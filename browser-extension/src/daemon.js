/* Client for the local subtitle-daemon.
 *
 * The daemon is preferred but no longer required: provider.js falls back to
 * doing the same work inside the extension when nothing is listening on the
 * port. This file is only the daemon half of that - it should keep throwing
 * DaemonDownError rather than handling the fallback itself, so there is exactly
 * one place that decides which side answers.
 */

export const DAEMON_ORIGIN = "http://127.0.0.1:8791";

export class DaemonDownError extends Error {
  constructor(message) {
    super(message || "The subtitle daemon is not running. Start it with subtitle-daemon/run.sh");
    this.name = "DaemonDownError";
  }
}

/* Something is listening on the port and it is not the daemon.
 *
 * Worth its own words rather than the message above, because the advice
 * differs: starting the daemon on top of this fails with the port already in
 * use, and the reader has to find what is holding it first. */
const FOREIGN = `Something other than the subtitle daemon is listening on ${DAEMON_ORIGIN}.`;

async function call(path, options = {}) {
  let response;
  try {
    response = await fetch(`${DAEMON_ORIGIN}${path}`, options);
  } catch {
    // fetch only rejects on a transport failure, which here means nothing is
    // listening on the port. Distinguish it so the UI can say something useful
    // instead of "failed to fetch".
    throw new DaemonDownError();
  }

  const payload = await response.json().catch(() => ({}));
  if (!response.ok && !payload.error) {
    throw new Error(`Daemon returned HTTP ${response.status}`);
  }
  return payload;
}

/* Whether the daemon is there - and it has to be the daemon, not merely an
 * answer.
 *
 * The probe asked "did something reply". Ports collide, and this one is 8791 on
 * the reader's own machine: a dev server left running there answers 200 with
 * its index page for every path it does not know, so nothing fails, nothing
 * parses, and every search went to it and came back empty while the
 * extension's own search - which works, and is the ordinary path now - never
 * ran. It reads as "no subtitles for anything" with nothing saying why.
 * `python3 -m http.server` on the same port is the other shape, answering 404,
 * and was already observed once - see study.js on the same port.
 *
 * `default_languages` is the cheapest thing in the reply that a page cannot
 * produce by accident: the daemon always sends the list, and a document, an
 * empty body and an unrelated JSON API all fail it. */
export async function health() {
  let payload;
  try {
    payload = await call("/health");
  } catch (error) {
    // An HTTP error from /health is something else on the port, not a daemon
    // with a problem - the daemon has no failing path here.
    throw error instanceof DaemonDownError ? error : new DaemonDownError(FOREIGN);
  }
  if (!Array.isArray(payload.default_languages)) throw new DaemonDownError(FOREIGN);
  return payload;
}

/** Search for subtitles. Free — this never costs download quota. */
export function search({ title, query, languages, year, season, episode }) {
  const params = new URLSearchParams();
  if (title) params.set("title", title);
  if (query) params.set("query", query);
  if (languages?.length) params.set("languages", languages.join(","));
  if (year) params.set("year", String(year));
  if (season != null) params.set("season", String(season));
  if (episode != null) params.set("episode", String(episode));
  return call(`/search?${params.toString()}`);
}

/**
 * Fetch cues for a file_id. Costs one unit of daily quota on a cache miss.
 *
 * `context` tells the daemon which film the file belongs to. Without it the
 * cache cannot recognise that a later search for the same title is asking for
 * something already downloaded, and a second upload of the same film would
 * cost another download.
 */
export function fetchSubtitle(fileId, context = {}) {
  return call("/fetch", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ file_id: fileId, ...context }),
  });
}

/** The title context to record alongside a downloaded subtitle. */
export function subtitleContext(result, resolved) {
  return {
    imdb_id: resolved?.imdb_id || null,
    language: result.language || null,
    movie_name: result.movie_name || null,
    release: result.release || null,
  };
}

/**
 * A word's dictionary entry, and its translation when the daemon has a
 * translator configured. Free, cached daemon-side, no download quota involved.
 */
export function lookup(query, language = "en", target = "") {
  const params = new URLSearchParams({ q: query, lang: language });
  if (target) params.set("to", target);
  return call(`/lookup?${params.toString()}`);
}

export function cached() {
  return call("/cached");
}

/** One cached subtitle. `content` also returns the raw bytes, base64, for sync. */
export function cachedOne(fileId, { content = false } = {}) {
  return call(`/cached/${fileId}${content ? "?content=1" : ""}`);
}

/** Delete one subtitle from the daemon's cache. */
export function forget(fileId) {
  return call(`/cached/${fileId}`, { method: "DELETE" });
}

/** Delete everything, or only the cached searches. */
export function forgetAll({ searchesOnly = false } = {}) {
  return call(`/cached${searchesOnly ? "?searches_only=1" : ""}`, { method: "DELETE" });
}

/** Hand the daemon a subtitle the extension downloaded while it was stopped. */
export function importSubtitle(body) {
  return call("/cached", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

/* Offsets are stored per subtitle file, not per page: the correction belongs to
 * the subtitle's timing, so it should follow that file to any tab. */
export function offsetKey(fileId) {
  return `sso:offset:${fileId}`;
}

// --- talking to the page ----------------------------------------------------

async function frameIds(tabId) {
  const frames = await chrome.webNavigation?.getAllFrames?.({ tabId }).catch(() => null);
  return frames ? frames.map((frame) => frame.frameId) : [undefined];
}

function options(frameId) {
  return frameId === undefined ? {} : { frameId };
}

/** Push cues into the content script, trying every frame until one takes them. */
export async function attachToTab(tabId, { cues, label, fileId, language, slot = 0 }) {
  let lastReason = "no frame on this page has a playable video";

  for (const frameId of await frameIds(tabId)) {
    try {
      const result = await chrome.tabs.sendMessage(
        tabId,
        { type: "sso:attach", payload: { cues, label, fileId, language, slot } },
        options(frameId),
      );
      if (result?.ok) return result;
      if (result?.reason) lastReason = result.reason;
    } catch {
      // Frame has no content script (chrome:// pages, cross-origin edge cases).
    }
  }
  throw new Error(lastReason);
}

/* Ask every frame for status; return the first one that holds a video.
 *
 * A frame drawing the controls for a video in another frame answers with that
 * video's state and says `mirrored`, which is what the panel it draws needs and
 * exactly the wrong answer here: an attach or a detach sent to it would arrive
 * at a document with no video in it. So the search is for the frame that
 * actually holds the film, and where the controls are is reported alongside
 * rather than instead - the keyboard shortcut that opens the panel needs it.
 */
export async function tabStatus(tabId) {
  let fallback = null;
  let chromeFrameId = null;
  let found = null;
  for (const frameId of await frameIds(tabId)) {
    try {
      const status = await chrome.tabs.sendMessage(tabId, { type: "sso:status" }, options(frameId));
      if (status?.mirrored) {
        chromeFrameId = frameId;
        continue;
      }
      if (status?.hasVideo && !found) {
        found = { ...status, frameId };
        // Both answers are wanted, and the order frames arrive in is not
        // promised - so stop early only once the other one is in hand.
        if (chromeFrameId != null) break;
        continue;
      }
      if (status && !fallback) fallback = { ...status, frameId };
    } catch {
      // no content script in this frame
    }
  }
  const answer = found || fallback;
  return answer && { ...answer, chromeFrameId };
}

/**
 * The best guess at what the tab is playing.
 *
 * The tab title is the weakest signal available: Prime Video titles a detail
 * page "Prime Video: Crime 101", and other sites bolt on episode numbers and
 * marketing. og:title and JSON-LD are what the site tells crawlers the page is
 * about, so the content script's candidates are preferred and the tab title is
 * only the fallback.
 */
/* How much a source is worth, low is better. Structured metadata is what the
 * site tells crawlers the page is about; a document title is whatever the page
 * felt like calling itself. */
/* The series outranks the episode's own name, and that order is the point.
 *
 * An episode page states two names: "Baggage" and "The Americans". Only the
 * second one can be searched - subtitles are indexed under the series, with the
 * season and episode as numbers beside it, so the episode's own title is the
 * one piece of the metadata that cannot be used to find anything. Reported as
 * a local catalogue app whose search went out as "Baggage".
 *
 * `json-ld-series` only exists when the page said `partOfSeries`, so this
 * cannot affect a film. */
const SOURCE_RANK = {
  "json-ld-series": 0,
  "json-ld": 1,
  "og:title": 2,
  "twitter:title": 3,
  /* What the page told the browser it is playing. A statement, like the two
   * above and unlike the two below - but an untyped one, since no standard
   * says which of the three fields carries the programme's name. */
  "mediaSession.title": 4,
  "mediaSession.artist": 5,
  "mediaSession.album": 6,
  h1: 7,
  "document.title": 8,
};

/**
 * What the tab is playing, gathered from every frame at once.
 *
 * This does not choose a frame, and that is the whole point. Choosing one is
 * wrong in both directions, measured on the same site: a player embedded from
 * one host titles its frame "The Americans (2013) (2013) S01E01" - the only
 * place on the page that names the episode - while the same site's other player
 * has an empty title, and the page's own metadata is the only thing left. Ask
 * for the top frame and the first case loses its episode; ask for the video's
 * frame and the second case falls back to the tab title and resolves nothing.
 *
 * So every frame contributes candidates and the choice is made between the
 * candidates. One that names an episode wins, because that is the fact which
 * cannot be recovered further down the pipeline - a title can be cleaned up,
 * a missing episode number cannot be guessed.
 */
export async function pageContextForTab(tab, videoFrameId = null) {
  const reports = [];
  for (const frameId of await frameIds(tab.id)) {
    try {
      const info = await chrome.tabs.sendMessage(tab.id, { type: "sso:pageInfo" }, options(frameId));
      if (info?.candidates) reports.push({ frameId, info });
    } catch {
      // A frame with no content script contributes nothing, which is fine.
    }
  }

  const candidates = reports.flatMap(({ frameId, info }) =>
    info.candidates.map((candidate) => ({ ...candidate, frameId, year: info.year ?? null })),
  );

  candidates.sort((a, b) => {
    const byEpisode = Number(Boolean(b.episode)) - Number(Boolean(a.episode));
    if (byEpisode !== 0) return byEpisode;
    const rank = (SOURCE_RANK[a.source] ?? 9) - (SOURCE_RANK[b.source] ?? 9);
    if (rank !== 0) return rank;
    // Among equals, the frame holding the video is describing what is loaded.
    return Number(b.frameId === videoFrameId) - Number(a.frameId === videoFrameId);
  });

  const best = candidates[0];
  const episode = pickEpisode(reports, videoFrameId);

  return {
    // The tab title is the last resort and a worse signal than any of the
    // above, so it is worth knowing in the report when it was what got used.
    title: best?.text || tab.title || "",
    titleSource: best ? `${best.source} (frame ${best.frameId})` : "tab.title (fallback)",
    // The year travels with the title. Without it a common name like "Mercy"
    // cannot be resolved to one film - the index holds eighteen of them.
    year: best?.year ?? reports.map((r) => r.info.year).find((y) => y != null) ?? null,
    season: episode?.season ?? null,
    episode: episode?.episode ?? null,
    episodeSource: episode?.source ?? null,
    candidateCount: candidates.length,
    framesAsked: reports.length,
    /* What the page actually offered, not just how many things it offered.
     *
     * The count alone cannot answer the question it gets asked. Recorded on
     * 2026-08-12: auto-attach refused with `Nothing matched "The Americans Full
     * Episodes"`, context `candidateCount: 4, episodeSource: null` - four
     * candidates, and no way to tell whether the page named the episode
     * somewhere this missed, or genuinely never said. Those are different bugs
     * and the log could not separate them.
     *
     * Capped and trimmed: this rides every autoAttach entry, and the entry
     * already carries the ranked results. */
    candidates: candidates.slice(0, 8).map((candidate) => ({
      source: candidate.source,
      frameId: candidate.frameId,
      text: String(candidate.text || "").slice(0, 120),
      episode: candidate.episode ?? null,
    })),
  };
}

/* Which statement about the episode to believe, most authoritative first.
 *
 * The player's own frame title outranks the page, because it describes what was
 * actually loaded into the player - if a viewer picked one episode and the
 * embed served another, that is the one on screen. Structured metadata comes
 * next: a page that states `episodeNumber` is not guessing, and it is the only
 * source here that cannot be confused by a digit in a title. Then the marked
 * control: it is what the viewer chose, and on a site whose player says nothing
 * it is the only answer there is.
 */
function pickEpisode(reports, videoFrameId) {
  const at = (frameId) => reports.find((report) => report.frameId === frameId)?.info.episode;
  const fromVideoTitle = at(videoFrameId)?.fromTitle;
  if (fromVideoTitle) return { ...fromVideoTitle, source: "the player frame's title" };

  for (const key of ["fromMetadata", "fromMarker", "fromTitle", "fromUrl"]) {
    const hit = reports.map((report) => report.info.episode?.[key]).find(Boolean);
    if (hit) {
      return {
        ...hit,
        source: {
          fromMetadata: "the page's schema.org metadata",
          fromMarker: "the control marked as chosen on the page",
          fromTitle: "a frame title",
          fromUrl: "the address",
        }[key],
      };
    }
  }
  return null;
}

/**
 * Choose the subtitle to attach without asking.
 *
 * Language preference wins first — an excellent subtitle in the wrong language
 * is not a result. Then how well it matches what was asked for, because
 * OpenSubtitles' fuzzy search will confidently return an unrelated film. Only
 * then does "already downloaded" break ties, since preferring a cached file
 * over a better match would keep re-attaching the wrong subtitle.
 *
 * The caller still has to check `match_score` against the threshold: this
 * returns the best candidate, not necessarily a good one.
 */
export function pickBest(results, languages) {
  if (!results?.length) return null;

  const languageRank = (result) => {
    const index = languages.indexOf(result.language);
    return index === -1 ? languages.length : index;
  };

  return [...results].sort((a, b) => {
    const byLanguage = languageRank(a) - languageRank(b);
    if (byLanguage !== 0) return byLanguage;

    // Bucket the score so near-equal matches fall through to the daemon's
    // trust-and-popularity ordering rather than splitting hairs.
    const byScore = Math.round((b.match_score ?? 0) * 10) - Math.round((a.match_score ?? 0) * 10);
    if (byScore !== 0) return byScore;

    return Number(Boolean(b.cached)) - Number(Boolean(a.cached));
  })[0];
}

/**
 * The second language of a pair, and why there is not one.
 *
 * Reported: "I am using EN+TR subtitle pair but next time either TR or both are
 * not loaded. I need to add manually each time."
 *
 * `match_score` compares the query against the uploader's own movie_name and
 * release string. That is the right guard for the FIRST subtitle, where it is
 * all that stands between a fuzzy search and an unrelated film. It is close to
 * meaningless for the second: once the search has resolved to an imdb id every
 * result in the response is already this title, and what the score then
 * measures is how a Turkish uploader chose to name their file. A Turkish
 * release named in Turkish scores badly against an English query and was
 * dropped - silently, which was the other half of the report.
 *
 * So with a resolved title the second language is judged on the thing the name
 * score cannot see and that actually matters: whether it is the episode being
 * watched. pickBest ranks by language and score and does NOT require episode
 * agreement, so the filter happens before it rather than being trusted to it.
 * Without a resolved title there is no such guarantee and the score is still
 * the only guard there is.
 *
 * The same reasoning now covers the FIRST subtitle - see planAutoAttach in
 * background.js. It was written here because this is where the silence was
 * reported; it was never true only of the second one.
 *
 * Returns `{ result, reason }`. `reason` is empty when a subtitle was found and
 * otherwise says what to do about it, because silence here reads as the pair
 * being broken rather than as one language being unavailable.
 */
/**
 * The results that are the episode being watched.
 *
 * "The result does not say" is not a mismatch: an upload carrying no episode
 * metadata cannot be ruled out by it. With nothing asked for, every result
 * qualifies.
 *
 * One function, because both halves of a pair need the same answer and a
 * second copy of this rule is how the two come to disagree - and because a
 * search that resolved to a title can still hand back other episodes. When the
 * episode has no subtitles at all the daemon falls back to the series as a
 * whole rather than reporting nothing, so "resolved" and "the right instalment"
 * are two questions, not one.
 */
export function forEpisode(results, used) {
  const list = results || [];
  if (used?.season == null && used?.episode == null) return [...list];
  return list.filter((item) => {
    if (item.season == null && item.episode == null) return true;
    return (
      (used.season == null || item.season === used.season) &&
      (used.episode == null || item.episode === used.episode)
    );
  });
}

export function pickSecondLanguage({ results, languages, taken, used, resolved, threshold, query }) {
  const others = (languages || []).filter((language) => language !== taken);
  if (!others.length) return { result: null, reason: "" };

  let reason = `no ${others.join(" or ").toUpperCase()} subtitle came back for this`;
  for (const language of others) {
    const inLanguage = (results || []).filter((r) => r.language === language);
    if (!inLanguage.length) continue;
    const usable = forEpisode(inLanguage, used);
    if (!usable.length) {
      reason = `every ${language.toUpperCase()} subtitle found is for another episode`;
      continue;
    }
    const pick = pickBest(usable, [language]);
    if (!pick) continue;
    if (resolved || (pick.match_score ?? 0) >= threshold) return { result: pick, reason: "" };
    reason = `no ${language.toUpperCase()} subtitle matched ${JSON.stringify(query)} well enough`;
  }
  return { result: null, reason };
}
