# subtitle-daemon

A loopback HTTP service that finds a subtitle for whatever is playing,
downloads it once, and serves it as cues to the browser extension and the
study viewer.

It exists as a separate process rather than as extension code for three
reasons: the OpenSubtitles API key stays out of any web page, the download
cache survives extension reloads, and the same service can back the viewer and
the realtime transcriber later.

## Setup

```bash
cd subtitle-daemon
cp config.example.json config.local.json   # gitignored
```

Put an API key in `config.local.json`. Create one at
[opensubtitles.com/en/consumers](https://www.opensubtitles.com/en/consumers)
after registering — it is free.

```json
{
  "api_key": "your-key",
  "username": "your-username",
  "password": "your-password",
  "default_languages": ["en", "tr"]
}
```

Username and password are optional but worth setting: they raise the download
allowance from 5 per day to at least 10. Environment variables
(`OPENSUBTITLES_API_KEY`, `OPENSUBTITLES_USERNAME`, `OPENSUBTITLES_PASSWORD`,
`SUBTITLE_LANGUAGES`, `SUBTITLE_DAEMON_PORT`) override the file.

### What a word means, and why that needs a second setting

Study mode's word meanings come from here, in three tiers.

```json
{
  "gloss_model": "qwen3.6:35b-a3b",
  "gloss_url": "",
  "gloss_api_key": "",
  "google_api_key": ""
}
```

Naming a `gloss_model` turns on the only tier that sees the **line a word was
said in**, which is what separates "can you spare a minute" from "one spare
engine" - and, where the page said so, **which film it is and the lines either
side**. A line of dialogue means different things in different programmes:
"jump", "viper" and "the old man" are all three of them Battlestar Galactica's
own vocabulary and none of them is what a dictionary says. `gloss_url` defaults to `http://127.0.0.1:11434/api/chat`,
which is [ollama](https://ollama.com) on this machine: no key, no quota, and
nothing about what you are watching leaves the house. Any endpoint speaking the
OpenAI chat-completions shape works, with `gloss_api_key` for a hosted one.
`GLOSS_MODEL`, `GLOSS_URL`, `GLOSS_API_KEY` and `GOOGLE_API_KEY` override the
file.

`google_api_key` is the tier below: a sane answer for a bare word, with no idea
of the line. Below that a free archive answers with no key at all, which is what
the extension falls back to on its own when this daemon is not running.

None of it is required. Without any of it, meanings still arrive - they are just
answers to "what does this word usually translate as", which is a different
question from the one the reader asked.

## Running

```bash
./run.sh              # or: uv run subtitle-daemon
./run.sh --verbose    # log every request
./run.sh --replace    # stop a daemon already on the port, then take over
./run.sh --port 8792  # run alongside one
```

Listens on `http://127.0.0.1:8794`. It starts and serves `/health` with no API
key configured, so you can confirm the plumbing before dealing with
credentials.

A forgotten copy of the daemon holding the port is the most likely reason it
will not start. Rather than an `EADDRINUSE` traceback, it asks whatever is on
the port whether it is a subtitle-daemon and prints the PID and the three ways
out. `--replace` stops the old one and takes over — and refuses if the port is
held by something that is not a subtitle-daemon, since taking the port first
is not a reason to be killed.

There are no runtime dependencies. `http.server` and `urllib` cover a service
of this size, and keeping the dependency list empty means the daemon starts
even if nothing has been installed.

## Quota, and why the cache is not optional

Per the [OpenSubtitles
quotas](https://opensubtitles.tawk.help/article/getting-started): searching is
unlimited, downloading is not — 5 per day anonymous, 10 per day on a free
account, up to 1000 for VIP.

Ten is not many. Reloading a tab three times while fixing a title would spend a
third of a day's allowance, so:

- Every downloaded subtitle is written to `cache/subtitles/` and served from
  there forever after. A `file_id` is only ever downloaded once.
- Concurrent `/fetch` calls for the same `file_id` are serialised, so two tabs
  asking at the same moment cost one download, not two.
- Searches are cached for six hours. They cost no quota, but they are slow
  enough to be worth not repeating while a title is being corrected.
- Search results are annotated with `cached: true` so the UI can show which
  choices are free.

The search cache holds *processed* results, so `SEARCH_SCHEMA_VERSION` in
`cache.py` is part of its key. Bump it whenever parsing, scoring, ranking or
filtering changes — otherwise the daemon keeps serving answers computed by the
previous version until the TTL expires, which reliably wastes an afternoon.
Downloaded subtitle files are not versioned: those are raw bytes.

## Endpoints

| Method | Path | Notes |
|---|---|---|
| `GET` | `/health` | Config and credential status. |
| `GET` | `/search?title=...` | Parses a raw page title, then searches. Free. |
| `GET` | `/search?query=...` | Explicit query, skips the title guesser. Free. |
| `POST` | `/fetch` | Body `{"file_id": N}`. Returns cues, VTT and metadata. Costs quota only on a cache miss. |
| `GET` | `/cached` | Everything already on disk. |
| `GET` | `/cached/{file_id}` | Cues for one cached subtitle. |
| `GET` | `/lookup?q=...` | A word's dictionary entry and its meaning. `lang`, `to`, `sentence`, and optionally `film`, `before` and `after`. Free. |
| `POST` | `/gloss` | Body `{"language", "target", "film", "items": [{"term", "sentence", "before", "after"}]}`. Many words with their lines, answered before they are asked. Free. |
| `POST` | `/cached` | Body `{"file_id", "content"}` and the metadata beside it. Takes in a subtitle the extension downloaded while the daemon was stopped, so the same `file_id` is not paid for twice. |
| `POST` | `/log` | Appends to the extension's running log. A browser extension cannot write a file without announcing every one, and this records while you watch. Larger body ceiling than the rest. |
| `POST` | `/translate` | Body `{"source_id", "language", "target", "cues": [...]}` and the film's `imdb_id`, `movie_name`, `season`, `episode`. Starts translating a whole subtitle in the background, or reports the job already doing so - the same episode into the same language is the same job whichever subtitle it is made from, and asking again for one still waiting its turn moves it to the front. A cached `source_id` with no `cues` is read off the disk. |
| `GET` | `/translate` | Every translation job the daemon holds, newest first, the model in use, and the `languages` a subtitle can be made in. |
| `GET` | `/translate/{job}` | One job's progress: `status`, `done` of `total` lines, `eta_seconds`, `file_id` once done, and `waiting_for` (the job ahead of it) while it is queued. `?cues=1` adds the whole file as it stands - translated where a chunk has landed, the source text where not - with `translated_indexes` and `pending_indexes`, the lines no chunk has been asked for yet. |
| `POST` | `/translate/{job}` | Goes on with a job from its key alone, no cues needed: a stopped or failed one from its next chunk, a finished one with the lines it kept in the source language, asked for one at a time and written into the file again. A waiting job is moved to the front of the queue; a job with nothing left answers with its status. |
| `DELETE` | `/translate/{job}` | Stops a job at once; the request in flight is torn down and its chunk is asked for again on the next `POST`. `?forget=1` removes its directory too. |
| `DELETE` | `/cached/{file_id}` | Forgets one subtitle. |
| `DELETE` | `/cached` | Forgets everything. `?searches_only=1` keeps the downloaded files and clears only the search cache, which is the one that costs nothing to rebuild. |

`/search` also accepts `languages`, `year`, `season`, `episode` and `imdb_id`.

## How a search resolves

`/subtitles?query=` is fuzzy and always returns *something*, which makes a
wrong title indistinguishable from a film that isn't there. So the title is
resolved first:

1. **`/features`** — the title index. Candidates are scored against the query;
   a confident match hands back an IMDb id and the search becomes exact
   (`imdb_id`, or `parent_imdb_id` + season + episode for a series).
2. **Fuzzy fallback** — if nothing matches confidently, search by query with a
   `type` filter, so a film search doesn't drown in episodes that merely share
   a word.
3. **Unfiltered last resort** — catches series searched without an episode
   number, and anything the type filter misclassifies.

This is not a marginal improvement. Searching `Crime 101` through
`/subtitles?query=` returns 187 unrelated TV episodes and zero with
`type=movie` — the film looks absent. Through `/features` it resolves to
imdb 32430579 and its subtitles match exactly. Both calls are free; only
downloading is metered.

Results are then **scored against what was asked for** (`matching.py`) and
ranked by that score before trust and popularity. Anything below a visibility
floor is dropped; when nothing is plausible the response carries
`low_confidence` so the UI can say so rather than presenting junk as an answer.
The extension refuses to auto-download below `auto_attach_threshold`.

For series, agreement with the requested season and episode outranks
everything else. Mislabelled uploads are common, and without that the
most-downloaded episode of the show wins regardless of which was asked for.

When a season and episode are known, step 1 resolves to the **show** rather
than to one of its episodes. Every episode of a series carries the series name,
so all of them score identically against it and the tie fell to whichever was
most downloaded - asking for "Not Suitable for Work" S01E01 resolved to the
S01E03 entry. A show resolves into `parent_imdb_id` plus the season and
episode, which names one episode exactly.

## When the page does not say which episode

A series searched without a season and episode comes back as a question, not a
guess: fifty results across four seasons share the winning score, and the
tiebreaks that would pick one know nothing about what is on screen. Prime Video
is the case that made this matter - it plays an episode in place on the show's
own page, where the address, the tab title and everything else stay the show's.

What the disk does know is which episodes have already been fetched for this
show. So a series search that asked for no episode also reports `last_episode`,
the furthest one held in any language, and `next_episode`, the one after it -
re-derived on every reply, including a cached one, because it is a fact about
the download cache and not about the search. The panel turns it into one click.
Files downloaded before the numbers were recorded are read from the names the
uploader gave them; every one of the 322 held at the time says which episode it
is in its own name.

## When the answer is that it does not exist

An empty result list has two causes with different remedies: the search missed,
or nobody has subtitled this in the language asked for. `/features` says which,
per language, and it is already in hand - so a search that finds nothing in the
requested language comes back with `missing_languages` and
`available_languages` rather than only an empty list. "Not Suitable for Work"
(2026) has 13 languages across its episodes and no Turkish in any of them; no
amount of re-querying was going to produce one, and the panel says so instead
of "try a different title".

## Making the subtitle that does not exist

Where `missing_languages` names the language being learnt, the daemon can make
the file from a subtitle that does exist, with a model on this machine. The
extension offers it - on the Find screen, and as a toast when study is switched
on with one subtitle - and nothing runs until the offer is accepted.

The translation is a job, not a request: `POST /translate` returns at once, a
thread walks the file forty cues at a time, and every chunk is written to
`cache/translate-jobs/<job>/chunks/` the moment it lands. A restart of the
daemon re-queues whatever was unfinished and starts at the first chunk with no
file; a closed tab changes nothing. One thread works the jobs, the one asked
for most recently first: a job still running when a newer one arrives steps
aside at its next chunk boundary and goes on after it, so the episode being
watched is never behind the one that was. `GET /translate/{job}?cues=1` is the file as
it stands, so the extension attaches it a few seconds in and swaps in more of it
every few seconds. The finished file goes into the ordinary cache under a
synthetic `file_id` (above 9e13, derived from the source and the language, so
the same job always makes the same file) with `generated: true`, the model and
the source in its sidecar - and from then on every search for that title and
episode lists it, ranked as identified, and stops calling the language missing.

What comes back is checked before it is believed - see `translate.py` for the
two checks and `docs/reports/translate-bakeoff-2026-09-10.md` for why they are
needed. A line the model could not translate keeps its source text, visibly,
and the job reports how many. Those lines can be asked for again later with
`POST /translate/{job}`: one at a time, with more context above each than the
chunk had, and usually after the model has been swapped for a bigger one; what
comes back is checked the same way, lands in the chunk file that owns it, and
the cached file is written again.

What does the translating is `translate_model` in `config.local.json`. Left
empty, it is Google Translate when `google_api_key` is set and `gemma3:4b` on
this machine when it is not - the same rule the gloss tier follows for the
same key. The quality bake-off of 2026-09-16
(`docs/reports/translate-quality-2026-09-16.md`) is why: over sixty lines of a
workplace comedy graded for accuracy out of 5, Google Translate scored 4.5 in
1.3 seconds, `qwen3.6:35b-a3b` 4.2 at 0.85 seconds a line and 22.6 GB of
memory while it runs, `qwen3:14b` 3.6 at 3.2 seconds a line, and `gemma3:4b`
3.1 - the file the reader actually watched through it was 3.3. Google's first
500,000 characters a month are free (an episode is about 45,000) and $20 a
million after. Naming a model - `"google"`, or an ollama model - is the choice;
`translate_url` and `translate_api_key` point a local model elsewhere and fall
back to `gloss_url` and `gloss_api_key`. `TRANSLATE_MODEL`, `TRANSLATE_URL` and
`TRANSLATE_API_KEY` override the file. ollama is spoken to through its own
`/api/chat` with reasoning switched off, which is what makes the qwen3 family
usable at all (95 seconds for an 18-token answer through the OpenAI-shaped
URL, measured); any other endpoint speaking the OpenAI chat-completions shape
works. `/health` names the translator in use and the seconds per line the
last job on it measured, which is what the offer's estimate is made from.

## Access control

The daemon binds to `127.0.0.1`, which keeps other machines out. It does not
keep other *pages* out — any site you visit can issue requests to localhost —
so there is an origin allowlist covering browser extensions, `localhost` pages
and `file://` (which sends `Origin: null`). Everything else gets a 403 before
any work happens, which is what stops a random website from spending your
download quota. `tests/test_server.py` covers that boundary directly.

Requests with no `Origin` header at all are allowed: those are direct calls
from `curl` or the address bar, not cross-site requests.

## Notes on the implementation

**Encodings.** Subtitles from OpenSubtitles are often not UTF-8, and Turkish
ones are routinely cp1254. Decoding those as latin-1 does not raise — it
silently produces mojibake — so `subtitles.decode` scores candidate encodings
rather than taking the first that does not throw.

**A series' subtitle count.** `/features` returns both a scalar
`subtitles_count` and a per-language `subtitles_counts`, and on a Tvshow they
count different things: the scalar counts what is filed against the show entry
itself, not against its episodes. A series whose subtitles all hang off
episodes therefore reports zero - "Not Suitable for Work" (2026) reports 0
beside a breakdown holding 61, "Where the Bears Are" 0 beside 701, "Mercy
Street" 0 beside 187 - and was dropped as an empty entry, which is what stopped
a series ever resolving to its own show. Both are read and the larger is used,
because neither is reliable alone: "The Care Bears" reports 11 beside a
breakdown holding 1.

**Title guessing.** `titles.guess` strips site branding, player chrome and
release-scene tokens from a tab title, and pulls out season/episode. It is
heuristic and the extension lets you correct it.

Branding is stripped from **both ends**. Prime Video titles a detail page
`Prime Video: Crime 101` while its player page uses `Crime 101 - Prime Video`;
handling only the suffix left the site name in the query and turned a title
search into a fuzzy match on the word "prime". Stripping never empties a
query — `Prime Video` on its own stays as it is rather than becoming a search
for nothing.

A bare trailing year is deliberately left in the query, because "Ayla 2017" and
"Blade Runner 2049" are indistinguishable and guessing wrong is worse than
passing it through. A bracketed or dot-delimited year is extracted.

**Response shapes.** The OpenSubtitles reference docs render client-side, so
the field names were confirmed against live calls rather than read off a spec.
Every field is therefore read defensively: a renamed key costs one result, not
the request.

## Tests

```bash
uv run pytest
```

Covers encoding detection, SRT parsing, title guessing, match scoring, title
resolution, episode ranking, quota behaviour and the origin allowlist. A stub
stands in for the API client, so no test makes a network call or spends real
quota.

`test_align.py` drives the extension's aligner over every pair of subtitles
in the live download cache, and the cache grows with use: at 343 files that
is 58,653 alignments, about ninety seconds across the cores on an idle
machine. Those tests carry the `corpus` marker, so `uv run pytest -m "not
corpus"` is the quick run and the plain one is the gate.

The Crime 101 failure is pinned as a regression test in three places: the
title guesser (`test_site_branding_is_stripped_from_either_end`), the scorer
(`test_the_actual_bad_matches_score_below_auto_attach`) and the search endpoint
(`test_the_crime_101_regression`).
