/* What the study rail actually did, read back out of the running log.
 *
 *     node tools/study-report.mjs [--logs <dir>] [--since YYYY-MM-DD]
 *
 * Two questions, and neither of them was answerable before the `marks` record
 * existed: are these the words worth stopping on, and is the meaning under them
 * right. `glossAhead` in study.js walks a whole film in one pass applying one
 * rule, so it is the only place that sees the entire population - every word it
 * marked, every word it refused and why, and what came back for each.
 *
 * The half that matters most is what was REFUSED. A filter judged on the words
 * that survive it is judged against a population it curated itself: nothing it
 * wrongly threw away can turn up in its own output, so the numbers look perfect
 * whatever the rule does. The record carries the refusal counts for that reason
 * and this prints them beside the marks.
 *
 * Nothing here is a pass or a fail. It is a description of what happened, and
 * the judgements are left to whoever reads it.
 */

import { readdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const DEFAULT_LOGS = join(HERE, "..", "..", "subtitle-daemon", "logs");

const flag = (name, fallback) => {
  const at = process.argv.indexOf(name);
  return at === -1 ? fallback : process.argv[at + 1];
};

async function marksFrom(dir, since) {
  const found = [];
  let files = 0;
  for (const name of (await readdir(dir)).sort()) {
    if (!name.endsWith(".jsonl")) continue;
    if (since && name.slice(0, 10) < since) continue;
    files += 1;
    const text = await readFile(join(dir, name), "utf-8");
    for (const line of text.split("\n")) {
      if (!line.includes('"marks"')) continue;
      try {
        const entry = JSON.parse(line);
        if (entry.kind === "marks") found.push(entry);
      } catch {
        // A half-written last line is normal on a log being appended to.
      }
    }
  }
  return { found, files };
}

const pct = (part, whole) => (whole ? `${((100 * part) / whole).toFixed(1)}%` : "-");
const row = (label, value) => console.log(`  ${String(label).padEnd(34)} ${value}`);

/* A gloss that is not one.
 *
 * Three shapes, and each is a different failure. Nothing came back at all;
 * the term was handed back unchanged, which is how every translator says "I do
 * not know"; or a sentence arrived where one to three words were asked for. */
const nothing = (g) => !g;
const echoed = (term, g) => Boolean(g) && g.toLowerCase() === term.toLowerCase();
const wordy = (term, g) => g.split(/\s+/).filter(Boolean).length > term.split(/\s+/).length + 3;

function report(records) {
  const films = new Map();
  for (const entry of records) {
    // One film may be walked twice - a re-attach, a second language - and the
    // last walk is the one that describes what the reader ended up with.
    films.set(`${entry.film || entry.label}|${entry.slot}`, entry);
  }
  const all = [...films.values()];

  console.log(`\n${all.length} film-subtitle walks, ${records.length} records\n`);

  console.log("WHAT WAS MARKED");
  let asked = 0;
  let phrases = 0;
  let unrankedMarks = 0;
  let cues = 0;
  const refused = { name: 0, short: 0, common: 0, unranked: 0, cap: 0 };
  for (const entry of all) {
    asked += entry.asked.length;
    cues += entry.cues || 0;
    for (const item of entry.asked) {
      if (item.p) phrases += 1;
      if (item.r === null) unrankedMarks += 1;
    }
    for (const key of Object.keys(refused)) refused[key] += entry.skipped?.[key] || 0;
  }
  row("marks", asked);
  row("of them phrases", `${phrases} (${pct(phrases, asked)})`);
  row("words the table never saw", `${unrankedMarks} (${pct(unrankedMarks, asked)})`);
  row("marks per 100 cues", cues ? ((100 * asked) / cues).toFixed(1) : "-");

  console.log("\nWHAT WAS REFUSED, AND WHY");
  const totalRefused = Object.values(refused).reduce((a, b) => a + b, 0);
  row("a name", `${refused.name} (${pct(refused.name, totalRefused)})`);
  row("too short", `${refused.short} (${pct(refused.short, totalRefused)})`);
  row("common enough already", `${refused.common} (${pct(refused.common, totalRefused)})`);
  row("no rank to judge it by", `${refused.unranked} (${pct(refused.unranked, totalRefused)})`);
  row("over the line's cap", `${refused.cap} (${pct(refused.cap, totalRefused)})`);
  console.log(
    `  ${"".padEnd(34)} ${totalRefused} refusals against ${asked} marks` +
      ` - the rule keeps ${pct(asked, asked + totalRefused)} of what it looks at`,
  );

  console.log("\nWHICH TIER ANSWERED");
  /* Three tiers behind one chip. The model reads the line the word was said in
   * and is the only one that can tell "spare a minute" from "a spare tyre";
   * Google answers the bare word; disk is a question already answered. An empty
   * chip is none of them, and until this was recorded the four were
   * indistinguishable from the overlay - which is what "translation quality is
   * still not improved" had to be diagnosed through. */
  const from = { disk: 0, model: 0, google: 0, none: 0 };
  for (const entry of all) {
    for (const key of Object.keys(from)) from[key] += entry.from?.[key] || 0;
  }
  const fromTotal = Object.values(from).reduce((a, b) => a + b, 0);
  if (!fromTotal) {
    console.log("  not recorded - these walks predate the tier being counted");
  } else {
    row("the model, reading the line", `${from.model} (${pct(from.model, fromTotal)})`);
    row("already on disk", `${from.disk} (${pct(from.disk, fromTotal)})`);
    row("the bare word, no line", `${from.google} (${pct(from.google, fromTotal)})`);
    row("nothing answered", `${from.none} (${pct(from.none, fromTotal)})`);
  }

  console.log("\nWHAT CAME BACK");
  let blank = 0;
  let same = 0;
  let long = 0;
  let blankPhrase = 0;
  let blankUnranked = 0;
  for (const entry of all) {
    for (const item of entry.asked) {
      if (nothing(item.g)) {
        blank += 1;
        if (item.p) blankPhrase += 1;
        if (item.r === null) blankUnranked += 1;
      } else if (echoed(item.t, item.g)) same += 1;
      else if (wordy(item.t, item.g)) long += 1;
    }
  }
  const answered = asked - blank;
  row("answered", `${answered} (${pct(answered, asked)})`);
  row("nothing came back", `${blank} (${pct(blank, asked)})`);
  row("  of those, phrases", `${blankPhrase} (${pct(blankPhrase, phrases)} of phrases)`);
  row("  of those, off the table", `${blankUnranked} (${pct(blankUnranked, unrankedMarks)} of them)`);
  row("handed the word back unchanged", `${same} (${pct(same, asked)})`);
  row("longer than a gloss should be", `${long} (${pct(long, asked)})`);

  /* The terms marked in the most different films.
   *
   * A word the reader meets in every film they watch is not a rare word, it is
   * a hole in the frequency table - and it costs one of the line's two places
   * every time. This is the list to read when deciding whether the tables need
   * rebuilding. */
  console.log("\nMARKED IN THE MOST FILMS");
  const across = new Map();
  for (const entry of all) {
    for (const term of new Set(entry.asked.map((item) => item.t))) {
      const seen = across.get(term) || { films: 0, blank: 0, gloss: "" };
      seen.films += 1;
      const item = entry.asked.find((each) => each.t === term);
      if (nothing(item.g)) seen.blank += 1;
      else if (!seen.gloss) seen.gloss = item.g;
      across.set(term, seen);
    }
  }
  const often = [...across.entries()]
    .filter(([, seen]) => seen.films > 1)
    .sort((a, b) => b[1].films - a[1].films)
    .slice(0, 20);
  if (!often.length) {
    console.log("  nothing yet - no term has been marked in two different films");
  }
  for (const [term, seen] of often) {
    console.log(
      `  ${term.padEnd(20)} ${String(seen.films).padStart(3)} films` +
        `   ${seen.blank ? `${seen.blank} with no answer` : seen.gloss}`,
    );
  }

  console.log("\nPER FILM");
  for (const entry of all.slice(-24)) {
    const name = entry.film || entry.label || "(unnamed)";
    const blanks = entry.asked.filter((item) => nothing(item.g)).length;
    console.log(
      `  ${name.slice(0, 44).padEnd(44)} ${entry.language}>${entry.target}` +
        ` ${String(entry.asked.length).padStart(4)} marks` +
        ` ${String(entry.cues).padStart(5)} cues` +
        `  ${pct(entry.asked.length - blanks, entry.asked.length).padStart(6)} answered`,
    );
  }
  console.log("");
}

const dir = flag("--logs", DEFAULT_LOGS);
const { found, files } = await marksFrom(dir, flag("--since", ""));
if (!found.length) {
  console.log(
    `\nNo \`marks\` records in ${files} log file(s) under ${dir}.\n\n` +
      "The record is written once per film per subtitle, when the prefetch has\n" +
      "walked the whole file and asked for every meaning. Watch something with\n" +
      "study mode on and the daemon running, then run this again.\n",
  );
} else {
  report(found);
}
