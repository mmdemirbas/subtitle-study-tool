#!/usr/bin/env node
/* What shape is the truth, across the whole corpus?
 *
 *   node bench/align/shapes.mjs                # the census
 *   node bench/align/shapes.mjs --penalty      # the calibration behind it
 *
 * Every same-film pair whose text can settle it is fitted three ways - one
 * shift, one line, one line with per-segment offsets - and reported as
 * whichever is the simplest that fits about as well as the best of them.
 *
 * The point of the census is that the aligner's model is a choice - it offers
 * one shift and one rate from a list of seven - and until now nobody had
 * counted how often that is the right model for a real pair of files.
 */
import { load, pairs, check } from "./corpus.mjs";
import { anchorsFor, shapeOf, segment, fitRate, scaleOf, PENALTY_SIGMAS } from "./truth.mjs";

const files = load();
check(files);
const all = pairs(files).filter((p) => p.label !== "different");

const found = [];
const refused = [];
for (const p of all) {
  const points = anchorsFor(p.a, p.b);
  if (!points) { refused.push(p); continue; }
  const shape = shapeOf(points);
  if (!shape) { refused.push(p); continue; }
  found.push({ ...p, points, shape });
}

const languagesOf = (p) => [p.a.language, p.b.language];
const sameLanguage = (p) => p.a.language && p.a.language === p.b.language;

console.log(`corpus: ${files.size} files, ${all.length} same-film pairs`);
console.log(`  of those, ${all.filter(sameLanguage).length} are same-language and ` +
  `${all.filter((p) => !sameLanguage(p)).length} are cross-language\n`);
console.log(`TRUTH FROM TEXT - ${found.length} pairs settled, ${refused.length} refused`);
console.log(`  refused and same-language: ${refused.filter(sameLanguage).length} ` +
  `(independent transcriptions - no shared lines to anchor on)`);
console.log(`  refused and cross-language: ${refused.filter((p) => !sameLanguage(p)).length} ` +
  `(no shared text by construction; there is no oracle for these)\n`);

if (process.argv.includes("--penalty")) {
  /* The control that makes the segment count meaningful.
   *
   * A segmenter with a free hand always finds more segments, so the number of
   * breaks it reports is worthless until it has been shown returning ONE on a
   * pair that needs one. These are the flat pairs: two files already sharing a
   * clock, where every break is a break in noise. */
  const flat = found.filter((f) => f.shape.kind === "flat");
  const stepped = found.filter((f) => f.shape.kind === "stepped");
  console.log("PENALTY CALIBRATION - segments found on pairs that need one, against pairs that do not\n");
  console.log(`${"sigmas".padStart(8)} ${"flat pairs -> segments".padStart(26)} ${"stepped pairs -> segments".padStart(28)}`);
  const median = (v) => { const s = [...v].sort((a, b) => a - b); return s.length ? s[s.length >> 1] : NaN; };
  for (const sigmas of [1, 3, 6, 12, 25, 50, 200]) {
    const count = (list) => list.map((f) => {
      const rate = fitRate(f.points);
      const residuals = f.points.map((p) => p.y - rate * p.x);
      return segment(residuals, {
        penalty: sigmas * Math.max(scaleOf(residuals), 10) ** 2,
        at: (i) => f.points[i].x,
      }).length;
    });
    const onFlat = count(flat), onStepped = count(stepped);
    console.log(`${String(sigmas).padStart(8)} ${`${median(onFlat)} (worst ${Math.max(...onFlat, 0)})`.padStart(26)} ` +
      `${`${median(onStepped)} (worst ${Math.max(...onStepped, 0)})`.padStart(28)}${sigmas === PENALTY_SIGMAS ? "   <- shipped" : ""}`);
  }
  console.log("\nThe left column is the control: these pairs need one segment, so any number");
  console.log("above one there is the segmenter reading noise. The right column is the known");
  console.log("staircases, which need about six. The shipped value is where the left column");
  console.log("has settled at one and the right has not yet collapsed.\n");
}

const census = new Map();
for (const f of found) {
  const key = `${f.shape.kind}${sameLanguage(f) ? "" : " (cross-language)"}`;
  census.set(key, (census.get(key) || 0) + 1);
}
console.log("SHAPE OF THE TRUTH - the simplest model that fits about as well as the best one\n");
for (const [kind, n] of [...census].sort((a, b) => b[1] - a[1])) {
  console.log(`  ${kind.padEnd(28)} ${String(n).padStart(4)}  ${(100 * n / found.length).toFixed(1)}%`);
}

console.log("\nWHAT A SINGLE SHIFT COSTS ON EACH KIND");
console.log("(the error a shift-only aligner is left with, even when it finds the best shift there is,");
console.log(" against the floor - how far apart the two subtitlers put the same line to begin with)\n");
console.log(`${"kind".padEnd(10)} ${"pairs".padStart(6)} ${"median p50 err".padStart(15)} ${"median p95 err".padStart(15)} ${"worst p95".padStart(11)} ${"median floor".padStart(13)}`);
for (const kind of ["flat", "linear", "stepped", "messy"]) {
  const group = found.filter((f) => f.shape.kind === kind);
  if (!group.length) continue;
  const mid = (v) => { const s = [...v].sort((a, b) => a - b); return s[s.length >> 1]; };
  console.log(`${kind.padEnd(10)} ${String(group.length).padStart(6)} ` +
    `${`${mid(group.map((g) => g.shape.shift.p50))}ms`.padStart(15)} ` +
    `${`${mid(group.map((g) => g.shape.shift.p95))}ms`.padStart(15)} ` +
    `${`${Math.max(...group.map((g) => g.shape.shift.p95))}ms`.padStart(11)} ` +
    `${`${mid(group.map((g) => g.shape.jitterMs))}ms`.padStart(13)}`);
}

console.log("\nTHE PAIRS THAT NEED MORE THAN A SHIFT, in full:\n");
for (const f of found.filter((x) => x.shape.kind !== "flat").sort((a, b) => b.shape.shift.p95 - a.shape.shift.p95)) {
  const s = f.shape;
  console.log(`  ${f.key.padEnd(24)} ${f.a.film} [${languagesOf(f).join("/")}]  ${s.anchors} anchors`);
  console.log(`      truth is ${s.kind}: rate ${s.line.rate.toFixed(5)}, ` +
    `${s.steps.count} segment${s.steps.count === 1 ? "" : "s"} at [${s.steps.levels.join(", ")}]ms` +
    `${s.steps.breaks.length ? `, breaking at ${s.steps.breaks.map((b) => clock(b)).join(" ")}` : ""}`);
  console.log(`      best single shift ${s.shift.offsetMs}ms leaves p50 ${s.shift.p50}ms, p95 ${s.shift.p95}ms; ` +
    `best line leaves p95 ${s.line.p95}ms; segmented leaves p95 ${s.steps.p95}ms`);
}

function clock(ms) {
  const total = Math.round(ms / 1000);
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, "0")}`;
}
