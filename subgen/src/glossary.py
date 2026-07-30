"""Glossary handling utilities.

This module reads a glossary file and builds an initial prompt string for
Whisper.  Each line of the file should contain a single term or phrase.
The terms are concatenated into a comma‑separated list prefixed with a
label.  Empty lines and comments starting with ``#`` are ignored.
"""

from __future__ import annotations

from pathlib import Path
from typing import Iterable, Optional


def load_glossary(path: str) -> str:
    """Load a glossary file and build an initial prompt.

    Args:
        path: Path to a glossary text file.  If the file does not exist
            or is empty, an empty string is returned.

    Returns:
        A string of the form ``"Vocabulary: term1, term2, ..."`` which can
        be passed as ``initial_prompt`` to the Whisper model.  If no terms
        are found, the empty string is returned.
    """
    file = Path(path)
    if not file.exists():
        return ""
    terms = []
    with file.open(encoding="utf-8") as f:
        for line in f:
            stripped = line.strip()
            if not stripped or stripped.startswith("#"):
                continue
            terms.append(stripped)
    if not terms:
        return ""
    return "Vocabulary: " + ", ".join(terms)
