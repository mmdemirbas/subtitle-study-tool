"""Tests for parsing OpenSubtitles responses.

Field names here were confirmed against live calls rather than read off a spec
(the reference docs render client-side), so the parser is written to tolerate
renames. These tests pin the shapes actually observed on 2026-07-30.
"""

from __future__ import annotations

from typing import Any

from subtitle_daemon.opensubtitles import _parse_feature, _parse_search_item, _split_year_prefix


def subtitle_item(**feature: Any) -> dict[str, Any]:
    return {
        "id": "7331",
        "attributes": {
            "language": "EN",
            "release": "Sicario.2015.1080p.BluRay",
            "download_count": 4210,
            "from_trusted": True,
            "hearing_impaired": False,
            "fps": 23.976,
            "url": "https://example.invalid/7331",
            "files": [{"file_id": 42, "file_name": "Sicario.srt"}],
            "feature_details": feature,
        },
    }


# --- the "2015 - Sicario" shape ---------------------------------------------


def test_split_year_prefix_separates_the_year() -> None:
    assert _split_year_prefix("2015 - Sicario") == ("Sicario", 2015)
    assert _split_year_prefix("1994 – Sicario") == ("Sicario", 1994)


def test_split_year_prefix_leaves_ordinary_titles_alone() -> None:
    assert _split_year_prefix("Sicario") == ("Sicario", None)
    assert _split_year_prefix("Blade Runner 2049") == ("Blade Runner 2049", None)
    # A year with nothing after the dash is not a prefix (the name is returned
    # stripped, as it is for every other input).
    assert _split_year_prefix("2015 - ") == ("2015 -", None)


def test_movie_name_year_prefix_is_stripped_when_parsing() -> None:
    """Left in place it costs every exact title a chunk of its match score."""
    result = _parse_search_item(subtitle_item(movie_name="2015 - Sicario"))
    assert result is not None
    assert result.movie_name == "Sicario"
    assert result.year == 2015


def test_explicit_year_field_wins_over_the_prefix() -> None:
    result = _parse_search_item(subtitle_item(movie_name="2015 - Sicario", year=2016))
    assert result is not None
    assert result.year == 2016


# --- defensive parsing -------------------------------------------------------


def test_missing_files_array_drops_the_result_rather_than_raising() -> None:
    item = subtitle_item(movie_name="Sicario")
    item["attributes"]["files"] = []
    assert _parse_search_item(item) is None


def test_missing_file_id_drops_the_result() -> None:
    item = subtitle_item(movie_name="Sicario")
    item["attributes"]["files"] = [{"file_name": "x.srt"}]
    assert _parse_search_item(item) is None


def test_absent_feature_details_still_yields_a_result() -> None:
    item = subtitle_item()
    del item["attributes"]["feature_details"]
    result = _parse_search_item(item)
    assert result is not None
    assert result.release == "Sicario.2015.1080p.BluRay"
    assert result.movie_name == ""


def test_language_is_lowercased() -> None:
    result = _parse_search_item(subtitle_item(movie_name="Sicario"))
    assert result is not None
    assert result.language == "en"


def test_garbage_items_are_skipped() -> None:
    for junk in (None, [], "string", {}, {"attributes": None}):
        assert _parse_search_item(junk) is None


# --- features ----------------------------------------------------------------


def feature_item(**attributes: Any) -> dict[str, Any]:
    return {"attributes": {"imdb_id": 3397884, "title": "sicario", "year": 2015,
                           "feature_type": "Movie", "subtitles_count": 210, **attributes}}


def test_feature_parsing() -> None:
    feature = _parse_feature(feature_item())
    assert feature is not None
    assert feature.imdb_id == "3397884"
    assert feature.year == 2015
    assert feature.subtitles_count == 210
    assert not feature.is_series


def test_feature_series_detection() -> None:
    for kind in ("Tvshow", "Episode", "tvshow"):
        feature = _parse_feature(feature_item(feature_type=kind))
        assert feature is not None and feature.is_series


def test_feature_without_imdb_id_is_dropped() -> None:
    item = feature_item()
    del item["attributes"]["imdb_id"]
    assert _parse_feature(item) is None


def test_feature_garbage_is_skipped() -> None:
    for junk in (None, [], "string", {}, {"attributes": 5}):
        assert _parse_feature(junk) is None
