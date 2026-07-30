"""Utility functions for subtitle generation.

This module contains helpers for formatting timestamps, writing SRT files
and converting segments returned by faster‑whisper into more convenient
structures.
"""

from __future__ import annotations

import os
from typing import Iterable, List, Tuple


def format_timestamp(seconds: float) -> str:
    """Return a string in ``HH:MM:SS,mmm`` format for an offset in seconds.

    Args:
        seconds: Timestamp in seconds (float).  Negative values are clamped to
            zero.

    Returns:
        A string formatted according to the SRT specification.
    """
    if seconds < 0:
        seconds = 0.0
    hours, remainder = divmod(seconds, 3600)
    minutes, remainder = divmod(remainder, 60)
    secs, ms = divmod(remainder, 1)
    return f"{int(hours):02d}:{int(minutes):02d}:{int(secs):02d},{int(ms * 1000):03d}"


def segments_to_srt(segments: Iterable) -> List[str]:
    """Convert an iterable of segments into a list of SRT entries.

    Each segment must have ``start``, ``end`` and ``text`` attributes.
    The returned list of strings does not include the final newline.
    """
    srt_lines: List[str] = []
    for idx, segment in enumerate(segments, start=1):
        start_ts = format_timestamp(segment.start)
        end_ts = format_timestamp(segment.end)
        text = segment.text.strip()
        srt_lines.append(f"{idx}\n{start_ts} --> {end_ts}\n{text}\n")
    return srt_lines


def write_srt(segments: Iterable, path: str) -> None:
    """Write an iterable of segments to an SRT file.

    Args:
        segments: An iterable of objects with ``start``, ``end`` and ``text``
            attributes.
        path: Output path for the SRT file.  Parent directories will be
            created if necessary.
    """
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "w", encoding="utf-8") as f:
        for entry in segments_to_srt(segments):
            f.write(entry)
