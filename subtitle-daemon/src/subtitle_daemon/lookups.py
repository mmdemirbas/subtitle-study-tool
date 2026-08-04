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

import json
import logging
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


class Lookups:
    """Dictionary entries, cached on disk. One JSON file per word."""

    def __init__(self, root: Path) -> None:
        self._dir = root / "lookups"
        self._dir.mkdir(parents=True, exist_ok=True)
        self._translations = root / "translations"
        self._translations.mkdir(parents=True, exist_ok=True)

    def get(self, query: str, language: str, target: str = "") -> dict[str, Any]:
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
            payload = {**payload, "translation": self.translate(term, lang, into)}
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

    def translate(self, query: str, language: str, target: str) -> str:
        """What this says in `target`, or "" when nothing trustworthy came back."""
        term = query.strip()
        lang = (language or "").strip().lower()[:2]
        into = (target or "").strip().lower()[:2]
        if not term or not lang or not into or lang == into:
            return ""

        cached = self._read_translation(term.lower(), lang, into)
        if cached is not None:
            return cached

        answer = self._fetch_translation(term, lang, into)
        if answer:
            self._write_translation(term.lower(), lang, into, answer)
        return answer

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

    def _translation_path(self, term: str, language: str, target: str) -> Path:
        safe = urllib.parse.quote(term, safe="")
        return self._translations / f"{language}-{target}-{safe}.json"

    def _read_translation(self, term: str, language: str, target: str) -> str | None:
        path = self._translation_path(term, language, target)
        if not path.exists():
            return None
        try:
            stored = json.loads(path.read_text(encoding="utf-8"))
        except (OSError, ValueError):
            return None
        text = stored.get("translation")
        return str(text) if isinstance(text, str) and text else None

    def _write_translation(self, term: str, language: str, target: str, text: str) -> None:
        try:
            self._translation_path(term, language, target).write_text(
                json.dumps({"query": term, "translation": text}, ensure_ascii=False),
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

    def usable(text: str) -> bool:
        candidate = text.strip()
        if not candidate or candidate.lower() == source:
            # Handing the word back unchanged is how this API says "no".
            return False
        return len(candidate) <= MAX_TRANSLATION_CHARS and len(candidate.split()) <= allowed_words

    best = ""
    best_score = 0.0
    for match in raw.get("matches") or []:
        if not isinstance(match, dict):
            continue
        text = str(match.get("translation") or "")
        if not usable(text):
            continue
        score = _number(match.get("match"), 0.0) * (_number(match.get("quality"), 0.0) / 100)
        if score > best_score:
            best, best_score = text.strip(), score

    if best:
        return best

    # No scored candidate survived: fall back to the API's own pick, which is
    # all there is when `matches` is absent.
    fallback = str((raw.get("responseData") or {}).get("translatedText") or "")
    return fallback.strip() if usable(fallback) else ""


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
