/* Speaker labels, sound descriptions and music markers inside cue text.
 *
 * Port of subtitle-daemon/src/subtitle_daemon/annotations.py. The reasoning for
 * the heuristics lives there and is not repeated; what is recorded here is
 * every place JavaScript's regex engine differs from Python's, because those
 * are the places this can silently stop agreeing with the daemon.
 *
 * The tables are generated, not copied - see tables.generated.js.
 */

import {
  GENERIC_SPEAKERS,
  MODIFIERS,
  MUSIC_COLOR,
  MUSIC_MOOD,
  MUSIC_UPBEAT,
  NOUN_STEMS,
  PHRASE_SYMBOLS,
  SOUND_COLOR,
  SPEAKER_PALETTE,
  STEM_SYMBOLS,
} from "./tables.generated.js";
import { normalise } from "./text.js";

export const SPEAKER = "speaker";
export const SOUND = "sound";
export const MUSIC = "music";
export { SOUND_COLOR, MUSIC_COLOR, SPEAKER_PALETTE };

const GENERIC_SPEAKER_SET = new Set(GENERIC_SPEAKERS);
const MODIFIER_SET = new Set(MODIFIERS);
const NOUN_STEM_SET = new Set(NOUN_STEMS);
const MUSIC_MOOD_SET = new Set(MUSIC_MOOD);
const MUSIC_UPBEAT_SET = new Set(MUSIC_UPBEAT);

/* Longest stem first, so "gunshot" is not answered by "gun" and "footstep" is
 * not answered by "step". Python sorts on every lookup; the order is fixed, so
 * it is computed once here. Both sorts are stable and both start from the
 * table's insertion order, so they agree on ties. */
const STEMS_BY_LENGTH = Object.keys(STEM_SYMBOLS).sort((a, b) => b.length - a.length);
const PHRASE_ENTRIES = Object.entries(PHRASE_SYMBOLS);

/* Python's \w is Unicode-aware; JavaScript's is ASCII whatever the flags. Every
 * \w in the ported patterns is spelled out, or a Turkish annotation would
 * tokenise differently here than in the daemon. */
const WORD = "[\\p{L}\\p{N}_]";

const SOUND_HINTS = new RegExp(
  "\\b(?:" +
    "sighs?|gasps?|laughs?|chuckl" + WORD + "+|cries|sobs?|groans?|grunts?|moans?" +
    "|screams?|shouts?|yells?|whispers?|coughs?|sneezes?|snor" + WORD + "+|scoffs?" +
    "|speaking|speaks|voice|voices|chatter" + WORD + "*|murmur" + WORD + "*|mutter" + WORD + "*|indistinct" +
    "|music|singing|sings|humming|song|theme" +
    "|ring" + WORD + "*|beep" + WORD + "*|buzz" + WORD + "*|click" + WORD + "*|clank" + WORD + "*|creak" + WORD + "*|rattl" + WORD + "*|rustl" + WORD + "*" +
    "|bang" + WORD + "*|crash" + WORD + "*|thud" + WORD + "*|explo" + WORD + "+|gunshots?|gunfire|shot|shots" +
    "|footsteps?|knock" + WORD + "*|door|engine|siren|alarm|horn|tires?|brakes?" +
    "|thunder|rain|wind|waves|barking|barks|meows|chirping" +
    "|continues|fades?|stops|distant|muffled|echoing|static|silence" +
    "|dings?|dinging|pants|panting|clicks?|buzzes|whirs?|hums?" +
    "|applause|clapping|cheer" + WORD + "*|panting|breathing|inhal" + WORD + "+|exhal" + WORD + "+" +
    "|over\\s+(?:phone|radio|pa|intercom|speaker)" +
    ")\\b",
  "iu",
);

// Bracketed or parenthesised spans. Square brackets dominate.
const ANNOTATION = /\[([^[\]\n]{1,80})\]|\(([^()\n]{1,80})\)/g;

// Music is marked with note characters rather than brackets, often unpaired.
const MUSIC_MARK = /[♪♫\u{1f3b5}\u{1f3b6}]/gu;

// "SHARON: Get down!" - a speaker label written without brackets.
const BARE_SPEAKER = /^\s*([A-Z][A-Za-z0-9 .'À-ɏ-]{0,28}):\s/;

const IS_MUSIC = /\b(?:music|singing|sings|song|humming|theme)\b/;

/* What may follow a stem for a token to count as an inflection of it. Verbs
 * inflect freely; nouns take only a plural, because "train" + "ing" is a
 * perfectly good inflection and made "training montage" a locomotive. */
const VERB_INFLECTION = /^(?:s|es|ed|d|e|ing|ings|er|ers|y|ies|ly)?$|^[bcdfghjklmnpqrstvwxz](?:ing|ed)$/;
const NOUN_INFLECTION = /^(?:s|es|'s)?$/;

/** Python's `str.isupper()` on the first character: true only for cased letters. */
function startsUpper(text) {
  const first = text.slice(0, 1);
  if (!first) return false;
  return first !== first.toLowerCase() && first === first.toUpperCase();
}

function allTokens(text) {
  return normalise(text)
    .split(/[^\p{L}\p{N}_']+/u)
    .filter(Boolean);
}

/** Words that carry meaning: normalised, with modifiers removed. */
function contentTokens(text) {
  const words = allTokens(text);
  const kept = words.filter((word) => !MODIFIER_SET.has(word));
  // A description that is nothing but modifiers keeps them, rather than
  // matching on an empty list.
  return kept.length ? kept : words;
}

function matchesStem(token, stem) {
  if (!token.startsWith(stem)) return false;
  const pattern = NOUN_STEM_SET.has(stem) ? NOUN_INFLECTION : VERB_INFLECTION;
  return pattern.test(token.slice(stem.length));
}

function lookup(token) {
  for (const stem of STEMS_BY_LENGTH) {
    if (matchesStem(token, stem)) return STEM_SYMBOLS[stem];
  }
  return null;
}

function phraseMatches(phrase, first, second) {
  const at = phrase.indexOf(" ");
  return matchesStem(first, phrase.slice(0, at)) && matchesStem(second, phrase.slice(at + 1));
}

/**
 * A symbol for an annotation, or null when nothing fits.
 *
 * Returning null is a normal outcome. A wrong symbol is worse than none: the
 * point is that seeing the same glyph teaches the word.
 */
export function symbolFor(text) {
  /* Phrases are matched before modifiers are stripped: several of them lead
   * with a word that is a modifier elsewhere. "OVER PA" was invisible when this
   * ran after stripping, because "over" had already gone. */
  const raw = allTokens(text);
  for (let index = 0; index < raw.length - 1; index++) {
    for (const [phrase, symbol] of PHRASE_ENTRIES) {
      if (phraseMatches(phrase, raw[index], raw[index + 1])) return symbol;
    }
  }

  const tokens = contentTokens(text);
  if (!tokens.length) return null;

  if (tokens.some((token) => matchesStem(token, "music") || matchesStem(token, "theme"))) {
    if (tokens.some((token) => MUSIC_MOOD_SET.has(token))) return "🎬";
    if (tokens.some((token) => MUSIC_UPBEAT_SET.has(token))) return "🎶";
  }

  for (const token of tokens) {
    const symbol = lookup(token);
    if (symbol) return symbol;
  }
  return null;
}

/**
 * Decide what a bracketed annotation is.
 *
 * `followedBySpeech` is the tiebreaker no amount of word matching replaces: a
 * label with dialogue after it is almost always naming who says it.
 */
export function classify(text, { followedBySpeech }) {
  const inner = String(text || "").trim();
  if (!inner) return SOUND;
  MUSIC_MARK.lastIndex = 0;
  if (MUSIC_MARK.test(inner)) return MUSIC;

  const lowered = inner.toLowerCase();

  // A role in place of a name: "[man]", "[girl]", "[all]".
  const words = lowered.split(/[^\p{L}\p{N}_]+/u).filter(Boolean);
  if (words.length && words.every((word) => GENERIC_SPEAKER_SET.has(word))) return SPEAKER;

  /* A single capitalised word is a name until something says otherwise, or a
   * character called Bell, Rain or Fox becomes a doorbell, weather and
   * wildlife - all three are real sound stems. */
  const looksLikeAName =
    inner.split(/\s+/).length === 1 && startsUpper(inner) && !SOUND_HINTS.test(lowered);

  if (!looksLikeAName && (SOUND_HINTS.test(lowered) || symbolFor(inner))) {
    // "[Ormon sighs]" names someone but describes a sound; sound wins.
    return IS_MUSIC.test(lowered) ? MUSIC : SOUND;
  }

  if (followedBySpeech) return SPEAKER;

  // A bare capitalised name as the whole cue is still a speaker label - the
  // dialogue is on the following line.
  if (startsUpper(inner) && inner.split(/\s+/).length <= 3) return SPEAKER;
  return SOUND;
}

/**
 * A stable colour for a speaker name.
 *
 * Deterministic, so a character keeps the same colour across cues and sessions
 * and between the daemon and the extension. The hash is spelled out rather than
 * taken from the platform for exactly that reason.
 */
export function speakerColor(name) {
  const key = normalise(name);
  let digest = 0;
  for (const char of key) {
    // Multiplication overflows 32 bits, so it is done in parts: Math.imul keeps
    // the low 32 bits the way Python's & 0xFFFFFFFF does.
    digest = (Math.imul(digest, 31) + char.codePointAt(0)) >>> 0;
  }
  return SPEAKER_PALETTE[digest % SPEAKER_PALETTE.length];
}

/**
 * Locate annotations in cue text.
 *
 * Returns {start, end, kind, inner} spans in order: bracketed spans,
 * note-marked music, and bare `NAME:` speaker prefixes.
 */
export function findAnnotations(text) {
  const found = [];
  const source = String(text || "");

  ANNOTATION.lastIndex = 0;
  for (const match of source.matchAll(ANNOTATION)) {
    const inner = match[1] !== undefined ? match[1] : match[2];
    const rest = source.slice(match.index + match[0].length).trim();
    // Speech after it, on this line or the next, means a speaker label.
    const followed = Boolean(rest) && !rest.startsWith("[") && !rest.startsWith("(");
    found.push({
      start: match.index,
      end: match.index + match[0].length,
      kind: classify(inner, { followedBySpeech: followed }),
      inner,
    });
  }

  const bare = BARE_SPEAKER.exec(source);
  if (bare) {
    // Group 1 starts after the leading whitespace the pattern allows.
    const start = bare[0].length - bare[0].replace(/^\s*/, "").length;
    if (!found.some((span) => span.start <= start && start < span.end)) {
      found.push({ start, end: start + bare[1].length + 1, kind: SPEAKER, inner: bare[1] });
    }
  }

  MUSIC_MARK.lastIndex = 0;
  for (const match of source.matchAll(MUSIC_MARK)) {
    if (!found.some((span) => span.start <= match.index && match.index < span.end)) {
      found.push({
        start: match.index,
        end: match.index + match[0].length,
        kind: MUSIC,
        inner: match[0],
      });
    }
  }

  found.sort((a, b) => a.start - b.start);
  return found;
}
