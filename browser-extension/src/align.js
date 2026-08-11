/* Working out how far apart two subtitles are, and refusing to guess.
 *
 * The problem this exists for: a subtitle downloaded for one release of a film
 * is timed against that release, and the file you are watching is a different
 * one. The text is right and the clock is wrong, by anything from half a second
 * to a minute and a half, and fixing it by hand means holding a button while
 * watching a line you have already read.
 *
 * Two files describing the same film describe the same speech. They do not
 * describe it identically - one language merges what the other splits, a
 * hearing-impaired track adds cues the other has never heard of, and the same
 * line is cued a tenth of a second apart by two different subtitlers. But the
 * *shape* is the same, and the offset between them is the number that appears
 * over and over in the differences between their cue times.
 *
 * So: histogram every pairwise difference, take the peak, and then decide
 * whether the peak means anything. That last part is the whole design. An
 * aligner that always returns a number is worse than none, because the number
 * it returns for two unrelated films is confident and wrong, and a subtitle
 * silently shifted twelve seconds is harder to diagnose than one that was
 * never touched.
 *
 * ---
 *
 * Pure arithmetic. No DOM, no chrome.*, no I/O - which is what lets the same
 * file run in the extension, in the test harness, and under node.
 */

(() => {
  "use strict";

  /* How far apart two subtitles for the same film can honestly be.
   *
   * Real offsets come from distributor idents, different pre-title sequences
   * and recaps, and top out somewhere near a minute and a half. Three minutes
   * is generous headroom. The bound is not free: every second of range is more
   * places a wrong pair can find a coincidental peak, so widening it costs
   * confidence directly. */
  const MAX_OFFSET_MS = 180000;

  /* A second, wider look, for when the first one finds nothing.
   *
   * Three minutes covers a distributor ident and a different pre-title
   * sequence, which is what most release gaps are. It does not cover a subtitle
   * timed for a broadcast cut that carries a "previously on" recap the other
   * file has never heard of, and it does not cover a file whose clock simply
   * starts somewhere else. Measured on this repo's own EN/TR pair, which scores
   * 476 in agreement: shifted 175s it still scores 476 and recovers the shift
   * exactly; shifted 185s it collapses to 4.33 with the shift 5s wrong; shifted
   * 240s it reads 0.53 and returns a number that is nonsense. So beyond the
   * window the answer is not "less sure", it is "not looking" - and the reader
   * was told the two files were different films.
   *
   * This is only tried when the narrow pass has already failed, so nothing that
   * works today changes. It is not a free widening either: the hypothesis count
   * in score() is proportional to the window, so a match found out here has to
   * clear a bar an eighth of a decade higher to report the same confidence. It
   * pays for its own search. */
  const WIDE_OFFSET_MS = 1500000; // 25 minutes

  /* Bin width for the vote. With the three-bin smoothing below this is an
   * effective window of 300ms, which covers the spread between two subtitlers
   * cueing the same line without smearing the peak into its neighbours. */
  const BIN_MS = 100;

  /* How close a cue has to land to count as the same speech event. Two
   * measurements of genuine cross-language pairs put the typical disagreement
   * near 100ms, so this is about twice that. Loosening it helps a wrong pair
   * more than a right one: every extra millisecond raises the chance that an
   * unrelated cue falls within tolerance of *something*. */
  const TOL_MS = 250;
  const COARSE_TOL_MS = 400;

  /* Peaks to try. In a true pair the answer is the tallest bin; the runners-up
   * are for films with periodic structure - song lyrics, countdowns, a scene of
   * someone reading numbers aloud - where the tallest can be a harmonic. */
  const PEAKS = 3;
  const PEAK_GUARD_MS = 3000;

  /* Nothing below this is worth an opinion. Twelve cues is a title sequence. */
  const MIN_CUES = 12;
  const MIN_PAIRS = 8;

  /* The framerate ratios, as a closed set.
   *
   * A rate is selected, never fitted. A free fit needs a constant-offset peak
   * to seed it, and a 4% rate error destroys exactly that peak - the whole
   * point of the search is to find the alignment that a rate error is hiding.
   * So each candidate is tried in full and the best one wins.
   *
   * These are the ratios that actually occur: PAL against an NTSC-film encode
   * and back, PAL speed-up and back, and the 24-vs-23.976 pair, which is only
   * a tenth of a percent but is five seconds by the end of a feature. */
  const F23976 = 24000 / 1001;
  const RATES = [
    1,
    25 / F23976, // 1.042708 - the common one
    F23976 / 25, // 0.959041
    25 / 24, //     1.041667
    24 / 25, //     0.960000
    24 / F23976, //  1.001000
    F23976 / 24, //  0.999001
  ];

  /* A non-unity rate has to be this many decades better than assuming no
   * stretch at all, and needs this much of the film to have been compared -
   * a rate measured over eight minutes extrapolates to nonsense by the end. */
  const RATE_MARGIN = 1.0;
  const RATE_MIN_SPAN_MS = 1200000;

  /* Three verdicts, not two, and the corpus is why.
   *
   * Measured over every pair of the seventeen subtitle files in this repository
   * - four films, one series, two languages, and several retimings - the
   * confidences come out like this:
   *
   *   963, 802, 476, 327  same film, same or near-identical timing
   *    95,  36,  33       same episode, different retimings
   *   7.05, 6.34, 3.97, 3.55   same episode across languages, weak agreement
   *   3.11                     Good Fortune against Crime 101 - WRONG
   *   2.34 and below           every other unrelated pair
   *
   * So there is no threshold that both accepts every true pair and rejects
   * every false one with room to spare: the worst true pair is 3.55 and the
   * worst false one is 3.11. A single cutoff between them would be four
   * hundredths of a decade from being wrong in either direction, on a corpus of
   * seventeen files.
   *
   * The way out is to stop pretending it is one decision. Above AUTO the answer
   * is not in doubt and applying it silently is what "it should just work"
   * means. Between ACCEPT and AUTO it is probably right and worth one click to
   * confirm. Below ACCEPT it is refused. That leaves the razor-thin boundary
   * deciding between "refuse" and "ask", which is the cheapest of the three
   * places to be wrong.
   *
   * What does NOT work, measured, so nobody adds it back: checking that the
   * offset holds across the first, middle and last third of the film. The false
   * accept's thirds agree to within 46ms while genuine cross-language pairs
   * scatter by 70 to 95ms - the gate is real but points the wrong way, because
   * two languages disagree about cue timing more in some scenes than others. */
  const ACCEPT = 3.5;
  const AUTO = 8;
  const OVERWHELMING = 60;

  /* Confidence is not enough to act without asking. How much of the two files
   * actually paired has to be above chance as well.
   *
   * The binomial score answers "how surprised should I be that this many cues
   * line up", and on a thousand-cue file a thin excess over chance spread
   * across the whole film can clear AUTO on sheer n. Coverage is the direct
   * measure of that excess: matched, over the cues there were to match.
   *
   * Measured over this repository's corpus, and the two groups do not overlap:
   *
   *   0.322 0.328 0.408 0.662 0.730 1.000 1.000   every genuine "apply"
   *   0.206 0.216 0.217 0.218                     every wrong shift applied
   *
   * The second row is the case reported from The Americans, where the English
   * subtitle is silent through the Russian scenes - the show burns those in -
   * while the Turkish keeps translating them. Blanking those scenes out of the
   * English file costs the true peak its votes, a competing peak 3.4 SECONDS
   * away wins, and it came back verdict "apply" at confidence 8.33 to 9.87.
   * A subtitle silently moved three and a half seconds is the failure this
   * whole file exists to prevent.
   *
   * The second row is not a coincidence: p0 for these densities is about 0.17,
   * so 0.21 IS the chance pairing rate. A shift that pairs no better than
   * chance must not be applied on its own, whatever the arithmetic says about
   * how many cues that is.
   *
   * 0.28 sits between the two, with headroom on both sides. The guard is
   * deliberately one-directional: it can only ever turn "apply" into "offer",
   * never "no" into "yes", so the boundary this file is really about - the
   * 3.11 wrong pair against the 3.55 right one - is untouched by it. */
  const AUTO_MIN_COVERAGE = 0.28;

  // --- the maths ---------------------------------------------------------------

  /* log of n choose k, via lgamma. Binomial tails at n in the thousands
   * overflow a naive factorial long before they stop being interesting. */
  function lnGamma(x) {
    // Lanczos, g=7, n=9. Accurate to about 15 digits over the range used here.
    const c = [
      0.99999999999980993, 676.5203681218851, -1259.1392167224028,
      771.32342877765313, -176.61502916214059, 12.507343278686905,
      -0.13857109526572012, 9.9843695780195716e-6, 1.5056327351493116e-7,
    ];
    if (x < 0.5) return Math.log(Math.PI / Math.sin(Math.PI * x)) - lnGamma(1 - x);
    x -= 1;
    let a = c[0];
    const t = x + 7.5;
    for (let i = 1; i < 9; i++) a += c[i] / (x + i);
    return 0.5 * Math.log(2 * Math.PI) + (x + 0.5) * Math.log(t) - t + Math.log(a);
  }

  const lnChoose = (n, k) => lnGamma(n + 1) - lnGamma(k + 1) - lnGamma(n - k + 1);

  /* P(Binomial(n, p) >= k), in logs.
   *
   * This is the question "if these two files had nothing to do with each other,
   * how surprised should I be that this many cues line up?" - and it is the
   * only thing standing between a reader and a silently mis-shifted subtitle. */
  function lnBinomialTail(n, p, k) {
    if (k <= 0) return 0;
    if (k > n) return -Infinity;
    if (p <= 0) return -Infinity;
    if (p >= 1) return 0;
    let sum = -Infinity;
    const lnP = Math.log(p);
    const ln1P = Math.log1p(-p);
    for (let i = k; i <= n; i++) {
      const term = lnChoose(n, i) + i * lnP + (n - i) * ln1P;
      // log-sum-exp, so the tail does not underflow to zero and read as
      // certainty when it is merely small.
      sum = sum === -Infinity ? term : Math.max(sum, term) +
        Math.log1p(Math.exp(-Math.abs(sum - term)));
      if (term < sum - 40) break; // the rest cannot move it
    }
    return sum;
  }

  function median(values) {
    if (!values.length) return 0;
    const sorted = [...values].sort((a, b) => a - b);
    const middle = sorted.length >> 1;
    return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
  }

  // --- the passes --------------------------------------------------------------

  /* Everything that is only a title card or a credit roll.
   *
   * The first and last few per cent of a subtitle are where releases disagree
   * most - one has the distributor ident, another starts at the studio logo,
   * a third carries translated credits the other does not. They are noise
   * against the question being asked. */
  function trim(times) {
    if (times.length < 40) return times;
    const cut = Math.floor(times.length * 0.05);
    return times.slice(cut, times.length - cut);
  }

  /** Vote on the offset between A and B under one rate hypothesis. */
  function vote(a, b, rate, maxOffsetMs) {
    const bins = Math.round((2 * maxOffsetMs) / BIN_MS) + 1;
    const centre = bins >> 1;
    const counts = new Int32Array(bins);

    /* Two pointers rather than a nested scan: for each cue in A only the window
     * of B within the search range can contribute, and both lists are sorted,
     * so the window only ever moves forward. */
    let lo = 0;
    let hi = 0;
    for (let i = 0; i < a.length; i++) {
      const at = rate * a[i];
      while (lo < b.length && b[lo] < at - maxOffsetMs) lo++;
      if (hi < lo) hi = lo;
      while (hi < b.length && b[hi] <= at + maxOffsetMs) hi++;
      for (let j = lo; j < hi; j++) {
        const index = Math.round((b[j] - at) / BIN_MS) + centre;
        if (index >= 0 && index < bins) counts[index]++;
      }
    }

    // A true offset scatters across neighbouring bins, because subtitlers round
    // differently; smoothing gathers it back into one number.
    const smooth = new Int32Array(bins);
    for (let i = 0; i < bins; i++) {
      smooth[i] = (counts[i - 1] || 0) + counts[i] + (counts[i + 1] || 0);
    }

    const guard = Math.round(PEAK_GUARD_MS / BIN_MS);
    const peaks = [];
    const taken = new Set();
    for (let n = 0; n < PEAKS; n++) {
      let best = -1;
      let bestAt = -1;
      for (let i = 0; i < bins; i++) {
        if (smooth[i] <= best) continue;
        let near = false;
        for (const at of taken) {
          if (Math.abs(i - at) <= guard) { near = true; break; }
        }
        if (near) continue;
        best = smooth[i];
        bestAt = i;
      }
      if (bestAt < 0 || best <= 0) break;
      taken.add(bestAt);
      peaks.push((bestAt - centre) * BIN_MS);
    }
    return peaks;
  }

  /* Match each cue in A to at most one cue in B.
   *
   * Injective on purpose. Without it a hearing-impaired track, which cues the
   * same moment several times over, matches the same cue in the other file
   * repeatedly and reports more agreement than there are cues to agree - which
   * inflates confidence for exactly the files most likely to be over-segmented.
   */
  function pairUp(a, b, rate, shift, tol) {
    const pairs = [];
    let j = 0;
    for (let i = 0; i < a.length; i++) {
      const want = rate * a[i] + shift;
      while (j < b.length && b[j] < want - tol) j++;
      let best = -1;
      let bestGap = Infinity;
      for (let k = j; k < b.length && b[k] <= want + tol; k++) {
        const gap = Math.abs(b[k] - want);
        if (gap < bestGap) { bestGap = gap; best = k; }
      }
      if (best >= 0) {
        pairs.push([a[i], b[best]]);
        j = best + 1; // that cue in B is spoken for
      }
    }
    return pairs;
  }

  /* How surprising the agreement is, if the two files were unrelated.
   *
   * Returned as minus the base-ten log of the probability, corrected for how
   * many hypotheses were tried - because trying seven rates and three peaks
   * over a three-minute window is a lot of chances to be impressed by nothing.
   */
  function score(a, b, rate, shift, pairs, maxOffsetMs) {
    const inA = a.filter((t) => {
      const at = rate * t + shift;
      return at >= b[0] - TOL_MS && at <= b[b.length - 1] + TOL_MS;
    });
    const inB = b.filter((t) => {
      const at = (t - shift) / rate;
      return at >= a[0] - TOL_MS && at <= a[a.length - 1] + TOL_MS;
    });
    if (inA.length < MIN_CUES || inB.length < MIN_CUES) return null;

    const denser = inA.length >= inB.length ? inA : inB;
    const span = denser[denser.length - 1] - denser[0];
    if (span <= 0) return null;
    const lambda = denser.length / span; // cues per millisecond
    // The chance one cue lands within tolerance of any cue at all.
    const p0 = Math.min(0.95, 2 * TOL_MS * lambda);
    const n = Math.min(inA.length, inB.length);
    const m = pairs.length;
    if (m < MIN_PAIRS) return null;

    const hypotheses = RATES.length * PEAKS * Math.round(maxOffsetMs / TOL_MS);
    const lnTail = lnBinomialTail(n, p0, m);
    const confidence = -(lnTail + Math.log(hypotheses)) / Math.LN10;

    const residuals = pairs.map(([x, y]) => y - (rate * x + shift));
    const centre = median(residuals);
    const mad = median(residuals.map((r) => Math.abs(r - centre)));

    return {
      confidence,
      matched: m,
      coverage: m / n,
      madMs: Math.round(mad),
      overlapMs: Math.round(span),
    };
  }

  /** One rate hypothesis, all the way through. */
  function tryRate(a, b, rate, maxOffsetMs) {
    let best = null;
    for (const seed of vote(a, b, rate, maxOffsetMs)) {
      let shift = seed;
      // Two polishing passes: wide first so a slightly-off seed still gathers
      // its pairs, then tight so the answer is not dragged by the stragglers.
      for (const tol of [COARSE_TOL_MS, TOL_MS]) {
        const pairs = pairUp(a, b, rate, shift, tol);
        if (!pairs.length) break;
        // Median, never mean: a handful of pairs from a mistimed opening
        // sequence moves a mean by seconds and a median not at all.
        shift += median(pairs.map(([x, y]) => y - (rate * x + shift)));
      }
      const pairs = pairUp(a, b, rate, shift, TOL_MS);
      const scored = score(a, b, rate, shift, pairs, maxOffsetMs);
      if (!scored) continue;
      if (!best || scored.confidence > best.confidence) {
        best = { rate, shiftMs: Math.round(shift), ...scored };
      }
    }
    return best;
  }

  /**
   * Work out how to map times in A onto times in B.
   *
   * Returns `{ ok, rate, shiftMs, confidence, ... }`. When `ok` is false the
   * `reason` says which way it failed, because "these are different cuts of the
   * same film" and "this is the wrong film" want different words on screen.
   */
  function align(aTimes, bTimes, { maxOffsetMs = MAX_OFFSET_MS, wide = true } = {}) {
    const a = trim((aTimes || []).filter(Number.isFinite).sort((x, y) => x - y));
    const b = trim((bTimes || []).filter(Number.isFinite).sort((x, y) => x - y));
    if (a.length < MIN_CUES || b.length < MIN_CUES) {
      return { ok: false, reason: "too-few-cues", confidence: -Infinity };
    }

    const answer = search(a, b, maxOffsetMs);
    /* Nothing inside three minutes. Look again over twenty-five before saying
     * these are different films, because "no gap this small fits" and "these
     * are not the same programme" are different answers and only one of them
     * was ever given. Costs a second pass on the searches that were going to
     * fail anyway, and none on the ones that succeed. */
    /* Also when the narrow answer is only an offer, because just outside the
     * window is where the narrow pass produces its worst answers rather than
     * its least confident ones. Measured: the same pair shifted 185s - five
     * seconds past the edge - comes back ok, verdict "offer", confidence 4.33,
     * and a shift 5.18 SECONDS wrong. One click from being applied. The wide
     * pass scores 475 on it with the shift exact, and is only taken when it
     * beats what the narrow pass found. */
    const weak = !answer.ok || answer.verdict === "offer";
    if (weak && wide && maxOffsetMs < WIDE_OFFSET_MS) {
      const wider = align(aTimes, bTimes, { maxOffsetMs: WIDE_OFFSET_MS, wide: false });
      if (wider.ok || wider.confidence > answer.confidence) {
        return { ...wider, searchedMs: WIDE_OFFSET_MS };
      }
    }
    return { ...answer, searchedMs: maxOffsetMs };
  }

  /** One complete search at a given window. */
  function search(a, b, maxOffsetMs) {
    const unity = tryRate(a, b, 1, maxOffsetMs);
    let best = unity;

    /* Only bother with the rest if no-stretch is not already overwhelming. A
     * film that lines up at rate 1 with a thousand agreeing cues is not going
     * to be explained better by a 4% stretch. */
    if (!unity || unity.confidence < OVERWHELMING) {
      for (const rate of RATES) {
        if (rate === 1) continue;
        const tried = tryRate(a, b, rate, maxOffsetMs);
        if (!tried) continue;
        if (!best || tried.confidence > best.confidence) best = tried;
      }
    }
    if (!best) return { ok: false, reason: "no-match", confidence: -Infinity };

    /* A stretch has to earn itself. It must beat "no stretch" by a clear margin
     * and have been measured over enough of the film to extrapolate from -
     * otherwise the honest answer is the simpler one. */
    if (best.rate !== 1) {
      const enough = best.overlapMs >= RATE_MIN_SPAN_MS;
      const better = !unity || best.confidence >= unity.confidence + RATE_MARGIN;
      if (!enough || !better) best = unity || best;
    }

    const ok = Boolean(best) && best.confidence >= ACCEPT;
    /* Both gates, not either. See AUTO_MIN_COVERAGE for the measurement: a
     * pairing rate at chance can still clear AUTO on a long file, and when it
     * does the shift it carries is the wrong one. */
    const sure = ok && best.confidence >= AUTO && best.coverage >= AUTO_MIN_COVERAGE;
    return {
      ok,
      // How much this is worth acting on by itself. See ACCEPT and AUTO.
      verdict: !ok ? "no" : sure ? "apply" : "offer",
      /* Why it is only an offer, for the surface that has to say so. "thin"
       * means the two files agree about too few of their lines to move one
       * without being asked - which is what two subtitlers cutting the same
       * speech into different lines looks like from in here, and is a
       * different sentence from "not confident". */
      reason: ok ? (sure ? "matched" : best.confidence >= AUTO ? "thin" : "matched") : "low-confidence",
      rate: best.rate,
      shiftMs: best.shiftMs,
      confidence: Number(best.confidence.toFixed(2)),
      matched: best.matched,
      coverage: Number(best.coverage.toFixed(3)),
      madMs: best.madMs,
      overlapMs: best.overlapMs,
    };
  }

  /**
   * Which line is being spoken right now, ranked.
   *
   * For the case no amount of arithmetic covers: one subtitle, no reference,
   * and it is out by more than the reader can eyeball. They press a key on a
   * line they can hear and pick it from what comes back.
   *
   * The naive version of this - "shift so the cue on screen starts now" - can
   * only ever move a subtitle later, because the cue on screen is by definition
   * the one whose window contains the current time. Useless for the half of
   * cases where the subtitle is late. So the anchor is the *nearest* cue start,
   * and the reader confirms which by reading the line.
   */
  function proposeAnchors(atMs, cues, { windowMs = 30000, reactionMs = 300, limit = 8 } = {}) {
    const heardAt = atMs - reactionMs;
    return (cues || [])
      .map((cue, index) => ({
        index,
        startMs: cue.start,
        text: cue.text,
        offsetMs: Math.round(heardAt - cue.start),
      }))
      .filter((item) => Math.abs(item.offsetMs) <= windowMs)
      .sort((x, y) => Math.abs(x.offsetMs) - Math.abs(y.offsetMs))
      .slice(0, limit);
  }

  /* RATE_MIN_SPAN_MS is out here because the overlay measures a rate too, from
   * the reader's own corrections rather than from a second subtitle, and "a
   * rate measured over eight minutes extrapolates to nonsense by the end" is
   * true of both. One number, one reason, one place to change it. */
  const API = { align, proposeAnchors, RATES, ACCEPT, AUTO, MAX_OFFSET_MS, RATE_MIN_SPAN_MS };

  /* globalThis rather than `window` plus a CommonJS export.
   *
   * In the extension's isolated world globalThis is window, so this is the same
   * assignment. Under node it is the only one that works: this file has no
   * top-level require or module reference, so node's syntax detection treats it
   * as an ES module, `module` is undefined and a `module.exports = ...` guarded
   * by typeof silently does nothing - which presents as an empty object from
   * require() and nothing to test. */
  globalThis.__ssoAlign = API;
})();
