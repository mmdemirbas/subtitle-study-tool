/* Build the word-rarity tables the study rail ranks against.
 *
 *     node tools/build-frequency.mjs [lang...]
 *
 * Source: hermitdave/FrequencyWords (MIT), whose lists are counted over the
 * OpenSubtitles corpus. That corpus is the reason to use this one rather than a
 * general web or book frequency list: the question being asked is "is this word
 * rare *in film dialogue*", and a word can be common in print and vanishingly
 * rare in speech, or the reverse. A list built from anything else answers a
 * different question and would mark the wrong words.
 *
 * The output is words in rank order, one per line, as plain text. Rank is the
 * line number, so nothing has to be stored per word beyond the word itself, and
 * the threshold the user sets is an index comparison.
 *
 * Generated files are committed. This is not part of any build: it runs when
 * the lists are refreshed upstream, which is roughly never.
 */

import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT_DIR = join(HERE, "..", "src", "study");

const SOURCE = (lang) =>
  `https://raw.githubusercontent.com/hermitdave/FrequencyWords/master/content/2018/${lang}/${lang}_50k.txt`;

/* How many words to keep.
 *
 * The tail of a 50k list is mostly noise - proper nouns, typos in the
 * subtitles it was counted from, and words that appeared four times in the
 * whole corpus. Nothing past 30k is a word a learner needs ranked; it only
 * needs to be *absent*, which is the same answer the table gives by not
 * containing it. Keeping the whole 50k would add 250 KB to say "rare" twice. */
const KEEP = 30000;

/* Below this many occurrences a line says more about the corpus than about the
 * language. Applied before the rank cut, so ranks stay dense. */
const MIN_COUNT = 12;

/* Letters only, and it may be one letter.
 *
 * This used to demand two, to keep out the stray letters left over from
 * tokenising contractions ("don't" -> "don", "t"), on the grounds that a single
 * letter marked rare on screen is noise sitting on top of the film. It kept
 * those out, and it also kept out "i", the second commonest word in the whole
 * corpus at 27 million occurrences, and "a", the fifth.
 *
 * That mattered somewhere else. rarity.js answers a contraction by looking up
 * the part before the apostrophe, so "i'll" is rankable only if "i" is in here
 * - and it was not, so "i'll" and "i've" came back unrankable, which the
 * marking rule reads as rarer than the 30,000th word. Measured over the 175
 * English films in this machine's cache: "i'll" was marked in 150 of them and
 * "i've" in 113.
 *
 * The stray letters are still harmless. Nothing under three letters can be
 * marked, so "t" and "s" can only sit in the table being common, and neither is
 * ever the part before an apostrophe. */
const WORD = /^\p{L}([\p{L}\p{M}'’-]*\p{L})?$/u;

async function build(lang) {
  const response = await fetch(SOURCE(lang));
  if (!response.ok) throw new Error(`${lang}: HTTP ${response.status} from ${SOURCE(lang)}`);
  const raw = await response.text();

  const words = [];
  const seen = new Set();
  for (const line of raw.split("\n")) {
    const [word, count] = line.trim().split(/\s+/);
    if (!word || Number(count) < MIN_COUNT) continue;
    const normalised = word.toLocaleLowerCase(lang);
    if (!WORD.test(normalised) || seen.has(normalised)) continue;
    seen.add(normalised);
    words.push(normalised);
    if (words.length >= KEEP) break;
  }

  /* One word per line and nothing else - no header, no banner, no metadata.
   *
   * Rank is the line number, and anything written above the first word would
   * shift every rank by one. The provenance that used to sit in the module's
   * comment lives here, in the generator that writes the file, which is the
   * only place it can be acted on anyway.
   *
   * Text rather than a JS module because the reader is a service worker, where
   * dynamic import is disallowed by the HTML specification - see the comment on
   * table() in src/study/rarity.js for what that cost. */
  const body = `${words.join("\n")}\n`;

  const path = join(OUT_DIR, `frequency-${lang}.generated.txt`);
  await mkdir(OUT_DIR, { recursive: true });
  await writeFile(path, body, "utf-8");
  return { lang, kept: words.length, bytes: body.length };
}

const languages = process.argv.slice(2);
for (const lang of languages.length ? languages : ["en", "tr"]) {
  const result = await build(lang);
  process.stdout.write(
    `${result.lang}: ${result.kept} words, ${(result.bytes / 1024).toFixed(0)} KB\n`,
  );
}
