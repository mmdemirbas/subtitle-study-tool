// One two-minute block at a time, every minute along each film: how often the
// shift comes back within a second of the truth when a line is placed by its
// whole length (bestShift alone) and when it is placed by its first part and
// then refined by the whole (placeLines, which is what ships), with the signed
// median of the answers that landed - the bias each file's timing carries.
//
//   node bench/listen/blocks.mjs [name...]
//
// The speech frames are the extension's own: one createHearing fed the whole
// film from its first frame, read back block by block.
import { loadFilm, filmNames, hearWhole, HOP_MS as hop } from "./film.mjs";

const { bestShift, placeLines } = globalThis.__ssoListen;
// A film whose subtitle is from another release (it has a .truth.json) has no
// one shift to be within a second of, and is left out unless named.
const names = filmNames(process.argv.slice(2));
const TRUTH = 4000, BLOCK_MS = 120000;

const med = (a) => { const s = [...a].sort((x, y) => x - y); return s.length ? s[s.length >> 1] : NaN; };
const total = { n: 0, whole: 0, head: 0 };
const cell = (ok, n, errs) => `${ok} (${(100 * ok / n).toFixed(0)}%), ${med(errs)}ms`;
console.log("film           blocks      whole line: within 1s, bias   head, then whole: within 1s, bias");
for (const name of names) {
  const film = loadFilm(name);
  const { cues, filmMs } = film;
  const heard = hearWhole(film);
  const out = { whole: { ok: 0, errs: [] }, head: { ok: 0, errs: [] } };
  let n = 0;
  for (let from = 0; from + BLOCK_MS <= filmMs; from += 60000) {
    const spans = cues
      .filter((c) => c.endMs - TRUTH > from - 60000 && c.startMs - TRUTH < from + BLOCK_MS + 60000)
      .map((c) => [c.startMs - TRUTH, c.endMs - TRUTH]);
    if (spans.length < 8) continue;
    const speech = heard.subarray(from / hop, (from + BLOCK_MS) / hop);
    n++;
    const answers = { whole: bestShift(speech, spans, { hopMs: hop, originMs: from }), head: placeLines(speech, spans, { hopMs: hop, originMs: from }) };
    for (const key of ["whole", "head"]) {
      const got = answers[key];
      if (got && Math.abs(got.shiftMs - TRUTH) <= 1000) { out[key].ok++; out[key].errs.push(got.shiftMs - TRUTH); }
    }
  }
  total.n += n; total.whole += out.whole.ok; total.head += out.head.ok;
  console.log(name.padEnd(14), String(n).padStart(6), cell(out.whole.ok, n, out.whole.errs).padStart(32), cell(out.head.ok, n, out.head.errs).padStart(37));
}
console.log("all".padEnd(14), String(total.n).padStart(6),
  `${total.whole} (${(100 * total.whole / total.n).toFixed(1)}%)`.padStart(32), `${total.head} (${(100 * total.head / total.n).toFixed(1)}%)`.padStart(37));
