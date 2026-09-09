"""Decoding subtitle bytes and converting SRT to WebVTT.

Two things here are less trivial than they look.

*Encoding.* Subtitle files on OpenSubtitles are frequently not UTF-8. Turkish
subtitles in particular are routinely cp1254 (Windows-1254), and decoding those
as latin-1 silently turns every s-cedilla, g-breve and dotless-i into mojibake
rather than raising. So the decoder scores candidate encodings instead of
taking the first one that does not throw.

*Format.* Browsers will not render an SRT in a `<track>`, and the overlay needs
cue objects anyway, so everything is normalised to parsed cues and WebVTT.
"""

from __future__ import annotations

import re
from dataclasses import dataclass

from . import markup

# Ordered by likelihood for the languages this tool is used with. utf-8 is tried
# first because when it succeeds it is almost never a false positive - arbitrary
# 8-bit text usually fails utf-8's continuation-byte rules.
_CANDIDATE_ENCODINGS = ("utf-8-sig", "utf-8", "cp1254", "cp1251", "cp1250", "latin-1")

# Signs a decode went wrong even though it did not raise: U+FFFD, and the C1
# control block, which is what cp1254 bytes turn into once latin-1 mangles them.
_MOJIBAKE = re.compile("[�-]")

# Letters that indicate a decode went right for the languages in play. Turkish
# c-cedilla, g-breve, dotless-i, dotted-I, o/u-diaeresis, s-cedilla, plus the
# circumflex vowels that show up in older orthography.
_EXPECTED_LETTERS = re.compile(
    "[çğıİöşü"
    "ÇĞÖŞÜ"
    "âîû]"
)

# Something to read: any letter in any script, or any digit.
#
# A cue whose whole content is punctuation is a mark the subtitler left to say
# something is happening that they are not writing down - and the overlay draws
# it as a box over the picture at the exact moment the picture is carrying the
# words instead of the file. Reported as a subtitle that is "only - or _ ...
# blocking the view unnecessarily".
#
# Measured over the 180 files in the download cache: 415 of 170,252 cues have
# nothing to read in them, spread over 16 files. 232 are a lone "_", 88 a run of
# asterisks, 73 are music marks with no lyrics, 8 a lone copyright sign, and the
# rest are stray dots and dashes. The Americans is the worked example: the show
# burns English subtitles into the picture for the Russian dialogue, and the
# English .srt writes "_" through those scenes so the reader can see the file
# has not given up. One episode spends 67 of its 626 cues that way.
#
# Letters and digits rather than a list of the marks actually seen, because the
# next file will use a different one and an allowlist has to be extended for
# every one of them. `[^\W_]` is `\w` without the underscore, which CPython
# defines as `str.isalnum()`; the JavaScript port writes the same test as
# `/[\p{L}\p{N}]/u`, and over all 1,114,112 code points the two disagree on
# none.
_READABLE = re.compile(r"[^\W_]")

_TIMECODE = re.compile(
    r"(?P<sh>\d{1,3}):(?P<sm>\d{2}):(?P<ss>\d{2})[,.](?P<sms>\d{1,3})"
    r"\s*-->\s*"
    r"(?P<eh>\d{1,3}):(?P<em>\d{2}):(?P<es>\d{2})[,.](?P<ems>\d{1,3})"
)

# UTF-8 BOM, as a character, for stripping after decode.
_BOM = "﻿"


@dataclass(frozen=True)
class Cue:
    """One subtitle entry. Times are milliseconds from the start of the film."""

    start_ms: int
    end_ms: int
    text: str


def decode(raw: bytes) -> tuple[str, str]:
    """Decode subtitle bytes, returning the text and the encoding chosen.

    Valid UTF-8 wins outright. Everything else is scored, because latin-1 never
    raises and would otherwise always win.

    The short-circuit is not an optimisation, it is the correctness fix. Scoring
    UTF-8 against the 8-bit encodings looks even-handed and is not: the bytes of
    a music note, E2 99 AA, read as cp1250 give "â™Ş", and the trailing Ş is a
    Turkish letter that the scoring rewards. So a UTF-8 file full of "♪♪♪"
    scored *higher* as cp1250 and every note became mojibake - 92 occurrences in
    an eight-subtitle corpus. Valid UTF-8 is decisive because arbitrary 8-bit
    text almost never satisfies its continuation-byte structure by accident.
    """
    for encoding in ("utf-8-sig", "utf-8"):
        try:
            return raw.decode(encoding), encoding
        except UnicodeDecodeError:
            pass

    best_text = ""
    best_encoding = "latin-1"
    best_score = float("-inf")

    for encoding in _CANDIDATE_ENCODINGS:
        try:
            text = raw.decode(encoding)
        except (UnicodeDecodeError, LookupError):
            continue

        # Penalise replacement chars and C1 controls heavily; reward letters
        # that belong in the target languages.
        score = -20 * len(_MOJIBAKE.findall(text)) + len(_EXPECTED_LETTERS.findall(text))

        if score > best_score:
            best_text, best_encoding, best_score = text, encoding, score

    return best_text, best_encoding


def parse_srt(text: str) -> list[Cue]:
    """Parse SRT text into cues, skipping malformed blocks rather than failing.

    Real-world SRT files carry stray blank lines, missing indices and occasional
    garbage blocks. One bad block should cost one cue, not the whole file.
    """
    text = text.replace("\r\n", "\n").replace("\r", "\n").lstrip(_BOM)
    cues: list[Cue] = []

    for block in re.split(r"\n{2,}", text):
        block = block.strip("\n")
        if not block:
            continue

        match = _TIMECODE.search(block)
        if not match:
            continue

        lines = block.split("\n")
        # Content is everything after the line holding the timecode. The index
        # line above it, when present, is discarded.
        timecode_line = next(i for i, line in enumerate(lines) if _TIMECODE.search(line))
        content = "\n".join(lines[timecode_line + 1 :]).strip()
        # Markup comes off first. The copyright cues are written
        # `<font color=orange>(c)`, so the letters in the tag would answer for
        # the text if this read the raw block. This also covers the empty block
        # the check here used to test for on its own.
        if not _READABLE.search(markup.parse(content).plain):
            continue

        start = _to_ms(match.group("sh"), match.group("sm"), match.group("ss"), match.group("sms"))
        end = _to_ms(match.group("eh"), match.group("em"), match.group("es"), match.group("ems"))
        if end < start:
            continue

        cues.append(Cue(start_ms=start, end_ms=end, text=content))

    cues.sort(key=lambda cue: cue.start_ms)
    return cues


def to_vtt(cues: list[Cue]) -> str:
    """Render cues as WebVTT, translating inline markup into VTT tags."""
    parts = ["WEBVTT", ""]
    for index, cue in enumerate(cues, start=1):
        parsed = markup.parse(cue.text)
        # \anN maps onto a cue setting; VTT positions from the top, so "top" is
        # a small percentage and the default bottom is left unstated.
        settings = ""
        if parsed.vertical == "top":
            settings = " line:10%"
        elif parsed.vertical == "middle":
            settings = " line:50%"

        parts.append(str(index))
        parts.append(f"{_fmt_vtt(cue.start_ms)} --> {_fmt_vtt(cue.end_ms)}{settings}")
        parts.append(markup.to_vtt(parsed))
        parts.append("")
    return "\n".join(parts)


def to_srt(cues: list[Cue]) -> str:
    """Render cues back as SRT, renumbered from one.

    The counterpart of parse_srt, and the format a subtitle is WRITTEN in - VTT
    is what a browser reads and JSON is what the overlay reads, so neither of
    them round-trips to a file anyone else can open. A subtitle this tool
    produced itself has to be storable as an ordinary .srt, or it is only ever
    usable from inside this tool.

    Indices are 1..N rather than whatever the input carried, because parse_srt
    does not keep the original numbering and a subtitle with gaps in its
    numbering is not one every player accepts.
    """
    blocks = []
    for index, cue in enumerate(cues, start=1):
        blocks.append(
            f"{index}\n{_fmt_srt(cue.start_ms)} --> {_fmt_srt(cue.end_ms)}\n{cue.text}\n"
        )
    return "\n".join(blocks)


_WORD = re.compile(r"[^\W_]+", re.UNICODE)


def measure(rendered: list[dict[str, object]]) -> dict[str, int]:
    """How much is actually said in a subtitle: lines, and words.

    Two uploads of one film are routinely not the same subtitle. One carries
    every line; another only the parts spoken in a foreign language; a third was
    cut down by whoever retimed it. A search result says how often a file was
    downloaded and nothing at all about what is in it, so these two numbers are
    what separate "the whole film" from "a quarter of it".

    Counted over the RENDERED text - what to_json produces - so positioning and
    styling tags are already gone, and the answer matches the JavaScript's to
    the word without either side having to strip markup of its own.
    """
    words = 0
    for cue in rendered:
        words += len(_WORD.findall(str(cue.get("text") or "")))
    return {"lines": len(rendered), "words": words}


def to_json(cues: list[Cue]) -> list[dict[str, object]]:
    """Render cues in the shape the extension overlay consumes.

    `text` is the dialogue with markup removed, so any consumer can use it
    directly. `runs` carries the same text split by formatting, for renderers
    that build elements rather than print a string. Cues with no formatting at
    all omit `runs` entirely - which is most of them.
    """
    payload: list[dict[str, object]] = []
    for cue in cues:
        parsed = markup.parse(cue.text)
        entry: dict[str, object] = {
            "start": cue.start_ms,
            "end": cue.end_ms,
            "text": parsed.plain,
        }
        # kind counts as much as styling: a cue that is only "[indistinct
        # chatter]" carries no formatting but still needs its run, or the
        # renderer cannot tell it apart from speech.
        if any(run.styles or run.color or run.kind for run in parsed.runs):
            entry["runs"] = [run.as_dict() for run in parsed.runs]
        if parsed.vertical:
            entry["vertical"] = parsed.vertical
        payload.append(entry)
    return payload


def _to_ms(hours: str, minutes: str, seconds: str, fraction: str) -> int:
    # SRT fractions are milliseconds, but files in the wild sometimes write one
    # or two digits. Pad rather than misread ",5" as 5 ms.
    millis = int(fraction.ljust(3, "0")[:3])
    return ((int(hours) * 60 + int(minutes)) * 60 + int(seconds)) * 1000 + millis


def _fmt_srt(ms: int) -> str:
    """SRT separates the milliseconds with a comma where VTT uses a stop."""
    return _fmt_vtt(ms).replace(".", ",")


def _fmt_vtt(ms: int) -> str:
    ms = max(0, ms)
    hours, rest = divmod(ms, 3_600_000)
    minutes, rest = divmod(rest, 60_000)
    seconds, millis = divmod(rest, 1000)
    return f"{hours:02d}:{minutes:02d}:{seconds:02d}.{millis:03d}"
