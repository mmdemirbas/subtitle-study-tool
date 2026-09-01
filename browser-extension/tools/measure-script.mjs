/* What a whole subtitle file says about the film, before it plays.
 *
 * The extension marks rare words one line at a time, because that is all a
 * viewer needs while a film is running. The FILE holds more than that: every
 * word of the script, with its timing, in advance. This measures what that
 * makes knowable - how hard the dialogue is, which words carry the film, and
 * where the reading load actually sits - so a proposal about pre-study,
 * difficulty ratings or an adaptive pause can be argued from a number rather
 * than from an intuition.
 *
 *   node tools/measure-script.mjs <file.srt> [--lang en] [--rank 4000]
 *
 * Ranks come from the same generated tables the extension uses, and the
 * tokeniser is the extension's own WORD_PATTERN with its apostrophe fallback,
 * so a word counted here is a word the overlay would have marked.
 */
import { readFile } from "node:fs/promises";
import { basename } from "node:path";

const WORD_PATTERN = /[\p{L}\p{M}][\p{L}\p{M}'’-]*/gu;
const LETTERS = /[\p{L}\p{M}]/gu;
/* The extension's own floor: below three letters it is function words and
 * interjections, which are never the problem. It is also what saves the English
 * table from itself - "a" and "i" are absent from the 30,000 word list, and
 * absent means rarer than anything in it. */
const MIN_LETTERS = 3;
// What the overlay puts on screen from one line, at most.
const MAX_PER_CUE = 2;
// Anything bracketed is a sound or a speaker label, not spoken words.
const NOT_SPOKEN = /\[[^\]]*\]|\([^)]*\)|\{[^}]*\}|<[^>]*>/g;

const args = process.argv.slice(2);
const file = args.find((a) => !a.startsWith("--"));
const flag = (name, fallback) => {
  const at = args.indexOf(`--${name}`);
  return at === -1 ? fallback : args[at + 1];
};
if (!file) {
  console.error("usage: node tools/measure-script.mjs <file.srt> [--lang en] [--rank 4000]");
  process.exit(2);
}
const lang = String(flag("lang", /-TR\b|\.tr\./i.test(file) ? "tr" : "en")).toLowerCase();
const threshold = Number(flag("rank", 4000));

/* Folded with the file's own language, the way study.js folds a word on
 * screen. Turkish disagrees with the default fold twice - a dotted capital
 * becomes "i" plus a combining dot, and a dotless capital I becomes a dotted i
 * - and neither form is in the table, so every affected word would be counted
 * here as rarer than the 30,000th word. Measured before this: 78 of the 5,122
 * tokens in the Turkish file, 61 of them words the table knows once folded. */
const fold = (word) => String(word).toLocaleLowerCase(lang);

const table = await readFile(new URL(`../src/study/frequency-${lang}.generated.txt`, import.meta.url), "utf-8");
const ranks = new Map();
table.split("\n").forEach((word, rank) => { if (word) ranks.set(word, rank); });

/** The extension's rule: a contraction falls back to its stem. Null is rarer
 *  than anything the table holds, not "unknown". */
function rankOf(word) {
  const direct = ranks.get(word);
  if (direct !== undefined) return direct;
  const apostrophe = word.search(/['’]/);
  if (apostrophe > 0) {
    const stem = ranks.get(word.slice(0, apostrophe));
    if (stem !== undefined) return stem;
  }
  return null;
}

const clock = (stamp) => {
  const [h, m, rest] = stamp.split(":");
  const [s, ms] = rest.split(",");
  return ((+h * 60 + +m) * 60 + +s) * 1000 + +ms;
};

const raw = await readFile(file, "utf8");
const cues = [];
// Counted rather than ignored: a file can carry timestamps that are not
// timestamps. The Turkish translation of the miniseries in this repo has ten
// cues reading "00:41:23,*** --> 00:41:27,***", left behind by whatever
// produced it, and a NaN start silently poisons every percentile downstream.
let unparsed = 0;
for (const block of raw.replace(/\r/g, "").split(/\n{2,}/)) {
  const lines = block.split("\n").filter(Boolean);
  const timing = lines.find((line) => line.includes("-->"));
  if (!timing) continue;
  const [from, to] = timing.split("-->").map((part) => part.trim().slice(0, 12));
  const start = clock(from);
  const end = clock(to);
  if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) {
    unparsed += 1;
    continue;
  }
  const text = lines.slice(lines.indexOf(timing) + 1).join(" ");
  cues.push({ start, end, text });
}
if (!cues.length) {
  console.error(`${file}: no cues`);
  process.exit(1);
}

const seen = new Map(); // word -> {rank, count, firstMs, capitalMid}
let tokens = 0;
const perCue = [];
/* Two maps, because the overlay's rule changed and both numbers are worth
 * keeping. `marked` is what it put on screen when every rare word competed for
 * the same two places, which is where the 27.8% name share in
 * docs/reports/what-the-script-is-worth.md was measured. `markedVocabulary` is
 * what it puts there now that a name is its own kind and does not enter the
 * contest. Reporting only the second would make that report unreproducible. */
const marked = new Map();
const markedVocabulary = new Map();

/* A name, guessed the only way a subtitle file allows: capitalised where a
 * sentence did not just start. Walked with real match positions rather than
 * indexOf, which returns the FIRST occurrence of a surface form and therefore
 * reads the wrong context for any word said twice in one line.
 *
 * Sentence-start is generous on purpose - the opening of a line, the word
 * after . ! ? or an ellipsis, and the word after a dash, which is how a
 * subtitle marks the second speaker. Each of those would otherwise be read as
 * a mid-sentence capital and inflate the count.
 *
 * A pass of its own, ahead of the marking, because the verdict is about the
 * whole file: three cues in, an incremental count has met a name once and has
 * no opinion worth having. The overlay reads the file before it marks its first
 * line for exactly this reason, so measuring it any other way would measure
 * something the overlay does not do. */
for (const cue of cues) {
  const spoken = cue.text.replace(NOT_SPOKEN, " ");
  for (const match of spoken.matchAll(WORD_PATTERN)) {
    const raw = match[0];
    const lower = fold(raw);
    const before = spoken.slice(0, match.index).replace(/["'“”‘’()\[\]]+\s*$/, "").trimEnd();
    const sentenceStart = before === "" || /[.!?…:]$/.test(before) || /(^|\s)[-–—]$/.test(before);
    const entry = seen.get(lower) || { rank: rankOf(lower), count: 0, firstMs: cue.start, capitalMid: 0 };
    if (!sentenceStart && /^[\p{Lu}]/u.test(raw)) entry.capitalMid += 1;
    entry.count += 1;
    seen.set(lower, entry);
  }
}

const isName = (it) => it.capitalMid >= Math.max(1, it.count * 0.5);

for (const cue of cues) {
  const spoken = cue.text.replace(NOT_SPOKEN, " ");
  const words = (spoken.match(WORD_PATTERN) || []).map(fold);
  let rareHere = 0;
  const candidates = [];
  for (const word of words) {
    tokens += 1;
    const rank = seen.get(word).rank;
    const enough = (word.match(LETTERS) || []).length >= MIN_LETTERS;
    if (enough && (rank === null || rank >= threshold)) {
      rareHere += 1;
      candidates.push({ word, rank: rank === null ? Infinity : rank });
    }
  }
  // Rarest first, which is how the overlay spends its two places.
  candidates.sort((a, b) => b.rank - a.rank);
  for (const pick of candidates.slice(0, MAX_PER_CUE)) {
    marked.set(pick.word, (marked.get(pick.word) || 0) + 1);
  }
  // The same contest with the names withdrawn: the places they were taking go
  // to the next-rarest words rather than going unspent.
  for (const pick of candidates.filter((it) => !isName(seen.get(it.word))).slice(0, MAX_PER_CUE)) {
    markedVocabulary.set(pick.word, (markedVocabulary.get(pick.word) || 0) + 1);
  }
  const seconds = Math.max(0.001, (cue.end - cue.start) / 1000);
  perCue.push({
    startMs: cue.start,
    seconds,
    chars: spoken.trim().length,
    charsPerSecond: spoken.trim().length / seconds,
    words: words.length,
    rare: rareHere,
  });
}

const rare = [...seen.entries()]
  .filter(([word, it]) =>
    (word.match(LETTERS) || []).length >= MIN_LETTERS &&
    (it.rank === null || it.rank >= threshold))
  .sort((a, b) => b[1].count - a[1].count);
const repeated = rare.filter(([, it]) => it.count >= 3);

const filmMs = cues[cues.length - 1].end;
const minutes = Math.ceil(filmMs / 60000);
const perMinute = Array.from({ length: minutes }, () => 0);
for (const cue of perCue) perMinute[Math.floor(cue.startMs / 60000)] += cue.rare;

const share = (n, of) => `${((n / of) * 100).toFixed(1)}%`;
const sorted = [...perCue].map((c) => c.charsPerSecond).sort((a, b) => a - b);
const at = (q) => sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * q))];
// 17 chars/second is the usual professional subtitling ceiling for adults.
const FAST = 17;

console.log(JSON.stringify({
  file: basename(file),
  language: lang,
  rarerThan: threshold,
  cues: cues.length,
  unparsedCues: unparsed,
  runtimeMin: +(filmMs / 60000).toFixed(1),
  tokens,
  uniqueWords: seen.size,
  rareTypes: rare.length,
  rareTypeShare: share(rare.length, seen.size),
  rareTokens: perCue.reduce((sum, c) => sum + c.rare, 0),
  rareTokenShare: share(perCue.reduce((sum, c) => sum + c.rare, 0), tokens),
  repeatedRareTypes: repeated.length,
  repeatedRareCoverage: share(
    repeated.reduce((sum, [, it]) => sum + it.count, 0),
    perCue.reduce((s, c) => s + c.rare, 0),
  ),
  topRepeatedRare: repeated.slice(0, 15).map(([word, it]) => [word, it.count, isName(it) ? "name" : "word"]),
  // Of the words the overlay would actually put on screen, how many are names.
  markedTokens: [...marked.values()].reduce((a, b) => a + b, 0),
  markedTypes: marked.size,
  markedVocabularyTokens: [...markedVocabulary.values()].reduce((a, b) => a + b, 0),
  markedVocabularyTypes: markedVocabulary.size,
  markedNameTokens: [...marked.entries()]
    .filter(([word]) => isName(seen.get(word)))
    .reduce((sum, [, n]) => sum + n, 0),
  repeatedRareNames: repeated.filter(([, it]) => isName(it)).length,
  /* How much of the film's rare-word traffic the commonest N of them account
   * for. This is the pre-study argument in one array: if a short list covers
   * most of the occurrences, learning it before pressing play is worth doing,
   * and if the curve is flat there is nothing to pre-teach. */
  coverageCurve: (() => {
    const totalRare = perCue.reduce((sum, c) => sum + c.rare, 0);
    const counts = rare.map(([, it]) => it.count);
    const notNames = rare.filter(([, it]) => !isName(it)).map(([, it]) => it.count);
    const cumulative = (list, n) => list.slice(0, n).reduce((a, b) => a + b, 0);
    const points = [];
    for (let n = 10; n <= 160; n += 10) {
      points.push({
        words: n,
        withNames: +((cumulative(counts, n) / totalRare) * 100).toFixed(1),
        withoutNames: +((cumulative(notNames, n) / totalRare) * 100).toFixed(1),
      });
    }
    return points;
  })(),
  charsPerSecond: { p50: +at(0.5).toFixed(1), p90: +at(0.9).toFixed(1), p99: +at(0.99).toFixed(1) },
  cuesOverFast: perCue.filter((c) => c.charsPerSecond > FAST).length,
  cuesOverFastShare: share(perCue.filter((c) => c.charsPerSecond > FAST).length, perCue.length),
  rarePerMinute: {
    max: Math.max(...perMinute),
    median: [...perMinute].sort((a, b) => a - b)[Math.floor(perMinute.length / 2)],
    zeroMinutes: perMinute.filter((n) => n === 0).length,
    minutes: perMinute.length,
    series: perMinute,
  },
}, null, 1));
