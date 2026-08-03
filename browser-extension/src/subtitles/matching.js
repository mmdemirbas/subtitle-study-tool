/* Scoring how well a search result matches what was asked for.
 *
 * Port of subtitle-daemon/src/subtitle_daemon/matching.py. See that file for
 * why the score is shaped this way; the reasoning is not repeated here, only
 * the parts that constrain the port.
 */

import { ARTICLES, AUTO_ATTACH_THRESHOLD, VISIBLE_THRESHOLD } from "./tables.generated.js";
import { casefold, foldAccents, ratio, roundHalfEven } from "./text.js";

export { AUTO_ATTACH_THRESHOLD, VISIBLE_THRESHOLD };

const ARTICLE_SET = new Set(ARTICLES);

/* Python's `re.compile(r"[^\w\s]", re.UNICODE)`. JavaScript's \w is ASCII-only
 * whatever the flags, so the class is spelled out: anything that is not a
 * letter, a number, an underscore or whitespace. Without this a Turkish title
 * loses its dotless i and stops matching itself. */
const NON_WORD = /[^\p{L}\p{N}_\s]/gu;

export function normalise(text) {
  return casefold(foldAccents(text)).replace(NON_WORD, " ").replace(/\s+/g, " ").trim();
}

export function tokens(text) {
  return normalise(text)
    .split(" ")
    .filter((word) => word && !ARTICLE_SET.has(word));
}

export function score(query, candidate, { queryYear = null, candidateYear = null } = {}) {
  const queryTokens = tokens(query);
  const candidateTokens = tokens(candidate);
  if (!queryTokens.length || !candidateTokens.length) return 0.0;

  const queryNorm = queryTokens.join(" ");
  const candidateNorm = candidateTokens.join(" ");

  let base;
  if (queryNorm === candidateNorm) {
    base = 1.0;
  } else {
    const similarity = ratio(queryNorm, candidateNorm);

    const querySet = new Set(queryTokens);
    const candidateSet = new Set(candidateTokens);
    let shared = 0;
    for (const word of querySet) if (candidateSet.has(word)) shared++;

    const covered = shared / querySet.size;
    const precision = shared / candidateSet.size;
    const coverage = covered * (0.5 + 0.5 * precision);

    base = Math.max(similarity, coverage);
  }

  if (queryYear && candidateYear) {
    const delta = Math.abs(queryYear - candidateYear);
    if (delta === 0) base = Math.min(1.0, base + 0.1);
    else if (delta > 1) base *= 0.7;
  }

  return roundHalfEven(base, 4);
}

export function bestScore(query, names, { queryYear = null, candidateYear = null } = {}) {
  let best = 0.0;
  for (const name of names) {
    if (!name) continue;
    const value = score(query, name, { queryYear, candidateYear });
    if (value > best) best = value;
  }
  return best;
}
