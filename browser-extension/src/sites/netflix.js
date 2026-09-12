/* What Netflix's own player is given, overheard.
 *
 * Runs in the PAGE's world (`"world": "MAIN"`, netflix.com only), like
 * `primevideo.js`, and for the same reason with one difference: the player's
 * manifest never crosses the network as JSON. It comes back inside an MSL
 * envelope, encrypted, and is decrypted and `JSON.parse`d by the player's own
 * code - so a wrapped fetch would see ciphertext and resource timing would see
 * a URL. `JSON.parse` itself is wrapped instead. Every parse the page makes
 * passes through here, and the one that is a manifest is recognised by what
 * it carries: `result.movieId` beside `result.timedtexttracks` (the older
 * name `textTracks` is read too). The value goes back to the player
 * untouched.
 *
 * Read in the source of two extensions that do this, both maintained: Subadub
 * (github rsimmons/subadub, dist/page_script.js) and "Netflix - subtitle
 * downloader" (greasyfork 26654, Tithen-Firion), 2026-09-12. A track has
 * `language`, `languageDescription`, `rawTrackType` ("subtitles" or
 * "closedcaptions"), `isForcedNarrative`, `isNoneTrack` for the "Off" entry,
 * and `ttDownloadables` (older: `downloadables`) keyed by format: `dfxp-ls-sdh`
 * and `imsc1.1` are TTML and in the player's default request, `webvtt-lssdh-
 * ios8` is there only when asked for. Each holds `downloadUrls` (an object of
 * URLs) or `urls` (a list of `{url}`). Both extensions fetch the file with a
 * plain `fetch(url)`, so the URLs authorise themselves. Both also rewrite the
 * player's REQUEST to add the WebVTT format; this does not, because the TTML
 * the player is given anyway is read by `subtitles/ttml.js`, and a request
 * the player did not make is a request Netflix can refuse.
 *
 * The player fetches the next episode's manifest ahead of time, so the latest
 * parse is not always the title on screen. Every manifest is kept by movieId,
 * and the one posted is the one for the id the page shows - `data-videoid` on
 * the player, or `/watch/<id>` in the URL - checked once a second, which is
 * how Subadub follows an episode change.
 *
 * What crosses to the extension's world is a postMessage on this window; the
 * URLs are never written anywhere. Nothing here is verified against the live
 * page yet: the first playback writes a `pageSubtitles` line to the running
 * log with the shape of what was found, which is the evidence this waits on. */
(() => {
  const MARK = "sso-ear";
  if (window.__ssoNetflixHooked) return;
  window.__ssoNetflixHooked = true;

  const FORMATS = ["dfxp-ls-sdh", "imsc1.1", "webvtt-lssdh-ios8"];
  const manifests = new Map();
  let shown = "";

  const post = (message) => window.postMessage({ source: MARK, ...message }, location.origin);

  const urlOf = (downloadable) => {
    if (!downloadable || typeof downloadable !== "object") return "";
    const listed = downloadable.downloadUrls;
    if (listed && typeof listed === "object") {
      const first = Object.values(listed).find((value) => typeof value === "string");
      if (first) return first;
    }
    const urls = Array.isArray(downloadable.urls) ? downloadable.urls : [];
    return urls.find((entry) => typeof entry?.url === "string")?.url ?? "";
  };

  const tracksIn = (result) => {
    const list = Array.isArray(result.timedtexttracks) ? result.timedtexttracks : result.textTracks;
    return (Array.isArray(list) ? list : [])
      .filter((track) => track && typeof track === "object" && !track.isNoneTrack)
      .map((track) => {
        const downloadables = track.ttDownloadables ?? track.downloadables ?? {};
        const format = FORMATS.find((name) => urlOf(downloadables[name]));
        return {
          language: track.language ?? "",
          url: format ? urlOf(downloadables[format]) : "",
          type: track.rawTrackType ?? "",
          displayName: track.languageDescription ?? "",
          format: format === "webvtt-lssdh-ios8" ? "vtt" : "ttml",
          forced: Boolean(track.isForcedNarrative),
          keys: Object.keys(track),
          formats: Object.keys(downloadables && typeof downloadables === "object" ? downloadables : {}),
        };
      })
      .filter((track) => track.url);
  };

  const currentId = () => {
    const onPlayer = document.querySelector("[data-videoid]")?.dataset?.videoid;
    if (onPlayer) return String(onPlayer);
    const inUrl = /\/watch\/(\d+)/.exec(location.pathname);
    return inUrl ? inUrl[1] : "";
  };

  const show = () => {
    const id = currentId();
    const found = manifests.get(id);
    if (!found || shown === id) return;
    shown = id;
    post({ type: "tracks", ...found });
  };

  const noticed = (result) => {
    const titleId = String(result.movieId);
    manifests.set(titleId, { titleId, tracks: tracksIn(result), shape: Object.keys(result), at: Date.now() });
    if (shown === titleId) shown = "";
    show();
  };

  const originalParse = JSON.parse;
  JSON.parse = function parseWithEar() {
    const value = originalParse.apply(this, arguments);
    try {
      const result = value?.result;
      if (result && typeof result === "object" && result.movieId != null && (result.timedtexttracks || result.textTracks)) {
        noticed(result);
      }
    } catch {
      // The player's own parse is what matters, and it has already happened.
    }
    return value;
  };

  setInterval(show, 1000);

  window.addEventListener("message", (event) => {
    if (event.source !== window || event.data?.source !== MARK || event.data.type !== "ask") return;
    shown = "";
    show();
  });
})();
