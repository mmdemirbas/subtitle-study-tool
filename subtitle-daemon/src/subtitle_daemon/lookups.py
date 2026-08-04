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

What this deliberately does not do is translate. The daemon has no runtime
dependencies and no API key beyond OpenSubtitles', and a translator means one of
those - a hosted API with a cost per call, or a local model that has to be
resident. That decision has not been made, so `translation` is always empty
here, and the payload carries the field so that a translator can fill it later
without every reader changing. For a learner watching with two subtitles the
gap is smaller than it sounds: the sentence is already translated, by a human,
in the other subtitle, and the overlay shows that line next to the word.
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


class Lookups:
    """Dictionary entries, cached on disk. One JSON file per word."""

    def __init__(self, root: Path) -> None:
        self._dir = root / "lookups"
        self._dir.mkdir(parents=True, exist_ok=True)

    def get(self, query: str, language: str) -> dict[str, Any]:
        """A word's entry, from disk if it is there and from the web if not.

        Always returns a payload. A word with no entry is a normal answer, not
        an error: the caller shows the word and its rarity either way, and the
        definition was only ever enrichment.
        """
        term = query.strip().lower()
        lang = (language or "en").strip().lower()[:2]
        if not term:
            return _empty(term, "nothing to look up")

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
