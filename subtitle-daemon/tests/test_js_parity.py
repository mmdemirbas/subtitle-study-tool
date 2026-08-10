"""The extension's copy of the pipeline must agree with this one.

The extension can now run the whole search-decode-annotate path itself when the
daemon is not running, which means the pipeline exists in two languages. The
data tables are generated from here, so they cannot drift; the *logic* is
written twice and this is what stops the two copies from diverging.

Divergence would be quiet. Both sides would keep producing subtitles - the
extension's would just be annotated slightly differently, coloured slightly
differently, or decoded slightly differently, and only on the path the daemon's
own tests never touch. So the two are run over the same inputs and diffed
exactly: same symbol, same colour, same runs, same encoding, same score.

Real inputs, not invented ones: every annotation in the corpus and every SRT
file in the repository.
"""

from __future__ import annotations

import json
import shutil
import subprocess
import sys
from pathlib import Path

import pytest

from subtitle_daemon import annotations, matching, subtitles, titles

REPO = Path(__file__).resolve().parents[2]
EXTENSION = REPO / "browser-extension"
HARNESS = EXTENSION / "tests" / "parity.mjs"
CORPUS = Path(__file__).parent / "data" / "annotation-corpus.json"

# Title shapes that have each cost a round trip to discover. Kept here rather
# than in the JS so both sides are driven from one list.
TITLE_CASES = [
    "Prime Video: Crime 101",
    "Crime 101 - Prime Video",
    "Watch Mercy (2025) Online Free HD",
    "The.Matrix.1999.1080p.BluRay.x264-GROUP",
    "Battlestar Galactica S01E03 - Bastille Day",
    "Free Willy",
    "The Full Monty",
    "Prime Video",
    "(3) Netflix - Stranger Things 2x04",
    "Blade Runner 2049",
    "Mr. Robot",
    "Kurtlar Vadisi 1080p Türkçe Dublaj izle",
    "Season 2 Episode 10 of Something",
    # A listing line copied out of a streaming page, in the four shapes sites
    # render it. These were added after a change to the year and release-token
    # rules was made in Python only: every case above still agreed, so the two
    # copies diverged and this test stayed green.
    "The Americans (2013) 2013 · S02 E04",
    "The Americans 2013 S02E04",
    "The.Americans.2013.S02E04.1080p.BluRay.x264",
    "Blade Runner 2049 (2017)",
    "1917 (2019)",
    "Dallas 2012 S02E04",
    "Ayla 2017",
]

SCORE_CASES = [
    ("Crime 101", "Crime 101", 2025, 2025),
    ("Crime 101", "Crime 101", 2025, 2026),
    ("Crime 101", "Crime 101", 2025, 2020),
    ("Crime 101", "Major Crimes: 101 Ways", None, None),
    ("Mercy", "Mercy", 2025, 2026),
    ("Mercy", "Mercy Street", 2025, None),
    ("The Matrix", "Matrix", None, None),
    ("Ekusute", "Crime 101", None, None),
    ("Şeytan", "Seytan", None, None),
    ("Battlestar Galactica", "Battlestar Galactica: The Miniseries", 2003, 2003),
    ("", "Anything", None, None),
]


# Every markup dialect, plus the shapes that have broken the parser before.
# Real subtitle files in this repo are plain UTF-8 dialogue - 4539 cues between
# them carry 41 styled runs and 5 annotations - so on their own they exercise
# the SRT reader and almost nothing else. These do the rest.
MARKUP_CASES = [
    "<i>Italic</i> and plain",
    "<I>Uppercase tag</I>",
    "<b>Bold</b> <u>under</u> <s>strike</s>",
    "<i>Nested <b>both</b> still italic</i>",
    "<i>Unclosed italic",
    "Stray </i> close",
    '<font color="#ff0000">Red</font> plain',
    "<font color='red'>Named</font>",
    "<font color=yellow>Bare</font>",
    '<font color="red; background: url(x)">Rejected</font>',
    "<font color=&HFF8000&>SubStation hex</font>",
    "[i]BBCode italic[/i]",
    "[color=lime]BBCode colour[/color]",
    "[b]Bold[/b] [Ormon] speaks",
    r"{\an8}Top of frame",
    r"{\an5}Middle",
    r"{\i1}SSA italic{\i0} off",
    r"{\pos(120,400)}Positioned",
    r"{\i1\an8}Both at once",
    "{y:i}Legacy italic",
    "[Ormon] Get down!",
    "[sighs] Fine.",
    "[indistinct chatter]",
    "SHARON: Get down!",
    "♪ La la la ♪",
    "♪♪♪",
    "[Ormon sighs] Not now.",
    "[man] Over here.",
    "[Bell] I told you.",
    "(clears throat) Excuse me.",
    "[phone dings] [door creaks]",
    "<i>[sighs]</i> Still italic",
    "[suspenseful music continuing]",
    "- Did you see that?\n- I saw nothing at all.",
    "[Ormon] Line one\nand line two.",
]


def _write_srt(path: Path, texts: list[str], encoding: str) -> Path:
    """One cue per text, written in a given encoding.

    The encoding is the point for half of these: the decoder scores candidates
    rather than taking the first that does not fail, and every real file in the
    repo is UTF-8, so without this the scorer is never run on either side.
    """
    blocks = []
    for index, text in enumerate(texts, start=1):
        start = index * 2000
        end = start + 1800
        blocks.append(
            f"{index}\n{_fmt(start)} --> {_fmt(end)}\n{text}\n"
        )
    path.write_bytes("\n".join(blocks).encode(encoding, errors="replace"))
    return path


def _fmt(ms: int) -> str:
    hours, rest = divmod(ms, 3_600_000)
    minutes, rest = divmod(rest, 60_000)
    seconds, millis = divmod(rest, 1000)
    return f"{hours:02d}:{minutes:02d}:{seconds:02d},{millis:03d}"


# Turkish text whose bytes decode differently under each candidate encoding.
# This is the case the decoder exists for, and the case the note-character bug
# came from: E2 99 AA read as cp1250 gives "â™Ş", whose Ş the scorer rewards.
_TURKISH = [
    "Çağrı şöyle dedi: gidiyorum.",
    "Işık yandı, ığdır'a vardık.",
    "♪ Şarkı söylüyor ♪",
    "[Öznur] Güzel bir gün.",
    "Üzgünüm, öyle olmadı.",
]


def _fixture_files(tmp: Path) -> list[Path]:
    files = [
        _write_srt(tmp / "markup-utf8.srt", MARKUP_CASES, "utf-8"),
        _write_srt(tmp / "turkish-utf8.srt", _TURKISH, "utf-8"),
        _write_srt(tmp / "turkish-cp1254.srt", _TURKISH, "cp1254"),
        _write_srt(tmp / "turkish-cp1250.srt", _TURKISH, "cp1250"),
        _write_srt(tmp / "latin1.srt", ["Café brûlée", "Naïve façade"], "latin-1"),
        # The note-character case, in UTF-8, which must not lose to cp1250.
        _write_srt(tmp / "notes-utf8.srt", ["♪♪♪"] * 20, "utf-8"),
    ]
    # A byte-order mark, which selects a different encoding name.
    bom = tmp / "bom.srt"
    bom.write_bytes(b"\xef\xbb\xbf" + (tmp / "markup-utf8.srt").read_bytes())
    files.append(bom)
    return files


def _srt_files() -> list[Path]:
    return sorted(REPO.glob("srt-viewer/subtitles/*.srt"))


@pytest.fixture(scope="module")
def js_results(tmp_path_factory: pytest.TempPathFactory) -> dict:
    if shutil.which("node") is None:
        pytest.skip("node is not installed; cannot check the extension's copy")
    if not CORPUS.exists():
        pytest.skip(f"no corpus at {CORPUS}")

    corpus = json.loads(CORPUS.read_text())["annotations"]
    tmp = tmp_path_factory.mktemp("parity")

    # Real files first - the regression against actual input - then the
    # fixtures covering what the real files here happen not to contain.
    payload = {
        "annotations": sorted(corpus),
        "subtitles": [str(path) for path in _srt_files() + _fixture_files(tmp)],
        "scores": [list(case) for case in SCORE_CASES],
        "titles": TITLE_CASES,
    }

    input_path = tmp / "input.json"
    input_path.write_text(json.dumps(payload), encoding="utf-8")

    result = subprocess.run(
        ["node", str(HARNESS), str(input_path)],
        capture_output=True,
        text=True,
        cwd=EXTENSION,
    )
    if result.returncode != 0:
        pytest.fail(f"parity harness failed:\n{result.stderr}")
    return json.loads(result.stdout)


def test_symbols_agree(js_results: dict) -> None:
    mismatches = [
        (row["text"], annotations.symbol_for(row["text"]), row["symbol"])
        for row in js_results["annotations"]
        if annotations.symbol_for(row["text"]) != row["symbol"]
    ]
    assert not mismatches, _report("symbol", mismatches)


def test_speaker_colours_agree(js_results: dict) -> None:
    mismatches = [
        (row["text"], annotations.speaker_color(row["text"]), row["color"])
        for row in js_results["annotations"]
        if annotations.speaker_color(row["text"]) != row["color"]
    ]
    assert not mismatches, _report("speaker colour", mismatches)


def test_classification_agrees(js_results: dict) -> None:
    mismatches = []
    for row in js_results["annotations"]:
        for key, followed in (("followed", True), ("alone", False)):
            mine = annotations.classify(row["text"], followed_by_speech=followed)
            if mine != row[key]:
                mismatches.append((f"{row['text']} ({key})", mine, row[key]))
    assert not mismatches, _report("classification", mismatches)


def test_scores_agree(js_results: dict) -> None:
    mismatches = []
    for row, case in zip(js_results["scores"], SCORE_CASES, strict=True):
        query, candidate, query_year, candidate_year = case
        mine = matching.score(
            query, candidate, query_year=query_year, candidate_year=candidate_year
        )
        if mine != row["value"]:
            mismatches.append((f"{query!r} vs {candidate!r}", mine, row["value"]))
    assert not mismatches, _report("score", mismatches)


def test_title_guesses_agree(js_results: dict) -> None:
    mismatches = []
    for row in js_results["titles"]:
        mine = titles.guess(row["raw"])
        theirs = (row["query"], row["year"], row["season"], row["episode"])
        if (mine.query, mine.year, mine.season, mine.episode) != theirs:
            mismatches.append((row["raw"], (mine.query, mine.year, mine.season,
                                            mine.episode), theirs))
    assert not mismatches, _report("title guess", mismatches)


def test_the_comparison_actually_covers_the_pipeline(js_results: dict) -> None:
    """Guard against the corpus quietly testing nothing.

    The first version of this file compared 4539 real cues and felt thorough.
    Those cues carried 41 styled runs, 5 annotations and one encoding between
    them, so it was checking the SRT reader and almost nothing else - the
    encoding scorer, which is where the worst bug in this pipeline lived, was
    never run at all. Coverage is asserted rather than assumed.
    """
    runs = 0
    annotated = 0
    symbols = 0
    encodings = set()
    for row in js_results["subtitles"]:
        encodings.add(row["encoding"])
        for cue in row["cues"]:
            for run in cue.get("runs", []):
                runs += 1
                if run.get("kind"):
                    annotated += 1
                if run.get("symbol"):
                    symbols += 1

    assert runs >= 60, f"only {runs} styled runs compared"
    assert annotated >= 25, f"only {annotated} annotation runs compared"
    assert symbols >= 10, f"only {symbols} symbols compared"
    assert len(encodings) >= 3, f"only these encodings exercised: {sorted(encodings)}"
    assert any(row["cues"] and row.get("encoding") != "utf-8" for row in js_results["subtitles"]), (
        "every file decoded as utf-8; the scoring path was never taken"
    )


def test_decoding_and_cues_agree(js_results: dict) -> None:
    """The whole path over real files: bytes in, rendered cues out.

    This is the one that matters most. It covers the encoding scoring, the SRT
    parser, the markup parser and the annotator together, on files that are not
    UTF-8 and do carry speaker labels.
    """
    assert js_results["subtitles"], "no SRT files found to compare"

    for row in js_results["subtitles"]:
        raw = Path(row["path"]).read_bytes()
        text, encoding = subtitles.decode(raw)
        cues = subtitles.parse_srt(text)
        mine = subtitles.to_json(cues)
        name = Path(row["path"]).name

        assert encoding == row["encoding"], f"{name}: encoding {encoding} vs {row['encoding']}"
        assert len(mine) == row["cue_count"], (
            f"{name}: {len(mine)} cues vs {row['cue_count']}"
        )

        for index, (left, right) in enumerate(zip(mine, row["cues"], strict=True)):
            assert left == right, (
                f"{name} cue {index} differs:\n"
                f"  daemon:    {json.dumps(left, ensure_ascii=False)}\n"
                f"  extension: {json.dumps(right, ensure_ascii=False)}"
            )


def _report(what: str, mismatches: list) -> str:
    lines = [f"{len(mismatches)} {what} mismatch(es) between daemon and extension:"]
    for subject, mine, theirs in mismatches[:20]:
        lines.append(f"  {subject!r}: daemon={mine!r} extension={theirs!r}")
    if len(mismatches) > 20:
        lines.append(f"  ... and {len(mismatches) - 20} more")
    return "\n".join(lines)
