# browser-extension — architecture and invariants

`README.md` is the user-facing install and feature guide. This file is the map
you need before editing `src/`. Read the root `CLAUDE.md` for commit style.

## The four content scripts, and what each owns

All four are injected into **every frame** (`all_frames: true`) and run in the
extension's isolated world. They talk to each other through globals on that
isolated `window` — never through the DOM, and never reachable from the page.

| File | Lines | Owns | Exposes |
|---|---|---|---|
| `align.js` | 435 | matching a subtitle's timing to the playing release | — |
| `content.js` | 3.5k | the video, the playback clock, the cue overlay, the CC handle, settings, keys, frame/fullscreen plumbing | `window.__ssoApi`, `__ssoTeardown` |
| `panel.js` | 2.5k | the control panel window (search, attach, sync, settings) | `window.__ssoPanel`, `__ssoPanelTeardown` |
| `study.js` | 1.9k | the study rail, word cards, the deck, the lookup popup | `window.__ssoStudy`, `__ssoStudyTeardown` |

`content.js` is the only one that touches the `<video>`. `panel.js` and
`study.js` reach it exclusively through `window.__ssoApi`. Keep that direction:
nothing in content.js should depend on the panel's internals, only on the
`__ssoPanel` / `__ssoStudy` method surface it calls (`toggle`, `reparent`,
`rescale`, `onCue`, `claimPointerDown`, `saveTop`, `setEnabled`).

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
- **Fullscreen is handled by the top layer, not by re-parenting.**
  `toTopLayer()` in `content.js` promotes each host with
  `popover="manual"` + `showPopover()`. Appending into the fullscreen element
  is only the fallback, and it **must** refuse a replaced element: several
  players (and Chrome's own "fullscreen the video") fullscreen the `<video>`
  itself, and a child of `<video>` is never painted — the surface silently
  renders 0x0 while reporting itself open. That is the "the button does
  nothing" report.
- **Menus and popups get their own host** (`makeLayer()`), because anything
  drawn inside the panel is clipped by it.
- **`document` listeners are capture-phase.** Players routinely
  `stopPropagation()` on pointer events inside the player, which silences any
  bubble-phase listener exactly where it is needed.

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
`151 overlay, 22 fallback, 9 worker`).

**The harness cannot see the frame problem above.** It is a single-document
page, so anything about nested frames, cross-origin players or a parent page's
overlay has to be checked in a real browser on a real site.

## Reloading during development

`chrome://extensions` → reload. The content scripts tear down and re-inject
themselves, but the service worker does not re-run for already-open tabs —
reload the tab too when touching `background.js`.
