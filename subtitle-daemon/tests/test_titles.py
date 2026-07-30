"""Tests for turning a browser tab title into a search query."""

from __future__ import annotations

import pytest

from subtitle_daemon.titles import guess


@pytest.mark.parametrize(
    ("raw", "expected"),
    [
        ("Blade Runner 2049 - Netflix", "Blade Runner 2049"),
        ("(3) The Matrix | Prime Video", "The Matrix"),
        ("Arrival - Watch Online", "Arrival"),
        ("Dune  Part Two   ", "Dune Part Two"),  # runs of whitespace collapse
        ("Interstellar full movie", "Interstellar"),
    ],
)
def test_strips_site_and_player_noise(raw: str, expected: str) -> None:
    assert guess(raw).query.strip() == expected.strip()


@pytest.mark.parametrize(
    "raw",
    [
        "Prime Video: Crime 101",
        "Watch Crime 101 | Prime Video",
        "Crime 101 - Prime Video",
        "Amazon Prime Video: Crime 101",
        "Crime 101 - Watch Online - Prime Video",
        "Netflix: Crime 101",
    ],
)
def test_site_branding_is_stripped_from_either_end(raw: str) -> None:
    # Regression: Prime Video detail pages lead with the branding rather than
    # trailing it, so "Prime Video: Crime 101" reached OpenSubtitles verbatim
    # and fuzzy-matched "Ekusute" and "Major Crimes".
    assert guess(raw).query == "Crime 101"


def test_site_name_alone_is_not_reduced_to_nothing() -> None:
    assert guess("Prime Video").query == "Prime Video"
    assert guess("Netflix").query == "Netflix"


def test_leading_watch_needs_a_title_after_it() -> None:
    assert guess("Watch").query == "Watch"
    assert guess("Watchmen").query == "Watchmen"


def test_extracts_year_and_removes_it_from_query() -> None:
    result = guess("Blade Runner (1982) - Netflix")
    assert result.query == "Blade Runner"
    assert result.year == 1982


def test_extracts_season_and_episode_sxxexx() -> None:
    result = guess("Battlestar Galactica S01E03 1080p BluRay")
    assert result.query == "Battlestar Galactica"
    assert (result.season, result.episode) == (1, 3)
    assert result.is_episode


def test_extracts_season_and_episode_xformat() -> None:
    result = guess("The Wire 2x05 - watch online")
    assert result.query == "The Wire"
    assert (result.season, result.episode) == (2, 5)


def test_extracts_verbose_season_episode() -> None:
    result = guess("Severance Season 2 Episode 7")
    assert result.query == "Severance"
    assert (result.season, result.episode) == (2, 7)


def test_cuts_release_scene_metadata() -> None:
    result = guess("Sicario.2015.1080p.BluRay.x264-SPARKS")
    assert result.query == "Sicario"
    assert result.year == 2015


def test_keeps_single_period_in_title() -> None:
    # Only multiple dots mean "these are spaces".
    assert guess("Mr. Robot - Prime Video").query == "Mr. Robot"


def test_turkish_streaming_noise() -> None:
    assert guess("Nefes - full HD izle").query == "Nefes"
    assert guess("Ayla 2017 tek parça izle").query == "Ayla 2017"


def test_bare_trailing_year_stays_in_the_query() -> None:
    # A bare number at the end is ambiguous - "Ayla 2017" is a year, "Blade
    # Runner 2049" is part of the name - so it is left in the query text rather
    # than guessed at. OpenSubtitles handles a year inside the query fine.
    for raw in ("Ayla 2017", "Blade Runner 2049"):
        assert guess(raw).query == raw
        assert guess(raw).year is None


def test_movie_without_metadata_is_left_alone() -> None:
    result = guess("Stalker")
    assert result.query == "Stalker"
    assert result.year is None
    assert not result.is_episode


def test_empty_input_does_not_crash() -> None:
    assert guess("").query == ""


def test_year_like_number_leading_a_title_is_kept() -> None:
    result = guess("2001: A Space Odyssey")
    assert result.year is None
    assert result.query == "2001: A Space Odyssey"


def test_title_made_only_of_noise_words_is_not_emptied() -> None:
    # The suffix stripper must never reduce a query to nothing, or the search
    # silently becomes "find me anything".
    assert guess("Free").query == "Free"
    assert guess("Watch Online").query != ""
