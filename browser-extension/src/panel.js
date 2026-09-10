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

  /* Which programme the Find screen is about.
   *
   * The box and the list of results below it answer a question about ONE
   * episode, and on a streaming site the next episode starts without a page
   * load. Nothing here noticed. The box was filled with the page's title once,
   * when it was empty, and kept that value for the rest of the session; the
   * results kept whatever the last search returned. So the episode after the
   * one you searched for opened a screen that said the previous film's name,
   * searched for it when pressed, and offered the previous film's files to
   * attach. Reported as "I have clicked the next episode button ... but the
   * subtitle tool still finds the previous title and searches for it", and seen
   * in the log at 21:06 on 2026-08-23: S03E12's subtitles attached by hand to
   * S03E13, then taken off again two minutes later.
   *
   * Whose words are in the box decides what happens to them. What this filled
   * in is this file's guess and gets refreshed; what a person typed is theirs
   * and is left alone. The results are dropped either way - they are files for
   * a film that is no longer playing. */
  let searchedFor = null;
  let queryFromPage = false;
  /* An in-flight fill that has been overtaken - by typing, or by another
   * programme - must not land. The answer comes from the worker, so there is
   * always a moment between asking and writing. */
  let fillToken = 0;

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
  /* A stylesheet that will not load costs the look, never the panel.
   *
   * These are web-accessible resources fetched at runtime, and the fetch fails
   * for a reason that has nothing to do with the panel: the extension being
   * reloaded under an open tab invalidates the context and every getURL with
   * it. Left to reject, it took build() with it, and build() is awaited by
   * show(), which is called from a click that cannot catch anything - so the
   * CC button did nothing at all and said nothing about why. Unstyled is a
   * worse panel; absent is not a panel. */
  async function loadStyles() {
    if (sheets) return sheets;
    const files = ["src/chrome.css", "src/panel.css"];
    const texts = await Promise.all(
      /* getURL is a chrome call, so it throws on an orphaned context before
       * fetch is ever reached - and an unstyled surface is the least of the
       * problems at that point. Answering "" builds nothing and says nothing. */
      files.map((file) =>
        Promise.resolve()
          .then(() => fetch(chrome.runtime.getURL(file)))
          .then((r) => r.text())
          .catch(() => ""),
      ),
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

    /* There is no count in the title bar.
     *
     * It read "nothing attached" or "2 attached" beside the window's name, and
     * it was there to give a folded panel one useful fact. It is not one: the
     * body directly below says the same thing far better - two named cards, or
     * a designed empty state with the button that ends it - so unfolded it was
     * a worse copy of what the reader was already looking at, and folded it
     * said a number about subtitles on a bar that says nothing else about them.
     * A title bar is the window's name and its controls. */

    /* Everything that is not about one subtitle. It was five sections in the
     * column behind a "More settings" button; the sections already fold, so the
     * button was a second fold on top of a fold. */
    el.gear = document.createElement("button");
    el.gear.className = "sso-icon sso-icon--gear";
    el.gear.type = "button";
    el.gear.textContent = "⚙";
    el.gear.title = "Settings";
    el.gear.setAttribute("aria-pressed", "false");
    el.gear.addEventListener("click", () => api.detached(openSettings(), "Settings"));

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

    el.preview = buildPreview();
    /* The preview goes LAST, after the three buttons, and the order is
     * load-bearing. It asks for a whole line (`flex: 1 0 100%`), so a flex
     * line breaks before it - placed between the name and the buttons it took
     * the first line for itself and pushed the gear, the fold and the close
     * onto a second one, 22px lower. That is what the harness saw as
     * "Settings at [870,113] covered by the study rail": the button had moved
     * down out of the panel's own head and under the rail beside it. */
    head.append(el.back, title, el.gear, el.fold, close, el.preview.root);

    /* Double-click the bar to fold it away, and again to bring it back.
     *
     * The gesture every window on the machine has for exactly this, asked for
     * directly: "double click on the subtitle panel should collapse / expand
     * it". The button in the corner stays - a gesture nobody is told about is
     * not a control - and this is the version you reach for while a film is
     * running, because the bar is a much larger target than a 26px icon and
     * you are not aiming at anything when you take the panel out of the way.
     *
     * The NAME keeps the older gesture: double-clicking it puts the panel back
     * under the CC button, for a panel dragged somewhere unhelpful - behind the
     * player's own controls, half off a screen that has since been resized -
     * which otherwise has to be dragged back from wherever it went. Two
     * behaviours in one bar is a smell, and the split is deliberate: the name
     * is where a window says which window it is, so "put this window where it
     * belongs" is its gesture, and both say which they are on hover. */
    head.addEventListener("dblclick", (event) => {
      if (event.target.closest("button, .sso-win__title")) return;
      setFolded(!folded);
    });

    title.title = "Double-click to put the panel back under the CC button";
    title.addEventListener("dblclick", (event) => {
      event.stopPropagation();
      host.style.setProperty("left", "auto", "important");
      host.style.setProperty("right", `${HANDLE_RIGHT}px`, "important");
      host.style.setProperty("top", `${HANDLE_TOP + HANDLE_HEIGHT + GAP}px`, "important");
      api.writeStored(null, { remove: POSITION_KEY });
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
      ear: screen(buildByEar()),
    };
    body.append(...Object.values(el.screens));

    /* Everything the panel has to say, in one place that never moves.
     *
     * Messages used to be written on the card they were about, which put a
     * result next to the control that produced it - the right instinct, and it
     * was reported as the wrong trade: "the messages should have a single fixed
     * place, they shouldn't appear on card face, this causes UI drift". It did.
     * A card grew by a line when a message arrived and shrank when it expired,
     * so the map, the field and the card below it all moved while the reader
     * was aiming at them.
     *
     * A status line at the foot of the window costs its height once, always,
     * and nothing above it ever moves. It carries the subtitle's number, so a
     * message about one of two subtitles still says which - that was the whole
     * value of writing it on the card. */
    el.status = document.createElement("div");
    el.status.className = "sso-panel__status";
    el.statusSlot = document.createElement("span");
    el.statusSlot.className = "sso-panel__status-slot";
    el.statusText = document.createElement("span");
    el.statusText.className = "sso-panel__status-text";
    el.statusDo = document.createElement("button");
    el.statusDo.type = "button";
    el.statusDo.className = "sso-panel__status-do";
    el.statusDo.hidden = true;
    /* Bound once, to whatever offer is standing. The button is built with the
     * window rather than with each message, so a new offer replaces what it
     * does and never leaves a second listener behind on the same element. */
    el.statusDo.addEventListener("click", (event) => {
      event.stopPropagation();
      saidAction?.onClick();
    });
    el.status.append(el.statusSlot, el.statusText, el.statusDo);

    panel.append(head, body, el.status, ...buildResizeGrips(body));
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
        /* Where the corner is relative to the hand that took hold of it. The
         * grip is a few pixels across and the press lands somewhere inside it,
         * so snapping the pointer would line the panel up off by however far
         * into the grip the press happened to land. */
        offX: (corner.dx < 0 ? box.left : box.right) - event.clientX,
        offY: (corner.dy < 0 ? box.top : box.bottom) - event.clientY,
      };
      // measurePlacement moved it; put it back before the drag begins.
      const back = from.map.toLocal(box.left, box.top);
      setPosition(`${back.x}px`, `${back.y}px`);

      // After the put-back, so the lines are measured against where the panel
      // actually is. The panel itself is left out of them: a box cannot be
      // lined up with the edge it is currently dragging.
      api.guides?.open?.(host);
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
      /* Held to the picture's edges and to the other surfaces on it, by the
       * corner being dragged. The same lines the subtitle boxes are held to and
       * the same key lets go of them - a panel edge that lines up with the
       * subtitle under it is the reason any of this exists. */
      let pointerX = event.clientX;
      let pointerY = event.clientY;
      let atX = null;
      let atY = null;
      if (!event.altKey) {
        const hitX = api.guides?.near?.([pointerX + from.offX], "x");
        const hitY = api.guides?.near?.([pointerY + from.offY], "y");
        if (hitX) { pointerX += hitX.delta; atX = hitX.at; }
        if (hitY) { pointerY += hitY.delta; atY = hitY.at; }
      }

      const movedX = (pointerX - from.x) * corner.dx;
      const movedY = (pointerY - from.y) * corner.dy;

      const wantedWidth = from.width + movedX;
      const wantedHeight = from.height + movedY;
      const width = clamp(wantedWidth, MIN_WIDTH, MAX_WIDTH);
      const height = clamp(
        wantedHeight,
        MIN_BODY,
        Math.max(MIN_BODY, window.innerHeight - 120),
      );
      // A size the panel is not allowed to take is not a size it lined up at.
      api.guides?.show?.(width === wantedWidth ? atX : null, height === wantedHeight ? atY : null);
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
      api.guides?.close?.();
      grip.releasePointerCapture?.(event.pointerId);
      api.writeStored({
        [SIZE_KEY]: {
          width: host.getBoundingClientRect().width,
          body: body.getBoundingClientRect().height,
        },
      });
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
      const stored = await api.readStored([SIZE_KEY, FOLD_KEY]);
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
    /* All three key events, because a player is free to act on any of them -
     * and one that toggles play on keyup heard every space typed into the
     * search box while only keydown was stopped. The window-level guard in
     * content.js is the one that reaches a field; this is what keeps the
     * player keys on a focused button from seeking and scrolling the page. */
    for (const type of ["keydown", "keyup", "keypress"]) {
      panel.addEventListener(type, (event) => {
        const target = event.composedPath?.()[0] ?? event.target;
        const typing =
          target?.isContentEditable ||
          /^(INPUT|TEXTAREA|SELECT)$/.test(target?.tagName || "");
        if (typing || PLAYER_KEYS.test(event.code)) event.stopPropagation();
      });
    }
  }

  const SIZE_KEY = "sso:panelSize";
  const FOLD_KEY = "sso:panelFolded";
  let folded = false;

  /* Folded is the panel's own state rather than a setting, but it survives a
   * reload for the same reason the position does: it is where the reader left
   * their tools, and having them spring open again is the thing they folded
   * them to avoid. */
  function setFolded(next) {
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
    api.writeStored({ [FOLD_KEY]: folded });
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
    makeCardsReorderable();

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

  /* Moving a subtitle to another number, by dragging its card.
   *
   * Asked for as "I added TR as #1 by mistake ... I should either remove it and
   * add EN as #1 first, or add EN as #2 and then move it to the position #1",
   * and the second of those is the one that should not need saying. The number
   * on a card is not a label: it is which box on the picture the lines go in,
   * which colour and size they are drawn at, and where that subtitle's strip of
   * studied words sits. Getting them the wrong way round meant taking both off
   * and starting again.
   *
   * The card is the handle, and so is its name - a click on the name already
   * means "point the keys here", so a drag on it means "move this", which is
   * the same double duty the card itself has carried since the radio chip was
   * removed from it. Everything else on the card is a control and keeps its
   * press. The press is only taken when there is somewhere to move to, so a
   * panel with one subtitle still drags the window from anywhere on it.
   *
   * The cards do not change places in the DOM while the gesture runs - the
   * dragged one follows the pointer on a transform and the others slide out of
   * its way. Rebuilding the list under a live pointer capture is how a drag
   * comes to end on a node that no longer exists.
   */
  function makeCardsReorderable() {
    // Under this, the press was a click. Both gestures start the same way.
    const GRAB_PX = 5;
    let drag = null;
    // Whether the press that is about to become a click moved the card. A
    // click after a drag would select whichever card the pointer ended over.
    let dragged = false;

    const rows = () =>
      el.trackCards
        .map((card, slot) => ({ card, slot, box: card.root.getBoundingClientRect() }))
        .filter((row) => !row.card.root.hidden && row.box.height > 0);

    function clear() {
      for (const card of el.trackCards) {
        card.root.style.transform = "";
        delete card.root.dataset.dragging;
      }
    }

    /* Where the card would land, as a position in the list on screen: the
     * number of other cards whose middle it has been carried past. */
    function landing() {
      const centre = drag.row.box.top + drag.row.box.height / 2 + drag.dy;
      let at = 0;
      for (const row of drag.rows) {
        if (row === drag.row) continue;
        if (row.box.top + row.box.height / 2 < centre) at += 1;
      }
      return at;
    }

    function show() {
      const at = landing();
      drag.row.card.root.style.transform = `translateY(${Math.round(drag.dy)}px)`;
      for (const row of drag.rows) {
        if (row === drag.row) continue;
        const was = drag.rows.indexOf(row);
        let by = 0;
        if (at > drag.pos && was > drag.pos && was <= at) by = -drag.step;
        if (at < drag.pos && was >= at && was < drag.pos) by = drag.step;
        row.card.root.style.transform = by ? `translateY(${by}px)` : "";
      }
    }

    function finish(event, { commit = true } = {}) {
      if (!drag) return;
      const { row, rows: all, started } = drag;
      const at = started ? landing() : drag.pos;
      drag = null;
      clear();
      try {
        row.card.root.releasePointerCapture?.(event.pointerId);
      } catch {}
      if (!commit || !started) return;
      // The slot standing at that position is the one this subtitle takes; the
      // set of numbers is the same, only which subtitle is under each changes.
      const to = all[at].slot;
      if (to === row.slot) return;
      api.detached(Promise.resolve(api.reorderTracks(row.slot, to)), "Moving the subtitle");
      refresh(api.status());
    }

    for (const { root } of el.trackCards) {
      root.addEventListener("pointerdown", (event) => {
        // A press that never became a drag and never heard its release - a
        // pointerup the page swallowed - is not a reason to refuse the next.
        if (event.button !== 0 || drag?.started) return;
        const control = event.target.closest("button, input, select, textarea, .sso-map");
        if (control && !control.classList.contains("sso-track__label")) return;
        const all = rows();
        if (all.length < 2) return;
        const pos = all.findIndex((row) => row.card.root === root);
        if (pos < 0) return;
        // The window is the handle for a press on any empty part of it, so a
        // press that is going to move a card has to stop being one.
        event.stopPropagation();
        dragged = false;
        drag = {
          rows: all,
          row: all[pos],
          pos,
          y: event.clientY,
          dy: 0,
          started: false,
          pointerId: event.pointerId,
          // What one place is worth: a card, plus the gap the stylesheet keeps
          // between two of them.
          step: Math.round(all[pos].box.height + Math.max(0, all[1].box.top - all[0].box.bottom)),
        };
        /* NOT captured here. Capturing on the press retargets the release to
         * the card, and a click is delivered to the nearest common ancestor of
         * where the press landed and where the release did - the card, not
         * the name inside it. So with two subtitles attached the name's own
         * click and double-click never fired, and "double-click the name to
         * replace it" did nothing on exactly the panel most readers have. The
         * harness could not see it: a synthetic pointer id cannot be captured,
         * so the dispatched dblclick reached the name every time. Capture is
         * taken below, once the press has moved far enough to be a drag. */
      });

      root.addEventListener("pointermove", (event) => {
        if (!drag || drag.row.card.root !== root) return;
        /* No button down means the press ended somewhere this never heard
         * about - a pointerup swallowed by the page, a lost capture, an
         * alt-tab. Without this the card follows the mouse forever. */
        if (event.buttons === 0) {
          finish(event, { commit: false });
          return;
        }
        drag.dy = event.clientY - drag.y;
        if (!drag.started) {
          if (Math.abs(drag.dy) < GRAB_PX) return;
          drag.started = true;
          dragged = true;
          drag.row.card.root.dataset.dragging = "true";
          /* Capture throws for a pointer id that is not live, which is what a
           * synthetic pointerdown produces. Same guard the map's drag carries. */
          try {
            root.setPointerCapture?.(drag.pointerId);
          } catch {}
        }
        event.preventDefault();
        show();
      });

      root.addEventListener("pointerup", (event) => finish(event));
      root.addEventListener("lostpointercapture", (event) => finish(event, { commit: false }));

      /* The click the press turns into, cancelled once the press moved
       * something. Capturing, because the card's own selection handler and the
       * name button's are both below this. */
      root.addEventListener(
        "click",
        (event) => {
          if (!dragged) return;
          dragged = false;
          event.stopPropagation();
          event.preventDefault();
        },
        true,
      );
    }
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
      b.className = "sso-arr sso-quiet";
      const icon = document.createElement("span");
      icon.className = `sso-arr__i sso-arr__i--${kind}`;
      b.append(icon);
      return b;
    };

    /* Four places to put a pair of subtitles, and the two new ones are the
     * answer to "I cannot place the subtitles aligned to the left or right of
     * the screen". They stack both boxes against one edge of the picture and
     * range the text against that edge, which is what makes an edge placement
     * read as placed rather than as drifting - and it leaves the middle of the
     * frame, where the faces are, clear. */
    el.arrangeGroup = document.createElement("div");
    el.arrangeGroup.className = "sso-arr-group";
    el.arrangeGroup.append(
      arranger("side", "Side by side - one on the left half, one on the right", () =>
        api.arrange("side"),
      ),
      arranger("stack", "Stacked - one above the other, along the bottom", () =>
        api.arrange("stacked"),
      ),
      arranger("left", "Both against the left edge, ranged left", () => api.arrange("left")),
      arranger("right", "Both against the right edge, ranged right", () => api.arrange("right")),
    );

    el.centreButton = arranger(
      "centre",
      "Both back to the middle of the bottom",
      () => api.resetPosition(),
    );

    /* Placing is a mode, so it says so: the button reads Done while it is on
     * and is lit, which is the only control here that changes what a click
     * anywhere else will do. */
    /* "Place", not "Move".
     *
     * It turns on a mode in which the SUBTITLES are dragged around the picture -
     * middle to move one, edge to make it wider - and it sat in a row of panel
     * controls labelled with a verb that says nothing about what it acts on.
     * Reported as "I don't understand what the Move button does". The three
     * icons beside it are presets for the same thing; this is the free-hand
     * version, and it is the only way to get a subtitle off something on screen
     * worth seeing. */
    el.moveButton = button("Place", {
      onClick: () => api.setPlacing(!api.status().placing),
      title: "Drag a subtitle around the picture: the middle moves it, an edge makes it wider",
    });
    el.moveButton.className = "sso-quick__move sso-quiet";

    /* There is no Study button here any more.
     *
     * It switched study on without naming a subtitle, next to a per-subtitle
     * "learn" chip that was itself hidden until study was already on. Two
     * controls for one idea, each unusable in the state the other one governed:
     * the row's button could not say WHICH subtitle, and the chip could not be
     * seen from the state it was for getting out of. The chip does both now -
     * marking a subtitle turns study on, unmarking the last turns it off - and
     * it says which one, which the button never could. */

    /* The version that names no subtitle: every other one moves to agree with
     * the first. On this row rather than on a card because it is about the set
     * of them, and because with three or more it is the only way to say it once
     * instead of once per card. Hidden with fewer than two, where it would be a
     * button that cannot do anything. */
    el.lineUpAll = button("Line up all", {
      onClick: () => api.detached(lineUpAll(), "Lining them up"),
      title: "Move every other subtitle to agree with the first",
    });
    el.lineUpAll.className = "sso-quick__align sso-quiet";

    /* Again and Next, once for the film rather than once per subtitle.
     *
     * They move the PICTURE to a line boundary, and there is one picture. Drawn
     * on each card they were the same control twice, asking the reader to
     * choose a card before they could press either - and the choice does not
     * matter, because both cards move the same playhead. The keyed subtitle
     * decides whose line boundaries are counted, which is what api.stepLine
     * does with no slot and what the keyboard bindings have always done.
     *
     * "Again" and not "Previous": the first press restarts the line being
     * spoken, which is what it is reached for, and it takes a second press to
     * go back one.
     *
     * A group of its own with room either side, because these two are the only
     * controls on this row that touch the FILM. Everything to their left
     * arranges the subtitles on the picture; Line up all, on the right, changes
     * their timing. Three kinds of thing, three groups, and the gaps say so. */
    const stepper = (text, key, direction, why) => {
      const b = button("", { title: why });
      b.className = "sso-line-step sso-quiet";
      const said = document.createElement("span");
      said.textContent = text;
      const hint = document.createElement("kbd");
      hint.className = "sso-key-hint";
      b.append(said, hint);
      b.addEventListener("click", () => api.stepLine(direction));
      return { b, hint, key };
    };

    el.steps = [
      stepper("Again", "prevLine", -1,
        "Play this line from its start. Press twice to go back one."),
      stepper("Next", "nextLine", +1, "Skip to where the next line begins."),
    ];
    el.playGroup = document.createElement("div");
    el.playGroup.className = "sso-quick__play";
    el.playGroup.append(...el.steps.map((step) => step.b));

    const spacer = document.createElement("span");
    spacer.className = "sso-grow";

    el.quick.append(
      el.arrangeGroup, el.centreButton, el.moveButton,
      el.playGroup, spacer, el.lineUpAll,
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
  /* Asynchronous only because the aligner may be in another frame - see the
   * note on api.autoAlign. With the video in this one it resolves in the same
   * turn and nothing about the sequence below changes. */
  async function lineUpAll() {
    const status = api.status();
    const first = status.tracks.findIndex((track) => track.attached);
    if (first === -1) return;

    for (const [slot] of status.tracks.entries()) clearSaid(slot);
    const moved = [];
    const unsure = [];
    for (const [slot, track] of status.tracks.entries()) {
      if (!track.attached || slot === first) continue;
      const answer = await api.autoAlign?.(slot, { against: first });
      if (answer?.applied) moved.push(slot + 1);
      else if (answer?.verdict === "offer") unsure.push(slot + 1);
    }

    const said = [
      moved.length ? `${moved.length === 1 ? `Subtitle ${moved[0]}` : `${moved.length} subtitles`} lined up with subtitle ${first + 1}` : "",
      unsure.length ? `subtitle ${unsure.join(" and ")} not certain - use Line up on its card` : "",
    ].filter(Boolean);
    // No Undo, for the reason given in lineUp: it went unused, and the sync
    // trace now carries the signal it was the only source of.
    api.showToast(said.length ? said.join(" · ") : "Nothing needed moving");
    refresh(api.status());
  }

  /* The nudge ladder is gone with the buttons that used it.
   *
   * holdToRepeat lived here: click to nudge, hold to run, escalating from a
   * quarter-second step to five whole seconds so one pair of controls could
   * cover both a trim and a seventeen-second correction. It was 70 lines
   * serving four buttons that the map has replaced - dragging the strip aims
   * at the position directly, which is what the escalation was approximating.
   * The keyboard nudges go through api.nudge with a fixed step and never used
   * any of this.
   */

  /* A name, split so the end of it survives being too long for the card.
   *
   * The last token is what identifies a subtitle - the language, or the source
   * a release came from - and it is the first thing an ellipsis takes. Held out
   * of the truncation it costs a dozen pixels and the two cards stop reading
   * the same. Only a SHORT last token: a name whose final separator is thirty
   * characters from the end has no tail worth saving, and holding one out would
   * leave nothing for the part that says which film this is. */
  const TAIL_MAX = 12;

  /* The reading, to hundredths and no further.
   *
   * It was `Math.round(offsetMs) / 1000` handed straight to String, which is
   * exact and therefore ragged: a drag lands on 8958ms and the card reads
   * 8.958, the next one lands on 1667 and it reads 1.667, and in a locale whose
   * decimal mark is a comma that renders as "8,958" - a number that looks like
   * eight thousand. Reported as a reading with far too many decimals.
   *
   * Two places is what the rest of the extension already says (formatOffset and
   * describeOffset in content.js both round to two), and a fixed number of
   * places is what keeps a tabular figure from shuffling sideways under a drag
   * that is rewriting it several times a second. A hundredth of a second is
   * four times finer than a film frame. */
  const offsetSeconds = (ms) => (Math.round(ms) / 1000).toFixed(2);

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
  /* Must match .sso-map__plot's height in panel.css: the canvas is sized in
   * device pixels from it, and a disagreement blurs every bar.
   *
   * 38 rather than 30, because the height now carries a value. While every line
   * was a full-height tick the strip only had to be tall enough to see; a bar
   * whose height says how much is said needs enough of them to tell a stub from
   * a full exchange, and at 30px the range between the 0.28 floor and the top
   * was 21 pixels. It is 27 now, and the card gave up a row for it. */
  const MAP_HEIGHT = 38;

  /* A minute, then fifteen seconds, then the whole film. Three steps because
   * they answer three different questions - which line is which, is this
   * exactly on, and where am I - and because a slider would be a fourth
   * control on a card that already has nine.
   *
   * A minute is where it opens, and the whole film is now the step you go to
   * rather than the one you start on. The measurement that decides it: on a
   * two-hour film in a 296px strip a 4.2 second error - a big one, the kind
   * that lands a line on the wrong speaker - is 0.06% of the width, which is a
   * third of one pixel. The opening scale showed every sync error worth fixing
   * as nothing at all, so the map opened saying the two subtitles agreed. At 60
   * seconds across, a pixel is a fifth of a second and the same error is 21px
   * of displacement between one card and the other. */
  const MAP_SPANS = [
    { ms: 60000, label: "60s", title: "Showing a minute around the playhead. Click to go closer." },
    { ms: 15000, label: "15s", title: "Showing 15 seconds around the playhead. Click for the whole film." },
    { ms: 0, label: "film", title: "Showing the whole film. Click to come back to a minute." },
  ];

  /* The first line that could still be on screen at `from`.
   *
   * Bisected on the running maximum of the ends - `reach` - and not on the ends
   * themselves. A caption held across the dialogue under it puts the ends out
   * of order: a forty-second sign ends long after the four short lines that
   * started later, and a bisection is only defined on a sorted list. Measured
   * on exactly that shape, with the playhead inside the sign and past every
   * line under it, the search answered "nothing from here on" and the strip
   * drew 0 of its 361 columns - and marked itself empty, which is the one
   * signal that means this subtitle needs moving.
   *
   * The running maximum is sorted by construction and lands on the right line
   * rather than merely a safe one: it rises only where a cue's own end is the
   * new highest, so the first index whose maximum reaches `from` is itself a
   * line that reaches `from`, and nothing before it does.
   *
   * Written once because it was written twice - the strip and the preview each
   * had a copy, and only one of them was ever going to be corrected. */
  function firstReaching(reach, count, toStream, from) {
    let low = 0;
    let high = count - 1;
    let first = count;
    while (low <= high) {
      const mid = (low + high) >> 1;
      if (toStream(reach[mid]) >= from) {
        first = mid;
        high = mid - 1;
      } else {
        low = mid + 1;
      }
    }
    return first;
  }

  /* The sync, in the title bar, at a glance.
   *
   * Asked for: "put a preview of the subtitle maps to the header bar of the
   * subtitle panel, so we can see the sync status at a glance even when the
   * panel is collapsed. Since it will be always visible, make sure it is not
   * annoying or attractive, but just visible when you look at it."
   *
   * So it is a minute of film around the playhead, not the whole film, and
   * that is the one decision here that carries the feature. Across a two-hour
   * axis a four-second error is a third of one pixel - the measurement that
   * put a zoom control on the cards in the first place - so a whole-film
   * preview would be a picture that says "in sync" whatever the truth is. Over
   * a minute the same error is a fifth of the strip.
   *
   * One row per subtitle, one above the other, on a shared axis. Being out of
   * sync looks like exactly what it is: the same pattern in both rows, one of
   * them slid sideways. Nothing else is drawn - no scale, no labels, no
   * border. It is not a control and it must not read as one.
   *
   * Quiet is a requirement rather than a preference here, because unlike every
   * other picture in this panel it is on screen the whole time the panel is,
   * folded or not. Low contrast, no fill behind it, and the playhead the same
   * ink as the bars rather than the bright one the cards use. */
  const PREVIEW_SPAN_MS = 60000;
  const PREVIEW_ROW = 7;
  /* And where in the FILM that minute is.
   *
   * Asked for as "it should show the current location as well", and the reason
   * it was missing is built into the picture above: the window is centred on
   * the playhead, so the playhead is always in the middle and the rows say
   * nothing whatever about whether this is the first scene or the last. Two
   * marks answer it - a rule the width of the film with the part already
   * watched drawn brighter, and the clock beside it. The rule is two pixels
   * tall and the same ink as everything else here, because a progress bar is
   * the one thing on this surface a reader can already read without being
   * taught, and it does not need to shout to be read. */
  const PREVIEW_FILM_ROW = 5;

  const PREVIEW_TITLE =
    "Where each subtitle speaks, around the playhead. Out of step shows as one row slid sideways. " +
    "The rule underneath is the whole film, and where in it you are.";

  const clockText = (ms) => {
    if (!Number.isFinite(ms) || ms < 0) return "";
    const all = Math.floor(ms / 1000);
    const hours = Math.floor(all / 3600);
    const minutes = Math.floor((all % 3600) / 60);
    const seconds = all % 60;
    const pad = (n) => String(n).padStart(2, "0");
    return hours > 0 ? `${hours}:${pad(minutes)}:${pad(seconds)}` : `${minutes}:${pad(seconds)}`;
  };

  function buildPreview() {
    const root = document.createElement("div");
    root.className = "sso-peek";
    root.title = PREVIEW_TITLE;

    const canvas = document.createElement("canvas");
    canvas.className = "sso-peek__canvas";

    /* The clock is text, not something drawn into the canvas: it has to stay
     * crisp at any device pixel ratio and inherit the panel's own numerals. */
    const clock = document.createElement("span");
    clock.className = "sso-peek__clock";

    root.append(canvas, clock);

    // The canvas rather than the root: the clock is a sibling now, so the two
    // are no longer the same width and the row scale comes from the canvas.
    let cssWidth = null;
    new ResizeObserver((entries) => {
      const next = entries[entries.length - 1]?.contentRect?.width ?? 0;
      if (next === cssWidth) return;
      cssWidth = next;
      painted = "";
      ink = null;
    }).observe(canvas);

    let painted = "";

    /* The colour, read from the cascade once - the same rule the cards' strips
     * follow, and for the same reason: getComputedStyle forces a style
     * recalculation, and this one ran on every repaint of the preview.
     *
     * Which during a drag on a card's map is every pointermove, because the
     * offset is in the preview's own signature. Measured on the catalogue app
     * with two 900-cue subtitles: sixty setOffsets produced sixty calls, and
     * the panel went from 11 layouts a second to 70. Re-read when the box
     * changes, which is the one moment cheap enough not to care about. */
    let ink = null;
    const inkOf = () => {
      if (ink === null) {
        ink = getComputedStyle(root).getPropertyValue("--sso-peek-ink").trim() || "#93b9fb";
      }
      return ink;
    };

    function draw(status) {
      const attached = status.tracks
        .map((track, slot) => ({ track, slot }))
        .filter((each) => each.track.attached);
      root.hidden = attached.length === 0;
      if (root.hidden) return;
      /* Measured rather than trusted whenever the cache says nothing, and the
       * hidden case is why. The observer reports 0 while nothing is attached -
       * the row is display:none then - and reports the real width only after
       * the layout that follows the round which un-hides it. Trusting the 0
       * cost that round, so the picture appeared one status behind the
       * subtitle that asked for it. */
      if (cssWidth === null || cssWidth < 1) cssWidth = canvas.getBoundingClientRect().width;
      if (cssWidth < 1) return;

      const dpr = Math.max(1, Math.round(window.devicePixelRatio || 1));
      const width = Math.max(1, Math.round(cssWidth * dpr));
      const filmRow = Math.round(PREVIEW_FILM_ROW * dpr);
      const height = Math.max(1, Math.round(PREVIEW_ROW * dpr) * attached.length + filmRow);
      const cssHeight = PREVIEW_ROW * attached.length + PREVIEW_FILM_ROW;
      if (canvas.width !== width || canvas.height !== height) {
        canvas.width = width;
        canvas.height = height;
        // In CSS pixels too, or the box has no height of its own. See the
        // stylesheet: letting it come from the intrinsic ratio is circular.
        canvas.style.height = `${cssHeight}px`;
        painted = "";
      }

      const now = Number.isFinite(status.currentTime) ? status.currentTime * 1000 : 0;
      const from = now - PREVIEW_SPAN_MS / 2;
      const to = now + PREVIEW_SPAN_MS / 2;

      /* Nothing is repainted while it would land on the same pixels - the same
       * rule the cards' strips follow, and it matters more here: this draws on
       * every status round whether or not anybody has opened the panel body. */
      const perPixel = PREVIEW_SPAN_MS / Math.max(1, width - 1);
      // At least as far as the playhead, for the reason setWindow gives: the
      // played fraction under this strip is otherwise pinned at 1.
      const durationMs = Math.max(
        Number.isFinite(status.duration) ? status.duration * 1000 : 0,
        now,
      );
      /* The second is in the key because the clock is: the rows only need
       * repainting when they would land on different pixels, but a clock that
       * repaints four times a second and a clock that repaints once a second
       * look the same and only one of them is honest about the film's length
       * arriving late. */
      const shot = [
        Math.round(from / perPixel), width, height, Math.floor(now / 1000), Math.round(durationMs),
        ...attached.map((each) => `${each.track.fileId}:${each.track.offsetMs}:${each.track.rate}:${each.track.cueCount}`),
      ].join("|");
      if (shot === painted) return;
      painted = shot;

      const context = canvas.getContext("2d");
      if (!context) return;
      context.clearRect(0, 0, width, height);
      context.fillStyle = inkOf();

      const row = Math.round(PREVIEW_ROW * dpr);
      attached.forEach((each, index) => {
        const { starts, ends, reach } = api.cueSpans(each.slot);
        const top = index * row;
        const tall = Math.max(1, row - dpr);
        // The first line still on screen at the window's edge: this runs on the
        // status round and the file is a thousand lines.
        const first = firstReaching(reach, starts.length, (ms) => api.toStreamMs(each.slot, ms), from);
        context.globalAlpha = 0.85;
        for (let i = first; i < starts.length; i++) {
          const at = api.toStreamMs(each.slot, starts[i]);
          if (at > to) break;
          const until = api.toStreamMs(each.slot, ends[i] ?? starts[i]);
          const left = Math.round(((at - from) / (to - from)) * (width - 1));
          const span = Math.max(dpr, Math.round(((until - at) / (to - from)) * (width - 1)));
          context.fillRect(left, top, span, tall);
        }
      });

      // The playhead, in the same ink as everything else. A brighter mark here
      // would be the loudest thing in a title bar that is always on screen.
      const rows = Math.round(PREVIEW_ROW * dpr) * attached.length;
      context.globalAlpha = 0.55;
      context.fillRect(Math.round((width - 1) / 2), 0, dpr, rows);

      /* The whole film underneath, and where in it this minute is.
       *
       * Drawn in three weights of the one ink rather than a second colour: the
       * unwatched remainder faintest, the part already played over it, and the
       * position itself as a full-height tick so it can be found at a glance
       * without being the brightest thing in the bar. Nothing is drawn at all
       * without a duration - a live stream has no "where in the film", and a
       * bar that pretends otherwise would sit pinned at one end. */
      if (durationMs > 0) {
        const top = rows + Math.round(dpr);
        const tall = Math.max(1, filmRow - 2 * Math.round(dpr));
        context.globalAlpha = 0.22;
        context.fillRect(0, top, width, tall);
        const played = Math.max(0, Math.min(1, now / durationMs));
        context.globalAlpha = 0.5;
        context.fillRect(0, top, Math.round(width * played), tall);
        context.globalAlpha = 0.95;
        context.fillRect(
          Math.min(width - dpr, Math.round(width * played)), rows, dpr, filmRow,
        );
      }
      context.globalAlpha = 1;

      /* Elapsed only. "15:00 / 2:00:00" is 86 pixels of a head that has about
       * 139 to give, so printing the length took more from the picture than it
       * gave: the rule underneath already says what fraction of the film this
       * is, which is the part a glance wants, and the length goes in the title
       * for the reader who wants the number. */
      clock.textContent = clockText(now);
      root.title = durationMs > 0
        ? `${PREVIEW_TITLE} ${clockText(now)} of ${clockText(durationMs)}.`
        : PREVIEW_TITLE;
    }

    return { root, draw };
  }

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

    /* Which block is under the pointer, said in the block's own words.
     *
     * Asked for directly: "to make the identification of the subtitle blocks on
     * the subtitle map, we can add a small tooltip to the blocks so we can know
     * which blocks we are dragging and we can easily find the block we are
     * looking for. Do not block the UI with tooltips, though."
     *
     * So: above the strip rather than on it - the blocks grow from the bottom
     * and a full line reaches the top, so a label inside the well would cover
     * the data it names. It takes no clicks, it is only there while the pointer
     * is, and during a drag it sits clear of the offset readout in the middle.
     *
     * A sibling of the strip, not a child: the strip clips, which is what keeps
     * a block from spilling past the axis, and a label above it would be
     * clipped by the same rule. */
    const tip = document.createElement("span");
    tip.className = "sso-map__tip";
    tip.hidden = true;
    root.append(tip);

    let buckets = null;
    // Lines shifted off either end of the film. Counted, never binned - see
    // rebuildDensity for what binning them cost.
    let spilled = { before: 0, after: 0 };
    let signature = "";
    // What the canvas is currently showing, as the pixels that decide it.
    let painted = "";
    /* The strip's laid-out width, kept by an observer rather than measured on
     * every draw. null until the first answer arrives. */
    let cssWidth = null;
    new ResizeObserver((entries) => {
      const next = entries[entries.length - 1]?.contentRect?.width ?? 0;
      if (next === cssWidth) return;
      cssWidth = next;
      // A different width is a different picture, whatever else is unchanged.
      painted = "";
      inks = null;
    }).observe(plot);
    let durationMs = 0;
    let width = 0;
    let height = 0;
    // The stream-time window being shown, which is the whole film or a slice
    // of it centred on the playhead.
    let from = 0;
    let to = 0;

    const spanMs = () => MAP_SPANS[spanStep].ms;

    function setWindow(status) {
      const at = Number.isFinite(status.currentTime) ? status.currentTime * 1000 : 0;
      durationMs = Number.isFinite(status.duration) ? status.duration * 1000 : 0;
      /* A length behind the clock is not this film's length.
       *
       * A player that cannot be seeked is seeked by fetching another stream
       * that begins at the moment asked for, and until enough of it has arrived
       * the element reports a few seconds of film while the picture is half an
       * hour in. Measured on the local catalogue app: currentTime 2363,
       * duration 11.
       *
       * Everything below then agrees on the wrong picture. At the scale this
       * opens at, 60 seconds is longer than the whole "film", so the strip
       * falls into its whole-film branch and draws an axis eleven seconds wide;
       * the playhead is clamped into it and sits on the last pixel; and it
       * STAYS there, because the clamped position is what the repaint check
       * compares - so nothing is redrawn however far the film runs. Reported as
       * "the play marker on the subtitle maps becomes frozen at the right edge
       * of the map area".
       *
       * A film is at least as long as the part of it being watched, so the axis
       * runs at least that far - and the end of it is not held onto below,
       * because there is no end here to hold onto. */
      const behind = at > durationMs;
      if (behind) durationMs = at;
      const span = spanMs();
      if (!span || span >= durationMs) {
        from = 0;
        to = durationMs;
        return;
      }
      /* Centred on the playhead, and clamped at the start of the film only.
       *
       * Zero is a certainty - no film has anything before it - and thirty
       * seconds at the very beginning is not a moment anyone is syncing. The
       * END is a belief, and on a player that fetches a new stream for every
       * seek it is routinely wrong: `filmSeconds` answers "where the stream
       * starts, plus what has arrived", which sits a few seconds ahead of the
       * playhead and climbs with it. A clamp against that pinned the window
       * near its right edge and left the mark to creep across it. Reported as
       * "when I rewind the timeline of the video, the subtitle overlay play
       * markers couldn't stay in the center and in sync".
       *
       * What the clamp was defending does not need it. `to` is `from + span`
       * whatever happens, so nothing shrinks at the end and the last thirty
       * seconds are still drawn at full scale - the window simply runs past the
       * credits into empty axis, which is honest: there is no film there. The
       * one thing the map promises is that the mark is the middle, and that is
       * now true at every moment of every film. */
      from = Math.max(0, at - span / 2);
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
      spilled = { before: 0, after: 0 };
      if (!durationMs || !track.cueCount) return;
      let tallest = 0;
      /* Weighted by how much is said, not by how many lines say it.
       *
       * A bar's height is meant to mean "how much dialogue is here", and
       * counting cues does not measure that: a subtitler who breaks a long
       * speech into six lines makes it six times taller than the same speech
       * kept whole in the other file. Which is exactly the comparison these two
       * strips exist to support, so the count was working against the one job
       * the picture has. Characters survive the split. */
      const { starts, chars } = api.cueSpans(slot);
      for (let i = 0; i < starts.length; i++) {
        const fileMs = starts[i];
        const at = api.toStreamMs(slot, fileMs);
        /* Lines pushed off the film are counted at the edge, NOT poured into
         * the edge bucket.
         *
         * Pinning them there was a real bug and a confusing one: dragging a
         * subtitle a long way piled hundreds of cues into one column, that
         * column became the tallest, and every genuine bar was then divided by
         * it - so the whole map went faint and short exactly when the reader
         * was moving it. What the height means has to be "how much dialogue is
         * here", and a bar cannot mean that if an off-screen pile sets the
         * scale. The count is kept and drawn as an edge mark instead, which is
         * the honest way to say "there is more, that way". */
        if (at < 0) { spilled.before += 1; continue; }
        if (at > durationMs) { spilled.after += 1; continue; }
        const bucket = Math.min(width - 1, Math.max(0, Math.round((at / durationMs) * (width - 1))));
        buckets[bucket] += Math.max(1, chars[i] || 1);
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

      /* Lines that have been pushed off the film, said at the edge they went
       * past. Without this a subtitle dragged far enough simply thins out and
       * the reader has no way to tell "there is no dialogue here" from "the
       * dialogue is off the end". */
      const edge = Math.max(2, ratio() * 2);
      context.fillStyle = inkOf().spill;
      if (spilled.before) context.fillRect(0, 0, edge, height);
      if (spilled.after) context.fillRect(width - edge, 0, edge, height);
    }

    /* Every line in the window, as long as it is and as full as it is.
     *
     * It was a 2px tick at each start: where somebody speaks, and nothing about
     * what happens next. Two subtitlers cutting the same exchange differently -
     * four lines against two - produce two unrelated tick patterns from
     * identical dialogue, so on the one scale where syncing actually happens
     * the eye had the least matchable picture available. Reported as exactly
     * that: the map "shows where a subtitle starts, but it doesn't show where
     * it ends or how many chars it has".
     *
     * So a line is a block from its start to its end, and its height is how
     * much it says - a full two-line exchange reaches the top of the well, an
     * interjection is a stub. Both survive being cut differently, which is what
     * makes one strip comparable with the one above it. Reading the two cards
     * together: the blocks have the same rhythm and the same profile, displaced
     * sideways by however far out the subtitle is.
     *
     * Binary search for the first cue in range rather than a scan, because this
     * runs on the playhead tick and the file is a thousand lines. */
    /* What counts as a full-height line. Two 42-character rows is the classic
     * subtitling limit and about as much as anybody reads in one cue; longer
     * ones exist and simply peg at the top rather than flattening everything
     * else, which is what normalising to the file's own longest line would do
     * on a file with one 300-character sign in it. */
    const FULL_CHARS = 84;

    /* The first cue that could be inside the window, by bisection.
     *
     * Against the END, not the start: a line that began before the window
     * opened is still on screen inside it, and searching on starts alone
     * clipped the first block of every window at the fifteen-second scale,
     * where a single cue can be most of what is showing.
     *
     * Shared with cuesInWindow, which walked the file from index 0 on every
     * draw. That is a scan whose length is however many lines the film has
     * already been through, on a path that runs 21.5 times a second - so it
     * costs nothing in the opening titles and grows for two hours. It was the
     * only linear walk left on this path, three lines below a bisection doing
     * the same job. */
    const firstInWindow = (spans) =>
      firstReaching(spans.reach, spans.starts.length, (ms) => api.toStreamMs(slot, ms), from);

    function paintCues(context) {
      const spans = api.cueSpans(slot);
      const { starts, ends, chars } = spans;
      if (!starts.length) return;
      const first = firstInWindow(spans);
      const thin = Math.max(2, ratio() * 2);
      for (let i = first; i < starts.length; i++) {
        const at = api.toStreamMs(slot, starts[i]);
        if (at > to) break;
        const until = api.toStreamMs(slot, ends[i] ?? starts[i]);
        const left = Math.round(xOf(at));
        /* Never thinner than the tick it replaces, and never touching its
         * neighbour.
         *
         * Both bounds were measured on the harness fixture at the 15s scale:
         * lines 1.8s long with gaps of 0 to 1.6s fill 74% of the strip, and
         * without the gap a run of dialogue renders as one unbroken slab - the
         * pattern the eye is supposed to match against the card below is only
         * there while the lines are separable. At the far end of the same
         * scales a two-second line is under a pixel, and a line that rounds
         * away is a line nobody can line up. */
        const span = Math.max(thin, Math.round(xOf(until)) - left - ratio());
        const fill = Math.min(1, (chars[i] || 1) / FULL_CHARS);
        const bar = Math.max(thin, Math.round((0.28 + 0.72 * fill) * (height - 2)));
        // The body of the line, and a firm edge at the start of it. The start
        // is the instant being matched against the other card; the block is the
        // shape that makes the match findable.
        context.globalAlpha = 0.55;
        context.fillRect(left, height - bar, span, bar);
        context.globalAlpha = 0.95;
        context.fillRect(left, height - bar, thin, bar);
      }
      context.globalAlpha = 1;
    }

    /* Which line is under this pointer, by the same arithmetic that drew it.
     *
     * Walks from the first cue that could be in the window, the way paintCues
     * does, and stops at the first block whose drawn extent covers the pointer.
     * Reusing the drawn extent rather than the cue's own times is the point:
     * the minimum widths in paintCues mean a two-second line at the two-hour
     * scale is a block a reader can aim at but a span they cannot, and a label
     * that disagreed with the picture would be worse than none.
     *
     * -1 for a pointer over empty axis, which is most of a quiet stretch. */
    function cueUnder(cssX) {
      const spans = api.cueSpans(slot);
      const { starts, ends } = spans;
      if (!starts.length || !width || to <= from) return -1;
      const px = cssX * ratio();
      const thin = Math.max(2, ratio() * 2);
      for (let i = firstInWindow(spans); i < starts.length; i++) {
        const at = api.toStreamMs(slot, starts[i]);
        if (at > to) break;
        const left = Math.round(xOf(at));
        const until = api.toStreamMs(slot, ends[i] ?? starts[i]);
        const span = Math.max(thin, Math.round(xOf(until)) - left - ratio());
        if (px >= left && px <= left + span) return i;
      }
      return -1;
    }

    /* The label under the pointer, and the one thing it must never do.
     *
     * The text comes from the frame holding the cues, which on a nested player
     * is not this one, so the answer arrives late - and by then the pointer has
     * moved. `wanted` is what the pointer is on NOW; an answer for anything
     * else is dropped rather than shown, or a slow frame writes the line the
     * hand was over three moves ago.
     *
     * Answers are kept, because a hover crosses the same block many times.
     * Emptied when the subtitle in this slot changes, and that is not optional:
     * the two cards are built once and reused for every attach, so index 12
     * means a different line as soon as a different file is in the slot. */
    const texts = new Map();
    let textsFor = null;
    let wanted = -1;
    async function showTip(index, cssX) {
      if (index < 0) {
        wanted = -1;
        tip.hidden = true;
        return;
      }
      wanted = index;
      let said = texts.get(index);
      if (said === undefined) {
        const cue = await api.cueTextAt(slot, index);
        // The pointer moved on, or the strip went away, while that was in
        // flight.
        if (wanted !== index || !cue) return;
        /* One line, however many the cue is written on, and short enough to be
         * read without moving the eye off the strip. A subtitle is two rows of
         * about 42 characters; a label that carried both would be the width of
         * the card. */
        said = String(cue.text).replace(/\s+/gu, " ").trim().slice(0, 64);
        texts.set(index, said);
      }
      if (wanted !== index || !said) return;
      tip.textContent = said;
      tip.hidden = false;
      /* Follows the pointer, and stops at the ends of the strip. Measured off
       * the strip rather than the window: the panel is dragged anywhere,
       * including half off the screen, and a label clamped to the viewport
       * would drift away from the block it names. */
      const room = plot.getBoundingClientRect().width;
      const wide = tip.getBoundingClientRect().width;
      tip.style.left = `${Math.round(Math.min(Math.max(0, cssX - wide / 2), Math.max(0, room - wide)))}px`;
    }

    plot.addEventListener("pointerleave", () => showTip(-1, 0));

    /* The strip's three colours, read from the cascade once.
     *
     * getComputedStyle forces a style recalculation, and this was doing it two
     * or three times per paint to fetch custom properties that are constants in
     * panel.css - it was the second-hottest thing in the profile at 80 samples,
     * behind only getBoundingClientRect. Re-read when the strip is resized,
     * which is the one moment cheap enough to not care and the only one where a
     * sheet could plausibly have been swapped underneath. */
    let inks = null;
    const inkOf = () => {
      if (inks) return inks;
      const style = getComputedStyle(plot);
      const token = (name, fallback) => style.getPropertyValue(name).trim() || fallback;
      inks = {
        ink: token("--sso-map-ink", "#93b9fb"),
        head: token("--sso-map-head", "#eef0f3"),
        spill: token("--sso-map-spill", "#f0836f"),
        grid: token("--sso-map-grid", "rgba(238, 240, 243, 0.22)"),
      };
      return inks;
    };

    /* The clock, on the strip.
     *
     * Two patterns matched by eye need something to be matched AGAINST, and
     * until now the only landmark either strip carried was the playhead - one
     * mark, in the same place on both cards, which says nothing about whether
     * the bar under it on this card is the bar under it on that one. Asked for
     * directly: "subtitle maps should show time ticks. That would make it
     * easier to match multiple points by eye."
     *
     * The ladder rather than a fixed division, because this strip shows a
     * minute, fifteen seconds or two hours depending on which the reader asked
     * for, and one division cannot serve all three. The first step that leaves
     * enough room for a label wins. */
    const TICK_STEPS = [
      1000, 2000, 5000, 10000, 15000, 30000,
      60000, 120000, 300000, 600000, 900000, 1800000,
    ];

    const clock = (ms) => {
      const total = Math.max(0, Math.round(ms / 1000));
      const hours = Math.floor(total / 3600);
      const minutes = Math.floor(total / 60) % 60;
      const seconds = total % 60;
      const mm = hours ? String(minutes).padStart(2, "0") : String(minutes);
      return `${hours ? `${hours}:` : ""}${mm}:${String(seconds).padStart(2, "0")}`;
    };

    function paintTicks(context) {
      const span = to - from;
      if (!(span > 0)) return;
      /* Far enough apart for the label to fit with room to spare. A grid whose
       * numbers touch is a grid nobody reads, and the whole point of the
       * numbers is being read at a glance from one card to the other. */
      const room = 58 * ratio();
      const step = TICK_STEPS.find((ms) => (ms / span) * width >= room)
        ?? TICK_STEPS[TICK_STEPS.length - 1];

      context.fillStyle = inkOf().grid;
      context.font = `${Math.round(9 * ratio())}px system-ui, -apple-system, sans-serif`;
      context.textBaseline = "top";
      for (let at = Math.ceil(from / step) * step; at <= to; at += step) {
        const x = Math.round(xOf(at));
        // The line quieter than its label: the label is the fact, the line is
        // only there to say which column the fact belongs to.
        context.globalAlpha = 0.55;
        context.fillRect(x, 0, ratio(), height);
        context.globalAlpha = 1;
        // Right of the line, and never off the end of the strip.
        const text = clock(at);
        const room = width - x - 3 * ratio();
        if (context.measureText(text).width <= room) {
          context.fillText(text, x + 3 * ratio(), ratio());
        }
      }
    }

    function paint(status) {
      const context = canvas.getContext("2d");
      if (!context || !width || to <= from) return;
      context.clearRect(0, 0, width, height);

      // Behind the dialogue, which is what the strip is actually about.
      paintTicks(context);

      const colour = inkOf();
      context.fillStyle = colour.ink;
      if (spanMs()) paintCues(context);
      else paintDensity(context);

      const at = status.currentTime;
      if (Number.isFinite(at)) {
        context.fillStyle = colour.head;
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
       * against the signature and hand it back when the screen returns.
       *
       * The width comes from a ResizeObserver, not from a getBoundingClientRect
       * on every draw. That read was the single biggest cost the panel had: it
       * forces a layout, it happened for both subtitles on every status round -
       * 43 a second with a film playing - and it was asking a question whose
       * answer only changes when somebody drags a corner. Measured: 36.3
       * layouts a second with the panel open against 3.3 with it shut, and
       * getBoundingClientRect the top entry in the profile at 108 samples.
       * An observer is told when the box changes and costs nothing when it does
       * not. */
      if (cssWidth === null) cssWidth = plot.getBoundingClientRect().width;
      if (cssWidth < 1) return;

      const nextWidth = Math.max(1, Math.round(cssWidth * ratio()));
      if (nextWidth !== width) {
        width = nextWidth;
        height = Math.max(1, Math.round(MAP_HEIGHT * ratio()));
        canvas.width = width;
        canvas.height = height;
        signature = "";
      }

      // See the note on `texts`: the card outlives the file in its slot.
      if (textsFor !== track.fileId) {
        textsFor = track.fileId;
        texts.clear();
      }

      const scale = MAP_SPANS[spanStep];
      zoom.textContent = scale.label;
      zoom.title = scale.title;
      root.dataset.zoomed = scale.ms ? "true" : "false";

      setWindow(status);

      /* Nothing is repainted while it would land on the same pixels.
       *
       * draw() runs on every status round, not on the 250ms playhead interval
       * it was written for - refresh() calls it for each attached subtitle, and
       * refresh runs on every notify. Measured at 21.5 draws a second with the
       * film playing, against the 4 the interval intends. At the 60s scale a
       * 254px strip is 236ms of film per pixel, so 50ms of playhead is a
       * quarter of one pixel and three paints in four produce a picture
       * identical to the one already on the canvas. Across the whole film it is
       * a twentieth of a pixel.
       *
       * So the window and the playhead are quantised to whole device pixels and
       * compared with what was last painted, along with everything else the
       * picture depends on. A skipped paint is not an approximation: it is the
       * same image. */
      const perPixel = (to - from) / Math.max(1, width - 1);
      const at = Number.isFinite(status.currentTime) ? status.currentTime * 1000 : null;
      const shot = [
        Math.round(from / Math.max(1, perPixel)), Math.round(perPixel),
        at === null ? -1 : Math.round(Math.min(width - 1, Math.max(0, xOf(at)))),
        track.offsetMs, track.rate, track.cueCount, track.fileId,
        status.adDriftMs, width, spanStep,
      ].join("|");
      if (shot === painted) return;
      painted = shot;

      const started = performance.now();
      if (!scale.ms) rebuildDensity(status);
      paint(status);
      // Only the rounds that actually put ink on the canvas: the ones the
      // signature above skips are the same picture and cost nothing.
      api.notePerf?.("maps", 1);
      api.notePerf?.("mapMs", performance.now() - started);

      /* And whether anything was drawn, because an empty well and a well whose
       * lines have all been pushed out of the window look identical - and one
       * of those is a subtitle that needs moving. It only means anything at a
       * zoomed scale: across the whole film an empty strip is a file with no
       * cues at all, which the card already says elsewhere. */
      plot.dataset.empty = scale.ms && !cuesInWindow(slot) ? "true" : "false";
    }

    /* Whether this subtitle says anything between `from` and `to`.
     *
     * Counted rather than taken from the paint, because paint runs on the
     * canvas and answers in pixels: a bar one device pixel wide at the very
     * edge of the strip is drawn and is not something a reader can see. */
    function cuesInWindow() {
      const spans = api.cueSpans(slot);
      const { starts } = spans;
      if (!starts.length) return false;
      // The first line still on screen at the window's edge. If its start is
      // past the far edge, the window falls in a silence and nothing is drawn.
      const first = firstInWindow(spans);
      if (first >= starts.length) return false;
      return api.toStreamMs(slot, starts[first]) <= to;
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
      /* Capture throws for a pointer id that is not live, which is what a
       * synthetic pointerdown produces. Losing capture costs a drag that stops
       * at the edge of the strip; letting it throw costs the drag entirely.
       * Same guard makeMovable uses, for the same reason. */
      try {
        plot.setPointerCapture?.(event.pointerId);
      } catch {}
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
      /* Said whether or not a drag is running. Without a drag it is how a
       * reader finds the line they are looking for; with one it is how they
       * know which line they have hold of, which is what was asked for. */
      const cssX = event.clientX - plot.getBoundingClientRect().left;
      api.detached(showTip(cueUnder(cssX), cssX), "The map's label");
      if (!drag) return;
      /* No button down means the press ended somewhere this never heard about -
       * a pointerup swallowed by the page, a capture lost, an alt-tab. Without
       * this the drag stayed live forever and merely moving the mouse across the
       * strip re-timed the subtitle, which is what "I'm not clicking and
       * dragging but it still behaves like I'm adjusting it" is. makeMovable
       * has carried this guard all along; this did not. */
      if (event.buttons === 0) {
        /* Ended, but not committed. The press was lost somewhere this never
         * heard about, so the position under the pointer is not an aim - it is
         * wherever the hand happened to be. Whatever the live moves already
         * applied stands, because it was applied while the button was down;
         * nothing new is written, said, or recorded. */
        finish(event, { commit: false });
        return;
      }
      const next = movedTo(event);
      if (next === null) return;
      readout.textContent = api.describeOffset(next);
      // How many repaints the gesture asked for, so a slow drag can be told
      // from a slow film.
      api.notePerf?.("drags", 1);
      /* Silent, deliberately: the drag is one correction and this fires sixty
       * times inside it. finish() commits the same value once with `note`, so
       * the drift estimator and the log see the gesture, not its samples. */
      api.setOffset(next, { slot, quiet: true, note: false });
    });

    function finish(event, { commit = true } = {}) {
      if (!drag) return;
      const next = movedTo(event);
      const was = drag.was;
      drag = null;
      delete plot.dataset.dragging;
      readout.hidden = true;
      /* The lines have just moved under the pointer, so whatever the label was
       * naming is not what is there now. The next move says the new answer. */
      showTip(-1, 0);
      try {
        plot.releasePointerCapture?.(event.pointerId);
      } catch {}
      if (!commit || next === null || next === was.offsetMs) return;
      // The gesture, once, now that it has ended: this is the correction the
      // reader made, and `fromMs` is where they started from rather than where
      // the last pointermove left it.
      api.setOffset(next, { slot, quiet: true, how: "drag", fromMs: was.offsetMs });
      /* No Undo behind a drag.
       *
       * It was a button that stood on the card until something else replaced
       * it, offering to reverse a gesture the reader had just aimed by hand -
       * and the way back from a drag that went too far is the same drag again,
       * three pixels the other way, on the picture they are already looking at.
       * Reported as unnecessary, and it is. The one that is not is the offer
       * behind Line up, which reverses something the MACHINE decided; that one
       * stays, and the log reads it as the only honest signal about whether the
       * aligner was right. */
      /* And then the drag is steadied. A hand on a 180px strip showing a minute
       * of film is accurate to about a fifth of a second, and the answer is
       * usually a few tens of milliseconds away - so the drag aims and this
       * lands. Said out loud rather than done quietly, because a correction
       * that moves after the hand has let go with nothing saying why teaches
       * the reader that their own drag was imprecise.
       *
       * Through a promise because snapTiming is forwarded: with the film in
       * another frame it answers with one, and reading `.deltaMs` off a promise
       * would have snapped nothing and said so confidently.
       *
       * `fromMs` is what makes it a steadying rather than an override: where
       * the gesture began is the only thing that says whether the snap is
       * refining the reader's aim or undoing it. See SNAP_KEEPS. */
      api.detached(
        Promise.resolve(api.snapTiming?.(slot, { fromMs: was.offsetMs })).then((snapped) => {
          sayInPanel(slot, snapped
            ? `Snapped · ${api.describeOffset(next + snapped.deltaMs)} · ${snapped.lines} lines agree`
            : `Moved · ${api.describeOffset(next)}`);
          refresh(api.status());
        }),
        "Steadying the correction",
      );
    };
    plot.addEventListener("pointerup", finish);
    plot.addEventListener("pointercancel", finish);
    // Capture can be taken away without a pointerup - a page that calls
    // setPointerCapture itself, a browser gesture. Ending here as well is what
    // stops the drag outliving the press.
    plot.addEventListener("lostpointercapture", finish);

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
    /* A group, not a button.
     *
     * It carried role="button" with tabindex 0, and twelve real buttons inside
     * it - a control that contains controls, which is not a thing, and which
     * leaves a screen reader announcing "button" over a region whose contents
     * it then reads out one interactive element at a time. Selecting is still a
     * click anywhere on the card for a mouse; the keyboard reaches it through
     * the name, which is a real button and says whether it is pressed. */
    root.setAttribute("role", "group");
    root.addEventListener("click", (event) => {
      if (event.target.closest("button, input, label")) return;
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
    /* The name IS the selection.
     *
     * It has to be reachable and operable from the keyboard, and the card
     * around it cannot be the control - see the note on the group above. A
     * button here gives Enter and Space for free, carries aria-pressed to say
     * which subtitle the keys act on, and is the element a reader would point
     * at if asked which one is selected. */
    /* And the name is where a different subtitle is asked for.
     *
     * Replacing one is a question about WHICH FILE this is, and the name is the
     * answer to that question already on the card. It was a menu item, two
     * clicks away behind a "⋯" that also held Style and Remove, which is what
     * made the menu feel like a filing cabinet - three unrelated verbs sharing
     * one button because none of them had a home.
     *
     * A double-click, not a single one, because a single click on the name
     * already means something here: it selects the card. Double-click is the
     * conventional "open this" everywhere a name is also a selection, and a
     * single click stays the cheap, reversible one. */
    const label = document.createElement("button");
    label.type = "button";
    label.className = "sso-track__label";
    label.addEventListener("click", (event) => {
      event.stopPropagation();
      api.setKeyTrack(slot);
    });
    label.addEventListener("dblclick", (event) => {
      event.stopPropagation();
      // The selection the first click of the pair made stands: replacing a
      // subtitle is also a good reason to be pointing the keys at it.
      openFind(slot);
    });
    /* The same move as dragging the card, for a hand that is not on a mouse.
     * The name is the card's keyboard entry point - it is the real button in
     * there - so it is where the card's own verbs have to be reachable from.
     * Alt with an arrow is what a reorderable list is moved with everywhere
     * else, and it is not a binding the page or the player can take. */
    label.addEventListener("keydown", (event) => {
      if (!event.altKey || (event.key !== "ArrowUp" && event.key !== "ArrowDown")) return;
      const to = slot + (event.key === "ArrowUp" ? -1 : 1);
      if (to < 0 || to >= (api.trackCount || 0)) return;
      event.preventDefault();
      event.stopPropagation();
      api.detached(Promise.resolve(api.reorderTracks(slot, to)), "Moving the subtitle");
      refresh(api.status());
    });
    /* Three facts, three treatments.
     *
     * It rendered as one string - "1. EN · the.americans.s02e06" - at one size
     * and one weight, so the two pieces of filing (which slot, which language)
     * read as the first words of the subtitle's name. Reported as exactly that.
     * They are not the name: the number is which card this is, the language is
     * what the file is in, and the name is the only part that identifies the
     * file. Set the first two small and quiet, and the name is what the eye
     * finds - which is the whole job of this line. */
    const labelNo = document.createElement("span");
    labelNo.className = "sso-track__no";
    const labelLang = document.createElement("span");
    labelLang.className = "sso-track__lang";
    const labelHead = document.createElement("span");
    labelHead.className = "sso-track__name";
    const labelTail = document.createElement("span");
    labelTail.className = "sso-track__tail";
    label.append(labelNo, labelLang, labelHead, labelTail);

    /* The menu of verbs is gone, and every one of them is on the face.
     *
     * It held three things that have nothing to do with each other - Style,
     * Replace, Remove - collected behind one "⋯" because none of them had a
     * home rather than because they belonged together. A menu is two clicks and
     * a reading step for each, and it hid the two that say something about the
     * card's state: whether this subtitle is being studied, and that it can be
     * taken off at all.
     *
     * Each now sits where its own question is asked. Replace is on the name,
     * which is the answer to "which file is this". Style opens the look of THIS
     * subtitle. Remove sits beside Hide, because they are the two ways to stop
     * seeing something and a reader reaching for one is choosing between them. */
    const styleButton = document.createElement("button");
    styleButton.className = "sso-icon sso-track__style";
    styleButton.type = "button";
    styleButton.title = "Colour, font, size, outline";
    styleButton.setAttribute("aria-label", "Style this subtitle");
    /* Drawn, not written: three letters of "Aa" in the row that already carries
     * an eye. A word here would take the room the name needs, and the two
     * letters are how every editor on earth says "type". */
    styleButton.textContent = "Aa";
    styleButton.addEventListener("click", (event) => {
      event.stopPropagation();
      openStyle(slot);
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
     * which cannot express "both" and cannot express "neither".
     *
     * It is on the face whether or not study mode is on, and that is what
     * retired the Study button from the row above. The two controls were one
     * idea split in half: a global switch that named no subtitle, and a
     * per-subtitle mark that only appeared once the global switch was already
     * on - so the mark was invisible in exactly the state a reader would use it
     * to leave. Marking a subtitle IS switching study on, and unmarking the
     * last one IS switching it off. See emptyMeansOff in study.js, which held
     * the second half of that rule already. */
    const learnChip = document.createElement("button");
    learnChip.className = "sso-track__learn";
    learnChip.type = "button";
    /* Both words, one cell. See .sso-track__learn: the button is right-aligned
     * in a group with the timing field and its clear, so a width that changes
     * with the state moves both of them under the reader's hand. */
    for (const word of ["learn", "learning"]) {
      const span = document.createElement("span");
      span.className = "sso-track__learn-word";
      span.dataset.word = word;
      span.textContent = word;
      learnChip.append(span);
    }
    learnChip.addEventListener("click", (event) => {
      event.stopPropagation();
      api.toggleStudySlot(slot);
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

    /* Taking a subtitle off, beside the other way of not seeing it.
     *
     * On the face rather than in a menu, and asking twice rather than once. A
     * menu item is safe by being hard to reach, which is a poor trade: it costs
     * every deliberate removal two clicks and a reading step to protect against
     * a mis-click. Asking on the spot costs the same two presses and protects
     * against the same mistake, with the state visible in between - the button
     * says what the next press will do rather than doing it.
     *
     * The armed state expires, and that is the part that makes it safe rather
     * than merely slow. A button left armed is a mine: the reader gives up,
     * looks away, comes back, presses what they think is the ordinary control
     * and loses the subtitle. Four seconds is long enough to move a pointer
     * across a 340px panel and short enough that nothing survives a distraction.
     * The undo behind it stays, because two presses is a smaller guarantee than
     * a way back. */
    const REMOVE_ARMED_MS = 4000;
    let armedTimer = null;

    const remove = document.createElement("button");
    remove.className = "sso-icon sso-track__remove";
    remove.type = "button";
    remove.dataset.armed = "false";
    remove.addEventListener("click", (event) => {
      event.stopPropagation();
      if (remove.dataset.armed === "true") {
        disarm();
        removeTrack(slot);
        return;
      }
      arm();
    });
    /* Disarmed by leaving it as well as by time. Moving the pointer off the
     * button is the clearest statement there is that the reader has changed
     * their mind, and it costs nothing to believe them. */
    remove.addEventListener("pointerleave", disarm);

    /* One place decides what the button says, so the two faces cannot drift
     * apart - the armed one is the whole safety mechanism and a stale "✕" over
     * an armed button would remove a subtitle nobody asked to remove. */
    function face(armed) {
      remove.dataset.armed = armed ? "true" : "false";
      remove.textContent = armed ? "Remove?" : "✕";
      remove.title = armed
        ? "Press again to take this subtitle off"
        : "Take this subtitle off";
      remove.setAttribute("aria-label", remove.title);
    }

    function arm() {
      face(true);
      clearTimeout(armedTimer);
      armedTimer = setTimeout(disarm, REMOVE_ARMED_MS);
    }

    function disarm() {
      clearTimeout(armedTimer);
      armedTimer = null;
      face(false);
    }

    face(false);

    /* No fold on a card.
     *
     * It carried one over from when a card was seven controls tall and two of
     * them filled the panel. A card is a title and one row now - about sixty
     * pixels - so folding it saves twenty-six of them and costs the timing row,
     * which is the one thing on this surface that is used while a film runs.
     * A control that hides the only thing worth showing is not worth a click. */
    /* The verbs, in a group of their own, with room around them.
     *
     * Four controls were sharing one 4px gap with the name and with each other,
     * so the top right of a card read as a strip of glyphs the eye had to
     * separate before it could aim at one. Reported as "too crowded". They are
     * two kinds of thing: "learn" is a switch that says what study does with
     * this subtitle, and the three beside it are what you can do TO the card.
     * The group is the boundary, the gap either side of it is the breathing
     * room, and every one of them is now the same 26px the rest of the panel's
     * controls are. */
    /* The reading, and the way back from it, on the identity line.
     *
     * The ask was for all three timing controls to join the map's line, and
     * they do not fit: measured at the 340px the panel opens at, the field, the
     * clear and Line up take 185px of a 316px row and leave the map 82 pixels.
     * The map is the instrument - the whole reason for making the card shorter
     * was to bring the two of them closer together - so shrinking it by two
     * thirds to save a row would have paid for the goal with the goal.
     *
     * So the number and its clear sit here instead, which is a row they fit in
     * and a place they belong: this line already says which subtitle this is,
     * and where it has been moved to is part of that. Line up stays with the
     * map below, at the card's right edge and directly under "Line up all".
     * The card is two rows either way, and the map keeps 224px at the opening
     * width instead of 82. */
    const acts = document.createElement("div");
    acts.className = "sso-track__acts";
    acts.append(styleButton, visible, remove);

    /* Everything that is not the name, as one flex item.
     *
     * The head wraps at the narrowest widths the grips allow, and what has to
     * wrap is the whole right-hand side in one piece. As separate items the
     * browser drops whichever one happens not to fit - the three verbs alone on
     * a second line, under a reading that stayed up on the first - which is
     * three groups arranged by arithmetic rather than by meaning. */
    const right = document.createElement("div");
    right.className = "sso-track__right";
    right.append(learnChip, acts);
    head.append(label, right);

    /* One row under the map: move the film, or move the text.
     *
     * The four nudge buttons that used to live here - « Early ‹ › Late » - are
     * gone. They were the way to sync a subtitle before the map existed: hold
     * one, watch, let go, judge, hold again. The map replaced that with aiming
     * at a position, and the reader who asked for it said so plainly: "subtitle
     * maps become extremely useful to sync the subtitles, I even don't need to
     * use the buttons to sync anymore". Four controls whose whole job has been
     * taken over by the picture above them are four controls to delete, not to
     * shrink. The KEYS still nudge - they are bound in Settings, they work
     * while the panel is shut and while the film is fullscreen, and that is the
     * case the buttons never covered anyway.
     *
     * What is left is two groups, because the row does two unrelated things.
     * Left: move the picture by this subtitle's lines. Right: what this
     * subtitle's timing is, and the one control that works it out for you.
     * They sit at the two ends rather than in a queue, so which half a control
     * belongs to is answered by where it is. */
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
    // Any number of seconds is a valid offset, and the field now shows
    // hundredths - a 0.25 step would mark three readings in four invalid.
    offsetField.step = "any";
    offsetField.className = "sso-sync__field";
    offsetField.title = "Seconds. Negative brings the subtitle forward.";
    offsetField.setAttribute("aria-label", "Offset in seconds");
    const commitField = () => {
      const seconds = Number(offsetField.value);
      if (Number.isFinite(seconds)) api.setOffset(Math.round(seconds * 1000), { slot, how: "typed" });
    };
    offsetField.addEventListener("change", commitField);
    offsetField.addEventListener("keydown", (event) => {
      event.stopPropagation(); // typing must not reach the nudge bindings
      if (event.key === "Enter") commitField();
    });

    /* Back to the file's own timing, beside the timing it undoes.
     *
     * It shows only when there is something to clear, so it costs nothing on a
     * subtitle that is already right - and that is also honest: nothing to
     * reset is exactly when the subtitle needs no reset. */
    const offsetReset = document.createElement("button");
    offsetReset.className = "sso-sync__clear";
    offsetReset.type = "button";
    offsetReset.textContent = "⌫";
    offsetReset.title = "Back to the file's own timing";
    offsetReset.addEventListener("click", () => {
      api.setRate(1, { slot, quiet: true, how: "reset" });
      // Acts too. A subtitle cut into acts is not back to its own timing.
      api.setSteps([], { slot });
      // Read before the move, because the move is what it describes.
      const carried = api.status().leadSlot === slot;
      api.setOffset(0, { slot, quiet: true, how: "reset" });
      sayInPanel(slot, carried
        ? "Back to the file's own timing, and the other moved with it"
        : "Back to the file's own timing");
    });

    /* Again and Next are not here any more. They are on the quick row.
     *
     * They move the PICTURE by a line of this subtitle, which made them look
     * like a per-subtitle control, and they were drawn once per card. But a
     * film has one playhead: pressing Again on card 2 does exactly what
     * pressing it on card 1 does, give or take which file's line boundaries
     * are counted, and two identical buttons on two cards is a choice the
     * reader has to make before they can press either. Reported as exactly
     * that. One pair, on the row that already holds the things that act on the
     * whole picture, and the keyed subtitle decides whose lines are counted -
     * which is the same rule the keyboard bindings have always followed. */

    /* Lining up is a timing control, so it sits with the timing controls - the
     * reading it produces is the one directly beside it. */
    /* One button, and what it lines this subtitle up WITH is the difference.
     *
     * A follower is measured against the lead, and the aligner answers that
     * from where the two files say the same things. The lead is measured
     * against the picture, and nothing in either file answers that - which is
     * why the aligner cannot help and why the snap refuses to touch it. Its
     * only reference is the reader's ear, so this asks them.
     *
     * It used to be hidden with one subtitle and, with two, to offer the
     * follower's answer on the lead's card as well: pressing it there moved
     * the reference onto the thing being referenced, which is the model
     * inverted. Read out of the running log over 241 alignments, 419 of the
     * 629 corrections that followed one inside fifteen minutes were on the
     * lead - the subtitle this button had nothing to say about. Now it does. */
    const lineUpButton = button("Line up", {
      onClick: () => api.detached(
        api.status().leadSlot === null || api.status().leadSlot === slot
          ? openByEar(slot)
          : lineUp(slot),
        "Lining it up",
      ),
    });
    lineUpButton.className = "sso-sync__align";

    /* The timing group, hard against the card's right edge.
     *
     * Reported: "buttons at the right edge should be aligned to the right
     * edge". They were not, and the reason was a 560px cap this sheet put on
     * every row - written from a screenshot of a 640px panel read as a 1290px
     * one, because the capture was at 2x. The panel cannot go past 640px, so
     * the cap did nothing but leave every right-hand control 80px short of the
     * edge it was meant to sit on. The cap is gone; see panel.css.
     *
     * And it is on the map's own line now, which is what took the card from
     * three rows to two. The reading these controls produce IS the picture
     * beside them, and Line up ends the line directly under "Line up all" on
     * the quick row - the same verb, one about this subtitle and one about all
     * of them, in one column. The two maps end up a row closer together, which
     * is the point: matching one against the other is done by eye. */
    /* The reading, and the way back from it, on the identity line above.
     *
     * The ask was for all three timing controls to join the map's line, and
     * they do not fit. Measured at the 340px the panel opens at: the field, the
     * clear and Line up take 185px of a 316px row and leave the map 82 pixels
     * wide. The map is the instrument - bringing the two of them closer
     * together is the whole reason for making the card shorter - so shrinking
     * it by two thirds to save a row would have paid for the goal with the
     * goal.
     *
     * So the number and its clear go up one line, which is a row they fit in
     * and a place they belong: that line already says which subtitle this is,
     * and how far it has been moved is part of the same sentence. Line up stays
     * with the map, at the card's right edge and directly under "Line up all".
     * The card is two rows either way, and the map keeps 181px at the opening
     * width instead of 82. Measured with two subtitles attached: the card went
     * from 130px tall to 96, and the gap between the two maps - which is the
     * distance the eye has to carry a pattern across - from 100px to 66. */
    right.insertBefore(offsetField, learnChip);
    right.insertBefore(offsetReset, learnChip);

    const timing = document.createElement("div");
    timing.className = "sso-sync__time";
    timing.append(lineUpButton);

    /* What lining up did, on the card that did it.
     *
     * It was a toast, which draws at the top of the screen - the length of the
     * film away from the button that raised it, on a surface the reader is
     * already looking at. Reported as "the message can be easily missed". A
     * result belongs next to the control that produced it, and the answer here
     * is often a question ("use it?"), which is worse than missed if it is
     * missed: the reader concludes nothing happened. */
    /* The map, and the controls that move it, on one line. */
    const timeline = buildTimeline(slot);
    offsets.append(timeline.root, timing);

    /* The drift, on the card, for as long as the corrections describe one.
     *
     * A subtitle timed against a different framerate is the one error no offset
     * can fix: it is right where the reader last corrected it and wrong again
     * ten minutes later, which is what "I need to fix the sync multiple times"
     * is. The extension has been measuring it from the reader's own corrections
     * all along and had exactly one way to say so - a toast, offered once,
     * about half an hour into the film, gone in six seconds. Read out of the
     * running log: 33 of those offers, and 6 speeds ever applied, none of them
     * to the leading subtitle, while films drifting 0.8% to 1.4% were being
     * corrected by hand ten to twenty-five times each.
     *
     * A third row rather than a place on either of the other two, because the
     * card's two rows are measured to the pixel and this one is not there at
     * all on a subtitle that does not need it. */
    const driftFix = button("Fix the drift", {
      title: "Stretch this subtitle to the film's own speed, keeping the last line you lined up",
      /* Nothing said on success: setRate already puts "Subtitle running 0.9%
       * fast" on screen, and this row takes itself away, which between them
       * are the whole answer. The failure is the one worth a sentence, and it
       * has a cause the reader can act on. */
      onClick: () => api.detached(
        Promise.resolve(api.applyTrackDrift?.(slot)).then((done) => {
          if (!done) {
            sayInPanel(slot, "There is no longer a drift to measure - correct this subtitle once more", { warn: true });
          }
          refresh(api.status());
        }),
        "Fixing the drift",
      ),
    });
    driftFix.className = "sso-sync__driftfix";

    const driftSaid = document.createElement("span");
    driftSaid.className = "sso-sync__driftsaid";

    const drift = document.createElement("div");
    drift.className = "sso-sync__drift";
    drift.hidden = true;
    drift.append(driftSaid, driftFix);

    const body = document.createElement("div");
    body.className = "sso-track__body";
    body.append(offsets, drift);

    root.append(head, body);
    return {
      root, learnChip, label, labelNo, labelLang, labelHead, labelTail, styleButton,
      offsetField, offsetReset, visible, remove, disarm, lineUpButton, timeline,
      drift, driftSaid,
    };
  }

  /* --- lining up against the picture, by ear ----------------------------------
   *
   * The aligner answers "where does this file sit against that one", and a
   * reader whose two subtitles agree perfectly while both are eight seconds
   * late has no use for that answer. Read out of the running log over 241
   * alignments: 141 were followed by a by-hand correction inside fifteen
   * minutes, and of the 629 corrections that followed one, 419 were on the
   * LEADING subtitle - the one Line up has nothing to say about, and the one
   * the snap deliberately refuses to touch.
   *
   * There is one reference for where the film's dialogue is and it is the
   * reader's ear. So this asks the only question they can answer: of the lines
   * near the playhead, which one did you just hear. `proposeAnchors` in
   * align.js has been written and tested since the aligner shipped and until
   * now had no caller anywhere.
   *
   * A list rather than "move so the nearest line starts now", because the
   * nearest line is only the right one when the subtitle is already close, and
   * a subtitle that is already close is not the one being fixed. The comment
   * beside proposeAnchors says the same thing from the other end.
   */
  let earSlot = 0;
  let earMoment = 0;

  function buildByEar() {
    const wrap = document.createElement("div");

    el.earNote = document.createElement("p");
    el.earNote.className = "sso-note";

    el.earList = document.createElement("div");
    el.earList.className = "sso-ear";

    wrap.append(el.earNote, el.earList);
    return wrap;
  }

  /* How much to move, said as the thing being done rather than as a number
   * with a sign. The reading on the card is where the subtitle ended up; this
   * is the step, and the two want different words. */
  function describeMove(ms) {
    const seconds = (Math.abs(ms) / 1000).toFixed(2).replace(/\.?0+$/, "");
    if (Math.abs(ms) < 10) return "already where you heard it";
    return ms > 0 ? `hold it back ${seconds}s` : `bring it forward ${seconds}s`;
  }

  async function openByEar(slot) {
    /* The moment is taken now, not when the reader picks. They are about to
     * read eight lines while the film runs on, and an offset measured from
     * when they finished reading would be out by however long that took. */
    const answer = await Promise.resolve(api.anchorChoices?.(slot));
    if (!answer?.choices?.length) {
      sayInPanel(slot, "No lines near the playhead to choose between", { warn: true });
      return;
    }
    earSlot = slot;
    earMoment = answer.atMs;
    el.earNote.textContent =
      "Pick the line you just heard. Everything else moves with it when this is the first subtitle.";
    el.earList.replaceChildren(
      ...answer.choices.map((choice) => {
        const row = document.createElement("button");
        row.type = "button";
        row.className = "sso-ear__line";

        const said = document.createElement("span");
        said.className = "sso-ear__said";
        said.textContent = (choice.text || "").replace(/\s+/g, " ").trim();

        const move = document.createElement("span");
        move.className = "sso-ear__move";
        move.textContent = describeMove(choice.moveMs);

        row.append(said, move);
        row.addEventListener("click", () => {
          /* The STEP, not the sum. The offset may be in another frame and may
           * have moved since this list was built - see the note on api.nudge. */
          api.nudge(choice.moveMs, { slot: earSlot, quiet: true, how: "anchor" });
          goRoot();
          sayInPanel(earSlot, `Lined up by ear · ${describeMove(choice.moveMs)}`);
          refresh(api.status());
        });
        return row;
      }),
    );
    goTo("ear");
  }

  /* Say something on one card, with at most one thing to do about it.
   *
   * Returns whether it took the message, because content.js offers every
   * slot-specific message here first and falls back to a toast when this
   * declines - which is what happens when the panel is shut, or folded, or on
   * another screen, and is the case the keyboard nudges live in.
   *
   * A message stands until something else happens to that card. `clearSaid`
   * below is what stops a stale answer sitting under a subtitle it is no longer
   * about. */
  /* How long a report stands before it takes itself away.
   *
   * A message left on screen until something else happens to the card is a
   * message that is still there ten minutes later, describing a nudge nobody
   * remembers making - reported as "keeping a message at the UI always is not a
   * good practice", and it is not: a permanent element that says something
   * temporary trains the reader to stop reading that spot. Long enough to be
   * read twice at a glance, and gone.
   *
   * A message carrying an offer does NOT expire. "These look 4.2s apart - use
   * it?" is a question waiting for an answer, and a question that withdraws
   * itself while being considered is worse than one never asked. */
  const SAID_MS = 6000;

  let saidTimer = null;
  let saidSlot = null;
  let saidAction = null;

  function sayInPanel(slot, text, { action = null, warn = false } = {}) {
    if (!el.status) return false;
    if (!isPanelVisible() || folded || atScreen !== "root") return false;
    clearTimeout(saidTimer);
    saidTimer = null;
    saidSlot = text ? slot : null;
    el.status.dataset.warn = warn ? "true" : "false";
    /* Which subtitle, kept out of the sentence. It was implicit while the
     * message sat on the card; on one shared line it has to be said, and a
     * number in its own box says it without every caller having to write "for
     * subtitle 2" into a string that is already a full sentence. */
    /* And dropped when the sentence already opens with it. Several messages
     * are written as "Subtitle 2 on - 1238 lines · TR", which with a number
     * beside them reads "2 Subtitle 2 on ...". The sentence is left alone
     * rather than trimmed: it is also the toast, where there is no chip to
     * carry the number. */
    const named = Number.isInteger(slot) && new RegExp(`^subtitle ${slot + 1}\\b`, "i").test(text || "");
    el.statusSlot.textContent = text && Number.isInteger(slot) && !named ? String(slot + 1) : "";
    el.statusSlot.hidden = !el.statusSlot.textContent;
    el.statusText.textContent = text || "";
    el.statusDo.hidden = !text || !action;
    el.statusDo.replaceChildren();
    saidAction = text && action ? action : null;
    if (saidAction) el.statusDo.textContent = saidAction.label;
    if (!text) return true;
    if (!action) saidTimer = setTimeout(() => clearSaid(slot), SAID_MS);
    return true;
  }

  /* Take the message away.
   *
   * A message is an answer to something the reader just did, so it stops being
   * true the moment they do something else. Without this, "these look 4.2s
   * apart - use it?" stood over a subtitle the reader had since detached and
   * re-filled, offering a shift measured against a file that is no longer
   * there. The slot is checked because the line is shared now: clearing what
   * happened to subtitle 1 must not wipe an offer standing about subtitle 2. */
  function clearSaid(slot) {
    if (!el.status) return;
    if (Number.isInteger(slot) && saidSlot !== null && saidSlot !== slot) return;
    clearTimeout(saidTimer);
    saidTimer = null;
    saidSlot = null;
    saidAction = null;
    el.statusSlot.textContent = "";
    el.statusSlot.hidden = true;
    el.statusText.textContent = "";
    el.statusDo.hidden = true;
    el.statusDo.replaceChildren();
    el.status.dataset.warn = "false";
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
    ear: "Which line did you hear?",
  };

  let atScreen = "root";

  function screen(...parts) {
    const node = document.createElement("div");
    node.className = "sso-screen";
    node.append(...parts);
    return node;
  }

  function goTo(name) {
    atScreen = name;
    for (const [key, node] of Object.entries(el.screens)) node.hidden = key !== name;
    el.back.hidden = name === "root";
    el.title.textContent = SCREEN_TITLES[name] || SCREEN_TITLES.root;
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
    /* The button that opens it closes it, the same rule the card's Aa follows.
     * Reported against Aa first and fixed there; the gear had the same defect
     * and the same fix, which is what makes it a rule rather than a patch. */
    if (settingsWindow?.isOpen()) {
      settingsWindow.hide();
      refresh(api.status());
      return;
    }
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
        buildSite(), buildWatching(), buildStudy(), buildAppearance(), buildKeys(),
        buildDiagnostics(),
      );
    }
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
  /* Style is a window, not a screen, and the difference is the subtitle.
   *
   * A screen replaces what the panel is showing, so changing how a subtitle
   * looks meant losing the list of subtitles - including the other one, which
   * is the whole reason a colour or a size is being changed at all. The two
   * want opposite treatments and the only way to judge one is against the
   * other. A window sits beside the panel and both stay on screen, which is
   * also what Settings needed and for the same reason.
   *
   * Built on first use and kept, so its size and place survive within a session
   * as well as between them. */
  let styleWindow = null;

  async function openStyle(slot) {
    const wanted = slot >= 0 && slot < api.trackCount ? slot : 0;
    /* The button that opened it closes it.
     *
     * A control that opens something and then does nothing when pressed again
     * is a control that has stopped answering, and the reader's next move is to
     * press it harder. Only when it is showing THIS subtitle: pressing Aa on
     * the other card while the window is open is a request to see that one, not
     * a request to close - so it switches rather than shutting, which is also
     * the only way to compare the two without a trip through the close button.
     */
    if (styleWindow?.isOpen() && styleSlot === wanted) {
      styleWindow.hide();
      refresh(api.status());
      return;
    }
    styleSlot = wanted;
    if (!styleWindow) {
      styleWindow = api.makeWindow({
        title: "Style",
        sheets,
        storeKey: "sso:panelStyleWindow",
        width: 340,
        height: 400,
        accent: "#4c8bf5",
        accentInk: "#93b9fb",
        onClose: () => refresh(api.status()),
      });
      styleWindow.body.append(buildStyle());
    }
    await styleWindow.show(host);
    refresh(api.status());
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


  /* Taking a subtitle off is the one destructive thing this panel does, and it
   * used to be a plain button next to Hide with no way back - a mis-click cost
   * the download, the timing and wherever the box had been dragged to. The
   * toast carries the undo; the card list carries it too, because a toast
   * button cannot be reached from the keyboard in fullscreen and this is the
   * surface that owns removal. */
  function removeTrack(slot) {
    const label = api.status().tracks[slot]?.label;
    // Its own card is about to be hidden, so this one stays a toast - there is
    // nowhere on the list for it to sit, and the undo row below carries it too.
    clearSaid(slot);
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
   * PAL stretch was announced as lined up and was seconds out by the end.
   *
   * A timing is now three things, and the third goes the same way. `steps` is
   * one offset per act, for the pairs where a broadcast episode's advertising
   * breaks fall in different places in the two releases - and dropping it does
   * the same thing the dropped rate did, on the 30% of pairs that have one. */
  const timingOf = (slot) => {
    const track = api.status().tracks[slot];
    return { offsetMs: track?.offsetMs ?? 0, rate: track?.rate ?? 1, steps: track?.steps ?? [] };
  };

  const applyTiming = (slot, { offsetMs, rate, steps }) => {
    /* Said, when it undoes a speed the reader set.
     *
     * The aligner's answer is about where this file sits against the OTHER
     * one; a speed the reader applied by hand is about this file against the
     * film. The pair relationship is what was just asked for, so the answer
     * wins - but it arrives as one number with no mention of the stretch it
     * takes out, and a reader who corrected a drift half an hour ago has no
     * way to connect the two. */
    const droppedRate = api.status().tracks[slot]?.rate !== 1 && (rate ?? 1) === 1;
    api.setRate(rate ?? 1, { slot, quiet: true });
    api.setSteps(steps ?? [], { slot });
    /* `byHand: false`, the same as the aligner's own apply path, and here it is
     * load-bearing rather than tidy. This offset says where THIS file has to
     * sit against the other one, so if the slot happens to be the leading
     * subtitle, carrying it to the follower would move the very subtitle it
     * was just measured against - and destroy the alignment being accepted. */
    api.setOffset(offsetMs ?? 0, { slot, quiet: true, byHand: false });
    return { droppedRate };
  };

  async function lineUp(slot) {
    const answer = await api.autoAlign?.(slot);
    if (!answer) {
      sayInPanel(slot, "Nothing to line this up against", { warn: true });
      return;
    }
    /* No Undo behind this any more.
     *
     * It was here for two reasons and neither survives. The first was the
     * reader's: a way back from something the machine decided. Reported as
     * unused - "I never use the undo functionality during sync" - and it is
     * easy to see why, because the way back from a timing you can see is wrong
     * is the map you are already looking at, three pixels the other way.
     *
     * The second was ours: `alignOutcome` recorded whether the answer was put
     * back, and the note beside it called that the only honest signal about
     * whether the aligner was right. That is no longer true. Every by-hand
     * correction now writes a `sync` line carrying where it was made, by how
     * much, and which line was on screen - so a correction arriving shortly
     * after an align says the same thing the Undo said, with the size of the
     * error attached, and says it for the readers who fixed it by hand instead
     * of pressing the button. `taken` is still recorded, because accepting an
     * offer is a decision and not an absence of one. */
    /* Naming the acts when there are any, because the number beside them is
     * the FIRST act's and the reader would otherwise check it against the last
     * one and conclude the tool had got it wrong. Also because it is the news:
     * "these two releases are cut differently and it has been handled" is a
     * thing worth being told once, and the correction the reader would
     * otherwise be making at every break is the thing it saves. */
    const lined = ({ droppedRate = false } = {}) => {
      const acts = answer.steps?.length ?? 1;
      const also = droppedRate ? " · speed back to the film's own" : "";
      sayInPanel(slot, acts > 1
        ? `Lined up in ${acts} acts · ${api.describeOffset(answer.offsetMs)} at the start${also}`
        : `Lined up · ${api.describeOffset(answer.offsetMs)}${also}`);
    };
    if (answer.verdict === "apply") {
      lined();
    } else if (answer.verdict === "offer") {
      /* Two reasons a subtitle is only offered, and they want different words.
       *
       * "thin" means the arithmetic was confident and the two files still only
       * agree about a fifth of their lines - which is what one language
       * subtitling scenes the other leaves to burned-in captions looks like
       * from in here, and is exactly where the number comes back wrong. Naming
       * it stops the reader reading "not sure" as "wrong film" and going to
       * download another release, which does not help. */
      const why = answer.reason === "thin"
        ? " The two files only agree about a fifth of their lines, so check it before taking it."
        : "";
      sayInPanel(slot, `These look ${api.describeOffset(answer.offsetMs)} apart.${why}`, {
        action: {
          label: "Use it",
          onClick: () => {
            const done = applyTiming(slot, {
              offsetMs: answer.offsetMs, rate: answer.trackRate, steps: answer.steps,
            });
            api.trace?.("alignOutcome", {
              slot, outcome: "taken", offsetMs: answer.offsetMs, acts: answer.steps?.length ?? 1,
            });
            lined(done);
            refresh(api.status());
          },
        },
      });
    } else {
      /* Say which kind of no it is, and say the number.
       *
       * "These do not look like the same film" was the only answer available
       * for two very different situations, and it was wrong about one of them.
       * Measured on this repo's own files: shift the Turkish subtitle by 185
       * seconds and the confidence falls from 476 to 4.33; by 240 seconds and it
       * reads 0.53 with a nonsense shift - because the search window is three
       * minutes wide and beyond it the aligner is not looking. A subtitle timed
       * with a recap the other file does not have is exactly that case, and the
       * reader was told they had downloaded the wrong programme.
       *
       * autoAlign now takes a second, wider look before giving up, and whatever
       * comes back is named rather than summarised - a reader who can see 0.4
       * knows it is hopeless, and one who can see "4m12s apart" knows it is not
       * the wrong film, it is a different cut. */
      const gap = Number.isFinite(answer.offsetMs)
        ? ` The closest fit is ${api.describeOffset(answer.offsetMs)}, which is too weak to trust (${answer.confidence}).`
        : ` (confidence ${answer.confidence})`;
      sayInPanel(
        slot,
        `No timing fits both files well enough to use.${gap} Drag the map to line them up by eye.`,
        { warn: true },
      );
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
      if (event.key === "Enter") api.detached(runSearch(el.query.value.trim()), "The search");
    });
    /* From here on the words are the reader's, and the next episode does not
     * get to replace them. An answer already on its way from the worker is
     * cancelled by the same stroke. */
    el.query.addEventListener("input", () => {
      queryFromPage = false;
      fillToken += 1;
    });

    const grow = document.createElement("div");
    grow.className = "sso-grow";
    grow.append(el.query);

    /* Not primary. The panel's one primary is the empty state's button, and the
     * empty state is on screen exactly when there is one obvious thing to do;
     * once a subtitle is attached this is an adjustment surface with no single
     * next action, and a filled blue button in it would be claiming otherwise.
     * Enter in the field runs the same search. */
    row.append(grow, button("Search", {
      onClick: () => api.detached(runSearch(el.query.value.trim()), "The search"),
    }));

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
      onClick: () => api.detached(tryBest(), "Trying the best three"),
      title: "Download the top three and keep whichever lines up best. Costs three downloads.",
    });
    el.tryBest.className = "sso-try";
    el.tryBest.hidden = true;

    /* The episode after the last one fetched for this show, as one click.
     *
     * A series page that does not say which episode is playing - Prime Video
     * plays one in place on the show's own page - comes back as "which one?",
     * and the answer was typed into the box: one evening of Monk was S01E01,
     * then S01E02, then S01E03, each by hand. The daemon now says which was
     * fetched last, and the click runs the same search the typing did. */
    el.tryNext = button("", {
      onClick: () => {
        if (!nextEpisode) return;
        el.query.value = nextEpisode.query;
        queryFromPage = false;
        api.detached(runSearch(nextEpisode.query), "Trying the next episode");
      },
      title: "Search for the episode after the last one fetched for this series.",
    });
    /* Its own class. It shares the try button's shape, and the harness finds
     * that button by `.sso-try` - so giving this one the same name put a
     * hidden button first in the tree and "nothing offered to try the best
     * three" failed on a page that was offering it. */
    el.tryNext.className = "sso-next";
    el.tryNext.hidden = true;

    /* A results list for a dual setup is mostly the wrong language: a search
     * for two languages returns both, and picking the Turkish one out of forty
     * English ones by reading tags is the slow part. The filter is built from
     * whatever the search actually returned rather than from a fixed list, so
     * it never offers a language with nothing behind it. */
    el.languageFilter = document.createElement("div");
    el.languageFilter.className = "sso-seg sso-seg--wrap";
    el.languageFilter.hidden = true;

    /* Column labels, on the same grid as the rows under them. Without them the
     * last column is a bare number, and a bare number in a subtitle list reads
     * as a file size; with them it is how many words the file has to say,
     * which is the whole reason it is there. Hidden until there is a list for
     * it to label. */
    el.resultsHead = document.createElement("div");
    el.resultsHead.className = "sso-results__head";
    el.resultsHead.hidden = true;
    for (const label of ["", "", "year", "dl", "words"]) {
      const cell = document.createElement("span");
      cell.textContent = label;
      el.resultsHead.append(cell);
    }

    el.results = document.createElement("ul");
    el.results.className = "sso-results";

    wrap.append(
      el.findFor,
      row,
      el.searchNote,
      el.tryNext,
      el.tryBest,
      el.languageFilter,
      el.resultsHead,
      el.results,
    );
    return wrap;
  }

  let languageChoice = "";

  /* The query the "next episode" button will run, or null. */
  let nextEpisode = null;

  function offerNextEpisode(response) {
    const next = response.next_episode;
    const last = response.last_episode;
    const series = response.used?.query || "";
    nextEpisode = null;
    if (!next || !last || !series) {
      el.tryNext.hidden = true;
      return;
    }
    const pad = (n) => String(n).padStart(2, "0");
    const label = `S${pad(next.season)}E${pad(next.episode)}`;
    nextEpisode = { query: `${series} ${label}`, label };
    el.tryNext.textContent = `Try ${label} \u00b7 last fetched S${pad(last.season)}E${pad(last.episode)}`;
    el.tryNext.hidden = false;
  }

  /* Which languages this programme has, when one that was asked for is not
   * among them.
   *
   * Two different answers hide behind an empty result list, and they have
   * different remedies: the search missed, or nobody has subtitled this in that
   * language. The title index knows which, it arrives with the search and it
   * costs nothing. "Not Suitable for Work" (2026) carries 13 languages and no
   * Turkish, on every episode of the series, so no amount of retyping the title
   * was ever going to produce one.
   *
   * Codes rather than names, because that is what the language filter beside it
   * shows and a second vocabulary for the same thing reads as two things. */
  function languageAbsenceNote(response) {
    const missing = response.missing_languages || [];
    const available = response.available_languages || [];
    if (!missing.length || !available.length) return "";
    const asked = missing.map((code) => code.toUpperCase()).join(", ");
    const head = available.slice(0, 6).map((code) => code.toUpperCase()).join(", ");
    const rest = available.length > 6 ? `, and ${available.length - 6} more` : "";
    return `No ${asked} subtitle for this title. OpenSubtitles has ${head}${rest}.`;
  }

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

  /* Put the page's own title in the box, unless somebody else got there
   * first. */
  function fillQueryFromPage() {
    const mine = ++fillToken;
    bestPageTitle().then(
      (title) => {
        if (mine !== fillToken || !title || !el.query) return;
        el.query.value = title;
        queryFromPage = true;
      },
      // Filling in the box is a convenience; failing to must not be an error.
      () => {},
    );
  }

  /* A different film is playing, so nothing on the Find screen is about it. */
  function forgetSearch(mark, { refill = false } = {}) {
    searchedFor = mark;
    lastResults = [];
    lastResolved = null;
    languageChoice = "";
    el.results?.replaceChildren();
    if (el.languageFilter) el.languageFilter.hidden = true;
    if (el.tryBest) el.tryBest.hidden = true;
    if (el.tryNext) el.tryNext.hidden = true;
    nextEpisode = null;
    if (el.searchNote) {
      el.searchNote.className = "sso-note";
      el.searchNote.textContent = "";
    }
    // Only what this file put there, and only while there is a screen to put
    // it on - the panel is refreshed whether it is open or shut, and asking
    // the worker for a title nobody is looking at is a round trip for nothing.
    if (refill && el.query && (queryFromPage || !el.query.value)) fillQueryFromPage();
  }

  async function runSearch(query) {
    el.results.replaceChildren();
    el.resultsHead.hidden = true;
    el.tryBest.hidden = true;
    el.tryNext.hidden = true;
    el.searchNote.className = "sso-note";
    el.searchNote.textContent = "Searching…";

    /* From the worker, not from this frame. The panel is injected into whichever
     * frame holds the video, and on an embedded player that frame can see
     * neither the page's metadata nor its episode list. */
    const context = (await api.daemon("pageContext", {})) || {};
    const response = await api.daemon("search", {
      query,
      title: query ? "" : context.title || document.title,
      /* The id the page stated, which the panel used to throw away.
       *
       * Auto-attach has always sent it and this screen never did, so the
       * moment a reader opened the list by hand the search fell back to
       * matching titles as text - and a title is language-specific where an id
       * is not. Reported as "searching for the English name finds far fewer
       * Turkish subtitles than searching the Turkish name". With an id there is
       * no name to get wrong.
       *
       * Sent even when the query was typed. Correcting a bad guess at the
       * TITLE does not make the page's id wrong, and the daemon falls through
       * to the title path when the id turns up nothing. */
      imdb_id: context.imdbId ?? undefined,
      // And the other names for it, for the page that has no id to give.
      altTitles: context.altTitles ?? undefined,
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
    searchedFor = api.status().programme ?? null;
    /* Nothing to choose between with one result, and nothing to choose FROM
     * with none. Both are cases where a button offering to try three would be
     * a button that cannot do what it says. */
    el.tryBest.hidden = lastResults.length < 2;
    offerNextEpisode(response);
    const absence = languageAbsenceNote(response);
    if (lastResults.length === 0) {
      el.searchNote.className = "sso-note sso-note--warn";
      /* "Try a different title" was the wrong instruction for the case that
       * brought this up: the title was right and the subtitle does not exist.
       * Sending the reader back to retype a correct title is worse than saying
       * nothing, because it looks like something they can fix. */
      el.searchNote.textContent = absence || "Nothing found. Try a different title.";
      return;
    }

    el.searchNote.className = response.low_confidence ? "sso-note sso-note--warn" : "sso-note";
    const headline = response.low_confidence
      ? "Nothing matched well. These are guesses — check before attaching."
      : `${lastResults.length} result${lastResults.length === 1 ? "" : "s"}`;
    el.searchNote.textContent = absence ? `${headline} ${absence}` : headline;

    lastThreshold = response.auto_attach_threshold ?? 0.75;
    languageChoice = "";
    renderLanguageFilter(lastResults);
    renderResults(lastResults, lastThreshold);
  }

  let lastThreshold = 0.75;

  /* A count in the room a column has. 12400 -> "12.4k". */
  function compact(number) {
    if (!Number.isFinite(number) || number <= 0) return "";
    if (number < 1000) return String(number);
    if (number < 10000) return `${(number / 1000).toFixed(1)}k`;
    return `${Math.round(number / 1000)}k`;
  }

  function resultCell(className, text, title = "") {
    const span = document.createElement("span");
    span.className = className;
    span.textContent = text;
    if (title) span.title = title;
    return span;
  }

  /* One row per upload, one column per field.
   *
   * It was a language chip and the film's NAME on one line - the same name on
   * every row, because they are all uploads of the one film - and then a
   * joined string of "release · year · N dl" underneath. So the thing that
   * actually tells two rows apart was in the small grey line, and every number
   * started at a different x. Reported as both: "it would be better to see
   * more data", and "the same type of data in rows, aligned vertically so I
   * can scan top-down".
   *
   * The release leads now, because it is what identifies the file. The film's
   * name is in the hover text, where a name that is the same on every row
   * belongs.
   *
   * `words` is the field the reader asked for and the only honest way to
   * answer "is this one any richer": measured for a file already on disk, and
   * blank otherwise, because measuring one costs a metered download. The three
   * flags below are what a search result can say about the same question
   * before it is downloaded - and "foreign parts" is the loudest of them, since
   * it means the upload carries only the lines spoken in another language.
   */
  function renderResults(results, threshold) {
    const shown = languageChoice
      ? results.filter((result) => (result.language || "").toLowerCase() === languageChoice)
      : results;

    el.resultsHead.hidden = shown.length === 0;
    el.results.replaceChildren(
      ...shown.slice(0, 30).map((result) => {
        const item = document.createElement("li");
        const b = document.createElement("button");
        b.type = "button";
        b.className = "sso-result";

        const name = result.release || result.movie_name || "Untitled";
        b.append(
          resultCell("sso-result__lang", (result.language || "??").toUpperCase()),
          resultCell(
            "sso-result__name",
            name,
            [result.movie_name, result.release].filter(Boolean).join(" — ") || name,
          ),
          resultCell("sso-result__year", result.year ? String(result.year) : "·"),
          resultCell(
            "sso-result__dl",
            compact(result.download_count) || "·",
            `${result.download_count || 0} downloads`,
          ),
          resultCell(
            "sso-result__words",
            compact(result.words) || "·",
            result.words
              ? `${result.words} words over ${result.lines} lines`
              : "Counted once a subtitle is on disk. Measuring one costs a download, and the downloads are what you are choosing between.",
          ),
        );

        const flags = document.createElement("span");
        flags.className = "sso-result__flags";
        if (!result.identified && result.match_score != null && result.match_score < threshold) {
          flags.append(tag("weak match", "sso-tag--weak"));
        }
        if (result.cached) flags.append(tag("on disk", "sso-tag--free"));
        if (result.foreign_parts_only) {
          const chip = tag("foreign parts", "sso-tag--weak");
          chip.title = "Only the lines spoken in another language, not the whole film.";
          flags.append(chip);
        }
        if (result.ai_translated) flags.append(tag("AI", "sso-tag--weak"));
        else if (result.machine_translated) flags.append(tag("machine", "sso-tag--weak"));
        if (result.hearing_impaired) flags.append(tag("HI"));
        /* Only with enough votes behind it to be a claim. A single 10 and a 9
         * from four hundred people are not the same statement, and the panel
         * has no room to print both numbers. */
        if (result.ratings && result.votes >= 3) {
          flags.append(tag(`★ ${result.ratings.toFixed(1)}`, ""));
        }
        b.append(flags);

        b.addEventListener("click", () => api.detached(attachResult(result), "That subtitle"));
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

    /* Re-enabled in a finally, not after the loop.
     *
     * Anything thrown between the two assignments left the button disabled for
     * the life of the panel, with no way back short of closing and reopening
     * it - a control that has permanently stopped working because one download
     * went wrong. runDiagnostic already had this shape and these two did not. */
    el.tryBest.disabled = true;
    el.searchNote.className = "sso-note";
    const tried = [];
    const failed = [];
    try {
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
        /* Mark the row while the file is in hand.
         *
         * This already spends the downloads; measuring what came back costs
         * nothing on top, and it is the only way a reader gets a word count
         * for a subtitle they have not chosen yet. Whichever one wins, the two
         * that lose stay in the list with their numbers on them - which is
         * exactly the comparison "the richer one" needs. */
        result.lines = response.meta?.cue_count ?? response.cues.length;
        result.words = response.meta?.words ?? null;
      }
    } finally {
      el.tryBest.disabled = false;
      renderResults(lastResults, lastThreshold);
    }
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
  /* The way back to study's settings.
   *
   * They used to be eleven controls in this window, and they moved to the focus
   * box on the principle that settings belong on the thing they change. What
   * that missed is the box's own close button, which puts it away with study
   * still running - so one press took every threshold out of reach and the way
   * back was to turn study off and on again. Reported as "I remember that we
   * had some settings regarding how rare words should be shown, but I could not
   * find those settings any more. I think they are gone with the study pane
   * itself."
   *
   * A pointer rather than a second copy of the controls. Two surfaces holding
   * the same sliders is how they drift; this opens the one window there is, and
   * the reader who looked for settings in the settings window finds them. */
  function buildStudy() {
    const wrap = section("Study");

    const note = document.createElement("p");
    note.className = "sso-note";
    note.textContent =
      "What counts as a rare word, which phrasal verbs are marked, how many a line, " +
      "and what the focus box looks like. The same window opens from the gear on the " +
      "box itself.";

    const row = document.createElement("div");
    row.className = "sso-row";
    row.append(
      button("How study works", {
        title: "Open study's own settings - the thresholds are yours, not this subtitle's",
        onClick: () => api.openStudySettings(),
      }),
    );

    /* Hidden when study.js is not loaded at all, which is the one state where
     * there is no window to open. Not hidden when study is merely switched off:
     * the thresholds are what the reader wants to look at BEFORE turning it on
     * again, and a row that disappears in that state is the same defect this
     * section exists to fix. */
    el.studySection = wrap;
    wrap.hidden = !api.studySettings();

    wrap.append(note, row);
    return wrap;
  }

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
      "then opens the result. No downloads are spent. The same page holds the running " +
      "log, which is written as you go and keeps every attempt to line two subtitles up.";

    /* The switch, on this screen rather than buried in the settings window,
     * because this is the screen that explains what it turns off. */
    el.diagnostics = toggle_(
      "Keep a running log",
      api.status().settings.diagnostics !== false,
      (on) => api.updateSettings({ diagnostics: on }),
    );
    el.diagnostics.row.title =
      "Records what each frame looks like, every attempt to line two subtitles up, " +
      "and every error - to the daemon if it is running, otherwise held in the browser. " +
      "Nothing is sent anywhere. Turn it off and nothing is recorded at all.";

    const row = document.createElement("div");
    row.className = "sso-row";
    el.diagnose = button("Diagnose this page", {
      primary: true,
      onClick: () => api.detached(runDiagnostic(), "The capture"),
    });
    /* The log is worth reaching without capturing anything, and on a page that
     * has never had a capture taken - which is most of them. It has been
     * filling since the first time this panel was opened. */
    row.append(
      el.diagnose,
      button("Open the log", {
        title: "What the extension has recorded while you were using it, including every attempt to line two subtitles up",
        onClick: () =>
          api.detached(api.toWorker({ type: "sso:openReport" }), "The log"),
      }),
    );

    el.diagnoseNote = document.createElement("p");
    el.diagnoseNote.className = "sso-note";

    wrap.append(note, el.diagnostics.row, row, el.diagnoseNote);
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
      await api.toWorker({ type: "sso:openReport" });
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
        api.writeStored({ [POSITION_KEY]: { left: host.style.left, top: host.style.top } }),
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
      const stored = await api.readStored(POSITION_KEY);
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
  /* What the panel's height depends on. Anything not in here cannot change how
   * tall the panel wants to be, so it cannot need a re-fit. */
  let fittedFor = "";

  function refresh(status) {
    if (!host) return;
    /* The film can change without a page load, and when it does the Find
     * screen is answering about the last one. See searchedFor.
     *
     * A programme that was UNKNOWN and is now known is not a different
     * programme, though: it is the same one, described. The mark is empty
     * until a page announces itself or its video reports a length over a
     * minute, and until then a search is filed against "". Reproduced in the
     * harness: search, one result on screen, then the page sets
     * data-sso-now-playing - the mark goes from "" to the episode and the
     * result list empties under the reader, about a second after they asked
     * for it. What was learned is written down instead, so the next real
     * change is still caught. */
    const playing = status.programme ?? null;
    if (playing !== searchedFor) {
      if (searchedFor) forgetSearch(playing, { refill: isPanelVisible() });
      else searchedFor = playing;
    }
    const settings = status.settings;
    const showing = (name) => atScreen === name;
    /* Attaching a second subtitle adds a whole card, so the panel gets taller
     * while it is open, and it has to be re-fitted when that happens.
     *
     * WHEN THAT HAPPENS, and not on every status round. refresh() runs on every
     * notify - measured at 20 a second while a film plays, because the tick is
     * 50ms - and fitToViewport reads two getBoundingClientRects and then writes
     * a height, which is a forced layout each time. Measured on the frames
     * vehicle with two 1100-cue subtitles attached and the film playing: the
     * page did 3.3 layouts a second with the panel shut and 36 with it open.
     * Nothing about a nudged offset or a moved playhead changes how tall the
     * panel is. */
    const shape = [
      status.trackCount, status.attached, atScreen, folded,
      Boolean(api.removedTrack?.()), status.hasVideo,
      status.trackCount >= api.trackCount, Boolean(status.inAd || status.adDriftMs),
    ].join("|");
    if (shape !== fittedFor) {
      fittedFor = shape;
      queueMicrotask(fitToViewport);
    }

    const gone = api.removedTrack?.();
    el.undoRow.hidden = !gone;
    if (gone) {
      el.undoLabel.textContent = `Subtitle ${gone.slot + 1} removed${gone.label ? ` · ${gone.label}` : ""}`;
    }

    /* One statement of absence at a time. With something to put back, "no
     * subtitle attached - go and search for one" answers a question the reader
     * did not ask; the useful thing is the way back, and it stands down on its
     * own after half a minute. */
    const emptyState = !status.attached && !gone;
    el.none.hidden = !emptyState;
    el.noneTitle.textContent = status.hasVideo ? "No subtitle attached" : "No video on this page";
    el.noneNote.textContent = status.hasVideo
      ? "Search for the film or series and pick a result — it goes straight onto the video."
      : "Open something that plays, then come back.";
    el.noneAction.hidden = !status.hasVideo;
    /* Both slots full means the plus has nowhere to put anything; replacing one
     * is what a double-click on a card's name is for.
     *
     * Otherwise it shows whenever the empty state above is not showing, and
     * that INCLUDES having nothing attached. It used to be hidden on
     * `!status.attached`, which is the same condition the empty state stands
     * down on for the undo row - so taking off the last subtitle left a panel
     * holding one row, an Undo, and no way at all to add a subtitle for the
     * next thirty seconds. Reported as "how am I supposed to add new subtitles
     * in that state". */
    el.add.hidden = emptyState || status.trackCount >= api.trackCount;

    // In the title bar, so it is drawn whether or not the body is showing -
    // being visible while folded is the whole point of it.
    el.preview.draw(status);

    /* The shared row. Nothing attached means nothing to arrange, and the empty
     * state below owns that screen on its own. */
    el.quick.hidden = !status.attached;
    el.arrangeGroup.hidden = status.trackCount < 2;
    el.moveButton.textContent = status.placing ? "Done" : "Place";
    el.moveButton.dataset.on = status.placing ? "true" : "false";
    // One subtitle has nothing to agree with.
    el.lineUpAll.hidden = status.trackCount < 2;
    /* What each playback button is bound to, on the button. Cleared rather
     * than reading "off", because a button whose binding is unset has no
     * shortcut to advertise and "off" beside a working control invites the
     * reading that the control is off. */
    for (const step of el.steps) {
      const key = settings.keysEnabled ? settings.keys[step.key] : "";
      step.hint.textContent = key ? describeKey(key) : "";
      step.hint.hidden = !key;
    }
    el.moveButton.title = status.placing
      ? "Drag the stand-in to where the subtitle should be, then press Done — hold Alt to place it freely"
      : "Drag a subtitle around the picture: the middle moves it, an edge makes it wider — hold Alt to place it freely";

    // A toggle has to look like one while it is holding something open, or the
    // second press is a guess.
    const settingsOpen = Boolean(settingsWindow?.isOpen());
    el.gear.dataset.on = settingsOpen ? "true" : "false";
    el.gear.setAttribute("aria-pressed", settingsOpen ? "true" : "false");
    el.gear.title = settingsOpen ? "Close the settings" : "Settings";

    status.tracks.forEach((track, slot) => {
      const card = el.trackCards[slot];
      /* An empty track's card is not shown at all. A second set of controls
       * that do nothing is worse than no second set: it says the feature is
       * broken rather than unused. */
      card.root.hidden = !track.attached;
      if (!track.attached) return;

      /* The language comes off the front of the name rather than being printed
       * twice. attach() builds the label as "EN · release", which was written
       * when the language had nowhere else to go; it has its own element now,
       * so the copy inside the name is a repeat in a line with no room for
       * one. */
      const language = (track.language || "").toUpperCase();
      let name = track.label || "Attached";
      if (language && name.toUpperCase().startsWith(`${language} · `)) {
        name = name.slice(language.length + 3);
      }
      const [head, tail] = splitName(name);
      card.labelNo.textContent = String(slot + 1);
      card.labelLang.textContent = language;
      card.labelLang.hidden = !language;
      card.labelHead.textContent = head;
      card.labelTail.textContent = tail;
      // Release names are long and the controls beside them are not optional,
      // so the name is often an ellipsis. Hovering it says the whole thing -
      // and says how a different file is asked for, which is the one verb on
      // this card with no writing anywhere to announce it.
      card.label.title = `${track.label || "Attached"}\n\nDouble-click to choose a different subtitle`;
      /* Selected, which is what the keys act on. Marked on the card itself
       * rather than by a chip inside it: the whole card is the thing being
       * chosen, and a border says so without spending any of the title's room
       * on saying it. Only meaningful with two subtitles - with one there is
       * nothing to choose between, and a card lit up as "the selected one"
       * would be answering a question nobody asked. */
      const study = api.studySettings();
      const learning = Boolean(study?.studySlots?.includes(slot));
      const selected = status.trackCount > 1 && status.keyTrack === slot;
      card.root.dataset.selected = selected ? "true" : "false";
      card.root.setAttribute("aria-label", `Subtitle ${slot + 1}${track.label ? ` - ${track.label}` : ""}`);
      card.label.setAttribute("aria-pressed", selected ? "true" : "false");
      /* The name is never disabled, whatever is attached.
       *
       * It was disabled below two subtitles, on the argument that with one
       * there is nothing to choose between. That is true of the SELECTION a
       * single click makes, and false of the double click, which asks for a
       * DIFFERENT FILE - and which is the only way left to ask for one, since
       * the menu that used to hold Replace was taken apart. A disabled button
       * dispatches neither click nor dblclick, so on the ordinary panel, the
       * one with a single subtitle on it, the name did nothing at all.
       * Reported as "I'm supposed to be able to change the subtitle by
       * clicking or double-clicking the title, but it doesn't work now". */
      /* Two subtitles is what makes either gesture mean anything: with one
       * there is nothing to choose between and nowhere to move it to. */
      const movable = status.trackCount > 1;
      card.root.dataset.movable = movable ? "true" : "false";
      card.root.title = !movable
        ? ""
        : status.keyTrack === slot
          ? "Drag this card to change its number - the place and the style stay with the number"
          : "Click to point the keys and the study rail at this subtitle, or drag it to change its number";
      /* A toggle has to look like one while it is holding something open, or
       * the second press is a guess. Only the card whose subtitle the window is
       * actually showing is lit - the other card's Aa switches to that one. */
      const styling = Boolean(styleWindow?.isOpen()) && styleSlot === slot;
      card.styleButton.dataset.on = styling ? "true" : "false";
      card.styleButton.setAttribute("aria-pressed", styling ? "true" : "false");
      card.styleButton.title = styling ? "Close the style window" : "Colour, font, size, outline";

      card.learnChip.dataset.on = learning ? "true" : "false";
      /* "learning" is a state and "learn" is an invitation. The chip carried
       * the state's word in both positions, so an off switch read as a label
       * saying this subtitle was being studied when it was not. Which of the
       * two shows is decided by data-on in the stylesheet, because both of them
       * are in the button and the other one is holding the width. */
      /* On every attached subtitle, whether or not study mode is running.
       *
       * It used to need `study.enabled` AND a second subtitle, which hid it in
       * both of the states it is reached for: study off, where it is the way to
       * turn study on, and one subtitle, where it is the only mark saying that
       * subtitle is the one being learnt. All that is left is study.js having
       * loaded at all - with no study there is nothing to switch. */
      card.learnChip.hidden = !study;
      card.learnChip.title = learning
        ? "Study is marking the rare words in this subtitle — click to stop"
        : study?.enabled
          ? "Click to study this subtitle too"
          : "Mark the rare words in this subtitle and show what they mean";
      card.learnChip.setAttribute("aria-pressed", learning ? "true" : "false");
      /* What this subtitle is measured against decides the verb. The leading
       * one - and a lone one, which leads nothing - is measured against the
       * picture, and only the reader can say where that is. */
      const byEar = status.leadSlot === null || status.leadSlot === slot;
      card.lineUpButton.textContent = byEar ? "By ear" : "Line up";
      card.lineUpButton.title = byEar
        ? "Say which line you just heard, and this moves to match the picture"
        : "Work out the gap from where the two subtitles say the same things";
      /* What this file's own corrections say about its speed. It is a
       * measurement and it stands while it holds, so this is the reader's way
       * back to the offer the toast made once and took away. */
      card.drift.hidden = !track.drift;
      if (track.drift) {
        const way = track.drift.fast ? "fast" : "slow";
        card.driftSaid.textContent = track.drift.named
          ? `Running ${track.drift.percent}% ${way} · a framerate mismatch, not a delay`
          : `Drifting ${track.drift.percent}% ${way} · about ${Math.round(track.drift.byMs / 1000)}s out by the end`;
      }
      const stretched = track.rate && track.rate !== 1;
      const acts = track.steps?.length ?? 0;
      card.offsetField.dataset.set = track.offsetMs ? "true" : "false";
      // Not while it is being typed into, or the value rewrites itself under
      // the cursor between keystrokes.
      if (shadow.activeElement !== card.offsetField) {
        card.offsetField.value = offsetSeconds(track.offsetMs);
      }
      /* The reading is this subtitle's BASE offset, and when the file has been
       * cut into acts that is not the offset in force right now - the last act
       * of a broadcast episode can be thirty seconds further out than the
       * first. Nudging still moves the base and the acts travel with it, so
       * the number is the right one to show and edit; what would be wrong is
       * showing it with nothing saying the rest exists. The title says it, on
       * the control the number is in. */
      /* And the other thing the number does not say by itself: whether moving
       * it moves the other subtitle too. The first one attached is where the
       * FILM's dialogue is, so a correction to it is true of everything on
       * screen; the rest are each positioned against it and move alone. */
      const leads = status.leadSlot === slot;
      const carries = leads
        ? " Moving this one moves the other with it - it is the first subtitle,"
          + " so where it sits is where the film's dialogue is."
        : status.leadSlot !== null
          ? " Moving this one moves only this one."
          : "";
      card.offsetField.title = (acts > 1
        ? `Seconds, for the whole subtitle. This file is lined up in ${acts} acts - `
          + `the advertising breaks fall in different places in the two releases - `
          + `and nudging moves all of them together.`
        : "Seconds. Negative brings the subtitle forward.") + carries;
      /* A hidden subtitle says so on its card. The menu item it was toggled
       * from is not on screen to carry the state, and a subtitle that has
       * vanished from the picture with nothing in the panel saying why is the
       * kind of thing that reads as a bug. */
      card.root.dataset.hidden = track.visible ? "false" : "true";
      card.visible.title = track.visible ? "Take it off the picture" : "Put it back on the picture";
      card.visible.setAttribute("aria-label", card.visible.title);
      card.visible.dataset.on = track.visible ? "true" : "false";
      // Nothing to undo, no undo. Which is also when the subtitle is right.
      // Acts count: clearing them is part of "back to the file's own timing",
      // so a subtitle that has only been cut into acts still has something to
      // clear even with its base offset at zero.
      /* Kept in the layout when there is nothing to clear, rather than taken
       * out of it. It sits between the timing field and the learn chip in a
       * right-aligned group, so removing it slid the field sideways the moment
       * a subtitle came back to its own timing - which is exactly when the
       * reader is watching that number. */
      card.offsetReset.dataset.idle =
        !track.offsetMs && !stretched && acts < 2 ? "true" : "false";
      /* A message is an answer about the subtitle that was in this card. When a
       * different one arrives the answer is about a file that is no longer
       * there, so it goes rather than sitting under its replacement. */
      if (card.saidFor !== track.fileId) {
        if (card.saidFor !== undefined) clearSaid(slot);
        card.saidFor = track.fileId;
        /* And an armed Remove is about the subtitle that was in this card. A
         * different one arriving under a button already asking "Remove?" is the
         * one way this control could take something nobody offered it. */
        card.disarm();
      }
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

    if (styleWindow?.isOpen()) {
      const look = settings.tracks[styleSlot];
      const track = status.tracks[styleSlot];
      /* Which subtitle this is about, on the window's own bar. It has to be
       * there: the window is beside the panel rather than instead of it, so
       * two of them can be open at once and neither would otherwise say which
       * subtitle it changes. */
      styleWindow.setTitle(
        track?.attached
          ? `Style · subtitle ${styleSlot + 1}`
          : "Style",
      );
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
    }

    // The settings are their own window now, so what decides whether they are
    // worth redrawing is whether that window is open - not which screen the
    // panel happens to be showing.
    if (!settingsWindow?.isOpen()) return;

    el.pauseAtLineEnd.input.checked = Boolean(settings.pauseAtLineEnd);
    /* Study can arrive after this window was built - the frame holding the cue
     * text loads it when a subtitle attaches - so the section is asked again on
     * every redraw rather than only at build time. */
    if (el.studySection) el.studySection.hidden = !api.studySettings();
    el.background.input.value = String(settings.background);
    el.background.readout.textContent = String(settings.background);
    el.rewrap.input.checked = Boolean(settings.rewrap);
    el.showSymbols.input.checked = Boolean(settings.showSymbols);
    el.dimNonSpeech.input.checked = Boolean(settings.dimNonSpeech);

    el.keysEnabled.input.checked = Boolean(settings.keysEnabled);
    // Default on, so an installation that predates the setting reads as on
    // rather than as a switch somebody turned off.
    if (el.diagnostics) el.diagnostics.input.checked = settings.diagnostics !== false;
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
      if (!isPanelVisible()) return;
      const status = api.status();
      /* The head's picture is drawn ahead of every guard below, because it is
       * in the title bar precisely so that it survives a fold, and a mark that
       * stops moving the moment the panel is folded away says nothing at all.
       * It is also on every screen - the head does not change when the body
       * goes to search or settings - so `atScreen` must not gate it either. */
      el.preview.draw(status);
      if (folded || atScreen !== "root") return;
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

  /* One build, however many presses arrive during it.
   *
   * build() assigns `host` in its first statement and then awaits its
   * stylesheets, so a second press inside that window found a host whose shadow
   * root was still empty, skipped the build, and went on to reparent it, reveal
   * it and refresh it - and refresh reaches for el.trackCards, which a
   * half-built panel does not have. A single flight that every caller awaits is
   * the whole fix, and it is the same shape study.js needs for its rail. */
  let starting = null;

  async function show() {
    if (!host) {
      starting ||= build()
        .then(() => restorePosition())
        .finally(() => { starting = null; });
      await starting;
    }
    reparent();
    startPlayhead();
    setHostVisible(host, true);
    /* Every frame's account of itself, at the moment somebody reached for the
     * controls. This is the cheapest possible answer to "what does that page
     * actually look like" and it costs nothing but a message - no search, no
     * download. See trace.js. */
    api.trace?.("panel", { open: true }, { frames: true });
    /* Timed, because a freeze reported against the map had no number behind
     * it. content.js counts long tasks and its own two hot paths; the panel
     * runs in the same world and cost nothing anything could see, so a window
     * full of long tasks looked the same whether this was drawing or the page
     * was. See notePerf and the note above PERF_ZERO. */
    unsubscribe ||= api.subscribe((status) => {
      const started = performance.now();
      refresh(status);
      api.notePerf?.("panels", 1);
      api.notePerf?.("panelMs", performance.now() - started);
    });
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
    /* Asynchronous now that it crosses to the worker, so it fills in a moment
     * after the panel appears rather than holding it up.
     *
     * Ours to refresh, theirs to leave alone: a title this file guessed is
     * re-guessed for whatever is playing now, and words a person typed stay
     * where they typed them. It used to fill only an EMPTY box, which is why a
     * panel reopened on the next episode still named the last one. */
    if (!el.query.value || queryFromPage) fillQueryFromPage();
  }

  function hide() {
    stopPlayhead();
    /* Only when there was something to close.
     *
     * hide() is called on every frame-role change, and setFrameRole("solo")
     * fires whenever the mirror has been quiet for three seconds - which a
     * BACKGROUND tab produces on a timer, because its intervals are clamped to
     * one a minute and the push cannot beat its own silence check. Each of
     * those shipped a full cross-frame diagnostic: a message to every frame and
     * 13.5KB to the daemon, for a panel that was already shut.
     *
     * Measured in one day's log: 741 panel captures totalling 10.2MB, of which
     * 708 said open:false, at a median 60.1s apart - the background clamp. */
    if (isPanelVisible()) api.trace?.("panel", { open: false }, { frames: true });
    // A binding half-read is not a binding; the button that asked is going.
    api.cancelCapture();
    // Every window this panel opened goes with it. They are separate hosts, so
    // hiding the panel does not hide them, and one left behind is a Style
    // window floating over a film with nothing to close it from.
    settingsWindow?.hide();
    styleWindow?.hide();
    if (host) setHostVisible(host, false);
    if (unsubscribe) {
      unsubscribe();
      unsubscribe = null;
    }
  }

  const toggle = () => (isPanelVisible() ? hide() : show());

  /* Where the panel was last put, so a reparent that moves nothing costs
   * nothing.
   *
   * rescale removes a transform and then reads getBoundingClientRect: a write
   * followed by a read, which is a forced layout every time it runs. content.js
   * calls reparent from tick(), twenty times a second, and again on every
   * pointer event - and on all but a handful of those the panel is exactly
   * where it already was. Measured on the nested player vehicle with two
   * subtitles attached and the mouse still: 11.4 layouts a second with the
   * panel open against 0.8 with it shut.
   *
   * The scale only changes when the panel moves into or out of a scaled
   * container, which is precisely what this records - plus a viewport resize,
   * which is handled where clampIntoView is. */
  const TOP_LAYER = "top layer";
  let placedIn = null;
  // The host too, so a torn-down and rebuilt panel is measured again rather
  // than inheriting the previous one's placement. See the copy in study.js.
  let placedHost = null;
  const settle = (where) => {
    if (placedIn === where && placedHost === host) return;
    placedIn = where;
    placedHost = host;
    rescale();
  };

  /* Follows the overlay into the fullscreen element, since only that subtree
   * is rendered while fullscreen is active. */
  function reparent(parent, { raise = false } = {}) {
    if (!host) return;
    /* Outside fullscreen the top layer is the right answer and nothing moves:
     * it keeps the panel above chrome a player appends to itself continuously.
     *
     * Inside fullscreen it is not enough. The browser hit-tests only within the
     * fullscreen element's subtree, so a panel promoted to the top layer is
     * painted over the film and receives none of the presses aimed at it - the
     * player does. `parent` is the element content.js has established can hold
     * us, having switched the fullscreen element away from the <video> if that
     * is what the site fullscreened. See fullscreenHolder there. */
    if (!parent && api.toTopLayer?.(host, { again: raise })) {
      settle(TOP_LAYER);
      return;
    }
    api.fromTopLayer?.(host);
    const target = parent || api.paintableParent?.() || document.body || document.documentElement;
    if (target && host.parentElement !== target) target.appendChild(host);
    // The fullscreen element may be scaled; what we have just moved into
    // decides how big the panel renders and where a written position lands.
    settle(target);
  }

  /* The other way the scale can change without the panel moving: the container
   * it is inside is sized against the viewport. reparent no longer re-measures
   * on every call, so this is where a resize is answered. */
  window.addEventListener("resize", () => { rescale(); clampIntoView(); }, { passive: true });

  /* applySize is exported for the harness, which measures the sync row at both
   * ends of the width the corner grips allow. Driving the grips with synthetic
   * pointer events to get there would be testing the grips, not the row. */
  /* sayInPanel is exported because content.js offers every slot-specific
   * message to it before falling back to a toast. See showToast there. */
  /* isOpen is for samplePerf in content.js, which reports whether the panel was
   * up in the window it is describing. Boolean(window.__ssoPanel) cannot answer
   * that - panel.js runs in every frame and defines this global whether or not
   * anything is on screen, so the first version of that field said true
   * everywhere and would have made "panel open" impossible to correlate with. */
  window.__ssoPanel = { show, hide, toggle, reparent, rescale, applySize, sayInPanel, isOpen: isPanelVisible };

  window.__ssoPanelTeardown = () => {
    // Both live on hosts outside this shadow tree, so removing the panel does
    // not remove them.
    stopPlayhead();
    settingsWindow?.destroy();
    settingsWindow = null;
    styleWindow?.destroy();
    styleWindow = null;
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
