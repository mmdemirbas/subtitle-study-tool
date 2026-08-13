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
| `study.js` | 2.0k | the study rail, word cards, the deck, the lookup popup | `window.__ssoStudy`, `__ssoStudyTeardown` |

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

**Still open:** the study rail and clicking a word both need the cue text, so
they stay in the video's frame and remain behind a parent overlay on a site
that paints one. The cue overlay is there too, which is right — it only has to
be seen, and a transparent interceptor does not hide it.

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
- **Nothing may overlap a control in a `.sso-win__head`.** The corner resize
  grips sit above the head, so the head clears them with `--sso-grip`-derived
  padding. Measured before that: the NE grip covered 169 of the close button's
  576 square pixels including its centre, so the × could not be pressed at all,
  on every window at every size. A harness check hit-tests every head control
  on every window we draw.
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
  otherwise. The host is part of the key because `turnOff` drops the rail and
  `turnOn` builds a fresh one. A viewport resize is the other way the scale can
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
