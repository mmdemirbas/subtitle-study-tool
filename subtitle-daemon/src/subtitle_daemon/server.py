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
    GET  /lookup?q=...            a word's dictionary entry, for study mode
    POST /gloss                   many words with their lines, glossed ahead
"""

from __future__ import annotations

import base64
import binascii
import errno
import hashlib
import json
import logging
import re
import threading
from datetime import datetime, timezone
from http import HTTPStatus
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from typing import Any
from urllib.parse import parse_qs, urlparse

from . import matching, subtitles, titles
from .cache import Cache
from .config import CACHE_DIR, LOG_DIR, Config
from .lookups import Lookups
from .opensubtitles import Client, Feature, OpenSubtitlesError, QuotaExceededError
from .translate_jobs import Jobs

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

# An import carries a whole subtitle file, base64-encoded, so it is the one
# body that is legitimately larger than a request. Measured over the 273 files
# in this machine's cache: the median encodes to 56KB and the largest to 200KB,
# and 96 of them - a third of what is held - did not fit under the 64KB
# ceiling. Those imports were refused with "body too large", which meant the
# extension paid a second download for a file the daemon could have been given.
MAX_IMPORT_BODY_BYTES = 4 * 1024 * 1024

# The running log is the one body that is legitimately large: a single
# alignment entry carries two subtitle files' worth of timings. It is written
# straight to a file and never parsed into anything the rest of the daemon
# holds, so a bigger ceiling here costs disk, not memory.
MAX_LOG_BODY_BYTES = 64 * 1024 * 1024

_BODY_CEILINGS = {
    "/log": MAX_LOG_BODY_BYTES,
    "/cached": MAX_IMPORT_BODY_BYTES,
    # A whole subtitle's cues as JSON: the same ceiling as an import, which is
    # the same file arriving base64-encoded.
    "/translate": MAX_IMPORT_BODY_BYTES,
}

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
    "missing_languages",
    "available_languages",
    "error",
    "auto_attach_threshold",
)


def _stated_feature(imdb_id: str, title: str, year: int | None, season: int | None) -> Feature:
    """The index entry /features would have returned for an id the page gave.

    Everything downstream asks "was this title resolved?" and means "is this
    result set this programme, or a fuzzy guess at it". An id from the page
    answers yes as firmly as the index does, so it answers in the index's own
    shape rather than through a second flag nothing else reads. The count is
    zero because it only ever breaks ties between rivals, and an id has none.
    """
    return Feature(
        imdb_id=imdb_id,
        title=title,
        year=year,
        feature_type="Movie" if season is None else "Episode",
        subtitles_count=0,
    )


class Service:
    """Everything the request handlers need, assembled once at startup."""

    def __init__(self, config: Config) -> None:
        self.config = config
        self.cache = Cache(CACHE_DIR)
        self.lookups = Lookups(
            CACHE_DIR,
            gloss_model=config.gloss_model or "",
            gloss_url=config.gloss_url or "",
            gloss_key=config.gloss_api_key,
            google_key=config.google_api_key,
        )
        self.client = Client(config.api_key) if config.has_api_key else None
        # Whole-subtitle translations, as jobs that outlive their request. Its
        # model and endpoint fall back to the gloss tier's, and the queue picks
        # up whatever a previous process left unfinished.
        self.jobs = Jobs(
            CACHE_DIR / "translate-jobs",
            self.cache,
            model=config.translate_model or "",
            url=config.translate_url or "",
            key=config.translate_api_key or "",
        )
        self.jobs.resume_all()
        self._lock = threading.Lock()
        # Lines and words per cached file_id. A file on disk does not change,
        # so this is held for the life of the process. See _measure_cached.
        self._measured: dict[int, dict[str, int]] = {}

        if self.client and config.can_login:
            self.client.login(config.username or "", config.password or "")

    def _measure_cached(self, file_id: int) -> dict[str, int] | None:
        """Lines and words for a file already on disk, or None.

        Only for rows that are already cached, which is a handful of any result
        set. Nothing is downloaded to measure anything: a download is metered,
        and spending one to answer "is this subtitle any good" would cost the
        reader the very thing they are choosing between.
        """
        held = self._measured.get(file_id)
        if held is not None:
            return held
        item = self.cache.get_subtitle(file_id)
        if item is None:
            return None
        try:
            text, _ = subtitles.decode(item.read_bytes())
            counted = subtitles.measure(subtitles.to_json(subtitles.parse_srt(text)))
        except (OSError, ValueError):
            return None
        self._measured[file_id] = counted
        return counted

    # --- operations ---------------------------------------------------------

    def append_log(self, body: dict[str, Any]) -> dict[str, Any]:
        """Somewhere real for the extension's running log to go.

        A browser extension cannot write to a directory. The only API that puts
        a real file on disk is the download machinery, and that announces every
        file it writes - which, for something that records as you watch, means a
        popup every few seconds. The daemon has no such problem: it is a program
        with a filesystem.

        One line of JSON per entry, appended. Appending means a long session
        costs one file that grows rather than a directory of thousands, and a
        crash halfway through a write costs the last line rather than the file.
        """
        entries = body.get("entries")
        if not isinstance(entries, list):
            return {"error": "entries must be a list"}

        LOG_DIR.mkdir(parents=True, exist_ok=True)
        day = datetime.now(timezone.utc).strftime("%Y-%m-%d")
        path = LOG_DIR / f"{day}.jsonl"
        written = 0
        with self._lock, path.open("a", encoding="utf-8") as handle:
            for entry in entries:
                handle.write(json.dumps(entry, ensure_ascii=False) + "\n")
                written += 1
        return {"ok": True, "written": written, "file": str(path)}

    def health(self) -> dict[str, Any]:
        return {
            "ok": True,
            "has_api_key": self.config.has_api_key,
            "authenticated": bool(self.client and self.client.authenticated),
            "default_languages": list(self.config.default_languages),
            "cached_subtitles": len(self.cache.list_subtitles()),
            # Which model would translate a whole subtitle, so the offer can
            # name it - and how long a line takes on it, once one has run.
            "translate_model": self.jobs.model,
            "translating": sum(1 for job in self.jobs.list() if job["status"] in ("queued", "running")),
        }

    def lookup(self, params: dict[str, list[str]]) -> dict[str, Any]:
        """A word's dictionary entry. Free, cached on disk, no quota involved.

        `sentence` is the subtitle line the word was said in, and it is what
        separates "spare a minute" from "a spare tyre". `film`, `before` and
        `after` are the rest of what the caller knows about that line - which
        programme it is from and the lines either side of it. All four are
        optional: a caller that has none of them gets the context-free answer it
        always got.
        """
        return self.lookups.get(
            _first(params, "q") or "",
            _first(params, "lang") or "en",
            _first(params, "to") or "",
            _first(params, "sentence") or "",
            _first(params, "film") or "",
            _first(params, "before") or "",
            _first(params, "after") or "",
        )

    def gloss(self, body: dict[str, Any]) -> dict[str, Any]:
        """Many words at once, each with the line it was said in.

        The extension holds the whole subtitle file before the film starts, so
        it knows which words it is going to mark. Answering them ahead is what
        turns a 634ms lookup into a disk read - see `gloss_many`.

        `film` is said once for the whole request rather than per item, because
        one request is one programme. Each item may carry `before` and `after`,
        the subtitle lines either side of its own.
        """
        items = body.get("items")
        if not isinstance(items, list):
            return {"error": "items must be a list"}
        # Which tier answered, counted and sent back with the answers. See
        # gloss_many: from the overlay a slow model and a missing key look
        # identical, and both look like a word with no translation.
        tally: dict[str, int] = {}
        glosses = self.lookups.gloss_many(
            items,
            str(body.get("language") or "en"),
            str(body.get("target") or ""),
            str(body.get("film") or ""),
            tally=tally,
        )
        return {"glosses": glosses, "from": tally}

    def search(self, params: dict[str, list[str]]) -> dict[str, Any]:
        """Guess what is playing and find candidate subtitles.

        Accepts either a raw page `title` to be parsed, or an explicit `query`
        that bypasses the guesser - which is what the extension sends once the
        user has corrected a bad guess.
        """
        raw_title = _first(params, "title") or ""
        explicit = _first(params, "query")

        # Whatever text is being searched on gets parsed the same way, typed or
        # taken from the page. The rule and the reasoning are in titles.resolve,
        # which the extension's no-daemon path has a port of - one place, so the
        # two cannot drift the way they did before.
        guessed = titles.guess(explicit or raw_title)
        used = titles.resolve(
            title=raw_title,
            query=explicit or "",
            year=_first_int(params, "year"),
            season=_first_int(params, "season"),
            episode=_first_int(params, "episode"),
        )
        query, year, season, episode = used.query, used.year, used.season, used.episode

        languages = _languages(params, self.config.default_languages)
        imdb_id = _first(params, "imdb_id")
        # Other names for the same programme, best first.
        #
        # A film has one title per country and the index holds whichever one the
        # uploader typed, so searching an English name for a Turkish subtitle
        # finds a fraction of what is there. Repeated rather than
        # comma-separated: a title may contain a comma, and a delimiter that can
        # appear inside a value is not a delimiter.
        alt_titles = [text.strip() for text in params.get("alt", []) if text.strip()]

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

        key = _cache_key(query, languages, year, season, episode, imdb_id, alt_titles)
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
                alt_titles=alt_titles,
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

            # "No Turkish subtitle" and "no Turkish subtitle exists" are
            # different answers, and only one of them is worth trying again.
            # The title index says which languages a programme has, it comes
            # back with the resolution and it costs nothing, so an empty result
            # can name what is there instead of reading as a failed search.
            #
            # "Not Suitable for Work" (2026) is the case that prompted this: 13
            # languages, none of them Turkish, on every episode of the series.
            available = resolved.languages
            if available:
                have = {code.lower() for code in available}
                missing = [
                    language for language in languages if language.lower() not in have
                ]
                if missing:
                    response["missing_languages"] = missing
                    response["available_languages"] = available
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

        # Scored against every name the programme is known by, and the best of
        # them wins. Each upload carries one title, whichever one the uploader
        # typed, so a row holding the Turkish name of an English film matches a
        # name the page gave us and not the one that was typed - and scoring it
        # against the typed name alone would mark the right answer "weak match"
        # and rank it below a wrong one.
        names = [query, *alt_titles]
        for item in results:
            candidate = [str(item.get("movie_name") or ""), str(item.get("release") or "")]
            item["match_score"] = max(
                matching.best_score(
                    name, candidate, query_year=year, candidate_year=item.get("year")
                )
                for name in names
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
            # And how much is in it, for the ones that can be answered without
            # spending anything. See _measure_cached.
            if item["cached"]:
                item.update(self._measure_cached(item["file_id"]) or {})

        # A held file costs nothing, so auto-attach should reach for it before
        # spending a download on another upload of the same film.
        resolved = response.get("resolved")
        imdb_id = resolved.get("imdb_id") if isinstance(resolved, dict) else None

        self._add_generated(response, results, imdb_id, languages)

        # A series searched without an episode, and what the disk remembers.
        #
        # Prime Video plays an episode in place on the show's own page, where
        # nothing names the episode, so the search comes back as "which one?"
        # and the viewer types it. Measured on one evening of Monk: S01E01,
        # then S01E02, then S01E03, each typed by hand. The furthest episode
        # already fetched for this show is the best guess there is at the next
        # one, and it is offered rather than taken - a guess this good is still
        # a guess. Here rather than in the envelope because it is a fact about
        # the download cache, and re-derived on every reply for that reason.
        used = response.get("used") if isinstance(response.get("used"), dict) else {}
        is_series = isinstance(resolved, dict) and "tv" in str(resolved.get("type") or "").lower()
        if is_series and used.get("season") is None and used.get("episode") is None:
            last = self.cache.latest_episode(imdb_id)
            if last is not None:
                response["last_episode"] = {"season": last[0], "episode": last[1]}
                response["next_episode"] = {"season": last[0], "episode": last[1] + 1}

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

    def _add_generated(
        self,
        response: dict[str, Any],
        results: list[dict[str, Any]],
        imdb_id: Any,
        languages: tuple[str, ...],
    ) -> None:
        """Rows for the subtitles this daemon made itself, for this title.

        A translation made here is on no index, so no search returns it and
        no envelope holds it: it is added on every reply from the disk, the
        way `cached` is re-derived, for the programme the search resolved and
        the episode it asked for. Ranked as identified with a full score: it
        was made from a file for exactly this episode, and its whole reason to
        exist is that nothing else in its language does. Where a human upload
        appears later it sits beside this one with its own name, and the
        `generated` flag is what the panel shows.

        The language then stops being "missing": the search's absence note is
        about what can be had, and this can.
        """
        if not imdb_id:
            return
        used = response.get("used") if isinstance(response.get("used"), dict) else {}
        asked = (used.get("season"), used.get("episode"))
        wanted = {code.lower().split("-")[0] for code in languages}
        present = {item.get("file_id") for item in results}
        added: list[str] = []
        for held in self.cache.list_subtitles():
            if not held.meta.get("generated") or held.file_id in present:
                continue
            if str(held.meta.get("imdb_id") or "") != str(imdb_id):
                continue
            language = str(held.meta.get("language") or "").lower()
            if wanted and language.split("-")[0] not in wanted:
                continue
            if asked != (None, None) and held.episode() != asked:
                continue
            row: dict[str, Any] = {
                "file_id": held.file_id,
                "language": language,
                "movie_name": held.meta.get("movie_name") or "",
                "release": held.meta.get("release") or "",
                "season": held.meta.get("season"),
                "episode": held.meta.get("episode"),
                "download_count": 0,
                "from_trusted": False,
                "match_score": 1.0,
                "identified": True,
                "cached": True,
                "generated": True,
                "model": held.meta.get("model"),
                "unrepaired": held.meta.get("unrepaired"),
            }
            row.update(self._measure_cached(held.file_id) or {})
            results.insert(0, row)
            added.append(language.split("-")[0])
        if not added:
            return
        missing = response.get("missing_languages")
        if isinstance(missing, list):
            response["missing_languages"] = [code for code in missing if code not in added]
        available = response.get("available_languages")
        if isinstance(available, list):
            response["available_languages"] = sorted(set(available) | set(added))

    def _search_upstream(
        self,
        *,
        query: str,
        languages: tuple[str, ...],
        year: int | None,
        season: int | None,
        episode: int | None,
        imdb_id: str | None,
        alt_titles: list[str] | None = None,
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

        # An id names one thing, so it is asked for by itself.
        #
        # The season and episode do not go with it. `imdb_id` matches a
        # feature, and for an episode the feature IS the episode - the numbers
        # are already in it. Sending both is a combination the API does not
        # document, and the failure would be silent: an empty result set that
        # reads as "nobody has subtitled this". They still travel in `used`,
        # where the episode filter and the "which episode is this" guard read
        # them.
        #
        # The Feature is stated rather than left None, and that is the
        # difference between this path working and only looking as though it
        # does. A result set with no resolved title is scored against the
        # uploader's file name and refused below the threshold - on a search
        # that by construction cannot have found the wrong programme. The id
        # came from the page; every row is that programme.
        #
        # And an id that turns up nothing falls through to the title path
        # rather than reporting "not in the database". The id is a shortcut,
        # not the only route.
        if imdb_id:
            found = client.search(imdb_id=imdb_id, languages=languages)
            if found:
                return found, _stated_feature(imdb_id, query, year, season), []

        resolved, rivals = self._pick_feature(query, year, want_series=season is not None)

        # The name the page printed is not always the name the index holds.
        #
        # A film has one title per country. Searching "Once Upon a Crime" for a
        # Turkish subtitle finds a fraction of what searching its Turkish title
        # finds, because the uploader typed the title their audience knows. Any
        # other name for the same programme is therefore a second way into the
        # index - and once ONE of them resolves, everything below runs on an
        # IMDb id, where the language of the title stops mattering at all.
        #
        # Tried in order and only while nothing has resolved, so a page that
        # states nothing extra makes exactly the calls it always made.
        others = alt_titles or []
        for other in others:
            if resolved is not None:
                break
            resolved, rivals = self._pick_feature(
                other, year, want_series=season is not None
            )

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
        # not drown in episodes that merely share a word. Each name in turn,
        # for the reason above: the index may hold only one of them.
        names = [query, *others]
        media_type = "episode" if season is not None else "movie"
        for name in names:
            found = client.search(
                query=name,
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
        found = []
        for name in names:
            found = client.search(
                query=name, languages=languages, year=year, season=season, episode=episode
            )
            if found:
                break
        return found, resolved, rivals

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
        # Counted per language, not by the scalar. A Tvshow's scalar counts
        # only what is filed against the show entry itself, so a series whose
        # subtitles all hang off its episodes reported zero and was dropped
        # here as empty - which is why the show entry, an exact title match,
        # never won and the exact `parent_imdb_id` + season + episode search
        # below was unreachable for those shows.
        scored = [
            (matching.score(query, feature.title), feature)
            for feature in candidates
            if feature.total_subtitles > 0
        ]
        if not scored:
            return None, []

        def rank(pair: tuple[float, Any]) -> tuple[float, int, int, int]:
            score, feature = pair
            return (
                round(score, 1),
                _type_agreement(feature, want_series=want_series),
                _year_agreement(feature.year, year),
                feature.total_subtitles,
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
        file_id = _file_id(body.get("file_id"))
        if file_id is None:
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
                # Stated rather than left to be read back out of the names
                # above: the names are the uploader's claim, these are what the
                # search asked for. See CachedSubtitle.episode. Through
                # _file_id for the same reason it exists - an int that is not
                # a bool - so {"season": true} does not become season 1.
                "season": _file_id(body.get("season")),
                "episode": _file_id(body.get("episode")),
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
        file_id = _file_id(body.get("file_id"))
        if file_id is None:
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

    # --- whole-subtitle translation ------------------------------------------

    def translate_start(self, body: dict[str, Any]) -> dict[str, Any]:
        """Start translating a subtitle, or report the job already doing so.

        The cues come in the body, whatever their source: a download the
        daemon holds, a page's own track the daemon has never seen, a file the
        reader opened. A cached file_id with no cues is read off the disk.
        Everything else about the film travels as meta and lands in the
        generated file's sidecar, so a later search finds it by title.
        """
        target = str(body.get("target") or "").strip().lower()
        if not re.fullmatch(r"[a-z]{2,3}(-[a-z0-9]{2,4})?", target):
            return {"error": "target must be a language code"}
        source_language = str(body.get("language") or "").strip().lower()
        if not source_language:
            return {"error": "language of the source is required"}
        if source_language.split("-")[0] == target.split("-")[0]:
            return {"error": "the source is already in that language"}

        raw_id = body.get("source_id")
        source_id = str(raw_id) if isinstance(raw_id, (int, str)) and not isinstance(raw_id, bool) and str(raw_id) else ""
        cues_in = body.get("cues")
        cues: list[subtitles.Cue] = []
        if isinstance(cues_in, list) and cues_in:
            for entry in cues_in:
                if not isinstance(entry, dict):
                    continue
                start, end = entry.get("start"), entry.get("end")
                text = entry.get("text")
                if isinstance(start, (int, float)) and isinstance(end, (int, float)) and isinstance(text, str) and text.strip():
                    cues.append(subtitles.Cue(start_ms=int(start), end_ms=int(end), text=text))
        elif (cached_id := _file_id(raw_id)) is not None:
            held = self.cache.get_subtitle(cached_id)
            if held is None:
                return {"error": "that subtitle is not on disk; send its cues"}
            text, _ = subtitles.decode(held.read_bytes())
            cues = subtitles.parse_srt(text)
            source_id = str(cached_id)
        if not source_id:
            return {"error": "source_id is required"}
        if not cues:
            return {"error": "nothing to translate"}

        meta = {
            "imdb_id": str(body.get("imdb_id") or "") or None,
            "movie_name": str(body.get("movie_name") or "") or None,
            "release": str(body.get("release") or "") or None,
            "season": _file_id(body.get("season")),
            "episode": _file_id(body.get("episode")),
            "label": str(body.get("label") or "") or None,
        }
        started = self.jobs.start(
            source_id=source_id, source_language=source_language, target=target, cues=cues, meta=meta,
        )
        if "error" not in started:
            logger.info(
                "translation %s: %s -> %s, %d cues, %s",
                started["job"], source_language, target, len(cues), started["status"],
            )
        return started

    def translate_status(self, key: str, *, with_cues: bool = False) -> dict[str, Any]:
        return self.jobs.status(key, with_cues=with_cues)

    def translate_list(self) -> dict[str, Any]:
        return {"jobs": self.jobs.list(), "model": self.jobs.model}

    def translate_cancel(self, key: str, *, forget: bool = False) -> dict[str, Any]:
        return self.jobs.cancel(key, forget=forget)

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
        elif parsed.path == "/lookup":
            self._send(HTTPStatus.OK, self.service.lookup(params))
        elif parsed.path == "/cached":
            self._send(HTTPStatus.OK, self.service.cached_list())
        elif parsed.path == "/translate":
            self._send(HTTPStatus.OK, self.service.translate_list())
        elif match := re.fullmatch(r"/translate/([A-Za-z0-9-]+)", parsed.path):
            self._send(
                HTTPStatus.OK,
                self.service.translate_status(match.group(1), with_cues=bool(params.get("cues"))),
            )
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
        if parsed.path not in ("/fetch", "/cached", "/log", "/gloss", "/translate"):
            self._send(HTTPStatus.NOT_FOUND, {"error": "no such endpoint"})
            return

        try:
            length = int(self.headers.get("Content-Length") or 0)
        except ValueError:
            self._send(HTTPStatus.BAD_REQUEST, {"error": "bad Content-Length"})
            return
        # Negative as well as unparseable. Only the ceiling was checked, and a
        # declared length of -1 is under every ceiling there is - it then
        # reached rfile.read(-1), which reads until the peer closes rather than
        # until the body ends, so one request held a worker thread for as long
        # as the caller cared to keep the socket open.
        if length < 0:
            self._send(HTTPStatus.BAD_REQUEST, {"error": "bad Content-Length"})
            return
        ceiling = _BODY_CEILINGS.get(parsed.path, MAX_BODY_BYTES)
        if length > ceiling:
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
        elif parsed.path == "/log":
            self._send(HTTPStatus.OK, self.service.append_log(body))
        elif parsed.path == "/gloss":
            self._send(HTTPStatus.OK, self.service.gloss(body))
        elif parsed.path == "/translate":
            self._send(HTTPStatus.OK, self.service.translate_start(body))
        else:
            self._send(HTTPStatus.OK, self.service.fetch(body))

    def do_DELETE(self) -> None:  # noqa: N802
        if not self._origin_ok():
            return
        parsed = urlparse(self.path)
        params = parse_qs(parsed.query)

        if match := re.fullmatch(r"/cached/(\d+)", parsed.path):
            self._send(HTTPStatus.OK, self.service.forget(int(match.group(1))))
        elif match := re.fullmatch(r"/translate/([A-Za-z0-9-]+)", parsed.path):
            self._send(
                HTTPStatus.OK,
                self.service.translate_cancel(match.group(1), forget=bool(params.get("forget"))),
            )
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
    """How well the kind of entry matches the kind of thing being looked for.

    A page with no season or episode detected is a film until shown otherwise.
    Without this, television episodes sharing a film's title win on subtitle
    count, which is how a 2016 episode was chosen for a 2025 film.

    When a season and episode ARE known, the show outranks one of its own
    episodes. Every episode of a series carries the series name, so all of them
    score the same against it and the tie falls to whichever is most
    downloaded: asking for "Not Suitable for Work" S01E01 resolved to the S01E03
    entry. Resolving to the show instead searches `parent_imdb_id` with the
    season and episode, which names one episode exactly.
    """
    if feature.is_series != want_series:
        return -1
    if want_series and feature.feature_type.lower() == "tvshow":
        return 2
    return 1


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


def _file_id(value: Any) -> int | None:
    """A file_id, or None when what arrived cannot be one.

    bool is a subclass of int in Python, so `isinstance(file_id, int)` admitted
    True - and True is what a caller sends when a truthiness check has crept in
    somewhere on the way. It then names the file: measured against a scratch
    cache, {"file_id": true} wrote True.srt and True.json, after which
    list_subtitles raised ValueError on int("True") and every endpoint that
    lists what is held answered with a traceback instead. One bad body, and the
    cache directory stayed poisoned until somebody deleted the two files.
    """
    if isinstance(value, bool) or not isinstance(value, int):
        return None
    return value


def _cues_response(raw: bytes, meta: dict[str, Any], *, from_cache: bool) -> dict[str, Any]:
    text, encoding = subtitles.decode(raw)
    cues = subtitles.parse_srt(text)
    rendered = subtitles.to_json(cues)
    return {
        # `words` beside the older `cue_count`, which is the line count under
        # its first name. Together they let the panel mark a result the reader
        # has just downloaded without measuring it a second time.
        "meta": {**meta, "encoding": encoding, "cue_count": len(cues),
                 "words": subtitles.measure(rendered)["words"]},
        "cues": rendered,
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
    alt_titles: list[str] | None = None,
) -> str:
    parts = [query.lower(), ",".join(sorted(languages)), str(year), str(season), str(episode),
             str(imdb_id)]
    # The other names belong in the key because they change the answer: a search
    # made before the page offered them found less, and replaying that envelope
    # would hide the better one for the six hours it lives. Appended only when
    # there are any, so a search that offers none keys exactly as it always did
    # and every entry already on disk stays reachable.
    if alt_titles:
        parts.append(",".join(name.lower() for name in alt_titles))
    raw = "|".join(parts)
    # A readable name, plus a digest of what it was made from.
    #
    # The name alone was the key, and it is lossy twice over. Every character
    # outside a-z0-9 collapses to an underscore, so a title with no Latin
    # letters in it collapses to nothing: "君の名は" and "千と千尋の神隠し" both
    # keyed as "_en_none_none_none_none", and the second search was answered
    # with the first film's results for the six hours the entry lived. It was
    # also cut to 120 characters, so two long titles sharing a prefix met in
    # the same place. Searches cost no quota, so the collision was never paid
    # for in downloads - it was paid for by attaching the wrong subtitle.
    #
    # The digest is over the parts before they are flattened, so nothing that
    # distinguishes two searches can be lost on the way to the key. The
    # readable half is kept because this cache is looked at by hand.
    slug = re.sub(r"[^a-z0-9]+", "_", raw.lower())[:100]
    return f"{slug}-{hashlib.sha256(raw.encode('utf-8')).hexdigest()[:12]}"


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
