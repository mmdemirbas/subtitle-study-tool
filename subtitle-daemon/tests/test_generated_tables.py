"""The exported tables must match the Python they came from.

Without this the extension keeps a stale copy of the symbol table and nothing
fails - it just matches slightly worse than the daemon, on a path the daemon's
own tests never touch. Silence is the whole risk, so it gets a test.
"""

from __future__ import annotations

import sys
from pathlib import Path

TOOLS = Path(__file__).resolve().parents[1] / "tools"
sys.path.insert(0, str(TOOLS))

import export_tables


def test_generated_tables_are_current() -> None:
    expected = export_tables.build()
    actual = export_tables.OUTPUT.read_text(encoding="utf-8")
    assert actual == expected, (
        "browser-extension/src/subtitles/tables.generated.js is stale. "
        "Run: uv run python tools/export_tables.py"
    )


def test_duplicate_keys_resolve_the_way_python_reads_them() -> None:
    """The source listed some stems twice, and the later entry was the live one.

    Each is listed once now, with the value Python read. Exporting from the
    imported module got this right for free; a hand copy had to notice, which
    is the argument for generating the file.
    """
    from subtitle_daemon import annotations

    # `clatter` was listed as 💥 and again as 🍽️ further down; 🍽️ was in effect.
    assert annotations._STEM_SYMBOLS["clatter"] == "🍽️"
    assert annotations.symbol_for("clattering") == "🍽️"
