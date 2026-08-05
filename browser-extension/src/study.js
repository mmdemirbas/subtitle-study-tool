/* Study mode: the words in the line you just heard that you probably don't know.
 *
 * The premise is that watching a film in a language you are learning already
 * does the hard part - you are attending to real speech, in context, for two
 * hours, voluntarily. What it does not do is tell you which of the words that
 * went past were the ones worth keeping, and it gives you no way to keep one
 * without stopping the film and losing the thread.
 *
 * So this does two things and deliberately not more. It marks the words in the
 * current line that are rare in film dialogue, and it puts them in a column at
 * the side with their meaning as the film runs, without the mouse being touched
 * at all. One key saves the one at the top, with the line it was in.
 *
 * ---
 *
 * It runs as a third content script rather than inside content.js, with its own
 * shadow root, for the same reason the panel does: it is optional, it is off by
 * default, and nothing about the subtitle overlay should get slower or more
 * complicated for someone who never turns it on. content.js knows about it
 * through three optional calls (`onCue`, `claimPointerDown`, `reparent`), each
 * of which does nothing when this file is absent.
 *
 * The one thing it must not do is take gestures the film needs. The rules:
 *
 *   hover a word          look it up            (no click - the film is playing)
 *   click a word          pin it, stop the fade
 *   click anywhere else   pause, exactly as before
 *   drag                  move the subtitle, exactly as before
 *   shift-drag over words select a phrase
 *
 * Only the first two are new, and both are on individual words, which do not
 * exist as targets at all while study mode is off.
 */

(() => {
  "use strict";

  if (typeof window.__ssoStudyTeardown === "function") {
    try {
      window.__ssoStudyTeardown();
    } catch {
      // Never let a broken predecessor block the replacement.
    }
  }

  const api = window.__ssoApi;
  if (!api) return; // content.js did not install; nothing to study

  const SETTINGS_KEY = "sso:study";
  const POSITION_KEY = "sso:studyPosition";

  /* Where the rail sits until it is dragged, in pixels rather than in vh.
   *
   * What it has to clear is the control panel's parked title bar, which is a
   * fixed number of pixels tall wherever it is - so a fraction of the viewport
   * cleared it on a tall screen and landed on it on a short one. Measured: the
   * panel parks at 52px and its folded bar ends near 93, so this starts below
   * that on every screen.
   *
   * An open panel still covers the rail, which is correct - it is above by
   * z-index, it is opened on purpose and closed again, and both of them can be
   * dragged anywhere and remember where that was. */
  const PARK_TOP = 104;
  const PARK_RIGHT = 12;

  const DEFAULT_SETTINGS = {
    enabled: false,
    /* The unattended half. With this on, the rare words of each line arrive in
     * the rail as the line is spoken and nothing has to be pointed at. It is
     * the mode the feature is really for; hovering is what you do when the
     * rail's guess about which word you did not know was wrong. */
    auto: true,
    /* Rarer than this rank counts as worth marking. 4000 is about where a
     * learner past the first year stops recognising things: everything more
     * common is the language's working vocabulary, and a mark on it is noise
     * over the picture. It is a slider because the right value is a property of
     * the reader, not of the film. */
    rarityRank: 4000,
    /* Two at most per line, and three in the rail. Both were larger, and the
     * rail became something to read instead of something to glance at: words
     * from four lines ago were still there while new ones arrived under them,
     * so nothing was ever the thing being looked at. A rail is a focus, not a
     * transcript - the deck is where words go to be kept. */
    maxPerCue: 2,
    keep: 3,
    /* Only the newest is worth the full entry; the ones under it are there to
     * be recognised, not read, so they collapse to the word and its
     * translation. Pinning a card opts it back into the full entry. */
    focus: true,
    // Shortest word worth marking, in letters. Below three it is function
    // words and interjections, which are never the problem.
    minLetters: 3,
    // Which subtitle is the language being learnt. The other one is context.
    studySlot: 0,
    // Empty means "whatever language that subtitle is in".
    language: "",
    pauseOnPin: false,
    width: 320,
    // 0 means "as tall as its contents". A dragged bottom edge sets a number.
    height: 0,
    /* The rail was set in 12px against a film, which is a size for a settings
     * page and not for something read at a glance in the dark while something
     * else is moving. */
    textPx: 15,
    dwellMs: 140,
    /* The rail can be put away without turning study off. What is left is the
     * word under the pointer answered where the pointer already is, which is
     * the whole feature for anyone who does not want a column of cards over
     * the picture. */
    showRail: true,
    hoverCard: true,
    /* Folded to its title bar. Different from put away: the rail is still
     * there, still counting, and one click brings the words back - what it
     * stops doing is standing on the picture. */
    folded: false,
    /* How solid the rail is over the film. Dense text over a moving picture
     * needs a backing to be readable at all, so this stops well short of
     * invisible; the low end is for reading the frame through it. */
    opacity: 0.93,
  };

  let settings = { ...DEFAULT_SETTINGS };

  let host = null;
  let shadow = null;
  let railEl = null;
  let listEl = null;
  let countEl = null;
  let noteEl = null;
  let clearEl = null;
  let foldEl = null;
  let gearEl = null;
  let backEl = null;
  let titleEl = null;
  let settingsEl = null;
  let railScreen = "words";
  let setEls = null;
  let sheets = null;

  /* Cards currently in the rail, newest first. Held here rather than read back
   * out of the DOM so the save key has something to name without a selector. */
  let cards = [];
  let cardSeq = 0;

  let hoverTimer = null;
  let hoveredWord = null;
  let selection = null;

  /* The answer shown beside the word itself, in its own host so that it works
   * with the rail put away. Proximity: a translation is about one word, and the
   * place it is wanted is next to that word, not in a column at the edge of the
   * screen that the eye has to leave the subtitle to read. */
  let popupHost = null;
  let popupShadow = null;
  let popupEl = null;
  let popupTerm = "";

  /* Ranks are asked for over a message, so they are cached here: a film says
   * "the" a thousand times and every line shares most of its words with the
   * one before. Bounded because a two-hour film has a bounded vocabulary and
   * this should not outgrow it. */
  const rankCache = new Map();
  const RANK_CACHE_LIMIT = 20000;
  let savedTerms = new Set();

  // --- settings ---------------------------------------------------------------

  async function loadSettings() {
    try {
      const stored = await chrome.storage.local.get(SETTINGS_KEY);
      settings = { ...DEFAULT_SETTINGS, ...(stored[SETTINGS_KEY] || {}) };
    } catch {
      // Defaults are fine.
    }
    applySettings();
  }

  function updateSettings(patch) {
    settings = { ...settings, ...patch };
    chrome.storage.local.set({ [SETTINGS_KEY]: settings }).catch(() => {});
    applySettings();
    // The panel draws the study controls from here, and does not subscribe to
    // this file; one status round is what makes it redraw.
    api.notifyChanged?.();
    return settings;
  }

  function applySettings() {
    if (host) {
      host.style.setProperty("width", `${settings.width}px`, "important");
      // Study can be on with the rail put away; the host stays in the tree so
      // that turning it back on does not have to rebuild it.
      host.hidden = !settings.showRail;
    }
    if (railEl) {
      railEl.dataset.auto = settings.auto ? "true" : "false";
      railEl.dataset.folded = settings.folded ? "true" : "false";
      railEl.style.setProperty("--sso-study-text", `${settings.textPx}px`);
      railEl.style.setProperty("--sso-study-alpha", String(settings.opacity));
      // 0 is "as tall as its contents", which is not a height any element can
      // be given - it is the absence of one.
      if (settings.height > 0) railEl.style.setProperty("--sso-study-height", `${settings.height}px`);
      else railEl.style.removeProperty("--sso-study-height");
    }
    if (foldEl) {
      foldEl.textContent = settings.folded ? "▸" : "▾";
      foldEl.title = settings.folded ? "Show the words again" : "Fold to the title bar";
    }
    if (popupEl) {
      popupEl.style.setProperty("--sso-study-text", `${settings.textPx}px`);
      popupEl.style.setProperty("--sso-study-alpha", String(settings.opacity));
    }
    // Marking depends on the threshold, so a changed threshold has to re-mark
    // the line that is already on screen rather than wait for the next one.
    refreshRailSettings();
    remarkCurrent();
  }

  // --- tokenising ---------------------------------------------------------------

  /* Split on anything that is not a letter, a mark, an apostrophe or an
   * internal hyphen. Unicode classes rather than [a-z]: the languages this is
   * for are exactly the ones where an ASCII word class is wrong, and Turkish
   * "değil" would come out as three words.
   *
   * The apostrophe stays inside the word because "don't" is one word, and
   * because the rank table knows to fall back to the part before it. */
  const WORD_PATTERN = /[\p{L}\p{M}][\p{L}\p{M}'’-]*/gu;
  const LETTERS = /[\p{L}\p{M}]/gu;

  const letterCount = (word) => (word.match(LETTERS) || []).length;

  /* Wrap every word in the rendered cue in its own element, leaving punctuation
   * and spacing as they were.
   *
   * Walks text nodes only, so the speaker colours, the sound symbols and the
   * italics that content.js built are all untouched - the words end up inside
   * those spans, which is what keeps a rare word inside a shouted line still
   * looking like part of the shouted line. */
  function wrapWords(cueBox) {
    const walker = document.createTreeWalker(cueBox, NodeFilter.SHOW_TEXT);
    const texts = [];
    while (walker.nextNode()) texts.push(walker.currentNode);

    const words = [];
    for (const node of texts) {
      const text = node.nodeValue;
      WORD_PATTERN.lastIndex = 0;
      let match = WORD_PATTERN.exec(text);
      if (!match) continue;

      const fragment = document.createDocumentFragment();
      let at = 0;
      while (match) {
        if (match.index > at) {
          fragment.append(document.createTextNode(text.slice(at, match.index)));
        }
        const span = document.createElement("span");
        span.className = "sso-w";
        span.textContent = match[0];
        span.dataset.w = match[0].toLowerCase();
        fragment.append(span);
        words.push(span);
        at = match.index + match[0].length;
        match = WORD_PATTERN.exec(text);
      }
      if (at < text.length) fragment.append(document.createTextNode(text.slice(at)));
      node.replaceWith(fragment);
    }
    return words;
  }

  // --- the current line ---------------------------------------------------------

  /* What is on screen right now, so a hover, a save or a threshold change can
   * all answer "which line is this word in" without going back to the cue
   * list. Replaced wholesale on every cue. */
  let current = { slot: null, cue: null, cueBox: null, words: [], token: 0 };

  function onCue(slot, cue, cueBox) {
    if (!settings.enabled || slot !== settings.studySlot) return;

    // The words this was anchored to are about to be replaced, so an answer
    // left on screen would be pointing at nothing.
    hoveredWord = null;
    hidePopup();

    current = { slot, cue, cueBox, words: [], token: current.token + 1 };
    if (!cue) return;

    current.words = wrapWords(cueBox);
    markWords(current);
  }

  function remarkCurrent() {
    if (settings.enabled && current.cue && current.words.length) markWords(current);
  }

  async function markWords(line) {
    const language = studyLanguage();
    const candidates = [...new Set(line.words.map((span) => span.dataset.w))].filter(
      (word) => letterCount(word) >= settings.minLetters,
    );
    const ranks = await ranksFor(candidates, language);
    // The line changed while the ranks were in flight; marking now would put
    // the previous line's answers on this one's words.
    if (line.token !== current.token) return;

    const rare = [];
    for (const span of line.words) {
      const word = span.dataset.w;
      const rank = ranks.has(word) ? ranks.get(word) : undefined;
      const known = savedTerms.has(`${language}:${word}`);
      span.dataset.saved = known ? "true" : "false";

      /* undefined means the language has no table, which is not the same as
       * "not in the table". No opinion marks nothing; the alternative is
       * underlining every word of a film in a language we cannot rank. */
      if (rank === undefined || letterCount(word) < settings.minLetters) {
        span.dataset.rare = "false";
        continue;
      }
      const isRare = rank === null || rank >= settings.rarityRank;
      span.dataset.rare = isRare ? "true" : "false";
      // Kept on the element so a hover can report how rare the word is without
      // asking again. "" is how a dataset says null.
      span.dataset.rank = rank === null ? "" : String(rank);
      if (isRare && !known) rare.push({ word, rank });
    }

    if (!settings.auto || rare.length === 0) return;
    /* Rarest first, then capped. When a line has more unfamiliar words than
     * fit, the rarest are the ones a reader is least likely to have got from
     * context. */
    rare.sort((a, b) => (b.rank ?? Infinity) - (a.rank ?? Infinity));
    for (const item of rare.slice(0, settings.maxPerCue)) {
      addCard(item.word, { rank: item.rank, language, auto: true });
    }
  }

  async function ranksFor(words, language) {
    const known = new Map();
    const missing = [];
    for (const word of words) {
      const key = `${language}:${word}`;
      if (rankCache.has(key)) known.set(word, rankCache.get(key));
      else missing.push(word);
    }
    if (missing.length === 0) return known;

    const response = await api.daemon("rank", { words: missing, language });
    const ranks = response?.ranks || {};
    for (const word of missing) {
      // A language with no table answers with nothing at all, which has to stay
      // distinguishable from "answered, and this word is not in it".
      const value = Object.prototype.hasOwnProperty.call(ranks, word) ? ranks[word] : undefined;
      if (value === undefined) continue;
      if (rankCache.size < RANK_CACHE_LIMIT) rankCache.set(`${language}:${word}`, value);
      known.set(word, value);
    }
    return known;
  }

  function studyLanguage() {
    return (settings.language || api.trackInfo(settings.studySlot).language || "en")
      .toLowerCase()
      .slice(0, 2);
  }

  // --- pointer ------------------------------------------------------------------

  /* content.js offers every press on a cue box here first. Taking one means the
   * box will not be dragged and the click will not reach the player, so only
   * the two gestures that are unambiguously about a word are taken. */
  function claimPointerDown(slot, event) {
    if (!settings.enabled || slot !== settings.studySlot) return false;
    const word = event.composedPath?.()[0];
    if (!word?.classList?.contains?.("sso-w")) return false;

    if (event.shiftKey) {
      beginSelection(word, event);
      return true;
    }

    /* A press on a word without shift is only claimed at release, and only if
     * it did not move - otherwise dragging the subtitle by a word, which is
     * most of the box, would stop working. Rather than duplicate content.js's
     * threshold logic, watch this one pointer to its end. */
    watchTap(word, event);
    return false;
  }

  function watchTap(word, down) {
    const start = { x: down.clientX, y: down.clientY };
    let moved = false;

    const onMove = (event) => {
      if (Math.abs(event.clientX - start.x) > 4 || Math.abs(event.clientY - start.y) > 4) {
        moved = true;
      }
    };
    const onUp = () => {
      document.removeEventListener("pointermove", onMove, true);
      document.removeEventListener("pointerup", onUp, true);
      document.removeEventListener("pointercancel", onUp, true);
      if (!moved) pinWord(word);
    };

    document.addEventListener("pointermove", onMove, true);
    document.addEventListener("pointerup", onUp, true);
    document.addEventListener("pointercancel", onUp, true);
  }

  /* The rank the word was marked with, as the card wants it: a number, null for
   * "not in the table at all", or undefined when nothing ranked it. */
  function rankOf(word) {
    if (!("rank" in word.dataset)) return undefined;
    return word.dataset.rank === "" ? null : Number(word.dataset.rank);
  }

  function pinWord(word) {
    addCard(word.dataset.w, {
      pinned: true,
      rank: rankOf(word),
      language: studyLanguage(),
    });
    if (settings.pauseOnPin) api.pauseVideo();
  }

  /* Shift and sweep selects a phrase. Idioms are the reason: "give it a rest"
   * is four words each of which is common, and looking any one of them up
   * answers nothing. */
  function beginSelection(word, event) {
    selection = { anchor: word, focus: word, pointerId: event.pointerId };
    paintSelection();
    event.preventDefault();

    const onMove = (moveEvent) => {
      const over = moveEvent.composedPath?.()[0];
      if (over?.classList?.contains?.("sso-w")) {
        selection.focus = over;
        paintSelection();
      }
    };
    const onUp = () => {
      document.removeEventListener("pointermove", onMove, true);
      document.removeEventListener("pointerup", onUp, true);
      document.removeEventListener("pointercancel", onUp, true);
      const phrase = selectedWords()
        .map((span) => span.textContent)
        .join(" ")
        .trim();
      clearSelection();
      if (phrase) addCard(phrase.toLowerCase(), { pinned: true, language: studyLanguage() });
    };

    document.addEventListener("pointermove", onMove, true);
    document.addEventListener("pointerup", onUp, true);
    document.addEventListener("pointercancel", onUp, true);
  }

  function selectedWords() {
    if (!selection) return [];
    const words = current.words;
    const from = words.indexOf(selection.anchor);
    const to = words.indexOf(selection.focus);
    if (from === -1 || to === -1) return [selection.anchor];
    return words.slice(Math.min(from, to), Math.max(from, to) + 1);
  }

  function paintSelection() {
    const chosen = new Set(selectedWords());
    for (const span of current.words) {
      span.dataset.selected = chosen.has(span) ? "true" : "false";
    }
  }

  function clearSelection() {
    for (const span of current.words) span.dataset.selected = "false";
    selection = null;
  }

  /* Hover looks a word up without a click, because the film is playing and a
   * click is a pause. The dwell exists so that sweeping the pointer across the
   * subtitle on the way somewhere else does not fill the rail with every word
   * it passed over. */
  function onPointerOver(event) {
    if (!settings.enabled || selection) return;
    const word = event.composedPath?.()[0];
    if (!word?.classList?.contains?.("sso-w")) {
      clearTimeout(hoverTimer);
      hoveredWord = null;
      hidePopup();
      return;
    }
    if (word === hoveredWord) return;

    hoveredWord = word;
    clearTimeout(hoverTimer);
    hidePopup();
    hoverTimer = setTimeout(() => {
      if (hoveredWord !== word || !word.isConnected) return;
      const term = word.dataset.w;
      const language = studyLanguage();
      if (settings.hoverCard) showPopup(word, term, language);
      // With the rail put away the popup is the whole answer; adding to a list
      // nobody can see would only spend lookups.
      if (settings.showRail) addCard(term, { rank: rankOf(word), language });
    }, settings.dwellMs);
  }

  // --- the answer beside the word -----------------------------------------------

  async function buildPopup() {
    if (popupHost) return;
    popupHost = document.createElement("div");
    for (const [property, value] of Object.entries({
      all: "initial",
      position: "fixed",
      top: "0",
      left: "0",
      "z-index": "2147483646",
      "pointer-events": "none", // never in the way of the film or of a drag
    })) {
      popupHost.style.setProperty(property, value, "important");
    }
    popupShadow = popupHost.attachShadow({ mode: "open" });
    popupShadow.adoptedStyleSheets = await loadStyles();
    popupEl = document.createElement("div");
    // A window too, so it takes the same ink, lines and radius as the rail.
    popupEl.className = "sso-win sso-pop";
    popupEl.hidden = true;
    popupShadow.append(popupEl);
    (host?.parentElement || document.body).appendChild(popupHost);
    applySettings();
  }

  async function showPopup(word, term, language) {
    await buildPopup();
    if (hoveredWord !== word || !word.isConnected) return;

    popupTerm = term;
    drawPopup(term, null);
    placePopup(word);

    const entry = await lookUp(term, language);
    // The pointer moved on while the lookup was in flight; answering now would
    // put this word's meaning beside a different one.
    if (popupTerm !== term || hoveredWord !== word || !word.isConnected) return;
    drawPopup(term, entry);
    placePopup(word);
  }

  function drawPopup(term, entry) {
    if (!popupEl) return;
    popupEl.replaceChildren();
    popupEl.hidden = false;

    const head = document.createElement("div");
    head.className = "sso-pop__term";
    head.textContent = term;
    popupEl.append(head);

    if (entry === null) {
      const wait = document.createElement("div");
      wait.className = "sso-pop__note";
      wait.textContent = "Looking up…";
      popupEl.append(wait);
      return;
    }

    /* The translation leads. It is the one line that answers "what is this",
     * and a learner reading a subtitle in the dark has time for one line. */
    if (entry.translation) {
      const translation = document.createElement("div");
      translation.className = "sso-pop__translation";
      translation.textContent = entry.translation;
      popupEl.append(translation);
    }

    for (const definition of (entry.definitions || []).slice(0, 2)) {
      const line = document.createElement("div");
      line.className = "sso-pop__def";
      const part = document.createElement("span");
      part.className = "sso-pop__part";
      part.textContent = definition.partOfSpeech;
      line.append(part, document.createTextNode(definition.sense));
      popupEl.append(line);
    }

    if (!entry.translation && !(entry.definitions || []).length) {
      const note = document.createElement("div");
      note.className = "sso-pop__note";
      note.textContent = entry.unavailable || "Nothing found for that word.";
      popupEl.append(note);
    }
  }

  /* Above the word, and below it when there is no room above - the subtitle is
   * usually at the bottom of the screen, so above is almost always right, and
   * "almost always" is exactly the case that needs the other branch written. */
  function placePopup(word) {
    if (!popupHost || !popupEl) return;
    const anchor = word.getBoundingClientRect();
    const box = popupEl.getBoundingClientRect();
    const gap = 10;

    let top = anchor.top - box.height - gap;
    if (top < 4) top = Math.min(anchor.bottom + gap, window.innerHeight - box.height - 4);

    const left = clamp(
      anchor.left + anchor.width / 2 - box.width / 2,
      4,
      Math.max(4, window.innerWidth - box.width - 4),
    );
    popupHost.style.setProperty("transform", `translate(${Math.round(left)}px, ${Math.round(top)}px)`, "important");
  }

  function hidePopup() {
    popupTerm = "";
    if (popupEl) popupEl.hidden = true;
  }

  function clamp(value, low, high) {
    return Math.min(Math.max(value, low), high);
  }

  // --- the rail -----------------------------------------------------------------

  /* Its own shadow root, its own stylesheet, its own host carrying geometry
   * only - the same three decisions the panel documents, for the same reasons:
   * page CSS reaches anything in the light DOM, and an adopted stylesheet is
   * not subject to the page's style-src. */
  async function build() {
    host = document.createElement("div");
    for (const [property, value] of Object.entries({
      all: "initial",
      position: "fixed",
      top: `${PARK_TOP}px`,
      right: `${PARK_RIGHT}px`,
      left: "auto",
      width: `${settings.width}px`,
      "z-index": "2147483646", // just under the panel, which opens over it
    })) {
      host.style.setProperty(property, value, "important");
    }

    shadow = host.attachShadow({ mode: "open" });
    shadow.adoptedStyleSheets = await loadStyles();

    railEl = document.createElement("div");
    railEl.className = "sso-win sso-rail";

    const head = document.createElement("div");
    head.className = "sso-win__head";
    const title = document.createElement("span");
    title.className = "sso-win__title";
    title.textContent = "Study";
    /* How many words are here. A plain number in the quiet ink: it was an amber
     * pill, which made the least actionable fact on the surface the loudest
     * thing on it and spent the one colour that means "this word is marked". */
    countEl = document.createElement("span");
    countEl.className = "sso-rail__count";

    /* Three controls, in the order they get reached for: empty it, fold it,
     * put it away. All on the head, which is the thing they act on, and all in
     * the one treatment the control panel's head buttons use. */
    clearEl = document.createElement("button");
    clearEl.className = "sso-icon sso-icon--word";
    clearEl.type = "button";
    clearEl.textContent = "Clear";
    clearEl.title = "Empty the rail";
    clearEl.addEventListener("click", clearCards);

    foldEl = document.createElement("button");
    foldEl.className = "sso-icon";
    foldEl.type = "button";
    foldEl.addEventListener("click", () => updateSettings({ folded: !settings.folded }));

    const close = document.createElement("button");
    close.className = "sso-icon sso-icon--close";
    close.type = "button";
    close.textContent = "×";
    /* Puts the rail away without turning study off. Hovering a word still
     * answers next to the word, which for a reader who wants the picture
     * rather than a column of cards is the whole feature. Study itself goes
     * off from the control panel, where turning it back on also lives. */
    close.title = "Put the rail away — hovering a word still answers";
    close.addEventListener("click", () => updateSettings({ showRail: false }));

    /* Study's settings live here now rather than in the control panel.
     *
     * They were a section of eleven controls in a panel that is about
     * subtitles, and every one of them describes this surface: how big its text
     * is, how solid it is over the film, how many words it keeps, what counts
     * as rare. Settings belong on the thing they change, and this is the thing.
     *
     * What stays in the panel is the master switch, because the rail does not
     * exist when study is off and a switch you can only reach by first being in
     * the state it turns on is not a switch. */
    gearEl = document.createElement("button");
    gearEl.className = "sso-icon";
    gearEl.type = "button";
    gearEl.textContent = "⚙";
    gearEl.title = "How study works";
    gearEl.addEventListener("click", () => showRailScreen("settings"));

    backEl = document.createElement("button");
    backEl.className = "sso-icon";
    backEl.type = "button";
    backEl.textContent = "‹";
    backEl.title = "Back to the words";
    backEl.hidden = true;
    backEl.addEventListener("click", () => showRailScreen("words"));

    titleEl = title;
    head.append(backEl, title, countEl, clearEl, gearEl, foldEl, close);

    listEl = document.createElement("div");
    listEl.className = "sso-rail__list";

    noteEl = document.createElement("p");
    noteEl.className = "sso-rail__note";

    settingsEl = buildRailSettings();
    settingsEl.hidden = true;

    railEl.append(head, listEl, noteEl, settingsEl);
    shadow.append(railEl);

    makeDraggable(head);
    makeResizable();
    await restorePosition();
    applySettings();
    return host;
  }

  /* Two sheets. chrome.css carries what makes this a window and the control
   * panel adopts the same one, which is what keeps the two floating surfaces
   * speaking one language; study.css goes second so it can override any of it. */
  /* The rail's two faces: the words, and how they get there.
   *
   * Two, not a stack - there is nowhere to go from the settings but back. The
   * head's own controls come and go with it, because Clear and the count are
   * about a list that is not on screen. */
  function showRailScreen(name) {
    railScreen = name;
    const settings_ = name === "settings";
    settingsEl.hidden = !settings_;
    listEl.hidden = settings_;
    backEl.hidden = !settings_;
    gearEl.hidden = settings_;
    countEl.hidden = settings_;
    clearEl.hidden = settings_ || cards.length === 0;
    titleEl.textContent = settings_ ? "How study works" : "Study";
    if (!settings_) emptyNote();
    else noteEl.hidden = true;
  }

  /* One control per thing study does, in the order a reader meets them: what
   * gets marked, which subtitle is being learnt from, what appears where, and
   * then how this box looks. */
  function buildRailSettings() {
    const wrap = document.createElement("div");
    wrap.className = "sso-rail__settings";

    const check = (label, key, hint) => {
      const row = document.createElement("label");
      row.className = "sso-set sso-set--check";
      if (hint) row.title = hint;
      const input = document.createElement("input");
      input.type = "checkbox";
      input.addEventListener("change", () => updateSettings({ [key]: input.checked }));
      const said = document.createElement("span");
      said.textContent = label;
      row.append(input, said);
      wrap.append(row);
      return { row, input };
    };

    const range = (label, key, min, max, step, format, hint) => {
      const row = document.createElement("label");
      row.className = "sso-set";
      if (hint) row.title = hint;
      const said = document.createElement("span");
      said.className = "sso-set__label";
      said.textContent = label;
      const input = document.createElement("input");
      input.type = "range";
      input.min = String(min);
      input.max = String(max);
      input.step = String(step);
      const readout = document.createElement("span");
      readout.className = "sso-set__value";
      input.addEventListener("input", () => {
        const value = Number(input.value);
        readout.textContent = format(value);
        updateSettings({ [key]: key === "opacity" ? value / 100 : value });
      });
      row.append(said, input, readout);
      wrap.append(row);
      return { row, input, readout, format };
    };

    setEls = {
      auto: check("Mark rare words as they are said", "auto",
        "Without this, nothing is marked until you hover a word."),
      /* The threshold is a slider because the right value is a property of the
       * reader, not of the film: rank 2000 is where a beginner stops
       * recognising words and rank 12000 is where somebody comfortable does.
       * Nothing else can know which of those is on the sofa. */
      rank: range("Rarer than", "rarityRank", 500, 25000, 500, (v) => v.toLocaleString(),
        "A word this far down the frequency list, or missing from it, gets underlined."),
      keep: range("Words kept", "keep", 1, 8, 1, (v) => String(v),
        "How many stay on the rail. Pinned words survive past this."),
      hover: check("Answer beside the word on hover", "hoverCard",
        "Shows what a word means next to the word itself. Works with the rail put away."),
      focus: check("Only the newest word in full", "focus",
        "The rest collapse to the word and its meaning, so the rail stays something to glance at."),
      pause: check("Pause when a word is clicked", "pauseOnPin"),
      text: range("Text size", "textPx", 11, 26, 1, (v) => `${v}px`),
      opacity: range("Background", "opacity", 20, 100, 5, (v) => `${v}%`,
        "How solid this box is over the film."),
    };

    const deck = document.createElement("button");
    deck.className = "sso-set__action";
    deck.type = "button";
    deck.textContent = "Saved words";
    deck.title = "Open the deck on the options page";
    deck.addEventListener("click", () =>
      chrome.runtime.sendMessage({ type: "sso:openOptions", hash: "#deck" }),
    );
    wrap.append(deck);
    return wrap;
  }

  /* Written whenever the settings change, so the screen agrees with the rail
   * even when something else moved a value - a corner drag setting the text
   * size, or the panel's master switch. */
  function refreshRailSettings() {
    if (!setEls) return;
    for (const [key, control] of Object.entries(setEls)) {
      const name = { auto: "auto", rank: "rarityRank", keep: "keep", hover: "hoverCard",
        focus: "focus", pause: "pauseOnPin", text: "textPx", opacity: "opacity" }[key];
      const value = name === "opacity" ? Math.round(settings.opacity * 100) : settings[name];
      if (control.input.type === "checkbox") control.input.checked = Boolean(value);
      else {
        control.input.value = String(value);
        control.readout.textContent = control.format(Number(value));
      }
    }
  }

  async function loadStyles() {
    if (sheets) return sheets;
    const files = ["src/chrome.css", "src/study.css"];
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

  function emptyNote() {
    if (!noteEl) return;
    const empty = cards.length === 0;
    noteEl.hidden = !empty || railScreen === "settings";
    noteEl.textContent = settings.auto
      ? "Rare words appear here as they are said. Hover any word to look it up; shift-drag for a phrase."
      : "Hover a word in the subtitle to look it up. Shift-drag across words for a phrase.";
  }

  /**
   * Put a word in the rail and look it up.
   *
   * Repeats move the existing card to the top and pin it rather than adding a
   * second one: the same word arriving twice in a minute is the film insisting,
   * not two things to read.
   */
  async function addCard(term, { rank = undefined, language, pinned = false, auto = false } = {}) {
    if (!term || !host) return null;

    const existing = cards.find((card) => card.term === term && card.language === language);
    if (existing) {
      if (pinned) existing.pinned = true;
      promote(existing);
      return existing;
    }

    const cue = api.cueAt(current.slot ?? settings.studySlot);
    const paired = pairedLine();
    const card = {
      id: ++cardSeq,
      term,
      language,
      rank,
      pinned,
      auto,
      sentence: cue?.text || "",
      pairedSentence: paired.text,
      pairedLanguage: paired.language,
      timeMs: api.filmTimeMs(),
      lookup: null,
      saved: savedTerms.has(`${language}:${term}`),
      node: null,
    };

    cards.unshift(card);
    card.node = renderCard(card);
    listEl.prepend(card.node);
    trim();
    refreshCount();
    refocus();
    dedupeSentences();

    card.lookup = await lookUp(term, language);
    if (card.node?.isConnected) redrawCard(card);
    return card;
  }

  /* One place both the rail and the hover popup ask through, and one place the
   * target language is decided: the other subtitle's, because that is the
   * language the reader has already chosen to read this film in. */
  const lookupCache = new Map();

  async function lookUp(term, language) {
    const target = translationTarget();
    const key = `${language}>${target}:${term}`;
    if (lookupCache.has(key)) return lookupCache.get(key);

    const pending = api
      .daemon("lookup", { query: term, language, target })
      .then((response) => response || { definitions: [], unavailable: "Lookup failed." })
      .catch(() => ({ definitions: [], unavailable: "Lookup failed." }));
    lookupCache.set(key, pending);
    const settled = await pending;
    // Hold the value rather than the promise, and do not hold a failure: a
    // lookup that failed because the daemon was starting should be asked again.
    if (settled.definitions?.length || settled.translation) lookupCache.set(key, settled);
    else lookupCache.delete(key);
    return settled;
  }

  function translationTarget() {
    const other = settings.studySlot === 0 ? 1 : 0;
    return (api.trackInfo(other).language || "").toLowerCase().slice(0, 2);
  }

  /* The other subtitle at this exact moment. For a learner this is the single
   * most useful thing on the screen and it costs nothing to fetch: it is the
   * sentence, already translated by a human, already timed to the same frame. */
  function pairedLine() {
    const other = settings.studySlot === 0 ? 1 : 0;
    const cue = api.cueAt(other);
    return { text: cue?.text || "", language: api.trackInfo(other).language || "" };
  }

  function promote(card) {
    cards = [card, ...cards.filter((item) => item !== card)];
    listEl.prepend(card.node);
    redrawCard(card);
    refocus();
    dedupeSentences();
  }

  /* One line often contains three rare words, and with auto on that is three
   * cards carrying the same two quoted sentences - six lines of identical text
   * in a column 300px wide, which buries the words the column exists to show.
   *
   * So a card quotes its line only when the card above it quotes a different
   * one. The first card of each run keeps the quotation - cards arrive
   * newest-first and are read top down, so that is where the reader meets the
   * line, and the ones under it are more words out of the sentence they have
   * just read. */
  function dedupeSentences() {
    let changed = false;
    cards.forEach((card, index) => {
      const above = cards[index - 1];
      const hide = Boolean(above && above.sentence === card.sentence);
      if (card.hideSentence === hide) return;
      card.hideSentence = hide;
      changed = true;
    });
    if (changed) for (const card of cards) redrawCard(card);
  }

  /* Unpinned cards fall off the bottom as new ones arrive; pinned ones do not.
   * Pinning is the only way to say "I am still reading that", and a rail that
   * discarded it would be unusable at exactly the moment it is being used. */
  function trim() {
    const keep = [];
    const dropped = [];
    for (const card of cards) {
      if (card.pinned || keep.length < settings.keep) keep.push(card);
      else dropped.push(card);
    }
    for (const card of dropped) card.node?.remove();
    cards = keep;
  }

  /* The rail fills itself, so it needs a way to be emptied. Auto mode puts
   * words there without being asked and the reader is the only one who knows
   * which of them were wanted - without this the only control over the contents
   * was to wait for them to fall off the end. */
  function removeCard(card) {
    card.node?.remove();
    cards = cards.filter((item) => item !== card);
    refreshCount();
    refocus();
    dedupeSentences();
  }

  function clearCards() {
    for (const card of cards) card.node?.remove();
    cards = [];
    refreshCount();
  }

  function refreshCount() {
    if (countEl) countEl.textContent = cards.length ? String(cards.length) : "";
    // The head's list controls belong to a list that is not on screen while the
    // settings are, so the screen has the last word on whether they show.
    if (clearEl) clearEl.hidden = cards.length === 0 || railScreen === "settings";
    emptyNote();
  }

  function renderCard(card) {
    const node = document.createElement("div");
    node.className = "sso-card";
    redrawCard(card, node);
    return node;
  }

  /* Which card is the one being looked at.
   *
   * `card.open` is the reader's own answer and beats everything: undefined
   * means "you decide", true and false mean they have decided. Without it,
   * expanding was done by pinning - which made "keep this" and "open this" one
   * gesture and left no way to close a card again.
   *
   * The default, when they have not said, is the newest and anything pinned.
   * Everything else collapses to the word and what it means, which is what a
   * reader would have kept anyway. */
  function isFocused(card) {
    if (typeof card.open === "boolean") return card.open;
    return !settings.focus || card.pinned || cards[0] === card;
  }

  function toggleCard(card) {
    card.open = !isFocused(card);
    redrawCard(card);
  }

  function refocus() {
    for (const card of cards) {
      const wanted = isFocused(card);
      if (card.focused === wanted) continue;
      card.focused = wanted;
      redrawCard(card);
    }
  }

  function redrawCard(card, into) {
    const node = into || card.node;
    if (!node) return;
    card.focused = isFocused(card);
    node.dataset.pinned = card.pinned ? "true" : "false";
    node.dataset.saved = card.saved ? "true" : "false";
    node.dataset.focused = card.focused ? "true" : "false";
    node.replaceChildren();

    /* The head is the card's own control strip: open or close it, and throw it
     * away. Both act on this card, so both live on it. */
    const head = document.createElement("div");
    head.className = "sso-card__head";

    const caret = document.createElement("button");
    caret.className = "sso-card__caret";
    caret.type = "button";
    caret.textContent = card.focused ? "▾" : "▸";
    caret.title = card.focused ? "Collapse" : "Expand";
    caret.addEventListener("click", (event) => {
      event.stopPropagation();
      toggleCard(card);
    });

    const term = document.createElement("span");
    term.className = "sso-card__term";
    term.textContent = card.term;

    const meta = document.createElement("span");
    meta.className = "sso-card__rank";
    meta.textContent = rankLabel(card.rank);

    const drop = document.createElement("button");
    drop.className = "sso-card__drop";
    drop.type = "button";
    drop.textContent = "×";
    drop.title = "Remove this word";
    drop.addEventListener("click", (event) => {
      event.stopPropagation();
      removeCard(card);
    });

    head.append(caret, term);

    /* The head is one line and it carries everything about the word itself.
     *
     * Open, that is the pronunciation - which had a row of its own, spending a
     * whole line on the quietest thing in the card and pushing the answer
     * further from the question. Shut, it is the translation, which is the
     * reason to collapse a card rather than remove it: a shut card used to be
     * two lines, so folding four of them saved four rows instead of eight and
     * the density the fold was for never arrived. */
    if (!card.focused && card.lookup?.translation) {
      const gloss = document.createElement("span");
      gloss.className = "sso-card__gloss";
      gloss.textContent = card.lookup.translation;
      head.append(gloss);
    } else if (card.focused && card.lookup?.phonetic) {
      const phon = document.createElement("span");
      phon.className = "sso-card__phonetic";
      phon.textContent = card.lookup.phonetic;
      head.append(phon);
    }

    head.append(meta, drop);
    // The whole head toggles, not only the caret: it is a 12px target beside a
    // 300px one that means the same thing.
    head.addEventListener("click", () => toggleCard(card));
    node.append(head);

    if (!card.focused) return;

    /* The translation leads, above the definition, the same way it does in the
     * popup: it is the line that answers "what is this", and a card the reader
     * meets mid-film gets read from the top down until they have their answer.
     * Having the two disagree about which line matters made the same fact look
     * like two different features. */
    if (card.lookup?.translation) {
      const translation = document.createElement("div");
      translation.className = "sso-card__translation";
      translation.textContent = card.lookup.translation;
      node.append(translation);
    }

    if (card.lookup === null) {
      const loading = document.createElement("div");
      loading.className = "sso-card__note";
      loading.textContent = "Looking up…";
      node.append(loading);
    } else if (card.lookup.definitions?.length) {
      for (const definition of card.lookup.definitions) {
        const line = document.createElement("div");
        line.className = "sso-card__def";
        const part = document.createElement("span");
        part.className = "sso-card__part";
        part.textContent = definition.partOfSpeech;
        line.append(part, document.createTextNode(definition.sense));
        node.append(line);
      }
    } else if (card.lookup.unavailable) {
      const note = document.createElement("div");
      note.className = "sso-card__note";
      note.textContent = card.lookup.unavailable;
      node.append(note);
    }

    /* The line it was said in, with the word marked inside it. This is the part
     * that makes the entry worth keeping, so it is in the card and not behind
     * an expander. */
    if (card.sentence && !card.hideSentence) {
      node.append(sentenceLine(card.sentence, card.term, "sso-card__line", card.language));
      if (card.pairedSentence) {
        node.append(sentenceLine(card.pairedSentence, "", "sso-card__paired", card.pairedLanguage));
      }
    }

    const actions = document.createElement("div");
    actions.className = "sso-card__actions";

    const save = document.createElement("button");
    save.type = "button";
    save.className = "sso-card__save";
    save.textContent = card.saved ? "Saved" : "Save";
    save.disabled = card.saved;
    save.addEventListener("click", () => saveCard(card));

    const pin = document.createElement("button");
    pin.type = "button";
    pin.className = "sso-card__pin";
    pin.dataset.on = card.pinned ? "true" : "false";
    pin.textContent = card.pinned ? "Unpin" : "Pin";
    pin.addEventListener("click", () => {
      card.pinned = !card.pinned;
      redrawCard(card);
      refocus();
      trim();
      refreshCount();
    });

    actions.append(save, pin);
    node.append(actions);
  }

  /* Highlight the word inside its own sentence. textContent throughout, never
   * innerHTML: this string came out of a subtitle file off the internet. */
  function sentenceLine(sentence, term, className, language) {
    const line = document.createElement("div");
    line.className = className;

    /* Which language this line is in. The two quoted lines were told apart only
     * by the colour of a 2px rule down their left edge, and a reader studying a
     * language they cannot yet read at a glance is exactly the reader who
     * cannot use that cue. */
    if (language) {
      const tag = document.createElement("span");
      tag.className = "sso-card__lang";
      tag.textContent = language.slice(0, 2);
      line.append(tag);
    }

    const text = document.createElement("span");
    const flat = sentence.replace(/\s*\n\s*/g, " ");
    const at = term ? flat.toLowerCase().indexOf(term) : -1;
    if (at === -1) {
      text.textContent = flat;
    } else {
      const mark = document.createElement("mark");
      mark.textContent = flat.slice(at, at + term.length);
      text.append(
        document.createTextNode(flat.slice(0, at)),
        mark,
        document.createTextNode(flat.slice(at + term.length)),
      );
    }
    line.append(text);
    return line;
  }

  function rankLabel(rank) {
    if (rank === undefined) return "";
    if (rank === null) return "very rare";
    return `rank ${rank.toLocaleString()}`;
  }

  // --- saving -------------------------------------------------------------------

  async function saveCard(card) {
    if (!card || card.saved) return false;
    const info = api.trackInfo(settings.studySlot);
    const response = await api.daemon("deckSave", {
      entry: {
        term: card.term,
        language: card.language,
        rank: card.rank ?? null,
        definitions: card.lookup?.definitions || [],
        phonetic: card.lookup?.phonetic || "",
        translation: card.lookup?.translation || "",
        sentence: card.sentence,
        pairedSentence: card.pairedSentence,
        pairedLanguage: card.pairedLanguage,
        title: filmTitle(),
        fileId: info.fileId,
        timeMs: card.timeMs,
        url: location.href,
      },
    });

    card.saved = true;
    savedTerms.add(`${card.language}:${card.term}`);
    redrawCard(card);
    remarkCurrent();
    api.showToast(
      response?.added ? `Saved "${card.term}" with its line` : `"${card.term}" is already saved`,
    );
    return true;
  }

  function filmTitle() {
    const info = api.trackInfo(settings.studySlot);
    if (info.label) return info.label;
    return api.pageInfo().candidates[0]?.text || document.title;
  }

  /* What the save key saves. The top card, because with auto on that is the
   * word from the line still being spoken - which is the one you reached for
   * the key about. */
  function saveTop() {
    if (!settings.enabled) return false;
    const card = cards[0];
    if (!card) {
      api.showToast("Nothing in the study rail yet");
      return true;
    }
    saveCard(card);
    return true;
  }

  async function loadSavedTerms() {
    const response = await api.daemon("deckTerms", {});
    savedTerms = new Set(response?.terms || []);
    remarkCurrent();
  }

  // --- geometry -----------------------------------------------------------------

  /* Same coordinate-system problem as the control panel, same solution - see
   * measurePlacement in content.js. A rail that slides out from under the
   * pointer is the identical bug in the identical shape, and it would have been
   * fixed in one place and not the other if this used its own arithmetic. */
  function makeDraggable(handle) {
    api.makeMovable(handle, {
      host,
      place: (x, y) => setPosition(`${x}px`, `${y}px`),
      onEnd: savePosition,
    });

    /* Double-click the title bar to send it back to its corner, the same
     * gesture the control panel has. Somewhere to put a thing you have dragged
     * into the way, without having to aim it back. */
    handle.addEventListener("dblclick", (event) => {
      if (event.target.closest("button")) return;
      park();
    });
  }

  function park() {
    host.style.setProperty("left", "auto", "important");
    host.style.setProperty("right", `${PARK_RIGHT}px`, "important");
    host.style.setProperty("top", `${PARK_TOP}px`, "important");
    chrome.storage.local.remove(POSITION_KEY).catch(() => {});
    api.showToast?.("Rail parked");
  }

  function savePosition() {
    chrome.storage.local
      .set({ [POSITION_KEY]: { left: host.style.left, top: host.style.top } })
      .catch(() => {});
  }

  /* All four corners, like the panel and for the same reason: the rail can be
   * dragged anywhere, so whichever single corner were chosen would be the one
   * off the screen exactly when the rail is too big to fit - which is when
   * resizing it is what the reader wants.
   *
   * Width decides whether a definition reads as prose or as a column of two
   * words per line; height decides how much of the film the rail is standing
   * on. Both depend on the screen and the film, so neither has a right default.
   */
  const CORNERS = [
    { name: "nw", dx: -1, dy: -1, cursor: "nwse-resize" },
    { name: "ne", dx: +1, dy: -1, cursor: "nesw-resize" },
    { name: "sw", dx: -1, dy: +1, cursor: "nesw-resize" },
    { name: "se", dx: +1, dy: +1, cursor: "nwse-resize" },
  ];

  const MIN_WIDTH = 200;
  const MAX_WIDTH = 620;
  const MIN_HEIGHT = 120;

  function makeResizable() {
    for (const corner of CORNERS) railEl.append(buildGrip(corner));
  }

  function buildGrip(corner) {
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
        height: box.height,
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
      const width = clamp(from.width + (event.clientX - from.x) * corner.dx, MIN_WIDTH, MAX_WIDTH);
      const height = clamp(
        from.height + (event.clientY - from.y) * corner.dy,
        MIN_HEIGHT,
        Math.max(MIN_HEIGHT, window.innerHeight - 40),
      );
      updateSettings({ width: Math.round(width), height: Math.round(height) });

      /* Pulling a left or top edge grows the rail away from the pointer unless
       * the opposite edge is pinned, so move it by however much it actually
       * grew - which is not what the pointer did once the size hit a limit. */
      const grewX = corner.dx < 0 ? width - from.width : 0;
      const grewY = corner.dy < 0 ? host.getBoundingClientRect().height - from.height : 0;
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
        .set({ [POSITION_KEY]: { left: host.style.left, top: host.style.top } })
        .catch(() => {});
    };
    grip.addEventListener("pointerup", end);
    grip.addEventListener("pointercancel", end);
    return grip;
  }

  function setPosition(left, top) {
    host.style.setProperty("right", "auto", "important");
    host.style.setProperty("left", left, "important");
    host.style.setProperty("top", top, "important");
  }

  async function restorePosition() {
    try {
      const stored = await chrome.storage.local.get(POSITION_KEY);
      const saved = stored[POSITION_KEY];
      if (saved?.left && saved?.top) setPosition(saved.left, saved.top);
    } catch {
      // The default corner is fine.
    }
  }

  function clampIntoView() {
    if (!host || host.hidden) return;
    const box = host.getBoundingClientRect();
    if (box.width === 0) return;
    const maxLeft = Math.max(0, window.innerWidth - box.width);
    const maxTop = Math.max(0, window.innerHeight - 60);
    if (box.left > maxLeft || box.top > maxTop) {
      setPosition(`${Math.min(box.left, maxLeft)}px`, `${Math.min(box.top, maxTop)}px`);
    }
  }

  /* Follows the overlay into the fullscreen element, since only that subtree is
   * rendered while fullscreen is on. */
  function reparent(parent) {
    if (!host) return;
    const target =
      parent ||
      document.fullscreenElement ||
      document.webkitFullscreenElement ||
      document.body ||
      document.documentElement;
    if (target && host.parentElement !== target) target.appendChild(host);
    // The popup is anchored to the subtitle, so it has to follow the subtitle
    // into fullscreen or it renders behind the film.
    if (popupHost && target && popupHost.parentElement !== target) target.appendChild(popupHost);
    rescale();
  }

  /* Same counter-scale as the panel: a fullscreen element the player has scaled
   * scales everything re-parented into it, and a study rail that renders half
   * again as large in fullscreen is the same complaint. */
  function rescale() {
    if (!host) return;
    host.style.removeProperty("transform");
    const rendered = host.getBoundingClientRect().width;
    const asked = host.offsetWidth;
    const scale = asked > 0 && rendered > 0 ? rendered / asked : 1;
    if (Math.abs(scale - 1) > 0.01) {
      host.style.setProperty("transform", `scale(${(1 / scale).toFixed(4)})`, "important");
      host.style.setProperty("transform-origin", "top right", "important");
    } else {
      host.style.removeProperty("transform-origin");
    }
  }

  // --- lifecycle ----------------------------------------------------------------

  /* Study mode is one setting shared by every tab, because it is a way of
   * watching rather than something done once per page. Presence is not: a rail
   * belongs on the page being watched and nowhere else.
   *
   * Reported as the rail appearing on unrelated pages while a film played in
   * another tab - which is exactly what the old code did, since it built the
   * rail wherever the content script loaded with the setting on. The comment
   * there already claimed "attaching a subtitle later is what makes it
   * visible"; it just was not true.
   *
   * A subtitle being attached is the right test rather than a video being
   * present. Study mode reads cues - it marks words in them, saves lines out of
   * them, translates against the other one - so with nothing attached there is
   * nothing for it to do, whatever else is on the page. */
  let present = false;

  function studiable() {
    return Boolean(api.status?.().attached);
  }

  async function syncPresence() {
    const wanted = settings.enabled && studiable();
    if (wanted === present) return;
    present = wanted;
    if (wanted) await turnOn();
    else turnOff();
  }

  async function setEnabled(on) {
    updateSettings({ enabled: Boolean(on) });
    // Turning study on with the rail put away from a previous session would
    // look like nothing happened.
    if (settings.enabled && !settings.showRail) updateSettings({ showRail: true });

    await syncPresence();

    if (!settings.enabled) {
      api.showToast("Study mode off");
    } else if (!studiable()) {
      // Honest rather than silent: the switch is on and nothing appeared,
      // and the reason is that there is no subtitle on this page yet.
      api.showToast("Study mode on — attach a subtitle to see it");
    } else {
      api.showToast(
        settings.auto
          ? "Study mode on — rare words appear at the side"
          : "Study mode on — hover a word to look it up",
      );
    }
  }

  async function turnOn() {
    if (!host) await build();
    reparent();
    setStudyFlag(true);
    await loadSavedTerms();
    refreshCount();
    // The line already on screen was rendered before study mode existed, so it
    // has no words in it. Force it through again.
    api.redrawCues?.();
  }

  function turnOff() {
    /* Dropped, not hidden, and the reference dropped with it. Removing the
     * element alone was not enough: content.js calls reparent() on every
     * fullscreen change and every time the CC handle is revealed, and reparent
     * re-appends whatever host it is holding - so the rail came back on the
     * next mouse movement. */
    host?.remove();
    host = null;
    shadow = null;
    railEl = listEl = countEl = noteEl = clearEl = foldEl = null;
    // The popup goes the same way and for the same reason: a live reference to
    // a removed element is what brought the rail back on the next mouse
    // movement, and a second host would do it a second time.
    popupHost?.remove();
    popupHost = null;
    popupShadow = null;
    popupEl = null;
    popupTerm = "";
    hoveredWord = null;
    clearTimeout(hoverTimer);
    cards = [];
    // Words stay wrapped in whatever line is on screen, which is harmless -
    // the next cue rebuilds the box - but the marks have to go.
    for (const span of current.words) {
      span.dataset.rare = "false";
      span.dataset.selected = "false";
    }
    setStudyFlag(false);
  }

  /* Tells the overlay's stylesheet that words are targets now, which is what
   * changes the cursor over the subtitle from "grab" to "read". */
  function setStudyFlag(on) {
    for (const root of api.overlayRoots?.() || []) {
      root.dataset.study = on ? "true" : "false";
    }
  }

  const toggle = () => {
    setEnabled(!settings.enabled);
    return true;
  };

  document.addEventListener("pointerover", onPointerOver, { passive: true, capture: true });
  window.addEventListener("resize", clampIntoView, { passive: true });

  window.__ssoStudy = {
    onCue,
    claimPointerDown,
    reparent,
    rescale,
    toggle,
    saveTop,
    setEnabled,
    updateSettings,
    settings: () => ({ ...settings }),
    defaults: DEFAULT_SETTINGS,
  };

  loadSettings().then(() => {
    /* Study mode survives a reload and reaches every tab, because it is a way
     * of watching rather than a thing you do once. What arriving here does NOT
     * do is put a rail on the page: that waits for a subtitle to be attached,
     * so the setting being on in the tab playing a film does not decorate the
     * other nine. Attaching later brings it up, which is what makes this a
     * subscription rather than a one-off check. */
    api.subscribe?.(() => {
      syncPresence();
    });
    syncPresence();
  });

  window.__ssoStudyTeardown = () => {
    document.removeEventListener("pointerover", onPointerOver, { capture: true });
    window.removeEventListener("resize", clampIntoView);
    clearTimeout(hoverTimer);
    host?.remove();
    host = null;
    shadow = null;
    popupHost?.remove();
    popupHost = null;
    popupShadow = null;
    popupEl = null;
    cards = [];
    delete window.__ssoStudy;
    delete window.__ssoStudyTeardown;
  };
})();
