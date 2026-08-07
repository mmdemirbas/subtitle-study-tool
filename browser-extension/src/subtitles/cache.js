/* The extension's own copy of the download cache.
 *
 * This exists for quota reasons, not speed. A free OpenSubtitles account gets
 * around ten downloads a day; re-fetching because a tab was reloaded would burn
 * that in an evening.
 *
 * **Why this is a second store rather than the daemon's.** A browser extension
 * has no filesystem, so it cannot read or write subtitle-daemon/cache/. The two
 * stores therefore hold the same schema and are *converged* rather than shared:
 * whenever the daemon is reachable, whatever either side has downloaded is
 * copied to the other (see sync.js). What the user asked for - never spending a
 * download on a subtitle we already hold, whichever side fetched it - is what
 * that delivers; what it does not deliver is one set of bytes on disk.
 *
 * The schema mirrors subtitle-daemon/src/subtitle_daemon/cache.py field for
 * field, because the sync copies records across verbatim.
 */

import { SEARCH_SCHEMA_VERSION, SEARCH_TTL_SECONDS } from "./tables.generated.js";

const DB_NAME = "sso-subtitles";
const DB_VERSION = 2;
const SUBTITLES = "subtitles";
const SEARCHES = "searches";
/* Deletions waiting to reach the daemon. Without them, deleting a subtitle
 * while the daemon is stopped would do nothing at all: the next sync would see
 * the daemon still holding it, decide this side was missing it, and pull it
 * straight back. A record here is a pending instruction, not a gravestone - it
 * is removed as soon as the daemon has carried it out. */
const DELETIONS = "deletions";

let dbPromise = null;

function open() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(SUBTITLES)) {
        db.createObjectStore(SUBTITLES, { keyPath: "file_id" });
      }
      if (!db.objectStoreNames.contains(SEARCHES)) {
        db.createObjectStore(SEARCHES, { keyPath: "key" });
      }
      if (!db.objectStoreNames.contains(DELETIONS)) {
        db.createObjectStore(DELETIONS, { keyPath: "file_id" });
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
  return dbPromise;
}

/* Two helpers rather than one, because the one that tried to serve both had a
 * hole: "the request produced no result" and "the caller returned no request"
 * were indistinguishable, so a miss on `get` came back as a wrapper object.
 * That object was truthy, every cache lookup reported a hit, and the fetch
 * short-circuited to zero cues without ever downloading. Reading and writing
 * want different answers, so they get different functions. */

/** Run a read and resolve with its result - undefined when there is no record. */
function read(storeName, work) {
  return open().then(
    (db) =>
      new Promise((resolve, reject) => {
        const tx = db.transaction(storeName, "readonly");
        const request = work(tx.objectStore(storeName));
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
        tx.onabort = () => reject(tx.error);
      }),
  );
}

/** Run a write and resolve when the transaction commits. */
function write(storeName, work) {
  return open().then(
    (db) =>
      new Promise((resolve, reject) => {
        const tx = db.transaction(storeName, "readwrite");
        try {
          work(tx.objectStore(storeName));
        } catch (error) {
          reject(error);
          return;
        }
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
        tx.onabort = () => reject(tx.error);
      }),
  );
}

/** Seconds since the epoch, matching Python's time.time(). */
const now = () => Date.now() / 1000;

export async function sha256Hex(bytes) {
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

// --- subtitles --------------------------------------------------------------

export function getSubtitle(fileId) {
  return read(SUBTITLES, (store) => store.get(fileId));
}

/**
 * Store raw bytes plus the metadata the daemon records.
 *
 * Bytes, not decoded text: the sha256 is over the bytes on both sides, the
 * encoding scoring needs them, and the sync has to be able to hand the daemon
 * exactly what it would have downloaded itself.
 */
export async function putSubtitle(fileId, raw, meta) {
  const bytes = raw instanceof Uint8Array ? raw : new Uint8Array(raw);
  const record = {
    file_id: fileId,
    bytes,
    meta: { ...meta, cached_at: now(), sha256: await sha256Hex(bytes) },
  };
  await write(SUBTITLES, (store) => store.put(record));
  forgetMetaIndex();
  return record;
}

/** Store a record that came from the daemon, keeping its own cached_at. */
export async function importSubtitle(fileId, raw, meta) {
  const bytes = raw instanceof Uint8Array ? raw : new Uint8Array(raw);
  const record = {
    file_id: fileId,
    bytes,
    meta: { ...meta, sha256: meta.sha256 || (await sha256Hex(bytes)) },
  };
  await write(SUBTITLES, (store) => store.put(record));
  forgetMetaIndex();
  return record;
}

/** Every record, bytes included. For the sync, which has to send them. */
export function listSubtitles() {
  return read(SUBTITLES, (store) => store.getAll()).then((records) =>
    (records || []).sort(
      (a, b) => Number(b.meta.cached_at || 0) - Number(a.meta.cached_at || 0),
    ),
  );
}

/* The same list without the bytes, for the questions that are about metadata.
 *
 * IndexedDB has no way to read part of a record, so this keeps the metadata in
 * memory and rebuilds it from one full read when it is not there. Everything
 * that writes goes through this file, so the map cannot fall behind; a worker
 * that is shut down and restarted simply builds it again.
 *
 * Why it is worth having: `listSubtitles` loads every subtitle's bytes, and a
 * single search called it twice - once to mark which results are already held
 * and once to find a held file for the same title. Measured with 40 subtitles
 * cached, 90KB each: 4.2ms plus 3.9ms per search, and 3.6MB read into a
 * service worker that is killed for holding memory. It grows with everything
 * ever downloaded, which is the wrong direction for a cache to scale in.
 */
let metaIndex = null;

async function metaMap() {
  if (metaIndex) return metaIndex;
  const records = await read(SUBTITLES, (store) => store.getAll());
  metaIndex = new Map((records || []).map((record) => [record.file_id, record.meta]));
  return metaIndex;
}

/** Called by every write here, so the next read rebuilds rather than lies. */
function forgetMetaIndex() {
  metaIndex = null;
}

/** `[{file_id, meta}]`, newest first. No bytes. */
export async function listMeta() {
  const map = await metaMap();
  return [...map.entries()]
    .map(([file_id, meta]) => ({ file_id, meta }))
    .sort((a, b) => Number(b.meta.cached_at || 0) - Number(a.meta.cached_at || 0));
}

/**
 * A subtitle already held for this title, in the best available language.
 *
 * This is the part that actually protects the quota. Keying only on file_id
 * stops a repeat download of the same upload, but the same film is on
 * OpenSubtitles many times over, and a later search ranking a different upload
 * first would spend a download on a subtitle we effectively already have.
 */
export async function findForTitle(imdbId, languages) {
  if (!imdbId) return null;
  const records = await listMeta();
  const candidates = records.filter((item) => String(item.meta.imdb_id || "") === imdbId);
  if (!candidates.length) return null;

  const rank = (item) => {
    const language = String(item.meta.language || "");
    const position = languages.indexOf(language);
    return [position === -1 ? languages.length : position, -Number(item.meta.cached_at || 0)];
  };

  return candidates.reduce((best, item) => {
    const [aPos, aAge] = rank(item);
    const [bPos, bAge] = rank(best);
    if (aPos !== bPos) return aPos < bPos ? item : best;
    return aAge < bAge ? item : best;
  });
}

/**
 * Remove a subtitle, and remember to tell the daemon.
 *
 * The pending record is what makes deletion stick. Delete something while the
 * daemon is stopped and, without it, the next sync would see the daemon still
 * holding the file, conclude this side was missing it, and copy it back - so
 * the delete button would appear to work and quietly undo itself.
 */
export async function deleteSubtitle(fileId) {
  await write(SUBTITLES, (store) => store.delete(fileId));
  forgetMetaIndex();
  await write(DELETIONS, (store) => store.put({ file_id: fileId, at: now() }));
}

export async function deleteAllSubtitles() {
  const held = await listMeta();
  for (const item of held) await deleteSubtitle(item.file_id);
  return held.length;
}

export function pendingDeletions() {
  return read(DELETIONS, (store) => store.getAll()).then((records) => records || []);
}

/** Called once the daemon has carried the deletion out. */
export function clearPendingDeletion(fileId) {
  return write(DELETIONS, (store) => store.delete(fileId));
}

/**
 * Forget cached search results, so the next search asks upstream.
 *
 * Separate from deleting subtitles: searching is free and unlimited,
 * downloading is neither. Wanting a fresh search is not wanting to spend the
 * day's quota again.
 */
export async function clearSearches() {
  const keys = await read(SEARCHES, (store) => store.getAllKeys());
  await write(SEARCHES, (store) => {
    for (const key of keys || []) store.delete(key);
  });
  return (keys || []).length;
}

/** An existing file with identical bytes, under any file_id. */
export async function findByContent(digest) {
  const records = await listMeta();
  return records.find((item) => item.meta.sha256 === digest) || null;
}

// --- searches ---------------------------------------------------------------

/* Same key derivation and the same staleness window as the daemon, so a search
 * answered by one is answered the same way by the other. */
export function searchKey({ query, languages, year, season, episode, imdbId }) {
  const parts = [
    String(query).toLowerCase(),
    [...languages].sort().join(","),
    year === null || year === undefined ? "None" : String(year),
    season === null || season === undefined ? "None" : String(season),
    episode === null || episode === undefined ? "None" : String(episode),
    imdbId === null || imdbId === undefined ? "None" : String(imdbId),
  ];
  return parts
    .join("|")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .slice(0, 120);
}

export async function getSearch(key) {
  const record = await read(SEARCHES, (store) => store.get(`v${SEARCH_SCHEMA_VERSION}-${key}`));
  if (!record) return null;
  if (now() - Number(record.at || 0) > SEARCH_TTL_SECONDS) return null;
  return record.envelope && typeof record.envelope === "object" ? record.envelope : null;
}

export function putSearch(key, envelope) {
  return write(SEARCHES, (store) =>
    store.put({ key: `v${SEARCH_SCHEMA_VERSION}-${key}`, at: now(), envelope }),
  );
}

export async function stats() {
  const records = await listMeta();
  return { subtitles: records.length };
}
