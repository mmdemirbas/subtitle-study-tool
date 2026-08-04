/* Subtitle rendering and playback tracking.
 *
 * The overlay reads `video.currentTime` rather than keeping its own clock, so
 * seeking, pausing, buffering and rate changes need no handling at all. The
 * only offset left is the one baked into the subtitle file by being timed
 * against a different release, which is what the nudge controls adjust.
 *
 * Injected into every frame, because streaming players usually live in an
 * iframe. Frames without a usable video do nothing.
 *
 * Exposes `window.__ssoApi` for panel.js, which runs in the same isolated
 * world. That is not reachable from the page.
 */

(() => {
  "use strict";

  /* An earlier copy may already be running - the service worker re-injects on
   * update, because reloading an extension leaves open tabs on the previous
   * version. Hand over cleanly rather than bailing out: bailing would leave the
   * stale copy in charge, and simply running again would double every listener.
   */
  if (typeof window.__ssoTeardown === "function") {
    try {
      window.__ssoTeardown();
    } catch {
      // A broken predecessor must not stop the replacement from installing.
    }
  }

  const VERSION = chrome.runtime.getManifest().version;
  const TICK_MS = 50; // ~20 Hz: below perceptible latency, negligible cost
  const MIN_VIDEO_SECONDS = 60; // ignore ad breaks, teasers, autoplay loops
  const TOAST_MS = 1600;
  /* Sentinel for "redraw whatever is current". findCueIndex returns -1 when no
   * cue is active, so using -1 to mean "invalidate" collides with it: the tick
   * compares the new index against the old, sees -1 === -1, and skips the
   * render. That is invisible while a line is on screen and breaks exactly in
   * the gap between lines. */
  const NEEDS_REDRAW = -2;
  const SETTINGS_KEY = "sso:settings";

  /* Two subtitles at once, which is the whole point of studying with them: the
   * language being learnt and the one already known, on screen together, timed
   * against the same clock.
   *
   * Two rather than N. A third line has nowhere to go that does not cover the
   * film, and every part of this - geometry, offsets, which one the keys move -
   * gets an interface question the moment the count is open-ended. Two is what
   * a learner uses and it keeps all of those answers implicit. */
  const TRACK_COUNT = 2;
  const PRIMARY = 0;

  // Used by both the settings clamp and the drag; up here so neither section
  // owns them.
  const clamp = (value, low, high) => Math.min(Math.max(value, low), high);
  const round1 = (value) => Math.round(value * 10) / 10;

  /* Key bindings are stored as KeyboardEvent.code, which identifies the
   * physical key rather than the character it produces. On a Turkish Q layout
   * the keys right of P produce ğ and ü, but their codes are still
   * BracketLeft and BracketRight - so the default bindings stay physically
   * where they are on every layout, and remain rebindable besides. */
  /* Geometry is per track, appearance mostly is not.
   *
   * Position and width have to be per track - that is what side-by-side means -
   * and so does size, because the language being learnt wants to be bigger than
   * the one already known. The backdrop and the markup switches are properties
   * of "how subtitles look here", not of one file, so they stay shared. */
  const DEFAULT_TRACK = {
    // Centre of the cue box, as a percentage of the viewport. Percentages so a
    // position survives a resize or going fullscreen.
    posX: 50,
    posY: 92,
    // How wide the subtitle may get, again as a percentage of the viewport.
    widthPercent: 80,
    fontScale: 1,
    // False until dragged. While false a cue's own {\an8} may still move it,
    // and attaching a second subtitle may arrange both.
    placed: false,
  };

  /* Where the two go when a second one arrives and neither has been placed by
   * hand. Left and right halves, on the same baseline, because the eye reads
   * one line and then the other and should not have to move vertically to do
   * it. The boxes are anchored by their bottom edges, so the baseline holds
   * even when one language needs two lines and the other needs one.
   *
   * 44% wide at 26% and 74% leaves a margin at both screen edges and a gap of
   * four percent down the middle. Half the screen each, exactly, would put a
   * box against the edge of the frame and the two of them touching. */
  const SIDE_BY_SIDE = [
    { posX: 26, posY: 94, widthPercent: 44 },
    { posX: 74, posY: 94, widthPercent: 44 },
  ];

  /* One above the other. The gap is the taller of the two boxes plus a little,
   * so a two-line cue in the upper one does not reach the lower. */
  const STACKED = [
    { posX: 50, posY: 88, widthPercent: 80 },
    { posX: 50, posY: 96, widthPercent: 80 },
  ];

  const DEFAULT_SETTINGS = {
    background: 0.55,
    tracks: [
      { ...DEFAULT_TRACK },
      // The known language sits slightly smaller: it is there to be glanced at,
      // not read.
      { ...DEFAULT_TRACK, fontScale: 0.88 },
    ],
    // Let the box decide where lines break rather than the file. See rewrapRuns.
    rewrap: true,
    showSymbols: true,
    dimNonSpeech: true,
    smallStepMs: 250,
    largeStepMs: 1000,
    keys: {
      earlier: "BracketLeft",
      later: "BracketRight",
      reset: "Backslash",
      togglePanel: "KeyP",
      toggleOverlay: "KeyO",
      toggleStudy: "KeyS",
      saveWord: "KeyD",
    },
    keysEnabled: true,
  };

  /* Mid-roll ads and the clock they break.
   *
   * Prime stitches ads into the same stream (server-side ad insertion), so the
   * <video> element never changes and currentTime keeps advancing while the ad
   * plays. Film time stands still; stream time does not. Every cue after the
   * break is therefore late by exactly the ad's length, and the error adds up
   * across breaks - which is why the sync goes and never comes back.
   *
   * The fix is to measure each break and subtract it: film time is stream time
   * minus everything that was not the film. Measuring needs only the two
   * moments an ad starts and ends, which is why detection is the whole problem.
   *
   * No single selector is trustworthy - Prime has renamed player classes before
   * - so these are matched loosely and treated as hints, any one of which is
   * enough. */
  const AD_MARKERS = [
    '[class*="ad-timer"]',
    '[class*="adTimer"]',
    '[class*="ad-countdown"]',
    '[class*="adCountdown"]',
    '[class*="ad-badge"]',
    '[data-testid*="ad-timer"]',
    '[data-testid*="ad-badge"]',
  ].join(",");

  const AD_POLL_MS = 400;
  // A break shorter than this is noise; longer than this is not one ad break.
  const AD_MIN_MS = 2000;
  const AD_MAX_MS = 15 * 60 * 1000;

  /* One track's worth of playback state. The offset is per track because it
   * belongs to the file - two subtitles for the same film are routinely timed
   * against different releases, so syncing one says nothing about the other. */
  const newTrack = () => ({
    cues: [],
    offsetMs: 0,
    activeIndex: -1,
    label: "",
    fileId: null,
    language: "",
    visible: true,
  });

  const state = {
    tracks: Array.from({ length: TRACK_COUNT }, newTrack),
    /* Which track the nudge keys move. There is one pair of bracket keys and
     * now two things they could shift, and guessing from the pointer would make
     * the answer depend on where the mouse happens to be resting. The panel
     * names it instead, and every nudge says which track moved. */
    keyTrack: PRIMARY,
    // Accumulated ad time, kept apart from offsetMs because it belongs to this
    // viewing session, not to the subtitle file. Folding it into the saved
    // offset would corrupt the timing next time the film is opened. Shared:
    // an ad interrupts the video, not one of the subtitle files.
    adDriftMs: 0,
    inAd: false,
    adStartedAtMs: 0,
    // Placement mode. Cues come and go, so between two lines there is nothing
    // on screen to take hold of; this pins a stand-in until the position is
    // settled.
    placing: false,
    visible: true,
    video: null,
    settings: cloneSettings(DEFAULT_SETTINGS),
  };

  const attachedTracks = () => state.tracks.filter((track) => track.cues.length > 0);
  const anyAttached = () => state.tracks.some((track) => track.cues.length > 0);

  function cloneSettings(source) {
    return {
      ...source,
      keys: { ...source.keys },
      tracks: source.tracks.map((track) => ({ ...track })),
    };
  }

  const listeners = new Set();
  let host = null;      // in the page; geometry only
  let shadow = null;    // everything visible lives in here
  let overlaySheet = null;
  /* One view per track: a positioned root and the cue box inside it. Separate
   * roots rather than one root with two children, because position and width
   * are exactly what differs between the two and both live on the root. */
  let views = [];
  let toast = null;
  let toastTimer = null;
  let handle = null;
  let handleTimer = null;
  let ticker = null;

  // --- video selection ------------------------------------------------------

  /* The video the user is watching is the biggest one with a real duration.
   * Pages routinely hold several - preview loops, ad slots, hidden elements. */
  function pickVideo() {
    const candidates = Array.from(document.querySelectorAll("video")).filter((video) => {
      if (!Number.isFinite(video.duration) || video.duration < MIN_VIDEO_SECONDS) return false;
      const box = video.getBoundingClientRect();
      return box.width > 200 && box.height > 100;
    });
    if (candidates.length === 0) return null;

    candidates.sort((a, b) => {
      const playing = Number(!b.paused) - Number(!a.paused);
      if (playing !== 0) return playing;
      const aBox = a.getBoundingClientRect();
      const bBox = b.getBoundingClientRect();
      return bBox.width * bBox.height - aBox.width * aBox.height;
    });
    return candidates[0];
  }

  const hasPlayableVideo = () => pickVideo() !== null;

  /* A page with a video on it is not the same as a page you are watching.
   *
   * Feed rows play a hover preview, and a preview is a real <video>: playing,
   * unhidden, carrying the film's whole duration. Measured on YouTube's results
   * page it is 504x211 with duration 464s, which passes every test above - so
   * the CC handle appeared over a thumbnail on the home page, on a page with
   * nothing to subtitle.
   *
   * Two things separate a preview from a player, both measured rather than
   * assumed:
   *
   *   - It sits inside a link (`a#media-container-link`), because clicking it
   *     navigates to the video. A player you are watching is never inside a
   *     link - clicking it pauses.
   *   - It is small: 7.4% of the window, against the watch page's 32%. An
   *     embedded player is a whole frame of its own, so it measures near 100%.
   *
   * This gates the handle only. Which video gets subtitles remains pickVideo's
   * decision, and the frame the popup addresses remains hasPlayableVideo's, so
   * a video this declines to decorate is still reachable from the keyboard and
   * from the toolbar. A false negative costs a shortcut; a false positive puts
   * a button over someone's homepage. */
  const SUBJECT_VIEWPORT_SHARE = 0.12;

  function isPageSubject(video) {
    if (!video || video.closest("a")) return false;
    const viewport = window.innerWidth * window.innerHeight;
    if (!viewport) return false;
    const box = video.getBoundingClientRect();
    return (box.width * box.height) / viewport >= SUBJECT_VIEWPORT_SHARE;
  }

  // --- page metadata --------------------------------------------------------

  /* The tab title is the worst of the available signals: Prime Video titles a
   * detail page "Prime Video: Crime 101", and other sites append episode
   * numbers, resolutions and marketing. og:title and JSON-LD are what the site
   * tells crawlers the page is about, so they are tried first. */
  function pageInfo() {
    const candidates = [];

    const push = (value, source) => {
      const text = String(value || "").trim();
      if (text) candidates.push({ text, source });
    };

    let year = null;
    const noteYear = (value) => {
      const match = String(value || "").match(/\b(19[0-9]{2}|20[0-4][0-9])\b/);
      if (match && year === null) year = Number(match[1]);
    };

    for (const item of readJsonLd()) {
      if (/^(Movie|TVEpisode|TVSeries|VideoObject|CreativeWork)$/i.test(item["@type"] || "")) {
        push(item.name, "json-ld");
        if (item.partOfSeries?.name) push(item.partOfSeries.name, "json-ld-series");
        noteYear(item.datePublished || item.dateCreated || item.copyrightYear);
      }
    }

    push(document.querySelector('meta[property="og:title"]')?.content, "og:title");
    push(document.querySelector('meta[name="twitter:title"]')?.content, "twitter:title");
    push(document.querySelector("h1")?.textContent, "h1");
    push(document.title, "document.title");

    /* The release year is what tells one "Mercy" from the other seventeen.
     * Titles alone cannot: the index holds eighteen entries with that exact
     * name, so without a year the pick comes down to a tiebreak that has
     * nothing to do with which film is on screen.
     *
     * Streaming pages print the year next to the title, so scrape it from the
     * places it turns up, most reliable first. */
    noteYear(document.querySelector('meta[itemprop="datePublished"]')?.content);
    for (const candidate of candidates) noteYear(candidate.text);
    if (year === null) {
      // Prime and Netflix both render it as a bare 4-digit chip near the title.
      const near = document.querySelector("h1")?.closest("div")?.textContent || "";
      noteYear(near.slice(0, 400));
    }

    return { candidates, year, url: location.href };
  }

  function readJsonLd() {
    const found = [];
    for (const node of document.querySelectorAll('script[type="application/ld+json"]')) {
      try {
        const parsed = JSON.parse(node.textContent || "{}");
        found.push(...(Array.isArray(parsed) ? parsed : [parsed]));
      } catch {
        // Sites ship malformed JSON-LD routinely; skip it.
      }
    }
    return found;
  }

  // --- diagnostics ----------------------------------------------------------

  /* What this frame can see, for when a page does not work and nobody can say
   * why from the outside.
   *
   * It exists because the interesting failures are all invisible from the
   * console: the metadata is in one frame and the video is in another, the
   * content script did or did not load somewhere, the title that got searched
   * for is not the title on screen. Every one of those is a question about
   * which frame saw what, and a frame can only be asked from inside it.
   *
   * Collected per frame and merged by the service worker, which is the only
   * thing that can see all of them at once.
   */

  /* Episode markers, found by shape rather than by selector.
   *
   * A site that lists episodes does it with its own class names - `btn-episode`
   * on one, `ep-item` on another, an <option> on a third - so matching known
   * selectors would only ever work on pages somebody had already looked at.
   * What does not vary is that the control says which episode it is, in one of
   * a few notations, and that the one being watched is marked as chosen.
   *
   * Reported rather than acted on: this is the part most likely to be wrong on
   * a page nobody has seen, so it produces evidence first. */
  const EPISODE_PATTERNS = [
    // S01E01, S01-E01, S1 E1, s01.e01
    /\bS\s*(?<season>\d{1,2})\s*[.\-_ ]?\s*E\s*(?<episode>\d{1,3})\b/i,
    // 1x01
    /\b(?<season>\d{1,2})\s*x\s*(?<episode>\d{1,3})\b/i,
    // Season 1 Episode 2, Sezon 1 Bölüm 2
    /\b(?:season|sezon)\s*(?<season>\d{1,2})\D{1,12}(?:episode|ep|bölüm|bolum)\s*(?<episode>\d{1,3})\b/i,
  ];

  function matchEpisode(text) {
    for (const pattern of EPISODE_PATTERNS) {
      const match = pattern.exec(text);
      if (match?.groups) {
        return {
          season: Number(match.groups.season),
          episode: Number(match.groups.episode),
          matched: match[0],
        };
      }
    }
    return null;
  }

  /* "Chosen" is spelled a dozen ways. Checked on the element and a couple of
   * ancestors, because half the sites that mark a selection mark the <li> and
   * not the <a> inside it. */
  const SELECTED_CLASS = /(?:^|[\s_-])(?:active|current|selected|playing|watching|on)(?:$|[\s_-])/i;

  function selectionEvidence(node) {
    const reasons = [];
    let cursor = node;
    for (let depth = 0; cursor && depth < 3; depth++, cursor = cursor.parentElement) {
      const className = String(cursor.className || "");
      if (SELECTED_CLASS.test(className)) reasons.push(`class "${className.slice(0, 60)}"@${depth}`);
      if (cursor.getAttribute?.("aria-current")) reasons.push(`aria-current@${depth}`);
      if (cursor.getAttribute?.("aria-selected") === "true") reasons.push(`aria-selected@${depth}`);
      if (cursor.hasAttribute?.("selected")) reasons.push(`selected@${depth}`);
      if (cursor.dataset?.active != null) reasons.push(`data-active@${depth}`);
    }
    return reasons;
  }

  /** A short, readable path to an element, for pasting into a bug report. */
  function describeNode(node) {
    const parts = [];
    let cursor = node;
    for (let depth = 0; cursor && depth < 4; depth++, cursor = cursor.parentElement) {
      const tag = cursor.tagName?.toLowerCase();
      if (!tag) break;
      const id = cursor.id ? `#${cursor.id}` : "";
      const cls = String(cursor.className || "")
        .split(/\s+/)
        .filter(Boolean)
        .slice(0, 2)
        .map((name) => `.${name}`)
        .join("");
      parts.unshift(`${tag}${id}${cls}`);
    }
    return parts.join(" > ");
  }

  /* Reported markers, and the ceiling on how many are examined.
   *
   * These are different numbers for a reason found by running this: a full
   * series page carries one control per episode - 75 of them for The Americans
   * - and they are listed newest first, so the one being watched was 75th.
   * Stopping the *scan* at the reporting limit threw it away and the report
   * then said, with no caveat, that the page marked no episode as chosen. A cap
   * applied before the filter is a cap on the answer. */
  const MAX_MARKERS_REPORTED = 40;
  const MAX_NODES_SCANNED = 4000;

  function episodeMarkers() {
    const found = [];
    let scanned = 0;

    /* Elements with children are usually the list, not an item in it, and the
     * list's textContent contains every episode - so it matches the first one
     * and reports the wrong number with total confidence. Two children is the
     * allowance for an item that wraps its label in a span or carries an icon. */
    for (const node of document.querySelectorAll("a,button,li,span,div,option,h1,h2,h3,p")) {
      if (++scanned > MAX_NODES_SCANNED) break;
      if (node.children.length > 2) continue;
      const text = (node.textContent || "").replace(/\s+/g, " ").trim();
      if (!text || text.length > 60) continue;
      const match = matchEpisode(text);
      if (!match) continue;

      const selected = selectionEvidence(node);
      found.push({
        ...match,
        text: text.slice(0, 60),
        path: describeNode(node),
        selected: selected.length > 0,
        selectedBecause: selected,
        visible: node.getBoundingClientRect().width > 0,
      });
    }

    // Selected first, then visible: that is the order a reader wants them in,
    // and it is what decides which survive the cut below.
    found.sort(
      (a, b) => Number(b.selected) - Number(a.selected) || Number(b.visible) - Number(a.visible),
    );

    return {
      total: found.length,
      // Never a silent truncation: the report says how many were left out.
      omitted: Math.max(0, found.length - MAX_MARKERS_REPORTED),
      scanLimitHit: scanned > MAX_NODES_SCANNED,
      markers: found.slice(0, MAX_MARKERS_REPORTED),
    };
  }

  function describeVideo(video) {
    if (!video) return null;
    const box = video.getBoundingClientRect();
    return {
      duration: Number.isFinite(video.duration) ? Math.round(video.duration) : null,
      currentTime: Math.round(video.currentTime),
      paused: video.paused,
      width: Math.round(box.width),
      height: Math.round(box.height),
      // The URL itself is not wanted - it is long, single-use and identifying.
      // Which kind it is answers the only question worth asking of it.
      source: /^blob:/.test(video.currentSrc || "")
        ? "blob (MSE)"
        : video.currentSrc
          ? "direct"
          : "none",
      insideLink: Boolean(video.closest("a")),
      viewportShare: Number(
        ((box.width * box.height) / (window.innerWidth * window.innerHeight || 1)).toFixed(3),
      ),
    };
  }

  function diagnose() {
    const info = pageInfo();
    const chosen = pickVideo();
    const allVideos = Array.from(document.querySelectorAll("video"));

    return {
      url: location.href,
      isTopFrame: window === window.top,
      title: document.title,
      version: VERSION,

      // What the title guess would be built from, in the order it prefers.
      titleCandidates: info.candidates,
      year: info.year,

      // The question the search cannot currently answer.
      episodes: episodeMarkers(),
      episodeInTitle: matchEpisode(document.title),
      episodeInUrl: matchEpisode(decodeURIComponent(location.pathname + location.search)),

      videoCount: allVideos.length,
      // Every video, so "the one it picked is not the one playing" is visible.
      videos: allVideos.slice(0, 6).map(describeVideo),
      chosenVideo: describeVideo(chosen),
      hasPlayableVideo: chosen !== null,
      isPageSubject: isPageSubject(chosen),

      // Whether the ad correction could fire here at all.
      adMarkersMatched: document.querySelectorAll(AD_MARKERS).length,
      inAd: state.inAd,
      adDriftMs: state.adDriftMs,

      attached: state.tracks.map((track, slot) => ({
        slot,
        attached: track.cues.length > 0,
        cueCount: track.cues.length,
        label: track.label,
        language: track.language,
        fileId: track.fileId,
        offsetMs: track.offsetMs,
      })),
    };
  }

  // --- settings -------------------------------------------------------------

  async function loadSettings() {
    try {
      const stored = await chrome.storage.local.get(SETTINGS_KEY);
      const saved = stored[SETTINGS_KEY];
      if (saved) state.settings = migrate(saved);
    } catch {
      // Defaults are fine.
    }
    applySettings();
  }

  /* Older versions stored one subtitle's geometry at the top level, because
   * there was only ever one. Those values are the primary track's now - lifted
   * rather than dropped, so a position someone settled on survives the upgrade
   * instead of jumping back to the middle on the next film. */
  function migrate(saved) {
    const next = {
      ...DEFAULT_SETTINGS,
      ...saved,
      keys: { ...DEFAULT_SETTINGS.keys, ...(saved.keys || {}) },
      tracks: DEFAULT_SETTINGS.tracks.map((base, slot) => ({
        ...base,
        ...(saved.tracks?.[slot] || {}),
      })),
    };

    if (!saved.tracks) {
      const primary = next.tracks[PRIMARY];
      for (const key of ["posX", "posY", "widthPercent", "fontScale", "placed"]) {
        if (saved[key] != null) primary[key] = saved[key];
      }
      // A height set with the slider older still, which measured up from the
      // bottom rather than down from the top.
      if (saved.bottomPercent != null && saved.posY == null) {
        primary.posY = 100 - Number(saved.bottomPercent);
        primary.placed = true;
      }
    }

    for (const key of ["posX", "posY", "widthPercent", "fontScale", "placed", "bottomPercent"]) {
      delete next[key];
    }
    return next;
  }

  function updateSettings(patch) {
    const next = {
      ...state.settings,
      ...patch,
      keys: { ...state.settings.keys, ...(patch.keys || {}) },
      tracks: state.settings.tracks.map((track) => ({ ...track })),
    };
    if (patch.tracks) {
      next.tracks = next.tracks.map((track, slot) => ({ ...track, ...(patch.tracks[slot] || {}) }));
    }

    /* Keep each box on screen horizontally, here rather than in the drag alone.
     * A drag can only measure the line in front of it, so a position set
     * against a short line let the next long one hang off the edge - 101px of
     * it, on a 360px viewport - and widening the box afterwards did the same
     * to a position that was legal when it was set. The width setting bounds
     * the box whatever the line, so half of it is as close as the centre may
     * come to either edge. Vertically the height is text-dependent and has no
     * such bound, so that clamp stays with the drag, which can measure it. */
    for (const track of next.tracks) {
      const half = track.widthPercent / 2;
      track.posX = round1(clamp(track.posX, half, 100 - half));
    }

    state.settings = next;
    applySettings();
    chrome.storage.local.set({ [SETTINGS_KEY]: state.settings }).catch(() => {});
    notify();
  }

  /** Patch one track's geometry, leaving the other alone. */
  function updateTrackSettings(slot, patch) {
    const tracks = [];
    tracks[slot] = patch;
    updateSettings({ tracks });
  }

  function resetSettings() {
    updateSettings(cloneSettings(DEFAULT_SETTINGS));
  }

  /* Put both boxes somewhere sensible in one action.
   *
   * An arrangement is a button, not a mode. Position stays something you set by
   * dragging, and a stored "layout mode" would have to be either overridden by
   * the next drag - in which case it is not a mode - or defended against it, in
   * which case dragging stops working. So this writes the two geometries once
   * and then gets out of the way. */
  function arrange(name) {
    const preset = name === "stacked" ? STACKED : SIDE_BY_SIDE;
    updateSettings({ tracks: preset.map((geometry) => ({ ...geometry, placed: true })) });
  }

  function applySettings() {
    if (views.length === 0) return;
    const { background, dimNonSpeech } = state.settings;

    views.forEach((view, slot) => {
      const track = state.settings.tracks[slot];
      const { root } = view;
      root.style.setProperty("--sso-font-size", `${2.6 * track.fontScale}vh`);
      root.style.setProperty("--sso-bg", `rgba(0, 0, 0, ${background})`);
      root.style.setProperty("--sso-x", `${track.posX}%`);
      root.style.setProperty("--sso-y", `${track.posY}%`);
      root.style.setProperty("--sso-width", `${track.widthPercent}vw`);
      root.dataset.dim = dimNonSpeech ? "true" : "false";
      // Once placed by hand, a cue's own {\an8} no longer moves it.
      root.dataset.placed = track.placed ? "manual" : "auto";
    });

    // Symbols and wrapping are part of the rendered content, so a change needs
    // a redraw of whatever is currently on screen.
    for (const track of state.tracks) track.activeIndex = NEEDS_REDRAW;
  }

  // --- dragging the subtitle ------------------------------------------------

  /* The overlay is click-through by design, so the cue is the one part that
   * takes pointer events. That creates a conflict: the subtitle sits in the
   * middle-bottom of the screen, which is exactly where people click to pause.
   *
   * Resolved by distinguishing a drag from a click. Movement past a few pixels
   * is a drag; anything less is forwarded to whatever is underneath, by hiding
   * the cue for one hit-test and re-dispatching the click there. So the film
   * keeps its clicks and the subtitle is still movable. */
  const DRAG_THRESHOLD_PX = 4;
  const RESIZE_EDGE_PX = 16;
  const MIN_WIDTH_PERCENT = 20;
  const MAX_WIDTH_PERCENT = 100;
  let drag = null;

  /* Either vertical edge of the cue resizes it; the middle moves it. On a box
   * narrower than four edge-widths the two zones would meet in the middle and
   * there would be nowhere left to grab, so a short cue is all middle. */
  function edgeAt(slot, clientX) {
    const box = views[slot].cueBox.getBoundingClientRect();
    if (box.width < RESIZE_EDGE_PX * 4) return 0;
    if (clientX - box.left <= RESIZE_EDGE_PX) return -1;
    if (box.right - clientX <= RESIZE_EDGE_PX) return 1;
    return 0;
  }

  function onCuePointerDown(slot, event) {
    if (event.button !== 0) return;

    /* Study mode wants two gestures that would otherwise be the box's: shift
     * and drag selects a phrase, and a press on a word ends in a lookup rather
     * than in the click being handed to the player. It gets first refusal on
     * the press, and everything it declines behaves exactly as it did before
     * study mode existed. */
    if (window.__ssoStudy?.claimPointerDown?.(slot, event)) return;

    drag = {
      slot,
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      moved: false,
      sizing: edgeAt(slot, event.clientX) !== 0,
    };
    views[slot].cueBox.setPointerCapture(event.pointerId);
  }

  function onCuePointerMove(slot, event) {
    if (!drag || event.pointerId !== drag.pointerId) {
      // Not dragging: say which of the two things a press here would do.
      if (!drag) {
        views[slot].cueBox.style.cursor = edgeAt(slot, event.clientX) ? "ew-resize" : "";
      }
      return;
    }

    if (drag.sizing) {
      onResizeMove(event);
      return;
    }

    if (!drag.moved) {
      const far =
        Math.abs(event.clientX - drag.startX) > DRAG_THRESHOLD_PX ||
        Math.abs(event.clientY - drag.startY) > DRAG_THRESHOLD_PX;
      if (!far) return;
      drag.moved = true;
      views[drag.slot].root.dataset.dragging = "true";
    }

    /* Vertical clamp only, so the subtitle cannot be dragged off the bottom or
     * top and lost. The horizontal one belongs to updateSettings, which knows
     * the width the box is allowed rather than the width of this one line.
     *
     * posY is the box's bottom edge, so it may reach 100 but never go below its
     * own height - at which point the top of the box is at the top of the
     * screen. */
    const box = views[drag.slot].cueBox.getBoundingClientRect();
    const height = (box.height / window.innerHeight) * 100;
    const x = (event.clientX / window.innerWidth) * 100;
    const y = clamp((event.clientY / window.innerHeight) * 100, height, 100);

    updateTrackSettings(drag.slot, { posX: round1(x), posY: round1(y), placed: true });
  }

  /* The box grows about its centre, so the width is twice the distance from
   * the centre to the pointer. Measured from the stored centre rather than the
   * box's own, which shifts as the box grows and would have the drag chasing
   * itself. */
  function onResizeMove(event) {
    if (!drag.moved) {
      if (Math.abs(event.clientX - drag.startX) <= DRAG_THRESHOLD_PX) return;
      drag.moved = true;
      views[drag.slot].root.dataset.sizing = "true";
    }
    const centre = (state.settings.tracks[drag.slot].posX / 100) * window.innerWidth;
    const half = Math.abs(event.clientX - centre);
    const percent = ((half * 2) / window.innerWidth) * 100;
    updateTrackSettings(drag.slot, {
      widthPercent: round1(clamp(percent, MIN_WIDTH_PERCENT, MAX_WIDTH_PERCENT)),
      placed: true,
    });
  }

  // No slot argument: the press decided which box is being dragged, and the
  // pointer is captured, so the release belongs to that box whatever it is over.
  function onCuePointerUp(event) {
    if (!drag || event.pointerId !== drag.pointerId) return;
    const { moved, startX, startY } = drag;
    const view = views[drag.slot];
    drag = null;
    view.cueBox.releasePointerCapture?.(event.pointerId);
    view.root.dataset.dragging = "false";
    view.root.dataset.sizing = "false";

    if (!moved) forwardClickBeneath(startX, startY, event);
  }

  /* Both boxes have to be transparent to the hit test, not just the one that
   * was pressed: with two subtitles side by side the other is often what sits
   * under the pointer, and leaving it hittable would forward the click to a
   * subtitle rather than to the film. */
  function forwardClickBeneath(x, y, source) {
    const previous = views.map((view) => view.cueBox.style.pointerEvents);
    for (const view of views) view.cueBox.style.pointerEvents = "none";
    const target = document.elementFromPoint(x, y);
    views.forEach((view, slot) => {
      view.cueBox.style.pointerEvents = previous[slot];
    });
    if (!target || views.some((view) => view.cueBox === target)) return;

    for (const type of ["pointerdown", "mousedown", "mouseup", "click"]) {
      target.dispatchEvent(
        new MouseEvent(type, {
          bubbles: true,
          cancelable: true,
          composed: true,
          clientX: x,
          clientY: y,
          button: source.button,
        }),
      );
    }
  }

  // --- overlay --------------------------------------------------------------

  /* The overlay lives in a shadow root, for the same reason the panel does.
   *
   * In the page's own DOM it loses two fights it cannot win. Styling: a host
   * rule as ordinary as `span { font-style: normal }` cancels italics, and
   * broad colour resets flatten the speaker and sound colouring - reported as
   * "markup highlight was not working". Stacking: an element the player appends
   * later with the same z-index paints over ours, which is how a button pinned
   * at 2147483647 becomes invisible - reported as "I cannot see any CC button".
   *
   * A shadow boundary settles the first. Re-appending the host settles the
   * second: among equal z-index, last in the DOM wins. */
  function ensureOverlay() {
    if (host && host.isConnected) {
      attachToCorrectParent();
      return;
    }

    host = document.createElement("div");
    for (const [property, value] of Object.entries({
      all: "initial",
      position: "fixed",
      inset: "0",
      "z-index": "2147483647",
      display: "block",
      // The film must stay clickable; only the handle opts back in.
      "pointer-events": "none",
    })) {
      host.style.setProperty(property, value, "important");
    }

    shadow = host.attachShadow({ mode: "open" });
    if (overlaySheet) shadow.adoptedStyleSheets = [overlaySheet];

    views = Array.from({ length: TRACK_COUNT }, (_, slot) => buildView(slot));

    toast = document.createElement("div");
    toast.className = "sso-toast";

    handle = buildHandle();
    shadow.append(...views.map((view) => view.root), toast, handle);

    applySettings();
    attachToCorrectParent();
  }

  function buildView(slot) {
    const root = document.createElement("div");
    root.className = "sso-root";
    root.dataset.slot = String(slot);

    const cueBox = document.createElement("div");
    cueBox.className = "sso-cue";
    cueBox.title = "Drag to move the subtitles";
    cueBox.addEventListener("pointerdown", (event) => onCuePointerDown(slot, event));
    cueBox.addEventListener("pointermove", (event) => onCuePointerMove(slot, event));
    cueBox.addEventListener("pointerup", onCuePointerUp);
    cueBox.addEventListener("pointercancel", onCuePointerUp);
    root.appendChild(cueBox);

    return { root, cueBox };
  }

  /* Constructable stylesheet rather than a <style> element: adopted sheets are
   * not subject to the page's Content-Security-Policy, and streaming sites ship
   * strict style-src. Loaded once, before anything renders. */
  async function loadOverlayStyles() {
    if (overlaySheet) return overlaySheet;
    try {
      const css = await fetch(chrome.runtime.getURL("src/overlay.css")).then((r) => r.text());
      overlaySheet = new CSSStyleSheet();
      overlaySheet.replaceSync(css);
      if (shadow) shadow.adoptedStyleSheets = [overlaySheet];
    } catch {
      // Without the sheet cues still render, unstyled. Better than nothing.
    }
    return overlaySheet;
  }

  /* A small on-screen way into the control panel.
   *
   * The panel had been reachable only by a keyboard command, and Chrome does
   * not reliably bind a suggested_key that was added to an extension already
   * installed - so for some users there was simply no way to open it. An
   * element in the page cannot fail that way.
   *
   * It fades in with mouse movement and out again when the mouse rests, so it
   * is available while you are reaching for it and invisible while you watch. */
  function buildHandle() {
    const node = document.createElement("button");
    node.type = "button";
    node.className = "sso-handle";
    node.title = "Subtitle controls";
    node.setAttribute("aria-label", "Subtitle controls");
    node.textContent = "CC";
    node.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      window.__ssoPanel?.toggle();
    });

    /* Every property that decides whether this is on screen is set inline and
     * !important, because it is a <button> living in the page's own DOM and
     * streaming sites reset buttons hard. A single `button { position:
     * relative }` or `button { opacity: 0 }` in the host page is enough to
     * make it invisible, and the stylesheet loses that argument on
     * specificity. The panel had the same exposure and was moved into a shadow
     * root; one button does not justify a second shadow tree, but it does
     * justify winning the cascade outright. */
    node.style.setProperty("pointer-events", "auto", "important");
    return node;
  }

  function revealHandle() {
    if (!handle) return;
    handle.dataset.visible = "true";
    // Among equal z-index the last element in the DOM wins, and players append
    // their chrome continuously. Re-appending keeps the overlay on top.
    attachToCorrectParent({ raise: true });
    clearTimeout(handleTimer);
    handleTimer = setTimeout(() => {
      if (handle && !handle.matches(":hover")) handle.dataset.visible = "false";
    }, 2600);
  }

  /* Fullscreen is the detail that breaks naive overlays: the browser renders
   * only the fullscreen element's subtree, so an overlay parented to <body>
   * silently disappears. Re-parent on every change. */
  function attachToCorrectParent({ raise = false } = {}) {
    const parent =
      document.fullscreenElement ||
      document.webkitFullscreenElement ||
      document.body ||
      document.documentElement;
    if (!parent || !host) return;
    if (host.parentElement !== parent || raise) parent.appendChild(host);
    if (window.__ssoPanel?.reparent) window.__ssoPanel.reparent(parent);
    if (window.__ssoStudy?.reparent) window.__ssoStudy.reparent(parent);
  }

  function showToast(message) {
    ensureOverlay();
    toast.textContent = message;
    toast.dataset.visible = "true";
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => {
      toast.dataset.visible = "false";
    }, TOAST_MS);
  }

  // --- cue lookup -----------------------------------------------------------

  function findCueIndex(cues, timeMs) {
    let low = 0;
    let high = cues.length - 1;
    while (low <= high) {
      const mid = (low + high) >> 1;
      const cue = cues[mid];
      if (timeMs < cue.start) high = mid - 1;
      else if (timeMs > cue.end) low = mid + 1;
      else return mid;
    }
    return -1;
  }

  function tick() {
    if (!state.video || !state.video.isConnected) {
      state.video = pickVideo();
      if (!state.video) return;
    }
    if (!state.visible || !anyAttached()) {
      // "Nothing is showing", not "redraw" - otherwise this clears the text on
      // every tick forever.
      state.tracks.forEach((track, slot) => {
        if (track.activeIndex === -1) return;
        track.activeIndex = -1;
        if (views[slot]) views[slot].cueBox.textContent = "";
      });
      return;
    }
    ensureOverlay();
    pollAdState();

    state.tracks.forEach((track, slot) => {
      if (state.inAd || !track.visible || track.cues.length === 0) {
        // Film subtitles over an advert are worse than none.
        if (track.activeIndex !== -1) {
          track.activeIndex = -1;
          renderCue(slot, null);
        }
        return;
      }

      const index = findCueIndex(track.cues, filmTimeMs(track));
      if (index === track.activeIndex) return;
      track.activeIndex = index;
      renderCue(slot, index === -1 ? null : track.cues[index]);
    });
  }

  /** Stream time, less this subtitle's own offset and everything that was an ad. */
  function filmTimeMs(track) {
    return state.video.currentTime * 1000 - track.offsetMs - state.adDriftMs;
  }

  let lastAdPoll = 0;

  /* Detecting the two edges of an ad break is the entire mechanism: the gap
   * between them, measured in stream time, IS the correction. */
  function pollAdState() {
    const now = performance.now();
    if (now - lastAdPoll < AD_POLL_MS) return;
    lastAdPoll = now;

    const showing = adMarkerVisible();
    if (showing === state.inAd) return;

    const streamMs = state.video.currentTime * 1000;
    if (showing) {
      state.inAd = true;
      state.adStartedAtMs = streamMs;
      showToast("Ad break — subtitles paused");
    } else {
      const elapsed = streamMs - state.adStartedAtMs;
      state.inAd = false;
      // Guard both ends. A negative or tiny gap means the marker flickered; an
      // implausibly long one means we mistook something else for an ad and
      // adding it would wreck the timing rather than repair it.
      if (elapsed >= AD_MIN_MS && elapsed <= AD_MAX_MS) {
        state.adDriftMs += elapsed;
        showToast(`Ad break over — subtitles shifted ${(elapsed / 1000).toFixed(0)}s`);
      }
      for (const track of state.tracks) track.activeIndex = NEEDS_REDRAW;
    }
    notify();
  }

  function adMarkerVisible() {
    for (const node of document.querySelectorAll(AD_MARKERS)) {
      const box = node.getBoundingClientRect();
      if (box.width > 0 && box.height > 0) return true;
    }
    return false;
  }

  /* Builds the cue out of elements rather than assigning markup.
   *
   * The daemon splits a cue into runs - dialogue, speaker labels, sound
   * descriptions - each with its own styling. Speech stays at full strength;
   * everything else is dimmed, because it is context rather than something
   * being said. Sounds that recur get a symbol next to the words, which is
   * worth more than decoration when the subtitles are being read to learn the
   * language: the glyph attaches to the word on sight.
   *
   * Text always goes in through createTextNode, never innerHTML, so nothing in
   * a downloaded subtitle can become markup in the page. */
  /* Subtitle files hard-wrap their own lines - around forty characters, two
   * lines, a habit inherited from 4:3 television. Honouring those breaks
   * literally makes the box hug the longest line in the *file*, so a cue that
   * would sit comfortably on one line of a widescreen arrives as two short
   * ones and the width setting has nothing to act on. Measured on a 1200px
   * window: 45% of the screen with the file's breaks, 84% without.
   *
   * So the breaks are advisory and the box does the wrapping - except where a
   * break carries meaning. A line opening with a dash is the second speaker's
   * turn and a line opening with a note is a separate sung phrase; joining
   * either would put two voices on one line. */
  const TURN_START = /^[\s ]*(?:[-–—]|♪|♫)/;

  function rewrapText(text) {
    return text.replace(/\n+/g, (match, at) =>
      TURN_START.test(text.slice(at + match.length)) ? match : " ",
    );
  }

  /* The same rule across a cue's runs. A break can sit at the end of one run
   * with the dash that justifies it at the start of the next, so the decision
   * reads the whole cue while the replacement stays inside its own run. */
  function rewrapRuns(runs) {
    const full = runs.map((run) => run.text).join("");
    let base = 0;
    return runs.map((run) => {
      const start = base;
      base += run.text.length;
      if (!run.text.includes("\n")) return run;
      const text = run.text.replace(/\n+/g, (match, at) =>
        TURN_START.test(full.slice(start + at + match.length)) ? match : " ",
      );
      return { ...run, text };
    });
  }

  function renderCue(slot, cue) {
    const { root, cueBox } = views[slot];
    cueBox.replaceChildren();
    root.dataset.vertical = cue?.vertical || "bottom";
    if (!cue) {
      if (state.placing) cueBox.textContent = `Drag me — subtitle ${slot + 1}`;
      // Tell study mode the line ended, so a lookup does not outlive the line
      // that raised it.
      window.__ssoStudy?.onCue?.(slot, null, cueBox);
      return;
    }

    const rewrap = state.settings.rewrap;

    if (!cue.runs) {
      cueBox.textContent = rewrap ? rewrapText(cue.text) : cue.text;
    } else {
      for (const run of rewrap ? rewrapRuns(cue.runs) : cue.runs) {
        const span = document.createElement("span");
        span.className = "sso-run";
        if (run.kind) span.classList.add(`sso-${run.kind}`);
        for (const style of run.styles || []) span.classList.add(`sso-${style}`);
        // Colour is validated against an allowlist daemon-side, so it can only
        // ever be a hex literal or a known CSS colour name.
        if (run.color) span.style.color = run.color;

        if (run.symbol && state.settings.showSymbols) {
          const symbol = document.createElement("span");
          symbol.className = "sso-symbol";
          symbol.textContent = run.symbol;
          span.append(symbol);
        }
        span.append(document.createTextNode(run.text));
        cueBox.append(span);
      }
    }

    /* Study mode gets the finished box rather than a hook inside the loop
     * above. Splitting the line into words is its business, it only happens
     * while study mode is on, and doing it here would put a branch in the
     * middle of the one function that runs for every line of every film. */
    window.__ssoStudy?.onCue?.(slot, cue, cueBox);
  }

  function startTicking() {
    if (ticker === null) ticker = setInterval(tick, TICK_MS);
  }

  // --- offset ---------------------------------------------------------------

  const offsetKey = (fileId) => `sso:offset:${fileId}`;

  async function loadOffset(fileId) {
    if (fileId == null) return 0;
    try {
      const stored = await chrome.storage.local.get(offsetKey(fileId));
      return Number(stored[offsetKey(fileId)]) || 0;
    } catch {
      return 0;
    }
  }

  function saveOffset(track) {
    if (track.fileId == null) return;
    chrome.storage.local.set({ [offsetKey(track.fileId)]: track.offsetMs }).catch(() => {});
  }

  function setOffset(ms, { quiet = false, slot = state.keyTrack } = {}) {
    const track = state.tracks[slot];
    track.offsetMs = Math.round(ms);
    track.activeIndex = NEEDS_REDRAW; // force a re-render at the new offset
    saveOffset(track);
    notify();
    if (quiet) return;
    // Name the track only when there are two of them to confuse.
    const which = attachedTracks().length > 1 ? `Subtitle ${slot + 1}` : "Subtitle";
    showToast(`${which} offset ${formatOffset(track.offsetMs)}`);
  }

  const nudge = (deltaMs, { slot = state.keyTrack } = {}) =>
    setOffset(state.tracks[slot].offsetMs + deltaMs, { slot });

  function formatOffset(ms) {
    const seconds = (ms / 1000).toFixed(2).replace(/\.?0+$/, "");
    return `${ms > 0 ? "+" : ""}${seconds || "0"}s`;
  }

  // --- keyboard -------------------------------------------------------------

  /* Matching on event.code keeps bindings on the same physical keys across
   * layouts. Modifier chords are ignored so page and browser shortcuts win. */
  function onKeyDown(event) {
    if (!state.settings.keysEnabled) return;
    if (event.metaKey || event.ctrlKey || event.altKey) return;

    /* composedPath()[0] rather than event.target: the panel lives in a shadow
     * root, and events crossing that boundary are retargeted to the host
     * element. Reading event.target would see a plain div and let typing in the
     * panel's search box fire the nudge bindings. */
    const target = event.composedPath?.()[0] ?? event.target;
    if (
      target &&
      (target.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName || ""))
    ) {
      return;
    }
    if (window.__ssoPanel?.isCapturingKey?.()) return;

    const keys = state.settings.keys;
    const step = event.shiftKey ? state.settings.largeStepMs : state.settings.smallStepMs;
    let handled = true;

    if (event.code === keys.togglePanel) {
      window.__ssoPanel?.toggle();
    } else if (!anyAttached()) {
      handled = false; // the rest only make sense with something attached
    } else if (event.code === keys.earlier) {
      nudge(-step);
    } else if (event.code === keys.later) {
      nudge(step);
    } else if (event.code === "Escape" && state.placing) {
      window.__ssoApi.setPlacing(false);
    } else if (event.code === keys.reset) {
      setOffset(0);
      showToast("Subtitle offset reset");
    } else if (event.code === keys.toggleOverlay) {
      setVisible(!state.visible);
      showToast(state.visible ? "Subtitles shown" : "Subtitles hidden");
    } else if (event.code === keys.toggleStudy) {
      handled = Boolean(window.__ssoStudy?.toggle());
    } else if (event.code === keys.saveWord) {
      handled = Boolean(window.__ssoStudy?.saveTop());
    } else {
      handled = false;
    }

    if (handled) {
      event.preventDefault();
      event.stopPropagation();
    }
  }

  // --- attach / visibility --------------------------------------------------

  async function attach({ cues, label, fileId, language, slot = PRIMARY }) {
    const index = clamp(Number(slot) || 0, 0, TRACK_COUNT - 1);
    const track = state.tracks[index];
    const wasAlone = attachedTracks().length <= 1;

    track.cues = Array.isArray(cues) ? cues : [];
    track.label = label || "";
    track.fileId = fileId ?? null;
    track.language = language || "";
    track.offsetMs = await loadOffset(track.fileId);
    track.activeIndex = NEEDS_REDRAW;
    track.visible = true;
    state.adDriftMs = 0;
    state.inAd = false;
    state.visible = true;
    state.video = pickVideo();

    ensureOverlay();
    syncRootVisibility();

    /* A second subtitle on top of the first is unreadable, so the moment there
     * are two, put them side by side. Only while neither has been placed by
     * hand: after that the arrangement is the user's and moving it would be
     * this deciding it knows better. */
    if (wasAlone && attachedTracks().length > 1 && !state.settings.tracks.some((t) => t.placed)) {
      arrange("side");
    }

    startTicking();
    notify();
    // Show the handle on attach, so it is discoverable without knowing that
    // moving the mouse summons it.
    revealHandle();

    showToast(
      track.cues.length > 0
        ? `Subtitle ${index + 1} on - ${track.cues.length} lines${track.label ? ` · ${track.label}` : ""}`
        : "That subtitle had no readable lines",
    );
    return { ok: true, cueCount: track.cues.length, slot: index };
  }

  /** Drop one track, or every track when no slot is named. */
  function detach(slot) {
    const slots = slot == null ? state.tracks.map((_, index) => index) : [Number(slot)];
    for (const index of slots) {
      const track = state.tracks[index];
      if (!track) continue;
      Object.assign(track, newTrack());
      track.activeIndex = NEEDS_REDRAW;
      if (views[index]) views[index].cueBox.textContent = "";
    }
    notify();
    return { ok: true };
  }

  function setVisible(visible, { slot = null } = {}) {
    if (slot == null) {
      state.visible = visible;
    } else {
      state.tracks[slot].visible = visible;
      // Showing one track while everything is hidden has to turn the master
      // switch back on, or the click does nothing and reads as broken.
      if (visible) state.visible = true;
    }
    syncRootVisibility();
    notify();
    return { ok: true, visible: state.visible };
  }

  /* A track is on screen when both switches allow it: the one for all subtitles
   * and the one for that subtitle. Kept in one place because attach and
   * setVisible both change an input to it, and having each work out the answer
   * separately is how a track that was hidden comes back on the next attach. */
  function syncRootVisibility() {
    for (const [index, view] of views.entries()) {
      const on = state.visible && state.tracks[index].visible;
      view.root.hidden = !on;
      if (!on) view.cueBox.textContent = "";
      state.tracks[index].activeIndex = NEEDS_REDRAW;
    }
  }

  /* Status is the one shape three other files read - the panel, the popup and
   * the service worker. The per-track detail is in `tracks`; the flat fields
   * above it describe the primary, or the only, subtitle, so a caller that
   * only wants to say "attached, 1183 lines" does not have to know there can
   * be two. */
  function status() {
    const attached = attachedTracks();
    const lead = attached[0] || state.tracks[PRIMARY];
    return {
      hasVideo: hasPlayableVideo(),
      attached: attached.length > 0,
      trackCount: attached.length,
      cueCount: lead.cues.length,
      offsetMs: lead.offsetMs,
      label: lead.label,
      fileId: lead.fileId,
      tracks: state.tracks.map((track, slot) => ({
        slot,
        attached: track.cues.length > 0,
        cueCount: track.cues.length,
        offsetMs: track.offsetMs,
        label: track.label,
        fileId: track.fileId,
        language: track.language,
        visible: track.visible,
      })),
      keyTrack: state.keyTrack,
      placing: state.placing,
      adDriftMs: state.adDriftMs,
      inAd: state.inAd,
      visible: state.visible,
      settings: state.settings,
      currentTime: state.video?.currentTime ?? null,
      duration: state.video?.duration ?? null,
    };
  }

  function notify() {
    for (const listener of listeners) {
      try {
        listener(status());
      } catch {
        // A broken subscriber must not stop playback rendering.
      }
    }
  }

  // --- messaging ------------------------------------------------------------

  const onMessage = (message, _sender, sendResponse) => {
    switch (message?.type) {
      case "sso:ping":
        // Lets the service worker tell "running and current" from "stale or
        // absent" before deciding whether to re-inject.
        sendResponse({ ok: true, version: VERSION, hasPanel: Boolean(window.__ssoPanel) });
        return false;

      case "sso:status":
        sendResponse(status());
        return false;

      case "sso:pageInfo":
        sendResponse({ hasVideo: hasPlayableVideo(), ...pageInfo() });
        return false;

      case "sso:diagnose":
        sendResponse(diagnose());
        return false;

      case "sso:attach":
        if (!hasPlayableVideo()) {
          sendResponse({ ok: false, reason: "no video in this frame" });
          return false;
        }
        // Respond even if attach throws, so the sender never waits on a
        // channel that will not produce an answer.
        attach(message.payload).then(sendResponse, (error) =>
          sendResponse({ ok: false, reason: String(error?.message || error) }),
        );
        return true;

      case "sso:detach":
        sendResponse(detach(message.slot));
        return false;

      case "sso:setVisible":
        sendResponse(setVisible(Boolean(message.visible), { slot: message.slot ?? null }));
        return false;

      case "sso:toggleVisible":
        if (!anyAttached()) {
          sendResponse({ ok: false, reason: "nothing attached" });
          return false;
        }
        sendResponse(setVisible(!state.visible));
        return false;

      case "sso:nudge": {
        if (!anyAttached()) {
          sendResponse({ ok: false, reason: "nothing attached" });
          return false;
        }
        const slot = message.slot ?? state.keyTrack;
        nudge(Number(message.deltaMs) || 0, { slot });
        sendResponse({ ok: true, offsetMs: state.tracks[slot].offsetMs });
        return false;
      }

      case "sso:clearAdDrift":
        state.adDriftMs = 0;
        for (const track of state.tracks) track.activeIndex = NEEDS_REDRAW;
        notify();
        sendResponse({ ok: true });
        return false;

      case "sso:setOffset": {
        const slot = message.slot ?? state.keyTrack;
        setOffset(Number(message.offsetMs) || 0, { quiet: true, slot });
        sendResponse({ ok: true, offsetMs: state.tracks[slot].offsetMs });
        return false;
      }

      case "sso:togglePanel":
        window.__ssoPanel?.toggle();
        sendResponse({ ok: Boolean(window.__ssoPanel) });
        return false;

      case "sso:toast":
        showToast(String(message.message || ""));
        sendResponse({ ok: true });
        return false;

      default:
        return false;
    }
  };
  chrome.runtime.onMessage.addListener(onMessage);

  // --- api for panel.js -----------------------------------------------------

  window.__ssoApi = {
    status,
    attach,
    detach,
    setVisible,
    setOffset,
    nudge,
    formatOffset,
    setPlacing(on) {
      state.placing = Boolean(on);
      for (const track of state.tracks) track.activeIndex = NEEDS_REDRAW;
      for (const view of views) view.root.dataset.placing = state.placing ? "true" : "false";
      notify();
    },
    resetPosition() {
      updateSettings({
        tracks: DEFAULT_SETTINGS.tracks.map((track) => ({ ...track })),
      });
    },
    arrange,
    setKeyTrack(slot) {
      state.keyTrack = clamp(Number(slot) || 0, 0, TRACK_COUNT - 1);
      notify();
    },
    clearAdDrift() {
      state.adDriftMs = 0;
      for (const track of state.tracks) track.activeIndex = NEEDS_REDRAW;
      notify();
    },
    pageInfo,
    hasPlayableVideo,
    updateSettings,
    updateTrackSettings,
    resetSettings,
    showToast,
    /* Study mode needs to read the line under a word to save it with its
     * sentence, and the paired line in the other language, which is the whole
     * reason a word is worth saving at all. */
    cueAt(slot) {
      const track = state.tracks[slot];
      const index = track.activeIndex;
      return index >= 0 ? track.cues[index] : null;
    },
    trackInfo(slot) {
      const track = state.tracks[slot];
      return { label: track.label, fileId: track.fileId, language: track.language };
    },
    filmTimeMs() {
      return state.video ? state.video.currentTime * 1000 - state.adDriftMs : null;
    },
    pauseVideo() {
      state.video?.pause();
    },
    /* Turning study mode on has to affect the line already on screen, not just
     * the next one - a subtitle can sit there for five seconds and a feature
     * that appears to do nothing for five seconds reads as broken. */
    redrawCues() {
      for (const track of state.tracks) track.activeIndex = NEEDS_REDRAW;
    },
    overlayRoots() {
      return views.map((view) => view.root);
    },
    /* Study settings live in study.js, so a change there is invisible to the
     * panel's subscription. This pushes one status round so the panel redraws
     * against them. */
    notifyChanged: notify,
    defaults: DEFAULT_SETTINGS,
    trackCount: TRACK_COUNT,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    /* Daemon calls are routed through the service worker: MV3 content scripts
     * no longer make cross-origin requests with extension permissions, and the
     * daemon would reject the page's own origin anyway. */
    daemon(op, args) {
      return chrome.runtime.sendMessage({ type: "sso:daemon", op, args });
    },
  };

  // --- wiring ---------------------------------------------------------------

  /* The handle only appears where there is something to control, and only
   * while the mouse is moving - so it is never in the way of the film. */
  function onPointerMove() {
    if (!isPageSubject(pickVideo())) return;
    ensureOverlay();
    revealHandle();
  }

  /* Capture phase, not bubble. Video players routinely stopPropagation on
   * pointer events inside the player so their own chrome can own them, which
   * means a bubble-phase listener on document never runs while the pointer is
   * over the film - precisely where it needs to. Capture runs top-down before
   * any of that. mousemove as well as pointermove, because a few players
   * synthesise only one of the two. */
  document.addEventListener("keydown", onKeyDown, true);
  document.addEventListener("pointermove", onPointerMove, { passive: true, capture: true });
  document.addEventListener("mousemove", onPointerMove, { passive: true, capture: true });
  document.addEventListener("fullscreenchange", attachToCorrectParent);
  document.addEventListener("webkitfullscreenchange", attachToCorrectParent);
  loadOverlayStyles();
  loadSettings();
  startTicking();

  /* Everything this injection added, undone. Called by the next injection so a
   * version upgrade leaves exactly one copy running. */
  window.__ssoTeardown = () => {
    clearInterval(ticker);
    ticker = null;
    clearTimeout(toastTimer);
    clearTimeout(handleTimer);
    document.removeEventListener("keydown", onKeyDown, true);
    document.removeEventListener("pointermove", onPointerMove, { capture: true });
    document.removeEventListener("mousemove", onPointerMove, { capture: true });
    document.removeEventListener("fullscreenchange", attachToCorrectParent);
    document.removeEventListener("webkitfullscreenchange", attachToCorrectParent);
    chrome.runtime.onMessage.removeListener(onMessage);
    host?.remove();
    host = null;
    shadow = null;
    views = [];
    listeners.clear();
    window.__ssoPanelTeardown?.();
    window.__ssoStudyTeardown?.();
    delete window.__ssoApi;
    delete window.__ssoTeardown;
  };
})();
