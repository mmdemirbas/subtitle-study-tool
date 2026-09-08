# One pass over the file, before the film starts: what it actually produced

A measurement, not a design. The question was whether translating a whole
subtitle file with a model that can see the scene is enough better than what the
daemon does now to be worth building, and whether the same pass can hand back
the study vocabulary so the rail stops looking words up during playback.

Companion to `llm-gateway-research-2026-09-08.md`, which surveyed where such a
model would come from. This is what came back when one was actually asked.

## What was run

```
subtitle-daemon/tools/pretranslate.py \
  srt-viewer/subtitles/Battlestar.Galactica.Miniseries.S00E01.2003.1080p.BluRay-EN.srt \
  --start 300 --limit 120 --chunk 120
```

- **Model:** `claude-sonnet-5`, through the local `claude -p` CLI with
  `--json-schema`, `--restricted`, `--no-session-persistence`.
- **Input:** cues 301-420 of the miniseries part one, 120 lines, one request.
- **Asked for, in one answer:** a Turkish line per English line, plus a list of
  the words, phrases and idioms in those lines worth studying, each with what it
  means *there* and a note where it is an idiom or a false friend.

Artifacts, both committed beside this file:

- `llm-pretranslate-trial-2026-09-08/slice-300-419-tr.srt`
- `llm-pretranslate-trial-2026-09-08/slice-300-419-vocab.json`

## What it cost, measured

| | |
|---|---|
| Lines asked for / returned | 120 / 120 |
| Study terms returned | 21 |
| Wall clock, one request | 134.2s |
| Cost, one request | $0.223 |

Extrapolated to the 1154-cue episode at this chunk size: **10 requests, roughly
22 minutes and $2.15.** That figure is about the *instrument*, not the design.
Every `claude -p` is a fresh session that re-sends Claude Code's own system
prompt - measured at 14,661 tokens, and it is most of the bill; a two-line test
request cost $0.038 through Haiku for the same reason. The research report's
estimate for the same work against the raw API was $0.28 an episode. Both
numbers are real; they are measuring different things.

## What the model got that the current tier does not

The study rail's live lookups go to Google Translate with the word alone. This
is the same six terms, from the same lines, both ways. The right-hand column is
what the one pass returned; the left is the running daemon, asked through
`/lookup` with the subtitle line attached:

| Term | Daemon now (Google tier) | This pass | Reading |
|---|---|---|---|
| `quarters` | çeyrekler | kamara | wrong: fractions, not lodging |
| `old man` | yaşlı adam | ihtiyar (baba için) | wrong: it is slang for *father* here |
| `spare me` | beni bağışla | kendine sakla / boş ver | wrong: "forgive me", not "don't start" |
| `heart-to-heart` | kalpten kalbe | içten, samimi sohbet | wrong: literal, not the idiom |
| `radiate` | yaymak | (sinyal) yaymak | thin: no sense of which kind of emitting |
| `starboard` | sancak | sancak (geminin sağı) | correct, and unexplained |

Four of six are wrong in context. They are wrong in the way that matters for
study: each is a real Turkish word that sends the reader off with a confident
false belief.

The list also found things a word-level tier has no way to find at all, because
they are not words:

- **`striking a superior asshole`** - marked as wordplay on the military
  offence *striking a superior officer*, with the substitution named.
- **`It's about time`** - flagged with the note that `about` here is not
  "approximately".
- **`Same old Lee`**, **`In or out`**, **`ring in my ears`**,
  **`make Captain`**, **`honor guard`**, **`EVA`** (expanded to Extravehicular
  Activity).

Twenty-one terms over 120 lines is roughly one every six lines.

## A side effect worth naming

The Turkish is generated *from* the English file, so it carries the English
file's cue times unchanged. The two tracks are therefore aligned cue-for-cue by
construction: no offset to nudge, no drift, no aligner, and "the same moment in
the other subtitle" is exact rather than approximate. Every downloaded
translation in the repo's history has had to be lined up by hand or by
`align.js`; this one cannot be out of sync.

## What could not be measured, and why

**A like-for-like quality comparison against the repo's existing Turkish file.**
`...-TR-gpt5-thinking-web.srt` is not line-aligned with the English: 1141 cues
against 1154, and matching by start time within 4 seconds pairs only 86 of the
120 lines - several of those to unrelated dialogue ("Buyurun." against "and her
participation this afternoon in Galactica's decommissioning ceremony"). Any
per-line score off that pairing would be measuring the segmentation, not the
translation. It is not evidence either way about that file's quality.

**The OpenSubtitles Turkish subtitle the extension actually attaches for this
film.** The daemon's cache holds one Battlestar Turkish file and it is series
episode 1x1, 473 cues - different content, not a baseline for the miniseries.

So: the comparison above is against **the tier the study rail uses today**,
which is the thing the pre-pass would replace. It is not a comparison against a
good human translation, and nothing here says how close it comes to one.

## Recommendation

Stated as a recommendation, separate from the evidence.

**The vocabulary half is the stronger result and the cheaper one to ship.**
Four of six live glosses being wrong in context is not a tuning problem; the
tier cannot see the line, and the pass can. It also answers the latency
complaint outright - the terms arrive before playback starts, so the rail has
nothing left to look up.

**Do not run the pre-pass through `claude -p` in production.** It is a good
instrument and a poor backend, for the system-prompt reason above. A native
Messages-API path, or a router in front of one, is the shape.

**Open, and unchanged by this trial:** whether one request per 120 lines is the
right unit (a failure loses 120 answers), whether the pre-pass replaces the
gloss tier or sits above it, and what the vocabulary schema should hold beyond
term / kind / gloss / note.
