#!/usr/bin/env python3
"""Which model can translate a whole subtitle file on this machine, and stay lined up.

    uv run python tools/translate_bakeoff.py [model ...]

`tools/pretranslate.py` showed what a good answer looks like, through the local
`claude` CLI, and its report says not to ship that: every invocation re-sends
Claude Code's own system prompt. So the question is what a model on this machine
does with the same job - and the answer that matters is not fluency.

A subtitle cue is not a sentence. It is a numbered box with a start and an end,
and often two speakers in it:

    304
    00:14:02,110 --> 00:14:04,320
    - Secretary Roslin.
    - Yes.

Ask a small model for one translation per numbered line and it will helpfully
split that into two answers, renumber everything after it, and return exactly as
many lines as you asked for. Measured on translategemma:4b over cues 301-308:
the count check passed, `n` ran 301 to 308 as requested, and every line from 304
onward carried the previous line's dialogue. Nothing about that failure is
visible from the response shape - it is a subtitle where the words are right and
the timings belong to somebody else, which is worse than no subtitle at all,
because it looks like it worked.

So what is measured here is ALIGNMENT first and speed second, and fluency not at
all:

- **numbering** - the `n` values returned are exactly the ones asked for, no
  gaps, no extras, no duplicates.
- **shape** - a cue with two lines in it comes back with two lines. The brief
  says to keep the line's own breaks, so a disagreement is a broken contract and
  not a stylistic choice. This is the check that catches the split above.

Both are screens, not verdicts. A model that passes them has produced something
that can be attached to a film; whether it is worth reading is what the
transcript is for, and that part is read by eye.

Speed is reported per line because that is the number that decides whether this
runs while you wait or while you sleep: a 1154-cue episode is the unit.
"""

from __future__ import annotations

import argparse
import json
import sys
import time
import urllib.request
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "src"))

from subtitle_daemon import subtitles  # noqa: E402

OLLAMA = "http://127.0.0.1:11434/v1/chat/completions"

# Small first. The machine is not only running this, and the complaint that
# started the gloss bakeoff was a 22.6 GB model making everything else unusable.
CANDIDATES = [
    "kaelri/qwen3.5-mt:2b",
    "translategemma:4b",
    "gemma3:4b",
    "qwen3:4b",
    "qwen3:14b",
]

# The same brief pretranslate.py sends, minus the vocabulary half. The two jobs
# are separable and a 2B translation model will not do the second one; asking
# for it here would measure prompt-following rather than translation.
BRIEF = """\
You are translating a film's subtitles for someone watching it to learn {source}.

TRANSLATE every numbered line into {target}. Rules:
- One output line per input line, with the SAME number. Never merge two numbered
  lines into one answer, and never split one into two.
- A numbered line may itself contain a line break, and often does when two
  people speak. Keep those breaks exactly where they are.
- Translate what the line MEANS in this scene, not word by word. You can see the
  lines around it; use them.
- Keep proper nouns as they are. Keep the register.

Answer with a JSON object only: {{"lines": [{{"n": 301, "tr": "..."}}]}}\
"""


def unload(model: str) -> None:
    """Ask ollama to drop the model, so the next one is measured from cold.

    Same reason as the gloss bakeoff: two models resident at once means the
    second one is timed against a machine the first is still holding.
    """
    body = json.dumps({"model": model, "messages": [], "keep_alive": 0}).encode()
    request = urllib.request.Request(
        "http://127.0.0.1:11434/api/chat", data=body, headers={"Content-Type": "application/json"}
    )
    try:
        urllib.request.urlopen(request, timeout=30).read()
    except Exception:  # noqa: BLE001 - unloading is a courtesy, never a failure
        pass


def render(cues: list, first: int, last: int, carry: int) -> str:
    """The chunk as numbered text, with the tail of the previous chunk above it."""
    out = []
    if carry < first:
        out.append("--- for context only, already translated, do not answer for these ---")
        out.extend(f"{i + 1}: {cues[i].text}" for i in range(carry, first))
        out.append("--- translate everything below ---")
    out.extend(f"{i + 1}: {cues[i].text}" for i in range(first, last))
    return "\n".join(out)


def ask(model: str, prompt: str, system: str, timeout: float) -> tuple[dict | None, float, str]:
    body = json.dumps(
        {
            "model": model,
            "messages": [
                {"role": "system", "content": system},
                {"role": "user", "content": prompt},
            ],
            # Greedy, for the reason the gloss path is greedy: two identical
            # requests must agree, or a difference between runs cannot be read
            # as a difference in what was sent.
            "temperature": 0,
            "response_format": {"type": "json_object"},
            "chat_template_kwargs": {"enable_thinking": False},
        }
    ).encode("utf-8")
    request = urllib.request.Request(OLLAMA, data=body, headers={"Content-Type": "application/json"})
    started = time.monotonic()
    try:
        with urllib.request.urlopen(request, timeout=timeout) as response:
            raw = json.loads(response.read().decode("utf-8"))
        said = raw["choices"][0]["message"]["content"]
    except Exception as error:  # noqa: BLE001 - every failure is a result here
        return None, time.monotonic() - started, f"{type(error).__name__}: {error}"
    took = time.monotonic() - started
    try:
        return json.loads(said), took, ""
    except ValueError:
        return None, took, f"not JSON: {said[:160]!r}"


def score(cues: list, first: int, last: int, answer: dict) -> dict:
    """Numbering and shape, per the docstring. Nothing about fluency."""
    rows = answer.get("lines")
    if not isinstance(rows, list):
        return {"fatal": "no lines array"}

    got: dict[int, str] = {}
    duplicated = 0
    for row in rows:
        if not isinstance(row, dict) or "n" not in row:
            continue
        try:
            number = int(row["n"])
        except (TypeError, ValueError):
            continue
        if number in got:
            duplicated += 1
        got[number] = str(row.get("tr") or "")

    wanted = set(range(first + 1, last + 1))
    missing = sorted(wanted - set(got))
    extra = sorted(set(got) - wanted)

    # A cue's own line breaks, and the two very different things that happen to
    # them. Both show up as "the shape changed" and only one of them matters.
    #
    #   FLATTENED - "I'd like to welcome you aboard Galactica.\nThank you."
    #   comes back as one line carrying both halves. The break is gone and the
    #   words are all there. A renderer re-wraps it; nobody watching can tell.
    #
    #   DROPPED - "- Secretary Roslin.\n- Yes." comes back as
    #   "- Sekreter Roslin." and the second speaker is simply not in the file
    #   any more. Measured on gemma3:4b and translategemma:4b alike.
    #
    # Counting them together says a model reshaped 25 of 40 cues and hides which
    # 25. A speaker dash is the crisp signal: a cue whose lines start with "- "
    # has that many speakers in it, and the translation has to have as many.
    def speakers(text: str) -> int:
        return sum(1 for line in text.split("\n") if line.lstrip().startswith("-"))

    flattened = []
    dropped = []
    for number in sorted(wanted & set(got)):
        source = cues[number - 1].text
        answer = got[number]
        source_lines = source.count("\n") + 1
        answer_lines = answer.count("\n") + 1
        said, heard = speakers(source), speakers(answer)
        if said >= 2 and heard < said:
            dropped.append((number, said, heard))
        elif source_lines != answer_lines:
            flattened.append((number, source_lines, answer_lines))

    return {
        "returned": len(rows),
        "asked": last - first,
        "missing": missing,
        "extra": extra,
        "duplicated": duplicated,
        "flattened": flattened,
        "dropped": dropped,
        "answers": got,
    }


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("models", nargs="*", default=None, help="ollama models; default all candidates")
    parser.add_argument(
        "--srt",
        type=Path,
        default=Path(__file__).resolve().parents[2] / "srt-viewer/samples/night-ferry-EN.srt",
        help="the file to translate; the report's runs used cues 300-339 of a film from the local corpus",
    )
    parser.add_argument("--start", type=int, default=0, help="first cue, 0-based")
    parser.add_argument("--limit", type=int, default=40)
    parser.add_argument("--chunk", type=int, default=40)
    parser.add_argument("--carry", type=int, default=4)
    parser.add_argument("--source", default="English")
    parser.add_argument("--target", default="Turkish")
    parser.add_argument("--timeout", type=float, default=900.0)
    parser.add_argument("--transcript", type=Path, default=None, help="write every answer here")
    args = parser.parse_args()

    cues = subtitles.parse_srt(subtitles.decode(args.srt.read_bytes())[0])
    stop = min(len(cues), args.start + args.limit)
    system = BRIEF.format(source=args.source, target=args.target)
    models = args.models or CANDIDATES

    multi = sum(1 for i in range(args.start, stop) if "\n" in cues[i].text)
    print(f"{args.srt.name}: {len(cues)} cues; measuring {args.start}..{stop}")
    print(f"{multi} of {stop - args.start} cues have a line break in them\n")

    transcript: dict[str, dict] = {}
    table = []
    for model in models:
        unload(model)
        totals = {"asked": 0, "missing": 0, "extra": 0, "duplicated": 0,
                  "flattened": 0, "dropped": 0}
        seconds = 0.0
        failures = []
        answers: dict[int, str] = {}
        for first in range(args.start, stop, args.chunk):
            last = min(first + args.chunk, stop)
            prompt = render(cues, first, last, max(args.start, first - args.carry))
            answer, took, why = ask(model, prompt, system, args.timeout)
            seconds += took
            if answer is None:
                failures.append(f"{first}..{last}: {why}")
                totals["asked"] += last - first
                totals["missing"] += last - first
                continue
            marks = score(cues, first, last, answer)
            if "fatal" in marks:
                failures.append(f"{first}..{last}: {marks['fatal']}")
                totals["asked"] += last - first
                totals["missing"] += last - first
                continue
            totals["asked"] += marks["asked"]
            totals["missing"] += len(marks["missing"])
            totals["extra"] += len(marks["extra"])
            totals["duplicated"] += marks["duplicated"]
            totals["flattened"] += len(marks["flattened"])
            totals["dropped"] += len(marks["dropped"])
            answers.update(marks["answers"])

        per_line = seconds / totals["asked"] if totals["asked"] else 0.0
        aligned = totals["missing"] == 0 and totals["extra"] == 0 and totals["duplicated"] == 0
        table.append(
            {
                "model": model,
                "seconds": seconds,
                "per_line": per_line,
                "episode_minutes": per_line * 1154 / 60,
                "aligned": aligned,
                **totals,
                "failures": failures,
            }
        )
        transcript[model] = {str(k): v for k, v in sorted(answers.items())}
        print(
            f"{model:24s} {seconds:7.1f}s  {per_line:5.2f}s/line  "
            f"missing {totals['missing']:3d}  extra {totals['extra']:3d}  "
            f"dup {totals['duplicated']:3d}  flattened {totals['flattened']:3d}  "
            f"DROPPED {totals['dropped']:3d}"
            + (f"  [{len(failures)} failed chunks]" if failures else "")
        )
        for why in failures[:3]:
            print(f"    {why}")

    print("\nmodel                     numbering  lost a speaker  reflowed  s/line  1154-cue episode")
    for row in sorted(table, key=lambda r: (not r["aligned"], r["dropped"], r["per_line"])):
        numbering = "ok" if row["aligned"] else f"{row['missing']}m/{row['extra']}x/{row['duplicated']}d"
        lost = "none" if not row["dropped"] else f"{row['dropped']} cues"
        print(
            f"{row['model']:24s}  {numbering:9s}  {lost:14s}  {row['flattened']:8d}  "
            f"{row['per_line']:5.2f}  {row['episode_minutes']:6.1f} min"
        )

    if args.transcript:
        payload = {
            "source": {str(i + 1): cues[i].text for i in range(args.start, stop)},
            "models": transcript,
        }
        args.transcript.write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")
        print(f"\nwrote {args.transcript}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
