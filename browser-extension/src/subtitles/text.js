/* Text utilities shared by the matcher and the annotator.
 *
 * These exist to mirror Python behaviour the rest of the port depends on, and
 * the two that matter are both places where the obvious JavaScript is subtly
 * different from the Python it replaces.
 */

/* Python's `unicodedata.normalize("NFKD", s)` then dropping combining marks.
 *
 * Python drops characters whose *combining class* is non-zero; this drops
 * everything in Unicode category M, which is a superset. They differ only for
 * marks with a combining class of zero - enclosing marks and some spacing
 * marks - none of which appear in film titles or caption text in the languages
 * this handles. The parity run over the corpus is what confirms it.
 *
 * `casefold` is also not `toLowerCase`: the one difference that reaches real
 * input is the German sharp s, which casefolds to "ss" and lowercases to
 * itself, so it is done explicitly.
 */
export function foldAccents(text) {
  return String(text || "")
    .normalize("NFKD")
    .replace(/\p{M}/gu, "");
}

export function casefold(text) {
  return String(text || "").replace(/ß/g, "ss").toLowerCase();
}

/* Python: re.sub(r"\s+", " ", stripped.casefold()).strip() over the folded text.
 * Used for speaker colours, so a change here re-colours every character. */
export function normalise(text) {
  return casefold(foldAccents(text)).replace(/\s+/g, " ").trim();
}

/* --- difflib.SequenceMatcher.ratio ----------------------------------------
 *
 * Ported rather than approximated. The match score decides whether a subtitle
 * attaches without asking, and the threshold (0.75) was tuned against the
 * numbers this algorithm produces - a similarity metric that is merely
 * *similar* would move results across that line in either direction.
 *
 * This is difflib's "gestalt" ratio: find the longest matching block, recurse
 * either side of it, and score 2*matched/total. Not edit distance, and not the
 * same answer as edit distance.
 */

/** Map each element of b to the indices where it occurs, as difflib's b2j. */
function buildB2J(b) {
  const b2j = new Map();
  for (let i = 0; i < b.length; i++) {
    const key = b[i];
    const at = b2j.get(key);
    if (at) at.push(i);
    else b2j.set(key, [i]);
  }

  /* difflib's autojunk: in a sequence of 200 or more, an element appearing in
   * more than 1% of positions is treated as noise and stops anchoring matches.
   * Titles never reach 200 characters, so this is here for faithfulness rather
   * than effect - but leaving it out would make the port wrong for any caller
   * that did pass something long. */
  const popular = new Set();
  const n = b.length;
  if (n >= 200) {
    const limit = Math.floor(n / 100) + 1;
    for (const [key, at] of b2j) {
      if (at.length > limit) popular.add(key);
    }
    for (const key of popular) b2j.delete(key);
  }
  return b2j;
}

function findLongestMatch(a, b, b2j, alo, ahi, blo, bhi) {
  let besti = alo;
  let bestj = blo;
  let bestsize = 0;
  let j2len = new Map();

  for (let i = alo; i < ahi; i++) {
    const newj2len = new Map();
    for (const j of b2j.get(a[i]) || []) {
      if (j < blo) continue;
      if (j >= bhi) break;
      const k = (j2len.get(j - 1) || 0) + 1;
      newj2len.set(j, k);
      if (k > bestsize) {
        besti = i - k + 1;
        bestj = j - k + 1;
        bestsize = k;
      }
    }
    j2len = newj2len;
  }

  /* difflib runs the junk and non-junk extensions in four loops. With no junk
   * function - which is how matching.py calls it - the junk pair is dead, so
   * only the non-junk extension survives here. */
  while (besti > alo && bestj > blo && a[besti - 1] === b[bestj - 1]) {
    besti--;
    bestj--;
    bestsize++;
  }
  while (
    besti + bestsize < ahi &&
    bestj + bestsize < bhi &&
    a[besti + bestsize] === b[bestj + bestsize]
  ) {
    bestsize++;
  }

  return [besti, bestj, bestsize];
}

/** Total number of matched elements, which is all `ratio` needs. */
function matchedCount(a, b) {
  const b2j = buildB2J(b);
  const queue = [[0, a.length, 0, b.length]];
  let matched = 0;

  while (queue.length) {
    const [alo, ahi, blo, bhi] = queue.pop();
    const [i, j, k] = findLongestMatch(a, b, b2j, alo, ahi, blo, bhi);
    if (!k) continue;
    matched += k;
    if (alo < i && blo < j) queue.push([alo, i, blo, j]);
    if (i + k < ahi && j + k < bhi) queue.push([i + k, ahi, j + k, bhi]);
  }
  return matched;
}

/** difflib.SequenceMatcher(None, a, b).ratio() over two strings. */
export function ratio(a, b) {
  // Compared per code point rather than per UTF-16 unit, so an astral
  // character counts once, the way Python counts it.
  const left = [...String(a)];
  const right = [...String(b)];
  const total = left.length + right.length;
  if (total === 0) return 1.0;
  return (2.0 * matchedCount(left, right)) / total;
}

/* Python's round() breaks ties to even, JavaScript's rounds half away from
 * zero. round(0.00125, 4) is 0.0012 in Python and 0.0013 here. Scores land on
 * an exact tie rarely, but "rarely" across every result of every search is not
 * never, and a score that disagrees with the daemon's by one ulp at the
 * auto-attach threshold decides whether a subtitle attaches by itself. */
export function roundHalfEven(value, digits) {
  const scale = 10 ** digits;
  const scaled = value * scale;
  const floor = Math.floor(scaled);
  const diff = scaled - floor;
  let rounded;
  if (diff > 0.5) rounded = floor + 1;
  else if (diff < 0.5) rounded = floor;
  else rounded = floor % 2 === 0 ? floor : floor + 1;
  return rounded / scale;
}
