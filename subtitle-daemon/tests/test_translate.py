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


def test_a_line_asked_again_carries_more_context_and_keeps_the_speaker_check(model) -> None:
    """A retry that repeats the chunk's prompt gets the chunk's answer, since
    the decode is greedy. So the line is asked with twice the carry above it,
    and refused for the same reason the repair pass refuses."""
    stub = model(rows((3, "- Sekreter Roslin.\n- Evet.")), rows((4, "- Adım Aaron Doral.")))
    translator = translate.Translator(carry=1)
    assert translator.again(CUES, 3) == "- Sekreter Roslin.\n- Evet."
    assert "you'll call me later" in stub.prompts[0], "two lines of context, not the one the chunk had"
    assert translator.again(CUES, 4) == "- Adım Aaron Doral."

    model(rows((3, "- Sekreter Roslin.")))
    assert translate.Translator(carry=0).again(CUES, 3) == "", "one speaker where the cue has two"
    model(None)
    assert translate.Translator(carry=0).again(CUES, 1) == "", "no answer is no better"


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


def test_abort_ends_the_request_in_flight_rather_than_waiting_for_it() -> None:
    """Stop means now. A blocked read cannot see an event, so abort() tears the
    socket down - checked against a real server that never answers."""
    import threading
    import time
    from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

    class Silent(BaseHTTPRequestHandler):
        def do_POST(self) -> None:
            self.rfile.read(int(self.headers.get("Content-Length") or 0))
            time.sleep(8)

        def log_message(self, *args: object) -> None:
            pass

    server = ThreadingHTTPServer(("127.0.0.1", 0), Silent)
    thread = threading.Thread(target=server.serve_forever, kwargs={"poll_interval": 0.05}, daemon=True)
    thread.start()
    try:
        url = f"http://127.0.0.1:{server.server_address[1]}/v1/chat/completions"
        translator = translate.Translator(model="stub", url=url, timeout=30, carry=0)
        outcome: dict[str, object] = {}

        def ask() -> None:
            started = time.monotonic()
            try:
                translator.chunk_lines(CUES, 0, 2)
                outcome["raised"] = None
            except translate.Cancelled:
                outcome["raised"] = "cancelled"
            outcome["took"] = time.monotonic() - started

        asker = threading.Thread(target=ask, daemon=True)
        asker.start()
        time.sleep(0.3)  # long enough for the request to be open and blocked
        translator.abort()
        asker.join(timeout=5)
        assert outcome.get("raised") == "cancelled", outcome
        assert float(outcome["took"]) < 3, f"abort waited for the request: {outcome['took']:.1f}s"  # type: ignore[arg-type]
    finally:
        server.shutdown()
        server.server_close()


def test_the_answer_comes_back_under_the_target_language_code() -> None:
    """The brief's example said "tr" whatever the language, so a German
    request was parsed for a field the model was never told about."""
    german = translate.Translator(model="stub", target="German", target_code="de")
    assert '{"n": 1, "de": "..."}' in german.brief and '"tr"' not in german.brief
    assert translate._numbered({"lines": [{"n": 1, "de": "Ja."}, {"n": 2, "tr": "Evet."}]}, "de") == {1: "Ja.", 2: ""}
    turkish = translate.Translator(model="stub")
    assert '{"n": 1, "tr": "..."}' in turkish.brief
    # A region tag or an upper-case code is the bare code in the field.
    assert translate.Translator(model="stub", target_code="PT-BR").target_code == "pt"


# --- ollama's own API, and Google Translate ---------------------------------------


def _serve(handler_class):  # type: ignore[no-untyped-def]
    import threading
    from http.server import ThreadingHTTPServer

    server = ThreadingHTTPServer(("127.0.0.1", 0), handler_class)
    threading.Thread(target=server.serve_forever, kwargs={"poll_interval": 0.05}, daemon=True).start()
    return server


def test_ollama_is_spoken_to_through_its_own_api_with_thinking_off() -> None:
    """The OpenAI shape cannot switch a model's reasoning off, and a qwen3 that
    reasons took 95 seconds over an 18-token answer. Both the native URL and
    the OpenAI-shaped one on ollama's port go to /api/chat with think: false."""
    import json as json_module
    from http.server import BaseHTTPRequestHandler

    from subtitle_daemon import chat

    seen: list[tuple[str, dict]] = []

    class Ollama(BaseHTTPRequestHandler):
        def do_POST(self) -> None:
            body = json_module.loads(self.rfile.read(int(self.headers.get("Content-Length") or 0)))
            seen.append((self.path, body))
            answer = json_module.dumps({"message": {"role": "assistant", "content": '{"lines": [{"n": 1, "tr": "Merhaba."}]}'}}).encode()
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(answer)))
            self.end_headers()
            self.wfile.write(answer)

        def log_message(self, *args: object) -> None:
            pass

    server = _serve(Ollama)
    try:
        port = server.server_address[1]
        got = chat.ask_json(url=f"http://127.0.0.1:{port}/api/chat", model="m", key="", system="s", user="u", timeout=5)
        assert got == {"lines": [{"n": 1, "tr": "Merhaba."}]}
        path, body = seen[-1]
        assert path == "/api/chat" and body["think"] is False and body["format"] == "json" and body["stream"] is False
        assert body["options"] == {"temperature": 0} and "response_format" not in body
    finally:
        server.shutdown()
        server.server_close()
    # The OpenAI-shaped URL on ollama's port is rewritten; anywhere else it is left alone.
    assert chat.ollama_native("http://127.0.0.1:11434/v1/chat/completions") == "http://127.0.0.1:11434/api/chat"
    assert chat.ollama_native("http://localhost:11434/api/chat/") == "http://localhost:11434/api/chat/"
    assert chat.ollama_native("https://api.openai.com/v1/chat/completions") is None
    assert chat.ollama_native("http://127.0.0.1:8000/v1/chat/completions") is None
    assert chat.DEFAULT_URL.endswith("/api/chat")


def test_google_translates_every_line_of_a_cue_on_its_own_and_keeps_the_speakers() -> None:
    import json as json_module
    from http.server import BaseHTTPRequestHandler
    from urllib.parse import parse_qs

    asked: list[list[str]] = []
    CANNED = {
        "- Secretary Roslin.": "Sekreter Roslin.",  # the dash translated away
        "- Yes.": "- Evet.",
        "<i>Is anyone there?</i>": "<i>Orada biri var mı?</i>",
        "It's about time.": "Zaman&#39;ı geldi.",  # HTML-escaped, as format=html answers
    }

    class Google(BaseHTTPRequestHandler):
        def do_POST(self) -> None:
            fields = parse_qs(self.rfile.read(int(self.headers.get("Content-Length") or 0)).decode("utf-8"))
            strings = fields.get("q", [])
            asked.append(strings)
            assert fields["format"] == ["html"] and fields["source"] == ["en"] and fields["target"] == ["tr"] and fields["key"] == ["k"]
            if strings == ["short"]:
                rows: list[dict[str, str]] = []
            else:
                rows = [{"translatedText": CANNED.get(text, f"tr({text})")} for text in strings]
            answer = json_module.dumps({"data": {"translations": rows}}).encode()
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(answer)))
            self.end_headers()
            self.wfile.write(answer)

        def log_message(self, *args: object) -> None:
            pass

    server = _serve(Google)
    try:
        url = f"http://127.0.0.1:{server.server_address[1]}/language/translate/v2"
        google = translate.GoogleTranslator(key="k", source="en", target="tr", url=url)
        cues = [
            Cue(start_ms=0, end_ms=900, text="- Secretary Roslin.\n- Yes."),
            Cue(start_ms=1000, end_ms=1900, text="<i>Is anyone there?</i>"),
            Cue(start_ms=2000, end_ms=2900, text="It's about time."),
        ]
        got = google.chunk_lines(cues, 0, 3)
        assert asked[-1] == ["- Secretary Roslin.", "- Yes.", "<i>Is anyone there?</i>", "It's about time."]
        assert got.lines == {1: "-Sekreter Roslin.\n- Evet.", 2: "<i>Orada biri var mı?</i>", 3: "Zaman'ı geldi."}
        assert got.missing == [] and got.unrepaired == [] and not got.error
        assert translate.speakers(got.lines[1]) == 2, "both speakers, the dash put back where Google dropped it"
        assert google.again(cues, 3) == "Zaman'ı geldi."
        # A short answer is no answer: nothing is paired with the wrong line.
        short = google.chunk_lines([Cue(start_ms=0, end_ms=1, text="short")], 0, 1)
        assert short.lines == {} and short.missing == [1] and short.error
    finally:
        server.shutdown()
        server.server_close()


def test_the_translator_in_use_follows_the_key_unless_a_name_is_given(tmp_path) -> None:  # type: ignore[no-untyped-def]
    from subtitle_daemon import translate_jobs
    from subtitle_daemon.cache import Cache

    cache = Cache(tmp_path / "cache")
    with_key = translate_jobs.Jobs(tmp_path / "a", cache, model="", url="", key="", google_key="k")
    assert with_key.model == translate.GOOGLE_MODEL and with_key.rate() == translate.GOOGLE_SECONDS_PER_CUE
    assert isinstance(with_key._translator("en", "tr"), translate.GoogleTranslator)  # noqa: SLF001
    without = translate_jobs.Jobs(tmp_path / "b", cache, model="", url="", key="")
    assert without.model == translate.DEFAULT_MODEL and without.rate() == translate_jobs.SECONDS_PER_CUE
    named = translate_jobs.Jobs(tmp_path / "c", cache, model="qwen3.6:35b-a3b", url="", key="", google_key="k")
    assert named.model == "qwen3.6:35b-a3b" and isinstance(named._translator("en", "tr"), translate.Translator)  # noqa: SLF001
    assert translate_jobs.Jobs(tmp_path / "d", cache, model="google", url="", key="", google_key="k").model == translate.GOOGLE_MODEL
