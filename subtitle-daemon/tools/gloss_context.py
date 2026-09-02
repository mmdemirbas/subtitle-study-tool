"""Does telling the model what it is watching change what it answers?

    uv run python tools/gloss_context.py <subtitle.srt> [--film "Name (year)"]

Glosses the same words three times against the configured model: with the line
alone, which is what the daemon sent before; with the line alone AGAIN, which is
the control; and with the film named and the subtitle lines either side of it.
Prints every word the first and last disagree about.

It exists because the question is not answerable by reading. More context in a
prompt is not the same as a better answer, and a change that costs three times
the request body has to be shown doing something. The control arm is the half
that stops it being shown doing something it did not do: the model is sampled,
so two identical requests already disagree sometimes, and that count is the
floor the context has to clear. The cache is a fresh directory each run, so no
pass can answer from another's work.

Not part of any build and not a test: it needs a model on this machine and it
costs a few hundred generations. What it produces is a number for a commit
message.
"""

from __future__ import annotations

import argparse
import json
import re
import sys
import tempfile
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "src"))

from subtitle_daemon import config as daemon_config  # noqa: E402
from subtitle_daemon.lookups import Lookups  # noqa: E402
from subtitle_daemon.subtitles import parse_srt  # noqa: E402

WORD = re.compile(r"[^\W\d_]+", re.UNICODE)
NOT_SPOKEN = re.compile(r"\[[^\]]*\]|\([^)]*\)|\{[^}]*\}|<[^>]*>")


def lines_of(path: Path) -> list[str]:
    cues = parse_srt(path.read_text(encoding="utf-8", errors="replace"))
    return [cue.text for cue in cues]


def marked(lines: list[str], table: set[str], limit: int) -> list[dict[str, str]]:
    """The words a reader would have marked, with the lines around them.

    The rule is the overlay's, simplified to what matters here: a word the
    frequency table does not hold is a word the overlay would mark.
    """
    seen: set[tuple[str, str]] = set()
    items: list[dict[str, str]] = []
    for at, line in enumerate(lines):
        spoken = NOT_SPOKEN.sub(" ", line)
        for word in dict.fromkeys(w.lower() for w in WORD.findall(spoken)):
            if len(word) < 4 or word in table or (word, line) in seen:
                continue
            seen.add((word, line))
            items.append(
                {
                    "term": word,
                    "sentence": line,
                    "before": lines[at - 1] if at else "",
                    "after": lines[at + 1] if at + 1 < len(lines) else "",
                }
            )
            if len(items) >= limit:
                return items
    return items


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("subtitle", type=Path)
    parser.add_argument("--film", default="")
    parser.add_argument("--target", default="tr")
    parser.add_argument("--words", type=int, default=120)
    parser.add_argument(
        "--table",
        type=Path,
        default=Path(__file__).resolve().parents[2]
        / "browser-extension/src/study/frequency-en.generated.txt",
    )
    parser.add_argument("--common", type=int, default=4000)
    args = parser.parse_args()

    config = daemon_config.load()
    if not config.gloss_model:
        print("no gloss_model configured; nothing to measure")
        return 1

    table = set(
        args.table.read_text(encoding="utf-8").split("\n")[: args.common]
    )
    items = marked(lines_of(args.subtitle), table, args.words)
    print(f"{len(items)} words, model {config.gloss_model}, film {args.film!r}")

    def ask(with_context: bool) -> list[str]:
        with tempfile.TemporaryDirectory() as fresh:
            lookups = Lookups(
                Path(fresh),
                gloss_model=config.gloss_model,
                gloss_url=config.gloss_url or "",
                gloss_key=config.gloss_api_key,
            )
            sent = (
                items
                if with_context
                else [{"term": i["term"], "sentence": i["sentence"]} for i in items]
            )
            return lookups.gloss_many(sent, "en", args.target, args.film if with_context else "")

    """Three passes, not two.

    The model is sampled rather than argmaxed, so asking the same question
    twice already gives different words sometimes - and a difference count
    between "bare" and "told" cannot tell that apart from an effect of the
    context. The second bare pass is the null transform: it changes nothing
    that could possibly change an answer, so whatever it moves is the floor
    every other number has to clear.
    """
    bare = ask(False)
    control = ask(False)
    told = ask(True)

    def differs(left: list[str], right: list[str]) -> list[tuple[str, str, str]]:
        """Only where BOTH sides answered.

        A batch that timed out comes back as twenty empty strings, and counting
        those as agreement turns a lost request into "the context changed
        nothing" - a vacuous zero that reads exactly like a real one. So the
        comparable set is reported beside every count.
        """
        return [
            (item["term"], was, now)
            for item, was, now in zip(items, left, right)
            if was and now and was.strip().lower() != now.strip().lower()
        ]

    both = lambda left, right: sum(1 for a, b in zip(left, right) if a and b)
    noise = differs(bare, control)
    moved = differs(bare, told)
    gained = sum(1 for was, now in zip(bare, told) if not was and now)
    lost = sum(1 for was, now in zip(bare, told) if was and not now)

    for term, was, now in moved:
        print(f"  {term:<18} {was or '-':<24} -> {now or '-'}")
    print(
        json.dumps(
            {
                "words": len(items),
                "answered_by_both_arms": both(bare, told),
                "different_with_context": len(moved),
                "answered_by_both_bare_passes": both(bare, control),
                "different_asking_twice": len(noise),
                "answered_only_with_context": gained,
                "answered_only_without": lost,
            }
        )
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
