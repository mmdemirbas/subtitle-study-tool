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

const TRANSLATOR_ORIGIN = "https://api.mymemory.translated.net";
const TRANSLATOR_URL = (term, from, to) =>
  `${TRANSLATOR_ORIGIN}/get?q=${encodeURIComponent(term)}&langpair=${from}|${to}`;

/* The same scoring the daemon does, and here for the same reason condense() is:
 * this path runs when the daemon is not listening, and a translation that only
 * works with a daemon running is a translation most sessions do not get. The
 * rules are in lookups.py next to the recorded payloads that justify them -
 * briefly: the archive's own first answer can be a quality-0 entry, and a word
 * it does not know comes back unchanged. */
const MAX_EXTRA_WORDS = 3;
const MAX_TRANSLATION_CHARS = 80;

export function pickTranslation(payload, term) {
  if (!payload || typeof payload !== "object") return "";
  const source = String(term || "").trim().toLowerCase();
  const allowedWords = source.split(/\s+/).filter(Boolean).length + MAX_EXTRA_WORDS;

  const usable = (text) => {
    const candidate = String(text || "").trim();
    if (!candidate || candidate.toLowerCase() === source) return false;
    return (
      candidate.length <= MAX_TRANSLATION_CHARS &&
      candidate.split(/\s+/).filter(Boolean).length <= allowedWords
    );
  };

  let best = "";
  let bestScore = 0;
  for (const match of Array.isArray(payload.matches) ? payload.matches : []) {
    if (!match || typeof match !== "object") continue;
    if (!usable(match.translation)) continue;
    const score = (Number(match.match) || 0) * ((Number(match.quality) || 0) / 100);
    if (score > bestScore) {
      best = String(match.translation).trim();
      bestScore = score;
    }
  }
  if (best) return best;

  const fallback = String(payload.responseData?.translatedText || "");
  return usable(fallback) ? fallback.trim() : "";
}

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
  return granted(DICTIONARY_ORIGIN);
}

/** Has the user granted the translator origin? Never prompts. */
export async function canReachTranslator() {
  return granted(TRANSLATOR_ORIGIN);
}

async function granted(origin) {
  try {
    return await chrome.permissions.contains({ origins: [`${origin}/*`] });
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
export async function lookup({ query, language = "en", target = "" }) {
  const term = String(query || "").trim().toLowerCase();
  if (!term) return { query: "", definitions: [], unavailable: "nothing to look up" };

  // The target is part of the key: the same word wanted in a different language
  // is a different answer, and leaving it out served Turkish to a reader who
  // had since switched the other subtitle to something else.
  const key = `${language}>${target}:${term}`;
  await loadCache();
  const hit = cache.get(key);
  if (hit) return { ...hit, source: `${hit.source} (cached)` };

  const result = await resolve(term, language, target);
  // Only a real answer is worth keeping. Caching "the daemon was down" would
  // mean starting the daemon changed nothing until the cache was cleared.
  if (result.definitions.length > 0 || result.translation) remember(key, result);
  return result;
}

async function resolve(term, language, target) {
  if (await daemonUp()) {
    try {
      const payload = await daemon.lookup(term, language, target);
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

  /* The two halves are independent: a phrase has no dictionary entry but does
   * have a translation, and a language other than English has no dictionary at
   * all. Asking for both and reporting whichever arrives beats letting the one
   * that cannot answer decide there is no answer. */
  const [definition, translation] = await Promise.all([
    resolveDefinition(term, language),
    resolveTranslation(term, language, target),
  ]);

  if (translation) {
    const { unavailable, ...rest } = definition;
    // A translation is an answer; only say "unavailable" when nothing came.
    return { ...rest, translation };
  }
  return definition;
}

async function resolveDefinition(term, language) {
  if (language !== "en") {
    return { query: term, definitions: [], unavailable: `No dictionary available for ${language}.` };
  }
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

async function resolveTranslation(term, language, target) {
  const from = String(language || "").slice(0, 2);
  const to = String(target || "").slice(0, 2);
  if (!from || !to || from === to) return "";
  if (!(await canReachTranslator())) return "";

  try {
    const response = await fetch(TRANSLATOR_URL(term, from, to));
    if (!response.ok) return "";
    return pickTranslation(await response.json(), term);
  } catch {
    // The definition is still worth showing, and a learner does not need to be
    // told the translator was busy.
    return "";
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
