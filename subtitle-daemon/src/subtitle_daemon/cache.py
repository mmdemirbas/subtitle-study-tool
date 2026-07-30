"""On-disk cache for downloaded subtitles.

This exists for quota reasons, not speed. A free OpenSubtitles account gets
around 10 downloads per day; re-fetching a subtitle because a tab was reloaded
would burn that in an evening. Once a file_id has been downloaded it is served
from disk forever and never counted against the quota again.

Searches are cached too, with a short TTL, because they are unlimited but slow
enough to be worth not repeating while the user nudges a title around.
"""

from __future__ import annotations

import json
import time
from dataclasses import dataclass
from pathlib import Path

SEARCH_TTL_SECONDS = 6 * 60 * 60


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
        meta = {**meta, "cached_at": time.time()}
        path.with_suffix(".json").write_text(json.dumps(meta, ensure_ascii=False, indent=2))
        return CachedSubtitle(file_id=file_id, path=path, meta=meta)

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

    def get_search(self, key: str) -> list[dict[str, object]] | None:
        path = self._searches / f"{key}.json"
        if not path.exists():
            return None
        payload = json.loads(path.read_text())
        if time.time() - payload.get("at", 0) > SEARCH_TTL_SECONDS:
            return None
        return payload.get("results")

    def put_search(self, key: str, results: list[dict[str, object]]) -> None:
        path = self._searches / f"{key}.json"
        path.write_text(json.dumps({"at": time.time(), "results": results}, ensure_ascii=False))

    def _subtitle_path(self, file_id: int) -> Path:
        return self._subtitles / f"{file_id}.srt"
