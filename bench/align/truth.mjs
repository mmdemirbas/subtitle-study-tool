/* Ground truth for the alignment bake-off, derived from the words.
 *
 * WHY THIS EXISTS
 *
 * The bench had no truth for the shifts. It built a consensus instead: a pair
 * where the methods land within 250ms of each other is "settled" at their
 * median, and the rest are reported as disputed. That is honest about not
 * knowing, and it has one failure it cannot see - the settled pairs are
 * exactly the pairs the methods find easy, so every number computed on them
 * describes the easy half of the corpus. 29 of 93 same-film pairs were
 * excluded from the timing table on those grounds, and those 29 are the ones
 * worth measuring.
 *
 * HOW A TRUTH CAN BE INDEPENDENT
 *
 * The one part of a subtitle file that no alignment method reads is the text.
 * Two releases of the same film in the same language usually carry the same
 * words - one file is very often a re-timing of the other - so matching cue
 * TEXT gives a correspondence that owes nothing to any timing, and every
 * matched pair is a point on the true warp.
 *
 * Matching is unique-exact-text plus a longest increasing subsequence, which
 * is the anchor trick `diff` uses. A line that appears exactly once in each
 * file and reads identically is not a coincidence; requiring the matches to
 * be monotone in both files throws away the few that are.
 *
 * WHAT IT CANNOT DO
 *
 * Cross-language pairs have no shared text, so there is no oracle for them
 * here - `anchorsFor` refuses rather than guessing, and the bench reports the
 * coverage. Same-language pairs from independent transcriptions yield too few
 * anchors and are refused the same way. Both refusals are visible in the
 * output; neither is silently filled in.
 */

const MIN_ANCHORS = 40;
const MIN_SHARE = 0.15;      // of the shorter file
const MIN_TEXT_LENGTH = 6;   // "yes" and "no" match everywhere and mean nothing

/* Two files agreeing this closely are one clock. Chosen to sit above the
 * rounding in an SRT timestamp (10ms) and below the smallest sync error a
 * reader reports noticing, which the extension's own nudge step puts at
 * 100ms. */
export const TIGHT_MS = 250;

/** Matched (aTime, bTime) points, or null when the text cannot settle it. */
export function anchorsFor(a, b) {
  const A = a.cues, B = b.cues;
  if (!A?.length || !B?.length) return null;

  const countA = new Map(), countB = new Map();
  for (const cue of A) countA.set(cue.key, (countA.get(cue.key) || 0) + 1);
  for (const cue of B) countB.set(cue.key, (countB.get(cue.key) || 0) + 1);

  const whereB = new Map();
  B.forEach((cue, i) => { if (countB.get(cue.key) === 1) whereB.set(cue.key, i); });

  const candidates = [];
  A.forEach((cue, i) => {
    if (cue.key.length < MIN_TEXT_LENGTH || countA.get(cue.key) !== 1) return;
    const j = whereB.get(cue.key);
    if (j !== undefined) candidates.push([i, j]);
  });
  if (candidates.length < MIN_ANCHORS) return null;

  /* Monotone in both files. A subtitle file is a sequence and the true warp
   * never runs backwards, so a match that would require it is wrong however
   * identical the line reads. */
  const rising = longestRising(candidates.map(([, j]) => j));
  let kept = rising.map((k) => candidates[k]);

  /* Injective in TIME, not only in index.
   *
   * A two-speaker exchange is one cue in some files and two cues sharing a
   * start in others, so two different lines legitimately carry the same
   * timestamp. Both are matched, and one of the two is then a point on the
   * warp while the other is that point plus however far apart the speakers
   * were. Measured on The Americans S01E01: two consecutive lines 1.5s apart
   * in one file both start at 616210 in the other, and the residual came back
   * alternating by +/-1500ms - read as 221 segments of structure by a
   * segmenter that had no way to know it was reading punctuation.
   *
   * Neither of the pair can be trusted over the other, so both go. */
  const seenX = new Map(), seenY = new Map();
  for (const [i, j] of kept) {
    seenX.set(A[i].start, (seenX.get(A[i].start) || 0) + 1);
    seenY.set(B[j].start, (seenY.get(B[j].start) || 0) + 1);
  }
  kept = kept.filter(([i, j]) => seenX.get(A[i].start) === 1 && seenY.get(B[j].start) === 1);

  if (kept.length < MIN_ANCHORS) return null;
  if (kept.length / Math.min(A.length, B.length) < MIN_SHARE) return null;

  return kept.map(([i, j]) => ({ x: A[i].start, y: B[j].start }));
}

/** Indices of a longest strictly increasing subsequence. */
function longestRising(values) {
  const tails = [], at = [], from = new Array(values.length).fill(-1);
  for (let k = 0; k < values.length; k++) {
    let lo = 0, hi = tails.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (tails[mid] < values[k]) lo = mid + 1; else hi = mid;
    }
    tails[lo] = values[k];
    at[lo] = k;
    from[k] = lo > 0 ? at[lo - 1] : -1;
  }
  const out = [];
  for (let k = at[tails.length - 1]; k >= 0; k = from[k]) out.push(k);
  return out.reverse();
}

const sorted = (v) => [...v].sort((p, q) => p - q);
const median = (v) => { const s = sorted(v); return s.length ? s[s.length >> 1] : NaN; };
const quantile = (v, f) => { const s = sorted(v); return s.length ? s[Math.min(s.length - 1, Math.floor(f * s.length))] : NaN; };

/* The rate, measured over SHORT baselines on purpose.
 *
 * The obvious estimator is Theil-Sen over every pair of anchors, and it is
 * wrong here in a way that took a wrong answer to notice. A staircase pair -
 * one release with an ad break the other does not have - accumulates its steps
 * into every long baseline, so the median long-baseline slope reads the steps
 * as a slope. Measured on The Americans S02E09, whose two Turkish files share
 * a framerate exactly: all-pairs Theil-Sen returned 0.99311, and the residual
 * after removing that phantom 0.7% slope needed 59 segments to flatten. The
 * truth is rate 1 and six steps.
 *
 * A baseline of one to three minutes is long enough for timestamp noise
 * (+/-100ms) to be small against it and short enough that only the few pairs
 * straddling a step are contaminated - a handful out of hundreds, which is
 * what a median is for.
 */
export function fitRate(points, { minSpanMs = 60_000, maxSpanMs = 180_000 } = {}) {
  const slopes = [];
  for (let i = 0, j = 0; i < points.length; i++) {
    while (j < points.length && points[j].x - points[i].x < minSpanMs) j++;
    for (let k = j; k < points.length && points[k].x - points[i].x <= maxSpanMs; k++) {
      slopes.push((points[k].y - points[i].y) / (points[k].x - points[i].x));
    }
  }
  if (!slopes.length) return 1;
  const span = points[points.length - 1].x - points[0].x;
  return snapRate(median(slopes), span);
}

/* Framerate ratios a real pair of releases can differ by, plus the one that
 * matters most: exactly the same. */
const F23976 = 24000 / 1001;
export const RATE_CANDIDATES = [
  1,
  25 / F23976, 25 / 24, 30 / (30000 / 1001),
  F23976 / 25, 24 / 25, (30000 / 1001) / 30,
  24 / F23976, F23976 / 24,
];

/* A measured slope this close to a candidate is that candidate.
 *
 * Not cosmetic. A measured 1.00002 against a true 1 is a 56ms error at the end
 * of a 47-minute episode, which nobody sees - but the residual it leaves is a
 * ramp, and a segmenter handed a ramp reports it as a staircase. Five of six
 * pairs known to need one segment came back needing five before this existed.
 *
 * The tolerance is stated as an error at the far end of the material rather
 * than as a slope, because that is the quantity a reader would notice. */
const SNAP_MS = 200;

export function snapRate(rate, spanMs) {
  let best = rate, bestAway = SNAP_MS;
  for (const candidate of RATE_CANDIDATES) {
    const away = Math.abs(rate - candidate) * Math.max(spanMs, 1);
    if (away < bestAway) { bestAway = away; best = candidate; }
  }
  return best;
}

/** A rate and the offset its residuals want, as one straight line. */
export function fitLine(points) {
  const rate = fitRate(points);
  return { rate, offset: median(points.map((p) => p.y - rate * p.x)) };
}

/* Piecewise-constant fit of the residuals, by dynamic programming.
 *
 * The model is `y = rate * x + offset(segment)`: one rate for the whole file,
 * because a framerate mismatch is a property of the two encodes, and a
 * separate offset per segment, because a recap, an ad break or a missing scene
 * moves everything after it by a constant.
 *
 * Segments are paid for. Without a price the fit puts a break between every
 * pair of points and reports zero error, so the penalty is what stops "how
 * many shifts does this pair need" from always answering "as many as it has
 * lines".
 *
 * The price is set from the pair's OWN noise rather than fixed, because the
 * corpus holds two populations with noise floors an order of magnitude apart.
 * Where one file is a re-timing of the other, matched cues agree to the
 * millisecond. Where two subtitlers timed the same release independently,
 * they disagree by several hundred milliseconds on every line - each picks
 * their own in-point - and a fixed penalty tuned on the first population reads
 * that disagreement as structure. See `scaleOf`.
 *
 * Cost is squared deviation rather than absolute so a prefix sum answers
 * `cost(i, j)` in constant time; the O(n^2) DP over a thousand anchors is then
 * a million cheap steps instead of a billion. The LEVEL each segment is
 * reported at is still its median, because that is the number a shift would
 * actually be set to and it does not move when one anchor is wrong.
 */

/* PENALTY_SIGMAS is how many times the noise variance a break has to save
 * before it is worth taking. A spurious break placed in pure noise saves about
 * one variance, so anything comfortably above 1 refuses them; the value is
 * checked in run.mjs against pairs known to need one segment and pairs known
 * to need six. */
export const PENALTY_SIGMAS = 12;

/* Robust noise scale from CONSECUTIVE differences rather than from deviations
 * around a mean. A level shift changes exactly one consecutive difference, so
 * this reads the jitter and not the staircase - which an ordinary MAD around
 * the median cannot do, since to it the staircase IS the spread. */
export function scaleOf(residuals) {
  if (residuals.length < 8) return 0;
  const steps = [];
  for (let i = 1; i < residuals.length; i++) steps.push(Math.abs(residuals[i] - residuals[i - 1]));
  return (median(steps) * 1.4826) / Math.SQRT2;
}

export function segment(residuals, {
  penalty = PENALTY_SIGMAS * Math.max(scaleOf(residuals), 10) ** 2,
  at = null,   // index -> the time in file A that anchor sits at, for span rules
} = {}) {
  const n = residuals.length;
  if (!n) return [];
  const sum = new Float64Array(n + 1);
  const sumSquares = new Float64Array(n + 1);
  for (let i = 0; i < n; i++) {
    sum[i + 1] = sum[i] + residuals[i];
    sumSquares[i + 1] = sumSquares[i] + residuals[i] * residuals[i];
  }
  const cost = (i, j) => {
    const count = j - i;
    const total = sum[j] - sum[i];
    return sumSquares[j] - sumSquares[i] - (total * total) / count;
  };

  const best = new Float64Array(n + 1).fill(Infinity);
  const cameFrom = new Int32Array(n + 1).fill(-1);
  best[0] = 0;
  for (let j = 1; j <= n; j++) {
    for (let i = 0; i < j; i++) {
      if (!Number.isFinite(best[i])) continue;
      // Every segment after the first pays; the first one is the model itself.
      const price = best[i] + cost(i, j) + (i === 0 ? 0 : penalty);
      if (price < best[j]) { best[j] = price; cameFrom[j] = i; }
    }
  }

  const cuts = [];
  for (let j = n; j > 0; j = cameFrom[j]) cuts.push(j);
  cuts.push(0);
  cuts.reverse();
  const out = [];
  for (let k = 0; k + 1 < cuts.length; k++) {
    const from = cuts[k], to = cuts[k + 1];
    out.push({ from, to, level: median(residuals.slice(from, to)) });
  }
  return tidy(out, residuals, at);
}

/* What the squared-error DP cannot know: what a CUT is.
 *
 * A cut is somebody removing or inserting material, so it moves everything
 * after it and it keeps it moved. Two things that are not cuts still reduce
 * squared error when a break is placed at them, and the DP takes both:
 *
 *   a level change too small to see. An SRT timestamp at 25fps lands on a
 *   40ms grid, so a residual alternates between two adjacent grid values and
 *   the DP separates the runs. Sherlock's DVDRip pair came back as 105
 *   segments whose levels ran 1376, 1418, 1376, 1418 - a 42ms staircase.
 *
 *   a level change that does not last. A subtitler nudging four lines by a
 *   second is a correction inside one release, not a difference between two.
 *
 * So a break has to move the clock by something a reader would notice and
 * keep it moved for long enough to be a scene rather than an exchange. */
const MERGE_MS = 250;
const MIN_SEGMENT_MS = 30_000;
const MIN_SEGMENT_ANCHORS = 8;

function tidy(pieces, residuals, at) {
  let current = pieces;
  for (;;) {
    if (current.length < 2) return current;
    let worst = -1, worstScore = Infinity;
    for (let k = 0; k + 1 < current.length; k++) {
      const gap = Math.abs(current[k + 1].level - current[k].level);
      const short = Math.min(spanOf(current[k]), spanOf(current[k + 1]));
      const thin = Math.min(current[k].to - current[k].from, current[k + 1].to - current[k + 1].from);
      // Merge the least defensible join first, and only if it is indefensible.
      const score = gap < MERGE_MS ? gap : short < MIN_SEGMENT_MS || thin < MIN_SEGMENT_ANCHORS ? MERGE_MS + short : Infinity;
      if (score < worstScore) { worstScore = score; worst = k; }
    }
    if (worst < 0 || !Number.isFinite(worstScore)) return current;
    const merged = { from: current[worst].from, to: current[worst + 1].to };
    merged.level = median(residuals.slice(merged.from, merged.to));
    current = [...current.slice(0, worst), merged, ...current.slice(worst + 2)];
  }

  function spanOf(piece) {
    return at ? at(piece.to - 1) - at(piece.from) : Infinity;
  }
}

/* How much better a model has to fit before its extra freedom is earned.
 *
 * A rate and a set of breaks are both things a reader would have to be told
 * about, so the simplest model that fits about as well is the honest answer.
 * 150ms is under the 250ms a sync is called tight at and well under the 100ms
 * nudge step the overlay offers, so a model bought for less than this is
 * buying nothing the reader could perceive. */
const PARSIMONY_MS = 150;

/* A segmented model that needs a break every few anchors has stopped
 * describing the pair and started tracing it. Past this density the answer is
 * "no simple relationship exists", which is a different finding from "the
 * relationship is a staircase" and wants different words on screen. */
const MIN_ANCHORS_PER_SEGMENT = 25;

/** How a pair's two clocks actually relate, and how well each model fits. */
export function shapeOf(points) {
  if (!points || points.length < MIN_ANCHORS) return null;

  const fitted = (residuals, pieces) => {
    const errs = [];
    for (const piece of pieces) {
      for (let i = piece.from; i < piece.to; i++) errs.push(Math.abs(residuals[i] - piece.level));
    }
    return { p50: median(errs), p95: quantile(errs, 0.95), worst: Math.max(...errs) };
  };
  const one = (residuals) => [{ from: 0, to: residuals.length, level: median(residuals) }];

  const flatRes = points.map((p) => p.y - p.x);
  const flat = fitted(flatRes, one(flatRes));

  const rate = fitRate(points);
  const rateRes = points.map((p) => p.y - rate * p.x);
  const line = fitted(rateRes, one(rateRes));

  const pieces = segment(rateRes, { at: (i) => points[i].x });
  const steps = fitted(rateRes, pieces);

  /* The floor. Two files can only agree as closely as their subtitlers chose
   * the same in-points, and where they did not, no aligner can do better than
   * this however right its model is. Reported so a method's error can be read
   * against what was available rather than against zero. */
  const jitterMs = scaleOf(rateRes);

  const best = Math.min(flat.p50, line.p50, steps.p50);
  const overfit = pieces.length > Math.max(2, points.length / MIN_ANCHORS_PER_SEGMENT);
  const kind =
    flat.p50 <= best + PARSIMONY_MS ? "flat" :
    line.p50 <= best + PARSIMONY_MS ? "linear" :
    overfit ? "messy" : "stepped";

  const model = kind === "flat" ? { rate: 1, pieces: one(flatRes) }
    : kind === "linear" ? { rate, pieces: one(rateRes) }
    : { rate, pieces };

  return {
    kind,
    anchors: points.length,
    spanMs: points[points.length - 1].x - points[0].x,
    jitterMs: Math.round(jitterMs),
    shift: { offsetMs: Math.round(median(flatRes)), p50: Math.round(flat.p50), p95: Math.round(flat.p95) },
    line: { rate, offsetMs: Math.round(median(rateRes)), p50: Math.round(line.p50), p95: Math.round(line.p95) },
    steps: {
      count: pieces.length,
      rate,
      breaks: pieces.slice(1).map((piece) => Math.round(points[piece.from].x)),
      levels: pieces.map((piece) => Math.round(piece.level)),
      p50: Math.round(steps.p50),
      p95: Math.round(steps.p95),
    },
    /* The true mapping, as a function, so a method's answer can be scored at
     * every point of the film rather than at one. Outside the anchored range
     * it holds the nearest segment's value, which is what an aligner
     * extrapolating past its own evidence would have to do anyway. */
    at(x) {
      let level = model.pieces[0].level;
      for (const piece of model.pieces) if (points[piece.from].x <= x) level = piece.level;
      return model.rate * x + level;
    },
  };
}

/** Prepare a corpus file for anchoring: cue text reduced to its comparison key. */
export function keyed(file, cues) {
  return { id: file.id, cues: cues.map((cue) => ({ start: cue.start, key: cue.key })) };
}
