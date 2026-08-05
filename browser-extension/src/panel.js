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
  let sheets = null;

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
  /* Two sheets, not one. chrome.css carries what makes this a window - surface,
   * title bar, head buttons, corner grips, folded state - and the study rail
   * adopts the same one, which is what stops the two floating surfaces drifting
   * into different visual languages again. It goes first so panel.css can
   * override any of it. */
  async function loadStyles() {
    if (sheets) return sheets;
    const files = ["src/chrome.css", "src/panel.css"];
    const texts = await Promise.all(
      files.map((file) => fetch(chrome.runtime.getURL(file)).then((r) => r.text())),
    );
    sheets = texts.map((css) => {
      const made = new CSSStyleSheet();
      made.replaceSync(css);
      return made;
    });
    return sheets;
  }

  async function build() {
    await loadOpenSections();
    host = createHost();
    shadow = host.attachShadow({ mode: "open" });
    shadow.adoptedStyleSheets = await loadStyles();

    const panel = document.createElement("div");
    panel.className = "sso-win sso-panel";
    el.panel = panel;

    const head = document.createElement("div");
    head.className = "sso-win__head";
    const title = document.createElement("div");
    title.className = "sso-win__title";
    title.textContent = "Subtitle Overlay";

    el.title = title;

    /* Back out of a screen. It lives in the title bar because that is where the
     * screen's name is, and it is a "‹" rather than a "▸" deliberately: the
     * generic window tests find the fold button by matching /^[▾▸]$/ across the
     * head's buttons, and a back arrow drawn with a caret would be picked up as
     * the fold. */
    el.back = document.createElement("button");
    el.back.className = "sso-icon sso-panel__back";
    el.back.type = "button";
    el.back.textContent = "‹";
    el.back.title = "Back";
    el.back.hidden = true;
    el.back.addEventListener("click", goRoot);

    /* What is attached, in the title bar. Folded, the bar is all that is left
     * on screen, so it has to carry the one fact that decides whether the panel
     * is worth opening again. */
    el.state = document.createElement("span");
    el.state.className = "sso-panel__state";

    /* Everything that is not about one subtitle. It was five sections in the
     * column behind a "More settings" button; the sections already fold, so the
     * button was a second fold on top of a fold. */
    el.gear = document.createElement("button");
    el.gear.className = "sso-icon";
    el.gear.type = "button";
    el.gear.textContent = "⚙";
    el.gear.title = "Settings";
    el.gear.addEventListener("click", () => openSettings());

    /* Folds to the title bar, the same control the study rail has. Different
     * from closing: the panel stays where it was put and at the size it was
     * given, so a glance at the film does not cost finding it again. */
    el.fold = document.createElement("button");
    el.fold.className = "sso-icon";
    el.fold.type = "button";
    el.fold.addEventListener("click", () => setFolded(!folded));

    const close = document.createElement("button");
    close.className = "sso-icon sso-icon--close";
    close.type = "button";
    close.textContent = "×";
    close.title = "Close";
    close.addEventListener("click", hide);
    head.append(el.back, title, el.state, el.gear, el.fold, close);

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

    /* Screens, not a column of sections.
     *
     * The panel used to stack seven sections and then fold five of them behind
     * a "More settings" button - a second fold on top of a fold, in a column
     * that was still taller than the film it sits on. What it was really doing
     * was mixing two kinds of thing: the subtitles you are watching, and the
     * places you go to set something up.
     *
     * So the root is the subtitles and nothing else, and everything else is
     * somewhere you go and come back from. Screens are in flow - siblings in
     * the body with all but one hidden - rather than absolutely positioned,
     * because fitToViewport works out the furniture height by subtracting the
     * body's height from the host's, and an out-of-flow screen would leave the
     * body sized for whichever screen is not showing. In flow, the scroll
     * container, its overscroll containment and the height fit all keep working
     * untouched.
     *
     * All of them are built now and hidden, not built on demand: half the
     * panel's own code reaches for el.query, and a screen that does not exist
     * yet is a null every one of those has to learn about. */
    el.screens = {
      root: screen(buildTracks()),
      find: screen(buildSearch()),
      style: screen(buildStyle()),
    };
    body.append(...Object.values(el.screens));

    panel.append(head, body, ...buildResizeGrips(body));
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

  /* All four corners, not just the bottom-right.
   *
   * Reported from fullscreen: the one corner that resized was off the bottom of
   * the screen and there was no way to reach it. A panel that can only be
   * resized from the corner furthest from the top-left is a panel that cannot
   * be resized whenever it is near the bottom, which is exactly when it is too
   * big. Dragging a left or top corner also moves the panel, so the opposite
   * corner stays where it is - which is what makes a corner feel like a corner
   * rather than a slider.
   */
  const CORNERS = [
    { name: "nw", dx: -1, dy: -1, cursor: "nwse-resize" },
    { name: "ne", dx: +1, dy: -1, cursor: "nesw-resize" },
    { name: "sw", dx: -1, dy: +1, cursor: "nesw-resize" },
    { name: "se", dx: +1, dy: +1, cursor: "nwse-resize" },
  ];

  function buildResizeGrips(body) {
    return CORNERS.map((corner) => buildResizeGrip(body, corner));
  }

  function buildResizeGrip(body, corner) {
    const grip = document.createElement("div");
    grip.className = `sso-grip sso-grip--${corner.name}`;
    grip.style.cursor = corner.cursor;
    grip.title = "Drag to resize";

    let from = null;
    grip.addEventListener("pointerdown", (event) => {
      const box = host.getBoundingClientRect();
      from = {
        x: event.clientX,
        y: event.clientY,
        width: box.width,
        height: body.getBoundingClientRect().height,
        left: box.left,
        top: box.top,
        map: api.measurePlacement(host, (x, y) => setPosition(`${x}px`, `${y}px`)),
      };
      // measurePlacement moved it; put it back before the drag begins.
      const back = from.map.toLocal(box.left, box.top);
      setPosition(`${back.x}px`, `${back.y}px`);

      grip.setPointerCapture?.(event.pointerId);
      event.preventDefault();
      event.stopPropagation();
    });

    grip.addEventListener("pointermove", (event) => {
      if (!from) return;
      if (event.buttons === 0) {
        end(event);
        return;
      }
      const movedX = (event.clientX - from.x) * corner.dx;
      const movedY = (event.clientY - from.y) * corner.dy;

      const width = clamp(from.width + movedX, MIN_WIDTH, MAX_WIDTH);
      const height = clamp(
        from.height + movedY,
        MIN_BODY,
        Math.max(MIN_BODY, window.innerHeight - 120),
      );
      applySize(width, height);

      /* Pulling a left or top edge grows the panel away from the pointer unless
       * the opposite edge is pinned, so move it by however much it actually
       * grew - which is not what the pointer did once the size hit a limit. */
      const grewX = corner.dx < 0 ? width - from.width : 0;
      const grewY = corner.dy < 0 ? body.getBoundingClientRect().height - from.height : 0;
      if (grewX || grewY) {
        const local = from.map.toLocal(from.left - grewX, from.top - grewY);
        setPosition(`${local.x}px`, `${local.y}px`);
      }
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

  /* Undo whatever the page has scaled us by.
   *
   * In fullscreen the panel re-parents into the player's fullscreen element,
   * and if the player has scaled that element the panel is scaled with it -
   * reported as the panel rendering bigger in fullscreen, with its resize
   * corner pushed off the screen. Counter-scaling puts it back at the size it
   * was designed at, whatever the page is doing around it.
   *
   * The transform is cleared before measuring, or the second call would measure
   * the correction it applied the first time and converge on nothing. */
  function rescale() {
    if (!host || host.hidden) return;
    host.style.removeProperty("transform");
    const rendered = host.getBoundingClientRect().width;
    const asked = host.offsetWidth;
    const scale = asked > 0 && rendered > 0 ? rendered / asked : 1;

    if (Math.abs(scale - 1) > 0.01) {
      host.style.setProperty("transform", `scale(${(1 / scale).toFixed(4)})`, "important");
      host.style.setProperty("transform-origin", "top left", "important");
    } else {
      host.style.removeProperty("transform-origin");
    }
    fitToViewport();
  }

  const clamp = (value, low, high) => Math.min(Math.max(value, low), high);

  /* The height the user asked for, which is not always the height they can
   * have: a panel dragged down the screen has less room beneath it than one in
   * the corner. Kept apart from what gets applied so that moving it back up
   * restores the size rather than having silently lost it. */
  let preferredBody = 420;
  /* Whether a corner has been dragged.
   *
   * Until it has, the panel is as tall as it needs to be and no taller, capped
   * by the room under it - which is right for a surface that grows a card when
   * a subtitle is attached. After it has, the height is the reader's answer and
   * it is applied whether or not the contents need it, because "I could not
   * make the panel bigger when it was already fitting" is a panel refusing an
   * instruction on the grounds that it knows better. */
  let sizedByHand = false;

  function applySize(width, bodyHeight, { byHand = true } = {}) {
    if (byHand && bodyHeight != null) sizedByHand = true;
    // Inline !important, like every other geometry property on the host: the
    // page's own rules reach the host and a plain assignment would lose to them.
    host.style.setProperty("width", `${Math.round(width)}px`, "important");
    // A width-only call - the harness measures the sync row at several widths -
    // must not throw the stored height away.
    if (bodyHeight != null) preferredBody = bodyHeight;
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
    const wanted = Math.round(Math.max(MIN_BODY, Math.min(preferredBody, available)));
    /* A cap until a corner has been dragged, a height after.
     *
     * max-height alone can only ever make a box shorter than its contents, so
     * dragging a corner downwards on a panel whose contents already fitted did
     * nothing at all - the number was stored and the panel did not move. */
    if (sizedByHand) {
      body.style.setProperty("height", `${wanted}px`);
      body.style.setProperty("max-height", `${wanted}px`);
    } else {
      body.style.removeProperty("height");
      body.style.setProperty("max-height", `${wanted}px`);
    }
  }

  async function restoreSize() {
    try {
      const stored = await chrome.storage.local.get([SIZE_KEY, FOLD_KEY]);
      const size = stored[SIZE_KEY];
      if (size?.width) {
        applySize(size.width, size.body ?? null, { byHand: false });
        // A stored body height means a corner was dragged in an earlier
        // session, and that is still the reader's answer.
        if (size.body) { sizedByHand = true; preferredBody = size.body; }
      }
      setFolded(stored[FOLD_KEY] === true);
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
  const SIZE_KEY = "sso:panelSize";
  const FOLD_KEY = "sso:panelFolded";
  let folded = false;

  /* Folded is the panel's own state rather than a setting, but it survives a
   * reload for the same reason the position does: it is where the reader left
   * their tools, and having them spring open again is the thing they folded
   * them to avoid. */
  function setFolded(next) {
    closeMenu();
    folded = Boolean(next);
    if (el.panel) el.panel.dataset.folded = folded ? "true" : "false";
    if (el.fold) {
      el.fold.textContent = folded ? "▸" : "▾";
      el.fold.title = folded ? "Open the panel" : "Fold to the title bar";
    }
    /* Folding goes back to the root. Otherwise the bar reads "SETTINGS ‹" with
     * nothing under it, and the only way out is to unfold first - so folded is
     * always one state rather than three. Reopening does the same, for the same
     * reason: a panel that comes back on a screen you left is a panel you have
     * to work out. */
    if (folded && atScreen !== "root") goRoot();
    chrome.storage.local.set({ [FOLD_KEY]: folded }).catch(() => {});
    // Folding frees the space the body was holding; unfolding needs it back,
    // and near the bottom of the screen there may be less of it than there was.
    fitToViewport();
  }

  /* Which sections start open. The two that answer "what is on screen and how
   * do I change it" - everything else is set once and then left alone, and a
   * panel that shows all seven at full height is taller than the film. */
  /* Sections now live only inside Settings, where five of them share one
   * screen. The subtitles and the search have screens of their own, and a
   * screen with one section on it is a fold with nothing to fold against.
   *
   * Arrangement opens by default because it is the one a reader arrives at
   * Settings for; the rest are set once. */
  const OPEN_BY_DEFAULT = new Set(["Arrangement"]);
  let openSections = null; // filled from storage before the panel is built
  const sections = new Map(); // heading -> { apply, wrap }

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
    sections.set(heading, { apply, wrap });
    return wrap;
  }

  async function loadOpenSections() {
    if (openSections) return;
    try {
      const stored = await chrome.storage.local.get(OPEN_KEY);
      openSections = new Set(stored[OPEN_KEY] || [...OPEN_BY_DEFAULT]);
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
    /* No heading. The screen has a title bar that says what it is, and a
     * "SUBTITLES" header directly under "SUBTITLE OVERLAY" is the same word
     * twice - and a fold on a screen that is the only thing there. Sections
     * survive inside Settings, where several of them share one screen. */
    const wrap = document.createElement("div");

    /* Nothing attached is the first thing most readers see, so it is a state
     * that was designed rather than the sentence that fits where the content
     * would go. It says what the panel is for, why it is empty, and carries the
     * control that ends the emptiness - which is the whole point, because the
     * search that answers it is a section further down and behind a heading. */
    el.none = document.createElement("div");
    el.none.className = "sso-empty";
    el.noneTitle = document.createElement("div");
    el.noneTitle.className = "sso-empty__title";
    el.noneNote = document.createElement("p");
    el.noneNote.className = "sso-empty__note";
    /* The panel's one primary, and the only moment it has one: nothing
     * attached is the only state here with a single obvious next action. It
     * goes to the Find screen with the cursor in the field, which is already
     * filled with the page's own title. */
    el.noneAction = button("Find a subtitle", {
      primary: true,
      onClick: () => openFind(0),
    });
    el.none.append(el.noneTitle, el.noneNote, el.noneAction);

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

    /* The same undo the toast offers, in the list the subtitle was removed
     * from. A toast button is out of reach from the keyboard while the film is
     * fullscreen, and it is gone in seven seconds; this row is where somebody
     * who looked away would come looking. */
    el.undoRow = document.createElement("div");
    el.undoRow.className = "sso-undo";
    el.undoLabel = document.createElement("span");
    el.undoLabel.className = "sso-undo__label";
    el.undoRow.append(
      el.undoLabel,
      button("Undo", { onClick: () => { api.undoRemove(); refresh(api.status()); } }),
    );

    /* The way to a second subtitle, from the list it will join. Finding one
     * used to be a separate section with its own heading and its own question
     * about which slot to fill; pressing the plus on the list answers that
     * question by being pressed. */
    el.add = button("＋  Add a subtitle", {
      onClick: () => openFind(api.status().tracks.findIndex((t) => !t.attached)),
    });
    el.add.className = "sso-add";

    wrap.append(
      el.none,
      ...el.trackCards.map((card) => card.root),
      el.undoRow,
      el.add,
      el.adRow,
    );
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

  function holdToRepeat(node, slot, direction, size = "small") {
    let timer = null;
    let startedAt = 0;
    let ranOn = false;

    /* Where on the ladder a button starts. The escalation was the only way to
     * cover both a quarter-second trim and a seventeen-second correction, and
     * it works - but it made the first press of every gesture the smallest
     * possible one, so a reader who already knew the subtitle was seconds out
     * had to hold a button and wait for it to agree. The large button starts a
     * rung up and escalates from there; the small one is unchanged. */
    const stepFor = (heldMs) => {
      const { smallStepMs, largeStepMs } = api.status().settings;
      const base = size === "large" ? largeStepMs : smallStepMs;
      if (heldMs < FAST_AFTER_MS) return base;
      if (heldMs < FASTER_AFTER_MS) return size === "large" ? largeStepMs * 5 : largeStepMs;
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

    /* Two attached subtitles is the normal way this tool is used - the language
     * being learnt and the one it is being learnt from - and two open cards is
     * the same seven controls twice, three hundred and fifty pixels of
     * near-identical layout whose differences are two small numbers. So a card
     * folds to its title, on the same idiom the study rail uses for a word.
     *
     * `open` is undefined until the reader says otherwise, and the default is
     * then "the one the keys are pointed at, or the only one there is". Once
     * they have clicked, their answer stands. */
    const caret = document.createElement("button");
    caret.className = "sso-track__caret";
    caret.type = "button";
    caret.addEventListener("click", (event) => {
      event.stopPropagation();
      toggleTrack(slot);
    });

    /* The radio says which subtitle the bracket keys move. There is one pair of
     * keys and two things they could shift, and this is the only place that
     * answer can be given without guessing it from where the pointer is.
     *
     * It sits in a chip that says "keys", because a bare radio in a title row
     * is a dot whose meaning has to be guessed - and the guess a reader makes
     * is usually "this is the selected one", which is a different question with
     * a different answer. */
    const keyed = document.createElement("input");
    keyed.type = "radio";
    keyed.name = "sso-keytrack";
    keyed.setAttribute("aria-label", "The nudge keys move this subtitle");
    keyed.addEventListener("change", () => api.setKeyTrack(slot));

    const keysChip = document.createElement("label");
    keysChip.className = "sso-track__keys";
    keysChip.title = "The [ and ] keys nudge this subtitle";
    const keysWord = document.createElement("span");
    keysWord.textContent = "keys";
    keysChip.append(keyed, keysWord);
    keysChip.addEventListener("click", (event) => event.stopPropagation());

    const label = document.createElement("span");
    label.className = "sso-track__label";

    /* What a shut card still has to answer. Open, the readout below says it in
     * full; shut, this is the only line there is. */
    const shut = document.createElement("span");
    shut.className = "sso-track__shut";

    /* Everything this subtitle can have done to it, on demand.
     *
     * These were four permanent controls on the card - Hide, Remove, Reset
     * timing, and two sliders - none of which is touched while a film plays.
     * Behind one button they stop competing with the timing row, which is the
     * only thing here that is. Remove goes last, after a rule and in the danger
     * ink, because a menu makes it one tap with no confirmation; the undo is
     * what makes that safe. */
    const more = document.createElement("button");
    more.className = "sso-icon sso-track__more";
    more.type = "button";
    more.textContent = "⋯";
    more.title = "What can be done to this subtitle";
    more.setAttribute("aria-haspopup", "menu");
    more.addEventListener("click", (event) => {
      event.stopPropagation();
      // A click from a key press carries detail 0. The menu uses this to decide
      // whether to take focus, so a mouse user is not shown a focus ring.
      more.dataset.viaKey = event.detail === 0 ? "true" : "false";
      const status = api.status();
      /* Read once, and safely. `__ssoStudy?.settings?.().enabled` looks guarded
       * and is not: when study.js has not loaded, `settings?.()` is undefined
       * and reading `.enabled` off it throws - which would take out the whole
       * menu, on a surface that has nothing to do with study. */
      const study = window.__ssoStudy?.settings?.() || null;
      menu(more, [
        {
          label: "Style…",
          title: "Colour, font, size, outline",
          onClick: () => openStyle(slot),
        },
        {
          label: "Study this one",
          title: "Mark the rare words in this subtitle instead",
          hidden: !study?.enabled || status.trackCount < 2 || study.studySlot === slot,
          onClick: () => {
            window.__ssoStudy?.updateSettings({ studySlot: slot });
            refresh(api.status());
          },
        },
        {
          label: "Nudge with the keys",
          title: "Point the [ and ] keys at this subtitle",
          hidden: status.trackCount < 2 || status.keyTrack === slot,
          onClick: () => api.setKeyTrack(slot),
        },
        {
          label: "Line up with the other",
          title: "Work out the gap from where the two subtitles say the same things",
          hidden: status.trackCount < 2,
          onClick: () => lineUp(slot),
        },
        {
          label: "Replace…",
          title: "Find a different subtitle for this one",
          onClick: () => openFind(slot),
        },
        null,
        { label: "Remove", danger: true, onClick: () => removeTrack(slot) },
      ]);
    });

    /* Which subtitle is the language being learnt.
     *
     * It was a "Subtitle 1 / Subtitle 2" pair in the study section - a third
     * copy of that control, in a third place, meaning a third thing. It names a
     * subtitle, so it belongs on that subtitle, beside the other chip that says
     * what this one is for. */
    const learnChip = document.createElement("button");
    learnChip.className = "sso-track__learn";
    learnChip.type = "button";
    learnChip.textContent = "learning";
    learnChip.title = "Study marks the rare words in this subtitle";
    learnChip.addEventListener("click", (event) => {
      event.stopPropagation();
      window.__ssoStudy?.updateSettings({ studySlot: slot });
      refresh(api.status());
    });

    /* Hide is a button, not a menu item. It is the other thing readers reach
     * for constantly - a subtitle in the way of something on screen goes away
     * for ten seconds and comes back - and burying a ten-second action two
     * clicks deep is what made the menu feel like a filing cabinet. */
    const visible = document.createElement("button");
    visible.className = "sso-icon sso-track__eye";
    visible.type = "button";
    visible.addEventListener("click", (event) => {
      event.stopPropagation();
      api.setVisible(!api.status().tracks[slot].visible, { slot });
    });

    head.append(caret, label, shut, learnChip, keysChip, visible, more);
    head.addEventListener("click", () => toggleTrack(slot));

    /* One row: say what is wrong, twice as fast or twice as fine, and read what
     * it did in the middle.
     *
     * Say what is wrong, not which way to push a number. What a viewer
     * perceives is "the text came up before they spoke". Turning that into a
     * sign means knowing that film time is stream time minus the offset, so a
     * larger offset shows the line later - which nobody should have to work out
     * while a film is playing, and getting it backwards doubles the error and
     * makes the next guess harder. That is why these are words and not arrows:
     * an arrow re-introduces exactly the question the words were invented to
     * remove, and "◀" is doubly ambiguous - does it move the text earlier, or
     * move it back relative to the speech? The chevron beside each word is a
     * magnitude, never a direction, and never appears on its own.
     *
     * Two sizes because one was wrong in both directions: a quarter-second is
     * useless when a subtitle is seventeen seconds out, and a second is too
     * coarse for the last adjustment. Holding either still escalates.
     *
     * The measurement that decides the layout: usable width is the host width
     * less 46px of borders and padding, so 294px at the default 340 and 234px
     * at the 280 minimum. Two chevron buttons, two words, a reading and the
     * gaps come to 208px, which fits both. Keeping the old sentences and adding
     * a second size needs 306px and fits neither. */
    const offsets = document.createElement("div");
    offsets.className = "sso-row sso-sync";

    /* Signed seconds, and an input. Holding a button runs the offset up
     * quickly, but somebody who already knows the answer - a subtitle timed
     * against a release seventeen seconds out - should be able to say seventeen
     * rather than hold a button until it arrives.
     *
     * This is the whole readout now. There used to be a second line of prose
     * beside it saying "held back 17s", which is the same fact in words next to
     * the same fact in figures. The prose stays in the toast, where it is read
     * once and gone. */
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

    const nudger = (word, chevron, direction, size, why) => {
      const b = button("", { title: why });
      b.className = `sso-nudge sso-nudge--${size}`;
      const mark = document.createElement("span");
      mark.className = "sso-nudge__step";
      mark.textContent = chevron;
      /* The word is an element, not a text node, because below 320px it is the
       * part that goes and a text node cannot be addressed by a selector. */
      /* The word belongs to the side, not to each button. Both buttons on a
       * side carrying it read as "« Early ‹ Early", which looks like a repeat
       * rather than two sizes of one thing. The whole step carries the word
       * because it is the one reached for first when something is visibly
       * wrong, and it sits at the outer edge where it is easiest to hit; the
       * fine step beside the number takes its meaning from the group. */
      const said = document.createElement("span");
      said.className = "sso-nudge__word";
      said.textContent = size === "large" ? word : "";
      // Chevron on the outside of the pair, so the two whole steps sit at the
      // two ends of the row and the fine ones flank the number.
      b.append(...(direction > 0 ? [mark, said] : [said, mark]));
      return holdToRepeat(b, slot, direction, size);
    };

    const early = "The line appears before it is spoken, so hold it back.";
    const late = "The line appears after it is spoken, so bring it forward.";
    /* The fine steps travel with the number, not with the edges of the row.
     * A single flex row put the field between them and let it take the slack,
     * which pushed each fine chevron up against the whole step it is a smaller
     * version of and away from the reading it changes. */
    /* Undo the timing, beside the timing.
     *
     * It was a menu item, which is three actions - open the menu, find it,
     * click it - for the one thing a reader does most often after over-shooting
     * a nudge. It shows only when there is something to undo, so it costs
     * nothing on a subtitle that is already right, and that is also honest:
     * nothing to reset is exactly when the subtitle needs no reset. */
    const offsetReset = document.createElement("button");
    offsetReset.className = "sso-sync__clear";
    offsetReset.type = "button";
    offsetReset.textContent = "⌫";
    offsetReset.title = "Back to the file's own timing";
    offsetReset.addEventListener("click", () => {
      api.setRate(1, { slot, quiet: true });
      api.setOffset(0, { slot });
    });

    const fine = document.createElement("div");
    fine.className = "sso-sync__fine";
    fine.append(
      nudger("Early", "‹", +1, "small", `${early} A fine step. Hold to run.`),
      offsetField,
      offsetReset,
      nudger("Late", "›", -1, "small", `${late} A fine step. Hold to run.`),
    );

    offsets.append(
      nudger("Early", "«", +1, "large", `${early} A whole step. Hold to run.`),
      fine,
      nudger("Late", "»", -1, "large", `${late} A whole step. Hold to run.`),
    );

    const body = document.createElement("div");
    body.className = "sso-track__body";
    body.append(offsets);

    root.append(head, body);
    return { root, caret, keyed, keysChip, learnChip, label, shut, offsetField, offsetReset, visible, more };
  }

  /* --- how one subtitle looks -------------------------------------------------
   *
   * A screen, because it is nine controls and none of them is touched while a
   * film plays. One screen serves both subtitles: which one it is showing comes
   * from the menu that opened it, the same way the Find screen learns its slot.
   */

  let styleSlot = 0;

  function buildStyle() {
    const wrap = document.createElement("div");

    /* Named looks first, because for most readers this is the whole screen.
     * The two subtitles want opposite treatments and setting six controls twice
     * per film is a chore that gets skipped - and a feature too much work to
     * use is a feature nobody has. They are starting points, not modes:
     * applying one writes the values and then stops having an opinion, so every
     * control below still works afterwards. */
    const lookNote = document.createElement("p");
    lookNote.className = "sso-note";
    lookNote.textContent = "Start from a look, then change anything you like.";

    const looks = document.createElement("div");
    looks.className = "sso-seg sso-seg--wrap";
    el.lookButtons = Object.entries(api.looks).map(([name, look]) => {
      const b = button(look.label, {
        title: look.hint,
        onClick: () => {
          api.applyLook(styleSlot, name);
          refresh(api.status());
        },
      });
      b.className = "sso-seg__b";
      looks.append(b);
      return { name, b };
    });

    el.styleSize = slider("Size", 0.6, 2.2, 0.05, 1, (value) =>
      api.updateTrackSettings(styleSlot, { fontScale: value }),
    );
    el.styleWidth = slider("Width", 20, 100, 1, 80, (value) =>
      api.updateTrackSettings(styleSlot, { widthPercent: value, placed: true }),
    );
    el.styleWeight = slider("Weight", 300, 800, 100, 600, (value) =>
      api.updateTrackSettings(styleSlot, { weight: value }),
    );
    /* Zero is "none", not "faint". Over a bright frame the useful setting is
     * usually more outline rather than less, so the range runs past what the
     * stylesheet always drew. */
    el.styleOutline = slider("Outline", 0, 2, 0.1, 1, (value) =>
      api.updateTrackSettings(styleSlot, { outline: value }),
    );
    el.styleBackdrop = slider("Backdrop", 0, 1, 0.05, 0.55, (value) =>
      api.updateTrackSettings(styleSlot, { backdrop: value }),
    );

    /* A colour well rather than a list of named colours. What a reader wants is
     * "the same yellow the cinema uses" or "something that is not the other
     * subtitle", and neither is on a list of eight. */
    const colourRow = document.createElement("label");
    colourRow.className = "sso-label";
    const colourName = document.createElement("span");
    colourName.textContent = "Colour";
    el.styleColor = document.createElement("input");
    el.styleColor.type = "color";
    el.styleColor.className = "sso-swatch";
    el.styleColor.addEventListener("input", () =>
      api.updateTrackSettings(styleSlot, { color: el.styleColor.value }),
    );
    colourRow.append(colourName, el.styleColor);

    const fontRow = document.createElement("div");
    fontRow.className = "sso-seg sso-seg--wrap";
    const fontLead = document.createElement("span");
    fontLead.className = "sso-seg__lead";
    fontLead.textContent = "Font";
    fontRow.append(fontLead);
    el.fontButtons = Object.keys(api.fonts).map((name) => {
      const b = button(name === "sans" ? "Default" : name[0].toUpperCase() + name.slice(1), {
        onClick: () => {
          api.updateTrackSettings(styleSlot, { font: name });
          refresh(api.status());
        },
      });
      b.className = "sso-seg__b";
      // Each button is set in the face it selects, so the choice is the sample.
      b.style.fontFamily = api.fonts[name];
      fontRow.append(b);
      return { name, b };
    });

    wrap.append(
      lookNote,
      looks,
      colourRow,
      fontRow,
      el.styleSize.row,
      el.styleWeight.row,
      el.styleWidth.row,
      el.styleOutline.row,
      el.styleBackdrop.row,
    );
    return wrap;
  }

  /* --- screens ---------------------------------------------------------------
   *
   * One deep. There is no stack because there is nowhere to go from a screen
   * except back, and a breadcrumb for a 340px panel would be more chrome than
   * content.
   */

  const SCREEN_TITLES = {
    root: "Subtitle Overlay",
    find: "Find a subtitle",
    style: "Style",
  };

  let atScreen = "root";

  function screen(...parts) {
    const node = document.createElement("div");
    node.className = "sso-screen";
    node.append(...parts);
    return node;
  }

  function goTo(name) {
    closeMenu();
    atScreen = name;
    for (const [key, node] of Object.entries(el.screens)) node.hidden = key !== name;
    el.back.hidden = name === "root";
    el.title.textContent = SCREEN_TITLES[name] || SCREEN_TITLES.root;
    // The count belongs to the subtitles, so it goes when they are not on show.
    el.state.hidden = name !== "root";
    el.panel.scrollTop = 0;
    refresh(api.status());
    fitToViewport();
  }

  const goRoot = () => goTo("root");

  /* Settings, in a window of their own.
   *
   * Built the first time it is asked for rather than with the panel: it holds
   * five sections nobody opens during a film, and building them up front costs
   * every reader who never opens it. Kept afterwards, so its size and place are
   * where they were left within the session as well as between them. */
  let settingsWindow = null;

  async function openSettings() {
    if (!settingsWindow) {
      settingsWindow = api.makeWindow({
        title: "Settings",
        sheets,
        storeKey: "sso:panelSettingsWindow",
        width: 380,
        height: 420,
        accent: "#4c8bf5",
        accentInk: "#93b9fb",
        onClose: () => refresh(api.status()),
      });
      settingsWindow.body.append(
        buildArrangement(), buildAppearance(), buildStudy(), buildKeys(), buildDiagnostics(),
      );
    }
    closeMenu();
    await settingsWindow.show(host);
    refresh(api.status());
  }

  /* Go and find one, for a named subtitle.
   *
   * Which subtitle a result fills is carried here rather than picked from a
   * "Subtitle 1 / Subtitle 2" control on the search screen. You said which one
   * by which plus you pressed, or by whose menu you opened Replace from, and a
   * segmented control asking again - a section away from a second, identical
   * pair of buttons meaning something else entirely - was a question with the
   * answer already in it. */
  function openStyle(slot) {
    styleSlot = slot >= 0 && slot < api.trackCount ? slot : 0;
    goTo("style");
  }

  function openFind(slot) {
    /* Clamped, because the plus passes the first free slot and there is not
     * always one - findIndex returns -1, which read as "becomes subtitle 0" on
     * the screen and would have attached to a slot that does not exist. With
     * both full the sensible target is the first, and the screen says it is
     * replacing rather than filling. */
    targetSlot = slot >= 0 && slot < api.trackCount ? slot : 0;
    goTo("find");
    el.query.focus();
    el.query.select();
  }

  /* A menu of verbs, anchored to the button that opened it.
   *
   * It is a child of .sso-panel rather than a second shadow host. The panel is
   * `overflow: hidden auto` - hidden across, auto down - so a menu no wider
   * than the panel and right-aligned to its anchor is clipped on neither axis,
   * and it scrolls with the row it belongs to, which is what a menu anchored to
   * a row should do. A floating host would need its own stylesheet adoption,
   * its own fullscreen re-parenting and its own teardown, for a list of five
   * words.
   *
   * Only one is open at a time, and it closes on a press outside it, on
   * Escape, and on anything that changes screen. It does NOT close on scroll:
   * it is a child of the scrolling container, so it moves with the row it is
   * anchored to rather than detaching from it - and a scroll dismissal was
   * closing menus by itself, because re-fitting the panel to the viewport can
   * emit a scroll event that no reader caused.
   */
  let openMenu = null;
  let menuLife = null;

  /* Closing takes the dismiss listeners and the layer with it.
   *
   * They used to be registered `{ once: true }` and left to expire on their
   * own, which is not the same thing: a menu closed by Escape or by picking an
   * item leaves its listeners attached, and the next menu is then closed by the
   * *previous* menu's handler. It presented as a menu that opens and is
   * instantly gone, only ever the second menu of a session, which is exactly
   * the sort of thing that survives a manual check. */
  function closeMenu() {
    menuLife?.abort();
    menuLife = null;
    openMenu?.remove();
    openMenu = null;
  }

  function menu(anchor, items) {
    closeMenu();
    const layer = api.makeLayer({ zIndex: "2147483647" });
    layer.shadow.adoptedStyleSheets = sheets;

    const node = document.createElement("div");
    node.className = "sso-win sso-menu";
    node.setAttribute("role", "menu");

    for (const item of items) {
      if (item?.hidden) continue;
      if (item === null) {
        const rule = document.createElement("div");
        rule.className = "sso-menu__rule";
        node.append(rule);
        continue;
      }
      const b = document.createElement("button");
      b.type = "button";
      b.className = item.danger ? "sso-menu__item sso-menu__item--danger" : "sso-menu__item";
      b.setAttribute("role", "menuitem");
      b.textContent = item.label;
      if (item.title) b.title = item.title;
      b.addEventListener("click", () => {
        closeMenu();
        item.onClick();
      });
      node.append(b);
    }
    layer.shadow.append(node);
    openMenu = layer;

    /* In viewport coordinates, hanging left from the anchor's right edge, and
     * flipped above it when there is no room below.
     *
     * The layer is a host of its own rather than a child of the panel, which is
     * the whole point: a menu opened near the bottom of the panel used to be
     * cut off at the panel's edge. Nothing above this host can clip it. */
    const at = anchor.getBoundingClientRect();
    const box = node.getBoundingClientRect();
    const below = at.bottom + 4;
    const top = below + box.height > window.innerHeight - 8
      ? Math.max(8, at.top - box.height - 4)
      : below;
    const left = clamp(at.right - box.width, 8, Math.max(8, window.innerWidth - box.width - 8));
    layer.place(left, top);

    if (anchor.dataset.viaKey === "true") node.querySelector("button")?.focus();

    menuLife = new AbortController();
    const { signal } = menuLife;
    node.addEventListener("keydown", (event) => {
      if (event.key === "Escape") {
        closeMenu();
        anchor.focus();
      }
    }, { signal });

    /* Bound after this click finishes, or the press that opened the menu is the
     * one that dismisses it. Watched on the document because the menu is no
     * longer inside the panel's shadow tree, so a press on the panel is now a
     * press somewhere else entirely. */
    setTimeout(() => {
      if (signal.aborted) return;
      const away = (event) => {
        const path = event.composedPath?.() || [];
        if (!path.includes(node) && !path.includes(anchor)) closeMenu();
      };
      document.addEventListener("pointerdown", away, { capture: true, signal });
      window.addEventListener("resize", closeMenu, { signal });
    }, 0);
    return node;
  }

  /* Taking a subtitle off is the one destructive thing this panel does, and it
   * used to be a plain button next to Hide with no way back - a mis-click cost
   * the download, the timing and wherever the box had been dragged to. The
   * toast carries the undo; the card list carries it too, because a toast
   * button cannot be reached from the keyboard in fullscreen and this is the
   * surface that owns removal. */
  function removeTrack(slot) {
    const label = api.status().tracks[slot]?.label;
    api.detach(slot);
    api.showToast(`Subtitle ${slot + 1} removed${label ? ` · ${label}` : ""}`, {
      action: { label: "Undo", onClick: () => api.undoRemove() },
    });
    refresh(api.status());
  }

  /* Work out the gap between the two subtitles, and say what happened.
   *
   * Three outcomes, because the aligner has three answers. Sure enough to act
   * on, and it has already acted - the toast carries the undo. Probably right,
   * and the reader gets one click to say so, because a subtitle silently
   * shifted by the wrong amount is harder to diagnose than one nobody touched.
   * Or not confident at all, and the honest thing is to say the two files do
   * not look like the same film rather than to shift by the best of a bad lot.
   */
  function lineUp(slot) {
    const answer = api.autoAlign?.(slot);
    if (!answer) {
      api.showToast("Nothing to line this up against");
      return;
    }
    if (answer.verdict === "apply") {
      api.showToast(`Lined up · ${api.describeOffset(answer.offsetMs)}`, {
        action: {
          label: "Undo",
          onClick: () => {
            api.setRate(1, { slot, quiet: true });
            api.setOffset(0, { slot });
          },
        },
      });
    } else if (answer.verdict === "offer") {
      const was = api.status().tracks[slot].offsetMs;
      api.showToast(`These look ${api.describeOffset(answer.offsetMs)} apart. Use it?`, {
        action: {
          label: "Line up",
          onClick: () => {
            api.setOffset(answer.offsetMs, { slot, quiet: true });
            api.showToast(`Lined up · ${api.describeOffset(answer.offsetMs)}`, {
              action: { label: "Undo", onClick: () => api.setOffset(was, { slot }) },
            });
          },
        },
      });
    } else {
      /* Named, not generic. "Could not sync" sends a reader to try the same
       * thing again; "these do not look like the same film" sends them to
       * check which subtitle they downloaded, which is where the fault is. */
      api.showToast("These two do not look like the same film");
    }
    refresh(api.status());
  }

  /* Which track cards are open. `undefined` means the reader has not said, and
   * refresh() then picks the keyed one; a boolean is their answer and outlives
   * every status round. */
  const trackOpen = [undefined, undefined];

  function toggleTrack(slot) {
    const card = el.trackCards[slot];
    trackOpen[slot] = card.root.dataset.open !== "true";
    refresh(api.status());
  }

  // --- search ---------------------------------------------------------------

  function buildSearch() {
    const wrap = document.createElement("div");

    /* Where the result will land, said once, as a fact rather than a question.
     *
     * There used to be an "Attach to: Subtitle 1 / Subtitle 2" control here,
     * which asked something the reader had already answered by which plus they
     * pressed - and which was a section away from a second, identical pair of
     * buttons telling study which subtitle to read from. Two identical
     * segmented controls meaning different things is a control you have to test
     * to understand. */
    el.findFor = document.createElement("p");
    el.findFor.className = "sso-note sso-find__for";

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

    /* Not primary. The panel's one primary is the empty state's button, and the
     * empty state is on screen exactly when there is one obvious thing to do;
     * once a subtitle is attached this is an adjustment surface with no single
     * next action, and a filled blue button in it would be claiming otherwise.
     * Enter in the field runs the same search. */
    row.append(grow, button("Search", { onClick: () => runSearch(el.query.value.trim()) }));

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

    wrap.append(el.findFor, row, el.searchNote, el.languageFilter, el.results);
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
    /* The target stays where the reader put it.
     *
     * It used to flip to the other subtitle here, to save a click for somebody
     * building a pair. It cost more than it saved: picking a result moved the
     * selection under the reader at the moment they were looking at the list,
     * and the next equally common intent - that release was wrong, try the one
     * below it - then silently attached to the other slot instead of replacing.
     * A guess about the next click is not worth making when getting it wrong is
     * invisible until two subtitles are on screen.
     *
     * The convenience it was buying is a note instead, which costs one click
     * and no surprise. */
    el.searchNote.className = "sso-note";
    const other = slot === 0 ? 1 : 0;
    el.searchNote.textContent = api.status().tracks[other].attached
      ? `Attached to subtitle ${slot + 1}.`
      : `Attached to subtitle ${slot + 1}. Pick “Subtitle ${other + 1}” above to add a second one.`;
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
  /* Two controls, and everything else moved.
   *
   * This was eleven controls in a panel about subtitles, all of them describing
   * the rail: how big its text is, how solid it is over the film, how many
   * words it keeps, what counts as rare. Settings belong on the thing they
   * change, so they are on the rail's own gear now.
   *
   * The master switch has to stay here, because the rail does not exist while
   * study is off - a switch you can only reach by first being in the state it
   * turns on is not a switch. "Saved words" stays for the same reason: the deck
   * outlives any one film and has to be reachable with study off. */
  function buildStudy() {
    const wrap = section("Study");
    el.studySection = wrap;

    const note = document.createElement("p");
    note.className = "sso-note";
    note.textContent =
      "Marks the words in each line that are rare in film dialogue, and shows what they mean at " +
      "the side. Hover any word to look it up; shift-drag across words for a phrase.";

    el.studyEnabled = toggle_("Study mode", false, (on) => window.__ssoStudy?.setEnabled(on));

    el.studyWhere = document.createElement("p");
    el.studyWhere.className = "sso-note";
    el.studyWhere.textContent = "Everything else about study is on the rail's own \u2699.";

    const actions = document.createElement("div");
    actions.className = "sso-row";
    actions.style.marginTop = "8px";
    actions.append(
      button("Saved words", {
        onClick: () => chrome.runtime.sendMessage({ type: "sso:openOptions", hash: "#deck" }),
        title: "Open the deck on the options page",
      }),
    );

    wrap.append(note, el.studyEnabled.row, el.studyWhere, actions);
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
      button("Reset keys", {
        onClick: () => api.resetKeys(),
        title: "Put the bindings back to their defaults",
      }),
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
    api.makeMovable(handle, {
      host,
      place: (x, y) => setPosition(`${x}px`, `${y}px`),
      // Dragging down the screen leaves less room beneath.
      onMove: fitToViewport,
      onEnd: () =>
        chrome.storage.local
          .set({ [POSITION_KEY]: { left: host.style.left, top: host.style.top } })
          .catch(() => {}),
    });
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

  /* One status round writes about forty properties across the panel, and
   * notify() fires on every offset change - twelve times a second while a nudge
   * button is held. Screens that are not on show are skipped: they are redrawn
   * by goTo() on the way in, so nothing can be stale by the time it is seen. */
  function refresh(status) {
    if (!host) return;
    const settings = status.settings;
    const showing = (name) => atScreen === name;
    /* Attaching a second subtitle adds a whole card, so the panel gets taller
     * while it is open. Re-fitting on every status round keeps it on the screen
     * without anything having to remember to ask. */
    queueMicrotask(fitToViewport);

    const gone = api.removedTrack?.();
    el.undoRow.hidden = !gone;
    if (gone) {
      el.undoLabel.textContent = `Subtitle ${gone.slot + 1} removed${gone.label ? ` · ${gone.label}` : ""}`;
    }

    /* One statement of absence at a time. With something to put back, "no
     * subtitle attached - go and search for one" answers a question the reader
     * did not ask; the useful thing is the way back, and it stands down on its
     * own after half a minute. */
    el.none.hidden = status.attached || Boolean(gone);
    el.noneTitle.textContent = status.hasVideo ? "No subtitle attached" : "No video on this page";
    el.noneNote.textContent = status.hasVideo
      ? "Search for the film or series and pick a result — it goes straight onto the video."
      : "Open something that plays, then come back.";
    el.noneAction.hidden = !status.hasVideo;
    // Both slots full means the plus has nowhere to put anything; replacing one
    // is what the card's own menu is for.
    el.add.hidden = !status.attached || status.trackCount >= api.trackCount;

    // The one fact a folded title bar has to carry.
    el.state.textContent = status.attached
      ? `${status.trackCount} attached`
      : status.hasVideo ? "nothing attached" : "no video";
    el.state.dataset.on = status.attached ? "true" : "false";

    status.tracks.forEach((track, slot) => {
      const card = el.trackCards[slot];
      /* An empty track's card is not shown at all. A second set of controls
       * that do nothing is worse than no second set: it says the feature is
       * broken rather than unused. */
      card.root.hidden = !track.attached;
      if (!track.attached) return;

      /* Until the reader has folded one themselves, the open card is the one
       * the keys point at - which with a single subtitle is always that one, so
       * nothing folds until there is a second card to fold against. */
      const open = trackOpen[slot] ?? (status.trackCount < 2 || status.keyTrack === slot);
      card.root.dataset.open = open ? "true" : "false";
      card.caret.textContent = open ? "▾" : "▸";
      card.caret.title = open ? "Fold this subtitle's controls" : "Show this subtitle's controls";
      card.caret.setAttribute("aria-expanded", open ? "true" : "false");

      card.label.textContent = `${slot + 1}. ${track.label || "Attached"}`;
      card.keyed.checked = status.keyTrack === slot;
      /* A chip appears on the card the thing is true of, and nowhere else.
       *
       * Both chips on both cards, one lit and one dim, cost about ninety pixels
       * of the title - and the title is the subtitle's name, which is the one
       * thing on this card that identifies it. Showing only the live one keeps
       * the state visible and gives the name its room back; moving it is a
       * menu item on the card you want it moved to, which is where a reader
       * looks for "do this to this one" now. */
      const study = window.__ssoStudy?.settings?.();
      const keyed = status.keyTrack === slot;
      const learning = study?.studySlot === slot;
      card.keysChip.dataset.on = keyed ? "true" : "false";
      card.keysChip.hidden = status.trackCount < 2 || !keyed;
      card.learnChip.dataset.on = learning ? "true" : "false";
      card.learnChip.hidden = !study?.enabled || status.trackCount < 2 || !learning;
      card.shut.hidden = open;
      const stretched = track.rate && track.rate !== 1;
      card.shut.textContent = track.offsetMs || stretched
        ? api.describeOffset(track.offsetMs) + (stretched ? " · stretched" : "")
        : `${track.cueCount} line${track.cueCount === 1 ? "" : "s"}`;
      card.shut.dataset.set = track.offsetMs || stretched ? "true" : "false";
      card.offsetField.dataset.set = track.offsetMs ? "true" : "false";
      // Not while it is being typed into, or the value rewrites itself under
      // the cursor between keystrokes.
      if (shadow.activeElement !== card.offsetField) {
        card.offsetField.value = String(Math.round(track.offsetMs) / 1000);
      }
      /* A hidden subtitle says so on its card. The menu item it was toggled
       * from is not on screen to carry the state, and a subtitle that has
       * vanished from the picture with nothing in the panel saying why is the
       * kind of thing that reads as a bug. */
      card.root.dataset.hidden = track.visible ? "false" : "true";
      card.visible.textContent = track.visible ? "◉" : "◎";
      card.visible.title = track.visible ? "Take it off the picture" : "Put it back on the picture";
      card.visible.dataset.on = track.visible ? "true" : "false";
      // Nothing to undo, no undo. Which is also when the subtitle is right.
      card.offsetReset.hidden = !track.offsetMs && !stretched;
    });

    const drift = status.adDriftMs || 0;
    el.adRow.hidden = !status.attached || (drift === 0 && !status.inAd);
    el.adDrift.textContent = status.inAd
      ? "Ad playing — subtitles paused"
      : `Ad time removed: ${(drift / 1000).toFixed(0)}s`;

    if (showing("find")) {
      const filling = status.tracks[targetSlot];
      el.findFor.textContent = filling?.attached
        ? `Replacing subtitle ${targetSlot + 1} · ${filling.label || "attached"}`
        : `The result you pick becomes subtitle ${targetSlot + 1}.`;
    }

    if (showing("style")) {
      const look = settings.tracks[styleSlot];
      const track = status.tracks[styleSlot];
      el.title.textContent = `Style · subtitle ${styleSlot + 1}`;
      el.styleSize.input.value = String(look.fontScale);
      el.styleSize.readout.textContent = look.fontScale.toFixed(2);
      el.styleWidth.input.value = String(Math.round(look.widthPercent));
      el.styleWidth.readout.textContent = `${Math.round(look.widthPercent)}%`;
      el.styleWeight.input.value = String(look.weight);
      el.styleWeight.readout.textContent = String(look.weight);
      el.styleOutline.input.value = String(look.outline);
      el.styleOutline.readout.textContent = look.outline === 0 ? "none" : look.outline.toFixed(1);
      /* null means "follow the shared backdrop", which is what every subtitle
       * that has never been styled carries. The slider shows what is actually
       * being drawn, so moving it takes ownership rather than jumping. */
      const backdrop = look.backdrop == null ? settings.background : look.backdrop;
      el.styleBackdrop.input.value = String(backdrop);
      el.styleBackdrop.readout.textContent = `${Math.round(backdrop * 100)}%`;
      el.styleColor.value = look.color;
      for (const { name, b } of el.fontButtons) b.dataset.on = look.font === name ? "true" : "false";
      /* A look is marked only while every value it sets still holds. Change one
       * slider and no look is showing, which is true - and better than leaving
       * a name lit against settings it no longer describes. */
      for (const { name, b } of el.lookButtons) {
        const wanted = api.looks[name].style;
        b.dataset.on = Object.entries(wanted)
          .every(([key, value]) => look[key] === value) ? "true" : "false";
      }
      if (!track?.attached) el.title.textContent = "Style";
    }

    // The settings are their own window now, so what decides whether they are
    // worth redrawing is whether that window is open - not which screen the
    // panel happens to be showing.
    if (!settingsWindow?.isOpen()) return;

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
    /* Where the rest of it went, said only while it is somewhere the reader can
     * actually go. With study off there is no rail to carry a gear, and a note
     * pointing at a surface that does not exist is worse than no note. */
    el.studyWhere.hidden = !study.enabled;
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
    // Always back at the subtitles. A panel that reopens on the screen you left
    // it on is a panel you have to work out before you can use it.
    goTo("root");
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
    closeMenu();
    settingsWindow?.hide();
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
    // The fullscreen element may be scaled; what we have just moved into
    // decides how big the panel renders and where a written position lands.
    rescale();
  }

  document.addEventListener("keydown", onCaptureKey, true);
  window.addEventListener("resize", clampIntoView, { passive: true });

  /* applySize is exported for the harness, which measures the sync row at both
   * ends of the width the corner grips allow. Driving the grips with synthetic
   * pointer events to get there would be testing the grips, not the row. */
  window.__ssoPanel = { show, hide, toggle, reparent, isCapturingKey, rescale, applySize };

  window.__ssoPanelTeardown = () => {
    // Both live on hosts outside this shadow tree, so removing the panel does
    // not remove them.
    closeMenu();
    settingsWindow?.destroy();
    settingsWindow = null;
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
