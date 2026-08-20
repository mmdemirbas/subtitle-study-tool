# Extension tests

Two pages and one script. All three run themselves and print PASS/FAIL. No
install, no test runner, no dependencies.

```bash
node tests/worker.mjs    # the service worker, with Chrome stubbed
```

The worker one exists because neither page loads `background.js` — one is the
overlay in a hostile page and the other is the fetch path, and both stub the
worker away, because that is what a content script sees. The half of the
extension that decides what to do with a *tab* had nothing running it.

```bash
cd browser-extension
python3 tests/serve.py
# http://127.0.0.1:8997/tests/harness.html   - the overlay in a hostile page
# http://127.0.0.1:8997/tests/fallback.html  - fetching without the daemon
```

**Use `tests/serve.py`, not `python3 -m http.server`.** It is the same thing
with `Cache-Control: no-store` on every reply, and that is load-bearing: the
browser's memory cache does not revalidate a URL it has already seen this
session, and the page URL is not the script URL. Reloading a test page reloads
the page and keeps the *previous* `content.js`, so the suite passes while
describing code that is no longer on disk. `harness.html` also appends a
cache-buster to its own `<script src>` tags, but a page cannot defend what a
module imports — `fallback.html` imports `provider.js`, which imports
`cache.js`, and nothing in the page ever names that URL.

**Give the window room: 1512x944 or larger.** The pages are written to be
opened in an ordinary browser window, and a few checks drag a surface to a
fixed point and assert that it moved. Run `harness.html` in a 1280x720 viewport
and "a strip has its own place, and is dragged like a subtitle" fails on its
own: the strip starts at y=526 and the drag target is y=520, so it travels 14px
where the check wants 40. Nothing is wrong with the overlay. Anything driving
these pages headlessly has to set the viewport, and `deviceScaleFactor: 2`,
which several of the geometry checks also assume.

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
| A feed row playing a hover preview of another video | CC handle appeared on the home page |

Each row cost a round trip to discover. Anything that survives this page
survives Prime Video.

## The cases

Fifty-five. The first thirty-seven cover the single-subtitle overlay; the rest
cover two at once and study mode, described at the end.

Thirty-seven, covering: shadow-root isolation, cue colour, italics, speaker
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

Four more cover where the CC handle is allowed to appear: a feed row's hover
preview not getting one, a video too small to be what the page is about not
getting one, a preview still not getting one once a narrow window has made it
large enough to clear the size floor, and a player that is merely large — a
third of the window, not all of it — still getting one.

Six cover two subtitles at once, and every one of them is an *independence*,
because a shared value is exactly how a dual display goes wrong: one that
renders both and then moves them together is the bug that looks like the
feature. The second gets its own box beside the first, the pair arranges itself
without being asked, each keeps its own offset, dragging one leaves the other,
hiding one leaves the other showing, detaching one leaves the other attached,
and an arrangement made by hand is not overwritten by the next attach.

Eleven cover study mode. Half are about it working — words becoming elements
only once it is on, the rare word marked and the common ones not, the threshold
deciding which is which, a hover looking a word up into the rail, the card
carrying the line the word was in, saving keeping that line and the timestamp, a
saved word marked as met before, and a shift-drag keeping the phrase rather than
one word. The other half are about it not breaking anything: a click on the film
still reaching the player, dragging still moving the box, and turning it off
taking the rail and the marks away. Those three are the ones that matter, since
a feature that eats a click meant for a film is worse than no feature.

The ad cases advance `video.currentTime` while an ad marker is on screen,
which is what server-side ad insertion does to the clock. They take a few
seconds because the detector polls.

## fallback.html

The extension can fetch subtitles on its own when the daemon is not running.
That path has three parts the parity test does not reach — the rule for which
side answers, the IndexedDB cache, and the convergence with the daemon's cache —
so they are checked here against a stubbed OpenSubtitles and a stubbed daemon.

`options-preview.html` is not a test — it renders the settings page against a
stubbed service worker so the layout can be looked at without loading the
extension into Chrome. It exists because a table that renders wrong is not
something a passing test notices: the Delete column was landing outside the card
and behind a horizontal scroll, which no assertion here would have caught.

Twenty-two cases. The ones that matter are about quota, and they assert it
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

Cache management adds six more: what is held listed with sizes and dates,
entries in both stores appearing once rather than twice, deleting with the
daemon running, **deleting with the daemon stopped not undoing itself**,
forgetting searches without touching downloads, and deleting everything.

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
