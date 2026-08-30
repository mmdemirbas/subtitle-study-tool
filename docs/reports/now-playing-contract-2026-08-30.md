# Saying what is playing: the contract that removes the wait

**Both halves are implemented.** The extension and the daemon are in this repo;
the player side is in `~/dev/mmdemirbas/movies`
(`src/lib/components/local-player.svelte`). This is the companion to
`seek-contract-2026-08-23.md`, which added the other direction of the same
contract, and it is written so a third party can implement either side without
reading either codebase.

## What the reader sees

Switch to the next episode in the local catalogue app and the previous
episode's subtitles stay on the new picture for several seconds before the new
ones arrive. Reported as "I switch to the next episode and it still finds the
previous title".

The one time this was measured end to end, from the extension's own log on
2026-08-25: the tab title moved to the next episode between 09:30:32 and
09:30:42, and the new subtitles went up at 09:30:47.

## Where the seconds went

Read out of the source rather than argued. Six things happened in sequence, and
only the last of them was doing any work.

| Step | Cost | Where |
|---|---|---|
| The identity is memoised while the JSON-LD is re-parsed | up to 250ms | `content.js`, `STATED_WORK_MS` |
| The tick that reads it | 50ms attached, **500ms with nothing attached** | `content.js`, `TICK_MS` / `IDLE_TICK_MS` |
| The mark has to stop moving before it is believed | **1500ms, restarted on every change** | `content.js`, `PROGRAMME_SETTLE_MS` |
| Every frame is asked what the page says, one at a time | one round trip per frame, twice | `daemon.js`, `pageContextForTab`; `background.js`, `tabStatus` |
| The title is resolved to an id before it can be searched exactly | one HTTP call, then another to search | `server.py`, `_pick_feature` then `_search_upstream` |
| The subtitles are downloaded | one call per language, in sequence | `background.js`, `attachOne` |

Two of those deserve naming, because they are the ones that were avoidable.

**The settle window is not caution about the page, it is caution about the
signal.** Everything the extension could read is a guess: schema.org, the media
session, `og:title`, the `<h1>`, the tab title. None of them is labelled, so
the reader cannot tell "Baggage" from "The Americans" without deciding which is
the show; and none of them arrives at a defined moment, so the answer moves
several times before it means anything. Acting on each move takes the subtitles
off, so the answer is watched until it stops changing. That is the 1500ms, and
because the clock restarts on every change it is a floor rather than a ceiling.
In the measured case the metadata and the tab title were ten seconds apart, and
the identity was built from both.

**The search then had to work the identity out a second time.** The extension
sent a title; the daemon called `/features` to turn that title into an IMDb id;
then it searched by the id. Both calls are free of download quota and neither
is free of time, and the first one is also where the whole wrong-film class
lives: searching "Prime Video: Crime 101" once returned an unrelated 2007
Japanese horror film, which is why there is a match-score gate refusing to
spend a download on a weak match.

## What was added

One attribute, on the element that already carries the clock, and one event.

```html
<video
  data-sso-time-offset="1231"
  data-sso-seek="film"
  data-sso-now-playing='{"v":1,"kind":"episode","title":"The Americans",
    "year":2013,"season":3,"episode":9,"imdb":"tt4331672",
    "durationSeconds":2701.44}'
></video>
```

```js
// what the page implements, whenever what is in the player changes
video.dataset.ssoNowPlaying = JSON.stringify(nowPlaying);
video.dispatchEvent(new Event("sso:nowplaying", { bubbles: true }));
```

| Field | Meaning |
|---|---|
| `v` | `1`. A reader that does not know a version ignores the whole announcement, not the fields it fails to recognise: a later version may change what an existing field means |
| `kind` | `"movie"` or `"episode"`. Anything else is not an announcement |
| `title` | The name subtitles are **indexed under** - the series for an episode, never the episode's own name |
| `season`, `episode` | Numbers, both or neither |
| `year` | The release year |
| `imdb` | `tt...`, of the thing playing - the episode's own id for an episode |
| `durationSeconds` | The **film's** whole length, not what has arrived. Optional |

Three rules carry as much as the fields do:

- **Announce as soon as you commit to playing it, before the stream is open.**
  Which film this is was never a property of the bytes. A reader given it early
  spends the stream-opening on the search rather than spending it waiting.
- **Write the whole object in one assignment.** A reader may observe between two
  writes.
- **Omit what you do not know.** An empty string is not a value. A site
  generator emitting the whole vocabulary with empty strings in it reads as
  episode zero of season zero, which outranks the real answer.

The event carries no payload and the attribute is the contract. A reader must
watch the attribute as well, so a page that dispatches nothing still works and a
page that dispatches without changing anything costs nothing. A string in the
DOM rather than a `CustomEvent` detail, for the same reason `sso:seek` is one:
an object built in an extension's isolated world is not reliably readable in
the page's, and the DOM is the one thing both worlds share.

### Why the presence of the attribute is itself the capability declaration

`data-sso-seek="film"` is a page saying "asks are taken". There is no
equivalent flag here, deliberately: writing the attribute *is* the statement
that this page announces completely and atomically. Two things to keep in step
is one thing that can disagree, and the disagreement would be silent.

This is also why the existing schema.org path keeps its settle window. JSON-LD
on an arbitrary site is not a promise about *when* it is written - a hydrating
page can emit it late, or in pieces. The new attribute is a promise, and it is
believed on that basis rather than on the basis of being structured.

### What is not in the identity

`durationSeconds` is stated and is deliberately **not** part of what makes one
programme different from another. A length that grows as the stream arrives,
read as identity, is a new film several times an episode: measured from the
extension's log on 2026-08-23, one evening on one episode of The Americans, the
reported length went 2701, 146, 2701, 530, 2701, 113, 2701, 111, 2701, and each
of those settled long enough to be believed. Every one took both subtitles off
and searched again. Switching to another copy of the same episode changes the
length too, and it is not a different programme either.

## What each side does now

**The player** (`local-player.svelte`) derives the announcement from the props
it already receives - `tconst`, `season`, `episode`, `name`, `seriesTitle`,
`year` - and from the chosen file's duration. Those props change on the
`goto('/title/<next tconst>')` navigation, which is before `attach` opens the
stream, so the announcement is out first. `title` is `seriesTitle || name`,
which is the whole of the "Baggage" repair expressed as one field.

**The content script** (`content.js`):

- `announcedProgramme()` reads the attribute and memoises on the raw string and
  the element it came from, which is exact where the old 250ms window was a
  guess - and that guess was on the path whose latency is the complaint.
- `programmeMark()` returns the announcement **alone**. The tab title does not
  ride along, which it does in the two inferred shapes. It is the signal that
  lags, and including it is what restarted the settle clock ten seconds after
  the metadata had already answered.
- `settleFor(mark)` is 0 for an announced mark and 1500ms for an inferred one,
  and `noticeProgrammeChange` no longer returns after recording a new mark when
  the wait is zero - so an announcement is acted on in the turn it arrives in
  rather than one tick later.
- An `sso:nowplaying` listener and a `MutationObserver` filtered to the one
  attribute both call the same function the tick calls. The observer is
  attributes-only: `childList` would also catch an element that arrives with
  the attribute already set, and would fire on every DOM insertion a
  single-page app makes, for a case that is a page load rather than an episode
  change.
- `statedSeconds()` prefers the announced length. The catalogue app's
  `VideoObject` states an exact one, but only once playback has started, which
  is after the moment it is most needed.

**The worker** (`daemon.js`, `background.js`): `pageContextForTab` returns the
announcement as the context instead of ranking candidates, preferring the frame
that holds the video where two frames announce. What the frames offered is
still recorded in the log - dropping it would make a wrong announcement look
exactly like a right one. The IMDb id reaches `search` as `imdb_id`.

**The search** (`server.py`, `subtitles/local.js`): given an id, the
`/features` call is skipped. Three fixes went with that, because the branch had
never been reachable from the extension and did not survive being used:

- The season and episode are no longer sent with the id. `imdb_id` matches a
  feature, and for an episode the feature *is* the episode. Sending both is a
  combination the API does not document, and the failure would have been silent
  - an empty result set reading as "nobody has subtitled this".
- A resolved feature is now stated for the id rather than left null. Everything
  downstream asks "was this title resolved?" and means "is this result set this
  programme, or a fuzzy guess at it". Left null, an exact search would have been
  scored against the uploader's file name and refused below the match
  threshold, which is the refusal already documented at length in
  `planAutoAttach`.
- An id that finds nothing falls through to the title path instead of reporting
  "not in the database".

One unrelated inconsistency was closed on the way: `daemon.js`'s `search()`
never forwarded `imdb_id`, so the panel's re-search after a resolved title used
the id when the daemon was down and the fuzzy path when it was up. Two answers
to one question, decided by whether a background process happened to be
running.

## What is immediate now, and what is not

Worth separating, because only the first half is actually zero.

**Immediate.** Identifying the programme. The announcement is written by the
app at the moment it commits to the episode, the observer fires in the same
turn, the mark is built from the announcement alone, and it is believed without
settling. There is no interval to wait for and nothing to agree with.

**Not immediate, and cannot be.** The subtitles themselves. A search and one
download per language still have to happen over the network, and OpenSubtitles
meters downloads rather than searches. What changed is that the search is now
one exact call instead of a title resolution followed by a fuzzy match, and
that it starts while the stream is still being opened rather than after. The
daemon caches searches for six hours and downloads on disk, so an episode
watched before is a local answer.

**Not measured.** The end-to-end improvement has not been timed against the
running app. What is verified is that the constants on the path are no longer
consulted for an announced programme, that the worker uses the announcement,
and that the suites below pass. The honest way to close this is a run against
`localhost:5173` with the extension's own log, the way the 2026-08-25 numbers
were produced.

Two specifics inside that. The harness runs `content.js` as a script in the
page itself, so it exercises the announcement but not the crossing of a real
extension's isolated world - the seek contract's own verification was in the
other direction, page listening for an extension's event. The `MutationObserver`
does not depend on that crossing at all, since a DOM mutation is a DOM mutation
in both worlds, and it fires in the same turn as the event would; so the event
is what has not been proven end to end, not the noticing.

## What was deliberately left out

- **`upNext`.** The app knows the next episode before it is asked for - it is
  already a prop - so a reader could warm its search cache and have the answer
  in hand at click time. Left out because the useful half of that is the
  search, the expensive half is the download, and OpenSubtitles allows five to
  ten downloads a day: prefetching subtitles for episodes nobody watches would
  spend the quota on guesses. If it is added, it warms the search only.
- **A series IMDb id.** OpenSubtitles indexes episodes under `parent_imdb_id`
  with the season and episode beside it, and the app has `parentTconst` in its
  page data but does not pass it to the player. The episode's own id answers
  the same question in one field, so v1 carries one id rather than two. A
  reader that only has the series id is the case v2 would be for.
- **The announcement on `<html>` rather than on the `<video>`.** It would
  survive the element being recreated and could be read before one exists.
  Rejected because it needs a precedence rule for a page with two players,
  where the attribute on the element needs none, and because the case it buys
  is a page load rather than an episode change.
- **The settle window on the schema.org path.** Unchanged, including the tab
  title riding along in the mark. That is a deliberate trade for sites that
  state nothing reliably, and changing it is a separate question from adding a
  contract.

## How to check it

```bash
cd browser-extension
node tests/worker.mjs          # 56/56, six of them new
PLAYWRIGHT_PATH=/opt/homebrew/lib/node_modules/@playwright/mcp \
  node tmp/run-harness.mjs 9601 harness.html
cd ../subtitle-daemon && uv run pytest -q
```

The new harness case is "a page that says what it is playing is not waited
for", and what it asserts is not "faster" but *reported before the settle
window could have elapsed*: an announcement written on the element produces one
`sso:programme` message within 300ms, a tab title change after it produces
none, an announcement carrying a version this build does not know produces
none, and a season with no episode produces none.

By hand, against the running app:

1. Open `localhost:5173/title/<tconst>` with the extension installed, and
   attach two subtitles.
2. In the console: `document.querySelector('video').dataset.ssoNowPlaying` -
   the announcement should be there before the film starts.
3. Press next. The old subtitles should come off and the search should start at
   the moment the page changes, not after the tab title catches up.
