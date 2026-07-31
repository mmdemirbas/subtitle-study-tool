"""Scoring how well a search result matches what was actually asked for.

OpenSubtitles' `query` search is fuzzy and always returns something. Asking it
for "Prime Video: Crime 101" produced "Ekusute" and "Major Crimes" — both
confidently, both wrong. Fixing the query fixes most of that, but not all: a
title the database has never heard of still comes back with plausible-looking
neighbours, and downloading one costs quota and screen time.

So results carry a score, and the caller decides. Auto-attach requires a good
score; the popup shows everything and lets a human overrule.
"""

from __future__ import annotations

import re
import unicodedata
from difflib import SequenceMatcher

# Above this, a result is close enough to attach without asking.
AUTO_ATTACH_THRESHOLD = 0.75

# Below this, a result is not worth showing at all.
VISIBLE_THRESHOLD = 0.25

# Leading articles carry no signal and differ between a title and its listing.
_ARTICLES = frozenset({"the", "a", "an", "la", "le", "el", "der", "die", "das"})

_NON_WORD = re.compile(r"[^\w\s]", re.UNICODE)
_SPACES = re.compile(r"\s+")


def normalise(text: str) -> str:
    """Casefold, strip accents and punctuation, collapse whitespace."""
    decomposed = unicodedata.normalize("NFKD", text or "")
    without_accents = "".join(ch for ch in decomposed if not unicodedata.combining(ch))
    cleaned = _NON_WORD.sub(" ", without_accents.casefold())
    return _SPACES.sub(" ", cleaned).strip()


def tokens(text: str) -> list[str]:
    return [word for word in normalise(text).split() if word not in _ARTICLES]


def score(query: str, candidate: str, *, query_year: int | None = None,
          candidate_year: int | None = None) -> float:
    """How well `candidate` matches `query`, from 0.0 to 1.0.

    Combines whole-string similarity with token coverage, because the two fail
    in different directions. Similarity alone punishes a candidate that is
    correct but carries extra words ("Crime 101" vs "Crime 101 2025 Remastered");
    coverage alone rewards a candidate that merely contains the query's words
    ("Crime 101" vs "Major Crimes: 101 Ways"). Taking the higher of the two and
    then damping by length mismatch handles both.
    """
    query_tokens = tokens(query)
    candidate_tokens = tokens(candidate)
    if not query_tokens or not candidate_tokens:
        return 0.0

    query_norm = " ".join(query_tokens)
    candidate_norm = " ".join(candidate_tokens)

    if query_norm == candidate_norm:
        base = 1.0
    else:
        similarity = SequenceMatcher(None, query_norm, candidate_norm).ratio()

        query_set = set(query_tokens)
        candidate_set = set(candidate_tokens)
        covered = len(query_set & candidate_set) / len(query_set)

        # Coverage on its own says "all my words appear somewhere in yours",
        # which a much longer title satisfies trivially. Scale it by how much
        # of the candidate is accounted for.
        precision = len(query_set & candidate_set) / len(candidate_set)
        coverage = covered * (0.5 + 0.5 * precision)

        base = max(similarity, coverage)

    if query_year and candidate_year:
        # A matching year corroborates. A year out by one does not contradict:
        # festival and wide-release years differ, and so do regions - the page
        # said 2025 for a film the database calls 2026. Penalising that dropped
        # an exact title below the auto-attach threshold and refused to attach
        # the correct subtitle. Only a real disagreement counts against.
        delta = abs(query_year - candidate_year)
        if delta == 0:
            base = min(1.0, base + 0.1)
        elif delta > 1:
            base *= 0.7

    return round(base, 4)


def best_score(query: str, names: list[str], *, query_year: int | None = None,
               candidate_year: int | None = None) -> float:
    """Highest score across several candidate names for the same result.

    A result has both a movie name and a release string, and either may be the
    one that resembles the query.
    """
    return max(
        (score(query, name, query_year=query_year, candidate_year=candidate_year)
         for name in names if name),
        default=0.0,
    )
