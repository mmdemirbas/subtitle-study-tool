"""The aligner has to say yes to the same film and no to a different one.

The extension can work out how far apart two subtitles are and shift one to
match the other. The arithmetic is in `browser-extension/src/align.js` and its
own harness covers the shapes: exact offsets, the framerate ratios, partial
tracks, bad input. What that harness cannot cover is the only question that
actually matters, which is where the line goes between "these are the same
film" and "these are not".

Synthetic cue lists are too easy. Two invented films score around zero, so any
threshold at all separates them and the test passes whatever the constant is.
Real subtitle files do not: the worst genuine pair in this repository scores
3.55 and the worst *wrong* pair scores 3.11, which is four hundredths of a
decade of margin. A gate tested only against invented data would sail past
that and start silently shifting subtitles by twenty seconds.

So this runs the real thing over the real corpus - every subtitle file in the
repository, every pair - and asserts the gap is still a gap.

The pairs are named below rather than derived, because "same film" is not
something the files say about themselves: two of the cached downloads carry no
metadata at all and are identified only by the release name in their sidecar.
"""

from __future__ import annotations

import json
import re
import shutil
import subprocess
from itertools import combinations
from pathlib import Path

import pytest

REPO = Path(__file__).resolve().parents[2]
ALIGN_JS = REPO / "browser-extension" / "src" / "align.js"
CACHE = REPO / "subtitle-daemon" / "cache" / "subtitles"
VIEWER = REPO / "srt-viewer" / "subtitles"

TIME = re.compile(r"(\d+):(\d+):(\d+)[,.](\d+)")

# Which files are the same film. Everything not listed together is a different
# one, which is what makes the negative half of this test exhaustive rather
# than a handful of examples.
SAME_FILM = [
    {"98043", "99413"},  # Leap Year, EN and TR, different releases
    # The Americans S01E01 - five files, three retimings, two languages
    {"8036186", "12574865", "3637194", "3635977", "3637542"},
    {"BSG.S00E01-EN", "BSG.S00E01-TR"},
    {"BSG.S00E02-EN", "BSG.S00E02-TR"},
]

# Same episode, but a cut that no single offset can fix.
#
# 3637194 is a differently-cut release: against 12574865 the divergence runs
# from about +1.3s at the start to +21s at the end, so no offset and no rate
# lines them up. Which files it does and does not align with is the evidence -
# it matches the two Turkish files (confidence 36 and 33), which were timed
# from the same cut, and refuses both English ones. Refusing is correct, so
# these are excluded from both halves rather than asserted on.
DIFFERENT_CUT = [{"3637194", "12574865"}, {"3637194", "8036186"}]


def _starts(path: Path) -> list[int]:
    out: list[int] = []
    for line in path.read_text("latin-1").splitlines():
        if "-->" not in line:
            continue
        found = TIME.search(line.split("-->")[0])
        if found:
            h, m, s, ms = (int(x) for x in found.groups())
            out.append(((h * 60 + m) * 60 + s) * 1000 + ms)
    return out


def _corpus() -> dict[str, list[int]]:
    files: dict[str, list[int]] = {}
    for path in sorted(CACHE.glob("*.srt")):
        files[path.stem] = _starts(path)
    for path in sorted(VIEWER.glob("*.srt")):
        episode = "S00E01" if "S00E01" in path.name else "S00E02"
        language = "EN" if "-EN" in path.name else "TR"
        files[f"BSG.{episode}-{language}"] = _starts(path)
    return {name: times for name, times in files.items() if len(times) >= 12}


def _run(pairs: list[tuple[str, list[int], list[int]]]) -> dict[str, dict]:
    """Drive align.js under node over every pair in one process."""
    # Over stdin, not argv: a hundred pairs of two thousand timestamps is
    # several megabytes, and argv tops out well before that.
    script = f"""
    await import({json.dumps(str(ALIGN_JS))});
    const align = globalThis.__ssoAlign;
    let raw = "";
    process.stdin.setEncoding("utf8");
    for await (const chunk of process.stdin) raw += chunk;
    const out = {{}};
    for (const [name, a, b] of JSON.parse(raw)) out[name] = align.align(a, b);
    console.log(JSON.stringify(out));
    """
    done = subprocess.run(
        ["node", "--input-type=module", "-e", script],
        input=json.dumps([[name, a, b] for name, a, b in pairs]),
        capture_output=True,
        text=True,
        check=True,
    )
    return json.loads(done.stdout)


def _relation(x: str, y: str) -> str:
    # Cuts first: a re-cut pair is also the same film, and the more specific
    # answer is the one that decides what to expect of it.
    for group in DIFFERENT_CUT:
        if x in group and y in group:
            return "cut"
    for group in SAME_FILM:
        if x in group and y in group:
            return "same"
    return "different"


@pytest.fixture(scope="module")
def verdicts() -> dict[str, dict]:
    if shutil.which("node") is None:
        pytest.skip("node is not installed")
    files = _corpus()
    if len(files) < 6:
        pytest.skip("not enough subtitle files in the repository to judge the gate")
    pairs = [
        (f"{x}|{y}", files[x], files[y]) for x, y in combinations(sorted(files), 2)
    ]
    return _run(pairs)


def test_same_film_is_recognised(verdicts: dict[str, dict]) -> None:
    missed = {
        name: answer["confidence"]
        for name, answer in verdicts.items()
        if _relation(*name.split("|")) == "same" and not answer["ok"]
    }
    assert not missed, f"the same film went unrecognised: {missed}"


def test_a_different_film_is_refused(verdicts: dict[str, dict]) -> None:
    """The half that matters.

    An aligner that always returns a number is worse than none: the number it
    gives for two unrelated films is confident and wrong, and a subtitle
    silently shifted by twenty seconds is harder to diagnose than one nobody
    touched.
    """
    wrong = {
        name: (answer["confidence"], answer.get("shiftMs"))
        for name, answer in verdicts.items()
        if _relation(*name.split("|")) == "different" and answer["ok"]
    }
    assert not wrong, f"a different film was accepted: {wrong}"


def test_the_gap_is_still_a_gap(verdicts: dict[str, dict]) -> None:
    """One assertion guarding every constant in the aligner at once.

    Bin width, tolerance, search range, the rate list, the Bonferroni
    correction - change any of them and this is what notices.
    """
    same, different = [], []
    for name, answer in verdicts.items():
        where = _relation(*name.split("|"))
        if where == "same":
            same.append(answer["confidence"])
        elif where == "different":
            different.append(answer["confidence"])

    assert same and different, "the corpus lost one side of the comparison"
    assert max(different) < min(same), (
        f"the two halves overlap: worst wrong pair {max(different)}, "
        f"worst right pair {min(same)}"
    )


def test_a_different_cut_is_declined(verdicts: dict[str, dict]) -> None:
    """Same episode, but re-cut - and no single offset can fix it.

    3637194 against 12574865 diverges from about +1.3s at the start to +21s at
    the end. There is no offset and no rate that lines these up, so the honest
    answer is to refuse.
    """
    for group in DIFFERENT_CUT:
        x, y = sorted(group)
        answer = verdicts.get(f"{x}|{y}")
        if answer is None:
            pytest.skip(f"{x} or {y} is not in the cache")
        assert not answer["ok"], (
            f"claimed a {answer['shiftMs']}ms answer for a different cut "
            f"(confidence {answer['confidence']})"
        )


# Gaps bigger than the old three-minute search window. A subtitle timed for a
# broadcast cut with a "previously on" recap the other file has never heard of
# lands out here, and so does one whose clock simply starts somewhere else.
WIDE_SHIFTS_MS = [181_000, 185_000, 240_000, 600_000, 1_200_000]


@pytest.fixture(scope="module")
def wide_verdicts() -> dict[str, dict]:
    """One known-good pair, moved further and further apart."""
    if shutil.which("node") is None:
        pytest.skip("node is not installed")
    files = _corpus()
    a = files.get("BSG.S00E01-EN")
    b = files.get("BSG.S00E01-TR")
    if not a or not b:
        pytest.skip("the English/Turkish pair is not in the repository")
    pairs = [(str(shift), a, [t + shift for t in b]) for shift in WIDE_SHIFTS_MS]
    # The same pair against a different episode, moved the same way: the wider
    # search must not start saying yes to those.
    other = files.get("BSG.S00E02-EN")
    if other:
        pairs += [(f"wrong-{shift}", a, [t + shift for t in other]) for shift in WIDE_SHIFTS_MS]
    return _run(pairs)


def test_a_gap_wider_than_the_search_window_is_still_found(wide_verdicts: dict[str, dict]) -> None:
    """Beyond the window the aligner was not less sure, it was not looking.

    Measured before the second pass was added: the same pair shifted 240s came
    back refused with confidence 0.53 and a nonsense shift, and the reader was
    told the two files were different films. Worse, at 185s - five seconds past
    the edge - it came back ACCEPTED, verdict "offer", with the shift 5.18
    seconds wrong, which is one click from being applied.
    """
    for shift in WIDE_SHIFTS_MS:
        answer = wide_verdicts[str(shift)]
        assert answer["ok"], f"a {shift}ms gap was refused: confidence {answer['confidence']}"
        error = abs(answer["shiftMs"] - shift)
        # A cue is cued to the tenth of a second; anything under a bin width is
        # the same answer.
        assert error <= 100, f"a {shift}ms gap was reported as {answer['shiftMs']}ms"


def test_the_wider_search_does_not_start_accepting_other_episodes(
    wide_verdicts: dict[str, dict],
) -> None:
    """The cost side of the second pass, asserted rather than assumed.

    Widening a search is not free: every extra second of range is another place
    an unrelated pair can find a coincidental peak. What pays for it is the
    hypothesis count in score(), which is proportional to the window - so a
    match found out there has to clear a higher bar. Measured, a different
    episode scores -0.29 through the wide pass against -0.26 through the narrow
    one: harder to accept, not easier.
    """
    accepted = {
        name: (answer["confidence"], answer.get("shiftMs"))
        for name, answer in wide_verdicts.items()
        if name.startswith("wrong-") and answer["ok"]
    }
    assert not accepted, f"a different episode was accepted by the wide search: {accepted}"
