# Subtitle Overlay (browser extension)

Puts subtitles on a video that has none, in the tab you are already watching.

## Install

Chrome, Edge, Brave or any Chromium browser:

1. Start the daemon first — `cd ../subtitle-daemon && ./run.sh`
2. Open `chrome://extensions`
3. Turn on **Developer mode** (top right)
4. **Load unpacked** → select this `browser-extension/` directory

There is no icon file, so the toolbar shows a default placeholder. Pin it.

### After changing the code

Reloading the extension does **not** update tabs that are already open — they
keep running the previous content script until navigated, which makes changes
look like they did nothing. The service worker now re-injects on install and
update, and repairs a stale tab on the next command, so a page reload should no
longer be necessary. If something still looks unchanged, reload the page.

New keyboard commands are a separate trap: Chrome does not always bind a
`suggested_key` that was added to an extension already installed. Check
`chrome://extensions/shortcuts` — the popup lists the live bindings, and shows
*unset* when this has happened.

## Use

**The fast path:** press <kbd>⌘⇧S</kbd>. It works out what the page is playing,
searches, and puts the best match on screen. If nothing matches the title well
it opens the control panel instead of guessing — it will not spend a download
on a film it is not confident about.

**The control panel:** <kbd>⌘⇧K</kbd>. Search, timing, appearance and key
bindings, in a draggable panel over the video. This is the main surface. It
lives in the page rather than in the toolbar popup because **a popup cannot be
opened while the page is fullscreen**, which is exactly when you need to fix
timing.

The toolbar popup is a launcher and a status readout — whether the daemon is
up, whether a subtitle is attached, and the current shortcuts.

### Keys

| Key | Effect |
|---|---|
| <kbd>⌘⇧S</kbd> | Find and attach subtitles |
| <kbd>⌘⇧K</kbd> | Control panel |
| <kbd>⌘⇧X</kbd> | Hide / show subtitles |
| <kbd>[</kbd> / <kbd>]</kbd> | Shift subtitles 0.25s earlier / later |
| <kbd>Shift</kbd> + <kbd>[</kbd> / <kbd>]</kbd> | Shift by 1s |
| <kbd>\\</kbd> | Reset the offset |
| <kbd>P</kbd> | Control panel |
| <kbd>O</kbd> | Hide / show subtitles |

In-page bindings match on the **physical key**, not the character it produces.
On a Turkish Q layout the two keys right of P print ğ and ü, but they are still
`BracketLeft` and `BracketRight` — so the defaults stay in the same physical
place on every layout without needing an AltGr chord. All of them are
rebindable in the panel: click a binding, press the key you want.

The ⌘⇧ shortcuts are Chrome's, changed at `chrome://extensions/shortcuts`.

The offset is remembered per subtitle file, so a film you come back to keeps
the correction you already made.

## Why sync is not a problem here

The usual difficulty with an external subtitle track is guessing how far ahead
or behind the video it is, then watching that guess drift.

None of that applies in a browser. The `<video>` element exposes
`currentTime`, and the overlay reads it 20 times a second. Seeking, pausing,
buffering and playback-rate changes are all reflected immediately, because the
overlay is not keeping its own clock — there is nothing to drift.

What remains is the offset baked into the subtitle file itself, from being
timed against a different release of the film. That is a constant, you set it
once with the bracket keys, and it is saved.

## Working out what is playing

The tab title is the weakest signal available. Prime Video calls a detail page
`Prime Video: Crime 101`; other sites bolt on resolutions, episode numbers and
marketing. So the content script reads `og:title`, `twitter:title` and JSON-LD
`Movie`/`TVEpisode` entries first — what the site tells crawlers the page is
about — and falls back to the tab title only if none of those exist.

Whatever comes out is still a guess, so the panel shows it and lets you correct
it, and auto-attach refuses to download anything that does not match it well.
That guard exists because the first version had none: it downloaded the top
fuzzy hit for `Prime Video: Crime 101` and displayed subtitles for an unrelated
2007 Japanese horror film.

## Why the panel is in a shadow root

Injected UI competes with the host page's stylesheet, and the page usually
wins. Verified against a page carrying two rules of a kind streaming sites ship
routinely:

| Page rule | Effect on a light-DOM panel |
|---|---|
| `button { font-size: 40px !important }` | every control resized |
| `div { line-height: 3; letter-spacing: 2px }` | inherited through, layout pulled apart |

`all: initial` on the panel root does not help: it resets the root only, never
its descendants. A shadow boundary does, so the panel lives in one.

Two consequences worth knowing before editing:

- The host element carries **geometry only** — position, width, z-index, all
  inline `!important`. Nothing visual, because anything visual there would be
  fighting the page forever. Appearance is on `.sso-panel` inside the shadow.
  `:host` rules are not used for anything load-bearing: inline `!important`
  outranks them, and page rules outrank `:host` for normal declarations anyway.
- Events crossing a shadow boundary are **retargeted to the host**, so
  `event.target` at document level reports a plain div. The key handler reads
  `event.composedPath()[0]` instead; otherwise typing `[` or `]` into the
  panel's own search box would nudge the subtitle timing.

Styles load as a constructable stylesheet via `adoptedStyleSheets` rather than
a `<style>` element, because adopted sheets are not subject to the page's
Content-Security-Policy and streaming sites tend to ship a strict `style-src`.

## Two implementation details that matter

**Fullscreen.** When a player goes fullscreen the browser renders only the
fullscreen element's subtree, so an overlay parented to `<body>` silently
disappears. The overlay re-parents itself to `document.fullscreenElement` on
every fullscreen change.

**Frames.** Streaming players usually live in an iframe, so the content script
runs in all frames. Frames without a usable video do nothing; the popup and the
service worker enumerate frames and address the one that has the player. That
also keeps status messages visible in fullscreen, where a toast in the top
frame would not be rendered.

The video is chosen as the largest one with a duration over a minute,
preferring a playing one — which skips ad slots, preview loops and hidden
elements.

**Daemon calls go through the service worker.** MV3 content scripts cannot make
cross-origin requests with extension permissions, and the daemon's origin
allowlist would refuse the page's origin anyway. The panel and popup both send
their daemon calls to the background worker, which is the only thing holding
the host permission.

## Boundaries

- The extension talks only to `http://127.0.0.1:8791`. It has no other host
  permission, so the OpenSubtitles API key never enters a web page.
- **DRM-protected video** (Netflix, Prime Video, Disney+) works for the
  overlay: the DOM overlay draws over protected video, and `currentTime` is
  readable. What will not work is future audio capture for live transcription,
  since protected streams yield silence.
- Subtitle text is inserted with `textContent`, never `innerHTML`, so subtitle
  markup cannot execute in the page.

## Not done yet

- No icon assets.
- Only tested against Chromium. The manifest is plain MV3 and `moz-extension://`
  is already in the daemon's origin allowlist, but Firefox is untested.
- Live transcription fallback is not wired in — see the repo README.
