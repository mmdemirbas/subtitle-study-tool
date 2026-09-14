# What is under the hood, read from the log and the source

14 September 2026. "I think there is a mess under the hood. Let's tidy up the
codebase and hunt the bugs and improve usability and performance further."

Two sources, nothing reproduced. The running log, `subtitle-daemon/logs/*.jsonl`,
fifteen days between 11 August and 14 September 2026: 24,973 lines, 50.5 MB.
And a count over `browser-extension/src/` of every top-level definition, its
length, and how many places in `src/` and `tests/` name it. `browser-extension/tools/survey-log.py`
and `browser-extension/tools/survey-code.mjs` are the scripts; they print the
numbers below and nothing else.

## What the log is made of

| kind | lines | bytes | share |
|---|---|---|---|
| panel (the frame tree on every open and close) | 2,212 | 28.1 MB | 55.7% |
| perf (a window with a long task in it) | 14,421 | 7.1 MB | 14.1% |
| align (both tracks' cue times per attempt) | 329 | 5.0 MB | 9.9% |
| autoAttach (the plan, with the results it ranked) | 426 | 4.0 MB | 8.0% |
| survey (the shape of a tabii/Disney+ player's traffic) | 1,665 | 1.6 MB | 3.2% |
| sync (a correction by hand) | 1,238 | 1.1 MB | 2.2% |
| said (every message shown) | 1,818 | 0.5 MB | 1.0% |
| error | 662 | 0.3 MB | 0.7% |
| everything else | 2,202 | 2.8 MB | 5.2% |

Two of those rows were not about this extension at all.

**All 662 error lines were a page's.** Every one is "ResizeObserver loop
completed with undelivered notifications", the `file` is the page's own URL,
and the handler's `mine` flag - set when the file or the stack is under
`chrome-extension://` - is false on every one. 232 came from one chat page,
96 from another, 45 from a mail client. No error of the extension's own
reached the top of a frame or the worker in fifteen days.

**12,368 of the 14,421 perf lines came from a page with nothing of ours on
it** - no subtitle attached, no panel, no split role. The gate added on
2026-08-24 already excluded hidden tabs; the front tab of every page the
reader had open still reported, and each line carried the tab's title and
URL with its query string: 7,430 from the reader's own local app, 1,762 from
a dev server, 872 from LinkedIn, 598 from a chat, 247 from mail. The
extension was writing down the pages the reader visited, session ids in the
query included, and the number it was there to measure - our share of a long
task on a page where we only tick - was 3ms in 310 pointer moves.

Fixed in `8652575`: the error handlers return unless the error is ours; the
perf sample returns unless something is attached, the panel is open or drew
in the window, or the frame is one half of a split.

## What the reader's last full day looked like

The `said`, `attach`, `autoAttach`, `command` and `reorder` lines for
2026-09-13, in order, read as the day the extension gave somebody. Three
things in it were defects.

**Every film was dragged into the other order, and then the study surface
was reset.** Six reorders that day, all EN to slot 1 (or TR to slot 2); over
the whole log 8 reorders, 4 followed within five minutes by study mode off
and on again. The order: `sso:usedLanguages` was written on every attach and
never on a move, so the next film started in the order the last one was
attached in, whatever had been dragged since. Fixed in `f1e962a` before this
pass. The study reset follows from it: study follows a subtitle *number*, the
number it followed held TR, and a move carries the flags with the file - so
after EN was dragged to slot 1 the words being marked were still TR's, and
off-then-on was the reader's way of pointing study at slot 1 again. With the
order remembered, the next film starts EN first and study starts on it. Not
changed further.

**Browsing Prime Video cost searches, downloads and toasts for trailers.**
The site plays a trailer in the hero of every detail page and of the
storefront, large and long enough to pass `pickVideo`, so each one was a
programme to the frame and an automatic run to the worker. 12:47:11 to
12:47:37, three plans in thirty seconds while moving between titles: the
page's own list for one trailer, then two OpenSubtitles searches for two
films whose trailers were playing, both attached (both from the cache, which
is why they cost no allowance that day - a film not yet watched would have
cost two of the day's five or ten). 05:22 to 05:32, six "No video playing on
this page" toasts, one per trailer that had ended before its plan was made,
to a reader who had pressed nothing. And at 05:22:33, "The page no longer
offers that subtitle - play the video and try again", twice, with both slots
emptied: the player had asked for the same title's resources twice, the
second answer carried no tracks, and the ear posted it over the first.

Three fixes. `f5af54d`: an empty answer for a title already listed keeps the
list (a different title's empty answer still replaces it). `61c1c32`: an
automatic run under ten minutes uses what the page carries and searches for
nothing, says no "Looking for subtitles…", and an automatic run that finds
no film writes `skipped: "no video"` to the log instead of a toast; the
shortcut and the toolbar keep both. Nothing about the programme mark
changed, so a trailer still gets the page's own subtitles for it.

**A timer of mine outlived its injection.** The check that drops a page's
own list on a navigation without a reload (`2f147ac`) ran on a `setInterval`
that `__ssoTeardown` did not clear, so every extension reload left the
previous copy asking once a second from an invalidated context. Quiet, since
a list that has not moved is a no-op, but a timer in a dead closure for the
life of the tab. Folded into the tick in `256fbcc`.

**"Nothing matched "Scarpetta - Season 1" well", ten times, for the episode
being watched.** Prime Video titles a series page "Prime Video: Scarpetta -
Season 1" and puts the episode on the player's overlay; the overlay was read
(S1 E1) but the query went out with "- Season 1" still in it, resolved to
nothing, and fell back to the name score: 0.5882 against "Scarpetta - S01E01
Bridge of Time (1)", under 0.75, five results each time and every one the
right episode. Both title guessers now take a trailing "Season N" as the
season; "Scarpetta" resolves to tt14786934 against the running daemon, and a
resolved title attaches however its uploader named the file. `567ff9b`.

**The survey read media segments to find out they were not playlists.** tabii
serves them as binary/octet-stream by Range request, and the only thing
keeping each one from being cloned and decoded into a string on the player's
main thread was the 2 MB size cap - the log's survey entries show none
digested, which is the cap working by luck. An untyped body is now read as a
stream and the first 64 bytes decide. `808e61e`.

Looked at and found in order: the 211 `seek` lines (171 are the catalogue
app's own contract, `asked: "page"`; on Prime Video 35 of 35 element seeks
landed); the 66 `warmNext` lines (all `attach`); our share of the 252 windows
with a film attached since 10 September (tick 26ms median per ten seconds
across 200 ticks, panel 1ms median and 84ms worst, map 86ms worst, against a
page median of 60ms of long task); the daemon's stderr (four lines, no
traceback); the "Monk" refusals (before `c75f539` landed the same day).

## What the source is made of

| file | lines | top-level definitions | over 80 lines |
|---|---|---|---|
| content.js | 8,493 | 264 | 9 |
| panel.js | 5,335 | 136 | 16 |
| study.js | 3,287 | 115 | 5 |
| background.js | 1,312 | | 2 |
| everything else under src/ | 10,475 | | 6 |

Referenced nowhere but their own definition, across `src/` and `tests/`: one
function, `findByContent` in `cache.js`. Referenced only from a test:
`subtitleRenditions` in `vtt.js`, whose job the streams ear does in the
page's world, and `unpackTimes` in `trace.js`, which is the documented decoder
for a log reader and stays. `TODO`/`FIXME`/`HACK`: none. The first two are
removed in `256fbcc`.

The 38 functions over 80 lines are where the length is. The three largest:

| function | lines | shape |
|---|---|---|
| `panel.js` `buildTimeline` | 714 | 18 inner functions over shared window state - the map component, written as one closure |
| `panel.js` `buildTrackCard` | 515 | 6 inner functions; the card's head, map, and rows |
| `panel.js` `refresh` | 355 | one function, the panel's whole status-round redraw |

None of the three has a defect the log or the harness can point at, and the
298-case harness exercises all three. What they cost is the reading: a change
to the map means reading 714 lines to find the 20 that matter.

## What was not done, and what it would take

- **Splitting `buildTimeline` and `buildTrackCard` out of `panel.js`.** The
  four content scripts are plain scripts sharing globals, not modules, so a
  split is a fifth script in the manifest, the harness's load list and
  `inject()`, plus a global for the panel to reach it - the same shape
  `study.js` took when it left `content.js`. Counted (`browser-extension/tools/free-vars.mjs`):
  `buildTimeline` reaches for 15 names in the panel's scope (`api`,
  `playhead`, `button`, `screen`, `refresh`, `show`, `sayInPanel`, ...) and
  `buildTrackCard` for 15, so the seam is a fifteen-item dependency bag, not
  an interface. About a day's work with a real regression surface, no defect
  behind it, and the closure moved rather than made smaller. Not done.
- **1,238 corrections by hand in fifteen days** is the largest number in the
  log and not a tidy-up. `docs/reports/sync-by-hand-2026-09-03.md` is the
  standing analysis; nothing here changes it.
- **The panel diagnostics are 56% of the log at 12.7 KB per open or close.**
  By design - the frame tree is what answers "what does that page look like" -
  and the disk is 50 MB over fifteen days. Left alone.
- **YouTube's caption fetch with the overheard `pot` token** is still
  unobserved: no YouTube playback in the log has had captions turned on.

## Recommendation

Read the log again after a week on `61c1c32`: the `perf` and `error` kinds
should be a few lines a day from pages with a film on them, the `autoAttach`
lines from Prime Video should show `decision: "short"` for trailers and no
`skipped: "no video"` toasts, and no reorder should be needed on a film
whose last one was dragged.
