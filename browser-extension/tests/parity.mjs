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
import { guess, resolve } from "../src/subtitles/titles.js";
import { cleanTranslation, pickTranslation } from "../src/study/lookup.js";

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

/* The search-level resolution, not only the parser. The parser agreed across
 * both copies while the two search paths disagreed about whether to run it at
 * all, so comparing guess() alone reported parity that did not exist. */
out.searches = (input.searches || []).map((params) => ({ params, ...resolve(params) }));

/* What a word means is the other pipeline written twice, and the one a reader
 * hits with no daemon running. `Serme<x id="1"/>` on a chip is what a
 * divergence here looks like. */
out.translations = (input.translations || []).map(({ term, payload }) => ({
  term,
  payload,
  cleaned: cleanTranslation(payload?.responseData?.translatedText ?? ""),
  picked: pickTranslation(payload, term),
}));

process.stdout.write(JSON.stringify(out));
