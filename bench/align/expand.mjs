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
 * The corpus's weakness is not its size, it is its shape: 42 of its 43
 * same-film pairs are one television series, so everything measured about
 * cross-language behaviour is really measured about that show. Diversity per
 * download therefore beats volume.
 *
 * Three files per title, which is the smallest set that produces all three
 * kinds of pair worth having:
 *
 *   English + Turkish            a cross-language pair, the hard case
 *   English + another English    a RETIMING pair, from a different release
 *   Turkish + that English       another cross-language pair, free
 *
 * Three downloads buy three positive pairs and one negative pair against every
 * other title in the corpus. The second English release is chosen to have a
 * different release name, because two files from the same release are the same
 * timing and prove nothing.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, "../..");
const CACHE = path.join(REPO, "subtitle-daemon/cache/subtitles");
const DAEMON = "http://127.0.0.1:8791";

/* Chosen for spread rather than taste: film and television, four decades,
 * several original languages, and titles popular enough that a Turkish
 * subtitle exists. A corpus of one genre from one decade would answer a
 * narrower question than the one being asked. */
const WANTED = [
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
];

const QUOTA_FLOOR = 20;
const argOf = (name, fallback) => {
  const at = process.argv.indexOf(name);
  return at === -1 ? fallback : process.argv[at + 1];
};
const DRY = process.argv.includes("--dry");
const BUDGET = Number(argOf("--budget", 30));

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

function choose(results) {
  const usable = results.filter((r) => r.file_id);
  const by = (language) => usable
    .filter((r) => (r.language || "").toLowerCase() === language)
    .sort((a, b) => (b.match_score ?? 0) - (a.match_score ?? 0) || (b.download_count ?? 0) - (a.download_count ?? 0));

  const english = by("en");
  const turkish = by("tr");
  const picked = [];
  if (english[0]) picked.push({ ...english[0], why: "English, best match" });
  if (turkish[0]) picked.push({ ...turkish[0], why: "Turkish, cross-language pair" });
  // A second English from a DIFFERENT release: same words, different clock.
  const second = english.find((r) => english[0] && releaseKey(r) !== releaseKey(english[0]));
  if (second) picked.push({ ...second, why: "second English release, retiming pair" });
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
  const picked = choose(found.results || []);
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
      if (typeof got.remaining_quota === "number") quota = got.remaining_quota;
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
