#!/usr/bin/env python3
"""Translate a subtitle file in one pass, and pull the study words out with it.

Why a whole file at once, rather than a line at a time. The archive tiers the
daemon uses translate each line with nothing around it, so a pronoun has no
referent, a joke has no setup, and a name is translated as a noun. Reported
after a season of watching: "the English subtitle is good, but the Turkish
translation is too poor and almost useless." A model that can see the scene
answers a different question.

And why the vocabulary comes back in the SAME call. The study rail looks a word
up while the film is playing, which is where its latency lives. If the pass that
translates the file also lists what is worth learning in it, there is nothing
left to look up later - one request at the start of the episode instead of
several hundred during it.

This drives the local `claude` CLI. That is a deliberate choice for MEASURING
rather than for running: it needs no API key, which is what makes it the cheapest
way to see what a good answer looks like for this file. It is a poor production
backend - every invocation is a fresh session and re-sends Claude Code's own
system prompt, about 14,600 tokens, which is why the chunks here are large and
few. See docs/reports/llm-gateway-research-2026-09-08.md.

    tools/pretranslate.py FILE.srt --target tr --limit 120

Writes FILE-<target>.srt and FILE-<target>.vocab.json beside the input, or into
--out. Every chunk is written to the work directory as it lands, so a re-run
skips what is already answered.
"""

from __future__ import annotations

import argparse
import json
import subprocess
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))

from subtitle_daemon import subtitles  # noqa: E402

# How many cues go in one request.
#
# Large on purpose. Each `claude -p` is a fresh session and pays for its own
# system prompt, so the fixed cost is per REQUEST and not per line - the
# opposite of the daemon's own gloss batching, where the cap exists because a
# failure loses the whole batch. Measured on this machine: two lines cost
# $0.038 through Haiku, essentially all of it that fixed cost.
CHUNK = 120

# Lines of the previous chunk shown as context and not translated. A scene does
# not start at a chunk boundary.
CARRY = 4

SCHEMA = {
    "type": "object",
    "properties": {
        "lines": {
            "type": "array",
            "items": {
                "type": "object",
                "properties": {
                    "n": {"type": "integer"},
                    "tr": {"type": "string"},
                },
                "required": ["n", "tr"],
                "additionalProperties": False,
            },
        },
        "vocab": {
            "type": "array",
            "items": {
                "type": "object",
                "properties": {
                    "term": {"type": "string"},
                    "kind": {"type": "string", "enum": ["word", "phrase", "idiom"]},
                    "gloss": {"type": "string"},
                    "note": {"type": "string"},
                    "n": {"type": "integer"},
                },
                "required": ["term", "kind", "gloss", "n"],
                "additionalProperties": False,
            },
        },
    },
    "required": ["lines", "vocab"],
    "additionalProperties": False,
}

BRIEF = """\
You are translating a film's subtitles for someone who is watching it to learn \
{source}. Two jobs, one answer.

TRANSLATE every numbered line into {target}. Rules:
- One output line per input line, same number. Never merge or split lines.
- Translate what the line MEANS in this scene, not word by word. You can see the
  lines around it; use them. A pronoun keeps its referent, a joke keeps its
  setup, an order sounds like an order.
- Keep proper nouns as they are. Keep [bracketed sound cues] bracketed and
  translate the words inside them.
- Keep the register: swearing stays swearing, military terms stay military.
- Keep the line's own line breaks where it has them.

LIST what is worth studying in these lines. For each item:
- `term`: the {source} word, phrase or idiom exactly as it appears.
- `kind`: "word", "phrase" or "idiom".
- `gloss`: what it means HERE, in {target}, in one to three words.
- `note`: only when the item is an idiom or a false friend, one short sentence
  in {target} saying why it is not what it looks like. Omit it otherwise.
- `n`: the line it came from.
Choose what a learner at intermediate level would not already know: idioms,
phrasal verbs, military and technical vocabulary, and words used in an
unexpected sense. Skip names, numbers and everything a beginner knows. Ten to
twenty five items for this many lines is the right density; fewer is better than
padding.

Answer with the JSON object only.\
"""


def render(cues, first, last, carry_from):
    """The chunk as numbered text, with the tail of the previous chunk above it."""
    out = []
    if carry_from < first:
        out.append("--- for context only, already translated, do not answer for these ---")
        for index in range(carry_from, first):
            out.append(f"{index + 1}: {cues[index].text}")
        out.append("--- translate everything below ---")
    for index in range(first, last):
        out.append(f"{index + 1}: {cues[index].text}")
    return "\n".join(out)


def ask(prompt, model, budget):
    started = time.monotonic()
    done = subprocess.run(
        [
            "claude",
            "-p",
            "--model", model,
            "--output-format", "json",
            "--json-schema", json.dumps(SCHEMA),
            "--restricted",
            "--no-session-persistence",
            "--max-budget-usd", str(budget),
        ],
        input=prompt,
        capture_output=True,
        text=True,
    )
    if done.returncode != 0:
        raise SystemExit(f"claude exited {done.returncode}: {done.stderr[:400]}")
    envelope = json.loads(done.stdout)
    if envelope.get("is_error"):
        raise SystemExit(f"claude reported an error: {str(envelope.get('result'))[:400]}")
    answer = envelope.get("structured_output")
    if not isinstance(answer, dict):
        answer = json.loads(envelope["result"])
    return answer, float(envelope.get("total_cost_usd") or 0), time.monotonic() - started


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("srt", type=Path)
    parser.add_argument("--source", default="English")
    parser.add_argument("--target", default="Turkish")
    parser.add_argument("--code", default="tr", help="suffix for the output files")
    parser.add_argument("--model", default="claude-sonnet-5")
    parser.add_argument("--chunk", type=int, default=CHUNK)
    parser.add_argument("--start", type=int, default=0, help="first cue, 0-based")
    parser.add_argument("--limit", type=int, default=0, help="how many cues, 0 for all")
    parser.add_argument("--max-usd", type=float, default=1.0, help="per request")
    parser.add_argument("--out", type=Path, default=None)
    args = parser.parse_args()

    text, encoding = subtitles.decode(args.srt.read_bytes())
    cues = subtitles.parse_srt(text)
    stop = len(cues) if args.limit <= 0 else min(len(cues), args.start + args.limit)
    print(f"{args.srt.name}: {len(cues)} cues, {encoding}; doing {args.start}..{stop}")

    out_dir = args.out or args.srt.parent
    out_dir.mkdir(parents=True, exist_ok=True)
    work = out_dir / f".{args.srt.stem}-{args.code}-chunks"
    work.mkdir(exist_ok=True)

    lines: dict[int, str] = {}
    vocab: list[dict] = []
    spent = 0.0
    for first in range(args.start, stop, args.chunk):
        last = min(first + args.chunk, stop)
        held = work / f"{first:05d}-{last:05d}.json"
        if held.exists():
            answer = json.loads(held.read_text(encoding="utf-8"))
            print(f"  {first}..{last}: already on disk")
        else:
            prompt = (
                BRIEF.format(source=args.source, target=args.target)
                + "\n\n"
                + render(cues, first, last, max(args.start, first - CARRY))
            )
            answer, cost, took = ask(prompt, args.model, args.max_usd)
            spent += cost
            got = len(answer.get("lines") or [])
            print(
                f"  {first}..{last}: {got}/{last - first} lines, "
                f"{len(answer.get('vocab') or [])} terms, {took:.1f}s, ${cost:.3f}"
            )
            held.write_text(json.dumps(answer, ensure_ascii=False), encoding="utf-8")
        for row in answer.get("lines") or []:
            lines[int(row["n"]) - 1] = str(row["tr"])
        vocab.extend(answer.get("vocab") or [])

    missing = [i for i in range(args.start, stop) if i not in lines]
    if missing:
        print(f"  {len(missing)} lines came back empty: {missing[:10]}")

    made = []
    for index in range(args.start, stop):
        cue = cues[index]
        made.append(
            subtitles.Cue(
                start_ms=cue.start_ms,
                end_ms=cue.end_ms,
                text=lines.get(index, cue.text),
            )
        )

    srt_out = out_dir / f"{args.srt.stem}-{args.code}-llm.srt"
    srt_out.write_text(to_srt(made), encoding="utf-8")
    vocab_out = out_dir / f"{args.srt.stem}-{args.code}-llm.vocab.json"
    vocab_out.write_text(json.dumps(vocab, ensure_ascii=False, indent=2), encoding="utf-8")
    print(f"wrote {srt_out}")
    print(f"wrote {vocab_out}  ({len(vocab)} terms)")
    print(f"spent ${spent:.3f}")
    return 0


def to_srt(cues) -> str:
    def stamp(ms: int) -> str:
        hours, rest = divmod(max(0, ms), 3_600_000)
        minutes, rest = divmod(rest, 60_000)
        seconds, millis = divmod(rest, 1000)
        return f"{hours:02d}:{minutes:02d}:{seconds:02d},{millis:03d}"

    blocks = []
    for number, cue in enumerate(cues, start=1):
        blocks.append(f"{number}\n{stamp(cue.start_ms)} --> {stamp(cue.end_ms)}\n{cue.text}\n")
    return "\n".join(blocks)


if __name__ == "__main__":
    raise SystemExit(main())
