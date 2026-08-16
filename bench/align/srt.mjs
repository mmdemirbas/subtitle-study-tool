/* Reading a subtitle file for everything except its timings.
 *
 * corpus.mjs reads the same files as latin-1 and looks only at the timestamps,
 * which is right for what it does and wrong for everything here. This module
 * exists because two questions turned out to need the words:
 *
 *   which language is this?   The cache's sidecars carry `language: null` for
 *                             every file the reader downloaded while watching,
 *                             so the bench believed its corpus held two
 *                             languages when it holds two languages it cannot
 *                             tell apart. A Turkish file with an English
 *                             release name (The.Americans.S02E09.1080p.WEB-DL)
 *                             is not a rare accident; it is most of them.
 *
 *   what lines up with what?  Timings are the thing under test, so a ground
 *                             truth built from timings is a tautology. The
 *                             text is the one part of a subtitle file that no
 *                             alignment method touches.
 */
import fs from "node:fs";

const TIME = /(\d+):(\d+):(\d+)[,.](\d+)\s*-->\s*(\d+):(\d+):(\d+)[,.](\d+)/;

/* UTF-8 first, Windows-1254 second. Reading a Turkish file as latin-1 turns
 * "Amerikalılar" into "AmerikalÄ±lar", which compares equal to nothing and
 * detects as no language at all. These files are one encoding or the other. */
export function decode(buffer) {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(buffer);
  } catch {
    return new TextDecoder("windows-1254").decode(buffer);
  }
}

/** Cue text with the parts that are not speech removed. */
export function normalise(text) {
  return String(text)
    .replace(/<[^>]*>/g, " ")           // <i>, <font color=...>
    .replace(/\{[^}]*\}/g, " ")         // {\an8} and the rest of the SSA leftovers
    .replace(/[[(][^\])]*[\])]/g, " ")  // [ brakes hiss ], (SIGHS)
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
}

/* Detected from the words, not from the filename and not from the sidecar.
 *
 * Two short stop-word lists and whichever matches more. Turkish gets its
 * dotless-i family as well, because a file can be short on stop words and
 * still be unmistakable from one letter. */
const STOPS = {
  en: new Set("the and you that is was for with have this what are not but his her they there when from him she all out about would there're".split(" ")),
  tr: new Set("bir bu ne için ve değil çok daha gibi ama var yok şey benim senin onun beni seni onu kadar sonra".split(" ")),
};
const TURKISH_LETTERS = /[ığşİıĞŞ]/;

export function detectLanguage(cues) {
  const words = [];
  for (const cue of cues) {
    for (const word of normalise(cue.text).split(" ")) if (word) words.push(word);
    if (words.length > 4000) break;
  }
  if (words.length < 40) return null;
  const score = {};
  for (const [code, stops] of Object.entries(STOPS)) {
    let hit = 0;
    for (const word of words) if (stops.has(word)) hit++;
    score[code] = hit / words.length;
  }
  /* The letters are worth a thumb on the scale rather than a decision: an
   * English subtitle for a Turkish film carries Turkish proper nouns. */
  const joined = cues.slice(0, 200).map((c) => c.text).join(" ");
  if (TURKISH_LETTERS.test(joined)) score.tr += 0.02;
  const [best, second] = Object.entries(score).sort((a, b) => b[1] - a[1]);
  // Both under a percent means neither list matched; say nothing rather than guess.
  if (best[1] < 0.01 || best[1] < second[1] * 1.5) return null;
  return best[0];
}

/** Every cue in the file, with its text, plus the language the text is in. */
export function readCues(file) {
  const cues = [];
  let pending = null;
  for (const line of decode(fs.readFileSync(file)).split(/\r?\n/)) {
    const m = TIME.exec(line);
    if (m) {
      const at = (h, mi, s, ms) => ((+h * 60 + +mi) * 60 + +s) * 1000 + +ms;
      pending = { start: at(m[1], m[2], m[3], m[4]), end: at(m[5], m[6], m[7], m[8]), text: [] };
      if (pending.end > pending.start) cues.push(pending);
      else pending = null;
      continue;
    }
    if (!pending) continue;
    if (!line.trim()) { pending = null; continue; }
    pending.text.push(line);
  }
  cues.sort((a, b) => a.start - b.start);
  for (const cue of cues) cue.text = cue.text.join(" ").replace(/\s+/g, " ").trim();
  return { cues, language: detectLanguage(cues) };
}
