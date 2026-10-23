/* Lining the leading subtitle up with the film by listening to it.
 *
 * The aligner puts a subtitle where another subtitle says it belongs, and the
 * lead has nothing above it: the only thing that knows where the film's
 * dialogue is, is the film. Read out of the running log over 241 alignments,
 * 419 of the 629 corrections that followed one were made by hand on the lead,
 * by a reader who heard a line before they read it. This hears it instead.
 *
 * What it hears is not words. Every tick it takes the energy in the speech
 * band (300-3400Hz) of the middle of the stereo mix and of its sides, and calls
 * a moment speech when the band stands above a running floor, is centred (a
 * voice is mixed to the middle; music and effects spread), and moves the way
 * syllables move. Then it asks where the subtitle's lines have to sit for the
 * most of them to fall on speech.
 *
 * Measured offline with bench/listen/ on ten films whose subtitle is timed to
 * their own picture, listened to from every fifth minute for twenty minutes:
 * displaced by -21.35s, +4s and +37.2s, 405 of 477 listenings applied a shift
 * within 300ms of the truth, 10 within 500ms, none further out, and 62 never
 * applied - 32 of those on Flow, a film without dialogue. Half had applied by
 * the fourth minute, nine in ten by the tenth. Of 159 listenings to a file
 * already right, one moved it - by 500ms, on Truman, and back eight minutes
 * later.
 *
 * Two things about the answer are load-bearing:
 *
 * - It is applied only when independent stretches agree. One stretch of film
 *   is wrong often enough to matter - a song, a scene in the rain - and its
 *   margin over the next best shift was measured and does not separate the
 *   right answers from the wrong ones. Two consecutive two-minute blocks that
 *   each agree, to 200ms, with the answer over the last eight minutes rarely
 *   do so by chance.
 * - The lines are first placed with their tails cut off. A subtitle stays up
 *   after its speech has ended, by anything from nothing to a second, and over
 *   a whole line that pulls the answer off. Placed by its first part, then
 *   refined within 600ms by the whole line, 722 of 914 two-minute blocks land
 *   within a second; by the whole line alone, 635.
 *
 * Pure arithmetic except openEar, which is the only part that touches the
 * page, so the rest runs under node against a film's own audio. */

(() => {
  "use strict";

  const HOP_MS = 50;
  /* A block is two minutes of HEARD film, not of wall time: a paused film and a
   * film being scrubbed through hear nothing. */
  const BLOCK_FRAMES = 120000 / HOP_MS;
  const RECENT_BLOCKS = 4;
  const AGREE_MS = 200;
  const SEARCH_MS = 60000;
  /* Below this a shift is not applied. A file timed to its own picture comes
   * back as up to 350ms off on some films (its subtitler's convention, not an
   * error), and moving it there would be the extension making a right file
   * slightly wrong. */
  const APPLY_MIN_MS = 400;
  /* After the reader has corrected the lead by hand, their ear is the truth
   * for anything finer than this. What is left for listening is a jump - an
   * insert, a cut, an advert the clock did not see. */
  const AFTER_HAND_MIN_MS = 2000;
  const MIN_LINES = 8;

  const FLOOR_FRAMES = 30000 / HOP_MS;
  const FLOOR_EVERY = 60;
  const FLOOR_QUANTILE = 0.15;
  const ABOVE_FLOOR_DB = 9;
  const CENTRE_DB = 4;
  const MODULATION_DB = 2;

  /**
   * The shift that puts a subtitle's lines on the film's speech.
   *
   * `speech` is one value per `hopMs` frame from `originMs` on (1 speech, 0
   * not, -1 not heard); `spans` are [start, end] in the same clock. Returns the
   * shift to ADD to the spans, with its z against every shift searched, or null
   * when too little was heard to say.
   */
  function bestShift(speech, spans, { hopMs = HOP_MS, originMs = 0, searchMs = SEARCH_MS } = {}) {
    const n = speech.length;
    let heard = 0, said = 0;
    for (const v of speech) if (v >= 0) { heard++; said += v; }
    if (heard < 200) return null;
    const mean = said / heard;
    const prefix = new Float64Array(n + 1);
    for (let i = 0; i < n; i++) prefix[i + 1] = prefix[i] + (speech[i] < 0 ? 0 : speech[i] - mean);
    const at = (ms) => prefix[Math.min(n, Math.max(0, Math.round((ms - originMs) / hopMs)))];
    const steps = Math.round(searchMs / hopMs);
    const scores = new Float64Array(2 * steps + 1);
    for (let s = -steps; s <= steps; s++) {
      const d = s * hopMs;
      let score = 0;
      for (const [a, b] of spans) score += at(b + d) - at(a + d);
      scores[s + steps] = score;
    }
    let best = 0;
    for (let i = 1; i < scores.length; i++) if (scores[i] > scores[best]) best = i;
    let sum = 0, sq = 0;
    for (const v of scores) { sum += v; sq += v * v; }
    const m = sum / scores.length, sd = Math.sqrt(Math.max(1e-9, sq / scores.length - m * m));
    return { shiftMs: (best - steps) * hopMs, z: (scores[best] - m) / sd };
  }

  /* Placed by the first part of each line, then refined by the whole of it. */
  function placeLines(speech, spans, { hopMs = HOP_MS, originMs = 0 } = {}) {
    if (spans.length < MIN_LINES) return null;
    const heads = spans.map(([a, b]) => [a, Math.max(a + 300, b - 500)]);
    const coarse = bestShift(speech, heads, { hopMs, originMs, searchMs: SEARCH_MS });
    if (!coarse) return null;
    const moved = spans.map(([a, b]) => [a + coarse.shiftMs, b + coarse.shiftMs]);
    const fine = bestShift(speech, moved, { hopMs, originMs, searchMs: 600 });
    return { shiftMs: coarse.shiftMs + (fine ? fine.shiftMs : 0), z: coarse.z };
  }

  /**
   * What has been heard of one film, frame by frame on the stream's clock, and
   * the decision it supports.
   *
   * `hear` takes one reading per tick. `decide` is asked after a block closes,
   * with a function giving the lead's lines as [start, end] stream times for a
   * window, and answers what the blocks say and whether that is a shift to
   * apply. Nothing here knows about subtitles, offsets or the page.
   *
   * `blockFrames` is for the harness, which cannot wait four minutes; a block
   * still has to hold 200 heard frames for bestShift to answer at all.
   */
  function createHearing({ blockFrames = BLOCK_FRAMES } = {}) {
    let frames = new Int8Array(0);
    const floorRing = new Float32Array(FLOOR_FRAMES);
    let floorCount = 0, floorNext = 0, floor = -120, sinceFloor = FLOOR_EVERY;
    let recent = [];
    let lastBin = -10;
    let current = [];
    let spoken = 0;
    const blocks = [];

    function store(bin, value) {
      if (bin >= frames.length) {
        const grown = new Int8Array(Math.max(bin + 1, frames.length * 2, 72000)).fill(-1);
        grown.set(frames);
        frames = grown;
      }
      frames[bin] = value;
    }

    function updateFloor(bandDb) {
      if (bandDb > -110) {
        floorRing[floorNext] = bandDb;
        floorNext = (floorNext + 1) % FLOOR_FRAMES;
        floorCount = Math.min(FLOOR_FRAMES, floorCount + 1);
      }
      if (++sinceFloor < FLOOR_EVERY || !floorCount) return;
      sinceFloor = 0;
      const sorted = floorRing.slice(0, floorCount).sort();
      floor = sorted[Math.floor(floorCount * FLOOR_QUANTILE)];
    }

    /* Returns true when this reading closed a block. */
    function hear(streamMs, bandDb, sideDb) {
      if (!Number.isFinite(streamMs) || streamMs < 0) return false;
      const bin = Math.round(streamMs / HOP_MS);
      if (bin === lastBin) return false;
      /* A jump is a seek or a gap in the ticks; the syllable test reads the
       * last five frames and must not read them across one. */
      if (Math.abs(bin - lastBin) > 3) recent = [];
      lastBin = bin;
      const band = Number.isFinite(bandDb) ? bandDb : -120;
      const side = Number.isFinite(sideDb) ? sideDb : -120;
      updateFloor(band);
      recent.push(band);
      if (recent.length > 6) recent.shift();
      /* Not yet judged rather than not speech: a frame stored as silence
       * after every jump would, on a tab ticking once a second, record the
       * whole film as silence. */
      if (recent.length < 6) return false;
      let moving = 0;
      for (let k = 1; k < recent.length; k++) moving += Math.abs(recent[k] - recent[k - 1]);
      const syllabic = moving / 5 > MODULATION_DB;
      const speech = band > floor + ABOVE_FLOOR_DB && band - side > CENTRE_DB && syllabic;
      if (speech) spoken++;
      store(bin, speech ? 1 : 0);
      current.push(bin);
      if (current.length < blockFrames) return false;
      blocks.push(Int32Array.from(current));
      if (blocks.length > RECENT_BLOCKS) blocks.shift();
      current = [];
      return true;
    }

    /* The heard frames of some blocks as one array, -1 where a frame is not
     * theirs, so a block with a seek inside it is still one question. */
    function over(chosen) {
      let lo = Infinity, hi = -Infinity;
      for (const block of chosen) for (const bin of block) { if (bin < lo) lo = bin; if (bin > hi) hi = bin; }
      const speech = new Int8Array(hi - lo + 1).fill(-1);
      for (const block of chosen) for (const bin of block) speech[bin - lo] = frames[bin];
      return { speech, fromMs: lo * HOP_MS, toMs: hi * HOP_MS };
    }

    function shiftOf(chosen, linesFor) {
      const { speech, fromMs, toMs } = over(chosen);
      const spans = linesFor(fromMs - SEARCH_MS, toMs + SEARCH_MS);
      return placeLines(speech, spans, { originMs: fromMs });
    }

    function decide(linesFor, { minimumMs = APPLY_MIN_MS } = {}) {
      if (blocks.length < 2) return { blocks: blocks.length, agreed: null, apply: null };
      const last = shiftOf(blocks.slice(-1), linesFor);
      const before = shiftOf(blocks.slice(-2, -1), linesFor);
      const all = shiftOf(blocks, linesFor);
      const agreed = last && before && all
        && Math.abs(last.shiftMs - all.shiftMs) <= AGREE_MS
        && Math.abs(before.shiftMs - all.shiftMs) <= AGREE_MS
        ? all.shiftMs : null;
      return {
        blocks: blocks.length,
        lastMs: last?.shiftMs ?? null,
        beforeMs: before?.shiftMs ?? null,
        allMs: all?.shiftMs ?? null,
        z: all ? Math.round(all.z * 10) / 10 : null,
        agreed,
        apply: agreed != null && Math.abs(agreed) >= minimumMs ? agreed : null,
      };
    }

    return {
      hear,
      decide,
      get heardMs() { return (blocks.length * blockFrames + current.length) * HOP_MS; },
      // Of everything heard since this began, how much was taken for speech.
      get spokenMs() { return spoken * HOP_MS; },
      // What was stored for a stretch of the stream, -1 where nothing was.
      framesBetween(fromMs, toMs) {
        const from = Math.round(fromMs / HOP_MS), to = Math.round(toMs / HOP_MS);
        const out = new Int8Array(Math.max(0, to - from)).fill(-1);
        for (let bin = Math.max(0, from); bin < Math.min(to, frames.length); bin++) out[bin - from] = frames[bin];
        return out;
      },
    };
  }

  /**
   * The film's sound, as two speech-band levels a tick can read.
   *
   * `captureStream()` and not `createMediaElementSource`: the second takes the
   * element's sound away from the speakers and makes the extension responsible
   * for playing it. A capture is a copy, before the element's own volume, so a
   * muted film is heard as well as a loud one. Chrome refuses it for a video
   * whose data is from another origin without CORS (observed: "Cannot capture
   * from element with cross-origin data"), and is expected to for encrypted
   * media, not yet observed; the caller records the error either way.
   *
   * The analyser mixes its input to mono, which for a stereo source is the
   * middle, (L+R)/2; the side is L/2 - R/2 summed into a second analyser.
   * Measured in Chrome against a clip with tone bursts at known moments: each
   * onset was read between 20ms early and 98ms late on a 50ms poll, muted or
   * not.
   */
  function openEar(video, { onState = () => {} } = {}) {
    let stream;
    try {
      const capture = video.captureStream || video.mozCaptureStream;
      if (!capture) return { refused: "captureStream is not available" };
      stream = capture.call(video);
    } catch (error) {
      return { refused: `${error?.name || "Error"}: ${error?.message || error}` };
    }
    if (!stream.getAudioTracks().length) {
      return { refused: "no audio track yet", retry: true };
    }
    let context;
    try {
      context = new AudioContext();
    } catch (error) {
      return { refused: `${error?.name || "Error"}: ${error?.message || error}` };
    }
    const source = context.createMediaStreamSource(stream);
    const fftSize = context.sampleRate > 60000 ? 4096 : 2048;
    const middle = context.createAnalyser();
    const sides = context.createAnalyser();
    for (const analyser of [middle, sides]) {
      analyser.fftSize = fftSize;
      analyser.smoothingTimeConstant = 0;
    }
    /* Through stereo first, by the speakers rule: a mono film then has no
     * sides at all rather than a left channel and silence, and a 5.1 film has
     * its centre - where the dialogue is mixed - in both. */
    const stereo = context.createGain();
    stereo.channelCount = 2;
    stereo.channelCountMode = "explicit";
    stereo.channelInterpretation = "speakers";
    const split = context.createChannelSplitter(2);
    const left = context.createGain();
    const right = context.createGain();
    left.gain.value = 0.5;
    right.gain.value = -0.5;
    source.connect(stereo);
    stereo.connect(middle);
    stereo.connect(split);
    split.connect(left, 0);
    split.connect(right, 1);
    left.connect(sides);
    right.connect(sides);

    const bins = new Float32Array(middle.frequencyBinCount);
    const hz = context.sampleRate / fftSize;
    const lo = Math.ceil(300 / hz), hi = Math.floor(3400 / hz);
    const band = (analyser) => {
      analyser.getFloatFrequencyData(bins);
      let power = 0;
      for (let k = lo; k <= hi; k++) if (bins[k] > -200) power += 10 ** (bins[k] / 10);
      return 10 * Math.log10(power + 1e-12);
    };

    /* An AudioContext made before the frame has seen a gesture starts
     * suspended; the next press or key in this frame lets it run. */
    const resume = () => {
      if (context.state === "suspended") context.resume().catch(() => {});
    };
    document.addEventListener("pointerdown", resume, true);
    document.addEventListener("keydown", resume, true);
    context.addEventListener("statechange", () => onState(context.state));
    resume();

    return {
      get state() { return context.state; },
      sampleRate: context.sampleRate,
      fftSize,
      read() {
        if (context.state !== "running") return null;
        return { bandDb: band(middle), sideDb: band(sides) };
      },
      close() {
        document.removeEventListener("pointerdown", resume, true);
        document.removeEventListener("keydown", resume, true);
        for (const track of stream.getTracks()) track.stop();
        context.close().catch(() => {});
      },
    };
  }

  globalThis.__ssoListen = {
    bestShift, placeLines, createHearing, openEar,
    HOP_MS, BLOCK_FRAMES, APPLY_MIN_MS, AFTER_HAND_MIN_MS,
  };
})();
