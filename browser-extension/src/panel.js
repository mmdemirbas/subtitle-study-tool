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
    body.append(
      buildTracks(),
      buildSearch(),
      buildArrangement(),
      buildAppearance(),
      buildStudy(),
      buildKeys(),
      buildDiagnostics(),
    );

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

    const offsets = document.createElement("div");
    offsets.className = "sso-row";
    const offsetValue = document.createElement("span");
    offsetValue.className = "sso-offset";
    offsetValue.textContent = "0s";
    offsets.append(
      button("−1s", { onClick: () => api.nudge(-1000, { slot }), title: "1s earlier" }),
      button("−¼", { onClick: () => api.nudge(-250, { slot }) }),
      offsetValue,
      button("+¼", { onClick: () => api.nudge(250, { slot }) }),
      button("+1s", { onClick: () => api.nudge(1000, { slot }), title: "1s later" }),
      button("Reset", { onClick: () => api.setOffset(0, { slot }) }),
    );

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

    root.append(head, offsets, size.row, width.row, actions);
    return { root, keyed, label, offsetValue, size, width, visible };
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

    const info = api.pageInfo();
    const response = await api.daemon("search", {
      query,
      title: query ? "" : (info.candidates[0]?.text || document.title),
      year: info.year ?? undefined,
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

  function bestPageTitle() {
    const info = api.pageInfo();
    return info.candidates[0]?.text || document.title;
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

      card.label.textContent = `${slot + 1}. ${track.label || "Attached"} · ${track.cueCount} lines`;
      card.keyed.checked = status.keyTrack === slot;
      // With one subtitle there is nothing for the keys to be ambiguous about.
      card.keyed.hidden = status.trackCount < 2;
      card.offsetValue.textContent = api.formatOffset(track.offsetMs);
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
