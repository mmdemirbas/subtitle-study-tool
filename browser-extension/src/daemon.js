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

/** Fetch cues for a file_id. Costs one unit of daily quota on a cache miss. */
export function fetchSubtitle(fileId) {
  return call("/fetch", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ file_id: fileId }),
  });
}

export function cached() {
  return call("/cached");
}

/* Offsets are stored per subtitle file, not per page: the correction belongs to
 * the subtitle's timing, so it should follow that file to any tab. */
export function offsetKey(fileId) {
  return `sso:offset:${fileId}`;
}

/** Push cues into the content script, trying every frame until one takes them. */
export async function attachToTab(tabId, { cues, label, fileId }) {
  const payload = {
    cues,
    label,
    storageKey: offsetKey(fileId),
  };

  const frames = await chrome.webNavigation?.getAllFrames?.({ tabId }).catch(() => null);
  const frameIds = frames ? frames.map((frame) => frame.frameId) : [undefined];

  let lastReason = "no frame on this page has a playable video";
  for (const frameId of frameIds) {
    try {
      const options = frameId === undefined ? {} : { frameId };
      const result = await chrome.tabs.sendMessage(
        tabId,
        { type: "sso:attach", payload },
        options,
      );
      if (result?.ok) return result;
      if (result?.reason) lastReason = result.reason;
    } catch {
      // Frame has no content script (chrome:// pages, cross-origin edge cases).
      // Keep trying the others.
    }
  }
  throw new Error(lastReason);
}

/** Ask every frame for status; return the first one that holds a video. */
export async function tabStatus(tabId) {
  const frames = await chrome.webNavigation?.getAllFrames?.({ tabId }).catch(() => null);
  const frameIds = frames ? frames.map((frame) => frame.frameId) : [undefined];

  let fallback = null;
  for (const frameId of frameIds) {
    try {
      const options = frameId === undefined ? {} : { frameId };
      const status = await chrome.tabs.sendMessage(tabId, { type: "sso:status" }, options);
      if (status?.hasVideo) return { ...status, frameId };
      if (status && !fallback) fallback = { ...status, frameId };
    } catch {
      // no content script in this frame
    }
  }
  return fallback;
}

/**
 * Choose the subtitle to attach without asking.
 *
 * Preference order: something already downloaded (free, and previously good
 * enough to pick), then the daemon's own ranking, which puts trusted uploads
 * and popular files first. Language preference wins over both, because an
 * excellent subtitle in the wrong language is not a result.
 */
export function pickBest(results, languages) {
  if (!results?.length) return null;

  const rank = (result) => {
    const languageIndex = languages.indexOf(result.language);
    return [
      languageIndex === -1 ? languages.length : languageIndex,
      result.cached ? 0 : 1,
    ];
  };

  return [...results].sort((a, b) => {
    const [aLang, aCached] = rank(a);
    const [bLang, bCached] = rank(b);
    if (aLang !== bLang) return aLang - bLang;
    if (aCached !== bCached) return aCached - bCached;
    return 0; // daemon already ordered by trust and popularity
  })[0];
}
