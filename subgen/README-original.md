# Local Subtitle Generation System (SubGen)

This repository provides a privacy‑first command‑line tool that turns local audio or video files into properly time‑coded subtitles.  It uses the open‑source **faster‑whisper** engine to run OpenAI’s Whisper model entirely on your Mac (Apple Silicon) without sending any data to external APIs.

## Features

* **Fully local processing** – media files never leave your computer.  Model weights are downloaded once and cached locally.  Subsequent runs re‑use the cached model.
* **Large‑V3 model for accuracy** – by default the tool loads the Whisper **large‑v3** model via `faster‑whisper` which is more accurate for heavily accented English (Turkish, Chinese, Indian and other non‑native speakers).
* **Transcription and translation modes** – generate subtitles in the original spoken language (`filename.orig.srt`), English translation (`filename.en.srt`), or both in a single run.
* **Voice activity detection (VAD)** – silence longer than 500 ms is filtered before transcription to prevent hallucinated loops during quiet sections【266722112981846†L60-L82】.
* **Glossary injection** – a simple `glossary.txt` file lets you provide domain‑specific vocabulary (e.g. *Contoso*, *Apache Spark*, *Kubernetes*).  The terms are included as an initial prompt so Whisper spells them correctly.
* **Reusable model instance** – the heavy Whisper model is loaded once and reused for multiple files.  This saves several seconds per run.
* **Optional diarization hook** – the code exposes a `--diarize` flag that will integrate speaker diarization when supported libraries are installed.  The v1 implementation prints a warning and continues without diarization.
* **Reproducible setup** – a `setup.sh` script creates an isolated virtual environment and installs pinned dependencies.  All you need is macOS with Python 3.10+ and an `ffmpeg` binary installed via Homebrew.

## Requirements

* **Hardware**: Apple Silicon (M1/M2/M3).  All computation is run on the CPU because CTranslate2 does not support the Apple GPU (Metal/MPS)【389818013476231†L410-L426】.
* **Operating system**: macOS (tested on macOS 13–14).
* **Software**:
  - Python 3.10 or later.
  - `ffmpeg` installed system‑wide.  On macOS you can install it with Homebrew (`brew install ffmpeg`).
  - A working internet connection for the initial model download (model weights are cached locally).

## Installation

1. **Clone the repository**:

   ```bash
   git clone <repo-url> subgen
   cd subgen
   ```

2. **Install ffmpeg** (if not already installed):

   ```bash
   # using Homebrew on macOS
   brew install ffmpeg
   ```

3. **Run the setup script** to create a virtual environment and install dependencies:

   ```bash
   ./setup.sh
   ```

   The script will create a `.venv` directory, activate it, install packages from `requirements.txt` and verify that `ffmpeg` is available.

4. **(Optional) Adjust the glossary**: open `src/glossary.txt` in a text editor and add any specialised terms you expect to hear (one term per line).  These terms will be included in the model’s initial prompt to improve spelling.

## Usage

Once the environment is set up you can run the tool via the provided wrapper script:

```bash
./run.sh [options] <input>
```

Where `<input>` is either a single media file (e.g. `meeting.mp4`) or a directory containing multiple audio/video files.  Supported formats include any file that ffmpeg can decode (`.mp4`, `.mkv`, `.mov`, `.avi`, `.webm`, `.wav`, `.mp3`, etc.).

### CLI Options

| Flag | Description | Default |
|-----|-------------|---------|
| `--mode {transcribe,translate,both}` | Select whether to output the original language (`transcribe`), the English translation (`translate`), or both. | `both` |
| `--model-size` | Whisper model size to load.  Larger models are more accurate but require more RAM and time.  Typical choices: `large-v3`, `medium`, `small`. | `large-v3` |
| `--device` | Device to run inference on.  Use `cpu` on Apple Silicon as CTranslate2 does not support GPU acceleration【389818013476231†L410-L426】. | `cpu` |
| `--compute-type` | Numerical precision for inference (`float32`, `float16`, `int8`, `auto`).  `int8` is faster and uses less memory with minimal accuracy loss【389818013476231†L432-L456】; `float32` offers the highest accuracy. | `int8` |
| `--output-dir` | Directory where generated subtitles will be saved.  This folder is created if it doesn’t exist. | `outputs` |
| `--glossary` | Path to a glossary file (one term per line).  The default uses `src/glossary.txt`. | `src/glossary.txt` |
| `--diarize` | Attempt to label speakers (`Speaker 1:`, `Speaker 2:`, etc.).  Requires additional dependencies (see below). | off |

### Examples

* **Generate both original language and English subtitles** for a single video:

  ```bash
  ./run.sh inputs/meeting.mp4
  ```

  This produces `outputs/meeting.orig.srt` and `outputs/meeting.en.srt`.

* **Only generate English subtitles**:

  ```bash
  ./run.sh --mode translate inputs/lecture.mkv
  ```

* **Process all media files in a directory**:

  ```bash
  ./run.sh --mode transcribe inputs/
  ```

## How It Works

### Model and Inference

The tool uses the `faster-whisper` library, a reimplementation of Whisper that runs on CTranslate2.  Faster‑whisper is up to four times faster than the official openai/whisper implementation and uses less memory【238427152875014†L100-L106】.  CTranslate2 automatically utilises Apple’s Accelerate Framework for efficient CPU computation on M‑series chips【389818013476231†L410-L426】.  The default compute type of `int8` reduces memory and improves speed with a very small drop in word error rate【389818013476231†L432-L456】.

### Voice Activity Detection

Whisper tends to hallucinate repeated phrases when processing long periods of silence.  To mitigate this, the tool enables the built‑in VAD filter and removes silence longer than 500 milliseconds【266722112981846†L60-L82】.  These parameters can be tweaked in `src/engine.py` if you need different behaviour.

### Glossary

The terms listed in `src/glossary.txt` are joined into a phrase and supplied as an `initial_prompt` when calling the Whisper model.  This encourages the model to spell domain‑specific words correctly.  You can supply a different glossary file via the `--glossary` option or edit the default file.

### Diarization (Future Work)

Speaker diarization is not enabled by default.  Passing `--diarize` will print a warning unless you install compatible libraries (e.g. `pyannote.audio`) and configure authentication tokens.  The code is structured so that adding diarization later only requires implementing the logic in `src/diarization.py`.

## Performance Notes

On an M1 MacBook Pro (16 GB RAM), transcribing a one‑hour video with the default `large‑v3` model and `int8` compute type typically completes within 45–60 minutes.  Switching to `float16` or `float32` may marginally improve accuracy at the cost of higher RAM usage and slower processing.  Smaller models (`medium`, `small`) run faster but may struggle with heavily accented speech.

## Contributing

Pull requests are welcome!  Feel free to open issues if you encounter bugs or have suggestions for improvement.