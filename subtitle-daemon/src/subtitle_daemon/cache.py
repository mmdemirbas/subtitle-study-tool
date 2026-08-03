"""On-disk cache for downloaded subtitles.

This exists for quota reasons, not speed. A free OpenSubtitles account gets
around 10 downloads per day; re-fetching a subtitle because a tab was reloaded
would burn that in an evening. Once a file_id has been downloaded it is served
from disk forever and never counted against the quota again.

Searches are cached too, with a short TTL, because they are unlimited but slow
enough to be worth not repeating while the user nudges a title around.
"""

from __future__ import annotations

import hashlib
import json
import time
from dataclasses import dataclass
from pathlib import Path

SEARCH_TTL_SECONDS = 6 * 60 * 60

# Bump when the shape or the derivation of cached search results changes -
# parsing, scoring, ranking, filtering. Cached entries hold *processed* results,
# so without this a change to any of that stays invisible for the TTL and the
# daemon keeps serving answers computed by the previous version. Downloaded
# subtitle files are not versioned: those are raw bytes and never go stale.
SEARCH_SCHEMA_VERSION = 6


@dataclass(frozen=True)
class CachedSubtitle:
    """A subtitle already on disk."""

    file_id: int
    path: Path
    meta: dict[str, object]

    def read_bytes(self) -> bytes:
        return self.path.read_bytes()


class Cache:
    """Files on disk plus small JSON sidecars. No database; nothing needs one."""

    def __init__(self, root: Path) -> None:
        self._subtitles = root / "subtitles"
        self._searches = root / "searches"
        self._subtitles.mkdir(parents=True, exist_ok=True)
        self._searches.mkdir(parents=True, exist_ok=True)

    # --- subtitles ----------------------------------------------------------

    def get_subtitle(self, file_id: int) -> CachedSubtitle | None:
        path = self._subtitle_path(file_id)
        meta_path = path.with_suffix(".json")
        if not path.exists() or not meta_path.exists():
            return None
        return CachedSubtitle(
            file_id=file_id,
            path=path,
            meta=json.loads(meta_path.read_text()),
        )

    def put_subtitle(self, file_id: int, raw: bytes, meta: dict[str, object]) -> CachedSubtitle:
        path = self._subtitle_path(file_id)
        path.write_bytes(raw)
        meta = {**meta, "cached_at": time.time(), "sha256": hashlib.sha256(raw).hexdigest()}
        path.with_suffix(".json").write_text(json.dumps(meta, ensure_ascii=False, indent=2))
        return CachedSubtitle(file_id=file_id, path=path, meta=meta)

    def find_for_title(self, imdb_id: str | None, languages: tuple[str, ...]) -> CachedSubtitle | None:
        """A subtitle already on disk for this title, in the best language.

        This is the part that actually protects the quota. Keying only on
        file_id stops a *repeat* download of the same upload, but the same film
        is on OpenSubtitles many times over, and a later search ranking a
        different upload first would spend a download on a subtitle we
        effectively already have.
        """
        if not imdb_id:
            return None

        candidates = [
            item for item in self.list_subtitles() if str(item.meta.get("imdb_id") or "") == imdb_id
        ]
        if not candidates:
            return None

        def rank(item: CachedSubtitle) -> tuple[int, float]:
            language = str(item.meta.get("language") or "")
            position = languages.index(language) if language in languages else len(languages)
            return (position, -float(item.meta.get("cached_at", 0)))

        return min(candidates, key=rank)

    def find_by_content(self, digest: str) -> CachedSubtitle | None:
        """An existing file with identical bytes, under any file_id."""
        return next(
            (item for item in self.list_subtitles() if item.meta.get("sha256") == digest),
            None,
        )

    def delete_subtitle(self, file_id: int) -> bool:
        """Remove a subtitle and its sidecar. False if it was not there."""
        path = self._subtitle_path(file_id)
        meta_path = path.with_suffix(".json")
        existed = path.exists() or meta_path.exists()
        path.unlink(missing_ok=True)
        meta_path.unlink(missing_ok=True)
        return existed

    def clear_subtitles(self) -> int:
        """Remove every downloaded subtitle. Returns how many went."""
        removed = 0
        for item in self.list_subtitles():
            if self.delete_subtitle(item.file_id):
                removed += 1
        return removed

    def clear_searches(self) -> int:
        """Forget cached search results, so the next search asks upstream.

        Separate from clearing subtitles: searching is free and unlimited,
        downloading is neither. Wanting a fresh search is not wanting to spend
        the day's quota again.
        """
        removed = 0
        for path in self._searches.glob("*.json"):
            path.unlink(missing_ok=True)
            removed += 1
        return removed

    def list_subtitles(self) -> list[CachedSubtitle]:
        found: list[CachedSubtitle] = []
        for meta_path in self._subtitles.glob("*.json"):
            data_path = meta_path.with_suffix(".srt")
            if not data_path.exists():
                continue
            found.append(
                CachedSubtitle(
                    file_id=int(meta_path.stem),
                    path=data_path,
                    meta=json.loads(meta_path.read_text()),
                )
            )
        found.sort(key=lambda item: float(item.meta.get("cached_at", 0)), reverse=True)
        return found

    # --- searches -----------------------------------------------------------

    def get_search(self, key: str) -> dict[str, object] | None:
        """The cached search envelope, or None if absent or stale.

        Returns the whole envelope rather than only the rows: the confidence
        flags alongside them are conclusions about that result set and have to
        survive a replay with it.
        """
        path = self._search_path(key)
        if not path.exists():
            return None
        payload = json.loads(path.read_text())
        if time.time() - payload.get("at", 0) > SEARCH_TTL_SECONDS:
            return None
        envelope = payload.get("envelope")
        return envelope if isinstance(envelope, dict) else None

    def put_search(self, key: str, envelope: dict[str, object]) -> None:
        path = self._search_path(key)
        path.write_text(json.dumps({"at": time.time(), "envelope": envelope},
                                   ensure_ascii=False))

    def _search_path(self, key: str) -> Path:
        return self._searches / f"v{SEARCH_SCHEMA_VERSION}-{key}.json"

    def _subtitle_path(self, file_id: int) -> Path:
        return self._subtitles / f"{file_id}.srt"
