// The extension's ear, replayed over films whose subtitle is timed to their
// own picture: the shipped src/listen.js hears the feature vectors features.mjs
// took out of the film, the subtitle is displaced by a known amount, and what it
// applies is compared with that amount.
//
//   node bench/listen/replay.mjs [--minutes 20] [--every 5] [--truths ms,ms] [--slow %] [--no-rates]
//     [--block-s 120] [--agree 2] [--recent 4] [--start-only] [--whole] [name...]
//
// Default: every film in bench/listen/films, a listening of --minutes starting
// at every --every minutes, the subtitle displaced by each of TRUTHS. --whole
// listens from the start to the end instead and reports how much of the film
// was on screen within 300ms and within a second - which is the question for a
// film whose truth is not one number.
//
// A film with a <name>.truth.json beside it has a subtitle from ANOTHER release,
// and the file says where that subtitle belongs as a line, {offsetMs,
// msPerMinute}: the shift to add at minute m is offsetMs + msPerMinute * m. Such
// a film is left out of the default table, which measures one shift, and is
// measured when named.
import { loadFilm, filmNames } from "./film.mjs";
import "../../browser-extension/src/align.js";

const { createHearing, retiming } = globalThis.__ssoListen;
const { RATES } = globalThis.__ssoAlign;
let TRUTHS = [-21350, 4000, 37200];
const RIGHT_MS = 300;

const args = process.argv.slice(2);
const option = (name, fallback) => { const i = args.indexOf(`--${name}`); return i >= 0 ? Number(args.splice(i, 2)[1]) : fallback; };
const minutes = option("minutes", 20), every = option("every", 5);
{ const i = args.indexOf("--truths"); if (i >= 0) TRUTHS = args.splice(i, 2)[1].split(",").map(Number); }
// --slow 0.1 makes the subtitle's clock run 0.1% slow as well as displaced:
// a line said at t is written at t * (1 - 0.001) - displacement.
const slow = option("slow", 0) / 100;
// The hearing's own knobs, for sweeping them: --block-s 60 --agree 3 --recent 4.
const hearingOptions = {};
{ const b = option("block-s", 0); if (b) hearingOptions.blockFrames = Math.round(b * 1000 / 50); }
{ const a = option("agree", 0); if (a) hearingOptions.agreeBlocks = a; }
{ const r = option("recent", 0); if (r) hearingOptions.recentBlocks = r; }
// --start-only: one listening per film and displacement, from the first frame,
// which is what a film watched from its beginning gets.
const startOnly = args.includes("--start-only") ? (args.splice(args.indexOf("--start-only"), 1), true) : false;
const rates = !args.includes("--no-rates") || (args.splice(args.indexOf("--no-rates"), 1), false);
const whole = args.includes("--whole") ? (args.splice(args.indexOf("--whole"), 1), true) : false;
const names = filmNames(args);

/* `belongs(ms)` is where the file's own lines belong at that moment of the
 * stream - nothing for a subtitle taken out of this very release. */
function listen(film, truth, fromMs, toMs, belongs = () => 0) {
  const hop = 50, hearing = createHearing(hearingOptions), cues = film.cues;
  // The lead's timing, as the extension holds it: a rate and an offset.
  let timing = { rate: 1, offsetMs: 0 };
  let first = null, applies = 0, rated = 0, rightMs = 0, nearMs = 0;
  const written = (ms) => ms * (1 - slow) - truth;
  const shown = (ms) => written(ms) * timing.rate + timing.offsetMs;
  // The lead's lines on the stream's clock: the file's own times, displaced
  // (and slowed) by the truth, then put through the timing so far.
  const linesFor = (lo, hi) => {
    const out = [];
    for (const c of cues) {
      const a = shown(c.startMs), b = shown(c.endMs);
      if (b > lo && a < hi) out.push([a, b]);
    }
    return out;
  };
  // How far the line said at `ms` is from being shown there.
  const errorAt = (ms) => shown(ms) - ms - belongs(ms);
  for (let i = Math.round(fromMs / hop); i < Math.min(film.frames, Math.round(toMs / hop)); i++) {
    const off = Math.abs(errorAt(i * hop));
    if (off <= RIGHT_MS) rightMs += hop;
    if (off <= 1000) nearMs += hop;
    if (!hearing.hear(i * hop, film.features(i))) continue;
    // The conversions as factors on the lead's present rate, as content.js asks.
    const factors = RATES.filter((rate) => rate !== 1).map((rate) => rate / timing.rate).filter((f) => Math.abs(f - 1) > 0.002);
    const d = hearing.decide(linesFor, { rates, factors, key: `${timing.rate}|${timing.offsetMs}` });
    if (d.drift?.take) {
      timing = retiming(d.drift, timing.rate, RATES).apply(timing);
      rated++;
    } else if (d.apply != null) {
      timing = { ...timing, offsetMs: timing.offsetMs + d.apply };
    } else continue;
    applies++;
    first ??= i * hop - fromMs;
  }
  return { err: errorAt(toMs), first, applies, rated, rightMs, nearMs, rate: timing.rate };
}

const q = (a, f) => { const s = [...a].sort((x, y) => x - y); return s.length ? s[Math.floor(f * (s.length - 1))] : NaN; };
const total = { n: 0, right: 0, near: 0, wrong: 0, never: 0, firsts: [], extra: 0, rated: 0, wrongs: [] };
console.log(whole ? "film            min  displaced   on screen within 300ms   within 1s   applies  rates  rate" : `film           runs  right(<=${RIGHT_MS})  <=500  wrong  never   first apply p50/p90 min  extra applies  rates`);
for (const name of names) {
  const film = loadFilm(name), cues = film.cues, filmMs = film.filmMs, line = film.line;
  const belongs = line ? (ms) => line.offsetMs + line.msPerMinute * ms / 60000 : () => 0;
  if (whole) {
    for (const truth of TRUTHS) {
      const r = listen(film, truth, 0, filmMs, belongs);
      console.log(name.padEnd(14), (filmMs / 60000).toFixed(0).padStart(5), `${(truth / 1000).toFixed(2)}s`.padStart(10),
        `${(100 * r.rightMs / filmMs).toFixed(1)}%`.padStart(24), `${(100 * r.nearMs / filmMs).toFixed(1)}%`.padStart(11), String(r.applies).padStart(9),
        String(r.rated).padStart(6), r.rate.toFixed(5).padStart(8));
    }
    continue;
  }
  const f = { n: 0, right: 0, near: 0, wrong: 0, never: 0, firsts: [], extra: 0, rated: 0 };
  for (let t0 = 0; t0 + minutes * 60000 <= filmMs && !(startOnly && t0 > 0); t0 += every * 60000) {
    for (const truth of TRUTHS) {
      const r = listen(film, truth, t0, t0 + minutes * 60000, belongs);
      f.n++;
      f.rated += r.rated;
      if (r.first == null) { if (Math.abs(r.err) <= RIGHT_MS) f.right++; else f.never++; continue; }
      f.firsts.push(r.first);
      if (t0 === 0) (f.afterLine ??= []).push(r.first - Math.max(0, cues[0].startMs - truth));
      f.extra += r.applies - 1;
      if (Math.abs(r.err) <= RIGHT_MS) f.right++;
      else if (Math.abs(r.err) <= 500) f.near++;
      else { f.wrong++; total.wrongs.push(`${name}@${t0 / 60000}m:${r.err}`); }
    }
  }
  for (const k of ["n", "right", "near", "wrong", "never", "extra", "rated"]) total[k] += f[k];
  (total.afterLine ??= []).push(...(f.afterLine || []));
  total.firsts.push(...f.firsts);
  console.log(name.padEnd(14), String(f.n).padStart(5), String(f.right).padStart(11), String(f.near).padStart(6), String(f.wrong).padStart(6), String(f.never).padStart(6),
    `${(q(f.firsts, 0.5) / 60000).toFixed(1)}/${(q(f.firsts, 0.9) / 60000).toFixed(1)}`.padStart(25), String(f.extra).padStart(14), String(f.rated).padStart(6));
}
if (!whole) {
  console.log("all".padEnd(14), String(total.n).padStart(5), String(total.right).padStart(11), String(total.near).padStart(6), String(total.wrong).padStart(6), String(total.never).padStart(6),
    `${(q(total.firsts, 0.5) / 60000).toFixed(1)}/${(q(total.firsts, 0.9) / 60000).toFixed(1)}`.padStart(25), String(total.extra).padStart(14), String(total.rated).padStart(6));
  if (total.wrongs.length) console.log("wrong:", total.wrongs.join(" "));
  // From the first frame: how long after the subtitle's first line was the first correction.
  if (total.afterLine?.length) console.log(`from the start, first correction after the first line: p50 ${(q(total.afterLine, 0.5) / 60000).toFixed(1)} min, p90 ${(q(total.afterLine, 0.9) / 60000).toFixed(1)} min, over ${total.afterLine.length}`);
}
