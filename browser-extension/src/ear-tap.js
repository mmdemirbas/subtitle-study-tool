/* The tab's sound cut into windows on the audio clock, for offscreen.js.
 *
 * The offscreen document used to read two AnalyserNodes on a 50ms timer, and
 * a hidden document's timer is not a clock: measured in the tab-ear spike,
 * its ticks came 4 to 126ms apart, median 57, p90 102. Replayed over three
 * episodes, that left 27% of the frames unheard and judged the rest on gaps
 * the detector was not fitted on, and the first correction came a median 4.1
 * minutes in against 2.0 on even frames. Here every hop of samples, exactly,
 * the last window of the middle and the sides goes to the document, which
 * reads it as the analysers would have. */
class EarTap extends AudioWorkletProcessor {
  constructor({ processorOptions: { size, hop } }) {
    super();
    this.size = size;
    this.hop = hop;
    this.mid = new Float32Array(size);
    this.side = new Float32Array(size);
    this.at = 0;
    this.seen = 0;
  }

  process([input]) {
    const left = input[0];
    if (!left) return true;
    const right = input[1] || left;
    for (let i = 0; i < left.length; i++) {
      this.mid[this.at] = (left[i] + right[i]) / 2;
      this.side[this.at] = (left[i] - right[i]) / 2;
      this.at = (this.at + 1) % this.size;
      this.seen++;
      if (this.seen % this.hop || this.seen < this.size) continue;
      const mid = new Float32Array(this.size);
      const side = new Float32Array(this.size);
      mid.set(this.mid.subarray(this.at));
      mid.set(this.mid.subarray(0, this.at), this.size - this.at);
      side.set(this.side.subarray(this.at));
      side.set(this.side.subarray(0, this.at), this.size - this.at);
      this.port.postMessage({ endMs: ((currentFrame + i + 1) / sampleRate) * 1000, mid, side }, [mid.buffer, side.buffer]);
    }
    return true;
  }
}

registerProcessor("sso-ear-tap", EarTap);
