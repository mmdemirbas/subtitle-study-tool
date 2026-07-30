"""
SubGen package

This package implements a local subtitle generation pipeline based on
OpenAI’s Whisper model via the faster‑whisper library.  It exposes a
command‑line interface (see :mod:`src.cli`) and supporting modules for
loading the model, writing SRT files, post‑processing segments, and
optional diarization hooks.
"""

from .engine import SubtitleGenerator  # noqa: F401