"""Tests for result match scoring.

The named cases are the real ones: what OpenSubtitles actually returned for
Crime 101 on 2026-07-30, which got downloaded and shown because nothing checked
whether the result resembled the request.
"""

from __future__ import annotations

from subtitle_daemon.matching import (
    AUTO_ATTACH_THRESHOLD,
    VISIBLE_THRESHOLD,
    best_score,
    normalise,
    score,
    tokens,
)


def test_normalise_strips_accents_case_and_punctuation() -> None:
    assert normalise("Amélie!") == "amelie"
    assert normalise("  Mr.  Robot ") == "mr robot"
    assert normalise("İstanbul") == "istanbul"


def test_tokens_drop_articles() -> None:
    assert tokens("The Matrix") == ["matrix"]
    assert tokens("A Space Odyssey") == ["space", "odyssey"]


def test_identical_titles_score_one() -> None:
    assert score("Crime 101", "Crime 101") == 1.0
    assert score("crime 101", "  Crime  101  ") == 1.0


def test_the_actual_bad_matches_score_below_auto_attach() -> None:
    # These two were downloaded and displayed for a search for Crime 101.
    for wrong in ("Ekusute", "Major Crimes", "Exte: Hair Extensions"):
        assert score("Crime 101", wrong) < AUTO_ATTACH_THRESHOLD, wrong


def test_ekusute_is_not_even_worth_showing() -> None:
    assert score("Crime 101", "Ekusute") < VISIBLE_THRESHOLD


def test_partial_word_overlap_does_not_reach_auto_attach() -> None:
    # "Crime" appearing inside a longer, different title must not be enough.
    assert score("Crime 101", "Major Crimes") < AUTO_ATTACH_THRESHOLD
    assert score("Crime 101", "True Crime Story: Indefensible") < AUTO_ATTACH_THRESHOLD


def test_correct_title_with_extra_words_still_matches() -> None:
    assert score("Crime 101", "Crime 101 (2025)") >= AUTO_ATTACH_THRESHOLD
    assert score("Blade Runner", "Blade Runner - The Final Cut") >= VISIBLE_THRESHOLD


def test_matching_year_helps_and_clashing_year_hurts() -> None:
    with_match = score("Sicario", "Sicario", query_year=2015, candidate_year=2015)
    with_clash = score("Sicario", "Sicario", query_year=2015, candidate_year=2018)
    assert with_match == 1.0
    assert with_clash < with_match


def test_a_year_out_by_one_is_not_a_clash() -> None:
    """Release years disagree by a year all the time and must not penalise.

    The page said Mercy (2025); the database says 2026. Treating that as a
    clash cost an exact title 30% of its score, dropped it under the
    auto-attach threshold, and refused to attach the right subtitle.
    """
    adjacent = score("Mercy", "Mercy", query_year=2025, candidate_year=2026)
    assert adjacent >= AUTO_ATTACH_THRESHOLD
    assert adjacent == score("Mercy", "Mercy")


def test_a_year_out_by_several_still_counts_against() -> None:
    assert score("Mercy", "Mercy", query_year=2025, candidate_year=2009) < AUTO_ATTACH_THRESHOLD


def test_year_clash_alone_does_not_disqualify_an_exact_title() -> None:
    # Listings carry wrong years often enough that this must stay visible.
    assert score("Sicario", "Sicario", query_year=2015, candidate_year=2018) > VISIBLE_THRESHOLD


def test_case_and_accent_differences_do_not_penalise() -> None:
    assert score("Amelie", "Amélie") == 1.0
    assert score("Nefes", "NEFES") == 1.0


def test_article_differences_do_not_penalise() -> None:
    assert score("The Matrix", "Matrix") == 1.0


def test_best_score_takes_the_better_of_several_names() -> None:
    # The movie name may be blank while the release string carries the title.
    assert best_score("Crime 101", ["", "Crime.101.2025.1080p.WEB"]) > VISIBLE_THRESHOLD
    assert best_score("Crime 101", ["Ekusute", "Crime 101"]) == 1.0


def test_empty_inputs_score_zero_rather_than_crashing() -> None:
    assert score("", "Crime 101") == 0.0
    assert score("Crime 101", "") == 0.0
    assert best_score("Crime 101", []) == 0.0


def test_thresholds_are_ordered() -> None:
    assert 0 < VISIBLE_THRESHOLD < AUTO_ATTACH_THRESHOLD < 1
