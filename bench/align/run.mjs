/* Run every method over every pair and print numbers that can be compared.
 *
 *   node bench/align/run.mjs            # the table
 *   node bench/align/run.mjs --json     # results.json for a report to read
 *
 * Three metrics, because they answer different questions and a method can win
 * one while losing another.
 *
 * ROC AUC is the ranking, and it is the number that survives having no
 * threshold chosen yet. Useful precisely because nothing is tuned to produce
 * it.
 *
 * RECALL AT ZERO FALSE ACCEPTS is the operating point this product actually
 * has. A wrong shift applied without asking is the failure the whole aligner
 * exists to prevent, so the honest question is: with the threshold pushed to
 * wherever it must go to admit not one wrong pair, how many right pairs are
 * still recognised? A method with a better AUC and a worse answer here is the
 * wrong trade for us.
 *
 * SHIFT ERROR, because a score that ranks perfectly and times badly is
 * useless. There is no labelled truth for the shifts, so a consensus is built
 * from the methods that agree and every pair where they do not is reported
 * rather than averaged away.
 */
import fs from "node:fs";
import { load, pairs, check, REPO } from "./corpus.mjs";
import { METHODS, prepare, loadShipped } from "./methods.mjs";

const AGREE_MS = 250;

const files = load();
const shape = check(files);
await loadShipped(REPO);
prepare(files);

const all = pairs(files);
const judged = all.filter((p) => p.label !== "cut");

console.log(`corpus: ${shape.files} files, ${shape.films} distinct films, ` +
  `${shape.withCompany} of them with more than one file, ${shape.languages} languages`);
console.log(`pairs: ${all.length} (${judged.filter((p) => p.label === "same").length} same, ` +
  `${judged.filter((p) => p.label === "different").length} different, ` +
  `${all.length - judged.length} different-cut, judged separately)\n`);

// --- run ---------------------------------------------------------------------
const results = new Map();   // method -> pair key -> answer
const timing = new Map();
for (const method of METHODS) {
  const answers = new Map();
  const began = performance.now();
  for (const p of all) answers.set(p.key, method.run(p.a, p.b));
  timing.set(method.name, performance.now() - began);
  results.set(method.name, answers);
}

// --- metrics -----------------------------------------------------------------
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

// --- shift accuracy, against a consensus -------------------------------------
/* No labelled truth exists for the shifts, so one is built from agreement: a
 * same-film pair whose methods land within 250ms of each other is taken as
 * settled at their median. Pairs where they disagree are NOT averaged into a
 * truth - they are counted and listed, because those are exactly the pairs
 * where a single global shift may not be the right answer at all. */
const truth = new Map();
const disputed = [];
for (const p of judged.filter((x) => x.label === "same")) {
  const said = METHODS.map((m) => results.get(m.name).get(p.key).shiftMs).filter((v) => v !== null);
  if (said.length < 2) continue;
  const sorted = [...said].sort((a, b) => a - b);
  const mid = sorted[sorted.length >> 1];
  if (said.every((v) => Math.abs(v - mid) <= AGREE_MS)) truth.set(p.key, mid);
  else disputed.push({ key: p.key, said });
}

console.log(`\nTIMING - how far off is the shift, where the methods agree on one?`);
console.log(`(${truth.size} of ${judged.filter((x) => x.label === "same").length} same-film pairs settled; ` +
  `${disputed.length} disputed and excluded rather than averaged)\n`);
console.log(`${"method".padEnd(9)} ${"within 250ms".padStart(13)} ${"median error".padStart(13)} ${"worst".padStart(10)}`);
for (const method of METHODS) {
  const answers = results.get(method.name);
  const errs = [];
  for (const [key, want] of truth) {
    const got = answers.get(key).shiftMs;
    if (got !== null) errs.push(Math.abs(got - want));
  }
  errs.sort((a, b) => a - b);
  const close = errs.filter((e) => e <= AGREE_MS).length;
  console.log(`${method.name.padEnd(9)} ${`${close}/${errs.length}`.padStart(13)} ` +
    `${`${errs.length ? errs[errs.length >> 1] : "-"}ms`.padStart(13)} ${`${errs.length ? errs[errs.length - 1] : "-"}ms`.padStart(10)}`);
}

/* Who is right when they disagree.
 *
 * "Disputed" is not an answer, and neither method's own score can settle it -
 * each one prefers the shift its own objective was built to maximise. So the
 * candidates are judged by two referees that belong to neither: how many cue
 * STARTS line up after the shift, and how much of the two files' speech
 * OVERLAPS after it. One referee favours the point methods by construction and
 * the other favours the interval methods, so a shift that wins both is winning
 * on the other side's terms as well.
 */
function refereePoints(a, b, shift) {
  const A = a.spans.map((s) => s[0]);
  const B = b.spans.map((s) => s[0]);
  const taken = new Uint8Array(B.length);
  let hit = 0, j = 0;
  for (const x of A) {
    const want = x + shift;
    while (j < B.length && B[j] < want - 250) j++;
    for (let k = j; k < B.length && B[k] <= want + 250; k++) {
      if (taken[k]) continue;
      taken[k] = 1; hit++; break;
    }
  }
  return hit / Math.min(A.length, B.length);
}

function refereeOverlap(a, b, shift) {
  let i = 0, j = 0, both = 0;
  const A = a.spans;
  const B = b.spans.map(([s, e]) => [s - shift, e - shift]);
  while (i < A.length && j < B.length) {
    both += Math.max(0, Math.min(A[i][1], B[j][1]) - Math.max(A[i][0], B[j][0]));
    if (A[i][1] < B[j][1]) i++; else j++;
  }
  const span = (list) => list.reduce((t, [s, e]) => t + (e - s), 0);
  return both / Math.min(span(A), span(B));
}

if (disputed.length) {
  console.log("\nDISPUTED - the methods do not agree on one shift, so two referees judge the candidates.");
  console.log("(points = matched cue starts; overlap = shared speech. Neither belongs to any method.)\n");
  const wins = new Map(METHODS.map((m) => [m.name, { points: 0, overlap: 0 }]));
  for (const d of disputed) {
    const pair = judged.find((p) => p.key === d.key);
    const scored = METHODS.map((m) => {
      const shift = results.get(m.name).get(d.key).shiftMs;
      return shift === null ? null : {
        name: m.name, shift,
        points: refereePoints(pair.a, pair.b, shift),
        overlap: refereeOverlap(pair.a, pair.b, shift),
      };
    }).filter(Boolean);
    for (const referee of ["points", "overlap"]) {
      const best = scored.reduce((x, y) => (y[referee] > x[referee] ? y : x));
      // A tie is nobody's win.
      if (scored.filter((s) => Math.abs(s[referee] - best[referee]) < 1e-9).length === 1) {
        wins.get(best.name)[referee]++;
      }
    }
    d.scored = scored;
  }
  console.log(`${"method".padEnd(9)} ${"wins on points".padStart(15)} ${"wins on overlap".padStart(16)}   of ${disputed.length} disputed`);
  for (const [name, w] of wins) {
    console.log(`${name.padEnd(9)} ${String(w.points).padStart(15)} ${String(w.overlap).padStart(16)}`);
  }
  console.log("\n  the six widest disagreements:");
  for (const d of disputed.sort((x, y) =>
    (Math.max(...y.said) - Math.min(...y.said)) - (Math.max(...x.said) - Math.min(...x.said))).slice(0, 6)) {
    console.log(`  ${d.key}`);
    for (const s of d.scored) {
      console.log(`      ${s.name.padEnd(9)} ${String(s.shift).padStart(8)}ms   ` +
        `points ${(s.points * 100).toFixed(1).padStart(5)}%   overlap ${(s.overlap * 100).toFixed(1).padStart(5)}%`);
    }
  }
}

// --- the pairs that are supposed to be hard ----------------------------------
console.log("\nDIFFERENT CUT - same episode, and no single shift can fix it:");
for (const p of all.filter((x) => x.label === "cut")) {
  const said = METHODS.map((m) => {
    const r = results.get(m.name).get(p.key);
    const first = Object.entries(r.scores || {})[0];
    return `${m.name} ${first ? `${first[0]}=${(+first[1]).toFixed(2)}` : "-"} shift=${r.shiftMs}`;
  });
  console.log(`  ${p.key}\n    ${said.join("\n    ")}`);
}

console.log("\nCOST - whole corpus, one process:");
for (const method of METHODS) {
  const ms = timing.get(method.name);
  console.log(`  ${method.name.padEnd(9)} ${ms.toFixed(0).padStart(7)}ms total   ${(ms / all.length).toFixed(2)}ms per pair`);
}

if (process.argv.includes("--json")) {
  const out = { shape, rows, generatedFrom: "bench/align/run.mjs", pairs: [] };
  for (const p of all) {
    const row = { key: p.key, label: p.label, a: p.a.id, b: p.b.id,
      languages: [p.a.language, p.b.language], methods: {} };
    for (const m of METHODS) row.methods[m.name] = results.get(m.name).get(p.key);
    out.pairs.push(row);
  }
  fs.writeFileSync(`${REPO}/bench/align/results.json`, JSON.stringify(out));
  console.log(`\nwrote bench/align/results.json (${out.pairs.length} pairs)`);
}

/* --- is one shift even the right model? ------------------------------------
 *
 * The disputed pairs above share a shape: about a fifth of cue starts line up
 * while nearly all of the speech overlaps. That is what a re-cut release looks
 * like - the two files agree everywhere locally and nowhere globally, so each
 * method locks onto a different locally-good alignment and the referees split.
 *
 * The direct test is to stop insisting on one shift. Cut the timeline into
 * segments, let each pick its own offset, and see how much that buys. If it
 * buys little, a global shift is the right model and alass's split penalty is
 * a solution to somebody else's problem. If it buys a lot, it is ours too.
 */
{
  const SEGMENTS = 6;
  const STEP = 100;
  const REACH = 30_000;   // how far a segment may wander from the global answer

  const bestShiftFor = (aSpans, bSpans, around) => {
    let best = { shift: around, score: -1 };
    for (let s = around - REACH; s <= around + REACH; s += STEP) {
      let i = 0, j = 0, both = 0;
      while (i < aSpans.length && j < bSpans.length) {
        const bs = bSpans[j][0] - s, be = bSpans[j][1] - s;
        both += Math.max(0, Math.min(aSpans[i][1], be) - Math.max(aSpans[i][0], bs));
        if (aSpans[i][1] < be) i++; else j++;
      }
      if (both > best.score) best = { shift: s, score: both };
    }
    return best;
  };

  const gains = [];
  for (const p of judged.filter((x) => x.label === "same")) {
    const global = results.get("overlap").get(p.key).shiftMs;
    if (global === null) continue;
    const span = (l) => l.reduce((t, [s, e]) => t + (e - s), 0);
    const floor = Math.min(span(p.a.spans), span(p.b.spans));
    const whole = bestShiftFor(p.a.spans, p.b.spans, global).score / floor;

    const from = p.a.spans[0][0];
    const to = p.a.spans[p.a.spans.length - 1][1];
    const width = (to - from) / SEGMENTS;
    let piecewise = 0;
    const shifts = [];
    for (let k = 0; k < SEGMENTS; k++) {
      const lo = from + k * width, hi = lo + width;
      const aPart = p.a.spans.filter(([s]) => s >= lo && s < hi);
      if (aPart.length < 8) continue;
      const found = bestShiftFor(aPart, p.b.spans, global);
      piecewise += found.score;
      shifts.push(Math.round(found.shift));
    }
    if (shifts.length < SEGMENTS - 1) continue;
    gains.push({ key: p.key, whole, piecewise: piecewise / floor,
      gain: piecewise / floor - whole, spread: Math.max(...shifts) - Math.min(...shifts), shifts });
  }

  gains.sort((a, b) => b.spread - a.spread);
  const median = (v) => { const s = [...v].sort((x, y) => x - y); return s[s.length >> 1]; };
  console.log(`\nONE SHIFT OR MANY - ${SEGMENTS} segments, each free to pick its own offset (${gains.length} same-film pairs)\n`);
  console.log(`  median spread between segment offsets: ${median(gains.map((g) => g.spread))}ms`);
  console.log(`  pairs whose segments want offsets more than 1s apart:  ${gains.filter((g) => g.spread > 1000).length}/${gains.length}`);
  console.log(`  pairs whose segments want offsets more than 5s apart:  ${gains.filter((g) => g.spread > 5000).length}/${gains.length}`);
  console.log(`  median overlap gained by splitting: ${(median(gains.map((g) => g.gain)) * 100).toFixed(1)} points\n`);
  /* The control this needs, and the reason it is trustworthy.
   *
   * Six free segments with 30 seconds of reach each can always find SOMETHING
   * better than one shift, so a gain on its own proves nothing - it could be
   * the method fitting noise. The calibration is the pairs that should gain
   * nothing: two files already sharing a timeline have no drift to recover, so
   * if splitting helps them too, the number is measuring the freedom rather
   * than the drift. Splitting them and finding nothing is what makes the large
   * gains elsewhere real. */
  const settled = gains.filter((g) => g.spread <= 1000);
  const drifting = gains.filter((g) => g.spread > 5000);
  console.log(`  CONTROL - pairs whose segments agree within 1s (${settled.length}): ` +
    `median gain ${(median(settled.map((g) => g.gain)) * 100).toFixed(1)} points`);
  console.log(`  pairs whose segments want more than 5s apart (${drifting.length}): ` +
    `median gain ${(median(drifting.map((g) => g.gain)) * 100).toFixed(1)} points\n`);

  console.log("  widest, with each segment's own offset:");
  for (const g of gains.slice(0, 6)) {
    console.log(`    ${g.key.padEnd(22)} spread ${String(g.spread).padStart(7)}ms  ` +
      `overlap ${(g.whole * 100).toFixed(1)}% -> ${(g.piecewise * 100).toFixed(1)}%   [${g.shifts.join(", ")}]`);
  }
}
