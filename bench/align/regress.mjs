#!/usr/bin/env node
/* Does the candidate make anything WORSE than what ships?
 *
 *   node bench/align/regress.mjs [--against starts] [--candidate split]
 *   node bench/align/regress.mjs --before HEAD   # split now, against split at HEAD
 *
 * --before is the one to run on any change to align.js itself: it loads the
 * file as it was at that revision beside the one in the working tree, so the
 * question is "does my edit lose ground anywhere", not "does split beat starts".
 *
 * A better average is not an improvement if it is bought by breaking pairs
 * that already worked. The reader who was happy is the one who notices, and a
 * method that wins the accuracy table while losing four pairs outright is a
 * different distribution of the same complaint rather than a fix.
 *
 * So this asks one question per pair and reports the tail rather than the
 * mean: for every pair the oracle can settle, how much of the film does each
 * method put inside 250ms, and where does the candidate lose ground?
 *
 * It found four when it was first run - three Amelie releases and one Lost,
 * all at 100 percent under the shipped aligner and 59 to 65 percent under the
 * candidate. Two of those turned out to be the ORACLE being wrong rather than
 * the candidate: a pair that agrees for 57 minutes and then jumps 770ms has a
 * small median residual, and the truth's model chooser was comparing medians.
 * That is the useful thing about a regression list. It does not know which
 * side is at fault, so it makes you go and look.
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { load, pairs, check, REPO } from "./corpus.mjs";
import { METHODS, prepare, loadShipped, splitOf } from "./methods.mjs";
import { anchorsFor, shapeOf } from "./truth.mjs";

const TIGHT_MS = 250;
const argOf = (name, fallback) => {
  const at = process.argv.indexOf(name);
  return at === -1 ? fallback : process.argv[at + 1];
};
const BASE = argOf("--against", "starts");
const CANDIDATE = argOf("--candidate", "split");
const byName = (name) => {
  const found = METHODS.find((m) => m.name === name);
  if (!found) throw new Error(`no method called ${name}; have ${METHODS.map((m) => m.name).join(", ")}`);
  return found;
};

const BEFORE = argOf("--before", null);

/* align.js at a revision, loaded beside the working tree's copy. The file sets
 * globalThis.__ssoAlign and nothing else, so the earlier copy is captured and
 * the global handed back before anything reads it. */
async function alignAt(rev) {
  const source = execFileSync("git", ["show", `${rev}:browser-extension/src/align.js`], { cwd: REPO });
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "align-")), "align.js");
  fs.writeFileSync(file, source);
  const now = globalThis.__ssoAlign;
  await import(file);
  const then = globalThis.__ssoAlign;
  globalThis.__ssoAlign = now;
  fs.rmSync(path.dirname(file), { recursive: true });
  return then;
}

const files = load();
check(files);
await loadShipped(REPO);
prepare(files);

const base = BEFORE ? splitOf(await alignAt(BEFORE), `split@${BEFORE}`.slice(0, 12)) : byName(BASE);
const candidate = BEFORE ? byName("split") : byName(CANDIDATE);
const BASE_NAME = base.name, CANDIDATE_NAME = candidate.name;
const rows = [];
for (const p of pairs(files)) {
  if (p.label === "different") continue;
  const points = anchorsFor(p.a, p.b);
  const shape = points && shapeOf(points);
  if (!shape) continue;
  const xs = p.a.spans.map((s) => s[0]).filter((x) => x >= points[0].x && x <= points[points.length - 1].x);
  if (xs.length < 20) continue;
  const scoreOf = (answer) => {
    if (!answer?.at) return null;
    let hit = 0;
    for (const x of xs) if (Math.abs(answer.at(x) - shape.at(x)) <= TIGHT_MS) hit++;
    return hit / xs.length;
  };
  rows.push({
    key: p.key, film: p.a.film, kind: shape.kind,
    languages: `${p.a.language ?? "?"}/${p.b.language ?? "?"}`,
    base: scoreOf(base.run(p.a, p.b)),
    candidate: scoreOf(candidate.run(p.a, p.b)),
  });
}

const both = rows.filter((r) => r.base !== null && r.candidate !== null);
const onlyBase = rows.filter((r) => r.base !== null && r.candidate === null);
const onlyCandidate = rows.filter((r) => r.base === null && r.candidate !== null);

console.log(`${CANDIDATE_NAME} against ${BASE_NAME}, over ${rows.length} pairs with a text-derived truth\n`);
console.log(`  both answered:        ${both.length}`);
console.log(`  only ${BASE_NAME.padEnd(8)} answered: ${onlyBase.length}`);
console.log(`  only ${CANDIDATE_NAME.padEnd(8)} answered: ${onlyCandidate.length}\n`);

/* A pair moving by less than this is noise: one cue in a hundred lands the
 * other side of the tolerance because the two subtitlers typed a line at
 * slightly different moments. */
const NOISE = 0.01;
const worse = both.filter((r) => r.candidate < r.base - NOISE).sort((a, b) => (a.candidate - a.base) - (b.candidate - b.base));
const better = both.filter((r) => r.candidate > r.base + NOISE);
const same = both.length - worse.length - better.length;

console.log(`  BETTER: ${better.length}   unchanged: ${same}   WORSE: ${worse.length}\n`);

const show = (list, title) => {
  if (!list.length) return;
  console.log(`${title}\n`);
  console.log(`  ${"pair".padEnd(20)} ${"film".padEnd(30)} ${"langs".padEnd(6)} ${"truth".padEnd(8)} ` +
    `${BASE_NAME.padStart(8)} ${CANDIDATE_NAME.padStart(8)} ${"move".padStart(8)}`);
  for (const r of list) {
    console.log(`  ${r.key.padEnd(20)} ${String(r.film).slice(0, 29).padEnd(30)} ${r.languages.padEnd(6)} ${r.kind.padEnd(8)} ` +
      `${`${(r.base * 100).toFixed(0)}%`.padStart(8)} ${`${(r.candidate * 100).toFixed(0)}%`.padStart(8)} ` +
      `${`${r.candidate > r.base ? "+" : ""}${((r.candidate - r.base) * 100).toFixed(0)}`.padStart(8)}`);
  }
  console.log();
};

show(worse, "WORSE - every pair the candidate loses ground on:");
show(better.sort((a, b) => (b.candidate - b.base) - (a.candidate - a.base)).slice(0, 12),
  "BETTER - the twelve largest gains:");

const mid = (v) => { const s = [...v].sort((a, b) => a - b); return s.length ? s[s.length >> 1] : NaN; };
console.log("BY KIND\n");
console.log(`  ${"kind".padEnd(9)} ${"pairs".padStart(6)} ${`median ${BASE_NAME}`.padStart(16)} ${`median ${CANDIDATE_NAME}`.padStart(18)} ${"worse".padStart(7)}`);
for (const kind of ["flat", "linear", "stepped", "messy"]) {
  const group = both.filter((r) => r.kind === kind);
  if (!group.length) continue;
  console.log(`  ${kind.padEnd(9)} ${String(group.length).padStart(6)} ` +
    `${`${(mid(group.map((r) => r.base)) * 100).toFixed(1)}%`.padStart(16)} ` +
    `${`${(mid(group.map((r) => r.candidate)) * 100).toFixed(1)}%`.padStart(18)} ` +
    `${String(group.filter((r) => r.candidate < r.base - NOISE).length).padStart(7)}`);
}

process.exitCode = worse.length ? 1 : 0;
