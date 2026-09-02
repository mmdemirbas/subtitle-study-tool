# browser-extension — architecture and invariants

`README.md` is the user-facing install and feature guide. This file is the map
you need before editing `src/`. Read the root `CLAUDE.md` for commit style.

## The four content scripts, and what each owns

All four are injected into **every frame** (`all_frames: true`) and run in the
extension's isolated world. They talk to each other through globals on that
isolated `window` — never through the DOM, and never reachable from the page.

| File | Lines | Owns | Exposes |
|---|---|---|---|
| `align.js` | 520 | matching a subtitle's timing to the playing release | — |
| `content.js` | 4.5k | the video, the playback clock, the cue overlay, the CC handle, settings, keys, the frame roles, frame/fullscreen plumbing | `window.__ssoApi`, `__ssoTeardown` |
| `panel.js` | 3.2k | the control panel window (search, attach, sync, settings) | `window.__ssoPanel`, `__ssoPanelTeardown` |
| `study.js` | 2.5k | the word strips, the focus box, the deck, the lookup popup | `window.__ssoStudy`, `__ssoStudyTeardown` |

`content.js` is the only one that touches the `<video>`. `panel.js` and
`study.js` reach it exclusively through `window.__ssoApi`. Keep that direction:
nothing in content.js should depend on the panel's internals, only on the
`__ssoPanel` / `__ssoStudy` method surface it calls (`toggle`, `reparent`,
`rescale`, `onCue`, `claimPointerDown`, `claimPointerUp`, `saveTop`, `setEnabled`).

Re-injection is supported and expected: every file calls the previous
`__ssoXTeardown` on load so a reload leaves exactly one copy running.

## The frame model — read this before any UI change

On real streaming sites the video is usually **not** in the top frame. Measured
on `streaming-site.example` (2026-08-08):

```
top      streaming-site.example/tv/...              no video   1400x813
 └─ [0]  streaming-site.example/watch/index.html    no video   same-origin
     └─  embos.top/tv/?mid=...                THE VIDEO  cross-origin, 1136x568 at (32,120)
```

**A nested frame cannot escape its parent's stacking order.** Verified: a
`popover` element promoted to the top layer inside an iframe still loses to a
plain `position:fixed; inset:0; z-index:2147483647` div that the *parent*
document appends to `<html>` — the click goes to the parent's overlay and the
in-iframe panel never sees it. The top layer is per-document; the iframe as a
whole is one box in the parent's paint order. No z-index and no `showPopover()`
inside the frame can change that. streaming-site.example appends exactly such an iframe,
so a CC button drawn in the player's frame was visible and unpressable.

### So the frames divide the work

Each frame is one of three roles, held in `role` in `content.js`:

| Role | When | What it draws |
|---|---|---|
| `solo` | the video is in this frame, or there is no video | everything, as before |
| `video` | this frame has the film, the top frame took the controls | the cue overlay only — **no CC button** |
| `chrome` | this frame is the top one and the film is elsewhere | the CC button, the panel, toasts |

Nothing about `solo` changed, and most pages are `solo`. The split only happens
when `isPageSubject()` is true in a frame that is not the top one.

**The two frames cannot see each other**, so every word goes through the
service worker:

- The video frame reports `{type: "sso:frameRole", hasSubject}` on every change
  and **takes the answer** — `"video"` only if the top frame accepted the job.
  If it did not (no content script up there), the answer is `"solo"` and the
  player's frame keeps its own button. One button either way, and never none.
- `sso:toChrome` / `sso:toVideo` are the relay. `videoFrames` in
  `background.js` is the routing table, one entry per tab.
- The video frame pushes `sso:mirror` — its whole `status()`, the study
  settings and, only when the attached files change, the cue times. Throttled
  to 150ms while something is attached and 1s while nothing is, because that
  message is also the heartbeat and it must not keep the service worker
  resident for the life of an idle tab.
- The chrome frame's `status()` **is** that mirror, and says `mirrored: true`.
  `tabStatus()` in `daemon.js` skips mirrored frames when looking for the video
  and reports where the controls are as `chromeFrameId` — so an attach still
  goes to the film and `toggle-panel` still goes to the panel.
- Everything on `__ssoApi` that changes the film is wrapped once by the
  `FORWARDED` list and sent as `sso:call`. The receiving side checks the same
  list, so the two cannot drift. `callVideoFrame` **never rejects** — it toasts
  and resolves null, because nearly every caller is a click handler.

Three consequences worth keeping in mind:

- **Read-modify-write across the gap is a bug.** The held nudge button used to
  read the offset and send the sum; against a mirror one round trip behind,
  every repeat after the first computes from a stale number. `api.nudge` takes
  the *step*, so the addition happens where the value is. Any new relative
  control does the same.
- **`panel.js` may not reach `window.__ssoStudy` directly** — that only ever
  finds the copy in its own document. `api.studySettings()`,
  `setStudyEnabled`, `toggleStudySlot`, `toggleStudy`, `saveTopWord`.
- **`onKeyDown` goes through `__ssoApi`, not the functions behind it.** A
  keystroke lands in whichever document has focus, which on a nested player is
  usually the frame with no subtitle in it.

The arrangement heals in both directions, and both are checked:
a push refused by a top frame that no longer thinks it draws the controls
(which is what a re-injection leaves behind) clears `claimedSubject` so the
next tick claims again; and 3s of silence from the video frame drops the top
frame back to `solo`, so the button does not outlive the film.

**Still open, and now observed rather than argued:** the study surfaces and
clicking a word all need the cue text, so they stay in the video's frame and
remain behind a parent overlay on a site that paints one. `tests/frames/run.mjs`
carries it as `KNOWN GAP - a press on the study box is still taken by a
full-viewport page overlay`: a real click at the focus box's coordinates, from
the top document, with the vehicle's interceptor on — the page's counter
swallows both the pointerdown and the click.

**No user has reported it since streaming-site.example stopped painting that overlay**, so
the exposure is to the class of page rather than to that page. The check is
written as "still swallowed" deliberately: it stays green on today's behaviour
and fails the moment it changes, including when it is fixed, at which point it
gets inverted and renamed.

**Do not probe this from inside the film's frame.** `describeSurfaces()`
computes `reachable` with `document.elementsFromPoint`, which knows nothing
about a box in the PARENT document — so the frame reports itself unobstructed
while the parent takes every press. That false pass is why the original report
could establish the mechanism and never observe it. The witness is
`window.__stolen` in `tests/frames/top.html`, counting what the interceptor ate.

The cue overlay is in the video's frame too, which is right — it only has to be
seen, and a transparent interceptor does not hide it.

## The running log — read this before asking anyone to reproduce anything

`trace.js` in the worker keeps a rolling log, written as the extension is used
rather than when somebody presses a diagnostic button. It exists because two
questions kept being answered by guesswork:

- **What does that page actually look like?** Every time the control panel
  opens or closes, every frame's `sso:diagnose` is captured with it — the frame
  tree, which one holds the film, what each drew, what is covering it, which
  element has fullscreen, and whether the overlay host was built *and*
  parented. Asking for this after the fact means asking someone to reproduce
  something that has already happened, on a page whose player has often
  navigated since.
- **Which two files did the aligner refuse?** Every `autoAlign` call records
  both tracks' cue starts, their labels, languages, counts, offsets and rates,
  and the answer. Whether two subtitles can be lined up is a property of their
  cue times and nothing else, so an attempt that failed is only reproducible
  with the times that failed — and the extension already had them.
  `alignOutcome` records what the reader then did (`taken`, `undone`), which is
  the only ground truth there is about whether an answer was right.

- **Where did the reader correct the sync, and by how much?** Every by-hand
  correction writes a `sync` line: how it was made (`key`, `drag`, `typed`,
  `reset`, `command`, `snap`), where in the stream and where in the file, the
  offset before and after, the rate, and for **every** attached subtitle the cue
  under the playhead — its index, its time in its own file, how far the playhead
  was from it, and its first 90 characters. The text is what makes the record
  checkable against a copy of the file on another machine; the numbers alone
  cannot be replayed. Whether the *other* subtitle was already right at that
  moment is what separates "this file is out" from "these two disagree".

  A correction is the only ground truth this extension ever gets — a human ear
  deciding a line is late by this much, at this point in the film — and until
  2026-08-16 every one of them was thrown away by the next one. **One gesture is
  one record**: a drag calls `setOffset` on every pointermove, so the moves pass
  `note: false` and the release carries `fromMs`, the offset the gesture started
  from. Do not undo that; it also stops sixty points at one instant filling the
  drift estimator's eight-deep memory.

It also records every message shown to the reader (`said` — that is the
extension's entire error surface), every attach and detach, every keyboard or
toolbar command with the frame it addressed, every auto-attach plan, and every
error or unhandled rejection that reached the top of a frame or the worker.

**It goes to the daemon, and that is the third shape this took.** Both earlier
ones are worth knowing so they are not tried again:

1. *A log with a Save button.* Useless — the failures worth recording are the
   ones where nothing responds to clicks.
2. *A log that writes itself through `chrome.downloads`.* Worse. An extension
   cannot write to a directory; the only API that puts a file on disk is the
   download machinery, and it announces every file. Recording while a film
   plays meant a popup every few seconds. `setUiOptions({enabled:false})` is
   supposed to silence that and **did not** — reported, not theorised.

So `flush()` POSTs to `http://127.0.0.1:8791/log` and the daemon appends one
line of JSON per entry to `subtitle-daemon/logs/<date>.jsonl`. No files, no
popups, no ceiling but the disk. **Read that directory instead of asking anyone
to reproduce anything.**

With the daemon down it simply **holds** — up to 20000 entries or 400MB, which
is what `unlimitedStorage` is for — and sends the lot in one piece the moment
the daemon appears. A file is downloaded only if even that fills, or if asked
for on the report page. The buffer is emptied **only after** the entries are
somewhere else; a destination that refuses them keeps them and records
`lastError`.

**The switch is `settings.diagnostics`**, on by default, in the panel's *If
this page is not working* section. `trace.js` reads it, so one flag covers the
frames and the worker; `content.js` checks it too, so switching it off stops
the messages as well as what is done with them. An installation that predates
the setting reads as **on** — `!== false`, never `=== true`.

Writes go through the same `inTurn` queue the deck uses. Cue times are stored
as gaps, a third of the size, and `unpackTimes` reconstructs them exactly;
starts **and ends** are kept, because the ends are what a better aligner needs
and what `align()` is never given.

**When a bug report is about sync or about frames, read
`~/Downloads/subtitle-overlay-log/` — do not ask anyone to reproduce
anything.**

## The aligner refuses two different ways, and both matter

`align.js` answers `apply`, `offer` or `no`. **`apply` needs a high confidence
AND a pairing rate above chance** (`AUTO_MIN_COVERAGE`), because the binomial
score can clear the auto threshold on a long file with a thin excess over
chance - and when it does, the shift it carries is the wrong one. Measured on
The Americans, where the show burns English subtitles into the picture for the
Russian dialogue so the English `.srt` is silent through those scenes: a
competing peak 3.4 seconds away won and was applied silently at confidence 8.3.

The gate is one-directional by construction - it can only turn `apply` into
`offer` - so it cannot touch the boundary the file is really about, the 3.11
wrong pair against the 3.55 right one. Keep it that way. `test_align.py` runs
the real corpus and will notice.

Cross-language pairs for this series are the worst in the corpus: coverage
0.25, confidence 3.8 to 6.1, because the two subtitlers cut the dialogue into
different lines (1173 English cues against 915 Turkish, median gap between
nearest starts 505ms against a 250ms tolerance). That is content, not a defect.
Measured on S02E09, where the two files share a timeline exactly: 88 of 725
English lines are sound description (`[ Brakes hiss ]`) with no Turkish
counterpart, and 114 Turkish lines merge two English ones.

## One shift is often the wrong SHAPE of answer

`align()` returns one number, and the drift estimator returns one line. Two
releases of one episode can be neither.

Measured on The Americans S02E09 - two Turkish files carrying the same 533-line
translation re-timed for two releases, every window matching 100% of its lines:
**1.00s, 5.30s, 11.85s, 18.80s, 24.80s, 30.55s.** Six plateaus, five jumps of
four to seven seconds, at scene boundaries. The two English files for the same
episode, by different subtitlers, give the same six to within 250ms - which
makes it a property of the video releases rather than of any subtitle. S02E04
does it again in two more pairs.

`align()` alone answers that pair with one number, which is right over one
plateau and wrong over the other five. The search is not at fault and the
coverage gate is not at fault: 11.85s is the correct shift for the third act.

**`alignSteps()` is what to call, and `autoAlign` does.** Same identification,
same refusal, seeded from the same rate, plus one offset per act - and a track
carries them as `steps`, which both time conversions read. Measured over 137
pairs whose truth comes from cue text rather than from any clock: 94.6% of the
film inside 250ms against `align()`'s 86.4%, and on the 41 pairs whose truth is
a staircase the median goes from 50% of its film in the right place to 90%.

**The property that let it ship is that it makes no pair worse**, and the first
version did not have it - it invented a second act on four pairs `align()`
already put 100% right. `bench/align/regress.mjs` is the standing gate and exits
non-zero on any pair that loses ground. Run it before touching any of the
constants in the acts section of `align.js`.

**Before adding another gate, read `docs/reports/auto-sync-2026-08-16.md`** -
how the truth is derived, how often each shape occurs, what every method scores,
and the four wrong answers that had to be found on the way.
`bench/align/shapes.mjs` prints the shape census; `bench/align/piecewise.mjs`
re-runs the original measurement on any two cached files.

**`snapNear` in `align.js` is the piece of that which shipped.** After a map
drag - and only after a drag - the correction is moved to the median of the
nearest-neighbour differences between the two subtitles, over two minutes around
the playhead. Three things about it are load-bearing:

- **Local.** Consulting the whole file would drag a third-act correction towards
  the first act's answer, because of the staircase above.
- **A median, not a count of matches.** Counting within a tolerance cannot see
  an error smaller than that tolerance, and every error a hand makes on a 180px
  strip is inside it. Counting also fails on a real cross-language pair, where a
  quarter of the lines coincide at all.
- **The test is the spread, at 150ms.** Genuine snaps on pairs by different
  subtitlers measured 67 to 139ms of spread, so a tighter-looking limit would
  refuse most of them. Injected errors from -480 to +480ms come back to within a
  millisecond of the truth.

Not on a keyboard nudge: a fixed step that snaps somewhere else is a key that
does not do the same thing twice.

**And not on the leading subtitle**, for the reason in the next section: it is
the reference, so snapping it onto a follower would pull the reader's own aim
back toward a subtitle that is only where it is because of the lead - silently,
in the moment after they let go.

## The first subtitle leads and the rest are individuals

Asked for as "the first subtitle should be treated like master, so moving it
should move the rest, but the others should be individuals". It is a model, not
a convenience, and the model is what stops it reading as a coupling bug:

- **The lead's offset is where the FILM's dialogue is.** A reader who hears a
  line before they read it has learnt something about the film, and it is true
  of every subtitle on screen at once.
- **Each follower's offset is how that file differs from the lead.** Only it
  moves, because only it is being described.
- **Nothing is lost.** Both degrees of freedom stay reachable: the lead by `d`
  moves everything and keeps every relative offset; a follower by `d` changes
  only its relation to the lead. "The lead alone is out" is the lead by `d` and
  the follower by `-d`, which is also the honest description of that case.

`byHand` is the discriminator, and it already was. Everything the extension
works out for itself - the aligner, a remembered release timing, the drift fix -
passes `byHand: false`, and every one of those is a statement about ONE file, so
carrying it would undo the relationship it was computed to establish. The snap
is by hand and is excluded by name (`how === "snap"`). **A new caller of
`setOffset` has to decide which kind it is**; the panel's `applyTiming` was the
one that had to be corrected when this landed, because it applies an aligner
answer and defaulted to by-hand.

The drift estimator is deliberately not told about a carried move. It learns
"this reader keeps nudging this file", and a follower that moved because the
lead did has not been nudged - counting it would measure a drift in a file
nobody corrected and then offer to stretch it.

Ordering matters when zeroing a pair: **the lead first**, because zeroing it
carries the follower. Zeroing the follower first and the lead second puts the
follower back wherever the lead happened to be.

## The search pipeline exists twice, and the copy that runs is the quiet one

`subtitle-daemon/` and `src/subtitles/` are the same pipeline in two languages.
The daemon answers when it is running; **when it is not — which is the ordinary
case — `src/subtitles/local.js` does, and that is the code the reader is
actually using.** Check `lsof -i :8791` before believing a daemon-side fix
reached anything.

A change to search, title parsing, matching or ranking has **four** places to
land: `subtitle_daemon/*.py`, its tests, `src/subtitles/*.js`, and whichever
extension module consumes it. A fix that reached the first three and missed
`local.js` left a reported bug alive for five days with 300+ tests green.

Two guards exist now and both must be kept honest:

- `test_js_parity.py` diffs the two implementations over shared input. It
  compares `titles.resolve` (the whole search resolution), **not just
  `titles.guess`** — the two sides agreed about parsing and disagreed about
  whether to parse a typed query at all, which parity on `guess` could never
  see. When you add a rule, add it to the compared surface.
- `tests/fallback.html` exercises `local.js` end to end. If you fix something in
  the daemon, ask what the same input does there.

## A cue with nothing to read is not a cue

`parseSrt` drops any block whose text carries no letter and no digit, and the
daemon's `parse_srt` does the same. It is one guard widened, not a new one: the
check there already dropped a block with empty content, and a block holding only
`_` is empty in every sense the reader cares about.

Reported as a subtitle that is "only - or _ ... blocking the view
unnecessarily", and the diagnosis in the report was right. These marks stand in
for dialogue the file is deliberately not writing down - usually because the
picture is already carrying it - so the overlay drew an empty box over the
words, at the one moment those words were burnt into the frame underneath it.

Measured over the 180 files in the download cache: **415 of 170,252 cues**,
across 16 files. 232 are a lone `_`, 88 a run of asterisks, 73 are music marks
with no lyrics under them, 8 a lone copyright sign, the rest stray dots and
dashes. The Americans is the worked example, and it is the same fact the
aligner section above already carries from the other side: the show burns
English subtitles into the picture for the Russian dialogue, and the English
`.srt` writes `_` through those scenes. One episode spends 67 of its 626 cues
that way.

Three things about it are load-bearing.

- **Letters and digits, not a list of the marks seen.** The next file uses a
  different one - the corpus already has four families - and an allowlist has to
  be extended for each. The test is `/[\p{L}\p{N}]/u` in JavaScript and
  `[^\W_]` in Python, which is `\w` without the underscore, which CPython
  defines as `str.isalnum()`. Checked over all 1,114,112 code points, the two
  disagree on **none** - so the two copies of this parser cannot drift here.
- **The markup comes off first.** The copyright cues are written
  `<font color=orange>(c)`, so a check reading the raw block finds the letters
  in the tag and keeps it. That costs a second markup parse per cue: measured
  over the corpus, `parseSrt` goes from 1.16ms to 2.03ms per file, paid once at
  attach. A cheap letter test on the raw block first is 40x faster and misses 9
  of the 415, which is the wrong trade for work nobody waits on.
- **A music mark is dropped alone and kept over lyrics.** `♪♪` is a box with
  nothing in it; `♪ Why don't you tell me` is a line, and `annotations.js` still
  colours it. Sound descriptions are words and are untouched - `[sighs]` stays,
  under `dimNonSpeech` as before.

**It is dropped at parse, so nothing downstream sees it**: not the overlay, not
the study strips, not next-line navigation, not the cue counts, and not the
aligner. That last one is why it was measured rather than argued - a placeholder
has a time and no counterpart, so it is a noise anchor. Over the 137 pairs
`bench/align` can settle with a text-derived truth, dropping them left the
shipped aligner's answer **unchanged on 132 and moved none**: no pair better, no
pair worse, no answer gained or lost.

**`bench/align/srt.mjs` reads subtitles itself** and did not get this guard, so
the bench still measures the unfiltered input. That is the measurement above,
not an oversight to fix blind - but a bench that stops matching what ships is
worth remembering before the next alignment change.

## Why the surfaces are built the way they are

Each of these was a reported bug. Undoing one brings the bug back.

- **Everything lives in a shadow root.** A host rule as ordinary as
  `span { font-style: normal }` cancels the markup italics; a player element
  appended later with an equal z-index paints over a CC button pinned at
  2147483647.
- **Hosts carry `all: initial` plus their geometry, inline and `!important`.**
  Inline `!important` outranks everything, including the adopted sheet's
  `:host` rules — so **never put anything load-bearing in a `:host` rule.**
- **Styles are adopted `CSSStyleSheet`s, not `<style>` elements.** Streaming
  sites ship a strict `style-src`; adopted sheets are not subject to the page's
  CSP. The CSS files are `web_accessible_resources` and fetched at runtime.
- **Visibility is `display` set inline, not the `hidden` attribute.** The
  host's inline `display` is `!important`, so the UA rule behind `hidden` could
  never win.
- **Fullscreen needs BOTH the top layer and the subtree. Painting and
  hit-testing are different questions.**
  Out of fullscreen, `toTopLayer()` promotes each host with `popover="manual"`
  + `showPopover()`; that is what keeps a surface above player chrome appended
  later at an equal z-index.
  In fullscreen the top layer is **not enough**: the browser delivers pointer
  events only inside the fullscreen element's subtree. Measured in a real
  fullscreen session — the panel is painted correctly over the film and
  `document.elementsFromPoint` at the centre of its own close button returns
  `VIDEO`, then `HTML`. Playwright refuses the click with "video intercepts
  pointer events". Out of fullscreen the same probe returns our host first.
  So while a session is open the hosts are appended **into** the fullscreen
  element (`fullscreenHolder()` in `content.js`), and because a `<video>`
  cannot hold children, the session is first moved onto the nearest ancestor
  that can — allowed without a fresh gesture while a session is already open.
  Do not "simplify" this back to top-layer-only: that is the
  "the fullscreen CC button does nothing" report, and the panel looks perfect
  while it happens.
- **Menus and popups get their own host** (`makeLayer()`), because anything
  drawn inside the panel is clipped by it.
- **`document` listeners are capture-phase.** Players routinely
  `stopPropagation()` on pointer events inside the player, which silences any
  bubble-phase listener exactly where it is needed.
- **Every host stops pointer events escaping in the bubble phase**
  (`keepPointersInside()` in `content.js`). The UI is built inside the frame
  that owns the `<video>`, so it sits inside the element the player binds
  play/pause to: a press on our close button worked *and then* paused the film.
  This is safe precisely because every one of our own document listeners is
  capture-phase. Apply it to any new host — including non-interactive ones; the
  toast is `interactive: false` and its Undo button is the thing people press.
- **Every placeable surface is held to the same lines, through one session.**
  Four boxes in the overlay (two subtitles, two word strips) plus two windows
  (the control panel, the study focus box), and a reader does not care which
  file built which. `openGuides(exclude)` / `guideNear(anchors, axis)` /
  `showGuides(atX, atY)` / `closeGuides()` in `content.js` are the whole of it:
  opened once when a gesture starts because every line costs a forced layout,
  and closed when it ends. The boxes reach them through `beginDrag`, the windows
  through `makeMovable`, and each window's own corner grips through
  `api.guides` — `panel.js` builds its grips itself, so it has to ask.
  `guidesFor` offers the picture's edges and middle (both rectangles when the
  film is letterboxed), every other box, and every host `makeMovable` has ever
  been given. **Alt suspends it**, read on every move rather than once, because
  "no, exactly there" is decided halfway through a drag. A snap with no line
  drawn is forbidden: a box that moves five pixels for a hand that moved one,
  with nothing on screen saying why, is indistinguishable from a bug — so a
  frame with no overlay in it does not snap at all, and a snap the clamp undoes
  draws nothing.
- **A subtitle card is two rows, and the map's width is the reason.** Head with
  the identity, the reading and the verbs; then the map with Line up at the
  card's right edge, under "Line up all". The ask was for the reading, its clear
  and Line up all to share the map's line, and all three do not fit: measured at
  the 340px the panel opens at they take 185px of a 316px row and leave the map
  82 pixels. The map is the instrument, so the reading went up a line instead
  and the map keeps 181px. Anything added to either row is measured against
  that. The head wraps below 340px, and the name is `flex: 1 1 0` because a
  wrapping flex line breaks on items at their **unshrunk** size - with `auto` a
  372px release name pushed everything else onto a second line at every width
  under 600.
- **Again and Next are on the quick row, once, not on each card.** They move the
  picture by a line boundary and there is one picture; drawn per card they were
  the same control twice and made the reader choose a card before pressing
  either. The keyed subtitle decides whose boundaries are counted.
- **The panel's title bar carries two double-click gestures.** The bar folds and
  unfolds; the **name** parks the panel back under the CC button. Tests that
  park it must aim at `.sso-win__title`, or they fold it and everything after
  them measures 0×0.
- **Nothing may overlap a control in a `.sso-win__head`.** The corner resize
  grips sit above the head, so the head clears them with `--sso-grip`-derived
  padding. Measured before that: the NE grip covered 169 of the close button's
  576 square pixels including its centre, so the × could not be pressed at all,
  on every window at every size. A harness check hit-tests every head control
  on every window we draw.
- **Study is two surfaces, and which one carries what is the design.** A strip
  of words per subtitle - a placeable root of its own, with `stripX`, `stripY`,
  `stripWidth` and `stripPlaced` beside the subtitle's own four keys, dragged
  and resized by the same gesture through `surfaceOf()` in `content.js`, so the
  two cannot drift apart - and one focus box holding the whole entry for the
  word being read. `study.js` owns only what goes in the strip: `api.studyDock`
  is the way in, `api.showStrip` says whether a subtitle has one at all. Hanging
  the words under the cue was the first version, and it made them impossible to
  put anywhere: "they should have their own places on the screen and Place
  button (or drag&drop) should allow to relocate/resize them just like the
  subtitle areas". The single rail that did both was reported four ways at once:
  "closing one study panel closes all", "disabling learning on a subtitle while
  the other one is enabled puts back both study panels", words piling up so
  nothing was ever the thing being looked at, and an animation that "makes the
  rest of the rails drift". Per-language closing is now structural - a strip
  belongs to one subtitle, and `trailOff` names the ones put away - rather than
  a flag on a shared surface.
- **The strip is a fixed-width box, and that is what stops the drift.** It takes
  the whole allotment the cue is capped to and centres its words in it, pinning
  them to the right end only once there are more than fit. Shrink-to-fit, an
  arriving word grew the box while the track slid inside it: measured, one
  arrival moved the left edge 7px and the width 13px, instantly, while the words
  slid the other way over 380ms. Two motions in different directions at the same
  moment is what "not stable" meant. The mask at the left edge is on the same
  switch, because a fade that is always on does to the oldest word exactly what
  the age fade is forbidden to do - at 14% of a 578px strip it put 81px of
  gradient over the first word, which no opacity assertion could see.
- **The fit is measured against the box, and re-measured when the box moves.**
  The row inside the strip is `flex: 0 0 auto` and therefore always exactly as
  wide as its cards, so comparing it with itself says "nothing is leaving" while
  cards are being cut in half at the strip's edge - read back off a screenshot
  as "kcasi" for "acikcasi". A `ResizeObserver` on the box does the re-measure,
  because a strip dragged narrower and a window resized never go through a word
  arriving, which was the only thing that used to recompute it.
- **The box itself is quiet until it is pointed at.** The cards carry their own
  background and edge; a second surface behind them is two elevation systems
  stacked, and with one card in a 672px box that left 500px of empty dark bar
  over the film. Hover, drag, resize and Place bring the field back, which is
  every moment the box rather than its contents is the thing being used. The
  language tag stays visible throughout, because it is the answer to "I even
  didn't understand it is rails".
- **A meaning is a (word, line) pair, and both halves have to match byte for
  byte on both sides.** A word out of its sentence is a different question: a
  context-free translator answers "spare" with "parça", from its memory of
  "spare part", to a reader who just heard "can you spare a minute". So the cue
  text travels with the word - into `lookUp`, into the daemon's `/lookup` and
  `/gloss`, and into the key the answer is filed under, on disk and in
  `chrome.storage`. **The line sent must be the cue's own `text`, brackets, line
  breaks and all** - the same string `addCard` puts in `card.sentence`.
  `glossAhead` finds its words in a bracket-stripped copy and still sends the
  raw one, because tidying it files every answer where nothing will look for it
  and the whole prefetch silently does nothing. Nothing fails if you get this
  wrong; it just stops working.
- **The film's words are answered before they are said, and that is the design,
  not an optimisation.** A lookup made as its line arrived took 634ms on average
  and up to 1.4s over 22 words, against a line on screen for about two seconds -
  so the meaning could land under the next line. `glossAhead` walks the whole
  file once at attach, works out which words each line would mark, and sends
  them to the daemon in film order a chunk at a time; by the time a line
  arrives, its words are a disk read. It is keyed on the cue array's identity
  and the two languages, deliberately not on the rarity settings, so moving the
  threshold slider does not send the script again.
- **A name is a kind, not a filter, and there are two sources of evidence.**
  239 of the 860 words the overlay marked in the Battlestar Galactica miniseries
  were proper nouns (27.8%; 193 of 682 in part two), because a name is not in
  the frequency table and "not in the table" ranks rarer than everything that
  is. They also cannot be translated: MyMemory answered "viper" with "Engerek!",
  the snake, and "adama" with a street in Warsaw. `namesIn` decides from the
  WHOLE file - capitalised where a sentence did not just start, in at least half
  of its occurrences - because every name opens a line sooner or later and one
  line cannot tell. The second source is brackets: the capitalisation test never
  sees a speaker label, since brackets are cut from the evidence, but the overlay
  still renders and marks the words inside them, so a capital inside a bracket is
  a name too. The rule is character for character the one in
  `tools/measure-script.mjs`, so `docs/reports/what-the-script-is-worth.md`
  keeps describing what the overlay does. **If you change one, change both.**
- **Meaning has three tiers and the bottom one needs nothing.** A model that
  sees the line (`gloss_model`, an OpenAI-compatible endpoint, by default one
  running on this machine); Google for a bare word (`google_api_key`); then a
  free archive that needs no key at all. The extension's own copy in
  `study/lookup.js` has only the bottom tier - a model needs a key or a local
  server and neither belongs in a content script - so with the daemon down it
  keys answers by word alone, because the archive allows about 600 words a day
  and keying by line would spend that on one film.
- **Lowercasing a word is a property of its language, so it takes the
  subtitle's language.** `study.js` folds every word through `fold(word,
  language)` rather than `toLowerCase()`, because Turkish disagrees with the
  default twice: `"İyi".toLowerCase()` is `i` plus a combining dot, and
  `"Işık".toLowerCase()` has a dotted i where Turkish wants the dotless one.
  Neither form is in any frequency table, and a word the table does not hold
  counts as rarer than the 30,000th word in it - so `iyi`, the 26th commonest
  word in Turkish film dialogue, was marked as very rare and took one of the
  line's two places every time it was said. Measured over the Turkish subtitle
  in `srt-viewer/subtitles`: 78 of 5,122 tokens fold differently under Turkish
  rules, 61 of them into words the table knows. Anything comparing a term
  against text has to fold BOTH sides the same way - the card's own quotation
  of the line was the second bug, where the fixed term could no longer be found
  inside a sentence folded the old way.
- **Study gets first refusal on the press AND on the release.**
  `claimPointerDown` deliberately declines a plain tap on a word, because the
  box has to stay draggable by its words and a tap is only a tap once it has
  failed to move. `onCuePointerUp` therefore asks `claimPointerUp` before
  forwarding the click to the player. Without that, tapping a word pinned it
  *and* played or paused the film - measured - and made the "pause when a word
  is clicked" setting impossible to switch off.
- **Ad time belongs to the playback, not to a subtitle and not to the tab.**
  `state.adDriftMs` is cleared by a new programme (`noticeProgrammeChange`) and
  by nothing else. `attach()` used to clear it, which destroyed the correction
  belonging to the track already on screen. Use `forgetAdDrift()`; there are
  three callers and they all have to forget the stamp as well as the number.
- **What a page may tell the extension is a STANDARD, with exactly one
  exception.** This is meant to be published, so a contract only one site
  implements is worth nothing. Three sources, and the order matters:
  - **schema.org (JSON-LD)** for identity. `pageInfo()` reads `name`,
    `partOfSeries.name`, `episodeNumber`, `partOfSeason.seasonNumber`,
    `datePublished` and `duration`, through `@graph` and array `@type`, because
    that is how site generators emit it. The series outranks the episode's own
    name in `SOURCE_RANK`, and that is load-bearing: an episode page names
    "Baggage" and "The Americans", and only the second can be looked up
    anywhere. `episodeNumber` is read as a NUMBER, so it never competes with
    `matchEpisode` scraping a digit out of a title.

    **It is also what says the programme CHANGED**, and the two readings have to
    stay the same reading. `statedProgramme()` builds the mark out of the series
    name and the stated season and episode - the search's own input - so the
    mark moves exactly when the query would move. They used to disagree: the
    detector keyed on the element's duration and the search on the page's
    metadata, and the window where the two disagreed was the window right after
    an episode changed. A stream produced as it is sent has no length for the
    first seconds of every episode, `noticeProgrammeChange` reads a lengthless
    mark as "ask again later", and so the last episode's identity was held over
    the new picture. Measured on the catalogue app 2026-08-25, one transition:
    the tab title moved between 09:30:32 and 09:30:42, the new subtitles went up
    at 09:30:47. Over 37 transitions in that log 31 were noticed unprompted and
    6 followed the reader touching something.

    **`statedSeconds` prefers a `VideoObject` and `statedProgramme` refuses
    one**, and that asymmetry is deliberate. A VideoObject describes the encode,
    so it knows the length to the millisecond - and its `name` is the media
    file's own name, written only once playback starts, so an identity built
    from it changes in the middle of an episode. The work (`Movie`, `TVEpisode`,
    `TVSeries`) is in `<head>` before a frame is decoded. Do not "simplify" the
    two into one reader.

    **The stated mark carries no duration on purpose.** A length that grows as
    the stream arrives is what used to churn it - 2701, 146, 2701, 530 over one
    evening, each flip taking both subtitles off. The length-and-title mark
    stays as the fallback for the sites that state nothing, which is most of
    them, and a harness check pins that shape so it cannot be quietly dropped.
  - **Media Session** for identity on sites with no structured data. Measured:
    an isolated world CAN read `navigator.mediaSession.metadata` that the page
    set. All three of `title`, `artist` and `album` are offered as candidates,
    because no standard says which carries the programme - one site puts the
    channel in `artist`, another puts the series there.
  - **`data-sso-time-offset` on the video**, in seconds, the only invented
    thing here. A stream that cannot be seeked is seeked by fetching a new one
    starting at the moment asked for, so the element's zero can be twenty
    minutes into the film. Both standards were tried and neither carries it:
    ffmpeg `-copyts` does not survive the MP4 muxer (Chrome reports
    currentTime 0 and buffered.start(0) 0 either way, measured side by side),
    and `MediaSession.setPositionState` has no getter.
  - **`data-sso-seek="film"` on the video**, the other half of that, and the
    second invented thing. Such a stream cannot be seeked by writing the
    element either: measured 2026-08-23 against the local player, `seekable`
    was the empty range [0, 0] while `buffered` held [0.08, 8.02], and every
    write came back 0 on the next read - backwards inside the buffer, forwards
    past it, past zero - each firing `seeking` and `seeked`. T and Y therefore
    threw the picture to the start of the stream, further back the longer it
    had played. A page carrying this attribute is ASKED: the moment goes on
    `data-sso-seek-to` in film seconds and a bubbling `sso:seek` event is
    dispatched on the video. Always at or before the moment given. `seekFilm`
    in `content.js` is the only place that writes or asks, and it reads the
    clock straight back to tell a player that moved from one that did not.
- **Nothing may assume the element's clock is the film's clock, or that its
  duration is the film's length.** `streamNowMs()` and `elementSeconds()` in
  `content.js` are the two directions and the only places that know; use them
  rather than `video.currentTime`. `filmSeconds()` is the length: the element's
  own duration is only what has ARRIVED on a stream produced as it is sent -
  3.878, 9.675, 18.476, 33.408 over the first fifteen seconds, measured in
  Chrome against a real 46:13 - and `seekable` cannot tell that apart from a
  short file, because Chrome reports one range over what has arrived. So a
  length seen to GROW ONCE is distrusted for the rest of that resource, and
  what the page states in schema.org is used instead. Two things about that
  counter are load-bearing and were each got wrong once. It is a count and not
  a time window: a stream is written in bursts and the gaps are seconds long,
  so a window said "still growing" then "settled" ten times in twenty-four
  seconds, and every flip took both subtitles off and put them back. And the
  threshold is one growth, not two: a duration arriving from NaN is not a
  growth, it is the first reading, so a player that states its length once and
  late still keeps its map at one. Raising it to two was measured costing ten
  seconds of "there is no video playing" at the start of every remuxed
  playback - twenty consecutive samples at 500ms with no video reported.
- **Nothing may assume the tick is 50ms of FILM.** It is 50ms of wall time, so
  at 2x playback it is 100ms of film and at 4x 200ms. Anything testing "are we
  near the end of this cue" has to work from the step the playhead actually
  took (`now - was`), not from `TICK_MS`. `pauseAtLineEnd` is the worked
  example, and the reason the harness's `currentTime` is configurable: a static
  playhead cannot show any of this, and the case that teleports it to 2.98s
  passed against a feature that was broken at every speed but one.
- **`api.daemon` never rejects, and callers rely on it.** A channel failure -
  the extension reloaded under an open tab - comes back as `{ transportError }`
  in the same shape the worker uses for its own errors. Every call site is an
  `await` inside something started from a click, which cannot catch. Anything
  new that starts async work from a handler goes through `api.detached(promise,
  "What it was")` so the failure is said rather than dropped.
- **`saveOffset` is throttled, and `loadOffset` reads the queue first.** The
  offset is written on every pointermove of a map drag and every 80ms of a held
  nudge. The pending value is newer than the stored one, so re-attaching the
  same file inside the window must not read back the older number.
- **A drag ends on `pointerup` AND on a move with no button held.**
  `event.buttons === 0` means the press ended somewhere we never heard about;
  without that branch the gesture outlives it and the next move — or the next
  click anywhere — re-times a subtitle or saves a word. It is in `makeMovable`,
  every resize grip, the timeline strip and both study sweeps. Copy it.

## Cost to keep in mind

**A freeze here is forced layout, not CPU.** Script time on the nested-player
vehicle is single-digit milliseconds a second; what stalls a frame is the
browser being asked to lay the page out again, and a CPU profile cannot see
that work at all. `Performance.getMetrics` over a fixed window is the
measurement — `LayoutCount`, `RecalcStyleCount`, `LayoutDuration` — never a
sample profile.

Two paths run hot and both are now guarded. Keep them that way.

- **`attachToCorrectParent` runs on every tick — twenty times a second — and on
  every pointer event.** `onPointerMove` fires for `pointermove` **and**
  `mousemove`, so a moving hand raises it about 240 times a second. Placement is
  still checked on every one of those (a site that removes our host has to be
  answered on the next tick), but the *re-raise* — `hidePopover()` +
  `showPopover()` on every host and every floating layer — is throttled to
  `RAISE_MS`. Fullscreen changes pass `force: true` and are never held back,
  which matters because that is the one moment the re-raise is not optional: the
  fullscreen element joins the top layer after us.
- **`rescale()` is a forced layout every time it runs** — it removes a transform
  and then reads `getBoundingClientRect`, a write followed by a read. Both
  `panel.js` and `study.js` gate it behind a `settle()` memo keyed on the
  destination *and the host*, so it runs when a surface actually moves and not
  otherwise. The host is part of the key because `turnOff` drops the focus box
  and `turnOn` builds a fresh one. A viewport resize is the other way the scale can
  change without a move, so `panel.js` answers that where `clampIntoView` is.

Measured with two subtitles attached, on `tests/frames`: panel open and mouse
still, 11.4 layouts/s against 0.8 with the panel shut. Mouse moving, 19.9
layouts/s and 49.6ms/s of task time before the two guards, 13.3 and 40.2ms/s
after. Two harness checks pin it — "a surface that has not moved is not measured
again" fails at 240 measurements for 60 pointer events without the memo, and its
companion asserts the other direction so the memo cannot be "fixed" by deleting
the measurement.

Adding work to either path is how this comes back.

**`samplePerf` in `content.js` is how to measure the real thing.** The vehicle
is one video and three short documents; the reports are about streaming sites
carrying five frames of player and adverts. It counts long tasks — one turn of
the event loop past 50ms, which *is* the freeze — with the tick and the pointer
handler timed beside them, and traces a `perf` line only for a window that
actually had one. A quiet ten seconds sends nothing, and neither does a hidden
tab: background timers are clamped to about one a minute, so the "long task"
there is the tab waking up. Read it out of `subtitle-daemon/logs/<date>.jsonl`
rather than asking anyone to reproduce.

What the first day of it said, over 505 windows: **our share of long-task time
was 0.0% to 0.3% on every host**, including the two the freezes were reported
on. The worst tasks, around 3.4s, arrived at the same instant across unrelated
tabs — machine-wide, not per-page and not ours. Read that as the extension
being ruled out, not as the sites being fine.

## Tests

Four checks. The first three need no dependencies and print PASS/FAIL
themselves; the fourth needs a real browser, and says so if it cannot find one.

```bash
node tests/worker.mjs          # the service worker, with Chrome stubbed
python3 tests/serve.py         # then open, in a browser:
#   http://127.0.0.1:8997/tests/harness.html    the overlay in a deliberately hostile page
#   http://127.0.0.1:8997/tests/fallback.html   the fetch path without the daemon

# and the one the other three cannot ask - the unpacked extension in Chrome,
# with the video in a cross-origin frame under a full-viewport interceptor:
npm i playwright-core          # anywhere; this repo does not depend on it
PLAYWRIGHT_PATH=<that>/node_modules node tests/frames/run.mjs
```

Use `tests/serve.py`, not `python3 -m http.server` — see `tests/README.md`.

`harness.html` loads the real `src/` files from disk, so it tests shipped code.
Counts go in the commit message (the convention is a trailing line like
`173 overlay, 25 fallback, 19 worker, 320 daemon`).

**A stub that is more forgiving than the API it stands for is not a test.**
Two of these have already hidden a whole feature that never ran:
`getManifest` returned a `css` key the real manifest does not have, so an
`insertCSS` that throws in Chrome looked fine and took the `executeScript`
after it down with it; and the storage stub handed every reader the same array
object, so three concurrent deck saves pushed into one array and all survived
by accident. Both now reject and copy the way the real thing does. When you add
to a stub, make it refuse what Chrome refuses.

**The daemon suite is part of this extension's net**, not a separate project:
`subtitle-daemon/tests/test_js_parity.py` runs `src/subtitles/*.js` under node
and diffs it against the Python, and `test_align.py` drives `src/align.js` over
the real subtitle corpus. A change to either side needs `uv run pytest` in
`subtitle-daemon/` as well.

**A new check has to fail against the old code before you trust it.** Revert the
fix, run it, see the reported symptom in the failure message, put the fix back.
Three checks written this way caught real holes their authors had not thought
of — the toast host missing a guard, the settings window being a separate
surface, and a search fix that four green suites said was complete.

**The harness cannot see the frame problem above.** It is a single document, so
`tests/frames/` exists for that: two `serve.py` instances on two ports, which
are two origins, a player page in a nested iframe and a fixed full-viewport
interceptor the top page can switch on. Twelve assertions, and the two that
matter most are the reverse ones - a video in the top frame must still draw
everything in that one frame, and no second frame may do anything.

Two things about it that cost time to learn:

- **The player page needs a real video file**, not a `defineProperty` on
  `duration`. The single-document harness gets away with that because it loads
  `src/` as page scripts; here the content script is in the isolated world,
  where a page-world redefinition is invisible, `duration` reads NaN and
  `pickVideo` correctly rejects the page. `clip.mp4` is 95s of flat colour at
  6KB, and the ffmpeg line that made it is in `player.html`.
- **Wait for the thing, do not sleep.** Everything here is settled by a tick
  that is 500ms when nothing is attached, behind a video loading over a socket,
  behind an extension installing. And the CC button fades after 2.6s of
  stillness by design, so a poll that only looks is racing that timer - it has
  to keep the pointer moving. Both of those produced a check that passed twice
  and failed on a cold profile.

## The manifest, and two things that are load-bearing in it

- **`content_scripts[0]` has `js` and deliberately no `css`.** Every stylesheet
  is fetched at runtime and adopted into a shadow root, because streaming sites
  ship a strict `style-src`. Anything passing `scripts.css` to
  `chrome.scripting.insertCSS` therefore passes `undefined`, and Chrome answers
  that with *"Exactly one of 'css' and 'files' must be specified"* - which is
  how both re-injection paths spent their whole life throwing on their first
  line. `inject()` in `background.js` is the only caller; keep it the only one.
- **`host_permissions` includes `<all_urls>` and needs to.**
  `chrome.scripting.executeScript` requires a host permission for the target,
  and the sweep over already-open tabs on install has no `activeTab` grant to
  borrow. It is not extra access: `content_scripts` already matches
  `<all_urls>`, so this only lets the programmatic API reach what the
  declarative one already does.

## Reloading during development

`chrome://extensions` → reload. The content scripts tear down and re-inject
themselves, and the service worker re-injects into every open tab on update -
which now actually happens, so a page reload should not be needed. Reload the
tab anyway when touching `background.js`, since the worker does not re-run for
tabs that already have a current content script.
