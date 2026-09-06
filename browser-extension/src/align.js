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

    /* Two ways this used to hand back an infinite confidence, and an infinite
     * confidence does not survive being written down: trace.js and report.js
     * both put the answer through JSON, where Infinity becomes null - and null
     * compared against the accept threshold is false, so an answer that had
     * just been applied read back as one that was refused.
     *
     * The chances counted and the hits counted come from different sets. `n` is
     * the smaller trimmed window, while `pairs` is not restricted to those
     * windows: below rate 1 the tolerance pairUp works to is TOL_MS/rate, which
     * is wider than the one that decided the windows, so a cue at the boundary
     * can pair without having been counted. Then k > n, the tail is -Infinity,
     * and the coverage passes 1. Constructed: 2000 cues at rate 0.959041 with
     * the first kept cue nudged 245ms gave confidence Infinity and coverage
     * 1.001. Nothing in the 6448-pair corpus reaches it.
     *
     * And a window under 125ms rounds to zero hypotheses, whose log is
     * -Infinity: align(a, b, {maxOffsetMs: 100}) answered Infinity as well. No
     * caller passes that, but the bench and the harness can. */
    const chances = Math.max(1, Math.round(maxOffsetMs / TOL_MS));
    const hypotheses = RATES.length * PEAKS * chances;
    const lnTail = lnBinomialTail(n, p0, Math.min(m, n));
    const confidence = -(lnTail + Math.log(hypotheses)) / Math.LN10;

    const residuals = pairs.map(([x, y]) => y - (rate * x + shift));
    const centre = median(residuals);
    const mad = median(residuals.map((r) => Math.abs(r - centre)));

    return {
      confidence,
      matched: m,
      coverage: Math.min(1, m / n),
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

    /* The window comes from a caller, and every way of getting it wrong failed
     * a long way from here. vote() sizes an array from it: a negative number or
     * Infinity threw a RangeError out of the middle of the search, 1e12 asked
     * for twenty billion bins and took the tab down with it, and NaN sized it
     * to NaN - which allocates nothing, matches nothing, and reports two copies
     * of the same film as different ones. Clamped to the range this file
     * searches, so a caller that gets it wrong gets an answer. */
    const window = Number.isFinite(maxOffsetMs)
      ? Math.min(Math.max(Math.round(maxOffsetMs), BIN_MS), WIDE_OFFSET_MS)
      : MAX_OFFSET_MS;

    const answer = search(a, b, window);
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
     * beats what the narrow pass found.
     *
     * "Beats" and nothing else. The test used to admit any wide answer that was
     * merely ok, which is not the same thing and cost confidence for nothing:
     * `hypotheses` scales with the window, so identical evidence scored over
     * 126 seconds instead of 15.1 loses log10(126000/15120) = 0.92 decades.
     * Measured over the corpus before this: 34 of 379 pairs took a wide answer
     * where the narrow pass had already said ok, every one of the 34 reported a
     * LOWER confidence than the narrow pass had found, and not one of them
     * changed the shift or the rate. It cannot turn an ok into a refusal - a
     * wide answer below the threshold fails both halves - but the panel ranks
     * candidate subtitles by this number, so the handicap fell on exactly the
     * candidates that were hardest to choose between. */
    const weak = !answer.ok || answer.verdict === "offer";
    if (weak && wide && window < WIDE_OFFSET_MS) {
      const wider = align(aTimes, bTimes, { maxOffsetMs: WIDE_OFFSET_MS, wide: false });
      if (wider.confidence > answer.confidence) {
        return { ...wider, searchedMs: WIDE_OFFSET_MS };
      }
    }
    return { ...answer, searchedMs: window };
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

  /* --- when one shift is the wrong SHAPE of answer ----------------------------
   *
   * `align` above returns a rate and one offset, and for about half of the
   * pairs in bench/align that is what the two files differ by. For thirty per
   * cent of them it is not. Two releases of one broadcast episode keep
   * different amounts of black around the advertising breaks, so they agree
   * over each act and jump between them - The Americans S02E09 runs 1.00,
   * 5.30, 11.85, 18.81, 24.78 and 30.57 seconds apart over its six acts,
   * measured from cue text rather than from any clock. No offset and no rate
   * exists for such a pair. Across 41 of them the single best shift puts a
   * median of 50 per cent of the film inside 250ms; per-act offsets put 90 per
   * cent there.
   *
   * This finds the acts. It is a refinement of `align` rather than a rival to
   * it: same identification, same refusal, seeded from the same rate, and it
   * returns `steps` of length one whenever there is nothing to find - which,
   * on the 91 pairs whose truth is a single shift or a single rate, is every
   * time. That control is the point. An invented break moves lines that were
   * already in the right place, which is worse than the problem.
   *
   * The whole design, and where each number came from, is in
   * docs/reports/auto-sync-2026-08-16.md; bench/align/regress.mjs is the gate
   * that says it makes no pair worse.
   */
  const STEP_WINDOW_MS = 90000;   // enough cues to answer, short enough to sit inside one act
  const STEP_HOP_MS = 45000;
  const STEP_REACH_MS = 45000;    // how far a window may sit from the window before it
  const STEP_SEARCH_MS = 40;
  const STEP_MIN_CUES = 8;
  const STEP_TOL_MS = 300;        // a cue counts as landing on one of B's
  const STEP_MIN_SHARE = 0.4;     // ... and this many of the window's must land
  const STEP_MARGIN = 1.3;        // over the best offset more than 2s away
  const STEP_MERGE_MS = 250;      // a jump smaller than this is not a jump
  const STEP_MIN_SPAN_MS = 30000; // an act is at least this long
  const STEP_WORTH = 0.02;        // a break must buy this share of the film's cues
  const STEP_WORTH_CUES = 8;      // ... and never fewer than this many
  const STEP_PENALTY_SIGMAS = 12; // how many times the noise a break must explain
  const STEP_RATE_WORTH_MS = 400; // a re-measured rate worth a second pass

  const landed = (times, at) => Math.abs(nearestOffset(times, at)) <= STEP_TOL_MS;

  /* Robust noise scale from CONSECUTIVE differences rather than deviations
   * around a middle. A step changes exactly one consecutive difference, so this
   * reads the jitter and not the staircase - which a spread around the median
   * cannot do, since to it the staircase IS the spread. */
  function scaleOf(values) {
    if (values.length < 8) return 0;
    const steps = [];
    for (let i = 1; i < values.length; i++) steps.push(Math.abs(values[i] - values[i - 1]));
    return (median(steps) * 1.4826) / Math.SQRT2;
  }

  /* Piecewise-constant fit by dynamic programming, paying for every extra
   * piece. Squared deviation rather than absolute so a prefix sum answers the
   * cost of any run in constant time. */
  function segment(values, penalty) {
    const n = values.length;
    if (!n) return [];
    const sum = new Float64Array(n + 1);
    const squares = new Float64Array(n + 1);
    for (let i = 0; i < n; i++) {
      sum[i + 1] = sum[i] + values[i];
      squares[i + 1] = squares[i] + values[i] * values[i];
    }
    const cost = (i, j) => squares[j] - squares[i] - ((sum[j] - sum[i]) ** 2) / (j - i);
    const best = new Float64Array(n + 1).fill(Infinity);
    const cameFrom = new Int32Array(n + 1).fill(-1);
    best[0] = 0;
    for (let j = 1; j <= n; j++) {
      for (let i = 0; i < j; i++) {
        if (!Number.isFinite(best[i])) continue;
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
      out.push({ from: cuts[k], to: cuts[k + 1], level: median(values.slice(cuts[k], cuts[k + 1])) });
    }
    return out;
  }

  /* What the squared-error fit cannot know: what an act break IS. It moves the
   * clock by something a reader would see, and it keeps it moved for a scene
   * rather than an exchange. Without these two rules the fit separates runs of
   * the 40ms frame grid - Sherlock's DVDRip pair came back as 105 pieces whose
   * levels ran 1376, 1418, 1376, 1418. */
  function joinTrivial(pieces, values, timeAt) {
    let current = pieces;
    while (current.length > 1) {
      let worst = -1;
      let worstScore = Infinity;
      for (let k = 0; k + 1 < current.length; k++) {
        const jump = Math.abs(current[k + 1].level - current[k].level);
        const shortest = Math.min(
          timeAt(current[k].to - 1) - timeAt(current[k].from),
          timeAt(current[k + 1].to - 1) - timeAt(current[k + 1].from),
        );
        const score = jump < STEP_MERGE_MS ? jump
          : shortest < STEP_MIN_SPAN_MS ? STEP_MERGE_MS + shortest
          : Infinity;
        if (score < worstScore) { worstScore = score; worst = k; }
      }
      if (worst < 0 || !Number.isFinite(worstScore)) return current;
      const joined = { from: current[worst].from, to: current[worst + 1].to };
      joined.level = median(values.slice(joined.from, joined.to));
      current = [...current.slice(0, worst), joined, ...current.slice(worst + 2)];
    }
    return current;
  }

  /* The offset one window of A wants, or null when it cannot tell.
   *
   * Counted rather than correlated, because a window holds a dozen cues and a
   * correlation over a dozen samples is mostly noise. Counting inside a
   * tolerance has a flat top, though - every offset within STEP_TOL_MS of the
   * right one matches the same cues - so the count picks the plateau and the
   * median of what actually landed picks the place inside it. Without that
   * second half three staircase pairs came back 282, 287 and 300ms out, in the
   * same direction on every window: the half-width, not noise. */
  function windowOffset(xs, b, mapped, around) {
    const steps = Math.floor((2 * STEP_REACH_MS) / STEP_SEARCH_MS) + 1;
    const hits = new Int32Array(steps);
    for (const want of mapped) {
      for (let s = 0; s < steps; s++) {
        if (landed(b, want + around - STEP_REACH_MS + s * STEP_SEARCH_MS)) hits[s]++;
      }
    }
    let bestAt = 0;
    for (let s = 1; s < steps; s++) if (hits[s] > hits[bestAt]) bestAt = s;
    const apart = Math.ceil(2000 / STEP_SEARCH_MS);
    let runnerUp = 0;
    for (let s = 0; s < steps; s++) {
      if (Math.abs(s - bestAt) > apart && hits[s] > runnerUp) runnerUp = hits[s];
    }
    /* Both gates. A window where nothing lands has no answer, and a window
     * where as much lands at three different offsets has three. */
    if (hits[bestAt] < Math.max(3, xs.length * STEP_MIN_SHARE)) return null;
    if (hits[bestAt] < runnerUp * STEP_MARGIN) return null;

    const coarse = around - STEP_REACH_MS + bestAt * STEP_SEARCH_MS;
    const gaps = [];
    for (const want of mapped) {
      const gap = nearestOffset(b, want + coarse);
      if (Math.abs(gap) <= STEP_TOL_MS) gaps.push(gap);
    }
    gaps.sort((p, q) => p - q);
    return { shiftMs: coarse + (gaps.length ? middle(gaps) : 0), hit: hits[bestAt] };
  }

  /** The offset a whole act wants, from every cue inside it rather than a window's. */
  function actLevel(a, b, map, from, to, start) {
    const gaps = [];
    for (const x of a) {
      if (x < from || x >= to) continue;
      const gap = nearestOffset(b, map(x) + start);
      if (Math.abs(gap) <= STEP_TOL_MS) gaps.push(gap);
    }
    if (gaps.length < 4) return start;
    gaps.sort((p, q) => p - q);
    return start + middle(gaps);
  }

  const actAt = (acts, x) => {
    let found = acts[0].level;
    for (const act of acts) if (x >= act.fromMs) found = act.level;
    return found;
  };

  function actMatches(acts, a, b, map) {
    let hit = 0;
    for (const x of a) if (landed(b, map(x) + actAt(acts, x))) hit++;
    return hit;
  }

  /* Every break earns itself against the whole film, not against the squared
   * error of the windows that suggested it. Cheapest first, recomputing after
   * each removal, because two breaks that each look worth keeping alone are
   * sometimes one break placed twice. Without this, four pairs the plain
   * aligner already put 100 per cent right came back at 59 to 65. */
  function pruneActs(acts, a, b, map) {
    let current = acts;
    while (current.length > 1) {
      const before = actMatches(current, a, b, map);
      let cheapest = -1;
      let cheapestGain = Infinity;
      for (let k = 1; k < current.length; k++) {
        const gain = before - actMatches(withoutAct(current, k), a, b, map);
        if (gain < cheapestGain) { cheapestGain = gain; cheapest = k; }
      }
      if (cheapestGain >= Math.max(STEP_WORTH_CUES, a.length * STEP_WORTH)) return current;
      current = withoutAct(current, cheapest);
    }
    return current;

    function withoutAct(list, k) {
      const joined = { fromMs: list[k - 1].fromMs, toMs: list[k].toMs, level: list[k - 1].level };
      joined.level = actLevel(a, b, map, joined.fromMs, joined.toMs, joined.level);
      return [...list.slice(0, k - 1), joined, ...list.slice(k + 1)];
    }
  }

  /* The rate, measured rather than chosen from RATES.
   *
   * Short baselines on purpose. A staircase accumulates its steps into every
   * long baseline, so a slope taken over the whole file reads the steps as a
   * slope; over one to three minutes only the few spans that straddle a step
   * are wrong, which is what a median is for. Then it is snapped back to a
   * known ratio when it is within 200ms of one at the far end of the film,
   * because a measured 1.00002 against a true 1 leaves a ramp, and a segmenter
   * handed a ramp reports a staircase. */
  function measureRate(points, spanMs) {
    const slopes = [];
    for (let i = 0, j = 0; i < points.length; i++) {
      while (j < points.length && points[j].x - points[i].x < 60000) j++;
      for (let k = j; k < points.length && points[k].x - points[i].x <= 180000; k++) {
        slopes.push((points[k].y - points[i].y) / (points[k].x - points[i].x));
      }
    }
    if (!slopes.length) return 1;
    const free = median(slopes);
    let best = free;
    let bestAway = 200;
    for (const candidate of RATES) {
      const away = Math.abs(free - candidate) * Math.max(spanMs, 1);
      if (away < bestAway) { bestAway = away; best = candidate; }
    }
    return best;
  }

  /**
   * Where each act of A lands in B, when one offset will not do.
   *
   * Returns `{ ...align(), steps: [{ fromMs, offsetMs }], settled }`, where
   * `fromMs` is a time in A and `offsetMs` the shift that act wants. One entry
   * means one shift was the right answer after all. `steps` is null when the
   * pair was refused, exactly as `align` refused it.
   */
  function alignSteps(aTimes, bTimes, options = {}) {
    const answer = align(aTimes, bTimes, options);
    if (!answer.ok) return { ...answer, steps: null, settled: 0 };
    const a = (aTimes || []).filter(Number.isFinite).sort((x, y) => x - y);
    const b = (bTimes || []).filter(Number.isFinite).sort((x, y) => x - y);
    const spanMs = a[a.length - 1] - a[0];

    const pass = (rate, shiftMs) => {
      const map = (x) => rate * x + shiftMs;
      const centres = [];
      const offsets = [];
      for (let from = a[0]; from < a[a.length - 1]; from += STEP_HOP_MS) {
        const xs = a.filter((x) => x >= from && x < from + STEP_WINDOW_MS);
        if (xs.length < STEP_MIN_CUES) continue;
        /* Each window searches from where the one before it landed, so a
         * staircase is walked up a step at a time instead of being asked to
         * jump its whole height from the global answer at once. */
        const found = windowOffset(xs, b, xs.map(map), offsets.length ? offsets[offsets.length - 1] : 0);
        if (!found) continue;
        centres.push(xs[xs.length >> 1]);
        offsets.push(found.shiftMs);
      }
      if (centres.length < 3) return null;

      const pieces = joinTrivial(
        segment(offsets, STEP_PENALTY_SIGMAS * Math.max(scaleOf(offsets), 100) ** 2),
        offsets,
        (i) => centres[i],
      );

      /* Windows hop 45 seconds, so the fit can only place a break to the
       * nearest one - and the window straddling a break answers with a blend
       * of both acts, which drags it early. Measured: a true break at 5:41
       * placed at 5:15. The cues between the neighbouring windows say where it
       * really is. */
      const bounds = pieces.map((piece, k) => ({
        fromMs: k === 0 ? -Infinity : centres[piece.from],
        toMs: k + 1 < pieces.length ? centres[pieces[k + 1].from] : Infinity,
        level: piece.level,
      }));
      for (let k = 1; k < bounds.length; k++) {
        const candidates = a.filter((x) => x >= centres[pieces[k].from] - STEP_HOP_MS * 2
          && x <= centres[pieces[k].from] + STEP_HOP_MS);
        if (candidates.length < 2) continue;
        let bestAt = bounds[k].fromMs;
        let bestScore = -1;
        for (const boundary of candidates) {
          let score = 0;
          for (const x of candidates) {
            if (landed(b, map(x) + (x < boundary ? bounds[k - 1].level : bounds[k].level))) score++;
          }
          if (score > bestScore) { bestScore = score; bestAt = boundary; }
        }
        bounds[k].fromMs = bestAt;
        bounds[k - 1].toMs = bestAt;
      }

      for (const bound of bounds) bound.level = actLevel(a, b, map, bound.fromMs, bound.toMs, bound.level);
      const acts = pruneActs(bounds, a, b, map);
      let settled = 0;
      for (const piece of pieces) {
        for (let i = piece.from; i < piece.to; i++) if (Math.abs(offsets[i] - piece.level) <= 250) settled++;
      }
      return { acts, map, rate, shiftMs, settled: settled / centres.length, windows: centres.length };
    };

    let found = pass(answer.rate, answer.shiftMs);
    if (!found) return { ...answer, steps: [{ fromMs: 0, offsetMs: 0 }], settled: 0 };

    /* RATES covers how two releases usually differ and not the whole of it.
     * The Americans S02E09's Turkish pair differs by 1.00425, which is nobody's
     * framerate ratio; the nearest hypothesis leaves 9 seconds across the
     * episode, and the first pass answered that by inventing 13 acts for an
     * episode with six. Once the acts are known the rate is visible in the
     * cues inside them. */
    const anchored = [];
    for (const x of a) {
      const want = found.map(x) + actAt(found.acts, x);
      const gap = nearestOffset(b, want);
      if (Math.abs(gap) <= STEP_TOL_MS) anchored.push({ x, y: want + gap });
    }
    if (anchored.length >= 40) {
      const measured = measureRate(anchored, spanMs);
      if (Math.abs(measured - answer.rate) * spanMs > STEP_RATE_WORTH_MS) {
        const better = pass(measured, answer.shiftMs);
        if (better && better.acts.length <= found.acts.length) found = better;
      }
    }

    /* Reported against the pair's own base offset, so `steps[0].offsetMs` is
     * always 0 and every other entry is how much further that act has moved.
     * A reader correcting the whole subtitle by hand then moves the base and
     * the staircase travels with it. */
    const base = found.acts[0].level;
    return {
      ...answer,
      rate: found.rate,
      shiftMs: Math.round(found.shiftMs + base),
      steps: found.acts.map((act, k) => ({
        fromMs: k === 0 ? 0 : Math.round(act.fromMs),
        offsetMs: Math.round(act.level - base),
      })),
      settled: Number(found.settled.toFixed(3)),
      windows: found.windows,
    };
  }

  /* --- snapping a correction to where the two files agree ---------------------
   *
   * A reader dragging the map is aiming at a position, and a hand on a 180px
   * strip showing a minute of film is accurate to about a fifth of a second at
   * best. The right answer is almost always a few tens of milliseconds from
   * where they let go, and it is a value that can be looked up rather than
   * guessed: it is the shift at which the most lines of this subtitle land on a
   * line of the other one.
   *
   * LOCAL, and that is the whole design. The measurement in
   * docs/reports/sync-the-americans-2026-08-16.md is that two releases of one
   * episode can differ by a staircase - six plateaus and five jumps totalling
   * 30.55 seconds - so there is often no single shift that is right for the
   * film, and a snap that consulted the whole file would drag a correction made
   * in the third act towards the answer for the first. Two minutes around the
   * playhead is a stretch the reader can hear, and a stretch inside which the
   * relationship is a constant even when it is not one across the film.
   *
   * It may only move a correction a little. Past half a second the reader was
   * not aiming at this peak, and moving them there would be taking the wheel
   * rather than steadying it. It also has to WIN, not tie: a delta that lines
   * up the same number of lines as the reader's own aim is not an improvement,
   * it is a different way of saying the same thing.
   */
  const SNAP_RADIUS_MS = 500;
  const SNAP_SPAN_MS = 120000;
  const SNAP_MIN_LINES = 4;
  /* How much the lines that pair are allowed to disagree with each other.
   *
   * This is the whole test, and it is a test of AGREEMENT rather than of count.
   * Counting is what a first version did - "which shift lines up the most
   * lines, within 250ms" - and it cannot see anything smaller than its own
   * tolerance: at a 140ms error every line already counts as matched, so no
   * shift can beat doing nothing, and the errors a hand actually makes are all
   * inside that blind spot.
   *
   * Counting also cannot be the test for these files. Measured on The
   * Americans, English against Turkish: a quarter of the lines pair at all,
   * because 12% of the English file is sound description the Turkish does not
   * carry and a quarter of what remains is two English lines merged into one
   * Turkish. A rule needing half the window to pair would never fire on a real
   * cross-language pair. What IS true of a real pair is that the lines which do
   * pair agree with each other about the size of the error; a wrong shift pairs
   * lines by accident, and accidents disagree. */
  const SNAP_MAX_SPREAD_MS = 150;
  // Below this there is nothing worth doing, and moving anyway would make the
  // reader's own aim look wrong.
  const SNAP_MIN_MOVE_MS = 15;

  /** Signed distance from `at` to the nearest value in the sorted `times`. */
  function nearestOffset(times, at) {
    let low = 0;
    let high = times.length - 1;
    let best = Infinity;
    while (low <= high) {
      const mid = (low + high) >> 1;
      const gap = times[mid] - at;
      if (Math.abs(gap) < Math.abs(best)) best = gap;
      if (gap === 0) return 0;
      if (gap < 0) low = mid + 1;
      else high = mid - 1;
    }
    return best;
  }

  const middle = (sorted) => sorted[sorted.length >> 1];

  /**
   * The small correction the two subtitles agree on near `atMs`, or null.
   *
   * Both arrays are in the same clock - the video's - so the answer is a number
   * of milliseconds to add to the first subtitle's offset. The median rather
   * than a search: it is the robust estimator for exactly this shape, half the
   * points may be nonsense without moving it, and it answers to the
   * millisecond instead of to a step size.
   */
  function snapNear(aTimes, bTimes, {
    atMs,
    radiusMs = SNAP_RADIUS_MS,
    spanMs = SNAP_SPAN_MS,
  } = {}) {
    if (!Number.isFinite(atMs)) return null;
    const from = atMs - spanMs / 2;
    const to = atMs + spanMs / 2;

    const a = (aTimes || []).filter((t) => Number.isFinite(t) && t >= from && t <= to);
    const b = (bTimes || [])
      .filter((t) => Number.isFinite(t) && t >= from - radiusMs && t <= to + radiusMs)
      .sort((x, y) => x - y);
    if (a.length < SNAP_MIN_LINES || b.length < SNAP_MIN_LINES) return null;

    const paired = [];
    for (const t of a) {
      const gap = nearestOffset(b, t);
      if (Math.abs(gap) <= radiusMs) paired.push(gap);
    }
    if (paired.length < SNAP_MIN_LINES) return null;

    paired.sort((x, y) => x - y);
    const shift = middle(paired);
    const spread = middle(paired.map((gap) => Math.abs(gap - shift)).sort((x, y) => x - y));
    if (spread > SNAP_MAX_SPREAD_MS) return null;

    const deltaMs = Math.round(shift);
    if (Math.abs(deltaMs) < SNAP_MIN_MOVE_MS) return null;
    return { deltaMs, lines: paired.length, spreadMs: Math.round(spread) };
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
  const API = {
    align, alignSteps, proposeAnchors, snapNear,
    RATES, ACCEPT, AUTO, MAX_OFFSET_MS, RATE_MIN_SPAN_MS, SNAP_RADIUS_MS,
  };

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
