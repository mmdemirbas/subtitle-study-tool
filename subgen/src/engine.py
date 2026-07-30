"""Core engine for subtitle generation.

The :class:`SubtitleGenerator` encapsulates loading the Whisper model,
performing transcription and translation, applying optional post‑processing
filters (voice activity detection and repetition removal), and writing
SRT files.  The model is loaded once per instance to avoid repeated
startup overhead.
"""

from __future__ import annotations

import os
from pathlib import Path
from typing import Iterable, List, Optional, Tuple

from faster_whisper import WhisperModel

# When run as a script, relative imports may fail.  Add the current
# directory to sys.path so that sibling modules can be imported.
if __package__ is None or __package__ == "":
    import os as _os
    import sys as _sys
    current = _os.path.dirname(_os.path.abspath(__file__))
    if current not in _sys.path:
        _sys.path.append(current)

from glossary import load_glossary  # type: ignore
from postprocess import remove_repeated_segments  # type: ignore
from utils import write_srt  # type: ignore
from diarization import apply_diarization  # type: ignore


class SubtitleGenerator:
    """Handle model loading and subtitle generation.

    Parameters
    ----------
    model_size: str
        Name of the Whisper model to load (e.g. ``"large-v3"``).
    device: str, optional
        The device on which to run inference (``"cpu"``, ``"cuda"`` or ``"auto"``).
        On Apple Silicon use ``"cpu"`` because GPU inference is not supported【389818013476231†L410-L426】.
    compute_type: str, optional
        Numeric precision for inference.  Acceptable values include ``"float32"``,
        ``"float16"``, ``"int8"`` and ``"auto"``.  Using ``"int8"`` can
        dramatically reduce memory usage and improve speed with a negligible drop
        in accuracy【389818013476231†L432-L456】.
    glossary_path: str or None, optional
        Path to a glossary file containing domain‑specific vocabulary.  Terms in
        the glossary are prepended to the model via the initial prompt.
    diarize: bool, optional
        If True, attempt to add speaker labels to the output.  Requires
        additional dependencies; see :mod:`src.diarization`.
    beam_size: int, optional
        Beam size for decoding.  Larger values may improve accuracy at the cost
        of slower inference.
    """

    def __init__(
        self,
        model_size: str = "large-v3",
        device: str = "cpu",
        compute_type: str = "int8",
        glossary_path: Optional[str] = None,
        diarize: bool = False,
        beam_size: int = 5,
    ) -> None:
        self.model_size = model_size
        self.device = device
        self.compute_type = compute_type
        self.diarize = diarize
        self.beam_size = beam_size
        self._model: Optional[WhisperModel] = None
        # Build initial prompt from glossary
        if glossary_path:
            self.initial_prompt = load_glossary(glossary_path)
        else:
            self.initial_prompt = ""

    def _load_model(self) -> WhisperModel:
        """Lazy‑load the Whisper model if not already loaded."""
        if self._model is None:
            # Create a local cache directory for model files under project root
            # to avoid polluting the user's global cache.  If the environment
            # variable CT2_CACHE is set, ctranslate2 will respect it.
            # Otherwise, faster‑whisper downloads models into ~/.cache.
            self._model = WhisperModel(
                self.model_size,
                device=self.device,
                compute_type=self.compute_type,
            )
        return self._model

    def _transcribe(
        self, file_path: str, task: str
    ) -> Tuple[List, object]:  # returns segments and info
        """Run the Whisper model on a file for either transcription or translation.

        Args:
            file_path: Path to the audio or video file.
            task: ``"transcribe"`` for original language or ``"translate"`` for
                English translation.

        Returns:
            A tuple ``(segments, info)`` where ``segments`` is a list of segment
            objects and ``info`` contains metadata about the transcription.
        """
        model = self._load_model()
        # Use VAD to filter long silences.  min_silence_duration_ms is set to
        # 500 ms to remove pauses longer than half a second【266722112981846†L60-L82】.
        vad_params = {"min_silence_duration_ms": 500}
        segments, info = model.transcribe(
            file_path,
            beam_size=self.beam_size,
            task=task,
            vad_filter=True,
            vad_parameters=vad_params,
            initial_prompt=self.initial_prompt or None,
        )
        return list(segments), info

    def _post_process_segments(self, segments: Iterable) -> List:
        """Apply post‑processing filters to remove obvious repetition and
        optionally diarize speakers."""
        cleaned = remove_repeated_segments(segments)
        if self.diarize:
            # Note: apply_diarization prints a warning if dependencies are missing
            cleaned = apply_diarization(cleaned, "")
        return cleaned

    def process_file(
        self,
        file_path: str,
        mode: str = "both",
        output_dir: str = "outputs",
    ) -> None:
        """Process a single file and write subtitle files to disk.

        Depending on ``mode``, this method will generate one or two SRT files:

        * ``transcribe`` – a `.orig.srt` file in the detected language.
        * ``translate`` – a `.en.srt` file containing the English translation.
        * ``both`` – both of the above.

        Args:
            file_path: Path to the media file.
            mode: One of ``transcribe``, ``translate`` or ``both``.
            output_dir: Directory into which the SRT files will be written.
        """
        file_path = os.path.abspath(file_path)
        filename = os.path.splitext(os.path.basename(file_path))[0]
        os.makedirs(output_dir, exist_ok=True)
        if mode in ("transcribe", "both"):
            segments, info = self._transcribe(file_path, task="transcribe")
            segments = self._post_process_segments(segments)
            out_path = os.path.join(output_dir, f"{filename}.orig.srt")
            write_srt(segments, out_path)
        if mode in ("translate", "both"):
            segments, info = self._transcribe(file_path, task="translate")
            segments = self._post_process_segments(segments)
            out_path = os.path.join(output_dir, f"{filename}.en.srt")
            write_srt(segments, out_path)