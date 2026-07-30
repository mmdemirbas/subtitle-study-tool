/* Renders subtitle cues over the page's video, driven by the video's own clock.
 *
 * The whole point of doing this in the page rather than in a separate window is
 * `video.currentTime`. Reading it means seeking, pausing, buffering and
 * variable playback rate all stay in sync for free — there is no drift to
 * correct, because there is no independent clock to drift from. The only offset
 * left is the one baked into the subtitle file by being timed against a
 * different release, which is what the nudge keys are for.
 *
 * Injected into every frame, because streaming players usually live in an
 * iframe. Frames without a usable video do nothing at all.
 */

(() => {
  "use strict";

  // Guard against double-injection when the extension is reloaded.
  if (window.__ssoInstalled) return;
  window.__ssoInstalled = true;

  const TICK_MS = 50; // ~20 Hz: below perceptible latency, negligible cost
  const NUDGE_SMALL_MS = 250;
  const NUDGE_LARGE_MS = 1000;
  const MIN_VIDEO_SECONDS = 60; // ignore ad breaks, teasers, autoplay clips
  const TOAST_MS = 1400;

  const state = {
    cues: [],
    offsetMs: 0,
    visible: true,
    video: null,
    activeIndex: -1,
    label: "",
    storageKey: "",
  };

  let root = null;
  let cueBox = null;
  let toast = null;
  let toastTimer = null;
  let ticker = null;

  // --- video selection ------------------------------------------------------

  /* Pick the video the user is actually watching: the biggest one with a real
   * duration. Pages routinely hold several — preview loops, ad slots, hidden
   * elements — and the largest playing one is reliably the feature. */
  function pickVideo() {
    const candidates = Array.from(document.querySelectorAll("video")).filter((video) => {
      if (!Number.isFinite(video.duration)) return false;
      if (video.duration < MIN_VIDEO_SECONDS) return false;
      const box = video.getBoundingClientRect();
      return box.width > 200 && box.height > 100;
    });

    if (candidates.length === 0) return null;

    candidates.sort((a, b) => {
      const aBox = a.getBoundingClientRect();
      const bBox = b.getBoundingClientRect();
      // Prefer a playing video over a paused one of the same size.
      const playing = Number(!b.paused) - Number(!a.paused);
      if (playing !== 0) return playing;
      return bBox.width * bBox.height - aBox.width * aBox.height;
    });

    return candidates[0];
  }

  function hasPlayableVideo() {
    return pickVideo() !== null;
  }

  // --- overlay --------------------------------------------------------------

  function ensureOverlay() {
    if (root && root.isConnected) return;

    root = document.createElement("div");
    root.className = "sso-root";
    cueBox = document.createElement("div");
    cueBox.className = "sso-cue";
    root.appendChild(cueBox);

    toast = document.createElement("div");
    toast.className = "sso-toast";

    attachToCorrectParent();
  }

  /* Fullscreen is the detail that breaks naive overlays. When a player goes
   * fullscreen the browser renders only the fullscreen element's subtree, so an
   * overlay parented to <body> silently vanishes. Re-parent on every change. */
  function attachToCorrectParent() {
    const parent =
      document.fullscreenElement ||
      document.webkitFullscreenElement ||
      document.body ||
      document.documentElement;

    if (!parent) return;
    if (root && root.parentElement !== parent) parent.appendChild(root);
    if (toast && toast.parentElement !== parent) parent.appendChild(toast);
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

  /* Binary search for the cue covering `timeMs`. Cues are sorted and
   * non-overlapping in practice; when they do overlap, the earlier one wins,
   * which matches how players behave. */
  function findCueIndex(timeMs) {
    const cues = state.cues;
    let low = 0;
    let high = cues.length - 1;
    let found = -1;

    while (low <= high) {
      const mid = (low + high) >> 1;
      const cue = cues[mid];
      if (timeMs < cue.start) {
        high = mid - 1;
      } else if (timeMs > cue.end) {
        low = mid + 1;
      } else {
        found = mid;
        break;
      }
    }
    return found;
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

    const timeMs = state.video.currentTime * 1000 - state.offsetMs;
    const index = findCueIndex(timeMs);
    if (index === state.activeIndex) return;

    state.activeIndex = index;
    cueBox.textContent = index === -1 ? "" : state.cues[index].text;
  }

  function startTicking() {
    if (ticker !== null) return;
    ticker = setInterval(tick, TICK_MS);
  }

  // --- offset ---------------------------------------------------------------

  /* Offsets are remembered per page, keyed by the subtitle that produced them,
   * so re-opening the same film does not mean re-finding the same nudge. */
  async function loadOffset(key) {
    if (!key) return 0;
    try {
      const stored = await chrome.storage.local.get(key);
      return Number(stored[key]) || 0;
    } catch {
      return 0;
    }
  }

  function saveOffset() {
    if (!state.storageKey) return;
    chrome.storage.local.set({ [state.storageKey]: state.offsetMs }).catch(() => {
      /* storage is a convenience here; failing to persist is not worth surfacing */
    });
  }

  function nudge(deltaMs) {
    state.offsetMs += deltaMs;
    state.activeIndex = -1; // force a re-render at the new offset
    saveOffset();
    const seconds = (state.offsetMs / 1000).toFixed(2).replace(/\.00$/, "");
    const sign = state.offsetMs > 0 ? "+" : "";
    showToast(`Subtitle offset ${sign}${seconds}s`);
  }

  // --- keyboard -------------------------------------------------------------

  /* Bracket keys, because they are close together, unshifted, and essentially
   * never bound by video players. Ignored while typing into the page. */
  function onKeyDown(event) {
    if (state.cues.length === 0) return;
    if (event.metaKey || event.ctrlKey || event.altKey) return;

    const target = event.target;
    if (target && (target.isContentEditable ||
        /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName || ""))) {
      return;
    }

    const step = event.shiftKey ? NUDGE_LARGE_MS : NUDGE_SMALL_MS;

    if (event.key === "[" || event.key === "{") {
      nudge(-step);
    } else if (event.key === "]" || event.key === "}") {
      nudge(step);
    } else if (event.key === "\\" || event.key === "|") {
      state.offsetMs = 0;
      state.activeIndex = -1;
      saveOffset();
      showToast("Subtitle offset reset");
    } else {
      return;
    }

    event.preventDefault();
    event.stopPropagation();
  }

  // --- messaging ------------------------------------------------------------

  async function attach(payload) {
    state.cues = Array.isArray(payload.cues) ? payload.cues : [];
    state.label = payload.label || "";
    state.storageKey = payload.storageKey || "";
    state.offsetMs = await loadOffset(state.storageKey);
    state.activeIndex = -1;
    state.visible = true;
    state.video = pickVideo();

    ensureOverlay();
    root.hidden = false;
    startTicking();

    showToast(
      state.cues.length > 0
        ? `Subtitles on — ${state.cues.length} lines${state.label ? ` · ${state.label}` : ""}`
        : "That subtitle had no readable lines",
    );

    return { ok: true, cueCount: state.cues.length };
  }

  function setVisible(visible) {
    state.visible = visible;
    if (root) root.hidden = !visible;
    if (!visible && cueBox) cueBox.textContent = "";
    state.activeIndex = -1;
    return { ok: true, visible };
  }

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    // Frames with no video ignore everything except the probe, so a broadcast
    // to all frames resolves to whichever frame actually holds the player.
    switch (message?.type) {
      case "sso:probe":
        sendResponse({ hasVideo: hasPlayableVideo(), attached: state.cues.length > 0 });
        return false;

      case "sso:attach":
        if (!hasPlayableVideo()) {
          sendResponse({ ok: false, reason: "no video in this frame" });
          return false;
        }
        attach(message.payload).then(sendResponse);
        return true; // async response

      case "sso:setVisible":
        if (state.cues.length === 0) {
          sendResponse({ ok: false, reason: "nothing attached" });
          return false;
        }
        sendResponse(setVisible(message.visible));
        return false;

      case "sso:toggleVisible":
        if (state.cues.length === 0) {
          sendResponse({ ok: false, reason: "nothing attached" });
          return false;
        }
        sendResponse(setVisible(!state.visible));
        return false;

      case "sso:status":
        sendResponse({
          hasVideo: hasPlayableVideo(),
          attached: state.cues.length > 0,
          cueCount: state.cues.length,
          offsetMs: state.offsetMs,
          visible: state.visible,
          label: state.label,
        });
        return false;

      case "sso:toast":
        showToast(String(message.message || ""));
        sendResponse({ ok: true });
        return false;

      case "sso:nudge":
        if (state.cues.length === 0) {
          sendResponse({ ok: false, reason: "nothing attached" });
          return false;
        }
        nudge(Number(message.deltaMs) || 0);
        sendResponse({ ok: true, offsetMs: state.offsetMs });
        return false;

      default:
        return false;
    }
  });

  // --- wiring ---------------------------------------------------------------

  document.addEventListener("keydown", onKeyDown, true);
  document.addEventListener("fullscreenchange", attachToCorrectParent);
  document.addEventListener("webkitfullscreenchange", attachToCorrectParent);
})();
