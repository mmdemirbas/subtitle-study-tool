"""Tests for speaker / sound / music classification.

The cases named here are taken from subtitles this tool actually downloaded, so
the classifier is measured against real caption-house conventions rather than
invented ones.
"""

from __future__ import annotations

import pytest

from subtitle_daemon.annotations import (
    LYRIC,
    MUSIC,
    MUSIC_COLOR,
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


# --- the song, as opposed to the marks around it --------------------------------
#
# The marks were coloured and what they bracket was left as dialogue, so a line
# of a song rendered exactly like a line somebody said. The shapes below are the
# ones the 277-file cache actually contains, in their measured proportions: 574
# lines that open and close, 291 that only open, 251 that only close.


def test_music_note_markers() -> None:
    """The marks themselves are still marks, with the song between them."""
    assert [run.kind for run in parse("♪ La la la ♪").runs] == [
        MUSIC,
        None,
        LYRIC,
        None,
        MUSIC,
    ]


def lyrics(text: str) -> list[str]:
    return [run.text for run in parse(text).runs if run.kind == LYRIC]


def test_a_lyric_that_only_opens_runs_to_the_end_of_its_line() -> None:
    assert lyrics("♪ Why don't you tell me") == ["Why don't you tell me"]


def test_a_lyric_that_only_closes_starts_at_the_beginning_of_its_line() -> None:
    """The back half of a line that began singing on the line before. 251 of
    them in the cache, and reading the mark as an opening one would format the
    empty string after it and leave every sung word as dialogue."""
    assert lyrics("who's on the phone?♪") == ["who's on the phone?"]


def test_each_line_of_a_cue_is_bracketed_on_its_own() -> None:
    assert lyrics("♪ Through the streets\nof your town ♪") == [
        "Through the streets",
        "of your town",
    ]


def test_a_line_beside_a_lyric_is_not_one() -> None:
    """All 44 cues in the cache that mix marked and unmarked lines are this
    shape - a song under one dash and somebody talking under the other."""
    assert lyrics("- ♪ Who by high ordeal ♪\n- Okay, Claire, meet Paige.") == [
        "Who by high ordeal"
    ]


def test_the_markup_and_the_marks_need_not_line_up() -> None:
    """`♪ <i>Happy birthday to you</i>` is two runs: the mark is in the first
    and every sung word is in the second. A pass that asked each run what was
    in it would find a mark with nothing after it and a lyric with no mark."""
    runs = parse("♪ <i>Happy birthday to you</i>").runs
    sung = [run for run in runs if run.kind == LYRIC]
    assert [run.text for run in sung] == ["Happy birthday to you"]
    assert "i" in sung[0].styles, "the file's own italics were dropped"


def test_two_marks_with_nothing_between_them_are_not_a_song() -> None:
    """A translator's credit, verbatim from the cache. Formatting the whole
    line would put a violet italic e-mail address over the film."""
    assert lyrics("Subs @Ivandrofly corrected ♪♪by") == []


def test_a_stray_trailing_mark_does_not_swallow_the_line() -> None:
    """Ends with a mark AND begins with one, so it is not a continuation."""
    assert lyrics("♪ I'm gonna swallow my tears♪♪") == ["I'm gonna swallow my tears"]


def test_a_sound_inside_a_song_is_still_a_sound() -> None:
    kinds_found = [run.kind for run in parse("♪ [sighs] and singing ♪").runs]
    assert SOUND in kinds_found and LYRIC in kinds_found


def test_a_lyric_carries_the_music_colour() -> None:
    """The same hue as the marks bracketing it, so the two read as one thing -
    and the reason every other annotation gets a colour: hue says "this is not
    the dialogue" faster than anything else can."""
    sung = [run for run in parse("♪ La la la ♪").runs if run.kind == LYRIC]
    marks = [run for run in parse("♪ La la la ♪").runs if run.kind == MUSIC]
    assert sung[0].color == marks[0].color == MUSIC_COLOR


def test_a_colour_the_file_chose_outranks_the_lyric_colour() -> None:
    sung = [
        run
        for run in parse('<font color="red">♪ La la la ♪</font>').runs
        if run.kind == LYRIC
    ]
    assert sung[0].color == "red"


def test_dialogue_with_no_marks_is_untouched() -> None:
    assert lyrics("Just something somebody said.") == []


def test_multiple_speakers_in_one_cue() -> None:
    result = kinds("[Lou] Hi. [Maya] Bye.")
    assert [kind for _, kind in result] == [SPEAKER, None, SPEAKER, None]


def test_speakers_in_one_cue_get_different_colours() -> None:
    runs = [r for r in parse("[Lou] Hi. [Maya] Bye.").runs if r.kind == SPEAKER]
    assert runs[0].color != runs[1].color
