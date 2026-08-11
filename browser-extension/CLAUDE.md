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
| `content.js` | 4.0k | the video, the playback clock, the cue overlay, the CC handle, settings, keys, frame/fullscreen plumbing | `window.__ssoApi`, `__ssoTeardown` |
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

The extension builds its UI **in whichever frame owns the `<video>`**.
`onPointerMove` gates on `isPageSubject(pickVideoCached())`, so on a page with
no video nothing is built at all.

On real streaming sites the video is usually **not** in the top frame. Measured
on `streaming-site.example` (2026-08-08):

```
top      streaming-site.example/tv/...              no video   1400x813
 └─ [0]  streaming-site.example/watch/index.html    no video   same-origin
     └─  embos.top/tv/?mid=...                THE VIDEO  cross-origin, 1136x568 at (32,120)
```

So the panel, the study rail and the CC handle are all drawn inside a
cross-origin iframe two levels deep that occupies a fraction of the viewport.

**A nested frame cannot escape its parent's stacking order.** Verified: a
`popover` element promoted to the top layer inside an iframe still loses to a
plain `position:fixed; inset:0; z-index:2147483647` div that the *parent*
document appends to `<html>` — the click goes to the parent's overlay and the
in-iframe panel never sees it. The top layer is per-document; the iframe as a
whole is one box in the parent's paint order. No z-index and no `showPopover()`
inside the frame can change that.

This is a known open defect — see `docs/reports/`.

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

`onPointerMove` fires on every `pointermove` **and** `mousemove` and calls
`revealHandle()` → `attachToCorrectParent({raise: true})`, which does
`hidePopover()` + `showPopover()` on every host and every floating layer. That
is several top-layer teardowns per mouse move. It does **not** break clicks
(measured: the click still fires), but it is not free — don't add work to that
path.

## Tests

No runner, no dependencies. All three print PASS/FAIL and run themselves.

```bash
node tests/worker.mjs          # the service worker, with Chrome stubbed
python3 tests/serve.py         # then open, in a browser:
#   http://127.0.0.1:8997/tests/harness.html    the overlay in a deliberately hostile page
#   http://127.0.0.1:8997/tests/fallback.html   the fetch path without the daemon
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

**The harness cannot see the frame problem above.** It is a single-document
page, so anything about nested frames, cross-origin players or a parent page's
overlay has to be checked in a real browser on a real site.

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
