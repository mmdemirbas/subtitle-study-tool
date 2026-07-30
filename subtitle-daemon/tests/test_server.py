"""End-to-end tests over the real HTTP surface.

The daemon is bound to loopback, but any page you visit can still reach
127.0.0.1, so the origin allowlist is a genuine trust boundary: it is what
stops an arbitrary website from spending your download quota. It gets tested
here rather than by inspection.

A stub stands in for the OpenSubtitles client so no test can make a network
call or consume real quota.
"""

from __future__ import annotations

import json
import threading
import urllib.error
import urllib.request
from collections.abc import Iterator
from dataclasses import replace
from http.server import ThreadingHTTPServer
from pathlib import Path
from typing import Any

import pytest

from subtitle_daemon import server as server_module
from subtitle_daemon.cache import Cache
from subtitle_daemon.config import Config
from subtitle_daemon.opensubtitles import DownloadResult, QuotaExceededError, SearchResult

SRT = (
    b"1\n00:00:01,000 --> 00:00:02,000\nHello\n\n"
    b"2\n00:00:03,000 --> 00:00:04,000\nWorld\n"
)


class StubClient:
    """Records calls so tests can assert quota was or was not spent."""

    def __init__(self) -> None:
        self.authenticated = True
        self.searches = 0
        self.downloads: list[int] = []
        self.raise_quota = False

    def search(self, **kwargs: Any) -> list[SearchResult]:
        self.searches += 1
        return [
            SearchResult(
                file_id=42,
                subtitle_id="s42",
                language="en",
                release="Some.Release.1080p",
                movie_name="Some Movie",
                year=2001,
                season=None,
                episode=None,
                download_count=999,
                from_trusted=True,
                hearing_impaired=False,
                fps=23.976,
                url="https://example.invalid/42",
            )
        ]

    def download(self, file_id: int) -> DownloadResult:
        if self.raise_quota:
            raise QuotaExceededError("daily download limit reached")
        self.downloads.append(file_id)
        return DownloadResult(content=SRT, file_name="some.srt", remaining=7)


@pytest.fixture
def service(tmp_path: Path) -> Iterator[tuple[server_module.Service, StubClient]]:
    config = Config(
        api_key="test-key",
        username=None,
        password=None,
        default_languages=("en",),
        port=0,
    )
    svc = server_module.Service.__new__(server_module.Service)
    svc.config = config
    svc.cache = Cache(tmp_path)
    stub = StubClient()
    svc.client = stub  # type: ignore[assignment]  # structural stand-in for Client
    svc._lock = threading.Lock()
    yield svc, stub


@pytest.fixture
def http(service: tuple[server_module.Service, StubClient]) -> Iterator[tuple[str, StubClient]]:
    svc, stub = service

    class Handler(server_module._Handler):
        pass

    Handler.service = svc
    httpd = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    # Small poll interval so shutdown() returns promptly; the default 0.5s is
    # paid once per test and dominates the suite.
    thread = threading.Thread(target=lambda: httpd.serve_forever(poll_interval=0.01), daemon=True)
    thread.start()
    try:
        yield f"http://127.0.0.1:{httpd.server_address[1]}", stub
    finally:
        httpd.shutdown()
        httpd.server_close()
        thread.join(timeout=5)


def _get(base: str, path: str, origin: str | None = None) -> tuple[int, dict[str, Any]]:
    request = urllib.request.Request(f"{base}{path}")
    if origin:
        request.add_header("Origin", origin)
    try:
        with urllib.request.urlopen(request, timeout=5) as response:
            return response.status, json.loads(response.read())
    except urllib.error.HTTPError as err:
        return err.code, json.loads(err.read() or b"{}")


def _post(base: str, path: str, body: dict[str, Any], origin: str | None = None):
    request = urllib.request.Request(
        f"{base}{path}", data=json.dumps(body).encode(), method="POST"
    )
    request.add_header("Content-Type", "application/json")
    if origin:
        request.add_header("Origin", origin)
    try:
        with urllib.request.urlopen(request, timeout=5) as response:
            return response.status, json.loads(response.read())
    except urllib.error.HTTPError as err:
        return err.code, json.loads(err.read() or b"{}")


# --- routing ----------------------------------------------------------------


def test_health_reports_configuration(http) -> None:
    base, _ = http
    status, payload = _get(base, "/health")
    assert status == 200
    assert payload["ok"] is True
    assert payload["has_api_key"] is True
    assert payload["default_languages"] == ["en"]


def test_unknown_endpoint_is_404(http) -> None:
    base, _ = http
    status, _payload = _get(base, "/nope")
    assert status == 404


def test_search_parses_the_page_title(http) -> None:
    base, stub = http
    status, payload = _get(base, "/search?title=Sicario.2015.1080p.BluRay.x264-SPARKS")
    assert status == 200
    assert payload["guess"]["query"] == "Sicario"
    assert payload["guess"]["year"] == 2015
    assert payload["results"][0]["file_id"] == 42
    assert stub.searches == 1


def test_search_with_no_title_does_not_call_the_api(http) -> None:
    base, stub = http
    _status, payload = _get(base, "/search?title=")
    assert "error" in payload
    assert stub.searches == 0


def test_repeat_search_is_served_from_cache(http) -> None:
    base, stub = http
    _get(base, "/search?title=The+Matrix")
    _status, payload = _get(base, "/search?title=The+Matrix")
    assert payload.get("from_cache") is True
    assert stub.searches == 1, "second identical search should not hit the API"


# --- quota ------------------------------------------------------------------


def test_fetch_downloads_once_then_serves_from_disk(http) -> None:
    base, stub = http
    status, first = _post(base, "/fetch", {"file_id": 42})
    assert status == 200
    assert first["from_cache"] is False
    assert [cue["text"] for cue in first["cues"]] == ["Hello", "World"]
    assert first["vtt"].startswith("WEBVTT")

    _status, second = _post(base, "/fetch", {"file_id": 42})
    assert second["from_cache"] is True
    assert stub.downloads == [42], "cached subtitle must not spend quota again"


def test_quota_exhaustion_is_reported_distinctly(http) -> None:
    base, stub = http
    stub.raise_quota = True
    _status, payload = _post(base, "/fetch", {"file_id": 99})
    assert payload["quota_exceeded"] is True
    assert "limit" in payload["error"].lower()


def test_fetch_rejects_non_integer_file_id(http) -> None:
    base, stub = http
    _status, payload = _post(base, "/fetch", {"file_id": "42"})
    assert "error" in payload
    assert stub.downloads == []


def test_fetch_rejects_oversized_body(http) -> None:
    base, _ = http
    status, _payload = _post(base, "/fetch", {"file_id": 1, "pad": "x" * 70_000})
    assert status == 413


# --- origin allowlist -------------------------------------------------------


@pytest.mark.parametrize(
    "origin",
    [
        "chrome-extension://abcdefghijklmnopabcdefghijklmnop",
        "moz-extension://0f1e2d3c-4b5a-6978-8796-a5b4c3d2e1f0",
        "http://localhost:8000",
        "http://127.0.0.1:5500",
        "null",
    ],
)
def test_allowed_origins_may_call_the_daemon(http, origin: str) -> None:
    base, _ = http
    status, _payload = _get(base, "/health", origin=origin)
    assert status == 200


@pytest.mark.parametrize(
    "origin",
    [
        "https://evil.example",
        "http://attacker.test",
        "https://localhost.evil.example",
        "http://127.0.0.1.evil.example",
    ],
)
def test_foreign_origins_are_refused_before_any_work(http, origin: str) -> None:
    base, stub = http
    status, payload = _get(base, "/search?title=The+Matrix", origin=origin)
    assert status == 403
    assert payload["error"] == "origin not allowed"
    assert stub.searches == 0, "a refused origin must not reach the API"


def test_foreign_origin_cannot_spend_quota(http) -> None:
    base, stub = http
    status, _payload = _post(base, "/fetch", {"file_id": 42}, origin="https://evil.example")
    assert status == 403
    assert stub.downloads == []


def test_request_without_origin_is_allowed(http) -> None:
    # curl and the address bar send no Origin; those are the user's own calls.
    base, _ = http
    status, _payload = _get(base, "/health")
    assert status == 200
