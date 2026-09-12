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
over costs the chunk in flight and nothing else". The finished file goes into
the ordinary subtitle cache under a synthetic file_id, with `generated` in its
sidecar, so a later search for the same title finds it the way it finds any
download.

One worker thread, whatever the number of jobs. The default model runs on
this machine and two jobs at once would each run at half speed while the
reader waits for the first; a hosted endpoint would take the parallelism, but
the ordinary case is one episode at a time.

`status()` is what the extension polls, and its `cues` are the whole file with
the translated lines where a chunk has landed and the source text where it has
not - so a reader can attach what exists ten seconds in and watch the Turkish
arrive under the English.
"""

from __future__ import annotations

import json
import logging
import os
import queue
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
                lines[int(entry["n"])] = str(entry["tr"])
        return lines

    def done_chunks(self) -> list[tuple[int, int]]:
        return [(first, last) for first, last in self.bounds() if self.chunk_path(first, last).exists()]


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
        chunk: int = translate.CHUNK,
        translator_factory: Any = None,
    ) -> None:
        self.root = root
        self.cache = cache
        self.model = model or translate.DEFAULT_MODEL
        self.url = url
        self.key = key
        self.chunk = chunk
        # Replaceable so the tests can hand in a Translator whose chat is stubbed.
        self._factory = translator_factory or self._translator
        self.root.mkdir(parents=True, exist_ok=True)
        self._lock = threading.Lock()
        self._queue: queue.Queue[str] = queue.Queue()
        self._cancel: dict[str, threading.Event] = {}
        self._running: str | None = None
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

        Idempotent on (source, target): a job already done answers with its
        file; one queued or running answers with its progress; one that failed
        or was cancelled is picked up where it stopped, since the chunks that
        landed are still on disk.
        """
        target = target.lower()
        key = job_key(source_id, target)
        if not cues:
            return {"error": "nothing to translate"}
        with self._lock:
            job = self._load(key)
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
            elif job.state["status"] == "done" or job.state["status"] in ("queued", "running"):
                return self._status_of(job)
            else:
                job.state["status"] = "queued"
                job.state["error"] = ""
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
            return answer

    def cancel(self, key: str, *, forget: bool = False) -> dict[str, Any]:
        with self._lock:
            job = self._load(key)
            if job is None:
                return {"error": "no such translation"}
            event = self._cancel.get(key)
            if event is not None:
                event.set()
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

    def _enqueue(self, key: str) -> None:
        self._cancel[key] = threading.Event()
        self._queue.put(key)
        if self._worker is None or not self._worker.is_alive():
            self._worker = threading.Thread(target=self._work, name="translate", daemon=True)
            self._worker.start()

    def _work(self) -> None:
        while True:
            key = self._queue.get()
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
            finally:
                self._queue.task_done()

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

        for first, last in job.bounds():
            if cancel.is_set():
                self._finish(job, "cancelled")
                return
            if job.chunk_path(first, last).exists():
                continue
            started = time.monotonic()
            attempt = translator.chunk_lines(cues, first, last, floor=0)
            took = time.monotonic() - started
            if attempt.error and not attempt.lines:
                # A model that does not answer at all is a stopped job, not a
                # file of English. Left for a retry, which is a start().
                with self._lock:
                    self._update(job, status="failed", error=attempt.error)
                    self._running = None
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
                    return
                self._update(job, status=status)
                self._running = None
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
                self._update(job, status="done", sha256=stored.meta.get("sha256"), finished_at=time.time())
            self._running = None
            self._cancel.pop(job.key, None)

    # --- disk ------------------------------------------------------------------

    def _translator(self, source_language: str, target: str) -> translate.Translator:
        return translate.Translator(
            model=self.model,
            url=self.url,
            key=self.key,
            source=language_name(source_language),
            target=language_name(target),
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
        rate = state.get("seconds_per_cue")
        remaining = max(0, total - done)
        eta = remaining * (float(rate) if rate else SECONDS_PER_CUE)
        return {
            "job": job.key,
            "status": state.get("status"),
            "source_id": state.get("source_id"),
            "source_language": state.get("source_language"),
            "target": state.get("target"),
            "model": state.get("model"),
            "total": total,
            "done": done,
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
            "meta": state.get("meta") or {},
        }
