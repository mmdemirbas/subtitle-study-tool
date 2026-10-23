// Does the ear take music for speech? Per film, what share of frames it marks
// as speech inside a line of the film's own subtitle, and what share far from
// any line - where the sound is music, effects, silence or speech nobody
// subtitled - with the film's opening (before its first line) apart, since
// that is where a title sequence plays.
//
//   node bench/listen/music.mjs [name...]
import { loadFilm, filmNames, hearWhole, HOP_MS as hop } from "./film.mjs";

const names = filmNames(process.argv.slice(2));
const AWAY_MS = 5000;

const share = (count) => (count.n ? `${(100 * count.speech / count.n).toFixed(1)}%` : "-");
console.log("film           in a line   far from lines   opening (min)   opening marked");
for (const name of names) {
  const film = loadFilm(name);
  const { cues, filmMs } = film;
  const frames = hearWhole(film);
  // Distance from each frame to the nearest line, by two sweeps.
  const inside = new Uint8Array(frames.length);
  for (const c of cues) for (let i = Math.max(0, Math.floor(c.startMs / hop)); i < Math.min(frames.length, Math.ceil(c.endMs / hop)); i++) inside[i] = 1;
  const near = new Float64Array(frames.length).fill(Infinity);
  let last = -Infinity;
  for (let i = 0; i < frames.length; i++) { if (inside[i]) last = i; near[i] = (i - last) * hop; }
  last = Infinity;
  for (let i = frames.length - 1; i >= 0; i--) { if (inside[i]) last = i; near[i] = Math.min(near[i], (last - i) * hop); }
  const firstLine = cues.length ? cues[0].startMs : filmMs;
  const count = { line: { n: 0, speech: 0 }, away: { n: 0, speech: 0 }, opening: { n: 0, speech: 0 } };
  for (let i = 0; i < frames.length; i++) {
    if (frames[i] < 0) continue;
    const kind = inside[i] ? "line" : near[i] >= AWAY_MS ? "away" : null;
    if (kind) { count[kind].n++; count[kind].speech += frames[i]; }
    if (i * hop < firstLine - AWAY_MS) { count.opening.n++; count.opening.speech += frames[i]; }
  }
  console.log(name.padEnd(14), share(count.line).padStart(9), share(count.away).padStart(16),
    (firstLine / 60000).toFixed(1).padStart(15), share(count.opening).padStart(16));
}
