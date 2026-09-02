/* Build the phrasal-verb table the study rail marks against.
 *
 *     node tools/build-phrases.mjs [--corpus <dir>]
 *
 * Two sources, because neither answers on its own.
 *
 * WHICH strings are phrasal verbs comes from Wiktionary's
 * `Category:English phrasal verbs` (CC BY-SA), through the MediaWiki API. It is
 * the only free list of this shape that is maintained, and a hand-written one
 * would be a hundred entries of somebody's guess about what matters.
 *
 * HOW COMMON each of them is comes from a corpus of subtitle files, for exactly
 * the reason build-frequency.mjs gives about words: the question is "does a
 * learner watching films meet this often enough to already know it", and a
 * general-English count answers a different one. The default corpus is the
 * subtitle cache this machine has downloaded.
 *
 * That second half is NOT reproducible from a clean checkout, and that is a
 * property of the measurement rather than a defect to hide. The committed table
 * was counted over the 174 English files in one cache; re-running this with
 * another corpus produces another order, which is the honest thing for it to
 * do. What ships is the artefact.
 *
 * The matcher is imported from src/study/phrases.js rather than written again
 * here. A build that counted phrases its runtime cannot find would produce a
 * table whose order describes nothing.
 *
 * Generated files are committed. This is not part of any build.
 */

import { readdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  GRAMMAR_HEADS,
  PARTICLES,
  buildIndex,
  findPhrases,
} from "../src/study/phrases.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT = join(HERE, "..", "src", "study", "phrases-en.generated.txt");
const DEFAULT_CORPUS = join(HERE, "..", "..", "subtitle-daemon", "cache", "subtitles");

const CATEGORY =
  "https://en.wiktionary.org/w/api.php?action=query&list=categorymembers" +
  "&cmtitle=Category%3AEnglish%20phrasal%20verbs&cmlimit=500&cmnamespace=0&format=json";
/* Wikimedia's user-agent policy asks for a name and a way to get in touch, and
 * answers a request without one with an HTML notice rather than JSON - which is
 * how this was found. Two seconds between pages gets the whole category in
 * eleven of them and is well inside what the policy asks for.
 *
 * Change the contact before running this anywhere but here. A build script that
 * identifies itself as somebody else is worse than one that identifies itself
 * as nobody. */
const BETWEEN_PAGES_MS = 2000;
const UA =
  "subtitle-study-tool/0.1 (https://github.com/mmdemirbas/subtitle-study-tool; one-off table build)";

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function category() {
  const titles = [];
  let from = null;
  for (let page = 0; page < 40; page++) {
    const url = CATEGORY + (from ? `&cmcontinue=${encodeURIComponent(from)}` : "");
    const response = await fetch(url, { headers: { "User-Agent": UA, Accept: "application/json" } });
    const text = await response.text();
    if (!text.startsWith("{")) throw new Error(`wiktionary answered HTTP ${response.status}: ${text.slice(0, 120)}`);
    const payload = JSON.parse(text);
    titles.push(...(payload.query?.categorymembers || []).map((member) => member.title));
    from = payload.continue?.cmcontinue || null;
    if (!from) return titles;
    await sleep(BETWEEN_PAGES_MS);
  }
  throw new Error("the category did not end");
}

/* A lower-case verb followed by one or two particles, and nothing else.
 *
 * The category also holds proper nouns, hyphenated forms, three-word idioms
 * that are not verb-plus-particle, and entries whose head carries grammar
 * rather than meaning. Every one of those either cannot be matched by the
 * runtime or matches something a learner already knows.
 */
function shaped(titles) {
  const particles = new Set(PARTICLES);
  const grammar = new Set(GRAMMAR_HEADS);
  return titles.filter((title) => {
    if (!/^[a-z]+( [a-z]+){1,2}$/.test(title)) return false;
    const [head, ...tail] = title.split(" ");
    return !grammar.has(head) && tail.every((word) => particles.has(word));
  });
}

const WORD = /[\p{L}\p{N}']+/gu;
const ENGLISH = /\b(the|and|you)\b/gi;

/** How often each phrase is said, over whatever subtitle files are in `dir`. */
async function count(phrases, dir) {
  const index = buildIndex(phrases);
  const counts = new Map();
  let files = 0;

  for (const name of await readdir(dir)) {
    if (!name.endsWith(".srt")) continue;
    let text;
    try {
      text = await readFile(join(dir, name), "utf-8");
    } catch {
      // A file this build cannot read is one film less in the count, not a
      // reason to produce no table.
      continue;
    }
    const lines = text
      .split(/\r?\n/)
      .filter((line) => line && !/^\d+$/.test(line) && !line.includes("-->"));
    /* English only. The cache holds both halves of every pair, and counting a
     * Turkish file against an English lexicon adds nothing and costs a scan.
     * Fifty of the three commonest English words is a wide margin either way. */
    if ((lines.join(" ").match(ENGLISH) || []).length < 50) continue;
    files++;
    for (const line of lines) {
      const words = line.toLowerCase().replace(/<[^>]*>/g, " ").match(WORD) || [];
      for (const hit of findPhrases(words, index)) {
        counts.set(hit.phrase, (counts.get(hit.phrase) || 0) + 1);
      }
    }
  }
  return { counts, files };
}

const corpusAt = () => {
  const at = process.argv.indexOf("--corpus");
  return at === -1 ? DEFAULT_CORPUS : process.argv[at + 1];
};

const titles = await category();
const list = shaped(titles);
const corpus = corpusAt();
const { counts, files } = await count(list, corpus);

/* Commonest first, so a rank is a line number and "outside the commonest N" is
 * an index comparison - the same shape the word table has, for the same reason.
 *
 * And ONLY what the corpus attests. The category is broad by design: it holds
 * "rust out", "deck up", "buck for" and "kick over" beside "give up" and "back
 * off", and a first version shipped the unattested tail on the theory that
 * never-said means rare and rare is worth marking. Measured against one
 * episode: of the fifteen phrases it put on screen, every one that read as
 * noise was from that tail and every one from the counted part was a phrasal
 * verb worth knowing. A phrase nobody said in 174 films of dialogue is not a
 * precious find, it is a corner of the category, and it must not take one of a
 * line's two places when it turns up.
 *
 * What that gives up is a real phrasal verb this corpus happens not to contain.
 * That is a property of the corpus and the honest way to widen it is a bigger
 * one, not a longer list of things nobody says.
 */
const seen = [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
const unseen = list.filter((phrase) => !counts.has(phrase));

await writeFile(OUT, `${seen.map(([phrase]) => phrase).join("\n")}\n`, "utf-8");

console.log(`wiktionary   ${titles.length} entries in the category`);
console.log(`kept         ${list.length} verb-plus-particle forms`);
console.log(`corpus       ${files} English subtitle files in ${corpus}`);
console.log(`kept in table ${seen.length} said at least once; dropped ${unseen.length} never said`);
console.log(`commonest    ${seen.slice(0, 8).map(([phrase, n]) => `${phrase} ${n}`).join(", ")}`);
console.log(`wrote        ${OUT}`);
