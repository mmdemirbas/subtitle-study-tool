# Subtitle Overlay (browser extension)

Puts subtitles on a video that has none, in the tab you are already watching.

## Install

Chrome, Edge, Brave or any Chromium browser:

1. Start the daemon first — `cd ../subtitle-daemon && ./run.sh`
2. Open `chrome://extensions`
3. Turn on **Developer mode** (top right)
4. **Load unpacked** → select this `browser-extension/` directory

There is no icon file, so the toolbar shows a default placeholder. Pin it.

## Use

**The fast path:** press <kbd>⌘⇧S</kbd>. It reads the tab title, searches,
picks the best match, downloads it and puts it on screen. Nothing else.

**The deliberate path:** click the toolbar button. The popup searches
immediately — searching costs nothing — and shows what it found. Click a result
to attach it. Downloading is the only thing that spends quota, so it stays
behind a click.

If the tab title was a bad guess, edit the box at the top and press Enter.

| Key | Effect |
|---|---|
| <kbd>[</kbd> / <kbd>]</kbd> | Shift subtitles 0.25s earlier / later |
| <kbd>Shift</kbd> + <kbd>[</kbd> / <kbd>]</kbd> | Shift by 1s |
| <kbd>\\</kbd> | Reset the offset |
| <kbd>⌘⇧X</kbd> | Hide / show the overlay |

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
