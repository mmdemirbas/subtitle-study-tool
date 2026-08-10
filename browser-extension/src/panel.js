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

  /* The two study bindings are not here. They belong to study, and study's
   * settings are on the rail's own gear - the same rule that moved everything
   * else about it off this surface. */
  /* "Line again" rather than "previous line", because that is what the key does
   * on the press that matters: it starts the line being spoken over, and only
   * goes back one when it is pressed again. Naming it "previous" would describe
   * the second press and mislead about the first. */
  const KEY_FIELDS = [
    ["earlier", "Subtitles earlier"],
    ["later", "Subtitles later"],
    ["reset", "Reset offset"],
    ["prevLine", "Line again"],
    ["nextLine", "Next line"],
    ["toggleOverlay", "Hide / show"],
    ["togglePanel", "This panel"],
  ];

  let host = null; // the element in the page; carries position only
  let shadow = null; // everything else lives in here
  let el = {};
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
    /* A press on this window is not a press on the film. See
     * keepPointersInside in content.js for what it cost not to do this. */
    api.keepPointersInside?.(node);
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

    /* Into the document here, not on the first reparent.
     *
     * toTopLayer refuses a node that is not connected, so a host whose first
     * meeting with the document happened inside reparent() could not be
     * promoted on that pass and fell through to the append instead - which,
     * while a player had fullscreened the <video>, put the panel inside a
     * replaced element where it is never painted. The panel reported itself
     * open, the CC button toggled it shut, and pressing again re-opened it
     * invisibly. The second open came right, because by then it was connected
     * and could be promoted - which is what made it "sometimes". */
    (api.paintableParent?.() || document.body || document.documentElement).append(host);
    // The whole panel, not only its bar: an empty part of a window is a handle
    // everywhere else, and this one is mostly empty when nothing is attached.
    makeDraggable(panel, head);
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

  /* Each is a card, and none of them folds.
   *
   * They folded while they were a column inside the panel, five headings deep
   * on a surface that also carried the subtitles. Settings are a window of
   * their own now - opened to change one thing, closed again - and a fold on a
   * window whose whole job is to show what you came for is a control that
   * hides the answer. What the fold really did was separate one group from the
   * next, so the separation is a card, which does that without being clicked.
   *
   * A heading, not a button: a title that can be pressed is a control that
   * does nothing. */
  function section(heading) {
    const wrap = document.createElement("div");
    wrap.className = "sso-sec";

    const head = document.createElement("h2");
    head.className = "sso-sec__h";
    head.textContent = heading;

    wrap.append(head);
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
      buildQuickRow(),
      ...el.trackCards.map((card) => card.root),
      el.undoRow,
      el.add,
      el.adRow,
    );
    return wrap;
  }

  /* What both subtitles share, above the two cards that do not.
   *
   * Where they sit and whether the words are being studied were in Settings,
   * two windows away from the subtitles they act on, next to backdrop sliders
   * and key bindings. They are not settings: they are things you do, several
   * times, while a film plays - "put them side by side", "that one is in the
   * way", "start marking the rare words". So they sit at the top of the list
   * they act on, which is also the only place both cards can be seen at once.
   *
   * The three arrangement buttons are drawn rather than written. Words for them
   * come to 157px of the 234 a 280px-wide panel has, which leaves nothing for
   * Move and Study; the pictures are 26px each and say what they do without
   * being read. They show only with two subtitles attached, because arranging
   * one against nothing is not an arrangement. */
  function buildQuickRow() {
    el.quick = document.createElement("div");
    el.quick.className = "sso-row sso-quick";

    const arranger = (kind, title, onClick) => {
      const b = button("", { title, onClick });
      b.className = "sso-arr";
      const icon = document.createElement("span");
      icon.className = `sso-arr__i sso-arr__i--${kind}`;
      b.append(icon);
      return b;
    };

    el.arrangeGroup = document.createElement("div");
    el.arrangeGroup.className = "sso-arr-group";
    el.arrangeGroup.append(
      arranger("side", "Side by side - one on the left half, one on the right", () =>
        api.arrange("side"),
      ),
      arranger("stack", "Stacked - one above the other, along the bottom", () =>
        api.arrange("stacked"),
      ),
    );

    el.centreButton = arranger(
      "centre",
      "Both back to the middle of the bottom",
      () => api.resetPosition(),
    );

    /* Placing is a mode, so it says so: the button reads Done while it is on
     * and is lit, which is the only control here that changes what a click
     * anywhere else will do. */
    el.moveButton = button("Move", {
      onClick: () => api.setPlacing(!api.status().placing),
      title: "Drag the middle of a subtitle to move it, an edge to make it wider",
    });
    el.moveButton.className = "sso-quick__move";

    /* The one control that is not about position. It is on this surface at all
     * because the rail it belongs to does not exist until it is on - a switch
     * you can only reach by first being in the state it turns on is not a
     * switch - and everything else about study is on the rail's own gear. */
    el.studyButton = button("Study", {
      onClick: () => window.__ssoStudy?.setEnabled(!window.__ssoStudy.settings().enabled),
      title: "Mark the words that are rare in film dialogue and show what they mean",
    });
    el.studyButton.className = "sso-quick__study";

    /* The version that names no subtitle: every other one moves to agree with
     * the first. On this row rather than on a card because it is about the set
     * of them, and because with three or more it is the only way to say it once
     * instead of once per card. Hidden with fewer than two, where it would be a
     * button that cannot do anything. */
    el.lineUpAll = button("Line up all", {
      onClick: lineUpAll,
      title: "Move every other subtitle to agree with the first",
    });
    el.lineUpAll.className = "sso-quick__align";

    const spacer = document.createElement("span");
    spacer.className = "sso-grow";

    el.quick.append(
      el.arrangeGroup, el.centreButton, el.moveButton, el.lineUpAll, spacer, el.studyButton,
    );
    return el.quick;
  }

  /* Everything to agree with the first, in one action and one sentence.
   *
   * The confident band applies itself, as it does everywhere else; anything
   * less sure is named rather than applied, and the card it belongs to has the
   * button that shows the number before taking it. Saying "two lined up, one
   * not sure" is the honest summary of a batch where the answers differ - a
   * single "done" would claim the uncertain one as settled. */
  function lineUpAll() {
    const status = api.status();
    const first = status.tracks.findIndex((track) => track.attached);
    if (first === -1) return;

    const moved = [];
    const unsure = [];
    /* What each one was, before the aligner is allowed to overwrite it. Undo
     * used to set rate 1 and offset 0, which throws away a timing the reader
     * had set by hand rather than putting it back. */
    const before = new Map();
    for (const [slot, track] of status.tracks.entries()) {
      if (!track.attached || slot === first) continue;
      before.set(slot, timingOf(slot));
      const answer = api.autoAlign?.(slot, { against: first });
      if (answer?.applied) moved.push(slot + 1);
      else if (answer?.verdict === "offer") unsure.push(slot + 1);
    }

    const said = [
      moved.length ? `${moved.length === 1 ? `Subtitle ${moved[0]}` : `${moved.length} subtitles`} lined up with subtitle ${first + 1}` : "",
      unsure.length ? `subtitle ${unsure.join(" and ")} not certain - use Line up on its card` : "",
    ].filter(Boolean);
    api.showToast(
      said.length ? said.join(" · ") : "Nothing needed moving",
      moved.length
        ? {
            action: {
              label: "Undo",
              onClick: () => {
                for (const number of moved) {
                  applyTiming(number - 1, before.get(number - 1) || { offsetMs: 0, rate: 1 });
                }
                api.showToast("Back to the timing each one had");
                refresh(api.status());
              },
            },
          }
        : {},
    );
    refresh(api.status());
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

  /* A name, split so the end of it survives being too long for the card.
   *
   * The last token is what identifies a subtitle - the language, or the source
   * a release came from - and it is the first thing an ellipsis takes. Held out
   * of the truncation it costs a dozen pixels and the two cards stop reading
   * the same. Only a SHORT last token: a name whose final separator is thirty
   * characters from the end has no tail worth saving, and holding one out would
   * leave nothing for the part that says which film this is. */
  const TAIL_MAX = 12;

  function splitName(name) {
    let at = -1;
    for (const mark of ["-", ".", "·", " ", "_"]) at = Math.max(at, name.lastIndexOf(mark));
    if (at <= 0 || name.length - at > TAIL_MAX) return [name, ""];
    return [name.slice(0, at), name.slice(at)];
  }

  /* --- where this subtitle speaks ---------------------------------------------
   *
   * A subtitle is 900 lines and a reader syncing one by hand is working from a
   * two-second window of them. What is missing is the shape of the whole file:
   * where the dialogue is dense, where the long silences are, and - the part
   * that makes syncing a matter of looking rather than guessing - whether the
   * two files have the same shape in the same places.
   *
   * So each card carries a strip of the film's running time with a bar for
   * every stretch of dialogue. Drawn against the STREAM clock, not the file's
   * own, so every card shares one axis and two subtitles out of step read as
   * one pattern displaced sideways from the other. The playhead is on the same
   * axis, which is what ties the picture to what is being heard.
   *
   * And it is a control, not a picture: dragging the strip moves that subtitle.
   * Holding a nudge button and watching for the moment it looks right is the
   * gesture this replaces, and it costs a reader the whole time it takes.
   *
   * Two scales, and the second one is not optional.
   *
   * A whole film is the map the eye wants for orientation, and it is useless
   * for the job it is here to do. Measured on a two-hour film in a 296px strip:
   * a 4.2 second error - a big one, the kind that makes a line land on the wrong
   * speaker - is 0.06% of the width, which is a third of one pixel. Every sync
   * error worth fixing is invisible at this scale. So the strip zooms to a
   * window around the playhead, where at 30 seconds across a pixel is a tenth
   * of a second and the displacement between two cards is the thing you are
   * looking at.
   *
   * Each scale is drawn the way that scale wants. Across a whole film, density
   * into one bucket per device pixel column: a bar per line is illegible past a
   * couple of hundred lines and would grow with the file. Inside a window,
   * every cue as itself, found by binary search - twenty of them, in their
   * exact places, which is what "the same line, here and there" needs.
   */
  const MAP_HEIGHT = 26;

  /* Whole film, then a minute, then fifteen seconds. Three steps because they
   * answer three different questions - where am I, which line is which, and is
   * this exactly on - and because a slider would be a fourth control on a card
   * that already has nine. */
  const MAP_SPANS = [
    { ms: 0, label: "film", title: "Showing the whole film. Click for a closer look." },
    { ms: 60000, label: "60s", title: "Showing a minute around the playhead. Click to go closer." },
    { ms: 15000, label: "15s", title: "Showing 15 seconds around the playhead. Click for the whole film." },
  ];

  function buildTimeline(slot) {
    const root = document.createElement("div");
    root.className = "sso-map";

    /* The strip and its scale are siblings, not one on top of the other.
     *
     * The badge started inside the strip, in the corner, and covered the last
     * eighth of it - which at the fifteen-second scale is nearly two seconds of
     * film hidden behind the control that chose to show them. A label that eats
     * the data it labels is worse than one that costs a little width. */
    const plot = document.createElement("div");
    plot.className = "sso-map__plot";
    plot.title = "Where this subtitle speaks. Drag it sideways to move the timing.";

    const canvas = document.createElement("canvas");
    canvas.className = "sso-map__canvas";
    plot.append(canvas);

    /* The scale, beside the thing whose scale it is. A button rather than a
     * setting because it is changed constantly - coarse to find the scene, fine
     * to land the line - and a control reached for that often does not belong
     * behind a menu. */
    let spanStep = 0;
    const zoom = document.createElement("button");
    zoom.type = "button";
    zoom.className = "sso-map__zoom";
    zoom.addEventListener("click", (event) => {
      event.stopPropagation();
      spanStep = (spanStep + 1) % MAP_SPANS.length;
      signature = ""; // the axis changed, so the picture has to be built again
      refresh(api.status());
    });
    root.append(plot, zoom);

    /* What the drag is doing, while it is doing it. The number is the whole
     * point of dragging rather than nudging - the reader is aiming at a
     * position, and the offset is the thing they will have to undo if it is
     * wrong. */
    const readout = document.createElement("span");
    readout.className = "sso-map__readout";
    readout.hidden = true;
    plot.append(readout);

    let buckets = null;
    let signature = "";
    let durationMs = 0;
    let width = 0;
    let height = 0;
    // The stream-time window being shown, which is the whole film or a slice
    // of it centred on the playhead.
    let from = 0;
    let to = 0;

    const spanMs = () => MAP_SPANS[spanStep].ms;

    function setWindow(status) {
      durationMs = Number.isFinite(status.duration) ? status.duration * 1000 : 0;
      const span = spanMs();
      if (!span || span >= durationMs) {
        from = 0;
        to = durationMs;
        return;
      }
      const at = Number.isFinite(status.currentTime) ? status.currentTime * 1000 : 0;
      /* Clamped to the film rather than allowed to run off it, so the last
       * fifteen seconds are still fifteen seconds wide. A window that shrank at
       * the ends would change the scale exactly where a reader is checking the
       * end credits line up. */
      from = Math.min(Math.max(0, at - span / 2), Math.max(0, durationMs - span));
      to = from + span;
    }

    /* The whole-film picture is recomputed only when something it depends on
     * changes. refresh() runs on every status round - several a second while a
     * film plays - and rebuilding a histogram of a thousand cues each time
     * would put real work on that path for a picture that has not moved. */
    function rebuildDensity(status) {
      const track = status.tracks[slot];
      const next = [
        track.cueCount, track.fileId, track.offsetMs, track.rate,
        Math.round(durationMs), width, status.adDriftMs,
      ].join("|");
      if (next === signature) return;
      signature = next;

      buckets = new Float32Array(width);
      if (!durationMs || !track.cueCount) return;
      let tallest = 0;
      for (const fileMs of api.cueTimes(slot)) {
        const at = api.toStreamMs(slot, fileMs) / durationMs;
        /* Lines pushed outside the film are pinned to the edge they went past
         * rather than dropped. A subtitle shifted far enough to run off the end
         * is exactly the state the reader is trying to see, and a strip that
         * quietly emptied itself would hide it. */
        const bucket = Math.min(width - 1, Math.max(0, Math.round(at * (width - 1))));
        buckets[bucket] += 1;
        if (buckets[bucket] > tallest) tallest = buckets[bucket];
      }
      if (tallest > 0) for (let i = 0; i < width; i++) buckets[i] /= tallest;
    }

    const ratio = () => Math.max(1, Math.round(window.devicePixelRatio || 1));
    const xOf = (streamMs) => ((streamMs - from) / (to - from)) * (width - 1);

    function paintDensity(context) {
      if (!buckets) return;
      for (let i = 0; i < width; i++) {
        const value = buckets[i];
        if (!value) continue;
        /* A floor, so one line in a quiet stretch is still a mark. The quiet
         * stretches are what the eye lines up on - a run of silence is a
         * landmark in a way that a run of dialogue is not. */
        const bar = Math.max(2, Math.round(value * height));
        context.globalAlpha = 0.4 + 0.6 * value;
        context.fillRect(i, height - bar, ratio(), bar);
      }
      context.globalAlpha = 1;
    }

    /* Every line in the window, where it actually is.
     *
     * Binary search for the first cue in range rather than a scan, because this
     * runs on the playhead tick and the file is a thousand lines. Bounded by
     * what fits on screen: a fifteen-second window holds about six lines. */
    function paintCues(context) {
      const times = api.cueTimes(slot);
      if (!times.length) return;
      let low = 0;
      let high = times.length - 1;
      let first = times.length;
      while (low <= high) {
        const mid = (low + high) >> 1;
        if (api.toStreamMs(slot, times[mid]) >= from) {
          first = mid;
          high = mid - 1;
        } else {
          low = mid + 1;
        }
      }
      for (let i = first; i < times.length; i++) {
        const at = api.toStreamMs(slot, times[i]);
        if (at > to) break;
        context.globalAlpha = 0.9;
        context.fillRect(Math.round(xOf(at)), 2, Math.max(2, ratio() * 2), height - 2);
      }
      context.globalAlpha = 1;
    }

    function paint(status) {
      const context = canvas.getContext("2d");
      if (!context || !width || to <= from) return;
      context.clearRect(0, 0, width, height);

      const style = getComputedStyle(plot);
      context.fillStyle = style.getPropertyValue("--sso-map-ink").trim() || "#93b9fb";
      if (spanMs()) paintCues(context);
      else paintDensity(context);

      const at = status.currentTime;
      if (Number.isFinite(at)) {
        context.fillStyle = style.getPropertyValue("--sso-map-head").trim() || "#eef0f3";
        const x = Math.min(width - 1, Math.max(0, xOf(at * 1000)));
        context.fillRect(Math.round(x), 0, ratio(), height);
      }
    }

    function draw(status) {
      const track = status.tracks[slot];
      // Nothing to draw, and nothing honest to draw it against: a film whose
      // duration the player has not reported yet has no axis.
      root.hidden = !track.attached || !Number.isFinite(status.duration) || status.duration <= 0;
      if (root.hidden) return;
      /* Off-screen means no measurement, and no measurement means no draw. The
       * card is in the DOM while the Find screen is showing and measures 0px
       * wide there; rendering into that would cache a one-pixel histogram
       * against the signature and hand it back when the screen returns. */
      const box = plot.getBoundingClientRect();
      if (box.width < 1) return;

      const nextWidth = Math.max(1, Math.round(box.width * ratio()));
      if (nextWidth !== width) {
        width = nextWidth;
        height = Math.max(1, Math.round(MAP_HEIGHT * ratio()));
        canvas.width = width;
        canvas.height = height;
        signature = "";
      }

      const scale = MAP_SPANS[spanStep];
      zoom.textContent = scale.label;
      zoom.title = scale.title;
      root.dataset.zoomed = scale.ms ? "true" : "false";

      setWindow(status);
      if (!scale.ms) rebuildDensity(status);
      paint(status);
    }

    /* Drag to move the subtitle.
     *
     * Pointer capture, because the reader will leave the strip - the whole
     * gesture is aiming at a position further along the film than the one under
     * the finger - and a drag that stops working at the edge of a 300px strip
     * would be worse than the buttons it replaces. Committed on release with
     * one toast carrying an undo, the same shape a held nudge ends with. */
    let drag = null;
    plot.addEventListener("pointerdown", (event) => {
      if (!durationMs || !width || event.button !== 0) return;
      event.preventDefault();
      event.stopPropagation(); // the card treats a bare click as "select me"
      drag = {
        x: event.clientX,
        was: timingOf(slot),
        pixels: plot.getBoundingClientRect().width || 1,
        /* The span at the moment the drag started, not the live one. Nudging
         * the offset moves the playhead's line through the window, which moves
         * the window - and a conversion that changed under the gesture would
         * make the subtitle accelerate away from the finger. */
        across: to - from,
      };
      plot.setPointerCapture(event.pointerId);
      plot.dataset.dragging = "true";
      readout.hidden = false;
      readout.textContent = api.describeOffset(drag.was.offsetMs);
    });

    const movedTo = (event) => {
      if (!drag) return null;
      const moved = ((event.clientX - drag.x) / drag.pixels) * drag.across;
      /* Dragging right means the lines should arrive later, which is a larger
       * offset - the same direction the "Late" button pushes. The span is the
       * window's, not the film's, which is what makes the fine scale worth
       * having: 15 seconds across 296px is a tenth of a second per pixel. */
      return Math.round(drag.was.offsetMs + moved);
    };

    plot.addEventListener("pointermove", (event) => {
      const next = movedTo(event);
      if (next === null) return;
      readout.textContent = api.describeOffset(next);
      api.setOffset(next, { slot, quiet: true });
    });

    const finish = (event) => {
      const next = movedTo(event);
      if (next === null) return;
      const was = drag.was;
      drag = null;
      delete plot.dataset.dragging;
      readout.hidden = true;
      if (plot.hasPointerCapture?.(event.pointerId)) plot.releasePointerCapture(event.pointerId);
      if (next === was.offsetMs) return;
      api.showToast(`Moved · ${api.describeOffset(next)}`, {
        action: {
          label: "Undo",
          onClick: () => {
            applyTiming(slot, was);
            refresh(api.status());
          },
        },
      });
      refresh(api.status());
    };
    plot.addEventListener("pointerup", finish);
    plot.addEventListener("pointercancel", finish);

    return { root, draw };
  }

  function buildTrackCard(slot) {
    /* The card is the selection.
     *
     * There was a radio in a chip marked "keys" on every card, saying which
     * subtitle the nudge keys moved. The comment beside it admitted the
     * problem: a reader looking at a dot on a card guesses "this is the
     * selected one", which was said to be "a different question with a
     * different answer". It should not have been. One subtitle being the one
     * the controls act on IS selection, and a surface with two subtitles on it
     * needs that idea anyway - so the card is selectable, the selected one is
     * marked, and the chip is gone along with the row of its own it needed.
     *
     * Clicking anywhere on the card that is not a control selects it. */
    const root = document.createElement("div");
    root.className = "sso-track";
    root.tabIndex = 0;
    root.setAttribute("role", "button");
    root.addEventListener("click", (event) => {
      if (event.target.closest("button, input, label, .sso-nudge")) return;
      api.setKeyTrack(slot);
    });
    root.addEventListener("keydown", (event) => {
      if (event.key !== "Enter" && event.key !== " ") return;
      if (event.target !== root) return;
      event.preventDefault();
      api.setKeyTrack(slot);
    });

    const head = document.createElement("div");
    head.className = "sso-track__head";

    /* The name, in two parts, because a release name identifies a subtitle at
     * its END and an ellipsis eats the end first. Measured: two subtitles for
     * the same episode, 397px of name in 155px of card, both rendering
     * "1. Battlestar.Galactic..." and "2. Battlestar.Galactica..." - two cards
     * with nothing to tell them apart, on the one line whose job is telling
     * them apart. The last token is held out of the truncation. */
    const label = document.createElement("span");
    label.className = "sso-track__label";
    const labelHead = document.createElement("span");
    labelHead.className = "sso-track__name";
    const labelTail = document.createElement("span");
    labelTail.className = "sso-track__tail";
    label.append(labelHead, labelTail);

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
      menu(more, [
        {
          label: "Style…",
          title: "Colour, font, size, outline",
          onClick: () => openStyle(slot),
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

    /* Whether this subtitle is one of the languages being learnt.
     *
     * It was a "Subtitle 1 / Subtitle 2" pair in the study section - a third
     * copy of that control, in a third place, meaning a third thing. It names a
     * subtitle, so it belongs on that subtitle, beside the other chip that says
     * what this one is for.
     *
     * And it is a switch per subtitle rather than a radio, because study can
     * follow more than one at once. Its former shape said "move study here",
     * which cannot express "both" and cannot express "neither". */
    const learnChip = document.createElement("button");
    learnChip.className = "sso-track__learn";
    learnChip.type = "button";
    learnChip.addEventListener("click", (event) => {
      event.stopPropagation();
      window.__ssoStudy?.toggleStudySlot(slot);
      refresh(api.status());
    });

    /* Hide is a button, not a menu item. It is the other thing readers reach
     * for constantly - a subtitle in the way of something on screen goes away
     * for ten seconds and comes back - and burying a ten-second action two
     * clicks deep is what made the menu feel like a filing cabinet. */
    /* Drawn, not written. It was "◉" for showing and "◎" for hidden, next to a
     * radio drawn "◉", next to an amber dot for the subtitle being studied:
     * three circles in a row, telling three unrelated things apart by colour
     * alone. An eye is a shape nobody has to learn, and the bar across it is
     * how every player on earth says "off". */
    const visible = document.createElement("button");
    visible.className = "sso-icon sso-track__eye";
    visible.type = "button";
    const eye = document.createElement("span");
    eye.className = "sso-eye";
    const eyeBar = document.createElement("span");
    eyeBar.className = "sso-eye__bar";
    eye.append(eyeBar);
    visible.append(eye);
    visible.addEventListener("click", (event) => {
      event.stopPropagation();
      api.setVisible(!api.status().tracks[slot].visible, { slot });
    });

    /* No fold on a card.
     *
     * It carried one over from when a card was seven controls tall and two of
     * them filled the panel. A card is a title and one row now - about sixty
     * pixels - so folding it saves twenty-six of them and costs the timing row,
     * which is the one thing on this surface that is used while a film runs.
     * A control that hides the only thing worth showing is not worth a click. */
    head.append(label, learnChip, visible, more);

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

    /* Moving the film by this subtitle's lines.
     *
     * Not a timing control - it moves the picture, not the text - but it
     * belongs on this card all the same, because "a line" means a line of this
     * file, and the two subtitles are routinely timed and cut differently. It
     * sits under the sync row and carries the same weight, which is the right
     * order: the timing is set once when a subtitle turns out to be out of
     * step, and this is reached for whenever a line goes past too fast.
     *
     * "Again" and not "Previous": the first press restarts the line being
     * spoken, which is what it is reached for, and it takes a second press to
     * go back one. */
    const lines = document.createElement("div");
    lines.className = "sso-row";
    const stepper = (text, direction, why) => {
      const b = button(text, { title: why });
      b.className = "sso-line-step";
      b.addEventListener("click", () => api.stepLine(direction, { slot }));
      return b;
    };

    /* Lining up was a menu item, which is three actions - open the menu, read
     * five entries, click one - for the thing a reader reaches for the moment a
     * second subtitle is out of step with the first. It is the same promotion
     * the timing undo already got, for the same reason.
     *
     * On the card rather than in the top bar because it names a subtitle: this
     * one moves, the other one does not. The top bar has the version that does
     * not name one. */
    const lineUpButton = button("Line up", {
      title: "Work out the gap from where the two subtitles say the same things",
      onClick: () => lineUp(slot),
    });
    lineUpButton.className = "sso-line-step sso-line-step--align";

    lines.append(
      lineUpButton,
      stepper("‹ Again", -1, "Play this line from its start. Press twice to go back one."),
      stepper("Next ›", +1, "Skip to where the next line begins."),
    );

    /* The map goes above the controls that move it, not below them: it is the
     * reading those controls change, and it is also one of them. */
    const timeline = buildTimeline(slot);

    const body = document.createElement("div");
    body.className = "sso-track__body";
    body.append(timeline.root, offsets, lines);

    root.append(head, body);
    return {
      root, learnChip, label, labelHead, labelTail,
      offsetField, offsetReset, visible, more, lineUpButton, timeline,
    };
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
        onClose: () => {
          api.cancelCapture();
          refresh(api.status());
        },
      });
      settingsWindow.body.append(
        buildSite(), buildWatching(), buildAppearance(), buildKeys(), buildDiagnostics(),
      );
    }
    closeMenu();
    await settingsWindow.show(host);
    refresh(api.status());
    refreshSite();
  }

  /* What happens on this site when something starts playing.
   *
   * First in the window, because it is the only setting here that changes what
   * the tool does without being asked - everything below it changes how
   * something already asked for looks or is reached. A switch for behaviour a
   * reader did not turn on has to be the easiest one in the window to find.
   *
   * The site is named rather than described, because "this site" read on an
   * embedded player is ambiguous in exactly the case where it matters.
   */
  function buildSite() {
    const wrap = section("This site");

    el.autoSite = toggle_("Put subtitles on by themselves", false, async (on) => {
      const result = await api.daemon("autoSiteSet", { enabled: on });
      el.autoSiteWhere.textContent = describeSite(result);
      api.showToast(
        on
          ? "Subtitles will come on by themselves here"
          : "Subtitles will wait to be asked for here",
      );
    });
    el.autoSite.row.title =
      "When a new episode starts, find and attach subtitles without being asked";

    el.autoSiteWhere = document.createElement("p");
    el.autoSiteWhere.className = "sso-note";

    const note = document.createElement("p");
    note.className = "sso-note";
    note.textContent =
      "It switches itself on the first time you attach subtitles on a site, and never " +
      "downloads anything that does not match what is playing.";

    wrap.append(el.autoSite.row, el.autoSiteWhere, note);
    return wrap;
  }

  const describeSite = (result) =>
    result?.origin ? result.origin.replace(/^https?:\/\//, "") : "this page";

  /* Asked for rather than pushed, because it lives in the worker and only the
   * settings window shows it. Silent on failure: a switch that cannot read its
   * own state should not put an error in front of somebody who came here to
   * change the backdrop. */
  async function refreshSite() {
    if (!el.autoSite) return;
    try {
      const result = await api.daemon("autoSite", {});
      el.autoSite.input.checked = Boolean(result?.enabled);
      el.autoSiteWhere.textContent = describeSite(result);
    } catch {
      el.autoSiteWhere.textContent = "";
    }
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
  /* A timing is two numbers, and they only mean anything together.
   *
   * The offset the aligner hands back is derived from the rate it was measured
   * at - `offsetMs` at the autoAlign call site is computed from `trackRate` -
   * so taking one without the other lines the film up at the start and lets it
   * drift for the rest of the run. Which is exactly what the offer path did: it
   * applied the offset and dropped the rate, so a subtitle that needed the 4%
   * PAL stretch was announced as lined up and was seconds out by the end. */
  const timingOf = (slot) => {
    const track = api.status().tracks[slot];
    return { offsetMs: track?.offsetMs ?? 0, rate: track?.rate ?? 1 };
  };

  const applyTiming = (slot, { offsetMs, rate }) => {
    api.setRate(rate ?? 1, { slot, quiet: true });
    api.setOffset(offsetMs ?? 0, { slot, quiet: true });
  };

  function lineUp(slot) {
    /* Read before the aligner runs, because the confident band applies itself
     * inside autoAlign and after the call there is nothing left to remember.
     * Undo used to put back rate 1 and offset 0, which is where a file starts
     * out and not where the reader was if they had already timed it by hand. */
    const was = timingOf(slot);
    const answer = api.autoAlign?.(slot);
    if (!answer) {
      api.showToast("Nothing to line this up against");
      return;
    }
    const lined = (undoTo) => {
      api.showToast(`Lined up · ${api.describeOffset(answer.offsetMs)}`, {
        action: {
          label: "Undo",
          onClick: () => {
            applyTiming(slot, undoTo);
            api.showToast("Back to the timing it had");
            refresh(api.status());
          },
        },
      });
    };
    if (answer.verdict === "apply") {
      lined(was);
    } else if (answer.verdict === "offer") {
      api.showToast(`These look ${api.describeOffset(answer.offsetMs)} apart. Use it?`, {
        action: {
          label: "Line up",
          onClick: () => {
            applyTiming(slot, { offsetMs: answer.offsetMs, rate: answer.trackRate });
            lined(was);
            refresh(api.status());
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

    /* Pick for me.
     *
     * Reading a list of forty releases and guessing which one was cut for the
     * file you are watching is the slow part of this screen, and it is a guess:
     * the name says which release it was timed against, and nothing on the page
     * says which release you have. So the honest way to choose is to fetch a
     * few and look at their timing, which is what this does.
     *
     * Three, because two cannot break a tie and four is another download for a
     * question the first three have usually settled. */
    el.tryBest = button("Try the best 3", {
      onClick: () => tryBest(),
      title: "Download the top three and keep whichever lines up best. Costs three downloads.",
    });
    el.tryBest.className = "sso-try";
    el.tryBest.hidden = true;

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

    wrap.append(el.findFor, row, el.searchNote, el.tryBest, el.languageFilter, el.results);
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
    el.tryBest.hidden = true;
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
    /* Nothing to choose between with one result, and nothing to choose FROM
     * with none. Both are cases where a button offering to try three would be
     * a button that cannot do what it says. */
    el.tryBest.hidden = lastResults.length < 2;
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

  /* --- letting the timing choose the subtitle ---------------------------------
   *
   * What a result's name tells you is which release it was TIMED AGAINST. What
   * nothing on a streaming page tells you is which release you are WATCHING. So
   * picking by reading names is guessing, and the reader finds out it was wrong
   * by watching a scene with the lines in the wrong place and coming back.
   *
   * Timing is checkable, and the aligner already checks it. So: fetch the top
   * three, and let the evidence decide.
   *
   * There are two kinds of evidence and they are not equally good, so the
   * summary says which one was used. With a subtitle already attached there is
   * a real answer - the aligner compares each candidate against it and returns
   * a confidence, and that IS the question being asked. With nothing attached
   * there is nothing to compare against, and the best available evidence is
   * weaker: how much of the film a candidate covers, and whether the others
   * agree with its timing. Two candidates agreeing puts them in the same
   * release family, which is usually the common one; it does not prove either
   * is right for this file.
   *
   * The two that lose are not wasted. The daemon caches every download, so
   * picking one of them by hand afterwards costs nothing.
   */
  const AUTO_TRY = 3;

  /* How much of the film a subtitle reaches. Real subtitles stop before the
   * end - credits are not spoken - so anything from about four-fifths of the
   * way in is a full file, and short of that it is a different cut, a sample,
   * or the wrong episode. */
  function spanFit(cues, durationMs) {
    if (!durationMs || !cues.length) return 0;
    const covered = cues[cues.length - 1].start / durationMs;
    if (covered > 1.05) return 0.2; // runs past the end of the film
    return Math.min(1, covered / 0.85);
  }

  async function tryBest() {
    const shown = languageChoice
      ? lastResults.filter((result) => (result.language || "").toLowerCase() === languageChoice)
      : lastResults;
    const picks = shown.slice(0, AUTO_TRY);
    if (!picks.length) return;

    const slot = targetSlot;
    const status = api.status();
    const durationMs = Number.isFinite(status.duration) ? status.duration * 1000 : 0;
    /* The lowest attached slot that is not the one being filled - the same rule
     * autoAlign uses, so what this checks against is what will line it up. */
    const referenceSlot = status.tracks.findIndex(
      (track, index) => index !== slot && track.attached,
    );
    const reference = referenceSlot >= 0 ? api.cueTimes(referenceSlot) : null;

    el.tryBest.disabled = true;
    el.searchNote.className = "sso-note";
    const tried = [];
    const failed = [];
    for (const [index, result] of picks.entries()) {
      el.searchNote.textContent =
        `Trying ${index + 1} of ${picks.length} · ${result.release || result.movie_name || ""}`;
      const response = await api.daemon("fetch", {
        fileId: result.file_id,
        context: fetchContext(result),
      });
      if (!response || response.error || response.transportError || !response.cues?.length) {
        failed.push(response?.quota_exceeded ? "the daily download limit" : "a failed download");
        // A quota wall will not heal on the next one, so stop asking.
        if (response?.quota_exceeded) break;
        continue;
      }
      tried.push({ result, cues: response.cues });
    }

    el.tryBest.disabled = false;
    if (!tried.length) {
      el.searchNote.className = "sso-note sso-note--warn";
      el.searchNote.textContent = failed.length
        ? `Could not try any of them: ${failed[0]}.`
        : "Could not download any of them.";
      return;
    }

    const aligner = globalThis.__ssoAlign;
    for (const candidate of tried) {
      candidate.starts = candidate.cues.map((cue) => cue.start);
      candidate.fit = spanFit(candidate.cues, durationMs);
      candidate.agree = 0;
      if (reference && aligner) {
        const answer = aligner.align(reference, candidate.starts);
        candidate.confidence = answer.ok ? answer.confidence : 0;
      }
    }

    /* Which candidates share a timing. Only worth computing with nothing to
     * check against, where it is the only thing said about timing at all. */
    if (!reference && aligner) {
      for (let i = 0; i < tried.length; i++) {
        for (let j = i + 1; j < tried.length; j++) {
          const answer = aligner.align(tried[i].starts, tried[j].starts);
          if (answer.ok && Math.abs(answer.shiftMs) < 1000) {
            tried[i].agree += 1;
            tried[j].agree += 1;
          }
        }
      }
    }

    /* Order preserved on a tie, so when the evidence cannot separate two
     * candidates the daemon's own ranking - match against the title, then
     * downloads - breaks it, rather than whichever happened to be fetched
     * first. */
    const best = tried.reduce((winner, candidate) => {
      const score = (item) =>
        reference ? item.confidence : item.agree * 2 + item.fit;
      return score(candidate) > score(winner) ? candidate : winner;
    }, tried[0]);

    const said = reference
      ? best.confidence >= (aligner?.ACCEPT ?? 3.5)
        ? `Checked against subtitle ${referenceSlot + 1}: this one matches.`
        : `None of the three clearly matches subtitle ${referenceSlot + 1}. This is the closest — check it.`
      : `Nothing attached to check against, so this is the one that covers the film best.`;

    await attachResult(best.result, { cues: best.cues });
    el.searchNote.className =
      reference && best.confidence < (aligner?.ACCEPT ?? 3.5) ? "sso-note sso-note--warn" : "sso-note";
    el.searchNote.textContent =
      `${said}${tried.length > 1 ? ` The other ${tried.length - 1} are cached, so picking one below is free.` : ""}`;
  }

  function tag(text, extra) {
    const span = document.createElement("span");
    span.className = extra ? `sso-tag ${extra}` : "sso-tag";
    span.textContent = text;
    return span;
  }

  /* Title context, so the cache can recognise this film next time and not spend
   * another download on a different upload of it. */
  const fetchContext = (result) => ({
    imdb_id: lastResolved?.imdb_id || null,
    language: result.language || null,
    movie_name: result.movie_name || null,
    release: result.release || null,
  });

  /* `cues` is for the caller that already has them.
   *
   * tryBest downloads three and then attaches one, and without this it asked
   * for the winner a second time - four requests to try three files. The daemon
   * caches, so the repeat was free in quota and still a round trip spent on a
   * file already in hand. */
  async function attachResult(result, { cues = null } = {}) {
    const slot = targetSlot;
    el.searchNote.className = "sso-note";
    if (!cues) el.searchNote.textContent = result.cached ? "Loading…" : "Downloading…";

    const response = cues
      ? { cues }
      : await api.daemon("fetch", { fileId: result.file_id, context: fetchContext(result) });
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

  // --- appearance -----------------------------------------------------------

  /* How the film runs, rather than how it looks.
   *
   * One setting so far, and it is a way of watching rather than a preference:
   * stopping at the end of every line turns a film into a deck of lines, which
   * is what intensive listening is and is not what anybody wants by accident.
   * It sits above Appearance because it changes what happens; everything below
   * changes what things look like. */
  function buildWatching() {
    const wrap = section("While watching");

    el.pauseAtLineEnd = toggle_(
      "Stop at the end of each line",
      api.status().settings.pauseAtLineEnd,
      (on) => {
        api.updateSettings({ pauseAtLineEnd: on });
        api.showToast(
          on
            ? "Stopping at the end of every line - press play to go on"
            : "Playing straight through again",
        );
      },
    );
    el.pauseAtLineEnd.row.title =
      "Pause when a line finishes. Press play to carry on to the end of the next one.";

    const note = document.createElement("p");
    note.className = "sso-note";
    note.textContent =
      "Lines of the selected subtitle. With the keys on, T plays the line again and Y skips ahead.";

    wrap.append(el.pauseAtLineEnd.row, note);
    return wrap;
  }

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

  /* Off until asked for, and switchable one at a time.
   *
   * Seven unmodified single letters on a page that belongs to somebody else:
   * players bind letters of their own, and a search field that has not taken
   * focus yet turns every one of them into a surprise. Nothing here is needed
   * to use the tool - the panel opens from the CC button, and every binding
   * has a control beside the thing it acts on - so the shortcuts are a
   * convenience a reader turns on, not a default they discover by accident.
   *
   * Each binding also switches off by itself, which is the same question asked
   * about one key: somebody who wants only the two nudge keys should not have
   * to accept five more to get them. */
  function buildKeys() {
    const wrap = section("Keys");

    el.keysEnabled = toggle_("Keyboard shortcuts", false, (on) =>
      api.updateSettings({ keysEnabled: on }),
    );
    el.keysEnabled.row.title = "One key each, with no modifier held";

    el.keysOff = document.createElement("p");
    el.keysOff.className = "sso-note";
    el.keysOff.textContent = "Off, so none of these will fire. They can still be set up now.";

    const grid = document.createElement("div");
    grid.className = "sso-keys";
    el.keyButtons = {};
    el.keyClears = {};

    for (const [name, label] of KEY_FIELDS) {
      const caption = document.createElement("span");
      caption.textContent = label;

      const b = button("", { title: "Click, then press the key you want" });
      b.className = "sso-key";
      b.addEventListener("click", () => rebind(name, b));
      el.keyButtons[name] = b;

      /* One shortcut off, without touching the rest. It shows only when there
       * is a binding to remove, which is also when the row has anything to
       * say - an unset row is already off and offering to unset it twice is
       * how a settings page fills up with controls that do nothing. */
      const clear = document.createElement("button");
      clear.className = "sso-key__clear";
      clear.type = "button";
      clear.textContent = "⌫";
      clear.title = `Switch "${label}" off`;
      clear.setAttribute("aria-label", `Switch "${label}" off`);
      clear.addEventListener("click", () => api.updateSettings({ keys: { [name]: "" } }));
      el.keyClears[name] = clear;

      const cell = document.createElement("div");
      cell.className = "sso-keys__cell";
      cell.append(b, clear);
      grid.append(caption, cell);
    }

    const actions = document.createElement("div");
    actions.className = "sso-row";
    actions.style.marginTop = "8px";
    actions.append(
      button("Reset keys", {
        onClick: () => api.resetKeys(),
        title: "Put every binding back to its default",
      }),
      button("Switch them all off", {
        onClick: () => api.updateSettings({
          keys: Object.fromEntries(KEY_FIELDS.map(([name]) => [name, ""])),
        }),
        title: "Leave every binding unset",
      }),
    );

    wrap.append(el.keysEnabled.row, el.keysOff, grid, actions);
    return wrap;
  }

  /* Reading the keystroke is content.js's job: there are two surfaces with
   * bindings on them now, and "listen at the document in the capture phase and
   * stop the key from also doing what it is bound to" is not a clause to write
   * twice. */
  async function rebind(name, target) {
    target.dataset.capturing = "true";
    target.textContent = "press a key…";
    const key = await api.captureKey();
    target.dataset.capturing = "false";
    if (key) api.updateSettings({ keys: { [name]: key } });
    else refresh(api.status());
  }

  /* What to print on the key.
   *
   * It printed KeyboardEvent.code, which names the switch under the finger and
   * not the letter on it: "BracketLeft" on a Turkish layout is the key that
   * types ğ, and no amount of explaining makes that a useful thing to read. */
  function describeKey(key) {
    if (!key) return "off";
    const named = {
      " ": "space",
      ArrowLeft: "←", ArrowRight: "→", ArrowUp: "↑", ArrowDown: "↓",
      Enter: "enter", Tab: "tab", Backspace: "backspace",
    };
    if (named[key]) return named[key];
    // As it looks on the keyboard, which for a letter is the capital.
    return key.length === 1 ? key.toUpperCase() : key;
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
  function makeDraggable(handle, head) {
    api.makeMovable(handle, {
      host,
      keepOnScreen: head,
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

    /* The shared row. Nothing attached means nothing to arrange and nothing to
     * study, and the empty state below owns that screen on its own. */
    const study = window.__ssoStudy?.settings?.() || null;
    el.quick.hidden = !status.attached;
    el.arrangeGroup.hidden = status.trackCount < 2;
    el.moveButton.textContent = status.placing ? "Done" : "Move";
    el.moveButton.dataset.on = status.placing ? "true" : "false";
    // One subtitle has nothing to agree with.
    el.lineUpAll.hidden = status.trackCount < 2;
    el.moveButton.title = status.placing
      ? "Drag the stand-in to where the subtitle should be, then press Done"
      : "Drag the middle of a subtitle to move it, an edge to make it wider";
    // study.js is a separate content script; if it did not load there is
    // nothing to switch on and the row should not claim otherwise.
    el.studyButton.hidden = !study;
    el.studyButton.dataset.on = study?.enabled ? "true" : "false";
    el.studyButton.setAttribute("aria-pressed", study?.enabled ? "true" : "false");

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

      const [head, tail] = splitName(`${slot + 1}. ${track.label || "Attached"}`);
      card.labelHead.textContent = head;
      card.labelTail.textContent = tail;
      // Release names are long and the chips beside them are not optional, so
      // the name is often an ellipsis. Hovering it says the whole thing.
      card.label.title = track.label || "Attached";
      /* Selected, which is what the keys act on. Marked on the card itself
       * rather than by a chip inside it: the whole card is the thing being
       * chosen, and a border says so without spending any of the title's room
       * on saying it. Only meaningful with two subtitles - with one there is
       * nothing to choose between, and a card lit up as "the selected one"
       * would be answering a question nobody asked. */
      const study = window.__ssoStudy?.settings?.();
      const learning = Boolean(study?.studySlots?.includes(slot));
      card.root.dataset.selected =
        status.trackCount > 1 && status.keyTrack === slot ? "true" : "false";
      card.root.title =
        status.trackCount > 1 && status.keyTrack !== slot
          ? "Click to point the keys and the study rail at this subtitle"
          : "";
      card.learnChip.dataset.on = learning ? "true" : "false";
      /* "learning" is a state and "learn" is an invitation. The chip carried
       * the state's word in both positions, so an off switch read as a label
       * saying this subtitle was being studied when it was not. */
      card.learnChip.textContent = learning ? "learning" : "learn";
      /* Shown on every attached subtitle now, not only on the one being
       * studied: a switch nobody can see in its off position is not a switch.
       * Still nothing to choose between with one subtitle on screen. */
      card.learnChip.hidden = !study?.enabled || status.trackCount < 2;
      card.learnChip.title = learning
        ? "Study is marking the rare words in this subtitle — click to stop"
        : "Click to study this subtitle too";
      card.learnChip.setAttribute("aria-pressed", learning ? "true" : "false");
      // Nothing to line up against with one subtitle on screen.
      card.lineUpButton.hidden = status.trackCount < 2;
      const stretched = track.rate && track.rate !== 1;
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
      card.visible.title = track.visible ? "Take it off the picture" : "Put it back on the picture";
      card.visible.setAttribute("aria-label", card.visible.title);
      card.visible.dataset.on = track.visible ? "true" : "false";
      // Nothing to undo, no undo. Which is also when the subtitle is right.
      card.offsetReset.hidden = !track.offsetMs && !stretched;
      card.timeline.draw(status);
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

    el.pauseAtLineEnd.input.checked = Boolean(settings.pauseAtLineEnd);
    el.background.input.value = String(settings.background);
    el.background.readout.textContent = String(settings.background);
    el.rewrap.input.checked = Boolean(settings.rewrap);
    el.showSymbols.input.checked = Boolean(settings.showSymbols);
    el.dimNonSpeech.input.checked = Boolean(settings.dimNonSpeech);

    el.keysEnabled.input.checked = Boolean(settings.keysEnabled);
    el.keysOff.hidden = Boolean(settings.keysEnabled);
    for (const [name] of KEY_FIELDS) {
      const key = settings.keys[name];
      el.keyButtons[name].textContent = describeKey(key);
      el.keyButtons[name].dataset.set = key ? "true" : "false";
      el.keyClears[name].hidden = !key;
    }
  }

  // --- lifecycle ------------------------------------------------------------

  /* The playhead moves when nothing has changed.
   *
   * refresh() runs when the overlay notifies, which is when something has been
   * done to a subtitle - not continuously while a film plays. So the strips get
   * a tick of their own, and only while the panel is on screen, unfolded, and
   * has something to draw. At 250ms the mark reads as moving and the redraw is
   * bounded by the strip's width in pixels, which is a few hundred fillRects a
   * quarter-second - far away from the pointermove path the overlay's own notes
   * warn about. */
  const PLAYHEAD_MS = 250;
  let playhead = null;

  function startPlayhead() {
    if (playhead) return;
    playhead = setInterval(() => {
      if (!isPanelVisible() || folded || atScreen !== "root") return;
      const status = api.status();
      if (!status.attached) return;
      for (const [slot, track] of status.tracks.entries()) {
        if (track.attached) el.trackCards[slot].timeline.draw(status);
      }
    }, PLAYHEAD_MS);
  }

  function stopPlayhead() {
    if (playhead) clearInterval(playhead);
    playhead = null;
  }

  async function show() {
    if (!host) {
      await build();
      await restorePosition();
    }
    reparent();
    startPlayhead();
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
    stopPlayhead();
    // A binding half-read is not a binding; the button that asked is going.
    api.cancelCapture();
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
  function reparent(parent, { raise = false } = {}) {
    if (!host) return;
    /* The top layer is above the fullscreen element wherever the host sits, so
     * when it works nothing moves. See toTopLayer in content.js for what
     * appending costs on a site that fullscreens the <video> itself: the panel
     * lands inside a replaced element, is never painted, and still reports
     * itself open - so the CC button appears to do nothing. */
    if (api.toTopLayer?.(host, { again: raise })) {
      rescale();
      return;
    }
    /* The whole replaced-element rule, not half of it. This used to test
     * `parent.tagName !== "VIDEO"` and then fall back to
     * `document.fullscreenElement` unchecked - and `show()` passes no parent at
     * all, so on the path that matters the test never ran. */
    const target = api.paintableParent?.(parent) || document.body || document.documentElement;
    if (target && host.parentElement !== target) target.appendChild(host);
    // The fullscreen element may be scaled; what we have just moved into
    // decides how big the panel renders and where a written position lands.
    rescale();
  }

  window.addEventListener("resize", clampIntoView, { passive: true });

  /* applySize is exported for the harness, which measures the sync row at both
   * ends of the width the corner grips allow. Driving the grips with synthetic
   * pointer events to get there would be testing the grips, not the row. */
  window.__ssoPanel = { show, hide, toggle, reparent, rescale, applySize };

  window.__ssoPanelTeardown = () => {
    // Both live on hosts outside this shadow tree, so removing the panel does
    // not remove them.
    closeMenu();
    stopPlayhead();
    settingsWindow?.destroy();
    settingsWindow = null;
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
