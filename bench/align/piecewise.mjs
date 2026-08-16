#!/usr/bin/env node
/* Is one number enough to line these two subtitles up?
 *
 * The aligner answers "what is the gap between these two files" with a single
 * shift, and the drift estimator answers "what is the slope" with a single
 * rate. Both are answers to a question the reader may not be asking. Somebody
 * who corrects the sync four times in one episode is telling you the true
 * relationship is neither a constant nor a line - and nothing in the extension
 * measured which of those three it is.
 *
 * This does. It cuts the film into windows, finds the best shift inside each
 * one on its own, and prints them as a column. Three shapes and three
 * different fixes:
 *
 *   flat        one shift is right; the aligner just picked the wrong peak
 *   sloped      a framerate mismatch; a rate fixes it, an offset never will
 *   stepped     the files are cut differently - ad breaks, a recap, a scene
 *               missing from one release. No single shift and no rate exists.
 *               This is the case that needs anchors, and the only way to know
 *               it is the case is to measure it.
 *
 * Usage:
 *   node bench/align/piecewise.mjs <idA> <idB> [--window 240] [--text 3]
 *
 * ids are OpenSubtitles file ids as cached under subtitle-daemon/cache/subtitles.
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, "../..");
const CACHE = path.join(REPO, "subtitle-daemon/cache/subtitles");

const TIME = /(\d+):(\d+):(\d+)[,.](\d+)\s*-->\s*(\d+):(\d+):(\d+)[,.](\d+)/;

/* Timings AND text, which is the difference between this and corpus.mjs. A
 * shift that lines two files up numerically can still be lining up the wrong
 * lines - two people speaking four seconds apart in a scene where everybody
 * talks - and the only way to tell is to read what got matched. */
/* UTF-8 first, Windows-1254 second. corpus.mjs reads latin-1 because it only
 * ever looks at timestamps, and a byte that decodes to the wrong letter still
 * decodes. Here the text is the point - a Turkish line read as latin-1 comes
 * out as "AmerikalÄ±lar", which cannot be compared with anything - so the
 * encoding has to be right, and these files are one or the other. */
function decode(buffer) {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(buffer);
  } catch {
    return new TextDecoder("windows-1254").decode(buffer);
  }
}

function read(id) {
  const file = path.join(CACHE, `${id}.srt`);
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
  for (const cue of cues) {
    cue.text = cue.text.join(" ").replace(/<[^>]*>/g, "").replace(/\s+/g, " ").trim();
  }

  let meta = {};
  const beside = path.join(CACHE, `${id}.json`);
  if (fs.existsSync(beside)) {
    try { meta = JSON.parse(fs.readFileSync(beside, "utf8")); } catch { meta = {}; }
  }
  return {
    id,
    cues,
    language: meta.language ?? "?",
    release: meta.release || meta.file_name || "?",
    title: meta.movie_name || "?",
  };
}

/* The best shift over one slice of the film, by voting.
 *
 * Every A start inside the window votes for every difference to a B start
 * within reach, and the winning bin is the shift. Deliberately not the shipped
 * aligner: that one searches for a rate as well, and over four minutes a rate
 * is unconstrained - it would fit the noise and report a confident answer to a
 * question this is not asking. One quantity, one estimator.
 *
 * The vote is counted over three bins, not one. At 50ms bins a genuine shift
 * splits across a boundary as often as not, and two subtitlers who cut the
 * same line differently disagree by tens of milliseconds even when they agree.
 */
const BIN = 50;
function localShift(aStarts, bStarts, maxLagMs) {
  const votes = new Map();
  let bFrom = 0;
  for (const a of aStarts) {
    while (bFrom < bStarts.length && bStarts[bFrom] < a - maxLagMs) bFrom += 1;
    for (let j = bFrom; j < bStarts.length; j++) {
      const diff = bStarts[j] - a;
      if (diff > maxLagMs) break;
      const bin = Math.round(diff / BIN);
      votes.set(bin, (votes.get(bin) || 0) + 1);
    }
  }
  let bestBin = null;
  let best = 0;
  for (const [bin] of votes) {
    const near = (votes.get(bin - 1) || 0) + (votes.get(bin) || 0) + (votes.get(bin + 1) || 0);
    if (near > best) { best = near; bestBin = bin; }
  }
  if (bestBin === null) return null;

  /* The peak's own centre of mass, so the answer is not quantised to 50ms.
   * The reader can hear a tenth of a second. */
  let mass = 0;
  let weight = 0;
  for (let d = -1; d <= 1; d++) {
    const n = votes.get(bestBin + d) || 0;
    mass += n * (bestBin + d) * BIN;
    weight += n;
  }
  return {
    shiftMs: Math.round(mass / Math.max(1, weight)),
    votes: best,
    // What share of this window's lines found a partner at the winning shift.
    share: best / Math.max(1, aStarts.length),
  };
}

/* A line through the windows, by Theil-Sen: the median of the slopes of every
 * pair. Least squares would be dragged by one stepped window, which is exactly
 * the shape being tested for. */
function fitLine(points) {
  const slopes = [];
  for (let i = 0; i < points.length; i++) {
    for (let j = i + 1; j < points.length; j++) {
      const dx = points[j].at - points[i].at;
      if (dx < 300000) continue; // five minutes apart, or the slope is noise
      slopes.push((points[j].shiftMs - points[i].shiftMs) / dx);
    }
  }
  if (!slopes.length) return null;
  slopes.sort((x, y) => x - y);
  const slope = slopes[slopes.length >> 1];
  const intercepts = points.map((p) => p.shiftMs - slope * p.at).sort((x, y) => x - y);
  return { slope, intercept: intercepts[intercepts.length >> 1] };
}

const asTime = (ms) => {
  const s = Math.max(0, Math.round(ms / 1000));
  return `${String(Math.floor(s / 60)).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`;
};

// --- run ---------------------------------------------------------------------

const argv = process.argv.slice(2);
const flag = (name, fallback) => {
  const at = argv.indexOf(`--${name}`);
  return at === -1 ? fallback : Number(argv[at + 1]);
};
// Whatever is left once the flags and their values are taken out.
const positional = [];
for (let i = 0; i < argv.length; i++) {
  if (argv[i].startsWith("--")) { i += 1; continue; }
  positional.push(argv[i]);
}
const [idA, idB] = positional;

if (!idA || !idB || !fs.existsSync(path.join(CACHE, `${idA}.srt`)) || !fs.existsSync(path.join(CACHE, `${idB}.srt`))) {
  console.error("usage: node bench/align/piecewise.mjs <idA> <idB> [--window 240] [--text 3]");
  console.error("both ids must exist under subtitle-daemon/cache/subtitles");
  process.exit(2);
}

const WINDOW_S = flag("window", 240);
const SHOW_TEXT = flag("text", 0);
const MAX_LAG_MS = 60000;

const A = read(idA);
const B = read(idB);
const aStarts = A.cues.map((c) => c.start);
const bStarts = B.cues.map((c) => c.start);

await import(`${REPO}/browser-extension/src/align.js`);
const shipped = globalThis.__ssoAlign;
const whole = shipped.align(aStarts, bStarts);

console.log(`A  ${A.id}  ${A.language}  ${A.cues.length} cues  ${asTime(aStarts[0])}..${asTime(aStarts[aStarts.length - 1])}  ${A.release}`);
console.log(`B  ${B.id}  ${B.language}  ${B.cues.length} cues  ${asTime(bStarts[0])}..${asTime(bStarts[bStarts.length - 1])}  ${B.release}`);
console.log("");
console.log(
  `align.js over the whole file: ${whole.ok ? `${whole.shiftMs}ms` : "no answer"}` +
  `  verdict=${whole.verdict ?? (whole.ok ? "offer" : "no")}` +
  `  confidence=${Number(whole.confidence).toFixed(2)}` +
  `  coverage=${(whole.coverage ?? 0).toFixed(2)}` +
  `  rate=${whole.rate ?? 1}`,
);
console.log("");

const span = aStarts[aStarts.length - 1];
const rows = [];
for (let from = 0; from < span; from += WINDOW_S * 1000) {
  const to = from + WINDOW_S * 1000;
  const inWindow = aStarts.filter((s) => s >= from && s < to);
  if (inWindow.length < 8) continue;
  const found = localShift(inWindow, bStarts, MAX_LAG_MS);
  if (!found) continue;
  rows.push({ at: from + (WINDOW_S * 1000) / 2, from, cues: inWindow.length, ...found });
}

console.log(`the best shift inside each ${WINDOW_S}s window, measured on its own:`);
console.log("");
console.log("  window        A cues   shift      lines matched");
for (const row of rows) {
  const bar = "#".repeat(Math.max(0, Math.round(row.share * 20)));
  console.log(
    `  ${asTime(row.from)}-${asTime(row.from + WINDOW_S * 1000)}` +
    `   ${String(row.cues).padStart(4)}   ` +
    `${(row.shiftMs / 1000).toFixed(2).padStart(8)}s   ` +
    `${String(Math.round(row.share * 100)).padStart(3)}%  ${bar}`,
  );
}
console.log("");

// Windows where enough lines agreed to be worth believing.
const solid = rows.filter((r) => r.share >= 0.35);
const shifts = solid.map((r) => r.shiftMs).sort((x, y) => x - y);
if (shifts.length >= 3) {
  const median = shifts[shifts.length >> 1];
  const spread = shifts[shifts.length - 1] - shifts[0];
  const line = fitLine(solid);
  console.log(`${solid.length} of ${rows.length} windows matched at least 35% of their lines.`);
  console.log(`  median shift   ${(median / 1000).toFixed(2)}s`);
  console.log(`  spread         ${(spread / 1000).toFixed(2)}s  (${shifts[0] / 1000}s to ${shifts[shifts.length - 1] / 1000}s)`);
  if (line) {
    const drift = line.slope * span;
    const residuals = solid
      .map((r) => Math.abs(r.shiftMs - (line.intercept + line.slope * r.at)))
      .sort((x, y) => x - y);
    console.log(
      `  best line      ${(line.intercept / 1000).toFixed(2)}s at the start, ` +
      `${(drift / 1000).toFixed(2)}s of drift by the end ` +
      `(rate ${(1 + line.slope).toFixed(5)})`,
    );
    console.log(`  left over      median ${Math.round(residuals[residuals.length >> 1])}ms, worst ${Math.round(residuals[residuals.length - 1])}ms`);
    console.log("");
    /* The reading, said out loud rather than left to the reader of a table.
     * A quarter of a second is about where a mismatch stops being visible. */
    const worst = residuals[residuals.length - 1];
    if (spread <= 400) console.log("  FLAT - one shift covers the whole film.");
    else if (worst <= 400) console.log("  SLOPED - a rate covers it; no single shift can.");
    else console.log("  STEPPED - neither a shift nor a rate covers it. The two files are cut differently.");

    /* And what the shipped answer is worth, in minutes of film rather than in
     * confidence. A single shift is not right or wrong; it is right over some
     * part of the film and wrong over the rest, and that fraction is the thing
     * the reader experiences as "I had to correct it again". */
    if (whole.ok) {
      const minutes = solid.reduce((total, r) => total + (r.cues ? WINDOW_S / 60 : 0), 0);
      const within = (ms) => solid
        .filter((r) => Math.abs(r.shiftMs - whole.shiftMs) <= ms)
        .reduce((total) => total + WINDOW_S / 60, 0);
      console.log("");
      console.log(
        `  align.js would apply ${(whole.shiftMs / 1000).toFixed(2)}s. Of ${minutes.toFixed(0)} minutes ` +
        `where a shift could be measured, that is right to within` +
        ` 250ms over ${within(250).toFixed(0)}, 1s over ${within(1000).toFixed(0)}, ` +
        `and out by more than 2s over ${(minutes - within(2000)).toFixed(0)}.`,
      );
    }
  }
}

if (SHOW_TEXT > 0) {
  console.log("");
  console.log(`what got matched, ${SHOW_TEXT} lines per window:`);
  for (const row of rows) {
    console.log("");
    console.log(`  --- ${asTime(row.from)} shifted by ${(row.shiftMs / 1000).toFixed(2)}s, ${Math.round(row.share * 100)}% matched`);
    const here = A.cues.filter((c) => c.start >= row.from && c.start < row.from + WINDOW_S * 1000);
    const step = Math.max(1, Math.floor(here.length / SHOW_TEXT));
    for (let i = 0; i < here.length && i / step < SHOW_TEXT; i += step) {
      const want = here[i].start + row.shiftMs;
      let near = null;
      for (const cue of B.cues) {
        if (near === null || Math.abs(cue.start - want) < Math.abs(near.start - want)) near = cue;
        if (cue.start > want + 30000) break;
      }
      console.log(`    A ${asTime(here[i].start)}  ${here[i].text.slice(0, 78)}`);
      console.log(`    B ${asTime(near.start)}  ${near.text.slice(0, 78)}   (${near.start - want > 0 ? "+" : ""}${near.start - want}ms)`);
    }
  }
}
