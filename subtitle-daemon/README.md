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

## Running

```bash
./run.sh              # or: uv run subtitle-daemon
./run.sh --verbose    # log every request
```

Listens on `http://127.0.0.1:8791`. It starts and serves `/health` with no API
key configured, so you can confirm the plumbing before dealing with
credentials.

There are no runtime dependencies. `http.server` and `urllib` cover a
three-endpoint service, and keeping the dependency list empty means the daemon
starts even if nothing has been installed.

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

## Endpoints

| Method | Path | Notes |
|---|---|---|
| `GET` | `/health` | Config and credential status. |
| `GET` | `/search?title=...` | Parses a raw page title, then searches. Free. |
| `GET` | `/search?query=...` | Explicit query, skips the title guesser. Free. |
| `POST` | `/fetch` | Body `{"file_id": N}`. Returns cues, VTT and metadata. Costs quota only on a cache miss. |
| `GET` | `/cached` | Everything already on disk. |
| `GET` | `/cached/{file_id}` | Cues for one cached subtitle. |

`/search` also accepts `languages`, `year`, `season`, `episode` and `imdb_id`.

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

**Title guessing.** `titles.guess` strips site branding, player chrome and
release-scene tokens from a tab title, and pulls out season/episode. It is
heuristic and the extension lets you correct it. One deliberate choice: a bare
trailing year is left in the query, because "Ayla 2017" and "Blade Runner 2049"
are indistinguishable and guessing wrong is worse than passing it through.

**Response shapes.** The OpenSubtitles reference docs render client-side, so
the field names were confirmed against live calls rather than read off a spec.
Every field is therefore read defensively: a renamed key costs one result, not
the request.

## Tests

```bash
uv run pytest
```

Covers encoding detection, SRT parsing, title guessing, quota behaviour and the
origin allowlist. A stub stands in for the API client, so no test makes a
network call or spends real quota.
