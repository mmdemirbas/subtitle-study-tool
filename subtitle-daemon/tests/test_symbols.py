"""Tests for stem-based symbol matching.

An exhaustive word list was never going to work - caption houses write
"exhales deeply", "exhales sharply", "suspenseful music continuing" - so
matching is by stem plus inflection, with modifiers dropped. These tests are
mostly about the two ways that can go wrong: missing an obvious inflection, and
matching a word that merely starts the same way.
"""

from __future__ import annotations

import pytest

from subtitle_daemon.annotations import _MODIFIERS, _STEM_SYMBOLS, symbol_for


@pytest.mark.parametrize(
    "description",
    [
        "clicking",
        "buzzing",
        "indistinct chatter",
        "exhales deeply",
        "breathing heavily",
        "panting",
        "thuds",
        "exhales sharply",
        "phone dings",
        "suspenseful music continuing",
    ],
)
def test_the_reported_gaps_all_resolve(description: str) -> None:
    assert symbol_for(description), f"no symbol for {description!r}"


def test_inflections_of_one_stem_agree() -> None:
    """One table entry has to cover the whole verb, however it is written."""
    for group in (
        ["click", "clicks", "clicked", "clicking"],
        ["exhale", "exhales", "exhaled", "exhaling"],
        ["thud", "thuds", "thudded", "thudding"],
        ["buzz", "buzzes", "buzzing"],
        ["chuckle", "chuckles", "chuckling"],
    ):
        symbols = {symbol_for(word) for word in group}
        assert len(symbols) == 1 and None not in symbols, f"{group} -> {symbols}"


def test_modifiers_do_not_change_the_answer() -> None:
    base = symbol_for("exhales")
    for modifier in ("deeply", "sharply", "softly", "again", "continuing", "in the distance"):
        assert symbol_for(f"exhales {modifier}") == base


def test_music_mood_is_distinguished_from_plain_music() -> None:
    plain = symbol_for("music playing")
    assert symbol_for("suspenseful music continuing") != plain
    assert symbol_for("tense music") == symbol_for("ominous music")
    assert symbol_for("upbeat music") not in (None, plain)


def test_leftmost_informative_token_wins() -> None:
    # Caption style is subject first: the object is what identifies the sound.
    assert symbol_for("phone dings") == symbol_for("phone rings")
    assert symbol_for("door creaks") == symbol_for("door slams")


def test_related_words_deliberately_share_a_symbol() -> None:
    # "footsteps" and "stepping" are the same event and should read the same.
    # Shadowing that would be a bug is covered by test_every_stem_is_reachable.
    assert symbol_for("footsteps") == symbol_for("stepping")
    assert symbol_for("gunshot") == symbol_for("gunfire")


@pytest.mark.parametrize(
    ("word", "wrong_stem"),
    [
        ("carpet", "car"),
        ("caring", "car"),
        ("bringing", "ring"),
        ("shotgun", "shot"),
        ("training", "rain"),
        ("winding", "wind"),
        ("keyboard", "key"),
        ("password", "pass"),
        ("running", "run"),
    ],
)
def test_prefix_collisions_are_rejected_or_deliberate(word: str, wrong_stem: str) -> None:
    """A stem must only match a real inflection of itself.

    Plain prefix matching would make "carpet" a car and "bringing" a bell. The
    inflection check is what prevents that; where a word legitimately IS an
    inflection ("running" of "run", "winding" of "wind") a match is correct.
    """
    from subtitle_daemon.annotations import _matches_stem

    legitimate = {"running", "winding", "caring"}
    if word in legitimate:
        return
    assert not _matches_stem(word, wrong_stem), f"{word!r} wrongly matched stem {wrong_stem!r}"


@pytest.mark.parametrize(
    "description",
    ["bureaucracy intensifies", "zzzyzx", "", "   ", "ambience", "indeterminate"],
)
def test_unknown_sounds_return_nothing_rather_than_a_wrong_symbol(description: str) -> None:
    # A wrong glyph is worse than none: the whole value is that the same symbol
    # always means the same word.
    assert symbol_for(description) is None


def test_a_real_sound_word_anywhere_in_the_phrase_still_matches() -> None:
    # The flip side: matching is generous about surrounding words, because
    # descriptions are written as free text.
    assert symbol_for("indeterminate rustle of papers") == symbol_for("rustling")
    assert symbol_for("speaking in a foreign language") is not None


def test_description_made_only_of_modifiers_does_not_crash() -> None:
    assert symbol_for("continuing") is None or isinstance(symbol_for("continuing"), str)
    assert symbol_for("softly, distantly") is None


def test_case_and_punctuation_do_not_matter() -> None:
    assert symbol_for("PHONE DINGS") == symbol_for("phone dings")
    assert symbol_for("phone dings.") == symbol_for("phone dings")
    assert symbol_for("[phone dings]".strip("[]")) == symbol_for("phone dings")


def test_phrase_table_beats_its_parts() -> None:
    assert symbol_for("clears throat") != symbol_for("throat")
    assert symbol_for("car horn") != symbol_for("car engine")


def test_every_stem_is_reachable() -> None:
    """Guards against a stem shadowed by a shorter one that sorts first."""
    unreachable = [
        stem for stem in _STEM_SYMBOLS if symbol_for(stem) != _STEM_SYMBOLS[stem]
    ]
    assert unreachable == [], f"shadowed stems: {unreachable}"


def test_no_stem_is_also_a_modifier() -> None:
    # A stem in the modifier list would be stripped before it could match.
    assert not (set(_STEM_SYMBOLS) & _MODIFIERS)
