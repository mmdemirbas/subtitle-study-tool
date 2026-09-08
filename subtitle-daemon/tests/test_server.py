"""End-to-end tests over the real HTTP surface.

The daemon is bound to loopback, but any page you visit can still reach
127.0.0.1, so the origin allowlist is a genuine trust boundary: it is what
stops an arbitrary website from spending your download quota. It gets tested
here rather than by inspection.

A stub stands in for the OpenSubtitles client so no test can make a network
call or consume real quota.
"""

from __future__ import annotations

import base64
import http.client as http_client
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
from subtitle_daemon.lookups import Lookups
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
        "foreign_parts_only": False,
        "machine_translated": False,
        "ai_translated": False,
        "ratings": None,
        "votes": 0,
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
    svc.lookups = Lookups(tmp_path)
    stub = StubClient()
    svc.client = stub  # type: ignore[assignment]  # structural stand-in for Client
    svc._lock = threading.Lock()
    svc._measured = {}
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


def test_lookup_is_routed_and_costs_no_quota(http) -> None:
    """The route exists, answers, and never touches the OpenSubtitles client.

    A phrase is used deliberately: it is answered without a network call of any
    kind, so this stays a test of the routing rather than of the dictionary.
    """
    base, client = http
    status, payload = _get(base, "/lookup?q=give%20it%20a%20rest&lang=en")
    assert status == 200
    assert payload["query"] == "give it a rest"
    assert payload["definitions"] == []
    assert "Phrases" in payload["unavailable"]
    assert client.downloads == [], "a lookup spent download quota"


def test_lookup_refuses_an_origin_that_is_not_allowed(http) -> None:
    """Same trust boundary as everything else: a page cannot use the daemon."""
    base, _ = http
    status, _payload = _get(base, "/lookup?q=warrant", origin="https://evil.example")
    assert status == 403


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


def test_the_mercy_regression(http) -> None:
    """A common title cannot be resolved on title similarity alone.

    "Mercy" matches 18 entries in the index exactly, so every one scores 1.0
    and whatever breaks the tie IS the answer. Breaking it on subtitle count
    chose a 2016 television episode for a 2025 film. A film page with no season
    or episode wants a Movie, and the year decides among the films.
    """
    base, stub = http
    stub.feature_list = [
        # What used to win: most-subtitled entry sharing the name.
        make_feature("mercy", imdb_id="4793696", year=2016,
                     feature_type="Episode", subtitles_count=258),
        make_feature("mercy", imdb_id="6156390", year=2017,
                     feature_type="Episode", subtitles_count=203),
        make_feature("mercy", imdb_id="2481496", year=2014,
                     feature_type="Movie", subtitles_count=65),
        # The film actually playing. Listed as 2026 upstream, 2025 on the page.
        make_feature("mercy", imdb_id="31050594", year=2026,
                     feature_type="Movie", subtitles_count=201),
    ]
    _status, payload = _get(base, "/search?query=Mercy&year=2025&languages=en")

    assert payload["resolved"]["imdb_id"] == "31050594"
    assert payload["resolved"]["type"] == "Movie"


def test_a_film_page_prefers_films_over_episodes(http) -> None:
    base, stub = http
    stub.feature_list = [
        make_feature("mercy", imdb_id="1", feature_type="Episode", subtitles_count=900),
        make_feature("mercy", imdb_id="2", feature_type="Movie", subtitles_count=5),
    ]
    _status, payload = _get(base, "/search?query=Mercy")
    assert payload["resolved"]["imdb_id"] == "2", "no episode number means a film"


def test_an_episode_search_still_prefers_series(http) -> None:
    base, stub = http
    stub.feature_list = [
        make_feature("mercy", imdb_id="1", feature_type="Movie", subtitles_count=900),
        make_feature("mercy", imdb_id="2", feature_type="Tvshow", subtitles_count=5),
    ]
    _status, payload = _get(base, "/search?query=Mercy&season=1&episode=2")
    assert payload["resolved"]["imdb_id"] == "2"


def test_year_is_a_preference_not_a_filter(http) -> None:
    """Release years disagree between festival, wide release and region.

    Prime lists the film as 2025 and OpenSubtitles as 2026. Filtering on an
    exact year would reject the correct entry, so a year within one still
    counts as agreement.
    """
    base, stub = http
    stub.feature_list = [
        make_feature("mercy", imdb_id="off-by-one", year=2026,
                     feature_type="Movie", subtitles_count=10),
        make_feature("mercy", imdb_id="far-off", year=2009,
                     feature_type="Movie", subtitles_count=900),
    ]
    _status, payload = _get(base, "/search?query=Mercy&year=2025")
    assert payload["resolved"]["imdb_id"] == "off-by-one"


def test_an_exact_year_beats_an_adjacent_one(http) -> None:
    base, stub = http
    stub.feature_list = [
        make_feature("mercy", imdb_id="adjacent", year=2026,
                     feature_type="Movie", subtitles_count=900),
        make_feature("mercy", imdb_id="exact", year=2025,
                     feature_type="Movie", subtitles_count=1),
    ]
    _status, payload = _get(base, "/search?query=Mercy&year=2025")
    assert payload["resolved"]["imdb_id"] == "exact"


def test_indistinguishable_titles_are_reported_not_silently_chosen(http) -> None:
    """With no year, several films of the same name are a genuine coin toss."""
    base, stub = http
    stub.feature_list = [
        make_feature("mercy", imdb_id="a", year=2026, feature_type="Movie",
                     subtitles_count=201),
        make_feature("mercy", imdb_id="b", year=2014, feature_type="Movie",
                     subtitles_count=65),
    ]
    _status, payload = _get(base, "/search?query=Mercy")

    assert payload["ambiguous_title"] is True
    assert [o["imdb_id"] for o in payload["other_titles"]] == ["b"]


def test_a_year_removes_the_ambiguity(http) -> None:
    base, stub = http
    stub.feature_list = [
        make_feature("mercy", imdb_id="a", year=2026, feature_type="Movie",
                     subtitles_count=201),
        make_feature("mercy", imdb_id="b", year=2014, feature_type="Movie",
                     subtitles_count=65),
    ]
    _status, payload = _get(base, "/search?query=Mercy&year=2025")
    assert not payload.get("ambiguous_title")


def test_ambiguity_survives_a_cache_hit(http) -> None:
    base, stub = http
    stub.feature_list = [
        make_feature("mercy", imdb_id="a", feature_type="Movie", subtitles_count=9),
        make_feature("mercy", imdb_id="b", feature_type="Movie", subtitles_count=8),
    ]
    _get(base, "/search?query=Mercy")
    _status, replayed = _get(base, "/search?query=Mercy")
    assert replayed["from_cache"] is True
    assert replayed["ambiguous_title"] is True
    assert replayed["other_titles"]


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


def test_download_records_which_film_the_file_belongs_to(http) -> None:
    base, _ = http
    _post(base, "/fetch", {
        "file_id": 42, "imdb_id": "3397884", "language": "en",
        "movie_name": "Sicario", "release": "Sicario.2015.1080p",
    })
    _status, payload = _get(base, "/cached")
    [entry] = payload["subtitles"]
    assert entry["imdb_id"] == "3397884"
    assert entry["language"] == "en"
    assert entry["sha256"]


def test_a_cached_subtitle_for_the_title_is_offered_first(http) -> None:
    """The actual quota saver.

    file_id caching alone only stops re-downloading the *same upload*. The same
    film is on OpenSubtitles many times over, so a later search that ranks a
    different upload first would spend a download on a subtitle already held.
    """
    base, stub = http
    stub.feature_list = [make_feature("Sicario", imdb_id="3397884", year=2015)]

    # Already downloaded: a modest upload of this film.
    _post(base, "/fetch", {"file_id": 42, "imdb_id": "3397884", "language": "en"})

    # A later search turns up a far more popular different upload.
    stub.results = [
        make_result(999, "Sicario", download_count=90000),
        make_result(42, "Sicario", download_count=3),
    ]
    _status, payload = _get(base, "/search?query=Sicario&languages=en")

    assert payload["results"][0]["file_id"] == 42, "the one we already have comes first"
    assert payload["results"][0]["cached"] is True
    assert payload["reusing_cached"] is True


def test_a_result_already_on_disk_says_how_much_is_in_it(http) -> None:
    """A search result says how often a file was downloaded and nothing about
    what is in it, and two uploads of one film are routinely not the same
    subtitle - one carries every line, another only the foreign-language parts.
    For a file already held the answer costs a disk read, so it is given. For
    one that is not, it would cost a metered download, so it is not: spending a
    download to judge a subtitle costs the reader the thing they are choosing
    between.
    """
    base, stub = http
    stub.feature_list = [make_feature("Sicario", imdb_id="3397884", year=2015)]
    stub.results = [make_result(999, "Sicario"), make_result(42, "Sicario")]

    _post(base, "/fetch", {"file_id": 42, "imdb_id": "3397884", "language": "en"})
    _status, found = _get(base, "/search?query=Sicario&languages=en")

    held = next(item for item in found["results"] if item["file_id"] == 42)
    # SRT above is two cues, "Hello" and "World".
    assert held["lines"] == 2
    assert held["words"] == 2

    missing = next(item for item in found["results"] if item["file_id"] == 999)
    assert "lines" not in missing, "a file not on disk was measured, which costs a download"


def test_a_title_the_index_holds_under_another_name_is_still_found(http) -> None:
    """A film has one title per country, and each upload carries whichever one
    the uploader typed.

    Reported: searching "Once Upon a Crime" for Turkish subtitles returns far
    fewer results than searching the Turkish name of the same film. Any other
    name for the programme is a second way into the index, and once one of them
    resolves everything after it runs on an IMDb id, where the language of the
    title stops mattering at all.
    """
    base, stub = http
    asked: list[str] = []

    def features(query: str):
        asked.append(query)
        # The index has never heard of the English name.
        if query == "Suclu Bir Zamanlar":
            return [make_feature("Suclu Bir Zamanlar", imdb_id="104084", year=1992)]
        return []

    stub.features = features  # type: ignore[assignment]
    stub.results = [make_result(7, "Suclu Bir Zamanlar", release="Suclu.1992.DVDRip")]

    _status, found = _get(
        base,
        "/search?query=Once+Upon+a+Crime&alt=Suclu+Bir+Zamanlar&languages=tr",
    )

    assert asked == ["Once Upon a Crime", "Suclu Bir Zamanlar"], (
        f"the other name was not tried, or was tried first: {asked}"
    )
    assert found["resolved"]["imdb_id"] == "104084"
    assert [item["file_id"] for item in found["results"]] == [7]
    # And it is not marked a weak match. The row carries the name the page gave
    # as an alternative, not the one that was typed, and scoring it against the
    # typed name alone would rank the right answer below a wrong one.
    assert found["results"][0]["match_score"] >= found["auto_attach_threshold"]
    assert not found.get("low_confidence")


def test_a_search_with_no_other_names_makes_the_calls_it_always_made(http) -> None:
    """The alternative names are additive. A page that states none has to
    produce exactly the request set it produced before they existed."""
    base, stub = http
    _status, _found = _get(base, "/search?query=Sicario&languages=en")
    assert stub.feature_lookups == 1
    assert len(stub.search_calls) == 1


def test_a_replayed_search_knows_what_has_been_downloaded_since(http) -> None:
    """The order this searched in six hours ago is not evidence about the cache.

    A search envelope is kept for six hours because searching upstream is slow,
    not because its answer is timeless. Two things in it are facts about the
    download cache rather than about the search: which results are already held,
    and the reordering that floats a held file to the top. Frozen into the
    envelope, they go stale the moment anything is downloaded - and then a
    replay ranks a different upload of the same film first and auto-attach
    spends one of ten daily downloads on a subtitle already on disk.
    """
    base, stub = http
    stub.feature_list = [make_feature("Sicario", imdb_id="3397884", year=2015)]
    stub.results = [
        make_result(999, "Sicario", download_count=90000),
        make_result(42, "Sicario", download_count=3),
    ]

    # Search first, while nothing is held. The popular upload ranks first.
    _status, first = _get(base, "/search?query=Sicario&languages=en")
    assert first["results"][0]["file_id"] == 999
    assert first["results"][0]["cached"] is False

    # Then take the other one - which is what the panel is for.
    _post(base, "/fetch", {"file_id": 42, "imdb_id": "3397884", "language": "en"})

    # The same search again, inside the six hours, so it is replayed.
    _status, replayed = _get(base, "/search?query=Sicario&languages=en")
    assert replayed["from_cache"] is True
    assert replayed["results"][0]["file_id"] == 42, "the held file must still come first"
    assert replayed["reusing_cached"] is True
    assert {item["file_id"]: item["cached"] for item in replayed["results"]} == {
        42: True,
        999: False,
    }


def test_a_replayed_search_forgets_a_promotion_that_no_longer_applies(service) -> None:
    """The re-derivation runs in both directions, not only downwards.

    Deleting a subtitle from the cache folder is a normal thing to do. If the
    envelope kept the promotion it was stored with, the search would keep
    claiming to hold a file that is gone.
    """
    svc, stub = service
    stub.feature_list = [make_feature("Sicario", imdb_id="3397884")]
    stub.results = [
        make_result(999, "Sicario", download_count=90000),
        make_result(42, "Sicario", download_count=3),
    ]

    svc.fetch({"file_id": 42, "imdb_id": "3397884", "language": "en"})
    first = svc.search({"query": ["Sicario"], "languages": ["en"]})
    assert first["reusing_cached"] is True
    assert first["results"][0]["file_id"] == 42

    # Clear the folder the way a person would.
    for held in svc.cache.list_subtitles():
        held.path.unlink()
        held.path.with_suffix(".json").unlink()

    replayed = svc.search({"query": ["Sicario"], "languages": ["en"]})
    assert replayed["from_cache"] is True
    assert not replayed.get("reusing_cached"), "a stale promotion must not survive"
    assert replayed["results"][0]["file_id"] == 999
    assert all(item["cached"] is False for item in replayed["results"])


def test_cached_promotion_needs_a_matching_title(http) -> None:
    base, stub = http
    stub.feature_list = [make_feature("Sicario", imdb_id="3397884")]
    _post(base, "/fetch", {"file_id": 42, "imdb_id": "9999999", "language": "en"})

    stub.results = [make_result(999, "Sicario", download_count=90000), make_result(42, "Sicario")]
    _status, payload = _get(base, "/search?query=Sicario&languages=en")

    # A cached subtitle for a different film must not be promoted.
    assert payload["results"][0]["file_id"] == 999
    assert not payload.get("reusing_cached")


def test_repeated_attach_of_the_same_film_spends_one_download(http) -> None:
    base, stub = http
    stub.feature_list = [make_feature("Sicario", imdb_id="3397884")]
    stub.results = [make_result(42, "Sicario")]

    for _ in range(3):
        _get(base, "/search?query=Sicario&languages=en")
        _post(base, "/fetch", {"file_id": 42, "imdb_id": "3397884", "language": "en"})

    assert stub.downloads == [42], "watching the same film again must be free"


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


def test_a_typed_query_is_parsed_the_same_way_as_a_page_title(http) -> None:
    """The search box used to bypass the guesser entirely.

    A reader who types a clean title is unaffected; a reader who pastes what the
    page shows them was sending the year twice and the episode marker as query
    text, which scored 0.50 against the real name and marked every result weak.
    """
    base, _stub = http
    status, payload = _get(base, "/search?query=The+Americans+(2013)+2013+-+S02+E04")
    assert status == 200
    assert payload["used"]["query"] == "The Americans"
    assert payload["used"]["year"] == 2013
    assert payload["used"]["season"] == 2
    assert payload["used"]["episode"] == 4


def test_a_typed_episode_marker_beats_the_one_the_page_reported(http) -> None:
    # The panel sends the playing episode with every search. Typing a different
    # one is the reader asking for that one.
    base, _stub = http
    _status, payload = _get(base, "/search?query=The+Americans+S02+E04&season=1&episode=9")
    assert (payload["used"]["season"], payload["used"]["episode"]) == (2, 4)


def test_a_clean_typed_title_survives_the_guesser_untouched(http) -> None:
    base, _stub = http
    _status, payload = _get(base, "/search?query=Crime+101")
    assert payload["used"]["query"] == "Crime 101"


def test_two_searches_that_share_no_latin_letters_are_not_one_search() -> None:
    """The key was the readable name and nothing else, and the name is lossy.

    Every character outside a-z0-9 becomes an underscore, so a title written in
    a script that has none of them collapses to nothing at all: two different
    films keyed the same, and the second search was answered out of the first
    one's cache entry for the six hours it lived. Searches cost no quota, so
    this was never paid for in downloads - it was paid for by attaching the
    wrong subtitle. The 120-character cut did the same to two long titles that
    begin alike.
    """
    kimi = server_module._cache_key("君の名は", ("en",), None, None, None, None)
    chihiro = server_module._cache_key("千と千尋の神隠し", ("en",), None, None, None, None)
    assert kimi != chihiro

    long_one = server_module._cache_key("the " * 40 + "americans", ("en",), None, None, None, None)
    long_two = server_module._cache_key("the " * 40 + "sopranos", ("en",), None, None, None, None)
    assert long_one != long_two

    # Still readable, because this cache is looked at by hand.
    plain = server_module._cache_key("the americans", ("en", "tr"), 2013, 2, 9, "tt2149175")
    assert plain.startswith("the_americans_en_tr_2013_2_9_tt2149175-")


# --- what a body may say ----------------------------------------------------


def test_a_boolean_file_id_is_refused_by_both_endpoints(http, tmp_path) -> None:
    """bool is a subclass of int, and True names a file.

    isinstance(True, int) is True, so a body of {"file_id": true} - which is
    what a truthiness check on the caller's side produces - reached the cache
    and wrote True.srt and True.json beside the numbered ones. list_subtitles
    then raised ValueError on int("True"), so every endpoint that lists what is
    held answered with a traceback, and it stayed that way until somebody
    deleted the two files by hand.
    """
    base, _stub = http

    for path in ("/fetch", "/cached"):
        _status, answer = _post(base, path, {"file_id": True, "content": "aGk="})
        assert answer.get("error") == "file_id must be an integer", (path, answer)

    status, listed = _get(base, "/cached")
    assert status == 200
    assert isinstance(listed.get("subtitles"), list)


def test_a_negative_content_length_is_refused_rather_than_read(http) -> None:
    """Only the ceiling was checked, and -1 is under every ceiling there is.

    It then reached rfile.read(-1), which reads until the peer closes rather
    than until the body ends - so the request held a worker thread for as long
    as the caller kept the socket open. Without the check this test times out
    rather than failing.
    """
    base, _stub = http
    host, port = base.removeprefix("http://").split(":")

    conn = http_client.HTTPConnection(host, int(port), timeout=5)
    try:
        conn.putrequest("POST", "/cached")
        conn.putheader("Content-Type", "application/json")
        conn.putheader("Content-Length", "-1")
        conn.endheaders()
        conn.send(b"{}")
        response = conn.getresponse()
        assert response.status == 400
        assert json.loads(response.read())["error"] == "bad Content-Length"
    finally:
        conn.close()


def test_an_import_the_size_of_a_real_subtitle_fits(http) -> None:
    """A third of this machine's cache did not fit under the old ceiling.

    Imports carry a whole subtitle file, base64-encoded. Measured over the 273
    files held here: the median encodes to 56KB and the largest to 200KB, and 96
    of them were over the 64KB ceiling every other endpoint shares. Each of
    those was answered with "body too large", which is a download paid twice.
    """
    base, _stub = http

    cues = "".join(
        f"{n}\n00:{n // 60:02d}:{n % 60:02d},000 --> 00:{n // 60:02d}:{n % 60:02d},900\n"
        f"a line of dialogue long enough to be one\n\n"
        for n in range(1, 1400)
    )
    raw = cues.encode()
    assert len(base64.b64encode(raw)) > server_module.MAX_BODY_BYTES

    status, answer = _post(
        base, "/cached",
        {"file_id": 8801, "content": base64.b64encode(raw).decode(), "meta": {"language": "en"}},
    )
    assert status == 200, answer
    assert answer.get("imported") is True, answer


# --- the extension's running log --------------------------------------------


def test_the_log_is_appended_a_line_at_a_time(http, tmp_path, monkeypatch) -> None:
    """Somewhere real for the extension to put its record.

    A browser extension cannot write to a directory. The only API that puts a
    file on disk is the download machinery, and it announces every file it
    writes - which, for something recording while a film plays, is a popup
    every few seconds. This endpoint exists so that never has to happen.

    One line of JSON per entry, appended: a long session costs one growing file
    rather than a directory of thousands, and a crash halfway through a write
    costs the last line rather than the file.
    """
    base, _ = http
    logs = tmp_path / "logs"
    monkeypatch.setattr(server_module, "LOG_DIR", logs)

    status, first = _post(base, "/log", {"entries": [{"kind": "panel"}, {"kind": "align"}]})
    assert status == 200, first
    assert first["written"] == 2

    status, second = _post(base, "/log", {"entries": [{"kind": "said", "message": "hello"}]})
    assert status == 200, second

    written = list(logs.glob("*.jsonl"))
    assert len(written) == 1, f"expected one file for one day, got {written}"
    lines = [json.loads(line) for line in written[0].read_text("utf-8").splitlines()]
    assert [entry["kind"] for entry in lines] == ["panel", "align", "said"]


def test_a_log_body_may_be_far_larger_than_any_other(http, tmp_path, monkeypatch) -> None:
    """One alignment entry carries two subtitle files' worth of timings.

    Every other endpoint is capped at 64KB, which is right for them and would
    reject the one body that legitimately is not small. It is written straight
    to a file and never held, so the ceiling costs disk rather than memory.
    """
    base, _ = http
    monkeypatch.setattr(server_module, "LOG_DIR", tmp_path / "logs")

    fat = {"kind": "align", "times": list(range(60_000))}
    assert len(json.dumps(fat)) > server_module.MAX_BODY_BYTES
    status, answer = _post(base, "/log", {"entries": [fat]})
    assert status == 200, answer
    assert answer["written"] == 1


def test_a_log_without_entries_is_refused_rather_than_written(http, tmp_path, monkeypatch) -> None:
    base, _ = http
    logs = tmp_path / "logs"
    monkeypatch.setattr(server_module, "LOG_DIR", logs)

    _status, answer = _post(base, "/log", {"entries": "not a list"})
    assert "error" in answer
    assert not logs.exists()


def test_many_words_are_glossed_in_one_request(service, http, monkeypatch) -> None:
    """The route the overlay uses to answer a film's words before they are said.

    Asked one at a time as each line arrives, a lookup took 634ms on average and
    up to 1.4s, against a line that is on screen for about two seconds - so the
    answer landed after the question had gone. The extension holds the whole
    subtitle file before the film starts, so it does not have to wait to be
    asked: this is where it sends what it already knows it will need.
    """
    base, _ = http
    asked: list[tuple[str, str]] = []

    # **kwargs, not a fixed signature: a stub that is stricter than the thing it
    # stands in for fails the day the real one grows an argument, which is a
    # failure about the stub and reads as a failure about the route.
    def gloss_many(items, language, target, film="", **kwargs):
        asked.extend((it["term"], it["sentence"]) for it in items)
        tally = kwargs.get("tally")
        if tally is not None:
            tally["model"] = len(items)
        return [f"{it['term']}-{target}" for it in items]

    monkeypatch.setattr(service[0].lookups, "gloss_many", gloss_many)

    status, body = _post(base, "/gloss", {
        "language": "en", "target": "tr",
        "items": [{"term": "spare", "sentence": "Can you spare a minute?"},
                  {"term": "chamber", "sentence": "The chamber is dropping."}],
    })
    assert status == 200, body
    assert body["glosses"] == ["spare-tr", "chamber-tr"]
    assert asked == [("spare", "Can you spare a minute?"),
                     ("chamber", "The chamber is dropping.")], "the lines did not travel"
    # Which tier answered comes back with the answers. Without it a slow model,
    # a missing key and an untranslatable word are the same empty chip.
    assert body["from"] == {"model": 2}


def test_a_gloss_request_without_items_is_answered_not_crashed(http) -> None:
    base, _ = http
    status, body = _post(base, "/gloss", {"language": "en", "target": "tr"})
    assert status == 200, body
    assert "error" in body
