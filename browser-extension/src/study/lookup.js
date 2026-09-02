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

/* What a translation memory leaves in a segment, and what the reader saw.
 *
 * Reported with a screenshot: the word "laying" glossed as `Serme<x id="1"/>`.
 * That is XLIFF inline markup - the archive stores segments with their
 * placeholders in, and an answer scored on how well its SOURCE matched can
 * carry a placeholder its source had. Nothing between the archive and the chip
 * took it out, so the reader read the tag. It was on THIS path, the one that
 * runs with no daemon listening, which is the ordinary case.
 *
 * Entities first, because the archive escapes its own markup about as often as
 * it does not: `&lt;x id="1"/&gt;` has to become a tag before a tag can be
 * taken out. The named set is the five that matter plus a space, character for
 * character the one in `lookups.py`, and `test_js_parity.py` diffs the two -
 * a fix in one copy would otherwise leave the other showing tags. */
const NAMED_ENTITIES = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " };
const ENTITY = /&(#x[0-9a-fA-F]{1,6}|#\d{1,7}|[a-zA-Z]{2,8});/g;
const PLACEHOLDER = /<[^<>]*>|\{\d+\}|%\d+\$?[sd]\b|%[sd]\b|\[\d+\]/g;

export function cleanTranslation(text) {
  const answer = String(text ?? "").replace(ENTITY, (whole, name) => {
    if (name[0] === "#") {
      const code = name[1] === "x" || name[1] === "X"
        ? Number.parseInt(name.slice(2), 16)
        : Number.parseInt(name.slice(1), 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : whole;
    }
    return NAMED_ENTITIES[name.toLowerCase()] ?? whole;
  });
  return answer.replace(PLACEHOLDER, " ").split(/\s+/).filter(Boolean).join(" ");
}

export function pickTranslation(payload, term) {
  if (!payload || typeof payload !== "object") return "";
  const source = String(term || "").trim().toLowerCase();
  const allowedWords = source.split(/\s+/).filter(Boolean).length + MAX_EXTRA_WORDS;

  const usable = (candidate) => {
    /* A segment that was nothing but a placeholder cleans away to the empty
     * string, which is the same "no" as the archive handing the word back
     * unchanged. */
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
    // Cleaned BEFORE it is judged, so the length and word counts are of what
    // the reader would actually see rather than of the markup around it.
    const text = cleanTranslation(match.translation);
    if (!usable(text)) continue;
    const score = (Number(match.match) || 0) * ((Number(match.quality) || 0) / 100);
    if (score > bestScore) {
      best = text;
      bestScore = score;
    }
  }
  if (best) return best;

  const fallback = cleanTranslation(payload.responseData?.translatedText);
  return usable(fallback) ? fallback : "";
}

const CACHE_KEY = "sso:lookupCache";
/* Enough to cover a film's worth of unfamiliar words many times over, small
 * enough that the whole map is one storage read. Definitions do not go stale,
 * so there is no TTL - only a cap, and the oldest entries go first.
 *
 * A daemon that glosses a word in its line files one entry per (word, line)
 * rather than per word, so a feature film is nearer six hundred entries than
 * four hundred. Still several films inside the cap. */
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
export async function lookup({
  query,
  language = "en",
  target = "",
  sentence = "",
  film = "",
  before = "",
  after = "",
}) {
  const term = String(query || "").trim().toLowerCase();
  if (!term) return { query: "", definitions: [], unavailable: "nothing to look up" };

  // The target is part of the key: the same word wanted in a different language
  // is a different answer, and leaving it out served Turkish to a reader who
  // had since switched the other subtitle to something else.
  /* The line is part of the key only when something can actually use it.
   *
   * With a daemon, it is part of the answer: it glosses "spare" one way in
   * "spare a minute" and another in "a spare tyre", and a key that cannot tell
   * them apart hands the second reader the first one's meaning.
   *
   * Without one, this path asks a context-free archive, which returns the same
   * string whatever line it came from - and that archive allows about six
   * hundred words a day. Keying those by line would ask it again for every new
   * sentence the same word turned up in, and spend a day's allowance on one
   * film. So the daemon being up is what decides the shape of the key. */
  const daemon = await daemonUp();
  const key = `${language}>${target}:${term}${daemon && sentence ? `@${sentence}` : ""}`;
  await loadCache();
  const hit = cache.get(key);
  if (hit) return { ...hit, source: `${hit.source} (cached)` };

  /* The film and the neighbouring lines are not in the key, for the reason the
   * daemon's `_translation_path` gives at length: they help answer the
   * question, they are not part of it. Keying by them would ask again for every
   * position in the file the same word turned up in. */
  const result = await resolve(term, language, target, sentence, daemon, {
    film,
    before,
    after,
  });
  // Only a real answer is worth keeping. Caching "the daemon was down" would
  // mean starting the daemon changed nothing until the cache was cleared.
  if (result.definitions.length > 0 || result.translation) remember(key, result);
  return result;
}

/* `up`, not `daemon`, and the name is the whole of a bug that ran for months.
 *
 * This file imports the daemon's client as `daemon` at the top. A parameter of
 * the same name shadows it, so `daemon.lookup(...)` was called on the BOOLEAN
 * `daemonUp()` returns - "up.lookup is not a function", a TypeError, thrown
 * inside a try whose catch says "went down between the probe and the call".
 * Every word a reader clicked therefore went to the free archive while the
 * daemon and its model sat there answering nothing, and the failure was
 * invisible because the archive answers. `Serme<x id="1"/>` under a word is
 * what it looks like from the reader's side: XLIFF markup out of a translation
 * memory, on the path that was never supposed to be running.
 *
 * The prefetch was unaffected - background.js sends `gloss` straight to the
 * daemon - which is why the film's marked words were glossed well and the words
 * looked up by hand were not. */
async function resolve(term, language, target, sentence, up, context = {}) {
  if (up) {
    try {
      const payload = await daemon.lookup(term, language, target, sentence, context);
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
