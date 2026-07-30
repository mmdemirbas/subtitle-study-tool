"""OpenSubtitles REST API client.

Docs: https://opensubtitles.stoplight.io — the reference pages are rendered
client-side, so the response shapes below were confirmed against live calls
rather than read off the spec. Everything is therefore read defensively: a
missing or renamed field degrades one result, it does not fail the request.

Quota, from https://opensubtitles.tawk.help/article/getting-started:
searching is unlimited, downloading is not - 5 per day anonymous, 10 per day
for a free account, more for VIP. `Cache` is what keeps this tool inside that.
"""

from __future__ import annotations

import gzip
import json
import logging
import urllib.error
import urllib.parse
import urllib.request
from dataclasses import dataclass, field
from typing import Any

from .config import API_BASE, USER_AGENT

logger = logging.getLogger(__name__)

TIMEOUT_SECONDS = 20


class OpenSubtitlesError(RuntimeError):
    """An API call failed in a way the caller should surface to the user."""

    def __init__(self, message: str, *, status: int | None = None) -> None:
        super().__init__(message)
        self.status = status


class QuotaExceededError(OpenSubtitlesError):
    """The daily download allowance is used up.

    Separated from the generic error because the remedy is different: waiting
    or signing in, not retrying.
    """


@dataclass(frozen=True)
class SearchResult:
    """One candidate subtitle, flattened from the API's nested shape."""

    file_id: int
    subtitle_id: str
    language: str
    release: str
    movie_name: str
    year: int | None
    season: int | None
    episode: int | None
    download_count: int
    from_trusted: bool
    hearing_impaired: bool
    fps: float | None
    url: str

    def as_dict(self) -> dict[str, Any]:
        return {
            "file_id": self.file_id,
            "subtitle_id": self.subtitle_id,
            "language": self.language,
            "release": self.release,
            "movie_name": self.movie_name,
            "year": self.year,
            "season": self.season,
            "episode": self.episode,
            "download_count": self.download_count,
            "from_trusted": self.from_trusted,
            "hearing_impaired": self.hearing_impaired,
            "fps": self.fps,
            "url": self.url,
        }


@dataclass
class DownloadResult:
    """A downloaded subtitle plus what the API said about remaining quota."""

    content: bytes
    file_name: str
    remaining: int | None = None
    reset_time: str | None = None
    quota_headers: dict[str, str] = field(default_factory=dict)


class Client:
    """Thin OpenSubtitles client. One instance per daemon process."""

    def __init__(self, api_key: str) -> None:
        self._api_key = api_key
        self._token: str | None = None

    # --- auth ---------------------------------------------------------------

    def login(self, username: str, password: str) -> None:
        """Authenticate to raise the download quota above the anonymous 5/day.

        A failure here is not fatal - the daemon carries on unauthenticated at
        the lower limit - so this logs and returns rather than raising.
        """
        try:
            payload = self._request(
                "POST",
                "/login",
                body={"username": username, "password": password},
            )
        except OpenSubtitlesError as err:
            logger.warning("OpenSubtitles login failed, continuing anonymously: %s", err)
            return

        token = payload.get("token")
        if isinstance(token, str) and token:
            self._token = token
            logger.info("Signed in to OpenSubtitles as %s", username)
        else:
            logger.warning("OpenSubtitles login returned no token; continuing anonymously")

    @property
    def authenticated(self) -> bool:
        return self._token is not None

    # --- search -------------------------------------------------------------

    def search(
        self,
        *,
        query: str,
        languages: tuple[str, ...],
        year: int | None = None,
        season: int | None = None,
        episode: int | None = None,
        imdb_id: str | None = None,
        moviehash: str | None = None,
    ) -> list[SearchResult]:
        """Search for subtitles. Unlimited, so callers may retry freely."""
        params: dict[str, str] = {}

        # The API wants languages comma-separated and, per its own best-practice
        # note, parameters in alphabetical order.
        if languages:
            params["languages"] = ",".join(sorted(languages))
        if query:
            params["query"] = query
        if year:
            params["year"] = str(year)
        if season is not None:
            params["season_number"] = str(season)
        if episode is not None:
            params["episode_number"] = str(episode)
        if imdb_id:
            params["imdb_id"] = imdb_id.removeprefix("tt")
        if moviehash:
            params["moviehash"] = moviehash

        payload = self._request("GET", "/subtitles", params=params)
        raw = payload.get("data")
        if not isinstance(raw, list):
            return []

        results = [parsed for item in raw if (parsed := _parse_search_item(item))]
        results.sort(key=_ranking_key, reverse=True)
        return results

    # --- download -----------------------------------------------------------

    def download(self, file_id: int) -> DownloadResult:
        """Resolve a file_id to subtitle bytes. Costs one unit of daily quota."""
        payload = self._request("POST", "/download", body={"file_id": file_id})

        link = payload.get("link")
        if not isinstance(link, str) or not link:
            message = str(payload.get("message") or "download response contained no link")
            raise OpenSubtitlesError(message)

        content = self._fetch_file(link)
        remaining = payload.get("remaining")
        return DownloadResult(
            content=content,
            file_name=str(payload.get("file_name") or f"{file_id}.srt"),
            remaining=int(remaining) if isinstance(remaining, (int, float)) else None,
            reset_time=str(payload.get("reset_time")) if payload.get("reset_time") else None,
        )

    # --- transport ----------------------------------------------------------

    def _request(
        self,
        method: str,
        path: str,
        *,
        params: dict[str, str] | None = None,
        body: dict[str, Any] | None = None,
    ) -> dict[str, Any]:
        url = f"{API_BASE}{path}"
        if params:
            # Alphabetical order and + for spaces, both per the API's own
            # best-practice guidance.
            ordered = sorted(params.items())
            url = f"{url}?{urllib.parse.urlencode(ordered, quote_via=urllib.parse.quote_plus)}"

        data = json.dumps(body).encode("utf-8") if body is not None else None
        request = urllib.request.Request(url, data=data, method=method)
        request.add_header("Api-Key", self._api_key)
        request.add_header("User-Agent", USER_AGENT)
        request.add_header("Accept", "application/json")
        if data is not None:
            request.add_header("Content-Type", "application/json")
        if self._token:
            request.add_header("Authorization", f"Bearer {self._token}")

        try:
            with urllib.request.urlopen(request, timeout=TIMEOUT_SECONDS) as response:
                return _read_json(response.read())
        except urllib.error.HTTPError as err:
            raise _translate_http_error(err) from err
        except urllib.error.URLError as err:
            raise OpenSubtitlesError(f"could not reach OpenSubtitles: {err.reason}") from err

    def _fetch_file(self, link: str) -> bytes:
        """Fetch the actual subtitle file from the one-shot download link."""
        request = urllib.request.Request(link)
        request.add_header("User-Agent", USER_AGENT)
        try:
            with urllib.request.urlopen(request, timeout=TIMEOUT_SECONDS) as response:
                raw = response.read()
                if response.headers.get("Content-Encoding") == "gzip":
                    raw = gzip.decompress(raw)
                return raw
        except urllib.error.HTTPError as err:
            raise _translate_http_error(err) from err
        except urllib.error.URLError as err:
            raise OpenSubtitlesError(f"could not download subtitle: {err.reason}") from err


def _read_json(raw: bytes) -> dict[str, Any]:
    try:
        parsed = json.loads(raw.decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError) as err:
        raise OpenSubtitlesError("OpenSubtitles returned a non-JSON response") from err
    return parsed if isinstance(parsed, dict) else {"data": parsed}


def _translate_http_error(err: urllib.error.HTTPError) -> OpenSubtitlesError:
    """Turn an HTTP failure into something with a useful message."""
    detail = ""
    try:
        body = err.read().decode("utf-8", errors="replace")
        parsed = json.loads(body)
        if isinstance(parsed, dict):
            detail = str(parsed.get("message") or parsed.get("error") or "")
    except (ValueError, OSError):
        pass

    if err.code == 406 or "quota" in detail.lower() or "limit" in detail.lower():
        return QuotaExceededError(
            detail or "daily download limit reached", status=err.code
        )
    if err.code == 401:
        return OpenSubtitlesError(
            detail or "OpenSubtitles rejected the API key", status=err.code
        )
    if err.code == 429:
        return OpenSubtitlesError(detail or "rate limited, slow down", status=err.code)
    return OpenSubtitlesError(detail or f"OpenSubtitles returned HTTP {err.code}", status=err.code)


def _parse_search_item(item: Any) -> SearchResult | None:
    """Flatten one `data[]` entry, tolerating missing or renamed fields."""
    if not isinstance(item, dict):
        return None
    attributes = item.get("attributes")
    if not isinstance(attributes, dict):
        return None

    files = attributes.get("files")
    if not isinstance(files, list) or not files:
        return None
    first = files[0]
    if not isinstance(first, dict):
        return None
    file_id = first.get("file_id")
    if not isinstance(file_id, int):
        return None

    feature = attributes.get("feature_details")
    feature = feature if isinstance(feature, dict) else {}

    return SearchResult(
        file_id=file_id,
        subtitle_id=str(item.get("id") or ""),
        language=str(attributes.get("language") or "").lower(),
        release=str(attributes.get("release") or first.get("file_name") or ""),
        movie_name=str(feature.get("movie_name") or feature.get("title") or ""),
        year=_as_int(feature.get("year")),
        season=_as_int(feature.get("season_number")),
        episode=_as_int(feature.get("episode_number")),
        download_count=_as_int(attributes.get("download_count")) or 0,
        from_trusted=bool(attributes.get("from_trusted")),
        hearing_impaired=bool(attributes.get("hearing_impaired")),
        fps=_as_float(attributes.get("fps")),
        url=str(attributes.get("url") or ""),
    )


def _ranking_key(result: SearchResult) -> tuple[int, int, int]:
    """Order candidates so the first one is usually the right one.

    Trusted uploads first, then popularity. Hearing-impaired versions sink
    slightly: they are correct subtitles but carry sound annotations that are
    noise when the goal is following dialogue.
    """
    return (
        1 if result.from_trusted else 0,
        -1 if result.hearing_impaired else 0,
        result.download_count,
    )


def _as_int(value: Any) -> int | None:
    if isinstance(value, bool):
        return None
    if isinstance(value, (int, float)):
        return int(value)
    if isinstance(value, str) and value.strip().lstrip("-").isdigit():
        return int(value)
    return None


def _as_float(value: Any) -> float | None:
    if isinstance(value, bool):
        return None
    if isinstance(value, (int, float)):
        return float(value)
    if isinstance(value, str):
        try:
            return float(value)
        except ValueError:
            return None
    return None
