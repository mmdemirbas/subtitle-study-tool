# Why a TV series gets the wrong subtitle

Investigated 2026-08-04 against `streaming-site-2.example/watch-tvseries-the-americans-23870.html`,
The Americans S01E01. Reported as "cannot find a subtitle" and "TR-EN looks
unsynced".

**Neither symptom is a timing problem.** They are one cause with two faces: the
extension never learns which episode is playing, so it either searches for
nothing recognisable or attaches a subtitle for a different episode. A subtitle
for the wrong episode of the same series looks exactly like a subtitle that has
drifted — same show, same voices, same pacing, wrong words.

## How this was established, and a correction

The first version of this document was written from the page plus the source.
The page observations were real; the chain joining them - which frame the
extension asks, what it therefore searches for, what it decides - was **read off
the code and not executed**, and it was reported here as though it had been.
Two things in it were wrong:

- It said auto-attach *refuses* on this page **and** that the mixed-episode
  result set was what produced the wrong subtitle. Both happen, but not at once:
  the refusal is what happens now, and the mixed result set is what happens
  after the frame is fixed. They are the same defect at two stages.
- It treated the advert as worth a section. It is not implicated by anything
  measured.

Everything below is now taken from a capture made by the extension itself,
running in Chrome, on this page, with S01-E01 selected the way a viewer selects
it. The mechanism it describes was right; the sequence was not.

Searching costs no quota, so all of it is repeatable.

## What the page says it is playing

| Source | Value |
|---|---|
| `document.title` (top frame) | `The Americans TV series \| SiteBrand` |
| `og:title` | `The Americans TV series \| SiteBrand` |
| `<h1>` | `Watch TV Series: The Americans` |
| JSON-LD | `{"@type":"TVSeries","name":"The Americans","startDate":"2013"}` |
| Episode, anywhere in the metadata | **absent** |

The episode is on the page, but only as UI state: 75 `button.btn-episode`
elements reading `S06-E10`, `S06-E09` … and exactly one carrying `active`:

```
<button class="btn-episode active" idepisode="oi0t">S01-E01</button>
```

## Second correction: the fix proposed below was wrong

Two captures from the reporting user's own browser, one before playback and one
during, settled it — and reversed the first recommendation.

**The site has two player servers, and they behave oppositely.**

| | `#M` — `embed-host-2.example` | `BackUp` — `embed-host.example` → `embed-host-3.example` |
|---|---|---|
| Video frame's `document.title` | *(empty)* | `The Americans (2013) (2013) S01E01` |
| Title source used | `tab.title` fallback | `document.title` **of the player frame** |
| Season / episode sent | none | **1 / 1** |
| Resolved | nothing | the americans (Tvshow) |
| Decision | `too-weak` | `attach` |
| Best English | `- Transit (TV Series)` @ 0.667 | `S01E01 Pilot` @ **0.957** |
| Second, Turkish | — | `S01E01 Pilot` @ **0.975** |
| Tied at top score | 1 | 1 |

On the BackUp server the whole thing works, both languages, exact episode — and
it works **because** it asks the player's frame, which names the episode. The
top frame never does; it only ever says "The Americans", which is the 26-way tie.

So "read the top frame instead" would have taken a 0.957 exact-episode match and
replaced it with a series-only search. The player frame is not the *wrong*
frame. It is an *unreliable* one: sometimes the only source that knows the
episode, sometimes empty. A rule that always prefers either frame is wrong in
one of the two cases.

**The corrected fix is to stop choosing a frame at all.** Collect title
candidates from every frame, and choose between the candidates rather than
between their sources — preferring one that carries a season and episode,
because that is the thing that cannot be recovered later. And send the season
and episode as fields, taken from whichever frame has them, or from the control
marked as chosen on the page when no title carries them. Against these two
captures that produces the exact episode on both servers.

## What the extension actually did

Captured by the extension's own diagnostic, on this page, with S01-E01 selected.
The two columns are the same search run twice: once from the frame the extension
addresses, once from the top frame, so the difference is visible rather than
argued about.

| | Frame 5 — the one it believes | Frame 0 — the top frame |
|---|---|---|
| Holds | the video | the metadata and 75 episode controls |
| Title source | **`tab.title` (fallback)** | `json-ld` |
| Title sent | `The Americans TV series \| SiteBrand` | `The Americans` |
| Season / episode sent | none | none |
| Resolved to | **nothing** | the americans (Tvshow), imdb 2149175 |
| Decision | **`too-weak` — opens the panel** | `attach` |
| Best match | `- Transit (TV Series)` @ 0.667 | `S01E01 Pilot` @ 0.750 |
| Tied at the top score | 1 | **26** |

Read across: the extension is looking at the frame that cannot see anything,
falling back to the tab title, failing to resolve, and refusing. **That is the
"cannot find a subtitle" report, reproduced.**

Read the right-hand column as the counterfactual: fixing the frame moves the
failure rather than removing it. The series resolves, the decision becomes
*attach*, and twenty-six results share the winning score — so which episode
arrives is decided by tiebreaks that know nothing about the episode. **That is
the "unsynced" report.** The two symptoms are one defect at two stages, which is
why fixing only the frame would look like a fix and would not be one.

The page knew all along. The diagnostic found it with no site-specific selector:

```
S01-E01  →  season 1, episode 1
path      div.episodes-section > div.episode-grid > button.btn-episode.active
chosen    class "btn-episode active"
```

## Defect A — metadata is read from the frame with the video, which is the wrong frame

`background.js` finds the frame holding the video and asks *that* frame what the
page is about:

```js
const status = await tabStatus(tab.id);        // first frame with hasVideo
const frameId = status?.frameId ?? TOP_FRAME;
const { title, year } = await bestTitleForTab(tab, frameId);
```

Measured, frame by frame:

| Frame | `document.title` | `og:title` | `<h1>` | videos | `.btn-episode` |
|---|---|---|---|---|---|
| `streaming-site-2.example` (top) | The Americans TV series \| SiteBrand | present | present | **0** | **75** |
| `embed-host-2.example/play/…` | *(empty string)* | none | none | **1** | 0 |

The two are disjoint and the iframe is cross-origin, so the frame that knows
where the playhead is cannot see any of the metadata, and the frame with the
metadata has no video. `pageInfo()` in the player frame returns **no candidates
at all**; `bestTitleForTab` then falls back to `tab.title`, which is the only
reason anything is searched for.

This is not specific to this site. The extension's own README says streaming
players usually live in an iframe, and the whole point of `pageInfo` is to read
what the *page* says it is about.

## Defect B — nothing extracts the season and episode

`daemon.js` already accepts them and the daemon already uses them:

```js
export function search({ title, query, languages, year, season, episode }) {
```

Nothing ever fills them. The only route by which a season and episode reach a
search today is `titles.guess()` finding `S01E01` inside the *title string* —
and here the title string has no episode in it.

## Defect C — a series search with no episode returns a mixed bag, and nothing says so

The measurement that matters. Four searches, same daemon, same moment:

| What was sent | Results | Episodes returned | Top hit | Top score |
|---|---|---|---|---|
| `title="The Americans TV series \| SiteBrand"` — **what happens today** | 49 | none resolved at all | `Transit (TV Series)` | 0.667 |
| `title="The Americans"` | 50 | **S1, S2, S5 and S6 mixed** | `S01E01 Pilot` | 0.750 |
| `title="The Americans S01E01"` | 26 | S1E1 only | `S01E01 Pilot` | 0.783 |
| `title="The Americans" &season=1&episode=1` | 26 | S1E1 only | `S01E01 Pilot` | 0.783 |

Row 1 is the "cannot find a subtitle" report: nothing resolves, the best match is
an unrelated show at 0.667, and since that is below the 0.75 auto-attach
threshold the shortcut correctly refuses and opens the panel.

Row 2 is the "unsynced" report, and it is the dangerous one. The search resolves
correctly to The Americans (imdb 2149175) — and then returns episodes from four
different seasons, with `S01E01` and `S02E04` **tied at 0.750**, exactly the
auto-attach threshold. `pickBest` breaks that tie on language and then on
whether a file is already cached, neither of which has anything to do with which
episode is on screen. So auto-attach spends a download and confidently displays
another episode.

The reason nothing catches it is in `_episode_agreement`:

```python
if season is None and episode is None:
    return 0
```

"Not asked for" scores the same as "no episode metadata". That is right as a
ranking rule — a result with no episode field is not evidence of a mismatch —
but it means that when the episode is unknown, every episode of the series ranks
identically, and the daemon reports no doubt about it.

## Two things the capture found that reading could not

Both are the kind of thing that only turns up by running it, and both were bugs
in work written the same afternoon.

**The listener's second parameter was named `_sender`.** Threading the sending
tab through it therefore threw `ReferenceError: sender is not defined` on the
first real message. Nothing in the harness sends a message from an extension
page, so nothing caught it.

**The episode scan capped before it filtered.** It stopped at forty markers, and
a series page lists its episodes newest-first, so on a six-season show the one
being watched is seventy-fifth. The report then stated, with no caveat, that the
page marked no episode as chosen - a confident wrong answer produced by a limit
applied to the wrong end of the work. It now scans, sorts, and then cuts, and
says how many it left out.

The first capture also said "no frame has a video" and "no episode is marked",
and both were artefacts of the test rather than facts about the page: a fresh
visit marks nothing until an episode is clicked, and the player iframe does not
load until then either. The reproduction has to include the click.

## The remaining open question: a hundred seconds

The two captures disagree about how long the episode is:

| Server | `duration` |
|---|---|
| `#M` — `embed-host-2.example` | 4165 s |
| `BackUp` — `embed-host-3.example` | **4265 s** |

The same episode, a hundred seconds apart. Neither matched a single ad marker:
`adMarkersMatched: 0` in every frame of both captures, because `AD_MARKERS` is a
list of Prime Video class names and these are JW Player and embed-host.

A hundred seconds of something at the front of one stream would put every cue in
that stream a hundred seconds out — which is what "TR-EN looks unsynced" would
look like once the right episode is attached, and it is *constant*, so the
bracket keys fix it once and the offset is then remembered per file.

**What this is has not been established.** A hundred seconds could be a stitched
pre-roll, a recap the other encode lacks, or a different cut. Telling them apart
needs one measurement nobody has taken yet: with subtitles attached and the
offset set so a line lands correctly, does the correction still hold an hour in?
Constant means it is a fixed head, and the offset is the whole answer. Growing
means something is stitched mid-stream and the marker list needs an entry for
this player.

### An argument this document made and has withdrawn

It previously reasoned from the `#M` server's duration alone — 4165 s against a
pilot that runs about 68 minutes — that the stream was the episode and nothing
was stitched into it. One number from one encode, with no second encode to
compare against, was not enough to carry that: the BackUp server reports 4265 s
for the same episode. The reasoning was sound and the evidence was one
measurement short.

## What follows

In order of how much each one costs to get wrong:

1. **Stop choosing a frame; choose between candidates.** Ask every frame for its
   title candidates, merge them, and rank — preferring one that carries a season
   and episode, then structured metadata (`json-ld`, `og:title`) over a bare
   `document.title`. This is the corrected item: preferring *either* frame
   unconditionally is wrong on one of the two servers this site offers, and the
   two captures show both. The panel needs the same merged view, and it runs
   inside the player's frame where it cannot read across a cross-origin
   boundary, so it has to ask the worker — the way it already does for the
   daemon.
2. **Read the season and episode off the page** — the active item in an episode
   control, and the URL, in the same spirit as the existing title candidates.
3. **Refuse to auto-attach an episode nobody identified.** When the search
   resolves to a series and no episode is known, that is not a confident match,
   whatever the title score says. The panel should open instead — which is
   already what happens for a film that does not match well, and for the same
   reason: it will not spend a download on a guess.

Item 3 matters more than it looks. Items 1 and 2 make the common case work;
item 3 is what stops the uncommon case failing *silently*, which is what turns a
missing feature into an hour of blaming the timing.

## Reproducing this

The diagnostic is in the extension: **control panel → If this page is not
working → Diagnose this page**. It asks every frame what it can see, runs the
real decision code rather than a description of it, and opens a report. It costs
no download quota.

For a repeatable run against a page, without clicking through by hand:

```
node run-diagnostic.mjs <url> [episode label]
```

which loads the unpacked extension into Chrome, selects the episode, captures,
and writes the report to `/tmp/sso-report.json`. It is not committed - it drives
a specific site - but the shape is three calls and it is worth keeping to hand
while this is being fixed.
