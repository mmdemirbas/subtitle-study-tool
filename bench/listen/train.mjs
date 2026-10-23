// Train the ear's speech detector: a logistic model on listen.js's feature
// vectors and their squares, labelled by each film's own subtitle - a frame
// inside a line is speech, a frame a second or more from any line is not, the
// frames between are left out.
//
//   node --max-old-space-size=8192 bench/listen/train.mjs           # judge it, each film held out
//   node --max-old-space-size=8192 bench/listen/train.mjs --write   # train on all, write it into listen.js
//
// --write replaces what is between the model markers in
// browser-extension/src/listen.js. Films with a .truth.json are left out: their
// subtitle is another release's, so its lines are not where this film speaks.
import fs from "node:fs";
import path from "node:path";
import { parseSrt } from "../../browser-extension/src/subtitles/srt.js";
import "../../browser-extension/src/listen.js";

const { FEATURES, placeLines } = globalThis.__ssoListen;
const HERE = path.dirname(new URL(import.meta.url).pathname);
const FILMS = path.join(HERE, "films");
const LISTEN = path.join(HERE, "../../browser-extension/src/listen.js");
const write = process.argv.includes("--write");
const names = fs.readdirSync(FILMS)
  .filter((f) => f.endsWith(".f32"))
  .map((f) => f.slice(0, -4))
  .filter((name) => !fs.existsSync(path.join(FILMS, `${name}.truth.json`)))
  .sort();
const D = FEATURES, P = 2 * D + 1, HOP = 50, AWAY_MS = 1000, EVERY = 5;

const films = {};
for (const name of names) {
  const buf = fs.readFileSync(path.join(FILMS, `${name}.f32`));
  const X = new Float32Array(buf.buffer, buf.byteOffset, buf.length / 4);
  const n = X.length / D;
  const cues = parseSrt(fs.readFileSync(path.join(FILMS, `${name}.srt`), "utf8"));
  const inside = new Uint8Array(n);
  for (const c of cues) for (let i = Math.max(0, Math.floor(c.startMs / HOP)); i < Math.min(n, Math.ceil(c.endMs / HOP)); i++) inside[i] = 1;
  const dist = new Float64Array(n);
  let last = -1e9;
  for (let i = 0; i < n; i++) { if (inside[i]) last = i; dist[i] = i - last; }
  last = 1e9;
  for (let i = n - 1; i >= 0; i--) { if (inside[i]) last = i; dist[i] = Math.min(dist[i], last - i); }
  const label = new Int8Array(n).fill(-1);
  for (let i = 10; i < n; i++) label[i] = inside[i] ? 1 : dist[i] * HOP >= AWAY_MS ? 0 : -1;
  films[name] = { X, n, cues, label };
}

function fit(trainNames) {
  const mean = new Float64Array(D), std = new Float64Array(D);
  let count = 0;
  for (const name of trainNames) {
    const { X, n } = films[name];
    for (let i = 0; i < n; i += 7) { for (let j = 0; j < D; j++) { mean[j] += X[i * D + j]; std[j] += X[i * D + j] ** 2; } count++; }
  }
  for (let j = 0; j < D; j++) { mean[j] /= count; std[j] = Math.sqrt(Math.max(1e-9, std[j] / count - mean[j] ** 2)); }
  const expand = (X, i) => {
    const x = new Float64Array(P);
    x[0] = 1;
    for (let j = 0; j < D; j++) { const v = (X[i * D + j] - mean[j]) / std[j]; x[1 + j] = v; x[1 + D + j] = v * v; }
    return x;
  };
  const rows = [], ys = [];
  for (const name of trainNames) {
    const { X, n, label } = films[name];
    for (let i = 0; i < n; i += EVERY) if (label[i] >= 0) { rows.push(expand(X, i)); ys.push(label[i]); }
  }
  const w = new Float64Array(P);
  for (let it = 0; it < 15; it++) { // Newton's method with a little L2
    const g = new Float64Array(P), H = Array.from({ length: P }, () => new Float64Array(P));
    for (let r = 0; r < rows.length; r++) {
      const x = rows[r];
      let z = 0;
      for (let j = 0; j < P; j++) z += w[j] * x[j];
      const p = 1 / (1 + Math.exp(-z)), e = ys[r] - p, s = p * (1 - p);
      for (let j = 0; j < P; j++) { g[j] += e * x[j]; const sx = s * x[j]; for (let k = j; k < P; k++) H[j][k] += sx * x[k]; }
    }
    for (let j = 0; j < P; j++) { g[j] -= w[j]; H[j][j] += 1; for (let k = 0; k < j; k++) H[j][k] = H[k][j]; }
    const A = H.map((row, j) => [...row, g[j]]);
    for (let c = 0; c < P; c++) {
      let pivot = c;
      for (let r = c + 1; r < P; r++) if (Math.abs(A[r][c]) > Math.abs(A[pivot][c])) pivot = r;
      [A[c], A[pivot]] = [A[pivot], A[c]];
      for (let r = 0; r < P; r++) if (r !== c) { const f = A[r][c] / A[c][c]; for (let k = c; k <= P; k++) A[r][k] -= f * A[c][k]; }
    }
    let step = 0;
    for (let j = 0; j < P; j++) { const d = A[j][P] / A[j][j]; w[j] += d; step += d * d; }
    if (step < 1e-10) break;
  }
  const round = (a, k) => Array.from(a, (v) => Number(v.toFixed(k)));
  return { mean: round(mean, 4), std: round(std, 4), weights: round(w, 5) };
}

function probabilities(model, X, n) {
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    let z = model.weights[0];
    for (let j = 0; j < D; j++) { const v = (X[i * D + j] - model.mean[j]) / model.std[j]; z += model.weights[1 + j] * v + model.weights[1 + D + j] * v * v; }
    out[i] = 1 / (1 + Math.exp(-z));
  }
  return out;
}

function auc(scores, labels) {
  const order = scores.map((_, i) => i).sort((a, b) => scores[a] - scores[b]);
  let rank = 0, pos = 0, sum = 0;
  for (const i of order) { rank++; if (labels[i]) { pos++; sum += rank; } }
  return (sum - (pos * (pos + 1)) / 2) / (pos * (scores.length - pos));
}

if (write) {
  const model = fit(names);
  const source = fs.readFileSync(LISTEN, "utf8");
  const begin = "/* model:begin */", end = "/* model:end */";
  const a = source.indexOf(begin), b = source.indexOf(end);
  if (a < 0 || b < a) throw new Error("no model markers in listen.js");
  const literal = `${begin} ${JSON.stringify({ trainedOn: names, ...model })} ${end}`;
  fs.writeFileSync(LISTEN, source.slice(0, a) + literal + source.slice(b + end.length));
  console.log(`wrote a model trained on ${names.length} films into listen.js`);
} else {
  const TRUTH = 4000;
  console.log("film (held out)   frame AUC   60s windows within 300ms");
  for (const held of names) {
    const model = fit(names.filter((name) => name !== held));
    const { X, n, cues, label } = films[held];
    const p = probabilities(model, X, n);
    const s = [], l = [];
    for (let i = 0; i < n; i += 3) if (label[i] >= 0) { s.push(p[i]); l.push(label[i]); }
    let ok = 0, m = 0;
    for (let from = 0; from + 60000 <= n * HOP; from += 30000) {
      const spans = cues.filter((c) => c.endMs - TRUTH > from - 60000 && c.startMs - TRUTH < from + 120000).map((c) => [c.startMs - TRUTH, c.endMs - TRUTH]);
      if (spans.length < 8) continue;
      const got = placeLines(p.slice(from / HOP, (from + 60000) / HOP), spans, { originMs: from });
      m++;
      if (got && Math.abs(got.shiftMs - TRUTH) <= 300) ok++;
    }
    console.log(held.padEnd(17), auc(s, l).toFixed(3).padStart(9), `${ok}/${m} (${((100 * ok) / m).toFixed(0)}%)`.padStart(20));
  }
}
