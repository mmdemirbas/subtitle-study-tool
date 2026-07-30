"""Build and measure an annotation corpus from real subtitles.

The symbol matcher was written from intuition about how caption houses phrase
things. This measures it instead: download a set of subtitles, extract every
bracketed annotation, and report what fraction the matcher recognises and what
it does with them.

Downloads cost quota, so it prefers hearing-impaired subtitles - those are the
ones that carry sound descriptions at all - and keeps the set small.

    uv run python tools/annotation_corpus.py fetch     # spends quota
    uv run python tools/annotation_corpus.py report    # reads the saved corpus

The saved corpus is an *inventory*: annotation texts and counts, not subtitle
files. It is small, carries no dialogue, and is committed so the coverage test
has something to run against without re-downloading anything.
"""

from __future__ import annotations

import json
import re
import sys
from collections import Counter
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))

from subtitle_daemon import annotations, config, subtitles  # noqa: E402
from subtitle_daemon.opensubtitles import Client  # noqa: E402

CORPUS = Path(__file__).resolve().parents[1] / "tests" / "data" / "annotation-corpus.json"

# Titles chosen for dialogue density and variety of sound design, across eras
# and genres, so the sample is not all one caption house's house style.
TITLES = [
    ("Sicario", 2015),
    ("Arrival", 2016),
    ("The Social Network", 2010),
    ("Mad Max: Fury Road", 2015),
    ("Get Out", 2017),
    ("A Quiet Place", 2018),
    ("Whiplash", 2014),
    ("Parasite", 2019),
]


def fetch() -> None:
    settings = config.load()
    if not settings.has_api_key:
        raise SystemExit("no API key configured; see subtitle-daemon/README.md")

    client = Client(settings.api_key or "")
    if settings.can_login:
        client.login(settings.username or "", settings.password or "")

    inventory: Counter[str] = Counter()
    sources: list[dict[str, object]] = []

    for title, year in TITLES:
        features = [f for f in client.features(title) if f.subtitles_count > 0]
        best = next((f for f in features if not f.is_series), None)
        if best is None:
            print(f"  ?  {title}: not found")
            continue

        results = client.search(imdb_id=best.imdb_id, languages=("en",))
        # Hearing-impaired subtitles are the ones with sound descriptions in
        # them; without this filter most of the corpus is plain dialogue.
        hi = [r for r in results if r.hearing_impaired] or results
        if not hi:
            print(f"  ?  {title}: no subtitles")
            continue

        chosen = hi[0]
        downloaded = client.download(chosen.file_id)
        text, encoding = subtitles.decode(downloaded.content)
        cues = subtitles.parse_srt(text)

        found = extract(cues)
        inventory.update(found)
        sources.append(
            {
                "title": title,
                "year": year,
                "imdb_id": best.imdb_id,
                "release": chosen.release,
                "hearing_impaired": chosen.hearing_impaired,
                "encoding": encoding,
                "cues": len(cues),
                "annotations": len(found),
            }
        )
        print(
            f"  ok {title}: {len(cues)} cues, {len(found)} annotations, "
            f"{downloaded.remaining} downloads left"
        )

    CORPUS.parent.mkdir(parents=True, exist_ok=True)
    CORPUS.write_text(
        json.dumps(
            {
                "note": "Annotation inventory only - no dialogue. Built by tools/annotation_corpus.py.",
                "sources": sources,
                "annotations": dict(inventory.most_common()),
            },
            ensure_ascii=False,
            indent=2,
        )
    )
    print(f"\nwrote {CORPUS} - {len(inventory)} distinct annotations")


def extract(cues: list[subtitles.Cue]) -> list[str]:
    """Every bracketed annotation in a set of cues, as written."""
    found: list[str] = []
    for cue in cues:
        for _start, _end, _kind, inner in annotations.find_annotations(cue.text):
            inner = re.sub(r"\s+", " ", inner).strip()
            if inner and not annotations._MUSIC_MARK.fullmatch(inner):
                found.append(inner)
    return found


def report() -> None:
    if not CORPUS.exists():
        raise SystemExit(f"no corpus at {CORPUS}; run `fetch` first")

    data = json.loads(CORPUS.read_text())
    inventory: dict[str, int] = data["annotations"]

    matched: list[tuple[str, int, str]] = []
    unmatched: list[tuple[str, int]] = []
    for text, count in inventory.items():
        kind = annotations.classify(text, followed_by_speech=False)
        if kind == annotations.SPEAKER:
            continue  # speakers get a colour, not a symbol
        if not annotations._content_tokens(text):
            continue  # bare note characters are already a symbol
        symbol = annotations.symbol_for(text)
        (matched.append((text, count, symbol)) if symbol else unmatched.append((text, count)))

    total = sum(count for _t, count in unmatched) + sum(count for _t, _c, count in
                                                        [(t, c, c) for t, c, _s in matched])
    hit = sum(count for _t, count, _s in matched)

    print(f"corpus: {len(data['sources'])} subtitles, {len(inventory)} distinct annotations")
    print(f"non-speaker occurrences: {total}")
    print(f"symbol coverage: {hit}/{total} = {100 * hit / total:.1f}% of occurrences")
    print(f"                 {len(matched)}/{len(matched) + len(unmatched)} distinct\n")

    print("--- most common WITH a symbol (check these for wrongness) ---")
    for text, count, symbol in sorted(matched, key=lambda row: -row[1])[:30]:
        print(f"  {count:4}  {symbol}  {text}")

    print("\n--- most common WITHOUT a symbol (candidates to add) ---")
    for text, count in sorted(unmatched, key=lambda row: -row[1])[:30]:
        print(f"  {count:4}     {text}")


if __name__ == "__main__":
    command = sys.argv[1] if len(sys.argv) > 1 else "report"
    {"fetch": fetch, "report": report}[command]()
