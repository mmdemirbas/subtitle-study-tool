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
from subtitle_daemon.opensubtitles import (
    DownloadResult,
    Feature,
    OpenSubtitlesError,
    QuotaExceededError,
    SearchResult,
)

SRT = (
    b"1\n00:00:01,000 --> 00:00:02,000\nHello\n\n"
    b"2\n00:00:03,000 --> 00:00:04,000\nWorld\n"
)


def make_result(file_id: int, movie_name: str, **overrides: Any) -> SearchResult:
    defaults: dict[str, Any] = {
        "subtitle_id": f"s{file_id}",
        "language": "en",
        "release": f"{movie_name}.1080p",
        "year": None,
        "season": None,
        "episode": None,
        "download_count": 100,
        "from_trusted": True,
        "hearing_impaired": False,
        "fps": 23.976,
        "url": f"https://example.invalid/{file_id}",
    }
    return SearchResult(file_id=file_id, movie_name=movie_name, **{**defaults, **overrides})


class StubClient:
    """Records calls so tests can assert quota was or was not spent."""

    def __init__(self) -> None:
        self.authenticated = True
        self.searches = 0
        self.downloads: list[int] = []
        self.raise_quota = False
        self.results: list[SearchResult] = [
            make_result(42, "Some Movie", release="Some.Release.1080p", year=2001,
                        download_count=999)
        ]
        # Empty by default, so tests exercise the fuzzy-query fallback unless
        # they deliberately populate the title index.
        self.feature_list: list[Feature] = []
        self.feature_lookups = 0
        self.search_calls: list[dict[str, Any]] = []

    def features(self, query: str) -> list[Feature]:
        self.feature_lookups += 1
        return self.feature_list

    def search(self, **kwargs: Any) -> list[SearchResult]:
        self.searches += 1
        self.search_calls.append(kwargs)
        return self.results

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


def test_cache_hit_reproduces_the_whole_envelope(http) -> None:
    """Confidence flags are conclusions about the result set, not decoration.

    Caching only the rows made a replayed low-confidence search look confident,
    which is precisely when the caller must not auto-attach.
    """
    base, stub = http
    stub.feature_list = []
    stub.results = [make_result(1, "Ekusute", release="Ekusute.DVDRip")]

    _status, fresh = _get(base, "/search?query=Crime+101")
    _status, replayed = _get(base, "/search?query=Crime+101")

    assert replayed["from_cache"] is True
    assert stub.searches == 1
    for field in ("low_confidence", "auto_attach_threshold", "results"):
        assert replayed.get(field) == fresh.get(field), field


def test_cache_hit_keeps_the_resolved_title(http) -> None:
    base, stub = http
    stub.feature_list = [make_feature("Sicario", imdb_id="3397884", year=2015)]

    _get(base, "/search?query=Sicario")
    _status, replayed = _get(base, "/search?query=Sicario")

    assert replayed["from_cache"] is True
    assert replayed["resolved"]["imdb_id"] == "3397884"
    assert stub.feature_lookups == 1


# --- match scoring ----------------------------------------------------------


def test_results_carry_a_match_score(http) -> None:
    base, stub = http
    stub.results = [make_result(1, "Crime 101")]
    _status, payload = _get(base, "/search?query=Crime+101")
    assert payload["results"][0]["match_score"] == 1.0
    assert payload["auto_attach_threshold"] > 0


def test_the_crime_101_regression(http) -> None:
    """The exact failure: a Prime Video detail-page title returned unrelated films.

    Both halves are asserted - the query stops carrying the site branding, and
    the unrelated results no longer outrank the real one.
    """
    base, stub = http
    stub.results = [
        make_result(1, "Ekusute", download_count=5000),  # was ranked first
        make_result(2, "Major Crimes", season=1, episode=1, download_count=4000),
        make_result(3, "Crime 101", download_count=3),
    ]
    _status, payload = _get(base, "/search?title=Prime+Video%3A+Crime+101")

    assert payload["guess"]["query"] == "Crime 101", "site branding must be stripped"
    assert payload["results"][0]["movie_name"] == "Crime 101", "despite being least downloaded"
    assert not payload.get("low_confidence")


def test_near_miss_results_stay_visible_but_below_auto_attach(http) -> None:
    """A partial-word match is worth showing, never worth downloading unasked.

    "Major Crimes" shares a word with "Crime 101", so it is a plausible thing
    to offer if the title guess was wrong. What must not happen is auto-attach
    spending quota on it, which is what the threshold - not visibility -
    prevents.
    """
    base, stub = http
    stub.results = [make_result(1, "Major Crimes", season=1, episode=1)]
    _status, payload = _get(base, "/search?query=Crime+101")

    assert payload["results"], "a near miss is still worth offering"
    assert all(r["match_score"] < payload["auto_attach_threshold"] for r in payload["results"])


def test_wholly_unrelated_results_are_flagged_low_confidence(http) -> None:
    base, stub = http
    stub.results = [make_result(1, "Ekusute", release="Ekusute.DVDRip.XviD")]
    _status, payload = _get(base, "/search?query=Crime+101")

    # Nothing resembles the query at all. Results are still returned - the title
    # guess may be what is wrong - but flagged, so the UI does not present junk
    # as an answer.
    assert payload["low_confidence"] is True
    assert all(r["match_score"] < payload["auto_attach_threshold"] for r in payload["results"])


def test_popularity_still_breaks_ties_between_equal_matches(http) -> None:
    base, stub = http
    stub.results = [
        make_result(1, "Crime 101", download_count=10),
        make_result(2, "Crime 101", download_count=900),
    ]
    _status, payload = _get(base, "/search?query=Crime+101")
    assert payload["results"][0]["file_id"] == 2


# --- title resolution --------------------------------------------------------


def make_feature(title: str, **overrides: Any) -> Feature:
    defaults: dict[str, Any] = {
        "imdb_id": "1234567",
        "year": None,
        "feature_type": "Movie",
        "subtitles_count": 20,
    }
    return Feature(title=title, **{**defaults, **overrides})


def test_known_title_is_searched_by_imdb_id_not_by_fuzzy_query(http) -> None:
    base, stub = http
    stub.feature_list = [make_feature("Sicario", imdb_id="3397884", year=2015)]
    _status, payload = _get(base, "/search?query=Sicario")

    assert stub.feature_lookups == 1
    assert stub.search_calls[0]["imdb_id"] == "3397884"
    assert "query" not in stub.search_calls[0] or not stub.search_calls[0].get("query")
    assert payload["resolved"]["imdb_id"] == "3397884"


def test_series_is_searched_by_parent_id_with_season_and_episode(http) -> None:
    base, stub = http
    stub.feature_list = [
        make_feature("Battlestar Galactica", imdb_id="407362", feature_type="Tvshow")
    ]
    _get(base, "/search?query=Battlestar+Galactica&season=1&episode=3")

    call = stub.search_calls[0]
    assert call["parent_imdb_id"] == "407362"
    assert (call["season"], call["episode"]) == (1, 3)


def test_unknown_title_falls_back_to_a_type_filtered_query(http) -> None:
    base, stub = http
    stub.feature_list = []  # index has never heard of it
    _get(base, "/search?query=Crime+101")

    call = stub.search_calls[0]
    assert call["query"] == "Crime 101"
    # Without a type filter a film search drowns in episodes sharing a word.
    assert call["media_type"] == "movie"


def test_title_absent_from_the_database_is_reported_as_such(http) -> None:
    """The Crime 101 case: not a bad query, a film OpenSubtitles does not have.

    Saying so beats returning near-miss episodes, because no amount of
    retyping the title will ever produce a result.
    """
    base, stub = http
    stub.feature_list = []
    stub.results = []
    _status, payload = _get(base, "/search?query=Crime+101")

    assert payload["not_in_database"] is True
    assert "no subtitles" in payload["error"].lower()
    assert payload["results"] == []


def test_features_failure_degrades_to_fuzzy_search(http) -> None:
    base, stub = http

    def boom(_query: str):
        raise OpenSubtitlesError("features endpoint down")

    stub.features = boom  # type: ignore[assignment]
    _status, payload = _get(base, "/search?query=Sicario")

    # The index is precision, not a dependency: losing it must not lose search.
    assert payload["results"]
    assert stub.searches >= 1


def test_feature_with_no_subtitles_is_not_used(http) -> None:
    base, stub = http
    stub.feature_list = [make_feature("Sicario", imdb_id="3397884", subtitles_count=0)]
    _get(base, "/search?query=Sicario")

    # Resolving to a title with zero subtitles would turn a findable film into
    # an empty result.
    assert "imdb_id" not in stub.search_calls[0]


def test_requested_episode_outranks_a_more_popular_wrong_one(http) -> None:
    """Series results all score identically on title, so episode must decide.

    Mislabelled uploads are common; without this the most-downloaded episode of
    the show wins regardless of which one was asked for.
    """
    base, stub = http
    stub.results = [
        make_result(1, "Battlestar Galactica", season=1, episode=8, download_count=9000),
        make_result(2, "Battlestar Galactica", season=1, episode=3, download_count=12),
    ]
    _status, payload = _get(base, "/search?query=Battlestar+Galactica&season=1&episode=3")
    assert payload["results"][0]["file_id"] == 2


def test_results_without_episode_metadata_sort_between_match_and_mismatch(http) -> None:
    base, stub = http
    stub.results = [
        make_result(1, "Show", season=1, episode=9, download_count=9000),  # wrong episode
        make_result(2, "Show", download_count=10),  # says nothing
        make_result(3, "Show", season=1, episode=3, download_count=5),  # right episode
    ]
    _status, payload = _get(base, "/search?query=Show&season=1&episode=3")
    assert [r["file_id"] for r in payload["results"]] == [3, 2, 1]


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
