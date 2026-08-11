# subgen

Makes a subtitle file out of the audio, locally, with Whisper. For the film
that nobody has subtitled — where fetching cannot help because the subtitle
does not exist.

```bash
./setup.sh                        # installs faster-whisper into a venv
./run.sh /path/to/film.mkv        # writes film.srt beside it
python3 src/cli.py --help         # every option
```

## What it does

`faster-whisper` (CTranslate2 Whisper) behind a small CLI, with the parts that
make the output usable rather than merely present:

| Piece | What it is for |
|---|---|
| `src/engine.py` | loads the model once, transcribes, writes SRT |
| `src/postprocess.py` | drops the repeated segments Whisper emits over music and silence |
| `src/glossary.py` + `glossary.txt` | names and terms fed to the model as a prompt, so "Adama" does not come out as "a llama" |
| `src/diarization.py` | speaker labelling — a stub, not wired up |
| `experiments/faster-whisper-minimal.py` | the twelve-line script the engine bake-off was run from |

`--mode transcribe` keeps the original language, `translate` gives English,
`both` writes two files. `--model-size large-v3` by default; `--device cpu` on
Apple Silicon.

## What it is not

- **Not live.** It runs over a file you already have, at its own pace. Putting
  subtitles on a *playing* stream is the extension's job, and the realtime
  version of this is still an idea — see the root `README.md`.
- **Not connected to `subtitle-daemon/`.** The daemon has no Whisper in it. If
  they are ever joined, this is the half that does the work.

The model weights and the whisper.cpp checkout live in `../models/` and
`../vendor/`, both gitignored and both restored by `../scripts/setup-whisper.sh`.
Never read or search them.

## Where it came from

Migrated from `~/dev/incubation/speech-to-text`, which was never under version
control. `docs/engine-bakeoff/` has the whisper.cpp against faster-whisper
transcripts that decided which engine this uses; `docs/subgen-spec-claude-*.md`
is a detailed spec for a tool that was never built, kept for the decisions in
it rather than as a plan.
