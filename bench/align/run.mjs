/* Run every method over every pair and print numbers that can be compared.
 *
 *   node bench/align/run.mjs            # the tables
 *   node bench/align/run.mjs --json     # results.json for a report to read
 *   node bench/align/run.mjs --same     # skip the different-film pairs (fast)
 *
 * Three questions, because a method can answer one well and another badly.
 *
 * CAN IT TELL TWO FILMS APART? ROC AUC is the ranking, and it is the number
 * that survives having no threshold chosen yet - nothing is tuned to produce
 * it. Recall at zero false accepts is the operating point this product has: a
 * wrong shift applied without asking is the failure the aligner exists to
 * prevent, so with the threshold pushed to wherever it must go to admit not
 * one wrong pair, how many right pairs are still recognised?
 *
 * HOW RIGHT IS THE ANSWER? Against truth.mjs, which derives the true mapping
 * from cue TEXT and so owes nothing to any method here. Scored at every cue of
 * the film rather than as one number, because a method that is exact for eight
 * minutes and twenty seconds out for the other forty is not 71 percent right.
 * The oracle settles about half the same-film pairs and refuses the rest out
 * loud; the refused half is measured by referees below and labelled as such.
 *
 * WHAT DOES IT COST? Last, and it only matters against the other two.
 */
import fs from "node:fs";
import { load, pairs, check, REPO } from "./corpus.mjs";
import { METHODS, prepare, loadShipped } from "./methods.mjs";
import { anchorsFor, shapeOf } from "./truth.mjs";

const TIGHT_MS = 250;
const SAME_ONLY = process.argv.includes("--same");

const files = load();
const shape = check(files);
await loadShipped(REPO);
prepare(files);

const all = pairs(files).filter((p) => !SAME_ONLY || p.label !== "different");
const judged = all.filter((p) => p.label !== "cut");

console.log(`corpus: ${shape.files} files, ${shape.films} distinct films, ` +
  `${shape.withCompany} of them with more than one file, ${shape.languages} languages`);
console.log(`pairs: ${all.length} (${judged.filter((p) => p.label === "same").length} same, ` +
  `${judged.filter((p) => p.label === "different").length} different, ` +
  `${all.length - judged.length} different-cut, judged separately)`);

// --- the truth, before any method runs ---------------------------------------
const truth = new Map();
for (const p of all) {
  if (p.label === "different") continue;
  const points = anchorsFor(p.a, p.b);
  const found = points && shapeOf(points);
  if (found) truth.set(p.key, { shape: found, from: points[0].x, to: points[points.length - 1].x });
}
console.log(`truth: ${truth.size} pairs settled from cue text, ` +
  `${all.filter((p) => p.label !== "different").length - truth.size} refused (mostly cross-language)\n`);

// --- run ---------------------------------------------------------------------
const results = new Map();
const timing = new Map();
for (const method of METHODS) {
  const answers = new Map();
  const began = performance.now();
  for (const p of all) answers.set(p.key, method.run(p.a, p.b));
  timing.set(method.name, performance.now() - began);
  results.set(method.name, answers);
}

// --- discrimination ----------------------------------------------------------
function auc(values, positive) {
  const order = values.map((v, i) => [v, positive[i]]).sort((a, b) => a[0] - b[0]);
  let sumPos = 0, pos = 0, neg = 0;
  for (let i = 0; i < order.length; ) {
    let j = i;
    while (j < order.length && order[j][0] === order[i][0]) j++;
    const rank = (i + j + 1) / 2;
    for (let k = i; k < j; k++) if (order[k][1]) { sumPos += rank; pos++; } else neg++;
    i = j;
  }
  return pos && neg ? (sumPos - (pos * (pos + 1)) / 2) / (pos * neg) : NaN;
}

/* The threshold has to clear EVERY wrong pair, so it is set by the best one -
 * strictly above it, since a tie is a pair the gate cannot separate. */
function recallAtZeroFalseAccepts(values, positive) {
  let ceiling = -Infinity;
  for (let i = 0; i < values.length; i++) if (!positive[i] && values[i] > ceiling) ceiling = values[i];
  let hit = 0, total = 0;
  for (let i = 0; i < values.length; i++) if (positive[i]) { total++; if (values[i] > ceiling) hit++; }
  return { share: total ? hit / total : NaN, hit, total, ceiling };
}

const rows = [];
if (!SAME_ONLY) {
  for (const method of METHODS) {
    const answers = results.get(method.name);
    const names = new Set();
    for (const p of judged) for (const k of Object.keys(answers.get(p.key).scores || {})) names.add(k);
    for (const score of names) {
      const values = judged.map((p) => answers.get(p.key).scores[score] ?? 0);
      const positive = judged.map((p) => p.label === "same");
      const zero = recallAtZeroFalseAccepts(values, positive);
      rows.push({ method: method.name, score, auc: auc(values, positive), ...zero });
    }
  }
  console.log("DISCRIMINATION - can it tell the same film from a different one?\n");
  console.log(`${"method".padEnd(9)} ${"score".padEnd(12)} ${"AUC".padStart(8)}   ` +
    `${"recall at zero false accepts".padStart(28)}`);
  for (const r of rows.sort((a, b) => b.auc - a.auc)) {
    console.log(`${r.method.padEnd(9)} ${r.score.padEnd(12)} ${r.auc.toFixed(5).padStart(8)}   ` +
      `${`${(r.share * 100).toFixed(1)}%`.padStart(7)}  (${r.hit}/${r.total}, threshold must clear ${r.ceiling.toFixed(3)})`);
  }
}

// --- accuracy, against the oracle -------------------------------------------
/* Scored at every cue START in file A that falls inside the anchored range,
 * which is the closest thing to "what the reader sees" the bench can compute:
 * each of those is a line that appears on screen, and the error is how far off
 * it appears. Sampling at fixed intervals instead would weight the silences
 * equally with the dialogue. */
function errorsFor(answer, key) {
  const known = truth.get(key);
  if (!known || !answer?.at) return null;
  const p = all.find((x) => x.key === key);
  const errs = [];
  for (const [x] of p.a.spans) {
    if (x < known.from || x > known.to) continue;
    errs.push(Math.abs(answer.at(x) - known.shape.at(x)));
  }
  if (errs.length < 20) return null;
  errs.sort((u, v) => u - v);
  return errs;
}

const share = (errs, bar) => errs.filter((e) => e <= bar).length / errs.length;
const mid = (v) => { const s = [...v].sort((a, b) => a - b); return s.length ? s[s.length >> 1] : NaN; };
const at = (errs, f) => errs[Math.min(errs.length - 1, Math.floor(f * errs.length))];

const KINDS = ["flat", "linear", "stepped", "messy"];
const perMethod = new Map();
for (const method of METHODS) {
  const answers = results.get(method.name);
  const rowsFor = [];
  for (const [key] of truth) {
    const errs = errorsFor(answers.get(key), key);
    rowsFor.push({ key, kind: truth.get(key).shape.kind, errs });
  }
  perMethod.set(method.name, rowsFor);
}

console.log("\nACCURACY - how much of the film does the answer put in the right place?");
console.log(`(${truth.size} pairs with a text-derived truth; "within 250ms" is pooled over every cue of every pair)\n`);
console.log(`${"method".padEnd(9)} ${"pairs".padStart(6)} ${"within 250ms".padStart(13)} ${"within 1s".padStart(10)} ` +
  `${"median err".padStart(11)} ${"p95 err".padStart(10)} ${"refused".padStart(8)}`);
for (const method of METHODS) {
  const got = perMethod.get(method.name);
  const answered = got.filter((r) => r.errs);
  const pooled = answered.flatMap((r) => r.errs);
  if (!pooled.length) { console.log(`${method.name.padEnd(9)} ${"-".padStart(6)}`); continue; }
  pooled.sort((a, b) => a - b);
  console.log(`${method.name.padEnd(9)} ${String(answered.length).padStart(6)} ` +
    `${`${(share(pooled, TIGHT_MS) * 100).toFixed(1)}%`.padStart(13)} ` +
    `${`${(share(pooled, 1000) * 100).toFixed(1)}%`.padStart(10)} ` +
    `${`${Math.round(at(pooled, 0.5))}ms`.padStart(11)} ` +
    `${`${Math.round(at(pooled, 0.95))}ms`.padStart(10)} ` +
    `${String(got.length - answered.length).padStart(8)}`);
}

console.log("\n  by what the truth turned out to be:\n");
console.log(`  ${"kind".padEnd(9)} ${"pairs".padStart(6)}  ` +
  METHODS.map((m) => `${m.name} within 250ms`.padStart(22)).join(" "));
for (const kind of KINDS) {
  const keys = [...truth].filter(([, v]) => v.shape.kind === kind).map(([k]) => k);
  if (!keys.length) continue;
  const cells = METHODS.map((m) => {
    const got = perMethod.get(m.name).filter((r) => keys.includes(r.key) && r.errs);
    const pooled = got.flatMap((r) => r.errs);
    return pooled.length ? `${(share(pooled, TIGHT_MS) * 100).toFixed(1)}%`.padStart(22) : "-".padStart(22);
  });
  console.log(`  ${kind.padEnd(9)} ${String(keys.length).padStart(6)}  ${cells.join(" ")}`);
}

// --- the pairs with no oracle ------------------------------------------------
/* Cross-language pairs share no text, so there is nothing to derive a truth
 * from and the referees are all there is. Neither belongs to any method: one
 * counts matched cue STARTS after the mapping and the other measures shared
 * SPEECH, so a method winning both is winning on the other side's terms too.
 * They are objectives, not truth, and this table is read accordingly. */
function refereePoints(a, b, map) {
  const B = b.spans.map((s) => s[0]);
  const taken = new Uint8Array(B.length);
  let hit = 0;
  for (const [x] of a.spans) {
    const want = map(x);
    let lo = 0, hi = B.length;
    while (lo < hi) { const m = (lo + hi) >> 1; if (B[m] < want - TIGHT_MS) lo = m + 1; else hi = m; }
    for (let k = lo; k < B.length && B[k] <= want + TIGHT_MS; k++) {
      if (taken[k]) continue;
      taken[k] = 1; hit++; break;
    }
  }
  return hit / Math.min(a.spans.length, B.length);
}

function refereeOverlap(a, b, map) {
  /* The mapping is monotone, so applying it to A's spans and sweeping against
   * B's is the same linear merge a constant shift allowed. */
  const A = a.spans.map(([s, e]) => [map(s), map(e)]);
  let i = 0, j = 0, both = 0;
  while (i < A.length && j < b.spans.length) {
    both += Math.max(0, Math.min(A[i][1], b.spans[j][1]) - Math.max(A[i][0], b.spans[j][0]));
    if (A[i][1] < b.spans[j][1]) i++; else j++;
  }
  const span = (list) => list.reduce((t, [s, e]) => t + (e - s), 0);
  return both / Math.min(span(A), span(b.spans));
}

const noOracle = all.filter((p) => p.label !== "different" && !truth.has(p.key));
if (noOracle.length) {
  console.log(`\nNO ORACLE - ${noOracle.length} same-film pairs whose text cannot settle them, judged by two referees`);
  console.log("(these are objectives, not truth. Every method is scored on the same two.)\n");
  console.log(`${"method".padEnd(9)} ${"answered".padStart(9)} ${"median matched starts".padStart(22)} ${"median shared speech".padStart(21)}`);
  for (const method of METHODS) {
    const answers = results.get(method.name);
    const points = [], overlaps = [];
    for (const p of noOracle) {
      const answer = answers.get(p.key);
      if (!answer?.at) continue;
      points.push(refereePoints(p.a, p.b, answer.at));
      overlaps.push(refereeOverlap(p.a, p.b, answer.at));
    }
    console.log(`${method.name.padEnd(9)} ${String(points.length).padStart(9)} ` +
      `${`${(mid(points) * 100).toFixed(1)}%`.padStart(22)} ${`${(mid(overlaps) * 100).toFixed(1)}%`.padStart(21)}`);
  }
}

console.log("\nCOST - whole corpus, one process:");
for (const method of METHODS) {
  const ms = timing.get(method.name);
  console.log(`  ${method.name.padEnd(9)} ${ms.toFixed(0).padStart(7)}ms total   ${(ms / all.length).toFixed(2)}ms per pair`);
}

console.log("\nWhat SHAPE the truth is, and how often, is a separate question with its own");
console.log("script: node bench/align/shapes.mjs\n");

if (process.argv.includes("--json")) {
  const out = { shape, rows, generatedFrom: "bench/align/run.mjs", pairs: [] };
  for (const p of all) {
    const known = truth.get(p.key);
    const row = {
      key: p.key, label: p.label, a: p.a.id, b: p.b.id,
      languages: [p.a.language, p.b.language],
      truth: known ? { kind: known.shape.kind, rate: known.shape.line.rate, segments: known.shape.steps.count } : null,
      methods: {},
    };
    for (const m of METHODS) {
      const answer = results.get(m.name).get(p.key);
      const errs = errorsFor(answer, p.key);
      row.methods[m.name] = {
        rate: answer?.at?.rate ?? null,
        shiftMs: answer?.at?.shiftMs ?? null,
        segments: answer?.at?.pieces ?? (answer?.at ? 1 : 0),
        scores: answer?.scores ?? {},
        within250: errs ? share(errs, TIGHT_MS) : null,
        p50: errs ? Math.round(at(errs, 0.5)) : null,
      };
    }
    out.pairs.push(row);
  }
  fs.writeFileSync(`${REPO}/bench/align/results.json`, JSON.stringify(out));
  console.log(`wrote bench/align/results.json (${out.pairs.length} pairs)`);
}
