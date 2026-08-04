"""Word lookups for study mode.

Nothing here makes a network call. What is worth testing is not the dictionary -
that is somebody else's service - but the three decisions around it: what gets
cached, what does not, and which questions are answered without asking at all.
The last one matters most, because a phrase or an unsupported language reaching
the network can only ever come back as a 404 the user then has to read.
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

import pytest
from subtitle_daemon.lookups import Lookups, condense, pick_translation

RAW_ENTRY: list[dict[str, Any]] = [
    {
        "word": "warrant",
        "phonetic": "/ˈwɒɹənt/",
        "phonetics": [{"text": "/ˈwɒɹənt/"}],
        "meanings": [
            {
                "partOfSpeech": "noun",
                "definitions": [
                    {"definition": "An authorisation to act.", "example": "a search warrant"},
                    {"definition": "A voucher.", "example": ""},
                ],
            },
            {
                "partOfSpeech": "verb",
                "definitions": [{"definition": "To justify.", "example": ""}],
            },
            {
                "partOfSpeech": "noun",
                "definitions": [{"definition": "A second noun sense.", "example": ""}],
            },
        ],
    }
]


@pytest.fixture
def lookups(tmp_path: Path) -> Lookups:
    return Lookups(tmp_path)


def test_condense_keeps_one_sense_per_part_of_speech() -> None:
    result = condense(RAW_ENTRY)
    parts = [item["partOfSpeech"] for item in result["definitions"]]
    assert parts == ["noun", "verb"]
    assert result["definitions"][0]["sense"] == "An authorisation to act."
    assert result["phonetic"] == "/ˈwɒɹənt/"


def test_condense_survives_a_payload_of_the_wrong_shape() -> None:
    # The API returns an object rather than a list for some errors, and a broken
    # entry must degrade to "no definitions", never raise into the request.
    assert condense({"title": "No Definitions Found"})["definitions"] == []
    assert condense([{"meanings": [{"partOfSpeech": "noun", "definitions": []}]}])["definitions"] == []


def test_a_phrase_is_not_sent_to_a_word_dictionary(lookups: Lookups) -> None:
    result = lookups.get("give it a rest", "en")
    assert result["definitions"] == []
    assert "Phrases" in result["unavailable"]


def test_an_unsupported_language_is_answered_without_asking(lookups: Lookups) -> None:
    result = lookups.get("kitap", "tr")
    assert result["definitions"] == []
    assert "tr" in result["unavailable"]


def test_an_empty_query_is_answered_without_asking(lookups: Lookups) -> None:
    assert lookups.get("   ", "en")["unavailable"] == "nothing to look up"


def test_a_cached_entry_is_served_from_disk(lookups: Lookups, tmp_path: Path) -> None:
    payload = {"query": "warrant", **condense(RAW_ENTRY), "source": "dictionaryapi.dev"}
    lookups._write("warrant", "en", payload)

    result = lookups.get("Warrant", "en")  # case and cache key are independent
    assert result["definitions"][0]["sense"] == "An authorisation to act."
    assert result["source"].endswith("(cached)")


def test_a_failed_lookup_is_not_cached(lookups: Lookups, monkeypatch: Any) -> None:
    """Caching a network failure would make it permanent."""
    calls = []

    def fail(term: str, language: str) -> dict[str, Any]:
        calls.append(term)
        return {"query": term, "definitions": [], "unavailable": "Could not reach the dictionary."}

    monkeypatch.setattr(lookups, "_fetch", fail)
    lookups.get("warrant", "en")
    lookups.get("warrant", "en")
    assert calls == ["warrant", "warrant"], "the failure was cached and never retried"


def test_a_word_that_could_escape_the_cache_directory_does_not(lookups: Lookups) -> None:
    """The cache key is a filename, and the word comes off a subtitle line."""
    path = lookups._path("../../etc/passwd", "en")
    assert path.parent == lookups._dir
    assert "/" not in path.name.removeprefix("en-")


def test_a_corrupt_cache_file_is_a_miss_rather_than_a_crash(
    lookups: Lookups, monkeypatch: Any
) -> None:
    lookups._path("warrant", "en").write_text("{ this is not json", encoding="utf-8")
    monkeypatch.setattr(
        lookups, "_fetch", lambda term, language: {"query": term, "definitions": [], "phonetic": ""}
    )
    assert lookups.get("warrant", "en")["definitions"] == []


def test_a_cached_entry_round_trips_as_json(lookups: Lookups) -> None:
    payload = {"query": "warrant", **condense(RAW_ENTRY), "source": "dictionaryapi.dev"}
    lookups._write("warrant", "en", payload)
    on_disk = json.loads(lookups._path("warrant", "en").read_text(encoding="utf-8"))
    assert on_disk == payload


# --- translation ---------------------------------------------------------------

# Recorded from api.mymemory.translated.net rather than invented, because the
# two ways its answers mislead are things it does and not things imagined for
# it. Trimmed to the fields the picker reads.
FRANKLY = {
    "responseData": {"translatedText": "açıkçası", "match": 0.99},
    "matches": [
        {"translation": "açıkçası", "quality": "74", "match": 0.99, "created-by": "MateCat"},
        {"translation": "açıkçası", "quality": 70, "match": 0.85, "created-by": "MT!"},
        {
            "translation": "Şunu içtenlikle söyleyebilirim,",
            "quality": "74",
            "match": 0.84,
            "created-by": "MateCat",
        },
    ],
}

# The archive's own order puts a quality-0 entry first, and the sense the film
# meant third, behind a sentence about a phone shop.
GET_DOWN = {
    "responseData": {"translatedText": "başlamak", "match": 1},
    "matches": [
        {"translation": "başlamak", "quality": "0", "match": 1, "created-by": "marco"},
        {
            "translation": (
                "ı was worked turktelekom and vodafone shop on sale in total seventeen months. "
            ),
            "quality": 74,
            "match": 0.98,
            "created-by": "MateCat",
        },
        {"translation": "Çök.", "quality": 74, "match": 0.96, "created-by": "MateCat"},
    ],
}

# A word it does not know comes back unchanged, with a confident-looking score.
UNKNOWN = {
    "responseData": {"translatedText": "zzzqqxnotaword", "match": 0.85},
    "matches": [
        {"translation": "zzzqqxnotaword", "quality": 70, "match": 0.85, "created-by": "MT!"}
    ],
}


def test_the_best_scored_candidate_wins() -> None:
    assert pick_translation(FRANKLY, "frankly") == "açıkçası"


def test_a_quality_zero_entry_loses_to_a_lower_ranked_good_one() -> None:
    # The whole reason the list is scored: taking matches[0] returns "başlamak".
    assert pick_translation(GET_DOWN, "get down") == "Çök."


def test_a_long_unrelated_segment_is_not_a_word_translation() -> None:
    assert "turktelekom" not in pick_translation(GET_DOWN, "get down")


def test_handing_the_word_back_unchanged_is_not_a_translation() -> None:
    assert pick_translation(UNKNOWN, "zzzqqxnotaword") == ""


def test_the_echo_is_rejected_whatever_its_case() -> None:
    raw = {"matches": [{"translation": "Frankly", "quality": 90, "match": 1}]}
    assert pick_translation(raw, "frankly") == ""


def test_responsedata_is_used_when_there_are_no_matches() -> None:
    raw = {"responseData": {"translatedText": "açıkçası"}, "matches": []}
    assert pick_translation(raw, "frankly") == "açıkçası"


def test_a_shape_that_is_not_a_payload_is_not_a_crash() -> None:
    assert pick_translation(None, "frankly") == ""
    assert pick_translation([], "frankly") == ""
    assert pick_translation({"matches": [None, "nonsense"]}, "frankly") == ""


def test_translating_into_the_same_language_asks_nobody(lookups: Lookups) -> None:
    assert lookups.translate("frankly", "en", "en") == ""


def test_a_translation_is_cached_on_disk_and_reused(lookups: Lookups, monkeypatch: Any) -> None:
    calls = []

    def once(term: str, language: str, target: str) -> str:
        calls.append(term)
        return "açıkçası"

    monkeypatch.setattr(lookups, "_fetch_translation", once)
    assert lookups.translate("frankly", "en", "tr") == "açıkçası"
    assert lookups.translate("Frankly", "en", "tr") == "açıkçası"
    assert calls == ["frankly"], "the second lookup should have come off the disk"


def test_a_word_with_no_dictionary_still_carries_its_translation(
    lookups: Lookups, monkeypatch: Any
) -> None:
    # The normal case for every language but English, and for every phrase.
    monkeypatch.setattr(lookups, "_fetch_translation", lambda *args: "açıkçası")
    payload = lookups.get("dürüst", "tr", "en")
    assert payload["translation"] == "açıkçası"
    assert "unavailable" not in payload, "a translation is an answer, not a failure"


def test_a_failed_translation_is_not_cached(lookups: Lookups, monkeypatch: Any) -> None:
    monkeypatch.setattr(lookups, "_fetch_translation", lambda *args: "")
    lookups.translate("frankly", "en", "tr")
    assert not lookups._translation_path("frankly", "en", "tr").exists()
