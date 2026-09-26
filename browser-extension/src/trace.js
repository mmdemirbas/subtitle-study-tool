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
 * already part of this project: one POST per piece of the log, one line of JSON
 * per entry appended to subtitle-daemon/logs/<date>.jsonl. No files, no popups, no
 * ceiling but the disk.
 *
 * When the daemon is not running the log simply stays in the browser, which is
 * why `unlimitedStorage` is asked for. It keeps accumulating - hundreds of
 * megabytes if it comes to that - and goes out, piece by piece, once the
 * daemon appears. Downloading is the last resort and only happens when the
 * buffer is genuinely enormous or somebody asks for it on the report page.
 *
 * All of it is on this machine. Nothing here talks to anything but 127.0.0.1.
 */

import { DAEMON_ORIGIN } from "./daemon.js";
import { noteDaemon } from "./daemon-watch.js";

// The whole log as one array, which is how it was held until 2026-09-26. Read
// once, on the first touch after that, and moved into pieces.
const KEY = "sso:trace";
const INDEX_KEY = "sso:traceIndex";
const PIECE_KEY = "sso:trace:";
const STATE_KEY = "sso:traceState";
const SETTINGS_KEY = "sso:settings";
export const FOLDER = "subtitle-overlay-log";
// Derived, not a second literal: the two drifted apart the last time the port
// moved, and a log posted to the old one is a log nobody has.
const DAEMON_LOG = `${DAEMON_ORIGIN}/log`;

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

/* Held in pieces, and a new line touches only the last one.
 *
 * The log was one array under one key, and every line read the whole array,
 * added itself and wrote the whole array back. With the daemon down for ten
 * days (found 2026-09-26) that was 3,151 entries and 4.8MB for every line - two
 * full reads, one full write and a stringify, at 15ms a parse and 29ms a clone
 * in V8 before the browser process made its own copy and wrote it to disk -
 * and Brave's storage log showed a fresh 1.1MB table every 3 to 13 seconds
 * while a video played. What a line cost grew with how long the daemon had
 * been gone, which is the one thing nobody watching a film can see.
 *
 * So the log is pieces of at most PIECE_ENTRIES entries or PIECE_BYTES, and a
 * small index says which pieces exist and how much each holds. A line reads
 * the index and the last piece and writes both back; last week is not touched.
 * The pieces also go out one POST each, so a long absence is many small sends
 * rather than one body the size of it - the daemon refuses a log body over
 * 64MB, and HOLD_BYTES is far past that. */
const PIECE_ENTRIES = 200;
const PIECE_BYTES = 256 * 1024;

/* How long a daemon that refused the last POST is left before being asked
 * again.
 *
 * Past FLUSH_AT_ENTRIES every line used to start a flush, and with the daemon
 * down each of those read and stringified the whole log for a POST that could
 * not land - once per line, of a port that had refused the line before. A
 * minute is soon enough for a daemon somebody has just started, and a worker
 * that restarts asks on its first busy line regardless. */
const RETRY_MS = 60_000;

let queue = Promise.resolve();
let flushTimer = null;
let flushDue = Infinity;
/* Whether the daemon answered last time. Not a health check: the POST itself
 * is the check, and this only stops the timer firing at a socket that was not
 * there a moment ago. */
let daemonSeen = true;
let retryAt = 0;

function inTurn(work) {
  const done = queue.then(work, work);
  queue = done.then(
    () => {},
    () => {},
  );
  return done;
}

const pieceKey = (n) => `${PIECE_KEY}${n}`;
const sizeOf = (entry) => JSON.stringify(entry).length;
const fits = (piece, size) => Boolean(piece) && piece.count < PIECE_ENTRIES && piece.bytes + size <= PIECE_BYTES;

/* Which pieces exist. Only ever called inside a turn, because on an
 * installation from before the pieces the first call moves the old array. */
async function readIndex() {
  const index = (await chrome.storage.local.get(INDEX_KEY))[INDEX_KEY];
  if (index && Array.isArray(index.pieces)) return index;
  return movePastOneArray();
}

/* The one-array log, split once. The pieces and the index go down in one set,
 * so an interruption leaves the old layout or the new one and never half of
 * each; the old key goes only after that. */
async function movePastOneArray() {
  const old = (await chrome.storage.local.get(KEY))[KEY];
  const index = { next: 0, pieces: [] };
  const pieces = {};
  for (const entry of Array.isArray(old) ? old : []) {
    const size = sizeOf(entry);
    let last = index.pieces.at(-1);
    if (!fits(last, size)) {
      last = { n: index.next++, count: 0, bytes: 0 };
      index.pieces.push(last);
      pieces[pieceKey(last.n)] = [];
    }
    pieces[pieceKey(last.n)].push(entry);
    last.count += 1;
    last.bytes += size;
  }
  await chrome.storage.local.set({ ...pieces, [INDEX_KEY]: index });
  if (old !== undefined) await chrome.storage.local.remove(KEY);
  return index;
}

async function readPiece(n) {
  const stored = await chrome.storage.local.get(pieceKey(n));
  return Array.isArray(stored[pieceKey(n)]) ? stored[pieceKey(n)] : [];
}

async function readAll(index) {
  const keys = index.pieces.map((about) => pieceKey(about.n));
  if (!keys.length) return [];
  const stored = await chrome.storage.local.get(keys);
  return keys.flatMap((key) => (Array.isArray(stored[key]) ? stored[key] : []));
}

function held(index) {
  let count = 0;
  let bytes = 0;
  for (const about of index.pieces) {
    count += about.count;
    bytes += about.bytes;
  }
  return { count, bytes };
}

/** Everything held, oldest first. In turn, so it never reads a half-written line. */
export function entries() {
  return inTurn(async () => {
    try {
      return await readAll(await readIndex());
    } catch {
      return [];
    }
  });
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
  return inTurn(async () => {
    try {
      const index = (await chrome.storage.local.get(INDEX_KEY))[INDEX_KEY];
      const pieces = Array.isArray(index?.pieces) ? index.pieces.map((about) => pieceKey(about.n)) : [];
      await chrome.storage.local.remove([KEY, INDEX_KEY, STATE_KEY, ...pieces]);
    } catch {
      // Nothing to clear is not a failure.
    }
  });
}

/**
 * Add one entry. `at` is stamped here so every entry has one, whatever the
 * caller remembered, and the flush is scheduled here so no caller has to.
 */
export function record(kind, detail) {
  return inTurn(async () => {
    try {
      if (!(await enabled())) return;
      const entry = { at: new Date().toISOString(), kind, ...detail };
      const size = sizeOf(entry);
      const index = await readIndex();
      let last = index.pieces.at(-1);
      let piece = [];
      if (fits(last, size)) {
        piece = await readPiece(last.n);
      } else {
        last = { n: index.next++, count: 0, bytes: 0 };
        index.pieces.push(last);
      }
      piece.push(entry);
      last.count = piece.length;
      last.bytes += size;
      await chrome.storage.local.set({ [pieceKey(last.n)]: piece, [INDEX_KEY]: index });
      schedule(index);
    } catch {
      // A record that cannot be written must never break what it was recording.
    }
  });
}

/* One timer, moved earlier when something more urgent arrives and never
 * later: a timer restarted by every line is one a steady stream of lines never
 * lets fire. */
function schedule(index) {
  const due = daemonSeen ? held(index).count >= FLUSH_AT_ENTRIES : overflowing(index);
  const wait = due ? 0 : daemonSeen ? FLUSH_AFTER_MS : RETRY_MS;
  const at = Math.max(Date.now() + wait, retryAt);
  if (flushTimer && flushDue <= at) return;
  clearTimeout(flushTimer);
  flushDue = at;
  flushTimer = setTimeout(flush, at - Date.now());
}

function overflowing(index) {
  const { count, bytes } = held(index);
  return count >= HOLD_ENTRIES || bytes >= HOLD_BYTES;
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
  flushDue = Infinity;
  /* Never rejects: the timer and schedule() call this without waiting, and a
   * storage that cannot be read is an answer for the report page, not an
   * unhandled rejection for the worker to record - into the same storage. */
  return inTurn(() => sendOut(force).catch((error) => ({ ok: false, reason: String(error?.message || error) })));
}

async function sendOut(force) {
  const index = await readIndex();
  if (!index.pieces.length) return { ok: true, empty: true };

  /* Oldest piece first, each one let go the moment the daemon has it, so a
   * refusal halfway leaves exactly what did not arrive. The piece is removed
   * before the index stops naming it: an interruption between the two leaves
   * the index naming a piece that is not there, which reads as empty, rather
   * than a piece nothing names, which would never be sent or cleared. */
  let sent = { ok: true };
  let posts = 0;
  let sentEntries = 0;
  let sentBytes = 0;
  let file = null;
  while (index.pieces.length) {
    const { n } = index.pieces[0];
    const piece = await readPiece(n);
    if (piece.length) {
      sent = await toDaemon(piece);
      if (!sent.ok) break;
      posts += 1;
      sentEntries += piece.length;
      sentBytes += sent.bytes;
      file = sent.file;
    }
    await chrome.storage.local.remove(pieceKey(n));
    index.pieces.shift();
    await chrome.storage.local.set({ [INDEX_KEY]: index });
  }
  daemonSeen = sent.ok;
  retryAt = sent.ok ? 0 : Date.now() + RETRY_MS;
  if (posts) await tally({ posts, entries: sentEntries, bytes: sentBytes, destination: "daemon" });
  if (sent.ok) return { ok: true, destination: "daemon", entries: sentEntries, file };

  if (!force && !overflowing(index)) {
    /* Held on purpose. Nothing has been lost and nothing has interrupted:
     * the entries stay where they are until the daemon comes up or until
     * there are too many to keep. */
    await note({ lastError: sent.reason, lastDestination: "held in the browser" });
    return { ok: true, held: held(index).count, reason: sent.reason };
  }

  const log = await readAll(index);
  const written = await toFile(log);
  if (!written.ok) {
    await note({ lastError: written.reason });
    return { ok: false, reason: written.reason };
  }
  await chrome.storage.local.remove(index.pieces.map((about) => pieceKey(about.n)));
  index.pieces = [];
  await chrome.storage.local.set({ [INDEX_KEY]: index });
  await tally({ files: 1, entries: log.length, bytes: written.bytes, destination: written.file });
  return { ok: true, destination: "file", entries: log.length, file: written.file };
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
    /* A POST that succeeded is not proof the daemon took it.
     *
     * Ports collide, and this one is on this machine: something else holding it
     * that answers 200 would be handed the log AND have the browser's copy
     * dropped, so the entries are gone and they went to a stranger's process.
     * The daemon says where it wrote them, and nothing else does. */
    if (said.ok !== true || typeof said.file !== "string") {
      const reason = `something other than the daemon answered on ${DAEMON_ORIGIN}`;
      await noteDaemon(false, reason);
      return { ok: false, reason };
    }
    /* The look at the daemon that happens most while a film plays: nothing
     * else asks for it on a page that carries its own subtitles. An HTTP error
     * above is not reported either way - something is listening there. */
    await noteDaemon(true);
    return { ok: true, bytes: text.length, file: said.file };
  } catch (error) {
    await noteDaemon(false);
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

/* What went out, for the report page. The pieces themselves are removed by
 * flush as each one lands - emptied only after it is somewhere else, because a
 * buffer cleared on a write that failed is the one outcome that leaves nothing
 * at all to look at. */
async function tally({ posts = 0, files = 0, entries, bytes, destination }) {
  const was = await state();
  await chrome.storage.local.set({
    [STATE_KEY]: {
      ...was,
      sentToDaemon: was.sentToDaemon + posts,
      filesWritten: was.filesWritten + files,
      entriesSent: was.entriesSent + entries,
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
