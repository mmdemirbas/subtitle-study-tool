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
from typing import Any

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

# How long a failing endpoint is left alone. Without this, every word looked up
# by hand pays the full live timeout before the archive gets its turn, and a
# reader who never configured a model would feel the whole feature stall.
GLOSS_REST_SECONDS = 60

GLOSS_SYSTEM = (
    "You gloss single words for someone watching a film with subtitles and "
    "learning the language they are in. Each item is one word and the subtitle "
    "line it was said in. Answer with what that word means IN THAT LINE, in the "
    "language with ISO 639-1 code '{target}', as a short learner's gloss: one to "
    "three words, in the dictionary form where the language has one, with no "
    "explanation, no punctuation and no quotation marks. If an item is a proper "
    "noun, answer with an empty string. Return strictly a JSON object with the "
    'key "g", whose value is an array of strings, one per input item, in the '
    "same order and of the same length. No other text."
)


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
        self, query: str, language: str, target: str = "", sentence: str = ""
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
            payload = {**payload, "translation": self.translate(term, lang, into, sentence)}
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

    def translate(self, query: str, language: str, target: str, sentence: str = "") -> str:
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
                answer = self._gloss([(term, line)], lang, into, GLOSS_LIVE_TIMEOUT_SECONDS)[0]
                if answer:
                    return answer
                self._gloss_rests_until = time.monotonic() + GLOSS_REST_SECONDS

        cached = self._read_translation(term.lower(), lang, into)
        if cached is not None:
            return cached

        answer = self._fetch_google(term, lang, into) or self._fetch_translation(term, lang, into)
        if answer:
            self._write_translation(term.lower(), lang, into, answer)
        return answer

    def gloss_many(self, items: list[dict[str, Any]], language: str, target: str) -> list[str]:
        """Gloss many words at once, each in the line it was said in.

        Why in bulk, and why before they are asked for: the extension holds the
        whole subtitle file before the film starts, so the words it is going to
        mark are known in advance. Asked one at a time as each line arrives, a
        lookup took 634ms on average and up to 1.4s against a line that is on
        screen for about two seconds, so the answer landed after the question
        had left. Asked ahead, every one of them is a disk read.

        Returns one answer per item, in order, "" where nothing came back.
        """
        lang = (language or "").strip().lower()[:2]
        into = (target or "").strip().lower()[:2]
        pairs = [
            (str(item.get("term", "")).strip(), str(item.get("sentence", "")).strip())
            for item in items
            if isinstance(item, dict)
        ]
        answers = ["" for _ in pairs]
        if not lang or not into or lang == into:
            return answers

        # One entry per distinct question. A word said twice in the same line is
        # asked once; a word said in two different lines is asked twice, which
        # is the whole reason the line travels with it.
        wanted: dict[tuple[str, str], list[int]] = {}
        for at, (term, line) in enumerate(pairs):
            if not term:
                continue
            held = self._read_translation(term.lower(), lang, into, line)
            if held is None and not line:
                held = self._read_translation(term.lower(), lang, into)
            if held is not None:
                answers[at] = held
                continue
            wanted.setdefault((term, line), []).append(at)

        if not wanted or not self._gloss_model:
            return answers

        asked = list(wanted)
        for start in range(0, len(asked), GLOSS_BATCH):
            chunk = asked[start : start + GLOSS_BATCH]
            answered = self._gloss(chunk, lang, into, GLOSS_BATCH_TIMEOUT_SECONDS)
            for (term, line), text in zip(chunk, answered):
                if not text:
                    continue
                for at in wanted[(term, line)]:
                    answers[at] = text
        return answers

    # --- disk ---------------------------------------------------------------

    def _path(self, term: str, language: str) -> Path:
        # quote() rather than a hash: the cache stays readable, and a word that
        # contains a slash or a dot cannot escape the directory.
        safe = urllib.parse.quote(term, safe="")
        return self._dir / f"{language}-{safe}.json"

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
        """
        safe = urllib.parse.quote(term, safe="")
        if sentence:
            mark = hashlib.sha1(sentence.encode("utf-8")).hexdigest()[:10]
            return self._translations / f"{language}-{target}-{safe}-{mark}.json"
        return self._translations / f"{language}-{target}-{safe}.json"

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
        self, pairs: list[tuple[str, str]], language: str, target: str, timeout: float
    ) -> list[str]:
        """One request, one gloss per pair, "" for every pair on any failure."""
        blank = ["" for _ in pairs]
        if not self._gloss_model or not pairs:
            return blank

        body = json.dumps(
            {
                "model": self._gloss_model,
                "messages": [
                    {"role": "system", "content": GLOSS_SYSTEM.format(target=target)},
                    {
                        "role": "user",
                        "content": json.dumps(
                            [{"word": term, "line": line} for term, line in pairs],
                            ensure_ascii=False,
                        ),
                    },
                ],
                "temperature": 0.2,
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
                "gloss unavailable for %s words from %s: %s", len(pairs), self._gloss_url, error
            )
            return blank

        # A short array would pair every gloss after the gap with the wrong
        # word, which is worse than no gloss at all - a wrong meaning under a
        # word is not read as a failure, it is read as the meaning.
        if not isinstance(answers, list) or len(answers) != len(pairs):
            logger.warning(
                "gloss returned %s answers for %s words",
                len(answers) if isinstance(answers, list) else type(answers).__name__,
                len(pairs),
            )
            return blank

        # Written here rather than by the callers, so the single-word path and
        # the batch cannot disagree about what a cached gloss looks like.
        glossed = [_short_gloss(text, term) for text, (term, _) in zip(answers, pairs)]
        for (term, line), text in zip(pairs, glossed):
            if text:
                self._write_translation(term.lower(), language, target, text, line)
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
