/* Run the ported pipeline over a set of inputs and print the results as JSON.
 *
 * The daemon side of the parity test (subtitle-daemon/tests/test_js_parity.py)
 * feeds this the same inputs, runs the Python, and diffs. Nothing is asserted
 * here - this end only reports what JavaScript produced.
 *
 *     node tests/parity.mjs <input.json>
 */

import { readFileSync } from "node:fs";

import { classify, speakerColor, symbolFor } from "../src/subtitles/annotations.js";
import { score } from "../src/subtitles/matching.js";
import { decode, parseSrt, toJson } from "../src/subtitles/srt.js";
import { guess } from "../src/subtitles/titles.js";

const input = JSON.parse(readFileSync(process.argv[2], "utf-8"));
const out = {};

out.annotations = (input.annotations || []).map((text) => ({
  text,
  symbol: symbolFor(text),
  color: speakerColor(text),
  followed: classify(text, { followedBySpeech: true }),
  alone: classify(text, { followedBySpeech: false }),
}));

out.subtitles = (input.subtitles || []).map((path) => {
  const bytes = new Uint8Array(readFileSync(path));
  const { text, encoding } = decode(bytes);
  const cues = parseSrt(text);
  return { path, encoding, cue_count: cues.length, cues: toJson(cues) };
});

out.scores = (input.scores || []).map(([query, candidate, queryYear, candidateYear]) => ({
  query,
  candidate,
  value: score(query, candidate, { queryYear, candidateYear }),
}));

out.titles = (input.titles || []).map((raw) => ({ raw, ...guess(raw) }));

process.stdout.write(JSON.stringify(out));
