"""HTTP surface for the daemon.

Bound to loopback only. That is most of the security story, but not all of it:
any page you visit can issue requests to 127.0.0.1, so a wide-open CORS policy
would let an arbitrary website spend your OpenSubtitles quota and read your
cache. Hence the origin allowlist below - browser extensions, localhost pages,
and `file://` (which sends `Origin: null`) are permitted, everything else is
refused before any work is done.

Endpoints:
    GET  /health                  daemon and credential status
    GET  /search?title=...        guess a title and search; never costs quota
    POST /fetch  {"file_id": N}   download-or-serve-from-cache; may cost quota
    GET  /cached                  what is already on disk
    GET  /cached/{file_id}        cues for a cached subtitle
"""

from __future__ import annotations

import json
import logging
import re
import threading
from http import HTTPStatus
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from typing import Any
from urllib.parse import parse_qs, urlparse

from . import subtitles, titles
from .cache import Cache
from .config import CACHE_DIR, Config
from .opensubtitles import Client, OpenSubtitlesError, QuotaExceededError

logger = logging.getLogger(__name__)

# Origins allowed to talk to the daemon. Loopback binding stops other machines;
# this stops other *pages* on this machine.
_ALLOWED_ORIGIN = re.compile(
    r"""^(?:
        chrome-extension://[a-z]+
      | moz-extension://[0-9a-f-]+
      | safari-web-extension://[0-9A-Fa-f-]+
      | https?://(?:localhost|127\.0\.0\.1)(?::\d+)?
      | null
    )$""",
    re.VERBOSE,
)

MAX_BODY_BYTES = 64 * 1024


class Service:
    """Everything the request handlers need, assembled once at startup."""

    def __init__(self, config: Config) -> None:
        self.config = config
        self.cache = Cache(CACHE_DIR)
        self.client = Client(config.api_key) if config.has_api_key else None
        self._lock = threading.Lock()

        if self.client and config.can_login:
            self.client.login(config.username or "", config.password or "")

    # --- operations ---------------------------------------------------------

    def health(self) -> dict[str, Any]:
        return {
            "ok": True,
            "has_api_key": self.config.has_api_key,
            "authenticated": bool(self.client and self.client.authenticated),
            "default_languages": list(self.config.default_languages),
            "cached_subtitles": len(self.cache.list_subtitles()),
        }

    def search(self, params: dict[str, list[str]]) -> dict[str, Any]:
        """Guess what is playing and find candidate subtitles.

        Accepts either a raw page `title` to be parsed, or an explicit `query`
        that bypasses the guesser - which is what the extension sends once the
        user has corrected a bad guess.
        """
        raw_title = _first(params, "title") or ""
        explicit = _first(params, "query")

        guessed = titles.guess(raw_title)
        query = explicit or guessed.query
        year = _first_int(params, "year") or (None if explicit else guessed.year)
        season = _first_int(params, "season")
        episode = _first_int(params, "episode")
        if season is None and episode is None and not explicit:
            season, episode = guessed.season, guessed.episode

        languages = _languages(params, self.config.default_languages)
        imdb_id = _first(params, "imdb_id")

        response: dict[str, Any] = {
            "guess": {
                "query": guessed.query,
                "year": guessed.year,
                "season": guessed.season,
                "episode": guessed.episode,
            },
            "used": {
                "query": query,
                "year": year,
                "season": season,
                "episode": episode,
                "languages": list(languages),
            },
            "results": [],
        }

        if not query:
            response["error"] = "no searchable title; type one in"
            return response
        if not self.client:
            response["error"] = "no OpenSubtitles API key configured"
            return response

        key = _cache_key(query, languages, year, season, episode, imdb_id)
        cached = self.cache.get_search(key)
        if cached is not None:
            response["results"] = cached
            response["from_cache"] = True
            return response

        try:
            found = self.client.search(
                query=query,
                languages=languages,
                year=year,
                season=season,
                episode=episode,
                imdb_id=imdb_id,
            )
        except OpenSubtitlesError as err:
            response["error"] = str(err)
            return response

        results = [item.as_dict() for item in found]
        # Mark what is already downloaded so the UI can show a free choice.
        on_disk = {item.file_id for item in self.cache.list_subtitles()}
        for item in results:
            item["cached"] = item["file_id"] in on_disk

        self.cache.put_search(key, results)
        response["results"] = results
        return response

    def fetch(self, body: dict[str, Any]) -> dict[str, Any]:
        """Return cues for a file_id, downloading only if not already cached."""
        file_id = body.get("file_id")
        if not isinstance(file_id, int):
            return {"error": "file_id must be an integer"}

        cached = self.cache.get_subtitle(file_id)
        if cached is not None:
            return _cues_response(cached.read_bytes(), dict(cached.meta), from_cache=True)

        if not self.client:
            return {"error": "no OpenSubtitles API key configured"}

        # Serialised: two tabs asking for the same subtitle at once would
        # otherwise spend two units of a ten-per-day quota on one file.
        with self._lock:
            cached = self.cache.get_subtitle(file_id)
            if cached is not None:
                return _cues_response(cached.read_bytes(), dict(cached.meta), from_cache=True)

            try:
                downloaded = self.client.download(file_id)
            except QuotaExceededError as err:
                return {"error": str(err), "quota_exceeded": True}
            except OpenSubtitlesError as err:
                return {"error": str(err)}

            meta: dict[str, Any] = {
                "file_id": file_id,
                "file_name": downloaded.file_name,
                "remaining_quota": downloaded.remaining,
            }
            stored = self.cache.put_subtitle(file_id, downloaded.content, meta)

        if downloaded.remaining is not None:
            logger.info("Downloaded %s; %s downloads left today", downloaded.file_name,
                        downloaded.remaining)

        return _cues_response(stored.read_bytes(), dict(stored.meta), from_cache=False)

    def cached_list(self) -> dict[str, Any]:
        return {
            "subtitles": [
                {"file_id": item.file_id, **item.meta} for item in self.cache.list_subtitles()
            ]
        }

    def cached_one(self, file_id: int) -> dict[str, Any]:
        cached = self.cache.get_subtitle(file_id)
        if cached is None:
            return {"error": "not cached"}
        return _cues_response(cached.read_bytes(), dict(cached.meta), from_cache=True)


def serve(config: Config) -> None:
    """Run the daemon until interrupted."""
    service = Service(config)

    class Handler(_Handler):
        pass

    Handler.service = service

    server = ThreadingHTTPServer(("127.0.0.1", config.port), Handler)
    logger.info("subtitle-daemon listening on http://127.0.0.1:%d", config.port)
    if not config.has_api_key:
        logger.warning(
            "No OpenSubtitles API key configured - search and download are disabled. "
            "Create one at https://www.opensubtitles.com/en/consumers and put it in "
            "subtitle-daemon/config.local.json"
        )
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        logger.info("shutting down")
    finally:
        server.server_close()


class _Handler(BaseHTTPRequestHandler):
    """Routes requests to `Service`. One instance per request, as usual."""

    service: Service
    server_version = "subtitle-daemon/0.1"

    def do_OPTIONS(self) -> None:  # noqa: N802 - name fixed by BaseHTTPRequestHandler
        origin = self.headers.get("Origin")
        if origin and not _ALLOWED_ORIGIN.match(origin):
            self._send(HTTPStatus.FORBIDDEN, {"error": "origin not allowed"})
            return
        self.send_response(HTTPStatus.NO_CONTENT)
        self._cors_headers(origin)
        self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")
        self.send_header("Access-Control-Max-Age", "600")
        self.end_headers()

    def do_GET(self) -> None:  # noqa: N802
        if not self._origin_ok():
            return
        parsed = urlparse(self.path)
        params = parse_qs(parsed.query)

        if parsed.path == "/health":
            self._send(HTTPStatus.OK, self.service.health())
        elif parsed.path == "/search":
            self._send(HTTPStatus.OK, self.service.search(params))
        elif parsed.path == "/cached":
            self._send(HTTPStatus.OK, self.service.cached_list())
        elif match := re.fullmatch(r"/cached/(\d+)", parsed.path):
            self._send(HTTPStatus.OK, self.service.cached_one(int(match.group(1))))
        else:
            self._send(HTTPStatus.NOT_FOUND, {"error": "no such endpoint"})

    def do_POST(self) -> None:  # noqa: N802
        if not self._origin_ok():
            return
        parsed = urlparse(self.path)
        if parsed.path != "/fetch":
            self._send(HTTPStatus.NOT_FOUND, {"error": "no such endpoint"})
            return

        try:
            length = int(self.headers.get("Content-Length") or 0)
        except ValueError:
            self._send(HTTPStatus.BAD_REQUEST, {"error": "bad Content-Length"})
            return
        if length > MAX_BODY_BYTES:
            self._send(HTTPStatus.REQUEST_ENTITY_TOO_LARGE, {"error": "body too large"})
            return

        try:
            body = json.loads(self.rfile.read(length) or b"{}")
        except (ValueError, OSError):
            self._send(HTTPStatus.BAD_REQUEST, {"error": "body must be JSON"})
            return
        if not isinstance(body, dict):
            self._send(HTTPStatus.BAD_REQUEST, {"error": "body must be a JSON object"})
            return

        self._send(HTTPStatus.OK, self.service.fetch(body))

    def log_message(self, fmt: str, *args: Any) -> None:
        # Route through logging instead of BaseHTTPRequestHandler's stderr writes.
        logger.debug("%s - %s", self.address_string(), fmt % args)

    # --- helpers ------------------------------------------------------------

    def _origin_ok(self) -> bool:
        origin = self.headers.get("Origin")
        # No Origin header means a direct call (curl, the address bar), not a
        # cross-site request. Those are the user's own, so allow them.
        if origin is None or _ALLOWED_ORIGIN.match(origin):
            return True
        self._send(HTTPStatus.FORBIDDEN, {"error": "origin not allowed"})
        return False

    def _cors_headers(self, origin: str | None) -> None:
        self.send_header("Access-Control-Allow-Origin", origin or "*")
        self.send_header("Vary", "Origin")

    def _send(self, status: HTTPStatus, payload: dict[str, Any]) -> None:
        raw = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(raw)))
        self._cors_headers(self.headers.get("Origin"))
        self.end_headers()
        self.wfile.write(raw)


def _cues_response(raw: bytes, meta: dict[str, Any], *, from_cache: bool) -> dict[str, Any]:
    text, encoding = subtitles.decode(raw)
    cues = subtitles.parse_srt(text)
    return {
        "meta": {**meta, "encoding": encoding, "cue_count": len(cues)},
        "cues": subtitles.to_json(cues),
        "vtt": subtitles.to_vtt(cues),
        "from_cache": from_cache,
    }


def _cache_key(
    query: str,
    languages: tuple[str, ...],
    year: int | None,
    season: int | None,
    episode: int | None,
    imdb_id: str | None,
) -> str:
    parts = [query.lower(), ",".join(sorted(languages)), str(year), str(season), str(episode),
             str(imdb_id)]
    return re.sub(r"[^a-z0-9]+", "_", "|".join(parts).lower())[:120]


def _first(params: dict[str, list[str]], key: str) -> str | None:
    values = params.get(key)
    return values[0].strip() if values and values[0].strip() else None


def _first_int(params: dict[str, list[str]], key: str) -> int | None:
    value = _first(params, key)
    if value is None:
        return None
    try:
        return int(value)
    except ValueError:
        return None


def _languages(params: dict[str, list[str]], default: tuple[str, ...]) -> tuple[str, ...]:
    raw = _first(params, "languages")
    if not raw:
        return default
    parsed = tuple(part.strip().lower() for part in raw.split(",") if part.strip())
    return parsed or default
