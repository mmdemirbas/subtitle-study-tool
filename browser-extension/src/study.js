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
    /* Two at most per line. It was larger, and the surface became something to
     * read instead of something to glance at: words from four lines ago were
     * still arriving while new ones landed on top of them, so nothing was ever
     * the thing being looked at. The deck is where words go to be kept. */
    maxPerCue: 2,
    // Shortest word worth marking, in letters. Below three it is function
    // words and interjections, which are never the problem.
    minLetters: 3,
    /* Which subtitles are the languages being learnt. Everything not in here is
     * context: still on screen, still quoted on a saved card, just not marked
     * and not looked up.
     *
     * A set rather than one slot, because a reader can be working on two
     * languages at once. It cannot disagree with the switch - marked means
     * study is on, empty means it is off - and that is why this starts EMPTY
     * beside `enabled: false` rather than at [0].
     *
     * It was [0] with the switch off, which is the one pair the rule forbids,
     * and it made the first press of a subtitle's learn chip do the opposite of
     * what it says. Observed in a real browser on the nested-player vehicle:
     * subtitle 1 was already marked before anything was pressed, so the press
     * unmarked it, `slotsAndSwitchAgree` correctly kept study off, and the
     * reader who had just switched learning on got nothing on screen - reported
     * as "I cannot see any strips ... I've enabled learning for a language
     * already". Switching study on with nothing marked still marks the first
     * attached subtitle, so nothing is lost by starting empty. */
    studySlots: [],
    // Empty means "whatever language that subtitle is in".
    language: "",
    pauseOnPin: false,
    /* The focus box was set in 12px against a film, which is a size for a
     * settings page and not for something read at a glance in the dark while
     * something else is moving. */
    textPx: 15,
    dwellMs: 140,
    /* Which subtitles' trails are put away, by slot. Not one switch for all of
     * them, which is the reported bug: "Closing one study panel closes all.
     * Wrong." A trail belongs to one subtitle, so closing it is a statement
     * about that subtitle and about nothing else.
     *
     * Study itself stays on: the words are still marked in the line and the
     * focus box still answers. */
    trailOff: [],
    /* The one box that carries a whole entry. It can be put away too, leaving
     * the trails and the marks - which is the reading for someone who wants
     * the film with a strip of words under it and nothing else on screen. */
    showFocus: true,
    hoverCard: true,
    /* How solid the focus box is over the film. Dense text over a moving
     * picture needs a backing to be readable at all, so this stops well short
     * of invisible; the low end is for reading the frame through it. */
    opacity: 0.93,
  };

  /* How many words a trail holds before the oldest leaves.
   *
   * Not a setting. It was one - "Words kept", 1 to 12 - and the number that
   * matters is not how many are kept but how many are legible, which the
   * strip's own width decides: past eight the left-hand end is clipped by the
   * subtitle's width on every screen this was measured on, so a larger number
   * only moved words out of sight faster than they faded. */
  const TRAIL_KEEP = 8;

  /* Fixed, because a box holding one entry has a size that fits one entry. The
   * rail was resizable from all four corners and remembered a width and a
   * height, which is three settings and four grips spent on a surface whose
   * contents are always one word, its meaning and the line it was in. */
  const FOCUS_WIDTH = 320;

  let settings = { ...DEFAULT_SETTINGS };

  let host = null;
  let shadow = null;
  let railEl = null;
  let listEl = null;
  let countEl = null;
  let noteEl = null;
  let clearEl = null;
  let gearEl = null;
  let settingsEl = null;
  let setEls = null;
  let keyEls = null;
  let sheets = null;

  /* The words study mode has picked out, newest first. Held here rather than
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
      const stored = await api.readStored(SETTINGS_KEY);
      settings = settled({ ...DEFAULT_SETTINGS, ...migrate(stored[SETTINGS_KEY] || {}) });
    } catch {
      // Defaults are fine.
    }
    applySettings();
  }

  /* The switch and the marks, made to agree on the way IN.
   *
   * `slotsAndSwitchAgree` holds this rule for every change to the settings, and
   * that turned out to be half of it: a state that arrives already disagreeing
   * - from the defaults, from an installation that predates studySlots, from a
   * write by an older version - never passes through it, and every later
   * decision is then made against a contradiction. The switch is the coarser
   * statement, so it wins: study off means nothing is being learnt. */
  function settled(state) {
    const marked = Array.isArray(state.studySlots) && state.studySlots.length > 0;
    if (!state.enabled && marked) return { ...state, studySlots: [] };
    if (state.enabled && !marked) return { ...state, enabled: false };
    return state;
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
   * which they routinely do, since switching study on writes the switch and
   * then the trails. By the time the FIRST event arrives the guard holds
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
    settings = settled({ ...DEFAULT_SETTINGS, ...migrate(stored) });
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
  /* The same for the rail's own keys, now that what it drew is a trail under
   * each subtitle and one focus box. A reader who had put the rail away had
   * said something - "not on the picture, thank you" - and the nearest thing
   * this can still honour is to keep the focus box away; the trails are new
   * and arrive shown, because nothing was ever said about them. `keep`,
   * `focus`, `width`, `height` and `folded` describe a surface that no longer
   * exists, and are dropped rather than left for something later to read. */
  function migrate(stored) {
    const { studySlot, showRail, keep, focus, width, height, folded, ...rest } = stored;
    if (!Array.isArray(rest.studySlots) && Number.isInteger(studySlot)) {
      rest.studySlots = [studySlot];
    }
    /* showRail is deliberately dropped rather than carried into showFocus.
     *
     * They are not the same surface. Closing the old rail meant "put away the
     * column of cards at the edge of the screen"; the box it became holds one
     * entry and sits with a strip under each subtitle. Carried across, a reader
     * who had closed the rail once, months ago, would switch learning on and
     * see nothing at all - and nothing on screen would say why. A surface that
     * has changed shape starts visible, and closing it again is one click. */
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
    const on = !isStudied(slot);
    const next = on
      ? [...studiedSlots(), slot].sort((a, b) => a - b)
      : studiedSlots().filter((studied) => studied !== slot);
    const was = settings.enabled;
    /* Only THIS subtitle's trail is brought back, and only when this subtitle
     * is the one being switched on.
     *
     * The reported bug: "disabling learning on a subtitle while the other one
     * is enabled puts back the both study panels. I think our
     * multiple-language-learning at the same time support is broken." It was.
     * There was one surface for every language and one switch that put it
     * back, and it fired on the way OUT as well - so closing the English strip
     * and then unlearning Turkish reopened the English one. A subtitle being
     * switched on is the only thing that may show a strip, and the only strip
     * it may show is its own. */
    updateSettings({
      studySlots: next,
      trailOff: on ? closedTrails().filter((each) => each !== slot) : closedTrails(),
    });
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
    api.writeStored({ [SETTINGS_KEY]: settings }).then((written) => {
      // No write, no event to spend.
      if (!written) selfWrites = Math.max(0, selfWrites - 1);
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
      // Study can be on with the focus box put away; the host stays in the
      // tree so that turning it back on does not have to rebuild it.
      setHostVisible(host, settings.showFocus);
    }
    if (railEl) {
      railEl.dataset.auto = settings.auto ? "true" : "false";
      railEl.style.setProperty("--sso-study-text", `${settings.textPx}px`);
      railEl.style.setProperty("--sso-study-alpha", String(settings.opacity));
    }
    syncTrails();
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

  /* Lowercasing is a property of the language, not of the string, and Turkish
   * is where the default answer is wrong twice over.
   *
   * `"İyi".toLowerCase()` is "i" followed by COMBINING DOT ABOVE, because that
   * is what round-trips in every language except this one. No frequency table
   * holds that form, and a word the table does not hold counts as rarer than
   * the 30,000th word in it - so `iyi`, the 26th commonest word in Turkish film
   * dialogue, was marked as very rare and took one of the two places in its
   * line every time somebody said it. `"Işık".toLowerCase()` is the other half:
   * "işık", where Turkish wants the dotless "ışık".
   *
   * Measured over the Turkish subtitle in srt-viewer/subtitles: 78 of its 5,122
   * tokens lowercase differently under Turkish rules, and 61 of those are words
   * the table knows once they are folded that way, against 3 that only the
   * default gets right.
   *
   * The language has to be the SUBTITLE's, not the page's or the browser's,
   * because the same letters mean different things in two files on screen at
   * the same time. */
  function fold(word, language) {
    const text = String(word);
    return language ? text.toLocaleLowerCase(language) : text.toLowerCase();
  }

  /* Wrap every word in the rendered cue in its own element, leaving punctuation
   * and spacing as they were.
   *
   * Walks text nodes only, so the speaker colours, the sound symbols and the
   * italics that content.js built are all untouched - the words end up inside
   * those spans, which is what keeps a rare word inside a shouted line still
   * looking like part of the shouted line. */
  function wrapWords(cueBox, slot) {
    // Once per cue rather than once per word: it is the same answer for every
    // word in the line, and it reads the settings and the track to get it.
    const language = studyLanguage(slot);
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
        span.dataset.w = fold(match[0], language);
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
  const closedTrails = () => [...(settings.trailOff || [])];
  const trailShown = (slot) => isStudied(slot) && !closedTrails().includes(slot);

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

    /* Nothing to build when there is nowhere to show it.
     *
     * The hover path carries this guard and says why - "adding to a list nobody
     * can see would only spend lookups" - and the automatic path, which is the
     * one that runs on every line of the film, did not. Measured with the rail
     * put away: cards built into a host at display:none and 0px wide, and a
     * dictionary lookup spent on a word nobody could read.
     *
     * Two surfaces can show it now, so it takes both being away to stop the
     * work: this subtitle's own trail, and the focus box that any subtitle's
     * word can land in. */
    if (!settings.auto || rare.length === 0) return;
    if (!trailShown(line.slot) && !settings.showFocus) return;
    /* Rarest first, then capped. When a line has more unfamiliar words than
     * fit, the rarest are the ones a reader is least likely to have got from
     * context. */
    rare.sort((a, b) => (b.rank ?? Infinity) - (a.rank ?? Infinity));
    for (const item of rare.slice(0, settings.maxPerCue)) {
      addCard(item.word, { rank: item.rank, language, auto: true, slot: line.slot });
    }
  }

  // --- the trail ----------------------------------------------------------------

  /* One strip of word cards per subtitle.
   *
   * Asked for: "our study panel should be streaming like live streaming videos
   * on the net. I mean the words should be scrolling slowly and while new words
   * appear, older ones should be slightly disappearing... instead of using a
   * panel, maybe we can use another subtitle-like overlay area."
   *
   * It replaces a column of cards at the edge of the screen. The column held
   * three words and the reader had to leave the subtitle to read it; a strip is
   * one glance, which is the only way a word gets read without losing the film.
   * What the column did that this does not is carry a whole dictionary entry -
   * that is the focus box's job now, and there is exactly one of it.
   *
   * The BOX is content.js's: a root of its own with its own position, width and
   * drag, so it can be put anywhere and resized like a subtitle. This file owns
   * what goes in it and nothing else - api.studyDock is the way in, and
   * api.showStrip says whether this subtitle has one at all. The first version
   * hung the words under the cue, which made them impossible to place: "they
   * should have their own places on the screen and Place button (or drag&drop)
   * should allow to relocate/resize them just like the subtitle areas". */
  const trails = new Map();

  function trailFor(slot) {
    const existing = trails.get(slot);
    if (existing?.root?.isConnected) return existing;

    const root = api.studyDock?.(slot);
    if (!root) return null;
    root.replaceChildren();

    const track = document.createElement("div");
    track.className = "sso-trail__track";

    root.append(track);
    const trail = { slot, root, track, words: [] };
    trails.set(slot, trail);
    /* The box is resized by its own edges and by the window, neither of which
     * goes through a word arriving - so measuring the fit only when a word
     * arrives left a strip dragged narrower cutting its cards until the next
     * one did. */
    if (typeof ResizeObserver === "function") {
      trail.watch = new ResizeObserver(() => measureFit(trail));
      trail.watch.observe(root);
    }
    api.showStrip?.(slot, true);
    api.stripCount?.(slot);
    return trail;
  }

  /* Whether anything is actually leaving the box. The fade at the left edge and
   * the pinning at the right both hang off this, and both are wrong while the
   * words still fit.
   *
   * Measured against the BOX, not against the row: the row is `flex: 0 0 auto`
   * and therefore always exactly as wide as its cards, so comparing it with
   * itself said "nothing is leaving" while cards were being cut in half at the
   * strip's edge. */
  function measureFit(trail) {
    if (!trail?.root?.isConnected) return;
    trail.over = trail.track.scrollWidth > trail.root.clientWidth + 1;
    trail.root.dataset.over = trail.over ? "true" : "false";
  }

  /* A word arriving is the strip moving, not a word appearing in a gap.
   *
   * The whole track is given the arriving word's width as a transform and then
   * has it taken away on the next frame, so the browser interpolates the slide.
   * Doing it the obvious way - letting flex lay the new word out and animating
   * a margin - is a layout on every frame of every arriving word, and it was
   * measured making the surfaces around it drift while it ran. */
  function pushToTrail(card) {
    const trail = trailFor(card.slot);
    if (!trail || !trailShown(card.slot)) return null;

    const node = document.createElement("span");
    node.className = "sso-trail__word";
    node.dataset.term = card.term;
    node.dataset.saved = card.saved ? "true" : "false";

    const term = document.createElement("span");
    term.className = "sso-trail__term";
    term.textContent = card.term;

    const gloss = document.createElement("span");
    gloss.className = "sso-trail__gloss";

    node.append(term, gloss);
    node.title = "Click to hold it in the focus box";
    node.addEventListener("pointerenter", () => previewCard(card));
    node.addEventListener("pointerleave", () => releasePreview(card));
    node.addEventListener("click", (event) => {
      event.stopPropagation();
      pinCard(card);
    });

    trail.track.append(node);
    trail.words.push({ card, node, gloss });
    card.chip = { node, gloss, slot: card.slot };

    ageTrail(trail);

    /* How far the words have to slide for the new one to arrive where it
     * belongs, which is not the same in the two regimes: pinned to the right
     * the whole track moves by the arriving word's width, and centred it moves
     * by half of it, because the group re-centres around what it now holds.
     * Getting this wrong is visible - the words settle a few pixels off and
     * then the next arrival corrects it. */
    const width = node.getBoundingClientRect().width + 6;
    const slide = trail.over ? width : width / 2;
    trail.track.style.transition = "none";
    trail.track.style.transform = `translateX(${Math.round(slide)}px)`;
    requestAnimationFrame(() => {
      trail.track.style.removeProperty("transition");
      trail.track.style.transform = "translateX(0)";
    });
    return node;
  }

  /* Older words dim, and stop dimming while they are still readable.
   *
   * The floor is the whole rule. At 0.14 the third word back could not be read
   * at all over a moving picture, reported as fading "that much aggresively" -
   * so age is a hint about which word is newest and never the reason a word is
   * unreadable. 0.075 a step, floor 0.5: eight words fit between them. */
  const TRAIL_FADE_STEP = 0.075;
  const TRAIL_FADE_FLOOR = 0.5;

  function ageTrail(trail) {
    while (trail.words.length > TRAIL_KEEP) {
      const gone = trail.words.shift();
      gone.node.remove();
      if (gone.card.chip?.node === gone.node) gone.card.chip = null;
    }
    trail.words.forEach((item, index) => {
      const age = trail.words.length - 1 - index;
      const dim = Math.max(TRAIL_FADE_FLOOR, 1 - age * TRAIL_FADE_STEP);
      item.node.style.opacity = String(dim);
      item.node.dataset.newest = age === 0 ? "true" : "false";
    });
    /* How many words are in it, said on the box, because whether the box is
     * worth drawing at all is the box's own question - and in Place mode an
     * empty one still has to show itself so it can be put somewhere. */
    api.stripCount?.(trail.slot);
    // Read after the widths are settled, so a word removed above is already out
    // of the measurement.
    measureFit(trail);
  }

  /* What the word means, put on the chip when the lookup comes back. The trail
   * is worth reading on its own - a reader who glanced down for one word should
   * not have to go to another surface for it - so the chip carries the short
   * answer and the focus box carries the rest. */
  function drawChip(card) {
    if (!card.chip) return;
    card.chip.node.dataset.saved = card.saved ? "true" : "false";
    card.chip.node.dataset.focused = focused === card ? "true" : "false";
    card.chip.gloss.textContent = shortMeaning(card);
  }

  function shortMeaning(card) {
    const entry = card.lookup;
    if (!entry) return "";
    if (entry.translation) return entry.translation;
    const first = entry.definitions?.[0];
    const gloss = typeof first === "string" ? first : first?.text || first?.definition || "";
    return gloss.length > 42 ? `${gloss.slice(0, 41)}…` : gloss;
  }

  /* Which subtitles have a strip, said in one place. Called whenever the
   * settings change: a subtitle that is no longer being learnt, or whose strip
   * was put away, loses its words rather than keeping a stale row of them
   * under a line nobody is marking. */
  function syncTrails() {
    for (const slot of [...trails.keys()]) {
      if (trailShown(slot)) continue;
      const going = trails.get(slot);
      emptyTrail(going);
      going?.watch?.disconnect();
      trails.delete(slot);
      api.showStrip?.(slot, false);
    }
    // And the boxes of the ones that are being learnt, which may have been put
    // away in a previous session and switched back on since.
    for (let slot = 0; slot < (api.trackCount || 0); slot += 1) {
      if (trailShown(slot) && trails.has(slot)) api.showStrip?.(slot, true);
    }
  }

  function emptyTrail(trail) {
    if (!trail) return;
    for (const item of trail.words) {
      item.node.remove();
      if (item.card.chip?.node === item.node) item.card.chip = null;
    }
    trail.words = [];
    if (trail.root?.isConnected) api.stripCount?.(trail.slot);
  }

  /* Put one subtitle's strip away. The × on the box calls this; the box itself
   * belongs to content.js. The reported bug is that there was one control for
   * all of them: "Closing one study panel closes all. Wrong." */
  function closeStrip(slot) {
    updateSettings({ trailOff: [...new Set([...closedTrails(), slot])] });
    api.showToast?.("Words for that subtitle put away - the Learn chip brings them back");
  }

  function emptyTrails() {
    for (const trail of trails.values()) {
      emptyTrail(trail);
      trail.watch?.disconnect();
      api.showStrip?.(trail.slot, false);
    }
    trails.clear();
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

  /* Different from untabled, and the difference is what the reader is told.
   *
   * A daemon that is not answering produces the same empty result as a language
   * with no table, and study mode said "no word-frequency list for EN" either
   * way - a wrong diagnosis of a condition the reader could fix in one command.
   * Observed with a plain `python3 -m http.server` left running on 8791: every
   * rank request came back HTTP 501, nothing was ever marked, and the surface
   * blamed the language. It is not remembered like `untabled` either: the
   * daemon coming back has to be enough, without a reload. */
  let ranksUnavailable = false;

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
    /* Nothing was asked and nothing was answered - the helper is down, or
     * something else is on its port. Say so rather than blaming the language,
     * and do not write a verdict that the next successful request would have
     * to undo. */
    if (response?.transportError || response?.error) {
      if (!ranksUnavailable) {
        ranksUnavailable = true;
        emptyNote();
      }
      return known;
    }
    if (ranksUnavailable) {
      ranksUnavailable = false;
      emptyNote();
    }
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
        const language = studyLanguage(slot);
        addCard(fold(phrase, language), { pinned: true, language, slot });
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
      /* A word pointed at goes into this subtitle's trail and into the focus
       * box, unless both are away - with nowhere to show it, a lookup would be
       * spent on something nobody can see. The popup beside the word is the
       * whole answer in that case, which is what it is for. */
      if (trailShown(slot) || settings.showFocus) {
        api.detached(addCard(term, { rank: rankOf(word), language, slot }), "That word");
      }
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
  /* Which build owns the rail. Bumped by every build and by every teardown, so
   * a build whose stylesheets were still loading when study was switched off
   * knows not to put its host on the page. Without it, off-during-build left a
   * rail nothing held a reference to - undismissable, and joined by a second
   * one the next time study came on. */
  let buildToken = 0;

  async function build() {
    const token = ++buildToken;
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
      width: `${FOCUS_WIDTH}px`,
      "z-index": "2147483646", // just under the panel, which opens over it
    })) {
      host.style.setProperty(property, value, "important");
    }

    shadow = host.attachShadow({ mode: "open" });
    shadow.adoptedStyleSheets = await loadStyles();
    // Switched off, or rebuilt, while the sheets were being fetched.
    if (token !== buildToken) return null;

    railEl = document.createElement("div");
    railEl.className = "sso-win sso-focus";

    const head = document.createElement("div");
    head.className = "sso-win__head";
    const title = document.createElement("span");
    title.className = "sso-win__title";
    title.textContent = "Study";
    /* Which word this is, and where it is from. It was a count of how many
     * words were in the rail, which is the least actionable fact a surface
     * showing ONE word can carry - the box holds one entry now, so the head
     * says whose language it is in. */
    countEl = document.createElement("span");
    countEl.className = "sso-focus__of";

    /* Three controls, in the order they get reached for: let go of the word
     * being held, change how study works, put the box away. All on the head,
     * which is the thing they act on, and all in the one treatment the control
     * panel's head buttons use. */
    clearEl = document.createElement("button");
    clearEl.className = "sso-icon sso-icon--word";
    clearEl.type = "button";
    clearEl.textContent = "Clear";
    clearEl.title = "Let go of this word and empty the trails";
    clearEl.addEventListener("click", clearCards);

    const close = document.createElement("button");
    close.className = "sso-icon sso-icon--close";
    close.type = "button";
    close.textContent = "×";
    /* Puts the box away without turning study off. The words are still marked
     * in the line and still arrive in the trail under it; what goes is the one
     * surface that stands on the picture. Study itself goes off from the
     * control panel, where turning it back on also lives. */
    close.title = "Put the focus box away — the words under the subtitle stay";
    close.addEventListener("click", () => updateSettings({ showFocus: false }));

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
    gearEl.className = "sso-icon sso-icon--gear";
    gearEl.type = "button";
    gearEl.textContent = "⚙";
    gearEl.title = "How study works";
    gearEl.setAttribute("aria-pressed", "false");
    gearEl.addEventListener("click", () => api.detached(openRailSettings(), "Study settings"));

    head.append(title, countEl, clearEl, gearEl, close);

    listEl = document.createElement("div");
    listEl.className = "sso-focus__body";

    noteEl = document.createElement("p");
    noteEl.className = "sso-focus__note";

    railEl.append(head, listEl, noteEl);
    shadow.append(railEl);

    /* Connected before anything tries to promote it. toTopLayer refuses a node
     * that is not in the document, so a host that first met the document inside
     * reparent() fell through to the append - and while a player had
     * fullscreened the <video>, that put the rail inside a replaced element
     * where it is never painted. Same defect the control panel had, same fix;
     * both hosts were built the same way. */
    (api.paintableParent?.() || document.body || document.documentElement).append(host);

    /* The whole box is a handle, not only its bar - the same as the control
     * panel. A press on a word or a meaning still selects the text: the grab
     * only takes elements that carry no words of their own.
     *
     * Draggable and not resizable, which is the one asymmetry with the panel.
     * A box holding one entry has a size that fits one entry, and the four
     * grips it used to carry cost two stored numbers and a fold state for a
     * surface whose contents never change shape. Where it sits on the film is
     * still the reader's, because that depends on the film. */
    makeDraggable(railEl, head);
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

  /* The button that opens it closes it, the same rule the panel's Aa follows.
   * A control that opens something and then does nothing when pressed again has
   * stopped answering, and the reader's next move is to press it harder. */
  const markGear = () => {
    const on = Boolean(settingsWindow?.isOpen());
    if (!gearEl) return;
    gearEl.dataset.on = on ? "true" : "false";
    gearEl.setAttribute("aria-pressed", on ? "true" : "false");
    gearEl.title = on ? "Close the study settings" : "How study works";
  };

  async function openRailSettings() {
    if (settingsWindow?.isOpen()) {
      settingsWindow.hide();
      markGear();
      return;
    }
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
        onClose: markGear,
      });
      settingsEl = buildRailSettings();
      settingsWindow.body.append(settingsEl);
    }
    await settingsWindow.show(host);
    markGear();
    refreshRailSettings();
  }

  /* One control per thing study does, in the order a reader meets them: what
   * gets marked, which subtitle is being learnt from, what appears where, and
   * then how this box looks. */
  function buildRailSettings() {
    const wrap = document.createElement("div");
    wrap.className = "sso-focus__settings";

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

    /* A slider says what its number IS, and which way is more of what.
     *
     * Reported about the rarity control, and true of every one of these: "'rarer
     * than' what? What unit? Which end shows more words. It is not clear." A
     * title attribute was where that answer lived, which means it was not on
     * screen - so the note is a line under the row, and the two ends of the
     * scale are named under the track itself, where the hand is. */
    const range = (label, key, min, max, step, format, note, ends) => {
      const group = document.createElement("div");
      group.className = "sso-set__group";

      const row = document.createElement("label");
      row.className = "sso-set";
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
      group.append(row);

      if (ends) {
        const scale = document.createElement("div");
        scale.className = "sso-set__ends";
        const low = document.createElement("span");
        low.textContent = ends[0];
        const high = document.createElement("span");
        high.textContent = ends[1];
        scale.append(low, high);
        group.append(scale);
      }
      if (note) {
        const said2 = document.createElement("p");
        said2.className = "sso-set__note";
        said2.textContent = note;
        group.append(said2);
      }

      wrap.append(group);
      return { row, input, readout, format };
    };

    setEls = {
      auto: check("Mark rare words as they are said", "auto",
        "Without this, nothing is marked until you hover a word."),
      /* The threshold is a slider because the right value is a property of the
       * reader, not of the film: rank 2000 is where a beginner stops
       * recognising words and rank 12000 is where somebody comfortable does.
       * Nothing else can know which of those is on the sofa.
       *
       * What the number MEANS is the part that was missing. It is a position in
       * a frequency list of film dialogue, so the readout says the position and
       * the note says the list - "4,000" alone could as easily have been a
       * count of words, a percentage or a score. */
      rank: range(
        "Mark a word rarer than", "rarityRank", 500, 25000, 500,
        (v) => `the ${v.toLocaleString()} commonest`,
        "Position in a frequency list of film dialogue. A word further down the list " +
          "than this - or missing from it altogether - is the kind you are unlikely to " +
          "know, so it gets underlined.",
        ["← more words marked", "fewer, rarer words →"],
      ),
      hover: check("Answer beside the word on hover", "hoverCard",
        "Shows what a word means next to the word itself, with or without the focus box."),
      pause: check("Pause when a word is clicked", "pauseOnPin"),
      text: range("Text size", "textPx", 11, 26, 1, (v) => `${v}px`, "", ["smaller", "larger"]),
      opacity: range(
        "Focus box background", "opacity", 20, 100, 5, (v) => `${v}%`,
        "How solid the focus box is over the film. The words under the subtitle are not " +
          "affected; they carry their own backing.",
        ["see the film through it", "solid"],
      ),
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
      api.toWorker({ type: "sso:openOptions", hash: "#deck" }),
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
      const name = { auto: "auto", rank: "rarityRank", hover: "hoverCard",
        pause: "pauseOnPin", text: "textPx", opacity: "opacity" }[key];
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
    if (ranksUnavailable) {
      noteEl.textContent =
        "The subtitle helper is not answering, so no word can be marked as rare. " +
        "Hovering still looks a word up; shift-drag for a phrase.";
      return;
    }
    const language = studyLanguage();
    if (untabled.has(language)) {
      noteEl.textContent =
        `No word-frequency list for ${language.toUpperCase()}, so nothing is marked ` +
        `automatically. Hover a word to look it up; shift-drag for a phrase.`;
      return;
    }
    noteEl.textContent = settings.auto
      ? "Rare words arrive under the subtitle they were said in, and the one you are reading is here. Hover any word to look it up; shift-drag for a phrase."
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

    /* The same word twice in a minute is the film insisting, not two things to
     * read. It goes to the front of the focus box rather than arriving in the
     * trail a second time - a strip with the same word in it twice reads as a
     * strip that is not keeping up. */
    const existing = cards.find((card) => card.term === term && card.language === language);
    if (existing) {
      if (pinned) existing.pinned = true;
      // Newest again, in the record as well as in the box. They are two
      // statements of the same fact - "this is the word that just arrived" -
      // and while they disagreed, letting go of a held word handed the box
      // back to whatever had been newest before it, rather than to the line
      // actually on screen.
      cards = [existing, ...cards.filter((card) => card !== existing)];
      /* And back into the strip if it is not in it. A word said again half an
       * hour later is new to a trail that has moved on eight words since, and
       * the record of it here is not a reason to leave the strip silent. */
      if (!existing.chip?.node?.isConnected) pushToTrail(existing);
      focusCard(existing);
      drawChip(existing);
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
      paired: pairedLines(from, cue),
      timeMs: api.filmTimeMs(),
      lookup: null,
      saved: savedTerms.has(`${language}:${term}`),
      chip: null,
      node: null,
    };

    cards.unshift(card);
    pushToTrail(card);
    focusCard(card);
    trim();

    card.lookup = await lookUp(term, language, from);
    drawChip(card);
    if (focused === card) drawFocus();
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

  /* Every other subtitle's line for this stretch of the film. For a learner
   * this is the single most useful thing on the screen: the sentence, already
   * translated by a human, already timed to the same frame.
   *
   * A list rather than "the other one", because with two subtitles being
   * studied there is no such thing as the other one. Whether a line is itself
   * being studied does not come into it - the same moment in another language
   * is worth keeping either way.
   *
   * It asks for the line covering this cue's SPAN, not the line under the
   * playhead. Reported as "the study panel could match wrong EN-TR sentence
   * pairs"; the mechanism, the measurements and the fallback are in
   * `pairedCues` in content.js. `near` is that fallback: nothing overlapped and
   * this is the closest line, so it is shown as an approximate pairing rather
   * than quoted as the translation. */
  function pairedLines(slot, cue) {
    return (api.pairedCues?.(slot, cue) || []).map((each) => ({
      text: each.text,
      language: each.language,
      near: each.overlapMs === 0,
    }));
  }

  // --- the focus box ------------------------------------------------------------

  /* One word in full, in one place, however many subtitles are being learnt.
   *
   * The rail before it kept three cards, the newest in full and the rest
   * collapsed to a line each - which is three pieces of state (which is
   * newest, which is pinned, which the reader has opened by hand) deciding how
   * much of each of three cards to draw, over a film. What a reader does with
   * it is read ONE word. So there is one box, always the same size, and the
   * only question left is which word is in it.
   *
   * `held` is the reader's answer and beats the film's: clicking a word in a
   * trail holds it there until they let go, so a line arriving underneath does
   * not take away what they were reading. `previewed` is a hover, which is
   * borrowed rather than taken - the box goes back to whatever it was showing
   * when the pointer leaves. */
  let focused = null;
  let held = null;
  let previewed = null;

  function focusCard(card) {
    if (held && held !== card) return;
    focused = card;
    drawFocus();
  }

  function previewCard(card) {
    previewed = card;
    focused = card;
    drawFocus();
  }

  function releasePreview(card) {
    if (previewed !== card) return;
    previewed = null;
    focused = held || cards[0] || null;
    drawFocus();
  }

  /* Clicking the same word again lets it go, which is the rule every other
   * pressed-in control on these surfaces follows. Without it the only way to
   * stop holding a word was to hold a different one. */
  function pinCard(card) {
    const already = held === card;
    held = already ? null : card;
    card.pinned = !already;
    previewed = null;
    focused = held || cards[0] || card;
    if (!already && settings.pauseOnPin) api.pauseVideo?.();
    drawFocus();
    for (const item of cards) drawChip(item);
  }

  /* The cards behind the trails. Bounded because every one of them holds a
   * sentence, a paired sentence and a dictionary entry, and a two-hour film
   * would otherwise keep every word it ever marked. The trails hold eight each
   * and the box holds one; nothing reads past that. */
  const CARD_MEMORY = 40;

  function trim() {
    if (cards.length <= CARD_MEMORY) return;
    cards = cards.filter((card, index) => index < CARD_MEMORY || card === held || card === focused);
  }

  /* The trails fill themselves, so there has to be a way to empty them. Auto
   * mode puts words there without being asked and the reader is the only one
   * who knows which of them were wanted. */
  function clearCards() {
    for (const trail of trails.values()) emptyTrail(trail);
    cards = [];
    held = previewed = focused = null;
    drawFocus();
  }

  /* Which word, and out of which subtitle. Two languages can be being learnt
   * at once, and "what does this mean" has a different answer in each - so the
   * box says which one it is answering for rather than leaving the reader to
   * work it out from the word. */
  function drawFocus() {
    if (!listEl) return;
    for (const card of cards) drawChip(card);
    listEl.replaceChildren();
    if (countEl) countEl.textContent = focused ? (focused.language || "").toUpperCase() : "";
    if (clearEl) clearEl.hidden = cards.length === 0;
    emptyNote();
    if (!focused) return;

    const node = document.createElement("div");
    node.className = "sso-card";
    focused.node = node;
    redrawCard(focused, node);
    listEl.append(node);
  }

  function redrawCard(card, into) {
    const node = into || card.node;
    if (!node) return;
    /* Always in full. There is one card on screen and it is the one being
     * read, so there is nothing for a collapsed state to make room for. */
    card.focused = true;
    node.dataset.pinned = card.pinned ? "true" : "false";
    node.dataset.saved = card.saved ? "true" : "false";
    node.dataset.focused = "true";
    node.replaceChildren();

    /* The head is the word itself, how rare it is, and how it is said. It
     * carried a caret and a discard button when it was one card of three; a
     * box with one card in it has nothing to collapse and nothing to discard
     * it in favour of - the next word replaces it, and the head's own × puts
     * the whole box away. */
    const head = document.createElement("div");
    head.className = "sso-card__head";

    const term = document.createElement("span");
    term.className = "sso-card__term";
    term.textContent = card.term;

    const meta = document.createElement("span");
    meta.className = "sso-card__rank";
    meta.textContent = rankLabel(card.rank);

    head.append(term);

    /* The pronunciation goes on the head rather than in a row of its own,
     * which is what it had: a whole line spent on the quietest thing in the
     * card, pushing the answer further from the question. */
    if (card.lookup?.phonetic) {
      const phon = document.createElement("span");
      phon.className = "sso-card__phonetic";
      phon.textContent = card.lookup.phonetic;
      head.append(phon);
    }

    head.append(meta);
    node.append(head);

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
    if (card.sentence) {
      node.append(sentenceLine(card.sentence, card.term, "sso-card__line", card.language));
      // Every other subtitle's line at that moment, in slot order, so a card
      // from a three-language screen reads down the languages the same way the
      // screen does.
      for (const line of card.paired || []) {
        const quoted = sentenceLine(line.text, "", "sso-card__paired", line.language);
        /* Nothing in that language actually covered this line, so this is the
         * nearest one. Said rather than styled away: an approximate pair is
         * still worth reading, and a reader who is not told will take it for a
         * translation of the words above it. */
        if (line.near) {
          quoted.dataset.near = "true";
          quoted.title = "Nothing in this subtitle covers that line - this is the nearest one.";
        }
        node.append(quoted);
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

    /* Hold this word here, so the next line does not take it away. The same
     * statement as clicking the word in its trail, which is where a reader
     * standing at the strip makes it - both end in pinCard so the two cannot
     * come to mean different things. */
    const pin = document.createElement("button");
    pin.type = "button";
    pin.className = "sso-card__pin";
    pin.dataset.on = held === card ? "true" : "false";
    pin.textContent = held === card ? "Let go" : "Hold";
    pin.title = held === card
      ? "Let the next word replace this one"
      : "Keep this word here while the film runs";
    pin.addEventListener("click", () => pinCard(card));

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
    /* Folded the way the term was, or the mark lands nowhere. The term now
     * carries its subtitle's own lowercasing, and a default fold of the same
     * sentence is a different string in Turkish - "iyi" would never be found
     * inside "i̇yi". The length is checked because the default fold GROWS the
     * string there, and every index after the growth would be one place off,
     * which slices the mark across the middle of a letter. */
    const folded = fold(flat, language);
    const at = term && folded.length === flat.length ? folded.indexOf(term) : -1;
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
    // What the key saves is what the box is showing, which is what the reader
    // is looking at - held, previewed or simply the last one to arrive.
    const card = focused || cards[0];
    if (!card) {
      api.showToast("No word to save yet");
      return true;
    }
    saveCard(card);
    return true;
  }

  async function loadSavedTerms() {
    const response = await api.daemon("deckTerms", {});
    savedTerms = new Set((response?.terms || []).map(foldStoredTerm));
    remarkCurrent();
  }

  /* A stored term folded the way this session folds the words on screen.
   *
   * The deck holds `language:term`, and terms kept before the folding was
   * right carry the combining dot. Without this they never match the word in
   * the line again, so a Turkish word saved last week comes back underlined and
   * arrives in the strip once more - which is the one thing saving it was
   * supposed to stop. Split on the FIRST colon only: a saved phrase can carry
   * one of its own. */
  function foldStoredTerm(stored) {
    const text = String(stored);
    const at = text.indexOf(":");
    if (at < 1) return text;
    const language = text.slice(0, at);
    return `${language}:${fold(text.slice(at + 1), language)}`;
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
    api.writeStored(null, { remove: POSITION_KEY });
    api.showToast?.("Focus box parked");
  }

  function savePosition() {
    api.writeStored({ [POSITION_KEY]: { left: host.style.left, top: host.style.top } });
  }

  /* Nothing here resizes it, and that is the change.
   *
   * It had four corner grips, a stored width, a stored height and a minimum
   * and maximum for each - all of it so that a column of three cards could be
   * made to fit a film. One entry has one size, so the box has one size, and
   * what is left of the geometry is where the reader put it.
   */

  function setPosition(left, top) {
    host.style.setProperty("right", "auto", "important");
    host.style.setProperty("left", left, "important");
    host.style.setProperty("top", top, "important");
  }

  async function restorePosition() {
    try {
      const stored = await api.readStored(POSITION_KEY);
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

  /* Where the rail was last put. Same reason as the panel's copy: rescale
   * removes a transform and then reads getBoundingClientRect, and content.js
   * calls reparent twenty times a second from tick() whether or not anything
   * has moved. See the note above placedIn in panel.js. */
  const TOP_LAYER = "top layer";
  let placedIn = null;
  /* The host too, not just where it went. turnOff drops the rail and turnOn
   * builds a fresh one, so a memo keyed on the destination alone would tell the
   * new host it had already been measured in a place it has never been. */
  let placedHost = null;
  const settle = (where) => {
    if (placedIn === where && placedHost === host) return;
    placedIn = where;
    placedHost = host;
    rescale();
  };

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
      settle(TOP_LAYER);
      return;
    }
    api.fromTopLayer?.(host);
    if (popupHost) api.fromTopLayer?.(popupHost);
    const target = parent || api.paintableParent?.() || document.body || document.documentElement;
    if (target && host.parentElement !== target) target.appendChild(host);
    // The popup is anchored to the subtitle, so it has to follow the subtitle
    // into fullscreen or it renders behind the film.
    if (popupHost && target && popupHost.parentElement !== target) target.appendChild(popupHost);
    settle(target);
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
    /* Study switched on with every surface put away from a previous session
     * would look like nothing happened, so the trails of the subtitles being
     * learnt come back with it. The focus box does not: it is the surface that
     * stands on the picture, putting it away is a deliberate act, and the
     * words still arrive under the subtitle where they can be seen. */
    if (settings.enabled) updateSettings({ trailOff: [] });

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

  let building = null;

  async function turnOn() {
    if (!host) {
      // One build, however many callers ask at once. The panel's chip, the
      // keyboard and a settings change arriving from another frame can all land
      // in the same turn, and each of them used to start a rail of its own.
      building ||= build().finally(() => { building = null; });
      await building;
    }
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
    drawFocus();
    // The line already on screen was rendered before study mode existed, so it
    // has no words in it. Force it through again.
    api.redrawCues?.();
  }

  function turnOff() {
    // Any build still fetching its stylesheets is now building a rail nobody
    // asked for. See buildToken.
    buildToken += 1;
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
    railEl = listEl = countEl = noteEl = clearEl = null;
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
    /* The trails are in content.js's overlay root rather than in a host of our
     * own, so nothing removes them when this one goes - they have to be emptied
     * by hand, or the words of a film stay under its subtitles with study
     * switched off. */
    emptyTrails();
    cards = [];
    held = previewed = focused = null;
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
    closeStrip,
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
    /* Guarded: the commonest reason to be tearing down is that the extension
     * has just been reloaded, and reaching into chrome.storage is then the very
     * thing that throws - which would leave everything below still standing. */
    try {
      chrome.storage.onChanged.removeListener(onStorageChanged);
    } catch {
      // Gone with the context that owned it.
    }
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
