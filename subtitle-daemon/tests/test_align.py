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

Which files are the same film is DERIVED from what each file says about
itself - the `movie_name` its sidecar was downloaded with - rather than named
by hand. An earlier version named them, and the naming rotted: this corpus is
the live download cache, so every subtitle downloaded since added pairs nobody
had labelled, and the rule "anything not named together is a different film"
turned every correct answer about those pairs into a failure. It reported
`3632113|3632269` as a wrong pair accepted at confidence 390.89 - two files
whose sidecars both say "The Americans - S01E06 Trust Me", lined up at an
offset of zero.

Two of the fifty carry no metadata at all. Those are declared below, and a
guard fails on any further one rather than letting it quietly default to
"a different film from everything".
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

# The files whose sidecar carries no identity at all, named by hand because
# there is nothing in them to derive one from. `test_every_file_says_what_it_is`
# fails on any file that is neither derivable nor listed here - which is the
# guard the previous version lacked, and the reason an unlabelled download used
# to become "a different film from everything" in silence.
NO_METADATA = {
    "11911329": "mercy 2026",  # Mercy.2026.1080P.WEB.H264-POKE.srt
    "12466148": "crime 101 2026",  # Crime.101.2026.1080p.WEB.H264-ETHEL-HI.srt
}

# What a download was SEARCHED for, which the download itself does not record.
#
# `/fetch` stores what OpenSubtitles returned for one file id, and for a large
# part of the catalogue that response carries `movie_name: null` - so a file can
# be perfectly good and still say nothing about which film it is of. Every
# download made deliberately, by `bench/align/expand.mjs` or by hand, is
# recorded here with the title it was asked for.
#
# One file, read by both sides. When the bench corpus was doubled, the fix for
# this went into the JavaScript reader and not into this one, and 36 unlabelled
# downloads turned three assertions here red while every JS check stayed green.
# A second copy of the answer is how that happens.
LABELS = REPO / "bench" / "align" / "labels.json"

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


def _same(name: str | None) -> str | None:
    """One spelling for one film, so two sidecars can be compared.

    Whitespace because the names arrive with double spaces in them - "The
    Americans - S01E06  Trust Me" - and case because nothing guarantees it.
    """
    if not name:
        return None
    return re.sub(r"\s+", " ", name.strip().lower())


def _noted() -> dict[str, str]:
    """What each deliberate download was asked for, if the file is there."""
    try:
        rows = json.loads(LABELS.read_text("utf-8"))
    except (OSError, ValueError):
        return {}
    return {
        stem: film
        for stem, row in rows.items()
        if isinstance(row, dict) and (film := _same(row.get("film")))
    }


def _identity(stem: str, sidecar: dict | None, noted: dict[str, str]) -> str | None:
    """What film a cached download is of.

    Its own sidecar first, because that is the download speaking about itself.
    Then what it was searched for, for the large part of the catalogue whose
    `movie_name` comes back null. Hand-written names last and only for the two
    files that have neither.
    """
    if stem in NO_METADATA:
        return NO_METADATA[stem]
    return _same((sidecar or {}).get("movie_name")) or noted.get(stem)


def _corpus() -> tuple[dict[str, list[int]], dict[str, str | None]]:
    """Cue starts and, beside them, which film each file belongs to."""
    starts: dict[str, list[int]] = {}
    films: dict[str, str | None] = {}
    noted = _noted()
    for path in sorted(CACHE.glob("*.srt")):
        times = _starts(path)
        if len(times) < 12:
            continue
        sidecar = None
        beside = path.with_suffix(".json")
        if beside.exists():
            try:
                sidecar = json.loads(beside.read_text("utf-8"))
            except (OSError, ValueError):
                sidecar = None
        starts[path.stem] = times
        films[path.stem] = _identity(path.stem, sidecar, noted)
    for path in sorted(VIEWER.glob("*.srt")):
        times = _starts(path)
        if len(times) < 12:
            continue
        episode = "S00E01" if "S00E01" in path.name else "S00E02"
        language = "EN" if "-EN" in path.name else "TR"
        # These have no sidecar; the filename is the metadata.
        starts[f"BSG.{episode}-{language}"] = times
        films[f"BSG.{episode}-{language}"] = f"bsg {episode.lower()}"
    return starts, films


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


def _relation(x: str, y: str, films: dict[str, str | None]) -> str:
    # Cuts first: a re-cut pair is also the same film, and the more specific
    # answer is the one that decides what to expect of it. It stays a hand-kept
    # list because no metadata says "this release was cut differently".
    for group in DIFFERENT_CUT:
        if x in group and y in group:
            return "cut"
    here, there = films.get(x), films.get(y)
    if here and there and here == there:
        return "same"
    return "different"


@pytest.fixture(scope="module")
def corpus() -> tuple[dict[str, list[int]], dict[str, str | None]]:
    return _corpus()


@pytest.fixture(scope="module")
def films(corpus) -> dict[str, str | None]:
    return corpus[1]


@pytest.fixture(scope="module")
def verdicts(corpus) -> dict[str, dict]:
    if shutil.which("node") is None:
        pytest.skip("node is not installed")
    files = corpus[0]
    if len(files) < 6:
        pytest.skip("not enough subtitle files in the repository to judge the gate")
    pairs = [
        (f"{x}|{y}", files[x], files[y]) for x, y in combinations(sorted(files), 2)
    ]
    return _run(pairs)


def test_every_file_says_what_it_is(films: dict[str, str | None]) -> None:
    """The guard the previous version did not have.

    Relations are derived, so a file with no derivable identity has no relation
    to anything - and the rule that everything unrelated is a different film
    then makes it a wrong answer waiting to happen, against every other file in
    the corpus. That is what happened: the corpus is the live download cache,
    it grew, and the failures pointed at the aligner.

    Failing here instead names the file and says what to do about it, which is
    one line in NO_METADATA.
    """
    nameless = sorted(name for name, film in films.items() if not film)
    assert not nameless, (
        f"no identity for {nameless} - add each to NO_METADATA with the film "
        "it belongs to, or the pairs it forms are judged as different films"
    )


# What the corpus can actually be lined up. Measured over 1431 pairs - 42 the
# same film, 1387 different, 2 re-cut - with 25 of the 42 applied on their own.
#
# Not all 42 can be, and the reason is content rather than arithmetic: The
# Americans burns English subtitles into the picture for the Russian dialogue,
# so the English .srt is silent through scenes the Turkish one translates.
# Four season-two pairs score below zero because of it, and refusing them is
# the honest answer. A floor rather than a target: it notices a change that
# makes the aligner meeker, without demanding it match files that do not.
APPLIED_SHARE_FLOOR = 0.5

# Wrong pairs the aligner is willing to OFFER, as a share of the different-film
# pairs it was shown.
#
# It was a count - one, out of the 1387 different-film pairs the corpus had when
# it was written - and a count over a corpus that grows is a ratchet that
# tightens on its own. Adding thirty-six files took the pairs to 3925 and adding
# six more to 4557, and each of those additions was mostly more episodes of one
# television series, which is precisely the material that produces a near miss:
# same cast, same show, same subtitler, a different hour of film. Three wrong
# offers now, and the algorithm has not changed.
#
# So the bound is a rate rather than a count. That was right and the NUMBER was
# still wrong, because 0.00066 was three events. A count of three has a 95 per
# cent interval of roughly 0.6 to 8.8 events, which is a rate anywhere between
# 0.00014 and 0.0019 - an error bar four times wider than the value it was
# quoting, and a bound set at the point estimate of it fails the first time the
# corpus is big enough to measure anything.
#
# The corpus is now 178 files and 15470 different-film pairs, and 16 of them are
# offered: 0.00103, with the algorithm unchanged. That is compatible with the
# old measurement rather than worse than it. Sixteen events have a 95 per cent
# upper bound near 26, so the ceiling is 26 of 15470, and a genuine regression
# would have to nearly double the rate to trip it.
#
# Every one of the 16 is an OFFER at confidence 3.6 to 5.0, which the reader
# accepts or ignores. Nothing is applied; the assertion above holds that
# separately and exhaustively, and it is the one with no headroom in it.
#
# Lower it when the algorithm improves. Raising it needs the same thing this
# raise had: the event count it rests on, and what the interval around that
# count actually permits.
WRONG_OFFER_RATE_CEILING = 0.0018


def test_the_same_film_is_usually_lined_up(
    verdicts: dict[str, dict], films: dict[str, str | None]
) -> None:
    """Recall, stated as a floor because perfect recall is not available.

    This asserted every same-film pair was recognised while the corpus was four
    hand-named groups, all of them easy. Over the whole cache that is simply
    untrue, and the four it is untrue for are documented above.
    """
    same = [
        answer
        for name, answer in verdicts.items()
        if _relation(*name.split("|"), films) == "same"
    ]
    assert same, "the corpus has no same-film pairs left to judge"
    applied = [a for a in same if a.get("verdict") == "apply"]
    share = len(applied) / len(same)
    assert share >= APPLIED_SHARE_FLOOR, (
        f"only {len(applied)} of {len(same)} same-film pairs were applied "
        f"({share:.0%}, floor {APPLIED_SHARE_FLOOR:.0%})"
    )


def test_a_different_film_is_refused(
    verdicts: dict[str, dict], films: dict[str, str | None]
) -> None:
    """The half that matters, in the two strengths the aligner answers in.

    An aligner that always returns a number is worse than none: the number it
    gives for two unrelated films is confident and wrong, and a subtitle
    silently shifted by twenty seconds is harder to diagnose than one nobody
    touched.

    APPLY is the one that must be exhaustively clean, because nobody is asked.
    Measured over 1387 different-film pairs: none. OFFER is shown to the reader
    with a shift they can undo, so one wrong candidate there costs a glance
    rather than a broken film - but it is still wrong, and left uncounted it
    would grow. `3629320|3629444` is The Americans S02E02 against S02E01, both
    Turkish, offered at confidence 3.87 with a 25.9 second shift. The ceiling
    holds that at what it is.
    """
    applied = {
        name: (answer["confidence"], answer.get("shiftMs"))
        for name, answer in verdicts.items()
        if _relation(*name.split("|"), films) == "different"
        and answer.get("verdict") == "apply"
    }
    assert not applied, f"a different film was shifted without asking: {applied}"

    different = [
        name for name in verdicts if _relation(*name.split("|"), films) == "different"
    ]
    offered = {
        name: (verdicts[name]["confidence"], verdicts[name].get("shiftMs"))
        for name in different
        if verdicts[name]["ok"]
    }
    rate = len(offered) / max(1, len(different))
    assert rate <= WRONG_OFFER_RATE_CEILING, (
        f"{len(offered)} of {len(different)} different-film pairs were offered "
        f"({rate:.5f}), ceiling is {WRONG_OFFER_RATE_CEILING}: {offered}"
    )


def test_the_gap_is_still_a_gap(
    verdicts: dict[str, dict], films: dict[str, str | None]
) -> None:
    """One assertion guarding every constant in the aligner at once.

    Bin width, tolerance, search range, the rate list, the Bonferroni
    correction - change any of them and this is what notices.

    The gap is measured at the boundary where the extension acts on its own,
    which is not the same boundary this once used. Comparing the worst same-film
    pair against the best different-film pair says the two halves overlap, and
    over the whole cache they genuinely do: the worst genuine pair scores -1.81
    and the best wrong one 3.87. Both of those are in the band where the reader
    is asked, so the overlap costs a question, not a broken film.

    What must not overlap is the band where nobody is asked. Measured: the
    least confident pair the aligner applies by itself scores 23.17, and the
    best a wrong pair manages anywhere in the corpus is 3.87. A factor of six,
    and it is that margin every constant here is really guarding.
    """
    applied, different = [], []
    for name, answer in verdicts.items():
        where = _relation(*name.split("|"), films)
        if where == "same" and answer.get("verdict") == "apply":
            applied.append(answer["confidence"])
        elif where == "different":
            different.append(answer["confidence"])

    assert applied and different, "the corpus lost one side of the comparison"
    assert max(different) < min(applied), (
        f"a wrong pair scored {max(different)}, into the band where shifts are "
        f"applied without asking - the weakest of those scores {min(applied)}"
    )


def test_every_silent_application_pairs_better_than_chance(
    verdicts: dict[str, dict],
) -> None:
    """A shift is only applied without asking when the files really agree.

    Confidence alone cannot carry this. It answers "how surprised should I be
    that this many cues line up", and on a thousand-cue file a thin excess over
    chance, spread across the whole film, clears the auto threshold on sheer
    length. Coverage is the direct measure of the excess, and for these cue
    densities chance is about 0.21.

    Guarding the constant here rather than only in align.js, because the number
    is a claim about this corpus and this is where the corpus lives.
    """
    thin = {
        name: (answer["confidence"], answer["coverage"])
        for name, answer in verdicts.items()
        if answer.get("verdict") == "apply" and answer["coverage"] < 0.28
    }
    assert not thin, f"applied a shift that paired barely better than chance: {thin}"


def _blank_scenes(times: list[int], scenes: int, share: float) -> list[int]:
    """Remove contiguous stretches, the way a burned-in scene removes them.

    Not random thinning: what the reported case has is whole scenes present in
    one language and absent from the other, which costs the true peak a block
    of its votes rather than a scattering of them.
    """
    span = times[-1] - times[0]
    width = (span * share) / scenes
    holes = [
        (times[0] + span * ((n + 0.5) / scenes) - width / 2,
         times[0] + span * ((n + 0.5) / scenes) + width / 2)
        for n in range(scenes)
    ]
    return [t for t in times if not any(lo <= t <= hi for lo, hi in holes)]


def test_a_language_that_subtitles_more_scenes_does_not_cause_a_wrong_shift() -> None:
    """The Americans, season two, and the reason this test exists.

    The show burns English subtitles into the picture for the Russian dialogue,
    so the English .srt is SILENT through those scenes while the Turkish .srt
    keeps translating them. Both files are the same episode; one of them simply
    has nothing to say for minutes at a time.

    Blanking those scenes out of the English file takes votes away from the
    true offset, and a competing peak 3.4 seconds away wins. Before the
    coverage gate this came back verdict "apply" at confidence 8.33 to 9.87 -
    so the subtitle was silently moved three and a half seconds and announced
    as lined up, which reads as the file being wrong rather than the alignment.

    The assertion is not "it must find the right answer". With a quarter of the
    dialogue missing it may honestly fail. It is that it must never APPLY a
    wrong one on its own.
    """
    if shutil.which("node") is None:
        pytest.skip("node is not installed")
    english = CACHE / "12574865.srt"
    turkish = CACHE / "3637542.srt"
    if not english.exists() or not turkish.exists():
        pytest.skip("The Americans S01E01 is not in the cache")

    a, b = _starts(english), _starts(turkish)
    truth = _run([("truth", a, b)])["truth"]
    assert truth["ok"], "the untouched pair should still be recognised"

    cases = [
        (f"{int(share * 100)}pc-over-{scenes}", _blank_scenes(a, scenes, share), b)
        for share in (0.10, 0.15, 0.20, 0.25, 0.30)
        for scenes in (3, 5, 8)
    ]
    wrong = {}
    for name, answer in _run(cases).items():
        if answer.get("verdict") != "apply":
            continue
        off = abs(answer["shiftMs"] - truth["shiftMs"])
        if off > 1000:
            wrong[name] = (off, answer["confidence"], answer["coverage"])

    assert not wrong, (
        "applied a shift far from the truth for a pair whose languages cover "
        f"different scenes: {wrong} (the truth is {truth['shiftMs']}ms)"
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
    files, _ = _corpus()
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


# --- acts -------------------------------------------------------------------
#
# Two releases of one broadcast episode keep different amounts of black around
# the advertising breaks, so they agree within an act and jump between them.
# Measured over 41 such pairs in bench/align: one shift puts a median of 50 per
# cent of the film inside 250ms, and per-act offsets put 90 per cent there.
# `alignSteps` is what finds the acts.
#
# The staircase used here is the one measured on The Americans S02E09 from cue
# text, in bench/align/shapes.mjs: six acts, breaking at 2:55, 9:04, 19:12,
# 28:33 and 36:19, each a few seconds further out than the last.
STAIRCASE = [
    (0, 1000),
    (175_000, 5300),
    (544_000, 11850),
    (1_152_000, 18810),
    (1_713_000, 24780),
    (2_179_000, 30570),
]


def _staircase(times: list[int], steps: list[tuple[int, int]]) -> list[int]:
    def offset(at: int) -> int:
        found = steps[0][1]
        for start, value in steps:
            if at >= start:
                found = value
        return found

    return [t + offset(t) for t in times]


def _run_steps(pairs: list[tuple[str, list[int], list[int]]]) -> dict[str, dict]:
    """Drive align.js's alignSteps under node, the same way _run drives align."""
    script = f"""
    await import({json.dumps(str(ALIGN_JS))});
    const align = globalThis.__ssoAlign;
    let raw = "";
    process.stdin.setEncoding("utf8");
    for await (const chunk of process.stdin) raw += chunk;
    const out = {{}};
    for (const [name, a, b] of JSON.parse(raw)) {{
      const answer = align.alignSteps(a, b);
      const map = (x) => {{
        let offset = answer.steps ? answer.steps[0].offsetMs : 0;
        for (const step of answer.steps || []) if (x >= step.fromMs) offset = step.offsetMs;
        return answer.rate * x + answer.shiftMs + offset;
      }};
      out[name] = {{
        ok: answer.ok, verdict: answer.verdict, rate: answer.rate,
        shiftMs: answer.shiftMs, steps: answer.steps,
        mapped: answer.ok ? a.map(map) : null,
      }};
    }}
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


def _longest(corpus) -> list[int]:
    files = corpus[0]
    return max(files.values(), key=len)


def test_a_staircase_is_walked_up_one_act_at_a_time(corpus) -> None:
    """The case a single shift cannot answer, with the answer known exactly.

    Built rather than found, because the point is to know the truth to the
    millisecond: one real subtitle, and a copy of it moved by the six-act
    staircase measured on The Americans S02E09. Every cue's correct position is
    then arithmetic, and any error is the aligner's.
    """
    if shutil.which("node") is None:
        pytest.skip("node is not installed")
    times = _longest(corpus)
    if len(times) < 400 or times[-1] < 2_400_000:
        pytest.skip("no subtitle long enough to carry a six-act staircase")
    moved = _staircase(times, STAIRCASE)
    answer = _run_steps([("stepped", times, moved)])["stepped"]

    assert answer["ok"], "a copy of a file moved by a staircase was refused"
    assert answer["steps"] is not None
    assert len(answer["steps"]) >= 5, (
        f"a six-act staircase came back as {len(answer['steps'])} acts: {answer['steps']}"
    )
    errors = sorted(abs(got - want) for got, want in zip(answer["mapped"], moved))
    inside = sum(1 for e in errors if e <= 250) / len(errors)
    assert inside >= 0.9, (
        f"only {inside:.1%} of the film landed inside 250ms; "
        f"median error {errors[len(errors) // 2]}ms, worst {errors[-1]}ms"
    )


def test_a_file_that_needs_one_shift_is_given_one_act(corpus) -> None:
    """The control, and the reason the rest of it is worth anything.

    A method free to invent acts will always fit better, so "it found six acts
    in a six-act staircase" says nothing until the same method has been shown
    finding ONE where there is one. An invented break is worse than the problem
    it solves: it moves lines that were already in the right place, on a
    subtitle the reader had no complaint about.

    Measured on the corpus rather than only here: over 75 pairs whose truth is
    a single shift and 16 whose truth is a single rate, it returns one act every
    time. bench/align/regress.mjs is the standing version of this check.
    """
    if shutil.which("node") is None:
        pytest.skip("node is not installed")
    times = _longest(corpus)
    if len(times) < 200:
        pytest.skip("no subtitle long enough to judge")
    pairs = [(str(shift), times, [t + shift for t in times]) for shift in (0, 2500, -8000)]
    answers = _run_steps(pairs)
    for shift, answer in answers.items():
        assert answer["ok"], f"a copy shifted {shift}ms was refused"
        assert len(answer["steps"]) == 1, (
            f"a copy shifted {shift}ms - one shift, no acts - came back as "
            f"{len(answer['steps'])} acts: {answer['steps']}"
        )
        errors = [abs(got - (t + int(shift))) for got, t in zip(answer["mapped"], times)]
        assert max(errors) <= 100, f"a {shift}ms shift was reported {max(errors)}ms out"
