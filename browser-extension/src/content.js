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
  const SETTINGS_KEY = "sso:settings";

  /* Key bindings are stored as KeyboardEvent.code, which identifies the
   * physical key rather than the character it produces. On a Turkish Q layout
   * the keys right of P produce ğ and ü, but their codes are still
   * BracketLeft and BracketRight - so the default bindings stay physically
   * where they are on every layout, and remain rebindable besides. */
  const DEFAULT_SETTINGS = {
    fontScale: 1,
    background: 0.55,
    bottomPercent: 8,
    smallStepMs: 250,
    largeStepMs: 1000,
    keys: {
      earlier: "BracketLeft",
      later: "BracketRight",
      reset: "Backslash",
      togglePanel: "KeyP",
      toggleOverlay: "KeyO",
    },
    keysEnabled: true,
  };

  const state = {
    cues: [],
    offsetMs: 0,
    visible: true,
    video: null,
    activeIndex: -1,
    label: "",
    fileId: null,
    settings: { ...DEFAULT_SETTINGS, keys: { ...DEFAULT_SETTINGS.keys } },
  };

  const listeners = new Set();
  let root = null;
  let cueBox = null;
  let toast = null;
  let toastTimer = null;
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

    for (const item of readJsonLd()) {
      if (/^(Movie|TVEpisode|TVSeries|VideoObject|CreativeWork)$/i.test(item["@type"] || "")) {
        push(item.name, "json-ld");
        if (item.partOfSeries?.name) push(item.partOfSeries.name, "json-ld-series");
      }
    }

    push(document.querySelector('meta[property="og:title"]')?.content, "og:title");
    push(document.querySelector('meta[name="twitter:title"]')?.content, "twitter:title");
    push(document.querySelector("h1")?.textContent, "h1");
    push(document.title, "document.title");

    return { candidates, url: location.href };
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

  // --- settings -------------------------------------------------------------

  async function loadSettings() {
    try {
      const stored = await chrome.storage.local.get(SETTINGS_KEY);
      const saved = stored[SETTINGS_KEY];
      if (saved) {
        state.settings = {
          ...DEFAULT_SETTINGS,
          ...saved,
          keys: { ...DEFAULT_SETTINGS.keys, ...(saved.keys || {}) },
        };
      }
    } catch {
      // Defaults are fine.
    }
    applySettings();
  }

  function updateSettings(patch) {
    state.settings = {
      ...state.settings,
      ...patch,
      keys: { ...state.settings.keys, ...(patch.keys || {}) },
    };
    applySettings();
    chrome.storage.local.set({ [SETTINGS_KEY]: state.settings }).catch(() => {});
    notify();
  }

  function resetSettings() {
    updateSettings({ ...DEFAULT_SETTINGS, keys: { ...DEFAULT_SETTINGS.keys } });
  }

  function applySettings() {
    if (!root) return;
    const { fontScale, background, bottomPercent } = state.settings;
    root.style.setProperty("--sso-font-size", `${2.6 * fontScale}vh`);
    root.style.setProperty("--sso-bg", `rgba(0, 0, 0, ${background})`);
    root.style.bottom = `${bottomPercent}%`;
  }

  // --- overlay --------------------------------------------------------------

  function ensureOverlay() {
    if (root && root.isConnected) {
      attachToCorrectParent();
      return;
    }
    root = document.createElement("div");
    root.className = "sso-root";
    cueBox = document.createElement("div");
    cueBox.className = "sso-cue";
    root.appendChild(cueBox);

    toast = document.createElement("div");
    toast.className = "sso-toast";

    applySettings();
    attachToCorrectParent();
  }

  /* Fullscreen is the detail that breaks naive overlays: the browser renders
   * only the fullscreen element's subtree, so an overlay parented to <body>
   * silently disappears. Re-parent on every change. */
  function attachToCorrectParent() {
    const parent =
      document.fullscreenElement ||
      document.webkitFullscreenElement ||
      document.body ||
      document.documentElement;
    if (!parent) return;
    if (root && root.parentElement !== parent) parent.appendChild(root);
    if (toast && toast.parentElement !== parent) parent.appendChild(toast);
    if (window.__ssoPanel?.reparent) window.__ssoPanel.reparent(parent);
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

  function findCueIndex(timeMs) {
    const cues = state.cues;
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
    if (!state.visible || state.cues.length === 0) {
      if (state.activeIndex !== -1) {
        state.activeIndex = -1;
        if (cueBox) cueBox.textContent = "";
      }
      return;
    }
    ensureOverlay();

    const index = findCueIndex(state.video.currentTime * 1000 - state.offsetMs);
    if (index === state.activeIndex) return;
    state.activeIndex = index;
    cueBox.textContent = index === -1 ? "" : state.cues[index].text;
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

  function saveOffset() {
    if (state.fileId == null) return;
    chrome.storage.local.set({ [offsetKey(state.fileId)]: state.offsetMs }).catch(() => {});
  }

  function setOffset(ms, { quiet = false } = {}) {
    state.offsetMs = Math.round(ms);
    state.activeIndex = -1; // force a re-render at the new offset
    saveOffset();
    notify();
    if (!quiet) showToast(`Subtitle offset ${formatOffset(state.offsetMs)}`);
  }

  const nudge = (deltaMs) => setOffset(state.offsetMs + deltaMs);

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
    } else if (state.cues.length === 0) {
      handled = false; // the rest only make sense with something attached
    } else if (event.code === keys.earlier) {
      nudge(-step);
    } else if (event.code === keys.later) {
      nudge(step);
    } else if (event.code === keys.reset) {
      setOffset(0);
      showToast("Subtitle offset reset");
    } else if (event.code === keys.toggleOverlay) {
      setVisible(!state.visible);
      showToast(state.visible ? "Subtitles shown" : "Subtitles hidden");
    } else {
      handled = false;
    }

    if (handled) {
      event.preventDefault();
      event.stopPropagation();
    }
  }

  // --- attach / visibility --------------------------------------------------

  async function attach({ cues, label, fileId }) {
    state.cues = Array.isArray(cues) ? cues : [];
    state.label = label || "";
    state.fileId = fileId ?? null;
    state.offsetMs = await loadOffset(state.fileId);
    state.activeIndex = -1;
    state.visible = true;
    state.video = pickVideo();

    ensureOverlay();
    root.hidden = false;
    startTicking();
    notify();

    showToast(
      state.cues.length > 0
        ? `Subtitles on - ${state.cues.length} lines${state.label ? ` · ${state.label}` : ""}`
        : "That subtitle had no readable lines",
    );
    return { ok: true, cueCount: state.cues.length };
  }

  function detach() {
    state.cues = [];
    state.label = "";
    state.fileId = null;
    state.activeIndex = -1;
    if (cueBox) cueBox.textContent = "";
    notify();
    return { ok: true };
  }

  function setVisible(visible) {
    state.visible = visible;
    if (root) root.hidden = !visible;
    if (!visible && cueBox) cueBox.textContent = "";
    state.activeIndex = -1;
    notify();
    return { ok: true, visible };
  }

  function status() {
    return {
      hasVideo: hasPlayableVideo(),
      attached: state.cues.length > 0,
      cueCount: state.cues.length,
      offsetMs: state.offsetMs,
      visible: state.visible,
      label: state.label,
      fileId: state.fileId,
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
        sendResponse(detach());
        return false;

      case "sso:setVisible":
        sendResponse(setVisible(Boolean(message.visible)));
        return false;

      case "sso:toggleVisible":
        if (state.cues.length === 0) {
          sendResponse({ ok: false, reason: "nothing attached" });
          return false;
        }
        sendResponse(setVisible(!state.visible));
        return false;

      case "sso:nudge":
        if (state.cues.length === 0) {
          sendResponse({ ok: false, reason: "nothing attached" });
          return false;
        }
        nudge(Number(message.deltaMs) || 0);
        sendResponse({ ok: true, offsetMs: state.offsetMs });
        return false;

      case "sso:setOffset":
        setOffset(Number(message.offsetMs) || 0, { quiet: true });
        sendResponse({ ok: true, offsetMs: state.offsetMs });
        return false;

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
    pageInfo,
    hasPlayableVideo,
    updateSettings,
    resetSettings,
    showToast,
    defaults: DEFAULT_SETTINGS,
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

  document.addEventListener("keydown", onKeyDown, true);
  document.addEventListener("fullscreenchange", attachToCorrectParent);
  document.addEventListener("webkitfullscreenchange", attachToCorrectParent);
  loadSettings();
  startTicking();

  /* Everything this injection added, undone. Called by the next injection so a
   * version upgrade leaves exactly one copy running. */
  window.__ssoTeardown = () => {
    clearInterval(ticker);
    ticker = null;
    clearTimeout(toastTimer);
    document.removeEventListener("keydown", onKeyDown, true);
    document.removeEventListener("fullscreenchange", attachToCorrectParent);
    document.removeEventListener("webkitfullscreenchange", attachToCorrectParent);
    chrome.runtime.onMessage.removeListener(onMessage);
    root?.remove();
    toast?.remove();
    listeners.clear();
    window.__ssoPanelTeardown?.();
    delete window.__ssoApi;
    delete window.__ssoTeardown;
  };
})();
