"""HTTP surface for the daemon.

Bound to loopback only. That is most of the security story, but not all of it:
any page you visit can issue requests to 127.0.0.1, so a wide-open CORS policy
would let an arbitrary website spend your OpenSubtitles quota and read your
cache. Hence the origin allowlist below - browser extensions, localhost pages,
and `file://` (which sends `Origin: null`) are permitted, everything else is
refused before any work is done.

Endpoints:
    GET  /health                  daemon and credential status
    GET  /search?title=...        guess a title and search; never costs quota
    POST /fetch  {"file_id": N}   download-or-serve-from-cache; may cost quota
    GET  /cached                  what is already on disk
    GET  /cached/{file_id}        cues for a cached subtitle
"""

from __future__ import annotations

import base64
import binascii
import errno
import json
import logging
import re
import threading
from http import HTTPStatus
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from typing import Any
from urllib.parse import parse_qs, urlparse

from . import matching, subtitles, titles
from .cache import Cache
from .config import CACHE_DIR, Config
from .opensubtitles import Client, OpenSubtitlesError, QuotaExceededError

logger = logging.getLogger(__name__)

# Origins allowed to talk to the daemon. Loopback binding stops other machines;
# this stops other *pages* on this machine.
_ALLOWED_ORIGIN = re.compile(
    r"""^(?:
        chrome-extension://[a-z]+
      | moz-extension://[0-9a-f-]+
      | safari-web-extension://[0-9A-Fa-f-]+
      | https?://(?:localhost|127\.0\.0\.1)(?::\d+)?
      | null
    )$""",
    re.VERBOSE,
)

MAX_BODY_BYTES = 64 * 1024

# Everything a search derives about its result set, and therefore everything a
# cache hit has to reproduce. Anything omitted here silently reverts to its
# default on a replay - which for the confidence flags means a doubtful result
# set coming back looking certain.
_CACHED_FIELDS = (
    "results",
    "resolved",
    "ambiguous_title",
    "other_titles",
    "low_confidence",
    "not_in_database",
    "error",
    "auto_attach_threshold",
)


class Service:
    """Everything the request handlers need, assembled once at startup."""

    def __init__(self, config: Config) -> None:
        self.config = config
        self.cache = Cache(CACHE_DIR)
        self.client = Client(config.api_key) if config.has_api_key else None
        self._lock = threading.Lock()

        if self.client and config.can_login:
            self.client.login(config.username or "", config.password or "")

    # --- operations ---------------------------------------------------------

    def health(self) -> dict[str, Any]:
        return {
            "ok": True,
            "has_api_key": self.config.has_api_key,
            "authenticated": bool(self.client and self.client.authenticated),
            "default_languages": list(self.config.default_languages),
            "cached_subtitles": len(self.cache.list_subtitles()),
        }

    def search(self, params: dict[str, list[str]]) -> dict[str, Any]:
        """Guess what is playing and find candidate subtitles.

        Accepts either a raw page `title` to be parsed, or an explicit `query`
        that bypasses the guesser - which is what the extension sends once the
        user has corrected a bad guess.
        """
        raw_title = _first(params, "title") or ""
        explicit = _first(params, "query")

        guessed = titles.guess(raw_title)
        query = explicit or guessed.query
        year = _first_int(params, "year") or (None if explicit else guessed.year)
        season = _first_int(params, "season")
        episode = _first_int(params, "episode")
        if season is None and episode is None and not explicit:
            season, episode = guessed.season, guessed.episode

        languages = _languages(params, self.config.default_languages)
        imdb_id = _first(params, "imdb_id")

        response: dict[str, Any] = {
            "guess": {
                "query": guessed.query,
                "year": guessed.year,
                "season": guessed.season,
                "episode": guessed.episode,
            },
            "used": {
                "query": query,
                "year": year,
                "season": season,
                "episode": episode,
                "languages": list(languages),
            },
            "results": [],
        }

        if not query:
            response["error"] = "no searchable title; type one in"
            return response
        if not self.client:
            response["error"] = "no OpenSubtitles API key configured"
            return response

        key = _cache_key(query, languages, year, season, episode, imdb_id)
        cached = self.cache.get_search(key)
        if cached is not None:
            # Restore the whole derived envelope, not just the rows. The
            # confidence flags are conclusions about this result set; dropping
            # them on a cache hit would render a low-confidence search as
            # though it were a confident one.
            response.update(cached)
            response["from_cache"] = True
            # Except what is a fact about the download cache rather than about
            # the search - that is re-derived, never replayed. See below.
            self._apply_cache_state(response, languages)
            return response

        try:
            found, resolved, rivals = self._search_upstream(
                query=query,
                languages=languages,
                year=year,
                season=season,
                episode=episode,
                imdb_id=imdb_id,
            )
        except OpenSubtitlesError as err:
            response["error"] = str(err)
            return response

        if resolved is not None:
            response["resolved"] = {
                "title": resolved.title,
                "year": resolved.year,
                "imdb_id": resolved.imdb_id,
                "type": resolved.feature_type,
            }
            # Titles this common cannot be resolved from the title alone. Say so
            # and hand over the alternatives, rather than presenting a coin toss
            # as an answer.
            if rivals:
                response["ambiguous_title"] = True
                response["other_titles"] = [
                    {
                        "title": other.title,
                        "year": other.year,
                        "imdb_id": other.imdb_id,
                        "type": other.feature_type,
                    }
                    for other in rivals
                ]
        elif not found:
            # /features knows the whole catalogue. If it has never heard of the
            # title, no query rewriting will help - the subtitles do not exist.
            # Saying so is more useful than 187 near-miss episodes.
            response["error"] = (
                f'OpenSubtitles has no subtitles for "{query}". '
                "Check the title, or transcribe the audio instead."
            )
            response["not_in_database"] = True
            return response

        results = [item.as_dict() for item in found]

        for item in results:
            item["match_score"] = matching.best_score(
                query,
                [str(item.get("movie_name") or ""), str(item.get("release") or "")],
                query_year=year,
                candidate_year=item.get("year"),
            )

        # Rank by match first. OpenSubtitles' own ordering is fuzzy enough to
        # put an unrelated film on top, which is how "Ekusute" got downloaded
        # for a Crime 101 search. Score is bucketed to one decimal so that among
        # equally plausible matches, trust and popularity still decide.
        #
        # Episode agreement outranks everything: for a series, every result
        # scores identically on title, and uploads mislabelled with the wrong
        # episode are common enough that ignoring the field puts the wrong
        # instalment first.
        def rank(item: dict[str, Any]) -> tuple[int, float, bool, int]:
            return (
                _episode_agreement(item, season, episode),
                round(item["match_score"], 1),
                item["from_trusted"],
                item["download_count"],
            )

        results.sort(key=rank, reverse=True)

        plausible = [item for item in results if item["match_score"] >= matching.VISIBLE_THRESHOLD]
        if plausible:
            response["results"] = plausible
        else:
            # Nothing resembles the query. Show a few anyway - the title guess
            # may be wrong rather than the film missing - but say so, so the UI
            # does not present junk as an answer.
            response["results"] = results[:5]
            response["low_confidence"] = True

        response["auto_attach_threshold"] = matching.AUTO_ATTACH_THRESHOLD

        # Stored before the cache state is applied, so what is kept is the
        # upstream answer in upstream order.
        self.cache.put_search(key, {k: response[k] for k in _CACHED_FIELDS if k in response})

        self._apply_cache_state(response, languages)
        return response

    def _apply_cache_state(self, response: dict[str, Any], languages: tuple[str, ...]) -> None:
        """Mark what is already downloaded, and float it to the top.

        Deliberately *not* stored with the search envelope, and re-run on every
        reply including a replayed one. Both of these are facts about the
        download cache, not about the search, and the envelope lives for six
        hours - long enough for anything to have been downloaded or deleted
        since.

        Frozen into the envelope they went stale immediately, and the cost was
        the thing the cache exists to prevent: search, download something from
        the panel, search again, and the replay still ranked a *different*
        upload of the same film first. Auto-attach took it and spent one of ten
        daily downloads on a subtitle already on disk.
        """
        results = response.get("results")
        if not isinstance(results, list):
            return

        on_disk = {item.file_id for item in self.cache.list_subtitles()}
        for item in results:
            item["cached"] = item["file_id"] in on_disk

        # A held file costs nothing, so auto-attach should reach for it before
        # spending a download on another upload of the same film.
        resolved = response.get("resolved")
        imdb_id = resolved.get("imdb_id") if isinstance(resolved, dict) else None
        owned = self.cache.find_for_title(imdb_id, languages)

        already = None
        if owned is not None:
            already = next(
                (item for item in results if item["file_id"] == owned.file_id), None
            )

        if already is not None:
            results.remove(already)
            results.insert(0, already)
            response["reusing_cached"] = True
        else:
            # Both directions: a promotion that no longer applies has to go,
            # or a deleted subtitle would still be advertised as held.
            response.pop("reusing_cached", None)

    def _search_upstream(
        self,
        *,
        query: str,
        languages: tuple[str, ...],
        year: int | None,
        season: int | None,
        episode: int | None,
        imdb_id: str | None,
    ) -> tuple[list[Any], Any, list[Any]]:
        """Resolve the title, then search for it exactly.

        `/subtitles?query=` is fuzzy and always returns something, so it cannot
        distinguish "wrong title" from "not in the database". `/features` can:
        it is the title index. When it recognises the title we search by IMDb
        id, which is exact; when it does not, we fall back to a fuzzy query so
        a title the index spells differently is still findable.

        Both calls are free - only downloading is metered.
        """
        client = self.client
        assert client is not None  # callers check has_api_key first

        if imdb_id:
            return client.search(
                imdb_id=imdb_id, languages=languages, season=season, episode=episode
            ), None, []

        resolved, rivals = self._pick_feature(query, year, want_series=season is not None)

        if resolved is not None:
            if resolved.is_series:
                found = client.search(
                    parent_imdb_id=resolved.imdb_id,
                    languages=languages,
                    season=season,
                    episode=episode,
                )
                # A series matched but the episode has no subtitles: fall back
                # to the show as a whole rather than reporting nothing.
                if not found and (season is not None or episode is not None):
                    found = client.search(
                        parent_imdb_id=resolved.imdb_id, languages=languages
                    )
            else:
                found = client.search(imdb_id=resolved.imdb_id, languages=languages)

            if found:
                return found, resolved, rivals

        # No confident title match. Narrow by media type so a film search does
        # not drown in episodes that merely share a word.
        media_type = "episode" if season is not None else "movie"
        found = client.search(
            query=query,
            languages=languages,
            year=year,
            season=season,
            episode=episode,
            media_type=media_type,
        )
        if found:
            return found, resolved, rivals

        # Last resort: unfiltered. Catches series searched without an episode
        # number, and anything the type filter misclassifies.
        return client.search(
            query=query, languages=languages, year=year, season=season, episode=episode
        ), resolved, rivals

    def _pick_feature(
        self, query: str, year: int | None, *, want_series: bool
    ) -> tuple[Any, list[Any]]:
        """Best index entry for the query, plus any equally-good rivals.

        A common title is not a rare case. "Mercy" matches 18 entries in the
        index exactly, so title similarity alone cannot choose between them and
        whatever breaks the tie IS the answer. Breaking it on subtitle count -
        which is what this used to do - picks the most-subtitled thing sharing
        the name, and returned a 2016 television episode for a 2025 film.

        So the tie is broken on things that actually indicate identity: whether
        the entry is the right kind of thing, and how close its year is. Rivals
        that survive all of that are returned rather than silently discarded,
        because at that point the daemon genuinely cannot tell and the user can.
        """
        client = self.client
        assert client is not None

        try:
            candidates = client.features(query)
        except OpenSubtitlesError as err:
            # The index is an optimisation, not a requirement. Losing it costs
            # precision, not the search.
            logger.warning("feature lookup failed, falling back to fuzzy search: %s", err)
            return None, []

        # Title similarity only. Feeding the year in here would apply the
        # scorer's clash penalty, and a one-year disagreement is normal enough
        # that it dropped an exact title below the threshold and resolved to
        # nothing. The year is a ranking dimension below, not a score modifier.
        scored = [
            (matching.score(query, feature.title), feature)
            for feature in candidates
            if feature.subtitles_count > 0
        ]
        if not scored:
            return None, []

        def rank(pair: tuple[float, Any]) -> tuple[float, int, int, int]:
            score, feature = pair
            return (
                round(score, 1),
                _type_agreement(feature, want_series=want_series),
                _year_agreement(feature.year, year),
                feature.subtitles_count,
            )

        scored.sort(key=rank, reverse=True)
        best_score, best = scored[0]
        if best_score < matching.AUTO_ATTACH_THRESHOLD:
            return None, []

        # Anything indistinguishable from the winner on every signal except
        # popularity is a rival, not a runner-up.
        top = rank(scored[0])[:3]
        rivals = [feature for pair, feature in ((rank(p), p[1]) for p in scored[1:])
                  if pair[:3] == top][:5]
        if rivals:
            logger.info(
                "%r matches %d entries equally well; picked %s (%s, %s)",
                query, len(rivals) + 1, best.title, best.year, best.feature_type,
            )
        return best, rivals

    def fetch(self, body: dict[str, Any]) -> dict[str, Any]:
        """Return cues for a file_id, downloading only if not already cached."""
        file_id = body.get("file_id")
        if not isinstance(file_id, int):
            return {"error": "file_id must be an integer"}

        cached = self.cache.get_subtitle(file_id)
        if cached is not None:
            return _cues_response(cached.read_bytes(), dict(cached.meta), from_cache=True)

        if not self.client:
            return {"error": "no OpenSubtitles API key configured"}

        # Serialised: two tabs asking for the same subtitle at once would
        # otherwise spend two units of a ten-per-day quota on one file.
        with self._lock:
            cached = self.cache.get_subtitle(file_id)
            if cached is not None:
                return _cues_response(cached.read_bytes(), dict(cached.meta), from_cache=True)

            try:
                downloaded = self.client.download(file_id)
            except QuotaExceededError as err:
                return {"error": str(err), "quota_exceeded": True}
            except OpenSubtitlesError as err:
                return {"error": str(err)}

            # Context from the caller, so the cache knows which film this file
            # belongs to. Without it a later search for the same title cannot
            # tell that it is already downloaded.
            meta: dict[str, Any] = {
                "file_id": file_id,
                "file_name": downloaded.file_name,
                "remaining_quota": downloaded.remaining,
                "imdb_id": str(body.get("imdb_id") or "") or None,
                "language": str(body.get("language") or "") or None,
                "movie_name": str(body.get("movie_name") or "") or None,
                "release": str(body.get("release") or "") or None,
            }
            stored = self.cache.put_subtitle(file_id, downloaded.content, meta)

            duplicate = self.cache.find_by_content(str(stored.meta.get("sha256")))
            if duplicate is not None and duplicate.file_id != file_id:
                # Two uploads of the same film with byte-identical content. The
                # download is already spent, but say so - it means the title
                # context above was missing or wrong on one of them.
                logger.info(
                    "file_id %d is byte-identical to cached %d; a download was spent "
                    "on a subtitle already held",
                    file_id,
                    duplicate.file_id,
                )

        if downloaded.remaining is not None:
            logger.info("Downloaded %s; %s downloads left today", downloaded.file_name,
                        downloaded.remaining)

        return _cues_response(stored.read_bytes(), dict(stored.meta), from_cache=False)

    def import_subtitle(self, body: dict[str, Any]) -> dict[str, Any]:
        """Take a subtitle the extension downloaded while this was not running.

        The extension can now do the whole fetch itself, which means a download
        can be spent while the daemon is stopped. Its cache is a separate store
        - a browser extension has no filesystem, so it cannot write to this one
        - and without a way back in, the daemon would later spend a *second*
        download on a file already held. That is the whole point of the cache,
        so the two are converged instead: this is the direction the extension
        cannot reach any other way.

        Bytes arrive base64-encoded because the transport is JSON. They are
        stored verbatim, so the file on disk is the one OpenSubtitles served and
        its sha256 matches on both sides.
        """
        file_id = body.get("file_id")
        if not isinstance(file_id, int):
            return {"error": "file_id must be an integer"}

        existing = self.cache.get_subtitle(file_id)
        if existing is not None:
            return {"imported": False, "reason": "already held", "file_id": file_id}

        try:
            raw = base64.b64decode(str(body.get("content") or ""), validate=True)
        except (ValueError, binascii.Error):
            return {"error": "content must be base64"}
        if not raw:
            return {"error": "content was empty"}

        meta_in = body.get("meta")
        meta_in = meta_in if isinstance(meta_in, dict) else {}
        # Only the fields this cache defines, so a future extension version
        # cannot write arbitrary keys into the sidecar.
        meta: dict[str, Any] = {
            "file_id": file_id,
            "file_name": str(meta_in.get("file_name") or f"{file_id}.srt"),
            "imdb_id": str(meta_in.get("imdb_id") or "") or None,
            "language": str(meta_in.get("language") or "") or None,
            "movie_name": str(meta_in.get("movie_name") or "") or None,
            "release": str(meta_in.get("release") or "") or None,
            "imported_from": "extension",
        }
        stored = self.cache.put_subtitle(file_id, raw, meta)
        logger.info(
            "imported file_id %d from the extension (%d bytes)", file_id, len(raw)
        )
        return {"imported": True, "file_id": file_id, "sha256": stored.meta.get("sha256")}

    def cached_list(self) -> dict[str, Any]:
        return {
            "subtitles": [
                # Size comes from the file rather than the sidecar: it is what
                # the cache manager shows, and a sidecar can outlive an edit.
                {"file_id": item.file_id, "bytes": item.path.stat().st_size, **item.meta}
                for item in self.cache.list_subtitles()
            ]
        }

    def forget(self, file_id: int) -> dict[str, Any]:
        return {"deleted": self.cache.delete_subtitle(file_id), "file_id": file_id}

    def forget_all(self, *, searches_only: bool = False) -> dict[str, Any]:
        if searches_only:
            return {"searches": self.cache.clear_searches()}
        return {
            "subtitles": self.cache.clear_subtitles(),
            "searches": self.cache.clear_searches(),
        }

    def cached_one(self, file_id: int, *, with_content: bool = False) -> dict[str, Any]:
        cached = self.cache.get_subtitle(file_id)
        if cached is None:
            return {"error": "not cached"}
        raw = cached.read_bytes()
        response = _cues_response(raw, dict(cached.meta), from_cache=True)
        if with_content:
            # The bytes themselves, for the extension to copy into its own store
            # during a sync. Cues would not do: the sha256 is over the bytes, and
            # re-encoding the text would not reproduce them.
            response["content"] = base64.b64encode(raw).decode("ascii")
        return response


class PortInUseError(RuntimeError):
    """Something is already listening on the port the daemon wants."""

    def __init__(self, port: int) -> None:
        super().__init__(f"port {port} is already in use")
        self.port = port


def serve(config: Config) -> None:
    """Run the daemon until interrupted."""
    # Bind before building the Service. Constructing it performs an
    # OpenSubtitles login, and paying for a network round trip only to then
    # fail on the port is both slow and confusing to read in the log.
    class Handler(_Handler):
        pass

    try:
        server = ThreadingHTTPServer(("127.0.0.1", config.port), Handler)
    except OSError as err:
        if err.errno == errno.EADDRINUSE:
            raise PortInUseError(config.port) from err
        raise

    Handler.service = Service(config)
    logger.info("subtitle-daemon listening on http://127.0.0.1:%d", config.port)
    if not config.has_api_key:
        logger.warning(
            "No OpenSubtitles API key configured - search and download are disabled. "
            "Create one at https://www.opensubtitles.com/en/consumers and put it in "
            "subtitle-daemon/config.local.json"
        )
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        logger.info("shutting down")
    finally:
        server.server_close()


class _Handler(BaseHTTPRequestHandler):
    """Routes requests to `Service`. One instance per request, as usual."""

    service: Service
    server_version = "subtitle-daemon/0.1"

    def do_OPTIONS(self) -> None:  # noqa: N802 - name fixed by BaseHTTPRequestHandler
        origin = self.headers.get("Origin")
        if origin and not _ALLOWED_ORIGIN.match(origin):
            self._send(HTTPStatus.FORBIDDEN, {"error": "origin not allowed"})
            return
        self.send_response(HTTPStatus.NO_CONTENT)
        self._cors_headers(origin)
        self.send_header("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")
        self.send_header("Access-Control-Max-Age", "600")
        self.end_headers()

    def do_GET(self) -> None:  # noqa: N802
        if not self._origin_ok():
            return
        parsed = urlparse(self.path)
        params = parse_qs(parsed.query)

        if parsed.path == "/health":
            self._send(HTTPStatus.OK, self.service.health())
        elif parsed.path == "/search":
            self._send(HTTPStatus.OK, self.service.search(params))
        elif parsed.path == "/cached":
            self._send(HTTPStatus.OK, self.service.cached_list())
        elif match := re.fullmatch(r"/cached/(\d+)", parsed.path):
            self._send(
                HTTPStatus.OK,
                self.service.cached_one(
                    int(match.group(1)), with_content=bool(params.get("content"))
                ),
            )
        else:
            self._send(HTTPStatus.NOT_FOUND, {"error": "no such endpoint"})

    def do_POST(self) -> None:  # noqa: N802
        if not self._origin_ok():
            return
        parsed = urlparse(self.path)
        if parsed.path not in ("/fetch", "/cached"):
            self._send(HTTPStatus.NOT_FOUND, {"error": "no such endpoint"})
            return

        try:
            length = int(self.headers.get("Content-Length") or 0)
        except ValueError:
            self._send(HTTPStatus.BAD_REQUEST, {"error": "bad Content-Length"})
            return
        if length > MAX_BODY_BYTES:
            self._send(HTTPStatus.REQUEST_ENTITY_TOO_LARGE, {"error": "body too large"})
            return

        try:
            body = json.loads(self.rfile.read(length) or b"{}")
        except (ValueError, OSError):
            self._send(HTTPStatus.BAD_REQUEST, {"error": "body must be JSON"})
            return
        if not isinstance(body, dict):
            self._send(HTTPStatus.BAD_REQUEST, {"error": "body must be a JSON object"})
            return

        if parsed.path == "/cached":
            self._send(HTTPStatus.OK, self.service.import_subtitle(body))
        else:
            self._send(HTTPStatus.OK, self.service.fetch(body))

    def do_DELETE(self) -> None:  # noqa: N802
        if not self._origin_ok():
            return
        parsed = urlparse(self.path)
        params = parse_qs(parsed.query)

        if match := re.fullmatch(r"/cached/(\d+)", parsed.path):
            self._send(HTTPStatus.OK, self.service.forget(int(match.group(1))))
        elif parsed.path == "/cached":
            self._send(
                HTTPStatus.OK,
                self.service.forget_all(searches_only=bool(params.get("searches_only"))),
            )
        else:
            self._send(HTTPStatus.NOT_FOUND, {"error": "no such endpoint"})

    def log_message(self, fmt: str, *args: Any) -> None:
        # Route through logging instead of BaseHTTPRequestHandler's stderr writes.
        logger.debug("%s - %s", self.address_string(), fmt % args)

    # --- helpers ------------------------------------------------------------

    def _origin_ok(self) -> bool:
        origin = self.headers.get("Origin")
        # No Origin header means a direct call (curl, the address bar), not a
        # cross-site request. Those are the user's own, so allow them.
        if origin is None or _ALLOWED_ORIGIN.match(origin):
            return True
        self._send(HTTPStatus.FORBIDDEN, {"error": "origin not allowed"})
        return False

    def _cors_headers(self, origin: str | None) -> None:
        self.send_header("Access-Control-Allow-Origin", origin or "*")
        self.send_header("Vary", "Origin")

    def _send(self, status: HTTPStatus, payload: dict[str, Any]) -> None:
        raw = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(raw)))
        self._cors_headers(self.headers.get("Origin"))
        self.end_headers()
        self.wfile.write(raw)


def _type_agreement(feature: Any, *, want_series: bool) -> int:
    """1 when the entry is the kind of thing we are looking for, else -1.

    A page with no season or episode detected is a film until shown otherwise.
    Without this, television episodes sharing a film's title win on subtitle
    count, which is how a 2016 episode was chosen for a 2025 film.
    """
    return 1 if feature.is_series == want_series else -1


def _year_agreement(candidate_year: int | None, wanted: int | None) -> int:
    """2 exact, 1 within a year, 0 unknown, -1 further away.

    Within-a-year counts as agreement on purpose. Release years disagree
    routinely between festival and wide release and between regions - Prime
    lists the film in question as 2025 and OpenSubtitles as 2026 - so treating
    the year as a filter would reject the correct entry. It is a preference.
    """
    if wanted is None or candidate_year is None:
        return 0
    delta = abs(candidate_year - wanted)
    if delta == 0:
        return 2
    if delta <= 1:
        return 1
    return -1


def _episode_agreement(item: dict[str, Any], season: int | None, episode: int | None) -> int:
    """1 if the result is the requested episode, -1 if it is a different one.

    0 covers "not asked for" and "result does not say", which must sort between
    the two: a result with no episode metadata is not evidence of a mismatch.
    """
    if season is None and episode is None:
        return 0
    item_season, item_episode = item.get("season"), item.get("episode")
    if item_season is None and item_episode is None:
        return 0
    if (season is None or item_season == season) and (
        episode is None or item_episode == episode
    ):
        return 1
    return -1


def _cues_response(raw: bytes, meta: dict[str, Any], *, from_cache: bool) -> dict[str, Any]:
    text, encoding = subtitles.decode(raw)
    cues = subtitles.parse_srt(text)
    return {
        "meta": {**meta, "encoding": encoding, "cue_count": len(cues)},
        "cues": subtitles.to_json(cues),
        "vtt": subtitles.to_vtt(cues),
        "from_cache": from_cache,
    }


def _cache_key(
    query: str,
    languages: tuple[str, ...],
    year: int | None,
    season: int | None,
    episode: int | None,
    imdb_id: str | None,
) -> str:
    parts = [query.lower(), ",".join(sorted(languages)), str(year), str(season), str(episode),
             str(imdb_id)]
    return re.sub(r"[^a-z0-9]+", "_", "|".join(parts).lower())[:120]


def _first(params: dict[str, list[str]], key: str) -> str | None:
    values = params.get(key)
    return values[0].strip() if values and values[0].strip() else None


def _first_int(params: dict[str, list[str]], key: str) -> int | None:
    value = _first(params, key)
    if value is None:
        return None
    try:
        return int(value)
    except ValueError:
        return None


def _languages(params: dict[str, list[str]], default: tuple[str, ...]) -> tuple[str, ...]:
    raw = _first(params, "languages")
    if not raw:
        return default
    parsed = tuple(part.strip().lower() for part in raw.split(",") if part.strip())
    return parsed or default
