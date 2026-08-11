/* What the extension saw, written to disk by itself.
 *
 * The first version of this kept a log in the browser and put a Save button on
 * the report page. That is the wrong shape, and the reason is the whole point
 * of the log: the failures worth recording are the ones where nothing is
 * responding to clicks. A record you have to press a button to keep is a
 * record you do not have on the day you need it.
 *
 * So nothing here waits to be asked. Entries accumulate in storage for a few
 * seconds and are then written to a file under the browser's download folder,
 * one file per flush, and the buffer is emptied. Nothing has to be pressed,
 * nothing has to be reproduced, and the file is on disk before the tab that
 * produced it is closed.
 *
 * What gets recorded is deliberately wide: the shape of every frame whenever
 * the panel opens or closes, every alignment attempt with both files' timings,
 * every message shown to the reader, every attach and detach, and every error
 * that reached the top of a frame or the worker. Narrowing it means deciding
 * in advance which question will be asked, which is exactly what has been
 * getting this wrong.
 *
 * All of it stays on this machine. It is written to a folder, not sent
 * anywhere; nothing in this file opens a socket.
 */

const KEY = "sso:trace";
const STATE_KEY = "sso:traceState";
export const FOLDER = "subtitle-overlay-log";

/* Bounds on the BUFFER, not on the record.
 *
 * The record is the folder, and it is as large as the disk allows - that is
 * what `unlimitedStorage` and writing to files are for. These only decide how
 * long an entry may sit in the browser before it is on disk, so they are small
 * on purpose: a crash, a tab close or a worker eviction can only cost whatever
 * has not been flushed yet.
 */
const FLUSH_AFTER_MS = 6000;
const FLUSH_AT_ENTRIES = 40;
const FLUSH_AT_BYTES = 4_000_000;

/* The one hard limit left, and it is a safety catch rather than a policy: if
 * writing to disk is failing - the folder is gone, the permission was revoked,
 * the disk is full - the buffer must not grow until it takes the browser's
 * storage down with it. Well above any normal flush. */
const BUFFER_PANIC_ENTRIES = 4000;

let queue = Promise.resolve();
let flushTimer = null;

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

/** Counts and filenames, so the report page can say what exists without reading it. */
export async function state() {
  try {
    const stored = await chrome.storage.local.get(STATE_KEY);
    return { written: 0, entriesWritten: 0, bytesWritten: 0, files: [], lastError: null, ...(stored[STATE_KEY] || {}) };
  } catch {
    return { written: 0, entriesWritten: 0, bytesWritten: 0, files: [], lastError: null };
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
  const full =
    log.length >= FLUSH_AT_ENTRIES ||
    log.length >= BUFFER_PANIC_ENTRIES ||
    roughBytes(log) >= FLUSH_AT_BYTES;
  if (full) {
    flush();
    return;
  }
  clearTimeout(flushTimer);
  flushTimer = setTimeout(flush, FLUSH_AFTER_MS);
}

/* Measured on the last few entries and multiplied out, rather than by
 * stringifying the whole buffer on every single record. An alignment entry is
 * tens of kilobytes and this runs on a path that must not become the expensive
 * part of pressing a button. */
function roughBytes(log) {
  const sample = log.slice(-3);
  if (!sample.length) return 0;
  const each = JSON.stringify(sample).length / sample.length;
  return each * log.length;
}

/**
 * Put whatever is buffered on disk, and empty the buffer.
 *
 * One file per flush, named by the time it was written, so nothing is ever
 * rewritten and a long session costs a directory of small files rather than
 * one file re-serialised every few seconds.
 */
export function flush() {
  clearTimeout(flushTimer);
  flushTimer = null;
  return inTurn(async () => {
    const log = await entries();
    if (!log.length) return { ok: true, empty: true };

    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const name = `${FOLDER}/${stamp}.json`;
    const text = JSON.stringify({ writtenAt: new Date().toISOString(), entries: log });

    try {
      await chrome.downloads.download({
        url: asDataUrl(text),
        filename: name,
        conflictAction: "uniquify",
        saveAs: false,
      });
    } catch (error) {
      /* Left in the buffer deliberately - the next flush tries again, and a
       * record that quietly deleted itself because the disk was full is worse
       * than one that stopped growing. The panic bound above is what stops
       * that becoming unbounded. */
      const was = await state();
      await chrome.storage.local
        .set({ [STATE_KEY]: { ...was, lastError: String(error?.message || error) } })
        .catch(() => {});
      return { ok: false, reason: String(error?.message || error) };
    }

    const was = await state();
    await chrome.storage.local.set({
      [KEY]: [],
      [STATE_KEY]: {
        ...was,
        written: was.written + 1,
        entriesWritten: was.entriesWritten + log.length,
        bytesWritten: was.bytesWritten + text.length,
        // Enough to name the folder and the newest file; the folder is the record.
        files: [...was.files, name].slice(-20),
        lastError: null,
      },
    });
    return { ok: true, file: name, entries: log.length, bytes: text.length };
  });
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
