"""What the extension is holding in the browser, read off the disk.

chrome.storage.local is a LevelDB directory in the browser profile. This finds
the one belonging to this unpacked extension (in Brave, Chrome, Chromium, Edge
or Arc, by the path in the profile's Secure Preferences), reads a copy of it -
tables and write-ahead log, in pure Python, no leveldb or snappy library - and
prints: the biggest keys, the running log still held in the browser (entries,
bytes, time range, by kind), the log's send state, and how often LevelDB has
been writing a table lately. Numbers only, so the output is safe to paste.

    python3 browser-extension/tools/read-storage.py                 # find it and report
    python3 browser-extension/tools/read-storage.py <store-dir>     # a copied directory
    python3 browser-extension/tools/read-storage.py --dump held.json  # also write the held log out

Written on 2026-09-26, when freezes and high CPU while watching turned out to
be the held log being rewritten whole on every line (see trace.js). The table
rate is what showed it: a fresh 1.1MB table every 3 to 13 seconds while a video
played. Run it when the daemon has been down, or when the browser is busy and
the extension is the suspect.
"""
from __future__ import annotations

import collections
import json
import re
import shutil
import struct
import sys
import tempfile
from datetime import datetime
from pathlib import Path

EXTENSION = Path(__file__).resolve().parents[1]
SUPPORT = Path.home() / "Library" / "Application Support"
BROWSERS = ["BraveSoftware/Brave-Browser", "Google/Chrome", "Chromium", "Microsoft Edge", "Arc/User Data"]


# --- LevelDB, just enough of it ----------------------------------------------


def varint(buf: bytes, pos: int) -> tuple[int, int]:
    result = shift = 0
    while True:
        byte = buf[pos]
        pos += 1
        result |= (byte & 0x7F) << shift
        if not byte & 0x80:
            return result, pos
        shift += 7


def unsnappy(src: bytes) -> bytes:
    length, pos = varint(src, 0)
    out = bytearray()
    while pos < len(src):
        tag = src[pos]
        pos += 1
        kind = tag & 3
        if kind == 0:
            n = tag >> 2
            if n >= 60:
                extra = n - 59
                n = int.from_bytes(src[pos : pos + extra], "little")
                pos += extra
            out += src[pos : pos + n + 1]
            pos += n + 1
            continue
        if kind == 1:
            n = ((tag >> 2) & 7) + 4
            offset = ((tag >> 5) << 8) | src[pos]
            pos += 1
        elif kind == 2:
            n = (tag >> 2) + 1
            offset = int.from_bytes(src[pos : pos + 2], "little")
            pos += 2
        else:
            n = (tag >> 2) + 1
            offset = int.from_bytes(src[pos : pos + 4], "little")
            pos += 4
        for _ in range(n):
            out.append(out[-offset])
    if len(out) != length:
        raise ValueError("snappy block did not decode to its stated length")
    return bytes(out)


def block_entries(block: bytes):
    restarts = struct.unpack("<I", block[-4:])[0]
    end = len(block) - 4 - 4 * restarts
    pos, key = 0, b""
    while pos < end:
        shared, pos = varint(block, pos)
        unshared, pos = varint(block, pos)
        size, pos = varint(block, pos)
        key = key[:shared] + block[pos : pos + unshared]
        pos += unshared
        yield key, block[pos : pos + size]
        pos += size


def table(path: Path):
    """(key, sequence, is_value, value) for every record in one .ldb file."""
    data = path.read_bytes()

    def block(offset: int, size: int) -> bytes:
        raw = data[offset : offset + size]
        return unsnappy(raw) if data[offset + size] == 1 else raw

    footer = data[-48:]
    _, pos = varint(footer, 0)
    _, pos = varint(footer, pos)
    index_offset, pos = varint(footer, pos)
    index_size, _ = varint(footer, pos)
    for _, handle in block_entries(block(index_offset, index_size)):
        offset, pos = varint(handle, 0)
        size, _ = varint(handle, pos)
        for internal, value in block_entries(block(offset, size)):
            tag = struct.unpack("<Q", internal[-8:])[0]
            yield internal[:-8], tag >> 8, (tag & 0xFF) == 1, value


def write_log(path: Path):
    """The same, from a .log file: the writes not yet flushed into a table.

    Without this the newest writes are invisible, and after the log went into
    small pieces the newest writes are most of what changes."""
    data = path.read_bytes()
    record = b""
    for start in range(0, len(data), 32768):
        chunk, pos = data[start : start + 32768], 0
        while pos + 7 <= len(chunk):
            size, kind = struct.unpack("<HB", chunk[pos + 4 : pos + 7])
            if kind == 0 and size == 0:
                break
            fragment = chunk[pos + 7 : pos + 7 + size]
            pos += 7 + size
            record = fragment if kind in (1, 2) else record + fragment
            if kind not in (1, 4) or len(record) < 12:
                continue
            sequence, count = struct.unpack("<QI", record[:12])
            at = 12
            try:
                for i in range(count):
                    is_value = record[at] == 1
                    size_, at = varint(record, at + 1)
                    key = record[at : at + size_]
                    at += size_
                    value = b""
                    if is_value:
                        size_, at = varint(record, at)
                        value = record[at : at + size_]
                        at += size_
                    yield key, sequence + i, is_value, value
            except IndexError:
                pass  # a batch cut off by the copy; the rest is still good


def read_store(directory: Path) -> dict[str, bytes]:
    latest: dict[bytes, tuple[int, bool, bytes]] = {}
    sources = [(p, table) for p in sorted(directory.glob("*.ldb"))] + [(p, write_log) for p in sorted(directory.glob("*.log"))]
    for path, reader in sources:
        for key, sequence, is_value, value in reader(path):
            if key not in latest or sequence > latest[key][0]:
                latest[key] = (sequence, is_value, value)
    return {k.decode(errors="replace"): v for k, (_, alive, v) in latest.items() if alive}


# --- finding it ----------------------------------------------------------------


def find_store() -> Path:
    for browser in BROWSERS:
        for prefs in sorted((SUPPORT / browser).glob("*/Secure Preferences")):
            try:
                settings = json.loads(prefs.read_text())["extensions"]["settings"]
            except (OSError, ValueError, KeyError):
                continue
            for ext_id, about in settings.items():
                if Path(str(about.get("path", ""))) == EXTENSION:
                    store = prefs.parent / "Local Extension Settings" / ext_id
                    if store.is_dir():
                        return store
    sys.exit(f"no browser profile has {EXTENSION} installed")


# --- the report ----------------------------------------------------------------


def held_log(values: dict[str, bytes]) -> list[dict]:
    """The running log as trace.js holds it: pieces in index order, after
    anything still under the one-array key from before 2026-09-26."""
    log = json.loads(values["sso:trace"]) if "sso:trace" in values else []
    index = json.loads(values.get("sso:traceIndex", b"{}") or b"{}")
    for piece in index.get("pieces", []):
        log += json.loads(values.get(f"sso:trace:{piece['n']}", b"[]"))
    return log


def table_rate(store: Path) -> None:
    stamps = []
    for name in ("LOG.old", "LOG"):
        path = store / name
        if not path.exists():
            continue
        for line in path.read_text(errors="replace").splitlines():
            match = re.match(r"(\d{4}/\d\d/\d\d-\d\d:\d\d:\d\d\.\d+) \S+ Level-0 table #\d+: (\d+) bytes OK", line)
            if match:
                stamps.append((datetime.strptime(match[1], "%Y/%m/%d-%H:%M:%S.%f"), int(match[2])))
    if len(stamps) < 2:
        print("\ntables written: too few in LevelDB's LOG to say")
        return
    last = stamps[-1][0]
    hour = [s for s in stamps if (last - s[0]).total_seconds() <= 3600]
    gaps = sorted((b[0] - a[0]).total_seconds() for a, b in zip(hour, hour[1:]))
    median = f"{gaps[len(gaps) // 2]:.0f}s apart at the median" if gaps else "one only"
    print(f"\ntables written in the hour before {last:%Y-%m-%d %H:%M}: {len(hour)}, "
          f"{sum(s[1] for s in hour) / 1e6:.1f}MB, {median}")


def main() -> None:
    args = sys.argv[1:]
    dump = None
    if "--dump" in args:
        at = args.index("--dump")
        dump = Path(args[at + 1])
        del args[at : at + 2]
    store = Path(args[0]) if args else find_store()
    print(f"store: {store}")

    # A copy, because the browser compacts while it runs and a table can vanish
    # between listing the directory and opening it.
    with tempfile.TemporaryDirectory() as scratch:
        copy = Path(scratch) / "store"
        shutil.copytree(store, copy, ignore=shutil.ignore_patterns("LOCK"))
        values = read_store(copy)

    sizes = sorted(((len(v), k) for k, v in values.items()), reverse=True)
    print(f"live keys: {len(sizes)}, {sum(s for s, _ in sizes) / 1e6:.2f}MB of values")
    for size, key in sizes[:10]:
        print(f"  {size:>10}  {key}")

    log = held_log(values)
    print(f"\nrunning log held in the browser: {len(log)} entries, {len(json.dumps(log)) / 1e6:.2f}MB")
    if log:
        print(f"  {log[0].get('at')} to {log[-1].get('at')}")
        count, size = collections.Counter(), collections.Counter()
        for entry in log:
            count[entry.get("kind")] += 1
            size[entry.get("kind")] += len(json.dumps(entry))
        for kind, n in count.most_common():
            print(f"  {kind:<16} {n:>6} entries {size[kind]:>10} bytes")
    if "sso:traceState" in values:
        state = json.loads(values["sso:traceState"])
        print(f"\nsend state: {state.get('lastDestination')}, last error {state.get('lastError')}, "
              f"{state.get('entriesSent')} entries sent in {state.get('sentToDaemon')} batches")

    table_rate(store)

    if dump:
        dump.write_text(json.dumps(log))
        print(f"\nheld log written to {dump}")


if __name__ == "__main__":
    main()
