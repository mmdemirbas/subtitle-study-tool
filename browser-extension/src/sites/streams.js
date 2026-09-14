/* What a player handed a stream manifest is given, overheard.
 *
 * Runs in the PAGE's world (`"world": "MAIN"`) on Disney+ and tabii, like
 * `primevideo.js`. These players are not handed a list of subtitle files;
 * they are handed a manifest, and the subtitles are in it beside the video
 * and audio. Three shapes are read, and the page decides which goes by:
 *
 *   HLS   the master `.m3u8` names every subtitle language on an
 *         `#EXT-X-MEDIA:TYPE=SUBTITLES` line - NAME, LANGUAGE, FORCED,
 *         CHARACTERISTICS and the URI of a playlist of WebVTT segments.
 *         Disney+: read in "Disney+ Subtitles Downloader Improved" (github
 *         Sen-Elsecaller, v2.16, 2026-09-12) - the XHR wrap, `sub-main`,
 *         `FORCED=YES`, segments fetched with a plain GET. That script
 *         resolves segment paths by hand against the master's directory;
 *         this resolves them against the playlist that listed them, which
 *         is the HLS rule and needs no knowledge of the layout.
 *   DASH  the `.mpd` names text tracks as AdaptationSets with a `lang`, a
 *         Role and a mime type; each is a file or a run of segments. The ear
 *         posts the MPD's URL and which track, and the worker reads the MPD
 *         again with `subtitles/dash.js`. Written from the spec, not from a
 *         site: tabii's home page lists both an HLS and a DASH URL per live
 *         channel (read 2026-09-12, no session) and its films are behind a
 *         login this ear has not been run on.
 *   sidecar  a player given subtitle files by its own API - a JSON answer with
 *         a `.vtt`/`.srt`/`.ttml` URL beside a language - watched for on
 *         tabii's API host, because that is the third way a web player gets
 *         its subtitles and nothing about tabii said which of the three it is.
 *
 * A player that does it the standard way - `<track>` elements under its
 * `<video>`, or text tracks with cues in them - needs no ear: content.js
 * reads the document itself, on every site (see "the subtitles a page
 * carries the standard way" there). This ear used to read both as well;
 * that was two copies of one reading, and the one in the extension's own
 * world is the one that runs everywhere.
 *
 * Beside this runs `survey.js`, which writes the shape of everything the
 * player does to the running log, so that a playback nobody was watching is
 * enough to learn a player from.
 *
 * The title's id is the last part of the page's path when the list goes by,
 * which is what the offset store keys on. Everything found is posted with the
 * shape it was found in - `m3u8`, `mpd`, `api` - so the first
 * playback's `pageSubtitles` log line says which shape this player has. The
 * URLs are never written anywhere. */
(() => {
  const MARK = "sso-ear";
  if (window.__ssoStreamsHooked) return;
  window.__ssoStreamsHooked = true;

  const PLAYLIST = /\.m3u8(?:[?#]|$)/;
  const MANIFEST = /\.mpd(?:[?#]|$)/;
  const SIDECAR = /\.(vtt|srt|ttml|dfxp|xml)(?:[?#]|$)/i;
  const API = /\/apigateway\//;
  let latest = null;

  const post = (message) => window.postMessage({ source: MARK, ...message }, location.origin);
  const titleId = () => location.pathname.split("/").filter(Boolean).pop() || "";

  const attributes = (line) => {
    const found = {};
    for (const match of line.matchAll(/([A-Z0-9-]+)=("([^"]*)"|[^,]*)/g)) found[match[1]] = match[3] ?? match[2];
    return found;
  };

  const hlsTracks = (text, url) => {
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

  /* The text AdaptationSets of an MPD, one track each: enough to name them
   * on the Find screen. The worker reads the MPD itself for the URLs. */
  const xmlAttributes = (text) => {
    const found = {};
    for (const match of String(text).matchAll(/([\w:.-]+)\s*=\s*"([^"]*)"/g)) found[match[1].replace(/^[\w-]+:/, "")] = match[2];
    return found;
  };
  const dashTracks = (text, url) => {
    const tracks = [];
    let index = -1;
    for (const match of String(text).matchAll(/<(?:[\w-]+:)?AdaptationSet\b([^>]*)>([\s\S]*?)<\/(?:[\w-]+:)?AdaptationSet\s*>/g)) {
      index += 1;
      const attrs = xmlAttributes(match[1]);
      const inner = match[2];
      const representation = /<(?:[\w-]+:)?Representation\b([^>]*)/.exec(inner);
      const rep = representation ? xmlAttributes(representation[1]) : {};
      const mime = attrs.mimeType || rep.mimeType || "";
      const codecs = attrs.codecs || rep.codecs || "";
      const isText = attrs.contentType === "text" || /^text\/vtt$|^application\/ttml\+xml$/.test(mime) || (mime === "application/mp4" && /stpp|wvtt/.test(codecs));
      if (!isText) continue;
      const roles = [...inner.matchAll(/<(?:[\w-]+:)?(?:Role|Accessibility)\b[^>]*\bvalue="([^"]*)"/g)].map((m) => m[1]);
      const label = /<(?:[\w-]+:)?Label\b[^>]*>([^<]*)</.exec(inner)?.[1]?.trim() || "";
      tracks.push({
        language: attrs.lang || rep.lang || "",
        url,
        type: `${roles.join(" ")} ${mime} ${codecs}`.trim(),
        displayName: label,
        format: "dash",
        forced: roles.some((role) => /forced/.test(role)),
        keys: Object.keys(attrs),
        dash: { representation: rep.id || "", adaptation: attrs.id || String(index) },
      });
    }
    return tracks;
  };

  /* Subtitle files named in an API answer: any object with a URL to one of
   * the sidecar formats, its language read from the usual field names. Key
   * paths are logged, values are not. */
  const apiTracks = (data) => {
    const tracks = [];
    const seen = new Set();
    const walk = (node, path) => {
      if (!node || typeof node !== "object" || seen.has(node) || tracks.length > 200) return;
      seen.add(node);
      if (!Array.isArray(node)) {
        const urlKey = Object.keys(node).find((key) => typeof node[key] === "string" && SIDECAR.test(node[key]) && /^https?:\/\/|^\//.test(node[key]));
        if (urlKey) {
          const language = ["language", "languageCode", "lang", "srclang", "locale", "code", "iso"].map((key) => node[key]).find((value) => typeof value === "string") || "";
          const ext = SIDECAR.exec(node[urlKey])[1].toLowerCase();
          let resolved = "";
          try {
            resolved = new URL(node[urlKey], location.href).href;
          } catch {
            return;
          }
          tracks.push({
            language,
            url: resolved,
            type: `${path} ${node.type ?? node.kind ?? ""}`.trim(),
            displayName: ["name", "title", "label", "displayName"].map((key) => node[key]).find((value) => typeof value === "string") || "",
            format: ext === "vtt" ? "vtt" : ext === "srt" ? "srt" : "ttml",
            forced: Boolean(node.forced),
            keys: Object.keys(node),
          });
          return;
        }
      }
      for (const [key, value] of Object.entries(node)) walk(value, Array.isArray(node) ? path : `${path}.${key}`);
    };
    walk(data, "");
    return tracks;
  };

  /* What this ear saw, by shape, for the survey to write down beside what
   * the player did: the one line that tells "the manifest went by and had
   * no text" from "the manifest did not go by". */
  const seen = { m3u8: 0, mpd: 0, api: 0, posted: 0 };
  window.__ssoStreamsState = () => ({ ...seen, latest: latest ? { where: latest.where, titleId: latest.titleId, tracks: latest.tracks.length, shape: latest.shape } : null });

  const noticed = (shape, tracks) => {
    seen[shape] = (seen[shape] || 0) + 1;
    /* An empty list is news only from the shape that last had some - the
     * video's text tracks gone with the video - not from a playlist that
     * simply carried no subtitles. */
    if (!tracks.length && latest?.shape?.[0] !== shape) return;
    latest = { where: location.pathname, titleId: titleId(), tracks, shape: [shape, ...new Set(tracks.map((track) => track.type).filter(Boolean))].slice(0, 12), at: Date.now() };
    seen.posted += 1;
    post({ type: "tracks", ...latest });
  };

  const consider = (url, text) => {
    if (typeof text !== "string" || !text) return;
    if (PLAYLIST.test(url)) {
      if (text.includes("#EXT-X-MEDIA:")) noticed("m3u8", hlsTracks(text, url));
    } else if (MANIFEST.test(url)) {
      if (/<(?:[\w-]+:)?MPD\b/.test(text)) noticed("mpd", dashTracks(text, url));
    } else if (API.test(url) && text[0] === "{") {
      try {
        noticed("api", apiTracks(JSON.parse(text)));
      } catch {
        // Not JSON after all.
      }
    }
  };

  const worth = (url) => PLAYLIST.test(url) || MANIFEST.test(url) || API.test(url);

  const originalFetch = window.fetch;
  window.fetch = function fetchWithEar(input, init) {
    const url = typeof input === "string" ? input : input?.url;
    const promise = originalFetch.apply(this, arguments);
    if (typeof url === "string" && worth(url)) {
      promise
        .then((response) => response.clone().text().then((text) => consider(new URL(url, location.href).href, text)))
        .catch(() => {});
    }
    return promise;
  };

  const originalOpen = XMLHttpRequest.prototype.open;
  XMLHttpRequest.prototype.open = function openWithEar(method, url) {
    const target = String(url ?? "");
    if (worth(target)) {
      this.addEventListener("load", () => {
        try {
          const kind = this.responseType;
          const resolved = this.responseURL || new URL(target, location.href).href;
          if (kind === "" || kind === "text") consider(resolved, this.responseText);
          else if (kind === "json") consider(resolved, JSON.stringify(this.response));
          /* A player that asks for bytes and parses the manifest itself. */
          else if (kind === "arraybuffer" && this.response?.byteLength < 4_000_000) consider(resolved, new TextDecoder().decode(this.response));
        } catch {
          // The player's own handler runs regardless.
        }
      });
    }
    return originalOpen.apply(this, arguments);
  };

  /* An ask is answered only for the page the list was heard on: the content
   * script asks after the site navigates without a reload, and Proxima's
   * list is no answer on the next film's page. */
  window.addEventListener("message", (event) => {
    if (event.source !== window || event.data?.source !== MARK || event.data.type !== "ask") return;
    /* Or heard in the last half minute: a player that fetches the next
     * title's list just before the site changes the URL to it. */
    if (latest && (latest.where === location.pathname || Date.now() - latest.at < 30_000)) post({ type: "tracks", ...latest });
  });
})();
