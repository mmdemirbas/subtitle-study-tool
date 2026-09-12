"""A translation as a job: what survives a restart, a cancel, and a closed tab.

The model is stubbed with a translator that records which chunks it was asked
for and can be made to stall or fail on cue. What is under test is the job
directory - that a chunk landed is a chunk never asked for again - and the
partial answer a reader can attach while the rest arrives.
"""

from __future__ import annotations

import json
import queue
import sys
import time
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))

from subtitle_daemon import translate, translate_jobs
from subtitle_daemon.cache import Cache
from subtitle_daemon.subtitles import Cue


def cues(count: int) -> list[Cue]:
    return [Cue(start_ms=i * 1000, end_ms=i * 1000 + 900, text=f"line {i + 1}") for i in range(count)]


class StubTranslator:
    """Translates "line N" to "satır N", one chunk at a time, on command."""

    def __init__(self, *, fail_at: tuple[int, int] | None = None, gate: queue.Queue | None = None) -> None:
        self.asked: list[tuple[int, int]] = []
        self.fail_at = fail_at
        # One token per chunk allowed through, so a test can hold the model
        # after exactly the chunk it means to.
        self.gate = gate

    def abort(self) -> None:
        # What the real translator does to a request in flight: the wait ends
        # with Cancelled rather than with an answer.
        self.aborted = True
        if self.gate is not None:
            self.gate.put("abort")

    def chunk_lines(self, source: list[Cue], first: int, last: int, floor: int = 0) -> translate.Attempt:
        self.asked.append((first, last))
        if self.gate is not None and self.gate.get(timeout=5) == "abort":
            raise translate.Cancelled()
        if self.fail_at == (first, last):
            return translate.Attempt(missing=list(range(first + 1, last + 1)), error="the model went away")
        return translate.Attempt(lines={i + 1: source[i].text.replace("line", "satır") for i in range(first, last)})


def wait_for(jobs: translate_jobs.Jobs, key: str, status: str, seconds: float = 5.0) -> dict:
    deadline = time.monotonic() + seconds
    while time.monotonic() < deadline:
        current = jobs.status(key)
        if current.get("status") == status:
            return current
        time.sleep(0.01)
    raise AssertionError(f"never reached {status}: {jobs.status(key)}")


@pytest.fixture
def cache(tmp_path: Path) -> Cache:
    return Cache(tmp_path / "cache")


def make_jobs(tmp_path: Path, cache: Cache, translator: StubTranslator, chunk: int = 4) -> translate_jobs.Jobs:
    return translate_jobs.Jobs(
        tmp_path / "jobs", cache, model="stub", url="", key="", chunk=chunk,
        translator_factory=lambda source, target: translator,
    )


META = {"imdb_id": "2149175", "movie_name": "The Americans", "release": "S03E13", "season": 3, "episode": 13, "label": "EN"}


def test_a_job_walks_every_chunk_once_and_files_the_result_in_the_cache(tmp_path: Path, cache: Cache) -> None:
    stub = StubTranslator()
    jobs = make_jobs(tmp_path, cache, stub)
    started = jobs.start(source_id="13", source_language="en", target="tr", cues=cues(10), meta=META)
    assert started["status"] in ("queued", "running")
    done = wait_for(jobs, started["job"], "done")
    assert stub.asked == [(0, 4), (4, 8), (8, 10)]
    assert done["done"] == 10 and done["total"] == 10 and done["file_id"] == started["generated_file_id"]

    held = cache.get_subtitle(done["file_id"])
    assert held is not None
    assert held.meta["generated"] is True
    assert held.meta["language"] == "tr" and held.meta["imdb_id"] == "2149175"
    assert held.meta["season"] == 3 and held.meta["episode"] == 13
    assert held.meta["source_id"] == "13" and held.meta["model"] == "stub"
    text = held.read_bytes().decode("utf-8")
    assert "satır 1" in text and "satır 10" in text and "line " not in text
    assert "00:00:09,000 --> 00:00:09,900" in text, "the timings are the source's"


def test_a_second_start_of_a_finished_job_answers_with_the_file_and_asks_nothing(tmp_path: Path, cache: Cache) -> None:
    stub = StubTranslator()
    jobs = make_jobs(tmp_path, cache, stub)
    first = jobs.start(source_id="13", source_language="en", target="tr", cues=cues(5), meta=META)
    wait_for(jobs, first["job"], "done")
    asked = len(stub.asked)
    again = jobs.start(source_id="13", source_language="en", target="tr", cues=cues(5), meta=META)
    assert again["status"] == "done" and again["file_id"] == first["generated_file_id"]
    assert len(stub.asked) == asked


def test_what_has_landed_can_be_attached_while_the_rest_arrives(tmp_path: Path, cache: Cache) -> None:
    gate: queue.Queue = queue.Queue()
    stub = StubTranslator(gate=gate)
    jobs = make_jobs(tmp_path, cache, stub)
    started = jobs.start(source_id="13", source_language="en", target="tr", cues=cues(10), meta=META)
    # Let exactly one chunk through, then hold the model.
    gate.put(1)
    deadline = time.monotonic() + 5
    while time.monotonic() < deadline and jobs.status(started["job"])["done"] < 4:
        time.sleep(0.01)
    partial = jobs.status(started["job"], with_cues=True)
    assert partial["status"] == "running"
    assert partial["done"] >= 4
    texts = [cue["text"] for cue in partial["cues"]]
    assert texts[0] == "satır 1" and texts[3] == "satır 4", "the landed chunk is translated"
    assert texts[-1] == "line 10", "and the rest is still the source, so the file plays"
    assert partial["translated_indexes"][:4] == [0, 1, 2, 3]
    assert partial["eta_seconds"] >= 0 and partial["seconds_per_cue"] is not None
    gate.put(1)
    gate.put(1)
    wait_for(jobs, started["job"], "done")


def test_a_restart_resumes_at_the_first_chunk_with_no_file(tmp_path: Path, cache: Cache) -> None:
    """The process died mid-job. The chunks that landed stay landed."""
    stub = StubTranslator(fail_at=(4, 8))
    jobs = make_jobs(tmp_path, cache, stub)
    started = jobs.start(source_id="13", source_language="en", target="tr", cues=cues(10), meta=META)
    failed = wait_for(jobs, started["job"], "failed")
    assert failed["done"] == 4 and failed["error"] == "the model went away"
    # As a crash leaves it: the sidecar still says running.
    state_path = tmp_path / "jobs" / started["job"] / "job.json"
    state = json.loads(state_path.read_text())
    state["status"] = "running"
    state_path.write_text(json.dumps(state))

    second = StubTranslator()
    revived = make_jobs(tmp_path, cache, second)
    assert revived.resume_all() == 1
    done = wait_for(revived, started["job"], "done")
    assert second.asked == [(4, 8), (8, 10)], "the first chunk was never asked for again"
    assert done["done"] == 10
    text = cache.get_subtitle(done["file_id"]).read_bytes().decode("utf-8")  # type: ignore[union-attr]
    assert "satır 1" in text and "satır 10" in text


def test_a_failed_job_is_picked_up_by_the_next_start(tmp_path: Path, cache: Cache) -> None:
    stub = StubTranslator(fail_at=(4, 8))
    jobs = make_jobs(tmp_path, cache, stub)
    started = jobs.start(source_id="13", source_language="en", target="tr", cues=cues(10), meta=META)
    wait_for(jobs, started["job"], "failed")
    stub.fail_at = None
    again = jobs.start(source_id="13", source_language="en", target="tr", cues=cues(10), meta=META)
    assert again["status"] in ("queued", "running")
    wait_for(jobs, started["job"], "done")
    assert stub.asked.count((0, 4)) == 1


def test_cancel_stops_before_the_next_chunk_and_a_restart_continues(tmp_path: Path, cache: Cache) -> None:
    gate: queue.Queue = queue.Queue()
    stub = StubTranslator(gate=gate)
    jobs = make_jobs(tmp_path, cache, stub)
    started = jobs.start(source_id="13", source_language="en", target="tr", cues=cues(12), meta=META)
    deadline = time.monotonic() + 5
    while time.monotonic() < deadline and not stub.asked:
        time.sleep(0.01)
    cancelled = jobs.cancel(started["job"])
    assert cancelled["status"] == "cancelled"
    # The chunk in flight is torn down, not waited for: the stub was aborted
    # and nothing landed for it.
    assert getattr(stub, "aborted", False), "cancel did not abort the translator in flight"
    wait_for(jobs, started["job"], "cancelled")
    time.sleep(0.05)
    assert stub.asked == [(0, 4)]
    assert cancelled["done"] == 0 and jobs.status(started["job"])["done"] == 0
    # And asked for again, it goes on from the first chunk with no file.
    again = jobs.start(source_id="13", source_language="en", target="tr", cues=cues(12), meta=META)
    assert again["status"] in ("queued", "running")
    gate.put(1)
    gate.put(1)
    gate.put(1)
    wait_for(jobs, started["job"], "done")
    assert stub.asked == [(0, 4), (0, 4), (4, 8), (8, 12)]


def test_a_cancel_and_an_immediate_restart_do_not_lose_the_restart(tmp_path: Path, cache: Cache) -> None:
    """The worker notices the cancel AFTER start() has re-queued the job. The
    re-queue has to win, or the queue pops a job that says it is cancelled."""
    gate: queue.Queue = queue.Queue()
    stub = StubTranslator(gate=gate)
    jobs = make_jobs(tmp_path, cache, stub)
    started = jobs.start(source_id="13", source_language="en", target="tr", cues=cues(8), meta=META)
    deadline = time.monotonic() + 5
    while time.monotonic() < deadline and not stub.asked:
        time.sleep(0.01)
    jobs.cancel(started["job"])
    jobs.start(source_id="13", source_language="en", target="tr", cues=cues(8), meta=META)
    gate.put(1)
    gate.put(1)
    wait_for(jobs, started["job"], "done")
    assert sorted(set(stub.asked)) == [(0, 4), (4, 8)]


def test_lines_the_model_never_answered_keep_their_source_and_are_counted(tmp_path: Path, cache: Cache) -> None:
    class Partial(StubTranslator):
        def chunk_lines(self, source, first, last, floor=0):  # type: ignore[override]
            attempt = super().chunk_lines(source, first, last, floor)
            if first == 0:
                lines = dict(attempt.lines)
                lines.pop(2)
                return translate.Attempt(lines=lines, missing=[2], unrepaired=[3])
            return attempt

    jobs = make_jobs(tmp_path, cache, Partial())
    started = jobs.start(source_id="13", source_language="en", target="tr", cues=cues(6), meta=META)
    done = wait_for(jobs, started["job"], "done")
    assert done["missing"] == 1 and done["unrepaired"] == 1
    held = cache.get_subtitle(done["file_id"])
    assert held is not None and held.meta["missing"] == 1 and held.meta["unrepaired"] == 1
    assert "line 2" in held.read_bytes().decode("utf-8"), "visibly untranslated, not invented"


def test_the_generated_id_is_deterministic_high_and_exact() -> None:
    a = translate_jobs.generated_file_id("13", "tr")
    assert a == translate_jobs.generated_file_id("13", "tr")
    assert a != translate_jobs.generated_file_id("13", "de")
    assert a != translate_jobs.generated_file_id("14", "tr")
    assert translate_jobs.is_generated(a) and not translate_jobs.is_generated(13)
    assert a < 2**53, "the extension's numbers stop being exact past this"
    page = translate_jobs.generated_file_id("page:amzn1.dv.gti.358f:en-us:sdh", "tr")
    assert translate_jobs.is_generated(page) and page < 2**53


def test_a_job_key_is_a_safe_directory_name() -> None:
    key = translate_jobs.job_key("page:amzn1.dv.gti.358f/../x:en-us:sdh", "TR")
    assert "/" not in key and ":" not in key and ".." not in key
    assert key.endswith("-tr")
    assert translate_jobs.job_key("13", "tr") != translate_jobs.job_key("13", "de")


def test_language_names_for_the_brief() -> None:
    assert translate_jobs.language_name("tr") == "Turkish"
    assert translate_jobs.language_name("en-US") == "English"
    assert translate_jobs.language_name("xx") == "xx"
