/* Where the thresholds in align.js sit against the corpus as it is now.
 *
 * The constants in align.js - ACCEPT, AUTO, AUTO_MIN_COVERAGE - were set on the
 * seventeen subtitle files this repository held when they were written, and the
 * comments there quoted the confidences of every pair of those seventeen. The
 * cache is 277 files now. This is what re-checks those numbers rather than
 * trusting them: it runs the SHIPPED aligner over every same-film pair, every
 * cut pair, and a deterministic sample of the different-film ones, and prints
 * what separates the groups and what does not.
 *
 *   node bench/align/separation.mjs
 *
 * Read-only, and slow enough to be worth the progress counter: a few minutes
 * for six and a half thousand pairs. The sample is fixed by a seeded generator
 * so two runs on the same cache compare.
 *
 * It also prints three things that are not about thresholds and are here
 * because they are nearly free once every pair has been aligned: which wide
 * passes were taken where the narrow pass had already answered, whether
 * align(a, b) and align(b, a) agree, and whether any confidence came back
 * non-finite or any coverage above 1.
 */
import { load, pairs, REPO } from "./corpus.mjs";
import { loadShipped } from "./methods.mjs";

const A = await loadShipped(REPO);
const files = load();
const starts = new Map();
for (const [id, f] of files) starts.set(id, f.spans.map((s) => s[0]));

const all = pairs(files);
const same = all.filter((p) => p.label === "same");
const cut = all.filter((p) => p.label === "cut");
const diffAll = all.filter((p) => p.label === "different");
// deterministic sample
let s = 12345;
const rnd = () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296);
const diff = diffAll.filter(() => rnd() < 6000 / diffAll.length);
console.log(`same=${same.length} cut=${cut.length} different sampled=${diff.length} of ${diffAll.length}`);

const fmt = (x) => (Number.isFinite(x) ? x.toFixed(2) : String(x));
const rows = [];
let n = 0;
for (const p of [...same, ...cut, ...diff]) {
  const a = starts.get(p.a.id), b = starts.get(p.b.id);
  const full = A.align(a, b);
  const row = { key: p.key, ida: p.a.id, idb: p.b.id, label: p.label, full };
  if (p.label !== "different") {
    row.narrow = A.align(a, b, { wide: false });
    row.wide = (!row.narrow.ok || row.narrow.verdict === "offer")
      ? A.align(a, b, { maxOffsetMs: 1500000, wide: false }) : null;
  }
  rows.push(row);
  if (++n % 200 === 0) process.stderr.write(`${n}/${same.length + cut.length + diff.length}\r`);
}
console.error("");

for (const l of ["same", "cut", "different"]) {
  const g = rows.filter((r) => r.label === l);
  const conf = g.map((r) => r.full.confidence).filter(Number.isFinite).sort((x, y) => x - y);
  console.log(`\n[${l}] ${g.length} pairs  ok=${g.filter((r) => r.full.ok).length}`,
    `apply=${g.filter((r) => r.full.verdict === "apply").length}`,
    `offer=${g.filter((r) => r.full.verdict === "offer").length}`,
    conf.length ? ` conf min=${fmt(conf[0])} p50=${fmt(conf[conf.length >> 1])} max=${fmt(conf[conf.length - 1])}` : "");
  console.log("  any non-finite confidence:", g.filter((r) => !Number.isFinite(r.full.confidence) && r.full.ok).length,
    "| any coverage > 1:", g.filter((r) => r.full.coverage > 1).length);
}

console.log("\nDIFFERENT-FILM pairs that were ACCEPTED, top 25 by confidence:");
const fa = rows.filter((r) => r.label === "different" && r.full.ok).sort((x, y) => y.full.confidence - x.full.confidence);
console.log(`  ${fa.length} of ${rows.filter((r) => r.label === "different").length} sampled different pairs accepted`);
for (const r of fa.slice(0, 25)) {
  console.log(`  ${r.key} conf=${fmt(r.full.confidence)} ${r.full.verdict} cov=${fmt(r.full.coverage)} shift=${r.full.shiftMs} rate=${r.full.rate.toFixed(6)} searched=${r.full.searchedMs} matched=${r.full.matched} mad=${r.full.madMs}`);
}
console.log("\nSAME-FILM pairs, 15 lowest confidences (accepted or not):");
for (const r of rows.filter((r) => r.label === "same").sort((x, y) => x.full.confidence - y.full.confidence).slice(0, 15)) {
  console.log(`  ${r.key} conf=${fmt(r.full.confidence)} ok=${r.full.ok} ${r.full.verdict ?? "-"} cov=${fmt(r.full.coverage)}`);
}
const refused = rows.filter((r) => r.label === "same" && !r.full.ok);
console.log(`\nSAME-FILM pairs REFUSED: ${refused.length} of ${same.length}; highest-confidence 10:`);
for (const r of refused.sort((x, y) => y.full.confidence - x.full.confidence).slice(0, 10)) {
  console.log(`  ${r.key} conf=${fmt(r.full.confidence)} reason=${r.full.reason}`);
}

console.log("\nAUTO_MIN_COVERAGE claim -- coverage of every 'apply':");
const appliesSame = rows.filter((r) => r.label === "same" && r.full.verdict === "apply").map((r) => r.full.coverage).sort((x, y) => x - y);
const appliesDiff = rows.filter((r) => r.label === "different" && r.full.verdict === "apply").map((r) => r.full.coverage).sort((x, y) => x - y);
console.log(`  same-film applies (${appliesSame.length}), 12 lowest:`, appliesSame.slice(0, 12).map(fmt).join(" "));
console.log(`  different-film applies (${appliesDiff.length}):`, appliesDiff.map(fmt).join(" ") || "(none)");

console.log("\nWIDE PASS taken where the NARROW pass had already answered ok:");
let hijack = 0, lower = 0, moved = 0;
const notes = [];
for (const r of rows) {
  if (!r.wide || !r.narrow?.ok) continue;
  if (!(r.wide.ok || r.wide.confidence > r.narrow.confidence)) continue;
  hijack++;
  const isLower = r.wide.confidence < r.narrow.confidence;
  const isMoved = r.narrow.shiftMs !== r.wide.shiftMs || r.narrow.rate !== r.wide.rate;
  if (isLower) lower++;
  if (isMoved) moved++;
  if (isLower || isMoved) {
    notes.push(`  ${r.key} [${r.label}] narrow ${fmt(r.narrow.confidence)}@${r.narrow.shiftMs} -> wide ${fmt(r.wide.confidence)}@${r.wide.shiftMs}`
      + (isLower ? " [LOWER CONFIDENCE REPORTED]" : "") + (isMoved ? ` [SHIFT MOVED ${r.wide.shiftMs - r.narrow.shiftMs}ms]` : ""));
  }
}
console.log(`  total ${hijack}; reported a lower confidence than the narrow pass had: ${lower}; changed the answer: ${moved}`);
for (const s2 of notes.slice(0, 20)) console.log(s2);

console.log("\nSYMMETRY align(a,b) vs align(b,a) on accepted same-film pairs:");
let asym = 0, checked = 0; const out = [];
for (const r of rows.filter((r) => r.label === "same" && r.full.ok)) {
  const back = A.align(starts.get(r.idb), starts.get(r.ida));
  checked++;
  const want = -r.full.shiftMs / r.full.rate;
  const d = back.ok ? Math.abs(back.shiftMs - want) : Infinity;
  if (back.ok !== r.full.ok || d > 300) {
    asym++;
    out.push(`  ${r.key} fwd ${fmt(r.full.confidence)}@${r.full.shiftMs} rate ${r.full.rate.toFixed(6)} | rev ok=${back.ok} ${fmt(back.confidence)}@${back.shiftMs} | expected ${want.toFixed(0)} off by ${Number.isFinite(d) ? d.toFixed(0) : "n/a"}`);
  }
}
console.log(`  checked ${checked}, disagreed ${asym}`);
for (const s3 of out.slice(0, 20)) console.log(s3);
