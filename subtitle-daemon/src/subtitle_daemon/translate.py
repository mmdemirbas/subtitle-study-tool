"""Translate a whole subtitle into a language nobody has uploaded it in.

The case this exists for: OpenSubtitles has thirteen languages for an episode
and Turkish is not one of them. No amount of searching produces a file that was
never made, and the tier the study rail falls back on translates each line with
nothing around it - reported after a season of watching as "the English subtitle
is good, but the Turkish translation is too poor and almost useless". A model
that can see the scene answers a different question.

What makes this different from `srt-translator/`, which also translates an .srt:

- **The scene is sent with the line.** Cues go up in chunks with the tail of the
  previous chunk carried in as read-only context, so a pronoun keeps its
  referent and a joke keeps its setup. That directory's CLI sends bare cue text
  and deduplicates identical lines across the whole file, which discards
  position by construction.
- **The answer is checked before it is believed.** See below. That is the whole
  reason this is not fifty lines.
- **It resumes.** Every chunk is written as it lands, so a browser tab closing,
  a daemon restart or a model falling over costs the chunk in flight and
  nothing else.

## Why the checking is the hard part

A subtitle cue is not a sentence. It is a numbered box with a start and an end,
and often two speakers in it:

    304
    - Secretary Roslin.
    - Yes.

Measured over 40 cues of the Battlestar miniseries, 25 of them have a line break
inside. Ask a small model for one translation per numbered line and it will
split that cue into two answers, renumber everything after it, and hand back
exactly the count you asked for - a file whose words are right and whose timings
belong to somebody else, which is worse than no file at all because it looks
like it worked. `docs/reports/translate-bakeoff-2026-09-10.md` has the numbers.

So two checks, and they are not the same check:

- **numbering** - the `n` values are exactly the ones asked for. A chunk that
  fails this is re-asked in halves, because the usual cause is a chunk the model
  could not hold, and re-asking it whole gets the same answer twice.
- **speakers** - a cue whose lines begin with a dash holds that many speakers,
  and the answer has to hold as many. A cue that fails this is re-asked ALONE,
  where there is no neighbour to merge it with. Both fast local models dropped
  "- Yes." from the cue above; asked for that cue by itself, they do not.

A cue that still fails after its repair keeps its original text rather than a
guess. A line of English in a Turkish subtitle is visibly untranslated, which is
an honest failure; a line of the wrong Turkish is not.
"""

from __future__ import annotations

import json
import logging
import re
import threading
from dataclasses import dataclass, field
from typing import Any

from . import chat
from .subtitles import Cue

logger = logging.getLogger(__name__)

# How many cues go up in one request.
#
# Smaller than the 120 `tools/pretranslate.py` uses, and for the opposite
# reason: that tool pays a fixed ~14,600-token system prompt per call, so its
# cost is per REQUEST. Here the cost is per line and a failure loses the chunk,
# so the number is chosen to lose little - measured at 40, gemma3:4b kept the
# numbering over the whole slice.
CHUNK = 40

# Lines of the previous chunk shown as context and not translated. A scene does
# not start at a chunk boundary.
CARRY = 4

# A local model reads about half a second a line; a chunk of 40 is around twenty
# seconds, and a cold model load is most of a minute on top.
TIMEOUT_SECONDS = 300.0

# Measured on this machine as the one that keeps the numbering at a speed that
# finishes an episode in about nine minutes. Named rather than left empty
# because the whole point of the local tier is that it works without being
# configured; a hosted endpoint is the same three settings pointed elsewhere.
DEFAULT_MODEL = "gemma3:4b"

BRIEF = """\
You are translating a film's subtitles for someone watching it to learn {source}.

TRANSLATE every numbered line into {target}. Rules:
- One answer per numbered line, with the SAME number. Never merge two numbered
  lines into one answer, and never split one line into two answers.
- A numbered line may itself contain a line break, and often does when two
  people speak. Keep those breaks, and keep every speaker: a line reading
  "- A.\\n- B." must come back with both halves.
- Translate what the line MEANS in this scene, not word by word. You can see the
  lines around it; use them. A pronoun keeps its referent, a joke keeps its
  setup, an order sounds like an order.
- Keep proper nouns as they are. Keep [bracketed sound cues] bracketed and
  translate the words inside them.
- Keep any <i> and <b> tags, around the same words: "<i>Is anyone there?</i>"
  comes back as "<i>Burada biri var mı?</i>", not without the tags.
- Keep the register: swearing stays swearing, military terms stay military.

Answer with a JSON object only: {{"lines": [{{"n": 1, "tr": "..."}}]}}\
"""


_TAG = re.compile(r"<[^>]+>")


def speakers(text: str) -> int:
    """How many dash-led lines a cue has, which is how many people speak in it.

    Tags come off first: the extension now sends a cue's italics along, and
    `<i>- Yes.</i>` is a speaker as much as `- Yes.` is. Read raw, an italic
    exchange counted no speakers on either side and the one check that
    catches a dropped speaker never ran on it."""
    return sum(1 for line in text.split("\n") if _TAG.sub("", line).lstrip().startswith("-"))


def render(cues: list[Cue], first: int, last: int, carry_from: int) -> str:
    """The chunk as numbered text, with the tail of the previous chunk above it."""
    out: list[str] = []
    if carry_from < first:
        out.append("--- for context only, already translated, do not answer for these ---")
        out.extend(f"{i + 1}: {cues[i].text}" for i in range(carry_from, first))
        out.append("--- translate everything below ---")
    out.extend(f"{i + 1}: {cues[i].text}" for i in range(first, last))
    return "\n".join(out)


def _numbered(answer: object) -> dict[int, str]:
    """The `{n: text}` an answer carries, ignoring rows that are not that shape."""
    if not isinstance(answer, dict):
        return {}
    rows = answer.get("lines")
    if not isinstance(rows, list):
        return {}
    got: dict[int, str] = {}
    for row in rows:
        if not isinstance(row, dict):
            continue
        try:
            got[int(row["n"])] = str(row.get("tr") or "")
        except (KeyError, TypeError, ValueError):
            continue
    return got


class Cancelled(Exception):
    """The job was stopped while a request was in flight. Not a failure of the
    model and not an empty answer, so neither of those paths sees it."""


@dataclass(frozen=True)
class Attempt:
    """What one chunk produced, and what had to be done about it."""

    lines: dict[int, str] = field(default_factory=dict)
    # Cues the model never answered for, or answered for twice over. These keep
    # their English rather than being filled with a neighbour's translation.
    missing: list[int] = field(default_factory=list)
    repaired: list[int] = field(default_factory=list)
    unrepaired: list[int] = field(default_factory=list)
    error: str = ""


class Translator:
    """Asks a model for a scene at a time and refuses to believe it blindly."""

    def __init__(
        self,
        *,
        model: str = "",
        url: str = "",
        key: str = "",
        source: str = "English",
        target: str = "Turkish",
        chunk: int = CHUNK,
        carry: int = CARRY,
        timeout: float = TIMEOUT_SECONDS,
    ) -> None:
        self.model = model or DEFAULT_MODEL
        self.url = url or chat.DEFAULT_URL
        self.key = key
        self.source = source
        self.target = target
        self.chunk = max(1, chunk)
        self.carry = max(0, carry)
        self.timeout = timeout
        # Stopping. The event is read between requests; the open connection
        # is what abort() tears down for the request in flight, because a
        # thread blocked in a read cannot see an event. See chat.tear_down.
        self.cancel = threading.Event()
        self._open: Any = None

    @property
    def brief(self) -> str:
        return BRIEF.format(source=self.source, target=self.target)

    def abort(self) -> None:
        """Stop, now: the next request is never made, and the one in flight is
        torn down so its chunk does not finish first."""
        self.cancel.set()
        held, self._open = self._open, None
        if held is not None:
            chat.tear_down(held)

    def _ask(self, prompt: str, what: str) -> dict[int, str] | None:
        if self.cancel.is_set():
            raise Cancelled()

        def opened(connection: Any) -> None:
            self._open = connection
            # abort() may have run between the check above and the open.
            if self.cancel.is_set():
                chat.tear_down(connection)

        answer = chat.ask_json(
            url=self.url,
            model=self.model,
            key=self.key,
            system=self.brief,
            user=prompt,
            timeout=self.timeout,
            what=what,
            on_open=opened,
        )
        self._open = None
        if self.cancel.is_set():
            raise Cancelled()
        return None if answer is None else _numbered(answer)

    def chunk_lines(self, cues: list[Cue], first: int, last: int, floor: int = 0) -> Attempt:
        """Translate cues `first`..`last`, checked and repaired.

        `floor` is where the job started, so the carried context never reaches
        back past cues the caller did not ask about.
        """
        wanted = set(range(first + 1, last + 1))
        prompt = render(cues, first, last, max(floor, first - self.carry))
        got = self._ask(prompt, f"translation of cues {first + 1}-{last}")

        # Two ways a chunk can be unusable, and one remedy.
        #
        # It came back with numbers nobody asked for, which is a model that lost
        # its place; or it did not come back at all, which at temperature 0 is
        # usually a body too long to stay well-formed - measured once in 40 cues
        # on gemma3:4b, as JSON truncated mid-string. Re-asking either one whole
        # gets the same answer, because the decode is greedy. Halving is the
        # remedy for both, and is what makes this terminate.
        unusable = got is None or set(got) != wanted
        if unusable and last - first > 1:
            middle = first + (last - first) // 2
            left = self.chunk_lines(cues, first, middle, floor)
            right = self.chunk_lines(cues, middle, last, floor)
            return Attempt(
                lines={**left.lines, **right.lines},
                missing=left.missing + right.missing,
                repaired=left.repaired + right.repaired,
                unrepaired=left.unrepaired + right.unrepaired,
                error=left.error or right.error,
            )
        if got is None:
            # Every cue in the range, listed. Returning an Attempt with no lines
            # AND no missing said "all forty translated" while contributing
            # none of them, so the caller believed a file that was five cues of
            # English short - the exact silent failure the checking exists for.
            return Attempt(
                missing=sorted(wanted),
                error=f"{self.model} at {self.url} did not answer",
            )

        lines = {n: text for n, text in got.items() if n in wanted}

        # Then speakers. A cue with two people in it that came back with one is
        # re-asked ALONE - there is no neighbour beside it to be merged with,
        # and both fast local models get it right when asked that way.
        repaired: list[int] = []
        unrepaired: list[int] = []
        for number in sorted(lines):
            said = speakers(cues[number - 1].text)
            if said < 2 or speakers(lines[number]) >= said:
                continue
            alone = self._ask(
                render(cues, number - 1, number, max(floor, number - 1 - self.carry)),
                f"repair of cue {number}",
            )
            second = (alone or {}).get(number, "")
            if second and speakers(second) >= said:
                lines[number] = second
                repaired.append(number)
            else:
                # Left in English on purpose. A visibly untranslated line is an
                # honest failure; half a line of Turkish is a silent one.
                lines[number] = cues[number - 1].text
                unrepaired.append(number)

        return Attempt(
            lines=lines,
            missing=sorted(wanted - set(lines)),
            repaired=repaired,
            unrepaired=unrepaired,
        )


    def again(self, cues: list[Cue], number: int, floor: int = 0) -> str:
        """One cue asked for on its own, for a retry of what a chunk left in
        the source language. "" when the model has nothing better.

        Not the question that failed. The decode is greedy, so the prompt the
        chunk used gets the answer it got; this one carries twice the context
        above the cue, which is a different prompt, and a model that has been
        swapped since - the reason most retries are pressed - sees the cue for
        the first time either way. The answer is checked the way the repair
        pass checks: a cue with two speakers that comes back with one is still
        refused, and the line stays as it was.
        """
        got = self._ask(
            render(cues, number - 1, number, max(floor, number - 1 - 2 * self.carry)),
            f"retry of cue {number}",
        )
        said = ((got or {}).get(number) or "").strip()
        said_by = speakers(cues[number - 1].text)
        if not said or (said_by >= 2 and speakers(said) < said_by):
            return ""
        return said


def to_cues(cues: list[Cue], lines: dict[int, str], first: int, last: int) -> list[Cue]:
    """The translated cues, keeping every timing and falling back to the original.

    Timings are copied rather than recomputed: the whole value of translating an
    existing subtitle rather than transcribing the audio is that somebody has
    already done the timing, and it is already lined up with this release.
    """
    return [
        Cue(
            start_ms=cues[i].start_ms,
            end_ms=cues[i].end_ms,
            text=lines.get(i + 1) or cues[i].text,
        )
        for i in range(first, last)
    ]


def chunk_bounds(first: int, last: int, chunk: int) -> list[tuple[int, int]]:
    return [(start, min(start + chunk, last)) for start in range(first, last, chunk)]


def as_json(attempt: Attempt) -> str:
    return json.dumps(
        {
            "lines": [{"n": n, "tr": text} for n, text in sorted(attempt.lines.items())],
            "missing": attempt.missing,
            "repaired": attempt.repaired,
            "unrepaired": attempt.unrepaired,
        },
        ensure_ascii=False,
    )
