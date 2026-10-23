// A film's speech-band levels, frame by frame, as the extension's ear reads
// them: every 50ms the speech band (300-3400Hz) of the last 2048 samples at
// 48kHz, Blackman-windowed as an AnalyserNode windows them, for the middle
// (L+R)/2 and the sides (L-R)/2 of the stereo mix. Also takes out a text
// subtitle stream, which is timed to this very picture and is the truth.
//
//   node bench/listen/features.mjs <media> <name> [audio index] [subtitle stream]
//
// Writes bench/listen/films/<name>.json and <name>.srt (gitignored: the
// subtitle is the film's, and the levels are its sound). The audio index
// counts audio streams (0:a:N); the subtitle is an absolute stream number
// (0:N), because the first text stream is often a picture-based one.
import { spawn, execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const [media, name, aIndex = "0", sIndex] = process.argv.slice(2);
if (!media || !name) { console.error("usage: features.mjs <media> <name> [audio index] [subtitle stream]"); process.exit(2); }
const OUT = path.join(path.dirname(new URL(import.meta.url).pathname), "films");
fs.mkdirSync(OUT, { recursive: true });
const RATE = Number(process.env.RATE || 48000), N = Number(process.env.FFT || 2048), HOP_MS = 50, HOP = RATE * HOP_MS / 1000;

if (sIndex != null) execFileSync("ffmpeg", ["-v", "error", "-y", "-i", media, "-map", `0:${sIndex}`, path.join(OUT, `${name}.srt`)]);

const win = new Float64Array(N).map((_, i) => 0.42 - 0.5 * Math.cos(2 * Math.PI * i / N) + 0.08 * Math.cos(4 * Math.PI * i / N));
function fft(re, im) {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) { let bit = n >> 1; for (; j & bit; bit >>= 1) j ^= bit; j ^= bit; if (i < j) { [re[i], re[j]] = [re[j], re[i]]; [im[i], im[j]] = [im[j], im[i]]; } }
  for (let len = 2; len <= n; len <<= 1) {
    const a = -2 * Math.PI / len, wr = Math.cos(a), wi = Math.sin(a);
    for (let i = 0; i < n; i += len) {
      let cr = 1, ci = 0;
      for (let k = 0; k < len / 2; k++) {
        const h = i + k + len / 2, ur = re[i + k], ui = im[i + k], vr = re[h] * cr - im[h] * ci, vi = re[h] * ci + im[h] * cr;
        re[i + k] = ur + vr; im[i + k] = ui + vi; re[h] = ur - vr; im[h] = ui - vi;
        const t = cr * wr - ci * wi; ci = cr * wi + ci * wr; cr = t;
      }
    }
  }
}
const binHz = RATE / N;
function speechBand(buf) {
  const re = new Float64Array(N), im = new Float64Array(N);
  for (let i = 0; i < N; i++) re[i] = buf[i] * win[i];
  fft(re, im);
  let band = 0;
  for (let k = 1; k < N / 2; k++) { const hz = k * binHz; if (hz >= 300 && hz <= 3400) band += re[k] * re[k] + im[k] * im[k]; }
  return Math.round(10 * Math.log10(band + 1e-12) * 10) / 10;
}

const ff = spawn("ffmpeg", ["-v", "error", "-i", media, "-map", `0:a:${aIndex}`, "-ac", "2", "-ar", String(RATE), "-f", "f32le", "-"]);
const L = Math.max(N, HOP);
const mid = new Float32Array(L), side = new Float32Array(L);
const frames = { hopMs: HOP_MS, rate: RATE, fft: N, band: [], sideBand: [] };
let carry = Buffer.alloc(0), filled = 0, queueM = [], queueS = [];
ff.stdout.on("data", (chunk) => {
  const buf = Buffer.concat([carry, chunk]);
  const usable = Math.floor(buf.length / 8) * 8;
  const st = new Float32Array(buf.buffer.slice(buf.byteOffset, buf.byteOffset + usable));
  carry = buf.subarray(usable);
  for (let i = 0; i < st.length; i += 2) { queueM.push((st[i] + st[i + 1]) / 2); queueS.push((st[i] - st[i + 1]) / 2); }
  while (queueM.length >= HOP) {
    mid.copyWithin(0, HOP); side.copyWithin(0, HOP);
    mid.set(queueM.splice(0, HOP), L - HOP); side.set(queueS.splice(0, HOP), L - HOP); filled += HOP;
    if (filled < N) { frames.band.push(-120); frames.sideBand.push(-120); continue; }
    frames.band.push(speechBand(mid.subarray(L - N)));
    frames.sideBand.push(speechBand(side.subarray(L - N)));
  }
});
ff.stderr.on("data", (d) => process.stderr.write(d));
ff.on("close", (code) => {
  fs.writeFileSync(path.join(OUT, `${name}.json`), JSON.stringify(frames));
  console.log(name, code, `${(frames.band.length * HOP_MS / 60000).toFixed(1)} min`);
});
