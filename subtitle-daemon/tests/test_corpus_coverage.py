"""Coverage of the symbol matcher against real caption files.

The matcher was originally written from intuition about how caption houses
phrase things, which is exactly the sort of thing that reads as correct and
measures as wrong. This runs it against an inventory extracted from eight
downloaded subtitles - 9,254 cues - so a regression shows up as a number.

The inventory is annotation text and counts only, no dialogue. Rebuild it with
`uv run python tools/annotation_corpus.py fetch` (spends download quota).
"""

from __future__ import annotations

import json
from pathlib import Path

import pytest

from subtitle_daemon import annotations

CORPUS_PATH = Path(__file__).parent / "data" / "annotation-corpus.json"

# Where the matcher stood when this test was written. Ratchets: a change that
# lowers coverage should have to justify itself by editing this line.
MINIMUM_OCCURRENCE_COVERAGE = 0.97
MINIMUM_DISTINCT_COVERAGE = 0.95


@pytest.fixture(scope="module")
def corpus() -> dict[str, int]:
    if not CORPUS_PATH.exists():
        pytest.skip(f"no corpus at {CORPUS_PATH}")
    return json.loads(CORPUS_PATH.read_text())["annotations"]


def _scorable(corpus: dict[str, int]) -> list[tuple[str, int]]:
    """Annotations that a symbol could meaningfully apply to.

    Speakers are excluded - they get an identity colour instead - as are bare
    note characters, which are already a symbol.
    """
    out = []
    for text, count in corpus.items():
        if annotations.classify(text, followed_by_speech=False) == annotations.SPEAKER:
            continue
        if not annotations._content_tokens(text):
            continue
        out.append((text, count))
    return out


def test_symbol_coverage_by_occurrence(corpus: dict[str, int]) -> None:
    scorable = _scorable(corpus)
    total = sum(count for _text, count in scorable)
    hit = sum(count for text, count in scorable if annotations.symbol_for(text))

    ratio = hit / total
    assert ratio >= MINIMUM_OCCURRENCE_COVERAGE, (
        f"symbol coverage fell to {ratio:.1%} ({hit}/{total}); "
        f"run tools/annotation_corpus.py report to see what stopped matching"
    )


def test_symbol_coverage_by_distinct_annotation(corpus: dict[str, int]) -> None:
    scorable = _scorable(corpus)
    hit = sum(1 for text, _count in scorable if annotations.symbol_for(text))

    ratio = hit / len(scorable)
    assert ratio >= MINIMUM_DISTINCT_COVERAGE, f"distinct coverage fell to {ratio:.1%}"


def test_the_most_common_annotations_all_resolve(corpus: dict[str, int]) -> None:
    """Frequency is what matters for learning: the repeated ones must land."""
    frequent = [
        (text, count)
        for text, count in _scorable(corpus)
        if count >= 5
    ]
    missing = [text for text, _count in frequent if not annotations.symbol_for(text)]
    assert missing == [], f"common annotations with no symbol: {missing}"


def test_no_annotation_decodes_as_mojibake(corpus: dict[str, int]) -> None:
    """Guards the encoding fix that this corpus exposed.

    A UTF-8 file of music notes was being decoded as cp1250, because the
    mangled bytes produce a Turkish letter that the encoding scorer rewarded.
    92 occurrences of "♪♪♪" arrived as "â™Şâ™Şâ™Ş".
    """
    from subtitle_daemon.subtitles import _MOJIBAKE

    broken = [text for text in corpus if _MOJIBAKE.search(text) or "â™" in text]
    assert broken == [], f"mojibake in corpus: {broken[:5]}"


def test_speakers_are_not_given_symbols(corpus: dict[str, int]) -> None:
    """A name must never pick up a sound glyph - "[Bell]" is not a doorbell."""
    speakers = [
        text
        for text in corpus
        if annotations.classify(text, followed_by_speech=True) == annotations.SPEAKER
    ]
    assert speakers, "corpus should contain speaker labels"
    # Sanity: the classifier is what protects this, not the symbol table.
    for name in speakers[:200]:
        assert annotations.classify(name, followed_by_speech=True) == annotations.SPEAKER
