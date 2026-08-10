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
  /* The speed for having nothing to do.
   *
   * With nothing attached the tick's only remaining job is noticing that a
   * player has appeared, and that does not need answering twenty times a
   * second. It matters because this script runs in every frame of every page:
   * measured on a page with no video at all, the idle tick ran 20 document-wide
   * `video` queries per second for as long as the tab stayed open, in every
   * frame. Half a second is imperceptible for spotting a player that has just
   * loaded, and it is the difference between a cost per tab and no cost. */
  const IDLE_TICK_MS = 500;
  const MIN_VIDEO_SECONDS = 60; // ignore ad breaks, teasers, autoplay loops
  const TOAST_MS = 1600;
  // Long enough to notice what happened and reach the button. The usual advice
  // for an undo is five to eight seconds; 1.6 is a confirmation, not an offer.
  const ACTION_TOAST_MS = 7000;
  /* Sentinel for "redraw whatever is current". "Nothing is on screen" is a real
   * answer - the empty set - so it cannot double as "invalidate": the tick
   * compares the new set against the old, sees two empty sets, and skips the
   * render. That is invisible while a line is on screen and breaks exactly in
   * the gap between lines. null is a set no comparison can equal. */
  const NEEDS_REDRAW = null;
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

    /* How this one looks.
     *
     * Per track, not shared, because the whole point of two subtitles is that
     * they are two different things: one is the language being learnt and one
     * is the language it is being learnt from, and a reader has to be able to
     * tell which is which without reading either. Colour does that at a glance
     * where size alone does not.
     *
     * Every default below is exactly what overlay.css hard-coded before these
     * existed, and the stylesheet still carries those same values as its
     * var() fallbacks - so a track that has never been styled renders byte for
     * byte as it did. */
    color: "#ffffff",
    font: "sans", // a key into FONTS, not a font stack: see there
    weight: 600,
    // 0 is no outline, 1 is what the stylesheet always drew. Not a boolean:
    // over a bright frame the useful setting is usually "more".
    outline: 1,
    // Per track, so a reference subtitle can be a whisper behind the one being
    // read. null means "use the shared backdrop", which is what every existing
    // installation has.
    backdrop: null,
  };

  /* The font choices, as keys rather than stacks.
   *
   * A stored font stack is a string from a settings file reaching a style
   * attribute, which is a place to be careful; a key that indexes a table here
   * cannot be anything but one of these five. Each stack ends in a generic so
   * it resolves on a machine that has none of the named faces. */
  const FONTS = {
    sans: '"Helvetica Neue", Helvetica, Arial, sans-serif',
    system: '-apple-system, "Segoe UI", Roboto, sans-serif',
    serif: 'Georgia, "Times New Roman", serif',
    mono: '"SF Mono", ui-monospace, Menlo, Consolas, monospace',
    rounded: '"SF Pro Rounded", "Nunito", "Trebuchet MS", sans-serif',
  };

  /* The outline, as a strength rather than a switch.
   *
   * Two shadows: a soft halo that lifts the text off a busy frame, and a tight
   * one under it that gives the letters an edge. Strength 1 reproduces exactly
   * what the stylesheet drew before this was a setting, so a track that has not
   * been styled is unchanged. Strength 0 is "none" and returns the keyword
   * rather than a transparent shadow, so the browser can skip the work.
   *
   * The blur grows with strength and the alpha saturates: past about 1.6 more
   * blur is just a grey box, so the halo widens instead of darkening. */
  function outlineShadow(strength) {
    const s = Number.isFinite(strength) ? clamp(strength, 0, 2) : 1;
    if (s === 0) return "none";
    const alpha = Math.min(0.9, 0.45 + 0.45 * s).toFixed(2);
    return `0 0 ${(4 * s).toFixed(1)}px rgba(0, 0, 0, ${alpha}), ` +
      `0 1px ${(2 * s).toFixed(1)}px rgba(0, 0, 0, ${alpha})`;
  }

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

  /* Named looks, because the two subtitles want opposite treatments and setting
   * six controls twice per film is a chore that gets skipped - and a feature
   * that is too much work to use is a feature nobody has.
   *
   * These are starting points, not modes: applying one writes the values and
   * then stops having an opinion, exactly like the arrangement buttons. Every
   * control stays where it was and every one of them still works afterwards.
   *
   * Only the appearance is set. Position, width and whether a box has been
   * placed by hand belong to the arrangement, and a look that moved the
   * subtitle would be answering a question nobody asked. */
  const LOOKS = {
    plain: {
      label: "Plain",
      hint: "How subtitles have always looked here",
      style: { color: "#ffffff", font: "sans", weight: 600, outline: 1, backdrop: null, fontScale: 1 },
    },
    learning: {
      label: "Learning",
      hint: "Bigger and warm, for the language being learnt",
      style: { color: "#fff3dc", font: "system", weight: 700, outline: 1.3, backdrop: 0.62, fontScale: 1.15 },
    },
    reference: {
      label: "Reference",
      hint: "Small and quiet, for the language you already read",
      style: { color: "#c6cfd8", font: "system", weight: 500, outline: 0.8, backdrop: 0.35, fontScale: 0.85 },
    },
    clean: {
      label: "Clean",
      hint: "No box at all, outline only - for a dark film",
      style: { color: "#ffffff", font: "system", weight: 700, outline: 1.8, backdrop: 0, fontScale: 1 },
    },
  };

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
    /* Stop at the end of every line and wait to be told to go on.
     *
     * Off, because it is a way of watching rather than a setting: it turns a
     * film into a deck of lines, which is what intensive listening is and is
     * not what anybody wants by accident. On, the pause happens once per line -
     * pressing play carries on to the end of the next one. */
    pauseAtLineEnd: false,
    /* The key the layout produces, not the key the keyboard has under it.
     *
     * These were KeyboardEvent.code - BracketLeft, KeyP - which names the
     * physical switch. That keeps a binding in the same place on every layout,
     * and the place is the only thing about it a reader cannot see: on a
     * Turkish Q layout the two keys right of P are ğ and ü, and "the shortcut
     * is BracketLeft" tells nobody which key to press. A binding is a promise
     * about what to type, so it is what the keyboard types.
     *
     * An empty string is a shortcut that is switched off, one at a time.
     *
     * Letters, and no punctuation. The old defaults were the bracket keys,
     * which is a fine choice for a binding on the physical key and a poor one
     * for a binding on the character: measured on this machine's layout,
     * Turkish Q, the key beside P types ğ and "[" needs a modifier the handler
     * deliberately refuses. A letter is on every Latin layout unmodified. */
    /* T and Y sit directly above G and H, which is the whole reason they were
     * picked. The pair below moves the subtitle against the film; the pair
     * above moves the film itself, and both keep the same left-is-back,
     * right-is-forward sense - so there is one thing to remember rather than
     * four. They are letters, unmodified, present on every Latin layout, and
     * neither Netflix, Prime nor Disney+ binds them. YouTube uses T for
     * theatre mode: these win it while the shortcuts are on, and either can be
     * rebound. */
    keys: {
      earlier: "g",
      later: "h",
      reset: "b",
      prevLine: "t",
      nextLine: "y",
      togglePanel: "p",
      toggleOverlay: "v",
      toggleStudy: "s",
      saveWord: "d",
    },
    /* Off until asked for.
     *
     * Nine single letters, unmodified, on a page that is somebody else's -
     * players bind letters of their own, and a search box that has not taken
     * focus yet turns every one of them into a surprise. Nothing here is
     * needed to use the tool: the panel opens from the CC button and every
     * binding has a control beside the thing it acts on. */
    keysEnabled: false,
  };

  /* What the old physical bindings typed on a US layout.
   *
   * Stored settings carry codes, and a code left in place would simply never
   * match again - the shortcuts would go quiet with nothing said. Anything not
   * in this table is dropped to "off" rather than guessed at, because a
   * shortcut that fires on the wrong key is worse than one that does not fire. */
  const KEY_FROM_CODE = {
    BracketLeft: "[", BracketRight: "]", Backslash: "\\", Semicolon: ";",
    Quote: "'", Comma: ",", Period: ".", Slash: "/", Minus: "-", Equal: "=",
    Space: " ", Backquote: "`",
  };

  function keyFromStored(value) {
    if (typeof value !== "string" || value === "") return "";
    if (value.length === 1) return value.toLowerCase(); // already a key
    if (KEY_FROM_CODE[value]) return KEY_FROM_CODE[value];
    if (/^Key[A-Z]$/.test(value)) return value.slice(3).toLowerCase();
    if (/^Digit[0-9]$/.test(value)) return value.slice(5);
    if (/^Arrow(Left|Right|Up|Down)$/.test(value)) return value;
    return "";
  }

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
    // How fast this file's clock runs against the film's. 1 is the same speed;
    // a framerate mismatch is a fraction of a per cent either side.
    rate: 1,
    // Which of this file's lines are on screen, in document order. Usually one;
    // several when a sign or a lyric is held across the dialogue under it.
    activeIndexes: [],
    // Where and by how much the reader has corrected this file by hand, which
    // is the only measurement of drift a single subtitle can produce.
    corrections: [],
    driftOffered: false,
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
  let tickerMs = 0;

  // --- video selection ------------------------------------------------------

  /* The video the user is watching is the biggest one with a real duration.
   * Pages routinely hold several - preview loops, ad slots, hidden elements. */
  /* The answer to "which video is this page about" for a fraction of a second.
   *
   * pickVideo walks every <video> on the page and measures each one, and
   * measuring forces layout. That is fine at 20Hz from the tick; it is not fine
   * from the pointer handler, which runs on every mouse move - and both
   * pointermove and mousemove are listened for, because some players synthesise
   * only one of the two, so a single physical movement asks twice. Measured on
   * a one-video page: 2 walks and 16 forced layouts per movement, 0.14ms each,
   * around 17ms of every second the mouse is moving - in every frame of the
   * page, for a question whose answer cannot change that fast.
   *
   * 250ms is well under the time it takes to move a hand to the CC button and
   * far longer than a mouse takes to cross the screen. */
  const VIDEO_CACHE_MS = 250;
  let videoGuess = { at: -Infinity, video: null };

  function pickVideoCached() {
    const now = performance.now();
    if (now - videoGuess.at < VIDEO_CACHE_MS && videoGuess.video?.isConnected !== false) {
      return videoGuess.video;
    }
    videoGuess = { at: now, video: pickVideo() };
    return videoGuess.video;
  }

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

    /* Each candidate carries whatever episode is written into it.
     *
     * Parsed here rather than in the worker so that exactly one copy of the
     * pattern exists. The worker has to *choose* between candidates from
     * different frames - and choosing needs to know which of them name an
     * episode - but it never has to read one. */
    const push = (value, source) => {
      const text = String(value || "").trim();
      if (text) candidates.push({ text, source, episode: matchEpisode(text) });
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

    /* The three places a frame can learn which episode is playing, reported
     * separately rather than resolved here. Which of them to trust depends on
     * whether this frame is the one holding the video, and a frame does not
     * know that about itself - the worker does. */
    return {
      candidates,
      year,
      url: location.href,
      isTopFrame: window === window.top,
      episode: {
        fromTitle: matchEpisode(document.title),
        fromMarker: selectedEpisodeOnPage(),
        fromUrl: matchEpisode(decodeURIComponent(location.pathname + location.search)),
      },
    };
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

  // --- placing things in a page that may have moved the coordinate system ----

  /* Work out how this element's own left/top relate to viewport pixels.
   *
   * `position: fixed` is only relative to the viewport while no ancestor has a
   * transform, filter, perspective or backdrop-filter - any of those makes that
   * ancestor the containing block instead. Streaming pages do this routinely,
   * and the overlay re-parents itself into the fullscreen element, so injected
   * UI regularly lands inside one.
   *
   * Two shapes of breakage follow, and they look different to a user. A
   * translated ancestor displaces everything by a constant: the panel is simply
   * somewhere else. A *scaled* one changes the rate: writing 100px moves it
   * 80px, so it drifts out from under the pointer as you drag - reported as
   * "it doesn't move at the same speed as the mouse". Measured on a container
   * at scale(0.8): 0.8 exactly.
   *
   * Both are the same linear mapping, viewport = origin + scale x local, so two
   * probes solve it. Done once when a drag starts; the writes happen inside one
   * event handler, so no frame is painted between them and nothing flickers.
   */
  /* The one place a track's position reaches the DOM, so the drag's probe and
   * the settings both move it by the same lever. */
  function writePosition(root, x, y) {
    root.style.setProperty("--sso-x", `${x}%`);
    root.style.setProperty("--sso-y", `${y}%`);
  }

  function measurePlacement(element, apply) {
    apply(0, 0);
    const at0 = element.getBoundingClientRect();
    apply(100, 100);
    const at100 = element.getBoundingClientRect();

    // A zero delta would mean the element cannot be moved at all; treating that
    // as 1 keeps a drag harmless rather than dividing by zero.
    const scaleX = (at100.left - at0.left) / 100 || 1;
    const scaleY = (at100.top - at0.top) / 100 || 1;

    return {
      scaleX,
      scaleY,
      /** Where to write, to land at this point on the screen. */
      toLocal(viewportX, viewportY) {
        return {
          x: (viewportX - at0.left) / scaleX,
          y: (viewportY - at0.top) / scaleY,
        };
      },
      /** Where this written value currently sits on the screen. */
      toViewport(localX, localY) {
        return { x: at0.left + localX * scaleX, y: at0.top + localY * scaleY };
      },
    };
  }

  /* Drag a floating thing by its handle.
   *
   * This is here, once, because it had been written three times - the subtitle,
   * the control panel, the study rail - and every fix landed in some of them.
   * The lost-release guard was in two of the three, so the rail would teleport
   * 500px the next time the mouse moved, which is the same defect the subtitle
   * had and was fixed for months earlier.
   *
   * Four things every one of them has to get right:
   *   - a press on a button inside the handle is a click, not a drag
   *   - the page's coordinate system is solved, not assumed (measurePlacement)
   *   - the grab offset is held, so the thing does not jump on the first move
   *   - a move with no button held means the release was lost: end the drag
   *
   * `place(x, y)` writes a position in whatever units the caller stores, and
   * the clamp keeps the handle on screen - the handle specifically, because it
   * is the part that drags the thing back.
   */
  /* What is not a handle.
   *
   * Controls, obviously - a press on a button is a click. Text is the less
   * obvious half: a window you can drag by its own words is a window whose
   * words cannot be selected, and the rail is a reading surface. So a press
   * counts as a grab when it lands on an element that has no words of its own,
   * which is what "an empty part of the window" means when you say it out
   * loud. The title bar grabs whatever it is pressed on, because that is what
   * a title bar has always been. */
  const NOT_A_HANDLE =
    "button, input, select, textarea, label, a, [contenteditable], .sso-grip, [data-nodrag]";

  function isEmptySpace(node) {
    if (!node || node.nodeType !== 1 || node.closest(NOT_A_HANDLE)) return false;
    for (const child of node.childNodes) {
      if (child.nodeType === 3 && child.textContent.trim()) return false;
    }
    return true;
  }

  /* `keepOnScreen` is the part that must stay reachable, which is the title bar
   * rather than the whole window: clamping the window itself would stop a tall
   * panel from being pushed down the screen at all, and the bar is the part
   * that drags it back. */
  /* `probe` is how the coordinate system gets measured, and it must be the raw
   * writer - not a `place` that clamps. measurePlacement writes 0 and then 100
   * and reads back where the element landed; a clamp that rounds 0 up to 8
   * makes those two probes 92px apart, so the solver reports a page scale of
   * 0.92 on a page doing no scaling at all. Measured on the settings window
   * before this was split out: a grab jumped it 38px sideways and then moved
   * it 1.087x as far as the pointer for the rest of the drag. */
  function makeMovable(handle, { host, place, probe = place, onMove, onEnd, keepOnScreen = null }) {
    let origin = null;

    handle.addEventListener("pointerdown", (event) => {
      if (event.button !== 0) return;
      const onBar = event.target.closest?.(".sso-win__head");
      if (event.target.closest(NOT_A_HANDLE) || (!onBar && !isEmptySpace(event.target))) return;
      const box = host.getBoundingClientRect();

      // Solve the mapping, then put it back where the probe found it. Both
      // happen in this handler, so nothing is painted in between.
      const map = measurePlacement(host, probe);
      const back = map.toLocal(box.left, box.top);
      place(back.x, back.y);

      origin = { map, grabX: event.clientX - box.left, grabY: event.clientY - box.top };
      // The bar carries the state, because the bar is what changes cursor.
      (keepOnScreen || handle).dataset.dragging = "true";
      /* Capture is how the drag keeps receiving moves once the pointer leaves
       * the window, and it throws for a pointer id that is not live - which is
       * what a synthetic pointerdown from the page, or from a test, produces.
       * Losing capture costs a drag that stops at the edge; letting it throw
       * costs the drag entirely. */
      try {
        handle.setPointerCapture?.(event.pointerId);
      } catch {}
    });

    handle.addEventListener("pointermove", (event) => {
      if (!origin) return;
      if (event.buttons === 0) {
        end(event);
        return;
      }
      const box = host.getBoundingClientRect();
      const handleHeight = (keepOnScreen || handle).getBoundingClientRect().height || 34;
      const left = clamp(
        event.clientX - origin.grabX,
        0,
        Math.max(0, window.innerWidth - box.width),
      );
      const top = clamp(
        event.clientY - origin.grabY,
        0,
        Math.max(0, window.innerHeight - handleHeight),
      );
      const local = origin.map.toLocal(left, top);
      place(local.x, local.y);
      onMove?.();
    });

    const end = (event) => {
      if (!origin) return;
      origin = null;
      (keepOnScreen || handle).dataset.dragging = "false";
      try {
        handle.releasePointerCapture?.(event.pointerId);
      } catch {}
      onEnd?.();
    };
    handle.addEventListener("pointerup", end);
    handle.addEventListener("pointercancel", end);
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

  /* The episode this page says is being watched, from whatever control marks a
   * selection. Stops at the first one, unlike the diagnostic scan below which
   * gathers everything: this answers "which episode", that one answers "what
   * did you see", and only the second has a reason to keep looking. */
  function selectedEpisodeOnPage() {
    let scanned = 0;
    for (const node of document.querySelectorAll("a,button,li,span,div,option")) {
      if (++scanned > MAX_NODES_SCANNED) break;
      if (node.children.length > 2) continue;
      const text = (node.textContent || "").replace(/\s+/g, " ").trim();
      if (!text || text.length > 60) continue;
      const match = matchEpisode(text);
      if (match && selectionEvidence(node).length > 0) return match;
    }
    return null;
  }

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
        rate: track.rate,
      })),

      // Why a surface will not take a click. See describeSurfaces.
      viewport: { width: window.innerWidth, height: window.innerHeight },
      surfaces: describeSurfaces(),
    };
  }

  /* What is sitting on top of the extension's own surfaces.
   *
   * A panel that will not take a click cannot be explained from one vantage
   * point, which is the same reason the rest of this report asks every frame.
   * From in here we can see what covers our hosts in *this* document, by
   * hit-testing the middle of each button the way a click does. What we cannot
   * see is the document above: on a site whose player is a cross-origin iframe
   * the extension draws inside that iframe, and neither z-index nor the top
   * layer reaches past a frame boundary - the iframe is one box in its
   * parent's paint order, and anything the parent draws over it wins.
   *
   * So the two findings this produces mean different things, and the report
   * says which. A button with something over it names its own obstruction. A
   * button that is topmost in a nested frame and still cannot be clicked is
   * being covered from above, and the fix is not in this frame at all.
   *
   * Our surfaces are found by the class the shadow root's first child carries,
   * rather than by a marker on the host: the hosts are built in three
   * different files and a marker would have to be remembered in all of them. */
  const MAX_SURFACES = 8;
  const MAX_TARGETS = 6;

  function describeSurfaces() {
    const surfaces = [];
    for (const node of document.querySelectorAll("*")) {
      if (surfaces.length >= MAX_SURFACES) break;
      const first = node.shadowRoot?.firstElementChild;
      const name = typeof first?.className === "string" ? first.className : "";
      if (!name.startsWith("sso-")) continue;

      const style = getComputedStyle(node);
      const box = node.getBoundingClientRect();
      surfaces.push({
        surface: name,
        rect: [Math.round(box.x), Math.round(box.y), Math.round(box.width), Math.round(box.height)],
        display: style.display,
        pointerEvents: style.pointerEvents,
        zIndex: style.zIndex,
        inTopLayer: node.matches(":popover-open"),
        parent: describeNode(node.parentElement),
        targets: sampleTargets(node),
      });
    }
    return surfaces;
  }

  /* One sample per button, at its middle, because that is where a click lands.
   * Sampling the host's own middle would be worthless for the cue overlay,
   * which is deliberately click-through everywhere except the cue itself. */
  function sampleTargets(host) {
    return Array.from(host.shadowRoot.querySelectorAll("button"))
      .slice(0, MAX_TARGETS)
      .map((button) => {
        const label = (button.getAttribute("aria-label") || button.title || button.textContent || "")
          .trim()
          .slice(0, 24);
        const box = button.getBoundingClientRect();
        if (box.width === 0 || box.height === 0) return { label, rendered: false };

        const x = box.left + box.width / 2;
        const y = box.top + box.height / 2;
        /* Shadow content retargets to the host, so the host is what comes back
         * for our own surface. Topmost means nothing here is in the way. */
        const stack = document.elementsFromPoint(x, y);
        const depth = stack.indexOf(host);
        return {
          label,
          at: [Math.round(x), Math.round(y)],
          reachable: depth === 0,
          // Empty with reachable false means the point does not hit us at all.
          coveredBy: (depth === -1 ? stack.slice(0, 3) : stack.slice(0, depth)).map(describeNode),
        };
      });
  }

  function describeNode(node) {
    if (!node) return "none";
    const style = getComputedStyle(node);
    const id = node.id ? `#${node.id}` : "";
    const classes =
      typeof node.className === "string" && node.className.trim()
        ? `.${node.className.trim().split(/\s+/).slice(0, 2).join(".")}`
        : "";
    return `${node.tagName}${id}${classes} z=${style.zIndex} pe=${style.pointerEvents}`;
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
      /* Bindings saved as codes are translated, not kept: a code no longer
       * matches anything, so the shortcuts would go quiet with nothing said. */
      keys: Object.fromEntries(
        Object.entries({ ...DEFAULT_SETTINGS.keys, ...(saved.keys || {}) })
          .map(([name, value]) => [name, keyFromStored(value)]),
      ),
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
      /* Normalised on the way in, not only on the way out of storage: this is
       * the one door every binding comes through, so "a stored binding is a
       * key the layout types" holds after any write rather than only after a
       * reload. A settings object written by an older version, arriving here
       * through a storage change in another frame, is translated too. */
      keys: Object.fromEntries(
        Object.entries({ ...state.settings.keys, ...(patch.keys || {}) })
          .map(([name, value]) => [name, keyFromStored(value)]),
      ),
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

  /* Just the bindings.
   *
   * The panel's "Reset keys" called resetSettings(), which resets every setting
   * there is - both subtitles' size, width and position, the backdrop, the text
   * handling. A reader who had spent a while getting the boxes where they
   * wanted them and then rebound one key by mistake lost the lot, from a button
   * that names one thing and does everything. */
  /** Write a named look onto one subtitle. Appearance only - see LOOKS. */
  function applyLook(slot, name) {
    const look = LOOKS[name];
    if (!look) return { ok: false };
    updateTrackSettings(slot, { ...look.style });
    return { ok: true };
  }

  /* The bindings, and not whether they are on. A reader who has turned the
   * shortcuts on and then wants one binding back is asking for that binding,
   * not to be switched off again by a button that says "reset keys". */
  function resetKeys() {
    updateSettings({ keys: { ...DEFAULT_SETTINGS.keys } });
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

  /* Subtitles are sized against the picture, not the window.
   *
   * They used to be 2.6vh, which is the *viewport's* height - so going
   * fullscreen changed the text size for a reason that has nothing to do with
   * the film. On a window smaller than the screen the viewport grows on entering
   * fullscreen and the subtitles grow with it; on a maximised window it barely
   * moves while the picture doubles, and the text ends up relatively tiny.
   * Measured: the same 20px whether the video was 778px tall or 300px.
   *
   * A subtitle belongs to the picture. Sizing it off the video's rendered height
   * makes it the same fraction of the frame at every window size, fullscreen or
   * not, which is what "it should not change when I go fullscreen" means. */
  const TEXT_FRACTION_OF_PICTURE = 0.026;

  function pictureHeight() {
    const box = state.video?.getBoundingClientRect();
    // Before a video is picked - or if it is collapsed while loading - the
    // window is the only thing to go on.
    return box && box.height > 80 ? box.height : window.innerHeight;
  }

  /* How much the page has scaled whatever we are inside.
   *
   * Fullscreen is the common case: the overlay re-parents into the fullscreen
   * element, and if the player has scaled that element then everything we draw
   * is scaled with it. `offsetWidth` is what we asked for, the bounding rect is
   * what was rendered, and the ratio between them is the factor to divide by so
   * a size in viewport pixels comes out at that size on the screen. */
  function hostScale() {
    if (!host) return 1;
    const rendered = host.getBoundingClientRect().width;
    const asked = host.offsetWidth;
    return asked > 0 && rendered > 0 ? rendered / asked : 1;
  }

  function applySettings() {
    if (views.length === 0) return;
    const { background, dimNonSpeech } = state.settings;
    const picture = pictureHeight();
    const scale = hostScale();

    views.forEach((view, slot) => {
      const track = state.settings.tracks[slot];
      const { root } = view;
      const fontPx = (picture * TEXT_FRACTION_OF_PICTURE * track.fontScale) / scale;
      root.style.setProperty("--sso-font-size", `${fontPx.toFixed(2)}px`);
      // A track with its own backdrop overrides the shared one; null is what
      // every installation that predates per-track styling has.
      const alpha = track.backdrop == null ? background : track.backdrop;
      root.style.setProperty("--sso-bg", `rgba(0, 0, 0, ${alpha})`);
      writePosition(root, track.posX, track.posY);
      root.style.setProperty("--sso-width", `${track.widthPercent}vw`);
      root.style.setProperty("--sso-color", track.color || DEFAULT_TRACK.color);
      root.style.setProperty("--sso-family", FONTS[track.font] || FONTS.sans);
      root.style.setProperty("--sso-weight", String(track.weight ?? DEFAULT_TRACK.weight));
      root.style.setProperty("--sso-outline", outlineShadow(track.outline));
      root.dataset.dim = dimNonSpeech ? "true" : "false";
      // Once placed by hand, a cue's own {\an8} no longer moves it.
      root.dataset.placed = track.placed ? "manual" : "auto";
    });

    // Symbols and wrapping are part of the rendered content, so a change needs
    // a redraw of whatever is currently on screen.
    for (const track of state.tracks) track.activeIndexes = NEEDS_REDRAW;
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
    /* End a drag whose release was never seen.
     *
     * This is the bug behind "I don't even drag, I just hover over the subtitle
     * and it jumps somewhere else". A press captures the pointer, so while the
     * capture is held *every* pointer event in the page retargets to the cue
     * box - which is what makes the feature work. If the matching release never
     * arrives, that state never ends, and the next time the mouse moves
     * anywhere the subtitle teleports to it.
     *
     * The release goes missing more easily than it sounds: players call
     * stopPropagation on pointer events inside the player surface, the button
     * can be let go outside the window, and a page that re-renders under the
     * pointer can swallow it. Rather than enumerate those, notice the state
     * that all of them leave behind - a live drag with no button held - and end
     * it. `buttons` is a bitmask of what is currently down, so zero means the
     * user is not pressing anything, whatever we were told earlier. */
    if (drag && event.pointerId === drag.pointerId && event.buttons === 0) {
      onCuePointerUp(event);
      return;
    }

    if (!drag || event.pointerId !== drag.pointerId) {
      // Not dragging: say which of the two things a press here would do.
      if (!drag) {
        views[slot].cueBox.style.cursor = edgeAt(slot, event.clientX) ? "ew-resize" : "";
      }
      return;
    }

    if (!drag.moved) {
      const far =
        Math.abs(event.clientX - drag.startX) > DRAG_THRESHOLD_PX ||
        Math.abs(event.clientY - drag.startY) > DRAG_THRESHOLD_PX;
      if (!far) return;
      drag.moved = true;
      beginGesture();
    }

    if (drag.sizing) {
      onResizeMove(event);
      return;
    }

    /* Keep the box on screen. The bound is a fact about the screen, so it is
     * applied in screen pixels and converted afterwards - clamping the written
     * percentage instead would assume those percentages span the viewport,
     * which is the assumption `drag.map` exists to stop making.
     *
     * Everything here is the box's top-left corner, because that is what the
     * map reports; the bottom-centre anchor the CSS uses differs from it by a
     * transform the map has already absorbed. */
    const box = views[drag.slot].root.getBoundingClientRect();
    const x = clamp(event.clientX - drag.grabX, 0, Math.max(0, window.innerWidth - box.width));
    const y = clamp(event.clientY - drag.grabY, 0, Math.max(0, window.innerHeight - box.height));
    const local = drag.map.toLocal(x, y);

    updateTrackSettings(drag.slot, {
      posX: round1(local.x),
      posY: round1(local.y),
      placed: true,
    });
  }

  /* Runs once, when a press turns into a gesture.
   *
   * Solves for how a written percentage maps to the screen, and for where the
   * pointer sits relative to the box's anchor. The second is the fix for "it
   * goes further than I drag" and "once it is up I cannot bring it down":
   * the anchor is the box's *bottom* edge, and the old drag wrote the pointer
   * straight into it, so the first move threw away where inside the box you
   * had grabbed. Grab a two-line cue near its top and nudge it down, and it
   * jumped up by most of its height before tracking - down became up. Grab
   * high, drag up, and it covered its own height extra. Holding the offset
   * for the whole gesture makes the box follow the pointer and nothing else. */
  function beginGesture() {
    const view = views[drag.slot];
    const track = state.settings.tracks[drag.slot];

    view.root.dataset[drag.sizing ? "sizing" : "dragging"] = "true";

    drag.map = measurePlacement(view.root, (x, y) => writePosition(view.root, x, y));
    writePosition(view.root, track.posX, track.posY);

    /* Measured from the press, not from the move that crossed the threshold.
     * The offset is "where inside the box the user took hold of it", which the
     * press is the only event that knows: taking it from the first move folds
     * that whole move into the offset and the box never catches up. */
    const corner = drag.map.toViewport(track.posX, track.posY);
    drag.grabX = drag.startX - corner.x;
    drag.grabY = drag.startY - corner.y;

    // Fixed for the gesture: the box grows about its centre, and reading the
    // centre back off a box that is being resized would have it chase itself.
    drag.centreX = corner.x + view.root.getBoundingClientRect().width / 2;
  }

  /* The box grows about its centre, so the width is twice the distance from
   * the centre to the pointer. Measured from the stored centre rather than the
   * box's own, which shifts as the box grows and would have the drag chasing
   * itself. */
  function onResizeMove(event) {
    /* Screen pixels from the centre, and the centre measured on screen rather
     * than assumed from the stored percentage.
     *
     * The width is set in `vw`, which is the viewport's width whatever the
     * containing block is - so unlike the move, this converts with the host's
     * own scale and not with the placement's. A scaled ancestor still renders
     * those vw larger, which is the part that has to be divided back out. */
    const half = Math.abs(event.clientX - drag.centreX);
    const percent = (((half * 2) / window.innerWidth) * 100) / hostScale();
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

    handle = buildHandle();
    shadow.append(...views.map((view) => view.root), handle);

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
      // The toast has a root of its own and is drawn by the same sheet. It can
      // exist before this resolves - a toast is often the first thing shown.
      if (toastLayer) toastLayer.shadow.adoptedStyleSheets = [overlaySheet];
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
  /* Elements that cannot render a child, whatever you append to them.
   *
   * A replaced element draws its own content and nothing else: children are
   * parsed, kept in the DOM, and never painted. Which matters here because
   * `requestFullscreen` can be called on any element, and several players -
   * and Chrome's own "fullscreen the video" - call it on the <video> itself. */
  const CANNOT_HOLD_CHILDREN = /^(VIDEO|IMG|CANVAS|IFRAME|EMBED|OBJECT|INPUT|BR|HR)$/;

  /* The top layer, which is the only place a floating surface can be seen while
   * something else is fullscreen.
   *
   * Everything this extension draws used to be moved into the fullscreen
   * element, because only that subtree is rendered. That works while the site
   * fullscreens a container and fails completely when it fullscreens the
   * <video>: measured on that path, the panel and the whole overlay both
   * rendered 0x0 with `hidden` false and `display` unset. So the panel believed
   * it was open, the CC button toggled it shut, pressing again re-opened it
   * invisibly, and leaving fullscreen revealed a panel that had been open the
   * whole time - which is exactly the "sometimes the button does nothing"
   * report, plus subtitles that vanish in fullscreen for the same reason.
   *
   * A popover is painted in the top layer, above the fullscreen element,
   * whatever its position in the document - so nothing needs moving at all.
   * Ordering within that layer is by when each entry was added, which is why
   * going fullscreen has to push these back to the front: the fullscreen
   * element joins the layer after them and would otherwise cover them.
   *
   * The UA stylesheet for `[popover]` is neutralised by the `all: initial`
   * every host already sets - it is an inline !important declaration covering
   * every longhand, so nothing of the UA rule survives it. */
  function toTopLayer(node, { again = false } = {}) {
    if (!node?.isConnected || typeof node.showPopover !== "function") return false;
    try {
      /* Out of a replaced element first. The top layer decides where a box is
       * painted, not whether one exists - and a child of <video> never
       * generates a box at all, so there is nothing to promote. Measured: the
       * panel reported `:popover-open` and still rendered 0x0 while it sat
       * inside a fullscreen <video> that an earlier version had moved it into. */
      const parent = node.parentElement;
      if (parent && CANNOT_HOLD_CHILDREN.test(parent.tagName)) {
        (document.body || document.documentElement).appendChild(node);
      }
      if (node.getAttribute("popover") !== "manual") node.setAttribute("popover", "manual");
      const showing = node.matches(":popover-open");
      if (showing && again) node.hidePopover();
      if (!showing || again) node.showPopover();
      return true;
    } catch {
      // A browser without the top layer, or a node in a state that refuses it.
      return false;
    }
  }

  /* Where a floating surface can be appended and still be painted.
   *
   * Two rules, and the panel and the study rail need both exactly as much as
   * the cue overlay does. Only the fullscreen element's subtree is rendered, so
   * a surface left on <body> vanishes the moment a player goes fullscreen. And
   * a replaced element paints its own content and nothing else, so appending
   * into a fullscreen <video> is worse than not moving at all: the surface is
   * never painted and still reports itself open.
   *
   * Exported because this rule was written out three times and two of the
   * copies were wrong. panel.js and study.js each tested for VIDEO, but only on
   * the parent they were handed - and `show()` hands them nothing, so the
   * fullscreen element they fell back to was never checked at all. */
  function paintableParent(preferred = null) {
    const usable = (node) => node && !CANNOT_HOLD_CHILDREN.test(node.tagName);
    const fullscreen = document.fullscreenElement || document.webkitFullscreenElement;
    return (
      (usable(preferred) ? preferred : null) ||
      (usable(fullscreen) ? fullscreen : null) ||
      document.body ||
      document.documentElement
    );
  }

  function attachToCorrectParent({ raise = false } = {}) {
    const fullscreen = document.fullscreenElement || document.webkitFullscreenElement;
    if (window.__ssoPanel?.reparent) window.__ssoPanel.reparent(fullscreen, { raise });
    if (window.__ssoStudy?.reparent) window.__ssoStudy.reparent(fullscreen, { raise });
    if (!host) return;

    /* The top layer first, and nothing moves when it works. Appending into the
     * fullscreen element is the fallback for a browser without it - and it
     * refuses a replaced element, where appending is not merely unnecessary
     * but is the bug: the child is never painted and the surface silently
     * disappears. */
    const raised = [host, ...layers].map((node) => toTopLayer(node, { again: raise }));
    if (raised.every(Boolean)) return;

    const parent = paintableParent();
    if (!parent) return;
    if (host.parentElement !== parent || raise) parent.appendChild(host);
    // Floating layers go too. Fullscreen renders only the fullscreen element's
    // subtree, so one left behind is a menu that silently stops appearing.
    for (const layer of layers) if (layer.parentElement !== parent) parent.appendChild(layer);
  }

  /* A toast can carry one action.
   *
   * Two things follow from that and neither is optional. It has to be
   * clickable - the toast is pointer-events:none so that an ordinary one never
   * eats a click meant for the film, and the button opts back in for its own
   * showing only. And it has to stay long enough to be read and reached:
   * TOAST_MS is 1.6 seconds, which is right for a line of confirmation and far
   * too short to notice a mistake and undo it. */
  /* A surface that floats free of whatever opened it.
   *
   * Everything this extension puts on screen lives in a shadow root, and that
   * is what stops a streaming site's stylesheet from reaching in. It also means
   * anything drawn inside a panel is clipped by that panel: a menu opened near
   * the bottom of the control panel was cut off at its edge, which is fine for
   * content and wrong for a menu.
   *
   * `position: fixed` inside the panel nearly works, and fails in exactly the
   * case that matters least often and is hardest to notice: when the overlay is
   * inside a scaled container, the host carries a counter-transform, that
   * transform makes the host the containing block for fixed descendants, and
   * the panel is then between the menu and its containing block - so the clip
   * comes back. A separate host has no ancestor to be clipped by at all.
   *
   * Returns the shadow root to draw into and a `place` that positions the host
   * in viewport coordinates. Callers must call `remove()`; nothing here reaps
   * them, because a layer that vanishes on its own is worse than one that
   * lingers.
   */
  const layers = new Set();

  function makeLayer({ zIndex = "2147483646", interactive = true } = {}) {
    const node = document.createElement("div");
    for (const [property, value] of Object.entries({
      all: "initial",
      position: "fixed",
      top: "0",
      left: "0",
      "z-index": zIndex,
      // The host is a coordinate frame, not a surface: only what is drawn
      // inside it should take a pointer.
      "pointer-events": interactive ? "auto" : "none",
    })) {
      node.style.setProperty(property, value, "important");
    }
    const shadow = node.attachShadow({ mode: "open" });
    (host?.parentElement || document.body).appendChild(node);
    layers.add(node);

    return {
      host: node,
      shadow,
      /** Put the layer's top-left at a point in viewport coordinates. */
      place(x, y) {
        node.style.setProperty("transform", `translate(${Math.round(x)}px, ${Math.round(y)}px)`, "important");
      },
      remove() {
        layers.delete(node);
        node.remove();
      },
    };
  }

  /* A window in its own right: draggable, resizable, closable, and remembered.
   *
   * The settings were a screen inside the control panel, and a reader said the
   * plainest possible thing about it - "clicking the settings button feels like
   * a new window". It does, because it is: you go there to change something and
   * then you are done with it, which is what a window is for and not what a
   * screen in a column is for. A screen also borrows the panel's width, and a
   * grid of key bindings wants more of that than a subtitle card does.
   *
   * Both surfaces get one, so the geometry, the drag, the corners, the close
   * and the remembering are written once here rather than a third and fourth
   * time in panel.js and study.js.
   */
  const MIN_WINDOW = { width: 260, height: 160 };

  function makeWindow({
    title, sheets, storeKey, width = 340, height = 380, onClose = null,
    /* The surface it belongs to, as tokens. Without this a settings window is
     * cool-neutral with a blue accent whoever opened it, so study's own
     * settings came out in the control panel's colours - which is the one thing
     * the two-surface scheme is there to prevent. */
    accent = null, accentInk = null, surface = null,
  }) {
    const layer = makeLayer({ zIndex: "2147483647" });
    layer.shadow.adoptedStyleSheets = sheets;

    const root = document.createElement("div");
    root.className = "sso-win sso-sheet";
    if (accent) root.style.setProperty("--sso-accent", accent);
    if (accentInk) root.style.setProperty("--sso-accent-ink", accentInk);
    if (surface) root.style.background = surface;

    const head = document.createElement("div");
    head.className = "sso-win__head";
    const name = document.createElement("div");
    name.className = "sso-win__title";
    name.textContent = title;
    const close = document.createElement("button");
    close.className = "sso-icon sso-icon--close";
    close.type = "button";
    close.textContent = "×";
    close.title = "Close";

    const body = document.createElement("div");
    body.className = "sso-sheet__body";

    head.append(name, close);
    root.append(head, body);
    layer.shadow.append(root);

    let at = { x: null, y: null };
    let size = { width, height };
    let open = false;

    const place = (x, y) => {
      /* Never off the edge. A window restored from a session on a wider screen
       * would otherwise open where nothing can reach it, and it carries its own
       * close button - so it would be unreachable and unclosable at once. */
      at = {
        x: clamp(x, 8, Math.max(8, window.innerWidth - size.width - 8)),
        y: clamp(y, 8, Math.max(8, window.innerHeight - 60)),
      };
      layer.place(at.x, at.y);
    };

    const applySize = () => {
      size.width = clamp(size.width, MIN_WINDOW.width, Math.max(MIN_WINDOW.width, window.innerWidth - 32));
      size.height = clamp(size.height, MIN_WINDOW.height, Math.max(MIN_WINDOW.height, window.innerHeight - 32));
      root.style.width = `${Math.round(size.width)}px`;
      body.style.height = `${Math.round(size.height)}px`;
    };

    const remember = () => {
      if (!storeKey) return;
      chrome.storage.local.set({ [storeKey]: { ...at, ...size } }).catch(() => {});
    };

    makeMovable(root, {
      host: layer.host,
      place,
      probe: layer.place,
      onEnd: remember,
      keepOnScreen: head,
    });

    for (const corner of [
      { name: "nw", dx: -1, dy: -1, cursor: "nwse-resize" },
      { name: "ne", dx: +1, dy: -1, cursor: "nesw-resize" },
      { name: "sw", dx: -1, dy: +1, cursor: "nesw-resize" },
      { name: "se", dx: +1, dy: +1, cursor: "nwse-resize" },
    ]) {
      const grip = document.createElement("div");
      grip.className = `sso-grip sso-grip--${corner.name}`;
      grip.style.cursor = corner.cursor;
      grip.title = "Drag to resize";
      let from = null;
      grip.addEventListener("pointerdown", (event) => {
        from = { x: event.clientX, y: event.clientY, ...size, left: at.x, top: at.y };
        grip.setPointerCapture?.(event.pointerId);
        event.stopPropagation();
      });
      grip.addEventListener("pointermove", (event) => {
        if (!from) return;
        if (event.buttons === 0) { from = null; return; }
        size.width = from.width + corner.dx * (event.clientX - from.x);
        size.height = from.height + corner.dy * (event.clientY - from.y);
        applySize();
        // Dragging a left or top corner moves the window, so the opposite
        // corner stays where it is - which is what makes a corner a corner.
        place(
          corner.dx < 0 ? from.left + (from.width - size.width) : from.left,
          corner.dy < 0 ? from.top + (from.height - size.height) : from.top,
        );
      });
      const stop = () => { if (from) { from = null; remember(); } };
      grip.addEventListener("pointerup", stop);
      grip.addEventListener("pointercancel", stop);
      root.append(grip);
    }

    const api_ = {
      host: layer.host,
      shadow: layer.shadow,
      root,
      body,
      isOpen: () => open,
      setTitle(text) { name.textContent = text; },
      async show(near) {
        if (!open) {
          let stored = null;
          try {
            stored = storeKey ? (await chrome.storage.local.get(storeKey))[storeKey] : null;
          } catch {
            // Defaults are fine.
          }
          if (stored?.width) size = { width: stored.width, height: stored.height ?? size.height };
          applySize();
          if (stored?.x != null) place(stored.x, stored.y);
          else if (near) {
            /* Beside the window that owns it, not on top of it. `near` is that
             * window's host rather than the button that was pressed - placing
             * against the button put the settings squarely over the panel,
             * because the button is near the panel's right edge and the window
             * hangs left from it. Falls to the right when there is no room on
             * the left. */
            const box = near.getBoundingClientRect();
            const left = box.left - size.width - 12;
            place(left >= 8 ? left : box.right + 12, box.top);
          } else {
            place((window.innerWidth - size.width) / 2, 80);
          }
        }
        open = true;
        layer.host.style.setProperty("display", "block", "important");
        attachToCorrectParent();
      },
      hide() {
        open = false;
        layer.host.style.setProperty("display", "none", "important");
        onClose?.();
      },
      destroy() { layer.remove(); },
    };

    close.addEventListener("click", () => api_.hide());
    root.addEventListener("keydown", (event) => {
      if (event.key === "Escape") api_.hide();
      // Typing in a settings field must not reach the nudge bindings.
      event.stopPropagation();
    });
    api_.hide();
    return api_;
  }

  /* The toast lives in a layer of its own, and is put back on top every time it
   * speaks.
   *
   * It used to sit in the overlay's shadow root, which carries the same
   * z-index as the control panel - and a tie at the same z-index is settled by
   * document order, which the panel wins because it is created second.
   * Measured, with the panel at the position it opens in: the Undo offered when
   * a second subtitle is lined up sat under the panel's left edge, and
   * elementFromPoint at the middle of that button returned the panel. The
   * button was drawn, described, and could not be pressed. An action that
   * cannot be taken is worse than one never offered.
   *
   * Re-appending is what keeps it true. The panel, the study rail and any menu
   * are all created after the overlay and may be re-parented at any time - so
   * being last once is not a property that lasts, and being last at the moment
   * of speaking is the only thing that matters.
   *
   * Not interactive, for the reason it never was: a toast sits over the picture
   * and must not eat a click meant for the film. The button opts back in on its
   * own, through the same rule in overlay.css as before. */
  let toastLayer = null;

  function ensureToast() {
    if (toastLayer && toastLayer.host.isConnected) {
      toastLayer.host.parentElement?.appendChild(toastLayer.host);
      return toast;
    }
    toastLayer = makeLayer({ zIndex: "2147483647", interactive: false });
    if (overlaySheet) toastLayer.shadow.adoptedStyleSheets = [overlaySheet];
    toast = document.createElement("div");
    toast.className = "sso-toast";
    toastLayer.shadow.append(toast);
    return toast;
  }

  function showToast(message, { action = null } = {}) {
    ensureOverlay();
    ensureToast();
    toast.replaceChildren();
    if (!action) {
      toast.textContent = message;
      toast.dataset.action = "false";
    } else {
      const said = document.createElement("span");
      said.textContent = message;
      const button = document.createElement("button");
      button.type = "button";
      button.className = "sso-toast__action";
      button.textContent = action.label;
      button.addEventListener("click", () => {
        toast.dataset.visible = "false";
        clearTimeout(toastTimer);
        action.onClick();
      });
      toast.append(said, button);
      toast.dataset.action = "true";
    }
    toast.dataset.visible = "true";
    clearTimeout(toastTimer);
    toastTimer = setTimeout(
      () => {
        toast.dataset.visible = "false";
      },
      action ? ACTION_TOAST_MS : TOAST_MS,
    );
  }

  // --- cue lookup -----------------------------------------------------------

  /* How far back to look for a line that is still on screen.
   *
   * The search below finds the last line that had started by now; if that one
   * has already ended, an earlier one may still be running - a sign, a song
   * lyric or a caption held across the dialogue under it. Sixteen is far more
   * nesting than a subtitle file ever has and bounds the walk at a constant. */
  const CUE_LOOKBACK = 16;

  /* Which line is on screen at this moment.
   *
   * It was a plain binary search on `start` and `end` together, which is exact
   * for a file whose lines do not overlap and silently wrong for one whose
   * lines do: a long cue with short ones inside it puts a start out of order
   * with the ends, the search follows the wrong half, and the long line
   * disappears for the part of its life the short ones do not cover. Verified
   * on a four-cue example - a line held 1s to 20s with dialogue at 2s and 5s
   * reported "nothing on screen" at 9s and 15s.
   *
   * So the search is on `start` alone, which is the field the file is sorted
   * by and the only one a binary search can be trusted with, and the cover test
   * happens afterwards.
   *
   * Every line covering the moment is returned, in document order, because
   * showing one of them and dropping the other is how a held sign or a song
   * lyric disappears the instant somebody speaks under it. The caller that
   * needs a single line takes the last one: the newest thing said is the thing
   * being said.
   *
   * None of this changes the answer for a file without overlaps, which is
   * nearly all of them - the walk finds one line and the list has one entry. */
  function findCueIndexes(cues, timeMs) {
    let low = 0;
    let high = cues.length - 1;
    let latest = -1;
    while (low <= high) {
      const mid = (low + high) >> 1;
      if (cues[mid].start <= timeMs) {
        latest = mid;
        low = mid + 1;
      } else {
        high = mid - 1;
      }
    }

    const floor = Math.max(0, latest - CUE_LOOKBACK);
    const found = [];
    // Ascending, so the list reads in document order and its last entry is the
    // line that started most recently.
    for (let index = floor; index <= latest; index++) {
      if (timeMs <= cues[index].end) found.push(index);
    }
    return found;
  }

  /** The line a single-line caller should follow: the last one to have started. */
  const lastCue = (track) => {
    const indexes = track.activeIndexes;
    return indexes && indexes.length ? track.cues[indexes[indexes.length - 1]] : null;
  };

  /* Whether the set on screen is the set that should be. Order is part of it -
   * two lines drawn the other way round is a different picture. A null side is
   * NEEDS_REDRAW and never matches, which is the whole point of it. */
  function sameIndexes(a, b) {
    if (!a || !b || a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
    return true;
  }

  function tick() {
    // Fast while there is something to draw, slow while there is not. Decided
    // here rather than at every call site that attaches or detaches, so it
    // cannot be forgotten at one of them.
    startTicking(anyAttached() ? TICK_MS : IDLE_TICK_MS);

    if (!state.video || !state.video.isConnected) {
      state.video = pickVideo();
      if (!state.video) return;
      applySettings();
    }
    /* Every tick, not only when the video is first picked: attach() and the
     * frame probes also assign state.video, so hanging this off the "we just
     * found one" branch left the observer watching nothing on the path most
     * films actually take. It exits on an identity check when unchanged. */
    watchVideoSize();
    /* Before the "nothing attached" exit below, because a page that has never
     * had subtitles on it is exactly where this has something to say. */
    noticeProgrammeChange();
    if (!state.visible || !anyAttached()) {
      // "Nothing is showing", not "redraw" - otherwise this clears the text on
      // every tick forever.
      state.tracks.forEach((track, slot) => {
        if (track.activeIndexes?.length === 0) return;
        track.activeIndexes = [];
        if (views[slot]) views[slot].cueBox.textContent = "";
      });
      return;
    }
    ensureOverlay();
    pollAdState();

    pauseAtLineEnd();

    state.tracks.forEach((track, slot) => {
      if (state.inAd || !track.visible || track.cues.length === 0) {
        // Film subtitles over an advert are worse than none.
        if (track.activeIndexes?.length !== 0) {
          track.activeIndexes = [];
          renderCues(slot, []);
        }
        return;
      }

      const indexes = findCueIndexes(track.cues, filmTimeMs(track));
      if (sameIndexes(indexes, track.activeIndexes)) return;
      track.activeIndexes = indexes;
      renderCues(
        slot,
        indexes.map((index) => track.cues[index]),
      );
    });
  }

  /** Stream time, less this subtitle's own offset and everything that was an ad. */
  /* Where we are in this subtitle file's own clock.
   *
   * The display model is `stream = rate * fileTime + offset + adDrift`, so this
   * is the inverse. Two details it would be easy to get wrong and impossible to
   * notice while rate is 1:
   *
   * The ad drift comes off before the division, because it is measured in
   * stream seconds - an advert takes the same real time whatever the film is
   * encoded at. And the divisor applies to the whole remaining time, which
   * stretches cue ends by the same factor as cue starts, which is right: a
   * film played 4% slow has lines on screen 4% longer.
   *
   * Rate defaults to 1, where this is exactly the expression it replaced. */
  function filmTimeMs(track) {
    const stream = state.video.currentTime * 1000 - state.adDriftMs - track.offsetMs;
    return track.rate && track.rate !== 1 ? stream / track.rate : stream;
  }

  /* Stop when a line finishes, once per line.
   *
   * Intensive listening is the same loop over and over - hear the line, read
   * it, say it back, go on - and the "go on" is the only part that needs a
   * hand. Without this it needs three: pause, rewind, play.
   *
   * Once per line is the whole difficulty. A pause is not a moment, it is a
   * state that lasts until somebody presses play, and by then the playhead is
   * still inside the same line's end - so the next tick would pause again and
   * the film would never move. What is remembered is which line was paused at,
   * and it is forgotten when the playhead leaves that line, whichever way it
   * goes: forwards to the next line, or backwards over it with the Again key,
   * which is the case that must still stop at the end a second time.
   *
   * The keyed subtitle is the one that decides, which is the same rule the
   * line keys use - the language being read is the one whose lines matter. */
  let pausedAtCue = null;

  function pauseAtLineEnd() {
    if (!state.settings.pauseAtLineEnd || !state.video || state.inAd) return;
    const track = state.tracks[state.keyTrack]?.cues.length
      ? state.tracks[state.keyTrack]
      : attachedTracks()[0];
    if (!track) return;

    const now = filmTimeMs(track);
    /* The last line to have started, where several overlap. Stopping at the end
     * of a sign held over the dialogue would stop in the middle of the sentence
     * being spoken, which is the opposite of what this is for. */
    const indexes = findCueIndexes(track.cues, now);
    const cue = indexes.length ? track.cues[indexes[indexes.length - 1]] : null;

    // Out of the line it stopped at - a gap, the next line, or seeked back over
    // it - so that line is done and its end can stop the film again.
    if (pausedAtCue && cue !== pausedAtCue) pausedAtCue = null;
    if (!cue || cue === pausedAtCue || state.video.paused) return;
    /* The end of the line, not a moment after it. The tick runs every 50ms, so
     * the playhead is somewhere in the last tick's worth of the line when this
     * fires; pausing on the way out rather than after the gap has started is
     * what keeps the line on screen while it is being read. */
    if (now < cue.end - TICK_MS) return;

    pausedAtCue = cue;
    state.video.pause();
  }

  /** The other direction: where a moment of this file lands in the stream. */
  function streamTimeMs(track, fileMs) {
    const scaled = track.rate && track.rate !== 1 ? fileMs * track.rate : fileMs;
    return scaled + track.offsetMs + state.adDriftMs;
  }

  // --- moving by line ---------------------------------------------------------

  /* Missing a line is the ordinary event of watching a film in a language you
   * are learning, and the ordinary repair - drag the scrubber back, overshoot,
   * drag forward, overshoot - costs far more attention than the line was worth,
   * and takes your eyes off the picture to do it. The subtitle file already
   * says where every line begins, so the repair is one keystroke.
   *
   * Backwards restarts the line being spoken before it goes to the one before
   * it. That is the rule a music player uses for "previous track" and it is
   * right here for the same reason: the first press is nearly always "say that
   * again". Pressing twice steps back one, because the first press leaves the
   * playhead at the line's own start and the grace period below is then behind
   * it. */
  const LINE_GRACE_MS = 400;
  /* Land a little before the line rather than exactly on it. A seek settles on
   * a keyframe, which can be after the moment asked for, and a repeat that
   * starts one word in has not repeated the line. */
  const LINE_PREROLL_MS = 150;

  function stepLine(direction, { slot = state.keyTrack } = {}) {
    if (!state.video) return false;
    /* The keyed track is the one being read, so its lines are the ones worth
     * stepping through. Falling back to whatever is attached keeps the keys
     * working when the keyed slot happens to be the empty one. */
    const track = state.tracks[slot]?.cues.length > 0 ? state.tracks[slot] : attachedTracks()[0];
    if (!track) return false;

    const now = filmTimeMs(track);
    let cue = direction < 0
      ? lastCueStartingBefore(track.cues, now - LINE_GRACE_MS)
      : firstCueStartingAfter(track.cues, now);
    /* Sitting in the pre-roll of a line - which is exactly where the previous
     * press left the playhead - means that line is the one about to be read,
     * so "next" has to mean the one after it. Without this, Again followed by
     * Next stays where it is and the key looks broken. Backwards needs no such
     * guard: the grace period is longer than the pre-roll, so the search is
     * already behind the line's own start. */
    if (direction > 0 && cue && cue.start - now <= LINE_PREROLL_MS) {
      cue = firstCueStartingAfter(track.cues, cue.start);
    }
    if (!cue) {
      // The key did its job; there was simply nowhere to go.
      showToast(direction < 0 ? "Nothing before this" : "That was the last line");
      return true;
    }

    state.video.currentTime = Math.max(
      0,
      (streamTimeMs(track, cue.start) - LINE_PREROLL_MS) / 1000,
    );
    /* Draw it now rather than up to a tick later. Setting currentTime moves the
     * official playback position immediately, so the tick reads the new time
     * even while the frames are still on their way. */
    for (const other of state.tracks) other.activeIndexes = NEEDS_REDRAW;
    tick();
    return true;
  }

  function lastCueStartingBefore(cues, timeMs) {
    let found = null;
    let low = 0;
    let high = cues.length - 1;
    while (low <= high) {
      const mid = (low + high) >> 1;
      if (cues[mid].start < timeMs) {
        found = cues[mid];
        low = mid + 1;
      } else {
        high = mid - 1;
      }
    }
    return found;
  }

  function firstCueStartingAfter(cues, timeMs) {
    let found = null;
    let low = 0;
    let high = cues.length - 1;
    while (low <= high) {
      const mid = (low + high) >> 1;
      if (cues[mid].start > timeMs) {
        found = cues[mid];
        high = mid - 1;
      } else {
        low = mid + 1;
      }
    }
    return found;
  }

  // --- a new programme, without a page load -----------------------------------

  /* Streaming sites are single pages. Starting the next episode swaps the
   * stream and leaves the tab, the frame and usually the <video> element
   * exactly where they were - so the subtitles for the last episode stay on
   * screen over the new one, which is worse than having none: they are
   * confidently wrong, and they look like a sync problem rather than the wrong
   * file.
   *
   * The mark is the duration and the tab's title, and deliberately not the
   * source URL. currentSrc changes for several things that are not a new
   * programme - a quality switch, a stream re-negotiation, an ad break on the
   * players that swap the element - while duration and title change when the
   * programme does and stay put when it does not. The failure this trades for
   * is two episodes of identical length on a site that never changes its
   * title, where nothing happens and the reader attaches by hand as before.
   * That is the safe direction to be wrong in. */
  /* The title, less the parts that change without the programme changing.
   *
   * A leading "(2) " is an unread count - YouTube, Gmail-style tabs and several
   * players write one - and a leading play or pause glyph is a state, not a
   * name. Left in, either would read as a new episode and take the subtitles
   * off the one being watched. */
  const programmeTitle = () =>
    document.title.replace(/^[\s(\[]*\d+[\s)\]]*/, "").replace(/^[▶►❚■•\s-]+/, "").trim();

  function programmeMark() {
    const video = state.video;
    if (!video || !Number.isFinite(video.duration) || video.duration < MIN_VIDEO_SECONDS) {
      return "";
    }
    return `${Math.round(video.duration)}|${programmeTitle()}`;
  }

  /* Long enough for a player that is still settling - the duration arrives
   * before the title on some sites and after it on others - and short enough
   * that the subtitles are up before the recap ends. */
  const PROGRAMME_SETTLE_MS = 1500;
  let programme = { mark: "", since: 0, told: "" };

  function noticeProgrammeChange() {
    // An advert is not a new programme, and on the players that swap the
    // element for one it is exactly what this would otherwise fire on.
    if (state.inAd) return;

    const mark = programmeMark();
    if (!mark) return;
    if (mark !== programme.mark) {
      programme = { mark, since: performance.now(), told: programme.told };
      return;
    }
    if (programme.told === mark) return;
    if (performance.now() - programme.since < PROGRAMME_SETTLE_MS) return;

    /* Marked as told before the worker answers, not after. The tick runs
     * twenty times a second and this is a round trip; without it, twenty
     * requests go out before the first one is back. */
    programme.told = mark;
    chrome.runtime.sendMessage({ type: "sso:programme", mark }).catch(() => {
      // No worker listening is not this frame's problem to report.
    });
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
      for (const track of state.tracks) track.activeIndexes = NEEDS_REDRAW;
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

  /* Every line covering this moment, stacked in one box.
   *
   * One background and one bottom edge however many lines are in it, so the
   * anchoring the whole overlay is built on still holds and two subtitles side
   * by side still share a baseline. Document order puts the held line above the
   * dialogue that arrived under it, which is where a reader expects context to
   * sit. */
  function renderCues(slot, cues) {
    const { root, cueBox } = views[slot];
    cueBox.replaceChildren();
    /* Where the box sits is one decision for the whole box and the lines in it
     * can disagree. The last to have started decides, for the same reason it
     * decides everywhere else: it is the thing being said. */
    root.dataset.vertical = cues[cues.length - 1]?.vertical || "bottom";
    if (cues.length === 0) {
      if (state.placing) cueBox.textContent = `Drag me — subtitle ${slot + 1}`;
      // Tell study mode the line ended, so a lookup does not outlive the line
      // that raised it.
      window.__ssoStudy?.onCue?.(slot, null, cueBox);
      return;
    }

    for (const cue of cues) {
      const line = document.createElement("div");
      line.className = "sso-line";
      renderCueInto(line, cue);
      cueBox.append(line);
    }

    /* Study mode gets the finished element rather than a hook inside the loop
     * above. Splitting the line into words is its business, it only happens
     * while study mode is on, and doing it here would put a branch in the
     * middle of the one function that runs for every line of every film.
     *
     * It gets the last-started line and the element holding exactly that line's
     * words - not the box, which may hold another line's as well. Marking and
     * saving both would put the wrong sentence on a saved word. */
    window.__ssoStudy?.onCue?.(slot, cues[cues.length - 1], cueBox.lastElementChild);
  }

  function renderCueInto(line, cue) {
    const rewrap = state.settings.rewrap;

    if (!cue.runs) {
      line.textContent = rewrap ? rewrapText(cue.text) : cue.text;
      return;
    }
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
      line.append(span);
    }
  }

  /** Run the tick at a given rate, changing rate only when it actually changes. */
  function startTicking(everyMs = TICK_MS) {
    if (ticker !== null && tickerMs === everyMs) return;
    clearInterval(ticker);
    tickerMs = everyMs;
    ticker = setInterval(tick, everyMs);
  }

  // --- offset ---------------------------------------------------------------

  const offsetKey = (fileId) => `sso:offset:${fileId}`;
  // Read by provider.js when it decides what to look for on the next film.
  const USED_LANGUAGES_KEY = "sso:usedLanguages";
  // The corrections themselves, so the next episode starts where this one ended.
  const USED_TIMING_KEY = "sso:usedTiming";

  /* What was last done to this file's timing.
   *
   * A bare number for every installation that predates rates, and an object
   * since. Reading has to accept both, or the first thing this change does to
   * an existing reader is forget every offset they have set. daemon.js writes
   * the same key - keep the two in step. */
  /* `known` says whether this file has been timed before, which is not the same
   * question as whether the offset is zero: a reader who put a subtitle back to
   * the file's own timing said something, and the release memory below must not
   * talk over it. */
  async function loadOffset(fileId) {
    const nothing = { offsetMs: 0, rate: 1, known: false };
    if (fileId == null) return nothing;
    try {
      const stored = await chrome.storage.local.get(offsetKey(fileId));
      const saved = stored[offsetKey(fileId)];
      if (typeof saved === "number") return { offsetMs: saved, rate: 1, known: true };
      if (!saved) return nothing;
      return {
        offsetMs: Number(saved.offsetMs) || 0,
        rate: Number(saved.rate) || 1,
        known: true,
      };
    } catch {
      return nothing;
    }
  }

  function saveOffset(track) {
    if (track.fileId == null) return;
    chrome.storage.local
      .set({ [offsetKey(track.fileId)]: { offsetMs: track.offsetMs, rate: track.rate } })
      .catch(() => {});
  }

  /* The correction, carried to the next episode.
   *
   * A saved offset belongs to one file, and the next episode is a different
   * file - so a season watched an episode at a time asks for the same
   * correction eight times over. The correction is not really a property of the
   * file, though. It is the gap between how a subtitle was timed and how this
   * copy of the video was encoded, and that gap belongs to the *release*: two
   * files from the same rip, subtitled by the same upload, want the same number.
   *
   * So the memory hangs on the release rather than on the film or on the
   * evening. The label already carries the release name; taking the episode
   * marker out of it leaves the part that is the same all season, and leaves
   * nothing whatever in common with a different download. That scoping is the
   * whole safety argument - a timing is never carried onto something it was not
   * measured against - and it is why this is not a global "last offset used".
   */
  /* Below this a key is not an identity. A local file called `tr.srt` reduces
   * to "tr", and every other `tr.srt` on the disk would then be the same
   * release - a collision that carries one film's correction onto another,
   * which is the single thing this must never do. A real release name is
   * fifteen to sixty characters; ten is well under the shortest of them and
   * well over anything generic enough to repeat. */
  const TIMING_FAMILY_MIN = 10;

  function timingFamily(label) {
    const family = String(label || "")
      .toLowerCase()
      .replace(/\bs\d{1,2}[\s._-]*e\d{1,3}\b/g, " ") // S01E02, s01.e02
      .replace(/\b\d{1,2}x\d{1,3}\b/g, " ") // 1x02
      .replace(/\bseason\s*\d{1,2}\b/g, " ")
      .replace(/\bepisode\s*\d{1,3}\b/g, " ")
      .replace(/\bpart\s*\d{1,2}\b/g, " ")
      .replace(/\b(srt|ass|ssa|sub|vtt)\b/g, " ")
      .replace(/[^a-z0-9]+/g, " ")
      .trim();
    return family.length >= TIMING_FAMILY_MIN ? family : "";
  }

  /* A short list rather than a growing map, so it never needs tidying: the
   * twelve most recent releases are kept and the rest fall off the end. Twelve
   * is more than one evening's viewing and small enough to read in one go.
   *
   * Language is part of the identity, not decoration. English and Turkish
   * subtitles for the same episode are different uploads timed by different
   * people, and one being eight seconds out says nothing about the other. */
  const TIMING_MEMORY_MAX = 12;

  async function rememberTiming(track) {
    const family = timingFamily(track.label);
    if (!family) return;
    try {
      const stored = await chrome.storage.local.get(USED_TIMING_KEY);
      const list = Array.isArray(stored[USED_TIMING_KEY]) ? stored[USED_TIMING_KEY] : [];
      const mine = (entry) =>
        entry?.family === family && (entry?.language || "") === (track.language || "");
      /* A timing of nothing is worth storing only where it replaces something.
       * Undoing a carried correction has to be recorded, or the next episode
       * carries it again - but a release that has never needed a correction
       * would otherwise take one of the twelve places and push out a release
       * that did. */
      if (!track.offsetMs && track.rate === 1 && !list.some(mine)) return;

      const kept = list.filter((entry) => !mine(entry));
      kept.unshift({
        family,
        language: track.language || "",
        offsetMs: track.offsetMs,
        rate: track.rate,
      });
      await chrome.storage.local.set({ [USED_TIMING_KEY]: kept.slice(0, TIMING_MEMORY_MAX) });
    } catch {
      // A timing that fails to be remembered leaves things as they were before
      // any of this existed, which is a working extension.
    }
  }

  /* Written once the nudging stops, not during it. Holding a nudge button fires
   * a dozen times a second and each write here is a read and a write; what is
   * worth remembering is where the reader stopped, not every step on the way. */
  let rememberTimer = null;

  function rememberTimingSoon(track) {
    clearTimeout(rememberTimer);
    rememberTimer = setTimeout(() => rememberTiming(track), 800);
  }

  async function recallTiming(track) {
    const family = timingFamily(track.label);
    if (!family) return null;
    try {
      const stored = await chrome.storage.local.get(USED_TIMING_KEY);
      const list = Array.isArray(stored[USED_TIMING_KEY]) ? stored[USED_TIMING_KEY] : [];
      const found = list.find(
        (entry) =>
          entry?.family === family && (entry?.language || "") === (track.language || ""),
      );
      if (!found) return null;
      const offsetMs = Math.round(Number(found.offsetMs) || 0);
      const rate = Number(found.rate) || 1;
      // This release needed no correction last time, so there is nothing to
      // apply and nothing worth a sentence in the toast.
      if (!offsetMs && rate === 1) return null;
      return { offsetMs, rate };
    } catch {
      return null;
    }
  }

  /* How fast this file's clock runs against the film's.
   *
   * A subtitle timed for 25fps against a 23.976 encode starts right and is
   * minutes out by the end - the one error no offset can fix, and the one that
   * looks like the subtitle "drifting". Kept separate from the offset because
   * nudging still means the same thing under a rate: a constant shift in
   * display time is a constant shift whatever the stretch. */
  /* `byHand` is what separates a correction the reader made from one this code
   * worked out, and only the first is worth remembering for the next episode.
   * The aligner's answer is re-derived from the other subtitle every time, so
   * storing it would be recollection standing in for evidence; a carried timing
   * is already the recollection. Not the same question as `quiet`, which is
   * only about whether to say so. */
  function setRate(rate, { slot = state.keyTrack, quiet = false, byHand = true } = {}) {
    const track = state.tracks[slot];
    const next = Number(rate);
    track.rate = Number.isFinite(next) && next > 0 ? next : 1;
    track.activeIndexes = NEEDS_REDRAW;
    /* The corrections were fitted against the old speed, so under the new one
     * they describe a film that no longer exists. Kept and they would measure a
     * drift that has just been taken out. */
    track.corrections = [];
    track.driftOffered = false;
    saveOffset(track);
    if (byHand) rememberTimingSoon(track);
    notify();
    if (!quiet) {
      showToast(track.rate === 1
        ? "Subtitle back to the film's own speed"
        : `Subtitle running ${((track.rate - 1) * 100).toFixed(1)}% ${track.rate > 1 ? "fast" : "slow"}`);
    }
  }

  function setOffset(ms, { quiet = false, slot = state.keyTrack, byHand = true } = {}) {
    const track = state.tracks[slot];
    track.offsetMs = Math.round(ms);
    track.activeIndexes = NEEDS_REDRAW; // force a re-render at the new offset
    saveOffset(track);
    if (byHand) rememberTimingSoon(track);
    notify();
    if (!quiet) {
      // Name the track only when there are two of them to confuse, and say what
      // the correction did rather than what number it is now.
      const which = attachedTracks().length > 1 ? `Subtitle ${slot + 1}` : "Subtitles";
      showToast(`${which} ${describeOffset(track.offsetMs)}`);
    }
    /* After the toast confirming the nudge, and deliberately replacing it. One
     * toast at a time, and of the two the reader already knows what they just
     * pressed - the drift is the news. Before it, this was written and then
     * immediately overwritten by the line above. */
    if (byHand) noteCorrection(track, slot);
  }

  const nudge = (deltaMs, { slot = state.keyTrack } = {}) =>
    setOffset(state.tracks[slot].offsetMs + deltaMs, { slot });

  /* --- drift ----------------------------------------------------------------
   *
   * The difference between a subtitle that is late and one that is drifting is
   * that nudging fixes the first for good. The second the reader experiences as
   * "I keep having to nudge it", and by then they have already done the
   * measurement: two corrections at different points in the film give the slope
   * between them, and the slope is the rate. Their own ears are the reference.
   *
   * This is the case the aligner cannot reach. It compares two subtitles
   * against each other, so its answer is about the pair, not about either one
   * against the film - and a reader watching in one language has no pair. It is
   * also why the estimate here is a straight line through two points the reader
   * placed rather than anything statistical: there is no noise to see through,
   * only two facts.
   *
   * Both gates below are in milliseconds at the end of the film, because that
   * is the unit the reader lives in. A rate is a number nobody can judge; "two
   * seconds out by the credits" is one anybody can. */
  const DRIFT_WORTH_SAYING_MS = 2000;
  const DRIFT_EXPLAINED_MS = 1000;
  // Two is all the arithmetic needs. The rest are kept so a reader who nudges
  // several times early still has an early point to measure from.
  const DRIFT_MAX_NOTES = 8;

  function noteCorrection(track, slot) {
    const durationMs = (state.video?.duration || 0) * 1000;
    if (!Number.isFinite(durationMs) || durationMs <= 0) return;
    const fileMs = filmTimeMs(track);
    if (!Number.isFinite(fileMs)) return;

    track.corrections.push({ fileMs, offsetMs: track.offsetMs });
    if (track.corrections.length > DRIFT_MAX_NOTES) track.corrections.shift();
    offerDrift(track, slot, durationMs);
  }

  function offerDrift(track, slot, durationMs) {
    // Once. A reader who declines has declined; a second toast saying the same
    // thing is the film interrupting them to repeat itself.
    if (track.driftOffered) return;
    const first = track.corrections[0];
    const last = track.corrections[track.corrections.length - 1];
    const spanMs = last.fileMs - first.fileMs;
    /* Far enough apart to extrapolate from - the aligner's own bar, for the
     * same reason. Two nudges a minute apart measure the reader's patience. */
    if (!(spanMs >= (globalThis.__ssoAlign?.RATE_MIN_SPAN_MS ?? 1200000))) return;

    const rate = track.rate + (last.offsetMs - first.offsetMs) / spanMs;
    if (!(rate > 0)) return;
    // Would leaving it alone cost anything by the end? Two nudges that happen
    // to differ are taste, not drift.
    if (Math.abs(rate - track.rate) * durationMs < DRIFT_WORTH_SAYING_MS) return;

    /* A framerate conversion if one accounts for it, because then the number
     * stops being a measurement and becomes a known ratio - and saying which
     * one tells the reader this will happen to every file from that release.
     * The bar is that the named ratio explains the drift to within a second by
     * the end, which is inside what an offset can mop up. */
    const named = (globalThis.__ssoAlign?.RATES || [])
      .filter((candidate) => candidate !== 1)
      .find((candidate) => Math.abs(rate - candidate) * durationMs <= DRIFT_EXPLAINED_MS);
    const fixed = named ?? rate;

    track.driftOffered = true;
    const percent = Math.abs((fixed - 1) * 100).toFixed(1);
    const way = fixed > 1 ? "fast" : "slow";
    showToast(
      named
        ? `Subtitle running ${percent}% ${way} — a framerate mismatch, not a delay`
        : `Subtitle drifting ${percent}% ${way} across the film`,
      { action: { label: "Fix the drift", onClick: () => applyDrift(track, slot, fixed, last) } },
    );
  }

  /* Apply the speed and keep the line the reader last lined up where they put
   * it. Speed alone would move every line including that one, so the correction
   * they just made by ear would be undone by the button offering to help. */
  function applyDrift(track, slot, fixed, last) {
    const offsetMs = last.offsetMs + (track.rate - fixed) * last.fileMs;
    setRate(fixed, { slot });
    setOffset(offsetMs, { slot, quiet: true, byHand: false });
  }

  function formatOffset(ms) {
    const seconds = (ms / 1000).toFixed(2).replace(/\.?0+$/, "");
    return `${ms > 0 ? "+" : ""}${seconds || "0"}s`;
  }

  /* The offset in words rather than as a signed number.
   *
   * A sign is only meaningful once you know the convention, and the convention
   * here - film time is stream time minus the offset, so a larger offset shows
   * the line later - is not something anybody should have to hold in their head
   * while a film is playing. What a viewer perceives is "the text came before
   * they spoke", and the shortest path from that to a correction is for the
   * control to be labelled with the symptom and the readout to say what was
   * done about it. */
  function describeOffset(ms) {
    if (!ms) return "matching the file";
    const seconds = (Math.abs(ms) / 1000).toFixed(2).replace(/\.?0+$/, "");
    return ms > 0 ? `held back ${seconds}s` : `brought forward ${seconds}s`;
  }

  // --- keyboard -------------------------------------------------------------

  /* What this keystroke typed.
   *
   * event.key, which is the character the layout produced - the same thing the
   * binding stores. Shift is the complication: the large nudge step is Shift
   * and the same key, and Shift over "[" types "{", which matches nothing. The
   * layout map answers exactly that question - it maps a physical key to the
   * character this layout puts on it - so the code goes through it and comes
   * back as the unshifted character. Chrome ships it; where it is missing the
   * letters still work, because Shift over "p" types "P" and case is folded. */
  let layoutMap = null;
  navigator.keyboard?.getLayoutMap?.().then((map) => { layoutMap = map; }).catch(() => {});

  function typedKeys(event) {
    const typed = [String(event.key || "").toLowerCase()];
    const unshifted = layoutMap?.get?.(event.code);
    if (unshifted) typed.push(String(unshifted).toLowerCase());
    return typed;
  }

  /* An unset binding is an empty string and must never match. Without the
   * guard every keystroke that produces nothing - a dead key, a modifier on
   * its own - would fire whichever shortcut had been switched off. */
  const isKey = (typed, binding) =>
    Boolean(binding) && typed.includes(String(binding).toLowerCase());

  /* Reading a binding, for whoever is showing the bindings.
   *
   * It lives here rather than in the panel because there are two surfaces with
   * key bindings on them now - the panel's settings and the study rail's - and
   * two copies of "listen at the document, in the capture phase, and stop the
   * keystroke from also doing what it is bound to" is two places for that last
   * clause to be forgotten. Resolves with the key, or with null for Escape. */
  let captureResolve = null;
  const isCapturingKey = () => captureResolve !== null;

  function captureKey() {
    cancelCapture();
    return new Promise((resolve) => { captureResolve = resolve; });
  }

  function cancelCapture() {
    const resolve = captureResolve;
    captureResolve = null;
    resolve?.(null);
  }

  const MODIFIERS = new Set(["Shift", "Control", "Alt", "Meta", "CapsLock"]);

  function onCaptureKey(event) {
    if (!captureResolve) return;
    // A modifier on its own is somebody reaching for a chord, not a binding.
    if (MODIFIERS.has(event.key)) return;
    event.preventDefault();
    event.stopPropagation();

    const resolve = captureResolve;
    captureResolve = null;
    if (event.key === "Escape") {
      resolve(null);
      return;
    }
    /* The unshifted character, so binding a key with Shift held stores the key
     * rather than the shifted symbol - Shift and "[" types "{", and a binding
     * of "{" would never fire again. */
    const unshifted = layoutMap?.get?.(event.code);
    resolve(String(unshifted || event.key).toLowerCase());
  }

  /* Modifier chords are ignored so page and browser shortcuts win. */
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
    // A keystroke being read as a binding must not also do what it is bound to.
    if (isCapturingKey()) return;

    const keys = state.settings.keys;
    const typed = typedKeys(event);
    const step = event.shiftKey ? state.settings.largeStepMs : state.settings.smallStepMs;
    let handled = true;

    if (isKey(typed, keys.togglePanel)) {
      window.__ssoPanel?.toggle();
    } else if (!anyAttached()) {
      handled = false; // the rest only make sense with something attached
    } else if (isKey(typed, keys.earlier)) {
      nudge(-step);
    } else if (isKey(typed, keys.later)) {
      nudge(step);
    } else if (isKey(typed, keys.prevLine)) {
      handled = stepLine(-1);
    } else if (isKey(typed, keys.nextLine)) {
      handled = stepLine(1);
    } else if (event.key === "Escape" && state.placing) {
      window.__ssoApi.setPlacing(false);
    } else if (isKey(typed, keys.reset)) {
      // Both, because a subtitle that has been stretched is not back to the
      // file's own timing until the stretch goes too.
      setRate(1, { quiet: true });
      setOffset(0, { quiet: true });
      showToast("Subtitle back to the file's own timing");
    } else if (isKey(typed, keys.toggleOverlay)) {
      setVisible(!state.visible);
      showToast(state.visible ? "Subtitles shown" : "Subtitles hidden");
    } else if (isKey(typed, keys.toggleStudy)) {
      handled = Boolean(window.__ssoStudy?.toggle());
    } else if (isKey(typed, keys.saveWord)) {
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
    // Something new in this slot means the removed one is not coming back.
    if (removed?.slot === index) {
      removed = null;
      clearTimeout(removedTimer);
    }

    track.cues = Array.isArray(cues) ? cues : [];
    track.label = label || "";
    track.fileId = fileId ?? null;
    track.language = language || "";
    const timing = await loadOffset(track.fileId);
    track.offsetMs = timing.offsetMs;
    track.rate = timing.rate;
    track.activeIndexes = NEEDS_REDRAW;
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
    rememberLanguages();
    /* The worker owns the "put subtitles on here by themselves" list, because
     * it is the only side that can see the tab's address - this frame may be a
     * player embedded from somewhere else, and the site a reader means is the
     * one in the address bar. Attaching here once is the statement it records.
     *
     * Also marks the programme as dealt with. Without it, an attach made by
     * hand on a page whose mark had not been reported yet would be followed by
     * the worker attaching over the top of it a second later. */
    programme.told = programmeMark() || programme.told;
    chrome.runtime.sendMessage({ type: "sso:attached" }).catch(() => {});
    // Show the handle on attach, so it is discoverable without knowing that
    // moving the mouse summons it.
    revealHandle();

    if (track.cues.length === 0) {
      showToast("That subtitle had no readable lines");
      return { ok: true, cueCount: 0, slot: index };
    }

    /* Line it up against the one already here, if there is one.
     *
     * This is the moment worth spending arithmetic on: two subtitles for the
     * same film, one of them already timed the way the reader wants it, and the
     * other timed against a different release. Both describe the same speech,
     * so the offset between them is the number that keeps appearing in the
     * differences between their cue times.
     *
     * Only when the reader has not already timed this file by hand. A saved
     * offset is an answer they gave, and overwriting it would be this deciding
     * it knows better. */
    const aligned = track.offsetMs === 0 && track.rate === 1 ? autoAlign(index) : null;

    /* Nothing measured and nothing saved, so fall back to what this release
     * needed last time.
     *
     * That order matters and it is the reason this sits after the aligner
     * rather than before it: the aligner compares this file against the one
     * already on screen, which is evidence about this pair of files, while the
     * memory is only evidence about the last pair. Evidence beats recollection.
     * A file with a timing of its own is not touched by either. */
    const carried = aligned?.applied || timing.known ? null : await recallTiming(track);
    if (carried) {
      if (carried.rate !== 1) setRate(carried.rate, { slot: index, quiet: true, byHand: false });
      setOffset(carried.offsetMs, { slot: index, quiet: true, byHand: false });
    }

    const said = `Subtitle ${index + 1} on - ${track.cues.length} lines` +
      `${track.label ? ` · ${track.label}` : ""}`;
    /* Undoing a carried timing is itself an answer - this release does not need
     * the correction after all - so it goes back through the by-hand path and
     * the next episode starts clean. */
    const undo = () => {
      setRate(1, { slot: index, quiet: true });
      setOffset(0, { slot: index, quiet: true });
      showToast("Subtitle back to the file's own timing");
    };

    if (aligned?.applied && !track.offsetMs && track.rate === 1) {
      /* The aligner ran, agreed with the file, and changed nothing. Saying
       * "lined up matching the file" - which is what the sentence below prints
       * for an offset of zero - reads as a correction that was not made, and
       * offers an Undo for it. Observed on two subtitles cut to the same
       * release, which is the ordinary case for a pair downloaded together. */
      showToast(`${said}, already in step`);
    } else if (aligned?.applied) {
      showToast(
        `${said}, lined up with subtitle ${aligned.referenceSlot + 1} · ` +
        `${describeOffset(track.offsetMs)}`,
        { action: { label: "Undo", onClick: () => setOffset(0, { slot: index }) } },
      );
    } else if (carried) {
      // A carried rate with no offset has nothing for describeOffset to say -
      // it would report "matching the file" over a subtitle that is being
      // stretched, which is the one thing the sentence must not do.
      const how = carried.offsetMs
        ? describeOffset(track.offsetMs)
        : "running at the speed you set";
      showToast(`${said}, ${how} as last time`, {
        action: { label: "Undo", onClick: undo },
      });
    } else {
      showToast(said);
    }
    return { ok: true, cueCount: track.cues.length, slot: index, aligned };
  }

  /* The last subtitle taken off, so it can be put back.
   *
   * One deep and not persisted. An undo that survives a reload is a wastebasket,
   * and a wastebasket needs a place to live and a way to empty it; this is the
   * two seconds after a click, which is when the mistake is noticed. */
  let removed = null;
  let removedTimer = null;
  /* How long the way back stays offered. Longer than the toast, because the
   * panel keeps offering it after the toast has gone; short enough that this
   * stays an undo. Past this it would be a wastebasket, which needs somewhere
   * to live and a way to empty it, and this is two subtitles, not a filesystem. */
  const UNDO_MS = 30000;

  /* What you actually watch with, in the order you put it on screen.
   *
   * Attaching English and then Turkish is a reader saying what they want, and
   * until now nothing listened: the next film went back to whatever the options
   * page had been set to, and a pair had to be built by hand again. The
   * shortcut already fills both slots - it just filled them from a list nobody
   * had told about this evening's viewing.
   *
   * Slot order is the whole point, not just the set. Slot 0 is the language
   * being learnt and slot 1 is the one it is being learnt from, and getting
   * them the wrong way round is not a small error.
   *
   * Written on every attach, so the most recent pair wins, and stored rather
   * than derived because a new video is usually a new page with no memory of
   * the last one. The geometry needs no help: the arrangement lives in the
   * settings and survives on its own.
   */
  function rememberLanguages() {
    const used = state.tracks.map((track) => (track.cues.length > 0 ? track.language || "" : ""));
    if (!used.some(Boolean)) return;
    chrome.storage.local.set({ [USED_LANGUAGES_KEY]: used }).catch(() => {});
  }

  /* Line one subtitle up against the other.
   *
   * Returns what the aligner said, or null when there is nothing to compare
   * against or align.js did not load - the extension has to keep working
   * without it, because a file that fails to load should cost a feature and not
   * the whole overlay.
   *
   * Applies the answer only when the aligner is sure enough to be trusted
   * without asking. Anything less confident comes back as a proposal for the
   * panel to offer, because a subtitle silently shifted by the wrong amount is
   * harder to diagnose than one that was never touched.
   */
  /* Only the confident verdict acts on its own, and that is a measurement, not
   * caution.
   *
   * The middle verdict looks like the one to take automatically - a pair
   * downloaded together is known to be the same film, so why ask? Modelled
   * against this repository's own subtitles, it is the wrong band to reach for.
   * An independently timed translation of the same film, with lines scattered
   * by 300ms, six per cent of them badly placed and eight per cent missing,
   * scores 733 and recovers the true shift to within 4ms. Degraded until a
   * quarter of the lines are gone and a fifth are placed by up to six seconds,
   * it still scores 89 - eleven times the confident threshold - and is still
   * within 23ms.
   *
   * Pairs that land in the middle band are not ordinary translations; they are
   * ones the aligner genuinely cannot read, and the number it returns there is
   * not merely less certain, it is wrong: the two constructed cases that scored
   * 7.49 and 4.79 recovered shifts 1.8s and 2.8s from the truth. Applying those
   * silently would move a subtitle nearly two seconds and call it lined up.
   *
   * So the middle band stays one click, in the panel, where the reader can see
   * the number before taking it. */
  function autoAlign(slot, { against = null } = {}) {
    const aligner = globalThis.__ssoAlign;
    if (!aligner) return null;
    const target = state.tracks[slot];
    if (!target || target.cues.length === 0) return null;

    /* The lowest attached slot that is not this one - so with two subtitles
     * the first is the reference and the second moves, which is the rule a
     * reader can hold: the one already on screen is the truth. */
    const referenceSlot = against ?? state.tracks.findIndex(
      (track, index) => index !== slot && track.cues.length > 0,
    );
    if (referenceSlot < 0) return null;
    const reference = state.tracks[referenceSlot];
    if (!reference || reference.cues.length === 0) return null;

    const answer = aligner.align(
      reference.cues.map((cue) => cue.start),
      target.cues.map((cue) => cue.start),
    );
    if (!answer.ok) return { ...answer, referenceSlot };

    /* The aligner maps reference-file time to target-file time:
     * `tB = rate * tA + shift`. The reference is already on screen at its own
     * offset and rate, and what the target needs is the pair that puts the same
     * words on screen at the same moment.
     *
     * Composing the two: the target's rate is the reference's divided by the
     * gap's, and its offset is the reference's less the gap, scaled. With both
     * rates at 1 - which is nearly always - this is `offset - shift` and
     * nothing else, which is the case worth reading. */
    const rate = reference.rate / answer.rate;
    const offsetMs = Math.round(reference.offsetMs - (reference.rate * answer.shiftMs) / answer.rate);
    const applied = answer.verdict === "apply";
    if (applied) {
      if (rate !== 1) setRate(rate, { slot, quiet: true, byHand: false });
      setOffset(offsetMs, { slot, quiet: true, byHand: false });
    }
    /* `applied` rather than each caller re-deriving it from the verdict. Two of
     * them did, and the one that decides whether to fall back to the release
     * memory has to agree with the one that writes the toast - or the reader is
     * told a correction was carried over and shown a different one. */
    return { ...answer, referenceSlot, offsetMs, trackRate: rate, applied };
  }

  /** Drop one track, or every track when no slot is named. */
  function detach(slot) {
    const slots = slot == null ? state.tracks.map((_, index) => index) : [Number(slot)];
    for (const index of slots) {
      const track = state.tracks[index];
      if (!track) continue;
      /* Replace the track rather than overwriting it. It used to be
       * `Object.assign(track, newTrack())` - the same object, emptied - so
       * anything holding a reference in order to put it back had it wiped by
       * the very call it was meant to survive. */
      if (track.cues.length > 0) {
        removed = { slot: index, track, at: Date.now() };
        clearTimeout(removedTimer);
        // Notifies on expiry, so the panel's row goes when the offer does
        // rather than lingering until something else happens to redraw.
        removedTimer = setTimeout(() => {
          removed = null;
          notify();
        }, UNDO_MS);
      }
      state.tracks[index] = newTrack();
      state.tracks[index].activeIndexes = NEEDS_REDRAW;
      if (views[index]) views[index].cueBox.textContent = "";
    }
    notify();
    return { ok: true };
  }

  /* Put the last removed subtitle back.
   *
   * Only the track goes in the stash. The box - position, width, size - lives
   * in settings.tracks[slot], which detach never touches, so it is still there
   * to come back to. The test asserts it anyway: "detach should also clear the
   * geometry" is a tidy-looking change somebody will make one day, and this is
   * where they find out it breaks the undo. */
  function undoRemove() {
    if (!removed) return { ok: false };
    const { slot, track } = removed;
    removed = null;
    clearTimeout(removedTimer);
    state.tracks[slot] = track;
    track.activeIndexes = NEEDS_REDRAW;
    ensureOverlay();
    syncRootVisibility();
    startTicking();
    notify();
    showToast(`Subtitle ${slot + 1} back${track.label ? ` · ${track.label}` : ""}`);
    return { ok: true, slot };
  }

  /** Whether there is something to put back, for the panel to offer it. */
  const removedTrack = () =>
    removed && { slot: removed.slot, label: removed.track.label, at: removed.at };

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
      state.tracks[index].activeIndexes = NEEDS_REDRAW;
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
        rate: track.rate,
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
        for (const track of state.tracks) track.activeIndexes = NEEDS_REDRAW;
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
    setRate,
    nudge,
    stepLine,
    formatOffset,
    describeOffset,
    // Shared by the panel and the study rail, which are both dragged around a
    // page whose coordinate system is not necessarily the viewport's.
    measurePlacement,
    makeMovable,
    makeLayer,
    makeWindow,
    // Shared with the panel and the study rail, which have hosts of their own
    // and the same fullscreen problem. See toTopLayer and paintableParent.
    toTopLayer,
    paintableParent,
    setPlacing(on) {
      state.placing = Boolean(on);
      for (const track of state.tracks) track.activeIndexes = NEEDS_REDRAW;
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
      for (const track of state.tracks) track.activeIndexes = NEEDS_REDRAW;
      notify();
    },
    pageInfo,
    hasPlayableVideo,
    updateSettings,
    updateTrackSettings,
    resetSettings,
    resetKeys,
    captureKey,
    cancelCapture,
    isCapturingKey,
    applyLook,
    autoAlign,
    looks: LOOKS,
    fonts: FONTS,
    showToast,
    undoRemove,
    removedTrack,
    /* Study mode needs to read the line under a word to save it with its
     * sentence, and the paired line in the other language, which is the whole
     * reason a word is worth saving at all. */
    cueAt(slot) {
      return lastCue(state.tracks[slot]);
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
      for (const track of state.tracks) track.activeIndexes = NEEDS_REDRAW;
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
    if (!isPageSubject(pickVideoCached())) return;
    ensureOverlay();
    revealHandle();
  }

  /* Capture phase, not bubble. Video players routinely stopPropagation on
   * pointer events inside the player so their own chrome can own them, which
   * means a bubble-phase listener on document never runs while the pointer is
   * over the film - precisely where it needs to. Capture runs top-down before
   * any of that. mousemove as well as pointermove, because a few players
   * synthesise only one of the two. */
  /* The other half of the stale-drag guard above. Capture phase, because a
   * player that stops propagation on pointer events is exactly the situation
   * that loses the release in the first place - a bubble-phase listener would
   * be silenced by the same thing it exists to survive. */
  function onGlobalPointerEnd(event) {
    if (drag && event.pointerId === drag.pointerId) onCuePointerUp(event);
  }

  /* The picture changes size without any setting changing: entering fullscreen,
   * resizing the window, a player switching to theatre mode. Since the subtitle
   * is sized off the picture, each of those has to re-derive it - otherwise the
   * text keeps the size it had for a frame that is no longer there.
   *
   * A ResizeObserver on the video covers the cases no event announces, which is
   * most of them; the two explicit listeners cover the moment of the fullscreen
   * transition, when the video's own box may not have settled yet. */
  const videoResize =
    typeof ResizeObserver === "function" ? new ResizeObserver(() => applySettings()) : null;
  let observedVideo = null;

  function watchVideoSize() {
    if (!videoResize || state.video === observedVideo) return;
    if (observedVideo) videoResize.unobserve(observedVideo);
    observedVideo = state.video;
    if (observedVideo) videoResize.observe(observedVideo);
  }

  const onViewportChange = () => {
    applySettings();
    // Fullscreen can scale what we are inside, which changes where a written
    // position lands as well as how big things look.
    window.__ssoPanel?.rescale?.();
    window.__ssoStudy?.rescale?.();
  };

  /* Before onKeyDown, so a keystroke being read as a binding is taken out of
   * the way first. Both are capture-phase at the document, so this one has to
   * be registered first to run first. */
  document.addEventListener("keydown", onCaptureKey, true);
  document.addEventListener("keydown", onKeyDown, true);
  window.addEventListener("resize", onViewportChange, { passive: true });
  document.addEventListener("fullscreenchange", onViewportChange);
  document.addEventListener("webkitfullscreenchange", onViewportChange);
  document.addEventListener("pointerup", onGlobalPointerEnd, true);
  document.addEventListener("pointercancel", onGlobalPointerEnd, true);
  document.addEventListener("pointermove", onPointerMove, { passive: true, capture: true });
  document.addEventListener("mousemove", onPointerMove, { passive: true, capture: true });
  /* Forced, because entering fullscreen adds the fullscreen element to the top
   * layer after everything already in it - so what was in front is now behind,
   * and only re-entering puts it back. */
  const onFullscreenChange = () => attachToCorrectParent({ raise: true });
  document.addEventListener("fullscreenchange", onFullscreenChange);
  document.addEventListener("webkitfullscreenchange", onFullscreenChange);
  loadOverlayStyles();
  loadSettings();
  startTicking();

  /* Everything this injection added, undone. Called by the next injection so a
   * version upgrade leaves exactly one copy running. */
  window.__ssoTeardown = () => {
    clearInterval(ticker);
    ticker = null;
    tickerMs = 0;
    clearTimeout(toastTimer);
    clearTimeout(handleTimer);
    clearTimeout(rememberTimer);
    videoResize?.disconnect();
    observedVideo = null;
    document.removeEventListener("keydown", onCaptureKey, true);
    document.removeEventListener("keydown", onKeyDown, true);
    window.removeEventListener("resize", onViewportChange);
    document.removeEventListener("fullscreenchange", onViewportChange);
    document.removeEventListener("webkitfullscreenchange", onViewportChange);
    document.removeEventListener("pointerup", onGlobalPointerEnd, true);
    document.removeEventListener("pointercancel", onGlobalPointerEnd, true);
    document.removeEventListener("pointermove", onPointerMove, { capture: true });
    document.removeEventListener("mousemove", onPointerMove, { capture: true });
    document.removeEventListener("fullscreenchange", onFullscreenChange);
    document.removeEventListener("webkitfullscreenchange", onFullscreenChange);
    chrome.runtime.onMessage.removeListener(onMessage);
    toastLayer?.remove();
    toastLayer = null;
    toast = null;
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
