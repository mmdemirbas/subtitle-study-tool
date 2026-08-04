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

  // Kept in step with the .sso-handle rule in overlay.css, so the panel hangs
  // directly under the button that opens it.
  const HANDLE_TOP = 16;
  const HANDLE_RIGHT = 16;
  const HANDLE_HEIGHT = 26;
  const GAP = 10;
  const PANEL_WIDTH = 340;

  const KEY_FIELDS = [
    ["earlier", "Subtitles earlier"],
    ["later", "Subtitles later"],
    ["reset", "Reset offset"],
    ["toggleOverlay", "Hide / show"],
    ["togglePanel", "This panel"],
    ["toggleStudy", "Study mode"],
    ["saveWord", "Save the top word"],
  ];

  let host = null; // the element in the page; carries position only
  let shadow = null; // everything else lives in here
  let el = {};
  let capturing = null;
  let unsubscribe = null;
  let lastResults = [];
  let lastResolved = null;
  let sheet = null;

  /* Which of the two subtitles the next attach lands on. Not stored: it is a
   * property of the search you are doing right now, and a remembered value
   * would silently overwrite a track you had already set up. Reset to the first
   * free slot every time the panel opens. */
  let targetSlot = 0;

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
   * anything load-bearing.
   *
   * Position: anchored under the CC handle, top-right. It used to open at
   * top-left while the handle that opens it sits top-right, so the thing you
   * clicked and the thing that appeared were at opposite ends of the screen.
   * Controls belong next to what they operate.
   *
   * Right-anchored rather than left-anchored at a computed offset, so it stays
   * against the handle when the window is resized. The first drag converts it
   * to left/top, because after that the user's placement is the intent. */
  function createHost() {
    const node = document.createElement("div");
    for (const [property, value] of Object.entries({
      all: "initial",
      position: "fixed",
      top: `${HANDLE_TOP + HANDLE_HEIGHT + GAP}px`,
      right: `${HANDLE_RIGHT}px`,
      left: "auto",
      width: `${PANEL_WIDTH}px`,
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
    await loadOpenSections();
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

    /* Double-click the bar to put the panel back under the CC button. A panel
     * dragged somewhere unhelpful - behind the player's own controls, half off
     * a screen that has since been resized - otherwise has to be dragged back
     * from wherever it went, which is the situation that made it unhelpful. */
    head.addEventListener("dblclick", (event) => {
      if (event.target.closest("button")) return;
      host.style.setProperty("left", "auto", "important");
      host.style.setProperty("right", `${HANDLE_RIGHT}px`, "important");
      host.style.setProperty("top", `${HANDLE_TOP + HANDLE_HEIGHT + GAP}px`, "important");
      chrome.storage.local.remove(POSITION_KEY).catch(() => {});
      api.showToast("Panel back to the corner");
    });

    const body = document.createElement("div");
    body.className = "sso-panel__body";

    /* Two tiers, not seven sections.
     *
     * Only two of these are opened while a film is playing: what is attached
     * and how it is timed, and finding something to attach. The other five are
     * set once - where the boxes go, how they look, study, key bindings,
     * diagnostics - and having them all in the column made a panel taller than
     * the video it sits on.
     *
     * So the rest fold away behind one control. Nothing is removed and nothing
     * is behind a mode; the default is simply the two that get used. */
    const more = document.createElement("div");
    more.className = "sso-more";
    more.append(
      buildArrangement(),
      buildAppearance(),
      buildStudy(),
      buildKeys(),
      buildDiagnostics(),
    );

    el.moreToggle = button("More settings", {
      onClick: () => setMoreOpen(more.dataset.open !== "true"),
    });
    el.moreToggle.className = "sso-more__toggle";
    el.more = more;

    const setMoreOpen = (open) => {
      more.dataset.open = open ? "true" : "false";
      el.moreToggle.textContent = open ? "Fewer settings" : "More settings";
      el.moreToggle.setAttribute("aria-expanded", open ? "true" : "false");
      chrome.storage.local.set({ [MORE_KEY]: open }).catch(() => {});
      fitToViewport();
    };
    setMoreOpen(moreOpen);

    body.append(buildTracks(), buildSearch(), el.moreToggle, more);

    panel.append(head, body, buildResizeGrip(body));
    shadow.append(panel);
    makeDraggable(head);
    containGestures(panel);
    await restoreSize();
    return host;
  }

  /* A corner grip that sets both dimensions at once.
   *
   * Width matters because the panel holds film titles and release names, which
   * are long and get truncated; height matters because how much of the film the
   * panel is allowed to cover is a judgement about the film, not about the
   * panel. One grip for both is what a window corner has always been, and it
   * saves a second control on a surface already accused of being too big.
   *
   * The height is applied to the scrolling body rather than the panel, so the
   * header stays put and only the list gets shorter. */
  const MIN_WIDTH = 280;
  const MAX_WIDTH = 640;
  const MIN_BODY = 140;

  function buildResizeGrip(body) {
    const grip = document.createElement("div");
    grip.className = "sso-grip";
    grip.title = "Drag to resize";

    let from = null;
    grip.addEventListener("pointerdown", (event) => {
      from = {
        x: event.clientX,
        y: event.clientY,
        width: host.getBoundingClientRect().width,
        height: body.getBoundingClientRect().height,
      };
      grip.setPointerCapture(event.pointerId);
      event.preventDefault();
      event.stopPropagation();
    });

    grip.addEventListener("pointermove", (event) => {
      if (!from) return;
      const width = clamp(from.width + (event.clientX - from.x), MIN_WIDTH, MAX_WIDTH);
      const height = clamp(
        from.height + (event.clientY - from.y),
        MIN_BODY,
        Math.max(MIN_BODY, window.innerHeight - 120),
      );
      applySize(width, height);
    });

    const end = (event) => {
      if (!from) return;
      from = null;
      grip.releasePointerCapture?.(event.pointerId);
      chrome.storage.local
        .set({
          [SIZE_KEY]: {
            width: host.getBoundingClientRect().width,
            body: body.getBoundingClientRect().height,
          },
        })
        .catch(() => {});
    };
    grip.addEventListener("pointerup", end);
    grip.addEventListener("pointercancel", end);
    return grip;
  }

  const clamp = (value, low, high) => Math.min(Math.max(value, low), high);

  /* The height the user asked for, which is not always the height they can
   * have: a panel dragged down the screen has less room beneath it than one in
   * the corner. Kept apart from what gets applied so that moving it back up
   * restores the size rather than having silently lost it. */
  let preferredBody = 420;

  function applySize(width, bodyHeight) {
    // Inline !important, like every other geometry property on the host: the
    // page's own rules reach the host and a plain assignment would lose to them.
    host.style.setProperty("width", `${Math.round(width)}px`, "important");
    preferredBody = bodyHeight;
    fitToViewport();
  }

  /* Keep the whole panel on the screen.
   *
   * A maximum height alone is not enough - a panel 500px tall starting 400px
   * down a 780px window still runs off the bottom, taking the second tier and
   * anything below it with it. What is available is the room under wherever the
   * panel currently is, so this runs after anything that changes that: opening
   * it, dragging it, folding a section, resizing the window. */
  function fitToViewport() {
    if (!host || host.hidden || !shadow) return;
    const body = shadow.querySelector(".sso-panel__body");
    if (!body) return;

    const hostBox = host.getBoundingClientRect();
    const bodyBox = body.getBoundingClientRect();
    // Everything that is not the scrolling list: the title bar, borders.
    const furniture = hostBox.height - bodyBox.height;
    const available = window.innerHeight - hostBox.top - furniture - 12;
    body.style.setProperty("max-height", `${Math.round(Math.max(MIN_BODY, Math.min(preferredBody, available)))}px`);
  }

  async function restoreSize() {
    try {
      const stored = await chrome.storage.local.get(SIZE_KEY);
      const size = stored[SIZE_KEY];
      if (size?.width) applySize(size.width, size.body || preferredBody);
    } catch {
      // The default size is fine.
    }
  }

  /* Keep the panel's own gestures inside the panel.
   *
   * A video player binds the wheel and the arrow keys to volume and seeking, on
   * document, and those listeners do not care that the pointer is over an
   * injected panel - so scrolling this list changed the volume, and it did so
   * while the list was scrolling, which reads as the page fighting back.
   *
   * stopPropagation, never preventDefault: the panel's own scrolling is the
   * browser's default action for the wheel and must go on working. What is
   * being stopped is the page *also* hearing about it. CSS overscroll-behavior
   * handles the other half - a player that relies on scroll chaining rather
   * than on its own listener.
   *
   * Keys are stopped for the same reason but only where they mean something
   * else here: typing in the search box, and the arrows and page keys, which a
   * player treats as seek and volume. content.js's own bindings already ignore
   * events from a field, and they are the extension's, not the page's. */
  const PLAYER_KEYS = /^(Arrow|Page|Home|End|Space)/;

  function containGestures(panel) {
    panel.addEventListener("wheel", (event) => event.stopPropagation(), { passive: true });
    panel.addEventListener("keydown", (event) => {
      const target = event.composedPath?.()[0] ?? event.target;
      const typing =
        target?.isContentEditable ||
        /^(INPUT|TEXTAREA|SELECT)$/.test(target?.tagName || "");
      if (typing || PLAYER_KEYS.test(event.code)) event.stopPropagation();
    });
  }

  const OPEN_KEY = "sso:panelOpen";
  const MORE_KEY = "sso:panelMore";
  const SIZE_KEY = "sso:panelSize";
  let moreOpen = false;

  /* Which sections start open. The two that answer "what is on screen and how
   * do I change it" - everything else is set once and then left alone, and a
   * panel that shows all seven at full height is taller than the film. */
  const OPEN_BY_DEFAULT = new Set(["Subtitles", "Find a subtitle"]);
  let openSections = null; // filled from storage before the panel is built

  /* Sections collapse.
   *
   * The panel began as timing controls and has since acquired search, layout,
   * appearance, study and diagnostics. Every one of them earns its place and
   * all of them at once is a column taller than the video it sits on. Folding
   * is the honest fix: nothing is removed, nothing is hidden behind a mode, and
   * the two sections in daily use are the ones that open by default.
   *
   * A real <button> for the header, so it is reachable by keyboard and says
   * what it does, rather than a div with a click handler. */
  function section(heading) {
    const wrap = document.createElement("div");
    wrap.className = "sso-sec";

    const head = document.createElement("button");
    head.type = "button";
    head.className = "sso-sec__h";

    const caret = document.createElement("span");
    caret.className = "sso-sec__caret";
    caret.textContent = "›"; // rotated by CSS when open
    const label = document.createElement("span");
    label.textContent = heading;
    head.append(caret, label);

    const apply = (open) => {
      wrap.dataset.open = open ? "true" : "false";
      head.setAttribute("aria-expanded", open ? "true" : "false");
    };
    apply(openSections?.has(heading) ?? OPEN_BY_DEFAULT.has(heading));

    head.addEventListener("click", () => {
      const open = wrap.dataset.open !== "true";
      apply(open);
      if (open) openSections.add(heading);
      else openSections.delete(heading);
      chrome.storage.local.set({ [OPEN_KEY]: [...openSections] }).catch(() => {});
      fitToViewport();
    });

    /* No wrapper around the contents: a closed section hides everything that is
     * not the header, with one CSS rule. That keeps every caller appending
     * straight to the section as it always did, and means folding cannot
     * introduce a layout box that changes how the contents lay out when open. */
    wrap.append(head);
    return wrap;
  }

  async function loadOpenSections() {
    if (openSections) return;
    try {
      const stored = await chrome.storage.local.get([OPEN_KEY, MORE_KEY]);
      openSections = new Set(stored[OPEN_KEY] || [...OPEN_BY_DEFAULT]);
      moreOpen = Boolean(stored[MORE_KEY]);
    } catch {
      openSections = new Set(OPEN_BY_DEFAULT);
    }
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

  // --- the two subtitles ----------------------------------------------------

  /* One card per subtitle, each holding everything that belongs to that one
   * subtitle: what it is, its timing, how big it is, whether it is showing.
   *
   * Grouped this way rather than as four sections of paired controls ("both
   * offsets", "both sizes") because every question asked here is about one of
   * the two - "the Turkish one is a second late", "the English one is too big" -
   * and the answer should be in one place, not split across the panel by
   * control type. */
  function buildTracks() {
    const wrap = section("Subtitles");

    el.noneNote = document.createElement("p");
    el.noneNote.className = "sso-note sso-note--strong";
    el.noneNote.textContent = "Nothing attached yet.";

    el.trackCards = [0, 1].map(buildTrackCard);

    /* Ad time is measured and subtracted automatically, but the detection
     * leans on player class names that change, so the total is shown and can
     * be thrown away when it is wrong. Shared: an ad interrupts the video, so
     * it moves both subtitles by the same amount. */
    el.adRow = document.createElement("div");
    el.adRow.className = "sso-row";
    el.adDrift = document.createElement("span");
    el.adDrift.className = "sso-note";
    el.adDrift.style.flex = "1";
    el.adRow.append(
      el.adDrift,
      button("Clear", { onClick: () => api.clearAdDrift(), title: "Forget measured ad time" }),
    );

    wrap.append(el.noneNote, ...el.trackCards.map((card) => card.root), el.adRow);
    return wrap;
  }

  /* Click to nudge, hold to run, and the longer it runs the bigger the steps.
   *
   * A quarter-second per click is right for the last adjustment and useless for
   * the first: a subtitle timed against a different release can be seventeen
   * seconds out, which is sixty-eight clicks. Escalating while held covers both
   * without a second pair of controls, a units menu, or the reader knowing in
   * advance how far out it is - hold until it looks right, let go.
   *
   * Toasts are suppressed while running, or every repeat would raise one; the
   * readout in the panel updates live and one toast lands on release.
   */
  const HOLD_DELAY_MS = 350; // a click stays a click
  const HOLD_TICK_MS = 80;
  const FAST_AFTER_MS = 900;
  const FASTER_AFTER_MS = 2400;

  function holdToRepeat(node, slot, direction) {
    let timer = null;
    let startedAt = 0;
    let ranOn = false;

    const stepFor = (heldMs) => {
      const { smallStepMs, largeStepMs } = api.status().settings;
      if (heldMs < FAST_AFTER_MS) return smallStepMs;
      if (heldMs < FASTER_AFTER_MS) return largeStepMs;
      return largeStepMs * 5;
    };

    const apply = (quiet) => {
      const held = startedAt ? Date.now() - startedAt : 0;
      const current = api.status().tracks[slot].offsetMs;
      api.setOffset(current + direction * stepFor(held), { slot, quiet });
    };

    const stop = () => {
      clearTimeout(timer);
      timer = null;
      if (!startedAt) return;
      startedAt = 0;
      // One toast for the whole gesture, naming where it ended up.
      api.setOffset(api.status().tracks[slot].offsetMs, { slot });
    };

    const tick = () => {
      apply(true);
      timer = setTimeout(tick, HOLD_TICK_MS);
    };

    node.addEventListener("pointerdown", (event) => {
      if (event.button !== 0) return;
      ranOn = true;
      startedAt = Date.now();
      apply(true);
      timer = setTimeout(tick, HOLD_DELAY_MS);
      node.setPointerCapture?.(event.pointerId);
    });

    for (const type of ["pointerup", "pointercancel", "pointerleave"]) {
      node.addEventListener(type, stop);
    }

    /* Keyboard activation still has to work, and it arrives as a click with no
     * pointer before it. The flag tells the two apart rather than letting a
     * mouse press count twice. */
    node.addEventListener("click", () => {
      if (ranOn) {
        ranOn = false;
        return;
      }
      startedAt = Date.now();
      apply(false);
      startedAt = 0;
    });

    return node;
  }

  function buildTrackCard(slot) {
    const root = document.createElement("div");
    root.className = "sso-track";

    const head = document.createElement("div");
    head.className = "sso-track__head";

    /* The radio says which subtitle the bracket keys move. There is one pair of
     * keys and two things they could shift, and this is the only place that
     * answer can be given without guessing it from where the pointer is. */
    const keyed = document.createElement("input");
    keyed.type = "radio";
    keyed.name = "sso-keytrack";
    keyed.title = "The nudge keys move this subtitle";
    keyed.addEventListener("change", () => api.setKeyTrack(slot));

    const label = document.createElement("span");
    label.className = "sso-track__label";

    head.append(keyed, label);

    /* Say what is wrong, not which way to push a number.
     *
     * What a viewer perceives is "the text came up before they spoke". Turning
     * that into a sign means knowing that film time is stream time minus the
     * offset, so a larger offset shows the line later - which nobody should
     * have to work out while a film is playing, and getting it backwards
     * doubles the error and makes the next guess harder.
     *
     * So the buttons carry the complaint and the readout says what was done
     * about it. Shift gives the coarse step, matching the bracket keys. */
    const offsets = document.createElement("div");
    offsets.className = "sso-row sso-sync";
    const offsetValue = document.createElement("span");
    offsetValue.className = "sso-offset";

    offsets.append(
      holdToRepeat(
        button("Text is early", {
          title:
            "The line appears before it is spoken, so hold it back. " +
            "Click to nudge, hold to run.",
        }),
        slot,
        +1,
      ),
      holdToRepeat(
        button("Text is late", {
          title:
            "The line appears after it is spoken, so bring it forward. " +
            "Click to nudge, hold to run.",
        }),
        slot,
        -1,
      ),
    );

    /* The readout sits under the buttons rather than between them. Three
     * controls and a reading do not fit across 340px - the Reset was rendering
     * past the edge of the panel - and they are two different things anyway:
     * above is what you tell it, below is what it did.
     *
     * The reading is also an input. Holding a button runs the offset up
     * quickly, but somebody who already knows the answer - a subtitle timed for
     * a release seventeen seconds out - should be able to say seventeen rather
     * than hold a button until it arrives. Signed seconds, with the words next
     * to it saying which way that is, so the number never has to be decoded
     * from the sign alone. */
    const offsetState = document.createElement("div");
    offsetState.className = "sso-row sso-sync__state";

    const offsetField = document.createElement("input");
    offsetField.type = "number";
    offsetField.step = "0.25";
    offsetField.className = "sso-sync__field";
    offsetField.title = "Seconds. Negative brings the subtitle forward.";
    offsetField.setAttribute("aria-label", "Offset in seconds");
    const commitField = () => {
      const seconds = Number(offsetField.value);
      if (Number.isFinite(seconds)) api.setOffset(Math.round(seconds * 1000), { slot });
    };
    offsetField.addEventListener("change", commitField);
    offsetField.addEventListener("keydown", (event) => {
      event.stopPropagation(); // typing must not reach the nudge bindings
      if (event.key === "Enter") commitField();
    });

    const unit = document.createElement("span");
    unit.className = "sso-note";
    unit.textContent = "s";

    const offsetReset = button("Reset", {
      onClick: () => api.setOffset(0, { slot }),
      title: "Back to the file's own timing",
    });
    offsetReset.className = "sso-linkish";
    offsetState.append(offsetField, unit, offsetValue, offsetReset);

    const size = slider("Size", 0.6, 2.2, 0.05, 1, (value) =>
      api.updateTrackSettings(slot, { fontScale: value }),
    );
    const width = slider("Width", 20, 100, 1, 80, (value) =>
      api.updateTrackSettings(slot, { widthPercent: value, placed: true }),
    );

    const actions = document.createElement("div");
    actions.className = "sso-row";
    const visible = button("Hide", {
      onClick: () => {
        const track = api.status().tracks[slot];
        api.setVisible(!track.visible, { slot });
      },
    });
    actions.append(visible, button("Detach", { onClick: () => api.detach(slot) }));

    root.append(head, offsets, offsetState, size.row, width.row, actions);
    return { root, keyed, label, offsetValue, offsetField, offsetReset, size, width, visible };
  }

  // --- search ---------------------------------------------------------------

  function buildSearch() {
    const wrap = section("Find a subtitle");

    /* Which subtitle a result attaches to. Named before the search rather than
     * per result, because it is one decision for the whole list and putting two
     * buttons on every row would double the width of a list that already has to
     * fit a film title, a release name and three tags. */
    const target = document.createElement("div");
    target.className = "sso-seg";
    el.targetButtons = [0, 1].map((slot) => {
      const b = button(`Subtitle ${slot + 1}`, {
        onClick: () => {
          targetSlot = slot;
          refresh(api.status());
        },
      });
      b.className = "sso-seg__b";
      target.append(b);
      return b;
    });

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

    /* A results list for a dual setup is mostly the wrong language: a search
     * for two languages returns both, and picking the Turkish one out of forty
     * English ones by reading tags is the slow part. The filter is built from
     * whatever the search actually returned rather than from a fixed list, so
     * it never offers a language with nothing behind it. */
    el.languageFilter = document.createElement("div");
    el.languageFilter.className = "sso-seg sso-seg--wrap";
    el.languageFilter.hidden = true;

    el.results = document.createElement("ul");
    el.results.className = "sso-results";

    wrap.append(target, row, el.searchNote, el.languageFilter, el.results);
    return wrap;
  }

  let languageChoice = "";

  function renderLanguageFilter(results) {
    const counts = new Map();
    for (const result of results) {
      const language = (result.language || "??").toLowerCase();
      counts.set(language, (counts.get(language) || 0) + 1);
    }

    // One language is not a choice, so there is nothing to show.
    el.languageFilter.hidden = counts.size < 2;
    if (el.languageFilter.hidden) {
      languageChoice = "";
      return;
    }

    const options = [["", `All ${results.length}`], ...[...counts].map(([lang, count]) => [lang, `${lang.toUpperCase()} ${count}`])];
    el.languageFilter.replaceChildren(
      ...options.map(([value, text]) => {
        const b = button(text, {
          onClick: () => {
            languageChoice = value;
            renderLanguageFilter(results);
            renderResults(results, lastThreshold);
          },
        });
        b.className = "sso-seg__b";
        b.dataset.on = value === languageChoice ? "true" : "false";
        return b;
      }),
    );
  }

  async function runSearch(query) {
    el.results.replaceChildren();
    el.searchNote.className = "sso-note";
    el.searchNote.textContent = "Searching…";

    /* From the worker, not from this frame. The panel is injected into whichever
     * frame holds the video, and on an embedded player that frame can see
     * neither the page's metadata nor its episode list. */
    const context = (await api.daemon("pageContext", {})) || {};
    const response = await api.daemon("search", {
      query,
      title: query ? "" : context.title || document.title,
      year: context.year ?? undefined,
      /* Sent even when the query was typed. The season and episode are facts
       * about what is on screen, not about the words in the box - and a viewer
       * typing "The Americans" is not asking for all six seasons at once. */
      season: context.season ?? undefined,
      episode: context.episode ?? undefined,
    });
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

    lastThreshold = response.auto_attach_threshold ?? 0.75;
    languageChoice = "";
    renderLanguageFilter(lastResults);
    renderResults(lastResults, lastThreshold);
  }

  let lastThreshold = 0.75;

  function renderResults(results, threshold) {
    const shown = languageChoice
      ? results.filter((result) => (result.language || "").toLowerCase() === languageChoice)
      : results;

    el.results.replaceChildren(
      ...shown.slice(0, 30).map((result) => {
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
    const slot = targetSlot;
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
      language: result.language || "",
      slot,
    });
    el.searchNote.textContent = "";
    // Point at the other one, so attaching a second subtitle is finding it and
    // clicking it rather than finding it, remembering to change the target,
    // and clicking it.
    targetSlot = slot === 0 ? 1 : 0;
    refresh(api.status());
  }

  async function bestPageTitle() {
    const context = await api.daemon("pageContext", {});
    return context?.title || api.pageInfo().candidates[0]?.text || document.title;
  }

  // --- arrangement ----------------------------------------------------------

  /* Two buttons that put both subtitles somewhere sensible at once.
   *
   * They are actions, not a stored layout mode. A mode would have to either
   * yield to the next drag - making it not a mode - or resist it, which would
   * break dragging. So these write the two positions and then stop having an
   * opinion, and the drag remains the only thing that owns position. */
  function buildArrangement() {
    const wrap = section("Arrangement");

    const row = document.createElement("div");
    row.className = "sso-row";
    row.append(
      button("Side by side", {
        onClick: () => api.arrange("side"),
        title: "One on the left half, one on the right",
      }),
      button("Stacked", {
        onClick: () => api.arrange("stacked"),
        title: "One above the other, along the bottom",
      }),
      button("Reset", { onClick: () => api.resetPosition(), title: "Both back to bottom centre" }),
    );

    el.positionRow = document.createElement("div");
    el.positionRow.className = "sso-row";
    el.position = document.createElement("span");
    el.position.className = "sso-note";
    el.position.style.flex = "1";
    el.placeButton = button("Move", {
      onClick: () => api.setPlacing(!api.status().placing),
      title: "Show a stand-in you can drag, so you need not catch a passing line",
    });
    el.positionRow.append(el.position, el.placeButton);

    wrap.append(row, el.positionRow);
    return wrap;
  }

  // --- appearance -----------------------------------------------------------

  /* What is left here is what both subtitles share. Size and width are per
   * subtitle and live on the track cards above, next to the subtitle they
   * belong to. */
  function buildAppearance() {
    const wrap = section("Appearance");
    const settings = api.status().settings;

    el.background = slider("Backdrop", 0, 1, 0.05, settings.background, (value) =>
      api.updateSettings({ background: value }),
    );

    el.rewrap = toggle_("Rewrap lines", settings.rewrap, (on) =>
      api.updateSettings({ rewrap: on }),
    );
    el.rewrap.row.title =
      "Let the width decide where lines break, instead of the subtitle file, " +
      "which wrapped them for a 4:3 television. Turns between speakers are kept.";

    el.showSymbols = toggle_("Sound symbols", settings.showSymbols, (on) =>
      api.updateSettings({ showSymbols: on }),
    );
    el.dimNonSpeech = toggle_("Dim non-speech", settings.dimNonSpeech, (on) =>
      api.updateSettings({ dimNonSpeech: on }),
    );

    wrap.append(
      el.background.row,
      el.rewrap.row,
      el.showSymbols.row,
      el.dimNonSpeech.row,
    );
    return wrap;
  }

  // --- study ----------------------------------------------------------------

  /* The controls for turning a film into vocabulary.
   *
   * study.js owns these settings rather than content.js, because the whole
   * feature is optional and nothing about ordinary watching should have to know
   * it exists. That is why this section reads through window.__ssoStudy and
   * hides itself when that file did not load. */
  function buildStudy() {
    const wrap = section("Study");
    el.studySection = wrap;

    const note = document.createElement("p");
    note.className = "sso-note";
    note.textContent =
      "Marks the words in each line that are rare in film dialogue, and shows what they mean at " +
      "the side. Hover any word to look it up; shift-drag across words for a phrase.";

    el.studyEnabled = toggle_("Study mode", false, (on) => window.__ssoStudy?.setEnabled(on));
    el.studyAuto = toggle_("Look up rare words as they are said", true, (on) =>
      window.__ssoStudy?.updateSettings({ auto: on }),
    );
    el.studyPause = toggle_("Pause when a word is clicked", false, (on) =>
      window.__ssoStudy?.updateSettings({ pauseOnPin: on }),
    );

    /* The threshold is a slider because the right value is a property of the
     * reader, not of the film: rank 2000 is where a beginner stops recognising
     * words and rank 12000 is where somebody comfortable does. Nothing else can
     * know which of those is on the sofa. */
    el.studyRank = slider("Rarer than rank", 500, 25000, 500, 4000, (value) =>
      window.__ssoStudy?.updateSettings({ rarityRank: value }),
    );
    el.studyRank.row.title =
      "A word this far down the frequency list, or missing from it, gets underlined. " +
      "Lower catches more words.";

    const which = document.createElement("div");
    which.className = "sso-row";
    const whichLabel = document.createElement("span");
    whichLabel.className = "sso-note";
    whichLabel.style.flex = "1";
    whichLabel.textContent = "Language being learnt";
    el.studySlotButtons = [0, 1].map((slot) => {
      const b = button(`Subtitle ${slot + 1}`, {
        onClick: () => window.__ssoStudy?.updateSettings({ studySlot: slot }),
      });
      b.className = "sso-seg__b";
      return b;
    });
    which.append(whichLabel, ...el.studySlotButtons);

    const actions = document.createElement("div");
    actions.className = "sso-row";
    actions.style.marginTop = "8px";
    actions.append(
      button("Saved words", {
        onClick: () => chrome.runtime.sendMessage({ type: "sso:openOptions", hash: "#deck" }),
        title: "Open the deck on the options page",
      }),
    );

    wrap.append(
      note,
      el.studyEnabled.row,
      el.studyAuto.row,
      el.studyRank.row,
      which,
      el.studyPause.row,
      actions,
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

  // --- diagnostics ----------------------------------------------------------

  /* When a page does not work, the reason is nearly always something no single
   * frame can see: the metadata is in one frame and the video in another, or
   * the title that got searched for is not the title on screen. This asks every
   * frame what it sees, runs the real decision code, and opens the result.
   *
   * It costs no download quota - the capture searches, which is free, and never
   * fetches. */
  function buildDiagnostics() {
    const wrap = section("If this page is not working");

    const note = document.createElement("p");
    note.className = "sso-note";
    note.textContent =
      "Captures what each frame of this page can see and what the search would do with it, " +
      "then opens the result. No downloads are spent.";

    const row = document.createElement("div");
    row.className = "sso-row";
    el.diagnose = button("Diagnose this page", {
      primary: true,
      onClick: runDiagnostic,
    });
    row.append(el.diagnose);

    el.diagnoseNote = document.createElement("p");
    el.diagnoseNote.className = "sso-note";

    wrap.append(note, row, el.diagnoseNote);
    return wrap;
  }

  async function runDiagnostic() {
    el.diagnose.disabled = true;
    el.diagnoseNote.className = "sso-note";
    el.diagnoseNote.textContent = "Asking every frame…";
    try {
      const report = await api.daemon("diagnose", {});
      if (!report || report.error || report.transportError) {
        el.diagnoseNote.className = "sso-note sso-note--warn";
        el.diagnoseNote.textContent =
          report?.error || report?.transportError || "The capture failed.";
        return;
      }
      el.diagnoseNote.textContent = `Captured ${report.frames?.length ?? 0} frame(s). Opening…`;
      // The page cannot open an extension page itself; the worker can.
      await chrome.runtime.sendMessage({ type: "sso:openReport" });
    } finally {
      el.diagnose.disabled = false;
    }
  }

  // --- dragging -------------------------------------------------------------

  /* Dragging, against a page that may have moved the coordinate system.
   *
   * `position: fixed` is only relative to the viewport while no ancestor has a
   * transform, filter, perspective, backdrop-filter or `will-change` naming one
   * - any of those makes that ancestor the containing block instead. Video
   * players use transforms routinely, and the overlay re-parents itself into
   * the fullscreen element, so the panel regularly lands inside one.
   *
   * The symptom is precise and was reported precisely: the panel moves, but not
   * with the pointer. `left: 300px` puts it 300px from the *ancestor*, while
   * `event.clientX` is measured from the viewport, so every position is out by
   * the ancestor's offset and the panel slides away under the cursor.
   *
   * Rather than hunt for the offending ancestor, measure the error once: write
   * a position, read back where the element actually landed, and keep the
   * difference. Every position afterwards is corrected by it. This is exact for
   * an offset containing block and costs one extra layout read per drag.
   */
  function makeDraggable(handle) {
    let origin = null;

    const place = (x, y) => setPosition(`${x}px`, `${y}px`);

    handle.addEventListener("pointerdown", (event) => {
      if (event.target.closest("button")) return;
      const box = host.getBoundingClientRect();

      // Solve the page's coordinate system, then put the panel back where the
      // probe found it. Both happen in this handler, so nothing is painted in
      // between and the panel does not flinch.
      const map = api.measurePlacement(host, place);
      const back = map.toLocal(box.left, box.top);
      place(back.x, back.y);

      origin = {
        map,
        // Where in the panel it was grabbed, so it does not jump on first move.
        grabX: event.clientX - box.left,
        grabY: event.clientY - box.top,
      };
      handle.dataset.dragging = "true";
      handle.setPointerCapture(event.pointerId);
    });

    handle.addEventListener("pointermove", (event) => {
      if (!origin) return;
      // A live drag with nothing pressed means the release was lost. Same guard
      // as the subtitle's, for the same reason - see onCuePointerMove.
      if (event.buttons === 0) {
        end(event);
        return;
      }
      const box = host.getBoundingClientRect();
      /* Clamped in viewport pixels, because the screen is what the panel must
       * stay on. The header's height is the bound rather than a round number:
       * it is the part that drags the panel back, so it is the part that has to
       * remain reachable. */
      const headerHeight = handle.getBoundingClientRect().height || 34;
      const maxLeft = Math.max(0, window.innerWidth - box.width);
      const maxTop = Math.max(0, window.innerHeight - headerHeight);
      const left = Math.min(Math.max(0, event.clientX - origin.grabX), maxLeft);
      const top = Math.min(Math.max(0, event.clientY - origin.grabY), maxTop);

      const local = origin.map.toLocal(left, top);
      place(local.x, local.y);
      // Dragging down the screen leaves less room beneath.
      fitToViewport();
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
    // Dragging replaces the right-anchor with an explicit position; keeping
    // both would fight and pin the width.
    host.style.setProperty("right", "auto", "important");
    host.style.setProperty("left", left, "important");
    host.style.setProperty("top", top, "important");
  }

  /* A window narrow enough to push a dragged panel off-screen would otherwise
   * strand it there with no way back. */
  function clampIntoView() {
    if (!host || host.hidden) return;
    const box = host.getBoundingClientRect();
    if (box.left === 0 && box.width === 0) return;
    const maxLeft = Math.max(0, window.innerWidth - box.width);
    const maxTop = Math.max(0, window.innerHeight - 40);
    if (box.left > maxLeft || box.top > maxTop) {
      setPosition(`${Math.min(box.left, maxLeft)}px`, `${Math.min(box.top, maxTop)}px`);
    }
    // A shorter window leaves less room under the panel, not just less room for
    // it - so the list has to shrink as well as the panel moving.
    fitToViewport();
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
    const settings = status.settings;
    /* Attaching a second subtitle adds a whole card, so the panel gets taller
     * while it is open. Re-fitting on every status round keeps it on the screen
     * without anything having to remember to ask. */
    queueMicrotask(fitToViewport);

    el.noneNote.hidden = status.attached;
    el.noneNote.textContent = status.hasVideo
      ? "Nothing attached yet."
      : "No video detected on this page.";

    status.tracks.forEach((track, slot) => {
      const card = el.trackCards[slot];
      const geometry = settings.tracks[slot];
      /* An empty track's card is not shown at all. A second set of controls
       * that do nothing is worse than no second set: it says the feature is
       * broken rather than unused. */
      card.root.hidden = !track.attached;
      if (!track.attached) return;

      card.label.textContent =
        `${slot + 1}. ${track.label || "Attached"} · ` +
        `${track.cueCount} line${track.cueCount === 1 ? "" : "s"}`;
      card.keyed.checked = status.keyTrack === slot;
      // With one subtitle there is nothing for the keys to be ambiguous about.
      card.keyed.hidden = status.trackCount < 2;
      card.offsetValue.textContent = api.describeOffset(track.offsetMs);
      card.offsetValue.dataset.set = track.offsetMs ? "true" : "false";
      // Nothing to undo means no undo button, which is also the width that lets
      // the reading sit on one line.
      card.offsetReset.hidden = !track.offsetMs;
      // Not while it is being typed into, or the value rewrites itself under
      // the cursor between keystrokes.
      if (shadow.activeElement !== card.offsetField) {
        card.offsetField.value = String(Math.round(track.offsetMs) / 1000);
      }
      card.visible.textContent = track.visible ? "Hide" : "Show";
      card.size.input.value = String(geometry.fontScale);
      card.size.readout.textContent = String(geometry.fontScale);
      card.width.input.value = String(Math.round(geometry.widthPercent));
      card.width.readout.textContent = `${Math.round(geometry.widthPercent)}%`;
    });

    const drift = status.adDriftMs || 0;
    el.adRow.hidden = !status.attached || (drift === 0 && !status.inAd);
    el.adDrift.textContent = status.inAd
      ? "Ad playing — subtitles paused"
      : `Ad time removed: ${(drift / 1000).toFixed(0)}s`;

    for (const [slot, b] of el.targetButtons.entries()) {
      b.dataset.on = targetSlot === slot ? "true" : "false";
      b.textContent = status.tracks[slot].attached ? `Subtitle ${slot + 1} ⟳` : `Subtitle ${slot + 1}`;
      b.title = status.tracks[slot].attached
        ? "Replace what is on this one"
        : "Attach the next result here";
    }

    el.background.input.value = String(settings.background);
    el.background.readout.textContent = String(settings.background);
    el.placeButton.textContent = status.placing ? "Done" : "Move";
    el.position.textContent = status.placing
      ? "Drag a stand-in, then Done"
      : "Drag the middle of a subtitle to move it, an edge to resize";
    el.rewrap.input.checked = Boolean(settings.rewrap);
    el.showSymbols.input.checked = Boolean(settings.showSymbols);
    el.dimNonSpeech.input.checked = Boolean(settings.dimNonSpeech);

    refreshStudy();

    for (const [name] of KEY_FIELDS) {
      el.keyButtons[name].textContent = describeCode(settings.keys[name]);
    }
    el.keysToggle.textContent = settings.keysEnabled ? "Disable keys" : "Enable keys";
  }

  function refreshStudy() {
    const study = window.__ssoStudy?.settings?.();
    // study.js is a separate content script; if it did not load there is
    // nothing to configure and the section should not claim otherwise.
    el.studySection.hidden = !study;
    if (!study) return;

    el.studyEnabled.input.checked = study.enabled;
    el.studyAuto.input.checked = study.auto;
    el.studyPause.input.checked = study.pauseOnPin;
    el.studyRank.input.value = String(study.rarityRank);
    el.studyRank.readout.textContent = study.rarityRank.toLocaleString();
    for (const [slot, b] of el.studySlotButtons.entries()) {
      b.dataset.on = study.studySlot === slot ? "true" : "false";
    }

    // Everything below the switch only means something once it is on.
    for (const row of [el.studyAuto.row, el.studyRank.row, el.studyPause.row]) {
      row.dataset.off = study.enabled ? "false" : "true";
    }
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
    // Point the next attach at the first free subtitle, which is what somebody
    // opening the panel is nearly always about to fill.
    const status = api.status();
    targetSlot = status.tracks.findIndex((track) => !track.attached);
    if (targetSlot === -1) targetSlot = 0;
    refresh(status);
    /* After the position is restored and the contents are drawn, never before:
     * how much room is under the panel depends on where the panel is, and
     * build() runs while it is still in the default corner. Fitting there and
     * not again let a panel restored halfway down the screen hang off the
     * bottom, taking the second tier of settings with it. */
    fitToViewport();
    // Asynchronous now that it crosses to the worker, so it fills in a moment
    // after the panel appears rather than holding it up.
    if (!el.query.value) bestPageTitle().then((title) => {
      if (!el.query.value) el.query.value = title;
    });
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
  window.addEventListener("resize", clampIntoView, { passive: true });

  window.__ssoPanel = { show, hide, toggle, reparent, isCapturingKey };

  window.__ssoPanelTeardown = () => {
    document.removeEventListener("keydown", onCaptureKey, true);
    window.removeEventListener("resize", clampIntoView);
    unsubscribe?.();
    unsubscribe = null;
    host?.remove();
    host = null;
    shadow = null;
    delete window.__ssoPanel;
    delete window.__ssoPanelTeardown;
  };
})();
