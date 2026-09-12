/* What a player does, written down for whoever has to build its ear.
 *
 * Runs in the PAGE's world beside `streams.js`, on the sites whose players
 * have not been seen from here: tabii, whose films are behind a login nobody
 * building this has, and Disney+. An ear for a player is written from the
 * shape of what the player fetches, and that shape is normally learned by
 * somebody sitting at DevTools. This is the substitute: while the page plays,
 * it records the SHAPE of everything the player does and posts it across to
 * be written to the running log, so one playback by the reader is enough for
 * the next session to read the log and write the ear. Nothing is asked of
 * the reader but to play something.
 *
 * Shape, never content, because the log is a file on disk that outlives the
 * session and a signed URL or a session token in it is a session leaked:
 *
 *   requests   every fetch and XHR - method, the URL with its ids and query
 *              values taken out (`/watch/{n}?token,lang`), header NAMES,
 *              status, content type, size, and a digest of the body: a JSON
 *              answer's key paths with the kind of each value (a URL by its
 *              host and extension, a language code by its value, a string by
 *              its length); a playlist's tags and its EXT-X-MEDIA attributes;
 *              a manifest's adaptation sets; a subtitle file's cue count.
 *              One entry per shape, with a count, so a thousand segments
 *              are one line.
 *   videos     each <video>: what its src is (blob or http), its text tracks
 *              with their kinds, languages, modes and cue counts, its <track>
 *              children.
 *   players    the player libraries found on window, by name.
 *   drm        the key systems asked for.
 *   dom        elements whose class or id says subtitle, for a player that
 *              draws its own.
 *
 * Posted every five seconds while anything changed, capped so a page that
 * never stops fetching cannot fill the log. The content script writes each
 * batch as a `survey` line. */
(() => {
  const MARK = "sso-ear";
  if (window.__ssoSurveyHooked) return;
  window.__ssoSurveyHooked = true;

  const EVERY_MS = 5000;
  const SHAPES = 400;
  const BODY_MAX = 2_000_000;
  const PATHS = 80;
  const TEXT = /json|xml|text|mpegurl|vtt|javascript|dash|ttml/i;

  const post = (message) => window.postMessage({ source: MARK, ...message }, location.origin);

  // --- shapes -----------------------------------------------------------------

  const segment = (piece) => {
    const [name, ext] = /^(.*?)(\.[A-Za-z0-9]{1,5})?$/.exec(piece).slice(1);
    const tail = ext || "";
    if (/^\d{3,}$/.test(name)) return `{n}${tail}`;
    if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(name)) return `{uuid}${tail}`;
    if (/^[0-9a-f]{16,}$/i.test(name)) return `{hex}${tail}`;
    if (/^[\w=-]{24,}$/.test(name)) return `{token}${tail}`;
    return piece;
  };

  const shapeOf = (url) => {
    let parsed;
    try {
      parsed = new URL(url, location.href);
    } catch {
      return "(unparseable)";
    }
    const path = parsed.pathname.split("/").map(segment).join("/");
    const keys = [...new Set(parsed.searchParams.keys())].sort();
    return `${parsed.origin}${path}${keys.length ? `?${keys.join(",")}` : ""}`;
  };

  const kindOf = (value) => {
    if (value === null) return "null";
    if (Array.isArray(value)) return `arr(${value.length})`;
    if (typeof value === "object") return "obj";
    if (typeof value === "string") {
      if (/^https?:\/\//.test(value) || /^\/[\w./-]+\.\w{2,5}(\?|$)/.test(value)) {
        try {
          const parsed = new URL(value, location.href);
          const ext = /\.([A-Za-z0-9]{1,5})$/.exec(parsed.pathname)?.[1] || "";
          return `url(${parsed.host}${ext ? ` .${ext}` : ""})`;
        } catch {
          return "url";
        }
      }
      if (/^[a-z]{2,3}(-[A-Za-z]{2,4})?$/.test(value)) return `lang:${value}`;
      return `str(${value.length})`;
    }
    return typeof value;
  };

  /* Key paths, the ones whose names say subtitle first. */
  const jsonShape = (data) => {
    const paths = [];
    const walk = (node, path, depth) => {
      if (paths.length >= PATHS * 3 || depth > 6 || !node || typeof node !== "object") return;
      if (Array.isArray(node)) {
        if (node.length) walk(node[0], `${path}[]`, depth + 1);
        return;
      }
      for (const [key, value] of Object.entries(node)) {
        const here = path ? `${path}.${key}` : key;
        paths.push(`${here}=${kindOf(value)}`);
        walk(value, here, depth + 1);
      }
    };
    walk(data, "", 0);
    const telling = (line) => /subtitle|caption|text|track|lang|srt|vtt|ttml|dfxp|media|stream|manifest|mpd|m3u8|drm|license|url/i.test(line);
    return [...paths.filter(telling), ...paths.filter((line) => !telling(line))].slice(0, PATHS);
  };

  const m3u8Shape = (text) => {
    const tags = {};
    const media = [];
    for (const raw of text.split(/\r?\n/)) {
      if (!raw.startsWith("#")) continue;
      const tag = raw.slice(1).split(/[:\s]/)[0];
      tags[tag] = (tags[tag] || 0) + 1;
      if (tag === "EXT-X-MEDIA") {
        const attrs = {};
        for (const match of raw.matchAll(/([A-Z0-9-]+)=("([^"]*)"|[^,]*)/g)) attrs[match[1]] = match[3] ?? match[2];
        media.push(["TYPE", "LANGUAGE", "NAME", "FORCED", "CHARACTERISTICS", "AUTOSELECT", "DEFAULT"].filter((k) => k in attrs).map((k) => `${k}=${attrs[k]}`).join(","));
      }
    }
    return { kind: "m3u8", tags, media: media.slice(0, 40) };
  };

  const mpdShape = (text) => {
    const sets = [];
    for (const match of text.matchAll(/<(?:[\w-]+:)?AdaptationSet\b([^>]*)>([\s\S]*?)<\/(?:[\w-]+:)?AdaptationSet\s*>/g)) {
      const attrs = {};
      for (const pair of match[1].matchAll(/([\w:.-]+)\s*=\s*"([^"]*)"/g)) attrs[pair[1].replace(/^[\w-]+:/, "")] = pair[2];
      const inner = match[2];
      const has = (name) => new RegExp(`<(?:[\\w-]+:)?${name}\\b`).test(inner);
      const values = [...inner.matchAll(/<(?:[\w-]+:)?(Role|Accessibility)\b[^>]*\bvalue="([^"]*)"/g)].map((m) => `${m[1]}=${m[2]}`);
      sets.push({
        ...Object.fromEntries(["id", "contentType", "mimeType", "codecs", "lang"].filter((k) => k in attrs).map((k) => [k, attrs[k]])),
        roles: values,
        representations: (inner.match(/<(?:[\w-]+:)?Representation\b/g) || []).length,
        by: ["SegmentTemplate", "SegmentList", "SegmentBase", "BaseURL"].filter(has).join("+") || "none",
        timeline: has("SegmentTimeline"),
        protected: has("ContentProtection"),
      });
    }
    return { kind: "mpd", sets: sets.slice(0, 20) };
  };

  const digest = (type, text) => {
    const head = text.slice(0, 200).trimStart();
    try {
      if (/json/i.test(type) || /^[[{]/.test(head)) return { kind: "json", paths: jsonShape(JSON.parse(text)) };
    } catch {
      // Not JSON after all; fall through to the text shapes.
    }
    if (head.startsWith("#EXTM3U")) return m3u8Shape(text);
    if (/<(?:[\w-]+:)?MPD\b/.test(head)) return mpdShape(text);
    if (head.startsWith("WEBVTT")) return { kind: "vtt", cues: (text.match(/-->/g) || []).length };
    if (/<(?:[\w-]+:)?tt\b/.test(head)) return { kind: "ttml", cues: (text.match(/<(?:[\w-]+:)?p\b/g) || []).length };
    if (/^\d+\s*\r?\n\d\d:\d\d:\d\d/.test(head)) return { kind: "srt", cues: (text.match(/-->/g) || []).length };
    if (head.startsWith("<")) return { kind: "xml", root: /<([\w:-]+)/.exec(head.replace(/^<\?xml[^>]*>\s*/, ""))?.[1] || "" };
    return { kind: "text" };
  };

  // --- what is collected ---------------------------------------------------------

  const requests = new Map();
  let changed = new Set();
  let timer = null;

  const schedule = () => {
    if (timer) return;
    timer = setTimeout(flush, EVERY_MS);
  };

  /* One entry per shape. A request counts once, when it is made; its answer
   * fills the entry in the first time and is not counted again. */
  const noted = (key, entry, { made = false } = {}) => {
    const known = requests.get(key);
    if (known) {
      if (made) known.count += 1;
      if (entry.status !== undefined && known.status === undefined) Object.assign(known, entry);
      if (entry.digest && !known.digest) known.digest = entry.digest;
      if (entry.headers?.length) known.headers = [...new Set([...(known.headers || []), ...entry.headers])].sort();
    } else if (requests.size < SHAPES) {
      requests.set(key, { ...entry, count: 1 });
    } else {
      return;
    }
    changed.add(key);
    schedule();
  };

  const headerNames = (headers) => {
    try {
      if (!headers) return [];
      if (Array.isArray(headers)) return headers.map((entry) => (Array.isArray(entry) ? entry[0] : entry));
      if (typeof headers.keys === "function") return [...headers.keys()];
      return Object.keys(headers);
    } catch {
      return [];
    }
  };

  const request = (method, url, headers) => {
    const shape = shapeOf(url);
    const key = `${method} ${shape}`;
    noted(key, { method, url: shape, headers: headerNames(headers).map((h) => h.toLowerCase()).sort() }, { made: true });
    return key;
  };

  const answered = (key, status, type, text) => {
    const entry = { status, type: String(type || "").split(";")[0], bytes: typeof text === "string" ? text.length : undefined };
    if (typeof text === "string" && text.length && text.length <= BODY_MAX && (TEXT.test(entry.type || "") || /^[[{#<W]/.test(text.trimStart().slice(0, 1)))) {
      try {
        entry.digest = digest(entry.type, text);
      } catch {
        entry.digest = { kind: "unreadable" };
      }
    }
    noted(key, entry);
  };

  const originalFetch = window.fetch;
  window.fetch = function fetchWithSurvey(input, init) {
    const url = typeof input === "string" ? input : input?.url;
    const method = String(init?.method || input?.method || "GET").toUpperCase();
    const promise = originalFetch.apply(this, arguments);
    if (typeof url === "string") {
      const key = request(method, url, init?.headers || input?.headers);
      promise
        .then((response) => {
          const type = response.headers.get("content-type") || "";
          const length = Number(response.headers.get("content-length"));
          /* Read unless it is plainly media, or plainly big: a CDN serves a
           * playlist or a subtitle as octet-stream often enough. */
          const readable = !/^(video|audio|image|font)\//.test(type) && !(length > BODY_MAX);
          if (readable) {
            response.clone().text().then((text) => answered(key, response.status, type, text)).catch(() => answered(key, response.status, type));
          } else {
            answered(key, response.status, type);
          }
        })
        .catch(() => noted(key, { status: 0 }));
    }
    return promise;
  };

  const originalOpen = XMLHttpRequest.prototype.open;
  const originalSetHeader = XMLHttpRequest.prototype.setRequestHeader;
  XMLHttpRequest.prototype.setRequestHeader = function setWithSurvey(name) {
    (this.__ssoHeaders ||= []).push(String(name).toLowerCase());
    return originalSetHeader.apply(this, arguments);
  };
  XMLHttpRequest.prototype.open = function openWithSurvey(method, url) {
    const target = String(url ?? "");
    this.addEventListener("loadend", () => {
      try {
        const key = request(String(method || "GET").toUpperCase(), target, this.__ssoHeaders || []);
        const type = this.getResponseHeader("content-type") || "";
        const kind = this.responseType;
        let text;
        if (kind === "" || kind === "text") text = this.responseText;
        else if (kind === "json") text = JSON.stringify(this.response);
        answered(key, this.status, type, text);
      } catch {
        // The player's own handler runs regardless.
      }
    });
    return originalOpen.apply(this, arguments);
  };

  // --- the page ------------------------------------------------------------------

  const PLAYERS = ["shaka", "dashjs", "Hls", "videojs", "bitmovin", "THEOplayer", "jwplayer", "Clappr", "Plyr", "flowplayer", "MediaPlayer", "Bitmovin", "Radiant", "vimeo", "YT"];
  const drm = new Set();
  const dom = new Set();
  let lastPage = "";

  const nativeAccess = navigator.requestMediaKeySystemAccess?.bind(navigator);
  if (nativeAccess) {
    navigator.requestMediaKeySystemAccess = function accessWithSurvey(keySystem) {
      drm.add(String(keySystem));
      schedule();
      return nativeAccess.apply(navigator, arguments);
    };
  }

  const pageNow = () => {
    const videos = [...document.querySelectorAll("video")].slice(0, 4).map((video) => ({
      src: (video.currentSrc || video.getAttribute("src") || "").split(":")[0] || "none",
      duration: Number.isFinite(video.duration) ? Math.round(video.duration) : null,
      textTracks: [...(video.textTracks || [])].slice(0, 20).map((track) => ({
        kind: track.kind, label: track.label, language: track.language, mode: track.mode,
        cues: track.cues ? track.cues.length : null,
      })),
      tracks: [...video.querySelectorAll("track")].map((track) => ({
        kind: track.getAttribute("kind"), srclang: track.getAttribute("srclang"), label: track.getAttribute("label"),
        src: shapeOf(track.getAttribute("src") || ""),
      })),
    }));
    const players = PLAYERS.filter((name) => {
      try {
        return name in window && window[name] != null;
      } catch {
        return false;
      }
    });
    return { videos, players, drm: [...drm], dom: [...dom].slice(0, 30) };
  };

  const watchDom = () => {
    const consider = (element) => {
      if (!(element instanceof Element)) return;
      const name = `${element.tagName.toLowerCase()}${element.id ? `#${element.id}` : ""}${element.className && typeof element.className === "string" ? `.${element.className.trim().split(/\s+/).slice(0, 3).join(".")}` : ""}`;
      if (/subtitle|caption|cue|timedtext|vtt/i.test(name) && !dom.has(name) && dom.size < 30) {
        dom.add(name);
        schedule();
      }
    };
    new MutationObserver((records) => {
      for (const record of records) for (const node of record.addedNodes) consider(node);
    }).observe(document.documentElement, { subtree: true, childList: true });
    document.querySelectorAll("[class*=subtitle],[class*=caption],[id*=subtitle],[id*=caption],[class*=cue]").forEach(consider);
  };
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", watchDom, { once: true });
  else watchDom();

  function flush() {
    timer = null;
    const page = pageNow();
    const pageKey = JSON.stringify(page);
    const entries = [...changed].map((key) => requests.get(key)).filter(Boolean);
    changed = new Set();
    if (!entries.length && pageKey === lastPage) return;
    lastPage = pageKey;
    post({ type: "survey", entries, page, totals: { requests: requests.size } });
  }

  setInterval(() => {
    if (JSON.stringify(pageNow()) !== lastPage) schedule();
  }, EVERY_MS);
  window.addEventListener("pagehide", () => {
    clearTimeout(timer);
    timer = null;
    flush();
  });
})();
