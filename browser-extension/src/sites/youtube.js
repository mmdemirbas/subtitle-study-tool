/* What YouTube's own player is given, overheard.
 *
 * Runs in the PAGE's world (`"world": "MAIN"`, youtube.com only), like the
 * other ears. YouTube tells its player every caption track of a video in the
 * player response: `captions.playerCaptionsTracklistRenderer.captionTracks`,
 * one entry per track with `baseUrl` (the `/api/timedtext` URL), `languageCode`,
 * `name`, `vssId`, and `kind: "asr"` for the auto-generated one. The response
 * is inlined into the first page as `ytInitialPlayerResponse` and fetched as
 * `/youtubei/v1/player` on every navigation after that, since the site is one
 * page. Both are read; the one posted is for the video in the URL, because
 * the player fetches the next video's response ahead of time.
 *
 * Observed live on 2026-09-12 (a public video, no session): six tracks in that
 * shape, 156 `translationLanguages` beside them, and `baseUrl` with
 * `exp=xpe` in its query - which is the one thing that makes this ear more
 * than a list. Read in yt-dlp's extractor (`youtube/_video.py`, master
 * 2026-09-12): a `timedtext` URL whose `exp` is `xpe` or `xpv` answers an empty
 * body unless the request carries a proof-of-origin token, `pot=...&potc=1&
 * c=WEB`, which the page's player makes for itself (BotGuard) and appends to
 * its own timedtext requests. The same fetch from this sandbox got HTTP 200
 * and 0 bytes. So the player's own timedtext requests are overheard too, the
 * three parameters are taken off the first one that carries them, and every
 * track's URL is posted with them on - which means the list is fetchable
 * from the moment the viewer has the player's captions on, in any language,
 * and only then. The worker says so when it gets an empty file.
 *
 * Every track's URL asks for `fmt=vtt`, which the timedtext API serves along
 * with json3, srv1-3, ttml and srt (yt-dlp's `_SUBTITLE_FORMATS`), and the
 * worker reads with `subtitles/vtt.js`. Translations (`tlang=`) are not
 * offered here; the daemon makes those. Nothing rewrites the player's own
 * requests. The URLs are never written anywhere. */
(() => {
  const MARK = "sso-ear";
  if (window.__ssoYouTubeHooked) return;
  window.__ssoYouTubeHooked = true;

  const PLAYER = /\/youtubei\/v1\/player\b/;
  const TIMEDTEXT = /\/api\/timedtext\b/;
  const responses = new Map();
  let proof = null;
  let shown = "";

  const post = (message) => window.postMessage({ source: MARK, ...message }, location.origin);

  /* The watch page's own element says which video it shows, and says so
   * before the URL catches up on an autoplay into the next one. */
  const currentId = () => {
    const onPage = document.querySelector("ytd-watch-flexy[video-id]")?.getAttribute("video-id");
    if (onPage) return onPage;
    const inQuery = new URLSearchParams(location.search).get("v");
    if (inQuery) return inQuery;
    const inPath = /\/(?:shorts|embed|live|v)\/([\w-]{11})/.exec(location.pathname);
    return inPath ? inPath[1] : "";
  };

  const nameOf = (name) => {
    if (!name || typeof name !== "object") return "";
    if (typeof name.simpleText === "string") return name.simpleText;
    return (Array.isArray(name.runs) ? name.runs : []).map((run) => run?.text ?? "").join("");
  };

  const tracksIn = (response) => {
    const renderer = response?.captions?.playerCaptionsTracklistRenderer;
    const list = Array.isArray(renderer?.captionTracks) ? renderer.captionTracks : [];
    return list
      .filter((track) => track && typeof track.baseUrl === "string")
      .map((track) => ({
        language: track.languageCode ?? "",
        baseUrl: track.baseUrl,
        type: track.kind ?? "",
        displayName: nameOf(track.name),
        forced: false,
        keys: Object.keys(track),
      }));
  };

  /* The URL the worker will fetch: the track's, asking for WebVTT, with the
   * player's proof on it when one has been seen. Built at post time so a
   * proof that arrives later reaches every track already listed. */
  const urlFor = (track) => {
    let url;
    try {
      url = new URL(track.baseUrl, location.href);
    } catch {
      return "";
    }
    url.searchParams.set("fmt", "vtt");
    if (proof) for (const [key, value] of Object.entries(proof)) url.searchParams.set(key, value);
    return url.href;
  };

  const show = () => {
    const id = currentId();
    const found = responses.get(id);
    if (!found || shown === id) return;
    shown = id;
    post({
      type: "tracks",
      titleId: id,
      tracks: found.tracks.map((track) => ({ ...track, baseUrl: undefined, url: urlFor(track), format: "vtt" })).filter((track) => track.url),
      shape: [...found.shape, proof ? "pot" : "no-pot"],
    });
  };

  const noticed = (response) => {
    const id = response?.videoDetails?.videoId;
    if (typeof id !== "string" || !id) return;
    /* Recorded even when empty: a video with no captions must replace the
     * previous video's list, or the panel goes on offering it. */
    const tracks = tracksIn(response);
    let needsProof = false;
    try {
      needsProof = tracks.some((track) => /^(xpe|xpv)$/.test(new URL(track.baseUrl, location.href).searchParams.get("exp") || ""));
    } catch {
      // A URL the player could fetch parses.
    }
    responses.set(id, {
      tracks,
      shape: [...Object.keys(response.captions?.playerCaptionsTracklistRenderer || {}), needsProof ? "exp=xpe" : "no-exp"],
    });
    if (shown === id) shown = "";
    show();
  };

  /* The player's own timedtext request, for its proof. */
  const overheard = (url) => {
    let parsed;
    try {
      parsed = new URL(url, location.href);
    } catch {
      return;
    }
    const pot = parsed.searchParams.get("pot");
    if (!pot || proof?.pot === pot) return;
    proof = { pot, potc: parsed.searchParams.get("potc") || "1", c: parsed.searchParams.get("c") || "WEB" };
    shown = "";
    show();
  };

  const originalFetch = window.fetch;
  window.fetch = function fetchWithEar(input, init) {
    const url = typeof input === "string" ? input : input?.url;
    const promise = originalFetch.apply(this, arguments);
    if (typeof url === "string") {
      if (PLAYER.test(url)) {
        promise
          .then((response) => response.clone().json().then((data) => noticed(data)))
          .catch(() => {});
      } else if (TIMEDTEXT.test(url)) {
        overheard(url);
      }
    }
    return promise;
  };

  const originalOpen = XMLHttpRequest.prototype.open;
  XMLHttpRequest.prototype.open = function openWithEar(method, url) {
    const target = String(url ?? "");
    if (TIMEDTEXT.test(target)) overheard(target);
    if (PLAYER.test(target)) {
      this.addEventListener("load", () => {
        try {
          const kind = this.responseType;
          if (kind === "" || kind === "text") noticed(JSON.parse(this.responseText));
          else if (kind === "json") noticed(this.response);
        } catch {
          // The player's own handler runs regardless.
        }
      });
    }
    return originalOpen.apply(this, arguments);
  };

  /* The first page's response is inlined, not fetched; and the video changes
   * without a navigation this script would see. Once a second covers both. */
  setInterval(() => {
    const initial = window.ytInitialPlayerResponse;
    const id = initial?.videoDetails?.videoId;
    if (typeof id === "string" && id && !responses.has(id)) noticed(initial);
    show();
  }, 1000);

  window.addEventListener("message", (event) => {
    if (event.source !== window || event.data?.source !== MARK || event.data.type !== "ask") return;
    shown = "";
    show();
  });
})();
