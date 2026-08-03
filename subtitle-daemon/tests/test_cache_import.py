"""Taking in a subtitle the extension downloaded while the daemon was stopped.

The extension can now run the whole fetch itself, so a download can be spent
while this process is not running. Its cache is a separate store - a browser
extension has no filesystem - so without a way back in, the daemon would later
spend a *second* download on a file already held, which is the one thing the
cache exists to prevent.
"""

from __future__ import annotations

import base64
import hashlib
import threading
from collections.abc import Iterator
from pathlib import Path

import pytest

from subtitle_daemon import server as server_module
from subtitle_daemon.cache import Cache
from subtitle_daemon.config import Config

SRT = (
    b"1\n00:00:01,000 --> 00:00:02,000\n[Ormon] Hello\n\n"
    b"2\n00:00:03,000 --> 00:00:04,000\n[sighs] World\n"
)


@pytest.fixture
def service(tmp_path: Path) -> Iterator[server_module.Service]:
    svc = server_module.Service.__new__(server_module.Service)
    svc.config = Config(
        api_key="test-key",
        username=None,
        password=None,
        default_languages=("en",),
        port=0,
    )
    svc.cache = Cache(tmp_path)
    svc.client = None
    svc._lock = threading.Lock()
    yield svc


def _body(file_id: int = 4242, content: bytes = SRT, **meta: object) -> dict:
    return {
        "file_id": file_id,
        "content": base64.b64encode(content).decode("ascii"),
        "meta": {"imdb_id": "tt123", "language": "en", **meta},
    }


def test_imported_subtitle_is_served_from_cache(service: server_module.Service) -> None:
    assert service.import_subtitle(_body())["imported"] is True

    # The daemon has no client at all here, so anything it returns must have
    # come from the cache rather than a download.
    response = service.fetch({"file_id": 4242})
    assert response["from_cache"] is True
    assert response["meta"]["cue_count"] == 2
    assert response["cues"][0]["runs"][0]["kind"] == "speaker"


def test_import_stores_the_bytes_verbatim(service: server_module.Service) -> None:
    """The sha256 has to match on both sides, so re-encoding is not allowed."""
    service.import_subtitle(_body())
    held = service.cache.get_subtitle(4242)
    assert held is not None
    assert held.read_bytes() == SRT
    assert held.meta["sha256"] == hashlib.sha256(SRT).hexdigest()


def test_import_protects_the_quota_via_find_for_title(
    service: server_module.Service,
) -> None:
    """The point of the whole exercise: the daemon must see what the extension got.

    find_for_title is what stops a later search ranking a *different* upload of
    the same film and spending a download on it.
    """
    service.import_subtitle(_body())
    owned = service.cache.find_for_title("tt123", ("en",))
    assert owned is not None and owned.file_id == 4242


def test_existing_file_is_not_overwritten(service: server_module.Service) -> None:
    service.cache.put_subtitle(4242, b"already here", {"imdb_id": "tt123"})
    result = service.import_subtitle(_body())
    assert result["imported"] is False
    assert service.cache.get_subtitle(4242).read_bytes() == b"already here"


def test_unknown_metadata_keys_are_dropped(service: server_module.Service) -> None:
    """A future extension version must not be able to write arbitrary keys."""
    service.import_subtitle(_body(sneaky="../../etc/passwd", cached_at=0))
    meta = service.cache.get_subtitle(4242).meta
    assert "sneaky" not in meta
    assert meta["imported_from"] == "extension"
    # cached_at is stamped by the cache, not taken from the caller.
    assert meta["cached_at"] > 0


@pytest.mark.parametrize(
    "body, expected",
    [
        ({"file_id": "no"}, "file_id must be an integer"),
        ({"file_id": 1, "content": "not base64!!"}, "content must be base64"),
        ({"file_id": 1, "content": ""}, "content was empty"),
    ],
)
def test_bad_input_is_refused(
    service: server_module.Service, body: dict, expected: str
) -> None:
    assert service.import_subtitle(body)["error"] == expected


def test_deleting_removes_the_file_and_its_sidecar(
    service: server_module.Service,
) -> None:
    service.cache.put_subtitle(42, SRT, {"imdb_id": "tt1"})
    path = service.cache.get_subtitle(42).path

    assert service.forget(42)["deleted"] is True
    assert service.cache.get_subtitle(42) is None
    assert not path.exists()
    # A sidecar left behind would show up in list_subtitles as a broken entry.
    assert not path.with_suffix(".json").exists()

    # Deleting something already gone is not an error, just nothing to do.
    assert service.forget(42)["deleted"] is False


def test_clearing_searches_keeps_the_downloads(service: server_module.Service) -> None:
    """Searching is free; downloading is five a day. They clear separately."""
    service.cache.put_subtitle(42, SRT, {"imdb_id": "tt1"})
    service.cache.put_search("some-key", {"results": []})

    result = service.forget_all(searches_only=True)

    assert result["searches"] == 1
    assert service.cache.get_search("some-key") is None
    assert service.cache.get_subtitle(42) is not None, "a download must survive"


def test_clearing_everything_removes_both(service: server_module.Service) -> None:
    service.cache.put_subtitle(42, SRT, {"imdb_id": "tt1"})
    service.cache.put_subtitle(43, SRT, {"imdb_id": "tt2"})
    service.cache.put_search("some-key", {"results": []})

    result = service.forget_all()

    assert result == {"subtitles": 2, "searches": 1}
    assert service.cache.list_subtitles() == []


def test_size_is_reported_for_the_cache_manager(service: server_module.Service) -> None:
    service.cache.put_subtitle(42, SRT, {"imdb_id": "tt1"})
    listed = service.cached_list()["subtitles"][0]
    assert listed["bytes"] == len(SRT)
    assert listed["cached_at"] > 0


def test_raw_content_is_available_for_the_other_direction(
    service: server_module.Service,
) -> None:
    """The extension needs the bytes, not the cues, to mirror what is on disk."""
    service.cache.put_subtitle(99, SRT, {"imdb_id": "tt9", "language": "en"})

    without = service.cached_one(99)
    assert "content" not in without

    with_content = service.cached_one(99, with_content=True)
    assert base64.b64decode(with_content["content"]) == SRT
