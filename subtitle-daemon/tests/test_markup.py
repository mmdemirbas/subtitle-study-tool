"""Tests for inline subtitle markup.

Two things carry most of the weight here. Square brackets are usually speaker
labels rather than tags, so over-eager BBCode parsing would eat dialogue. And
colour lands in a CSS value slot, so it is an allowlist, not a pass-through.
"""

from __future__ import annotations

import pytest

from subtitle_daemon.markup import BOLD, ITALIC, STRIKE, UNDERLINE, Run, parse, strip, to_vtt


def styles_of(text: str) -> list[tuple[str, list[str]]]:
    return [(run.text, sorted(run.styles)) for run in parse(text).runs]


# --- html ---------------------------------------------------------------------


def test_italic_is_the_common_case() -> None:
    assert styles_of("<i>Hello</i>") == [("Hello", ["i"])]


def test_partial_italic_splits_into_runs() -> None:
    assert styles_of("Say <i>hello</i> now") == [
        ("Say ", []),
        ("hello", ["i"]),
        (" now", []),
    ]


def test_all_html_styles() -> None:
    assert parse("<b>a</b>").runs[0].styles == frozenset({BOLD})
    assert parse("<u>a</u>").runs[0].styles == frozenset({UNDERLINE})
    assert parse("<s>a</s>").runs[0].styles == frozenset({STRIKE})
    assert parse("<em>a</em>").runs[0].styles == frozenset({ITALIC})
    assert parse("<strong>a</strong>").runs[0].styles == frozenset({BOLD})


def test_nesting_flattens_into_a_style_set() -> None:
    assert styles_of("<i><b>both</b></i>") == [("both", ["b", "i"])]


def test_unclosed_tag_runs_to_the_end_of_the_cue() -> None:
    assert styles_of("<i>rest of the line") == [("rest of the line", ["i"])]


def test_stray_closing_tag_is_ignored() -> None:
    assert styles_of("plain</i> text") == [("plain text", [])]


def test_repeated_open_tags_need_matching_closes() -> None:
    # One closing tag must not cancel two levels, so "y" is still italic - and
    # because it matches "x"'s formatting the two merge into a single run.
    assert styles_of("<i><i>x</i>y</i>") == [("xy", ["i"])]
    assert styles_of("<i><i>x</i>y</i>z") == [("xy", ["i"]), ("z", [])]


def test_case_and_spacing_in_tags() -> None:
    assert styles_of("<I>a</I>") == [("a", ["i"])]
    assert styles_of("< i >a< / i >") == [("a", ["i"])]


def test_a_less_than_sign_that_is_not_a_tag_stays_text() -> None:
    assert strip("1 < 2 and 3 > 2") == "1 < 2 and 3 > 2"


# --- forum / bbcode -----------------------------------------------------------


def test_bbcode_italic() -> None:
    assert styles_of("[i]Hello[/i]") == [("Hello", ["i"])]


def test_bbcode_all_styles() -> None:
    assert styles_of("[b]a[/b]") == [("a", ["b"])]
    assert styles_of("[u]a[/u]") == [("a", ["u"])]
    assert styles_of("[s]a[/s]") == [("a", ["s"])]


def test_bbcode_mixed_with_html() -> None:
    assert styles_of("[i]a[/i] and <b>b</b>") == [("a", ["i"]), (" and ", []), ("b", ["b"])]


@pytest.mark.parametrize(
    "line",
    [
        "[Ormon] Get down!",
        "[sighs]",
        "[indistinct chatter]",
        "[yoga instructor] Breathe.",
        "[Sharon] What?",
        "[breathing heavily]",
    ],
)
def test_speaker_and_sound_labels_are_dialogue_not_markup(line: str) -> None:
    """The dominant use of square brackets in real caption files.

    Sampled from the subtitles this tool downloaded: 47 [Ormon], 30 [sighs],
    13 [indistinct chatter], and zero BBCode tags. Treating brackets as
    formatting would delete the speaker names.

    They are classified as annotations (see test_annotations.py) and so may be
    split across runs, but every character has to survive - that is what makes
    them dialogue rather than markup.
    """
    assert strip(line) == line
    assert "".join(run.text for run in parse(line).runs) == line


def test_bracketed_word_starting_with_a_tag_letter_is_untouched() -> None:
    assert strip("[boy] Hi") == "[boy] Hi"
    assert strip("[static]") == "[static]"


# --- substation ----------------------------------------------------------------


def test_an8_moves_the_cue_to_the_top() -> None:
    parsed = parse(r"{\an8}Overhead sign")
    assert parsed.vertical == "top"
    assert parsed.plain == "Overhead sign"


def test_an2_is_the_bottom_default() -> None:
    assert parse(r"{\an2}text").vertical == "bottom"
    assert parse(r"{\an5}text").vertical == "middle"


def test_ssa_style_toggles() -> None:
    assert styles_of(r"{\i1}on{\i0} off") == [("on", ["i"]), (" off", [])]


def test_unsupported_override_blocks_are_dropped_not_shown() -> None:
    # The point of dropping them is that they must not reach the screen.
    assert strip(r"{\pos(192,240)}Hello") == "Hello"
    assert strip(r"{\fad(200,200)\blur3}Hello") == "Hello"


def test_legacy_curly_y_form() -> None:
    assert styles_of("{y:i}Hello") == [("Hello", ["i"])]
    assert styles_of("{Y:ib}Hello") == [("Hello", ["b", "i"])]


# --- colour --------------------------------------------------------------------


def test_font_color_hex_and_name() -> None:
    assert parse('<font color="#ff0000">a</font>').runs[0].color == "#ff0000"
    assert parse("<font color=red>a</font>").runs[0].color == "red"
    assert parse("[color=yellow]a[/color]").runs[0].color == "yellow"


def test_color_ends_at_the_closing_tag() -> None:
    runs = parse('<font color="red">a</font>b').runs
    assert runs[0].color == "red"
    assert runs[1].color is None


def test_substation_bgr_colour_is_converted_to_rgb() -> None:
    # &H is blue-green-red, the reverse of hex RGB.
    assert parse("[color=&H0000FF&]a[/color]").runs[0].color == "#ff0000"


@pytest.mark.parametrize(
    "value",
    [
        "red; background: url(http://evil.example)",
        "expression(alert(1))",
        "url(javascript:alert(1))",
        "}</style><script>alert(1)</script>",
        "notacolour",
        "#12345",
        "",
    ],
)
def test_unusable_colours_are_dropped_rather_than_passed_through(value: str) -> None:
    """Colour reaches a CSS value slot, so it is an allowlist, not a filter.

    A rejected tag falls through to being literal text, and literal text in
    brackets may then be classified as a speaker label and given a colour from
    our own palette. That is fine and is the point of the assertion: the only
    colours that ever reach output are ones this code chose.
    """
    from subtitle_daemon.annotations import SPEAKER_PALETTE

    runs = parse(f"[color={value}]a[/color]").runs
    assert all(run.color is None or run.color in SPEAKER_PALETTE for run in runs)
    if value:
        assert all(value not in (run.color or "") for run in runs)


def test_dropping_a_colour_keeps_the_text() -> None:
    assert strip("[color=notacolour]visible[/color]") == "visible"


# --- output --------------------------------------------------------------------


def test_runs_merge_when_formatting_matches() -> None:
    # {\pos} between two plain stretches must not split them into two runs.
    assert styles_of(r"one {\pos(1,2)}two") == [("one two", [])]


def test_to_vtt_emits_supported_tags_and_escapes_text() -> None:
    assert to_vtt(parse("<i>a & b</i>")) == "<i>a &amp; b</i>"
    assert to_vtt(parse("plain <b>bold</b>")) == "plain <b>bold</b>"


def test_to_vtt_escapes_angle_brackets_in_dialogue() -> None:
    assert to_vtt(parse("1 < 2")) == "1 &lt; 2"


def test_to_vtt_degrades_unsupported_styles_to_plain() -> None:
    # WebVTT has no strikethrough tag; the text must survive regardless.
    assert to_vtt(parse("<s>gone</s>")) == "gone"


def test_newlines_are_preserved() -> None:
    assert strip("<i>line one\nline two</i>") == "line one\nline two"


def test_empty_and_markup_only_input() -> None:
    assert parse("").runs == []
    assert parse("<i></i>").runs == []
    assert strip(r"{\an8}") == ""


def test_as_dict_omits_empty_fields() -> None:
    assert Run("a").as_dict() == {"text": "a"}
    assert Run("a", frozenset({ITALIC})).as_dict() == {"text": "a", "styles": ["i"]}
