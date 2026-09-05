"""Tests for the on-disk cache.

The cache exists to protect a download quota measured in tens per day, so the
tests are mostly about not spending one twice for the same thing.
"""

from __future__ import annotations

from pathlib import Path

from subtitle_daemon.cache import SEARCH_SCHEMA_VERSION, Cache

SRT = b"1\n00:00:01,000 --> 00:00:02,000\nHello\n"


def test_a_stored_subtitle_comes_back(tmp_path: Path) -> None:
    cache = Cache(tmp_path)
    cache.put_subtitle(42, SRT, {"language": "en"})
    found = cache.get_subtitle(42)
    assert found is not None
    assert found.read_bytes() == SRT
    assert found.meta["language"] == "en"


def test_content_hash_is_recorded(tmp_path: Path) -> None:
    cache = Cache(tmp_path)
    stored = cache.put_subtitle(42, SRT, {})
    assert len(str(stored.meta["sha256"])) == 64


def test_identical_content_under_a_different_id_is_detectable(tmp_path: Path) -> None:
    # Two uploads of the same film can be byte-identical. Spotting it is how we
    # learn that a download was wasted.
    cache = Cache(tmp_path)
    first = cache.put_subtitle(1, SRT, {})
    cache.put_subtitle(2, SRT, {})
    duplicate = cache.find_by_content(str(first.meta["sha256"]))
    assert duplicate is not None


def test_find_for_title_matches_on_imdb_id(tmp_path: Path) -> None:
    cache = Cache(tmp_path)
    cache.put_subtitle(1, SRT, {"imdb_id": "3397884", "language": "en"})
    cache.put_subtitle(2, SRT + b"x", {"imdb_id": "9999999", "language": "en"})

    found = cache.find_for_title("3397884", ("en",))
    assert found is not None and found.file_id == 1


def test_find_for_title_prefers_the_wanted_language(tmp_path: Path) -> None:
    cache = Cache(tmp_path)
    cache.put_subtitle(1, SRT, {"imdb_id": "3397884", "language": "de"})
    cache.put_subtitle(2, SRT + b"x", {"imdb_id": "3397884", "language": "tr"})
    cache.put_subtitle(3, SRT + b"y", {"imdb_id": "3397884", "language": "en"})

    assert cache.find_for_title("3397884", ("tr", "en")).file_id == 2
    assert cache.find_for_title("3397884", ("en", "tr")).file_id == 3


def test_find_for_title_ignores_files_with_no_title_recorded(tmp_path: Path) -> None:
    # Subtitles downloaded before the context was stored must not be matched to
    # an arbitrary film.
    cache = Cache(tmp_path)
    cache.put_subtitle(1, SRT, {})
    assert cache.find_for_title("3397884", ("en",)) is None


def test_find_for_title_without_an_id_finds_nothing(tmp_path: Path) -> None:
    cache = Cache(tmp_path)
    cache.put_subtitle(1, SRT, {"imdb_id": "3397884", "language": "en"})
    assert cache.find_for_title(None, ("en",)) is None
    assert cache.find_for_title("", ("en",)) is None


def test_search_cache_roundtrip(tmp_path: Path) -> None:
    cache = Cache(tmp_path)
    cache.put_search("k", {"results": [{"file_id": 1}], "low_confidence": True})
    assert cache.get_search("k") == {"results": [{"file_id": 1}], "low_confidence": True}


def test_search_cache_is_partitioned_by_schema_version(tmp_path: Path) -> None:
    """A scoring or parsing change must not be masked by yesterday's answers."""
    cache = Cache(tmp_path)
    cache.put_search("k", {"results": []})
    stored = list((tmp_path / "searches").glob("*.json"))
    assert stored[0].name.startswith(f"v{SEARCH_SCHEMA_VERSION}-")


def test_stale_search_entries_expire(tmp_path: Path, monkeypatch) -> None:
    import subtitle_daemon.cache as cache_module

    cache = Cache(tmp_path)
    cache.put_search("k", {"results": []})
    monkeypatch.setattr(cache_module.time, "time", lambda: 10**12)
    assert cache.get_search("k") is None


def test_a_subtitle_without_its_sidecar_is_not_returned(tmp_path: Path) -> None:
    cache = Cache(tmp_path)
    cache.put_subtitle(42, SRT, {})
    (tmp_path / "subtitles" / "42.json").unlink()
    assert cache.get_subtitle(42) is None
    assert cache.list_subtitles() == []


def test_a_half_written_search_entry_is_a_miss_rather_than_a_crash(tmp_path: Path) -> None:
    """The entry is read on the way into every search for that title.

    json.loads was unguarded, so a file cut short - by a crash, by a full disk,
    by somebody looking at it - raised out of /search and went on raising for
    every later search of the same title until the file was deleted by hand.
    """
    cache = Cache(tmp_path)
    cache.put_search("k", {"results": [{"file_id": 1}]})
    path = next((tmp_path / "searches").glob("*.json"))
    path.write_text(path.read_text()[: len(path.read_text()) // 2])
    assert cache.get_search("k") is None


def test_nothing_half_written_is_left_behind_by_a_store(tmp_path: Path) -> None:
    """Both stores write to a temporary name and rename over the target."""
    cache = Cache(tmp_path)
    cache.put_subtitle(42, SRT, {"language": "en"})
    cache.put_search("k", {"results": []})
    left = [p.name for p in tmp_path.rglob("*.writing")]
    assert left == []
    assert cache.get_subtitle(42) is not None
    assert cache.get_search("k") == {"results": []}


def test_a_file_that_is_not_a_file_id_does_not_take_out_the_listing(tmp_path: Path) -> None:
    """That directory is where a stray file lands, and one used to be fatal.

    list_subtitles read the name as an integer, so anything else in there -
    a note, an editor's backup, the True.srt a boolean file_id used to write -
    raised ValueError out of every endpoint that lists what is held.
    """
    cache = Cache(tmp_path)
    cache.put_subtitle(42, SRT, {"language": "en"})
    (tmp_path / "subtitles" / "notes.srt").write_bytes(SRT)
    (tmp_path / "subtitles" / "notes.json").write_text("{}")
    assert [held.file_id for held in cache.list_subtitles()] == [42]
