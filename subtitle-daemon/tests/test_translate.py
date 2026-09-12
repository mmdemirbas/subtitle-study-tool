"""The checking, which is the part that earns its keep.

Every test here is a shape a real local model produced during the bake-off. The
translation itself is stubbed: what is under test is what happens to an answer
after it arrives, because a model that translates well and renumbers badly
writes a file that is worse than no file.
"""

from __future__ import annotations

import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))

from subtitle_daemon import translate  # noqa: E402
from subtitle_daemon.subtitles import Cue  # noqa: E402


def cue(text: str, start: int = 0) -> Cue:
    return Cue(start_ms=start, end_ms=start + 1000, text=text)


CUES = [
    cue("So,", 1000),
    cue("you'll call me later, right?", 2000),
    cue("- Secretary Roslin.\n- Yes.", 3000),
    cue("My name's Aaron Doral.", 4000),
]


class Model:
    """Answers whatever the test told it to, and records what it was asked."""

    def __init__(self, *answers: object) -> None:
        self.answers = list(answers)
        self.prompts: list[str] = []

    def __call__(self, **kwargs: object) -> object:
        self.prompts.append(str(kwargs["user"]))
        return self.answers.pop(0) if self.answers else None


@pytest.fixture
def model(monkeypatch: pytest.MonkeyPatch):
    def install(*answers: object) -> Model:
        stub = Model(*answers)
        monkeypatch.setattr(translate.chat, "ask_json", stub)
        return stub

    return install


def rows(*pairs: tuple[int, str]) -> dict:
    return {"lines": [{"n": n, "tr": text} for n, text in pairs]}


def test_a_clean_answer_is_taken_as_it_is(model) -> None:
    model(rows((1, "Yani,"), (2, "sonra beni ararsın, değil mi?")))
    got = translate.Translator().chunk_lines(CUES, 0, 2)
    assert got.lines == {1: "Yani,", 2: "sonra beni ararsın, değil mi?"}
    assert got.missing == [] and got.repaired == [] and got.unrepaired == []


def test_a_cue_that_lost_a_speaker_is_asked_for_again_on_its_own(model) -> None:
    """Both fast local models dropped "- Yes." from cue 3 in a chunk, and both
    kept it when the cue was the only thing in the request."""
    stub = model(
        rows((3, "- Sekreter Roslin.")),
        rows((3, "- Sekreter Roslin.\n- Evet.")),
    )
    got = translate.Translator(carry=0).chunk_lines(CUES, 2, 3)
    assert got.repaired == [3]
    assert got.lines[3] == "- Sekreter Roslin.\n- Evet."
    assert len(stub.prompts) == 2, "the repair is a second request"
    assert "Secretary Roslin" in stub.prompts[1]
    assert "Aaron Doral" not in stub.prompts[1], "asked alone means alone"


def test_a_repair_that_fails_leaves_the_line_in_english(model) -> None:
    """A visibly untranslated line is an honest failure. Half a line of Turkish
    reads as the whole meaning and is a silent one."""
    model(rows((3, "- Sekreter Roslin.")), rows((3, "- Sekreter Roslin.")))
    got = translate.Translator(carry=0).chunk_lines(CUES, 2, 3)
    assert got.unrepaired == [3]
    assert got.lines[3] == "- Secretary Roslin.\n- Yes."


def test_a_single_speaker_cue_is_never_repaired(model) -> None:
    stub = model(rows((1, "Yani,")))
    got = translate.Translator().chunk_lines(CUES, 0, 1)
    assert got.repaired == [] and len(stub.prompts) == 1


def test_a_renumbered_chunk_is_split_rather_than_asked_again(model) -> None:
    """translategemma:4b returned seven numbers outside the range it was given.
    Asking the same chunk again gets the same answer, so it is halved."""
    stub = model(
        rows((1, "Yani,"), (2, "..."), (3, "..."), (99, "nobody asked")),
        rows((1, "Yani,"), (2, "sonra?")),
        rows((3, "- Sekreter Roslin.\n- Evet."), (4, "Ben Aaron Doral.")),
    )
    got = translate.Translator(carry=0).chunk_lines(CUES, 0, 4)
    assert sorted(got.lines) == [1, 2, 3, 4]
    assert 99 not in got.lines
    assert len(stub.prompts) == 3, "one bad chunk, then its two halves"


def test_a_single_cue_that_renumbers_is_not_split_forever(model) -> None:
    """The halving has to bottom out, or a model that always answers with the
    wrong number recurses until the stack gives out."""
    model(rows((77, "nobody asked")))
    got = translate.Translator(carry=0).chunk_lines(CUES, 0, 1)
    assert got.lines == {}
    assert got.missing == [1]


def test_a_model_that_does_not_answer_is_an_error_not_an_empty_translation(model) -> None:
    model(None)
    got = translate.Translator().chunk_lines(CUES, 0, 2)
    assert got.error
    assert got.lines == {}


def test_the_lines_around_a_chunk_are_sent_as_context_and_not_asked_about(model) -> None:
    stub = model(rows((3, "- Sekreter Roslin.\n- Evet."), (4, "Ben Aaron Doral.")))
    translate.Translator(carry=2).chunk_lines(CUES, 2, 4)
    prompt = stub.prompts[0]
    assert "for context only" in prompt
    assert "1: So," in prompt, "the carried lines are numbered as themselves"
    assert prompt.index("translate everything below") < prompt.index("3: - Secretary Roslin.")


def test_context_never_reaches_back_past_where_the_job_started(model) -> None:
    stub = model(rows((3, "- Sekreter Roslin.\n- Evet.")))
    translate.Translator(carry=4).chunk_lines(CUES, 2, 3, floor=2)
    assert "for context only" not in stub.prompts[0]


def test_timings_are_the_originals_and_a_missing_line_keeps_its_english() -> None:
    made = translate.to_cues(CUES, {1: "Yani,", 2: ""}, 0, 3)
    assert [c.start_ms for c in made] == [1000, 2000, 3000]
    assert [c.end_ms for c in made] == [2000, 3000, 4000]
    assert made[0].text == "Yani,"
    assert made[1].text == "you'll call me later, right?", "an empty answer is not an answer"
    assert made[2].text == "- Secretary Roslin.\n- Yes."


def test_speakers_counts_dash_led_lines_only() -> None:
    assert translate.speakers("- A.\n- B.") == 2
    assert translate.speakers("<i>- A.</i>\n<i>- B.</i>") == 2, "the extension sends the italics along"
    assert translate.speakers("A dash - inside a line.") == 0
    assert translate.speakers("  - indented still counts") == 1
    assert translate.speakers("plain line") == 0


def test_chunk_bounds_covers_the_range_exactly() -> None:
    assert translate.chunk_bounds(0, 10, 4) == [(0, 4), (4, 8), (8, 10)]
    assert translate.chunk_bounds(300, 340, 40) == [(300, 340)]


def test_a_chunk_the_model_could_not_answer_is_split_before_it_is_given_up_on(model) -> None:
    """Measured once in 40 cues on gemma3:4b: the body came back truncated
    mid-string. Greedy decoding means asking again is pointless; asking for less
    is not."""
    stub = model(
        None,
        rows((1, "Yani,"), (2, "sonra?")),
        rows((3, "- Sekreter Roslin.\n- Evet."), (4, "Ben Aaron Doral.")),
    )
    got = translate.Translator(carry=0).chunk_lines(CUES, 0, 4)
    assert sorted(got.lines) == [1, 2, 3, 4]
    assert got.missing == []
    assert len(stub.prompts) == 3


def test_a_range_that_cannot_be_answered_reports_every_cue_in_it_as_missing(model) -> None:
    """An Attempt with no lines and no missing reads as "all of them translated"
    while carrying none of them."""
    model(None, None, None)
    got = translate.Translator(carry=0).chunk_lines(CUES, 0, 2)
    assert got.missing == [1, 2], "not an empty list beside an empty result"
    assert got.error
