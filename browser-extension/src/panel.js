/* In-page control panel.
 *
 * This exists rather than living in the toolbar popup because the popup cannot
 * be opened while the page is fullscreen — which is exactly when subtitle
 * timing needs adjusting. Being in the page also means it re-parents into the
 * fullscreen element alongside the overlay and stays reachable.
 *
 * Runs in the same isolated world as content.js and talks to it through
 * window.__ssoApi. Not reachable from the page.
 */

(() => {
  "use strict";

  // Same handover as content.js: replace a previous copy rather than refusing
  // to load next to it.
  if (typeof window.__ssoPanelTeardown === "function") {
    try {
      window.__ssoPanelTeardown();
    } catch {
      // Never let a broken predecessor block the replacement.
    }
  }

  const api = window.__ssoApi;
  if (!api) return; // content.js did not install; nothing to control

  const POSITION_KEY = "sso:panelPosition";

  const KEY_FIELDS = [
    ["earlier", "Subtitles earlier"],
    ["later", "Subtitles later"],
    ["reset", "Reset offset"],
    ["toggleOverlay", "Hide / show"],
    ["togglePanel", "This panel"],
  ];

  let host = null; // the element in the page; carries position only
  let shadow = null; // everything else lives in here
  let el = {};
  let capturing = null;
  let unsubscribe = null;
  let lastResults = [];
  let lastResolved = null;
  let sheet = null;

  // --- construction ---------------------------------------------------------

  /* The host is the only element the page's cascade can reach, so it carries
   * nothing but geometry, pinned with inline !important. It is deliberately
   * invisible - no background, no typography - because anything visual placed
   * here would be fighting the page for the rest of time. All appearance lives
   * on .sso-panel inside the shadow root, where page CSS cannot reach it.
   *
   * `all: initial` matters as much as the positioning: it stops inherited
   * properties (line-height, letter-spacing, font) from crossing into the
   * shadow tree through the host.
   *
   * Note this outranks every `:host` rule in the adopted stylesheet, inline
   * !important being the top of the cascade - so `:host` must not be used for
   * anything load-bearing. */
  function createHost() {
    const node = document.createElement("div");
    for (const [property, value] of Object.entries({
      all: "initial",
      position: "fixed",
      top: "24px",
      left: "24px",
      width: "340px",
      "z-index": "2147483647",
    })) {
      node.style.setProperty(property, value, "important");
    }
    setHostVisible(node, false);
    return node;
  }

  /* Visibility is a display override rather than the `hidden` attribute: the
   * host's inline display is !important, so the UA rule behind `hidden` would
   * never win. */
  function setHostVisible(node, visible) {
    node.style.setProperty("display", visible ? "block" : "none", "important");
    node.hidden = !visible;
  }

  const isPanelVisible = () => Boolean(host) && host.hidden === false;

  /* A constructable stylesheet rather than a <style> element: adopted sheets
   * are not subject to the page's Content-Security-Policy, and many streaming
   * sites ship a restrictive style-src. */
  async function loadStyles() {
    if (sheet) return sheet;
    const css = await fetch(chrome.runtime.getURL("src/panel.css")).then((r) => r.text());
    sheet = new CSSStyleSheet();
    sheet.replaceSync(css);
    return sheet;
  }

  async function build() {
    host = createHost();
    shadow = host.attachShadow({ mode: "open" });
    shadow.adoptedStyleSheets = [await loadStyles()];

    const panel = document.createElement("div");
    panel.className = "sso-panel";

    const head = document.createElement("div");
    head.className = "sso-panel__head";
    const title = document.createElement("div");
    title.className = "sso-panel__title";
    title.textContent = "Subtitle Overlay";
    const close = document.createElement("button");
    close.className = "sso-panel__x";
    close.textContent = "×";
    close.title = "Close";
    close.addEventListener("click", hide);
    head.append(title, close);

    const body = document.createElement("div");
    body.className = "sso-panel__body";
    body.append(buildStatus(), buildSearch(), buildAppearance(), buildKeys());

    panel.append(head, body);
    shadow.append(panel);
    makeDraggable(head);
    return host;
  }

  function section(heading) {
    const wrap = document.createElement("div");
    wrap.className = "sso-sec";
    const h = document.createElement("p");
    h.className = "sso-sec__h";
    h.textContent = heading;
    wrap.append(h);
    return wrap;
  }

  function button(label, { primary = false, onClick, title } = {}) {
    const b = document.createElement("button");
    b.type = "button";
    b.textContent = label;
    if (primary) b.className = "sso-primary";
    if (title) b.title = title;
    if (onClick) b.addEventListener("click", onClick);
    return b;
  }

  // --- status and offset ----------------------------------------------------

  function buildStatus() {
    const wrap = section("Now showing");

    el.attached = document.createElement("p");
    el.attached.className = "sso-note sso-note--strong";
    el.attached.textContent = "Nothing attached yet.";

    const offsets = document.createElement("div");
    offsets.className = "sso-row";
    el.offsetValue = document.createElement("span");
    el.offsetValue.className = "sso-offset";
    el.offsetValue.textContent = "0s";

    offsets.append(
      button("−1s", { onClick: () => api.nudge(-1000), title: "Subtitles 1s earlier" }),
      button("−¼", { onClick: () => api.nudge(-250) }),
      el.offsetValue,
      button("+¼", { onClick: () => api.nudge(250) }),
      button("+1s", { onClick: () => api.nudge(1000), title: "Subtitles 1s later" }),
      button("Reset", { onClick: () => api.setOffset(0) }),
    );

    const actions = document.createElement("div");
    actions.className = "sso-row";
    el.toggleVisible = button("Hide subtitles", {
      onClick: () => api.setVisible(!api.status().visible),
    });
    actions.append(el.toggleVisible, button("Detach", { onClick: () => api.detach() }));

    el.offsetRow = offsets;
    el.actionsRow = actions;
    wrap.append(el.attached, offsets, actions);
    return wrap;
  }

  // --- search ---------------------------------------------------------------

  function buildSearch() {
    const wrap = section("Find a subtitle");

    const row = document.createElement("div");
    row.className = "sso-row";
    el.query = document.createElement("input");
    el.query.type = "text";
    el.query.spellcheck = false;
    el.query.placeholder = "Film or series title";
    el.query.addEventListener("keydown", (event) => {
      event.stopPropagation(); // typing must not trigger nudge bindings
      if (event.key === "Enter") runSearch(el.query.value.trim());
    });

    const grow = document.createElement("div");
    grow.className = "sso-grow";
    grow.append(el.query);

    row.append(grow, button("Search", { primary: true, onClick: () => runSearch(el.query.value.trim()) }));

    el.searchNote = document.createElement("p");
    el.searchNote.className = "sso-note";

    el.results = document.createElement("ul");
    el.results.className = "sso-results";

    wrap.append(row, el.searchNote, el.results);
    return wrap;
  }

  async function runSearch(query) {
    el.results.replaceChildren();
    el.searchNote.className = "sso-note";
    el.searchNote.textContent = "Searching…";

    const response = await api.daemon("search", { query, title: query ? "" : bestPageTitle() });
    if (!response || response.transportError) {
      el.searchNote.className = "sso-note sso-note--warn";
      el.searchNote.textContent =
        response?.transportError || "Cannot reach the daemon. Is run.sh running?";
      return;
    }
    if (response.error) {
      el.searchNote.className = "sso-note sso-note--warn";
      el.searchNote.textContent = response.error;
      return;
    }
    if (!query && response.used?.query) el.query.value = response.used.query;

    lastResults = response.results || [];
    lastResolved = response.resolved || null;
    if (lastResults.length === 0) {
      el.searchNote.textContent = "Nothing found. Try a different title.";
      return;
    }

    el.searchNote.className = response.low_confidence ? "sso-note sso-note--warn" : "sso-note";
    el.searchNote.textContent = response.low_confidence
      ? "Nothing matched well. These are guesses — check before attaching."
      : `${lastResults.length} result${lastResults.length === 1 ? "" : "s"}`;

    renderResults(lastResults, response.auto_attach_threshold ?? 0.75);
  }

  function renderResults(results, threshold) {
    el.results.replaceChildren(
      ...results.slice(0, 30).map((result) => {
        const item = document.createElement("li");
        const b = document.createElement("button");
        b.type = "button";
        b.className = "sso-result";

        const top = document.createElement("div");
        top.className = "sso-result__top";

        const lang = document.createElement("span");
        lang.className = "sso-result__lang";
        lang.textContent = (result.language || "??").toUpperCase();

        const name = document.createElement("span");
        name.className = "sso-result__name";
        name.textContent = result.movie_name || result.release || "Untitled";

        top.append(lang, name);
        if (result.cached) top.append(tag("cached", "sso-tag--free"));
        if (result.match_score != null && result.match_score < threshold) {
          top.append(tag("weak match", "sso-tag--weak"));
        }
        if (result.hearing_impaired) top.append(tag("HI"));

        const sub = document.createElement("span");
        sub.className = "sso-result__sub";
        sub.textContent = [result.release, result.year, `${result.download_count} dl`]
          .filter(Boolean)
          .join(" · ");

        b.append(top, sub);
        b.addEventListener("click", () => attachResult(result));
        item.append(b);
        return item;
      }),
    );
  }

  function tag(text, extra) {
    const span = document.createElement("span");
    span.className = extra ? `sso-tag ${extra}` : "sso-tag";
    span.textContent = text;
    return span;
  }

  async function attachResult(result) {
    el.searchNote.className = "sso-note";
    el.searchNote.textContent = result.cached ? "Loading…" : "Downloading…";

    // Title context, so the cache can recognise this film next time and not
    // spend another download on a different upload of it.
    const response = await api.daemon("fetch", {
      fileId: result.file_id,
      context: {
        imdb_id: lastResolved?.imdb_id || null,
        language: result.language || null,
        movie_name: result.movie_name || null,
        release: result.release || null,
      },
    });
    if (!response || response.error || response.transportError) {
      el.searchNote.className = "sso-note sso-note--warn";
      el.searchNote.textContent =
        response?.quota_exceeded
          ? "Daily download limit reached. Cached subtitles still work."
          : response?.error || response?.transportError || "Download failed.";
      return;
    }

    await api.attach({
      cues: response.cues,
      label: `${(result.language || "").toUpperCase()} · ${result.release || result.movie_name}`,
      fileId: result.file_id,
    });
    el.searchNote.textContent = "";
  }

  function bestPageTitle() {
    const info = api.pageInfo();
    return info.candidates[0]?.text || document.title;
  }

  // --- appearance -----------------------------------------------------------

  function buildAppearance() {
    const wrap = section("Appearance");
    const settings = api.status().settings;

    el.fontScale = slider("Size", 0.6, 2.2, 0.05, settings.fontScale, (value) =>
      api.updateSettings({ fontScale: value }),
    );
    el.background = slider("Backdrop", 0, 1, 0.05, settings.background, (value) =>
      api.updateSettings({ background: value }),
    );
    el.bottom = slider("Height", 0, 40, 1, settings.bottomPercent, (value) =>
      api.updateSettings({ bottomPercent: value }),
    );

    el.showSymbols = toggle_("Sound symbols", settings.showSymbols, (on) =>
      api.updateSettings({ showSymbols: on }),
    );
    el.dimNonSpeech = toggle_("Dim non-speech", settings.dimNonSpeech, (on) =>
      api.updateSettings({ dimNonSpeech: on }),
    );

    wrap.append(
      el.fontScale.row,
      el.background.row,
      el.bottom.row,
      el.showSymbols.row,
      el.dimNonSpeech.row,
    );
    return wrap;
  }

  function toggle_(label, checked, onChange) {
    const row = document.createElement("label");
    row.className = "sso-label sso-label--check";
    const input = document.createElement("input");
    input.type = "checkbox";
    input.checked = Boolean(checked);
    input.addEventListener("change", () => onChange(input.checked));
    const name = document.createElement("span");
    name.textContent = label;
    row.append(input, name);
    return { row, input };
  }

  function slider(label, min, max, step, value, onInput) {
    const row = document.createElement("label");
    row.className = "sso-label";
    const name = document.createElement("span");
    name.textContent = label;
    const input = document.createElement("input");
    input.type = "range";
    Object.assign(input, { min, max, step, value });
    const readout = document.createElement("span");
    readout.className = "sso-value";
    readout.textContent = String(value);
    input.addEventListener("input", () => {
      const parsed = Number(input.value);
      readout.textContent = String(parsed);
      onInput(parsed);
    });
    row.append(name, input, readout);
    return { row, input, readout };
  }

  // --- key bindings ---------------------------------------------------------

  function buildKeys() {
    const wrap = section("Keys");

    const note = document.createElement("p");
    note.className = "sso-note";
    note.textContent =
      "Bindings follow the physical key, so they stay in the same place on any layout.";

    const grid = document.createElement("div");
    grid.className = "sso-keys";
    el.keyButtons = {};

    for (const [name, label] of KEY_FIELDS) {
      const caption = document.createElement("span");
      caption.textContent = label;
      const b = button("", { title: "Click, then press a key" });
      b.className = "sso-key";
      b.addEventListener("click", () => beginCapture(name, b));
      el.keyButtons[name] = b;
      grid.append(caption, b);
    }

    const actions = document.createElement("div");
    actions.className = "sso-row";
    actions.style.marginTop = "8px";
    actions.append(
      button("Reset keys", { onClick: () => api.resetSettings() }),
      button("Disable keys", {
        onClick: () => api.updateSettings({ keysEnabled: !api.status().settings.keysEnabled }),
      }),
    );
    el.keysToggle = actions.lastChild;

    wrap.append(note, grid, actions);
    return wrap;
  }

  function beginCapture(name, target) {
    if (capturing) capturing.target.dataset.capturing = "false";
    capturing = { name, target };
    target.dataset.capturing = "true";
    target.textContent = "press a key…";
  }

  /* Capture runs at the document level in the capture phase so the binding is
   * read before the page or content.js can act on the keystroke. */
  function onCaptureKey(event) {
    if (!capturing) return;
    event.preventDefault();
    event.stopPropagation();

    const { name, target } = capturing;
    capturing = null;
    target.dataset.capturing = "false";

    if (event.code === "Escape") {
      refresh(api.status());
      return;
    }
    api.updateSettings({ keys: { [name]: event.code } });
  }

  const isCapturingKey = () => capturing !== null;

  /* KeyboardEvent.code is precise but unreadable. Show where the key actually
   * is rather than what the spec calls it. */
  function describeCode(code) {
    if (!code) return "unset";
    const named = {
      BracketLeft: "[ key",
      BracketRight: "] key",
      Backslash: "\\ key",
      Semicolon: "; key",
      Quote: "' key",
      Comma: ", key",
      Period: ". key",
      Slash: "/ key",
      Minus: "- key",
      Equal: "= key",
      Space: "space",
      ArrowLeft: "←",
      ArrowRight: "→",
      ArrowUp: "↑",
      ArrowDown: "↓",
    };
    if (named[code]) return named[code];
    if (code.startsWith("Key")) return code.slice(3);
    if (code.startsWith("Digit")) return code.slice(5);
    if (code.startsWith("Numpad")) return `num ${code.slice(6)}`;
    return code;
  }

  // --- dragging -------------------------------------------------------------

  function makeDraggable(handle) {
    let origin = null;

    handle.addEventListener("pointerdown", (event) => {
      if (event.target.closest("button")) return;
      const box = host.getBoundingClientRect();
      origin = { x: event.clientX - box.left, y: event.clientY - box.top };
      handle.dataset.dragging = "true";
      handle.setPointerCapture(event.pointerId);
    });

    handle.addEventListener("pointermove", (event) => {
      if (!origin) return;
      // Clamp so the panel can never be dragged fully off-screen.
      const maxLeft = Math.max(0, window.innerWidth - host.offsetWidth);
      const maxTop = Math.max(0, window.innerHeight - 40);
      const left = Math.min(Math.max(0, event.clientX - origin.x), maxLeft);
      const top = Math.min(Math.max(0, event.clientY - origin.y), maxTop);
      setPosition(`${left}px`, `${top}px`);
    });

    const end = (event) => {
      if (!origin) return;
      origin = null;
      handle.dataset.dragging = "false";
      handle.releasePointerCapture?.(event.pointerId);
      chrome.storage.local
        .set({ [POSITION_KEY]: { left: host.style.left, top: host.style.top } })
        .catch(() => {});
    };
    handle.addEventListener("pointerup", end);
    handle.addEventListener("pointercancel", end);
  }

  /* Position stays inline-!important, matching how createHost set it. A plain
   * `style.left = x` assignment drops the priority flag, which would hand the
   * page's cascade a way to move the panel off screen. */
  function setPosition(left, top) {
    host.style.setProperty("left", left, "important");
    host.style.setProperty("top", top, "important");
  }

  async function restorePosition() {
    try {
      const stored = await chrome.storage.local.get(POSITION_KEY);
      const saved = stored[POSITION_KEY];
      if (saved?.left && saved?.top) setPosition(saved.left, saved.top);
    } catch {
      // Default corner is fine.
    }
  }

  // --- refresh --------------------------------------------------------------

  function refresh(status) {
    if (!host) return;

    el.attached.textContent = status.attached
      ? `${status.label || `${status.cueCount} lines`} · ${status.cueCount} lines`
      : status.hasVideo
        ? "Nothing attached yet."
        : "No video detected on this page.";

    el.offsetRow.hidden = !status.attached;
    el.actionsRow.hidden = !status.attached;
    el.offsetValue.textContent = api.formatOffset(status.offsetMs);
    el.toggleVisible.textContent = status.visible ? "Hide subtitles" : "Show subtitles";

    const settings = status.settings;
    el.fontScale.input.value = String(settings.fontScale);
    el.fontScale.readout.textContent = String(settings.fontScale);
    el.background.input.value = String(settings.background);
    el.background.readout.textContent = String(settings.background);
    el.bottom.input.value = String(settings.bottomPercent);
    el.bottom.readout.textContent = String(settings.bottomPercent);
    el.showSymbols.input.checked = Boolean(settings.showSymbols);
    el.dimNonSpeech.input.checked = Boolean(settings.dimNonSpeech);

    for (const [name] of KEY_FIELDS) {
      el.keyButtons[name].textContent = describeCode(settings.keys[name]);
    }
    el.keysToggle.textContent = settings.keysEnabled ? "Disable keys" : "Enable keys";
  }

  // --- lifecycle ------------------------------------------------------------

  async function show() {
    if (!host) {
      await build();
      await restorePosition();
    }
    reparent();
    setHostVisible(host, true);
    unsubscribe ||= api.subscribe(refresh);
    refresh(api.status());
    if (!el.query.value) el.query.value = bestPageTitle();
  }

  function hide() {
    if (host) setHostVisible(host, false);
    if (unsubscribe) {
      unsubscribe();
      unsubscribe = null;
    }
  }

  const toggle = () => (isPanelVisible() ? hide() : show());

  /* Follows the overlay into the fullscreen element, since only that subtree
   * is rendered while fullscreen is active. */
  function reparent(parent) {
    if (!host) return;
    const target =
      parent ||
      document.fullscreenElement ||
      document.webkitFullscreenElement ||
      document.body ||
      document.documentElement;
    if (target && host.parentElement !== target) target.appendChild(host);
  }

  document.addEventListener("keydown", onCaptureKey, true);

  window.__ssoPanel = { show, hide, toggle, reparent, isCapturingKey };

  window.__ssoPanelTeardown = () => {
    document.removeEventListener("keydown", onCaptureKey, true);
    unsubscribe?.();
    unsubscribe = null;
    host?.remove();
    host = null;
    shadow = null;
    delete window.__ssoPanel;
    delete window.__ssoPanelTeardown;
  };
})();
