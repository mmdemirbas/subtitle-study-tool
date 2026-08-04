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
| `subtitle-daemon/` | Local HTTP service. Searches and downloads from OpenSubtitles, caches aggressively, converts to WebVTT. Backs both the extension and the viewer. | see its README |
| `srt-viewer/` | Single-file browser app, "SRT Study Tool v7". Dual-subtitle study surface with its own virtual playback clock. | working |
| `srt-translator/` | Python CLI. Batch-translates a whole `.srt` via OpenAI / DeepL / Google / Azure / LibreTranslate, with a SQLite dedup cache. | working |
| `subgen/` | Local Whisper transcription — batch today, realtime for the live overlay. | migrated, see below |
| `scripts/` | `setup-whisper.sh` builds whisper.cpp and fetches models. | working |
| `docs/` | Bake-off results and older design specs. | reference |

Multi-gigabyte things — the whisper.cpp checkout and the model weights — live
in `vendor/` and `models/`, both gitignored and both restored by
`scripts/setup-whisper.sh`.

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
from `~/dev/incubation/speech-to-text`, which was a scratch directory and never
under version control. What came across:

- `subgen/src/` — the only implementation that actually ran, previously
  `subtitle-gen/chatgpt-agent`. faster-whisper based, with VAD, a glossary
  prompt and a diarization stub.
- `subgen/experiments/faster-whisper-minimal.py` — the twelve-line script the
  bake-off was run from.
- `docs/subgen-spec-claude-*.md` — a detailed spec for the same tool that was
  never implemented. Kept for the design decisions in it, not as a plan.
- `docs/engine-bakeoff/` — whisper.cpp vs faster-whisper transcripts.

Left behind deliberately: the `whisper.cpp` clone (upstream source, 3 GB with
weights — rebuilt by the setup script), the sample `.wav`/`.mp3` audio, and an
empty `subtitle-gen/gemini/` directory.
