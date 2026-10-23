// One film of bench/listen/films: its feature vectors as features.mjs wrote
// them, its subtitle, and the films a table is made of.
import fs from "node:fs";
import path from "node:path";
import { parseSrt } from "../../browser-extension/src/subtitles/srt.js";
import "../../browser-extension/src/listen.js";

export const FILMS = path.join(path.dirname(new URL(import.meta.url).pathname), "films");
export const HOP_MS = 50;

export function loadFilm(name) {
  const { FEATURES } = globalThis.__ssoListen;
  const buf = fs.readFileSync(path.join(FILMS, `${name}.f32`));
  const all = new Float32Array(buf.buffer, buf.byteOffset, buf.length / 4);
  const frames = all.length / FEATURES;
  const cues = parseSrt(fs.readFileSync(path.join(FILMS, `${name}.srt`), "utf8"));
  const truthFile = path.join(FILMS, `${name}.truth.json`);
  return {
    name,
    frames,
    filmMs: frames * HOP_MS,
    cues,
    line: fs.existsSync(truthFile) ? JSON.parse(fs.readFileSync(truthFile, "utf8")) : null,
    features: (i) => all.subarray(i * FEATURES, (i + 1) * FEATURES),
  };
}

/* Every film, or the named ones. A film with a .truth.json has another
 * release's subtitle and is left out unless named. */
export function filmNames(args) {
  if (args.length) return args;
  return fs.readdirSync(FILMS)
    .filter((f) => f.endsWith(".f32"))
    .map((f) => f.slice(0, -4))
    .filter((name) => !fs.existsSync(path.join(FILMS, `${name}.truth.json`)))
    .sort();
}

/* The whole film heard at once, as the extension would from its first frame:
 * the speech probability of every frame, -1 where none was stored. */
export function hearWhole(film) {
  const hearing = globalThis.__ssoListen.createHearing({ blockFrames: Infinity });
  for (let i = 0; i < film.frames; i++) hearing.hear(i * HOP_MS, film.features(i));
  return hearing.framesBetween(0, film.filmMs);
}
