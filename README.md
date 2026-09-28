# subtitle-study-tool

Workspace for everything subtitle-related: getting subtitles onto the screen
for something that has none, and studying a foreign-language film once they
are there.

## The two problems

**Watching.** A film is playing and has no subtitles. Two ways to fix that,
and they fail in opposite situations, so the tools cover both:

- *Fetch* an existing human-made subtitle and sync it to the playing video.
  Perfect quality, instant, but only works for titles somebody has subtitled.
- *Transcribe* the audio locally with Whisper, live. Works for literally
  anything that makes sound, but runs behind the audio and reads worse than a
  human subtitle.

**Studying.** Two subtitle tracks side by side, aligned by timecode, with
lookup, translation and a personal dictionary.

The extension does this over a film that is actually streaming: the language
being learnt and the one already known on the same clock, the words in each line
that are rare *in film dialogue* underlined, and their meanings in a column at
the side as it plays. One key keeps a word with the sentence it was said in, the
translated line beside it, the film and the timestamp — which is the part that
makes it worth reviewing later. The deck exports to Anki.

`srt-viewer/` does the same for a subtitle file you already have, without a
video.

## Layout

| Directory | What it is | State |
|---|---|---|
| `browser-extension/` | MV3 extension. Overlays subtitles on any `<video>` in a page, driven by the page's own playback clock. One click to find and attach a subtitle — two languages side by side, with word lookup and a personal deck. | see its README |
| `subtitle-daemon/` | Local HTTP service. Searches and downloads from OpenSubtitles, caches aggressively, converts to WebVTT. **Optional** - the extension does the whole pipeline itself now. What the daemon still adds is a signed-in account (10 downloads a day instead of 5), the cache on disk, the API key outside the browser, and word lookup without a permission prompt. | see its README |
| `srt-viewer/` | Single-file browser app, "SRT Study Tool v7". Dual-subtitle study surface with its own virtual playback clock, for studying without a video. `samples/` holds the English/Turkish pair the tests run on. | see its README |
| `srt-translator/` | Python CLI. Batch-translates a whole `.srt` via OpenAI / DeepL / Google / Azure / LibreTranslate, with a SQLite dedup cache. | working |
| `subgen/` | Local Whisper transcription, for a film nobody has subtitled. Batch today, over a file you already have; realtime is still an idea. | see its README |
| `bench/align/` | The alignment bench. Builds a ground truth from cue text rather than from clocks, then measures every aligner against it - including the one the extension ships. Run it before changing an alignment constant. | see its README |
| `scripts/` | `setup-whisper.sh` builds whisper.cpp and fetches models. | working |
| `docs/` | Bake-off results, reports and older design specs. | reference |

Multi-gigabyte things — the whisper.cpp checkout and the model weights — live
in `vendor/` and `models/`, both gitignored and both restored by
`scripts/setup-whisper.sh`.

## Getting started

- **The extension:** load `browser-extension/` unpacked in any Chromium
  browser and paste an OpenSubtitles API key into its options; the steps are
  in [its README](browser-extension/README.md#install).
- **The viewer:** open `srt-viewer/srt-viewer.html` in a browser and give it
  the two files in `srt-viewer/samples/`.
- **The tests:** `uv run pytest` in `subtitle-daemon/`.

## Test data

`srt-viewer/samples/` is an original scene written for this repository, in
English and Turkish on the same timings. The aligner was developed against
real film subtitles, which are copyrighted and stay out of version control:
the tests and the bench that measure alignment read `srt-viewer/subtitles/`
and the daemon's download cache when they are there, and skip without them.
Both paths are gitignored.

## Why the extension reads the page clock

For a film streaming in a browser tab, the hard part of subtitle sync is
normally guessing the offset between the subtitle file and the playing video.
That guess is unnecessary here: the `<video>` element exposes `currentTime`,
so the overlay reads the actual playback position every frame. Seeking,
pausing and buffering all stay in sync for free. The only offset left to
correct is the one baked into the subtitle file itself, from being timed
against a different release — hence the nudge keys.

## Provenance

`subgen/`, `docs/engine-bakeoff/` and `docs/subgen-spec-*` were migrated here
from a scratch directory that was never under version control. What came
across:

- `subgen/src/` — the only implementation that actually ran, previously
  `subtitle-gen/chatgpt-agent`. faster-whisper based, with VAD, a glossary
  prompt and a diarization stub.
- `subgen/experiments/faster-whisper-minimal.py` — the twelve-line script the
  bake-off was run from.
- `docs/subgen-spec-claude-*.md` — a detailed spec for the same tool that was
  never implemented. Kept for the design decisions in it, not as a plan.
- `docs/engine-bakeoff/` — what a whisper.cpp against faster-whisper run
  showed. The transcripts themselves are of private recordings and were not
  kept.

Left behind deliberately: the `whisper.cpp` clone (upstream source, 3 GB with
weights — rebuilt by the setup script), the sample `.wav`/`.mp3` audio, and an
empty `subtitle-gen/gemini/` directory.

## License

MIT, see [LICENSE](LICENSE). The word-frequency and phrase lists under
`browser-extension/src/study/` are derived from CC BY-SA 4.0 sources and keep
that license; see [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
