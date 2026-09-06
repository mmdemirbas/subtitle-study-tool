/* Which of the marked words are somebody's name.
 *
 *     node tools/measure-names.mjs [--show 40]
 *
 * Measured once already and left open: over the 175 English subtitles in the
 * daemon's cache, 24.2% of everything the marking rule marks is a proper noun.
 * "paige" was marked in 60 of those films, "beeman" in 19, "emmett" in 13. A
 * mark on a character's name is the worst kind there is - it is never worth
 * learning, it takes one of the two places a line has, and the tier under it
 * has no idea it is looking at a name.
 *
 * The rule in study.js calls a word a name when it is capitalised in the middle
 * of a sentence at least half the times it appears. That is why it misses these
 * ones: a character is addressed, so the name opens the line - "Paige, come
 * down here" - or follows the dash that marks the second speaker, and neither
 * position counts as a mid-sentence capital.
 *
 * This measures a candidate that does not need the middle of a sentence: a word
 * capitalised EVERY time it appears, appearing more than once, that the
 * frequency table has never heard of. Rarity is what keeps "Well" and "Yes" out
 * of it - they open lines constantly and are ranked - and the repeat is what
 * keeps a one-off out.
 *
 * It prints what the candidate would REMOVE, by name and with counts, because a
 * rule that deletes cannot be judged by what survives it.
 */

import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const CACHE = join(HERE, "..", "..", "subtitle-daemon", "cache", "subtitles");
const show = Number(process.argv[process.argv.indexOf("--show") + 1]) || 40;

// The same shapes study.js uses, so what is measured is what would happen.
const WORD = /[\p{L}\p{M}]([\p{L}\p{M}'’-]*[\p{L}\p{M}])?/gu;
const CAPITAL = /^[\p{Lu}]/u;
const BRACKETED = /\[([^\]]*)\]|\(([^)]*)\)/g;
const NOT_SPOKEN = /\[[^\]]*\]|\([^)]*\)|♪|<[^>]*>/g;
const LETTERS = /[\p{L}\p{M}]/gu;

const ranks = new Map();
readFileSync(join(HERE, "..", "src", "study", "frequency-en.generated.txt"), "utf8")
  .split("\n").filter(Boolean).forEach((w, i) => ranks.set(w, i));
const rankOf = (w) => {
  if (ranks.has(w)) return ranks.get(w);
  const at = w.search(/['’]/);
  if (at > 0 && ranks.has(w.slice(0, at))) return ranks.get(w.slice(0, at));
  return null;
};

const cuesOf = (text) => {
  const out = [];
  for (const block of text.replace(/\r/g, "").split(/\n\s*\n/)) {
    const lines = block.split("\n");
    const at = lines.findIndex((l) => l.includes("-->"));
    if (at === -1) continue;
    const said = lines.slice(at + 1).join("\n").trim();
    if (said) out.push(said);
  }
  return out;
};

/* study.js's namesIn, ported. Kept literal rather than tidied: a measurement of
 * a rule that is not the rule measures nothing. */
function namesIn(texts) {
  const labelled = new Set();
  const seen = new Map();
  for (const text of texts) {
    for (const bracket of String(text).matchAll(BRACKETED)) {
      const inside = bracket[1] ?? bracket[2] ?? "";
      for (const match of inside.matchAll(WORD)) {
        if (CAPITAL.test(match[0])) labelled.add(match[0].toLowerCase());
      }
    }
    const spoken = String(text).replace(NOT_SPOKEN, " ");
    for (const match of spoken.matchAll(WORD)) {
      const word = match[0].toLowerCase();
      const before = spoken.slice(0, match.index)
        .replace(/["'“”‘’()[\]]+\s*$/, "").trimEnd();
      const opens = before === "" || /[.!?…:]$/.test(before)
        || /(^|\s)[-–—]$/.test(before);
      const entry = seen.get(word) || { count: 0, capitalMid: 0, capitals: 0 };
      if (!opens && CAPITAL.test(match[0])) entry.capitalMid += 1;
      if (CAPITAL.test(match[0])) entry.capitals += 1;
      entry.count += 1;
      seen.set(word, entry);
    }
  }
  const names = new Set(labelled);
  for (const [word, entry] of seen) {
    if (entry.capitalMid >= Math.max(1, entry.count * 0.5)) names.add(word);
  }
  return { names, seen };
}

const RARITY = 12000;   // the study default
const MIN_LETTERS = 3;
const letters = (w) => (w.match(LETTERS) || []).length;

let films = 0, marked = 0, wouldGo = 0;
const removes = new Map();   // word -> {films, tokens}
const ENGLISH = /\b(the|and|you)\b/gi;

for (const name of readdirSync(CACHE).sort()) {
  if (!name.endsWith(".srt")) continue;
  let text;
  try { text = readFileSync(join(CACHE, name), "utf8"); } catch { continue; }
  if ((text.match(ENGLISH) || []).length < 50) continue;
  films += 1;
  const texts = cuesOf(text);
  const { names, seen } = namesIn(texts);

  const gone = new Set();
  for (const [word, entry] of seen) {
    if (names.has(word)) continue;                       // already refused
    if (letters(word) < MIN_LETTERS) continue;
    const rank = rankOf(word);
    const isRare = rank === null || rank >= RARITY;
    if (!isRare) continue;                               // never marked anyway
    marked += entry.count;
    /* The candidate: capitalised every time, seen more than once, and a word
     * the table has never heard of. */
    if (entry.capitals === entry.count && entry.count > 1 && rank === null) {
      wouldGo += entry.count;
      gone.add(word);
      const held = removes.get(word) || { films: 0, tokens: 0 };
      held.tokens += entry.count;
      removes.set(word, held);
    }
  }
  for (const word of gone) removes.get(word).films += 1;
}

console.log(`${films} English films`);
console.log(`marked as rare, after the name rule refused what it could: ${marked} tokens`);
console.log(`the candidate would also refuse: ${wouldGo} (${(100 * wouldGo / marked).toFixed(1)}%)`);
console.log(`distinct words it refuses: ${removes.size}\n`);
console.log(`WHAT IT REMOVES, commonest first (a rule that deletes is judged by this):`);
for (const [word, held] of [...removes].sort((a, b) => b[1].tokens - a[1].tokens).slice(0, show)) {
  console.log(`  ${word.padEnd(18)} ${String(held.tokens).padStart(5)} tokens  in ${held.films} film(s)`);
}
