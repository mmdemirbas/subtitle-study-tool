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
    /* Which subtitles are the languages being learnt. Everything not in here is
     * context: still on screen, still quoted on a saved card, just not marked
     * and not looked up.
     *
     * A set rather than one slot, because a reader can be working on two
     * languages at once. Empty is not a state it rests in - unmarking the last
     * one turns study off, so "study nothing" and the switch cannot disagree
     * about whether the words under the pointer are live. */
    studySlots: [0],
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
  let settingsEl = null;
  let setEls = null;
  let keyEls = null;
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
      settings = { ...DEFAULT_SETTINGS, ...migrate(stored[SETTINGS_KEY] || {}) };
    } catch {
      // Defaults are fine.
    }
    applySettings();
  }

  /* Every frame keeps its own copy of these, and storage is what makes the
   * copies agree.
   *
   * Study is one setting shared by the whole browser, but this file runs in
   * every frame of every page, so "shared" was only true at load. A switch
   * thrown in one frame wrote storage and changed nothing anywhere else -
   * measured on a player nested three documents deep, in fullscreen: the panel
   * is drawn in the top frame, the film is at the bottom, and pressing study
   * set enabled=true in a frame with no subtitle in it. Nothing was built,
   * nothing appeared, and the toast said it had worked. Reported as "I cannot
   * see the study panel".
   *
   * A storage listener is the general answer rather than another relay: it
   * covers the panel, the keyboard and any future caller at once, and it does
   * not care which frame holds the film or whether the two are split at all.
   * Our own writes are counted rather than compared, and that is the second
   * version of this. Comparing the event's value against the last thing we
   * wrote looks right and is wrong the moment two writes go out together -
   * which they routinely do, since marking a subtitle writes the marks and
   * then writes showRail. By the time the FIRST event arrives the guard holds
   * the second value, so the frame does not recognise its own write, adopts
   * the older one, and study is torn down and rebuilt for nothing. It cost 26
   * harness cases. Chrome emits one event per set() that touches the key, in
   * write order, so counting them out is exact where comparing is not. */
  let selfWrites = 0;

  function adoptSettingsFrom(stored) {
    if (selfWrites > 0) {
      selfWrites--;
      return;
    }
    if (!stored || JSON.stringify(stored) === JSON.stringify(settings)) return;
    const was = settings.enabled;
    settings = { ...DEFAULT_SETTINGS, ...migrate(stored) };
    applySettings();
    // Only the switch changes what exists; everything else is appearance, and
    // applySettings has already dealt with it.
    if (settings.enabled !== was) api.detached?.(syncPresence(), "Study mode");
    api.notifyChanged?.();
  }

  const onStorageChanged = (changes, area) => {
    if (area !== "local" || !changes[SETTINGS_KEY]) return;
    adoptSettingsFrom(changes[SETTINGS_KEY].newValue);
  };
  chrome.storage.onChanged.addListener(onStorageChanged);

  /* `studySlot` was one number until study could follow more than one subtitle.
   * A reader who had pointed it at the second one keeps it pointed there, and
   * the old key is dropped rather than left to be read by something later. It
   * runs on the stored patch, not on the merged settings, because after the
   * merge the new key is always present and the old one would never be seen. */
  function migrate(stored) {
    const { studySlot, ...rest } = stored;
    if (!Array.isArray(rest.studySlots) && Number.isInteger(studySlot)) {
      rest.studySlots = [studySlot];
    }
    return rest;
  }

  /* Empty and off are the same state said two ways, so neither can be reached
   * without the other - and now in both directions.
   *
   * Unmarking the last subtitle IS switching study off, and switching study on
   * with nothing marked marks the first attached subtitle, because a feature
   * that is on and visibly doing nothing reads as broken. Marking a subtitle is
   * the same statement from the other end, so it switches study on.
   *
   * That third case is what let the panel's Study button go. It named no
   * subtitle, and the per-subtitle chip beside it was hidden until study was
   * already on - so a reader with study off had a switch that could not say
   * which subtitle, and a subtitle mark they could not see. One control says
   * both now, and this is the one place that rule lives. */
  /* Which side was thrown decides which side follows.
   *
   * Getting this wrong makes the feature unswitchable, and it did: a first
   * version read only the merged state, so "marked means on" fired on the very
   * call that was trying to switch study off - the marks were still there, so
   * enabled was put straight back to true. The harness caught it as "study
   * would not switch off". `patch.enabled` is the distinction, and it has to be
   * tested for `true`/`false` rather than for truthiness, because absent and
   * false are the two different cases this whole function turns on. */
  function slotsAndSwitchAgree(patch) {
    const next = { ...settings, ...patch };
    const marked = Array.isArray(next.studySlots) && next.studySlots.length > 0;

    // The switch was thrown, so the marks follow it.
    if (patch.enabled === true) return marked ? {} : { studySlots: [firstAttachedSlot()] };
    if (patch.enabled === false) return { studySlots: [] };

    // The marks were changed, so the switch follows them.
    if (marked) return next.enabled ? {} : { enabled: true };
    return next.enabled ? { enabled: false } : {};
  }

  function firstAttachedSlot() {
    for (let slot = 0; slot < (api.trackCount || 0); slot++) {
      if (api.trackInfo(slot).fileId != null) return slot;
    }
    return 0;
  }

  /* A subtitle added to the list has a line on screen already, and a change
   * that does nothing until the next line reads as one that did not work - the
   * same reason turning study on redraws. The record for a subtitle no longer
   * followed goes with it: its words are about to be replaced by a render that
   * will not wrap them, and a stale record would keep answering for them. */
  /* Dropping the record unmarks its words first, and that order is the whole
   * of it. The marks are undone by walking `lines`, so a record deleted before
   * the walk takes the only way of finding them with it - the words stay amber
   * over the film until the next cue happens to replace them.
   *
   * It only became reachable when switching study off started clearing the
   * marked subtitles too (see slotsAndSwitchAgree): that clears every slot, so
   * every line was deleted here, and turnOff then had nothing left to walk.
   * Caught by the harness as "words are still marked". Unmarking belongs where
   * the record is dropped rather than in the caller, because there are now two
   * callers and either could be the one that empties it. */
  function followedSubtitlesChanged() {
    for (const slot of [...lines.keys()]) {
      if (isStudied(slot)) continue;
      for (const span of lines.get(slot)?.words || []) {
        span.dataset.rare = "false";
        span.dataset.selected = "false";
      }
      lines.delete(slot);
    }
    if (latestSlot != null && !isStudied(latestSlot)) latestSlot = studiedSlots()[0] ?? null;
    if (settings.enabled) api.redrawCues?.();
  }

  /* One call rather than the panel doing the array arithmetic, because "empty
   * is off" has to hold in exactly one place. A second copy of that rule in
   * another file is how the two come to disagree.
   *
   * It builds and tears down the rail as well, and has to: marking a subtitle
   * now switches study on, and a switch that changes the setting without
   * building anything is a switch that reads as broken. That work lived in
   * setEnabled alone, which was the only door to it while the panel had a
   * separate Study button. Both doors lead to the same room. */
  async function toggleStudySlot(slot) {
    const next = isStudied(slot)
      ? studiedSlots().filter((studied) => studied !== slot)
      : [...studiedSlots(), slot].sort((a, b) => a - b);
    const was = settings.enabled;
    updateSettings({ studySlots: next });
    // Turning study on with the rail put away from a previous session would
    // look like nothing happened. Same reason as in setEnabled.
    if (settings.enabled && !settings.showRail) updateSettings({ showRail: true });
    await syncPresence();
    if (settings.enabled !== was) sayWhatStudyIsDoing();
    return settings;
  }

  function updateSettings(patch) {
    const was = studiedSlots().join(",");
    settings = { ...settings, ...patch, ...slotsAndSwitchAgree(patch) };
    // Counted before the write, so the event it raises is spent on the way
    // back in rather than being mistaken for another frame's.
    selfWrites += 1;
    chrome.storage.local.set({ [SETTINGS_KEY]: settings }).catch(() => {
      // No write, no event to spend.
      selfWrites = Math.max(0, selfWrites - 1);
    });
    applySettings();
    if (studiedSlots().join(",") !== was) followedSubtitlesChanged();
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
      setHostVisible(host, settings.showRail);
    }
    if (railEl) {
      railEl.dataset.auto = settings.auto ? "true" : "false";
      railEl.dataset.folded = settings.folded ? "true" : "false";
      railEl.style.setProperty("--sso-study-text", `${settings.textPx}px`);
      railEl.style.setProperty("--sso-study-alpha", String(settings.opacity));
      /* 0 is "as tall as its contents", which is not a height any element can
       * be given - it is the absence of one. Anything else came from a corner
       * being dragged, and is applied as a real height rather than a cap: a box
       * that springs back to its contents cannot be made bigger than them. */
      railEl.dataset.sized = settings.height > 0 ? "true" : "false";
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
  function wrapWords(cueBox, slot) {
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
        /* Which subtitle it came out of, carried on the word itself. With more
         * than one subtitle being studied, "the language of the line" and "the
         * line to quote on the card" are different answers for two words on
         * screen at the same time, and the word is the only thing that knows
         * which. */
        span.dataset.slot = String(slot);
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

  /* What is on screen right now, one record per studied subtitle, so a hover, a
   * save or a threshold change can all answer "which line is this word in"
   * without going back to the cue list.
   *
   * A map rather than the single record this was, because the lines arrive in
   * separate calls and neither replaces the other. Held as one, the second
   * subtitle's cue wiped the first's words the moment it landed, and every word
   * still on screen from the first stopped answering. */
  const lines = new Map();
  /* Which line a keypress belongs to: the one that arrived most recently. Only
   * a fallback - anything holding a word asks the word, which knows. */
  let latestSlot = null;
  let lineSeq = 0;

  const allWords = () => [...lines.values()].flatMap((line) => line.words);
  const lineOf = (span) => lines.get(Number(span?.dataset.slot));
  const isStudied = (slot) => (settings.studySlots || []).includes(slot);

  function onCue(slot, cue, cueBox) {
    if (!settings.enabled || !isStudied(slot)) return;

    /* The words this line was anchored to are about to be replaced, so an
     * answer left on screen would be pointing at nothing. Scoped to this line:
     * the other subtitle's cue ending is no reason to take down a popup opened
     * on a word that is still there. */
    const going = lines.get(slot);
    if (going && hoveredWord && going.words.includes(hoveredWord)) {
      hoveredWord = null;
      hidePopup();
    }
    if (going && selection && going.words.includes(selection.anchor)) clearSelection();

    const line = { slot, cue, cueBox, words: [], token: ++lineSeq };
    lines.set(slot, line);
    if (!cue) return;

    latestSlot = slot;
    line.words = wrapWords(cueBox, slot);
    markWords(line);
  }

  function remarkCurrent() {
    if (!settings.enabled) return;
    for (const line of lines.values()) {
      if (line.cue && line.words.length) markWords(line);
    }
  }

  async function markWords(line) {
    const language = studyLanguage(line.slot);
    const candidates = [...new Set(line.words.map((span) => span.dataset.w))].filter(
      (word) => letterCount(word) >= settings.minLetters,
    );
    const ranks = await ranksFor(candidates, language);
    // The line changed while the ranks were in flight; marking now would put
    // the previous line's answers on this one's words. Study being switched off
    // in that same window is the other way this arrives too late - the words it
    // would mark have been unwrapped, and the rail it would fill is gone.
    if (lines.get(line.slot) !== line || !settings.enabled) return;

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

    /* Nothing to build when the rail is not on screen.
     *
     * The hover path carries this guard and says why - "adding to a list nobody
     * can see would only spend lookups" - and the automatic path, which is the
     * one that runs on every line of the film, did not. Measured with the rail
     * put away: cards built into a host at display:none and 0px wide, and a
     * dictionary lookup spent on a word nobody could read. */
    if (!settings.auto || !settings.showRail || rare.length === 0) return;
    /* Rarest first, then capped. When a line has more unfamiliar words than
     * fit, the rarest are the ones a reader is least likely to have got from
     * context. */
    rare.sort((a, b) => (b.rank ?? Infinity) - (a.rank ?? Infinity));
    for (const item of rare.slice(0, settings.maxPerCue)) {
      addCard(item.word, { rank: item.rank, language, auto: true, slot: line.slot });
    }
  }

  /* Languages the worker has no frequency table for.
   *
   * rank() answers those with nothing at all, and "answered, and this word is
   * not in it" has to stay distinguishable from "no opinion" - so there is no
   * per-word value to cache and the cache could never fill. Measured over eight
   * cue changes with an untabled language: nine round trips to the worker, the
   * same four words asked twice inside the run, and nothing ever marked. It
   * would have gone on for the whole film.
   *
   * A language rather than a word, because the answer is a property of the
   * language. Not persisted: a table can arrive with the next version, and one
   * probe per session is nothing. */
  const untabled = new Set();

  async function ranksFor(words, language) {
    const known = new Map();
    const missing = [];
    for (const word of words) {
      const key = `${language}:${word}`;
      if (rankCache.has(key)) known.set(word, rankCache.get(key));
      else missing.push(word);
    }
    if (missing.length === 0 || untabled.has(language)) return known;

    const response = await api.daemon("rank", { words: missing, language });
    const ranks = response?.ranks || {};
    /* Nothing back for a request that named words is the table being absent -
     * a language that has one always answers for every word it was asked
     * about, with null for the ones it does not hold. */
    if (Object.keys(ranks).length === 0) {
      untabled.add(language);
      emptyNote();
      return known;
    }
    for (const word of missing) {
      // A language with no table answers with nothing at all, which has to stay
      // distinguishable from "answered, and this word is not in it".
      const value = Object.prototype.hasOwnProperty.call(ranks, word) ? ranks[word] : undefined;
      if (value === undefined) continue;
      /* At the limit the oldest goes, rather than the cache closing to new
       * words. It used to stop writing once full, which turns the bound into a
       * cliff: from that word on, every line pays a message round trip to the
       * worker for words it has already asked about. A Map iterates in
       * insertion order, so its first key is the least recently added. */
      if (rankCache.size >= RANK_CACHE_LIMIT) {
        rankCache.delete(rankCache.keys().next().value);
      }
      rankCache.set(`${language}:${word}`, value);
      known.set(word, value);
    }
    return known;
  }

  /* The language of one studied subtitle. `settings.language` still overrides
   * it, for the file whose own language tag is wrong or missing - it is a
   * correction, so it applies wherever the tag would have been read. */
  function studyLanguage(slot = latestSlot ?? studiedSlots()[0] ?? 0) {
    return (settings.language || api.trackInfo(slot).language || "en")
      .toLowerCase()
      .slice(0, 2);
  }

  /** The studied subtitles, lowest first, so anything reading "the first" agrees. */
  const studiedSlots = () => [...(settings.studySlots || [])].sort((a, b) => a - b);

  // --- pointer ------------------------------------------------------------------

  /* content.js offers every press on a cue box here first. Taking one means the
   * box will not be dragged and the click will not reach the player, so only
   * the two gestures that are unambiguously about a word are taken. */
  function claimPointerDown(slot, event) {
    if (!settings.enabled || !isStudied(slot)) return false;
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

  /* The press being watched for a tap, so its release can be claimed.
   *
   * content.js offers every release here before handing the click to the
   * player underneath. Without that, a tap on a word did both: the word was
   * pinned and the film played or paused. See claimPointerUp. */
  let pendingTap = null;

  function watchTap(word, down) {
    const start = { x: down.clientX, y: down.clientY };
    let moved = false;
    pendingTap = { pointerId: down.pointerId, moved: false };

    const detach = () => {
      document.removeEventListener("pointermove", onMove, true);
      document.removeEventListener("pointerup", onUp, true);
      document.removeEventListener("pointercancel", onUp, true);
    };
    const onMove = (event) => {
      /* No button held means the press ended somewhere this never heard about -
       * swallowed by the page, capture taken, alt-tab. Without this the pair of
       * listeners outlived the gesture and the NEXT pointerup anywhere on the
       * page pinned this word. Same shape as the stale drag on the timeline
       * strip, and the same guard every other drag in this extension carries.
       * Detached without pinning: a press whose end was never seen is not a
       * completed tap. */
      if (event.buttons === 0) {
        detach();
        // Not a completed tap, so it is not this file's to claim either - the
        // film should still get the click if content.js decides to forward one.
        pendingTap = null;
        return;
      }
      if (Math.abs(event.clientX - start.x) > 4 || Math.abs(event.clientY - start.y) > 4) {
        moved = true;
        if (pendingTap) pendingTap.moved = true;
      }
    };
    /* Left for claimPointerUp to consume rather than cleared here. This runs
     * on the document in the capture phase, which is BEFORE the cue box's own
     * pointerup handler - so clearing it now would leave content.js nothing to
     * ask by the time it asks. */
    const onUp = () => {
      detach();
      if (!moved) pinWord(word);
    };

    document.addEventListener("pointermove", onMove, true);
    document.addEventListener("pointerup", onUp, true);
    document.addEventListener("pointercancel", onUp, true);
  }

  /* Was that release a tap on a word?
   *
   * Answered for content.js, which asks before forwarding the click to the
   * player. True means this file has dealt with it: the word is pinned, and
   * the film must not also play or pause because a word was looked at. A press
   * that moved is a drag of the subtitle box and its click was never ours.
   *
   * Consumed on the way out, so one press can only ever be claimed once. */
  function claimPointerUp(slot, event) {
    if (!settings.enabled || !isStudied(slot)) return false;
    const tap = pendingTap;
    if (!tap || tap.pointerId !== event.pointerId) return false;
    pendingTap = null;
    return !tap.moved;
  }

  /* The rank the word was marked with, as the card wants it: a number, null for
   * "not in the table at all", or undefined when nothing ranked it. */
  function rankOf(word) {
    if (!("rank" in word.dataset)) return undefined;
    return word.dataset.rank === "" ? null : Number(word.dataset.rank);
  }

  function pinWord(word) {
    const slot = Number(word.dataset.slot);
    addCard(word.dataset.w, {
      pinned: true,
      rank: rankOf(word),
      language: studyLanguage(slot),
      slot,
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

    const detach = () => {
      document.removeEventListener("pointermove", onMove, true);
      document.removeEventListener("pointerup", onUp, true);
      document.removeEventListener("pointercancel", onUp, true);
    };
    const onMove = (moveEvent) => {
      /* The press ended without this hearing about it. Left attached, the sweep
       * kept painting a selection on every mouse move and the next pointerup
       * anywhere saved a phrase nobody asked for. See watchTap above. */
      if (moveEvent.buttons === 0) {
        detach();
        clearSelection();
        return;
      }
      const over = moveEvent.composedPath?.()[0];
      if (over?.classList?.contains?.("sso-w")) {
        selection.focus = over;
        paintSelection();
      }
    };
    const onUp = () => {
      detach();
      const phrase = selectedWords()
        .map((span) => span.textContent)
        .join(" ")
        .trim();
      const slot = Number(selection?.anchor?.dataset.slot);
      clearSelection();
      if (phrase) {
        addCard(phrase.toLowerCase(), { pinned: true, language: studyLanguage(slot), slot });
      }
    };

    document.addEventListener("pointermove", onMove, true);
    document.addEventListener("pointerup", onUp, true);
    document.addEventListener("pointercancel", onUp, true);
  }

  /* Within one line. A sweep that leaves the subtitle it started in is not a
   * phrase - two languages' words in one card would be neither. */
  function selectedWords() {
    if (!selection) return [];
    const words = lineOf(selection.anchor)?.words || [];
    const from = words.indexOf(selection.anchor);
    const to = words.indexOf(selection.focus);
    if (from === -1 || to === -1) return [selection.anchor];
    return words.slice(Math.min(from, to), Math.max(from, to) + 1);
  }

  function paintSelection() {
    const chosen = new Set(selectedWords());
    for (const span of allWords()) {
      span.dataset.selected = chosen.has(span) ? "true" : "false";
    }
  }

  function clearSelection() {
    for (const span of allWords()) span.dataset.selected = "false";
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
      const slot = Number(word.dataset.slot);
      const language = studyLanguage(slot);
      if (settings.hoverCard) api.detached(showPopup(word, term, language), "That lookup");
      // With the rail put away the popup is the whole answer; adding to a list
      // nobody can see would only spend lookups.
      if (settings.showRail) api.detached(addCard(term, { rank: rankOf(word), language, slot }), "That word");
    }, settings.dwellMs);
  }

  // --- the answer beside the word -----------------------------------------------

  async function buildPopup() {
    if (popupHost) return;
    popupHost = document.createElement("div");
    // The word popup is chrome as well; a click in it must not reach the player.
    api.keepPointersInside?.(popupHost);
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

    const entry = await lookUp(term, language, Number(word.dataset.slot));
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
    /* A press on the rail is not a press on the film - the rail is built
     * inside the player's own element. See keepPointersInside in content.js. */
    api.keepPointersInside?.(host);
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
    gearEl.addEventListener("click", () => api.detached(openRailSettings(), "Study settings"));

    head.append(title, countEl, clearEl, gearEl, foldEl, close);

    listEl = document.createElement("div");
    listEl.className = "sso-rail__list";

    noteEl = document.createElement("p");
    noteEl.className = "sso-rail__note";

    railEl.append(head, listEl, noteEl);
    shadow.append(railEl);

    /* Connected before anything tries to promote it. toTopLayer refuses a node
     * that is not in the document, so a host that first met the document inside
     * reparent() fell through to the append - and while a player had
     * fullscreened the <video>, that put the rail inside a replaced element
     * where it is never painted. Same defect the control panel had, same fix;
     * both hosts were built the same way. */
    (api.paintableParent?.() || document.body || document.documentElement).append(host);

    /* The whole rail is a handle, not only its bar - the same as the control
     * panel. A press on a word or a meaning still selects the text: the grab
     * only takes elements that carry no words of their own. */
    makeDraggable(railEl, head);
    makeResizable();
    await restorePosition();
    applySettings();
    // Now that it has a box, and not before. See restorePosition.
    clampIntoView();
    return host;
  }

  /* Two sheets. chrome.css carries what makes this a window and the control
   * panel adopts the same one, which is what keeps the two floating surfaces
   * speaking one language; study.css goes second so it can override any of it. */
  /* How study works, in a window of its own.
   *
   * It was a second face of the rail, which meant the rail's own width decided
   * how much room eight settings had, and getting back to the words was a
   * button rather than being done with it. The control panel's settings moved
   * out for the same reasons; these follow.
   *
   * Built on first use and kept, so its size and place survive within a session
   * as well as between them. */
  let settingsWindow = null;

  async function openRailSettings() {
    if (!settingsWindow) {
      settingsWindow = api.makeWindow({
        title: "How study works",
        sheets,
        storeKey: "sso:studySettingsWindow",
        width: 340,
        height: 300,
        // The rail's own colours: warm surface, amber accent.
        accent: "#e0a458",
        accentInk: "#d8a86a",
        surface: "rgba(22, 19, 16, 0.98)",
      });
      settingsEl = buildRailSettings();
      settingsWindow.body.append(settingsEl);
    }
    await settingsWindow.show(host);
    refreshRailSettings();
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

    /* Study's two key bindings, with study's other settings.
     *
     * They were in the control panel's Keys grid, which is where the bindings
     * for timing and for the panel itself live - and nothing else about study
     * is on that surface any more. A binding belongs with the thing it does.
     *
     * The keystroke is read by content.js, which owns the settings and already
     * has to stop a key being read from also doing what it is bound to. */
    const keys = document.createElement("div");
    keys.className = "sso-set__keys";
    keyEls = {};
    for (const [name, label] of [["toggleStudy", "Study mode"], ["saveWord", "Save the top word"]]) {
      const said = document.createElement("span");
      said.textContent = label;

      const b = document.createElement("button");
      b.className = "sso-set__key";
      b.type = "button";
      b.title = "Click, then press the key you want";
      b.addEventListener("click", async () => {
        b.dataset.capturing = "true";
        b.textContent = "press a key…";
        const key = await api.captureKey();
        b.dataset.capturing = "false";
        if (key) api.updateSettings({ keys: { [name]: key } });
        refreshRailSettings();
      });

      const clear = document.createElement("button");
      clear.className = "sso-set__key sso-set__key--clear";
      clear.type = "button";
      clear.textContent = "⌫";
      clear.title = `Switch "${label}" off`;
      clear.setAttribute("aria-label", `Switch "${label}" off`);
      clear.addEventListener("click", () => {
        api.updateSettings({ keys: { [name]: "" } });
        refreshRailSettings();
      });

      const cell = document.createElement("div");
      cell.className = "sso-set__keycell";
      cell.append(b, clear);
      keys.append(said, cell);
      keyEls[name] = { b, clear };
    }
    wrap.append(keys);

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

  /* What to print on the key: the character the layout types, as it looks on
   * the keyboard. It used to print KeyboardEvent.code. */
  function describeKey(key) {
    if (!key) return "off";
    const named = { " ": "space", ArrowLeft: "←", ArrowRight: "→", ArrowUp: "↑", ArrowDown: "↓" };
    return named[key] || (key.length === 1 ? key.toUpperCase() : key);
  }

  /* Written whenever the settings change, so the screen agrees with the rail
   * even when something else moved a value - a corner drag setting the text
   * size, or the panel's master switch. */
  function refreshRailSettings() {
    if (keyEls) {
      const bound = api.status().settings.keys;
      for (const [name, { b, clear }] of Object.entries(keyEls)) {
        if (b.dataset.capturing === "true") continue; // it is asking, leave it asking
        b.textContent = describeKey(bound[name]);
        b.dataset.set = bound[name] ? "true" : "false";
        clear.hidden = !bound[name];
      }
    }
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

  /* Visibility is an explicit display, not the `hidden` attribute.
   *
   * The host carries `all: initial !important` inline to stop the page's
   * inherited properties crossing into the shadow tree - and `all` includes
   * display, so the host has `display: inline !important` on it. The UA rule
   * behind the `hidden` attribute is `[hidden] { display: none }`, an author
   * rule of the lowest possible weight, and it cannot beat an inline
   * !important. So `host.hidden = true` set the attribute, changed the
   * setting, and left the rail exactly where it was: the close button did
   * nothing at all. The panel's host learned this; this one had not.
   *
   * The attribute is still set, because other code and the tests ask. */
  function setHostVisible(node, visible) {
    node.style.setProperty("display", visible ? "block" : "none", "important");
    node.hidden = !visible;
  }

  /* Unstyled beats absent - the same reason panel.js catches here. The fetch
   * fails when the extension is reloaded under an open tab, and letting it
   * reject took build() with it, then turnOn(), then syncPresence(), which is
   * called from a subscription that cannot catch anything: the rail silently
   * stopped appearing and the only trace was an unhandled rejection. */
  async function loadStyles() {
    if (sheets) return sheets;
    const files = ["src/chrome.css", "src/study.css"];
    const texts = await Promise.all(
      files.map((file) =>
        fetch(chrome.runtime.getURL(file))
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

  function emptyNote() {
    if (!noteEl) return;
    const empty = cards.length === 0;
    noteEl.hidden = !empty;
    /* Honest about the one case where nothing will ever appear.
     *
     * Rarity marking ships a table per language, and for anything else the
     * answer is "no opinion" - which is right, and on screen it is a rail
     * promising that rare words will turn up, staying empty for two hours,
     * with nothing anywhere saying why. Hovering still answers, so the
     * sentence says what does work rather than only what does not. */
    const language = studyLanguage();
    if (untabled.has(language)) {
      noteEl.textContent =
        `No word-frequency list for ${language.toUpperCase()}, so nothing is marked ` +
        `automatically. Hover a word to look it up; shift-drag for a phrase.`;
      return;
    }
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
  async function addCard(
    term,
    { rank = undefined, language, pinned = false, auto = false, slot = latestSlot } = {},
  ) {
    /* Guarded on the list, which is what this actually writes into, rather than
     * on the host. They are not the same question: ranking a line is a round
     * trip to the worker, and study can be turned off while one is in flight -
     * observed as `Cannot read properties of null (reading 'prepend')` from
     * markWords, twice, while switching study off and on again. */
    if (!term || !listEl) return null;

    const existing = cards.find((card) => card.term === term && card.language === language);
    if (existing) {
      if (pinned) existing.pinned = true;
      promote(existing);
      return existing;
    }

    const from = Number.isInteger(slot) ? slot : studiedSlots()[0] ?? 0;
    const cue = api.cueAt(from);
    const card = {
      id: ++cardSeq,
      term,
      language,
      rank,
      pinned,
      auto,
      slot: from,
      sentence: cue?.text || "",
      paired: pairedLines(from),
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

    card.lookup = await lookUp(term, language, from);
    if (card.node?.isConnected) redrawCard(card);
    return card;
  }

  /* One place both the rail and the hover popup ask through, and one place the
   * target language is decided: the other subtitle's, because that is the
   * language the reader has already chosen to read this film in. */
  const lookupCache = new Map();

  async function lookUp(term, language, slot) {
    const target = translationTarget(slot);
    const key = `${language}>${target}:${term}`;
    if (lookupCache.has(key)) return lookupCache.get(key);

    /* A transportError is an answer now, not a rejection, so it needs reading
     * here or it arrives as an entry with no definitions and no translation and
     * the popup says "nothing found for that word" about a word it never asked
     * about. The catch stays for anything else that can go wrong. */
    const pending = api
      .daemon("lookup", { query: term, language, target })
      .then((response) => {
        if (!response) return { definitions: [], unavailable: "Lookup failed." };
        if (response.transportError) {
          return { definitions: [], unavailable: `Lookup failed - ${response.transportError}` };
        }
        return response;
      })
      .catch(() => ({ definitions: [], unavailable: "Lookup failed." }));
    lookupCache.set(key, pending);
    const settled = await pending;
    // Hold the value rather than the promise, and do not hold a failure: a
    // lookup that failed because the daemon was starting should be asked again.
    if (settled.definitions?.length || settled.translation) lookupCache.set(key, settled);
    else lookupCache.delete(key);
    return settled;
  }

  /* What to translate into: an attached subtitle the reader is NOT studying,
   * because that is the language they have already chosen to read this film in.
   *
   * It was "slot 0 or slot 1, whichever is not the studied one", which had the
   * right instinct and only two seats for it. With every attached subtitle
   * being studied there is no such language, and the lookup then answers with
   * definitions and no translation - which is honest, rather than translating a
   * language into itself. */
  function translationTarget(slot) {
    for (let other = 0; other < (api.trackCount || 0); other++) {
      if (other === slot || isStudied(other)) continue;
      const language = (api.trackInfo(other).language || "").toLowerCase().slice(0, 2);
      if (language) return language;
    }
    return "";
  }

  /* Every other subtitle's line at this exact moment. For a learner this is the
   * single most useful thing on the screen and it costs nothing to fetch: the
   * sentence, already translated by a human, already timed to the same frame.
   *
   * A list rather than "the other one", because with two subtitles being
   * studied there is no such thing as the other one. Whether a line is itself
   * being studied does not come into it - the same moment in another language
   * is worth keeping either way. */
  function pairedLines(slot) {
    const out = [];
    for (let other = 0; other < (api.trackCount || 0); other++) {
      if (other === slot) continue;
      const text = api.cueAt(other)?.text;
      if (text) out.push({ text, language: api.trackInfo(other).language || "" });
    }
    return out;
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
    if (clearEl) clearEl.hidden = cards.length === 0;
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
      // Every other subtitle's line at that moment, in slot order, so a card
      // from a three-language screen reads down the languages the same way the
      // screen does.
      for (const line of card.paired || []) {
        node.append(sentenceLine(line.text, "", "sso-card__paired", line.language));
      }
    }

    const actions = document.createElement("div");
    actions.className = "sso-card__actions";

    const save = document.createElement("button");
    save.type = "button";
    save.className = "sso-card__save";
    save.textContent = card.saved ? "Saved" : "Save";
    save.disabled = card.saved;
    save.addEventListener("click", () => api.detached(saveCard(card), "Saving that word"));

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
    // The subtitle this word came out of, not "the studied one" - with two
    // being studied that names the wrong film file half the time.
    const info = api.trackInfo(card.slot ?? studiedSlots()[0] ?? 0);
    const response = await api.daemon("deckSave", {
      entry: {
        term: card.term,
        language: card.language,
        rank: card.rank ?? null,
        definitions: card.lookup?.definitions || [],
        phonetic: card.lookup?.phonetic || "",
        translation: card.lookup?.translation || "",
        sentence: card.sentence,
        paired: card.paired || [],
        title: filmTitle(card.slot),
        fileId: info.fileId,
        timeMs: card.timeMs,
        url: location.href,
      },
    });

    /* Only claim it once it has landed.
     *
     * background.js answers `{ transportError }` whenever deck.save throws - a
     * storage quota, a worker torn down mid-call - and that object carries no
     * `added`, so this used to fall through to "already saved" and then mark
     * the word as met. A word marked as met stops being underlined and stops
     * arriving in the rail, so the one the reader tried hardest to keep is the
     * one that quietly disappears. Two states were being reported as a third
     * that was true of neither. */
    const failed = !response || response.transportError || response.error;
    if (failed || (!response.added && !response.entry)) {
      const why = response?.transportError || response?.error || response?.reason || "no answer";
      api.showToast(`Could not save "${card.term}" - ${why}`);
      return false;
    }

    card.saved = true;
    savedTerms.add(`${card.language}:${card.term}`);
    redrawCard(card);
    remarkCurrent();
    api.showToast(
      response.added ? `Saved "${card.term}" with its line` : `"${card.term}" is already saved`,
    );
    return true;
  }

  /* The film this word came out of.
   *
   * `slot` matters for the same reason saveCard reads card.slot for the fileId
   * - with two subtitles being studied, "the first studied one" names the wrong
   * film half the time. That fix reached the id and not the title beside it, so
   * a card saved from the second subtitle carried the first one's label. */
  function filmTitle(slot) {
    const info = api.trackInfo(Number.isInteger(slot) ? slot : studiedSlots()[0] ?? 0);
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
  function makeDraggable(handle, head) {
    api.makeMovable(handle, {
      host,
      keepOnScreen: head,
      place: (x, y) => setPosition(`${x}px`, `${y}px`),
      onEnd: savePosition,
    });

    /* Double-click the title bar to send it back to its corner, the same
     * gesture the control panel has. Somewhere to put a thing you have dragged
     * into the way, without having to aim it back. */
    // On the bar only. Parking is a big move for a gesture that can happen by
    // accident, and a double-click anywhere in a list of words is an accident.
    head.addEventListener("dblclick", (event) => {
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
    /* And never off the edge of THIS viewport.
     *
     * The position is one stored value shared by every page, and the box it was
     * stored against is not the box it is restored into: the rail is built in
     * the frame that holds the film, which on a nested player is a fraction of
     * the window, and the same frame is the whole screen once the player goes
     * fullscreen. A rail dragged to the right-hand side of a 2056px fullscreen
     * session comes back at left: 1800 in a 1136px-wide player frame, which is
     * off the end of it - and it carries its own close and park controls, so it
     * is unreachable and unputtable-away at once. clampIntoView existed and ran
     * only on resize, which is the one moment this never happens on.
     *
     * Called by build() after applySettings rather than here: clamping measures
     * the box, and until applySettings has decided whether the rail is showing,
     * the box is 0x0 and the clamp returns without doing anything. */
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
  function reparent(parent, { raise = false } = {}) {
    if (!host) return;
    /* The top layer sits above the fullscreen element wherever the host is, so
     * when it works nothing moves. See toTopLayer in content.js: appending into
     * a fullscreen <video> puts the rail inside a replaced element, where it is
     * never painted and still reports itself open. */
    /* Only when nothing is fullscreen. Inside a fullscreen session the browser
     * hit-tests within the fullscreen element's subtree alone, so a rail in the
     * top layer is painted over the film and takes none of its own clicks. See
     * fullscreenHolder in content.js. */
    const raiseOne = (node) => node && api.toTopLayer?.(node, { again: raise });
    if (!parent && raiseOne(host) && (!popupHost || raiseOne(popupHost))) {
      rescale();
      return;
    }
    api.fromTopLayer?.(host);
    if (popupHost) api.fromTopLayer?.(popupHost);
    const target = parent || api.paintableParent?.() || document.body || document.documentElement;
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
    sayWhatStudyIsDoing();
  }

  /* What the switch just did, said once and from one place.
   *
   * Both ways in - the card's learn chip and the keyboard - end here, so the
   * two cannot come to describe the same state differently. The middle branch
   * is the one worth keeping: the switch is on and nothing appeared, and the
   * reason is that there is no subtitle on this page yet. Silence there reads
   * as a broken feature. */
  function sayWhatStudyIsDoing() {
    /* And written down, with the shape of the page attached.
     *
     * This is the entry that was missing. Two days of logs carry every study
     * toast and not one capture of the frames while study was on - both
     * toggles fell between two panel captures - so the rail's absence from
     * every capture said nothing at all, and the question "where was the rail
     * drawn" could not be answered without asking somebody to do it again.
     * Switching study on is exactly as interesting as opening the panel: it is
     * the moment a surface is supposed to appear, and which frame it appeared
     * in is the whole question. */
    api.trace?.(
      "study",
      {
        on: settings.enabled,
        slots: studiedSlots(),
        studiable: studiable(),
        railBuilt: Boolean(host),
        railBox: host ? (({ x, y, width, height }) => [
          Math.round(x), Math.round(y), Math.round(width), Math.round(height),
        ])(host.getBoundingClientRect()) : null,
      },
      { frames: true },
    );
    if (!settings.enabled) {
      api.showToast("Study mode off");
      return;
    }
    if (!studiable()) {
      api.showToast("Study mode on — attach a subtitle to see it");
      return;
    }
    api.showToast(
      settings.auto
        ? "Study mode on — rare words appear at the side"
        : "Study mode on — hover a word to look it up",
    );
  }

  async function turnOn() {
    if (!host) await build();
    /* Into the fullscreen element straight away, not on the next mouse move.
     *
     * A bare reparent() takes the top-layer path and returns without moving the
     * host anywhere, and inside a fullscreen session that leaves the rail
     * painted over the film and taking none of its own clicks - the browser
     * hit-tests within the fullscreen element's subtree alone. It was corrected
     * by the next pointermove, through attachToCorrectParent, which means the
     * rail was dead for as long as the reader sat still after switching study
     * on. Asking content.js for the holder is the same question it answers on
     * every fullscreen change; there is no reason to wait for a mouse. */
    reparent(api.fullscreenHolder?.() || null);
    setStudyFlag(true);
    await loadSavedTerms();
    refreshCount();
    // The line already on screen was rendered before study mode existed, so it
    // has no words in it. Force it through again.
    api.redrawCues?.();
  }

  function turnOff() {
    settingsWindow?.destroy();
    settingsWindow = null;
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
    for (const span of allWords()) {
      span.dataset.rare = "false";
      span.dataset.selected = "false";
    }
    lines.clear();
    latestSlot = null;
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
    api.detached(setEnabled(!settings.enabled), "Study mode");
    return true;
  };

  document.addEventListener("pointerover", onPointerOver, { passive: true, capture: true });
  window.addEventListener("resize", clampIntoView, { passive: true });

  window.__ssoStudy = {
    onCue,
    claimPointerDown,
    claimPointerUp,
    reparent,
    rescale,
    toggle,
    saveTop,
    setEnabled,
    updateSettings,
    toggleStudySlot,
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
      api.detached(syncPresence(), "The study rail");
    });
    api.detached(syncPresence(), "The study rail");
  });

  window.__ssoStudyTeardown = () => {
    document.removeEventListener("pointerover", onPointerOver, { capture: true });
    window.removeEventListener("resize", clampIntoView);
    /* Re-injection is expected, so a listener left behind is a second copy of
     * this file reacting to every settings write - and its `settings` and its
     * `host` are the previous instance's, which is how a rail that was torn
     * down comes back. */
    chrome.storage.onChanged.removeListener(onStorageChanged);
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
