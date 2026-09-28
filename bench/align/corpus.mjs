/* The corpus every alignment method is judged on, and where its labels come from.
 *
 * Two rules decide everything here.
 *
 * A pair's label is DERIVED, never hand-written. Every cached download carries
 * the `movie_name` it was fetched under, so "these two are the same film" is
 * something the files say about themselves. The alternative was tried and
 * rotted: a hand-kept list against a cache that grows every time somebody
 * watches something ends up calling correct answers failures. See
 * subtitle-daemon/tests/test_align.py, which learned this the same way.
 *
 * A file with no derivable identity is REFUSED, not guessed at. Anything else
 * makes it silently "a different film from everything", which is 53 wrong
 * labels from one missing field.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { readCues, normalise } from "./srt.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const REPO = path.resolve(HERE, "../..");
const CACHE = path.join(REPO, "subtitle-daemon/cache/subtitles");
const VIEWER = path.join(REPO, "srt-viewer/subtitles");

/* Both directories are local: the cache is filled by use, and the viewer's
 * corpus is copyrighted film subtitles kept out of the repository. A fresh
 * clone has neither, and gets an empty corpus rather than a crash. */
const srts = (dir) => (fs.existsSync(dir) ? fs.readdirSync(dir).filter((f) => f.endsWith(".srt")).sort() : []);

/* Identities the bench recorded for itself.
 *
 * A subtitle fetched straight from the daemon comes back with `movie_name`
 * null - the extension fills that in from the search result at attach time, and
 * there is no attach step here - so the corpus grown by `expand.mjs` carries
 * its labels in this file instead. Written by the thing that did the searching,
 * which is the only thing that knows what it was looking for. */
function recorded() {
  try {
    return JSON.parse(fs.readFileSync(path.join(HERE, "labels.json"), "utf8"));
  } catch {
    return {};
  }
}

/* Downloads whose sidecar carries no identity at all. Named here so a new one
 * fails loudly in `check()` rather than quietly becoming a negative pair
 * against all 53 others. */
const NO_METADATA = {
  11911329: "mercy 2026",
  12466148: "crime 101 2026",
};

/* Same episode, different cut - a divergence no single shift can fix. Metadata
 * cannot express this, so it stays a hand-kept list, and pairs in it are judged
 * on their own rather than counted as same-film or different-film.
 *
 * 3637194 against 12574865 runs from about +1.3s at the start to +21s at the
 * end. Which files it DOES line up with is the evidence: the two Turkish files
 * timed from the same cut, and neither English one. */
export const DIFFERENT_CUT = [
  ["3637194", "12574865"],
  ["3637194", "8036186"],
];

const MIN_CUES = 12;

/* Timings, the text each timing carries, and the language the text is in.
 *
 * This used to read latin-1 and keep only the timestamps, which is all the
 * scoring needs. The words are here now because the bench acquired a ground
 * truth that is derived from them (truth.mjs) and because the sidecars turned
 * out to carry `language: null` for every file downloaded while watching - so
 * "is this pair cross-language?" was a question the corpus could not answer
 * about most of itself. Reading 96 files properly costs about a second. */
function read(file) {
  const { cues, language } = readCues(file);
  return {
    spans: cues.map((cue) => [cue.start, cue.end]),
    cues: cues.map((cue) => ({ start: cue.start, end: cue.end, key: normalise(cue.text) })),
    language,
  };
}

const tidy = (s) => String(s || "").replace(/\s+/g, " ").trim().toLowerCase();

export function load() {
  const files = new Map();
  const noted = recorded();

  for (const name of srts(CACHE)) {
    const id = name.slice(0, -4);
    const { spans, cues, language } = read(path.join(CACHE, name));
    if (spans.length < MIN_CUES) continue;
    let sidecar = {};
    const beside = path.join(CACHE, `${id}.json`);
    if (fs.existsSync(beside)) {
      try { sidecar = JSON.parse(fs.readFileSync(beside, "utf8")); } catch { sidecar = {}; }
    }
    files.set(id, {
      id,
      spans,
      cues,
      film: NO_METADATA[id] || tidy(noted[id]?.film) || tidy(sidecar.movie_name) || null,
      /* Whoever wrote it down beats whatever the words look like, but the
       * words beat nothing at all - and nothing at all is what the sidecar
       * holds for every file the reader downloaded while watching. */
      language: noted[id]?.language || sidecar.language || language,
      release: noted[id]?.release || sidecar.release || sidecar.file_name || null,
      from: "cache",
    });
  }

  for (const name of srts(VIEWER)) {
    const { spans, cues } = read(path.join(VIEWER, name));
    if (spans.length < MIN_CUES) continue;
    const episode = name.includes("S00E01") ? "S00E01" : "S00E02";
    const language = name.includes("-EN") ? "en" : "tr";
    const id = `BSG.${episode}-${language.toUpperCase()}`;
    // No sidecar here; the filename is the metadata.
    files.set(id, { id, spans, cues, film: `bsg ${episode.toLowerCase()}`, language, release: name, from: "viewer" });
  }

  if (files.size < 2) {
    console.error(`nothing to compare: ${files.size} subtitle(s) in ${path.relative(REPO, CACHE)}/ and ${path.relative(REPO, VIEWER)}/, both local - see bench/align/README.md`);
    process.exit(1);
  }
  return files;
}

/** Every unordered pair, labelled same / different / cut. */
export function pairs(files) {
  const cut = new Set(DIFFERENT_CUT.flatMap(([a, b]) => [`${a}|${b}`, `${b}|${a}`]));
  const ids = [...files.keys()].sort();
  const out = [];
  for (let i = 0; i < ids.length; i++) {
    for (let j = i + 1; j < ids.length; j++) {
      const a = files.get(ids[i]);
      const b = files.get(ids[j]);
      const key = `${a.id}|${b.id}`;
      const label = cut.has(key) ? "cut" : a.film && b.film && a.film === b.film ? "same" : "different";
      out.push({ key, a, b, label });
    }
  }
  return out;
}

/** Refuse to run on a corpus that cannot be labelled. */
export function check(files) {
  const nameless = [...files.values()].filter((f) => !f.film).map((f) => f.id);
  if (nameless.length) {
    throw new Error(
      `no identity for ${nameless.join(", ")} - add each to NO_METADATA in ` +
      `bench/align/corpus.mjs, or every pair it forms is labelled "different film"`,
    );
  }
  const groups = new Map();
  for (const f of files.values()) groups.set(f.film, (groups.get(f.film) || 0) + 1);
  return {
    files: files.size,
    films: groups.size,
    withCompany: [...groups.values()].filter((n) => n > 1).length,
    languages: new Set([...files.values()].map((f) => f.language).filter(Boolean)).size,
  };
}
