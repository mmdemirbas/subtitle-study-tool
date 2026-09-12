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

  /* A copy of this script that no longer belongs to a live extension.
   *
   * Reloading or updating an extension orphans the content scripts already
   * running in open tabs. The DOM is still there and the code keeps ticking,
   * but every `chrome.*` call throws "Extension context invalidated" - and it
   * throws SYNCHRONOUSLY, which is the whole bug. Every call site here is
   * written `chrome.something(...).catch(...)`, and a synchronous throw happens
   * before there is a promise for that catch to attach to, so it reaches the
   * top of the frame uncaught.
   *
   * Reported from the extension's own error page: "Uncaught Error: Extension
   * context invalidated. src/content.js:4326", which is the sendMessage inside
   * trace(). trace() is reached from the tick, so one orphaned frame threw that
   * twenty times a second for as long as its tab stayed open - and the error
   * page is the only place it could be seen, because the daemon is exactly what
   * an invalidated context can no longer reach.
   *
   * `chrome.runtime.id` is undefined once it has happened, and reading it costs
   * nothing. Everything below goes through these three, so a new call site
   * cannot reintroduce the throw by forgetting to guard. */
  let orphaned = false;

  function alive() {
    if (orphaned) return false;
    try {
      if (chrome.runtime?.id) return true;
    } catch {
      // Some builds throw on the property read itself rather than answering.
    }
    orphan();
    return false;
  }

  /* Going quiet is the point, not swallowing the error.
   *
   * An orphaned frame that merely caught its failures would go on doing nothing
   * twenty times a second, holding a video observer and a document full of
   * listeners, for as long as the tab is open. There is no way to report this:
   * the worker it would report to is gone. Stopping is the whole remedy. */
  function orphan() {
    if (orphaned) return;
    orphaned = true;
    try {
      window.__ssoTeardown?.();
    } catch {
      // A teardown that fails must not leave the flag unset.
    }
  }

  /** Never throws and never rejects. null means "no answer", as it always did. */
  function sendToWorker(message) {
    if (!alive()) return Promise.resolve(null);
    try {
      return chrome.runtime.sendMessage(message).catch(() => null);
    } catch {
      orphan();
      return Promise.resolve(null);
    }
  }

  /** Reading storage, with "the extension is gone" answering as "nothing kept". */
  async function readStored(keys) {
    if (!alive()) return {};
    try {
      return (await chrome.storage.local.get(keys)) || {};
    } catch {
      if (!alive()) return {};
      // A real storage failure, not an orphaned context. Defaults are fine.
      return {};
    }
  }

  /** Writing it, which is allowed to be lost but never to throw. */
  function writeStored(patch, { remove = null } = {}) {
    if (!alive()) return Promise.resolve(false);
    try {
      const done = remove
        ? chrome.storage.local.remove(remove)
        : chrome.storage.local.set(patch);
      return done.then(() => true).catch(() => false);
    } catch {
      orphan();
      return Promise.resolve(false);
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
  const HAVE_METADATA = 1; // HTMLMediaElement.HAVE_METADATA, off the instance
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

    /* Where this subtitle's strip of studied words sits, and how wide it is.
     *
     * Its own place on the screen rather than a row hanging under the cue,
     * asked for directly: "they should have their own places on the screen and
     * Place button (or drag&drop) should allow to relocate/resize them just
     * like the subtitle areas". Same units, same anchor and the same drag as
     * the subtitle, because they are the same kind of thing - a box the reader
     * puts where they want it and expects to find again.
     *
     * The default is just above the dialogue, stacking upwards, and that is a
     * decision about the only screen it has to be sane on. Under a subtitle is
     * out: two subtitles are already at 88% and 96%, so a strip under either
     * lands on the other. The top of the picture is out too - the focus box
     * parks top-right, and a strip centred up there covers its buttons, which
     * measured as a Save that could not be pressed. Above the lines it is in
     * the same glance as the lines and in nothing else's way.
     *
     * Bottom edges, like every other posY here. */
    stripX: 50,
    stripY: 78,
    stripWidth: 56,
    stripPlaced: false,

    /* Which edge of its own box the text is ranged against.
     *
     * Only meaningful for a box that is not in the middle of the picture, and
     * that is exactly what it is for: a box pushed to the left edge with its
     * text still centred has a left margin that changes with every line, so it
     * reads as drifting rather than as placed. "center" is what the stylesheet
     * has always done and what every existing installation gets. */
    align: "center",

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
  /* How far apart two strips start, in percent of the viewport height. A strip
   * is one row of word cards - about 7% of an 800px picture - and this is that
   * plus a gap, so the second one starts clear of the first. They stack
   * upwards, away from the dialogue. */
  const STRIP_STACK_PERCENT = 9;

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

  /* Both against one edge of the picture, stacked.
   *
   * Reported as missing: "I cannot place the subtitles aligned to the left or
   * right of the screen." Dragging could always put a BOX near an edge, and
   * that is not the same thing - the text inside it stays centred, so a box
   * pushed left renders its short lines in the middle of itself and the left
   * margin visibly breathes in and out from line to line. What makes an edge
   * placement read as one is the text being aligned to that edge too, which is
   * why these carry `align` and the other two do not.
   *
   * It is also the placement that leaves the middle of the frame clear, which
   * is where faces are. 44% at 24 leaves a two percent margin outside the box
   * and the whole right half of the picture untouched. */
  const LEFT_EDGE = [
    { posX: 24, posY: 88, widthPercent: 44, align: "left" },
    { posX: 24, posY: 96, widthPercent: 44, align: "left" },
  ];

  const RIGHT_EDGE = [
    { posX: 76, posY: 88, widthPercent: 44, align: "right" },
    { posX: 76, posY: 96, widthPercent: 44, align: "right" },
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
      /* The known language sits slightly smaller: it is there to be glanced at,
       * not read. Its strip starts below the other one's, for the same reason
       * two subtitles do not start on top of each other. */
      {
        ...DEFAULT_TRACK,
        fontScale: 0.88,
        stripY: DEFAULT_TRACK.stripY - STRIP_STACK_PERCENT,
      },
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

    /* The running log, and the switch that stops it.
     *
     * On by default because its whole value is being there before anybody
     * knew they wanted it - a record that starts when you go looking for one
     * has already missed the thing. Off means off everywhere and at once: the
     * frames and the service worker both route through trace.js, which reads
     * this, so nothing keeps recording after the switch is thrown. */
    diagnostics: true,
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
    /* Extra offset per ACT, on top of offsetMs, when one number will not do.
     *
     * Two releases of one broadcast episode keep different amounts of black
     * around the advertising breaks, so they agree within an act and jump
     * between them. Measured over 41 such pairs in bench/align: one shift puts
     * a median of 50% of the film inside 250ms and per-act offsets put 90%
     * there. This is what "I had to correct the sync four times in one
     * episode" is, and correcting it four times is what the reader was doing
     * instead.
     *
     * Sorted by fromMs, the first entry always at 0 with offset 0, so a track
     * that needs one shift carries a one-entry list and every expression below
     * reduces to what it was. Hand corrections move offsetMs and leave these
     * alone, so the staircase travels with the correction rather than being
     * flattened by it. */
    steps: [],
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
  /* Which half of a split page this frame is - "solo", "video" or "chrome".
   * Up here with the rest of the shared state because the tick, the key
   * handler, status() and the diagnostic all ask; the whole arrangement is in
   * "the other frame" below. */
  let role = "solo";
  let videoFrameId = null;

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

  /* How long the film is, when anything knows.
   *
   * `video.duration` is the whole answer for a file the browser was given the
   * length of, and no answer at all for a stream produced as it is sent: there
   * the number is whatever has arrived so far. Measured in Chrome on the local
   * catalogue app this repo is used with, over the first fifteen seconds of an
   * episode: 3.878, 9.675, 18.476, 33.408, against a response carrying
   * `accept-ranges: none` and no `content-length`.
   *
   * A growing number is worse than no number - it is what the map would draw,
   * what the programme mark would key on, so every tick would look like the
   * next episode starting, and what the drift estimator would divide by. Every
   * reader of it already handles not knowing: the map hides itself and the mark
   * stays quiet.
   *
   * `seekable` does NOT separate the two, which is worth writing down because
   * it looks as though it should. Chrome reports one seekable range over what
   * has arrived, so a stream 10 seconds in is indistinguishable from a
   * 10-second file that can be seeked. The one thing that separates them is
   * that this one CHANGES, so that is what is watched.
   *
   * It is COUNTED, and never counted back down. Growth was first read as a
   * recent event - trust the element's own number again once it had been still
   * for two seconds - and that is wrong, because a stream is written into the
   * pipe in bursts and the pauses between them are longer than any window worth
   * having. Measured on the real page: the reported length flipped between the
   * page's 2760 and the arrived-so-far 10, 18.6, 22.1, 25.1 ten times in
   * twenty-four seconds. Every flip is a different programme mark, so both
   * subtitles were reported gone and re-attached, over and over, and the map
   * blinked out between them. Reported as "it thinks that both subtitles are
   * removed, shows a message then both subtitles come back".
   *
   * ONE growth is enough, and waiting for a second cost ten seconds of every
   * playback. The second was meant to protect a player that sets a placeholder
   * and corrects it once - but that player was never at risk, because a
   * duration arriving from nothing is not a growth: `noticeLength` starts the
   * record at the first finite value, so NaN to 46:13 is counted as zero
   * changes. Measured on the catalogue app: the stream's length climbs in
   * plateaus, one step every couple of seconds, so a second step is seconds
   * away rather than the moment the first was seen. For those seconds the
   * arrived-so-far number is under a minute, the film is refused for being
   * short, and the page reports no video playing - twenty consecutive samples
   * of it at 500ms each. That is the same failure as "the subtitle overlay is
   * not shown in this page", reintroduced by the guard against a case that
   * does not exist.
   *
   * A new resource on the element starts the count over, because what was
   * learned was learned about the old one.
   *
   * A page that knows better says so - see the clock below. */
  const LENGTH_GROWTH_S = 0.25;   // below this, a re-read is not a change
  const LENGTH_GROWTHS = 1;
  const lengths = new WeakMap();
  const forgetLength = (event) => lengths.delete(event.currentTarget);

  /* Called from pickVideo, which already walks every video on the page. */
  function noticeLength(video) {
    const seconds = video.duration;
    if (!Number.isFinite(seconds) || seconds <= 0) return;
    const seen = lengths.get(video);
    if (!seen) {
      // Never grown as far as anyone knows, which is the ordinary case.
      lengths.set(video, { seconds, grew: 0 });
      // Same function, so a second load does not stack a second listener.
      video.addEventListener("loadstart", forgetLength);
      return;
    }
    if (seconds - seen.seconds > LENGTH_GROWTH_S) seen.grew += 1;
    seen.seconds = seconds;
  }

  function filmSeconds(video = state.video) {
    const seen = lengths.get(video);
    if (seen && seen.grew >= LENGTH_GROWTHS) return statedSeconds();
    const own = video?.duration;
    if (!Number.isFinite(own) || own <= 0) return null;
    /* On the film's clock, which is not the element's.
     *
     * `duration` is the length of what the element is HOLDING, and a page that
     * says where its stream starts (`startSeconds`, below) is saying the
     * element holds the film from that moment on - so its duration is what is
     * left of the film, not the film. The two numbers were read off the same
     * element and reported side by side without ever being put on the same
     * clock.
     *
     * Measured from a panel capture on the local catalogue app, 39 minutes into
     * a 45-minute episode after the player had re-opened the stream:
     * currentTime 2363, duration 11. The map drew an axis eleven seconds wide
     * and pinned the playhead against its right-hand edge, where it stayed -
     * reported as "the play marker on the subtitle maps becomes frozen at the
     * right edge of the map area". */
    return startSeconds(video) + own;
  }

  /* How long the page SAYS the film is, from schema.org.
   *
   * Only consulted when the element's own number cannot be trusted, which is
   * the rare path - so it is parsed on demand rather than kept up to date, and
   * memoised for a second because the caller runs several times a second.
   *
   * A `VideoObject` wins over the work it belongs to: `duration` on a Movie is
   * the published runtime, rounded to the minute, while a VideoObject describes
   * the encode actually on the page and can say 46 minutes 13.162 seconds. Half
   * a minute of error would be visible on the map this feeds. */
  let statedLength = { at: -Infinity, seconds: null };
  const STATED_LENGTH_MS = 1000;

  /* ...and only while it is a length a film could have.
   *
   * This is the last word once the element's own duration cannot be trusted,
   * so an impossible number goes straight onto the map, into the programme
   * mark and into the drift estimator's divisor, with nothing downstream to
   * catch it. Two shapes turn up. A wrong unit: the local catalogue app writes
   * `PT${seconds}S` and the same field in milliseconds is 32 days. And a
   * placeholder short enough to make a film look like an advert, which would
   * take the overlay off a page that had it. Out of range is not a length,
   * which every reader of this already handles. */
  const LONGEST_FILM_S = 24 * 3600;

  function statedSeconds() {
    /* An announced length is the film's own, from the party that opened the
     * stream, and it is there before the first frame is decoded. Everything
     * below is how to find one on a page that does not announce - including
     * the VideoObject the catalogue app only writes once playback has started,
     * which is after the moment this is most needed. */
    const announced = announcedProgramme()?.durationSeconds;
    if (announced) return announced;

    const now = performance.now();
    if (now - statedLength.at < STATED_LENGTH_MS) return statedLength.seconds;
    let best = null;
    for (const item of readJsonLd()) {
      const type = schemaType(item);
      if (!SCHEMA_VIDEO_TYPE.test(type)) continue;
      const seconds = isoSeconds(item.duration);
      if (seconds === null || seconds < MIN_VIDEO_SECONDS || seconds > LONGEST_FILM_S) continue;
      if (/VideoObject/i.test(type)) { best = seconds; break; }
      if (best === null) best = seconds;
    }
    statedLength = { at: now, seconds: best };
    return best;
  }

  /* ISO 8601 durations, which is how schema.org writes one: PT46M13.162S. */
  function isoSeconds(value) {
    const match = /^P(?:([\d.]+)D)?(?:T(?:([\d.]+)H)?(?:([\d.]+)M)?(?:([\d.]+)S)?)?$/.exec(
      String(value ?? "").trim(),
    );
    if (!match) return null;
    const [, days, hours, minutes, seconds] = match.map((part) => (part ? Number(part) : 0));
    const total = days * 86400 + hours * 3600 + minutes * 60 + seconds;
    return Number.isFinite(total) && total > 0 ? total : null;
  }

  /* The element's clock is not always the film's clock.
   *
   * A stream that cannot be seeked is seeked by fetching a new one that begins
   * at the moment asked for - so resuming an episode 22 minutes in gives an
   * element whose `currentTime` starts at zero while the picture is 22 minutes
   * into the film. Nothing about the element says so, and subtitles put on it
   * are wrong by the resume point in a way that looks exactly like a bad sync.
   *
   * There is no standard that carries it, and both candidates were tried:
   * ffmpeg's `-copyts` does not survive the MP4 muxer - Chrome reports
   * currentTime 0 and buffered.start(0) 0 for a stream built with it and one
   * built without, measured side by side - and the Media Session API, which is
   * where a page states its true position, is write-only: `positionState` has
   * no getter, in the page's world or in ours.
   *
   * So this one fact is stated on the element, in seconds:
   *
   *   <video data-sso-time-offset="1320">
   *
   * The film's LENGTH is not here. That has a standard vocabulary and is read
   * from it - see `statedSeconds`. This is the only thing the extension asks a
   * page to invent.
   *
   * It is read live, because a player that seeks this way changes it.
   * Everything in this file is on the film's clock; the element's is that
   * clock less `startSeconds`, and `seekFilm` below is the only place that has
   * to go back the other way. */
  function timingHint(video, key) {
    const said = Number.parseFloat(video?.dataset?.[key] ?? "");
    return Number.isFinite(said) && said >= 0 ? said : null;
  }
  const startSeconds = (video = state.video) => timingHint(video, "ssoTimeOffset") ?? 0;
  const streamNowMs = (video = state.video) =>
    ((video?.currentTime || 0) + startSeconds(video)) * 1000;
  const elementSeconds = (streamMs, video = state.video) =>
    Math.max(0, streamMs / 1000 - startSeconds(video));

  /* Asking for a moment of the film, when writing the clock will not get there.
   *
   * Everything above assumes the element can be put where it is asked to go. On
   * a stream produced as it is sent it cannot. Measured on 2026-08-23 against
   * the local player, on a remux of a .mkv: `seekable` was the single empty
   * range [0, 0] while `buffered` held [0.08, 8.02], and every write came back
   * as 0 on the very next read - 2.52s backwards inside the buffer, 28.75s
   * forwards past it, 60s backwards past its start - each one firing `seeking`
   * and then `seeked` to say it had happened. Playback carried on from 2.2s,
   * the start of the stream.
   *
   * So T and Y did not step a line there. They threw the picture back to
   * wherever the page last opened the stream, which is further back the longer
   * it had been playing - reported as "T jumps too much previous subtitle
   * positions". Y went backwards for the same reason.
   *
   * A page that seeks by fetching a new stream is the only thing that can seek
   * one, so it is asked. This is the other half of the timing contract, and the
   * only other invented thing here:
   *
   *   <video data-sso-seek="film">          the page accepts asks, on the film's clock
   *   video.dataset.ssoSeekTo = "1234.500"  the moment wanted, in film seconds
   *   video.dispatchEvent(new Event("sso:seek", { bubbles: true }))
   *
   * A string on the element rather than a CustomEvent detail, because an object
   * built in this world is not reliably readable in the page's and the DOM is
   * the one thing both worlds share. The ask is always AT OR BEFORE the moment
   * given: every seek here is the start of a line, and landing after it clips
   * the first word off the line it was meant to repeat.
   *
   * A page that says nothing is written to as before, and the write is read
   * straight back to see whether it took. Setting `currentTime` moves the
   * official playback position immediately, so an element that can go there
   * says so on the next line and one that cannot reports where it stayed. That
   * read-back is the only test that works on every player: `seekable` cannot
   * tell a stream still arriving from a short file, which is why nothing here
   * asks it. */
  const SEEK_MISS_S = 1;

  function seekFilm(filmMs, { how = "", tell = false } = {}) {
    const video = state.video;
    if (!video) return false;
    const fromMs = Math.round(streamNowMs(video));
    const toMs = Math.max(0, Math.round(filmMs));

    if (video.dataset?.ssoSeek === "film") {
      video.dataset.ssoSeekTo = (toMs / 1000).toFixed(3);
      video.dispatchEvent(new Event("sso:seek", { bubbles: true }));
      trace("seek", { how, asked: "page", fromMs, toMs });
      return true;
    }

    const target = elementSeconds(toMs, video);
    video.currentTime = target;
    const took = Math.abs(video.currentTime - target) <= SEEK_MISS_S;
    /* A landing is only worth a line in the log when somebody asked for it or
     * when it did not happen. Stopping at the end of every line seeks once per
     * line, and a record of that is a record of the film playing. */
    if (!took || how !== "stop") {
      trace("seek", { how, asked: "element", fromMs, toMs, landedMs: Math.round(streamNowMs(video)), took });
    }
    if (!took && tell) showToast("This player will not jump - the film stayed where it was");
    return took;
  }

  /* Long enough to be worth subtitling, or of a length nothing can know.
   *
   * The test is for a SHORT video, not for an unknown one. An ad break, a
   * teaser and a hover preview are short and their length is known; a live
   * stream and a file being repackaged as it is sent have no length to test,
   * and are judged on size like everything else here. Testing a growing
   * duration against sixty seconds rejects the film for the first minute of
   * every playback - which is the minute somebody is getting their subtitles
   * up, and was reported as "the subtitle overlay is not shown in this page". */
  function longEnough(video) {
    const known = filmSeconds(video);
    if (known !== null) return known >= MIN_VIDEO_SECONDS;
    // NaN with nothing loaded is not "no length", it is "no video yet".
    return video.readyState >= HAVE_METADATA;
  }

  /* Big enough to be somebody's player rather than a decoration. Named because
   * two things ask it and they have to ask it the same way. */
  const playerSized = (video) => {
    const box = video.getBoundingClientRect();
    return box.width > 200 && box.height > 100;
  };

  /* Whether the last walk saw a player at all, set by the walk rather than
   * measured again. videoComing needs the same rectangles pickVideo is already
   * taking, and a second pass over every <video> is a second set of forced
   * layouts - which is the cost the cache below exists to avoid. */
  let sawPlayer = false;

  function pickVideo() {
    let player = false;
    const candidates = Array.from(document.querySelectorAll("video")).filter((video) => {
      noticeLength(video);
      if (!playerSized(video)) return false;
      player = true;
      return longEnough(video);
    });
    sawPlayer = player;
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

  /* Through the cache, because this is asked far more often than the answer
   * changes. It is part of every status round - twenty a second while a film
   * plays, and more while a map is being dragged, since each pointermove
   * writes an offset and every write notifies - and each uncached call walks
   * every <video> on the page and measures it, which is a forced layout apiece.
   * The cache exists for exactly this and was simply not used here: measured on
   * the catalogue app, 134 getBoundingClientRects inside sixty offset writes. */
  const hasPlayableVideo = () => pickVideoCached() !== null;

  /* A film that has not arrived yet, told apart from a page with no film.
   *
   * `hasVideo` is false for both and the worker has to treat them differently:
   * one is worth waiting a few seconds for, the other is worth refusing at
   * once. The difference is the LENGTH test, not the size one - on a stream
   * produced as it is sent, the element is already there and already the right
   * size, and only the part of the film that has arrived is too short to be
   * worth subtitling.
   *
   * Reported as "it fails to find subtitles, and even video for a while - I
   * need to try multiple times". Measured on the catalogue app, the same file
   * on the same machine: the element became playable 409ms after play on one
   * run and had still not after five seconds on the next, because it depends
   * on how fast ffmpeg fills the first fragments. Nothing that reads that once
   * and gives up is deciding by anything but luck. */
  const videoComing = () => {
    pickVideoCached();
    return sawPlayer;
  };

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
  /* Kept as one range so the two readings of a year cannot drift apart.
   * `subtitles/titles.js` holds the same one for the search side. */
  const YEAR_RANGE = "(?:19[0-9]{2}|20[0-4][0-9])";
  const ANY_YEAR = new RegExp(`\\b(${YEAR_RANGE})\\b`);
  // JavaScript has lookbehind, so titles.js's dotted-scene-release form ports.
  const TITLE_YEAR = new RegExp(
    `[([]\\s*(${YEAR_RANGE})\\s*[)\\]]|(?<=\\.)(${YEAR_RANGE})(?=\\.)`,
  );

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
      const match = String(value || "").match(ANY_YEAR);
      if (match && year === null) year = Number(match[1]);
    };

    /* ...but a number in a TITLE is not a year.
     *
     * `subtitles/titles.js` already carries the rule and the same example - "a
     * bare trailing number is left alone, because Blade Runner 2049 is a real
     * title" - and this scrape did not, so a page with no structured date
     * reported 2049. The year goes to the search as a hard filter, so that is
     * nothing found for a film that has subtitles in every language.
     *
     * A year printed beside a title is bracketed, or dotted in a scene release
     * name. The bare chip Prime and Netflix render near the heading is read
     * further down, where bare IS the signal rather than part of the name. */
    const noteTitleYear = (value) => {
      const match = String(value || "").match(TITLE_YEAR);
      if (match && year === null) year = Number(match[1] ?? match[2]);
    };

    /* schema.org is the standard way a page says what it is showing, and until
     * now only a third of it was read - the name, and the series' name. The
     * rest of the vocabulary is the part that matters for finding a subtitle.
     *
     * Reported on a local catalogue app: the page is an episode called
     * "Baggage", every visible title says "Baggage", and the search went out as
     * that word. What OpenSubtitles needs is "The Americans" with a season and
     * an episode number - and the page had all three in its metadata, in the
     * properties nothing here was reading.
     *
     * `episodeNumber` and `partOfSeason.seasonNumber` are read as NUMBERS
     * rather than scraped out of a string, so a page that states them is not
     * competing with `matchEpisode` against a title that happens to contain a
     * digit. Nothing about this is specific to any one site: it is the
     * vocabulary Google, IMDb and every SEO plugin already emit. */
    let fromMetadata = null;
    const video = state.video?.isConnected ? state.video : pickVideo();
    const inPlayer = episodeInPlayer(video);
    /* Other names for the same programme, and a link to what it IS.
     *
     * A film has one title per country, and each subtitle upload carries
     * whichever one the uploader typed - so searching the English name of a
     * film for a Turkish subtitle finds a fraction of what is there. Reported
     * as exactly that. schema.org already has the words for both halves of the
     * answer and neither was being read: `alternateName` is the vocabulary
     * term for "also called", and `sameAs` is how a page links to the thing's
     * entry somewhere authoritative - which for a film is usually IMDb.
     *
     * An id is the better of the two by a distance, because it ends the
     * question: search by it and the language of the title stops mattering.
     * The names are the fallback for a page that has no id to give. Both are
     * standard vocabulary rather than anything this extension invented, so a
     * player that already emits schema.org for search engines is emitting
     * them today. */
    const altTitles = [];
    let statedImdb = "";
    const noteAlso = (value) => {
      for (const one of Array.isArray(value) ? value : [value]) {
        const text = String(one ?? "").trim();
        if (text && text.length <= 120 && !altTitles.includes(text)) altTitles.push(text);
      }
    };
    const noteImdb = (value) => {
      for (const one of Array.isArray(value) ? value : [value]) {
        const found = IMDB_LINK.exec(String(one ?? ""));
        if (found && !statedImdb) statedImdb = found[1];
      }
    };
    for (const item of readJsonLd()) {
      if (!SCHEMA_VIDEO_TYPE.test(schemaType(item))) continue;
      push(item.name, "json-ld");
      if (item.partOfSeries?.name) push(item.partOfSeries.name, "json-ld-series");
      noteYear(item.datePublished || item.dateCreated || item.copyrightYear);
      noteAlso(item.alternateName);
      noteAlso(item.partOfSeries?.alternateName);
      /* A series' id, not the episode's, when both are stated - the episode's
       * is the more precise answer and `announced` already carries it. Taken
       * from the series only when the episode offers none, which is the shape
       * a catalogue page usually has. */
      noteImdb(item.sameAs);
      noteImdb(item.partOfSeries?.sameAs);
      if (!fromMetadata) fromMetadata = statedEpisode(item);
    }

    /* What the page tells the BROWSER it is playing - the same statement that
     * fills the OS media controls and Chrome's media hub. It is a W3C standard
     * (Media Session), every large video site sets it, and an isolated world
     * can read it: measured in Chrome with the extension loaded, a page-world
     * `new MediaMetadata({title, artist, album})` comes back through
     * `chrome.scripting.executeScript` intact.
     *
     * Which field carries what is NOT standardised, and that is why all three
     * are offered rather than one being trusted: a video site puts the channel
     * in `artist`, a series site puts the show there. The choosing already
     * handles that, including `matchEpisode` over each - which is how a site
     * writing "S03E02" into any of the three contributes the episode without
     * anything here having to know which field it used.
     *
     * `title` outranks the other two because it is the one field whose meaning
     * is consistent: what is playing. Both rank below schema.org, which is
     * typed, and above a scraped heading, which is not a statement at all. */
    const playing = navigator.mediaSession?.metadata;
    if (playing) {
      push(playing.title, "mediaSession.title");
      push(playing.artist, "mediaSession.artist");
      push(playing.album, "mediaSession.album");
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
    for (const candidate of candidates) noteTitleYear(candidate.text);
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
      /* Beside the candidates rather than among them. They are not competing
       * guesses at the one right title - they are the same programme's other
       * names, and every one of them is a second way into an index that holds
       * only one. */
      altTitles,
      statedImdb,
      url: location.href,
      isTopFrame: window === window.top,
      /* Reported beside the candidates rather than instead of them, so a frame
       * that announces and a frame that does not are the same message and the
       * worker decides. A page that announces still contributes its guesses:
       * the log keeps them, which is how "it announced the wrong thing" can be
       * told apart from "it announced nothing". */
      announced: announcedProgramme(video),
      episode: {
        fromMetadata,
        fromPlayer: inPlayer,
        fromTitle: matchEpisode(document.title),
        fromMarker: selectedEpisodeOnPage(),
        fromUrl: matchEpisode(decodeURIComponent(location.pathname + location.search)),
      },
      /* Evidence, not a source. Kept only when the player said something and
       * none of it named an episode - the case where the next step is to read
       * what it did say. */
      playerText: video && !inPlayer ? playerTextSample(video) : [],
    };
  }

  const SCHEMA_VIDEO_TYPE = /^(Movie|TVEpisode|TVSeries|VideoObject|CreativeWork)$/i;

  /* An IMDb title id inside a link. `sameAs` is a URL, and this is the only
   * part of it worth keeping. */
  const IMDB_LINK = /imdb\.com\/title\/(tt\d+)/i;

  /* `@type` is a string or a list of them, and both are valid JSON-LD. */
  function schemaType(item) {
    const type = item?.["@type"];
    return String(Array.isArray(type) ? type.find((one) => SCHEMA_VIDEO_TYPE.test(one)) || type[0] : type || "");
  }

  /* The season and episode the page states, or null.
   *
   * `partOfSeason.seasonNumber` is where the vocabulary puts it; `seasonNumber`
   * directly on the episode is common enough in the wild to be worth reading,
   * and both are sometimes strings. A season with no episode number is not an
   * answer - it would send a search for a whole season - so both are required.
   */
  function statedEpisode(item) {
    const season = statedNumber(item.partOfSeason?.seasonNumber ?? item.seasonNumber);
    const episode = statedNumber(item.episodeNumber);
    if (season === null || episode === null) return null;
    return { season, episode, matched: "schema.org episodeNumber" };
  }

  /* A field that is present and empty has not been stated.
   *
   * `Number("")` is 0, and a site generator emitting the whole vocabulary with
   * empty strings where it has no value is the ordinary output of every SEO
   * plugin - so the page reads as episode zero of season zero. A stated
   * episode outranks one scraped out of a title or an address, so that
   * invented pair beats the real one and the search goes out for something
   * that does not exist. Digits or nothing; season zero is a real season, so
   * the value is checked and not merely its truthiness. */
  function statedNumber(value) {
    if (typeof value === "number") return Number.isInteger(value) && value >= 0 ? value : null;
    return typeof value === "string" && /^\d+$/.test(value.trim()) ? Number(value.trim()) : null;
  }

  function readJsonLd() {
    const found = [];
    for (const node of document.querySelectorAll('script[type="application/ld+json"]')) {
      try {
        const parsed = JSON.parse(node.textContent || "{}");
        /* `@graph` is how a page ships several things in one block, and it is
         * what most site generators emit - a document that only reads the top
         * level sees a `WebPage` and nothing else. */
        for (const one of Array.isArray(parsed) ? parsed : [parsed]) {
          found.push(one);
          if (Array.isArray(one?.["@graph"])) found.push(...one["@graph"]);
        }
      } catch {
        // Sites ship malformed JSON-LD routinely; skip it.
      }
    }
    return found;
  }

  // --- what the page's own player was given ----------------------------------

  /* The subtitles the page carries for itself.
   *
   * A streaming player is handed every language the title has, as files timed
   * to its own picture, and draws one of them. Those files answer both of the
   * questions the rest of this extension spends its effort on - WHICH episode
   * is this, and WHERE do the lines sit against the film - by construction,
   * because the same server handed out the stream. So where they can be had
   * they come first, and the search over OpenSubtitles is for what the page
   * does not carry.
   *
   * They arrive by postMessage from `src/sites/<site>.js`, which runs in the
   * page's own world and overhears the player's request; see that file for
   * why nothing on this side of the boundary can. The URLs are signed and
   * short-lived and are kept here and nowhere else: the worker asks for the
   * list by message when it fetches one, `status()` carries a summary without
   * them, and the running log gets the languages and the shape of the answer.
   * That shape is the evidence this feature is waiting on, so it is written on
   * every new title rather than once. */
  const PAGE_SUBTITLE_SOURCE = "sso-ear";
  let pageSubtitles = null;

  function siteName() {
    const host = location.hostname;
    if (/(^|\.)primevideo\.com$/.test(host) || /(^|\.)amazon\./.test(host)) return "Prime Video";
    if (/(^|\.)netflix\.com$/.test(host)) return "Netflix";
    if (/(^|\.)disneyplus\.com$/.test(host)) return "Disney+";
    if (/(^|\.)youtube\.com$/.test(host)) return "YouTube";
    if (/(^|\.)tabii\.com$/.test(host)) return "tabii";
    return host.replace(/^www\./, "");
  }

  /* A track's kind, from the two fields that might say. Forced narratives are
   * the lines spoken in another language and nothing else, which is not a
   * subtitle for the film; [CC] and SDH carry the sound descriptions a hearing
   * viewer does not want on screen twice. Both are offered, neither is picked
   * first. The words are each site's: Prime says "sdh" in the type, Netflix
   * "closedcaptions", Disney+ "describes-music-and-sound" in the rendition's
   * characteristics, and all three put "[CC]" in the name. */
  function trackKind(track) {
    if (track.forced) return "forced";
    if (/sdh|hearing|closedcaptions|describes-music-and-sound|caption|\bcc\b|\[cc\]/i.test(`${track.type} ${track.displayName}`)) return "sdh";
    if (/\basr\b|auto-generated|automatic/i.test(`${track.type} ${track.displayName}`)) return "auto";
    return "subtitle";
  }

  function onPageSubtitles(event) {
    if (event.source !== window || event.origin !== location.origin) return;
    const data = event.data;
    if (!data || data.source !== PAGE_SUBTITLE_SOURCE) return;
    const site = siteName();
    if (data.type === "survey") {
      /* src/sites/survey.js: the shape of what the player did, for the log
       * and nothing else. See that file for what is and is not in it. */
      trace("survey", {
        site,
        entries: Array.isArray(data.entries) ? data.entries.slice(0, 400) : [],
        page: data.page && typeof data.page === "object" ? data.page : {},
        totals: data.totals && typeof data.totals === "object" ? data.totals : {},
      });
      return;
    }
    if (data.type !== "tracks") return;
    const titleId = String(data.titleId || "");
    const tracks = (Array.isArray(data.tracks) ? data.tracks : [])
      .filter((track) => track && typeof track.url === "string" && track.url)
      .map((track) => {
        const code = String(track.language || "").toLowerCase();
        const kind = trackKind(track);
        return {
          /* The id everything else keys on - the offset store, the card, the
           * worker's fetch. A string where OpenSubtitles ids are numbers, and
           * the prefix is what the worker tests for. */
          id: `page:${titleId}:${code}:${kind}`,
          language: code.split(/[-_]/)[0],
          code,
          kind,
          displayName: String(track.displayName || ""),
          /* How the worker should read the file: "ttml" (Prime, Netflix),
           * "vtt", or "hls-vtt" for a playlist of segments (Disney+). */
          format: String(track.format || "ttml"),
          url: track.url,
          /* For a DASH manifest, which text track in it. */
          ...(track.dash && typeof track.dash === "object" ? { dash: { representation: String(track.dash.representation ?? ""), adaptation: String(track.dash.adaptation ?? "") } } : {}),
          /* Read off the browser's own text track: nothing to fetch. */
          ...(Array.isArray(track.cues) ? { cues: track.cues } : {}),
        };
      });
    const changed = pageSubtitles?.titleId !== titleId || pageSubtitles?.tracks.length !== tracks.length;
    pageSubtitles = { site, titleId, tracks, at: Date.now() };
    if (!changed) return;
    let hosts = [];
    try {
      hosts = [...new Set(tracks.map((track) => new URL(track.url).hostname))];
    } catch {
      // A URL the player could fetch parses; a stray one is not worth a line.
    }
    trace("pageSubtitles", {
      site,
      titleId,
      tracks: tracks.map((track) => ({ code: track.code, kind: track.kind, displayName: track.displayName, format: track.format })),
      hosts,
      keys: data.tracks?.[0]?.keys ?? [],
      formats: data.tracks?.[0]?.formats ?? [],
      shape: data.shape ?? [],
    });
    notify();
  }

  /* Without the URLs, for the panel and the mirror. */
  function pageSubtitleSummary() {
    if (!pageSubtitles) return null;
    return {
      site: pageSubtitles.site,
      titleId: pageSubtitles.titleId,
      tracks: pageSubtitles.tracks.map(({ url, cues, ...rest }) => (cues ? { ...rest, cueCount: cues.length } : rest)),
    };
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
  /* The picture, which is what every stored position is a fraction of.
   *
   * Reported: leave fullscreen and the subtitles stay where the fullscreen
   * picture had them, hanging in the page beside a player a third of the
   * size; and in a window they could be dragged off the film onto the page
   * around it. Both are one fact - the percentages were of the VIEWPORT, and
   * the viewport and the picture only agree in fullscreen. So a position is
   * now a fraction of the video element's box, and is written as pixels from
   * that box each time the box is known to have moved: a resize, a fullscreen
   * change, the video's own ResizeObserver, and a scroll, which is the one
   * that moves an inline player without touching anything else.
   *
   * With no picture to speak of - before a video is picked, or one collapsed
   * while loading - the window stands in, which is what the percentages
   * always meant. Measured once per apply rather than once per box: the box
   * is read with getBoundingClientRect, which is a forced layout. */
  let pictureBox = null;

  function measurePicture() {
    const box = state.video?.getBoundingClientRect();
    /* The host's scale is measured here with the box rather than at every
     * write, for the same reason the box is: eight writes per apply, each a
     * layout, on an apply that runs behind every scroll frame. */
    const scale = hostScale();
    pictureBox =
      box && box.width >= 40 && box.height >= 40
        ? { left: box.left, top: box.top, width: box.width, height: box.height, scale }
        : { left: 0, top: 0, width: window.innerWidth, height: window.innerHeight, scale };
    return pictureBox;
  }

  function pictureFrame() {
    return pictureBox || measurePicture();
  }

  function writePosition(root, x, y) {
    const frame = pictureFrame();
    /* Divided by the host's scale for the reason the font size is: inside a
     * fullscreen element the page has scaled, a pixel written is not a pixel
     * drawn. The video's box is measured in drawn pixels. */
    const { scale } = frame;
    root.style.setProperty("--sso-x", `${((frame.left + (frame.width * x) / 100) / scale).toFixed(2)}px`);
    root.style.setProperty("--sso-y", `${((frame.top + (frame.height * y) / 100) / scale).toFixed(2)}px`);
  }

  function writeWidth(root, percent) {
    const frame = pictureFrame();
    root.style.setProperty("--sso-width", `${((frame.width * percent) / 100 / frame.scale).toFixed(2)}px`);
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
    // So a subtitle can be lined up with this window, and this window with the
    // next one. See guidesFor.
    movableHosts.add(host);

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
      // After the probe has put the host back, so the lines are measured
      // against where everything actually is.
      openGuides(host);
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
      const onScreenX = (value) => clamp(value, 0, Math.max(0, window.innerWidth - box.width));
      const onScreenY = (value) => clamp(value, 0, Math.max(0, window.innerHeight - handleHeight));
      let left = onScreenX(event.clientX - origin.grabX);
      let top = onScreenY(event.clientY - origin.grabY);

      /* Held to the same lines the subtitle boxes are held to, and let go by
       * the same key. A window is placed against the picture and against the
       * boxes standing on it, so there was never a reason for it to be the one
       * surface that could not be lined up with anything - it only missed out
       * because it drags through here instead of through beginDrag. */
      let atX = null;
      let atY = null;
      if (!event.altKey) {
        const hitX = guideNear([left, left + box.width / 2, left + box.width], "x");
        const hitY = guideNear([top, top + box.height / 2, top + box.height], "y");
        if (hitX) { left += hitX.delta; atX = hitX.at; }
        if (hitY) { top += hitY.delta; atY = hitY.at; }
        // A snap that would put it out of reach is not one, and a line drawn
        // for a move that did not happen is worse than no line at all.
        if (onScreenX(left) !== left) { left = onScreenX(left); atX = null; }
        if (onScreenY(top) !== top) { top = onScreenY(top); atY = null; }
      }
      showGuides(atX, atY);

      const local = origin.map.toLocal(left, top);
      place(local.x, local.y);
      onMove?.();
    });

    const end = (event) => {
      if (!origin) return;
      origin = null;
      closeGuides();
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
  function nodePath(node) {
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
  /* The episode written inside the player itself.
   *
   * Reported on Prime Video, watching Monk: the film plays in place on the
   * series page, so the address and the tab title never change, and while the
   * video was live the page offered exactly two strings - h1 "Monk" and title
   * "Prime Video: Monk". No mediaSession, no schema.org, no Open Graph.
   * Measured on four snapshots with the video playing. Every episode source
   * above came back null and the viewer picked S01E01, S01E02, S01E03 by hand.
   *
   * What a player DOES render is its own overlay: the name of the thing it is
   * playing, in its own chrome, beside its own controls. That text names one
   * episode - the one on screen - and it carries no "selected" class, because
   * it is not a choice among several. selectedEpisodeOnPage requires that
   * evidence and so skips the one element on the page that is the answer.
   *
   * So this reads text INSIDE the video's own container and nothing outside
   * it. The episode list on a series page says "S1 E1" fifteen times and lives
   * outside the player; the overlay says it once and lives inside. The walk
   * up from the <video> stops at the first ancestor much larger than the video
   * - the player's wrapper is the video's size, the page is not - so the list
   * below the fold is never read. No class names: the same rule finds the
   * overlay on a player nobody has looked at. */
  const PLAYER_GROWTH_LIMIT = 1.6;
  const PLAYER_ANCESTOR_LIMIT = 8;
  const PLAYER_TEXT_NODES = 2000;

  function playerContainer(video) {
    if (!video?.isConnected) return null;
    const box = video.getBoundingClientRect();
    const area = box.width * box.height;
    if (!area) return null;
    let widest = null;
    let cursor = video.parentElement;
    for (let depth = 0; cursor && depth < PLAYER_ANCESTOR_LIMIT; depth++, cursor = cursor.parentElement) {
      const rect = cursor.getBoundingClientRect();
      if (rect.width * rect.height > area * PLAYER_GROWTH_LIMIT) break;
      widest = cursor;
    }
    return widest;
  }

  /* Short text nodes under the player, in document order. Bounded, because
   * this runs inside every page snapshot and a player's chrome is a few dozen
   * strings; two thousand nodes is a page, not a player. */
  function playerStrings(container) {
    const out = [];
    if (!container) return out;
    const walker = document.createTreeWalker(container, NodeFilter.SHOW_TEXT);
    let scanned = 0;
    for (let node = walker.nextNode(); node && scanned < PLAYER_TEXT_NODES; node = walker.nextNode()) {
      scanned++;
      const text = String(node.nodeValue || "").replace(/\s+/g, " ").trim();
      if (!text || text.length > 120) continue;
      out.push({ text, node });
    }
    return out;
  }

  function episodeInPlayer(video) {
    for (const { text, node } of playerStrings(playerContainer(video))) {
      const match = matchEpisode(text);
      if (match) return { ...match, text: text.slice(0, 80), path: nodePath(node.parentElement) };
    }
    return null;
  }

  /* What the player's chrome said, for the log, when nothing in it matched.
   *
   * A page nobody has seen is the case this exists for: if the overlay writes
   * the episode in a notation matchEpisode does not know, the next thing to
   * do is read what it wrote, and that is only possible if it was kept. A
   * handful of distinct strings, not the whole subtree. */
  function playerTextSample(video, limit = 12) {
    const seen = new Set();
    const sample = [];
    for (const { text } of playerStrings(playerContainer(video))) {
      if (seen.has(text)) continue;
      seen.add(text);
      sample.push(text.slice(0, 80));
      if (sample.length >= limit) break;
    }
    return sample;
  }

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
        path: nodePath(node),
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
      duration: Math.round(filmSeconds(video) ?? 0) || null,
      currentTime: Math.round(streamNowMs(video) / 1000),
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
      /* Which half of a split page this frame is. "chrome" on a frame with no
       * video is not a fault - it is the arrangement working. */
      frameRole: role,
      videoFrameId,
      /* Which element this document has fullscreen, if any. A whole class of
       * "nothing works in fullscreen" is decided by this one line, and it was
       * not in the report while that bug was being chased: the answer differs
       * per frame, and the interesting case is the frame that says IFRAME. */
      fullscreen: describeNode(document.fullscreenElement || document.webkitFullscreenElement),
      /* Built and parented are different questions, and the gap between them
       * is invisible from every other field here: a host that was created and
       * never appended reports no surfaces at all, which reads identically to
       * never having been built - and the two have completely different
       * causes. */
      overlay: {
        built: Boolean(host),
        inDocument: Boolean(host?.isConnected),
        parent: describeNode(host?.parentElement),
        views: views.length,
      },

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
      const stored = await readStored(SETTINGS_KEY);
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
    writeStored({ [SETTINGS_KEY]: state.settings });
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
  const ARRANGEMENTS = {
    side: SIDE_BY_SIDE,
    stacked: STACKED,
    left: LEFT_EDGE,
    right: RIGHT_EDGE,
  };

  /* Every arrangement writes `align`, including the two that want it centred.
   * Without that, going from Left back to Side by side would leave both boxes
   * still ranged left - the geometry would move and the text would not, which
   * looks like the button half worked. An arrangement is a complete statement
   * about where the subtitles are, not a patch on top of the last one. */
  function arrange(name) {
    const preset = ARRANGEMENTS[name] || SIDE_BY_SIDE;
    updateSettings({
      tracks: preset.map((geometry) => ({ align: "center", ...geometry, placed: true })),
    });
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
    const { scale } = measurePicture();
    const picture = pictureHeight();

    views.forEach((view, slot) => {
      const track = state.settings.tracks[slot];
      const { root } = view;
      const fontPx = (picture * TEXT_FRACTION_OF_PICTURE * track.fontScale) / scale;
      root.style.setProperty("--sso-font-size", `${fontPx.toFixed(2)}px`);
      // A track with its own backdrop overrides the shared one; null is what
      // every installation that predates per-track styling has.
      const alpha = track.backdrop == null ? background : track.backdrop;
      root.style.setProperty("--sso-bg", `rgba(0, 0, 0, ${alpha})`);
      /* Both, because the box and the lines inside it are two different
       * questions. `justify-content` puts the CUE against an edge of the box
       * when the cue is narrower than the box; `text-align` puts each LINE
       * against an edge of the cue when a cue has two lines of different
       * lengths. A subtitle ranged left needs both or it still wanders. */
      const align = track.align === "left" || track.align === "right" ? track.align : "center";
      root.style.setProperty("--sso-align", align);
      root.style.setProperty(
        "--sso-justify",
        align === "center" ? "center" : align === "left" ? "flex-start" : "flex-end",
      );
      writePosition(root, track.posX, track.posY);
      writeWidth(root, track.widthPercent);
      root.style.setProperty("--sso-color", track.color || DEFAULT_TRACK.color);
      root.style.setProperty("--sso-family", FONTS[track.font] || FONTS.sans);
      root.style.setProperty("--sso-weight", String(track.weight ?? DEFAULT_TRACK.weight));
      root.style.setProperty("--sso-outline", outlineShadow(track.outline));
      root.dataset.dim = dimNonSpeech ? "true" : "false";
      // Once placed by hand, a cue's own {\an8} no longer moves it.
      root.dataset.placed = track.placed ? "manual" : "auto";

      /* The strip carries the same font size, colour and backdrop as the
       * subtitle it belongs to, scaled down by the stylesheet. That is what
       * makes two strips tellable apart at a glance without reading either -
       * the same thing the per-track colour does for the subtitles. */
      const { stripRoot, stripTag } = view;
      writePosition(stripRoot, track.stripX, track.stripY);
      writeWidth(stripRoot, track.stripWidth);
      stripRoot.style.setProperty("--sso-font-size", `${fontPx.toFixed(2)}px`);
      stripRoot.style.setProperty("--sso-bg", `rgba(0, 0, 0, ${alpha})`);
      stripRoot.style.setProperty("--sso-color", track.color || DEFAULT_TRACK.color);
      stripRoot.style.setProperty("--sso-family", FONTS[track.font] || FONTS.sans);
      void stripTag;
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
  /* A strip narrower than this holds one word card and a fade, which is a
   * surface that cannot do its job. Lower than the subtitle's floor because a
   * strip does not have to hold a sentence. */
  const MIN_STRIP_PERCENT = 14;
  const MAX_WIDTH_PERCENT = 100;
  /* How close a box has to come to a line before it is taken by it, in screen
   * pixels.
   *
   * Screen pixels rather than a percentage of anything, because the accuracy
   * being compensated for belongs to the hand: the same eight pixels is the
   * same gesture on a 1136px player and on a 2560px one. Eight also leaves the
   * positions between the lines reachable - the two boxes of a stacked pair
   * are 8% of the height apart, which is 45px on a 568px player - so a reader
   * who wants a subtitle a little off centre can still put it there. */
  const SNAP_PX = 8;
  let drag = null;
  // The two hairlines, built with the overlay. See showGuides.
  let guides = null;
  /* The lines for the gesture in progress, and the map that draws them.
   *
   * Held here rather than on `drag` because `drag` is the subtitle boxes' own
   * gesture and the panel and the focus box do not have one - they move through
   * makeMovable, which is a different code path in the same file. One session
   * either way: only one thing is ever being dragged. */
  let guideLines = null;
  let guideMap = null;
  /* Every floating window that can be placed by hand, so the boxes on the film
   * can be lined up with them and they with each other. Filled by makeMovable,
   * never emptied: a host that has been taken off the page is skipped by
   * isConnected, and a registry that three files have to remember to clear is a
   * registry one of them will forget. */
  const movableHosts = new Set();

  /* Either vertical edge of the cue resizes it; the middle moves it. On a box
   * narrower than four edge-widths the two zones would meet in the middle and
   * there would be nowhere left to grab, so a short cue is all middle. */
  /* Which box is being moved, and which settings it writes.
   *
   * The subtitle and its strip are placed the same way and remembered the same
   * way, so they are one gesture parameterised rather than two implementations
   * that will drift. Everything below reads the surface; only the cue's own
   * two special cases - study's claim on a press, and forwarding an unmoved
   * click to the player - stay behind a check on which kind it is. */
  function surfaceOf(slot, kind) {
    const view = views[slot];
    return kind === "strip"
      ? {
          kind, slot, root: view.stripRoot, box: view.stripBox,
          keys: { x: "stripX", y: "stripY", width: "stripWidth", placed: "stripPlaced" },
          minWidth: MIN_STRIP_PERCENT,
        }
      : {
          kind: "cue", slot, root: view.root, box: view.cueBox,
          keys: { x: "posX", y: "posY", width: "widthPercent", placed: "placed" },
          minWidth: MIN_WIDTH_PERCENT,
        };
  }

  function edgeAt(box, clientX) {
    const rect = box.getBoundingClientRect();
    if (rect.width < RESIZE_EDGE_PX * 4) return 0;
    if (clientX - rect.left <= RESIZE_EDGE_PX) return -1;
    if (rect.right - clientX <= RESIZE_EDGE_PX) return 1;
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

    beginDrag(surfaceOf(slot, "cue"), event);
  }

  function onStripPointerDown(slot, event) {
    if (event.button !== 0) return;
    // A press on a word is that word's, not the box's. The strip is still
    // draggable by everything around them, which is most of it.
    if (event.target.closest?.(".sso-trail__word, .sso-strip__close")) return;
    beginDrag(surfaceOf(slot, "strip"), event);
  }

  // --- the lines a box can be held to ---------------------------------------

  /* Placing things by hand is four boxes - two subtitles and two strips - that
   * have to agree with each other and with the picture, and a hand on a 1136px
   * player cannot hit 50.0% twice. Arrangements answer that in one press for
   * the four layouts they know; this answers it for every layout they do not,
   * by offering the positions that mean something and taking the nearest one.
   *
   * What means something is an edge or a middle: of the picture, and of every
   * other box on screen. Every one of a box's own three edges per axis is
   * offered against every one of those, so the pairs nobody would think to
   * name are all in it - my top against their bottom is how a box comes to sit
   * flush under another one, and it is the same rule as my left against their
   * left, not a case anybody had to write down.
   */

  /* The frame, which is up to two rectangles.
   *
   * A 2.39:1 film in a 16:9 player is letterboxed, and the black bar belongs
   * to the element and not to the picture. Both edges are worth offering: over
   * the bar is where some readers want the subtitle and on the picture is
   * where the rest do, and neither is a preference this can settle. `contain`
   * only, because that is the one fit whose geometry this arithmetic
   * describes - a player in a zoom mode is cropping rather than letterboxing,
   * so its element edge already is its picture edge. */
  function pictureRects() {
    const video = state.video;
    const box = video?.getBoundingClientRect();
    if (!box || box.width < 40 || box.height < 40) {
      // Nothing to speak of on screen: the window is the only frame there is.
      return [{ left: 0, top: 0, right: window.innerWidth, bottom: window.innerHeight }];
    }
    const out = [{ left: box.left, top: box.top, right: box.right, bottom: box.bottom }];

    const { videoWidth, videoHeight } = video;
    if (videoWidth > 0 && videoHeight > 0 && getComputedStyle(video).objectFit === "contain") {
      const scale = Math.min(box.width / videoWidth, box.height / videoHeight);
      const width = videoWidth * scale;
      const height = videoHeight * scale;
      const left = box.left + (box.width - width) / 2;
      const top = box.top + (box.height - height) / 2;
      // Within a pixel of the element means there is no letterbox at all, and
      // two lines drawn on top of each other are one line nobody can read.
      if (Math.abs(left - box.left) > 1 || Math.abs(top - box.top) > 1) {
        out.push({ left, top, right: left + width, bottom: top + height });
      }
    }
    return out;
  }

  /* Worked out once, when the gesture starts, and that is what makes it free.
   *
   * Every line here costs a getBoundingClientRect, which is a forced layout,
   * and this runs behind a pointermove that already fires about 240 times a
   * second - see the cost note in CLAUDE.md. Nothing that is not being dragged
   * moves while the drag is on, so there is nothing to recompute. */
  function guidesFor(exclude) {
    const x = [];
    const y = [];
    const offer = (rect) => {
      x.push(rect.left, (rect.left + rect.right) / 2, rect.right);
      y.push(rect.top, (rect.top + rect.bottom) / 2, rect.bottom);
    };
    for (const rect of pictureRects()) offer(rect);

    /* Every other placeable thing, and not only the other subtitles.
     *
     * The four boxes in the overlay and the two windows - the control panel and
     * the focus box - are one set as far as a reader is concerned: they are the
     * things standing on the film. Lining the focus box up with the subtitle
     * under it is the same wish as lining the two subtitles up with each other,
     * and the only reason the windows were left out is that they are built in
     * other files. */
    for (const root of [...views.flatMap((view) => [view.root, view.stripRoot]), ...movableHosts]) {
      if (root === exclude || !root?.isConnected) continue;
      const rect = root.getBoundingClientRect();
      // A box with nothing in it is drawn nowhere, and lining something up
      // with a surface the reader cannot see is a move with no reason.
      if (rect.width < 4 || rect.height < 4) continue;
      offer(rect);
    }
    return { x, y };
  }

  /* The nearest line to any of a box's own edges, or null.
   *
   * All three edges are offered at once and the closest wins, so a box carried
   * near a corner takes whichever alignment the hand is actually closer to
   * rather than whichever this happened to test first. */
  function nearestGuide(anchors, lines) {
    let best = null;
    for (const anchor of anchors) {
      for (const at of lines) {
        const delta = at - anchor;
        if (Math.abs(delta) > SNAP_PX) continue;
        if (!best || Math.abs(delta) < Math.abs(best.delta)) best = { delta, at };
      }
    }
    return best;
  }

  /* Drawn only while a gesture is actually sitting on one.
   *
   * A snap with nothing to see is a box that moved on its own: the hand went
   * one pixel and the box went five, and from the outside that is
   * indistinguishable from the extension being wrong. The line is the answer
   * to "why did it do that", and it is why this is worth two elements.
   *
   * Positions are written as percentages through a map of the lines' own, for
   * the same reason writePosition is: the shadow root sits inside whatever the
   * page has transformed, so a viewport pixel is not a pixel here. Their own,
   * and not the box's, because the box's has the box's translate(-50%, -100%)
   * baked into it - which is the whole point of measuring rather than
   * assuming. Measured with the box's map instead: every line landed 604.8px
   * to the right of the edge it claimed to be, which is exactly half of an
   * 80vw box. */
  function showGuides(atX, atY) {
    if (!guides) return;
    const map = guideMap;
    if (atX != null && map) guides.vertical.style.left = `${map.toLocal(atX, 0).x}%`;
    guides.vertical.dataset.on = atX != null && map ? "true" : "false";
    if (atY != null && map) guides.horizontal.style.top = `${map.toLocal(0, atY).y}%`;
    guides.horizontal.dataset.on = atY != null && map ? "true" : "false";
  }

  /* Opened when a gesture starts and closed when it ends.
   *
   * Both halves cost a forced layout, and nothing that is not being dragged
   * moves in between, so once is the right number of times. Answers false when
   * there is nothing to draw with - a frame with no overlay in it - and a
   * caller that cannot draw a line must not snap either: a box that moves five
   * pixels for a hand that moved one, with nothing on screen saying why, is
   * indistinguishable from the extension being wrong. */
  function openGuides(exclude) {
    if (!guides) return false;
    // A window that has been torn down and rebuilt leaves its old host behind.
    // Once per gesture is often enough to sweep them, and it keeps the set the
    // size of what is actually on the page.
    for (const host of movableHosts) if (!host?.isConnected) movableHosts.delete(host);
    /* The lines get a map of their own. They sit in the same shadow root and
     * therefore in the same containing block, so one measurement covers both of
     * them and both axes - and it has to be taken on a line that is on screen,
     * because a hidden element measures zero everywhere. Put back before this
     * returns, so no frame is painted showing it. */
    const line = guides.vertical;
    const shown = line.dataset.on;
    line.dataset.on = "true";
    guideMap = measurePlacement(line, (x, y) => {
      line.style.left = `${x}%`;
      line.style.top = `${y}%`;
    });
    // The stylesheet owns the other end of each line; only the axis it is drawn
    // on is written from here.
    line.style.top = "";
    line.dataset.on = shown;
    // Last, after the map has been measured and the line put back where the
    // probe found it, so nothing here reads a box that is mid-measurement.
    guideLines = guidesFor(exclude);
    return true;
  }

  function closeGuides() {
    showGuides(null, null);
    guideLines = null;
    guideMap = null;
  }

  /** The nearest line to any of these anchors on one axis, or null. */
  function guideNear(anchors, axis) {
    return guideLines ? nearestGuide(anchors, guideLines[axis]) : null;
  }

  function beginDrag(surface, event) {
    drag = {
      surface,
      slot: surface.slot,
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      moved: false,
      sizing: edgeAt(surface.box, event.clientX) !== 0,
    };
    surface.box.setPointerCapture(event.pointerId);
  }

  function onStripPointerMove(slot, event) {
    if (drag && event.pointerId === drag.pointerId && event.buttons === 0) {
      onSurfacePointerUp(event);
      return;
    }
    if (!drag) {
      const surface = surfaceOf(slot, "strip");
      surface.box.style.cursor = edgeAt(surface.box, event.clientX) ? "ew-resize" : "";
      return;
    }
    if (event.pointerId !== drag.pointerId) return;
    onDragMove(event);
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
        views[slot].cueBox.style.cursor = edgeAt(views[slot].cueBox, event.clientX) ? "ew-resize" : "";
      }
      return;
    }

    onDragMove(event);
  }

  function onDragMove(event) {
    /* A press is not a gesture until it has moved far enough to be one, and
     * everything the gesture needs is solved once, there. Both surfaces come
     * through here, so neither can forget it - the strip's own handler did, and
     * the first move read a map that had never been measured. */
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

    /* Keep the box on the picture. The bound is a fact about the screen, so
     * it is applied in screen pixels and converted afterwards - clamping the
     * written percentage instead would assume those percentages span the
     * picture exactly, which is the assumption `drag.map` exists to stop
     * making.
     *
     * The picture and not the window: in a window the film is a box on a page,
     * and a subtitle dragged onto the page around it is a subtitle that will
     * be somewhere else again in fullscreen. With no picture the window is the
     * picture, as everywhere else.
     *
     * Everything here is the box's top-left corner, because that is what the
     * map reports; the bottom-centre anchor the CSS uses differs from it by a
     * transform the map has already absorbed. */
    const box = drag.surface.root.getBoundingClientRect();
    const frame = pictureFrame();
    const onScreenX = (value) =>
      clamp(value, frame.left, Math.max(frame.left, frame.left + frame.width - box.width));
    const onScreenY = (value) =>
      clamp(value, frame.top, Math.max(frame.top, frame.top + frame.height - box.height));
    let x = onScreenX(event.clientX - drag.grabX);
    let y = onScreenY(event.clientY - drag.grabY);

    /* Held to the lines, unless the reader says otherwise.
     *
     * Alt is read on every move rather than once when the gesture starts, so
     * "no, exactly there" is a thing that can be decided halfway through a
     * drag - which is when a reader finds out they need it. */
    let atX = null;
    let atY = null;
    if (!event.altKey) {
      const hitX = guideNear([x, x + box.width / 2, x + box.width], "x");
      const hitY = guideNear([y, y + box.height / 2, y + box.height], "y");
      if (hitX) { x += hitX.delta; atX = hitX.at; }
      if (hitY) { y += hitY.delta; atY = hitY.at; }
      /* A snap that would put the box off the screen is not one. Staying
       * reachable is a fact about the screen and it wins; drawing a line the
       * box did not actually go to would be the extension explaining a move
       * it did not make. */
      if (onScreenX(x) !== x) { x = onScreenX(x); atX = null; }
      if (onScreenY(y) !== y) { y = onScreenY(y); atY = null; }
    }
    showGuides(atX, atY);

    const local = drag.map.toLocal(x, y);

    updateTrackSettings(drag.slot, {
      [drag.surface.keys.x]: round1(local.x),
      [drag.surface.keys.y]: round1(local.y),
      [drag.surface.keys.placed]: true,
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
    const { root, keys } = drag.surface;
    const track = state.settings.tracks[drag.slot];

    root.dataset[drag.sizing ? "sizing" : "dragging"] = "true";

    drag.map = measurePlacement(root, (x, y) => writePosition(root, x, y));
    writePosition(root, track[keys.x], track[keys.y]);

    /* Measured from the press, not from the move that crossed the threshold.
     * The offset is "where inside the box the user took hold of it", which the
     * press is the only event that knows: taking it from the first move folds
     * that whole move into the offset and the box never catches up. */
    const corner = drag.map.toViewport(track[keys.x], track[keys.y]);
    drag.grabX = drag.startX - corner.x;
    drag.grabY = drag.startY - corner.y;

    // Fixed for the gesture: the box grows about its centre, and reading the
    // centre back off a box that is being resized would have it chase itself.
    drag.centreX = corner.x + root.getBoundingClientRect().width / 2;

    // Last, after the box's own map has been measured and the box put back
    // where its probe found it, so nothing here reads a box mid-measurement.
    openGuides(root);
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
    let half = Math.abs(event.clientX - drag.centreX);

    /* The same lines the move is held to, met by whichever edge reaches one
     * first. The box grows about its centre, so an edge taken to a line puts
     * the other edge the same distance the other side of it - which is why the
     * line drawn is the one that was met and not the one under the pointer.
     * Only the vertical ones: a resize does not move the box's bottom, which
     * is what the horizontal lines are about. */
    let atX = null;
    if (!event.altKey && guideLines) {
      let best = null;
      for (const at of guideLines.x) {
        const delta = Math.abs(at - drag.centreX) - half;
        if (Math.abs(delta) > SNAP_PX) continue;
        if (!best || Math.abs(delta) < Math.abs(best.delta)) best = { delta, at };
      }
      if (best) {
        half = Math.abs(best.at - drag.centreX);
        atX = best.at;
      }
    }

    // Of the picture, like the position it goes with.
    const percent = ((half * 2) / pictureFrame().width) * 100;
    const { keys, minWidth } = drag.surface;
    const held = clamp(percent, minWidth, MAX_WIDTH_PERCENT);
    // A width the box is not allowed to take is not a width it lined up at.
    showGuides(held === percent ? atX : null, null);
    updateTrackSettings(drag.slot, {
      [keys.width]: round1(held),
      [keys.placed]: true,
    });
  }

  // No slot argument: the press decided which box is being dragged, and the
  // pointer is captured, so the release belongs to that box whatever it is over.
  function onCuePointerUp(event) {
    onSurfacePointerUp(event);
  }

  function onSurfacePointerUp(event) {
    if (!drag || event.pointerId !== drag.pointerId) return;
    const { moved, startX, startY, slot, surface } = drag;
    drag = null;
    // Before anything else: the lines answer a gesture, and the gesture is over.
    closeGuides();
    surface.box.releasePointerCapture?.(event.pointerId);
    surface.root.dataset.dragging = "false";
    surface.root.dataset.sizing = "false";

    if (moved || surface.kind !== "cue") return;
    /* Study gets first refusal on the RELEASE as well as on the press.
     *
     * A press on a word cannot be judged when it arrives - it is a tap only if
     * it does not move, and until then the box still has to be draggable by
     * its words, which is most of the box. So claimPointerDown deliberately
     * declines and watches the pointer to its end. Nothing then told this that
     * the press had been consumed, so the tap pinned the word AND was
     * forwarded to the player underneath: measured, one card in the rail and
     * one click delivered, and the film went from playing to paused. Study's
     * own contract says a click on a word pins it and a click anywhere else
     * pauses, and it made the "pause when a word is clicked" setting
     * meaningless - with it off the film paused anyway, and if it was already
     * paused, looking at a word started it. */
    if (window.__ssoStudy?.claimPointerUp?.(slot, event)) return;
    forwardClickBeneath(startX, startY, event);
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
    /* The host takes no pointer at all, so this only ever fires for the handle
     * and for subtitle text that study mode has opted back in - which is exactly
     * what must not reach the player behind it. A press on the CC button was
     * being handled AND then passed on, so the film played or paused under the
     * panel that had just opened. */
    keepPointersInside(host);

    shadow = host.attachShadow({ mode: "open" });
    if (overlaySheet) shadow.adoptedStyleSheets = [overlaySheet];

    views = Array.from({ length: TRACK_COUNT }, (_, slot) => buildView(slot));

    /* Two hairlines, one per axis, built with the overlay and hidden until a
     * drag is being held to one. They paint under both boxes, which is what
     * the z-index in the stylesheet is for - a line drawn over the text it is
     * helping to place would have to be got out of the way to see the result.
     *
     * LAST in the shadow root, and that is not cosmetic: describeSurfaces
     * names a surface after its shadow root's first element child, so putting
     * these first renamed the overlay to "sso-guide" in every diagnostic and
     * every line of the running log. Order here settles nothing about
     * painting; all three are positioned, so the z-index does. */
    const guideLine = (kind) => {
      const node = document.createElement("div");
      node.className = `sso-guide sso-guide--${kind}`;
      node.dataset.on = "false";
      return node;
    };
    guides = { vertical: guideLine("v"), horizontal: guideLine("h") };

    handle = buildHandle();
    shadow.append(
      ...views.flatMap((view) => [view.root, view.stripRoot]),
      handle,
      guides.vertical,
      guides.horizontal,
    );

    applySettings();
    attachToCorrectParent();
  }

  /* Which subtitle each strip belongs to, written where every change to the
   * attached files passes. It cannot live in applySettings with the rest of the
   * strip's appearance: that runs when a SETTING changes, and the language
   * arrives with the file - so a strip built before the second subtitle was
   * attached kept saying "2" with no language after it. */
  function writeStripTags() {
    for (const [slot, view] of (views || []).entries()) {
      if (!view?.stripTag) continue;
      const language = (state.tracks[slot]?.language || "").slice(0, 2).toUpperCase();
      view.stripTag.textContent = language ? `${slot + 1} ${language}` : `${slot + 1}`;
    }
  }

  function buildView(slot) {
    const root = document.createElement("div");
    root.className = "sso-root";
    root.dataset.slot = String(slot);

    const cueBox = document.createElement("div");
    cueBox.className = "sso-cue";
    cueBox.title = "Drag to move the subtitles — hold Alt to place it freely";
    cueBox.addEventListener("pointerdown", (event) => onCuePointerDown(slot, event));
    cueBox.addEventListener("pointermove", (event) => onCuePointerMove(slot, event));
    cueBox.addEventListener("pointerup", onCuePointerUp);
    cueBox.addEventListener("pointercancel", onCuePointerUp);
    root.appendChild(cueBox);

    /* The strip of studied words, in a root of its own.
     *
     * It hung under the cue and moved with it, which made it cheap to build
     * and impossible to put anywhere: "they should have their own places on the
     * screen and Place button (or drag&drop) should allow to relocate/resize
     * them just like the subtitle areas". A root of its own is what makes that
     * true for free - the same position variables, the same drag, the same
     * Place mode, the same reparenting into a fullscreen element.
     *
     * study.js owns what is INSIDE it and content.js owns where it is. That
     * split is the same one the cue box already has, and it is what keeps the
     * strip working when study mode is not loaded at all: an empty box that
     * hides itself. */
    const stripRoot = document.createElement("div");
    stripRoot.className = "sso-strip";
    stripRoot.dataset.slot = String(slot);
    stripRoot.dataset.words = "0";

    const stripBox = document.createElement("div");
    stripBox.className = "sso-strip__box";
    stripBox.title =
      "Drag to move this strip — its edges resize it, and Alt places it freely";
    stripBox.addEventListener("pointerdown", (event) => onStripPointerDown(slot, event));
    stripBox.addEventListener("pointermove", (event) => onStripPointerMove(slot, event));
    stripBox.addEventListener("pointerup", onSurfacePointerUp);
    stripBox.addEventListener("pointercancel", onSurfacePointerUp);

    /* What it is, said on the strip itself. The reader could not tell what the
     * row of words was - "I even didn't understand it is rails" - and a surface
     * that has to be explained is a surface with no label on it. It carries the
     * subtitle's number and language, and it is also the part to take hold of
     * when there are no words in it yet. */
    const stripTag = document.createElement("span");
    stripTag.className = "sso-strip__tag";

    const stripTrack = document.createElement("div");
    stripTrack.className = "sso-strip__track";

    /* The box's furniture is this file's, the way the box is; what pressing it
     * MEANS is study.js's, the way the words are. Same direction as onCue and
     * claimPointerDown, and it keeps the button working when study.js has not
     * loaded - it does nothing, which is correct, because then there is nothing
     * in the strip to put away. */
    const stripClose = document.createElement("button");
    stripClose.type = "button";
    stripClose.className = "sso-strip__close";
    stripClose.textContent = "×";
    stripClose.title = "Stop showing words for this subtitle";
    stripClose.addEventListener("click", (event) => {
      event.stopPropagation();
      window.__ssoStudy?.closeStrip?.(slot);
    });

    stripBox.append(stripTag, stripTrack, stripClose);
    stripRoot.append(stripBox);

    return { root, cueBox, stripRoot, stripBox, stripTag, stripTrack, stripClose };
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
      // toggle() builds the panel on first use, which fetches two stylesheets.
      // Dropping that promise is how the button comes to do nothing silently.
      window.__ssoApi.detached(window.__ssoPanel?.toggle(), "The panel");
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

  /** Out of the top layer, so the node can be parented somewhere and painted. */
  function fromTopLayer(node) {
    if (!node) return;
    try {
      if (node.matches(":popover-open")) node.hidePopover();
      node.removeAttribute("popover");
    } catch {}
  }

  /* Which element our chrome has to live inside, or null when nothing is
   * fullscreen.
   *
   * While a fullscreen session is open the browser hit-tests ONLY inside the
   * fullscreen element's subtree. Painting and hit-testing are different
   * questions and fullscreen answers the second one by subtree, so the top
   * layer - which settles the first - is not enough on its own. Measured in
   * real fullscreen with the <video> fullscreened: the panel is painted above
   * the film exactly as intended, and `document.elementsFromPoint` at the
   * centre of its own close button returns VIDEO and then HTML. The panel is
   * not in the hit-test at all. Out of fullscreen the same probe at the same
   * point returns our host first. Playwright's own actionability check agrees
   * and refuses the click with "video intercepts pointer events".
   *
   * That is both "the fullscreen CC button does nothing" and "I cannot click
   * even the close button of the settings pane, the player takes it as
   * play/pause": the press was never ours to lose.
   *
   * A <video> cannot hold children, which is why re-parenting was abandoned in
   * favour of the top layer. The way out is not to give up on the subtree but
   * to change which element owns it: requesting fullscreen for another element
   * needs no fresh gesture while a session is already open. Measured, switching
   * from the <video> to its parent leaves the picture filling the viewport and
   * makes every surface hit-test first.
   *
   * The switch is attempted once per holder. A request that fails must not
   * become a loop, and fullscreenchange calls straight back into here. */
  let switchingTo = null;

  function fullscreenHolder() {
    const current = document.fullscreenElement || document.webkitFullscreenElement;
    if (!current) {
      switchingTo = null;
      return null;
    }
    if (!CANNOT_HOLD_CHILDREN.test(current.tagName)) {
      switchingTo = null;
      return current;
    }
    /* An <iframe> is the one member of that list this must not act on.
     *
     * The escalation below exists for a <video>, which paints its own frames
     * and nothing else, so a surface appended to it is never seen. An iframe
     * is the opposite: it renders a whole document, and the extension is
     * running inside that document too. Moving the session up to the iframe's
     * parent takes fullscreen away from the frame the site gave it to - and on
     * a page three documents deep, two intermediate frames do it one after the
     * other. Measured on the three-frame vehicle: the top document ended up
     * with BODY as its fullscreen element, elementsFromPoint answered that our
     * panel was topmost, and a real click on its close button did nothing.
     *
     * There is nothing to hold here. The frame with the film draws the
     * controls while it is fullscreen - see reportFrameRole. */
    if (current.tagName === "IFRAME") {
      switchingTo = null;
      return null;
    }
    const holder = current.parentElement;
    if (!holder || switchingTo === holder) return null;
    switchingTo = holder;
    Promise.resolve()
      .then(() => holder.requestFullscreen?.())
      .then(() => attachToCorrectParent({ raise: true, force: true }))
      .catch(() => {});
    return null;
  }

  /* How often a raise is worth repeating.
   *
   * Raising means leaving the top layer and re-entering it - hidePopover then
   * showPopover on every surface - so the browser lays each one out again. It
   * earns that on a fullscreen change, where the fullscreen element has just
   * joined the layer in front of us. It does not earn it on a pointer event,
   * and revealHandle asks for one on every pointermove AND every mousemove,
   * which a moving hand raises about 120 times a second.
   *
   * Measured with two subtitles attached and the panel open, on the nested
   * player vehicle: the whole arrangement ran 20 times a second with the mouse
   * still and 250 with it moving, and moving cost 9 layouts a second on a page
   * with nothing else in it.
   *
   * Fullscreen changes pass `force`, so the case the re-raise exists for is
   * never the case being held back. */
  const RAISE_MS = 250;
  let raisedAt = 0;

  function attachToCorrectParent({ raise = false, force = false } = {}) {
    perf.arranged += 1;
    const holder = fullscreenHolder();
    const now = Date.now();
    /* Placement is still checked on every call - a site that removes our host
     * has to be answered on the next tick, not a quarter second later. Only the
     * re-raise is held back. */
    const raising = force || (raise && now - raisedAt >= RAISE_MS);
    if (raising) raisedAt = now;
    /* The rail first and the panel second, because the top layer paints in the
     * order its entries were shown in and a re-raise re-shows them both.
     *
     * Measured with the panel dragged over the focus box, elementsFromPoint at
     * the box's centre: the panel answered while nothing had moved, and the
     * focus box answered from the first pointer move over the film onwards. So
     * a panel opened on top of the box kept whatever it covered for a moment
     * and lost it as soon as the mouse moved. The z-index in the two files says
     * what this order now says; it settles the fullscreen path, where nothing
     * is in the top layer and stacking falls back to z-index. */
    if (window.__ssoStudy?.reparent) window.__ssoStudy.reparent(holder, { raise: raising });
    if (window.__ssoPanel?.reparent) window.__ssoPanel.reparent(holder, { raise: raising });
    if (!host) return;

    /* No fullscreen: the top layer, which is what keeps these above the chrome
     * a player appends to itself continuously, and needs nothing moved. */
    if (!holder) {
      const home = paintableParent();
      // Back out of whatever we were put inside on the way in, or a surface
      // stays parented to a player container that may clip or transform it.
      if (home && host.parentElement !== home) home.appendChild(host);
      for (const layer of layers) if (home && layer.parentElement !== home) home.appendChild(layer);
      const raised = [host, ...layers].map((node) => toTopLayer(node, { again: raising }));
      if (raised.every(Boolean)) return;
    }

    const parent = holder || paintableParent();
    if (!parent) return;
    // A popover cannot be hit-tested inside a fullscreen subtree it is not part
    // of, and moving a showing popover closes it anyway. Leave the layer first.
    if (holder) for (const node of [host, ...layers]) fromTopLayer(node);
    if (host.parentElement !== parent || (raising && !holder)) parent.appendChild(host);
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

  /* A click on our chrome is not a click on the film.
   *
   * Everything this extension draws is built inside the frame that owns the
   * <video>, which on most players is inside the very element the player has
   * bound its play/pause handler to. So a press on the settings window's close
   * button reached that handler by bubbling, and the film paused instead of the
   * window closing. Reported as "I cannot click even the close button of the
   * settings pane, it is captured by the player as pause/play". The click was
   * not being stolen before it arrived - it arrived, did its job, and then kept
   * going.
   *
   * Stopped at the host and in the BUBBLE phase only. Every document listener
   * this extension has is capture-phase already - players routinely
   * stopPropagation inside the player surface, so bubble was never an option
   * here - which means the panel's dismiss-on-outside-click, the key capture and
   * the handle reveal all still see everything. Checked before this was added,
   * because stopping the wrong phase would break the menus instead.
   *
   * dblclick is in the list for the same reason as click: several players
   * fullscreen on it, and a double click on a window's title bar - which is how
   * this extension's own "put the panel back in the corner" works - was doing
   * both. What this cannot defend against is a page listening in the capture
   * phase itself, which nothing can from inside the subtree. */
  const ESCAPING_EVENTS = [
    "pointerdown", "pointerup", "click", "dblclick",
    "mousedown", "mouseup", "contextmenu",
  ];

  /* Every host this frame has built. What the key guard below asks is "did
   * this keystroke land in something of ours", and the shadow root a field
   * lives in names its host. */
  const HOSTS = new WeakSet();

  function keepPointersInside(node) {
    for (const type of ESCAPING_EVENTS) {
      node.addEventListener(type, (event) => event.stopPropagation());
    }
    HOSTS.add(node);
    return node;
  }

  /* Typing in one of our fields must not reach the player. Reported on Prime
   * Video: a space in the search box paused the film.
   *
   * The panel already stops keydown in the bubble phase, and that was not
   * enough for two reasons that are both ordinary. A player is free to act on
   * keyup, which nothing stopped; and a listener on the document in the
   * CAPTURE phase runs before any listener inside a shadow tree can stop
   * anything, whichever phase that one is in. The one place that runs before
   * a document capture listener is a capture listener on the window, so that is
   * where this stands, and it covers all three key events.
   *
   * Only for a field. Our own bindings in onKeyDown are a document capture
   * listener too and would be silenced by this along with the page's - and
   * they already ignore a field, so nothing of ours is lost. A key pressed
   * with a panel BUTTON focused is left alone here, because that is how a
   * nudge binding reaches onKeyDown while the panel has focus. */
  function onOurField(event) {
    const target = event.composedPath?.()[0] ?? event.target;
    if (!target || !(target.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName || ""))) {
      return false;
    }
    const root = target.getRootNode?.();
    return Boolean(root && root.host && HOSTS.has(root.host));
  }

  function keepTypingInside(event) {
    if (onOurField(event)) event.stopPropagation();
  }

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
    /* Every layer, including the ones that take no pointer themselves.
     *
     * A toast is built with `interactive: false` so an ordinary one never eats
     * a click meant for the film - and then its Undo button opts back in, which
     * is the whole reason a toast can carry an action. Skipping the guard for
     * "non-interactive" layers therefore missed the one control on them that a
     * reader actually presses, and pressing Undo would have paused the film as
     * well as undoing. Found by the check that walks every host rather than the
     * ones I remembered. */
    keepPointersInside(node);
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
    // Which show() is the current one. See the note on show().
    let shows = 0;

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
      writeStored({ [storeKey]: { ...at, ...size } });
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
        const box = root.getBoundingClientRect();
        from = {
          x: event.clientX, y: event.clientY, ...size, left: at.x, top: at.y,
          /* Where the corner is relative to the hand that took hold of it.
           *
           * The grip is a few pixels across and the press lands somewhere
           * inside it, so the corner and the pointer are never at the same
           * point. Snapping the pointer would line the wrong thing up - by
           * however far into the grip the press happened to land, which is a
           * different number every time. */
          offX: (corner.dx < 0 ? box.left : box.right) - event.clientX,
          offY: (corner.dy < 0 ? box.top : box.bottom) - event.clientY,
        };
        openGuides(layer.host);
        grip.setPointerCapture?.(event.pointerId);
        event.stopPropagation();
      });
      grip.addEventListener("pointermove", (event) => {
        if (!from) return;
        if (event.buttons === 0) { from = null; closeGuides(); return; }

        // Held to the lines by the corner being dragged, and only that corner:
        // the other three are not moving, so they have nothing to line up with.
        let pointerX = event.clientX;
        let pointerY = event.clientY;
        let atX = null;
        let atY = null;
        if (!event.altKey) {
          const hitX = guideNear([pointerX + from.offX], "x");
          const hitY = guideNear([pointerY + from.offY], "y");
          if (hitX) { pointerX += hitX.delta; atX = hitX.at; }
          if (hitY) { pointerY += hitY.delta; atY = hitY.at; }
        }

        const wantedWidth = from.width + corner.dx * (pointerX - from.x);
        const wantedHeight = from.height + corner.dy * (pointerY - from.y);
        size.width = wantedWidth;
        size.height = wantedHeight;
        applySize();
        // A size the window is not allowed to take is not a size it lined up
        // at. applySize clamps in place, so this reads the answer, not the ask.
        showGuides(size.width === wantedWidth ? atX : null, size.height === wantedHeight ? atY : null);
        // Dragging a left or top corner moves the window, so the opposite
        // corner stays where it is - which is what makes a corner a corner.
        place(
          corner.dx < 0 ? from.left + (from.width - size.width) : from.left,
          corner.dy < 0 ? from.top + (from.height - size.height) : from.top,
        );
      });
      const stop = () => { if (from) { from = null; closeGuides(); remember(); } };
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
      /* Open from the first line, not from the far side of a storage read.
       *
       * `open` used to be set after `await chrome.storage.local.get`, so
       * isOpen() answered "shut" for the whole round trip - and the buttons
       * that open these windows are toggles that ask isOpen() to decide what a
       * press means. Two presses inside that window both read "shut", both
       * called show(), and both ran the placement. That is the "async
       * programming problems that would cause to create multiple study panes"
       * report: not two hosts, but one window that could not be closed by the
       * control that opened it because the control never saw it open.
       *
       * The generation counter covers the other half: a hide() or a second
       * show() arriving during the read must win over the read's own placement,
       * or a window closed while it was opening comes back on screen. */
      async show(near) {
        const wasOpen = open;
        open = true;
        if (!wasOpen) {
          const generation = ++shows;
          let stored = null;
          try {
            stored = storeKey ? (await readStored(storeKey))[storeKey] : null;
          } catch {
            // Defaults are fine.
          }
          if (generation !== shows || !open) return;
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
    /* Announced, because this is the extension's only voice: "Subtitle 1 on -
     * 1183 lines", "Ad break over - subtitles shifted 90s", "daily download
     * limit reached", and every Undo it offers. None of it reached a screen
     * reader. `polite` rather than `assertive`: it is never urgent enough to
     * interrupt what is being read, and one of these can appear while a film
     * plays without anybody having asked for it. */
    toast.setAttribute("role", "status");
    toast.setAttribute("aria-live", "polite");
    toastLayer.shadow.append(toast);
    return toast;
  }

  /* Say it where the reader is looking.
   *
   * A toast is drawn at the top of the picture, which is the right place for
   * something raised by a key press while a film plays and the wrong place for
   * the answer to a button in a panel the reader is looking straight at.
   * Reported against Line up: "the message can be easily missed since it is
   * printed on top of the screen, very far from the button I've clicked".
   *
   * The rule, in one place rather than at each call site: a message about ONE
   * subtitle goes on that subtitle's card when the panel is open, and to the
   * toast otherwise - which covers the keyboard nudges, where there may be no
   * panel at all. Every caller that names a slot gets this for free, so the
   * next one does not have to remember.
   */
  function showToast(message, { action = null, slot = null } = {}) {
    /* Everything the reader was told, in order.
     *
     * This is the extension's whole error surface: when something goes wrong
     * the reader sees a sentence here and nothing else is written down
     * anywhere. Recording the sentences means a report of "it said something
     * about the daemon and then stopped working" has the sentence in it. */
    trace("said", { message: String(message), slot, hadAction: Boolean(action) });
    if (slot != null && window.__ssoPanel?.sayInPanel?.(slot, message, { action })) return;
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
    /* The soonest anything notices that the extension has been reloaded under
     * this tab. Nothing else in an orphaned frame runs on its own - the pointer
     * handlers and the message listener all wait to be called - so the tick is
     * what turns "every chrome call throws" into "this copy has stopped",
     * within one tick of it becoming true. */
    if (!alive()) return;
    const tickStarted = performance.now();
    perf.ticks += 1;
    try {
      tickBody();
    } finally {
      perf.tickMs += performance.now() - tickStarted;
      samplePerf();
    }
  }

  function tickBody() {
    // Fast while there is something to draw, slow while there is not. Decided
    // here rather than at every call site that attaches or detaches, so it
    // cannot be forgotten at one of them.
    startTicking(anyAttached() ? TICK_MS : IDLE_TICK_MS);

    /* Before the "no video here" exit below, because losing the video is
     * exactly the change the other frame has to be told about. */
    mindTheOtherFrame();

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
    /* Beside it, and for the same reason it is above the "nothing attached"
     * exit: the next episode is worth warming whether or not this one has
     * subtitles on it. */
    noticeUpNext();
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
    const stream = streamNowMs() - state.adDriftMs - track.offsetMs;
    const plain = track.rate && track.rate !== 1 ? stream / track.rate : stream;
    if (!track.steps?.length) return plain;
    /* Inverted by trying each act's own offset and keeping the one whose answer
     * actually falls inside that act.
     *
     * The two releases disagree at every join about whether a stretch of film
     * exists at all, and the disagreement has a direction. Where the later act
     * sits FURTHER ON in the stream than the earlier one, the release inserted
     * material - a recap, a longer scene - and for the length of that insert
     * there is no moment of this subtitle file on screen at all.
     *
     * Answering `plain` there, which is what this did, hands back a file time
     * from inside the next act: its opening lines are drawn while the inserted
     * material plays, and then drawn AGAIN when the clock catches up and the
     * act properly begins. Reported as "Turkish subtitle sometimes shown
     * earlier and then shown just in time once again". Measured over the 26
     * distinct act plans in the running log, 20 of them have at least one join
     * of this shape: 51 joins and 206 seconds of film across them, the largest
     * single one 16.1 seconds of subtitle played twice.
     *
     * So the clock HOLDS at the join instead. Whatever line spans that instant
     * stays up, nothing new arrives while the insert plays, and the file
     * resumes exactly where it stopped - which makes the whole mapping
     * monotone, and a line can no longer be shown twice.
     *
     * The other direction is left alone. Where the release CUT material the two
     * acts overlap, something has to be dropped, and the later act winning is
     * the right drop: the picture on screen belongs to it. */
    let best = plain;
    /* The act BEFORE this join, because the join has two stream times and they
     * are what the gap is. The earlier act runs out at `fromMs` plus its own
     * offset; the later one begins at `fromMs` plus its own. Testing the hold
     * against the file boundary instead would hold the clock while the earlier
     * act was still running, which on a three-act plan is a second bug wearing
     * the first one's clothes. */
    let previous = 0;
    for (const step of track.steps) {
      const offset = step.offsetMs / (track.rate || 1);
      const shifted = plain - offset;
      if (shifted >= step.fromMs) best = shifted;
      else if (plain - previous >= step.fromMs) best = step.fromMs;
      previous = offset;
    }
    return best;
  }

  /** The act offset that applies at a moment of this file. */
  function stepOffsetMs(track, fileMs) {
    if (!track.steps?.length) return 0;
    let found = track.steps[0].offsetMs;
    for (const step of track.steps) if (fileMs >= step.fromMs) found = step.offsetMs;
    return found;
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
  /* Where the playhead was, and which line it was in, when this last looked.
   *
   * The stop cannot be a test on the current moment alone, and that is the
   * whole of what playback rate breaks. See the note in the body. */
  let insideCue = null;
  let lastFilmMs = null;

  /* A jump no amount of playing accounts for, so it was a seek - the line keys,
   * the scrubber, a chapter skip. Two seconds of film between two ticks is
   * forty times normal speed, well past anything a player offers. */
  const SEEK_JUMP_MS = 2000;
  /* How far inside the line to land when the playhead has already left it.
   * Far enough that the line is drawn, small enough to be imperceptible. */
  const LINE_END_MARGIN_MS = 60;

  function pauseAtLineEnd() {
    if (!state.settings.pauseAtLineEnd || !state.video || state.inAd) return;
    const track = state.tracks[state.keyTrack]?.cues.length
      ? state.tracks[state.keyTrack]
      : attachedTracks()[0];
    if (!track) {
      insideCue = null;
      lastFilmMs = null;
      return;
    }

    const now = filmTimeMs(track);
    const was = lastFilmMs;
    lastFilmMs = now;
    if (state.video.paused) return;

    /* The last line to have started, where several overlap. Stopping at the end
     * of a sign held over the dialogue would stop in the middle of the sentence
     * being spoken, which is the opposite of what this is for. */
    const indexes = findCueIndexes(track.cues, now);
    const cue = indexes.length ? track.cues[indexes[indexes.length - 1]] : null;
    const before = insideCue;
    insideCue = cue;

    /* Forget the line already stopped at, once the playhead has genuinely left
     * it: a different line has started, or it was seeked back over - which is
     * the Again key, and that line has to stop at its end a second time.
     *
     * Deliberately NOT "the playhead is no longer inside it": the gap after a
     * line is still that line's, or pressing play would stop the film again a
     * tick later without having moved. */
    if (pausedAtCue && ((cue && cue !== pausedAtCue) || now < pausedAtCue.start)) {
      pausedAtCue = null;
    }

    // A seek is not playback arriving at the end of a line.
    const step = was == null ? 0 : now - was;
    if (step < 0 || step > SEEK_JUMP_MS) return;

    /* Which line's end has been reached, and why this looks at two of them.
     *
     * The line the playhead is IN, when its end is within one step - that is
     * the ordinary case, and stopping on the way out is what keeps the line on
     * screen while it is read. Or the line it WAS in, when a single step
     * carried the playhead past the end altogether.
     *
     * The second branch is the whole reason this is not a test on `now`. The
     * window is one step wide, and a step is TICK_MS of FILM only while the
     * film plays at 1x: at 2x it is 100ms, at 4x 200ms, and the 50ms window
     * the old test used is simply jumped over. Measured over lines at 10-13,
     * 15-18, 20-23 and 25-28s: at 1x it stopped at all four, at 2x at one of
     * four, at 4x at none. Nothing recovered a missed stop, so from the
     * reader's side the mode had switched itself off.
     *
     * `step` rather than the tick interval, so this holds at any rate the
     * player offers without anything having to read playbackRate. */
    const reach = Math.max(step, TICK_MS);
    const target =
      cue && now >= cue.end - reach
        ? cue
        : before && before !== cue && now >= before.end
          ? before
          : null;

    if (!target || target === pausedAtCue) return;
    pausedAtCue = target;
    state.video.pause();

    /* Land inside the line, not just past it.
     *
     * Above 1x a single step can carry the playhead beyond the end, and the
     * render that runs later in this same tick would then draw an empty box -
     * a stopped film with no subtitle on it, which is the opposite of what
     * this mode is for. Put it back just inside. The move is one step at most,
     * which is 200ms of film even at 4x. */
    if (now > target.end) {
      seekFilm(streamTimeMs(track, target.end - LINE_END_MARGIN_MS), { how: "stop" });
    }
  }

  /** The other direction: where a moment of this file lands in the stream. */
  /* The drift is a parameter rather than a read of `state`, because the frame
   * drawing the controls for a nested player has no ad drift of its own - the
   * only one that matters is the one that came across in the mirror. */
  function streamTimeMs(track, fileMs, driftMs = state.adDriftMs) {
    const scaled = track.rate && track.rate !== 1 ? fileMs * track.rate : fileMs;
    return scaled + track.offsetMs + stepOffsetMs(track, fileMs) + driftMs;
  }

  // --- moving by line ---------------------------------------------------------

  /* Missing a line is the ordinary event of watching a film in a language you
   * are learning, and the ordinary repair - drag the scrubber back, overshoot,
   * drag forward, overshoot - costs far more attention than the line was worth,
   * and takes your eyes off the picture to do it. The subtitle file already
   * says where every line begins, so the repair is one keystroke. */

  /* How far past the mark it aimed at the playhead may sit and a second press
   * still count as part of the same gesture. */
  const LINE_GRACE_MS = 400;
  /* How far SHORT of that mark the film may have come to rest and still count
   * as having got there. A seek settles on a keyframe, and on a stream the
   * nearest one can be seconds away from the moment asked for. */
  const LINE_LANDING_MS = 4000;
  /* Land a little before the line rather than exactly on it. A seek settles on
   * a keyframe, which can be after the moment asked for, and a repeat that
   * starts one word in has not repeated the line. */
  const LINE_PREROLL_MS = 150;
  /* A stretch with nothing in the keyed subtitle, long enough that something
   * could be being said in it. Ordinary dialogue leaves gaps well under this;
   * a gap this long is music, action, or speech this file chose not to carry. */
  const LINE_GAP_MS = 2500;
  /* Two marks this close together are one line counted twice. Two files timed
   * against different releases put the same line a few hundred milliseconds
   * apart, and stepping through both of those is stepping twice through one
   * line. */
  const LINE_MERGE_MS = 1200;

  // Which mark the last press asked for. See stepLine for why it is kept.
  let lastStepMs = null;

  /* Every place the film has a new line to show, in stream milliseconds.
   *
   * The keyed subtitle sets the beat, because it is the one being read. The
   * other attached files are asked only about the stretches where it says
   * nothing at all.
   *
   * The case that needs them: a film in English that turns to Russian for a
   * scene. The picture carries a burnt-in English caption there, so the
   * English subtitle has nothing for those minutes - and stepping back by its
   * lines alone jumps over several whole conversations at once. The Turkish
   * translation kept going, and it is the only record left that anything was
   * said.
   *
   * Taking every mark from every file is wrong the other way. The same line in
   * two files sits a few hundred milliseconds apart, so their union is each
   * line twice and "again" degenerates into a nudge. Hence the two rules
   * below: only a gap long enough to hold a conversation is filled, and a
   * borrowed mark landing beside one already taken is dropped. Where both
   * files carry the dialogue - which is nearly all of a film - the answer is
   * exactly the keyed file's own line starts, as it was before. */
  function lineBoundaries(slot) {
    const attached = attachedTracks();
    if (attached.length === 0) return [];
    /* The keyed track is the one being read, so its lines are the ones worth
     * stepping through. Falling back to whatever is attached keeps the keys
     * working when the keyed slot happens to be the empty one. */
    const keyed = state.tracks[slot]?.cues.length > 0 ? state.tracks[slot] : attached[0];

    const spans = keyed.cues
      .map((cue) => [streamTimeMs(keyed, cue.start), streamTimeMs(keyed, cue.end)])
      .sort((a, b) => a[0] - b[0]);
    const marks = spans.map(([start]) => ({ at: start, keyed: true }));
    if (attached.length < 2 || spans.length === 0) return marks.map((mark) => mark.at);

    /* Where the keyed file has nothing on screen. Its cues overlap - a sign
     * held over the dialogue under it - so coverage is carried forward rather
     * than reset at each line. */
    const gaps = [[-Infinity, spans[0][0]]];
    let coveredTo = spans[0][1];
    for (const [start, end] of spans.slice(1)) {
      if (start - coveredTo > LINE_GAP_MS) gaps.push([coveredTo, start]);
      coveredTo = Math.max(coveredTo, end);
    }
    // Past the last line of the keyed file there is no more of it to be inside.
    gaps.push([coveredTo, Infinity]);

    const borrowed = [];
    for (const track of attached) {
      if (track === keyed) continue;
      for (const cue of track.cues) {
        const at = streamTimeMs(track, cue.start);
        if (gaps.some(([from, to]) => at > from && at < to)) borrowed.push({ at, keyed: false });
      }
    }
    if (borrowed.length === 0) return marks.map((mark) => mark.at);

    const all = [...marks, ...borrowed].sort((a, b) => a.at - b.at);
    const kept = [];
    for (const mark of all) {
      const last = kept.length > 0 ? kept[kept.length - 1] : null;
      const crowded = last !== null && mark.at - last.at <= LINE_MERGE_MS;
      /* Two of the keyed file's own marks this close together are two people
       * talking over each other, not one line counted twice, and both are
       * worth stepping to. Only a borrowed mark gives way - including to a
       * keyed one that arrives just after it. */
      if (crowded && !mark.keyed) continue;
      if (crowded && !last.keyed) {
        kept[kept.length - 1] = mark;
        continue;
      }
      kept.push(mark);
    }
    return kept.map((mark) => mark.at);
  }

  /** The last mark at or before this moment, or null. */
  function markAtOrBefore(marks, timeMs) {
    let found = null;
    let low = 0;
    let high = marks.length - 1;
    while (low <= high) {
      const mid = (low + high) >> 1;
      if (marks[mid] <= timeMs) {
        found = marks[mid];
        low = mid + 1;
      } else {
        high = mid - 1;
      }
    }
    return found;
  }

  /** The last mark strictly before this moment, or null. */
  function markBefore(marks, timeMs) {
    let found = null;
    let low = 0;
    let high = marks.length - 1;
    while (low <= high) {
      const mid = (low + high) >> 1;
      if (marks[mid] < timeMs) {
        found = marks[mid];
        low = mid + 1;
      } else {
        high = mid - 1;
      }
    }
    return found;
  }

  /** The first mark strictly after this moment, or null. */
  function markAfter(marks, timeMs) {
    let found = null;
    let low = 0;
    let high = marks.length - 1;
    while (low <= high) {
      const mid = (low + high) >> 1;
      if (marks[mid] > timeMs) {
        found = marks[mid];
        high = mid - 1;
      } else {
        low = mid + 1;
      }
    }
    return found;
  }

  function stepLine(direction, { slot = state.keyTrack } = {}) {
    if (!state.video) return false;
    const marks = lineBoundaries(slot);
    if (marks.length === 0) return false;

    const nowMs = streamNowMs();
    /* Count from what the last press ASKED FOR rather than from where the film
     * came to rest, while those can still be one gesture.
     *
     * They are routinely not the same moment. A seek settles on a keyframe, and
     * on a stream that keyframe can be a second or two short of the moment
     * asked for - so counting from where the film stopped reads the PREVIOUS
     * line as the current one, "again" plays the line before the one wanted,
     * and the press after it goes back two. Reported as exactly that: "it
     * looks like rewinding to the beginning or end of the previous one, not
     * the current one".
     *
     * Playing on through the line leaves the window, and so does dragging the
     * scrubber anywhere else, which is what stops an old press being read as
     * part of a new gesture. So does re-timing or replacing the file, which is
     * what the mark-still-exists test is for. */
    const stillThere = lastStepMs !== null && markAtOrBefore(marks, lastStepMs) === lastStepMs;
    const repeating =
      stillThere && nowMs >= lastStepMs - LINE_LANDING_MS && nowMs <= lastStepMs + LINE_GRACE_MS;
    const from = repeating ? lastStepMs : nowMs;

    let mark;
    if (direction < 0) {
      /* The first press restarts the line being spoken, and the press after it
       * steps back one. That is the rule a music player uses for "previous
       * track" and it is right here for the same reason: the first press is
       * nearly always "say that again". */
      mark = repeating ? markBefore(marks, from) : markAtOrBefore(marks, from);
    } else {
      mark = markAfter(marks, from);
      /* Sitting in the pre-roll of a line - which is exactly where a press
       * leaves the playhead - means that line is the one about to be read, so
       * "next" has to mean the one after it. Without this, Again followed by
       * Next stays where it is and the key looks broken. */
      if (mark !== null && mark - from <= LINE_PREROLL_MS) mark = markAfter(marks, mark);
    }

    if (mark === null) {
      // The key did its job; there was simply nowhere to go.
      showToast(direction < 0 ? "Nothing before this" : "That was the last line");
      return true;
    }

    seekFilm(mark - LINE_PREROLL_MS, { how: "line", tell: true });
    lastStepMs = mark;
    /* Draw it now rather than up to a tick later. Setting currentTime moves the
     * official playback position immediately, so the tick reads the new time
     * even while the frames are still on their way. */
    for (const other of state.tracks) other.activeIndexes = NEEDS_REDRAW;
    tick();
    return true;
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

  /* schema.org lets `url` and `sameAs` be one string or a list of them. */
  const firstString = (value) => {
    const one = Array.isArray(value) ? value.find((item) => typeof item === "string") : value;
    return typeof one === "string" ? one.trim() : "";
  };

  /* What the page ANNOUNCES it is playing, or null.
   *
   * `data-sso-now-playing` on the element that already carries the offset: one
   * JSON object, written whole, every time the page changes what is in the
   * player. Everything below this is a way of GUESSING that, and each of them
   * is a guess for the same reason - a page states several names and labels
   * none of them, so the reader has to work out which is the programme, which
   * is the episode and which is the site. An announcement is labelled.
   *
   * The presence of the attribute is itself the promise. A page that writes it
   * is saying its statement is complete and changes atomically, which is the
   * one thing no scraped signal can promise and the whole reason the settle
   * window below exists. There is no second attribute declaring the
   * capability: two things to keep in step is one thing that can disagree.
   *
   * A string in the DOM rather than a `CustomEvent` detail, for the reason
   * `sso:seek` is one: an object built in an extension's isolated world is not
   * reliably readable in the page's, and the DOM is what both worlds share.
   *
   * Memoised on the raw text and the element it came off, not on a clock. The
   * identity of the string IS the identity of the answer, so this is exact
   * where the 250ms window `statedProgramme` uses is a guess - and that guess
   * sat on the path whose LATENCY is the bug this contract exists to fix. */
  let announcedWork = { video: null, raw: null, value: null };

  function announcedProgramme(video = state.video) {
    const raw = video?.getAttribute?.("data-sso-now-playing") ?? null;
    if (video === announcedWork.video && raw === announcedWork.raw) return announcedWork.value;
    announcedWork = { video, raw, value: readAnnouncement(raw) };
    return announcedWork.value;
  }

  /* A version this does not know is not read at all, field by field or
   * otherwise. That is what makes the contract safe to extend: a later version
   * may change what an existing field MEANS, and a reader that helped itself
   * to the fields it recognised would then be confidently wrong instead of
   * falling back to the guessing, which still works. */
  const ANNOUNCEMENT_VERSION = 1;

  /* Parsed, then checked, because a malformed announcement has to fall through
   * to the guessing rather than send a search for half of one. Every rule here
   * is one the guessing already had to learn:
   *
   * - `title` is the name subtitles are INDEXED under, so for an episode it is
   *   the series. An episode page names "Baggage" and "The Americans" and only
   *   the second finds anything; the contract puts the answer in the field
   *   rather than leaving each reader to rank two unlabelled strings.
   * - a season with no episode is not an answer - it would search a whole
   *   series - so `statedEpisode` refuses that pair and so does this.
   * - numbers are numbers. A site generator emitting the whole vocabulary with
   *   empty strings in it reads as episode zero of season zero, which outranks
   *   the real one; `statedNumber` is why that is not possible here either.
   * - a length is checked against the range a film can have, because it goes
   *   into the drift estimator's divisor with nothing downstream to catch it.
   */
  function readAnnouncement(raw) {
    if (!raw) return null;
    let stated;
    try {
      stated = JSON.parse(raw);
    } catch {
      // A page mid-write, or one that emitted something else entirely.
      return null;
    }
    if (!stated || stated.v !== ANNOUNCEMENT_VERSION) return null;
    const playing = readIdentity(stated);
    if (!playing) return null;

    const seconds = Number(stated.durationSeconds);
    const usable = seconds >= MIN_VIDEO_SECONDS && seconds <= LONGEST_FILM_S;
    return {
      ...playing,
      durationSeconds: usable ? seconds : null,
      /* What the page says comes after this one, read by exactly the same
       * rules and refused on its own.
       *
       * A malformed `upNext` costs the prefetch and nothing else: the film
       * playing is still announced, and a reader that does not know the field
       * carries on as before. That is the whole reason it is a nested identity
       * rather than more fields on the top level - the two answers are about
       * different programmes and one of them must not be able to spoil the
       * other.
       *
       * It carries no length. A length describes an encode, and nothing is
       * encoding what has not been asked for yet. */
      upNext: readIdentity(stated.upNext),
    };
  }

  /* One programme's identity, from an announcement or from the `upNext` inside
   * one. Written once because the rules are the same rules and a prefetch that
   * validated more loosely than the attach would search for something the
   * attach then refuses. */
  function readIdentity(stated) {
    if (!stated || typeof stated !== "object") return null;
    const kind = stated.kind === "episode" || stated.kind === "movie" ? stated.kind : "";
    const title = String(stated.title ?? "").trim();
    if (!kind || !title) return null;

    const season = statedNumber(stated.season);
    const episode = statedNumber(stated.episode);
    if (kind === "episode" && (season === null || episode === null)) return null;

    const imdb = String(stated.imdb ?? "").trim();
    const year = statedNumber(stated.year);
    /* Other names for the same programme, if the player knows any.
     *
     * Additive inside v1, deliberately, rather than a v2. Bumping the version
     * makes every older extension discard the WHOLE announcement over one
     * field it does not need - a working handshake traded for an extra name. A
     * reader that does not know this field ignores it and gets what it always
     * got; a player that does not send it is unaffected. schema.org
     * `alternateName` says the same thing in standard vocabulary and is read
     * whether or not the player announces, so this is the shortcut rather than
     * the only route. */
    const also = Array.isArray(stated.altTitles) ? stated.altTitles : [];
    return {
      kind,
      title,
      altTitles: also.map((one) => String(one ?? "").trim()).filter(Boolean).slice(0, 6),
      year: year !== null && year > 1800 ? year : null,
      season: kind === "episode" ? season : null,
      episode: kind === "episode" ? episode : null,
      imdb: /^tt\d+$/.test(imdb) ? imdb : null,
    };
  }

  /* The identity an announcement carries, and nothing else it carries.
   *
   * The length is deliberately not in here. A length that grows as the stream
   * arrives is what used to churn the mark - 2701, 146, 2701, 530 over one
   * evening, each flip taking both subtitles off - and the announcement states
   * one only so the rest of the overlay can have the film's real length before
   * the first frame. Putting it in the identity would reintroduce exactly the
   * churn the announcement exists to end, and it would make switching to
   * another copy of the same episode read as a different programme. */
  const ANNOUNCED_PREFIX = "sso:1|";

  const announcedMark = (announced) =>
    ANNOUNCED_PREFIX +
    [
      announced.kind,
      announced.imdb || "",
      announced.title,
      announced.year ?? "",
      announced.season === null ? "" : `S${announced.season}E${announced.episode}`,
    ].join("|");

  /* What the page SAYS is playing - its identity, not its encode.
   *
   * `statedSeconds` above prefers a VideoObject, and this deliberately refuses
   * one. The asymmetry is the point. A VideoObject describes the file on the
   * page, so it is the right place to ask how long the film is - and its `name`
   * is the media file's own name, written on the local catalogue app only once
   * playback has started. An identity built from it changes in the middle of an
   * episode, which is the one thing an identity may never do. The WORK - Movie,
   * TVEpisode, TVSeries - is what the page is ABOUT, and it is in <head> before
   * the first frame is decoded.
   *
   * The series name with the stated season and episode, because that is what
   * the search sends. This is the whole repair: the detector and the search
   * were reading two different answers to "what is playing" - this one keyed on
   * the element's duration, the search on the page's metadata - and the window
   * where the two disagreed was exactly the window after an episode changed.
   * A mark built from the search's own input moves when the query would move,
   * and not otherwise.
   *
   * `url`/`sameAs` is taken when the page offers one: on the catalogue app it
   * is a per-episode id, which separates two episodes that share a title. */
  /* Memoised, because the tick asks twenty times a second and this parses every
   * JSON-LD block on the page. Not for a second, the way `statedSeconds` is:
   * that one is consulted only when the element's own duration cannot be
   * trusted, while this is on the path whose LATENCY is the bug being fixed,
   * and a stale answer here is time the last episode's subtitles stay up. 250ms
   * is what `pickVideo` already uses for the same kind of question, it is
   * negligible against the 1500ms the mark then has to settle for, and the work
   * is a querySelectorAll and a JSON.parse - no layout, which is the cost that
   * actually matters in this file. */
  let statedWork = { at: -Infinity, stated: null };
  const STATED_WORK_MS = VIDEO_CACHE_MS;

  /* The fields, once, so the mark and the description cannot disagree about
   * what the page said. The mark is what decides a programme changed; the
   * description is what is told to something that has to read it, and a second
   * scrape for the second reader is a second answer waiting to drift. */
  function statedIdentity() {
    const now = performance.now();
    if (now - statedWork.at < STATED_WORK_MS) return statedWork.stated;
    let stated = null;
    for (const item of readJsonLd()) {
      const type = schemaType(item);
      if (!SCHEMA_VIDEO_TYPE.test(type) || /VideoObject/i.test(type)) continue;
      const episode = statedEpisode(item);
      const name = String(item.partOfSeries?.name || item.name || "").trim();
      const id = firstString(item.url ?? item.sameAs ?? item["@id"]);
      if (!name && !id && !episode) continue;
      stated = {
        id,
        title: name,
        season: episode ? episode.season : null,
        episode: episode ? episode.episode : null,
      };
      break;
    }
    statedWork = { at: now, stated };
    return stated;
  }

  function statedProgramme() {
    const stated = statedIdentity();
    if (!stated) return "";
    const at = stated.season === null ? "" : `S${stated.season}E${stated.episode}`;
    return `${stated.id}|${stated.title}|${at}`;
  }

  /* What is playing, written for somebody to READ rather than to search with.
   *
   * The one consumer today is the model that glosses words: it is answering
   * "what does this word mean in this line", and a line of dialogue means
   * different things in different programmes. "Jump", "viper" and "the old man"
   * are the worked examples out of the Battlestar miniseries, where all three
   * are the programme's own vocabulary and none of them is what a dictionary
   * says.
   *
   * Two sources and no third, and the refusal is the point. A page that
   * ANNOUNCES what it is playing has promised; a page that states schema.org
   * has told its crawlers. Everything below that is a guess - the tab title on
   * Prime Video is "Prime Video: Crime 101" - and a model told the wrong
   * programme does not hedge, it answers confidently in the vocabulary of a
   * film nobody is watching. Nothing said is the honest answer there, and it is
   * exactly what this did before the field existed.
   */
  function describeFilm() {
    const identity = announcedProgramme() || statedIdentity();
    const title = String(identity?.title || "").trim();
    if (!title) return "";
    const year = identity.year ? ` (${identity.year})` : "";
    const at =
      identity.season === null || identity.season === undefined
        ? ""
        : `, season ${identity.season} episode ${identity.episode}`;
    return `${title}${year}${at}`;
  }

  /* The length in the mark is the longest this programme has reported, and a
   * film that is already playing is never allowed to get shorter.
   *
   * A film's length does not shrink while it plays. What does shrink is the
   * element's number, every time the page loads a new resource into it - and on
   * the local catalogue app every jump is a new resource, because a stream
   * produced as it is sent cannot be seeked and the app fetches another one
   * starting at the moment asked for. For the moment before enough of it has
   * arrived, `duration` is a few seconds.
   *
   * Read straight into the mark, each of those is a different programme.
   * Measured from the extension's own log on 2026-08-23, one evening on one
   * episode of The Americans: the reported length went 2701, 146, 2701, 530,
   * 2701, 113, 2701, 111, 2701 - and each step settled long enough to be
   * believed. Every one of them took both subtitles off and searched again, and
   * the two searches that came back with nothing left the film unsubtitled 39
   * and 26 minutes in. Reported as "my subtitles are gone again in the middle
   * of the movie".
   *
   * The memory is reset by the two things that really are a new programme: the
   * title changing, and the film going back to its beginning. Which leaves one
   * case uncovered - a shorter episode, on a site that never changes its title,
   * resumed part-way through - and that is the same direction this has always
   * been willing to be wrong in: nothing happens, and the reader attaches by
   * hand as before. */
  const PROGRAMME_RESTART_S = 20;
  let programmeLength = { title: "", seconds: 0 };

  function programmeMark() {
    const video = state.video;
    if (!video) return "";

    /* A page that ANNOUNCES what it is playing has answered this, alone.
     *
     * Nothing joins in - and in particular not the tab title. The title rides
     * along in both shapes below, because on a site that states nothing it is
     * the one signal every player updates; it is also the LAST thing to
     * update. Measured on the catalogue app 2026-08-25: the metadata named the
     * next episode and the tab title did not follow for ten seconds, and every
     * second of that was the mark moving again and the settle in
     * `noticeProgrammeChange` starting over. An identity that has to wait for
     * the slowest signal on the page is not an announcement. */
    const announced = announcedProgramme(video);
    if (announced) return announcedMark(announced);

    const title = programmeTitle();

    /* A page that states what it is playing has already answered this, and its
     * answer arrives with the navigation rather than with the stream.
     *
     * Everything below can only answer once a length is known, and on a stream
     * produced as it is sent there is no length for the first seconds of every
     * episode: `loadstart` clears what was learned about the last resource and
     * the element restarts at NaN, then climbs. So the mark was empty exactly
     * when the episode had just changed - and `noticeProgrammeChange` reads an
     * empty mark as "ask again later", which keeps the LAST episode's identity
     * for the whole of that window. Measured on the catalogue app 2026-08-25:
     * the tab title moved to the next episode between 09:30:32 and 09:30:42 and
     * the new subtitles went up at 09:30:47, with the previous episode's lines
     * over the new picture until then. Reported as "I switch to the next
     * episode and it still finds the previous title".
     *
     * The stated identity carries no length on purpose. A length that grows as
     * the stream arrives is what used to churn the mark - 2701, 146, 2701, 530
     * over one evening, each flip taking both subtitles off - and a page that
     * names what it is playing does not need one to be believed. The title
     * rides along in both shapes, so a page whose metadata is stale can still
     * be caught by the one signal every player updates. */
    const stated = statedProgramme();
    if (stated) return `${stated}|${title}`;

    const seconds = filmSeconds(video);
    if (seconds === null || seconds < MIN_VIDEO_SECONDS) return "";
    // Ad time is stream seconds that were not film, so it comes off before the
    // clock is asked whether this film has just started.
    const watched = (streamNowMs(video) - state.adDriftMs) / 1000;
    if (title !== programmeLength.title || watched < PROGRAMME_RESTART_S) {
      programmeLength = { title, seconds };
    } else if (seconds > programmeLength.seconds) {
      programmeLength.seconds = seconds;
    }
    return `${Math.round(programmeLength.seconds)}|${title}`;
  }

  /* Long enough for a player that is still settling - the duration arrives
   * before the title on some sites and after it on others - and short enough
   * that the subtitles are up before the recap ends. */
  const PROGRAMME_SETTLE_MS = 1500;

  /* An announcement does not settle, because it cannot flicker.
   *
   * The wait above is not caution about the page, it is caution about the
   * SIGNAL. A mark built from a duration that is still arriving and a title
   * that is still being written moves several times before it means anything,
   * and acting on each move takes the subtitles off. A page that writes its
   * identity as one attribute, whole, has nothing to settle: the next value is
   * as final as the one before it. Waiting for it is pure latency, and it is
   * the difference between subtitles a few seconds after the episode changes
   * and subtitles at the moment it changes. */
  const settleFor = (mark) => (mark.startsWith(ANNOUNCED_PREFIX) ? 0 : PROGRAMME_SETTLE_MS);

  let programme = { mark: "", since: 0, told: "" };
  /* The mark once it has stopped moving, which is what "a different programme"
   * means to anything outside this file.
   *
   * `told` is not that, and the difference matters: attach() writes to `told`
   * as well, to say this programme's search has already been answered. A reader
   * of `told` would see a subtitle arriving as a new episode - which would wipe
   * the panel's result list between attaching the first language and the second
   * one, out of the same list. */
  let settledProgramme = "";
  /* The same programme, described rather than marked. Worked out when the mark
   * settles and not on every read: it changes exactly when the programme does,
   * and `describeFilm` parses the page's JSON-LD, which is not work for a
   * function the panel calls once a second. */
  let settledFilm = "";
  /* Which programme the accumulated ad time was measured against.
   *
   * The correction is stream seconds that were not film, so it is true of one
   * playback and meaningless for the next thing that starts in the same tab.
   * Carrying it into the next episode would shift every line by the length of
   * the last episode's ad breaks. Cleared on the same settled mark the worker
   * is told about, not on a bare title flicker. */
  let adDriftFor = "";

  function noticeProgrammeChange() {
    // An advert is not a new programme, and on the players that swap the
    // element for one it is exactly what this would otherwise fire on.
    if (state.inAd) return;

    const mark = programmeMark();
    if (!mark) return;
    const wait = settleFor(mark);
    if (mark !== programme.mark) {
      programme = { mark, since: performance.now(), told: programme.told };
      /* An inferred mark is given the window to stop moving. An announced one
       * is acted on in the turn it arrived in: returning here unconditionally
       * cost a whole tick even where the wait is zero, and the tick during an
       * episode change is the idle one - half a second of the last episode's
       * lines over the new picture, for nothing. */
      if (wait > 0) return;
    }
    const settled = performance.now() - programme.since >= wait;
    if (settled && settledProgramme !== mark) {
      settledProgramme = mark;
      settledFilm = describeFilm();
      /* A different film is a change in what the status describes, and the
       * panel's Find screen is drawn from it. The tick does not notify by
       * itself - it has nothing to say most of the time - so without this the
       * panel hears about the new episode only when something else happens to
       * change. Once per programme. */
      notify();
    }
    if (programme.told === mark || !settled) return;

    /* A different programme, so last one's ad time is not this one's. Here
     * rather than in attach(), because it is the programme changing that makes
     * the number wrong - not a subtitle arriving. */
    if (adDriftFor && adDriftFor !== mark) forgetAdDrift();

    /* Marked as told before the worker answers, not after. The tick runs
     * twenty times a second and this is a round trip; without it, twenty
     * requests go out before the first one is back. */
    programme.told = mark;
    sendToWorker({ type: "sso:programme", mark }).catch(() => {
      // No worker listening is not this frame's problem to report.
    });
  }

  /* --- what is next, and when it stops being a guess --------------------------
   *
   * A reader watching a series watches the next episode, and the app knows
   * which one that is before it is asked for. Everything the switch spends is
   * spendable early: measured over the twelve episode changes in the running
   * log since the announcement contract landed, from "Looking for subtitles"
   * to both subtitles up is 10 to 37 seconds, median about 18, and inside a
   * typical one the search is 3s, the first download 3s, the second 6s and the
   * lining up 4s. Only the last of those needs the film.
   *
   * So the search goes out as soon as the page says what is next, because a
   * search costs nothing and OpenSubtitles does not meter it. The downloads
   * wait for the middle of the current film, because that is the point at
   * which the next episode stops being a guess - a download IS metered, five a
   * day anonymously and ten with an account, and a reader who stops at twenty
   * minutes must not have spent two of them on an episode they never saw.
   *
   * The worker holds the second half of that rule: it also refuses unless the
   * last download it made reported enough of the day's allowance left.
   */
  const COMMITTED_FRACTION = 0.5;
  let warmedNext = "";

  function noticeUpNext() {
    const next = announcedProgramme()?.upNext ?? null;
    if (!next) {
      warmedNext = "";
      return;
    }
    /* Two states, and the second includes the first, so the key carries the
     * depth: warming the search and then warming the downloads are two
     * different asks about the same episode, and the tick would otherwise send
     * whichever it reached first, twenty times a second, forever. */
    const committed = pastTheMiddle();
    const key = `${announcedMark(next)}|${committed ? "downloads" : "search"}`;
    if (key === warmedNext) return;
    warmedNext = key;
    sendToWorker({ type: "sso:warmNext", next, committed }).catch(() => {
      // No worker listening costs a prefetch, which is a saving, not a feature.
    });
  }

  function pastTheMiddle() {
    const seconds = filmSeconds();
    const at = streamNowMs();
    if (!Number.isFinite(seconds) || !(seconds > 0) || !Number.isFinite(at)) return false;
    return at / (seconds * 1000) >= COMMITTED_FRACTION;
  }

  let lastAdPoll = 0;

  /* Throw the measured ad time away. One function, three callers - the panel's
   * Clear button, the worker, and a new programme starting - because they all
   * have to forget the same three things and one of them forgetting only the
   * number would leave a stamp that clears the next programme's drift too. */
  function forgetAdDrift() {
    state.adDriftMs = 0;
    state.inAd = false;
    adDriftFor = "";
    for (const track of state.tracks) track.activeIndexes = NEEDS_REDRAW;
  }

  /* Detecting the two edges of an ad break is the entire mechanism: the gap
   * between them, measured in stream time, IS the correction. */
  function pollAdState() {
    const now = performance.now();
    if (now - lastAdPoll < AD_POLL_MS) return;
    lastAdPoll = now;

    const showing = adMarkerVisible();
    if (showing === state.inAd) return;

    const streamMs = streamNowMs();
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
        // Stamped with what it was measured against, so the next programme
        // does not inherit it. See adDriftFor.
        adDriftFor = programmeMark() || adDriftFor;
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
    perf.cues += 1;
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
    /* A correction still waiting to be written is newer than the one on disk.
     *
     * saveOffset is throttled, so re-attaching the same file inside that window
     * - which is what replacing a subtitle with another release of itself does
     * - read back the value from before the reader's last nudge and quietly
     * undid it. The queue is the truth until it drains. */
    const pending = pendingOffsets.get(fileId);
    if (pending) return { ...pending, known: true };
    try {
      const stored = await readStored(offsetKey(fileId));
      const saved = stored[offsetKey(fileId)];
      if (typeof saved === "number") return { offsetMs: saved, rate: 1, steps: [], known: true };
      if (!saved) return nothing;
      return {
        offsetMs: Number(saved.offsetMs) || 0,
        rate: Number(saved.rate) || 1,
        /* Absent for every installation that predates acts, which reads back as
         * the empty list and behaves exactly as it did. */
        steps: tidySteps(saved.steps),
        known: true,
      };
    } catch {
      return nothing;
    }
  }

  /* Anything read from storage or handed over by another frame, made safe.
   *
   * The list is load-bearing for every time conversion on screen, so a
   * malformed one is a film with no subtitles rather than a logged warning. It
   * must be sorted, must start at zero, and a single entry is the same thing as
   * none. */
  function tidySteps(value) {
    if (!Array.isArray(value)) return [];
    const kept = value
      .map((step) => ({ fromMs: Math.round(Number(step?.fromMs)), offsetMs: Math.round(Number(step?.offsetMs)) }))
      .filter((step) => Number.isFinite(step.fromMs) && Number.isFinite(step.offsetMs))
      .sort((a, b) => a.fromMs - b.fromMs);
    if (kept.length < 2) return [];
    kept[0].fromMs = 0;
    return kept;
  }

  /* How long a correction has to settle before it is written down.
   *
   * setOffset is on two gestures that fire at pointer rate: dragging the
   * timeline strip on a card, which calls it on every pointermove, and holding
   * a nudge button, which calls it every 80ms. Measured: 60 writes for a
   * 60-sample drag and 24 for a two-second hold, each one an IPC to the browser
   * process and a disk write, for a number that was superseded 16ms later.
   *
   * The same reasoning already sat eleven lines below in rememberTimingSoon -
   * "what is worth remembering is where the reader stopped, not every step on
   * the way" - and had been applied to the release memory and not to the offset
   * it is derived from.
   *
   * A throttle rather than a plain debounce, so a long drag still gets written
   * down every so often instead of only at the end. */
  const SAVE_OFFSET_MS = 400;
  const pendingOffsets = new Map();
  let offsetWriteTimer = null;

  function saveOffset(track) {
    if (track.fileId == null) return;
    // Per file, so nudging one subtitle does not discard the other's write.
    pendingOffsets.set(track.fileId, { offsetMs: track.offsetMs, rate: track.rate, steps: track.steps });
    if (offsetWriteTimer !== null) return;
    offsetWriteTimer = setTimeout(flushOffsets, SAVE_OFFSET_MS);
  }

  /** Write whatever is waiting. Also called on the way out - see the teardown. */
  function flushOffsets() {
    clearTimeout(offsetWriteTimer);
    offsetWriteTimer = null;
    if (pendingOffsets.size === 0) return;
    const patch = {};
    for (const [fileId, timing] of pendingOffsets) patch[offsetKey(fileId)] = timing;
    pendingOffsets.clear();
    writeStored(patch);
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
      const stored = await readStored(USED_TIMING_KEY);
      const list = Array.isArray(stored[USED_TIMING_KEY]) ? stored[USED_TIMING_KEY] : [];
      const mine = (entry) =>
        entry?.family === family && (entry?.language || "") === (track.language || "");
      /* A film the reader had to keep re-correcting has no single timing to
       * carry, so the entry goes rather than being written wrong.
       *
       * Everything above this is an argument that the correction belongs to the
       * release. It does, when there is one correction. When the reader has
       * been moving it all evening the number at the end is the release's gap
       * PLUS a film's worth of drift, and that total is what was being carried
       * onto the next episode. Measured over 61 handovers between episodes of
       * one release family in the running log: where the corrections had
       * drifted, carrying the last one missed the next episode's own answer by
       * a median of 10.2 seconds against 2.6 for carrying nothing at all. The
       * reader's part of that is the toast saying "brought forward 16.78s as
       * last time" and then having to find the reset - six of the last six
       * carried timings were undone within seconds.
       *
       * Deleted rather than left alone, because a stale entry is the same fault
       * one episode later. */
      if (correctionsDrifted(track)) {
        if (!list.some(mine)) return;
        await writeStored({ [USED_TIMING_KEY]: list.filter((entry) => !mine(entry)) });
        return;
      }
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
      await writeStored({ [USED_TIMING_KEY]: kept.slice(0, TIMING_MEMORY_MAX) });
    } catch {
      // A timing that fails to be remembered leaves things as they were before
      // any of this existed, which is a working extension.
    }
  }

  /* Written once the nudging stops, not during it. Holding a nudge button fires
   * a dozen times a second and each write here is a read and a write; what is
   * worth remembering is where the reader stopped, not every step on the way. */
  /* One timer per subtitle, not one between them. A correction to the leading
   * subtitle carries the followers, so two tracks ask to be remembered inside
   * the same gesture - and with one timer the second call cancelled the first,
   * which meant a follower's timing was never written down at all while a lead
   * was being dragged. */
  const rememberTimers = new Map();

  function rememberTimingSoon(track) {
    clearTimeout(rememberTimers.get(track));
    rememberTimers.set(track, setTimeout(() => {
      rememberTimers.delete(track);
      rememberTiming(track);
    }, 800));
  }

  async function recallTiming(track) {
    const family = timingFamily(track.label);
    if (!family) return null;
    try {
      const stored = await readStored(USED_TIMING_KEY);
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
  function setRate(rate, { slot = state.keyTrack, quiet = false, byHand = true, how = "set" } = {}) {
    const track = state.tracks[slot];
    const wasRate = track.rate;
    const next = Number(rate);
    track.rate = Number.isFinite(next) && next > 0 ? next : 1;
    track.activeIndexes = NEEDS_REDRAW;
    /* The corrections were fitted against the old speed, so under the new one
     * they describe a film that no longer exists. Kept and they would measure a
     * drift that has just been taken out.
     *
     * Only when the speed actually moved. Setting a track that runs at 1 to 1
     * changes nothing about what the corrections describe, and `applyTiming`
     * does exactly that on every accepted alignment - so taking an offer that
     * had nothing to say about the speed threw away the reader's whole drift
     * measurement and re-armed an offer they had already answered. */
    if (track.rate !== wasRate) {
      track.corrections = [];
      track.driftOffered = false;
    }
    saveOffset(track);
    if (byHand) rememberTimingSoon(track);
    notify();
    if (byHand && track.rate !== wasRate) {
      traceCorrection(track, slot, { how, wasOffsetMs: track.offsetMs, wasRate });
    }
    if (!quiet) {
      showToast(
        track.rate === 1
          ? "Subtitle back to the film's own speed"
          : `Subtitle running ${((track.rate - 1) * 100).toFixed(1)}% ${track.rate > 1 ? "fast" : "slow"}`,
        { slot },
      );
    }
  }

  /* `note` is what separates one correction from one gesture.
   *
   * A map drag calls this on every pointermove - about sixty times for a
   * deliberate aim - and each of those used to count as a separate correction:
   * eight of them fill the drift estimator's whole memory with points at the
   * same instant, and traced, one drag would be sixty lines in the log saying
   * the same thing. The moves are silent now and the release is the correction,
   * which is also what the reader means by having made one. */
  /* Which subtitle carries the others, or null when none does.
   *
   * The first one attached, and null when it is the only one - so a single
   * subtitle is never described as leading anything, and nothing in the panel
   * has to say so. */
  function leadSlot() {
    const first = state.tracks.findIndex((track) => track.cues.length > 0);
    if (first < 0) return null;
    const others = state.tracks.some((track, slot) => slot !== first && track.cues.length > 0);
    return others ? first : null;
  }

  /* Move everything that is not the lead by the same amount.
   *
   * Asked for as "the first subtitle should be treated like master, so moving
   * it should move the rest, but the others should be individuals", and the
   * split is right because the two corrections mean different things. Where
   * the first subtitle sits is where the FILM's dialogue is; where each other
   * one sits is how that file differs from the first. A reader who hears a
   * line before they read it has learnt something about the film, and it is
   * true of every subtitle on screen at once.
   *
   * Nothing is lost by it. The two things a reader can mean are still both
   * reachable: moving the lead by d moves everything and leaves every relative
   * offset alone, and moving a follower by d changes only its relation to the
   * lead. "The lead alone is out" is the lead by d and the follower by -d,
   * which is also the honest description of that case.
   *
   * The drift estimator is deliberately not told. It learns "this reader keeps
   * nudging this file", and a follower that moved because the lead did has not
   * been nudged - counting it would measure a drift in a file nobody corrected
   * and offer to stretch it. */
  function carryFollowers(lead, deltaMs, byHand) {
    if (!deltaMs) return;
    state.tracks.forEach((track, slot) => {
      if (slot === lead || track.cues.length === 0) return;
      track.offsetMs += deltaMs;
      track.activeIndexes = NEEDS_REDRAW;
      saveOffset(track);
      if (byHand) rememberTimingSoon(track);
    });
  }

  function setOffset(
    ms,
    { quiet = false, slot = state.keyTrack, byHand = true, how = "set", note = true, fromMs } = {},
  ) {
    const track = state.tracks[slot];
    /* `fromMs` is where the GESTURE started, for the one caller whose gesture is
     * longer than one call: the map drag has already moved the offset sixty
     * times by the point it commits, so the value it is replacing is its own. */
    const wasOffsetMs = Number.isFinite(fromMs) ? Math.round(fromMs) : track.offsetMs;
    /* Only a correction the reader aimed at the film carries the others.
     *
     * `byHand` is already false for everything the extension works out for
     * itself - the aligner, a remembered timing, the drift fix - and every one
     * of those is a statement about ONE file, so carrying them would undo the
     * very relationship they were computed to establish. The snap is by hand
     * and is the same kind of thing: it moves a subtitle onto the other one,
     * which is meaningless to do to the whole pair at once. */
    const carries = byHand && how !== "snap" && slot === leadSlot();
    const moved = Math.round(ms) - track.offsetMs;
    track.offsetMs = Math.round(ms);
    track.activeIndexes = NEEDS_REDRAW; // force a re-render at the new offset
    if (carries) carryFollowers(slot, moved, byHand);
    saveOffset(track);
    if (byHand) rememberTimingSoon(track);
    notify();
    if (!quiet) {
      // Name the track only when there are two of them to confuse, and say what
      // the correction did rather than what number it is now.
      const which = attachedTracks().length > 1 ? `Subtitle ${slot + 1}` : "Subtitles";
      /* Said out loud, because a control that moves something it is not next
       * to has to. The alternative is a reader who corrects subtitle 1, sees
       * subtitle 2 move, and concludes the pair is coupled by a bug. */
      const also = carries && moved ? " · the other moved with it" : "";
      showToast(`${which} ${describeOffset(track.offsetMs)}${also}`, { slot });
    }
    /* After the toast confirming the nudge, and deliberately replacing it. One
     * toast at a time, and of the two the reader already knows what they just
     * pressed - the drift is the news. Before it, this was written and then
     * immediately overwritten by the line above. */
    if (byHand && note) {
      traceCorrection(track, slot, { how, wasOffsetMs, wasRate: track.rate });
      noteCorrection(track, slot);
    }
  }

  /* Replace this file's per-act offsets, or clear them.
   *
   * Separate from setOffset because the two mean different things and want
   * different gestures. `offsetMs` is what the reader corrects - a nudge moves
   * the whole subtitle and the acts travel with it, which is right, because a
   * staircase between two releases does not stop existing because the reader
   * moved both files. `steps` is what the aligner found, and clearing it is
   * part of "back to the file's own timing" for the same reason clearing the
   * rate is: a subtitle that has been cut into acts is not back to its own
   * timing while the cuts are still there. */
  function setSteps(steps, { slot = state.keyTrack, quiet = true } = {}) {
    const track = state.tracks[slot];
    if (!track) return;
    track.steps = tidySteps(steps);
    track.activeIndexes = NEEDS_REDRAW;
    saveOffset(track);
    notify();
    if (!quiet) showToast(track.steps.length ? `${track.steps.length} acts` : "One timing for the whole film", { slot });
  }

  /* Steady the hand that just made a correction.
   *
   * A drag on a 180px strip showing a minute of film is accurate to about a
   * fifth of a second, and the right answer is usually a few tens of
   * milliseconds away from where the hand let go - a value that can be looked
   * up rather than guessed, because it is the shift at which the most lines of
   * this subtitle land on a line of the other one. Asked for as "some level of
   * smart snapping could be a great help while syncing subtitles".
   *
   * Only after a gesture that was AIMED, which is the map drag. A keyboard
   * nudge is a deliberate step of a known size, and snapping it would mean the
   * key stopped doing the same thing every time it was pressed - press, snap
   * back, press again, snap back. The reader would be fighting it.
   *
   * The search is in align.js and is deliberately local; see the note there
   * about why the whole file is the wrong thing to consult. Returns what it
   * did, so the panel can say so - a correction that moves after the hand has
   * let go must not be silent, or the reader learns the drag is imprecise. */
  /* How much of the reader's own move a snap is allowed to take back.
   *
   * Reported as the drag "fighting back", and the search is a fixed point, so
   * it is exactly that. snapNear answers with the median gap between the two
   * files near the playhead, and that answer does not depend on where the hand
   * let go - so once a correction sits on it, every deliberate move away is met
   * by a move of the same size back. Read out of the running log, over the 137
   * snaps that followed a drag: 76 went against the drag, 29 gave back more
   * than half of it, and 15 put the correction back within 8ms of where the
   * gesture began, five of them to the millisecond. A reader who moved the map
   * 443ms and was moved 443ms back has not been steadied, they have been
   * overruled - and the second time it happens they stop trusting the drag.
   *
   * So a snap may refine an aim and may not reverse it. Half is the line
   * because the whole claim above this function is that the snap is worth a few
   * tens of milliseconds against a hand accurate to about a fifth of a second;
   * something giving back more of the gesture than half is not that number, it
   * is an answer to a question the hand did not ask. */
  const SNAP_KEEPS = 0.5;

  function snapTiming(slot = state.keyTrack, { atMs, fromMs } = {}) {
    const track = state.tracks[slot];
    if (!track?.cues.length || !globalThis.__ssoAlign?.snapNear) return null;
    /* The lead has nothing above it to snap to.
     *
     * It is the reference the others are positioned against, so snapping it
     * onto one of them would pull the reader's own aim back toward a subtitle
     * that is only where it is because of the lead - undoing half the
     * correction they just made, quietly, immediately after they made it. */
    if (slot === leadSlot()) return null;
    const otherSlot = state.tracks.findIndex((t, i) => i !== slot && t.cues.length > 0);
    if (otherSlot === -1) return null;

    const at = Number.isFinite(atMs) ? atMs : streamNowMs();
    if (!Number.isFinite(at)) return null;

    // Both on the video's clock, which is the only one they share.
    const streamStarts = (which) => {
      const it = state.tracks[which];
      return it.cues.map((cue) => streamTimeMs(it, cue.start, state.adDriftMs));
    };
    const found = globalThis.__ssoAlign.snapNear(
      streamStarts(slot), streamStarts(otherSlot), { atMs: at },
    );
    if (!found) return null;

    /* A refinement of the move that was just made, or nothing.
     *
     * `fromMs` is where that gesture began. A caller with no gesture behind it
     * passes none, and then there is nothing to be reversing and the snap
     * stands as before. */
    const movedMs = Number.isFinite(fromMs) ? track.offsetMs - Math.round(fromMs) : null;
    if (
      movedMs !== null
      && found.deltaMs * movedMs < 0
      && Math.abs(found.deltaMs) > Math.abs(movedMs) * SNAP_KEEPS
    ) {
      return null;
    }

    setOffset(track.offsetMs + found.deltaMs, { slot, quiet: true, how: "snap" });
    return found;
  }

  /* --- lining up against the picture, by ear ----------------------------------
   *
   * The case the aligner cannot reach, and the one two thirds of the
   * corrections are actually about. `align()` answers "where does this file sit
   * against that one" - a question about the pair - and a reader whose pair
   * agrees perfectly while both files are eight seconds late has no use for it.
   * Read out of the running log over 241 alignments: 141 were followed by a
   * by-hand correction inside fifteen minutes, and of the 629 corrections that
   * followed one, 419 were on the LEADING subtitle, which is the one Line up
   * has nothing to say about and which snapTiming deliberately refuses.
   *
   * There is exactly one reference for where the film's dialogue is, and it is
   * the reader's ear. So they say which line they just heard and the arithmetic
   * is done for them. `proposeAnchors` in align.js has been written and tested
   * since the aligner shipped and has never had a caller.
   *
   * The cue starts are converted to the video's clock BEFORE they are offered,
   * which is what makes the answer right under a rate or a staircase: what
   * comes back is then the delta to add rather than an absolute offset computed
   * from a file clock that this track no longer sits on. `nudge` applies it, so
   * the addition happens where the value is - see the note there about reading
   * a value across a frame boundary.
   *
   * The moment is captured when the button is pressed, not when the reader
   * chooses. They are reading eight lines while the film runs on, and an offset
   * measured from when they finished reading would be wrong by however long
   * that took. */
  function anchorChoices(slot = state.keyTrack) {
    const track = state.tracks[slot];
    if (!track?.cues.length || !globalThis.__ssoAlign?.proposeAnchors) return null;
    const at = streamNowMs();
    if (!Number.isFinite(at)) return null;

    const shown = track.cues.map((cue) => ({
      start: streamTimeMs(track, cue.start, state.adDriftMs),
      text: cue.text,
    }));
    /* Every line, not only the eight nearest.
     *
     * Reported: "sometimes we are completely lost and want to find the exact
     * line with searching for a phrase or word". Eight lines within thirty
     * seconds is the right offer when the subtitle is nearly right, and the
     * subtitle that is nearly right is not the one being fixed - a file that
     * is four minutes out has nothing within thirty seconds of the playhead
     * to choose between. So the whole file goes to the panel in its own
     * order, each line with what picking it would do, and the eight nearest
     * are marked rather than being the whole answer. One call through
     * proposeAnchors with no window and no limit, so every line's arithmetic
     * is the arithmetic the nearest eight always had. */
    const every = globalThis.__ssoAlign.proposeAnchors(at, shown, {
      windowMs: Infinity,
      limit: Infinity,
    });
    if (!every.length) return null;
    const near = new Set(
      every
        .filter((line) => Math.abs(line.offsetMs) <= 30000)
        .slice(0, 8)
        .map((line) => line.index),
    );
    const lines = every
      .sort((x, y) => x.index - y.index)
      .map((line) => ({
        index: line.index,
        startMs: line.startMs,
        text: line.text,
        // What to ADD, not where to land. See above.
        moveMs: line.offsetMs,
        near: near.has(line.index),
      }));
    return {
      atMs: Math.round(at),
      slot,
      lines,
      // The eight nearest, as before, for anything still reading them.
      choices: lines.filter((line) => line.near),
    };
  }

  /* Relative, and that is the point of it existing beside setOffset.
   *
   * The held nudge buttons repeat every 80ms, and the panel drawing them may
   * be in a different frame from the offset they are moving - where reading a
   * value, adding a step and sending the sum means every repeat after the
   * first computes from the number before the previous one. Asking for the
   * step instead of the sum has no such window: the addition happens where the
   * value is. */
  const nudge = (deltaMs, { slot = state.keyTrack, quiet = false, how = "nudge" } = {}) =>
    setOffset(state.tracks[slot].offsetMs + deltaMs, { slot, quiet, how });

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
  /* How many corrections are remembered. Eight was enough for a line through
   * two of them; the median of their pairwise slopes gets steadier with every
   * point it has, and the busiest sitting in the log made 109. The cost is the
   * pair loop above, which at this cap is 276 divisions when somebody nudges. */
  const DRIFT_MAX_NOTES = 24;
  /* The shortest gap between two corrections that can say anything about a
   * slope. See the pair loop in driftEstimate. */
  const DRIFT_PAIR_MIN_MS = 300000;

  /* --- what a correction was made against ------------------------------------
   *
   * Reported after an episode of The Americans: "I needed to correct the sync
   * multiple times". Nothing in this extension could say where those
   * corrections were made, by how much, or what was on screen when they were -
   * the offset is a single number that the next correction overwrites, and the
   * corrections list above is in memory and dies with the tab. So the one
   * measurement that matters most was the one thing never recorded.
   *
   * A correction IS a measurement: at this moment of the film, this subtitle
   * was this many milliseconds out, by the ear of somebody watching it. A
   * session of them is the true offset sampled as a function of film time,
   * which is the shape neither the aligner (one number for the whole file, from
   * the other subtitle) nor the drift estimator (a straight line through two
   * points) can see. Several corrections that do not fall on one line say the
   * file was cut, and where.
   *
   * What makes each sample checkable afterwards is the LINE it was made
   * against. The numbers alone cannot be replayed against files that may not
   * even be on this machine; a cue index, its time in its own file, and the
   * first words of it can be matched to any copy of that subtitle. */
  /* --- which line in the other subtitle says the same thing --------------------
   *
   * Reported as "the study panel could match wrong EN-TR sentence pairs", and
   * it did, because the pair was whatever the other track happened to be
   * SHOWING at the instant a word was marked. That is the wrong question. The
   * two subtitlers cut the dialogue into different lines - measured on this
   * corpus: 1173 English cues against 915 Turkish, 114 Turkish lines merging
   * two English ones, and a median 505ms between the nearest starts - so at the
   * moment an English line begins, the Turkish line on screen is very often
   * still the previous sentence. A word marked in the first half-second of a
   * line got the sentence before it, quoted with no hedge.
   *
   * The right question is which lines cover the same STRETCH of the film, so
   * this takes the marked line's whole span and returns every line of the other
   * track that overlaps it, in order. A Turkish line that merges two English
   * ones is the answer to both of them; an English line spanning two Turkish
   * ones gets both, joined.
   *
   * Both sides are converted to the stream clock rather than compared in their
   * own file clocks, because two tracks with different offsets, rates or acts
   * do not share a timeline until they are.
   */
  /* How far off a line may be and still be offered when NOTHING overlaps. A
   * gap between two lines is ordinary - one speaker stops, the translation of
   * the next has not started - and the nearest line is nearly always the right
   * one. It is returned with `overlapMs: 0` so the caller can say so; quoting
   * it as confidently as a real overlap is the defect this is fixing. */
  const PAIR_NEAR_MS = 1500;
  /* The file-clock window to search before converting anything. Offsets and
   * acts move a track by seconds, so a generous slack around the plain inverse
   * covers them, and it keeps this a scan of a few cues rather than of the
   * file. It is slack, not a guarantee: what stops a line being missed is the
   * reach bisection below, not this number. */
  const PAIR_SLACK_MS = 45000;

  function cuesOverlappingStream(track, slot, fromStreamMs, toStreamMs) {
    const cues = track.cues || [];
    if (!cues.length) return [];

    const rate = track.rate || 1;
    const plainFrom = (fromStreamMs - track.offsetMs - state.adDriftMs) / rate - PAIR_SLACK_MS;
    const plainTo = (toStreamMs - track.offsetMs - state.adDriftMs) / rate + PAIR_SLACK_MS;

    /* First line that could still be on screen, over how far the file has
     * REACHED rather than over the ends themselves. The ends are not sorted -
     * a sign held across the dialogue under it ends after the lines that start
     * later - so bisecting them can step past a line that is still up and
     * leave it out of the pair. The slack above hid it: measured across the
     * 182 subtitles in the repository the worst end-inversion is 2,602ms
     * against 45,000ms of slack, so nothing in reach of this corpus triggers
     * it. A file with a four-minute caption over dialogue would, and one with
     * a 231,680ms cue is already in there. */
    const { reach } = cueSpansFor(slot);
    let low = 0;
    let high = cues.length - 1;
    let first = cues.length;
    while (low <= high) {
      const mid = (low + high) >> 1;
      if (reach[mid] >= plainFrom) {
        first = mid;
        high = mid - 1;
      } else {
        low = mid + 1;
      }
    }

    const found = [];
    let nearest = null;
    for (let index = first; index < cues.length && cues[index].start <= plainTo; index++) {
      const start = streamTimeMs(track, cues[index].start);
      const end = streamTimeMs(track, cues[index].end);
      const overlap = Math.min(toStreamMs, end) - Math.max(fromStreamMs, start);
      if (overlap > 0) {
        found.push({ cue: cues[index], overlapMs: Math.round(overlap) });
        continue;
      }
      // How far outside the span it sits, for the fallback below.
      const away = start > toStreamMs ? start - toStreamMs : fromStreamMs - end;
      if (away <= PAIR_NEAR_MS && (!nearest || away < nearest.away)) {
        nearest = { cue: cues[index], overlapMs: 0, away };
      }
    }
    if (found.length) return found;
    return nearest ? [{ cue: nearest.cue, overlapMs: 0 }] : [];
  }

  function cueUnder(track, fileMs) {
    const cues = track.cues || [];
    if (!cues.length || !Number.isFinite(fileMs)) return null;

    // The last line that has started, by bisection - this runs from a pointer
    // gesture on a file of a thousand lines.
    let low = 0;
    let high = cues.length - 1;
    let started = -1;
    while (low <= high) {
      const mid = (low + high) >> 1;
      if (cues[mid].start <= fileMs) {
        started = mid;
        low = mid + 1;
      } else {
        high = mid - 1;
      }
    }

    /* Whichever of the line just gone and the line coming is nearer. A
     * correction made in a silence - which is most of them, because a reader
     * notices the gap between hearing and reading - still names the exchange it
     * was about, and `awayMs` says how far from it they were. */
    const awayFrom = (i) => {
      if (i < 0 || i >= cues.length) return Infinity;
      const cue = cues[i];
      return fileMs < cue.start ? cue.start - fileMs : Math.max(0, fileMs - cue.end);
    };
    const i = awayFrom(started) <= awayFrom(started + 1) ? started : started + 1;
    if (i < 0 || i >= cues.length) return null;
    const cue = cues[i];
    return {
      i,
      startMs: Math.round(cue.start),
      endMs: Math.round(cue.end),
      awayMs: Math.round(awayFrom(i)),
      // Enough to find the same line in another copy of the file, not the whole
      // script: the log is read by somebody who has the file.
      text: String(cue.text || "").replace(/<[^>]*>/g, "").replace(/\s+/g, " ").trim().slice(0, 90),
    };
  }

  function traceCorrection(track, slot, { how, wasOffsetMs, wasRate }) {
    const streamMs = streamNowMs();
    if (!Number.isFinite(streamMs)) return;
    trace("sync", {
      how,
      slot,
      // Where in the film, and where in this file - two different clocks, and
      // the gap between them is the thing being corrected.
      streamMs: Math.round(streamMs),
      fileMs: Math.round(filmTimeMs(track)),
      fromMs: Math.round(wasOffsetMs),
      toMs: track.offsetMs,
      byMs: track.offsetMs - Math.round(wasOffsetMs),
      rate: track.rate,
      wasRate,
      adDriftMs: Math.round(state.adDriftMs || 0),
      duration: filmSeconds(),
      /* Every attached subtitle, not only the one that moved. Whether the other
       * one was already right at that moment is the difference between "this
       * file is out" and "these two files disagree", and only one of those is
       * something an aligner comparing them could ever have found. */
      tracks: state.tracks.map((other, index) => (
        other.cues.length
          ? {
            slot: index,
            fileId: other.fileId,
            language: other.language,
            label: other.label,
            offsetMs: other.offsetMs,
            rate: other.rate,
            cueCount: other.cues.length,
            cue: cueUnder(other, filmTimeMs(other)),
          }
          : null
      )).filter(Boolean),
    });
  }

  /* Did this film need more than one answer?
   *
   * The same two points offerDrift measures its slope from, asked a simpler
   * question: not how fast the file runs, but whether the correction the reader
   * settled on at the end is the one they settled on at the start. It is not a
   * question about a rate, so it does not care whether the drift was ever named
   * or fixed - only whether one number described the whole film. That is
   * exactly the claim `rememberTiming` makes when it carries a timing onto the
   * next episode. */
  function correctionsDrifted(track) {
    const notes = track.corrections;
    if (notes.length < 2) return false;
    /* By film time, not by the order they were made in. See the same reading in
     * driftEstimate: a reader corrects minute 44 and then minute 1, and asking
     * the first and last entries of the list what the film did gives an answer
     * about the reader's route through it. */
    let early = notes[0];
    let late = notes[0];
    for (const note of notes) {
      if (note.fileMs < early.fileMs) early = note;
      if (note.fileMs > late.fileMs) late = note;
    }
    const spanMs = late.fileMs - early.fileMs;
    // Too little of the film to tell, which is not the same as steady.
    if (!(spanMs >= (globalThis.__ssoAlign?.RATE_MIN_SPAN_MS ?? 1200000))) return false;
    return Math.abs(late.offsetMs - early.offsetMs) >= DRIFT_WORTH_SAYING_MS;
  }

  function noteCorrection(track, slot) {
    const durationMs = (filmSeconds() || 0) * 1000;
    if (!Number.isFinite(durationMs) || durationMs <= 0) return;
    const fileMs = filmTimeMs(track);
    if (!Number.isFinite(fileMs)) return;

    track.corrections.push({ fileMs, offsetMs: track.offsetMs });
    /* Past the cap, drop the SECOND oldest rather than the first.
     *
     * The estimate is a straight line through the earliest correction and the
     * latest, so shift() threw away the one point that gives the line its span
     * - the opposite of what the note beside DRIFT_MAX_NOTES says it is for.
     * After eight nudges the span collapsed toward the recent few and a real
     * drift stopped clearing the twenty-minute bar a rate needs. */
    if (track.corrections.length > DRIFT_MAX_NOTES) track.corrections.splice(1, 1);
    offerDrift(track, slot);
    /* And again, because the correction is state that surfaces show.
     *
     * setOffset notifies before it gets here, so the round that a correction
     * triggers is the one round that cannot see it. Nothing depended on that
     * while the drift was only ever a toast raised from inside this function;
     * the card reads it off status(), and with the film paused - which is
     * exactly when a reader is fixing the sync - there is no later round to
     * carry it. */
    notify();
  }

  /* The drift this file's corrections describe, or null while they describe
   * none. A measurement rather than a message, so the toast that announces it
   * once and the control that stands on the card cannot disagree about what it
   * says or about whether there is anything to say. */
  function driftEstimate(track) {
    // Cheapest first: this runs on every status(), twenty times a second, and
    // almost every call has nothing to measure.
    if (!track || track.corrections.length < 2) return null;
    const durationMs = (filmSeconds() || 0) * 1000;
    if (!Number.isFinite(durationMs) || durationMs <= 0) return null;
    /* How much of the FILM the corrections cover, not how far apart the first
     * and the last one happen to sit in the list.
     *
     * They are in the order they were made, and a reader does not correct a
     * film front to back. The running log is full of the other order - one
     * sitting goes 44m, 44m, 1m, 2m, 9m, 0m, 1m - so first-to-last was
     * routinely a few minutes, or negative, and this gate then threw away a
     * measurement made across the whole episode. A subtitle corrected at
     * minute 2 and again at minute 44 has been measured over 42 minutes
     * whichever one the reader did first. */
    let low = Infinity;
    let high = -Infinity;
    for (const note of track.corrections) {
      if (note.fileMs < low) low = note.fileMs;
      if (note.fileMs > high) high = note.fileMs;
    }
    const spanMs = high - low;
    // The most recent one, which is the line the reader last aimed at by hand
    // and the one applyTrackDrift has to leave where they put it.
    const last = track.corrections[track.corrections.length - 1];
    /* Far enough apart to extrapolate from - the aligner's own bar, for the
     * same reason. Two nudges a minute apart measure the reader's patience. */
    if (!(spanMs >= (globalThis.__ssoAlign?.RATE_MIN_SPAN_MS ?? 1200000))) return null;

    /* The slope of the corrections, taken as the median of every pairwise
     * slope among them rather than as the line through the first and the last.
     *
     * Read out of the running log. Over 880 by-hand corrections in 63 sittings
     * a reader aiming at one value scatters it badly - seven corrections inside
     * one minute of "Experimental Prototype City of Tomorrow" ran 13.4, 13.5,
     * 12.9, 10.5, 10.6, 10.2 and 10.5 seconds - and a two-point line takes one
     * point out of that scatter as gospel. The first correction was worse: the
     * eviction rule keeps it forever, and the log holds first corrections of
     * +105.4s and -47.1s made while somebody was hunting for the right value.
     *
     * A median of pairwise slopes is unmoved by up to a third of the points
     * being anywhere at all, which is what those excursions are. It costs one
     * pass over a few hundred pairs, on a path that runs when a reader nudges
     * rather than when a film plays.
     *
     * What it is measuring is real and is what this whole feature is for: every
     * one of the ten most-corrected sittings in the log has a systematic slope,
     * from 0.02% of the clock to 0.86% - 100 to 520ms of drift per minute of
     * film, which is 4.6 to 23 seconds by the end of a 45-minute episode. In
     * all 880 corrections the rate was changed 6 times. */
    const slopes = [];
    for (let i = 0; i < track.corrections.length; i++) {
      for (let j = i + 1; j < track.corrections.length; j++) {
        const gap = track.corrections[j].fileMs - track.corrections[i].fileMs;
        /* Two corrections at nearly the same moment say nothing about a slope
         * and divide by nearly nothing while saying it: a three-second scatter
         * a minute apart reads as five percent. */
        if (gap < DRIFT_PAIR_MIN_MS) continue;
        slopes.push((track.corrections[j].offsetMs - track.corrections[i].offsetMs) / gap);
      }
    }
    if (!slopes.length) return null;
    slopes.sort((a, b) => a - b);
    const mid = slopes.length >> 1;
    const slope = slopes.length % 2 ? slopes[mid] : (slopes[mid - 1] + slopes[mid]) / 2;

    const rate = track.rate + slope;
    if (!(rate > 0)) return null;
    // Would leaving it alone cost anything by the end? Two nudges that happen
    // to differ are taste, not drift.
    if (Math.abs(rate - track.rate) * durationMs < DRIFT_WORTH_SAYING_MS) return null;

    /* A framerate conversion if one accounts for it, because then the number
     * stops being a measurement and becomes a known ratio - and saying which
     * one tells the reader this will happen to every file from that release.
     * The bar is that the named ratio explains the drift to within a second by
     * the end, which is inside what an offset can mop up. */
    const named = (globalThis.__ssoAlign?.RATES || [])
      .filter((candidate) => candidate !== 1)
      .find((candidate) => Math.abs(rate - candidate) * durationMs <= DRIFT_EXPLAINED_MS);
    const fixed = named ?? rate;

    return {
      rate: fixed,
      named: Boolean(named),
      percent: Number(Math.abs((fixed - 1) * 100).toFixed(1)),
      fast: fixed > 1,
      /* What leaving it costs by the credits, which is the unit the reader
       * lives in and the one both gates above are written in. */
      byMs: Math.round(Math.abs(fixed - track.rate) * durationMs),
      atMs: last.fileMs,
      offsetMs: last.offsetMs,
    };
  }

  function offerDrift(track, slot) {
    // Once. A reader who declines has declined; a second toast saying the same
    // thing is the film interrupting them to repeat itself. The card carries it
    // for as long as it is true, which is the surface a decline leaves alone.
    if (track.driftOffered) return;
    const drift = driftEstimate(track);
    if (!drift) return;

    track.driftOffered = true;
    const way = drift.fast ? "fast" : "slow";
    showToast(
      drift.named
        ? `Subtitle running ${drift.percent}% ${way} — a framerate mismatch, not a delay`
        : `Subtitle drifting ${drift.percent}% ${way} across the film`,
      { action: { label: "Fix the drift", onClick: () => applyTrackDrift(slot) } },
    );
  }

  /* Apply the speed and keep the line the reader last lined up where they put
   * it. Speed alone would move every line including that one, so the correction
   * they just made by ear would be undone by the button offering to help.
   *
   * It re-measures rather than being handed an answer, because the two callers
   * are a toast raised at one moment and a control on the card pressed at
   * another, and by the second one the reader may have corrected the film
   * twice more. Returns what it did, so the panel can say so. */
  function applyTrackDrift(slot = state.keyTrack) {
    const track = state.tracks[slot];
    const drift = driftEstimate(track);
    if (!drift) return null;
    const offsetMs = drift.offsetMs + (track.rate - drift.rate) * drift.atMs;
    setRate(drift.rate, { slot });
    setOffset(offsetMs, { slot, quiet: true, byHand: false });
    return drift;
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

    /* Through the api rather than the functions behind it, because a keystroke
     * lands in whichever document has focus and on a nested player that is
     * usually the top frame - which has no subtitle of its own to move. The
     * api is the thing that knows where the film is, and status() is asked for
     * the same reason: `state` here would answer about an empty document.
     *
     * The toasts stay in the frame the key was pressed in, which is where the
     * reader is looking. */
    const api = window.__ssoApi;
    const seen = status();

    if (isKey(typed, keys.togglePanel)) {
      window.__ssoPanel?.toggle();
    } else if (!seen.attached) {
      handled = false; // the rest only make sense with something attached
    } else if (isKey(typed, keys.earlier)) {
      api.nudge(-step, { how: "key" });
    } else if (isKey(typed, keys.later)) {
      api.nudge(step, { how: "key" });
    } else if (isKey(typed, keys.prevLine)) {
      // Forwarded it answers with a promise rather than "there was a line to
      // step to", so the key counts as handled either way.
      handled = Boolean(api.stepLine(-1));
    } else if (isKey(typed, keys.nextLine)) {
      handled = Boolean(api.stepLine(1));
    } else if (event.key === "Escape" && seen.placing) {
      api.setPlacing(false);
    } else if (isKey(typed, keys.reset)) {
      // All three, because a subtitle that has been stretched, or cut into
      // acts, is not back to the file's own timing until those go too.
      api.setRate(1, { quiet: true, how: "reset" });
      api.setSteps([]);
      /* The lead carries the others here too, and it has to: putting the first
       * subtitle back on its file's own timing without moving the second one
       * would leave the pair out by however far the first one travelled. The
       * second keeps its own distance from the first, which is exactly what
       * its offset means. */
      const carried = seen.leadSlot !== null && seen.keyTrack === seen.leadSlot;
      api.setOffset(0, { quiet: true, how: "reset" });
      showToast(
        carried
          ? "Subtitle back to the file's own timing · the other moved with it"
          : "Subtitle back to the file's own timing",
      );
    } else if (isKey(typed, keys.toggleOverlay)) {
      api.setVisible(!seen.visible);
      showToast(seen.visible ? "Subtitles hidden" : "Subtitles shown");
    } else if (isKey(typed, keys.toggleStudy)) {
      handled = Boolean(api.toggleStudy());
    } else if (isKey(typed, keys.saveWord)) {
      handled = Boolean(api.saveTopWord());
    } else {
      handled = false;
    }

    if (handled) {
      event.preventDefault();
      event.stopPropagation();
    }
  }

  // --- a subtitle being made ----------------------------------------------------

  /* A translation the daemon is making for this tab, followed to the end.
   *
   * The job itself lives in the daemon - started once, resumed across its
   * restarts, finished whether or not anybody is watching - and this is the
   * watching: a poll every few seconds, and the file attached the moment any
   * of it exists. The lines the model has not reached yet are the source's,
   * so the box on screen is readable throughout and the other language
   * arrives under the reader's eyes rather than in one piece at the end.
   *
   * The generated file's id is known from the start (the daemon derives it
   * from the source and the language), so the first partial attach is under
   * the same id the finished file will have: any nudge the reader makes while
   * it is being made is the finished file's offset too. Everything that
   * changes the film goes through attach() the first time and swaps the cues
   * in place after that, because attach() also resets the corrections and
   * re-arranges the boxes, and a subtitle that grows is still one subtitle. */
  const TRANSLATE_POLL_MS = 4000;
  let translating = null;
  let translateTimer = null;

  function daemonCall(op, args) {
    /* The { transportError } shape is load-bearing - every caller checks it
     * and none of them can catch, being click handlers. An orphaned context
     * has to answer in the same shape rather than in a rejection or a null,
     * or the reader gets a control that silently does nothing. */
    if (!alive()) return Promise.resolve({ transportError: "Extension context invalidated" });
    try {
      return chrome.runtime
        .sendMessage({ type: "sso:daemon", op, args })
        .catch((error) => ({ transportError: String(error?.message || error) }));
    } catch (error) {
      orphan();
      return Promise.resolve({ transportError: String(error?.message || error) });
    }
  }

  function translationSummary() {
    if (!translating) return null;
    const { job, slot, sourceSlot, sourceLanguage, target, done, total, status, etaSeconds, model, error, unrepaired, missing, retrying } = translating;
    return { job, slot, sourceSlot, sourceLanguage, target, done, total, status, etaSeconds, model, error, unrepaired, missing, retrying };
  }

  /* The slot a made subtitle goes in: the one that is not the source, empty
   * first. With both full and neither the source, the first of them is
   * replaced, which the panel says before it happens. */
  function slotForTranslation(sourceSlot) {
    const others = state.tracks.map((_, index) => index).filter((index) => index !== sourceSlot);
    return others.find((index) => state.tracks[index].cues.length === 0) ?? others[0] ?? PRIMARY;
  }

  /* A cue's text with its markup back on, for the model to carry across.
   *
   * The cues here are the overlay's: `text` is the dialogue with the tags
   * removed, and the styling lives in `runs`. A translation made from `text`
   * alone loses every italic in the film - the whispered line, the voice on
   * the radio - so the tags are put back around each styled run and sent. A
   * model that echoes them gives a file with the italics where they were; one
   * that drops them gives what sending plain text would have. */
  function cueMarkup(cue) {
    if (!Array.isArray(cue.runs) || !cue.runs.length) return cue.text;
    return cue.runs
      .map((run) => {
        const styles = Array.isArray(run.styles) ? run.styles : [];
        let out = run.text;
        if (styles.includes("b")) out = `<b>${out}</b>`;
        if (styles.includes("i")) out = `<i>${out}</i>`;
        return out;
      })
      .join("");
  }

  async function startTranslation({ sourceSlot, target, slot = null } = {}) {
    const source = state.tracks[sourceSlot];
    if (!source?.cues.length) return { error: "There is no subtitle in that slot to translate" };
    const into = slot ?? slotForTranslation(sourceSlot);
    if (translating && !["done", "failed", "cancelled"].includes(translating.status)) {
      return { error: "A subtitle is already being made for this tab" };
    }
    const context = (await daemonCall("pageContext", {})) || {};
    const started = await daemonCall("translate", {
      body: {
        source_id: String(source.fileId ?? `slot-${sourceSlot}`),
        language: source.language || "en",
        target,
        cues: source.cues.map((cue) => ({ start: cue.start, end: cue.end, text: cueMarkup(cue) })),
        imdb_id: context.imdbId ?? undefined,
        movie_name: context.title ?? undefined,
        season: context.season ?? undefined,
        episode: context.episode ?? undefined,
        label: source.label,
      },
    });
    if (!started || started.transportError || started.error) {
      const why = started?.transportError || started?.error || "the daemon did not answer";
      showToast(`Could not start the translation: ${why}`);
      return { error: why };
    }
    translating = {
      job: started.job,
      slot: into,
      sourceSlot,
      sourceLanguage: (source.language || "en").toLowerCase(),
      target: target.toLowerCase(),
      fileId: started.generated_file_id,
      done: started.done,
      total: started.total,
      status: started.status,
      etaSeconds: started.eta_seconds,
      model: started.model,
      unrepaired: started.unrepaired,
      missing: started.missing,
      error: "",
      shown: -1,
    };
    trace("translate", {
      job: started.job, target, sourceSlot, slot: into, sourceFileId: source.fileId,
      cueCount: source.cues.length, model: started.model, status: started.status, etaSeconds: started.eta_seconds,
    });
    notify();
    scheduleTranslationPoll(0);
    return translationSummary();
  }

  /* A job started elsewhere - another tab, an earlier visit - attached to this
   * one as it arrives. The panel lists the daemon's jobs and offers this. */
  async function followTranslation({ job, target, sourceLanguage = "", slot = null } = {}) {
    const status = await daemonCall("translateStatus", { job, cues: false });
    if (!status || status.transportError || status.error) {
      return { error: status?.transportError || status?.error || "no such translation" };
    }
    translating = {
      job,
      slot: slot ?? slotForTranslation(-1),
      sourceSlot: null,
      sourceLanguage: (sourceLanguage || status.source_language || "").toLowerCase(),
      target: (target || status.target || "").toLowerCase(),
      fileId: status.generated_file_id,
      done: status.done, total: status.total, status: status.status, etaSeconds: status.eta_seconds,
      model: status.model, unrepaired: status.unrepaired, missing: status.missing, retrying: Boolean(status.retrying),
      error: "", shown: -1,
    };
    notify();
    scheduleTranslationPoll(0);
    return translationSummary();
  }

  /* Go on with a job: a stopped one from where it stopped, a finished one
   * with the lines it kept in the source language. Then followed like any
   * other, from a clean slate - `shown` starts over, so what the retry lands
   * is put on screen even though the count of made lines does not grow. */
  async function resumeTranslation({ job, target, sourceLanguage = "", slot = null } = {}) {
    const resumed = await daemonCall("translateResume", { job });
    if (!resumed || resumed.transportError || resumed.error) {
      return { error: resumed?.transportError || resumed?.error || "no such translation" };
    }
    trace("translate", { job, resumed: true, status: resumed.status, done: resumed.done, total: resumed.total, retrying: Boolean(resumed.retrying) });
    return followTranslation({ job, target, sourceLanguage, slot: slot ?? translating?.slot ?? null });
  }

  async function cancelTranslation() {
    if (!translating) return { error: "nothing is being made" };
    const answer = await daemonCall("translateCancel", { job: translating.job });
    trace("translate", { job: translating.job, cancelled: true, done: translating.done, total: translating.total });
    clearTimeout(translateTimer);
    translateTimer = null;
    translating = null;
    notify();
    return answer?.error ? { error: answer.error } : { ok: true };
  }

  function scheduleTranslationPoll(delay) {
    clearTimeout(translateTimer);
    translateTimer = setTimeout(() => {
      pollTranslation().catch(() => {});
    }, delay);
  }

  async function pollTranslation() {
    if (!translating || !alive()) return;
    const mine = translating;
    const status = await daemonCall("translateStatus", { job: mine.job, cues: false });
    if (translating !== mine) return;
    if (!status || status.transportError) {
      // The daemon is down or restarting. The job survives that; keep asking.
      mine.error = status?.transportError || "the daemon did not answer";
      notify();
      scheduleTranslationPoll(TRANSLATE_POLL_MS * 3);
      return;
    }
    if (status.error) {
      mine.status = "failed";
      mine.error = String(status.error);
      showToast(`The ${mine.target.toUpperCase()} subtitle could not be made: ${status.error}`);
      notify();
      return;
    }
    Object.assign(mine, {
      done: status.done, total: status.total, status: status.status, etaSeconds: status.eta_seconds,
      model: status.model, unrepaired: status.unrepaired, missing: status.missing, retrying: Boolean(status.retrying), error: "",
    });
    if (status.done > mine.shown || (status.status === "done" && mine.shown < status.total)) {
      const full = await daemonCall("translateStatus", { job: mine.job, cues: true });
      if (translating !== mine) return;
      if (Array.isArray(full?.cues) && full.cues.length) {
        await putTranslated(mine, full.cues);
        mine.shown = status.done;
      }
    }
    notify();
    if (status.status === "done") {
      const kept = (status.unrepaired || 0) + (status.missing || 0);
      showToast(
        `${mine.target.toUpperCase()} subtitle finished: ${status.total} lines` +
          (kept ? `, ${kept} left in ${mine.sourceLanguage.toUpperCase()}` : ""),
      );
      trace("translate", { job: mine.job, finished: true, total: status.total, unrepaired: status.unrepaired, missing: status.missing, model: status.model });
      return;
    }
    if (status.status === "failed" || status.status === "cancelled") {
      if (status.status === "failed") showToast(`The ${mine.target.toUpperCase()} subtitle stopped: ${status.error || "the model gave up"}`);
      return;
    }
    scheduleTranslationPoll(TRANSLATE_POLL_MS);
  }

  /* The offer, where the extension notices a second language is wanted.
   *
   * Study is the case: its rail translates each word into the OTHER attached
   * subtitle's language, and its cards quote that subtitle's line, so with one
   * subtitle on screen half of what study does has nothing to work from. Said
   * as a toast with the one button that is the confirmation, because nothing
   * is spent until it is pressed - a whole file through a model on this
   * machine is ten minutes of it running warm.
   *
   * Honest first: the search is free and cached, so before offering to make a
   * subtitle it asks whether one already exists. If it does, the offer is to
   * open Find; making a translation of a film somebody has already subtitled
   * would be the poorer file, slower. */
  async function offerTranslation({ reason = "" } = {}) {
    if (translating && !["done", "failed", "cancelled"].includes(translating.status)) return null;
    const attached = attachedTracks();
    if (!attached.length) return null;
    const short = (code) => String(code || "").toLowerCase().slice(0, 2);
    const languages = ((await daemonCall("languages", {}))?.languages || []).map(short).filter(Boolean);
    const have = new Set(attached.map((track) => short(track.language)));
    const target = languages.find((code) => !have.has(code));
    if (!target) return null;
    const source = attached.find((track) => short(track.language) && !isGeneratedFile(track.fileId)) || attached[0];
    const sourceSlot = state.tracks.indexOf(source);
    const from = short(source.language || "en").toUpperCase();
    const context = (await daemonCall("pageContext", {})) || {};
    const found = await daemonCall("search", {
      title: context.title || document.title,
      imdb_id: context.imdbId ?? undefined,
      altTitles: context.altTitles ?? undefined,
      year: context.year ?? undefined,
      season: context.season ?? undefined,
      episode: context.episode ?? undefined,
      languages: [target],
    });
    const rows = (found?.results || []).filter((row) => short(row.language) === target);
    const offer = { reason, target, sourceSlot, existing: rows.length };
    if (rows.length) {
      showToast(
        `Study reads better with a ${target.toUpperCase()} line under the ${from}: OpenSubtitles has ${rows.length} for this.`,
        { action: { label: "Find one", onClick: () => window.__ssoPanel?.openFind?.(slotForTranslation(sourceSlot)) } },
      );
      trace("translateOffer", { ...offer, offered: "find" });
      return offer;
    }
    const health = (await daemonCall("health", {})) || {};
    const model = health.translate_model || "the local model";
    const minutes = Math.max(1, Math.round((source.cues.length * (Number(health.translate_seconds_per_cue) || 0.5)) / 60));
    showToast(
      `No ${target.toUpperCase()} subtitle exists for this. Make one from the ${from} with ${model}, about ${minutes} min? The lines appear as they are made.`,
      {
        action: {
          label: "Make it",
          onClick: () => {
            startTranslation({ sourceSlot, target }).catch((error) => {
              showToast(`The translation did not start - ${error?.message || error}`);
            });
          },
        },
      },
    );
    trace("translateOffer", { ...offer, offered: "make", model, minutes });
    return offer;
  }

  /* A file this daemon made, by its id. The daemon files them above 9e13;
   * see translate_jobs.py. Never a source to translate FROM. */
  function isGeneratedFile(fileId) {
    return typeof fileId === "number" && fileId >= 90_000_000_000_000;
  }

  function translationLabel(mine) {
    const from = `made from ${mine.sourceLanguage.toUpperCase()}`;
    if (mine.status === "done") return `${mine.target.toUpperCase()} · ${from} by ${mine.model}`;
    const percent = mine.total ? Math.round((100 * mine.done) / mine.total) : 0;
    return `${mine.target.toUpperCase()} · ${from} · ${percent}%`;
  }

  async function putTranslated(mine, cues) {
    const track = state.tracks[mine.slot];
    if (track.fileId !== mine.fileId || track.cues.length === 0) {
      await attach({ cues, label: translationLabel(mine), fileId: mine.fileId, language: mine.target, slot: mine.slot });
      /* Said after the attach, whose own toast would otherwise cover it: a
       * second subtitle appearing on its own after a reload wants a reason. */
      if (mine.pickedUp) {
        mine.pickedUp = false;
        showToast(`Going on with the ${mine.target.toUpperCase()} subtitle being made for this: ${mine.done} of ${mine.total} lines so far.`);
      }
      return;
    }
    /* In place: the same file, more of it translated. See attach for what a
     * fresh attach would reset, none of which has changed. */
    track.cues = cues;
    track.label = translationLabel(mine);
    track.activeIndexes = NEEDS_REDRAW;
    lastStepMs = null;
    notify();
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
    /* A different file means the mark the last press aimed at is not this
     * file's mark. See stepLine, which reads it to tell a second press of the
     * pair from a first. */
    lastStepMs = null;
    track.label = label || "";
    track.fileId = fileId ?? null;
    track.language = language || "";
    const timing = await loadOffset(track.fileId);
    track.offsetMs = timing.offsetMs;
    track.rate = timing.rate;
    track.steps = timing.steps ?? [];
    track.activeIndexes = NEEDS_REDRAW;
    track.visible = true;
    /* Both drift measurements belong to the file that has just been replaced.
     *
     * A correction is "at this moment of THIS file, the reader put it here",
     * and a moment of the last file says nothing about this one - so keeping
     * the list means the slope is fitted across two subtitles that have never
     * shared a timeline. `driftOffered` is worse, because it is the flag that
     * says the offer has been made: kept, the second film of an evening can
     * never be told it is drifting, and the reader spends it correcting by
     * hand. Read out of the running log: 25 films whose own corrections meet
     * the bar against 33 offers made, which is not even the same shape of
     * number, because both of these outlived the file they were measured on. */
    track.corrections = [];
    track.driftOffered = false;
    /* Ad time is NOT cleared here, and that is the whole point of it being on
     * `state` rather than on a track.
     *
     * It used to be, along with `inAd`, which quietly destroyed the correction
     * belonging to whatever was already on screen. Measured: an ad break that
     * advanced the stream by 90 seconds is detected and held as 90000ms;
     * attaching a second subtitle to the empty slot put it back to 0, and the
     * first subtitle - which had been correct - was ninety seconds out with
     * nothing on screen saying why. It reads as "the sync broke when I added
     * the second language", and on a server-side-ad-inserted stream with a
     * dual-language setup that is the ordinary path, not an edge of one.
     *
     * An advert interrupts the video. What it belongs to is this playback of
     * this programme, so that is what clears it - see noticeProgrammeChange.
     * `inAd` is pollAdState's to own for the same reason: clearing it in the
     * middle of a break makes the break look like it started at the attach,
     * and the measured length comes out short. */
    state.visible = true;
    state.video = pickVideo();

    /* Which file landed in which slot, with the timing it was given. "The
     * wrong subtitle attached" and "the right one attached at the wrong
     * offset" look identical from outside and have nothing in common. */
    trace("attach", {
      slot: index,
      label: track.label,
      fileId: track.fileId,
      language: track.language,
      cueCount: track.cues.length,
      offsetMs: track.offsetMs,
      rate: track.rate,
      timingWasKnown: timing.known,
      duration: filmSeconds(),
      firstCueMs: track.cues[0]?.start ?? null,
      lastCueMs: track.cues[track.cues.length - 1]?.start ?? null,
    });

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
    sendToWorker({ type: "sso:attached" });
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

    if (aligned?.applied && !track.offsetMs && track.rate === 1 && track.steps.length < 2) {
      /* The aligner ran, agreed with the file, and changed nothing. Saying
       * "lined up matching the file" - which is what the sentence below prints
       * for an offset of zero - reads as a correction that was not made, and
       * offers an Undo for it. Observed on two subtitles cut to the same
       * release, which is the ordinary case for a pair downloaded together. */
      showToast(`${said}, already in step`);
    } else if (aligned?.applied) {
      /* The acts get named, because the number in the sentence is the FIRST
       * act's and the last one can be half a minute further out. A reader told
       * "+1.0s" who then checks the closing scene finds it thirty seconds off
       * and concludes the tool is broken, when what it did was handle exactly
       * that. Undo still clears the base offset only; the acts go with the
       * reset key or the card's clear, which say what they are. */
      const acts = track.steps.length > 1 ? ` in ${track.steps.length} acts` : "";
      showToast(
        `${said}, lined up${acts} with subtitle ${aligned.referenceSlot + 1} · ` +
        `${describeOffset(track.offsetMs)}${acts ? " at the start" : ""}`,
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
    /* Not awaited: a job the daemon is still working for this file is
     * picked up in the background, and the attach is over either way. */
    if (!isGeneratedFile(fileId)) pickUpTranslation(fileId).catch(() => {});
    return { ok: true, cueCount: track.cues.length, slot: index, aligned };
  }

  /* A translation the daemon is still making for the subtitle just attached,
   * followed again after a reload.
   *
   * The job outlives the tab, and the tab that started it is the only one
   * that was following it: reload the page - which is what a reader does when
   * the player stalls, and what the next episode does for them - and the
   * lines went on landing in the daemon with nothing on screen to receive
   * them, until the reader found the "Attach it as it arrives" button on the
   * Find screen. So every attach of a file that is not itself a made one
   * asks whether a job is being made from it: the job's source is the file's
   * id, and a page's own track has a stable id too. One request to the
   * daemon per attach, and never over a job this tab is already following. */
  async function pickUpTranslation(fileId) {
    if (fileId == null) return null;
    if (translating && !["done", "failed", "cancelled"].includes(translating.status)) return null;
    const listed = await daemonCall("translations", {});
    const jobs = (listed?.jobs || []).filter((job) => job.status === "queued" || job.status === "running");
    if (!jobs.length) return null;
    const attached = attachedTracks();
    const ids = new Set(attached.map((track) => String(track.fileId)));
    const job = jobs.find((job) => ids.has(String(job.source_id)));
    if (!job) return null;
    const sourceSlot = state.tracks.findIndex((track) => String(track.fileId) === String(job.source_id));
    const summary = await followTranslation({
      job: job.job, target: job.target, sourceLanguage: job.source_language, slot: slotForTranslation(sourceSlot),
    });
    if (summary?.error) return summary;
    if (translating?.job === job.job) translating.pickedUp = true;
    trace("translate", { job: job.job, pickedUp: true, fileId, done: job.done, total: job.total });
    return summary;
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
    writeStored({ [USED_LANGUAGES_KEY]: used });
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

    const referenceTimes = reference.cues.map((cue) => cue.start);
    const targetTimes = target.cues.map((cue) => cue.start);
    /* `alignSteps` rather than `align`, which is the same answer plus where
     * each ACT of the target lands. Two releases of one broadcast episode keep
     * different amounts of black around the advertising breaks, so they agree
     * within an act and jump between them, and one shift cannot fit both sides
     * of a jump. It returns a one-entry list whenever one shift is right, which
     * over 91 such pairs in bench/align it did every time. */
    const answer = aligner.alignSteps(referenceTimes, targetTimes);

    /* The attempt, whichever way it went, with the two things that decided it.
     *
     * Whether two subtitle files can be lined up is a property of their cue
     * times and nothing else, so an attempt that failed is only reproducible
     * with the times that failed. Reading the aligner cannot substitute for
     * the pair it could not match, and asking for the two .srt files after the
     * fact means asking somebody to find files the extension already had. */
    trace("align", {
      slot,
      referenceSlot,
      answer,
      tracks: [
        { slot: referenceSlot, ...describeTrackForTrace(reference) },
        { slot, ...describeTrackForTrace(target) },
      ],
    });

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

    /* The same composition again for the acts.
     *
     * A break the aligner reports sits at a moment of the REFERENCE file, and
     * the target's list is indexed by the target's own clock, so each one is
     * carried across the mapping it came from: `tB = rate * tA + shift + s`.
     * The offset each act needs is the reference's own act offset less the
     * gap's, scaled by the target's rate - which is the offset line above with
     * the per-act terms left in rather than dropped.
     *
     * The first entry falls out as zero, because the aligner reports its acts
     * against its own base and `offsetMs` has already absorbed that base. */
    const steps = (answer.steps ?? []).length > 1
      ? answer.steps.map((step) => ({
        fromMs: Math.round(answer.rate * step.fromMs + answer.shiftMs + step.offsetMs),
        offsetMs: Math.round(stepOffsetMs(reference, step.fromMs) - rate * step.offsetMs),
      }))
      : [];

    const applied = answer.verdict === "apply";
    if (applied) {
      if (rate !== 1) setRate(rate, { slot, quiet: true, byHand: false });
      // Before setOffset, which is what writes the timing down.
      target.steps = tidySteps(steps);
      setOffset(offsetMs, { slot, quiet: true, byHand: false });
    }
    /* `applied` rather than each caller re-deriving it from the verdict. Two of
     * them did, and the one that decides whether to fall back to the release
     * memory has to agree with the one that writes the toast - or the reader is
     * told a correction was carried over and shown a different one. */
    return { ...answer, referenceSlot, offsetMs, trackRate: rate, steps, applied };
  }

  /** Drop one track, or every track when no slot is named. */
  function detach(slot) {
    trace("detach", {
      slot: slot ?? null,
      tracks: state.tracks.map((track, index) => ({
        slot: index,
        label: track.label,
        fileId: track.fileId,
        cueCount: track.cues.length,
      })),
    });
    lastStepMs = null;
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
  const lastRemoved = () =>
    removed && { slot: removed.slot, label: removed.track.label, at: removed.at };

  /* Move a subtitle to another number - the subtitle travels, the place stays.
   *
   * Asked for as: "I normally add EN as #1 and TR as #2. But I added TR as #1
   * by mistake. Now I should either remove it and add EN as #1 first, or add EN
   * as #2 and then move it to the position #1."
   *
   * So the two halves of a subtitle come apart here, and which half is which is
   * the whole design. Everything about the FILE moves with it: its cues, its
   * offset, its rate, its acts, its language, whether it is hidden, whether the
   * keys point at it, whether its words are being learnt. Everything about the
   * PLACE stays: where the box sits, how wide it is, its colour, its font, its
   * size, where its strip of words is. Those live in `settings.tracks[slot]`,
   * which this deliberately never touches - number one is a place on the
   * screen that has been arranged to be read first, and a subtitle arriving
   * there should look like the thing that was there.
   *
   * Written as a move rather than a swap, so a third subtitle would work the
   * way a list works, and every number in between shifts by one.
   */
  function reorderTracks(from, to) {
    const a = clamp(Number(from) || 0, 0, TRACK_COUNT - 1);
    const b = clamp(Number(to) || 0, 0, TRACK_COUNT - 1);
    if (a === b) return { ok: false, reason: "same slot" };

    /* Which slot each subtitle ended up in, built the same way the tracks are
     * moved. Everything else that names a slot is remapped through it, so the
     * arithmetic exists once rather than once per caller. */
    const order = state.tracks.map((_, slot) => slot);
    order.splice(b, 0, ...order.splice(a, 1));
    const now = (was) => {
      const at = order.indexOf(was);
      return at < 0 ? was : at;
    };

    state.tracks.splice(b, 0, ...state.tracks.splice(a, 1));
    const moved = state.tracks[b];

    state.keyTrack = now(state.keyTrack);
    // The stash is "the subtitle that was in slot N", and N has moved.
    if (removed) removed = { ...removed, slot: now(removed.slot) };
    /* The words being marked, and the strips they are marked into, are per
     * subtitle number on both sides of the gap. Study keeps its own copy of
     * which numbers it is following, so it is told rather than guessed at. */
    window.__ssoStudy?.reorderSlots?.(order);

    for (const track of state.tracks) track.activeIndexes = NEEDS_REDRAW;
    // Cleared rather than left to the next tick: two boxes holding each
    // other's line for 50ms is exactly the frame somebody looks at.
    for (const view of views) view.cueBox.textContent = "";
    syncRootVisibility();
    trace("reorder", {
      from: a,
      to: b,
      tracks: state.tracks.map((track, slot) => ({ slot, label: track.label, fileId: track.fileId })),
    });
    if (moved.cues.length) showToast(`${moved.label || "That subtitle"} is subtitle ${b + 1} now`);
    notify();
    return { ok: true, slot: b };
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
      state.tracks[index].activeIndexes = NEEDS_REDRAW;
    }
  }

  /* Status is the one shape three other files read - the panel, the popup and
   * the service worker. The per-track detail is in `tracks`; the flat fields
   * above it describe the primary, or the only, subtitle, so a caller that
   * only wants to say "attached, 1183 lines" does not have to know there can
   * be two. */
  /* Status has one caller shape and two sources. In the frame drawing controls
   * for a video in another frame there is nothing local to report, so the
   * answer is what was last pushed across - and it says so, because the worker
   * has to be able to tell that frame from the one holding the film. */
  function status() {
    return role === "chrome" ? mirroredStatus() : localStatus();
  }

  function localStatus() {
    const attached = attachedTracks();
    const lead = attached[0] || state.tracks[PRIMARY];
    return {
      hasVideo: hasPlayableVideo(),
      // Not the same question. See videoComing.
      videoComing: videoComing(),
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
        steps: track.steps ?? [],
        label: track.label,
        fileId: track.fileId,
        language: track.language,
        visible: track.visible,
        /* What this file's own corrections say about its speed, for the control
         * that offers to fix it. A single toast, offered once and half an hour
         * into the film, was the only way to reach the one correction that
         * stops the reader making all the others. */
        drift: driftEstimate(track),
      })),
      /* Which programme the page has settled on, for the surfaces that are
       * ABOUT the film rather than about the picture. The panel's Find screen
       * is one: its box and its list of results belong to one episode, and it
       * had no way of noticing that a different one had started under it. */
      programme: settledProgramme,
      /* The same programme in words, for the surfaces that have to SAY which
       * film this is rather than notice that it changed. See describeFilm: ""
       * where the page only guessed, which is most of the web. */
      film: settledFilm,
      keyTrack: state.keyTrack,
      // Which subtitle moves the others with it. See carryFollowers.
      leadSlot: leadSlot(),
      placing: state.placing,
      adDriftMs: state.adDriftMs,
      inAd: state.inAd,
      visible: state.visible,
      settings: state.settings,
      currentTime: state.video ? streamNowMs() / 1000 : null,
      duration: filmSeconds(),
      // What the page carries for itself, if it told us. See onPageSubtitles.
      own: pageSubtitleSummary(),
      // A subtitle being made for this tab, if one is. See startTranslation.
      translation: translationSummary(),
    };
  }

  /* Starts AND ends, because the ends are what the aligner does not yet get.
   *
   * It is handed cue starts and nothing else, which is the right primitive for
   * the same subtitle retimed and the wrong one for two languages: the two
   * subtitlers break the same dialogue into different lines, so a line's start
   * in one file often has no counterpart in the other. Measured across the
   * repository's corpus, comparing WHEN THERE IS TEXT ON SCREEN instead lifts
   * the marginal cross-language pairs from 1.14 and 1.28 times the wrong-film
   * ceiling to 2.68 and 2.02. Nothing can be done with that unless the ends
   * were kept at the time, so they are kept. */
  const describeTrackForTrace = (track) => ({
    label: track.label,
    fileId: track.fileId,
    language: track.language,
    cueCount: track.cues.length,
    offsetMs: track.offsetMs,
    rate: track.rate,
    /* Whole numbers, not a count. "The reader corrected at 22 minutes" and
     * "the third act starts at 21:40 and is 6.9 seconds further out" are the
     * same fact from two sides, and only one of them is in the trace unless
     * the acts are written down with their times. */
    steps: track.steps ?? [],
    times: packTimes(track.cues.map((cue) => cue.start)),
    ends: packTimes(track.cues.map((cue) => cue.end)),
  });

  /* Gaps rather than times: a thousand starts of up to eight digits each,
   * against gaps of three or four. Same numbers, a third of the size, and the
   * size is what decides how many attempts can be kept. trace.js unpacks. */
  function packTimes(times) {
    const out = [];
    let previous = 0;
    for (const time of times) {
      const value = Math.round(time);
      out.push(value - previous);
      previous = value;
    }
    return out;
  }

  /** When this subtitle speaks, in the file's own clock, without the words. */
  function cueTimesFor(slot) {
    return (state.tracks[slot]?.cues || []).map((cue) => cue.start);
  }

  /* The same lines, with the two facts a start cannot carry: how long each one
   * is on screen, and how much it says.
   *
   * The panel's strip drew every cue as a 2px tick at its start, which says
   * where somebody speaks and nothing about what happens next. Two files cut
   * differently - one subtitler splitting a long exchange into four lines where
   * the other keeps two - produce two completely different tick patterns from
   * the same dialogue, so the eye had nothing to match. A line's DURATION and
   * its LENGTH survive that split: four short lines still fill the same stretch
   * of film and still add up to the same amount of text. That is what makes two
   * strips comparable, which is the whole reason they sit one above the other.
   *
   * Three parallel arrays rather than an array of objects, because this crosses
   * the frame gap as JSON on every file change and 900 three-key objects cost
   * about four times what three arrays of 900 numbers do. */
  /* Built once per file, not once per read.
   *
   * The strip asks for this on every draw, and draw runs on every status round
   * - measured at 21.5 times a second per subtitle with a film playing. Three
   * fresh 1100-element arrays each time is 140,000 numbers a second handed
   * straight to the collector, for a value that only changes when a different
   * file is attached. The cues themselves never change under a track: attach
   * replaces the array, which is exactly what the key notices. */
  const spansCache = new Map();

  function cueSpansFor(slot) {
    const cues = state.tracks[slot]?.cues || [];
    const cached = spansCache.get(slot);
    if (cached && cached.cues === cues) return cached.spans;
    const starts = new Array(cues.length);
    const ends = new Array(cues.length);
    const chars = new Array(cues.length);
    /* How far the file has reached by each line: the running maximum of the
     * ends. Sorted by construction, which the ends themselves are not - a sign
     * or a song lyric held across the dialogue under it ends long after the
     * lines that started later - and everything that looks for "the first line
     * still on screen at this moment" bisects it. See firstReaching in
     * panel.js for what that costs when it is missing. */
    const reach = new Array(cues.length);
    let furthest = -Infinity;
    for (let i = 0; i < cues.length; i++) {
      starts[i] = cues[i].start;
      ends[i] = cues[i].end;
      chars[i] = (cues[i].text || "").length;
      const until = Number.isFinite(ends[i]) ? ends[i] : starts[i];
      if (until > furthest) furthest = until;
      reach[i] = furthest;
    }
    const spans = { starts, ends, chars, reach };
    spansCache.set(slot, { cues, spans });
    return spans;
  }

  const NO_SPANS = { starts: [], ends: [], chars: [], reach: [] };

  /* The same lines with only their text, cached the same way and for the same
   * reason.
   *
   * Study mode's name test is the caller, and whether "Adama" is a name is not
   * a question one line can answer - it is answered by how the word is spelt
   * across the whole film. Asked once per cue with a film playing, so the array
   * is built once per file and handed back by reference; study.js uses that
   * reference as its own cache key, which is what makes attaching a different
   * file drop the old answer without anything having to notice the attach. */
  const textsCache = new Map();

  function cueTextsFor(slot) {
    const cues = state.tracks[slot]?.cues || [];
    const cached = textsCache.get(slot);
    if (cached && cached.cues === cues) return cached.texts;
    const texts = cues.map((cue) => cue.text || "");
    textsCache.set(slot, { cues, texts });
    return texts;
  }

  const NO_TEXTS = [];

  function notify() {
    writeStripTags();
    pushMirror();
    for (const listener of listeners) {
      try {
        listener(status());
      } catch {
        // A broken subscriber must not stop playback rendering.
      }
    }
  }

  // --- the other frame ------------------------------------------------------

  /* Where the film is, and where the controls are, when those are not the same
   * document.
   *
   * Sites that embed a player from another host paint over the frame they put
   * it in. Measured on streaming-site.example: an <iframe> appended to <html>, fixed,
   * inset 0, z-index 2147483647, swallowing every click on the page. The top
   * layer is per document, so nothing drawn inside the player's frame can get
   * above that - the frame itself is behind it. The CC button was visible and
   * every press went to the site.
   *
   * So the two frames divide the work. This one keeps the subtitles if it has
   * the video, because that is where the picture is and where a word has to be
   * clicked; the top frame draws the button and the panel, because that is the
   * document being painted in. They cannot see each other - different origins -
   * so the service worker carries every word, and the frame with the video
   * pushes its state across so the panel up there is not blind.
   *
   * On the ordinary page, where the video is in the top frame, `role` stays
   * "solo" and not a line of this runs.
   */
  let claimedSubject = null; // video frame: what was last reported, so it is said once

  /* Tell the worker whether this frame holds the film, and take the answer.
   *
   * The answer is not a formality. Being told "video" means the top frame
   * accepted the job of drawing the button, so this frame stops drawing one.
   * Being told "solo" - because the top frame has no content script, or is an
   * extension page, or refused - means nobody else will, so this frame keeps
   * it. One button either way, and never none.
   */
  /* Fullscreen undoes the whole reason the controls went up to the top frame.
   *
   * Only the fullscreen element's subtree is painted and only it is given
   * pointer events, so while the film's frame is fullscreen the page's overlay
   * is not on screen at all - and nothing the top document draws can be
   * pressed, whatever elementsFromPoint says about it. So the film's frame
   * stops claiming, which hands the controls straight back to it, where its
   * own fullscreen handling has always put them inside the session. */
  const inFullscreenHere = () =>
    Boolean(document.fullscreenElement || document.webkitFullscreenElement);

  function reportFrameRole() {
    if (window === window.top) return; // the top frame is told; it does not claim
    const subject = isPageSubject(pickVideoCached()) && !inFullscreenHere();
    if (subject === claimedSubject) return;
    claimedSubject = subject;
    sendToWorker({ type: "sso:frameRole", hasSubject: subject })
      .then((reply) => {
        const was = role;
        role = reply?.role === "video" ? "video" : "solo";
        // The top frame's button is the one now; take this frame's away
        // rather than leaving two of them on screen until it times out.
        if (role === "video" && handle) handle.dataset.visible = "false";
        if (role === "video" && was !== "video") handBackPanel();
      })
      .catch(() => {
        role = "solo";
      });
  }

  /* A panel opened in fullscreen, handed back on the way out.
   *
   * Reported as: open the panel while the film is fullscreen, leave fullscreen,
   * and the panel is trapped inside the player's rectangle and clipped at its
   * edges, so it cannot be dragged anywhere else.
   *
   * It is not a clipping bug. While the film's frame is fullscreen it stops
   * claiming to hold the subject - see reportFrameRole - which hands the whole
   * job back to it, so the panel opened in fullscreen is BUILT in the player's
   * frame. Leaving fullscreen gives the controls back to the top frame, and the
   * panel stays where it was built: inside an iframe, which is one box in its
   * parent's layout and cannot paint outside it. No z-index and no top layer
   * can lift it out, because the top layer is per document.
   *
   * So it moves rather than being freed. This frame closes the one it drew and
   * asks the frame that now draws the controls to open its own. The position is
   * a stored setting, so it comes back where the reader put it. */
  function handBackPanel() {
    if (!window.__ssoPanel?.isOpen?.()) return;
    window.__ssoPanel.hide();
    sendToWorker({ type: "sso:toChrome", message: { type: "sso:showPanel" } });
  }

  /* How often the video frame's state crosses the gap.
   *
   * Every push is a structured clone through the service worker, and the tick
   * that would trigger one runs twenty times a second. 150ms is under the
   * threshold where a readout looks laggy and is a fifth of the traffic.
   *
   * Slower with nothing attached, for the same reason the tick itself is: the
   * playhead is then on nobody's screen, and a message per tick would keep the
   * service worker resident for the life of the tab to report a number no
   * surface is reading. It cannot stop altogether - the silence is what tells
   * the other frame the player has gone. */
  const MIRROR_MS = 150;
  const IDLE_MIRROR_MS = 1000;
  let mirrorAt = 0;
  let mirrorTimer = null;
  let mirrorSignature = "";

  function pushMirror() {
    if (role !== "video") return;
    clearTimeout(mirrorTimer);
    mirrorTimer = null;
    const wait = (anyAttached() ? MIRROR_MS : IDLE_MIRROR_MS) - (Date.now() - mirrorAt);
    if (wait > 0) {
      mirrorTimer = setTimeout(pushMirror, wait);
      return;
    }
    mirrorAt = Date.now();

    const snapshot = localStatus();
    /* The cue times are the expensive part - a thousand numbers per track - and
     * they change only when a different file is attached, never with the
     * playhead. So they ride the change rather than the clock. Timing is not in
     * the signature on purpose: the times are in the file's own clock, and the
     * offset and rate that turn them into stream time travel in the status. */
    const signature = snapshot.tracks.map((track) => `${track.fileId}:${track.cueCount}`).join("|");
    const heavy = signature !== mirrorSignature;
    mirrorSignature = signature;

    sendToWorker({
      type: "sso:toChrome",
      message: {
        type: "sso:mirror",
        status: snapshot,
        removed: lastRemoved() || null,
        // The panel's Study button and the "learning" chip on each card read
        // this, and it lives in the frame the rail is drawn in.
        study: window.__ssoStudy?.settings?.() || null,
        cueSpans: heavy ? snapshot.tracks.map((_, slot) => cueSpansFor(slot)) : null,
      },
    })
      .then((reply) => {
        /* A top frame that no longer thinks it draws the controls.
         *
         * It is replaced whenever the extension updates under an open tab, and
         * a fresh copy starts out "solo" knowing nothing - so it drops the
         * push, and there is no button on the page and nothing pushing it
         * back. Forgetting the claim makes the next tick say it all again. */
        if (!reply?.ok) claimedSubject = null;
      })
      .catch(() => {
        claimedSubject = null;
      });
  }

  /* The pointer summoning a button in a document it never enters.
   *
   * Moving the mouse over a nested player raises no event in the top frame at
   * all - events do not cross a frame boundary - so the button up there would
   * appear only when the pointer happened to be outside the video. Once every
   * half second is enough to keep it up while a hand is moving, and it stops
   * the moment the hand does. */
  const POKE_MS = 500;
  let pokedAt = 0;

  function pokeChrome() {
    if (role !== "video") return;
    const now = Date.now();
    if (now - pokedAt < POKE_MS) return;
    pokedAt = now;
    sendToWorker({ type: "sso:toChrome", message: { type: "sso:pointerAlive" } });
  }

  // --- being the frame that draws the controls ------------------------------

  /* What the chrome frame knows, which is only what has been sent to it. */
  let mirror = null;
  let mirrorSettings = ""; // so an unchanged settings object is not re-applied
  let mirrorSeenAt = 0;
  // Which frame the held mirror describes, so it is only thrown away when the
  // film actually moves. See setFrameRole.
  let mirrorFrameId = null;
  /* How long a silence means the video's frame is gone.
   *
   * It pushes at least once a second while it is there, so three seconds of
   * nothing is not a quiet moment - it is a frame that navigated, or a player
   * the site tore out. Left alone the button would stay on a page with no film
   * behind it, and every press would open a panel reporting a video that is
   * not there. */
  const MIRROR_SILENCE_MS = 3000;

  function setFrameRole(next, frameId) {
    if (next === "chrome") {
      videoFrameId = frameId ?? null;
      if (role === "chrome") return;
      role = "chrome";
      /* Thrown away only when the film is in a different frame than the one
       * the held mirror came from.
       *
       * It used to be cleared on every claim, and the claim comes back on
       * every exit from fullscreen: the player's frame stops claiming the
       * subject while it is fullscreen - see reportFrameRole - so the top
       * frame drops to solo and takes the job again on the way out. With the
       * mirror gone, status() answered out of THIS document, which holds no
       * film and no tracks, so the panel handed straight back by
       * handBackPanel drew "No video on this page" over an empty list until
       * the next push landed, and then two subtitles appeared. Reported as
       * "once the list is empty, and next moment it has two subtitles".
       *
       * The film's frame going quiet for a moment is not evidence that the
       * subtitles went away. A push is at most 150ms behind while something
       * is attached, and three seconds of silence still drops this frame to
       * solo, so nothing here can outlive the film it describes. */
      if (mirrorFrameId !== videoFrameId) {
        mirror = null;
        mirrorSettings = "";
      }
      mirrorFrameId = videoFrameId;
      // The clock starts now, not at whatever the last arrangement left
      // behind, or the silence check below would fire before the first push.
      mirrorSeenAt = Date.now();
      /* The button, straight away rather than on the next pointer move. The
       * frame that told us has a film in it, which is the whole condition for
       * showing one. */
      ensureOverlay();
      revealHandle();
      askForMirror();
      return;
    }
    if (role !== "chrome") return;
    role = "solo";
    videoFrameId = null;
    /* The mirror is kept, and it costs nothing to keep: status() reads it only
     * while this frame is the one drawing the controls, and going solo is
     * usually the film's frame taking the screen for a moment rather than the
     * film going away. Held for the claim that follows. */
    mirrorSeenAt = 0;
    if (handle) handle.dataset.visible = "false";
    /* Whatever was open here is about a film this frame no longer knows
     * anything about, and on the way into fullscreen it is about to become
     * unreachable as well. Leaving it would put a panel back on screen on the
     * way out of fullscreen that the reader believes they closed, which is the
     * oldest bug in this file. */
    window.__ssoPanel?.hide?.();
    notify();
  }

  /* One tick's worth of keeping the two frames in step, whichever this is.
   *
   * Called from tick() so it runs at the same cadence as everything else, and
   * so the three questions - has my role changed, is my state stale up there,
   * has the film's frame gone quiet - are asked in one place. */
  function mindTheOtherFrame() {
    reportFrameRole();
    if (role === "video") pushMirror();
    if (role === "chrome" && mirrorSeenAt && Date.now() - mirrorSeenAt > MIRROR_SILENCE_MS) {
      setFrameRole("solo");
    }
  }

  function askForMirror() {
    if (role !== "chrome") return;
    sendToWorker({ type: "sso:toVideo", message: { type: "sso:mirrorPlease" } });
  }

  /* Answers whether it was taken, and the answer is load-bearing: a push that
   * lands in a frame no longer drawing the controls is how the sender finds
   * out to claim again. */
  function takeMirror(message) {
    if (role !== "chrome") return false;
    mirror = mirror || { status: null, cueSpans: [], cueTimes: [], removed: null };
    mirror.status = message.status || null;
    mirror.removed = message.removed || null;
    mirror.study = message.study || null;
    mirrorSeenAt = Date.now();
    /* One payload, two readings. The starts are the hot path - the strip's
     * binary search and the aligner both walk them on the playhead tick - so
     * they are pulled out once here rather than through a property lookup a
     * thousand times a second. */
    if (message.cueSpans) {
      mirror.cueSpans = message.cueSpans;
      mirror.cueTimes = message.cueSpans.map((spans) => spans.starts);
    }

    /* The panel reads settings out of the status, but this frame's own keydown
     * handler reads them out of `state`. A binding changed in the panel has to
     * work in the document the reader is typing into, which is this one. */
    const written = JSON.stringify(mirror.status?.settings || null);
    if (mirror.status?.settings && written !== mirrorSettings) {
      mirrorSettings = written;
      state.settings = mirror.status.settings;
      applySettings();
    }

    // The heavy half is only sent when it changes, so a chrome frame that
    // arrived after the change has to say so once.
    const missing = (mirror.status?.tracks || []).some(
      (track, slot) => track.cueCount > 0 && (mirror.cueTimes[slot]?.length ?? 0) !== track.cueCount,
    );
    if (missing) askForMirror();

    notify();
    return true;
  }

  function mirroredStatus() {
    /* Nothing pushed yet is not "no film on this page". This frame draws the
     * controls only because another one said it holds the subject, so
     * answering out of this document - which has no video in it - put "No
     * video on this page" in the panel of a page that was playing one. */
    const base = mirror?.status || { ...localStatus(), hasVideo: true };
    return { ...base, mirrored: true, videoFrameId };
  }

  /* Every api call that changes something about the film, sent to the frame
   * that has it.
   *
   * A list rather than a branch inside each, because the list is the thing
   * worth reading: it is exactly the set of calls that are about the film
   * rather than about this document. Everything not named here - the geometry
   * helpers, the toast, the key capture, the page metadata - is answered where
   * it is asked, because that is where the document is.
   */
  const FORWARDED = [
    "attach",
    "detach",
    "startTranslation",
    "followTranslation",
    "resumeTranslation",
    "cancelTranslation",
    "offerTranslation",
    "reorderTracks",
    "setVisible",
    "setOffset",
    "setRate",
    "setSteps",
    "nudge",
    "snapTiming",
    "anchorChoices",
    "applyTrackDrift",
    "stepLine",
    "updateSettings",
    "updateTrackSettings",
    "resetSettings",
    "resetKeys",
    "resetPosition",
    "setKeyTrack",
    "clearAdDrift",
    "setPlacing",
    "arrange",
    "applyLook",
    "autoAlign",
    "undoRemove",
    "pauseVideo",
    "setStudyEnabled",
    "toggleStudySlot",
    "openStudySettings",
    "cueTextAt",
    "toggleStudy",
    "saveTopWord",
  ];

  /* Never rejects, and that is deliberate.
   *
   * Almost every caller is a click handler that cannot await, so a rejection
   * here would be an unhandled one - invisible, with a control that silently
   * did nothing. The failure is said out loud instead, and the value comes back
   * as null, which is what the two callers that read one already treat as "no
   * answer". */
  function callVideoFrame(method, args) {
    return sendToWorker({ type: "sso:toVideo", message: { type: "sso:call", method, args } })
      .then(
        (reply) => {
          if (reply?.ok) return reply.value ?? null;
          showToast(
            reply
              ? `That did not work - ${reply.reason || "the video refused it"}`
              : "Lost touch with the frame the video is in",
          );
          return null;
        },
        () => {
          showToast("Lost touch with the frame the video is in");
          return null;
        },
      );
  }

  /* Write something down, for a question nobody has asked yet.
   *
   * Never awaited and never able to fail loudly: this is a note in the margin,
   * and a note that breaks the thing it is describing is worse than no note.
   * `frames` asks the worker to gather the shape of the page as well, which
   * only it can do - so the page says what happened and the worker says where.
   */
  /* Anything that reached the top of this frame, which is the class of failure
   * that presents as a control doing nothing.
   *
   * A page's console is not evidence: nobody has it open during a film, it is
   * per frame, and on a nested player the interesting frame is not the one
   * anybody would think to open it on. */
  /* Whose error it is.
   *
   * A window listener catches the PAGE's errors as well as ours - the two share
   * a window even though the scripts do not share a world - and the log has no
   * way to tell them apart once they are written down. One day's log held
   * twelve, of which the ones that read most alarmingly ("ResizeObserver loop
   * completed with undelivered notifications") were chat.google.com's own, from
   * a tab with no film in it. Reading them as the extension's cost real time.
   *
   * An extension script's filename is under the extension's own origin, which
   * nothing on the page can be. Captured once at load, because getURL is a
   * chrome call and would itself throw in the case that matters most. */
  const OUR_FILES = (() => {
    try {
      return chrome.runtime.getURL("");
    } catch {
      return "chrome-extension://";
    }
  })();
  const oursByFile = (file) => Boolean(file) && String(file).startsWith(OUR_FILES);

  const onWindowError = (event) => {
    const file = String(event.filename || "");
    trace("error", {
      where: window === window.top ? "top frame" : "frame",
      mine: oursByFile(file) || oursByFile(event.error?.stack),
      url: location.href,
      message: String(event.message || event.error?.message || event.error || "error"),
      stack: String(event.error?.stack || "").slice(0, 2000),
      file: `${file}:${event.lineno || 0}`,
    });
  };
  const onRejection = (event) => {
    const stack = String(event.reason?.stack || "");
    trace("error", {
      where: window === window.top ? "top frame" : "frame",
      // A rejection carries no filename, so the stack is the only witness.
      mine: stack.includes(OUR_FILES),
      url: location.href,
      unhandledRejection: true,
      message: String(event.reason?.message || event.reason || "rejection"),
      stack: stack.slice(0, 2000),
    });
  };
  window.addEventListener("error", onWindowError);
  window.addEventListener("unhandledrejection", onRejection);

  /* Where the time goes, measured on the page it goes wrong on.
   *
   * The vehicle in tests/frames is one video and three short documents, and the
   * extension costs single-digit milliseconds a second on it. That says nothing
   * about a streaming site carrying five frames of player, adverts and its own
   * scripts, which is where the freezes are reported - so the numbers that
   * decide anything have to come from there.
   *
   * A freeze IS a long task: one turn of the event loop that ran past 50ms and
   * took the frame, the click and the video's own bookkeeping with it. So long
   * tasks are what this counts, with the extension's two hot paths timed beside
   * them, because "the page stalled" and "we stalled it" are different claims
   * and the second one needs its own number.
   *
   * A quiet window sends nothing at all. Ten seconds with no long task in them
   * produce no line, which is what keeps this from becoming the next thing
   * filling the log. */
  const PERF_MS = 10000;
  const PERF_ZERO = {
    long: 0, longMs: 0, worst: 0, ticks: 0, tickMs: 0, moves: 0, moveMs: 0, cues: 0, arranged: 0,
    /* The panel's share, which nothing here could see before.
     *
     * A freeze was reported as "the subtitle map is freezing and dragging it
     * becomes terribly hard", and the sample had no way to answer it: the
     * panel and the map run in this world and cost nothing this counted, so a
     * window full of long tasks looked the same whether the panel was drawing
     * or the page was. Reproducing it needs the reader's machine - on the
     * catalogue app with two 900-cue subtitles, study mode on, a real
     * compositor and a 2x display, the drag holds 60fps with two dropped
     * frames in five seconds, which is not what was described. So the numbers
     * have to come from where it happens, which is what the note above this
     * whole block already says about long tasks. */
    panels: 0, panelMs: 0, maps: 0, mapMs: 0, drags: 0,
  };
  const perf = { ...PERF_ZERO };
  let perfAt = Date.now();
  try {
    new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) {
        perf.long += 1;
        perf.longMs += entry.duration;
        if (entry.duration > perf.worst) perf.worst = entry.duration;
      }
    }).observe({ entryTypes: ["longtask"] });
  } catch {
    // Not every engine reports them. The rest of the sample is still worth
    // having, it just never has a reason to be sent.
  }

  function samplePerf() {
    const now = Date.now();
    if (now - perfAt < PERF_MS) return;
    const over = (now - perfAt) / 1000;
    perfAt = now;
    const seen = { ...perf };
    Object.assign(perf, PERF_ZERO);
    if (!seen.long) return;
    /* Not from a tab nobody is looking at.
     *
     * A background tab has its timers clamped to about one a minute, so the
     * window is sixty seconds rather than ten and the long task in it is mostly
     * the tab waking up and doing a minute of deferred work in one go. That is
     * a fact about throttling, not about this extension, and it drowns the
     * question the sample was added to answer.
     *
     * Measured over the first day of samples: 405 of 505 windows reported
     * over:60, and 495 of 505 had nothing attached - so the probe was almost
     * entirely describing tabs with no film in them. The counters are still
     * reset, so a tab that comes back to the front starts from zero rather than
     * reporting the whole time it spent hidden. */
    if (document.visibilityState === "hidden") return;
    trace("perf", {
      role,
      over: Math.round(over),
      // What the page did: how many turns of the loop ran long, how much of the
      // window they took between them, and the worst single one.
      long: seen.long,
      longMs: Math.round(seen.longMs),
      worst: Math.round(seen.worst),
      // What WE did inside that, so the two can be told apart.
      ticks: seen.ticks,
      tickMs: Math.round(seen.tickMs),
      moves: seen.moves,
      moveMs: Math.round(seen.moveMs),
      cues: seen.cues,
      arranged: seen.arranged,
      // The panel's share of it: status rounds it redrew, strips it repainted,
      // and how many of those repaints a drag on a map asked for.
      panels: seen.panels,
      panelMs: Math.round(seen.panelMs),
      maps: seen.maps,
      mapMs: Math.round(seen.mapMs),
      drags: seen.drags,
      attached: anyAttached(),
      study: Boolean(window.__ssoStudy?.settings?.().enabled),
      panel: Boolean(window.__ssoPanel?.isOpen?.()),
      full: Boolean(document.fullscreenElement),
      frames: window.top === window ? "top" : "nested",
    });
  }

  function trace(kind, detail, { frames = false } = {}) {
    // Checked here as well as in the worker, so switching it off also stops
    // the messages, not only what is done with them.
    if (state.settings.diagnostics === false) return;
    sendToWorker({ type: "sso:daemon", op: "trace", args: { kind, detail, frames } });
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
      /* With the URLs, which status() leaves out: this is the worker about to
       * fetch one, and the only place the signed URL travels. */
      case "sso:pageSubtitles":
        sendResponse(pageSubtitles);
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
        nudge(Number(message.deltaMs) || 0, { slot, how: "command" });
        sendResponse({ ok: true, offsetMs: state.tracks[slot].offsetMs });
        return false;
      }

      case "sso:clearAdDrift":
        forgetAdDrift();
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

      /* Show, not toggle. This arrives from the film's frame when it stops
       * drawing the controls with a panel still open - leaving fullscreen - and
       * a toggle would close the panel it is asking us to take over. */
      case "sso:showPanel":
        window.__ssoPanel?.show();
        sendResponse({ ok: Boolean(window.__ssoPanel) });
        return false;

      // --- the two frames talking to each other ---------------------------

      case "sso:frameRole":
        setFrameRole(message.role, message.videoFrameId);
        sendResponse({ ok: true });
        return false;

      case "sso:mirror":
        sendResponse({ ok: takeMirror(message) });
        return false;

      case "sso:mirrorPlease":
        // A chrome frame that arrived after the last change, asking for the
        // half that only travels when it changes.
        mirrorSignature = "";
        mirrorAt = 0;
        pushMirror();
        sendResponse({ ok: true });
        return false;

      case "sso:pointerAlive":
        if (role === "chrome") {
          ensureOverlay();
          revealHandle();
        }
        sendResponse({ ok: true });
        return false;

      /* The chrome frame asking for something to be done to the film.
       *
       * A named list, not whatever it asks for. This arrives from another frame
       * of a page, and the api holds things that take DOM nodes and build
       * windows; what may cross the gap is the set that takes plain values and
       * is about the film. */
      case "sso:call": {
        if (!FORWARDED.includes(message.method)) {
          sendResponse({ ok: false, reason: `${message.method} is not forwardable` });
          return false;
        }
        try {
          const value = window.__ssoApi[message.method](...(message.args || []));
          Promise.resolve(value).then(
            (settled) => sendResponse({ ok: true, value: settled ?? null }),
            (error) => sendResponse({ ok: false, reason: String(error?.message || error) }),
          );
        } catch (error) {
          sendResponse({ ok: false, reason: String(error?.message || error) });
          return false;
        }
        return true;
      }

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
    startTranslation,
    followTranslation,
    resumeTranslation,
    cancelTranslation,
    offerTranslation,
    reorderTracks,
    setVisible,
    setOffset,
    setRate,
    setSteps,
    nudge,
    snapTiming,
    anchorChoices,
    applyTrackDrift,
    stepLine,
    formatOffset,
    describeOffset,
    // Shared by the panel and the study rail, which are both dragged around a
    // page whose coordinate system is not necessarily the viewport's.
    measurePlacement,
    makeMovable,
    /* The lines a box can be held to, for the gestures this file does not own.
     * makeMovable covers every window's MOVE, but each window builds its own
     * corner grips, so the resize has to be able to ask the same question. */
    guides: { open: openGuides, near: guideNear, show: showGuides, close: closeGuides },
    makeLayer,
    makeWindow,
    // Shared with the panel and the study rail, which have hosts of their own
    // and the same fullscreen problem. See toTopLayer and paintableParent.
    toTopLayer,
    fromTopLayer,
    paintableParent,
    /* Which element a surface has to be inside to take a click right now, or
     * null when nothing is fullscreen. Exported for the same reason
     * paintableParent is: it is not the same question, it is the one with the
     * exceptions in it - an IFRAME does not count, and a fullscreen <video>
     * cannot hold children so the session is moved onto the nearest thing that
     * can. A caller that re-derived it from document.fullscreenElement would
     * get all three of those wrong. */
    fullscreenHolder,
    keepPointersInside,
    setPlacing(on) {
      state.placing = Boolean(on);
      for (const track of state.tracks) track.activeIndexes = NEEDS_REDRAW;
      for (const view of views) {
        view.root.dataset.placing = state.placing ? "true" : "false";
        /* The strips join Place mode, which is the whole reason it exists: a
         * surface that is only visible while it has something in it cannot be
         * put anywhere before it has been used. In placing mode an empty strip
         * shows itself and says which subtitle it belongs to. */
        view.stripRoot.dataset.placing = state.placing ? "true" : "false";
      }
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
      forgetAdDrift();
      notify();
    },
    /* Study mode lives where the cue text is, which on a nested player is not
     * the frame drawing the panel. The panel used to reach `window.__ssoStudy`
     * directly, which only ever finds the copy in its own document - so these
     * three go through the api, where the forwarding already is. */
    studySettings() {
      return (role === "chrome" ? mirror?.study : window.__ssoStudy?.settings?.()) || null;
    },
    setStudyEnabled(on) {
      return window.__ssoStudy?.setEnabled?.(Boolean(on));
    },
    toggleStudySlot(slot) {
      return window.__ssoStudy?.toggleStudySlot?.(slot);
    },
    /* Opens study's own settings window, which lives in the frame the cue text
     * is in rather than the one drawing the panel. */
    openStudySettings() {
      return Boolean(window.__ssoStudy?.openSettings?.());
    },
    toggleStudy() {
      return Boolean(window.__ssoStudy?.toggle?.());
    },
    saveTopWord() {
      return Boolean(window.__ssoStudy?.saveTop?.());
    },
    trace,
    /* For the surfaces that run in this world and are not this file.
     *
     * Timed by the caller because only the caller knows where its own work
     * begins and ends, counted here because this is where the window is and
     * where the sample is sent from. Costs an addition; the sample itself is
     * still sent only when the window held a long task. */
    notePerf(kind, ms) {
      if (kind in perf) perf[kind] += Number.isFinite(ms) ? ms : 1;
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
    removedTrack() {
      return (role === "chrome" ? mirror?.removed : lastRemoved()) || null;
    },
    /* Study mode needs to read the line under a word to save it with its
     * sentence, and the paired line in the other language, which is the whole
     * reason a word is worth saving at all. */
    cueAt(slot) {
      return lastCue(state.tracks[slot]);
    },
    /* One line's text, by its index in the file, for the label the map shows
     * under the pointer.
     *
     * Asked for rather than mirrored. The chrome frame's mirror carries cue
     * TIMES and not text, deliberately - a film's dialogue crossing the frame
     * boundary several times a second to answer a hover nobody has made yet is
     * the wrong trade. A hover is rare and the answer is one string.
     *
     * Null for an index the file does not have, which is what a map drawn
     * against a subtitle that has since been detached will ask for. */
    cueTextAt(slot, index) {
      const cue = state.tracks[slot]?.cues?.[index];
      if (!cue) return null;
      return { text: String(cue.text || ""), startMs: cue.start, endMs: cue.end };
    },
    /* The same moment in every other language, paired by overlap rather than by
     * the playhead. See cuesOverlappingStream. `overlapMs: 0` means nothing
     * actually covered this line and the nearest one is being offered instead -
     * the caller is expected to say so rather than quote it as a translation.
     *
     * Empty in a mirrored frame: the mirror carries cue TIMES, not text, and
     * study runs where the film is. */
    pairedCues(slot, cue) {
      if (role === "chrome" || !cue) return [];
      const own = state.tracks[slot];
      if (!own) return [];
      const from = streamTimeMs(own, cue.start);
      const to = streamTimeMs(own, cue.end);
      const out = [];
      for (let other = 0; other < state.tracks.length; other++) {
        if (other === slot) continue;
        const track = state.tracks[other];
        if (!track?.cues?.length) continue;
        const found = cuesOverlappingStream(track, other, from, to);
        if (!found.length) continue;
        out.push({
          slot: other,
          language: track.language || "",
          label: track.label || "",
          text: found.map((each) => each.cue.text).join(" "),
          overlapMs: found.reduce((sum, each) => sum + each.overlapMs, 0),
          lines: found.length,
        });
      }
      return out;
    },
    /* The lines either side of this one, in its own subtitle.
     *
     * `pairedCues` above answers the other question - what the OTHER language
     * says at this moment - and a word looked up while its line is on screen
     * wants both. This one is what the prefetch already has for free, because
     * it walks the file in order; a lookup made by hand has only the cue, so it
     * asks here rather than the two paths sending the model different context
     * for the same word.
     *
     * By identity, because that is what the caller was handed: renderCues
     * passes the track's own cue objects through, and a search by time would
     * have to decide what to do about two lines that start together. */
    cueNeighbours(slot, cue) {
      if (role === "chrome" || !cue) return { before: "", after: "" };
      const cues = state.tracks[slot]?.cues || [];
      const at = cues.indexOf(cue);
      if (at === -1) return { before: "", after: "" };
      return { before: cues[at - 1]?.text || "", after: cues[at + 1]?.text || "" };
    },
    trackInfo(slot) {
      const track = state.tracks[slot];
      return { label: track.label, fileId: track.fileId, language: track.language };
    },
    /* When this subtitle speaks, in the file's own clock, without the words.
     *
     * Two callers want exactly this and neither wants the text. The timeline
     * strip on each card draws where the dialogue is, so two subtitles out of
     * step read as one pattern displaced from the other. And the finder aligns
     * a candidate against what is already attached before deciding whether to
     * keep it, which it has to do before attaching anything.
     *
     * A fresh array rather than the cue list, because a caller that sorted it
     * in place would silently reorder the track and break the binary search
     * that findCueIndexes depends on. */
    cueTimes(slot) {
      return role === "chrome" ? (mirror?.cueTimes?.[slot] || []).slice() : cueTimesFor(slot);
    },
    cueSpans(slot) {
      return role === "chrome" ? (mirror?.cueSpans?.[slot] || NO_SPANS) : cueSpansFor(slot);
    },
    /* Every line of this subtitle, for the work that needs the file rather than
     * the moment. Empty in a mirrored frame for the reason pairedCues is: the
     * mirror carries cue TIMES, not text, and study runs where the film is. */
    cueTexts(slot) {
      return role === "chrome" ? NO_TEXTS : cueTextsFor(slot);
    },
    /* File clock to stream clock, for a track that may not be attached yet.
     *
     * The strip is drawn against the video's own timeline so every track shares
     * one axis; without this each caller would re-derive `t * rate + offset +
     * adDrift` and one of them would forget the ad drift. */
    toStreamMs(slot, fileMs) {
      const mirrored = role === "chrome";
      const track = (mirrored ? mirror?.status?.tracks : state.tracks)?.[slot];
      if (!track) return fileMs;
      return streamTimeMs(track, fileMs, mirrored ? mirror?.status?.adDriftMs || 0 : state.adDriftMs);
    },
    filmTimeMs() {
      if (role === "chrome") {
        const seen = mirror?.status;
        return seen?.currentTime == null ? null : seen.currentTime * 1000 - (seen.adDriftMs || 0);
      }
      return state.video ? streamNowMs() - state.adDriftMs : null;
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
    /* Where study mode hangs its trail of words: under this subtitle, inside
     * this subtitle's own root.
     *
     * It could have been a floating surface of its own, positioned against the
     * cue box's measured rectangle. It is here instead because the subtitle is
     * dragged, placed against an edge, resized and re-scaled, and a second
     * surface tracking all of that is a second copy of the placement code that
     * would be one frame behind on every one of those gestures. As a sibling of
     * the cue box it simply moves with it, for nothing.
     *
     * A sibling and NOT a child: renderCues empties the cue box for every line
     * of the film, so anything inside it lasts until the next cue. The root is
     * a column anchored by its bottom edge, so the trail holds the anchor line
     * and the dialogue floats above it - see .sso-root in overlay.css. */
    /* Where study.js puts this subtitle's word cards. It owns what goes in;
     * this file owns where the box is, how big it is and when it is shown. */
    studyDock(slot) {
      const view = views?.[slot];
      if (!view) return null;
      return view.stripTrack;
    },

    /* Whether this subtitle's strip is on screen at all. study.js decides -
     * a strip belongs to a subtitle being learnt, and can be put away on its
     * own - and this is where that decision is written, because the box is
     * built here and has to hide itself when study.js is not loaded. */
    showStrip(slot, on) {
      const view = views?.[slot];
      if (!view) return;
      view.stripRoot.dataset.on = on ? "true" : "false";
    },

    stripCount(slot) {
      const view = views?.[slot];
      if (!view) return;
      // The cards, not the one track element that holds them.
      view.stripRoot.dataset.words = String(
        view.stripTrack.querySelectorAll(".sso-trail__word").length,
      );
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
    /* Never rejects, and that is a contract every caller depends on.
     *
     * The worker already answers its own failures as data - `{ transportError }`
     * from the handler's catch - but a failure of the CHANNEL is a rejection
     * from sendMessage itself, and there are two ordinary ways to get one: the
     * extension being reloaded or updated under an open tab ("Extension context
     * invalidated"), and no listener being registered because the worker threw
     * while starting. Every one of the eleven call sites is an `await` inside a
     * function started from a click, so a rejection there was an unhandled
     * rejection with the surface left on whatever it last said - "Searching…"
     * forever, a Try-the-best button disabled for the life of the panel.
     *
     * Answering in the same shape the worker uses means no caller has to learn
     * a second failure mode, and the ones that already check transportError -
     * search, fetch, diagnose, deckSave - report it without changing. */
    /* The guarded chrome APIs, for the two scripts sharing this isolated world.
     *
     * They have their own storage keys and their own messages, so they had
     * their own unguarded `chrome.*` calls and the same synchronous throw
     * waiting in each of them. Exposing the guards rather than letting each
     * file grow a copy keeps the rule in one place: see `alive` at the top. */
    alive,
    toWorker: sendToWorker,
    readStored,
    writeStored,
    daemon: daemonCall,
    /* Start work from somewhere that cannot await it.
     *
     * Every click handler here begins something asynchronous - a message to the
     * worker, a stylesheet fetch, a window that builds itself - and a handler
     * cannot await. A rejection dropped at that boundary is invisible: no
     * toast, nothing in a console the reader would open, and a control that
     * simply does nothing. This is the one place that boundary is crossed, so
     * the failure gets said out loud and names which thing failed rather than
     * being one generic message for every kind. */
    detached(promise, what) {
      Promise.resolve(promise).catch((error) => {
        showToast(`${what} did not work - ${error?.message || error}`);
      });
    },
  };

  /* The api is one shape and answers from two places.
   *
   * In the frame drawing controls for a video that is somewhere else, every
   * call above that changes the film has to happen where the film is. Wrapping
   * once here rather than branching inside twenty methods keeps each of them
   * about the thing it does, and keeps the set that crosses the gap written
   * down in one place - which is also the list the receiving side checks
   * against, so the two cannot drift.
   *
   * When the video is in this frame - which is every ordinary page - the
   * wrapper calls straight through and costs one comparison. */
  for (const name of FORWARDED) {
    const local = window.__ssoApi[name];
    if (typeof local !== "function") throw new Error(`forwarded api has no ${name}`);
    window.__ssoApi[name] = (...args) =>
      role === "chrome" ? callVideoFrame(name, args) : local(...args);
  }

  // --- wiring ---------------------------------------------------------------

  /* The handle only appears where there is something to control, and only
   * while the mouse is moving - so it is never in the way of the film. */
  function onPointerMove() {
    const moveStarted = performance.now();
    perf.moves += 1;
    try {
      onPointerMoveBody();
    } finally {
      perf.moveMs += performance.now() - moveStarted;
    }
  }

  function onPointerMoveBody() {
    /* The frame drawing the controls has no video to gate on - it was told
     * there is one, by the frame that has it. */
    if (role === "chrome") {
      ensureOverlay();
      revealHandle();
      return;
    }
    if (!isPageSubject(pickVideoCached())) return;
    ensureOverlay();
    /* The button is in the top frame now, and a pointer moving in here raises
     * no event up there - events do not cross a frame boundary. So say so,
     * rather than drawing a second button nobody can press. */
    if (role === "video") {
      pokeChrome();
      return;
    }
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

  /* A scroll moves an inline player and announces it to nothing the video
   * observes: the element is the same size, the window is the same size, and
   * only where the box is has changed. Once a frame, because scroll fires as
   * often as the wheel turns and every apply is a layout. */
  let scrollFrame = 0;
  const onScroll = () => {
    if (scrollFrame) return;
    scrollFrame = requestAnimationFrame(() => {
      scrollFrame = 0;
      applySettings();
    });
  };

  for (const type of ["keydown", "keyup", "keypress"]) {
    window.addEventListener(type, keepTypingInside, true);
  }
  /* Before onKeyDown, so a keystroke being read as a binding is taken out of
   * the way first. Both are capture-phase at the document, so this one has to
   * be registered first to run first. */
  document.addEventListener("keydown", onCaptureKey, true);
  document.addEventListener("keydown", onKeyDown, true);
  window.addEventListener("resize", onViewportChange, { passive: true });
  window.addEventListener("scroll", onScroll, { capture: true, passive: true });
  document.addEventListener("fullscreenchange", onViewportChange);
  document.addEventListener("webkitfullscreenchange", onViewportChange);
  document.addEventListener("pointerup", onGlobalPointerEnd, true);
  document.addEventListener("pointercancel", onGlobalPointerEnd, true);
  document.addEventListener("pointermove", onPointerMove, { passive: true, capture: true });
  document.addEventListener("mousemove", onPointerMove, { passive: true, capture: true });
  /* Forced, because entering fullscreen adds the fullscreen element to the top
   * layer after everything already in it - so what was in front is now behind,
   * and only re-entering puts it back. */
  const onFullscreenChange = () => {
    // Before the reparent, so the frame that is about to take the controls
    // back is already the one placing them.
    reportFrameRole();
    /* Forced past the raise throttle. This is the one moment the re-raise is
     * not optional: the fullscreen element joined the top layer after us, so
     * without it every surface stays behind the film. */
    attachToCorrectParent({ raise: true, force: true });
  };
  document.addEventListener("fullscreenchange", onFullscreenChange);
  document.addEventListener("webkitfullscreenchange", onFullscreenChange);

  /* Noticing a new episode at the page's moment rather than at the next tick.
   *
   * The tick is 50ms with subtitles up and 500ms without, and an episode
   * change is very often the second case - the last episode's lines have just
   * come off. Half a second was small next to the 1500ms settle that used to
   * follow it, and it is the whole remaining wait once an announcement removes
   * that settle.
   *
   * Two ways in, because a page may honestly implement either half and neither
   * is load-bearing on its own. The event is what a page dispatches after
   * writing the attribute; the observer catches a page that only writes it.
   * Both call the same function the tick calls, which still runs - so all
   * three agree by construction, and a page that does neither is exactly as
   * well served as before.
   *
   * Attributes only, filtered to the one name. `childList` would have caught
   * an element that arrives with the attribute already on it, and would also
   * have fired this on every DOM insertion a single-page app makes; that case
   * is a page load rather than an episode change, there is nothing attached to
   * be wrong, and the tick has it within one interval. */
  const onAnnouncement = () => {
    if (!state.video || !state.video.isConnected) state.video = pickVideo();
    if (!state.video) return;
    noticeProgrammeChange();
    /* In the same turn as the announcement, not on the next tick. The point of
     * warming the next episode's search is that it happens long before the
     * switch, and a page that announces a new `upNext` mid-film - a season
     * ending, a queue being reordered - has just changed the answer. */
    noticeUpNext();
  };
  document.addEventListener("sso:nowplaying", onAnnouncement, true);
  /* The page's own subtitles, from the world this script cannot see into. The
   * hook there runs at document_start and this runs at idle, so the answer
   * may already have gone by: ask for it once the ear is open. */
  window.addEventListener("message", onPageSubtitles);
  /* "*" because the target is this very window and a file:// page has no
   * origin to name; the guard is on the receiving side, in onPageSubtitles. */
  window.postMessage({ source: PAGE_SUBTITLE_SOURCE, type: "ask" }, "*");
  const announcements = new MutationObserver(onAnnouncement);
  announcements.observe(document.documentElement, {
    subtree: true,
    attributes: true,
    attributeFilter: ["data-sso-now-playing"],
  });

  loadOverlayStyles();
  loadSettings();
  startTicking();

  /* Everything this injection added, undone. Called by the next injection so a
   * version upgrade leaves exactly one copy running. */
  /* A correction still waiting to be written is lost if the tab goes first,
   * and the reader would have to make it again on the next episode. */
  const onPageHide = () => flushOffsets();
  window.addEventListener("pagehide", onPageHide);

  window.__ssoTeardown = () => {
    flushOffsets();
    window.removeEventListener("pagehide", onPageHide);
    clearInterval(ticker);
    ticker = null;
    tickerMs = 0;
    clearTimeout(toastTimer);
    clearTimeout(handleTimer);
    for (const timer of rememberTimers.values()) clearTimeout(timer);
    rememberTimers.clear();
    clearTimeout(mirrorTimer);
    clearTimeout(translateTimer);
    videoResize?.disconnect();
    observedVideo = null;
    for (const type of ["keydown", "keyup", "keypress"]) {
      window.removeEventListener(type, keepTypingInside, true);
    }
    document.removeEventListener("keydown", onCaptureKey, true);
    document.removeEventListener("keydown", onKeyDown, true);
    window.removeEventListener("resize", onViewportChange);
    window.removeEventListener("scroll", onScroll, { capture: true });
    if (scrollFrame) cancelAnimationFrame(scrollFrame);
    document.removeEventListener("fullscreenchange", onViewportChange);
    document.removeEventListener("webkitfullscreenchange", onViewportChange);
    document.removeEventListener("pointerup", onGlobalPointerEnd, true);
    document.removeEventListener("pointercancel", onGlobalPointerEnd, true);
    document.removeEventListener("pointermove", onPointerMove, { capture: true });
    document.removeEventListener("mousemove", onPointerMove, { capture: true });
    document.removeEventListener("fullscreenchange", onFullscreenChange);
    document.removeEventListener("webkitfullscreenchange", onFullscreenChange);
    document.removeEventListener("sso:nowplaying", onAnnouncement, true);
    window.removeEventListener("message", onPageSubtitles);
    announcements.disconnect();
    /* Guarded, because the commonest reason to be tearing down is that the
     * extension has just been reloaded - and reaching into chrome.runtime is
     * then the very thing that throws. A teardown that threw here left every
     * listener below it still attached. */
    try {
      chrome.runtime.onMessage.removeListener(onMessage);
    } catch {
      // Already gone with the context it belonged to.
    }
    window.removeEventListener("error", onWindowError);
    window.removeEventListener("unhandledrejection", onRejection);
    toastLayer?.remove();
    toastLayer = null;
    toast = null;
    host?.remove();
    host = null;
    shadow = null;
    guides = null;
    views = [];
    listeners.clear();
    window.__ssoPanelTeardown?.();
    window.__ssoStudyTeardown?.();
    delete window.__ssoApi;
    delete window.__ssoTeardown;
  };
})();
