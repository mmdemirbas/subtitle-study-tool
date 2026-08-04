/* What does this word mean.
 *
 * Same rule as provider.js for subtitles: prefer the daemon, and do it here
 * when nothing is listening on the port. The daemon is preferred for one
 * specific reason rather than on principle - it can reach the dictionary
 * without the browser granting anything, and its cache is on disk, so a word
 * looked up on one film is still looked up on the next one after a profile
 * reset.
 *
 * Doing it here needs a host permission for the dictionary, and that permission
 * is optional and requested on the options page rather than declared in the
 * manifest. The extension asks for exactly one origin today - the daemon - and
 * that is worth keeping true for anyone who never turns lookup on.
 *
 * A lookup that cannot happen is not an error. Rarity marking and saving a word
 * with the line it appeared in are the parts that make the feature worth having
 * and neither needs a network; the definition is enrichment, and its absence is
 * reported as such.
 */

import * as daemon from "./../daemon.js";
import { daemonUp } from "./../provider.js";

const DICTIONARY_ORIGIN = "https://api.dictionaryapi.dev";
const DICTIONARY_URL = (word) =>
  `${DICTIONARY_ORIGIN}/api/v2/entries/en/${encodeURIComponent(word)}`;

const CACHE_KEY = "sso:lookupCache";
/* Enough to cover a film's worth of unfamiliar words many times over, small
 * enough that the whole map is one storage read. Definitions do not go stale,
 * so there is no TTL - only a cap, and the oldest entries go first. */
const CACHE_LIMIT = 1500;
const CACHE_WRITE_DELAY_MS = 2000;

let cache = null;
let cacheWrite = null;

async function loadCache() {
  if (cache) return cache;
  try {
    const stored = await chrome.storage.local.get(CACHE_KEY);
    cache = new Map(Object.entries(stored[CACHE_KEY] || {}));
  } catch {
    cache = new Map();
  }
  return cache;
}

function remember(key, entry) {
  cache.set(key, entry);
  // Map iterates in insertion order, so the front is the oldest.
  while (cache.size > CACHE_LIMIT) cache.delete(cache.keys().next().value);

  clearTimeout(cacheWrite);
  cacheWrite = setTimeout(() => {
    chrome.storage.local.set({ [CACHE_KEY]: Object.fromEntries(cache) }).catch(() => {});
  }, CACHE_WRITE_DELAY_MS);
}

/** Has the user granted the dictionary origin? Never prompts. */
export async function canReachDictionary() {
  try {
    return await chrome.permissions.contains({ origins: [`${DICTIONARY_ORIGIN}/*`] });
  } catch {
    return false;
  }
}

/**
 * Look up one word or phrase.
 *
 * Always resolves. `definitions` empty plus `unavailable` set is the normal
 * shape when nothing could answer, and the caller shows the word anyway.
 */
export async function lookup({ query, language = "en" }) {
  const term = String(query || "").trim().toLowerCase();
  if (!term) return { query: "", definitions: [], unavailable: "nothing to look up" };

  const key = `${language}:${term}`;
  await loadCache();
  const hit = cache.get(key);
  if (hit) return { ...hit, source: `${hit.source} (cached)` };

  const result = await resolve(term, language);
  // Only a real answer is worth keeping. Caching "the daemon was down" would
  // mean starting the daemon changed nothing until the cache was cleared.
  if (result.definitions.length > 0 || result.translation) remember(key, result);
  return result;
}

async function resolve(term, language) {
  if (await daemonUp()) {
    try {
      const payload = await daemon.lookup(term, language);
      if (payload && !payload.error) {
        return {
          query: term,
          definitions: payload.definitions || [],
          phonetic: payload.phonetic || "",
          translation: payload.translation || "",
          source: payload.source || "daemon",
        };
      }
    } catch {
      // Went down between the probe and the call. Fall through and try here.
    }
  }

  /* Multi-word phrases have no entry in a word dictionary, so asking is a
   * request that can only 404. The daemon may still have answered above if it
   * has a translator configured, which is why this check is here and not at the
   * top of lookup(). */
  if (/\s/.test(term)) {
    return {
      query: term,
      definitions: [],
      unavailable: "Phrases are not in the dictionary. Saved with its line either way.",
    };
  }

  if (!(await canReachDictionary())) {
    return {
      query: term,
      definitions: [],
      unavailable:
        "No definitions available. Start the daemon, or allow the dictionary on the options page.",
    };
  }

  try {
    const response = await fetch(DICTIONARY_URL(term));
    if (response.status === 404) {
      return { query: term, definitions: [], unavailable: "No dictionary entry for that word." };
    }
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return { query: term, ...condense(await response.json()), source: "dictionaryapi.dev" };
  } catch (error) {
    return {
      query: term,
      definitions: [],
      unavailable: `Dictionary lookup failed: ${error?.message || error}`,
    };
  }
}

/* The dictionary returns every sense of every part of speech, which is far more
 * than fits beside a film that is still playing. Keep the first sense of each
 * part of speech, capped - that is the shape a paper dictionary's short entry
 * has, and it is the one that can be read in the two seconds a line is up. */
const MAX_DEFINITIONS = 3;

export function condense(payload) {
  const entries = Array.isArray(payload) ? payload : [];
  const definitions = [];
  const seen = new Set();
  let phonetic = "";

  for (const entry of entries) {
    phonetic ||= entry.phonetic || entry.phonetics?.find((p) => p.text)?.text || "";
    for (const meaning of entry.meanings || []) {
      const part = meaning.partOfSpeech || "";
      if (seen.has(part)) continue;
      const first = meaning.definitions?.[0];
      if (!first?.definition) continue;
      seen.add(part);
      definitions.push({
        partOfSpeech: part,
        sense: first.definition,
        example: first.example || "",
      });
      if (definitions.length >= MAX_DEFINITIONS) return { definitions, phonetic };
    }
  }
  return { definitions, phonetic };
}
