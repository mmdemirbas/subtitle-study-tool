"""Post‑processing utilities for transcribed segments.

Whisper occasionally produces hallucinated repetitions, especially
during long stretches of silence.  This module defines simple filters
to remove obvious duplicate lines while preserving the overall
sequence and timing.
"""

from __future__ import annotations

from typing import Iterable, List, Any


def remove_repeated_segments(segments: Iterable) -> List:
    """Remove consecutive segments with identical text.

    Args:
        segments: An iterable of objects with ``start``, ``end`` and ``text``
            attributes.

    Returns:
        A list of segments with obvious repeats removed.  Consecutive segments
        whose stripped text is identical and whose start times are very close
        (less than 0.1 seconds apart) will be collapsed into a single entry
        spanning the union of their durations.
    """
    cleaned: List[Any] = []
    prev = None
    for seg in segments:
        text = seg.text.strip()
        if prev is None:
            prev = seg
            continue
        prev_text = prev.text.strip()
        # if the same text appears back‑to‑back and starts within 100 ms, merge
        if text == prev_text and abs(seg.start - prev.start) < 0.1:
            # extend end time of the previous segment
            prev.end = max(prev.end, seg.end)
        else:
            cleaned.append(prev)
            prev = seg
    if prev is not None:
        cleaned.append(prev)
    return cleaned
