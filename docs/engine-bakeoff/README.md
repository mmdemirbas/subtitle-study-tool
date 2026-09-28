# Whisper engine bake-off (archived results)

Two Whisper implementations run over the same audio, to see how each behaved
on Turkish and on accented English. The recordings are of private
conversations, so neither the audio nor the transcripts are in the
repository; this page records the setup and what it decided.

## What was compared

| Engine | Model | Notes |
|---|---|---|
| `whisper.cpp` | `ggml-large-v3` | CPU, Metal-accelerated build. Emits `.srt` / `.vtt` / `.txt` directly. |
| `faster-whisper` (CTranslate2) | `large-v3` | CPU only — CTranslate2 has no Metal/MPS backend. `vad_filter=True`, `beam_size=8`, `condition_on_previous_text=False`. Emits plain timestamped text. |

## The audio

- A long interview in English with accented speech: whisper.cpp wrote `.srt`,
  `.vtt` and `.txt`, and faster-whisper plain timestamped text over the same
  audio.
- A shorter Turkish conversation, whisper.cpp only. A noisy variant of the
  recording existed but was never transcribed.

## Why it matters for the realtime path

Both runs used `large-v3`. On this machine that model transcribes slower than
realtime, so neither configuration here can drive a live overlay as-is. `subgen/`
is the batch generator and defaults to `large-v3` as well - a realtime engine is
still an idea, and when there is one it will run a smaller model. The transcripts
were the quality reference to measure that tradeoff against, not a baseline to
reproduce.

The `condition_on_previous_text=False` and VAD settings in the faster-whisper
run were both there to suppress hallucinated repetition during silence. That
problem gets worse, not better, in a streaming setup with short windows, so
those flags carry over.
