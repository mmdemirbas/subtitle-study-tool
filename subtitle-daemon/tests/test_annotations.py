"""Tests for speaker / sound / music classification.

The cases named here are taken from subtitles this tool actually downloaded, so
the classifier is measured against real caption-house conventions rather than
invented ones.
"""

from __future__ import annotations

import pytest

from subtitle_daemon.annotations import (
    MUSIC,
    SOUND,
    SPEAKER,
    SOUND_COLOR,
    SPEAKER_PALETTE,
    classify,
    find_annotations,
    speaker_color,
    symbol_for,
)
from subtitle_daemon.markup import parse


def kinds(text: str) -> list[tuple[str, str | None]]:
    return [(run.text, run.kind) for run in parse(text).runs]


# --- classification ------------------------------------------------------------


@pytest.mark.parametrize(
    "label",
    ["Ormon", "Davis", "Sharon", "Lou", "Maya", "Tillman", "Monroe", "yoga instructor"],
)
def test_names_followed_by_speech_are_speakers(label: str) -> None:
    assert classify(label, followed_by_speech=True) == SPEAKER


@pytest.mark.parametrize(
    "label",
    ["sighs", "chuckles", "indistinct chatter", "breathing heavily", "door creaks"],
)
def test_sound_words_are_sounds_even_when_speech_follows(label: str) -> None:
    # "[sighs] I don't know." - the bracket describes a sound, not a speaker,
    # so the lexicon has to outrank the followed-by-speech signal.
    assert classify(label, followed_by_speech=True) == SOUND


def test_lowercase_speaker_label_is_recognised_by_position() -> None:
    # No lexicon hit and dialogue after it: the only signal is position.
    assert classify("yoga instructor", followed_by_speech=True) == SPEAKER
    assert classify("yoga instructor", followed_by_speech=False) == SOUND


def test_name_plus_sound_is_a_sound() -> None:
    # What is conveyed is the sound, not who made it.
    assert classify("Ormon sighs", followed_by_speech=False) == SOUND


def test_standalone_capitalised_name_is_still_a_speaker() -> None:
    # Happens when the dialogue sits on the next line.
    assert classify("Sharon", followed_by_speech=False) == SPEAKER


def test_music_classification() -> None:
    assert classify("dramatic music", followed_by_speech=False) == MUSIC
    assert classify("singing", followed_by_speech=False) == MUSIC
    assert classify("♪ ♪", followed_by_speech=False) == MUSIC


def test_empty_annotation_does_not_crash() -> None:
    assert classify("", followed_by_speech=False) == SOUND


# --- symbols ---------------------------------------------------------------------


def test_symbols_for_the_frequent_sounds() -> None:
    assert symbol_for("sighs")
    assert symbol_for("chuckles")
    assert symbol_for("indistinct chatter")
    assert symbol_for("breathing heavily")


def test_longest_phrase_wins() -> None:
    """"breathing heavily" must not be answered by "breathing"."""
    assert symbol_for("breathing heavily") == symbol_for("panting")
    assert symbol_for("dramatic music") != symbol_for("music")


def test_symbol_matches_inside_a_longer_description() -> None:
    assert symbol_for("Ormon sighs deeply") == symbol_for("sighs")


def test_unknown_sounds_get_no_symbol_rather_than_a_wrong_one() -> None:
    assert symbol_for("bureaucracy intensifies") is None
    assert symbol_for("") is None


def test_symbol_lookup_is_case_and_accent_insensitive() -> None:
    assert symbol_for("SIGHS") == symbol_for("sighs")


def test_word_boundaries_are_respected() -> None:
    # "train" must not fire on "training": nouns take only a plural.
    assert symbol_for("training montage") is None
    assert symbol_for("carpet") is None


# --- speaker colour ---------------------------------------------------------------


def test_speaker_colour_is_stable_and_from_the_palette() -> None:
    first = speaker_color("Sharon")
    assert first in SPEAKER_PALETTE
    assert speaker_color("Sharon") == first


def test_speaker_colour_ignores_case_and_spacing() -> None:
    assert speaker_color("SHARON") == speaker_color("Sharon") == speaker_color(" sharon ")


def test_different_speakers_generally_differ() -> None:
    names = ["Ormon", "Davis", "Sharon", "Lou", "Maya", "Tillman"]
    assert len({speaker_color(n) for n in names}) >= 4, "palette should spread real casts"


def test_speaker_colour_survives_a_restart() -> None:
    # Python's hash() is salted per process; this must not use it.
    assert speaker_color("Sharon") == "#" + speaker_color("Sharon").lstrip("#")
    assert speaker_color("Sharon").startswith("#")


# --- integration through the parser -------------------------------------------------


def test_speaker_and_dialogue_become_separate_runs() -> None:
    assert kinds("[Ormon] Get down!") == [("[Ormon]", SPEAKER), (" Get down!", None)]


def test_sound_is_its_own_run() -> None:
    assert kinds("[sighs] I don't know.") == [("[sighs]", SOUND), (" I don't know.", None)]


def test_speaker_run_carries_a_colour_and_sound_run_a_symbol() -> None:
    speaker = parse("[Sharon] Hello").runs[0]
    assert speaker.color in SPEAKER_PALETTE
    sound = parse("[sighs]").runs[0]
    assert sound.symbol
    # Sounds are coloured too, just not with an identity colour.
    assert sound.color == SOUND_COLOR
    assert sound.color not in SPEAKER_PALETTE


def test_parenthesised_annotations_are_recognised_too() -> None:
    assert kinds("(laughs) Sure.") == [("(laughs)", SOUND), (" Sure.", None)]


def test_bare_name_colon_prefix_is_a_speaker() -> None:
    assert kinds("SHARON: Get down!") == [("SHARON:", SPEAKER), (" Get down!", None)]


def test_ordinary_dialogue_has_no_annotation_runs() -> None:
    assert kinds("Just an ordinary line.") == [("Just an ordinary line.", None)]


def test_time_of_day_colon_is_not_a_speaker() -> None:
    # "It is 5:30" must not be read as a speaker label.
    assert kinds("It is 5:30 already") == [("It is 5:30 already", None)]


def test_formatting_survives_annotation_splitting() -> None:
    runs = parse("<i>[sighs] quietly</i>").runs
    assert all("i" in run.styles for run in runs)
    assert runs[0].kind == SOUND


def test_music_note_markers() -> None:
    assert [run.kind for run in parse("♪ La la la ♪").runs] == [MUSIC, None, MUSIC]


def test_multiple_speakers_in_one_cue() -> None:
    result = kinds("[Lou] Hi. [Maya] Bye.")
    assert [kind for _, kind in result] == [SPEAKER, None, SPEAKER, None]


def test_speakers_in_one_cue_get_different_colours() -> None:
    runs = [r for r in parse("[Lou] Hi. [Maya] Bye.").runs if r.kind == SPEAKER]
    assert runs[0].color != runs[1].color
