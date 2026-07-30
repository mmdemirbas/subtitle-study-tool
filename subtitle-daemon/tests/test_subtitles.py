"""Tests for subtitle decoding and SRT parsing.

The encoding tests matter most: a wrong-but-not-raising decode is the failure
mode that reaches the screen as mojibake instead of as an exception.
"""

from __future__ import annotations

from subtitle_daemon.subtitles import Cue, decode, parse_srt, to_json, to_vtt

TURKISH = "İyi günler şöyle böyle ğırtlak Çay"


def test_mojibake_pattern_flags_replacement_and_c1() -> None:
    from subtitle_daemon.subtitles import _MOJIBAKE

    assert _MOJIBAKE.search("�")
    assert _MOJIBAKE.search("")
    assert _MOJIBAKE.search("")
    assert not _MOJIBAKE.search("plain ascii")
    assert not _MOJIBAKE.search(TURKISH)


def test_expected_letters_pattern_covers_turkish_alphabet() -> None:
    from subtitle_daemon.subtitles import _EXPECTED_LETTERS

    for letter in "çğıİöşüÇĞÖŞÜ":
        assert _EXPECTED_LETTERS.search(letter), f"missing {letter!r}"


def test_decode_prefers_utf8_when_valid() -> None:
    text, encoding = decode(TURKISH.encode("utf-8"))
    assert text == TURKISH
    assert encoding in ("utf-8", "utf-8-sig")


def test_decode_strips_utf8_bom() -> None:
    text, encoding = decode(b"\xef\xbb\xbf" + TURKISH.encode("utf-8"))
    assert text == TURKISH
    assert encoding == "utf-8-sig"


def test_decode_recovers_cp1254_rather_than_falling_back_to_latin1() -> None:
    # This is the case the scoring exists for. latin-1 would decode these bytes
    # without raising, producing C1 controls where the Turkish letters belong.
    text, encoding = decode(TURKISH.encode("cp1254"))
    assert encoding == "cp1254"
    assert text == TURKISH


def test_decode_never_raises_on_arbitrary_bytes() -> None:
    text, encoding = decode(bytes(range(256)))
    assert isinstance(text, str)
    assert encoding


def test_parse_srt_basic() -> None:
    cues = parse_srt(
        "1\n"
        "00:00:01,000 --> 00:00:03,500\n"
        "First line\n"
        "second line\n"
        "\n"
        "2\n"
        "00:01:00,250 --> 00:01:02,000\n"
        "Later\n"
    )
    assert cues == [
        Cue(1000, 3500, "First line\nsecond line"),
        Cue(60250, 62000, "Later"),
    ]


def test_parse_srt_accepts_dot_fraction_and_crlf() -> None:
    cues = parse_srt("1\r\n00:00:02.500 --> 00:00:04.000\r\nHello\r\n")
    assert cues == [Cue(2500, 4000, "Hello")]


def test_parse_srt_pads_short_fractions() -> None:
    # ",5" means 500 ms, not 5 ms.
    cues = parse_srt("1\n00:00:00,5 --> 00:00:01,25\nx\n")
    assert cues == [Cue(500, 1250, "x")]


def test_parse_srt_skips_bad_blocks_without_losing_good_ones() -> None:
    cues = parse_srt(
        "garbage with no timecode\n"
        "\n"
        "2\n00:00:05,000 --> 00:00:06,000\nkept\n"
        "\n"
        "3\n00:00:09,000 --> 00:00:08,000\nend before start\n"
        "\n"
        "4\n00:00:10,000 --> 00:00:11,000\n\n"  # empty content
    )
    assert cues == [Cue(5000, 6000, "kept")]


def test_parse_srt_sorts_by_start_time() -> None:
    cues = parse_srt(
        "1\n00:00:10,000 --> 00:00:11,000\nlate\n"
        "\n"
        "2\n00:00:01,000 --> 00:00:02,000\nearly\n"
    )
    assert [cue.text for cue in cues] == ["early", "late"]


def test_parse_srt_handles_hours_over_nine() -> None:
    cues = parse_srt("1\n01:02:03,004 --> 01:02:04,000\nx\n")
    assert cues[0].start_ms == ((1 * 60 + 2) * 60 + 3) * 1000 + 4


def test_to_vtt_shape() -> None:
    vtt = to_vtt([Cue(1000, 3500, "Hello\nthere")])
    assert vtt.startswith("WEBVTT\n\n")
    assert "00:00:01.000 --> 00:00:03.500" in vtt
    assert "Hello\nthere" in vtt


def test_to_json_shape() -> None:
    assert to_json([Cue(1000, 2000, "x")]) == [{"start": 1000, "end": 2000, "text": "x"}]


# --- markup reaching the wire -------------------------------------------------


def test_json_text_is_dialogue_without_markup() -> None:
    [entry] = to_json([Cue(0, 1, "<i>Hello</i>")])
    assert entry["text"] == "Hello"


def test_json_carries_runs_only_when_there_is_formatting() -> None:
    plain = to_json([Cue(0, 1, "Just talking")])[0]
    assert "runs" not in plain, "most cues have no formatting; do not pay for it"

    styled = to_json([Cue(0, 1, "Say <i>that</i> again")])[0]
    assert styled["runs"] == [
        {"text": "Say "},
        {"text": "that", "styles": ["i"]},
        {"text": " again"},
    ]


def test_json_carries_bbcode_formatting() -> None:
    [entry] = to_json([Cue(0, 1, "[i]Whispering[/i]")])
    assert entry["text"] == "Whispering"
    assert entry["runs"] == [{"text": "Whispering", "styles": ["i"]}]


def test_json_speaker_labels_survive_intact() -> None:
    [entry] = to_json([Cue(0, 1, "[Ormon] Get down!")])
    assert entry["text"] == "[Ormon] Get down!"
    # Split into runs so the renderer can colour the name, with every
    # character preserved.
    assert entry["runs"][0]["kind"] == "speaker"
    assert "".join(run["text"] for run in entry["runs"]) == "[Ormon] Get down!"


def test_json_carries_vertical_position() -> None:
    [entry] = to_json([Cue(0, 1, r"{\an8}Sign overhead")])
    assert entry["text"] == "Sign overhead"
    assert entry["vertical"] == "top"


def test_vtt_translates_markup_and_position() -> None:
    vtt = to_vtt([Cue(0, 1000, "<i>Hello</i>"), Cue(2000, 3000, r"{\an8}Above")])
    assert "<i>Hello</i>" in vtt
    assert "line:10%" in vtt
    assert "{\\an8}" not in vtt, "override codes must not reach the screen as text"


def test_vtt_escapes_dialogue_that_looks_like_markup() -> None:
    assert "1 &lt; 2" in to_vtt([Cue(0, 1, "1 < 2")])


def test_roundtrip_from_repo_fixture() -> None:
    # A real file from the repo, to catch anything synthetic cases miss.
    from pathlib import Path

    root = Path(__file__).resolve().parents[2]
    fixture = next((root / "srt-viewer" / "subtitles").glob("*EN.srt"), None)
    if fixture is None:
        return

    text, _ = decode(fixture.read_bytes())
    cues = parse_srt(text)
    assert len(cues) > 100
    assert all(cue.end_ms >= cue.start_ms for cue in cues)
    assert all(cue.text.strip() for cue in cues)
    assert to_vtt(cues).startswith("WEBVTT")
