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
own vocabulary and none of them is what a dictionary says. `gloss_url` defaults to `http://127.0.0.1:11434/v1/chat/completions`,
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

## When the answer is that it does not exist

An empty result list has two causes with different remedies: the search missed,
or nobody has subtitled this in the language asked for. `/features` says which,
per language, and it is already in hand - so a search that finds nothing in the
requested language comes back with `missing_languages` and
`available_languages` rather than only an empty list. "Not Suitable for Work"
(2026) has 13 languages across its episodes and no Turkish in any of them; no
amount of re-querying was going to produce one, and the panel says so instead
of "try a different title".

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

The Crime 101 failure is pinned as a regression test in three places: the
title guesser (`test_site_branding_is_stripped_from_either_end`), the scorer
(`test_the_actual_bad_matches_score_below_auto_attach`) and the search endpoint
(`test_the_crime_101_regression`).
