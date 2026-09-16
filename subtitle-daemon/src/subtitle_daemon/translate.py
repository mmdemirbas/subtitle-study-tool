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

import html
import http.client
import json
import logging
import re
import threading
import urllib.parse
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

# The local model when nothing names one and no Google key is configured.
# Named rather than left empty because the whole point of the local tier is
# that it works without being configured, and it is the one that fits any
# machine. It is not the best on this one: the quality bake-off of 2026-09-16
# (docs/reports/translate-quality-2026-09-16.md) graded it 3.1 of 5 on
# accuracy against 4.2 for qwen3.6:35b-a3b, which needs 22.6 GB to run, and
# 4.5 for Google Translate, which needs a key. The choice is the reader's,
# in config.local.json.
DEFAULT_MODEL = "gemma3:4b"

# The brief above, and what it replaced. The first brief was rules and one
# literal example of a two-speaker line, `"- A.\n- B."`; gemma3:4b appended
# "- A." and "- B." to its own answers on the reader's episode (lines 261-265
# of Not Suitable for Work S01E01), and the quality bake-off found the two
# briefs equal on accuracy within the grader's noise on every model, with
# this one halving the wall clock on the two larger ones because fewer chunks
# came back misnumbered and had to be halved and asked again: 0.85 against
# 1.58 seconds a line on qwen3.6:35b-a3b, 3.2 against 7.9 on qwen3:14b.

BRIEF = """\
You are subtitling a TV series into {target} for someone who is watching it to learn {source}. These are lines of dialogue, spoken aloud by characters, not written prose.

Translate every numbered line into {target} the way a professional {target} subtitler would:
- Everyday spoken {target}, the words people actually say to each other. Not formal, not written, not textbook language. Contractions, slang, filler and swearing stay at the same level in {target}.
- Short. A subtitle is read in two seconds; say it the way a {target} speaker would say it, not word by word from the {source}.
- The MEANING of the line in this scene. Idioms, sarcasm and jokes become the {target} idiom, sarcasm or joke with the same effect. A pronoun keeps its referent; an order sounds like an order; a question stays a question.
- Address: characters who are friends, family or colleagues on first-name terms speak informally to each other; strangers, bosses and officials formally, unless the scene shows otherwise.

Keep the file's shape exactly:
- One answer per numbered line, under the SAME number. Never merge two numbered lines into one answer, never split one line into two answers, never answer for a number you were not given.
- A numbered line may contain a line break, often because two people speak in it, each line starting with a dash. Keep the breaks, keep every speaker: two dash-led lines in, two dash-led lines out. Do not add dashes, letters or labels that are not in the line.
- Keep proper nouns as they are. Keep [bracketed sound cues] bracketed, translating the words inside. Keep <i> and <b> tags around the same words.

Examples of the register, {source} to {target}:
- "You've got to be kidding me." -> "Şaka yapıyorsun herhalde."
- "I'm not gonna lie, that was rough." -> "Yalan yok, zor oldu."
- "He totally bailed on us." -> "Bizi resmen ekti."
- "Knock it off." -> "Kes şunu."
- "Fair enough." -> "Peki, haklısın."
- "What's the catch?" -> "Bunun bir bityeniği ne?"
- "I can't even." -> "Dayanamıyorum."
- "Can you cover for me?" -> "Benim yerime bakar mısın?"

Answer with a JSON object only: {{"lines": [{{"n": 1, "{code}": "..."}}]}}\
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


def _numbered(answer: object, key: str) -> dict[int, str]:
    """The `{n: text}` an answer carries, ignoring rows that are not that shape.

    `key` is the field the brief asked the text to come back under - the
    target's code, so a Turkish answer reads `{"n": 1, "tr": "..."}` and a
    German one `{"n": 1, "de": "..."}`. It was the literal "tr" for every
    language, which made a request for German a request the parser could not
    read: the model answered under "de" as the brief's example would have led
    it to, had the example not said "tr"."""
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
            got[int(row["n"])] = str(row.get(key) or "")
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
        target_code: str = "tr",
        chunk: int = CHUNK,
        carry: int = CARRY,
        timeout: float = TIMEOUT_SECONDS,
    ) -> None:
        self.model = model or DEFAULT_MODEL
        self.url = url or chat.DEFAULT_URL
        self.key = key
        self.source = source
        self.target = target
        # The field the answer comes back under. Two or three letters, so the
        # model reads it as the language and not as a word; see _numbered.
        self.target_code = re.sub(r"[^a-z]", "", target_code.lower().split("-")[0])[:3] or "tr"
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
        return BRIEF.format(source=self.source, target=self.target, code=self.target_code)

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
        return None if answer is None else _numbered(answer, self.target_code)

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


# --- Google Translate, as a whole-file translator --------------------------------

GOOGLE_MODEL = "google-translate"
GOOGLE_URL = "https://translation.googleapis.com/language/translate/v2"
# Google's own limit on strings per request, from the v2 reference:
# https://cloud.google.com/translate/docs/reference/rest/v2/translate
GOOGLE_BATCH = 128
GOOGLE_TIMEOUT_SECONDS = 30.0
# Measured 2026-09-16: 60 cues in 1.3 seconds, one request. The estimate the
# offer makes before any job has run on it.
GOOGLE_SECONDS_PER_CUE = 0.03


class GoogleTranslator:
    """The same job through Google Translate v2, line by line.

    Not a model that can see the scene, and it does not have to be: the
    quality bake-off of 2026-09-16 graded it 4.5 of 5 on accuracy and 4.3 on
    naturalness over sixty lines of a workplace comedy, against 3.3 for the
    file the local default actually made and 4.2 for the best model on this
    machine - and it did sixty lines in 1.3 seconds. The first 500,000
    characters a month are free (a $10 credit; an episode is about 45,000),
    $20 a million after: https://cloud.google.com/translate/pricing.

    Every physical line of a cue goes up as its own string, so a two-speaker
    cue keeps its two dash-led lines by construction and nothing can drift:
    an answer is paired with its question by position in one request, never
    by a number the model was asked to copy. `format=html` keeps the <i> and
    <b> tags where they were; the answer is HTML-escaped and unescaped here.
    """

    def __init__(
        self, *, key: str, source: str = "en", target: str = "tr", url: str = GOOGLE_URL, timeout: float = GOOGLE_TIMEOUT_SECONDS
    ) -> None:
        self.model = GOOGLE_MODEL
        self.key = key
        self.url = url
        self.source = source.split("-")[0].lower()
        self.target = target.lower()
        self.timeout = timeout
        self.cancel = threading.Event()
        self._open: Any = None

    def abort(self) -> None:
        self.cancel.set()
        held, self._open = self._open, None
        if held is not None:
            chat.tear_down(held)

    def _translate(self, strings: list[str]) -> list[str] | None:
        """The strings translated, in order, or None if Google did not answer."""
        if self.cancel.is_set():
            raise Cancelled()
        fields = [("key", self.key), ("source", self.source), ("target", self.target), ("format", "html")]
        fields += [("q", text) for text in strings]
        body = urllib.parse.urlencode(fields).encode("utf-8")
        parsed = urllib.parse.urlsplit(self.url)
        make = http.client.HTTPSConnection if parsed.scheme == "https" else http.client.HTTPConnection
        connection = make(parsed.hostname or "", parsed.port, timeout=self.timeout)
        self._open = connection
        try:
            if self.cancel.is_set():
                raise Cancelled()
            connection.request(
                "POST", parsed.path, body=body,
                headers={"Content-Type": "application/x-www-form-urlencoded", "User-Agent": chat.USER_AGENT},
            )
            response = connection.getresponse()
            data = response.read()
            if response.status >= 400:
                logger.warning("google translate unavailable: HTTP %d %s", response.status, data[:200].decode("utf-8", "replace"))
                return None
            said = [html.unescape(str(row["translatedText"])) for row in json.loads(data.decode("utf-8"))["data"]["translations"]]
        except (http.client.HTTPException, TimeoutError, ValueError, OSError, KeyError, TypeError) as error:
            if self.cancel.is_set():
                raise Cancelled() from error
            logger.warning("google translate unavailable: %s", error)
            return None
        finally:
            self._open = None
            connection.close()
        if self.cancel.is_set():
            raise Cancelled()
        # A short array would pair each line with the next one's answer.
        if len(said) != len(strings):
            logger.warning("google translate answered %d of %d strings", len(said), len(strings))
            return None
        return said

    def chunk_lines(self, cues: list[Cue], first: int, last: int, floor: int = 0) -> Attempt:
        # Every physical line of every cue, flattened, and where each came from.
        strings: list[str] = []
        owners: list[int] = []
        for index in range(first, last):
            for line in cues[index].text.split("\n"):
                strings.append(line)
                owners.append(index + 1)
        answers: list[str] = []
        for start in range(0, len(strings), GOOGLE_BATCH):
            got = self._translate(strings[start : start + GOOGLE_BATCH])
            if got is None:
                return Attempt(missing=list(range(first + 1, last + 1)), error="Google Translate did not answer")
            answers.extend(got)
        lines: dict[int, list[str]] = {}
        for number, source_line, said in zip(owners, strings, answers):
            # The dash that marks a speaker is not a word, and Google now and
            # then translates it away or spaces it. Put back what the source had.
            stripped = _TAG.sub("", source_line).lstrip()
            if stripped.startswith("-") and not _TAG.sub("", said).lstrip().startswith("-"):
                said = f"-{said.lstrip()}"
            lines.setdefault(number, []).append(said)
        return Attempt(lines={number: "\n".join(parts) for number, parts in lines.items()})

    def again(self, cues: list[Cue], number: int, floor: int = 0) -> str:
        attempt = self.chunk_lines(cues, number - 1, number, floor)
        return (attempt.lines.get(number) or "").strip()


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


def line_text(row: dict[str, Any]) -> str:
    """The translated text a chunk-file row carries. Written under "text"
    now; the files of the first jobs, all Turkish, wrote it under "tr"."""
    return str(row.get("text", row.get("tr", "")) or "")


def as_json(attempt: Attempt) -> str:
    return json.dumps(
        {
            "lines": [{"n": n, "text": text} for n, text in sorted(attempt.lines.items())],
            "missing": attempt.missing,
            "repaired": attempt.repaired,
            "unrepaired": attempt.unrepaired,
        },
        ensure_ascii=False,
    )
