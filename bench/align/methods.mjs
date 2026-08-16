/* The alignment methods under test, behind one interface.
 *
 * Each method answers two questions about a pair of subtitle files, and the
 * bench scores them separately because they fail independently:
 *
 *   at(x)    - where in file B does the moment at x in file A happen?
 *   scores   - how sure are you these are the same film? (higher = surer)
 *
 * `at` is a FUNCTION, not a number, and that is a correction rather than an
 * extension. The interface used to be `shiftMs` alone, and the bench compared
 * those numbers across methods to decide who agreed with whom. One of the
 * methods - the shipped aligner - returns a shift that means nothing without
 * the rate beside it, so every pair whose two releases differ by a framerate
 * was recorded as a three-way dispute between a right answer and two wrong
 * ones. Amelie's two English releases differ by exactly 25/24; align.js
 * returns rate 1.041667 with a 167ms shift, which is right to a millisecond,
 * and the bench had it filed as "starts says 187ms, overlap says 113500ms,
 * nobody agrees". Scoring a mapping instead of an offset is the fix.
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

import { segment, scaleOf, fitRate, PENALTY_SIGMAS } from "./truth.mjs";

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

/** `y = rate * x + shift`, which is what every offset-and-rate method means. */
export const straight = (rate, shiftMs) => Object.assign((x) => rate * x + shiftMs, { rate, shiftMs });

export const starts = {
  name: "starts",
  about: "Ships today. Histogram of pairwise cue-START differences, binomial tail, coverage gate, seven rate hypotheses.",
  run(a, b) {
    const answer = shipped.align(a.spans.map((s) => s[0]), b.spans.map((s) => s[0]));
    return {
      at: answer.ok ? straight(answer.rate, answer.shiftMs) : null,
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
    if (!best) return { at: null, scores: { r: 0, prominence: 0, joint: 0 } };

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
      at: straight(1, best.lag * BIN),
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
    if (!seed.at) return { at: null, scores: { anchors: 0, agreement: 0, rate: 1 } };

    // Anchors: for each start in A, the nearest start in B once the seed shift
    // is removed. Injective, so an over-segmented file cannot pair twice.
    const TOL = 400;
    const A = a.spans.map((s) => s[0]);
    const B = b.spans.map((s) => s[0]);
    const taken = new Uint8Array(B.length);
    const xs = [], ys = [];
    let j = 0;
    for (const x of A) {
      const want = seed.at(x);
      while (j < B.length && B[j] < want - TOL) j++;
      let bestAt = -1, bestGap = TOL + 1;
      for (let k = j; k < B.length && B[k] <= want + TOL; k++) {
        if (taken[k]) continue;
        const gap = Math.abs(B[k] - want);
        if (gap < bestGap) { bestGap = gap; bestAt = k; }
      }
      if (bestAt >= 0) { taken[bestAt] = 1; xs.push(x); ys.push(B[bestAt]); }
    }
    if (xs.length < 8) return { at: seed.at, scores: { anchors: xs.length, agreement: 0, rate: 1 } };

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
      at: straight(rate, Math.round(offset)),
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

// --- 4. windowed offsets, segmented -----------------------------------------

/* The candidate the census argues for.
 *
 * 21 percent of the pairs the oracle can settle are staircases: five or six
 * plateaus with jumps of several seconds between them, and every one of them
 * is broadcast television, where each release keeps a different amount of the
 * black around the ad breaks. No offset and no rate exists that fits such a
 * pair, so all three methods above answer them with a number that is right
 * over one plateau and wrong over the rest.
 *
 * The shape of the fix is the same one truth.mjs uses, with the one part that
 * needs the words replaced by a part that does not:
 *
 *   truth.mjs   anchors on shared TEXT, then fits rate + segmented offsets
 *   this        anchors on nearby TIMINGS, then fits rate + segmented offsets
 *
 * That the two agree is therefore a real check and not a tautology - they
 * share the fitting and share none of the evidence. It also means this method
 * works on the cross-language pairs, which are 131 of the corpus's 283
 * same-film pairs and which the oracle refuses outright.
 *
 * Anchoring cannot be done against one global offset. On a pair that
 * staircases 30 seconds, a global answer sits on one plateau and everything
 * outside it falls beyond any sane tolerance - so a global anchor pass finds
 * the plateau it started on and nothing else. The offsets are estimated per
 * WINDOW instead, each window free to look anywhere within reach of the
 * global answer, and the segmentation is then run over the window offsets.
 */
const WINDOW_MS = 90_000;
const HOP_MS = 45_000;
const REACH_MS = 45_000;      // how far a window may sit from the global answer
const SEARCH_STEP_MS = 40;
const WINDOW_MIN_CUES = 8;
const WINDOW_TOL_MS = 300;    // a cue counts as matched inside this
const WINDOW_MIN_SHARE = 0.4; // ... and this many of them must be
const WINDOW_MARGIN = 1.3;    // over the best offset more than 2s away

/* A re-measured rate has to be worth a second pass. Below this it changes
 * nothing anyone could see at the far end of the film, and the pass costs as
 * much as the first one. */
const RATE_WORTH_MS = 400;

/* Every candidate offset scores by how many of the window's cues land on a cue
 * in B, rather than by correlation, because a window holds a dozen cues and
 * correlation over a dozen samples is mostly noise. Counting matches also
 * makes the two gates below expressible in the same units as the answer. */
function scoreShifts(xs, B, seed, around) {
  const wanted = xs.map((x) => seed(x));
  const steps = Math.floor((2 * REACH_MS) / SEARCH_STEP_MS) + 1;
  const hits = new Int32Array(steps);
  for (const want of wanted) {
    for (let s = 0; s < steps; s++) {
      const target = want + around - REACH_MS + s * SEARCH_STEP_MS;
      let lo = 0, hi = B.length;
      while (lo < hi) { const mid = (lo + hi) >> 1; if (B[mid] < target) lo = mid + 1; else hi = mid; }
      const near = Math.min(
        lo < B.length ? Math.abs(B[lo] - target) : Infinity,
        lo > 0 ? Math.abs(B[lo - 1] - target) : Infinity,
      );
      if (near <= WINDOW_TOL_MS) hits[s]++;
    }
  }
  return hits;
}

/** The offset this window of A most wants, or null when it cannot tell. */
function windowOffset(xs, B, seed, around) {
  const hits = scoreShifts(xs, B, seed, around);
  let bestAt = 0;
  for (let s = 1; s < hits.length; s++) if (hits[s] > hits[bestAt]) bestAt = s;
  const apart = Math.ceil(2000 / SEARCH_STEP_MS);
  let runnerUp = 0;
  for (let s = 0; s < hits.length; s++) {
    if (Math.abs(s - bestAt) <= apart) continue;
    if (hits[s] > runnerUp) runnerUp = hits[s];
  }
  /* Two gates, and both matter. A window where nothing matches has no answer,
   * and a window where the same number of cues match at three different
   * offsets has three answers, which is the same thing. */
  if (hits[bestAt] < Math.max(3, xs.length * WINDOW_MIN_SHARE)) return null;
  if (hits[bestAt] < runnerUp * WINDOW_MARGIN) return null;

  /* Counting matches inside a tolerance has a FLAT TOP: every shift within
   * WINDOW_TOL_MS of the right one matches the same cues, so the peak is a
   * 600ms-wide plateau and argmax returns its left edge. Measured before this
   * existed: three staircase pairs came back at a median error of 282, 287 and
   * 300ms - not noise, the half-width of the plateau, on every window of every
   * pair in the same direction.
   *
   * The count says which plateau; the matched cues say where in it. Taking the
   * median of what actually lined up costs one pass and removes the bias. */
  const coarse = around - REACH_MS + bestAt * SEARCH_STEP_MS;
  const gaps = [];
  for (const x of xs) {
    const target = seed(x) + coarse;
    let lo = 0, hi = B.length;
    while (lo < hi) { const mid = (lo + hi) >> 1; if (B[mid] < target) lo = mid + 1; else hi = mid; }
    let gap = Infinity;
    if (lo < B.length && Math.abs(B[lo] - target) < Math.abs(gap)) gap = B[lo] - target;
    if (lo > 0 && Math.abs(B[lo - 1] - target) < Math.abs(gap)) gap = B[lo - 1] - target;
    if (Math.abs(gap) <= WINDOW_TOL_MS) gaps.push(gap);
  }
  gaps.sort((p, q) => p - q);
  const centre = gaps.length ? gaps[gaps.length >> 1] : 0;
  return { shiftMs: coarse + centre, hit: hits[bestAt], of: xs.length };
}

export const split = {
  name: "split",
  about: "The shipped aligner for the rate, then one offset per 90s window, then the windows segmented into plateaus.",
  run(a, b) {
    /* Seeded from the SHIPPED aligner rather than from the occupancy peak,
     * because the rate is the one thing the windows cannot recover on their
     * own. A 4 percent framerate mismatch puts the two files 60 seconds apart
     * by the end, which is beyond any window's reach, and Amelie and Sherlock
     * are both exactly that. align.js sweeps seven ratios and gets both right
     * to within 180ms; seeding from the rate-blind peak instead had this
     * method 75 seconds out on Amelie while the thing it was meant to improve
     * on was already correct.
     *
     * That also makes this a refinement of what ships rather than a rival to
     * it: same identification, same refusal, one more question asked of the
     * pairs it accepts. */
    const seedAnswer = starts.run(a, b);
    if (!seedAnswer.at) return { at: null, scores: { ...seedAnswer.scores, held: 0, segments: 0 } };
    const A = a.spans.map((s) => s[0]);
    const B = b.spans.map((s) => s[0]);
    const last = A[A.length - 1];
    const filmMs = last - A[0];

    /* One complete pass at a given rate. Run twice: the second time with a
     * rate measured from the pair rather than chosen from a list. */
    const pass = (seed) => {
      const centres = [], offsets = [];
      for (let from = A[0]; from < last; from += HOP_MS) {
        const xs = A.filter((x) => x >= from && x < from + WINDOW_MS);
        if (xs.length < WINDOW_MIN_CUES) continue;
        /* Each window starts its search from what the window before it found,
         * so a staircase is walked up one step at a time instead of being
         * asked to jump the whole 30 seconds from the global answer at once. */
        const around = offsets.length ? offsets[offsets.length - 1] : 0;
        const found = windowOffset(xs, B, seed, around);
        if (!found) continue;
        centres.push(xs[xs.length >> 1]);
        offsets.push(found.shiftMs);
      }
      if (centres.length < 3) return null;

      /* One offset per WINDOW, so a plateau is measured in windows, not in
       * cues. A three-window opening plateau is two and a half minutes of film
       * and the default rule would merge it away; see MIN_SEGMENT_ANCHORS in
       * truth.mjs. The 30-second span rule is what does the real work here. */
      const pieces = segmentOffsets(offsets, centres);

      /* Two refinements, both cheap, both fixing an error the windows create
       * rather than an error in the pair.
       *
       * WHERE the break is. A window is 90 seconds and they hop 45, so the
       * segmentation can only place a break to the nearest window - and the
       * window straddling a real break answers with a blend of the two
       * plateaus, which drags the break up to a hop early. Measured on The
       * Americans S02E02: the true break is at 5:41 and the windows put it at
       * 5:15. Searching the cues between the two neighbouring windows for the
       * split that matches most lines puts it back.
       *
       * WHAT the level is. A plateau's level is the median of its windows, and
       * a window's own answer came from a dozen cues. Re-measuring it across
       * every cue in the plateau is the same computation over ten times the
       * evidence. */
      const bounds = breakPoints(pieces, centres, A, B, seed);
      const levels = bounds.map((edge, k) => level(A, B, seed, edge.from, edge.to, pieces[k].level));
      const plateaus = prune(bounds.map((edge, k) => ({ ...edge, level: levels[k] })), A, B, seed);

      const at = Object.assign((x) => {
        let found = plateaus[0].level;
        for (const plateau of plateaus) if (x >= plateau.from) found = plateau.level;
        return seed(x) + found;
      }, {
        rate: seed.rate, shiftMs: seed.shiftMs + plateaus[0].level,
        pieces: plateaus.length, breaks: plateaus.slice(1).map((e) => e.from),
      });
      return { at, pieces, offsets, centres, plateaus };
    };

    let result = pass(seedAnswer.at);
    if (!result) {
      return { at: seedAnswer.at, scores: { ...seedAnswer.scores, held: 0, segments: 1, windows: 0 } };
    }

    /* The rate, measured rather than chosen.
     *
     * align.js picks from seven framerate ratios, which is the right list for
     * how two releases USUALLY differ and is not the whole of how they can.
     * The Americans S02E09's Turkish pair differs by 1.00425 - not a ratio of
     * any two broadcast framerates, and what somebody's own stretch correction
     * leaves behind. The nearest hypothesis, 1.001, leaves 9 seconds across
     * the episode, and the first pass answered it by inventing 13 plateaus for
     * a staircase that has six.
     *
     * Once the plateaus are known the rate is easy to see: the anchors inside
     * them lie on a line, and their short-baseline median slope is it. A
     * second pass at that rate then has only the real steps left to find. */
    const anchored = [];
    for (const x of A) {
      const gap = nearest(B, result.at(x));
      if (Math.abs(gap) <= WINDOW_TOL_MS) anchored.push({ x, y: result.at(x) + gap });
    }
    if (anchored.length >= 40) {
      // `anchored` is (A time, B time), so the slope IS the rate, not a correction to it.
      const measured = fitRate(anchored);
      if (Math.abs(measured - seedAnswer.at.rate) * filmMs > RATE_WORTH_MS) {
        const better = pass(straight(measured, seedAnswer.at.shiftMs));
        if (better && better.pieces.length <= result.pieces.length) result = better;
      }
    }

    const { at, pieces, offsets, centres } = result;
    const covered = centres.length;

    /* How much of the film the windows actually spoke for. A pair that only
     * answers over a fifth of its length has not been aligned, whatever the
     * segments say about that fifth. */
    const held = covered / Math.max(1, Math.ceil(filmMs / HOP_MS));
    return {
      at,
      scores: {
        ...seedAnswer.scores,
        held,
        segments: at.pieces,
        // Windows that agreed with the plateau they were put in, as a share.
        settled: pieces.reduce((total, piece) => {
          let inside = 0;
          for (let i = piece.from; i < piece.to; i++) if (Math.abs(offsets[i] - piece.level) <= 250) inside++;
          return total + inside;
        }, 0) / covered,
      },
    };
  },
};

/** Where in A each plateau starts, refined from window resolution to cue resolution. */
function breakPoints(pieces, centres, A, B, seed) {
  const edges = pieces.map((piece, k) => ({
    from: k === 0 ? -Infinity : centres[piece.from],
    to: k + 1 < pieces.length ? centres[pieces[k + 1].from] : Infinity,
    level: piece.level,
  }));
  for (let k = 1; k < edges.length; k++) {
    const before = edges[k - 1].level, after = edges[k].level;
    // The straddling window can be a hop out in either direction, so look both ways.
    const lo = centres[pieces[k].from] - HOP_MS * 2;
    const hi = centres[pieces[k].from] + HOP_MS;
    const candidates = A.filter((x) => x >= lo && x <= hi);
    if (candidates.length < 2) continue;
    let bestAt = edges[k].from, bestScore = -1;
    for (const boundary of candidates) {
      let score = 0;
      for (const x of candidates) score += matches(B, seed(x) + (x < boundary ? before : after)) ? 1 : 0;
      if (score > bestScore) { bestScore = score; bestAt = boundary; }
    }
    edges[k].from = bestAt;
    edges[k - 1].to = bestAt;
  }
  return edges;
}

/* Every break has to earn itself against the whole film, not just against the
 * squared error of the window offsets that suggested it.
 *
 * This exists because of four regressions, and they are the reason a method
 * that wins on average still cannot ship. On four pairs that the shipped
 * aligner already puts 100 percent of the film inside 250ms - three Amelie
 * releases and one Lost - the segmentation invented a second plateau and took
 * them to 59, 59, 59 and 65 percent. A better average bought by making working
 * cases worse is not an improvement; it is a different distribution of the
 * same complaint, and the reader who was happy is the one who notices.
 *
 * So a break is kept only if removing it would cost real matched lines. The
 * least valuable break goes first and the count is recomputed, because two
 * breaks that each look worth keeping on their own are sometimes one break
 * that was placed twice. */
const BREAK_WORTH = 0.02;   // of the film's cues, per break
const BREAK_WORTH_CUES = 8; // ... and never fewer than this many

function prune(plateaus, A, B, seed) {
  let current = plateaus;
  while (current.length > 1) {
    const before = matchCount(current, A, B, seed);
    let cheapest = -1, cheapestGain = Infinity;
    for (let k = 1; k < current.length; k++) {
      const merged = withoutBreak(current, k, A, B, seed);
      const gain = before - matchCount(merged, A, B, seed);
      if (gain < cheapestGain) { cheapestGain = gain; cheapest = k; }
    }
    if (cheapestGain >= Math.max(BREAK_WORTH_CUES, A.length * BREAK_WORTH)) return current;
    current = withoutBreak(current, cheapest, A, B, seed);
  }
  return current;
}

function withoutBreak(plateaus, k, A, B, seed) {
  const joined = { from: plateaus[k - 1].from, to: plateaus[k].to, level: plateaus[k - 1].level };
  joined.level = level(A, B, seed, joined.from, joined.to, joined.level);
  return [...plateaus.slice(0, k - 1), joined, ...plateaus.slice(k + 1)];
}

function matchCount(plateaus, A, B, seed) {
  let hit = 0;
  for (const x of A) {
    let found = plateaus[0].level;
    for (const plateau of plateaus) if (x >= plateau.from) found = plateau.level;
    if (matches(B, seed(x) + found)) hit++;
  }
  return hit;
}

/** The offset a whole plateau wants, from every cue inside it. */
function level(A, B, seed, from, to, start) {
  const gaps = [];
  for (const x of A) {
    if (x < from || x >= to) continue;
    const gap = nearest(B, seed(x) + start);
    if (Math.abs(gap) <= WINDOW_TOL_MS) gaps.push(gap);
  }
  if (gaps.length < 4) return start;
  gaps.sort((p, q) => p - q);
  return start + gaps[gaps.length >> 1];
}

function nearest(B, target) {
  let lo = 0, hi = B.length;
  while (lo < hi) { const mid = (lo + hi) >> 1; if (B[mid] < target) lo = mid + 1; else hi = mid; }
  let gap = Infinity;
  if (lo < B.length && Math.abs(B[lo] - target) < Math.abs(gap)) gap = B[lo] - target;
  if (lo > 0 && Math.abs(B[lo - 1] - target) < Math.abs(gap)) gap = B[lo - 1] - target;
  return gap;
}

const matches = (B, target) => Math.abs(nearest(B, target)) <= WINDOW_TOL_MS;

/* The same piecewise-constant DP truth.mjs runs, over window offsets rather
 * than per-anchor residuals. Imported rather than copied: a candidate whose
 * fitting is a paraphrase of the reference's fitting measures the paraphrase,
 * which is the mistake this bench was built to avoid making about align.js. */
function segmentOffsets(offsets, centres) {
  return segment(offsets, {
    penalty: PENALTY_SIGMAS * Math.max(scaleOf(offsets), 100) ** 2,
    at: (i) => centres[i],
    // Two windows agreeing is a plateau; the 30-second span rule is the gate.
    minAnchors: 2,
  });
}

export const METHODS = [starts, overlap, anchors, split];
