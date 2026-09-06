"""Word lookups for study mode.

Nothing here makes a network call. What is worth testing is not the dictionary -
that is somebody else's service - but the three decisions around it: what gets
cached, what does not, and which questions are answered without asking at all.
The last one matters most, because a phrase or an unsupported language reaching
the network can only ever come back as a 404 the user then has to read.
"""

from __future__ import annotations

import json
import urllib.parse
from pathlib import Path
from typing import Any

import pytest
from subtitle_daemon.lookups import (
    GLOSS_PROBE,
    GOOGLE_BATCH,
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


def test_a_language_code_that_could_escape_the_cache_directory_does_not(
    lookups: Lookups,
) -> None:
    """The word was quoted and the codes beside it were not.

    `lang` and `to` arrive as query parameters on /lookup, and both are written
    straight into the filename the answer is cached under - so a code carrying
    a slash named a path rather than a file, in a directory the caller chose.
    Every real code quotes to itself, so nothing already on disk moved.
    """
    assert lookups._path("warrant", "en").name == "en-warrant.json"
    assert lookups._translation_path("warrant", "en", "tr").name == "en-tr-warrant.json"

    escaped = lookups._path("warrant", "../../etc")
    assert escaped.parent == lookups._dir
    assert "/" not in escaped.name

    both = lookups._translation_path("warrant", "../../etc", "../..")
    assert both.parent == lookups._translations
    assert "/" not in both.name


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


# --- the rest of what the caller knows ------------------------------------------
#
# A subtitle line is four or five words with the rest of the exchange in the
# lines around it, and every one of those lines belongs to a programme with its
# own vocabulary. Both were sitting in the extension unused: `glossAhead` walks
# the file in order, so the neighbours cost it nothing, and the page had already
# said which episode it was playing so the auto-attach could search for it.
#
# What is worth testing is that they reach the model, that they are omitted
# rather than sent empty when nobody knows them, and - the one that decides
# whether this feature costs anything - that neither of them is in the key.


def test_the_film_is_named_once_for_the_whole_request(
    glosser: Lookups, monkeypatch: Any
) -> None:
    """Once, in the system message, because one request is one programme.

    Per item it would be the same string forty times in a body with a 64KB
    ceiling, and it would read as something that could differ between them.
    """
    sent = _answers(monkeypatch, json.dumps({"g": ["sıçrama", "avcı"]}))
    items = [
        {"term": "jump", "sentence": "Prepare for the jump."},
        {"term": "viper", "sentence": "Get the viper out there."},
    ]
    glosser.gloss_many(items, "en", "tr", film="Battlestar Galactica (2003), season 0 episode 1")
    body = json.loads(sent[0])
    assert "Battlestar Galactica (2003), season 0 episode 1" in body["messages"][0]["content"]
    assert "Battlestar" not in body["messages"][1]["content"], (
        "the film was repeated on every item"
    )


def test_the_lines_either_side_travel_with_the_word(
    glosser: Lookups, monkeypatch: Any
) -> None:
    sent = _answers(monkeypatch, json.dumps({"g": ["sıçrama"]}))
    items = [
        {
            "term": "jump",
            "sentence": "Prepare for the jump.",
            "before": "Are we clear of the fleet?",
            "after": "Coordinates laid in, sir.",
        }
    ]
    glosser.gloss_many(items, "en", "tr")
    asked = json.loads(json.loads(sent[0])["messages"][1]["content"])
    assert asked[0]["before"] == "Are we clear of the fleet?"
    assert asked[0]["after"] == "Coordinates laid in, sir."
    assert asked[0]["line"] == "Prepare for the jump.", "the line itself was displaced"


def test_what_nobody_knows_is_left_out_rather_than_sent_empty(
    glosser: Lookups, monkeypatch: Any
) -> None:
    """The first line of a file has no line before it, and most of the web never
    says what it is playing. An empty string reads as a line that was silent."""
    sent = _answers(monkeypatch, json.dumps({"g": ["ayırmak"]}))
    glosser.gloss_many([{"term": "spare", "sentence": "Can you spare a minute?"}], "en", "tr")
    body = json.loads(sent[0])
    asked = json.loads(body["messages"][1]["content"])
    assert asked == [{"word": "spare", "line": "Can you spare a minute?"}]
    assert "The lines are from" not in body["messages"][0]["content"]


def test_the_context_is_not_part_of_the_key(glosser: Lookups, monkeypatch: Any) -> None:
    """The distinction the whole cache is built on. The line is the question and
    is in the key; the film and the neighbours help answer it and are not. Were
    they in the key, a word said twice in one film would be asked twice and a
    line an episode repeats would never hit at all - and every one of those
    answers is an answer to the same question."""
    sent = _answers(monkeypatch, json.dumps({"g": ["ayırmak"]}))
    line = "Can you spare a minute?"
    glosser.gloss_many([{"term": "spare", "sentence": line, "before": "One."}], "en", "tr")
    again = glosser.gloss_many(
        [{"term": "spare", "sentence": line, "after": "Two."}], "en", "tr", film="Something Else"
    )
    assert again == ["ayırmak"]
    assert len(sent) == 1, "different neighbours asked the same question twice"


def test_the_word_looked_up_by_hand_carries_the_same_context(
    glosser: Lookups, monkeypatch: Any
) -> None:
    """`translate` is the path a reader's click takes when the prefetch has not
    reached that word. Sending it less than the prefetch sends would gloss the
    same word two ways depending on who asked."""
    sent = _answers(monkeypatch, json.dumps({"g": ["sıçrama"]}))
    glosser.translate(
        "jump",
        "en",
        "tr",
        "Prepare for the jump.",
        film="Battlestar Galactica (2003)",
        before="Are we clear of the fleet?",
        after="Coordinates laid in, sir.",
    )
    body = json.loads(sent[0])
    assert "Battlestar Galactica (2003)" in body["messages"][0]["content"]
    asked = json.loads(body["messages"][1]["content"])
    assert asked[0]["before"] == "Are we clear of the fleet?"
    assert asked[0]["after"] == "Coordinates laid in, sir."


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
        lookups, "_gloss", lambda asks, *a, **kw: asked.append("gloss") or ["" for _ in asks]
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


# --- when the model cannot keep up ----------------------------------------------
#
# Reported after a season of watching: "translation quality is still not
# improved". It was not the model. Measured against the configured
# qwen3.6:35b-a3b on this machine, three words took 103 seconds and came back
# "iç", "ön koltuk" and "sağlamacı" - and "iç" is the sense of "domestic" in
# "from threats both foreign and domestic" that the context-free tier gets wrong
# as "yerel". At that speed a batch of twenty wants 690 seconds against a
# 180-second timeout, a timeout loses the whole batch, and the prefetch had
# nothing below it to catch what was lost.


def test_a_batch_that_times_out_still_answers_from_the_tier_below(
    tmp_path: Path, monkeypatch: Any
) -> None:
    glosser = Lookups(tmp_path, gloss_model="a-slow-model", google_key="k")
    monkeypatch.setattr(
        "subtitle_daemon.lookups.urllib.request.urlopen",
        lambda *args, **kwargs: (_ for _ in ()).throw(TimeoutError("too slow")),
    )
    monkeypatch.setattr(
        Lookups, "_fetch_google_many", lambda self, terms, *a: {t: f"{t}-google" for t in terms}
    )
    items = [
        {"term": "spare", "sentence": "Can you spare a minute?"},
        {"term": "chamber", "sentence": "The pressure in the chamber is dropping."},
    ]
    assert glosser.gloss_many(items, "en", "tr") == ["spare-google", "chamber-google"]


def test_the_context_free_answer_is_not_filed_where_the_contextual_one_goes(
    tmp_path: Path, monkeypatch: Any
) -> None:
    """Otherwise the model is never asked again. A bare-word answer under the
    word-and-line key is a wrong answer to a question nobody will re-ask."""
    glosser = Lookups(tmp_path, gloss_model="a-slow-model", google_key="k")
    monkeypatch.setattr(
        "subtitle_daemon.lookups.urllib.request.urlopen",
        lambda *args, **kwargs: (_ for _ in ()).throw(TimeoutError("too slow")),
    )
    monkeypatch.setattr(
        Lookups, "_fetch_google_many", lambda self, terms, *a: {t: "yerel" for t in terms}
    )
    line = "from threats both foreign and domestic."
    assert glosser.gloss_many([{"term": "domestic", "sentence": line}], "en", "tr") == ["yerel"]
    assert glosser._translation_path("domestic", "en", "tr").exists()
    assert not glosser._translation_path("domestic", "en", "tr", line).exists()


def test_the_batch_shrinks_to_what_the_model_can_manage(
    tmp_path: Path, monkeypatch: Any
) -> None:
    """A constant twenty is a claim about how fast the model is. The size comes
    from what the last batch actually cost, after a small probe first - the
    first request also pays for loading the model."""
    glosser = Lookups(tmp_path, gloss_model="a-slow-model")
    sizes: list[int] = []
    clock = [0.0]

    def fake_gloss(asks, language, target, timeout, film=""):
        sizes.append(len(asks))
        # Twelve seconds a word, so a 180s timeout holds nine and the aim of
        # 60% of it holds five.
        clock[0] += 12.0 * len(asks)
        return [f"{ask.term}-said" for ask in asks]

    monkeypatch.setattr(glosser, "_gloss", fake_gloss)
    monkeypatch.setattr("subtitle_daemon.lookups.time.monotonic", lambda: clock[0])
    items = [{"term": f"w{i}", "sentence": f"line {i}"} for i in range(14)]
    said = glosser.gloss_many(items, "en", "tr")

    assert sizes[0] == GLOSS_PROBE, f"the probe was {sizes[0]} words"
    assert sizes[1] == 9, f"the second batch was {sizes[1]} words, not what 12s a word allows"
    assert said[:2] == ["w0-said", "w1-said"]


def test_a_call_stops_asking_the_model_once_its_budget_is_gone(
    tmp_path: Path, monkeypatch: Any
) -> None:
    """Past the budget the film is better served by a fast answer for every
    remaining word than by a slow one for the next few."""
    glosser = Lookups(tmp_path, gloss_model="a-slow-model", google_key="k")
    clock = [0.0]
    asked: list[int] = []

    def fake_gloss(asks, language, target, timeout, film=""):
        asked.append(len(asks))
        clock[0] += 100.0
        return [f"{ask.term}-said" for ask in asks]

    monkeypatch.setattr(glosser, "_gloss", fake_gloss)
    monkeypatch.setattr("subtitle_daemon.lookups.time.monotonic", lambda: clock[0])
    monkeypatch.setattr(
        Lookups, "_fetch_google_many", lambda self, terms, *a: {t: f"{t}-google" for t in terms}
    )
    items = [{"term": f"w{i}", "sentence": f"line {i}"} for i in range(40)]
    said = glosser.gloss_many(items, "en", "tr")

    assert sum(asked) < 40, "the model was asked for every word despite the budget"
    assert said[-1] == "w39-google", "the words past the budget were left blank"
    assert said[0] == "w0-said", "the words inside it lost their contextual answer"


class _Raw:
    """A canned HTTP response with a body of the caller's own shape.

    _Answered wraps its argument in the OpenAI envelope, which is right for the
    gloss endpoint and wrong for every other one this module calls.
    """

    def __init__(self, body: bytes) -> None:
        self._body = body

    def read(self) -> bytes:
        return self._body

    def __enter__(self) -> _Raw:
        return self

    def __exit__(self, *args: Any) -> bool:
        return False


def test_a_word_handed_back_unchanged_is_not_a_gloss(tmp_path: Path, monkeypatch: Any) -> None:
    """A translator that returns the word it was given has no answer for it, and
    a chip reading "Paige" under the word Paige is read as a meaning rather than
    as a failure.

    It matters most for names. The model is told to answer a proper noun with an
    empty string; Google is not and cannot be, and 24.2% of everything the
    marking rule marks over the 175 English subtitles in the cache is a proper
    noun the name rule missed.
    """
    glosser = Lookups(tmp_path, google_key="k")

    # Stubbed at the wire, not at _fetch_google: the shortening that drops an
    # echo happens inside that method, so a stub replacing it would test the
    # test. Google answers with the word it was given for anything it cannot
    # translate, which is what a name looks like to it.
    def urlopen(request: Any, timeout: float = 0) -> Any:
        # The words are in the POST body now, and there may be several of them.
        terms = urllib.parse.parse_qs(request.data.decode("utf-8"))["q"]
        said = [{"Paige": "Paige", "vault": "kasa"}[term] for term in terms]
        return _Raw(
            json.dumps(
                {"data": {"translations": [{"translatedText": x} for x in said]}}
            ).encode()
        )

    monkeypatch.setattr("subtitle_daemon.lookups.urllib.request.urlopen", urlopen)
    said = glosser.gloss_many(
        [{"term": "Paige", "sentence": "Paige, come down here."},
         {"term": "vault", "sentence": "That is the vault."}],
        "en",
        "tr",
    )
    assert said == ["", "kasa"]
    # Case alone is not a translation either.
    assert _short_gloss("PAIGE", "Paige") == ""
    assert _short_gloss("kasa", "vault") == "kasa"


def test_a_proper_noun_the_model_refused_is_not_then_translated(
    tmp_path: Path, monkeypatch: Any
) -> None:
    """The empty string is an ANSWER from this tier, not an absence.

    The system prompt asks for "" on a proper noun, so a blank inside a batch
    that came back means "Paige is a name, leave it alone". Handing those to
    Google would undo the one instruction the model is given about them - and
    the tier below has no idea it is looking at a name. Only the words in a
    batch the model never answered at all fall through.
    """
    glosser = Lookups(tmp_path, gloss_model="a-model", google_key="k")
    clock = [0.0]

    def fake_gloss(asks, language, target, timeout, film=""):
        clock[0] += 1.0
        return ["" if ask.term == "Paige" else "oda" for ask in asks]

    monkeypatch.setattr(glosser, "_gloss", fake_gloss)
    monkeypatch.setattr("subtitle_daemon.lookups.time.monotonic", lambda: clock[0])
    monkeypatch.setattr(
        Lookups, "_fetch_google", lambda self, term, *a: "sayfa-numarası-yap"
    )
    items = [
        {"term": "Paige", "sentence": "Paige, come down here."},
        {"term": "chamber", "sentence": "The pressure in the chamber is dropping."},
    ]
    assert glosser.gloss_many(items, "en", "tr") == ["", "oda"]


def test_an_item_that_is_not_an_object_still_has_a_place_in_the_answers(
    tmp_path: Path, monkeypatch: Any
) -> None:
    """One answer per item, in order, is what the caller pairs by index.

    An item that was not a dict used to be dropped rather than answered, so the
    list came back a place short and every gloss after it sat under the word
    before it. A wrong meaning under a word is not read as a failure, it is read
    as the meaning.
    """
    glosser = Lookups(tmp_path, gloss_model="a-model")
    monkeypatch.setattr(
        glosser, "_gloss",
        lambda asks, *a, **kw: [f"{ask.term}-said" for ask in asks],
    )
    items: list[Any] = [
        {"term": "chamber", "sentence": "one"},
        "not an object",
        {"term": "hatch", "sentence": "two"},
    ]
    assert glosser.gloss_many(items, "en", "tr") == ["chamber-said", "", "hatch-said"]


def test_a_batch_of_names_does_not_stop_the_model_for_the_rest_of_the_film(
    tmp_path: Path, monkeypatch: Any
) -> None:
    """An empty batch used to be read as an outage, and it is not one.

    The prompt asks for "" on a proper noun, so a batch that happens to hold
    only names comes back entirely blank - and the loop broke there, handing
    every word after it to the tier below for the rest of the call. A cast list
    said early in a film is exactly such a batch.

    None is what an unreachable model returns now, and only that stops the tier.
    """
    glosser = Lookups(tmp_path, gloss_model="a-model", google_key="k")
    clock = [0.0]
    seen: list[list[str]] = []

    def fake_gloss(asks, language, target, timeout, film=""):
        clock[0] += 1.0
        seen.append([ask.term for ask in asks])
        # Every name refused; every other word answered.
        return ["" if ask.term[0].isupper() else f"{ask.term}-said" for ask in asks]

    monkeypatch.setattr(glosser, "_gloss", fake_gloss)
    monkeypatch.setattr("subtitle_daemon.lookups.time.monotonic", lambda: clock[0])
    monkeypatch.setattr(
        Lookups, "_fetch_google_many", lambda self, terms, *a: {t: f"{t}-google" for t in terms}
    )

    names = [{"term": f"Name{i}", "sentence": f"line {i}"} for i in range(GLOSS_PROBE)]
    words = [{"term": f"word{i}", "sentence": f"line {i}"} for i in range(3)]
    said = glosser.gloss_many(names + words, "en", "tr")

    assert said[:GLOSS_PROBE] == [""] * GLOSS_PROBE, "a refused name is left alone"
    assert said[GLOSS_PROBE:] == [f"word{i}-said" for i in range(3)], (
        f"the model was asked {seen} and stopped after the batch of names")


def test_which_tier_answered_is_counted_and_handed_back(
    tmp_path: Path, monkeypatch: Any
) -> None:
    """From the overlay a slow model, a missing key and a genuinely untranslatable
    word are the same empty chip. The one report that followed was "translation
    quality is still not improved", which is true and says nothing about which."""
    glosser = Lookups(tmp_path, gloss_model="a-model", google_key="k")
    clock = [0.0]
    batches = [0]

    def fake_gloss(asks, language, target, timeout, film=""):
        clock[0] += 1.0
        batches[0] += 1
        # The first batch answers; the second gives up, the way a batch that
        # ran out of clock does - None rather than a row of blanks, because a
        # row of blanks is the model saying these are names.
        if batches[0] > 1:
            return None
        # Written to disk the way the real _gloss writes, so the second call
        # below is asking the question this test means to ask.
        for ask in asks:
            glosser._write_translation(ask.term.lower(), "en", "tr", f"{ask.term}-said", ask.line)
        return [f"{ask.term}-said" for ask in asks]

    monkeypatch.setattr(glosser, "_gloss", fake_gloss)
    monkeypatch.setattr("subtitle_daemon.lookups.time.monotonic", lambda: clock[0])
    monkeypatch.setattr(
        Lookups,
        "_fetch_google_many",
        lambda self, terms, *a: {t: ("" if t == "w5" else f"{t}-google") for t in terms},
    )
    items = [{"term": f"w{i}", "sentence": f"line {i}"} for i in range(6)]
    tally: dict[str, int] = {}
    said = glosser.gloss_many(items, "en", "tr", tally=tally)

    assert said[:GLOSS_PROBE] == [f"w{i}-said" for i in range(GLOSS_PROBE)]
    assert said[4] == "w4-google"
    assert said[5] == ""
    assert tally == {"disk": 0, "model": GLOSS_PROBE, "google": 1, "none": 1}

    # And the second time round the model's answers are on disk, which is a
    # different fact about the same chip.
    again: dict[str, int] = {}
    glosser.gloss_many(items[:1], "en", "tr", tally=again)
    assert again["disk"] == 1 and again["model"] == 0


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


def test_a_film_of_words_reaches_google_in_one_request(
    tmp_path: Path, monkeypatch: Any
) -> None:
    """The whole of "the translations are late".

    A film marks about four hundred words and every one of them was its own
    round trip. Measured against the live API on twenty words: 54.29 seconds
    one at a time against 0.44 seconds as one request, the same twenty answers.
    """
    glosser = Lookups(tmp_path, google_key="k")
    calls: list[list[str]] = []

    def urlopen(request: Any, timeout: float = 0) -> Any:
        terms = urllib.parse.parse_qs(request.data.decode("utf-8"))["q"]
        calls.append(terms)
        return _Raw(
            json.dumps(
                {"data": {"translations": [{"translatedText": f"{t}-tr"} for t in terms]}}
            ).encode()
        )

    monkeypatch.setattr("subtitle_daemon.lookups.urllib.request.urlopen", urlopen)
    # Two lines asking about the same word are one question to a tier that
    # never sees the line, so "spare" is sent once and answers both.
    items = [{"term": f"w{i}", "sentence": f"line {i}"} for i in range(200)]
    items += [
        {"term": "spare", "sentence": "Can you spare a minute?"},
        {"term": "spare", "sentence": "We are down to one spare engine."},
    ]
    said = glosser.gloss_many(items, "en", "tr")

    assert said[0] == "w0-tr" and said[199] == "w199-tr"
    assert said[200] == said[201] == "spare-tr"
    assert [len(c) for c in calls] == [GOOGLE_BATCH, 73], "not one request per batch of 128"
    assert calls[0].count("spare") + calls[1].count("spare") == 1, "the word was asked twice"


def test_google_answering_with_the_wrong_number_of_words_is_no_answer(
    tmp_path: Path, monkeypatch: Any
) -> None:
    """A short array would pair each word with the NEXT one's answer.

    Silently, and for every word after the gap - which is worse than a row of
    empty chips, because a wrong meaning reads as a meaning.
    """
    glosser = Lookups(tmp_path, google_key="k")

    def urlopen(request: Any, timeout: float = 0) -> Any:
        terms = urllib.parse.parse_qs(request.data.decode("utf-8"))["q"]
        return _Raw(
            json.dumps(
                {"data": {"translations": [{"translatedText": f"{t}-tr"} for t in terms[1:]]}}
            ).encode()
        )

    monkeypatch.setattr("subtitle_daemon.lookups.urllib.request.urlopen", urlopen)
    items = [{"term": "vault", "sentence": "a"}, {"term": "courier", "sentence": "b"}]
    assert glosser.gloss_many(items, "en", "tr") == ["", ""]
    assert not glosser._translation_path("vault", "en", "tr").exists()
