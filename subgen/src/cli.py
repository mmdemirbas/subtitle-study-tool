"""Command‑line interface for the local subtitle generator.

This module defines a CLI using the standard :mod:`argparse` library.  It
parses user input, instantiates a :class:`SubtitleGenerator`, and processes
either a single file or an entire directory of media files.  The CLI is
designed to be simple and does not depend on third‑party packages.
"""

from __future__ import annotations

import argparse
import os
import sys
from pathlib import Path
from typing import List

# When run as a script, Python does not treat `src` as a package, so relative
# imports (e.g. `.engine`) may fail.  Append the parent directory of this
# file to ``sys.path`` so that we can import sibling modules directly.
if __package__ is None or __package__ == "":
    import os as _os
    import sys as _sys
    parent = _os.path.dirname(_os.path.abspath(__file__))
    if parent not in _sys.path:
        _sys.path.append(parent)

# We intentionally avoid importing the heavy engine at module import time.  This
# allows users to run `python3 cli.py --help` without having the model
# dependencies installed.  The engine is imported dynamically in the
# ``main`` function after argument parsing.


def parse_args(argv: List[str]) -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Local subtitle generator using Whisper via faster‑whisper."
    )
    parser.add_argument(
        "input_path",
        help="Path to an audio/video file or directory containing media files.",
    )
    parser.add_argument(
        "--mode",
        choices=["transcribe", "translate", "both"],
        default="both",
        help="Generate subtitles in the original language (transcribe), English translation (translate), or both.",
    )
    parser.add_argument(
        "--model-size",
        dest="model_size",
        default="large-v3",
        help="Name of the Whisper model to load (e.g. large-v3, medium, small).",
    )
    parser.add_argument(
        "--device",
        choices=["cpu", "cuda", "auto"],
        default="cpu",
        help="Device for inference.  Use cpu on Apple Silicon; cuda requires a supported NVIDIA GPU.",
    )
    parser.add_argument(
        "--compute-type",
        dest="compute_type",
        default="int8",
        help="Numerical precision for inference (float32, float16, int8, auto).",
    )
    parser.add_argument(
        "--output-dir",
        dest="output_dir",
        default="outputs",
        help="Directory where generated SRT files will be saved.",
    )
    parser.add_argument(
        "--glossary",
        dest="glossary",
        default=os.path.join(os.path.dirname(__file__), "glossary.txt"),
        help="Path to a glossary file used to prime the model with domain‑specific vocabulary.",
    )
    parser.add_argument(
        "--diarize",
        action="store_true",
        help="Attempt speaker diarization (requires optional dependencies).",
    )
    parser.add_argument(
        "--beam-size",
        type=int,
        default=5,
        help="Beam size for decoding.  Larger values may improve accuracy but slow down inference.",
    )
    return parser.parse_args(argv)


def gather_media_files(input_path: str) -> List[str]:
    """Return a list of media files to process.

    If ``input_path`` is a file, it is returned in a list.  If it is a
    directory, all files with supported extensions are returned.  Subdirectories
    are not traversed.
    """
    path = Path(input_path)
    if not path.exists():
        raise FileNotFoundError(f"Input path does not exist: {input_path}")
    if path.is_file():
        return [str(path)]
    # Accept typical audio/video extensions.  Feel free to extend this list.
    supported_exts = {".mp4", ".mkv", ".mov", ".avi", ".webm", ".wav", ".mp3", ".m4a"}
    files: List[str] = []
    for entry in path.iterdir():
        if entry.is_file() and entry.suffix.lower() in supported_exts:
            files.append(str(entry))
    return sorted(files)


def main(argv: List[str] | None = None) -> None:
    args = parse_args(argv or sys.argv[1:])
    # Import the engine lazily to avoid requiring model dependencies for --help
    try:
        from engine import SubtitleGenerator  # type: ignore
    except ImportError as e:
        print(
            "Error importing dependencies.  Have you run ./setup.sh?",
            file=sys.stderr,
        )
        raise
    generator = SubtitleGenerator(
        model_size=args.model_size,
        device=args.device,
        compute_type=args.compute_type,
        glossary_path=args.glossary,
        diarize=args.diarize,
        beam_size=args.beam_size,
    )
    files = gather_media_files(args.input_path)
    if not files:
        print("No supported media files found in the specified path.")
        return
    for file_path in files:
        print(f"[SubGen] Processing {file_path} ...")
        generator.process_file(file_path, mode=args.mode, output_dir=args.output_dir)
        print(f"[SubGen] Finished processing {file_path}")


if __name__ == "__main__":
    main()