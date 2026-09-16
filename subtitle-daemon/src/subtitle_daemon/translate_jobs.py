"""A whole-subtitle translation as a job that outlives the request that started it.

`translate.py` knows how to ask a model for a scene and check the answer. It
does not know about time, and time is the whole problem: an episode is 800 to
1200 cues and the local default does a cue every half second, so a file takes
the length of a coffee. No HTTP request lives that long, the panel that asked
will be closed, and the daemon will be restarted by the next `run.sh`. So a
translation is a directory on disk and a thread that walks it:

    cache/translate-jobs/<key>/
        job.json          what was asked, what has landed, what went wrong
        source.srt        the cues being translated, verbatim
        chunks/40-80.json one Attempt per chunk, written as it lands

A restart re-queues every job whose status is not final and picks up at the
first chunk with no file, which is the promise the translate module's
docstring makes - "a browser tab closing, a daemon restart or a model falling
over costs the chunk in flight and nothing else". A done job can be asked to
go on as well: the lines its chunks left in the source language are asked for
one at a time, land in the chunk files that own them, and the file is written
again - see resume(). The finished file goes into
the ordinary subtitle cache under a synthetic file_id, with `generated` in its
sidecar, so a later search for the same title finds it the way it finds any
download.

One worker thread, whatever the number of jobs. The default model runs on
this machine and two jobs at once would each run at half speed while the
reader waits for the first; a hosted endpoint would take the parallelism, but
the ordinary case is one episode at a time.

The order is "the one asked for most recently first", not arrival order, and
a running job steps aside between chunks for one asked for after it. The
case: an episode's translation is still going when the reader starts the
next episode - the first is forty minutes of model time, the second is what
they are watching now - and a queue that served the first to its end left the
second at zero for the length of it. Reported as "my second attempt doesn't
progress, it is still literally at zero". Nothing is lost by stepping aside:
the chunks are on disk, and the job that stepped aside goes on when the
newer one is done. `status()` says what a queued job is waiting for.

The same episode into the same language is one job, whichever subtitle it is
made from. The reader's reload attached the page's own English where the
download had been, and the second "make" from it made a second job for the
same episode, queued behind the first - see start().

`status()` is what the extension polls, and its `cues` are the whole file with
the translated lines where a chunk has landed and the source text where it has
not - so a reader can attach what exists ten seconds in and watch the Turkish
arrive under the English.
"""

from __future__ import annotations

import json
import logging
import os
import re
import threading
import time
import zlib
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

from . import subtitles, translate
from .cache import Cache
from .subtitles import Cue

logger = logging.getLogger(__name__)

# Above every file_id OpenSubtitles hands out (eight digits in 2026) and
# under 2**53, which is where the extension's numbers stop being exact.
GENERATED_BASE = 90_000_000_000_000

# Before the first chunk has landed there is no rate to report, and the
# confirmation needs a number. gemma3:4b measured 0.48 s/line in the bake-off
# (docs/reports/translate-bakeoff-2026-09-10.md); a hosted model is faster and
# says so after one chunk.
SECONDS_PER_CUE = 0.5

FINAL = ("done", "failed", "cancelled")

# What the brief calls a language. A code the table does not know is sent as
# itself, which a model reads correctly more often than not.
LANGUAGE_NAMES = {
    "en": "English", "tr": "Turkish", "de": "German", "fr": "French", "es": "Spanish",
    "it": "Italian", "pt": "Portuguese", "ru": "Russian", "ja": "Japanese", "ko": "Korean",
    "zh": "Chinese", "ar": "Arabic", "nl": "Dutch", "pl": "Polish", "sv": "Swedish",
    "da": "Danish", "nb": "Norwegian", "no": "Norwegian", "fi": "Finnish", "el": "Greek",
    "he": "Hebrew", "hi": "Hindi", "id": "Indonesian", "ms": "Malay", "th": "Thai",
    "cs": "Czech", "hu": "Hungarian", "ro": "Romanian", "uk": "Ukrainian", "vi": "Vietnamese",
    "fa": "Persian", "bg": "Bulgarian", "hr": "Croatian", "sr": "Serbian", "sk": "Slovak",
    "ca": "Catalan", "eu": "Basque", "gl": "Galician", "ta": "Tamil", "te": "Telugu",
    "kn": "Kannada", "ml": "Malayalam",
}


def language_name(code: str) -> str:
    return LANGUAGE_NAMES.get(code.lower().split("-")[0], code)


def job_key(source_id: str, target: str) -> str:
    """A directory name from a source id and a target language.

    A cached download's id is a number; a page's own track is
    `page:<titleId>:<code>:<kind>`, which carries characters no directory
    should. Everything but letters, digits and dashes becomes one dash, and a
    short digest keeps two sources that squash to the same name apart.
    """
    safe = re.sub(r"[^A-Za-z0-9-]+", "-", source_id).strip("-")[:60]
    digest = f"{zlib.crc32(source_id.encode('utf-8')) & 0xFFFFFFFF:08x}"
    return f"{safe}-{digest}-{target.lower()}"


def generated_file_id(source_id: str, target: str) -> int:
    """The synthetic file_id a translation is filed under. Deterministic, so
    running the same job twice produces the same file rather than two."""
    source = zlib.crc32(source_id.encode("utf-8")) & 0xFFFFFFFF
    lang = 0
    for char in target.lower()[:3]:
        lang = lang * 27 + (ord(char) - ord("a") + 1 if "a" <= char <= "z" else 0)
    return GENERATED_BASE + source * 100_000 + lang


def is_generated(file_id: int) -> bool:
    return file_id >= GENERATED_BASE


def episode_identity(meta: dict[str, Any]) -> tuple[Any, ...] | None:
    """What makes two jobs the same episode, whatever subtitle each is made
    from. An IMDb id with the season and episode beside it; without an id, a
    title with a season or episode number. A bare title is not enough - a
    series' landing page carries the series' name and nothing else, and two
    of its episodes must not fold into one job. None when nothing here
    identifies an episode, and then only the source id tells jobs apart."""
    season, episode = meta.get("season"), meta.get("episode")
    imdb = str(meta.get("imdb_id") or "").strip().lower()
    if imdb:
        return (imdb, season, episode)
    name = str(meta.get("movie_name") or "").strip().lower()
    if name and (season is not None or episode is not None):
        return (name, season, episode)
    return None


@dataclass
class Job:
    """One translation, as its directory says it stands."""

    key: str
    root: Path
    state: dict[str, Any] = field(default_factory=dict)

    @property
    def source_path(self) -> Path:
        return self.root / "source.srt"

    @property
    def chunks_dir(self) -> Path:
        return self.root / "chunks"

    def chunk_path(self, first: int, last: int) -> Path:
        return self.chunks_dir / f"{first}-{last}.json"

    def cues(self) -> list[Cue]:
        return subtitles.parse_srt(self.source_path.read_text(encoding="utf-8"))

    def bounds(self) -> list[tuple[int, int]]:
        return translate.chunk_bounds(0, int(self.state["total"]), int(self.state["chunk"]))

    def landed(self) -> dict[int, str]:
        """Every translated line on disk, keyed 1-based like the model sees them."""
        lines: dict[int, str] = {}
        for first, last in self.bounds():
            path = self.chunk_path(first, last)
            if not path.exists():
                continue
            try:
                data = json.loads(path.read_text(encoding="utf-8"))
            except ValueError:
                continue
            for entry in data.get("lines", []):
                lines[int(entry["n"])] = translate.line_text(entry)
        return lines

    def done_chunks(self) -> list[tuple[int, int]]:
        return [(first, last) for first, last in self.bounds() if self.chunk_path(first, last).exists()]

    def land(self, number: int, text: str) -> None:
        """A retried line, into the chunk file that owns it: the translation
        where the source text stood, and the number moved from missing or
        unrepaired to repaired. The chunk files stay the one record of what
        was translated, so a restart after this sees the line landed."""
        for first, last in self.bounds():
            if not first < number <= last:
                continue
            path = self.chunk_path(first, last)
            try:
                data = json.loads(path.read_text(encoding="utf-8"))
            except (OSError, ValueError):
                data = {}
            lines = {int(row["n"]): translate.line_text(row) for row in data.get("lines", [])}
            lines[number] = text
            data["lines"] = [{"n": n, "text": said} for n, said in sorted(lines.items())]
            for name in ("missing", "unrepaired"):
                data[name] = [n for n in data.get(name, []) if n != number]
            data["repaired"] = sorted(set(data.get("repaired", [])) | {number})
            path.write_text(json.dumps(data, ensure_ascii=False), encoding="utf-8")
            return


class Jobs:
    """The job directory, its queue and the one thread that works it."""

    def __init__(
        self,
        root: Path,
        cache: Cache,
        *,
        model: str,
        url: str,
        key: str,
        google_key: str = "",
        chunk: int = translate.CHUNK,
        translator_factory: Any = None,
    ) -> None:
        self.root = root
        self.cache = cache
        # Which translator, when nothing names one: Google Translate if the
        # key for it is there, the local default if not. The same rule the
        # gloss tier follows for the same key, and the measured one - see
        # translate.GoogleTranslator. A name in config.local.json is a
        # choice, and "google" is a name.
        self.google_key = google_key
        self.model = model or (translate.GOOGLE_MODEL if google_key else translate.DEFAULT_MODEL)
        if self.model == "google":
            self.model = translate.GOOGLE_MODEL
        self.url = url
        self.key = key
        self.chunk = chunk
        # Replaceable so the tests can hand in a Translator whose chat is stubbed.
        self._factory = translator_factory or self._translator
        self.root.mkdir(parents=True, exist_ok=True)
        self._lock = threading.Lock()
        # The jobs waiting their turn, the most recently asked for first. A
        # list under a condition rather than a Queue: the order is not
        # arrival order (see _enqueue), and the running job reads the head
        # between chunks to decide whether to step aside (see _step_aside).
        self._waiting: list[str] = []
        self._wake = threading.Condition(self._lock)
        self._cancel: dict[str, threading.Event] = {}
        self._running: str | None = None
        # The translator working the running job, for cancel() to abort: the
        # event alone waits for the request in flight, which on the local
        # model is up to a chunk's worth of minutes.
        self._active: Any = None
        self._worker: threading.Thread | None = None

    # --- the public surface -------------------------------------------------

    def start(
        self,
        *,
        source_id: str,
        source_language: str,
        target: str,
        cues: list[Cue],
        meta: dict[str, Any],
    ) -> dict[str, Any]:
        """Start, or resume, the translation of `cues` into `target`.

        Idempotent on (source, target), and on (episode, target) where the
        meta names the episode: a job already done answers with its file; one
        queued or running answers with its progress, and goes to the front of
        the queue if it was waiting, because somebody is watching for it
        now; one that failed or was cancelled is picked up where it stopped,
        since the chunks that landed are still on disk.

        The episode match is what makes a second source the same job. The
        same film's subtitle from OpenSubtitles and from the page itself have
        different ids, and translating both is the same forty minutes spent
        twice; the reader who asked twice asked for one Turkish subtitle.
        """
        target = target.lower()
        key = job_key(source_id, target)
        if not cues:
            return {"error": "nothing to translate"}
        with self._lock:
            job = self._load(key) or self._same_episode(meta, target)
            if job is None:
                job = Job(key=key, root=self.root / key)
                job.root.mkdir(parents=True, exist_ok=True)
                job.chunks_dir.mkdir(exist_ok=True)
                job.source_path.write_text(subtitles.to_srt(cues), encoding="utf-8")
                job.state = {
                    "key": key,
                    "source_id": source_id,
                    "source_language": source_language.lower(),
                    "target": target,
                    "model": self.model,
                    "total": len(cues),
                    "chunk": self.chunk,
                    "created_at": time.time(),
                    "updated_at": time.time(),
                    # When somebody last asked for this job - the start, and
                    # every resume. The queue is ordered by it; see _enqueue.
                    "asked_at": time.time(),
                    "status": "queued",
                    "file_id": generated_file_id(source_id, target),
                    "seconds_per_cue": None,
                    "repaired": 0,
                    "unrepaired": [],
                    "missing": [],
                    "error": "",
                    # Only the fields the cache defines, the same list
                    # import_subtitle keeps, so a caller cannot write arbitrary
                    # keys into a sidecar through here either.
                    "meta": {
                        name: meta.get(name)
                        for name in ("imdb_id", "movie_name", "release", "season", "episode", "label")
                    },
                }
                self._save(job)
            elif job.state["status"] == "done":
                return self._status_of(job)
            elif job.state["status"] in ("queued", "running"):
                if job.state["status"] == "queued":
                    self._update(job, asked_at=time.time())
                    self._enqueue(job.key)
                return self._status_of(job)
            else:
                job.state["status"] = "queued"
                job.state["error"] = ""
                job.state["asked_at"] = time.time()
                self._save(job)
            self._enqueue(job.key)
            return self._status_of(job)

    def resume(self, key: str) -> dict[str, Any]:
        """Go on with whatever this job has not translated.

        For a job that failed or was stopped, that is the chunks with no file,
        and start() would do the same given the cues again - this needs
        nothing but the key, since the source is on disk. For a job that is
        done, it is the lines the model never answered for or answered badly,
        which were left in the source language on purpose; those are asked
        for one at a time, and the file is written again when they are in. A
        done job with nothing left, and a job still going, are answered with
        their status and not queued twice - but a job still waiting its turn
        goes to the front of the queue, since asking for it again is what a
        reader does when it is the one they are watching for.
        """
        with self._lock:
            job = self._load(key)
            if job is None:
                return {"error": "no such translation"}
            if job.state["status"] == "queued":
                self._update(job, asked_at=time.time())
                self._enqueue(key)
                return self._status_of(job)
            if job.state["status"] == "running":
                return self._status_of(job)
            if job.state["status"] == "done":
                left = sorted(set(job.state.get("missing") or []) | set(job.state.get("unrepaired") or []))
                if not left:
                    return self._status_of(job)
                job.state["retry"] = left
                job.state["retry_total"] = len(left)
            job.state["status"] = "queued"
            job.state["error"] = ""
            job.state["asked_at"] = time.time()
            self._save(job)
            self._enqueue(key)
            return self._status_of(job)

    def status(self, key: str, *, with_cues: bool = False) -> dict[str, Any]:
        with self._lock:
            job = self._load(key)
            if job is None:
                return {"error": "no such translation"}
            answer = self._status_of(job)
            if with_cues:
                cues = job.cues()
                landed = job.landed()
                merged = translate.to_cues(cues, landed, 0, len(cues))
                answer["cues"] = subtitles.to_json(merged)
                answer["translated_indexes"] = sorted(n - 1 for n in landed)
                # The lines the model has not been asked about yet - every
                # line of a chunk with no file. Distinct from the lines it was
                # asked about and could not do, which keep their source text
                # in the file on purpose and are counted in `missing` and
                # `unrepaired`: the extension leaves these out of the subtitle
                # it shows and puts those in, visibly, as the honest failure.
                answer["pending_indexes"] = [
                    index
                    for first, last in job.bounds()
                    if not job.chunk_path(first, last).exists()
                    for index in range(first, last)
                ]
            return answer

    def cancel(self, key: str, *, forget: bool = False) -> dict[str, Any]:
        with self._lock:
            job = self._load(key)
            if job is None:
                return {"error": "no such translation"}
            event = self._cancel.get(key)
            if event is not None:
                event.set()
            if self._running == key and self._active is not None:
                abort = getattr(self._active, "abort", None)
                if abort is not None:
                    abort()
            if job.state["status"] not in FINAL:
                job.state["status"] = "cancelled"
                self._save(job)
            if forget:
                self._remove(job)
                return {"cancelled": True, "forgotten": True, "key": key}
            return self._status_of(job)

    def list(self) -> list[dict[str, Any]]:
        with self._lock:
            found = []
            for path in sorted(self.root.glob("*/job.json")):
                job = self._load(path.parent.name)
                if job is not None:
                    found.append(self._status_of(job))
            found.sort(key=lambda item: float(item.get("created_at") or 0), reverse=True)
            return found

    def rate(self) -> float:
        """Seconds per cue with the translator in use, from the most recent
        job that measured one on it, or the bake-off's number before any has."""
        for job in self.list():
            rate = job.get("seconds_per_cue")
            if rate and job.get("model") == self.model:
                return round(float(rate), 3)
        return translate.GOOGLE_SECONDS_PER_CUE if self.model == translate.GOOGLE_MODEL else SECONDS_PER_CUE

    def resume_all(self) -> int:
        """Re-queue every job a previous process left unfinished. Called once
        at startup; the in-flight chunk of a job that was `running` is the
        one thing lost, and it is re-asked."""
        count = 0
        with self._lock:
            for path in sorted(self.root.glob("*/job.json")):
                job = self._load(path.parent.name)
                if job is None or job.state.get("status") not in ("queued", "running"):
                    continue
                job.state["status"] = "queued"
                self._save(job)
                self._enqueue(job.key)
                count += 1
        if count:
            logger.info("resuming %d unfinished translation(s)", count)
        return count

    # --- the worker -----------------------------------------------------------

    def _asked_at(self, key: str) -> float:
        job = self._load(key)
        if job is None:
            return 0.0
        return float(job.state.get("asked_at") or job.state.get("created_at") or 0)

    def _same_episode(self, meta: dict[str, Any], target: str) -> Job | None:
        """The job already making this episode in this language from some
        other subtitle, if there is one. The one furthest along wins a tie:
        running over queued over done over stopped, then the most recently
        asked for. Called with the lock held."""
        wanted = episode_identity(meta)
        if wanted is None:
            return None
        rank = {"running": 0, "queued": 1, "done": 2}
        twins: list[Job] = []
        for path in sorted(self.root.glob("*/job.json")):
            job = self._load(path.parent.name)
            if job is None or job.state.get("target") != target:
                continue
            if episode_identity(job.state.get("meta") or {}) == wanted:
                twins.append(job)
        twins.sort(
            key=lambda job: (
                rank.get(str(job.state.get("status")), 3),
                -float(job.state.get("asked_at") or job.state.get("created_at") or 0),
            )
        )
        return twins[0] if twins else None

    def _enqueue(self, key: str) -> None:
        """Into the waiting list at the place its `asked_at` earns: the most
        recently asked for first. A job that steps aside goes back in by its
        own, older, time - behind the one it stepped aside for and ahead of
        anything older still. Called with the lock held."""
        self._cancel[key] = threading.Event()
        if key in self._waiting:
            self._waiting.remove(key)
        mine = self._asked_at(key)
        index = next((i for i, other in enumerate(self._waiting) if self._asked_at(other) < mine), len(self._waiting))
        self._waiting.insert(index, key)
        self._wake.notify()
        if self._worker is None or not self._worker.is_alive():
            self._worker = threading.Thread(target=self._work, name="translate", daemon=True)
            self._worker.start()

    def _work(self) -> None:
        while True:
            with self._wake:
                while not self._waiting:
                    self._wake.wait()
                key = self._waiting.pop(0)
            try:
                self._run(key)
            except Exception:
                logger.exception("translation %s crashed", key)
                with self._lock:
                    job = self._load(key)
                    if job is not None:
                        job.state["status"] = "failed"
                        job.state["error"] = "the translation crashed; see the daemon log"
                        self._save(job)
                    self._running = None
                    self._active = None

    def _step_aside(self, job: Job) -> bool:
        """Whether a job asked for after this one is waiting, in which case
        this one goes back to the queue - behind it - and the worker takes
        the newer one. Read between chunks, which is the one moment nothing
        is in flight, so stepping aside costs nothing on disk."""
        with self._lock:
            if not self._waiting:
                return False
            mine = float(job.state.get("asked_at") or job.state.get("created_at") or 0)
            if self._asked_at(self._waiting[0]) <= mine:
                return False
            fresh = self._load(job.key)
            if fresh is None or fresh.state.get("status") != "running":
                # Cancelled under us; the cancel's status stands.
                self._running = None
                self._active = None
                return True
            self._update(job, status="queued")
            self._running = None
            self._active = None
            self._enqueue(job.key)
            logger.info("translation %s: stepping aside for %s", job.key, self._waiting[0])
            return True

    def _run(self, key: str) -> None:
        with self._lock:
            job = self._load(key)
            if job is None or job.state["status"] != "queued":
                return
            self._update(job, status="running", started_at=job.state.get("started_at") or time.time())
            self._running = key
        cancel = self._cancel.get(key) or threading.Event()
        cues = job.cues()
        translator = self._factory(job.state["source_language"], job.state["target"])
        with self._lock:
            self._active = translator
            # cancel() may have run between the status check and here; a
            # translator that exists now can be aborted, so ask it.
            if cancel.is_set() and getattr(translator, "abort", None) is not None:
                translator.abort()

        for first, last in job.bounds():
            if cancel.is_set():
                self._finish(job, "cancelled")
                return
            if job.chunk_path(first, last).exists():
                continue
            if self._step_aside(job):
                return
            started = time.monotonic()
            try:
                attempt = translator.chunk_lines(cues, first, last, floor=0)
            except translate.Cancelled:
                self._finish(job, "cancelled")
                return
            took = time.monotonic() - started
            if attempt.error and not attempt.lines:
                # A model that does not answer at all is a stopped job, not a
                # file of English. Left for a retry, which is a start().
                with self._lock:
                    self._update(job, status="failed", error=attempt.error)
                    self._running = None
                    self._active = None
                return
            with self._lock:
                # The chunk and the state under one lock, so a status read
                # between them cannot see the chunk landed and no rate yet.
                job.chunk_path(first, last).write_text(translate.as_json(attempt), encoding="utf-8")
                # The rate this machine actually manages, for the estimate.
                per_cue = took / max(1, last - first)
                known = job.state.get("seconds_per_cue")
                self._update(
                    job,
                    repaired=int(job.state.get("repaired") or 0) + len(attempt.repaired),
                    unrepaired=sorted(set(job.state.get("unrepaired") or []) | set(attempt.unrepaired)),
                    missing=sorted(set(job.state.get("missing") or []) | set(attempt.missing)),
                    seconds_per_cue=per_cue if known is None else (float(known) * 0.7 + per_cue * 0.3),
                )

        # Then the lines a retry asked for, one at a time. Each lands in its
        # chunk file and comes off the list as it is answered, so a stop in
        # the middle costs the line in flight and nothing else, like a chunk.
        for number in [int(n) for n in job.state.get("retry") or []]:
            if cancel.is_set():
                self._finish(job, "cancelled")
                return
            if self._step_aside(job):
                return
            try:
                said = translator.again(cues, number, floor=0)
            except translate.Cancelled:
                self._finish(job, "cancelled")
                return
            with self._lock:
                if said:
                    job.land(number, said)
                fields: dict[str, Any] = {"retry": [n for n in job.state.get("retry") or [] if int(n) != number]}
                if said:
                    fields["repaired"] = int(job.state.get("repaired") or 0) + 1
                    fields["missing"] = [n for n in job.state.get("missing") or [] if int(n) != number]
                    fields["unrepaired"] = [n for n in job.state.get("unrepaired") or [] if int(n) != number]
                self._update(job, **fields)
        self._finish(job, "done")

    def _update(self, job: Job, **fields: Any) -> None:
        """Write these fields over what is on disk NOW, not over this thread's
        copy. cancel() and start() write the status from other threads while a
        chunk is in flight, and a save of a stale copy after the chunk landed
        would put "running" back over their "cancelled" or "queued". Called
        with the lock held."""
        fresh = self._load(job.key)
        if fresh is not None:
            job.state = fresh.state
        job.state.update(fields)
        job.state["updated_at"] = time.time()
        self._save(job)

    def _finish(self, job: Job, status: str) -> None:
        with self._lock:
            if status != "done":
                # Cancelled, and possibly already asked for again: start()
                # re-queues a cancelled job by writing "queued" to disk, and
                # this thread noticing the cancel afterwards must not write
                # over that, or the restart is lost and the queue pops a job
                # that says it is cancelled.
                fresh = self._load(job.key)
                if fresh is not None and fresh.state.get("status") == "queued":
                    self._running = None
                    self._active = None
                    return
                self._update(job, status=status)
                self._running = None
                self._active = None
                return
            if status == "done":
                cues = job.cues()
                merged = translate.to_cues(cues, job.landed(), 0, len(cues))
                raw = subtitles.to_srt(merged).encode("utf-8")
                source_meta = job.state.get("meta") or {}
                file_id = int(job.state["file_id"])
                stored = self.cache.put_subtitle(
                    file_id,
                    raw,
                    {
                        "file_id": file_id,
                        "file_name": f"{file_id}.srt",
                        "imdb_id": source_meta.get("imdb_id"),
                        "language": job.state["target"],
                        "movie_name": source_meta.get("movie_name"),
                        "release": f"{language_name(job.state['target'])} made from "
                                   f"{job.state['source_language'].upper()} by {job.state['model']}",
                        "season": source_meta.get("season"),
                        "episode": source_meta.get("episode"),
                        "generated": True,
                        "source_id": job.state["source_id"],
                        "source_language": job.state["source_language"],
                        "model": job.state["model"],
                        "unrepaired": len(job.state.get("unrepaired") or []),
                        "missing": len(job.state.get("missing") or []),
                    },
                )
                self._update(
                    job, status="done", sha256=stored.meta.get("sha256"), finished_at=time.time(), retry=[], retry_total=0,
                )
            self._running = None
            self._active = None
            self._cancel.pop(job.key, None)

    # --- disk ------------------------------------------------------------------

    def _translator(self, source_language: str, target: str) -> Any:
        if self.model == translate.GOOGLE_MODEL:
            return translate.GoogleTranslator(key=self.google_key, source=source_language, target=target)
        return translate.Translator(
            model=self.model,
            url=self.url,
            key=self.key,
            source=language_name(source_language),
            target=language_name(target),
            target_code=target.split("-")[0],
            chunk=self.chunk,
        )

    def _load(self, key: str) -> Job | None:
        if not re.fullmatch(r"[A-Za-z0-9-]+", key):
            return None
        root = self.root / key
        path = root / "job.json"
        if not path.exists():
            return None
        try:
            state = json.loads(path.read_text(encoding="utf-8"))
        except ValueError:
            return None
        return Job(key=key, root=root, state=state)

    def _save(self, job: Job) -> None:
        payload = json.dumps(job.state, ensure_ascii=False, indent=2).encode("utf-8")
        path = job.root / "job.json"
        temporary = path.with_name("job.json.writing")
        temporary.write_bytes(payload)
        os.replace(temporary, path)

    def _remove(self, job: Job) -> None:
        for path in sorted(job.root.rglob("*"), reverse=True):
            if path.is_file():
                path.unlink()
            else:
                path.rmdir()
        if job.root.exists():
            job.root.rmdir()

    def _status_of(self, job: Job) -> dict[str, Any]:
        state = job.state
        total = int(state.get("total") or 0)
        done = sum(last - first for first, last in job.done_chunks())
        # While a retry is on, the progress IS the retry's: "3 of 7 lines" is
        # what a reader watching it wants, and 1200 of 1200 says nothing.
        # Done is the whole file again, since that is what the file holds.
        retrying = bool(state.get("retry")) and state.get("status") != "done"
        if retrying:
            total = int(state.get("retry_total") or len(state["retry"]))
            done = total - len(state["retry"])
        rate = state.get("seconds_per_cue")
        remaining = max(0, total - done)
        eta = remaining * (float(rate) if rate else SECONDS_PER_CUE)
        # What a waiting job is waiting for: the running one, or the head of
        # the queue when nothing is running yet. Enough for the panel to say
        # "waiting for S01E01" rather than showing a zero that does not move.
        ahead = None
        if state.get("status") == "queued":
            before = self._running or next((k for k in self._waiting if k != job.key), None)
            other = self._load(before) if before and before != job.key else None
            if other is not None:
                ahead = {
                    "job": other.key,
                    "target": other.state.get("target"),
                    "meta": other.state.get("meta") or {},
                    "total": int(other.state.get("total") or 0),
                    "done": sum(last - first for first, last in other.done_chunks()),
                }
        return {
            "job": job.key,
            "status": state.get("status"),
            "source_id": state.get("source_id"),
            "source_language": state.get("source_language"),
            "target": state.get("target"),
            "model": state.get("model"),
            "total": total,
            "done": done,
            "retrying": retrying,
            "chunks_done": len(job.done_chunks()),
            "chunks_total": len(job.bounds()),
            "eta_seconds": int(eta) if state.get("status") in ("queued", "running") else 0,
            "seconds_per_cue": rate,
            "repaired": int(state.get("repaired") or 0),
            "unrepaired": len(state.get("unrepaired") or []),
            "missing": len(state.get("missing") or []),
            # Only when there is one: every caller of this daemon reads a
            # present "error" key as a failed request.
            **({"error": state["error"]} if state.get("error") else {}),
            "file_id": state.get("file_id") if state.get("status") == "done" else None,
            "generated_file_id": state.get("file_id"),
            "created_at": state.get("created_at"),
            "updated_at": state.get("updated_at"),
            "asked_at": state.get("asked_at") or state.get("created_at"),
            "waiting_for": ahead,
            "meta": state.get("meta") or {},
        }
