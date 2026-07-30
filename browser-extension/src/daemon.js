/* Client for the local subtitle-daemon, shared by the popup and the service
 * worker.
 *
 * The extension never talks to OpenSubtitles directly. Everything goes through
 * the daemon so the API key stays out of the browser and the download cache is
 * shared across tabs, reloads and extension restarts.
 */

export const DAEMON_ORIGIN = "http://127.0.0.1:8791";

export class DaemonDownError extends Error {
  constructor() {
    super("The subtitle daemon is not running. Start it with subtitle-daemon/run.sh");
    this.name = "DaemonDownError";
  }
}

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

export function health() {
  return call("/health");
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

export function cached() {
  return call("/cached");
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
export async function attachToTab(tabId, { cues, label, fileId }) {
  let lastReason = "no frame on this page has a playable video";

  for (const frameId of await frameIds(tabId)) {
    try {
      const result = await chrome.tabs.sendMessage(
        tabId,
        { type: "sso:attach", payload: { cues, label, fileId } },
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

/** Ask every frame for status; return the first one that holds a video. */
export async function tabStatus(tabId) {
  let fallback = null;
  for (const frameId of await frameIds(tabId)) {
    try {
      const status = await chrome.tabs.sendMessage(tabId, { type: "sso:status" }, options(frameId));
      if (status?.hasVideo) return { ...status, frameId };
      if (status && !fallback) fallback = { ...status, frameId };
    } catch {
      // no content script in this frame
    }
  }
  return fallback;
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
export async function bestTitleForTab(tab, frameId) {
  try {
    const info = await chrome.tabs.sendMessage(
      tab.id,
      { type: "sso:pageInfo" },
      options(frameId),
    );
    const best = info?.candidates?.[0]?.text;
    if (best) return best;
  } catch {
    // No content script, or the frame went away.
  }
  return tab.title || "";
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
