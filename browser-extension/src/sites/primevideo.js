/* What Prime Video's own player is given, overheard.
 *
 * This is the one file that runs in the PAGE's world rather than the
 * extension's - `"world": "MAIN"` in the manifest, on Prime Video's hosts only
 * - because what it wants is not in the document and not on the network in any
 * form a content script can see. When playback starts, the player POSTs to
 * `.../GetVodPlaybackResources?...&titleId=...` and the answer carries, beside
 * the stream, every subtitle the title has: `timedTextUrls.result.subtitleUrls`,
 * one entry per language with a signed URL to a TTML file. The player fetches
 * only the one the viewer picked; the list is the thing worth having, and the
 * list lives in a response body. Resource timing sees the URL and not the body;
 * webRequest sees request bodies and not response bodies. So `fetch` and
 * `XMLHttpRequest` are wrapped, the answer is CLONED and read, and the
 * player's own copy is untouched.
 *
 * Read in the source of the "Amazon Prime Video - Subtitle Downloader"
 * userscript (greasyfork 562565, v1.0.0, 2026-09-12): the same wrap, the same
 * path into the answer, and a plain `fetch(subtitle.url)` with no credentials
 * to get the file - so the URLs authorise themselves. That script re-asks the
 * API with an envelope dug out of the page's template JSON; this does not need
 * to, because the player has already asked for the title actually playing.
 *
 * What crosses to the extension's world is a postMessage on this window - the
 * only channel the two worlds share - carrying the language, the kind and the
 * URL of each track. The URLs are signed and are never written anywhere; the
 * content script logs languages and key names, and that is all.
 *
 * Nothing here is verified against the live page yet. The first playback with
 * this installed writes a `pageSubtitles` line to the running log saying what
 * the answer's shape was, which is the evidence the rest of this feature is
 * waiting on. */
(() => {
  const MARK = "sso-ear";
  if (window.__ssoPrimeHooked) return;
  window.__ssoPrimeHooked = true;

  const RESOURCES = /\/Get(?:Vod)?PlaybackResources\b/;
  let latest = null;

  const post = (message) => window.postMessage({ source: MARK, ...message }, location.origin);

  /* The tracks out of an answer, in one shape whatever the API called them.
   * Two spellings are read: the current `timedTextUrls.result.subtitleUrls`
   * and the older flat `subtitleUrls`. Forced narratives - the lines spoken in
   * another language, translated - come from `forcedNarratives` beside them
   * and are marked, because they are not a subtitle for the film. */
  const tracksIn = (data) => {
    const result = data?.timedTextUrls?.result ?? data;
    const list = (value, forced) =>
      (Array.isArray(value) ? value : []).map((track) => ({
        language: track?.languageCode ?? track?.language ?? "",
        url: track?.url ?? "",
        type: track?.type ?? "",
        displayName: track?.displayName ?? "",
        // The API says TTMLv2; the worker reads by this name. See vtt.js for
        // the other value an ear can send.
        format: "ttml",
        forced,
        keys: track && typeof track === "object" ? Object.keys(track) : [],
      }));
    return [
      ...list(result?.subtitleUrls, false),
      ...list(result?.forcedNarratives, true),
    ].filter((track) => track.url);
  };

  const noticed = (url, body) => {
    let data;
    try {
      data = JSON.parse(body);
    } catch {
      return;
    }
    let titleId = "";
    try {
      titleId = new URL(url, location.href).searchParams.get("titleId") || "";
    } catch {
      // A URL the page could fetch is a URL this can parse; nothing to do.
    }
    latest = {
      where: location.pathname,
      titleId,
      tracks: tracksIn(data),
      /* For the log, when the list is not where it was expected: the answer's
       * own top-level names say where to look next. */
      shape: Object.keys(data && typeof data === "object" ? data : {}),
      at: Date.now(),
    };
    post({ type: "tracks", ...latest });
  };

  const originalFetch = window.fetch;
  window.fetch = function fetchWithEar(input, init) {
    const url = typeof input === "string" ? input : input?.url;
    const promise = originalFetch.apply(this, arguments);
    if (typeof url === "string" && RESOURCES.test(url)) {
      promise
        .then((response) => response.clone().text().then((text) => noticed(url, text)))
        .catch(() => {});
    }
    return promise;
  };

  const originalOpen = XMLHttpRequest.prototype.open;
  XMLHttpRequest.prototype.open = function openWithEar(method, url) {
    const target = String(url ?? "");
    if (RESOURCES.test(target)) {
      this.addEventListener("load", () => {
        try {
          const kind = this.responseType;
          if (kind === "" || kind === "text") noticed(target, this.responseText);
          else if (kind === "json") noticed(target, JSON.stringify(this.response));
        } catch {
          // The player's own handler runs regardless.
        }
      });
    }
    return originalOpen.apply(this, arguments);
  };

  /* The content script loads at document_idle and may have missed the answer;
   * it asks, and gets the latest one - if it was heard on this page. The
   * content script also asks after the site navigates without a reload, and
   * a list heard on another title's page is not an answer. */
  window.addEventListener("message", (event) => {
    if (event.source !== window || event.data?.source !== MARK || event.data.type !== "ask") return;
    /* Or heard in the last half minute: a player that fetches the next
     * title's list just before the site changes the URL to it. */
    if (latest && (latest.where === location.pathname || Date.now() - latest.at < 30_000)) post({ type: "tracks", ...latest });
  });
})();
