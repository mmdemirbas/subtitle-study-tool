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
import { LocalService } from "./subtitles/local.js";
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

let probe = { at: 0, up: false };
let lastUp = false;
let syncing = null;
let service = null;
let serviceKey = null;

async function settings() {
  const stored = await chrome.storage.local.get(SETTINGS_KEY);
  return { apiKey: "", languages: DEFAULT_LANGUAGES, ...(stored[SETTINGS_KEY] || {}) };
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
  try {
    await daemon.health();
    up = true;
  } catch {
    up = false;
  }
  probe = { at: Date.now(), up };

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
  const info = await status();
  const configured = info.default_languages?.length ? info.default_languages : DEFAULT_LANGUAGES;
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

export async function search(args) {
  if (await daemonUp()) {
    await settled();
    try {
      return { served_by: "daemon", ...(await daemon.search(args)) };
    } catch (error) {
      if (!(error instanceof DaemonDownError)) throw error;
      // Stopped between the probe and the call. Answer it here instead.
      probe = { at: 0, up: false };
    }
  }
  return (await local()).search({
    title: args.title,
    query: args.query,
    languages: args.languages,
    year: args.year,
    season: args.season,
    episode: args.episode,
    imdb_id: args.imdb_id,
  });
}

export async function fetchSubtitle(fileId, context = {}) {
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
      // The daemon has them now, so nothing is left to propagate.
      for (const pending of await cache.pendingDeletions()) {
        await cache.clearPendingDeletion(pending.file_id);
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
