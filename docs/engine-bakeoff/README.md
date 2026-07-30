# Whisper engine bake-off (archived results)

Migrated from `~/dev/incubation/speech-to-text/out/`. These are the text
outputs of running two Whisper implementations over the same audio, kept
because they record how each engine behaved on Turkish and accented speech.
The source `.wav` files were left behind — they are 41 MB and add nothing the
transcripts don't already show.

## What was compared

| Engine | Model | Notes |
|---|---|---|
| `whisper.cpp` | `ggml-large-v3` | CPU, Metal-accelerated build. Emits `.srt` / `.vtt` / `.txt` directly. |
| `faster-whisper` (CTranslate2) | `large-v3` | CPU only — CTranslate2 has no Metal/MPS backend. `vad_filter=True`, `beam_size=8`, `condition_on_previous_text=False`. Emits plain timestamped text. |

## Samples

- `interview/` — a long interview. `interview.{srt,vtt,txt}` are
  whisper.cpp; `faster-whisper.txt` is the CTranslate2 run over the same audio.
- `sohbet/` — a shorter Turkish conversation, whisper.cpp only. A
  `sample-noise.wav` variant existed alongside `sample-clean.wav` but was never
  transcribed, so only the clean run survives.

## Why it matters for the realtime path

Both runs used `large-v3`. On this machine that model transcribes slower than
realtime, so neither configuration here can drive a live overlay as-is. The
realtime engine in `subgen/` uses a smaller model for that reason; these files
are the quality reference to measure that tradeoff against, not a baseline to
reproduce.

The `condition_on_previous_text=False` and VAD settings in the faster-whisper
run were both there to suppress hallucinated repetition during silence. That
problem gets worse, not better, in a streaming setup with short windows, so
those flags carry over.
