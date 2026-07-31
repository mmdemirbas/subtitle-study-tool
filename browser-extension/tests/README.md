# Extension tests

Open `harness.html` in a browser. It runs itself and prints PASS/FAIL down the
right-hand side. No install, no test runner, no dependencies.

```bash
cd browser-extension
python3 -m http.server 8997
# then open http://127.0.0.1:8997/tests/harness.html
```

It needs to be served over HTTP rather than opened from `file://`, because the
overlay fetches its stylesheet and `file://` blocks that.

## What it is for

The daemon had regression tests from the start; the extension had none, and it
showed. The control panel, the CC handle and subtitle markup each broke on a
real streaming site *after* being verified by hand, because a hand check
happens once and a page is hostile forever.

So the harness is not a generic test page. It is a reconstruction of the
specific things streaming sites do that have broken this extension:

| The page does this | What it broke |
|---|---|
| `button { opacity: 0; visibility: hidden; transform: scale(0) !important }` | CC handle invisible |
| `span { font-style: normal !important }` | subtitle italics cancelled |
| `span { color: #ff00ff !important }` | speaker and sound colouring flattened |
| `div { line-height: 3; letter-spacing: 2px }` | control panel layout pulled apart |
| A chrome element appended after ours at the same `z-index` | overlay painted over |
| `stopPropagation` on pointer events inside the player | handle never appeared |
| A mid-roll ad stitched into the same stream | every cue after the break late by the ad's length |

Each row cost a round trip to discover. Anything that survives this page
survives Prime Video.

## The cases

Twenty-four, covering: shadow-root isolation, cue colour, italics, speaker
colour, non-speech dimming, sound symbols, handle visibility under a
pointer-event-swallowing player, handle size under a button reset, stacking
against later chrome, the handle opening the panel, Turkish-Q bracket keys
nudging the offset, typing in the panel *not* nudging, and re-injection
leaving exactly one overlay. Four more cover mid-roll ads: the break being
measured, the cue surviving it unchanged, subtitles hidden while the ad runs,
and a flickering marker not being mistaken for a break.

Six more cover moving the subtitle: dragging it, the position persisting,
the clamp that stops it leaving the screen, a click without movement still
reaching the player, reset, and placement mode producing something to grab
between two lines.

The ad cases advance `video.currentTime` while an ad marker is on screen,
which is what server-side ad insertion does to the clock. They take a few
seconds because the detector polls.

## Adding a case

Append a `check("name", fn)` near the others; throw with a message explaining
what was expected. Cues 1 and 2 differ — cue 1 has a speaker run, cue 2 has
italics, a sound run and a symbol — and only the cue under the playhead is
rendered, so call `showSpeakerCue()` or `showSoundCue()` first.

**When a bug is found on a real site, reproduce it here before fixing it.**
That is the whole point: the fix is only trustworthy if the harness failed
first.
