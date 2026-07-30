"""Turn a browser tab title into something worth searching for.

A streaming page's `document.title` is mostly noise: site branding, player
state, resolution badges. What survives after stripping that is usually the
film title, and often a season/episode marker worth extracting separately
because OpenSubtitles indexes those as their own fields.

This is heuristic and will sometimes be wrong. The extension shows the guess
and lets it be corrected, so a wrong guess costs one edit, not a failed search.

The one rule worth stating: stripping is only allowed to remove a *suffix*, and
only if something is left over. "Free Willy" and "The Full Monty" must survive
a noise list that contains "free" and "full".
"""

from __future__ import annotations

import re
from dataclasses import dataclass

# Leading player-state noise: "(1234) " unread counts, play glyphs.
_LEADING_NOISE = re.compile(r"^\s*(?:\(\d+\)|[▶●▪•])\s*")

# Kept as bare class *contents* so it can be embedded both as its own class and
# inside a larger one. Wrapping it in brackets here would nest brackets at the
# second use site and silently break the pattern.
_SEPARATOR_CHARS = r"\-|–—·•:"
_SEPARATOR = f"[{_SEPARATOR_CHARS}]"

# Streaming sites and apps, as a trailing segment after a separator.
_SITE_NOISE = re.compile(
    rf"""
    \s*{_SEPARATOR}\s*
    (?:
        netflix | prime\s*video | amazon(?:\s*prime)? | disney\+? | hulu | max
      | hbo(?:\s*max)? | apple\s*tv\+? | youtube | vimeo | dailymotion
      | plex | jellyfin | emby | mubi | blutv | exxen | gain | tabii | tod
    )
    \s*$
    """,
    re.IGNORECASE | re.VERBOSE,
)

# Words that make up "watch this online free in HD" style trailing noise. They
# are stripped as a run, so multi-word tails come off in one pass, but only
# from the end and only when something remains in front.
_WATCH_NOISE_WORD = r"""
    (?:
        watch(?:ing)? | online | free | full | movie | film | stream(?:ing)?
      | hd | fhd | uhd | 4k | 1080p? | 720p? | 2160p?
      | izle | seyret | tek | par[çc]a | dizi | b[öo]l[üu]m
      | t[üu]rk[çc]e | dublaj | altyaz[ıi]l[ıi] | altyaz[ıi]
      | subtitled | subbed | dubbed | eng | tr
    )
"""

_WATCH_NOISE_TAIL = re.compile(
    rf"""
    \s*{_SEPARATOR}?\s*
    (?: \b {_WATCH_NOISE_WORD} \b [\s{_SEPARATOR_CHARS}]* )+
    $
    """,
    re.IGNORECASE | re.VERBOSE,
)

# Release-scene tokens. Everything from the first one onward is metadata, and
# their presence is also what makes a bare year trustworthy as a year.
_RELEASE_TOKENS = re.compile(
    r"""
    \b(?:
        1080p | 720p | 2160p | 480p | 4k | uhd | hdr | hdrip | bluray | blu-ray
      | brrip | bdrip | webrip | web-?dl | dvdrip | hdtv | camrip
      | x264 | x265 | h\.?264 | h\.?265 | hevc | xvid | avc
      | aac | ac3 | dts | ddp?5\.1 | atmos | truehd
      | remux | proper | repack | extended | uncut | remastered
    )\b
    """,
    re.IGNORECASE | re.VERBOSE,
)

_EPISODE_PATTERNS = (
    re.compile(r"\bS(?P<season>\d{1,2})\s*[.\-_ ]?\s*E(?P<episode>\d{1,3})\b", re.IGNORECASE),
    re.compile(r"\b(?P<season>\d{1,2})x(?P<episode>\d{1,3})\b", re.IGNORECASE),
    re.compile(
        r"\bseason\s*(?P<season>\d{1,2})\D{1,10}episode\s*(?P<episode>\d{1,3})\b",
        re.IGNORECASE,
    ),
)

_YEAR_RANGE = r"(?:19[0-9]{2}|20[0-4][0-9])"

# A year is only *removed* from the title when it is bracketed, or when the
# string is a scene release where dots delimit fields. A bare trailing number
# is left alone, because "Blade Runner 2049" and "Se7en"-style titles are real
# and OpenSubtitles copes with a year inside the query text anyway.
_YEAR_BRACKETED = re.compile(rf"[(\[]\s*(?P<year>{_YEAR_RANGE})\s*[)\]]")
_YEAR_DOTTED = re.compile(rf"(?<=\.)(?P<year>{_YEAR_RANGE})(?=\.)")


@dataclass(frozen=True)
class TitleGuess:
    """What a page title appears to be about."""

    query: str
    year: int | None = None
    season: int | None = None
    episode: int | None = None

    @property
    def is_episode(self) -> bool:
        return self.season is not None and self.episode is not None


def guess(raw: str) -> TitleGuess:
    """Extract a searchable title, and season/episode/year when confident."""
    text = _LEADING_NOISE.sub("", raw or "").strip()

    # Site branding first: it sits outside the watch-noise, and some pages stack
    # two separators ("Title - Watch Online - SomeSite").
    text = _strip_suffix_repeatedly(text, _SITE_NOISE)
    text = _strip_suffix_repeatedly(text, _WATCH_NOISE_TAIL)
    text = _strip_suffix_repeatedly(text, _SITE_NOISE)

    season = episode = None
    for pattern in _EPISODE_PATTERNS:
        match = pattern.search(text)
        if match:
            season = int(match.group("season"))
            episode = int(match.group("episode"))
            # Everything from the marker onward is episode metadata, not title.
            text = text[: match.start()]
            break

    year = None
    scene_release = bool(_RELEASE_TOKENS.search(text))

    # Cut at the first release-scene token; the title precedes it.
    release = _RELEASE_TOKENS.search(text)
    if release:
        text = text[: release.start()]

    for pattern in (_YEAR_BRACKETED, _YEAR_DOTTED):
        match = pattern.search(text)
        if match and (pattern is _YEAR_BRACKETED or scene_release):
            candidate = text[: match.start()] + " " + text[match.end() :]
            if candidate.strip(" .-|:"):
                year = int(match.group("year"))
                text = candidate
                break

    # Scene releases use dots and underscores as spaces. Only treat dots that
    # way when there are several, so "Mr. Robot" keeps its period.
    if text.count(".") >= 2:
        text = text.replace(".", " ")
    text = text.replace("_", " ")

    text = re.sub(r"[\[\](){}]", " ", text)
    text = re.sub(r"\s{2,}", " ", text)
    text = text.strip(" -|–—·•:,.")

    # A trailing bare year on a scene release is still metadata.
    if year is None and scene_release:
        trailing = re.search(rf"\s(?P<year>{_YEAR_RANGE})$", text)
        if trailing and text[: trailing.start()].strip():
            year = int(trailing.group("year"))
            text = text[: trailing.start()].strip()

    return TitleGuess(query=text, year=year, season=season, episode=episode)


def _strip_suffix_repeatedly(text: str, pattern: re.Pattern[str], limit: int = 3) -> str:
    """Remove a matching suffix, but never everything.

    The guard is what keeps a title made entirely of noise words from being
    reduced to an empty query.
    """
    for _ in range(limit):
        stripped = pattern.sub("", text).strip()
        if stripped == text or not stripped:
            break
        text = stripped
    return text
