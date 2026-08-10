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

# Streaming sites and apps. Branding appears at BOTH ends in the wild:
# Prime Video detail pages title themselves "Prime Video: Crime 101", while
# search-result and player pages use "Crime 101 - Prime Video". Stripping only
# the suffix leaves the site name in the query, which turns a title search into
# a fuzzy match against the word "prime" - the bug that returned "Ekusute" and
# "Major Crimes" for Crime 101.
_SITE_NAMES = r"""
    (?:
        netflix | prime\s*video | amazon(?:\s*prime(?:\s*video)?)? | disney\+?
      | hulu | hbo(?:\s*max)? | max | apple\s*tv\+? | paramount\+? | peacock
      | youtube(?:\s*tv)? | vimeo | dailymotion | crunchyroll
      | plex | jellyfin | emby | mubi | blutv | exxen | gain | tabii | tod
    )
"""

_SITE_SUFFIX = re.compile(
    rf"\s*{_SEPARATOR}\s*{_SITE_NAMES}\s*$",
    re.IGNORECASE | re.VERBOSE,
)

_SITE_PREFIX = re.compile(
    rf"^\s*{_SITE_NAMES}\s*{_SEPARATOR}\s*",
    re.IGNORECASE | re.VERBOSE,
)

# "Watch <title>" / "Stream <title>" openers, stripped only when a title
# follows. A leading bare "Watch" with nothing after it is left alone.
_WATCH_PREFIX = re.compile(
    r"^\s*(?:watch|stream|play)\s+(?=\S)",
    re.IGNORECASE,
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

_SPACE_RUN = re.compile(r"\s{2,}")


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


@dataclass(frozen=True)
class Search:
    """What to actually ask OpenSubtitles for."""

    query: str
    year: int | None = None
    season: int | None = None
    episode: int | None = None


def resolve(
    *,
    title: str = "",
    query: str = "",
    year: int | None = None,
    season: int | None = None,
    episode: int | None = None,
) -> Search:
    """Turn what the reader typed, or what the page says, into a search.

    One function rather than a rule written out at each search path, because it
    was written out twice - once in the daemon and once in the extension's
    no-daemon copy - and only one of them was corrected when the rule changed.
    Everything the two of them are supposed to agree about now lives here and
    in its port, and the parity test compares them directly.

    Markers found in the searched text win over the ones the caller passed:
    somebody typing S02 E04 while episode 9 is on screen is asking for four.
    """
    guessed = guess(query or title)
    return Search(
        query=guessed.query or query or "",
        year=guessed.year if guessed.year is not None else year,
        season=guessed.season if guessed.season is not None else season,
        episode=guessed.episode if guessed.episode is not None else episode,
    )


def guess(raw: str) -> TitleGuess:
    """Extract a searchable title, and season/episode/year when confident."""
    text = _LEADING_NOISE.sub("", raw or "").strip()

    # Site branding first: it sits outside the watch-noise, and some pages stack
    # two separators ("Title - Watch Online - SomeSite"). Both ends, because
    # branding leads on some pages and trails on others.
    text = _strip_repeatedly(text, _SITE_PREFIX)
    text = _strip_repeatedly(text, _SITE_SUFFIX)
    text = _strip_repeatedly(text, _WATCH_NOISE_TAIL)
    text = _strip_repeatedly(text, _SITE_SUFFIX)
    text = _strip_repeatedly(text, _WATCH_PREFIX, limit=1)

    # Looked for BEFORE the episode marker is cut away, not after.
    #
    # A scene release puts the episode marker in front of the quality tokens -
    # "The.Americans.2013.S02E04.1080p.BluRay.x264" - so cutting at the marker
    # first removed every token this test is looking for, and the string stopped
    # counting as a scene release exactly when it most obviously was one. The
    # cost was the dotted-year rule, which is gated on this: the year came back
    # as None and "2013" stayed in the query.
    scene_release = bool(_RELEASE_TOKENS.search(text))

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

    # A trailing bare year is still metadata when something else in the string
    # has already said this is a listing rather than a title: release tokens, or
    # an episode marker. "Dallas 2012 S02E04" is the reboot's year and a season,
    # not a programme called "Dallas 2012" - and the year is more use to
    # OpenSubtitles as its own field than as two words in the query.
    if year is None and (scene_release or season is not None):
        trailing = re.search(rf"\s(?P<year>{_YEAR_RANGE})$", text)
        if trailing and text[: trailing.start()].strip():
            year = int(trailing.group("year"))
            text = text[: trailing.start()].strip()

    # The same year twice.
    #
    # Streaming pages print it once beside the title and again in the listing
    # line under it: "The Americans (2013) 2013 - S02 E04" is what one of them
    # actually shows. The bracketed one was taken as the year and the bare one
    # was left in the query, which then searched for "The Americans 2013" and
    # scored 0.50 against "The Americans" - under the 0.75 auto-attach
    # threshold, so every result came back tagged as a weak match.
    if year is not None:
        text = _drop_number(text, year)

    return TitleGuess(query=text, year=year, season=season, episode=episode)


def _drop_number(text: str, number: int) -> str:
    """Remove a standalone number, unless it was the whole title.

    Guarded on both sides so a year inside a longer run of digits survives, and
    guarded on the result so "1917" does not become an empty query for a film
    whose title is its year.
    """
    without = re.sub(rf"(?<!\d){number}(?!\d)", " ", text)
    without = _SPACE_RUN.sub(" ", without).strip(" -|–—·•:,.")
    return without or text


def _strip_repeatedly(text: str, pattern: re.Pattern[str], limit: int = 3) -> str:
    """Remove a matching prefix or suffix, but never everything.

    The guard is what keeps a title made entirely of noise words from being
    reduced to an empty query - "Prime Video" on its own stays as it is rather
    than becoming a search for nothing.
    """
    for _ in range(limit):
        stripped = pattern.sub("", text).strip()
        if stripped == text or not stripped:
            break
        text = stripped
    return text
