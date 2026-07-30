"""Speaker diarization hook (stub).

In version 1, this module acts as a placeholder for future speaker
diarization support.  The `apply_diarization` function returns the
segments unchanged.  To enable diarization, install a compatible
library (e.g. `pyannote.audio`), accept the necessary licenses and
authentication tokens, and replace the implementation below.
"""

from __future__ import annotations

from typing import Iterable, List


def apply_diarization(segments: Iterable, audio_path: str) -> List:
    """Apply speaker diarization to the given segments.

    This stub implementation simply returns the input segments and prints
    a warning.  If pyannote or another diarization library is installed,
    you can replace this function with one that annotates each segment
    with a speaker label.

    Args:
        segments: An iterable of transcript segments returned by
            faster‑whisper.
        audio_path: Path to the original audio file (needed by
            diarization models for speaker separation).

    Returns:
        A list of segments, potentially augmented with speaker labels.
    """
    try:
        import pyannote.audio  # noqa: F401
    except ImportError:
        print("[SubGen] Diarization requested but optional dependency 'pyannote.audio' is not installed. "
              "Proceeding without diarization.")
        return list(segments)
    # Placeholder for future implementation
    print("[SubGen] Diarization dependencies detected, but diarization is not implemented in v1.")
    return list(segments)