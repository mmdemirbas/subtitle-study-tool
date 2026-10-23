#!/usr/bin/env node
/* What does each way of inverting an act plan put on screen?
 *
 *   node bench/align/joins.mjs
 *
 * Every act plan the aligner applied in the running log
 * (subtitle-daemon/logs/*.jsonl), replayed against the subtitle it was made
 * for when that file is in the download cache, at 100ms steps of the stream.
 * For each line it counts how long it is on screen and in how many separate
 * stretches, and reports the lines held past their own end, drawn twice,
 * never drawn, and cut short - under two inverses:
 *
 *   hold   the clock held at an insert join (content.js, 2026-09-03 to 10-23)
 *   act    a line belongs to the act it starts in (filmClock, from 2026-10-23)
 *
 * Both are copies, because the shipped one lives inside content.js's closure.
 * Keep `act` in step with filmClock and linesOnScreen there, or this measures
 * something that does not ship.
 *
 * It exists because the hold was checked on one cue at one join and shipped
 * with a defect the check could not see: a line across an insert stayed up
 * for the whole insert. Reported on Zodiac, where the worst was 43 seconds.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseSrt } from "../../browser-extension/src/subtitles/srt.js";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const LOGS = path.join(REPO, "subtitle-daemon/logs");
const CACHE = path.join(REPO, "subtitle-daemon/cache/subtitles");
const TICK_MS = 100;
// How far past or short of its own length a line has to be to count.
const SLACK_MS = 500;

/* The plan as the target track carries it: autoAlign's composition in
 * content.js, with the reference taken as untouched (offset 0, rate 1, no acts
 * of its own), which is what nearly every logged pair is. */
function targetPlan(answer) {
  const rate = 1 / answer.rate;
  const steps = answer.steps.map((step) => ({
    fromMs: Math.round(answer.rate * step.fromMs + answer.shiftMs + step.offsetMs),
    offsetMs: Math.round(-rate * step.offsetMs),
  })).sort((a, b) => a.fromMs - b.fromMs);
  steps[0].fromMs = 0;
  return { rate, offsetMs: -Math.round(answer.shiftMs / answer.rate), steps };
}

function plansInLog() {
  const plans = new Map();
  for (const name of fs.readdirSync(LOGS).filter((f) => f.endsWith(".jsonl")).sort()) {
    for (const line of fs.readFileSync(path.join(LOGS, name), "utf8").split("\n")) {
      if (!line.includes('"align"') || !line.includes('"steps"')) continue;
      let entry;
      try { entry = JSON.parse(line); } catch { continue; }
      const answer = entry.answer;
      if (entry.kind !== "align" || !answer?.ok || answer.verdict !== "apply" || !(answer.steps?.length > 1)) continue;
      const target = (entry.tracks || []).find((t) => t.slot === entry.slot);
      if (!target?.fileId) continue;
      const plan = { fileId: target.fileId, label: target.label, ...targetPlan(answer) };
      plans.set(plan.fileId + JSON.stringify(plan.steps), plan);
    }
  }
  return [...plans.values()];
}

// content.js's findCueIndexes, lookback included.
function covering(cues, timeMs) {
  let low = 0;
  let high = cues.length - 1;
  let latest = -1;
  while (low <= high) {
    const mid = (low + high) >> 1;
    if (cues[mid].start <= timeMs) { latest = mid; low = mid + 1; } else high = mid - 1;
  }
  const found = [];
  for (let i = Math.max(0, latest - 16); i <= latest; i++) if (timeMs <= cues[i].end) found.push(i);
  return found;
}

const INVERSES = {
  hold(plan, cues, plain) {
    let best = plain;
    let previous = 0;
    for (const step of plan.steps) {
      const offset = step.offsetMs / plan.rate;
      const shifted = plain - offset;
      if (shifted >= step.fromMs) best = shifted;
      else if (plain - previous >= step.fromMs) best = step.fromMs;
      previous = offset;
    }
    return covering(cues, best);
  },
  act(plan, cues, plain) {
    const steps = plan.steps;
    const inAct = (k) => plain - steps[k].offsetMs / plan.rate;
    let act = 0;
    for (let k = 1; k < steps.length; k++) if (inAct(k) >= steps[k].fromMs) act = k;
    let fromMs = -Infinity;
    let beforeMs = null;
    const toMs = steps[act + 1]?.fromMs ?? Infinity;
    if (act > 0 && steps[act].offsetMs > steps[act - 1].offsetMs) {
      fromMs = steps[act].fromMs;
      beforeMs = inAct(act - 1);
    }
    const lines = covering(cues, inAct(act)).filter((i) => cues[i].start >= fromMs && cues[i].start < toMs);
    if (beforeMs == null) return lines;
    return [...covering(cues, beforeMs).filter((i) => cues[i].start < fromMs), ...lines];
  },
};

/* Which join a line sits by, for saying where the dropped and shortened lines
 * are: an insert (the later act further on in the stream) or a cut. */
function joinBeside(plan, cue) {
  let best = null;
  for (let k = 1; k < plan.steps.length; k++) {
    const away = Math.min(Math.abs(cue.start - plan.steps[k].fromMs), Math.abs(cue.end - plan.steps[k].fromMs));
    if (!best || away < best.away) best = { away, kind: plan.steps[k].offsetMs > plan.steps[k - 1].offsetMs ? "insert" : "cut" };
  }
  return !best ? "no join" : best.away < 60000 ? `at ${best.kind}` : "a minute or more from any join";
}

const plans = plansInLog();
const tally = Object.fromEntries(Object.keys(INVERSES).map((name) => [name, {
  held: 0, worstMs: 0, heldPlans: 0, twice: 0, never: new Set(), short: new Set(), lines: 0,
}]));
const where = new Map();
let replayed = 0;
for (const plan of plans) {
  const file = path.join(CACHE, `${plan.fileId}.srt`);
  if (!fs.existsSync(file)) continue;
  replayed += 1;
  const cues = parseSrt(fs.readFileSync(file, "utf8")).map((c) => ({ start: c.startMs, end: c.endMs }));
  const lastMs = cues[cues.length - 1].end * plan.rate + plan.offsetMs + Math.max(0, ...plan.steps.map((s) => s.offsetMs)) + 5000;
  for (const [name, inverse] of Object.entries(INVERSES)) {
    const t = tally[name];
    const seen = new Map();
    let before = new Set();
    for (let now = 0; now <= lastMs; now += TICK_MS) {
      const shown = new Set(inverse(plan, cues, (now - plan.offsetMs) / plan.rate));
      for (const i of shown) {
        const s = seen.get(i) ?? { ticks: 0, runs: 0 };
        s.ticks += 1;
        if (!before.has(i)) s.runs += 1;
        seen.set(i, s);
      }
      before = shown;
    }
    let heldHere = 0;
    cues.forEach((cue, i) => {
      const key = `${plan.fileId}:${JSON.stringify(plan.steps)}:${i}`;
      const s = seen.get(i);
      if (!s) { t.never.add(key); where.set(key, joinBeside(plan, cue)); return; }
      const own = (cue.end - cue.start) * plan.rate;
      const up = s.ticks * TICK_MS;
      if (up > own + SLACK_MS) { t.held += 1; heldHere += 1; t.worstMs = Math.max(t.worstMs, up - own); }
      if (up < own - SLACK_MS) { t.short.add(key); where.set(key, joinBeside(plan, cue)); }
      if (s.runs > 1) t.twice += 1;
    });
    if (heldHere) t.heldPlans += 1;
    t.lines += cues.length;
  }
}

console.log(`${plans.length} applied act plans in the running log, ${replayed} with their file in the cache\n`);
for (const [name, t] of Object.entries(tally)) {
  console.log(`${name.padEnd(5)} held past their end: ${String(t.held).padStart(3)} lines in ${t.heldPlans} plans, worst by ${(t.worstMs / 1000).toFixed(1)}s`);
  console.log(`      drawn twice: ${t.twice}   never drawn: ${t.never.size} of ${t.lines}   cut short: ${t.short.size}`);
}
const same = (a, b) => a.size === b.size && [...a].every((key) => b.has(key));
console.log(`\nthe same lines never drawn under both: ${same(tally.hold.never, tally.act.never)}, the same cut short: ${same(tally.hold.short, tally.act.short)}`);
const byPlace = {};
for (const key of [...tally.act.never, ...tally.act.short]) byPlace[where.get(key)] = (byPlace[where.get(key)] ?? 0) + 1;
console.log("where they are under act:", byPlace);
