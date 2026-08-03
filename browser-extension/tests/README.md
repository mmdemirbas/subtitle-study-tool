# Extension tests

Two pages. Both run themselves and print PASS/FAIL. No install, no test runner,
no dependencies.

```bash
cd browser-extension
python3 -m http.server 8997
# http://127.0.0.1:8997/tests/harness.html   - the overlay in a hostile page
# http://127.0.0.1:8997/tests/fallback.html  - fetching without the daemon
```

There is a third, which lives on the daemon's side because it needs both
languages at once: `subtitle-daemon/tests/test_js_parity.py` runs the Python
pipeline and the JavaScript one over the same inputs and diffs the results. Run
it with `uv run pytest` from `subtitle-daemon/`.

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

Thirty-three, covering: shadow-root isolation, cue colour, italics, speaker
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

Nine more cover how wide it is and who decides where a line breaks: the
file's own breaks being rewrapped, a turn between two speakers keeping its
break, rewrapping off restoring both, the box reaching the whole width it is
given, narrowing pushing the text onto more rows, a long line staying on
screen after the box was placed against an edge with a short one showing,
widening not pushing it off the screen, an edge-drag resizing, and a
middle-drag still moving rather than resizing.

The ad cases advance `video.currentTime` while an ad marker is on screen,
which is what server-side ad insertion does to the clock. They take a few
seconds because the detector polls.

## fallback.html

The extension can fetch subtitles on its own when the daemon is not running.
That path has three parts the parity test does not reach — the rule for which
side answers, the IndexedDB cache, and the convergence with the daemon's cache —
so they are checked here against a stubbed OpenSubtitles and a stubbed daemon.

Sixteen cases. The ones that matter are about quota, and they assert it
directly: the stub counts calls to the download endpoint, so "this did not spend
a download" is a number, not an inference from a cache flag. Covered: the
extension answering alone, the title being cleaned before it is searched for,
cues coming back annotated, the same file not being fetched twice, *another
upload of the same film* not being fetched either, searches being replayed from
cache, a replay noticing a download made since it was cached and forgetting a
promotion that no longer applies, the daemon winning when it is up, a daemon
error not being retried locally, both directions of the sync, a pulled subtitle
working offline afterwards, the sha256 surviving the copy, and a missing API key
being reported rather than failing silently.

It found two real bugs on its first run: a cache miss that returned a truthy
wrapper object, so every lookup reported a hit and the fetch short-circuited to
zero cues; and a six-hour window in which a replayed search still ranked by what
was held when it was first run, which could send auto-attach to a different
upload of a film already on disk. The second was inherited from the daemon and
is now fixed on both sides.

## Adding a case

Append a `check("name", fn)` near the others; throw with a message explaining
what was expected. Cues 1 and 2 differ — cue 1 has a speaker run, cue 2 has
italics, a sound run and a symbol — and only the cue under the playhead is
rendered, so call `showSpeakerCue()` or `showSoundCue()` first.

**When a bug is found on a real site, reproduce it here before fixing it.**
That is the whole point: the fix is only trustworthy if the harness failed
first.
