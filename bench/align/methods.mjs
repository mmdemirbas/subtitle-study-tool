/* The alignment methods under test, behind one interface.
 *
 * Each method answers two questions about a pair of subtitle files, and the
 * bench scores them separately because they fail independently:
 *
 *   shiftMs  - how far apart are these two clocks?
 *   scores   - how sure are you these are the same film? (higher = surer)
 *
 * `scores` is a map rather than a number on purpose. A method often exposes
 * several statistics and it is not obvious in advance which one discriminates;
 * the interval method's correlation and its peak prominence disagree about
 * different pairs, and that only becomes visible if both are carried through
 * to the metrics.
 *
 * A method must not read the pair's label. There is no ground truth in scope
 * here for exactly that reason.
 */

const BIN = 100;                    // ms per sample for the signal methods
const MAX_LAG_MS = 180_000;         // the window align.js searches
const MAX_LAG = MAX_LAG_MS / BIN;
const MIN_OVERLAP_BINS = 600;       // 60s of shared timeline before a lag counts

// --- shared signal machinery -------------------------------------------------

/** ffsubsync's representation: is any cue on during this bin? */
function occupancy(spans) {
  const end = Math.ceil(spans[spans.length - 1][1] / BIN) + 1;
  const sig = new Float64Array(end);
  for (const [a, b] of spans) {
    const from = Math.max(0, Math.floor(a / BIN));
    const to = Math.min(end, Math.ceil(b / BIN));
    for (let i = from; i < to; i++) sig[i] = 1;
  }
  return sig;
}

function fft(re, im, inverse) {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) { [re[i], re[j]] = [re[j], re[i]]; [im[i], im[j]] = [im[j], im[i]]; }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = (inverse ? 2 : -2) * Math.PI / len;
    const wr = Math.cos(ang), wi = Math.sin(ang);
    for (let i = 0; i < n; i += len) {
      let cr = 1, ci = 0;
      for (let j = 0; j < len / 2; j++) {
        const ur = re[i + j], ui = im[i + j];
        const vr = re[i + j + len / 2] * cr - im[i + j + len / 2] * ci;
        const vi = re[i + j + len / 2] * ci + im[i + j + len / 2] * cr;
        re[i + j] = ur + vr; im[i + j] = ui + vi;
        re[i + j + len / 2] = ur - vr; im[i + j + len / 2] = ui - vi;
        const nr = cr * wr - ci * wi; ci = cr * wi + ci * wr; cr = nr;
      }
    }
  }
  if (inverse) for (let i = 0; i < n; i++) { re[i] /= n; im[i] /= n; }
}

/* One forward transform per FILE, not per pair. With N files there are N(N-1)/2
 * pairs and only N signals, so caching turns the dominant cost into a rounding
 * error - 54 transforms instead of 2862. */
const cache = new Map();
let SIZE = 0;

export function prepare(files) {
  cache.clear();
  let longest = 0;
  for (const f of files.values()) longest = Math.max(longest, f.spans[f.spans.length - 1][1]);
  SIZE = 1;
  while (SIZE < 2 * (Math.ceil(longest / BIN) + MAX_LAG + 2)) SIZE <<= 1;
}

function signal(file) {
  const found = cache.get(file.id);
  if (found) return found;
  const sig = occupancy(file.spans);
  const prefix = new Float64Array(sig.length + 1);
  for (let i = 0; i < sig.length; i++) prefix[i + 1] = prefix[i] + sig[i];
  const re = new Float64Array(SIZE), im = new Float64Array(SIZE);
  re.set(sig);
  fft(re, im, false);
  const made = { sig, prefix, re, im, n: sig.length };
  cache.set(file.id, made);
  return made;
}

/** Cross-correlation of the two occupancy signals at every lag in the window. */
function correlate(a, b) {
  const A = signal(a), B = signal(b);
  const re = new Float64Array(SIZE), im = new Float64Array(SIZE);
  for (let i = 0; i < SIZE; i++) {
    re[i] = A.re[i] * B.re[i] + A.im[i] * B.im[i];
    im[i] = A.re[i] * B.im[i] - A.im[i] * B.re[i];
  }
  fft(re, im, true);
  return { A, B, cross: re };
}

const clampSum = (prefix, from, to) =>
  prefix[Math.max(0, Math.min(prefix.length - 1, to))] -
  prefix[Math.max(0, Math.min(prefix.length - 1, from))];

// --- 1. the incumbent --------------------------------------------------------

/* align.js as it ships. Loaded rather than reimplemented: a bake-off whose
 * baseline is a paraphrase of the baseline measures the paraphrase. */
let shipped = null;
export async function loadShipped(repo) {
  if (shipped) return shipped;
  await import(`${repo}/browser-extension/src/align.js`);
  shipped = globalThis.__ssoAlign;
  if (!shipped) throw new Error("align.js did not expose __ssoAlign");
  return shipped;
}

export const starts = {
  name: "starts",
  about: "Ships today. Histogram of pairwise cue-START differences, binomial tail, coverage gate.",
  run(a, b) {
    const answer = shipped.align(a.spans.map((s) => s[0]), b.spans.map((s) => s[0]));
    return {
      shiftMs: answer.ok ? answer.shiftMs : null,
      scores: { confidence: answer.confidence, coverage: answer.coverage ?? 0 },
      verdict: answer.verdict ?? (answer.ok ? "offer" : "no"),
    };
  },
};

// --- 2. interval occupancy, correlated --------------------------------------

export const overlap = {
  name: "overlap",
  about: "ffsubsync's representation. Occupancy at 100ms, Pearson correlation per lag, FFT search.",
  run(a, b) {
    const { A, B, cross } = correlate(a, b);
    let best = null;
    const all = [];
    for (let lag = -MAX_LAG; lag <= MAX_LAG; lag++) {
      const from = Math.max(0, lag);
      const to = Math.min(A.n, B.n + lag);
      const n = to - from;
      if (n < MIN_OVERLAP_BINS) continue;
      const sa = clampSum(A.prefix, from, to);
      const sb = clampSum(B.prefix, from - lag, to - lag);
      // Binary signals, so the sum of squares is the sum.
      const va = sa - (sa * sa) / n;
      const vb = sb - (sb * sb) / n;
      if (va <= 0 || vb <= 0) continue;
      const r = (cross[(lag + SIZE) % SIZE] - (sa * sb) / n) / Math.sqrt(va * vb);
      all.push({ lag, r });
      if (!best || r > best.r) best = { lag, r, raw: cross[(lag + SIZE) % SIZE], n };
    }
    if (!best) return { shiftMs: null, scores: { r: 0, prominence: 0, joint: 0 } };

    /* Prominence measures whether the peak is a SPIKE or a SLOPE, and the two
     * are what a coincidence and a match look like. The peak's own
     * neighbourhood is excluded or a broad peak flattens its own score. */
    const away = all.filter((v) => Math.abs(v.lag - best.lag) > 30).map((v) => v.r).sort((x, y) => x - y);
    const mid = away.length ? away[away.length >> 1] : 0;
    const mad = away.length
      ? away.map((v) => Math.abs(v - mid)).sort((x, y) => x - y)[away.length >> 1] || 1e-9
      : 1e-9;
    const prominence = (best.r - mid) / (1.4826 * mad);
    return {
      shiftMs: best.lag * BIN,
      scores: {
        r: best.r,
        prominence,
        // Both conditions at once, as one number, so it can be ranked like any
        // other score: how many times over does the weaker of the two clear the
        // thresholds measured on this corpus?
        joint: Math.min(best.r / 0.295, prominence / 4.9),
        // alass's nosplit objective with overlap_scoring is the RAW peak. Kept
        // to show what normalisation is worth.
        rawOverlap: best.raw / Math.max(1, Math.min(A.prefix[A.n], B.prefix[B.n])),
      },
    };
  },
};

// --- 3. matched anchors, robust line fit ------------------------------------

/* Neither published tool does this, and it is the only candidate here that can
 * answer a question the others cannot: whether the two clocks run at different
 * SPEEDS. A pure offset method has to be told the rate hypotheses in advance -
 * align.js carries seven - because a rate error destroys the constant-offset
 * peak the search depends on. Fitting a line to matched anchors measures the
 * rate instead of selecting it.
 *
 * The fit has to be robust, not least-squares: a wrong pair still produces
 * anchors, and one bad anchor drags a least-squares line anywhere. Theil-Sen
 * takes the median of pairwise slopes and has a 29% breakdown point.
 */
export const anchors = {
  name: "anchors",
  about: "Seed with the occupancy peak, match cue starts within tolerance, then Theil-Sen for offset AND rate.",
  run(a, b) {
    const seed = overlap.run(a, b);
    if (seed.shiftMs === null) return { shiftMs: null, scores: { anchors: 0, agreement: 0, rate: 1 } };

    // Anchors: for each start in A, the nearest start in B once the seed shift
    // is removed. Injective, so an over-segmented file cannot pair twice.
    const TOL = 400;
    const A = a.spans.map((s) => s[0]);
    const B = b.spans.map((s) => s[0]);
    const taken = new Uint8Array(B.length);
    const xs = [], ys = [];
    let j = 0;
    for (const x of A) {
      const want = x + seed.shiftMs;
      while (j < B.length && B[j] < want - TOL) j++;
      let bestAt = -1, bestGap = TOL + 1;
      for (let k = j; k < B.length && B[k] <= want + TOL; k++) {
        if (taken[k]) continue;
        const gap = Math.abs(B[k] - want);
        if (gap < bestGap) { bestGap = gap; bestAt = k; }
      }
      if (bestAt >= 0) { taken[bestAt] = 1; xs.push(x); ys.push(B[bestAt]); }
    }
    if (xs.length < 8) return { shiftMs: seed.shiftMs, scores: { anchors: xs.length, agreement: 0, rate: 1 } };

    /* Theil-Sen over a bounded sample of pairs. All pairs is O(n^2) and n is a
     * thousand; a fixed stride keeps it linear and the median stable. */
    const slopes = [];
    const step = Math.max(1, Math.floor(xs.length / 400));
    for (let i = 0; i < xs.length; i += step) {
      for (let k = i + step; k < xs.length; k += step) {
        const dx = xs[k] - xs[i];
        if (dx > 60_000) slopes.push((ys[k] - ys[i]) / dx);
      }
    }
    const mid = (v) => { const s = [...v].sort((p, q) => p - q); return s.length ? s[s.length >> 1] : 1; };
    const rate = slopes.length ? mid(slopes) : 1;
    const offsets = xs.map((x, i) => ys[i] - rate * x);
    const offset = mid(offsets);

    // How tightly the anchors sit on that line, which is what tells a real
    // correspondence from a scatter that happened to have a median.
    const spread = mid(offsets.map((o) => Math.abs(o - offset)));
    return {
      shiftMs: Math.round(offset),
      rate,
      scores: {
        anchors: xs.length,
        // Anchors found, as a share of the shorter file - the direct measure of
        // how much of the two files actually corresponds.
        agreement: xs.length / Math.min(A.length, B.length),
        // Tight is good, so it is inverted to keep "higher = surer".
        tightness: 1 / (1 + spread / 100),
        rateAway: Math.abs(rate - 1),
      },
    };
  },
};

export const METHODS = [starts, overlap, anchors];
