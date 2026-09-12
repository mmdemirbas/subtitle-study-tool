/* What Disney+'s own player is given, overheard.
 *
 * Runs in the PAGE's world (`"world": "MAIN"`, disneyplus.com only), like
 * `primevideo.js`. Disney+ streams over HLS: when playback starts the player
 * fetches a master playlist (`.m3u8`), and beside the video and audio groups
 * that playlist names every subtitle language the title has, one
 * `#EXT-X-MEDIA:TYPE=SUBTITLES` line each, with the language, a name like
 * "English [CC]", whether it is forced, and the URI of its own playlist - a
 * list of WebVTT segments, timed on the title's clock. The player fetches only
 * the language the viewer picked; the master is the list worth having, and it
 * goes by in a response body, so `XMLHttpRequest` and `fetch` are wrapped for
 * URLs with `.m3u8` in them and the body is read beside the player's own copy.
 *
 * Read in the source of "Disney+ Subtitles Downloader Improved" (github
 * Sen-Elsecaller, v2.16, 2026-09-12): the same XHR wrap, the master told from
 * a media playlist by `#EXT-X-INDEPENDENT-SEGMENTS`, the subtitle group
 * `sub-main`, `FORCED=YES` for the forced tracks, and the segments fetched
 * with a plain GET and no headers - so the URLs authorise themselves. That
 * script resolves segment paths by hand against the master's directory; this
 * resolves them the way the player does, against the playlist that listed
 * them, which is the HLS rule and needs no knowledge of Disney's layout.
 *
 * The title's id is the last part of the page's path (`/play/<id>` or
 * `/video/<id>`) when the master goes by, which is what the offset store keys
 * on; a different id is a different film. What crosses to the extension's
 * world is a postMessage on this window; the URLs are never written
 * anywhere. Nothing here is verified against the live page yet: the first
 * playback writes a `pageSubtitles` line to the running log with the shape of
 * what was found, which is the evidence this waits on. */
(() => {
  const MARK = "sso-ear";
  if (window.__ssoDisneyHooked) return;
  window.__ssoDisneyHooked = true;

  const PLAYLIST = /\.m3u8(?:[?#]|$)/;
  let latest = null;

  const post = (message) => window.postMessage({ source: MARK, ...message }, location.origin);

  /* `KEY=VALUE` pairs separated by commas, a quoted value allowed to hold
   * commas of its own. The same reading as subtitles/vtt.js, which cannot be
   * imported into the page's world. */
  const attributes = (line) => {
    const found = {};
    for (const match of line.matchAll(/([A-Z0-9-]+)=("([^"]*)"|[^,]*)/g)) found[match[1]] = match[3] ?? match[2];
    return found;
  };

  const tracksIn = (text, url) => {
    const tracks = [];
    for (const raw of String(text).split(/\r?\n/)) {
      if (!raw.startsWith("#EXT-X-MEDIA:")) continue;
      const attrs = attributes(raw.slice("#EXT-X-MEDIA:".length));
      if (attrs.TYPE !== "SUBTITLES" || !attrs.URI) continue;
      let resolved = "";
      try {
        resolved = new URL(attrs.URI, url).href;
      } catch {
        continue;
      }
      tracks.push({
        language: attrs.LANGUAGE || "",
        url: resolved,
        type: attrs.CHARACTERISTICS || "",
        displayName: attrs.NAME || "",
        format: "hls-vtt",
        forced: attrs.FORCED === "YES",
        keys: Object.keys(attrs),
      });
    }
    return tracks;
  };

  const noticed = (url, text) => {
    if (typeof text !== "string" || !text.includes("#EXT-X-MEDIA:")) return;
    const tracks = tracksIn(text, url);
    if (!tracks.length) return;
    const titleId = location.pathname.split("/").filter(Boolean).pop() || "";
    latest = { titleId, tracks, shape: ["m3u8", ...new Set(tracks.map((track) => track.type).filter(Boolean))], at: Date.now() };
    post({ type: "tracks", ...latest });
  };

  const originalFetch = window.fetch;
  window.fetch = function fetchWithEar(input, init) {
    const url = typeof input === "string" ? input : input?.url;
    const promise = originalFetch.apply(this, arguments);
    if (typeof url === "string" && PLAYLIST.test(url)) {
      promise
        .then((response) => response.clone().text().then((text) => noticed(new URL(url, location.href).href, text)))
        .catch(() => {});
    }
    return promise;
  };

  const originalOpen = XMLHttpRequest.prototype.open;
  XMLHttpRequest.prototype.open = function openWithEar(method, url) {
    const target = String(url ?? "");
    if (PLAYLIST.test(target)) {
      this.addEventListener("load", () => {
        try {
          const kind = this.responseType;
          if (kind === "" || kind === "text") noticed(this.responseURL || new URL(target, location.href).href, this.responseText);
        } catch {
          // The player's own handler runs regardless.
        }
      });
    }
    return originalOpen.apply(this, arguments);
  };

  window.addEventListener("message", (event) => {
    if (event.source !== window || event.data?.source !== MARK || event.data.type !== "ask") return;
    if (latest) post({ type: "tracks", ...latest });
  });
})();
