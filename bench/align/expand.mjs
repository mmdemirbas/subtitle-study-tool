/* Grow the bake-off corpus, deliberately rather than by watching things.
 *
 *   node bench/align/expand.mjs --dry        # what it would fetch, costs nothing
 *   node bench/align/expand.mjs --budget 30  # actually fetch, at most 30 downloads
 *
 * Searching is free and unlimited; downloading is not. Every fetch spends a
 * unit of the reader's OpenSubtitles quota - the same quota they need to watch
 * something tonight - so this takes a hard budget, stops when the daemon says
 * the remaining quota is getting low, and never re-fetches what is already
 * cached.
 *
 * WHAT IT PICKS, AND WHY
 *
 * Originally three files per title - one English, one Turkish, one second
 * English release - which buys one retiming pair and two cross-language pairs.
 * That was the right shape when the question was "can the aligner tell two
 * films apart".
 *
 * The question has changed. truth.mjs derives a ground truth from cue TEXT,
 * which means it can only settle pairs that SHARE text: same language, and in
 * practice one file descended from the other. Cross-language pairs are 70 of
 * the corpus's 99 same-film pairs and the oracle refuses every one of them.
 * So the download that buys the most measurable truth is another release in a
 * language we already have.
 *
 * Releases of one title grow the settled pairs quadratically - k English files
 * are k(k-1)/2 pairs the oracle can label - where a new title grows them
 * linearly. Four English releases per title is the shape now: six labelled
 * pairs for four downloads, against one pair for two.
 *
 * The Turkish file is still fetched, because it is what the reader actually
 * watches with and the cross-language pairs are what the aligner meets in
 * production. It is measured against the referees rather than the oracle, and
 * the report says which is which.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, "../..");
const CACHE = path.join(REPO, "subtitle-daemon/cache/subtitles");
// Wherever the daemon listens; it moved off 8791 when a file server took it.
const DAEMON = "http://127.0.0.1:8794";

/* Chosen for the two shapes the corpus is short of, not for taste.
 *
 * STAIRCASES come from advertising. A 47-minute episode cut into five acts for
 * broadcast carries a different amount of black between the acts in every
 * release, and that is the six-plateau staircase measured on The Americans.
 * So the television half is deliberately ad-break television - AMC, ABC, Fox,
 * Sci-Fi - and not HBO, which has no breaks to differ about.
 *
 * RATES come from PAL. A film released on DVD in Europe at 25fps against the
 * same film at 23.976 differs by a 4 percent stretch, which is what Amelie and
 * Sherlock turned out to be. That is a property of the DVD era, so the film
 * half leans on titles old enough to have had one.
 *
 * The rest is spread: several decades, several original languages, and nothing
 * so obscure that only one subtitle exists for it. */
const WANTED = [
  // Already in the corpus at two English releases; deepened to four.
  { title: "Chernobyl", season: 1, episode: 1 },
  { title: "Breaking Bad", season: 1, episode: 1 },
  { title: "The Wire", season: 1, episode: 1 },
  { title: "Sherlock", season: 1, episode: 1 },
  { title: "Interstellar", year: 2014 },
  { title: "The Dark Knight", year: 2008 },
  { title: "Parasite", year: 2019 },
  { title: "Arrival", year: 2016 },
  { title: "The Grand Budapest Hotel", year: 2014 },
  { title: "Amelie", year: 2001 },
  { title: "Spirited Away", year: 2001 },
  { title: "Fargo", year: 1996 },
  // Broadcast television, for the ad breaks.
  { title: "Lost", season: 1, episode: 1 },
  { title: "Mad Men", season: 1, episode: 1 },
  { title: "24", season: 1, episode: 1 },
  { title: "Battlestar Galactica", season: 1, episode: 1 },
  { title: "House", season: 1, episode: 1 },
  { title: "Buffy the Vampire Slayer", season: 1, episode: 1 },
  // The DVD era, for the framerate ratios.
  { title: "Blade Runner", year: 1982 },
  { title: "Aliens", year: 1986 },
  { title: "Back to the Future", year: 1985 },
  { title: "Die Hard", year: 1988 },
  { title: "The Matrix", year: 1999 },
  { title: "Pulp Fiction", year: 1994 },
  { title: "Se7en", year: 1995 },
  { title: "The Godfather", year: 1972 },
  { title: "Heat", year: 1995 },
];

/* What is left for the reader after the bench has had its turn. Fifteen is
 * three evenings' worth of attaching subtitles to something, which is the
 * point: a corpus is worth less than being able to watch tonight. */
const QUOTA_FLOOR = 15;
const argOf = (name, fallback) => {
  const at = process.argv.indexOf(name);
  return at === -1 ? fallback : process.argv[at + 1];
};
const DRY = process.argv.includes("--dry");
const BUDGET = Number(argOf("--budget", 30));
const RELEASES = Number(argOf("--releases", 4));

const call = async (path_, body) => {
  const response = await fetch(DAEMON + path_, body
    ? { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }
    : undefined);
  if (!response.ok) throw new Error(`${path_} answered ${response.status}`);
  return response.json();
};

/* Identity, written down by the thing that knows it.
 *
 * The daemon's /fetch endpoint records what it downloaded, not what it was
 * looking for - `movie_name` comes back null, because the extension supplies
 * that from the SEARCH result when it attaches and a direct fetch has no
 * attach step. So 36 downloads arrived with no derivable identity, and the
 * corpus guard refused all of them, correctly.
 *
 * These labels live beside the bench rather than being written into the
 * daemon's cache: that cache is the daemon's file format and the reader's
 * viewing history, and a bench has no business editing either. */
const LABELS = path.join(HERE, "labels.json");
const readLabels = () => {
  try { return JSON.parse(fs.readFileSync(LABELS, "utf8")); } catch { return {}; }
};

const cachedIds = () => new Set(fs.readdirSync(CACHE).filter((f) => f.endsWith(".srt")).map((f) => f.slice(0, -4)));

/** The release name, reduced to what distinguishes one timing from another. */
const releaseKey = (r) =>
  String(r.release || r.file_name || "").toLowerCase()
    .replace(/\.(srt|ass|ssa)$/, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();

function choose(results, releases) {
  const usable = results.filter((r) => r.file_id);
  const by = (language) => usable
    .filter((r) => (r.language || "").toLowerCase() === language)
    .sort((a, b) => (b.match_score ?? 0) - (a.match_score ?? 0) || (b.download_count ?? 0) - (a.download_count ?? 0));

  const picked = [];
  /* One per distinct release name. Two files from the same release carry the
   * same clock, so the pair they form has nothing in it to align. */
  const seen = new Set();
  for (const result of by("en")) {
    const key = releaseKey(result);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    picked.push({ ...result, why: `English release ${seen.size}` });
    if (seen.size >= releases) break;
  }
  const turkish = by("tr")[0];
  if (turkish) picked.push({ ...turkish, why: "Turkish, cross-language pair" });
  return picked;
}

const health = await call("/health");
console.log(`daemon: ${health.cached_subtitles} cached, api key ${health.has_api_key ? "yes" : "NO"}` +
  `, authenticated ${health.authenticated}`);
console.log(DRY ? "\nDRY RUN - searching only, nothing is downloaded\n" : `\nbudget ${BUDGET} downloads, stopping if quota drops below ${QUOTA_FLOOR}\n`);

let spent = 0;
let quota = null;
const have = cachedIds();
const labels = readLabels();
let labelled = 0;

for (const want of WANTED) {
  if (!DRY && spent >= BUDGET) { console.log(`\nbudget spent (${spent})`); break; }
  if (quota !== null && quota < QUOTA_FLOOR) { console.log(`\nquota down to ${quota}, stopping`); break; }

  const query = new URLSearchParams({ title: want.title, languages: "en,tr" });
  if (want.season) query.set("season", String(want.season));
  if (want.episode) query.set("episode", String(want.episode));
  if (want.year) query.set("year", String(want.year));

  let found;
  try {
    found = await call(`/search?${query}`);
  } catch (error) {
    console.log(`  ${want.title}: search failed - ${error.message}`);
    continue;
  }
  const picked = choose(found.results || [], RELEASES);
  const label = `${want.title}${want.season ? ` S0${want.season}E0${want.episode}` : ""}`;
  console.log(`${label}  resolved=${found.resolved?.title ?? "?"} (${found.results?.length ?? 0} results) -> ${picked.length} to fetch`);

  for (const pick of picked) {
    if (!DRY && spent >= BUDGET) break;
    const already = have.has(String(pick.file_id));
    console.log(`    ${pick.language} ${String(pick.file_id).padEnd(9)} ${pick.why.padEnd(34)} ` +
      `${String(pick.release || pick.file_name).slice(0, 40)}${already ? "  [cached]" : ""}`);
    /* Recorded on every run, fetched or not. A file already on disk from an
     * earlier run still needs its identity, and that is exactly the case that
     * produced 36 unlabelled files. */
    labels[String(pick.file_id)] = {
      film: `${found.resolved?.title ?? want.title}${want.season ? ` s${want.season}e${want.episode}` : ""}`.toLowerCase(),
      language: pick.language ?? null,
      release: pick.release || pick.file_name || null,
      askedFor: want.title,
      why: pick.why,
    };
    labelled++;
    if (DRY || already) continue;
    try {
      const got = await call("/fetch", { file_id: pick.file_id });
      spent++;
      /* Under `meta`, not at the top level. It was read from the top level for
       * as long as this script has existed, which made `quota` permanently
       * null - so the floor below never fired and the only thing standing
       * between a run and the reader's whole day of downloads was --budget. */
      const left = got.meta?.remaining_quota;
      if (typeof left === "number") quota = left;
      have.add(String(pick.file_id));
      console.log(`      cached${quota === null ? "" : `, quota ${quota}`}`);
    } catch (error) {
      console.log(`      failed: ${error.message}`);
    }
  }
}

fs.writeFileSync(LABELS, JSON.stringify(labels, null, 1));
console.log(`\n${DRY ? "would fetch" : `fetched ${spent}`}${quota === null ? "" : `, quota now ${quota}`}` +
  `; wrote ${labelled} identities to bench/align/labels.json (${Object.keys(labels).length} in total)`);
if (!DRY) console.log("re-run: node bench/align/run.mjs");
