/* Which cues are not dialogue at all.
 *
 *     node tools/measure-noise.mjs [--show 40]
 *
 * A subtitle file carries lines nobody said: the site that made it, the person
 * who synced it, the release it was cut for. Study mode reads them as speech.
 * Measured once and left open: `www`, `addic`, `synced` and `corrections` are
 * all in the answer cache on this machine, so they were marked, glossed and put
 * on screen as vocabulary.
 *
 * This counts them, and - because a rule that deletes is judged by what it
 * deletes - prints every cue it would drop and every word that stops being
 * marked because of it.
 */

import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const CACHE = join(HERE, "..", "..", "subtitle-daemon", "cache", "subtitles");
const show = Number(process.argv[process.argv.indexOf("--show") + 1]) || 30;

const WORD = /[\p{L}\p{M}]([\p{L}\p{M}'’-]*[\p{L}\p{M}])?/gu;
const LETTERS = /[\p{L}\p{M}]/gu;

/* What a line that nobody spoke looks like.
 *
 * Three shapes, and they are deliberately narrow: a rule that guesses at
 * dialogue would eat real lines, and a film that mentions a website in the
 * script is a film whose script mentions a website. What they all share is that
 * they name the ARTEFACT rather than anything in it. */
/* A line that is NOTHING but a web address. Not merely one that contains a
 * URL: "I think it's petersonsyard.com" is somebody speaking, and a rule that
 * eats it is eating dialogue to catch a credit. */
const TAGS = /<[^>]*>/g;
const WEB_ONLY = /^[\s©@~*_·—–-]*(?:https?:\/\/)?(?:www\.)?[\w-]+(?:\.[\w-]+)+\/?[\s©@~*_·—–-]*$/i;
const CREDIT = /\b(?:sync(?:ed|hroniz(?:ed|ation))?|correct(?:ed|ions?)|subtitl(?:es?|ed)|translat(?:ed|ion)|transcri(?:bed|pt)|encoded?|ripp?ed|resync)\b[^.\n]{0,40}\bby\b/i;
const SITE = /\b(?:addic7ed|opensubtitles|subscene|podnapisi|yify|yts|rarbg|napiprojekt|legendas|subtitleseeker|tvsubtitles)\b/i;
const RELEASE = /\b(?:\d{3,4}p|bluray|blu-ray|web-?dl|webrip|hdtv|dvdrip|brrip|x26[45]|h\.?26[45]|xvid|aac|ac3|dts|hevc)\b/i;

export const notSpoken = (text) => {
  const flat = String(text).replace(/\s+/g, " ").trim();
  if (!flat) return "";
  const bare = flat.replace(TAGS, " ").replace(/\s+/g, " ").trim();
  if (bare && WEB_ONLY.test(bare)) return "web";
  if (SITE.test(flat)) return "site";
  if (CREDIT.test(flat)) return "credit";
  if (RELEASE.test(flat)) return "release";
  return "";
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

const ranks = new Map();
readFileSync(join(HERE, "..", "src", "study", "frequency-en.generated.txt"), "utf8")
  .split("\n").filter(Boolean).forEach((w, i) => ranks.set(w, i));
const rankOf = (w) => {
  if (ranks.has(w)) return ranks.get(w);
  const at = w.search(/['’]/);
  if (at > 0 && ranks.has(w.slice(0, at))) return ranks.get(w.slice(0, at));
  return null;
};
const letters = (w) => (w.match(LETTERS) || []).length;

const ENGLISH = /\b(the|and|you)\b/gi;
let films = 0, affected = 0, cues = 0, dropped = 0, rareGone = 0;
const kinds = new Map();
const samples = [];
const words = new Map();

for (const name of readdirSync(CACHE).sort()) {
  if (!name.endsWith(".srt")) continue;
  let text;
  try { text = readFileSync(join(CACHE, name), "utf8"); } catch { continue; }
  if ((text.match(ENGLISH) || []).length < 50) continue;
  films += 1;
  const all = cuesOf(text);
  cues += all.length;
  let any = false;
  for (const cue of all) {
    const kind = notSpoken(cue);
    if (!kind) continue;
    any = true;
    dropped += 1;
    kinds.set(kind, (kinds.get(kind) || 0) + 1);
    if (samples.length < show) samples.push([kind, cue.replace(/\n/g, " ⏎ ").slice(0, 96)]);
    /* Through the same strip the marking rule applies, or this counts words
     * that were never marked in the first place - "cyan" and "corsiva" live
     * inside a font tag and study.js has always cut those out. */
    const spoken = cue.replace(/\[[^\]]*\]|\([^)]*\)|♪|<[^>]*>/g, " ");
    for (const match of spoken.matchAll(WORD)) {
      const w = match[0].toLowerCase();
      if (letters(w) < 3) continue;
      const rank = rankOf(w);
      if (rank === null || rank >= 12000) {
        rareGone += 1;
        words.set(w, (words.get(w) || 0) + 1);
      }
    }
  }
  if (any) affected += 1;
}

console.log(`${films} English films, ${cues} cues`);
console.log(`cues that name the artefact rather than anything in it: ${dropped}, in ${affected} films`);
console.log(`  by shape: ${[...kinds].map(([k, n]) => `${k} ${n}`).join(", ")}`);
console.log(`marks they would stop producing: ${rareGone} tokens, ${words.size} distinct\n`);
console.log("WHAT STOPS BEING MARKED:");
for (const [w, n] of [...words].sort((a, b) => b[1] - a[1]).slice(0, show)) {
  console.log(`  ${w.padEnd(20)} ${n}`);
}
console.log("\nWHAT IS DROPPED, a sample:");
for (const [kind, cue] of samples) console.log(`  [${kind}] ${cue}`);
