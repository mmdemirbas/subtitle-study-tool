"""Word lookups for the study overlay.

Two reasons this is here rather than in the extension, both practical rather
than architectural. A browser extension can only reach an origin the user has
granted, and the extension asks for exactly one today - this daemon - which is
worth keeping true for anyone who never turns study mode on. And the cache
belongs on disk: a word looked up while watching one film is the same word in
the next one, and a browser profile reset should not spend it again.

The extension can still do this itself when the daemon is not running, behind
an optional permission it asks for at that point. This is the preferred path,
not the only one.

No new dependency: urllib, like the rest of the daemon.

Two different resources, deliberately kept apart. A DICTIONARY says what a word
means in its own language, and only English has one worth asking. A TRANSLATION
says what it is in yours, works in both directions, and is the only one of the
two that has anything to say about a phrase. They have different providers,
different coverage and different limits, so they cache separately and either can
be missing without taking the other with it.

The translator is MyMemory, which needs no key: 5000 chars/day anonymously and
50000 with an email in the `de` parameter, per
https://mymemory.translated.net/doc/usagelimits.php. A word is under ten of
those characters, so the anonymous allowance is several hundred lookups a day
and the disk cache means a word is only ever spent once.
"""

from __future__ import annotations

import hashlib
import json
import logging
import re
import time
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path
from typing import Any, NamedTuple

from .config import USER_AGENT

logger = logging.getLogger(__name__)

DICTIONARY_URL = "https://api.dictionaryapi.dev/api/v2/entries/{lang}/{word}"

# The only language dictionaryapi.dev covers well enough to be worth asking.
# Others get a clean "nothing to offer" rather than a confusing empty entry.
SUPPORTED = ("en",)

TIMEOUT_SECONDS = 6

# A dictionary entry returns every sense of every part of speech, which is far
# more than fits beside a film that is still playing. One sense per part of
# speech, capped, is the shape of a paper dictionary's short entry - and the one
# that can be read in the two seconds a line is on screen.
MAX_DEFINITIONS = 3

TRANSLATE_URL = "https://api.mymemory.translated.net/get"

# MyMemory answers with a ranked list of candidates, and the top one is not
# reliably the best: asked for "get down" it put a human-contributed entry of
# quality 0 first and the sense the film meant third. So the list is scored
# rather than trusted, by how close the match is and how good the entry claims
# to be, which puts a quality-0 entry last where it belongs.
#
# It also answers a word it does not know by handing the word back unchanged,
# with a plausible match score. That is a failure wearing a success's clothes,
# and the only way to see it is to compare with what was asked.
TRANSLATE_TIMEOUT_SECONDS = 6

# A word's translation is a word, or a short phrase. The archive contains whole
# paragraphs of unrelated text filed under short keys - one answer to "get down"
# was a sentence about a phone shop - and length is what separates them.
MAX_EXTRA_WORDS = 3
MAX_TRANSLATION_CHARS = 80

# What a translation memory leaves in a segment, and what the reader saw.
#
# Reported with a screenshot: the word "laying" glossed as `Serme<x id="1"/>`.
# That is XLIFF inline markup - a translation memory stores segments with their
# placeholders in, and an answer scored on how well its SOURCE matched can carry
# a placeholder its source had. Nothing on the way to the chip took it out, so
# the reader read the tag.
#
# Taken out rather than the answer refused, because "Serme" is the right gloss
# for "laying" and refusing it leaves an empty chip, which is the other half of
# the same report. What cleans away to nothing is refused by the usable() tests
# below, which now see the cleaned string rather than the raw one.
#
# Entities first, because the archive escapes its own markup about as often as
# it does not: `&lt;x id="1"/&gt;` has to become a tag before a tag can be
# taken out. The named set is deliberately the five that matter plus a space -
# every one of them is written the same way in the extension's copy, and a
# larger set in one language than the other is a divergence nobody would see.
NAMED_ENTITIES = {"amp": "&", "lt": "<", "gt": ">", "quot": '"', "apos": "'", "nbsp": " "}
ENTITY = re.compile(r"&(#x[0-9a-fA-F]{1,6}|#\d{1,7}|[a-zA-Z]{2,8});")
PLACEHOLDER = re.compile(r"<[^<>]*>|\{\d+\}|%\d+\$?[sd]\b|%[sd]\b|\[\d+\]")

# The context-free tier, one step above the archive. Google answers a bare word
# with a bare word rather than with whatever segment of whatever corpus matched
# the string, which is the difference between "yedek" and "Adama Mickiewicza".
# It still does not know the line, so it sits below the gloss and above
# MyMemory, and it is skipped entirely when no key is configured.
GOOGLE_URL = "https://translation.googleapis.com/language/translate/v2"
GOOGLE_TIMEOUT_SECONDS = 6

# --- the gloss ------------------------------------------------------------------
#
# A word out of its sentence is a different question from the one the reader
# asked, and the archive answers the question it was given. Measured against the
# subtitles in this repo, English into Turkish: "spare" came back as "parca",
# which is the archive's memory of "spare part"; "chamber" as "daire", which is
# an estate agent's; "viper" as "Engerek", the snake, for a ship. None of those
# is a bad match for the string. They are answers to "what does this word
# usually translate as", and nobody watching a film wants to know that.
#
# So the line travels with the word. The caller already has it - it is the
# subtitle on screen - and it is the only thing that can tell "spare a minute"
# from "spare part". This needs a model rather than an archive, which is why it
# is the first tier of three rather than the only one: with no key configured
# the archive still answers, and with no daemon at all the extension asks the
# archive itself.

# Any endpoint speaking the OpenAI chat-completions shape, which is one wire
# format and two very different deployments. The default is a model running on
# this machine: no key, no quota, nothing about what the reader is watching
# leaving the house, and a subtitle file is exactly the kind of thing worth not
# sending anywhere. A hosted endpoint is the same code with a URL and a key.
DEFAULT_GLOSS_URL = "http://127.0.0.1:11434/v1/chat/completions"

# A reasoning model narrates before it answers, and ollama passes that through
# in the message body when the template does not suppress it. Asking it not to
# think is the first line of defence; cutting the block out is the second,
# because the request that suppresses it is model-specific and this is not.
THINKING = re.compile(r"<think>.*?</think>", re.DOTALL)

# One request per twenty words. Small enough that a failure loses twenty answers
# rather than six hundred, and that the first batch lands while the film is
# still on its titles; large enough that a feature film's marked words are about
# thirty requests instead of six hundred.
GLOSS_BATCH = 20

# Two clocks, because the same request has two deadlines depending on who is
# waiting for it.
#
# The prefetch has the whole film: it is answering words that will be said in
# forty minutes, so a slow model is a slow model and not a failure. A word asked
# for while its line is on screen has about two seconds before the line goes,
# and a gloss that arrives after that is worth nothing however good it is - so
# that path gives up early and lets the tier below answer, and the prefetch will
# have the better answer ready the next time the word comes round.
GLOSS_BATCH_TIMEOUT_SECONDS = 180
GLOSS_LIVE_TIMEOUT_SECONDS = 4

# The first batch of a call, before anything is known about how fast this model
# is on this machine today. Small, because the first request also pays for
# loading the model, and because a probe that times out has cost the call its
# whole budget before it learned anything.
GLOSS_PROBE = 4

# How much of a batch's timeout an adaptively sized batch aims to use. A batch
# that only just fits is a batch that loses everything the next time the machine
# is a little busier than it was when the size was chosen.
GLOSS_BATCH_AIM = 0.6

# How long one prefetch call may spend on the model before the tier below takes
# the rest of it.
#
# The prefetch is answering words that will be said in forty minutes, so a slow
# model is not a failure - but it is not free either. Measured on this machine
# at 34 seconds a word, a chunk of forty words would hold the request for
# twenty-two minutes and answer none of the film's later chunks any sooner. Past
# this the remaining words are better served by a context-free answer that
# arrives than by a contextual one that does not.
GLOSS_CALL_BUDGET_SECONDS = 180

# How long a failing endpoint is left alone. Without this, every word looked up
# by hand pays the full live timeout before the archive gets its turn, and a
# reader who never configured a model would feel the whole feature stall.
GLOSS_REST_SECONDS = 60

GLOSS_SYSTEM = (
    "You gloss single words and phrases for someone watching a film with "
    "subtitles and learning the language they are in. Each item is one word or "
    "phrase and the subtitle line it was said in, and where the caller knows "
    'them the lines either side of it, as "before" and "after". Those two are '
    "there to be read and never to be glossed. Answer with what the item means "
    "IN THAT LINE, in the "
    "language with ISO 639-1 code '{target}', as a short learner's gloss: one to "
    "three words, in the dictionary form where the language has one, with no "
    "explanation, no punctuation and no quotation marks. If an item is a proper "
    "noun, answer with an empty string. Return strictly a JSON object with the "
    'key "g", whose value is an array of strings, one per input item, in the '
    "same order and of the same length. No other text."
)

# Which film these lines are from, said once for the whole request rather than
# per item, because it is true of all of them.
#
# It is only ever said when the PAGE said it - `describeFilm` in content.js
# refuses to guess - because a wrong film name is worse here than none. A model
# told the lines are from Battlestar Galactica reads "jump" and "viper" as the
# programme's own vocabulary; one told the wrong programme reads them as that
# one's, confidently.
GLOSS_FILM = " The lines are from {film}."


class Ask(NamedTuple):
    """One question, with everything that helps answer it.

    `term` and `line` are the question, and together they are the key the answer
    is filed under. `before` and `after` are the subtitle lines either side of
    it and the film is the programme they are from: both help, neither is part
    of the question, and `_translation_path` says why that distinction is the
    one the cache is built on.
    """

    term: str
    line: str
    before: str = ""
    after: str = ""


def clean_translation(text: Any) -> str:
    """A translation with the markup a translation memory leaves in it taken out.

    Written twice - here and in the extension's `study/lookup.js`, which answers
    when this daemon is not running - and diffed by `test_js_parity.py`, because
    the reader who saw `Serme<x id="1"/>` was on the extension's own path and a
    fix in one copy would have left the other showing tags.
    """

    def entity(match: re.Match[str]) -> str:
        name = match.group(1)
        if name.startswith("#x") or name.startswith("#X"):
            return chr(int(name[2:], 16))
        if name.startswith("#"):
            return chr(int(name[1:]))
        return NAMED_ENTITIES.get(name.lower(), match.group(0))

    answer = ENTITY.sub(entity, str(text or ""))
    answer = PLACEHOLDER.sub(" ", answer)
    return " ".join(answer.split())


def _short_gloss(text: Any, term: str) -> str:
    """A gloss, or "" for anything that is not one.

    The same cap the archive needed, for a different reason: a model asked for
    one to three words will occasionally explain itself instead, and a sentence
    does not fit on a chip under a subtitle.
    """
    answer = clean_translation(text).strip('"').strip()
    if not answer or len(answer) > MAX_TRANSLATION_CHARS:
        return ""
    if len(answer.split()) > len(term.split()) + MAX_EXTRA_WORDS:
        return ""
    # The word handed back unchanged, which is how a translator says it has no
    # answer - and putting "Paige" under "Paige" is worse than putting nothing
    # there, because a reader reads a chip as a meaning rather than as a
    # failure. tools/study-report.mjs already counts this shape as one of the
    # three ways a gloss is not one.
    #
    # It matters more now than it did. The model was told to answer a proper
    # noun with an empty string and did; Google was not and cannot be, and
    # measured over the 175 English subtitles in the cache 24.2% of everything
    # marked is a proper noun the name rule missed. Observed through the running
    # daemon the day the tier changed: "Paige" came back "Paige".
    if answer.casefold() == term.casefold():
        return ""
    return answer


class Lookups:
    """Dictionary entries, cached on disk. One JSON file per word."""

    def __init__(
        self,
        root: Path,
        gloss_model: str = "",
        gloss_url: str = "",
        gloss_key: str | None = None,
        google_key: str | None = None,
    ) -> None:
        self._dir = root / "lookups"
        self._dir.mkdir(parents=True, exist_ok=True)
        self._translations = root / "translations"
        self._translations.mkdir(parents=True, exist_ok=True)
        # The model is the switch. A URL with nothing to run on it answers
        # nothing, so naming the model is how the gloss tier is turned on.
        self._gloss_model = gloss_model or ""
        self._gloss_url = gloss_url or DEFAULT_GLOSS_URL
        self._gloss_key = gloss_key or None
        self._google_key = google_key or None
        # When to start asking again after a failure. See GLOSS_REST_SECONDS.
        self._gloss_rests_until = 0.0

    def get(
        self,
        query: str,
        language: str,
        target: str = "",
        sentence: str = "",
        film: str = "",
        before: str = "",
        after: str = "",
    ) -> dict[str, Any]:
        """A word's entry, from disk if it is there and from the web if not.

        Always returns a payload. A word with no entry is a normal answer, not
        an error: the caller shows the word and its rarity either way, and the
        definition was only ever enrichment.
        """
        term = query.strip().lower()
        lang = (language or "en").strip().lower()[:2]
        into = (target or "").strip().lower()[:2]
        if not term:
            return _empty(term, "nothing to look up")

        payload = self._definition(term, lang)
        if into and into != lang:
            translated = self.translate(term, lang, into, sentence, film, before, after)
            payload = {**payload, "translation": translated}
            # A word with no dictionary entry but a translation is a useful
            # answer, not an unavailable one - which is the normal case for
            # every language except English, and for every phrase.
            if payload["translation"] and not payload.get("definitions"):
                payload.pop("unavailable", None)
        return payload

    def _definition(self, term: str, lang: str) -> dict[str, Any]:
        cached = self._read(term, lang)
        if cached is not None:
            return {**cached, "source": f"{cached.get('source', 'cache')} (cached)"}

        if lang not in SUPPORTED:
            return _empty(term, f"No dictionary available for {lang}.")
        if " " in term:
            # A phrase has no entry in a word dictionary, so asking can only
            # 404. Saying so is more useful than a failed request.
            return _empty(term, "Phrases are not in the dictionary.")

        payload = self._fetch(term, lang)
        # Only a real answer is worth keeping. Caching a network failure would
        # make it permanent.
        if payload.get("definitions"):
            self._write(term, lang, payload)
        return payload

    def translate(
        self,
        query: str,
        language: str,
        target: str,
        sentence: str = "",
        film: str = "",
        before: str = "",
        after: str = "",
    ) -> str:
        """What this says in `target`, or "" when nothing trustworthy came back.

        Three tiers, best first, each one answering when the one above it
        cannot. A gloss that knows the line; the archive, which does not; and
        nothing, which is a normal answer and not an error - the definition and
        the rarity mark are what make a word worth showing, and the meaning was
        always enrichment.
        """
        term = query.strip()
        lang = (language or "").strip().lower()[:2]
        into = (target or "").strip().lower()[:2]
        line = (sentence or "").strip()
        if not term or not lang or not into or lang == into:
            return ""

        if line and self._gloss_model:
            held = self._read_translation(term.lower(), lang, into, line)
            if held is not None:
                return held
            if time.monotonic() >= self._gloss_rests_until:
                ask = Ask(term, line, (before or "").strip(), (after or "").strip())
                answered = self._gloss(
                    [ask], lang, into, GLOSS_LIVE_TIMEOUT_SECONDS, film=film
                )
                if answered and answered[0]:
                    return answered[0]
                # The rest is for a model that could not be reached, not for a
                # word it had nothing to say about. Standing down for a minute
                # over one proper noun took the good tier away from every word
                # the reader clicked next.
                if answered is None:
                    self._gloss_rests_until = time.monotonic() + GLOSS_REST_SECONDS

        cached = self._read_translation(term.lower(), lang, into)
        if cached is not None:
            return cached

        answer = self._fetch_google(term, lang, into) or self._fetch_translation(term, lang, into)
        if answer:
            self._write_translation(term.lower(), lang, into, answer)
        return answer

    def gloss_many(
        self,
        items: list[dict[str, Any]],
        language: str,
        target: str,
        film: str = "",
        tally: dict[str, int] | None = None,
    ) -> list[str]:
        """Gloss many words at once, each in the line it was said in.

        Why in bulk, and why before they are asked for: the extension holds the
        whole subtitle file before the film starts, so the words it is going to
        mark are known in advance. Asked one at a time as each line arrives, a
        lookup took 634ms on average and up to 1.4s against a line that is on
        screen for about two seconds, so the answer landed after the question
        had left. Asked ahead, every one of them is a disk read.

        Returns one answer per item, in order, "" where nothing came back.

        `tally` is filled in with how many answers came from where, if a caller
        passes a dict for it. Which tier answered used to be knowable only by
        watching the terminal the daemon was started in, and the one report that
        followed was "translation quality is still not improved" - which is a
        true statement about the chips on screen and says nothing about which of
        four things went wrong. The counts travel back with the answers now.
        """
        if tally is not None:
            for where in ("disk", "model", "google", "none"):
                tally.setdefault(where, 0)
        lang = (language or "").strip().lower()[:2]
        into = (target or "").strip().lower()[:2]
        # One ask per item including the ones that are not objects, which are
        # then answered with "". Skipping them shortened the list instead, so
        # every answer after the bad item was paired with the word before it -
        # and a wrong meaning under a word is not read as a failure, it is read
        # as the meaning. The docstring above promises one answer per item.
        asks = [
            Ask(
                str(item.get("term", "")).strip(),
                str(item.get("sentence", "")).strip(),
                str(item.get("before", "")).strip(),
                str(item.get("after", "")).strip(),
            )
            if isinstance(item, dict)
            else Ask("", "", "", "")
            for item in items
        ]
        answers = ["" for _ in asks]
        if not lang or not into or lang == into:
            return answers

        # One entry per distinct question. A word said twice in the same line is
        # asked once; a word said in two different lines is asked twice, which
        # is the whole reason the line travels with it.
        #
        # The neighbours ride along on whichever occurrence was seen first,
        # because they are not part of the question - the same (word, line) is
        # the same question wherever in the file it turned up, and it already
        # shares one answer through the cache.
        wanted: dict[tuple[str, str], list[int]] = {}
        context: dict[tuple[str, str], Ask] = {}
        for at, ask in enumerate(asks):
            if not ask.term:
                continue
            held = self._read_translation(ask.term.lower(), lang, into, ask.line)
            if held is None and not ask.line:
                held = self._read_translation(ask.term.lower(), lang, into)
            if held is not None:
                answers[at] = held
                if tally is not None:
                    tally["disk"] += 1
                continue
            wanted.setdefault((ask.term, ask.line), []).append(at)
            context.setdefault((ask.term, ask.line), ask)

        if not wanted:
            return answers

        asked = list(wanted)
        if self._gloss_model:
            asked = self._gloss_into(answers, asked, wanted, context, lang, into, film)
        if tally is not None:
            # What the model reached, which includes the words it deliberately
            # answered with "" - a proper noun refused is an answer from this
            # tier, not an absence. See _gloss_into.
            left = set(asked)
            for key, where in wanted.items():
                if key not in left:
                    tally["model"] += len(where)

        # Whatever the model did not answer, answered by the tier below rather
        # than left blank. See _fill_context_free.
        if asked:
            self._fill_context_free(answers, asked, wanted, lang, into)
        if tally is not None:
            for key in asked:
                for index in wanted[key]:
                    tally["google" if answers[index] else "none"] += 1
        return answers

    def _gloss_into(
        self,
        answers: list[str],
        asked: list[tuple[str, str]],
        wanted: dict[tuple[str, str], list[int]],
        context: dict[tuple[str, str], "Ask"],
        lang: str,
        into: str,
        film: str,
    ) -> list[tuple[str, str]]:
        """Ask the model for as many as it can manage. Returns the rest.

        The batch used to be a constant twenty, which is a claim about how fast
        the model is. Measured on this machine against the configured
        qwen3.6:35b-a3b: three words took 103 seconds, so twenty would want 690
        against a 180-second timeout - and a timeout loses the whole batch, so
        every request returned twenty blanks. The answers were good ones: the
        same three words came back "iç", "ön koltuk" and "sağlamacı", and "iç"
        is the sense of "domestic" in "foreign and domestic" that the tier below
        gets wrong as "yerel".

        So the size is measured rather than assumed. A small probe first,
        because the first request also pays for loading the model, and then each
        batch sized from what the last one actually cost. A whole call is
        bounded too: past that the film is better served by a fast answer for
        every remaining word than by a slow one for the next few.
        """
        budget = GLOSS_CALL_BUDGET_SECONDS
        size = GLOSS_PROBE
        at = 0
        while at < len(asked) and budget > 0:
            keys = asked[at : at + size]
            started = time.monotonic()
            answered = self._gloss(
                [context[key] for key in keys],
                lang,
                into,
                min(GLOSS_BATCH_TIMEOUT_SECONDS, budget),
                film=film,
            )
            took = time.monotonic() - started
            budget -= took
            if answered is None:
                # The model could not be asked - the clock, the port, the key.
                # `at` is deliberately not advanced: the batch that failed is
                # part of what the tier below has to answer, and advancing past
                # it was how those words kept their empty chips.
                logger.warning(
                    "gloss gave up after %.0fs for %s words; the rest go to the tier below",
                    took,
                    len(keys),
                )
                break
            for key, text in zip(keys, answered):
                if not text:
                    continue
                for index in wanted[key]:
                    answers[index] = text
            # Advanced whether or not anything came back, because a batch that
            # answered with nothing has still answered: the prompt asks for ""
            # on a name. Only an unreachable model stops the tier, above. This
            # used to break on an empty batch as well, so a run of names in one
            # batch cost the model tier the whole rest of the film.
            at += len(keys)
            # What the next batch may hold, from what this one cost. Aiming
            # short of the timeout rather than at it, because a batch that
            # only just fits is a batch that loses everything when the machine
            # is a little busier than it was.
            per = took / max(1, len(keys))
            room = (GLOSS_BATCH_TIMEOUT_SECONDS * GLOSS_BATCH_AIM) / per if per > 0 else GLOSS_BATCH
            size = max(1, min(GLOSS_BATCH, int(room)))
        return asked[at:]

    def _fill_context_free(
        self,
        answers: list[str],
        asked: list[tuple[str, str]],
        wanted: dict[tuple[str, str], list[int]],
        lang: str,
        into: str,
    ) -> None:
        """Google, for the words the model did not reach.

        The prefetch had no tier below it at all. `lookup` - the path a word
        takes when it is clicked - falls from the model to Google to the
        archive; this one returned "" instead, so a model that was down, busy or
        merely slow left every prefetched word with an empty chip. On a machine
        where the model cannot keep up that is the whole of "the translation
        quality is still not improved": the good answers exist and never arrive.

        Google and not the archive, deliberately. Google is keyed, fast - 0.25
        seconds a word measured here - and its quota is the reader's own; the
        archive is a free service, and a film's four hundred marked words
        arriving at it in one burst at attach is a way to be blocked. A reader
        with no key configured gets exactly what they got before, and their
        by-hand lookups still fall to the archive one word at a time.

        The answer is filed under the word alone, never under the word and its
        line. That distinction is what `_translation_path` is built on: a
        context-free answer is not an answer to the contextual question, and
        filing it there would mean the model is never asked again. Filed flat it
        serves every by-hand lookup of that word at once, and leaves the better
        answer still to be had.
        """
        if not self._google_key:
            return
        for key in asked:
            term = key[0]
            held = self._read_translation(term.lower(), lang, into)
            if held is None:
                held = self._fetch_google(term, lang, into)
                if held:
                    self._write_translation(term.lower(), lang, into, held)
            if not held:
                continue
            for index in wanted[key]:
                if not answers[index]:
                    answers[index] = held

    # --- disk ---------------------------------------------------------------

    def _path(self, term: str, language: str) -> Path:
        # quote() rather than a hash: the cache stays readable, and a word that
        # contains a slash or a dot cannot escape the directory.
        # The language too, and for the same reason. It arrives as a query
        # parameter, so "lang=../.." was a directory the answer got written to.
        safe = urllib.parse.quote(term, safe="")
        return self._dir / f"{urllib.parse.quote(language, safe='')}-{safe}.json"

    def _read(self, term: str, language: str) -> dict[str, Any] | None:
        path = self._path(term, language)
        if not path.exists():
            return None
        try:
            return json.loads(path.read_text(encoding="utf-8"))
        except (OSError, ValueError):
            # A truncated or hand-edited file is a cache miss, never a crash.
            return None

    def _translation_path(self, term: str, language: str, target: str, sentence: str = "") -> Path:
        """Where one answer lives.

        The line is part of the key, because the answer is. "spare" in "spare a
        minute" and "spare" in "the spare tyre" are two different words wearing
        one spelling, and a cache that cannot tell them apart hands the second
        reader the first one's answer. Hashed rather than quoted: a subtitle
        line is longer than a filename may be.

        A word with no line keeps the flat name it always had, so the archive's
        context-free answers and the model's contextual ones share a directory
        without ever being mistaken for each other.

        The film and the neighbouring lines are deliberately NOT in the key,
        though they are in the request. They help the model answer the question;
        they do not change what the question is. Putting them in would split the
        cache per position in the file, so a word said twice in one film would
        be asked twice and a line an episode repeats would never hit at all -
        and the answers being split apart are answers to the same question.
        """
        safe = urllib.parse.quote(term, safe="")
        # Both codes quoted as well: they come from the query string, and an
        # unquoted one carrying a slash names a path rather than a file. For
        # every real language code quote() is the identity, so nothing already
        # on disk changes name.
        pair = f"{urllib.parse.quote(language, safe='')}-{urllib.parse.quote(target, safe='')}"
        if sentence:
            mark = hashlib.sha1(sentence.encode("utf-8")).hexdigest()[:10]
            return self._translations / f"{pair}-{safe}-{mark}.json"
        return self._translations / f"{pair}-{safe}.json"

    def _read_translation(
        self, term: str, language: str, target: str, sentence: str = ""
    ) -> str | None:
        path = self._translation_path(term, language, target, sentence)
        if not path.exists():
            return None
        try:
            stored = json.loads(path.read_text(encoding="utf-8"))
        except (OSError, ValueError):
            return None
        text = stored.get("translation")
        return str(text) if isinstance(text, str) and text else None

    def _write_translation(
        self, term: str, language: str, target: str, text: str, sentence: str = ""
    ) -> None:
        try:
            self._translation_path(term, language, target, sentence).write_text(
                json.dumps(
                    {"query": term, "translation": text, "sentence": sentence},
                    ensure_ascii=False,
                ),
                encoding="utf-8",
            )
        except OSError as error:
            logger.debug("could not cache translation term=%s error=%s", term, error)

    def _write(self, term: str, language: str, payload: dict[str, Any]) -> None:
        try:
            self._path(term, language).write_text(
                json.dumps(payload, ensure_ascii=False), encoding="utf-8"
            )
        except OSError as error:
            logger.debug("could not cache lookup term=%s error=%s", term, error)

    # --- network ------------------------------------------------------------

    def _fetch(self, term: str, language: str) -> dict[str, Any]:
        url = DICTIONARY_URL.format(lang=language, word=urllib.parse.quote(term, safe=""))
        request = urllib.request.Request(url, headers={"User-Agent": USER_AGENT})
        try:
            with urllib.request.urlopen(request, timeout=TIMEOUT_SECONDS) as response:
                raw = json.loads(response.read().decode("utf-8"))
        except urllib.error.HTTPError as error:
            if error.code == 404:
                return _empty(term, "No dictionary entry for that word.")
            logger.debug("dictionary HTTP %s term=%s", error.code, term)
            return _empty(term, f"Dictionary returned HTTP {error.code}.")
        except (urllib.error.URLError, TimeoutError, ValueError, OSError) as error:
            logger.debug("dictionary unreachable term=%s error=%s", term, error)
            return _empty(term, "Could not reach the dictionary.")

        return {"query": term, **condense(raw), "source": "dictionaryapi.dev"}

    def _fetch_translation(self, term: str, language: str, target: str) -> str:
        query = urllib.parse.urlencode({"q": term, "langpair": f"{language}|{target}"})
        request = urllib.request.Request(
            f"{TRANSLATE_URL}?{query}", headers={"User-Agent": USER_AGENT}
        )
        try:
            with urllib.request.urlopen(request, timeout=TRANSLATE_TIMEOUT_SECONDS) as response:
                raw = json.loads(response.read().decode("utf-8"))
        except (urllib.error.URLError, TimeoutError, ValueError, OSError) as error:
            # Silent: the definition is still worth showing, and a learner does
            # not need to be told the translator was busy.
            logger.debug("translation unreachable term=%s error=%s", term, error)
            return ""
        return pick_translation(raw, term)

    def _fetch_google(self, term: str, language: str, target: str) -> str:
        """One word, no line. "" when no key is configured or anything fails."""
        if not self._google_key:
            return ""
        query = urllib.parse.urlencode(
            {
                "key": self._google_key,
                "q": term,
                "source": language,
                "target": target,
                "format": "text",
            }
        )
        request = urllib.request.Request(
            f"{GOOGLE_URL}?{query}", data=b"", headers={"User-Agent": USER_AGENT}
        )
        try:
            with urllib.request.urlopen(request, timeout=GOOGLE_TIMEOUT_SECONDS) as response:
                raw = json.loads(response.read().decode("utf-8"))
            answer = raw["data"]["translations"][0]["translatedText"]
        except (
            urllib.error.URLError,
            TimeoutError,
            ValueError,
            OSError,
            KeyError,
            IndexError,
        ) as error:
            logger.debug("google unavailable term=%s error=%s", term, error)
            return ""
        return _short_gloss(answer, term)

    def _gloss(
        self,
        asks: list[Ask],
        language: str,
        target: str,
        timeout: float,
        film: str = "",
    ) -> list[str] | None:
        """One gloss per ask, or None when the model could not be asked.

        None and a row of empty strings are two different things and the
        callers act on them differently: a model that answered nothing for
        these particular words has still been reached, and the tier is still
        good for the next batch. Returning "" for both made every refusal look
        like an outage - the batch loop stopped asking for the rest of the film
        and the single-word path stood down for a minute.
        """
        if not self._gloss_model or not asks:
            return None

        system = GLOSS_SYSTEM.format(target=target)
        if film:
            system += GLOSS_FILM.format(film=film)

        # Omitted rather than sent empty. A first or last line has no neighbour
        # on one side, and a key whose value is "" reads as a line that was
        # silent rather than one nobody looked up.
        asked = []
        for ask in asks:
            item: dict[str, str] = {"word": ask.term, "line": ask.line}
            if ask.before:
                item["before"] = ask.before
            if ask.after:
                item["after"] = ask.after
            asked.append(item)

        body = json.dumps(
            {
                "model": self._gloss_model,
                "messages": [
                    {"role": "system", "content": system},
                    {
                        "role": "user",
                        "content": json.dumps(asked, ensure_ascii=False),
                    },
                ],
                # Greedy, because a gloss is a lookup rather than a
                # composition, and because the answer is written to disk the
                # first time it is given - so whichever sample landed first is
                # the one the reader keeps for good.
                #
                # At 0.2, one word in one line of the Battlestar miniseries
                # came back as "temsil eden" in one request and "temsil etmek"
                # in another; "tamir" and "tamir etmek" for another; and
                # "itaatsiz" written "itaetsiz", which is a spelling nobody
                # would choose. To a learner reading one chip those are not
                # synonyms. What separates the sampling from the rest of the
                # request in those pairs is exactly what could not be told
                # apart while the decode was sampled, which is the point.
                #
                # It also makes `tools/gloss_context.py` able to measure
                # anything: greedy, two identical requests must agree, so a
                # difference between two runs is a difference in what was sent
                # rather than a difference in what was drawn.
                "temperature": 0,
                "response_format": {"type": "json_object"},
                # Honoured by the local runtimes and ignored by the hosted ones,
                # which is why THINKING exists as well.
                "chat_template_kwargs": {"enable_thinking": False},
            }
        ).encode("utf-8")
        headers = {"Content-Type": "application/json", "User-Agent": USER_AGENT}
        # A model on this machine wants no Authorization header, and sending an
        # empty one is how you get a 401 from something that has no accounts.
        if self._gloss_key:
            headers["Authorization"] = f"Bearer {self._gloss_key}"
        request = urllib.request.Request(self._gloss_url, data=body, headers=headers)

        try:
            with urllib.request.urlopen(request, timeout=timeout) as response:
                raw = json.loads(response.read().decode("utf-8"))
            said = THINKING.sub("", raw["choices"][0]["message"]["content"]).strip()
            answers = json.loads(said)["g"]
        except (
            urllib.error.URLError,
            TimeoutError,
            ValueError,
            OSError,
            KeyError,
            IndexError,
            TypeError,
        ) as error:
            # Loud here, silent to the reader: the archive is still there and
            # the definition is still worth showing. A misconfigured key is the
            # most likely cause and it has to be findable in the log, because
            # from the overlay it looks exactly like a word with no translation.
            logger.warning(
                "gloss unavailable for %s words from %s: %s", len(asks), self._gloss_url, error
            )
            return None

        # A short array would pair every gloss after the gap with the wrong
        # word, which is worse than no gloss at all - a wrong meaning under a
        # word is not read as a failure, it is read as the meaning.
        if not isinstance(answers, list) or len(answers) != len(asks):
            logger.warning(
                "gloss returned %s answers for %s words",
                len(answers) if isinstance(answers, list) else type(answers).__name__,
                len(asks),
            )
            return None

        # Written here rather than by the callers, so the single-word path and
        # the batch cannot disagree about what a cached gloss looks like.
        glossed = [_short_gloss(text, ask.term) for text, ask in zip(answers, asks)]
        for ask, text in zip(asks, glossed):
            if text:
                self._write_translation(ask.term.lower(), language, target, text, ask.line)
        return glossed


def pick_translation(raw: Any, term: str) -> str:
    """The best candidate MyMemory offered, or "" if none of them is one.

    Scored rather than taken in order, because the ranking it ships is not the
    one a learner wants - see TRANSLATE_URL above for the two ways the first
    answer is wrong.
    """
    if not isinstance(raw, dict):
        return ""

    source = term.strip().lower()
    allowed_words = len(source.split()) + MAX_EXTRA_WORDS

    def usable(candidate: str) -> bool:
        if not candidate or candidate.lower() == source:
            # Handing the word back unchanged is how this API says "no", and a
            # segment that was nothing but a placeholder cleans away to the same
            # empty string.
            return False
        return len(candidate) <= MAX_TRANSLATION_CHARS and len(candidate.split()) <= allowed_words

    best = ""
    best_score = 0.0
    for match in raw.get("matches") or []:
        if not isinstance(match, dict):
            continue
        # Cleaned BEFORE it is judged, so the length and word counts are of what
        # the reader would actually see rather than of the markup around it.
        text = clean_translation(match.get("translation"))
        if not usable(text):
            continue
        score = _number(match.get("match"), 0.0) * (_number(match.get("quality"), 0.0) / 100)
        if score > best_score:
            best, best_score = text, score

    if best:
        return best

    # No scored candidate survived: fall back to the API's own pick, which is
    # all there is when `matches` is absent.
    fallback = clean_translation((raw.get("responseData") or {}).get("translatedText"))
    return fallback if usable(fallback) else ""


def _number(value: Any, default: float) -> float:
    """`quality` arrives as 74, as "74", and sometimes not at all."""
    try:
        return float(value)
    except (TypeError, ValueError):
        return default


def condense(raw: Any) -> dict[str, Any]:
    """Keep the first sense of each part of speech, and the pronunciation."""
    definitions: list[dict[str, str]] = []
    seen: set[str] = set()
    phonetic = ""

    for entry in raw if isinstance(raw, list) else []:
        if not isinstance(entry, dict):
            continue
        if not phonetic:
            phonetic = entry.get("phonetic") or _first_phonetic(entry.get("phonetics"))
        for meaning in entry.get("meanings") or []:
            part = str(meaning.get("partOfSpeech") or "")
            if part in seen:
                continue
            senses = meaning.get("definitions") or []
            if not senses or not senses[0].get("definition"):
                continue
            seen.add(part)
            definitions.append(
                {
                    "partOfSpeech": part,
                    "sense": str(senses[0]["definition"]),
                    "example": str(senses[0].get("example") or ""),
                }
            )
            if len(definitions) >= MAX_DEFINITIONS:
                return {"definitions": definitions, "phonetic": phonetic, "translation": ""}

    return {"definitions": definitions, "phonetic": phonetic, "translation": ""}


def _first_phonetic(entries: Any) -> str:
    for item in entries or []:
        if isinstance(item, dict) and item.get("text"):
            return str(item["text"])
    return ""


def _empty(term: str, reason: str) -> dict[str, Any]:
    return {
        "query": term,
        "definitions": [],
        "phonetic": "",
        "translation": "",
        "unavailable": reason,
    }
