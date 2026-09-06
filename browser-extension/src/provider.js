/* Which side answers: the daemon, or the extension itself.
 *
 * The daemon is preferred whenever it is running. It holds the cache on disk,
 * it is where the API key lives when it lives there, and it is the only side
 * that will ever be able to transcribe audio. But needing it running to see a
 * subtitle at all contradicted the point of the tool - "one click away, no
 * searching" - so the extension can now do the whole fetch itself.
 *
 * Everything above this file is unaware of which one answered, except that the
 * response carries `served_by` for the panel to show.
 *
 * The rule is deliberately dumb: try the daemon, and on a transport failure -
 * which means nothing is listening on the port - do it here instead. It is not
 * a fallback for a daemon that answered with an error; an error is an answer,
 * and retrying it locally would spend a second download to reach the same one.
 */

import * as daemon from "./daemon.js";
import { DaemonDownError } from "./daemon.js";
import { cuesResponse, LocalService } from "./subtitles/local.js";
import * as cache from "./subtitles/cache.js";
import { converge } from "./subtitles/sync.js";

export const SETTINGS_KEY = "sso:provider";
const DEFAULT_LANGUAGES = ["en", "tr"];

/* Re-probing on every call would put a round trip in front of every keystroke
 * in the panel; never re-probing would leave the extension convinced the daemon
 * is down for the rest of the session. A few seconds is long enough to cover a
 * burst of calls and short enough that starting the daemon takes effect while
 * the user is still looking at the screen. */
const PROBE_TTL_MS = 5000;

let probe = { at: 0, up: false, why: "" };
let lastUp = false;
let syncing = null;
let service = null;
let serviceKey = null;

/* What is actually written down, with nothing filled in.
 *
 * Kept apart from settings() below because "the reader chose en, tr" and "the
 * reader chose nothing and en, tr is the default" are different facts, and
 * preferredLanguages has to tell them apart. */
async function storedSettings() {
  const stored = await chrome.storage.local.get(SETTINGS_KEY);
  return stored[SETTINGS_KEY] || {};
}

async function settings() {
  return { apiKey: "", languages: DEFAULT_LANGUAGES, ...(await storedSettings()) };
}

export async function updateSettings(patch) {
  const next = { ...(await settings()), ...patch };
  await chrome.storage.local.set({ [SETTINGS_KEY]: next });
  // The client holds the key, so a changed key needs a new one.
  service = null;
  return next;
}

async function local() {
  const config = await settings();
  const key = `${config.apiKey}|${config.languages.join(",")}`;
  if (!service || serviceKey !== key) {
    service = new LocalService({ apiKey: config.apiKey, languages: config.languages });
    serviceKey = key;
  }
  return service;
}

/** Is the daemon listening? Cached briefly; see PROBE_TTL_MS. */
export async function daemonUp({ force = false } = {}) {
  if (!force && Date.now() - probe.at < PROBE_TTL_MS) return probe.up;
  let up = false;
  /* Why it is not there, not only that it is not.
   *
   * The two reasons need different advice and the bare catch here threw the
   * difference away. A daemon that is not running is started with run.sh; a
   * port with something ELSE on it makes run.sh fail with the port in use, and
   * the reader has to find what is holding it first. daemon.js already tells
   * them apart - see FOREIGN there - and this is where that was being lost.
   *
   * Observed: a static file server from another project held the port for two
   * days. Nothing failed, because the extension does the work itself when the
   * daemon is absent, so the only symptom was that every translation arrived
   * late and knew nothing about the line it came from. The settings page said
   * "the daemon is not running", which was true and sent the reader nowhere. */
  let why = "";
  try {
    await daemon.health();
    up = true;
  } catch (error) {
    up = false;
    // Only the foreign case. "Nothing is listening" is the ordinary state and
    // already has advice that works; saying it twice would put a warning on
    // every reader who simply has not started the daemon.
    why = error instanceof DaemonDownError && error.foreign ? error.message : "";
  }
  probe = { at: Date.now(), up, why };

  /* Coming back up is the moment to converge the two caches, and it has to
   * finish before anything searches: a search that ran first would rank against
   * a stale view of what is held and could spend a download on a file the other
   * side already has. */
  if (up && !lastUp) syncing = converge(daemon).catch(() => ({ pushed: 0, pulled: 0, failed: 0 }));
  lastUp = up;
  return up;
}

async function settled() {
  if (!syncing) return;
  await syncing;
  syncing = null;
}

/** Whichever side is going to answer, plus why. */
export async function status() {
  if (await daemonUp()) {
    try {
      const health = await daemon.health();
      return { ...health, served_by: "daemon", daemon_running: true };
    } catch {
      // Raced with a shutdown; fall through to the local answer.
    }
  }
  const config = await settings();
  const held = await cache.stats();
  return {
    served_by: "extension",
    daemon_running: false,
    // Empty when the port is simply free. See daemonUp.
    daemon_blocked: probe.why,
    has_api_key: Boolean(config.apiKey),
    default_languages: config.languages,
    cached_subtitles: held.subtitles,
  };
}

/* What to look for, most wanted first.
 *
 * The order is not a detail: the first language becomes the first subtitle and
 * the second becomes the second, so this is also what decides which of a pair
 * is the language being learnt.
 *
 * What the reader last watched with comes first, because attaching English and
 * then Turkish is them saying what they want and it would be strange to ask
 * again on the next film. The configured list follows, so the search still
 * casts as wide a net as it did and a language that has never been used is
 * still found - it just does not win the slot.
 */
export async function preferredLanguages() {
  /* The extension's own setting wins, and only falls back to the daemon's.
   *
   * The options page writes this list into the extension's storage and reads it
   * straight back, so the field is showing the reader's own answer. status()
   * reports the DAEMON's list while a daemon is running, and that list lives in
   * a config file on disk that the options page never touches. So saving
   * "tr, en" and then starting the daemon searched in the daemon's order
   * instead, with the field still showing what the reader had chosen and
   * nothing anywhere saying otherwise - and the order decides which of the pair
   * is the language being learnt.
   *
   * A reader who has never saved anything on the options page has no stored
   * list, and for them the daemon's is still the better answer than a built-in
   * default. */
  const info = await status();
  const chosen = (await storedSettings()).languages;
  const configured = chosen?.length
    ? chosen
    : info.default_languages?.length
      ? info.default_languages
      : DEFAULT_LANGUAGES;
  let used = [];
  try {
    used = (await chrome.storage.local.get("sso:usedLanguages"))["sso:usedLanguages"] || [];
  } catch {
    // Nothing watched yet, or storage is unavailable. The configured list is
    // exactly the right answer in both cases.
  }
  const wanted = used.filter(Boolean);
  return [...wanted, ...configured.filter((language) => !wanted.includes(language))];
}

/* Whether each row is a programme the search actually identified, rather than
 * something a fuzzy query returned.
 *
 * "Does the name score say anything about this row?" is asked in two processes
 * - the auto-attach gate in the worker and the "weak match" tag on every row in
 * the panel - and a content script cannot import this module. So the answer is
 * derived once, here, where every search passes whichever side produced it, and
 * both read the same boolean. planAutoAttach in background.js carries the
 * reasoning for why a resolved title answers a question the score cannot.
 */
function markIdentified(response) {
  const rows = response?.results;
  if (!Array.isArray(rows)) return response;
  const known = Boolean(response.resolved?.imdb_id) && !response.ambiguous_title;
  const asked = new Set(known ? daemon.forEpisode(rows, response.used) : []);
  return { ...response, results: rows.map((row) => ({ ...row, identified: asked.has(row) })) };
}

export async function search(args) {
  if (await daemonUp()) {
    await settled();
    try {
      return markIdentified({ served_by: "daemon", ...(await daemon.search(args)) });
    } catch (error) {
      if (!(error instanceof DaemonDownError)) throw error;
      // Stopped between the probe and the call. Answer it here instead.
      probe = { at: 0, up: false };
    }
  }
  return markIdentified(
    await (await local()).search({
      title: args.title,
      query: args.query,
      languages: args.languages,
      year: args.year,
      season: args.season,
      episode: args.episode,
      imdb_id: args.imdb_id,
    }),
  );
}

export async function fetchSubtitle(fileId, context = {}) {
  /* What this side already holds, before either side is asked.
   *
   * A download is the scarce thing here - five a day anonymously, ten with an
   * account - and the daemon does not know what the extension has. The copy in
   * the other direction is made by converge, which runs on a down-to-up
   * transition and gives up quietly when a push fails or when listing the
   * daemon's cache fails, with no retry until the daemon next restarts. So a
   * file this side held and had not managed to push was fetched through the
   * daemon, and the daemon spent a download on it. Observed with the push
   * failed and file 99 held here: POST /fetch went out and the stub counted one
   * download spent.
   *
   * The bytes are the same bytes - the sha256 is checked on the way in and both
   * stores keep the file OpenSubtitles served - so answering from here is the
   * same answer, sooner and for nothing. */
  let held = null;
  try {
    held = await cache.getSubtitle(fileId);
  } catch {
    /* A store that cannot be read costs a download, not the answer. This is an
     * optimisation over what is already here, and it must not be the thing that
     * stops a subtitle arriving - which is what it became when it was written
     * unguarded: with no usable IndexedDB every fetch rejected before either
     * side was asked, and the reader was told "Something went wrong". */
  }
  if (held) return { served_by: "extension", ...cuesResponse(held.bytes, held.meta, true) };

  if (await daemonUp()) {
    await settled();
    try {
      const response = { served_by: "daemon", ...(await daemon.fetchSubtitle(fileId, context)) };
      /* Keep a copy. Without this, a film fetched through the daemon would be
       * downloaded a second time the first evening the daemon is not running -
       * which is now the normal case. */
      if (!response.error) await mirrorFromDaemon(fileId);
      return response;
    } catch (error) {
      if (!(error instanceof DaemonDownError)) throw error;
      probe = { at: 0, up: false };
    }
  }
  return (await local()).fetch({ file_id: fileId, ...context });
}

async function mirrorFromDaemon(fileId) {
  try {
    if (await cache.getSubtitle(fileId)) return;
    const full = await daemon.cachedOne(fileId, { content: true });
    if (!full?.content) return;
    const bytes = Uint8Array.from(atob(full.content), (char) => char.charCodeAt(0));
    const { cue_count: _count, encoding: _encoding, ...meta } = full.meta || {};
    await cache.importSubtitle(fileId, bytes, meta);
  } catch {
    // A copy that fails costs a future download, not this one.
  }
}

// --- cache management -------------------------------------------------------

/**
 * Everything downloaded, from both stores, as one list.
 *
 * Merged rather than shown as two lists: after a sync almost every entry is in
 * both, and two near-identical tables would suggest the subtitle had been
 * downloaded twice. `held_by` says where each one actually is, which is the
 * only part the user needs to know - and it is the honest answer to "where did
 * my disk space go".
 */
/* The one place that still reads every subtitle's bytes, and it should: the
 * table it builds has a size column, and the size is the length of what is
 * stored. It is the options page, opened when somebody wants to know what is on
 * disk - not the search path, which used to pay the same cost twice per query
 * and now reads metadata only. */
export async function cacheEntries() {
  const mine = await cache.listSubtitles();
  const merged = new Map();

  for (const record of mine) {
    merged.set(record.file_id, {
      ...record.meta,
      file_id: record.file_id,
      bytes: record.bytes.length,
      held_by: ["extension"],
    });
  }

  let daemonRunning = false;
  if (await daemonUp()) {
    try {
      const theirs = await daemon.cached();
      daemonRunning = true;
      for (const item of theirs.subtitles || []) {
        const existing = merged.get(item.file_id);
        if (existing) existing.held_by.push("daemon");
        else merged.set(item.file_id, { ...item, held_by: ["daemon"] });
      }
    } catch {
      // Went away mid-call; report what we have.
    }
  }

  const entries = [...merged.values()].sort(
    (a, b) => Number(b.cached_at || 0) - Number(a.cached_at || 0),
  );
  const pending = await cache.pendingDeletions();
  return { entries, daemon_running: daemonRunning, pending_deletions: pending.length };
}

/**
 * Delete a subtitle from both stores.
 *
 * With the daemon stopped it goes from here and is queued for the daemon, which
 * is what stops the next sync copying it back. Reported honestly either way, so
 * "deleted" never means "deleted from one of two places" without saying so.
 */
export async function cacheDelete(fileId) {
  await cache.deleteSubtitle(fileId);
  if (await daemonUp()) {
    try {
      await daemon.forget(fileId);
      await cache.clearPendingDeletion(fileId);
      return { deleted: true, everywhere: true };
    } catch {
      // Leave it pending.
    }
  }
  return { deleted: true, everywhere: false };
}

export async function cacheClear({ searchesOnly = false } = {}) {
  const result = { subtitles: 0, searches: 0, everywhere: false };
  if (!searchesOnly) result.subtitles = await cache.deleteAllSubtitles();
  result.searches = await cache.clearSearches();

  if (await daemonUp()) {
    try {
      await daemon.forgetAll({ searchesOnly });
      /* Only when the subtitles went too. Asked for searches only, the daemon
       * returns before it deletes a single subtitle - so emptying the queue
       * there threw away deletions nobody had propagated yet, and the next
       * convergence pulled those files back. Observed: a delete whose
       * propagation had failed stayed queued, "forget cached searches" emptied
       * the queue, and the deleted file was in the extension's cache again
       * after the next sync. */
      if (!searchesOnly) {
        for (const pending of await cache.pendingDeletions()) {
          await cache.clearPendingDeletion(pending.file_id);
        }
      }
      result.everywhere = true;
    } catch {
      // Deletions stay queued.
    }
  }
  return result;
}

/** Force a convergence now. Used by the options page's button. */
export async function syncNow() {
  if (!(await daemonUp({ force: true }))) throw new DaemonDownError();
  await settled();
  return converge(daemon);
}
