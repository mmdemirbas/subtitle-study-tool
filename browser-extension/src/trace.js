/* What the extension saw, kept without anybody having to ask for it.
 *
 * Two failed shapes preceded this one and both are worth stating, because the
 * obvious answer is wrong twice over.
 *
 * A log with a Save button is useless: the failures worth recording are the
 * ones where nothing is responding to clicks, so a record that needs a button
 * pressed is a record you do not have on the day you need it.
 *
 * A log that writes itself through `chrome.downloads` is worse. A browser
 * extension cannot write to a directory - the only API that puts a real file
 * on disk is the download machinery - and that machinery announces every file
 * it writes. Recording as you watch then means a popup every few seconds.
 * `setUiOptions` is supposed to silence it and did not.
 *
 * So the log goes to the daemon, which is a program with a filesystem and is
 * already part of this project: one POST per flush, one line of JSON per entry
 * appended to subtitle-daemon/logs/<date>.jsonl. No files, no popups, no
 * ceiling but the disk.
 *
 * When the daemon is not running the log simply stays in the browser, which is
 * why `unlimitedStorage` is asked for. It keeps accumulating - hundreds of
 * megabytes if it comes to that - and goes out in one piece the moment the
 * daemon appears. Downloading is the last resort and only happens when the
 * buffer is genuinely enormous or somebody asks for it on the report page.
 *
 * All of it is on this machine. Nothing here talks to anything but 127.0.0.1.
 */

const KEY = "sso:trace";
const STATE_KEY = "sso:traceState";
const SETTINGS_KEY = "sso:settings";
export const FOLDER = "subtitle-overlay-log";
const DAEMON_LOG = "http://127.0.0.1:8791/log";

/* How long an entry may sit before the daemon is offered it.
 *
 * Only a few seconds, because sending it costs a local POST and nothing else -
 * there is no file, no popup and nothing for anybody to notice. */
const FLUSH_AFTER_MS = 8000;
const FLUSH_AT_ENTRIES = 60;

/* And how much may pile up when the daemon is NOT there.
 *
 * Deliberately enormous. With nowhere free to put it, the only ways out are to
 * hold it or to download it, and downloading is the thing that interrupts. So
 * it holds - a whole evening of viewing, several films' worth of alignment
 * attempts - and only writes a file when even that is exhausted. Storage is
 * unlimited by permission, so these are the real bound rather than the
 * browser's. */
const HOLD_ENTRIES = 20000;
const HOLD_BYTES = 400_000_000;

let queue = Promise.resolve();
let flushTimer = null;
/* Whether the daemon answered last time. Not a health check: the POST itself
 * is the check, and this only stops the timer firing at a socket that was not
 * there a moment ago. */
let daemonSeen = true;

function inTurn(work) {
  const done = queue.then(work, work);
  queue = done.then(
    () => {},
    () => {},
  );
  return done;
}

export async function entries() {
  try {
    const stored = await chrome.storage.local.get(KEY);
    return Array.isArray(stored[KEY]) ? stored[KEY] : [];
  } catch {
    return [];
  }
}

/** Counts and destinations, so the report page can say what exists. */
export async function state() {
  const empty = {
    sentToDaemon: 0,
    entriesSent: 0,
    filesWritten: 0,
    bytesOut: 0,
    lastDestination: null,
    lastError: null,
  };
  try {
    const stored = await chrome.storage.local.get(STATE_KEY);
    return { ...empty, ...(stored[STATE_KEY] || {}) };
  } catch {
    return empty;
  }
}

/* The switch, read from the same settings object the panel writes.
 *
 * Off means off everywhere and immediately - the worker's own records go
 * through here too, so one flag covers the frames and the worker without
 * either having to be told. */
export async function enabled() {
  try {
    const stored = await chrome.storage.local.get(SETTINGS_KEY);
    return stored[SETTINGS_KEY]?.diagnostics !== false;
  } catch {
    return true;
  }
}

export function clear() {
  return inTurn(() => chrome.storage.local.remove([KEY, STATE_KEY]).catch(() => {}));
}

/**
 * Add one entry. `at` is stamped here so every entry has one, whatever the
 * caller remembered, and the flush is scheduled here so no caller has to.
 */
export function record(kind, detail) {
  return inTurn(async () => {
    try {
      if (!(await enabled())) return;
      const log = await entries();
      log.push({ at: new Date().toISOString(), kind, ...detail });
      await chrome.storage.local.set({ [KEY]: log });
      schedule(log);
    } catch {
      // A record that cannot be written must never break what it was recording.
    }
  });
}

function schedule(log) {
  if (log.length >= FLUSH_AT_ENTRIES || (!daemonSeen && overflowing(log))) {
    flush();
    return;
  }
  clearTimeout(flushTimer);
  flushTimer = setTimeout(flush, FLUSH_AFTER_MS);
}

function overflowing(log) {
  return log.length >= HOLD_ENTRIES || roughBytes(log) >= HOLD_BYTES;
}

/* Measured on the last few entries and multiplied out, rather than by
 * stringifying the whole buffer on every single record. An alignment entry is
 * tens of kilobytes and this runs on a path that must not become the expensive
 * part of pressing a button. */
function roughBytes(log) {
  const sample = log.slice(-3);
  if (!sample.length) return 0;
  return (JSON.stringify(sample).length / sample.length) * log.length;
}

/**
 * Get whatever is buffered out of the browser.
 *
 * The daemon first, always. A file only when the daemon is absent AND the
 * buffer has grown past what is reasonable to hold, or when `force` says
 * somebody asked for one on the report page.
 */
export function flush({ force = false } = {}) {
  clearTimeout(flushTimer);
  flushTimer = null;
  return inTurn(async () => {
    const log = await entries();
    if (!log.length) return { ok: true, empty: true };

    const sent = await toDaemon(log);
    daemonSeen = sent.ok;
    if (sent.ok) {
      await settle(log, { destination: "daemon", bytes: sent.bytes, daemon: true });
      return { ok: true, destination: "daemon", entries: log.length, file: sent.file };
    }

    if (!force && !overflowing(log)) {
      /* Held on purpose. Nothing has been lost and nothing has interrupted:
       * the entries stay where they are until the daemon comes up or until
       * there are too many to keep. */
      await note({ lastError: sent.reason, lastDestination: "held in the browser" });
      return { ok: true, held: log.length, reason: sent.reason };
    }

    const written = await toFile(log);
    if (!written.ok) {
      await note({ lastError: written.reason });
      return { ok: false, reason: written.reason };
    }
    await settle(log, { destination: written.file, bytes: written.bytes, daemon: false });
    return { ok: true, destination: "file", entries: log.length, file: written.file };
  });
}

async function toDaemon(log) {
  const text = JSON.stringify({ entries: log });
  try {
    const answer = await fetch(DAEMON_LOG, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: text,
    });
    if (!answer.ok) return { ok: false, reason: `daemon answered ${answer.status}` };
    const said = await answer.json().catch(() => ({}));
    return { ok: true, bytes: text.length, file: said.file || null };
  } catch (error) {
    return { ok: false, reason: `daemon not running (${error?.message || error})` };
  }
}

async function toFile(log) {
  const text = JSON.stringify({ writtenAt: new Date().toISOString(), entries: log });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const name = `${FOLDER}/${stamp}.json`;
  try {
    await chrome.downloads.download({
      url: asDataUrl(text),
      filename: name,
      conflictAction: "uniquify",
      saveAs: false,
    });
    return { ok: true, file: name, bytes: text.length };
  } catch (error) {
    return { ok: false, reason: String(error?.message || error) };
  }
}

/* Emptied only after it is somewhere else. A buffer cleared on a write that
 * failed is the one outcome that leaves nothing at all to look at. */
async function settle(log, { destination, bytes, daemon }) {
  const was = await state();
  await chrome.storage.local.set({
    [KEY]: [],
    [STATE_KEY]: {
      ...was,
      sentToDaemon: was.sentToDaemon + (daemon ? 1 : 0),
      filesWritten: was.filesWritten + (daemon ? 0 : 1),
      entriesSent: was.entriesSent + log.length,
      bytesOut: was.bytesOut + bytes,
      lastDestination: destination,
      lastError: null,
    },
  });
}

async function note(patch) {
  const was = await state();
  await chrome.storage.local.set({ [STATE_KEY]: { ...was, ...patch } }).catch(() => {});
}

/* A data URL, because a service worker has no URL.createObjectURL.
 *
 * Encoded in chunks: btoa takes a binary string, and building one from a
 * multi-megabyte buffer with a spread or a per-byte concatenation is either a
 * stack overflow or a quadratic copy. */
function asDataUrl(text) {
  const bytes = new TextEncoder().encode(text);
  const CHUNK = 0x8000;
  let binary = "";
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK));
  }
  return `data:application/json;base64,${btoa(binary)}`;
}

/* Cue times, small enough to keep a lot of them.
 *
 * A subtitle is a thousand or more starts, each up to eight digits, and the
 * gaps between them are three or four. Storing the gaps rather than the times
 * is a third of the size for something that reconstructs exactly.
 */
export function packTimes(times) {
  const out = [];
  let previous = 0;
  for (const time of times) {
    const value = Math.round(time);
    out.push(value - previous);
    previous = value;
  }
  return out;
}

export function unpackTimes(gaps) {
  const out = [];
  let running = 0;
  for (const gap of gaps) {
    running += gap;
    out.push(running);
  }
  return out;
}
