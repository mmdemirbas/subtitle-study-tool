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
from subtitle_daemon.lookups import (
    Lookups,
    _short_gloss,
    clean_translation,
    condense,
    pick_translation,
)

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


# --- the gloss ------------------------------------------------------------------
#
# The tier that knows the line a word was said in. What is worth testing is not
# the model - that is somebody else's - but the three things around it: that the
# line reaches it and comes back in the key, that a malformed answer is refused
# whole rather than in part, and that every one of the tiers below it still gets
# its turn when this one cannot answer.


class _Answered:
    """One canned HTTP response, in the shape an OpenAI-compatible endpoint sends."""

    def __init__(self, content: str) -> None:
        self._body = json.dumps({"choices": [{"message": {"content": content}}]}).encode()

    def read(self) -> bytes:
        return self._body

    def __enter__(self) -> _Answered:
        return self

    def __exit__(self, *_: Any) -> None:
        return None


@pytest.fixture
def glosser(tmp_path: Path) -> Lookups:
    """Naming a model is what turns the tier on, so every test here names one."""
    return Lookups(tmp_path, gloss_model="a-model-that-is-never-called")


def _answers(monkeypatch: Any, *replies: str) -> list[bytes]:
    """Serve `replies` in order, and record every request body that was sent."""
    sent: list[bytes] = []
    queue = list(replies)

    def urlopen(request: Any, timeout: float = 0) -> _Answered:
        sent.append(request.data)
        return _Answered(queue.pop(0) if queue else queue[-1])

    monkeypatch.setattr("subtitle_daemon.lookups.urllib.request.urlopen", urlopen)
    return sent


def test_the_line_travels_with_the_word(glosser: Lookups, monkeypatch: Any) -> None:
    sent = _answers(monkeypatch, json.dumps({"g": ["ayırmak"]}))
    assert glosser.translate("spare", "en", "tr", "Can you spare a minute?") == "ayırmak"
    asked = json.loads(sent[0])["messages"][1]["content"]
    assert "Can you spare a minute?" in asked, "the model was asked about the word alone"


def test_the_same_word_in_two_lines_is_two_answers(glosser: Lookups, monkeypatch: Any) -> None:
    """The whole fault this tier exists for. A context-free translator answers
    "spare" with "parça", from its memory of "spare part", and hands that to a
    reader who just heard "can you spare a minute"."""
    _answers(monkeypatch, json.dumps({"g": ["ayırmak"]}), json.dumps({"g": ["yedek"]}))
    assert glosser.translate("spare", "en", "tr", "Can you spare a minute?") == "ayırmak"
    assert glosser.translate("spare", "en", "tr", "We have one spare engine.") == "yedek"


def test_a_gloss_is_cached_against_its_line(glosser: Lookups, monkeypatch: Any) -> None:
    sent = _answers(monkeypatch, json.dumps({"g": ["ayırmak"]}))
    line = "Can you spare a minute?"
    assert glosser.translate("spare", "en", "tr", line) == "ayırmak"
    assert glosser.translate("Spare", "en", "tr", line) == "ayırmak"
    assert len(sent) == 1, "the second ask should have come off the disk"
    assert glosser._translation_path("spare", "en", "tr", line).exists()
    assert not glosser._translation_path("spare", "en", "tr").exists(), (
        "a contextual answer must not be filed where the context-free one is looked for"
    )


def test_a_word_said_twice_in_one_line_is_asked_once(glosser: Lookups, monkeypatch: Any) -> None:
    sent = _answers(monkeypatch, json.dumps({"g": ["ayırmak", "yedek"]}))
    items = [
        {"term": "spare", "sentence": "Spare a minute, spare a thought."},
        {"term": "spare", "sentence": "Spare a minute, spare a thought."},
        {"term": "spare", "sentence": "We have one spare engine."},
    ]
    assert glosser.gloss_many(items, "en", "tr") == ["ayırmak", "ayırmak", "yedek"]
    assert len(json.loads(sent[0])["messages"][1]["content"]) > 0
    assert len(sent) == 1


def test_a_reasoning_model_that_narrates_is_still_understood(
    glosser: Lookups, monkeypatch: Any
) -> None:
    _answers(monkeypatch, '<think>The line is about time.</think>\n{"g": ["ayırmak"]}')
    assert glosser.translate("spare", "en", "tr", "Can you spare a minute?") == "ayırmak"


def test_a_short_answer_is_refused_whole(glosser: Lookups, monkeypatch: Any) -> None:
    """Two answers for three words would put the second word's gloss under the
    third, and a wrong meaning under a word is not read as a failure. It is read
    as the meaning."""
    _answers(monkeypatch, json.dumps({"g": ["ayırmak", "yedek"]}))
    items = [
        {"term": "spare", "sentence": "One."},
        {"term": "chamber", "sentence": "Two."},
        {"term": "brig", "sentence": "Three."},
    ]
    assert glosser.gloss_many(items, "en", "tr") == ["", "", ""]


def test_an_explanation_is_not_a_gloss(glosser: Lookups, monkeypatch: Any) -> None:
    """A model asked for one to three words will sometimes explain itself, and a
    sentence does not fit on a chip under a subtitle. Refusing it drops through
    to the tier below, which is why the archive is stubbed silent here."""
    _answers(
        monkeypatch,
        json.dumps({"g": ["Bu kelime burada zaman ayırmak anlamında kullanılmıştır."]}),
    )
    monkeypatch.setattr(glosser, "_fetch_translation", lambda *args: "")
    assert glosser.translate("spare", "en", "tr", "Can you spare a minute?") == ""


def test_a_failing_endpoint_is_left_alone_for_a_while(
    glosser: Lookups, monkeypatch: Any
) -> None:
    """Without this every word looked up by hand pays the live timeout before
    the tier below gets its turn, and a reader who configured nothing would feel
    the whole feature stall."""
    tries = []

    def refuse(request: Any, timeout: float = 0) -> _Answered:
        tries.append(timeout)
        raise TimeoutError("no model there")

    monkeypatch.setattr("subtitle_daemon.lookups.urllib.request.urlopen", refuse)
    monkeypatch.setattr(glosser, "_fetch_translation", lambda *args: "parça")
    assert glosser.translate("spare", "en", "tr", "Spare a minute?") == "parça"
    assert glosser.translate("chamber", "en", "tr", "In the chamber.") == "parça"
    assert len(tries) == 1, "the second word asked a model that had just failed"


def test_the_tiers_fall_in_order(tmp_path: Path, monkeypatch: Any) -> None:
    asked: list[str] = []
    lookups = Lookups(tmp_path, gloss_model="a-model", google_key="a-key")

    monkeypatch.setattr(
        lookups, "_gloss", lambda pairs, *a: asked.append("gloss") or ["" for _ in pairs]
    )
    monkeypatch.setattr(
        lookups, "_fetch_google", lambda *a: asked.append("google") or "yedek"
    )
    monkeypatch.setattr(
        lookups, "_fetch_translation", lambda *a: asked.append("archive") or "parça"
    )
    assert lookups.translate("spare", "en", "tr", "One spare engine.") == "yedek"
    assert asked == ["gloss", "google"], "the archive answered over a tier that could"


def test_the_archive_still_answers_when_nothing_is_configured(
    lookups: Lookups, monkeypatch: Any
) -> None:
    """No model, no key, no daemon-side anything: the feature this replaced has
    to keep working for whoever cloned the repo and started it."""
    monkeypatch.setattr(lookups, "_fetch_translation", lambda *args: "parça")
    assert lookups.translate("spare", "en", "tr", "One spare engine.") == "parça"


def test_no_model_named_means_the_batch_asks_nobody(lookups: Lookups, monkeypatch: Any) -> None:
    def never(*args: Any, **kwargs: Any) -> None:
        raise AssertionError("the gloss tier is off and was asked anyway")

    monkeypatch.setattr("subtitle_daemon.lookups.urllib.request.urlopen", never)
    assert lookups.gloss_many([{"term": "spare", "sentence": "One."}], "en", "tr") == [""]


def test_a_translation_memorys_placeholders_do_not_reach_the_reader() -> None:
    """Reported with a screenshot: "laying" glossed as `Serme<x id="1"/>`.

    A translation memory stores segments with their inline placeholders in, and
    a candidate scored on how well its SOURCE matched can carry a placeholder
    its source had. Taken out rather than refused, because "Serme" is the right
    gloss and an empty chip is the other half of the same report.
    """
    assert clean_translation('Serme<x id="1"/>') == "Serme"
    assert clean_translation('&lt;g id="1"&gt;yatırma&lt;/g&gt;') == "yatırma"
    assert clean_translation("{1} koyma") == "koyma"
    assert clean_translation("%1$s serme") == "serme"
    assert clean_translation("kar&#351;ı") == "karşı"
    # One pass, so an escaped entity stays an escaped entity rather than being
    # unwrapped twice into markup nobody wrote.
    assert clean_translation("sa&amp;#39;lam") == "sa&#39;lam"
    # Nothing but a placeholder is nothing.
    assert clean_translation('<x id="1"/>') == ""


def test_a_segment_that_is_only_markup_is_refused_rather_than_shown_empty() -> None:
    raw = {"matches": [{"translation": '<x id="1"/>', "match": 1.0, "quality": 100}]}
    assert pick_translation(raw, "abuzz") == ""


def test_length_is_measured_on_what_the_reader_would_see() -> None:
    """Cleaned before it is judged, or the markup counts against the answer.

    Five placeholders and one word is a one-word gloss wearing a paragraph's
    length, and the rule that keeps whole paragraphs of unrelated archive text
    off the chip would have refused it.
    """
    padded = '<g id="1">tehditler</g><x id="2"/><x id="3"/><x id="4"/><x id="5"/>'
    raw = {"matches": [{"translation": padded, "match": 1.0, "quality": 70}]}
    assert pick_translation(raw, "threats") == "tehditler"


def test_a_gloss_from_a_model_is_cleaned_the_same_way() -> None:
    """One rule for three tiers. A model asked for JSON can wrap its answer."""
    assert _short_gloss('<b>yedek</b>', "spare") == "yedek"
    assert _short_gloss("&quot;yedek&quot;", "spare") == "yedek"
