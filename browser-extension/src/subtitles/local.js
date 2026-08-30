/* The daemon's job, done in the extension, for when the daemon is not running.
 *
 * Port of the Service class in subtitle-daemon/src/subtitle_daemon/server.py.
 * Same two-stage search, same ranking, same quota discipline, and the same
 * response envelope - so background.js can route a request to either side and
 * the panel cannot tell which answered.
 *
 * The one thing this cannot do is transcribe audio. When no subtitle exists
 * anywhere, that is still the daemon's job.
 */

import * as cache from "./cache.js";
import * as matching from "./matching.js";
import { Client, OpenSubtitlesError } from "./opensubtitles.js";
import { decode, parseSrt, toJson, toVtt } from "./srt.js";
import { guess, resolve } from "./titles.js";

export const DEFAULT_LANGUAGES = ["en"];

/* Only these survive into the cached envelope. The confidence flags are
 * conclusions about a result set, so they have to be replayed with it - a cache
 * hit that dropped them would render a low-confidence search as a confident
 * one. */
const CACHED_FIELDS = [
  "results",
  "resolved",
  "ambiguous_title",
  "other_titles",
  "low_confidence",
  "not_in_database",
  "error",
  "auto_attach_threshold",
];

/** 1 when the entry is the kind of thing we are looking for, else -1. */
const typeAgreement = (feature, wantSeries) => (feature.is_series === wantSeries ? 1 : -1);

/** 2 exact, 1 within a year, 0 unknown, -1 further away. A preference, not a filter. */
function yearAgreement(candidateYear, wanted) {
  if (wanted === null || wanted === undefined) return 0;
  if (candidateYear === null || candidateYear === undefined) return 0;
  const delta = Math.abs(candidateYear - wanted);
  if (delta === 0) return 2;
  if (delta <= 1) return 1;
  return -1;
}

/** 1 if the result is the requested episode, -1 if it is a different one. */
function episodeAgreement(item, season, episode) {
  if (season === null && episode === null) return 0;
  if (item.season === null && item.episode === null) return 0;
  const seasonOk = season === null || item.season === season;
  const episodeOk = episode === null || item.episode === episode;
  return seasonOk && episodeOk ? 1 : -1;
}

/** Lexicographic descending compare over a tuple of numbers, as Python sorts. */
function byTuple(keyOf) {
  return (a, b) => {
    const left = keyOf(a);
    const right = keyOf(b);
    for (let i = 0; i < left.length; i++) {
      const l = Number(left[i]);
      const r = Number(right[i]);
      if (l !== r) return r - l;
    }
    return 0;
  };
}

/** Python's round(x, 1), which is what the ranking buckets scores with. */
const bucket = (value) => Math.round(value * 10) / 10;

/* The entry /features would have returned for an id the page supplied.
 *
 * Everything downstream asks "was this title resolved?" and means "is this
 * result set this programme, or a fuzzy guess at it". An id from the page
 * answers yes as firmly as the index does, so it answers in the index's own
 * shape rather than through a second flag nothing else reads. The title is the
 * one the page announced, which is what the search asked for; the count is
 * zero because it is only ever used to break ties between rivals, and an id
 * has none. */
const statedFeature = (imdbId, title, year, season) => ({
  imdb_id: imdbId,
  title,
  year,
  feature_type: season === null ? "Movie" : "Episode",
  subtitles_count: 0,
  is_series: season !== null,
});

export class LocalService {
  constructor({ apiKey, languages = DEFAULT_LANGUAGES }) {
    this.client = apiKey ? new Client(apiKey) : null;
    this.languages = languages;
    // One download at a time. Two tabs asking for the same subtitle at once
    // would otherwise spend two units of a ten-per-day quota on one file.
    this.downloading = Promise.resolve();
  }

  get hasApiKey() {
    return Boolean(this.client);
  }

  /** Guess what is playing and find candidate subtitles. */
  async search(params = {}) {
    const rawTitle = params.title || "";
    const explicit = params.query || null;

    /* Both search paths resolve the same way, through the same function. This
     * copy is the one that matters most: it is what runs whenever the daemon is
     * not up, which is the ordinary case.
     *
     * It used to hold its own copy of the rule and was fixed five days after the
     * daemon's, which is the whole lesson - the daemon, the daemon's tests and
     * titles.js were all corrected and the path actually serving the reader was
     * not, so the reported bug survived a fix four suites agreed was complete. */
    const guessed = guess(explicit || rawTitle);
    const { query, year, season, episode } = resolve({
      title: rawTitle,
      query: explicit || "",
      year: params.year ?? null,
      season: params.season ?? null,
      episode: params.episode ?? null,
    });

    const languages = params.languages?.length ? params.languages : this.languages;
    const imdbId = params.imdb_id || null;

    const response = {
      guess: {
        query: guessed.query,
        year: guessed.year,
        season: guessed.season,
        episode: guessed.episode,
      },
      used: { query, year, season, episode, languages: [...languages] },
      results: [],
      served_by: "extension",
    };

    if (!query) {
      response.error = "no searchable title; type one in";
      return response;
    }
    if (!this.client) {
      response.error = "no OpenSubtitles API key set. Open the extension options and add one.";
      response.needs_api_key = true;
      return response;
    }

    const key = cache.searchKey({ query, languages, year, season, episode, imdbId });
    const cached = await cache.getSearch(key);
    if (cached) {
      const replayed = { ...response, ...cached, from_cache: true };
      // Except what is a fact about the download cache rather than about the
      // search - that is re-derived, never replayed. See applyCacheState.
      await applyCacheState(replayed, languages);
      return replayed;
    }

    let found;
    let resolved;
    let rivals;
    try {
      ({ found, resolved, rivals } = await this.searchUpstream({
        query,
        languages,
        year,
        season,
        episode,
        imdbId,
      }));
    } catch (error) {
      response.error = error.message;
      if (error.quotaExceeded) response.quota_exceeded = true;
      return response;
    }

    if (resolved) {
      response.resolved = {
        title: resolved.title,
        year: resolved.year,
        imdb_id: resolved.imdb_id,
        type: resolved.feature_type,
      };
      /* Titles this common cannot be resolved from the title alone. Say so and
       * hand over the alternatives, rather than presenting a coin toss as an
       * answer. */
      if (rivals.length) {
        response.ambiguous_title = true;
        response.other_titles = rivals.map((other) => ({
          title: other.title,
          year: other.year,
          imdb_id: other.imdb_id,
          type: other.feature_type,
        }));
      }
    } else if (!found.length) {
      /* /features knows the whole catalogue. If it has never heard of the
       * title, no query rewriting will help - the subtitles do not exist. */
      response.error =
        `OpenSubtitles has no subtitles for "${query}". ` +
        "Check the title, or transcribe the audio instead.";
      response.not_in_database = true;
      return response;
    }

    const results = found.map((item) => ({
      ...item,
      match_score: matching.bestScore(query, [item.movie_name || "", item.release || ""], {
        queryYear: year,
        candidateYear: item.year,
      }),
    }));

    /* Rank by match first. OpenSubtitles' own ordering is fuzzy enough to put
     * an unrelated film on top, which is how "Ekusute" got downloaded for a
     * Crime 101 search. Episode agreement outranks everything: for a series
     * every result scores the same on title, and uploads mislabelled with the
     * wrong episode are common enough to put the wrong instalment first. */
    results.sort(
      byTuple((item) => [
        episodeAgreement(item, season, episode),
        bucket(item.match_score),
        item.from_trusted ? 1 : 0,
        item.download_count,
      ]),
    );

    const plausible = results.filter((item) => item.match_score >= matching.VISIBLE_THRESHOLD);
    if (plausible.length) {
      response.results = plausible;
    } else {
      // Nothing resembles the query. Show a few anyway - the title guess may be
      // wrong rather than the film missing - but say so.
      response.results = results.slice(0, 5);
      response.low_confidence = true;
    }

    response.auto_attach_threshold = matching.AUTO_ATTACH_THRESHOLD;

    // Stored before the cache state is applied, so what is kept is the upstream
    // answer in upstream order.
    const envelope = {};
    for (const field of CACHED_FIELDS) {
      if (field in response) envelope[field] = response[field];
    }
    await cache.putSearch(key, envelope);

    await applyCacheState(response, languages);
    return response;
  }

  /**
   * Resolve the title, then search for it exactly.
   *
   * @see applyCacheState for why the download-cache annotations are not done here.
   *
   * `/subtitles?query=` is fuzzy and always returns something, so it cannot
   * distinguish "wrong title" from "not in the database". `/features` can: it
   * is the title index. Both calls are free - only downloading is metered.
   */
  async searchUpstream({ query, languages, year, season, episode, imdbId }) {
    /* An id names one thing, so it is asked for by itself.
     *
     * The season and episode do not go with it. `imdb_id` matches a feature,
     * and for an episode the feature IS the episode - the numbers are already
     * in it. Sending both is a combination the API does not document, and the
     * failure would be silent: an empty result set that reads as "nobody has
     * subtitled this". They still travel in `used`, where the episode filter
     * and the "which episode is this" guard read them.
     *
     * `resolved` is stated rather than left null, and that is the difference
     * between this path working and only looking as though it does. A result
     * set with no resolved title is scored against the uploader's file name
     * and refused below the threshold - the refusal planAutoAttach describes
     * at length, on a search that by construction cannot have found the wrong
     * programme. The id came from the page; every row is that programme.
     *
     * And an id that turns up nothing falls through to the title path rather
     * than reporting "not in the database". The id is a shortcut, not the only
     * route, and it can be right about the film while OpenSubtitles has it
     * indexed under a parent it does not share. */
    if (imdbId) {
      const found = await this.client.search({ imdbId, languages });
      if (found.length) return { found, resolved: statedFeature(imdbId, query, year, season), rivals: [] };
    }

    const { best: resolved, rivals } = await this.pickFeature(query, year, season !== null);

    if (resolved) {
      let found;
      if (resolved.is_series) {
        found = await this.client.search({
          parentImdbId: resolved.imdb_id,
          languages,
          season,
          episode,
        });
        // A series matched but the episode has no subtitles: fall back to the
        // show as a whole rather than reporting nothing.
        if (!found.length && (season !== null || episode !== null)) {
          found = await this.client.search({ parentImdbId: resolved.imdb_id, languages });
        }
      } else {
        found = await this.client.search({ imdbId: resolved.imdb_id, languages });
      }
      if (found.length) return { found, resolved, rivals };
    }

    // No confident title match. Narrow by media type so a film search does not
    // drown in episodes that merely share a word.
    const mediaType = season !== null ? "episode" : "movie";
    let found = await this.client.search({ query, languages, year, season, episode, mediaType });
    if (found.length) return { found, resolved, rivals };

    // Last resort: unfiltered. Catches series searched without an episode
    // number, and anything the type filter misclassifies.
    found = await this.client.search({ query, languages, year, season, episode });
    return { found, resolved, rivals };
  }

  /**
   * Best index entry for the query, plus any equally-good rivals.
   *
   * A common title is not a rare case. "Mercy" matches eighteen entries
   * exactly, so title similarity alone cannot choose and whatever breaks the
   * tie IS the answer. Breaking it on subtitle count returned a 2016 television
   * episode for a 2025 film, so it is broken on identity instead: the right
   * kind of thing, and how close the year is.
   */
  async pickFeature(query, year, wantSeries) {
    let candidates;
    try {
      candidates = await this.client.features(query);
    } catch {
      // The index is an optimisation, not a requirement. Losing it costs
      // precision, not the search.
      return { best: null, rivals: [] };
    }

    /* Title similarity only. Feeding the year in here would apply the scorer's
     * clash penalty, and a one-year disagreement is normal enough that it
     * dropped an exact title below the threshold and resolved to nothing. */
    const scored = candidates
      .filter((feature) => feature.subtitles_count > 0)
      .map((feature) => ({ score: matching.score(query, feature.title), feature }));
    if (!scored.length) return { best: null, rivals: [] };

    const rank = ({ score, feature }) => [
      bucket(score),
      typeAgreement(feature, wantSeries),
      yearAgreement(feature.year, year),
      feature.subtitles_count,
    ];

    scored.sort(byTuple(rank));
    if (scored[0].score < matching.AUTO_ATTACH_THRESHOLD) return { best: null, rivals: [] };

    // Anything indistinguishable from the winner on every signal except
    // popularity is a rival, not a runner-up.
    const top = rank(scored[0]).slice(0, 3).join("|");
    const rivals = scored
      .slice(1)
      .filter((pair) => rank(pair).slice(0, 3).join("|") === top)
      .slice(0, 5)
      .map((pair) => pair.feature);

    return { best: scored[0].feature, rivals };
  }

  /** Return cues for a file_id, downloading only if not already held. */
  async fetch(body = {}) {
    const fileId = body.file_id;
    if (!Number.isInteger(fileId)) return { error: "file_id must be an integer" };

    const held = await cache.getSubtitle(fileId);
    if (held) return cuesResponse(held.bytes, held.meta, true);

    if (!this.client) {
      return {
        error: "no OpenSubtitles API key set. Open the extension options and add one.",
        needs_api_key: true,
      };
    }

    // Serialised, for the same reason the daemon serialises it.
    const previous = this.downloading;
    let release;
    this.downloading = new Promise((resolve) => {
      release = resolve;
    });
    try {
      await previous;

      const again = await cache.getSubtitle(fileId);
      if (again) return cuesResponse(again.bytes, again.meta, true);

      let downloaded;
      try {
        downloaded = await this.client.download(fileId);
      } catch (error) {
        if (error instanceof OpenSubtitlesError) {
          return error.quotaExceeded
            ? { error: error.message, quota_exceeded: true }
            : { error: error.message };
        }
        throw error;
      }

      /* Context from the caller, so the cache knows which film this belongs to.
       * Without it a later search for the same title cannot tell that it is
       * already downloaded. */
      const meta = {
        file_id: fileId,
        file_name: downloaded.fileName,
        remaining_quota: downloaded.remaining,
        imdb_id: body.imdb_id || null,
        language: body.language || null,
        movie_name: body.movie_name || null,
        release: body.release || null,
      };
      const stored = await cache.putSubtitle(fileId, downloaded.content, meta);
      return cuesResponse(stored.bytes, stored.meta, false);
    } finally {
      release();
    }
  }

  async cachedList() {
    const records = await cache.listMeta();
    return { subtitles: records.map((item) => ({ file_id: item.file_id, ...item.meta })) };
  }

  async cachedOne(fileId) {
    const held = await cache.getSubtitle(fileId);
    if (!held) return { error: "not cached" };
    return cuesResponse(held.bytes, held.meta, true);
  }
}

/**
 * Mark what is already downloaded, and float it to the top.
 *
 * Deliberately *not* stored with the search envelope, and re-run on every reply
 * including a replayed one. Both of these are facts about the download cache,
 * not about the search, and the envelope lives for six hours - long enough for
 * anything to have been downloaded or deleted since.
 *
 * Frozen into the envelope they went stale immediately, and the cost was the
 * thing the cache exists to prevent: search, download something from the panel,
 * search again, and the replay still ranked a *different* upload of the same
 * film first. Auto-attach took it and spent one of ten daily downloads on a
 * subtitle already held.
 */
async function applyCacheState(response, languages) {
  const results = response.results;
  if (!Array.isArray(results)) return;

  const held = await cache.listMeta();
  const onDisk = new Set(held.map((item) => item.file_id));
  for (const item of results) item.cached = onDisk.has(item.file_id);

  // A held file costs nothing, so auto-attach should reach for it before
  // spending a download on another upload of the same film.
  const owned = await cache.findForTitle(response.resolved?.imdb_id || null, languages);
  const at = owned ? results.findIndex((item) => item.file_id === owned.file_id) : -1;

  if (at !== -1) {
    if (at > 0) results.unshift(results.splice(at, 1)[0]);
    response.reusing_cached = true;
  } else {
    // Both directions: a promotion that no longer applies has to go, or a
    // deleted subtitle would still be advertised as held.
    delete response.reusing_cached;
  }
}

/* `vtt` is built only when it is asked for.
 *
 * It was in every reply, and nothing in the extension has ever read it: the
 * overlay draws from `cues` and there is no <track> anywhere. Measured on a
 * 1,154-line subtitle, that was 85KB of string built in 3.7ms on every fetch -
 * including every cache hit - and then serialised across the worker-to-page
 * message boundary before being dropped. It stays available for a caller that
 * wants it, because the daemon's reply has the field and parity is the point.
 */
export function cuesResponse(raw, meta, fromCache, { vtt = false } = {}) {
  const bytes = raw instanceof Uint8Array ? raw : new Uint8Array(raw);
  const { text, encoding } = decode(bytes);
  const cues = parseSrt(text);
  const response = {
    meta: { ...meta, encoding, cue_count: cues.length },
    cues: toJson(cues),
    from_cache: fromCache,
    served_by: "extension",
  };
  if (vtt) response.vtt = toVtt(cues);
  return response;
}
