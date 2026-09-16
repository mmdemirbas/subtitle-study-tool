#!/usr/bin/env python3
"""Which model, with which brief, translates spoken dialogue into Turkish worth reading.

    uv run python tools/translate_quality.py --job <translate-job-dir> \\
        --candidate shipped --candidate gemma3:4b@spoken --candidate gemma3:12b@spoken \\
        --judge --out docs/reports/translate-quality-<date>

`tools/translate_bakeoff.py` chose the local default on numbering and speed and
says in its own words that it measured fluency "not at all". The reader then
watched an episode through it and reported the other half: "it translates,
but not very well. It misses the point most of the time. It is not supposed
to translate a book or academic language; it is supposed to translate daily
speech." This measures that half.

What a candidate is: a model on this machine and a brief, `model@brief`, run
the way the daemon runs it - forty cues a request, four of the previous chunk
carried in as context, greedy decode, JSON out - through ollama's own API so
that a model which reasons out loud can be told not to. Three candidates are
not models:

- `shipped`   the lines the daemon actually made for this job, read off its
              chunk files. What the reader saw.
- `shifted`   the shipped lines moved down by one cue: every answer under the
              number above it. A control for the judge - a grader that does
              not score this near the floor is not reading the line it was
              given, and nothing else here can be believed either.
- `google`    Google Translate v2, line by line, with the key in
              config.local.json. The floor a hosted machine translation sets,
              and what "daily speech" looks like without a model that can see
              the scene.

What is measured: each candidate's lines are handed to a stronger model as a
grader, with the whole English slice for context, and scored per line -
accuracy (this line's meaning in this scene, 1-5) and naturalness (reads like
a Turkish subtitle a native speaker would say, 1-5) - and tagged with the
worst thing wrong. The grader is `claude -p`, the instrument the pretranslate
trial used, and it is an instrument here too: it costs a fixed system prompt
per call, and this makes one call per candidate. Alongside the scores, the
same structural checks the bake-off keeps: numbering, speakers dropped.

The scores rank; the transcript decides. Every candidate's every line goes
into `transcript.md` beside the English, for reading by eye - by a native
speaker, which the grader is not.
"""

from __future__ import annotations

import argparse
import json
import subprocess
import sys
import time
import urllib.parse
import urllib.request
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "src"))

from subtitle_daemon import subtitles, translate

OLLAMA_CHAT = "http://127.0.0.1:11434/api/chat"
CHUNK = translate.CHUNK
CARRY = translate.CARRY

# The brief the daemon ships (translate.BRIEF), so a candidate can be measured
# on exactly what runs.
BRIEFS: dict[str, str] = {"current": translate.BRIEF}

# The brief this asks about: the same contract, said for spoken dialogue.
#
# Two things are different on purpose. The register is named - everyday
# spoken Turkish, short, the way a subtitler writes it - with examples of the
# register rather than rules about it, because a 4B model follows an example
# where it ignores an adjective. And there is no literal example of a
# two-speaker line: the shipped brief's `"- A.\n- B."` came back appended to
# the answers themselves, as "- A." and "- B." on the ends of lines 261-265
# of the reader's own episode. The rule is said in words.
BRIEFS["spoken"] = """\
You are subtitling a TV series into {target} for someone who is watching it to learn {source}. These are lines of dialogue, spoken aloud by characters, not written prose.

Translate every numbered line into {target} the way a professional {target} subtitler would:
- Everyday spoken {target}, the words people actually say to each other. Not formal, not written, not textbook language. Contractions, slang, filler and swearing stay at the same level in {target}.
- Short. A subtitle is read in two seconds; say it the way a {target} speaker would say it, not word by word from the {source}.
- The MEANING of the line in this scene. Idioms, sarcasm and jokes become the {target} idiom, sarcasm or joke with the same effect. A pronoun keeps its referent; an order sounds like an order; a question stays a question.
- Address: characters who are friends, family or colleagues on first-name terms speak informally to each other; strangers, bosses and officials formally, unless the scene shows otherwise.

Keep the file's shape exactly:
- One answer per numbered line, under the SAME number. Never merge two numbered lines into one answer, never split one line into two answers, never answer for a number you were not given.
- A numbered line may contain a line break, often because two people speak in it, each line starting with a dash. Keep the breaks, keep every speaker: two dash-led lines in, two dash-led lines out. Do not add dashes, letters or labels that are not in the line.
- Keep proper nouns as they are. Keep [bracketed sound cues] bracketed, translating the words inside. Keep <i> and <b> tags around the same words.

Examples of the register, {source} to {target}:
- "You've got to be kidding me." -> "Şaka yapıyorsun herhalde."
- "I'm not gonna lie, that was rough." -> "Yalan yok, zor oldu."
- "He totally bailed on us." -> "Bizi resmen ekti."
- "Knock it off." -> "Kes şunu."
- "Fair enough." -> "Peki, haklısın."
- "What's the catch?" -> "Bunun bir bityeniği ne?"
- "I can't even." -> "Dayanamıyorum."
- "Can you cover for me?" -> "Benim yerime bakar mısın?"

Answer with a JSON object only: {{"lines": [{{"n": 1, "{code}": "..."}}]}}\
"""


# --- the source ---------------------------------------------------------------


def load_job(job: Path) -> tuple[list, dict[int, str]]:
    """A translate job's cues and the lines its chunk files hold, 1-based."""
    cues = subtitles.parse_srt(job.joinpath("source.srt").read_text(encoding="utf-8"))
    landed: dict[int, str] = {}
    for path in sorted(job.joinpath("chunks").glob("*.json")):
        for row in json.loads(path.read_text(encoding="utf-8")).get("lines", []):
            landed[int(row["n"])] = translate.line_text(row)
    return cues, landed


# --- the candidates -----------------------------------------------------------


def ask_ollama(model: str, system: str, user: str, timeout: float) -> tuple[dict | None, float, str]:
    """One request through ollama's own API: thinking off, JSON on, greedy."""
    body = json.dumps(
        {
            "model": model,
            "messages": [{"role": "system", "content": system}, {"role": "user", "content": user}],
            "think": False,
            "format": "json",
            "stream": False,
            "options": {"temperature": 0, "num_ctx": 8192},
        }
    ).encode("utf-8")
    request = urllib.request.Request(OLLAMA_CHAT, data=body, headers={"Content-Type": "application/json"})
    started = time.monotonic()
    try:
        with urllib.request.urlopen(request, timeout=timeout) as response:
            raw = json.loads(response.read().decode("utf-8"))
        said = raw["message"]["content"]
    except Exception as error:  # noqa: BLE001 - every failure is a result here
        return None, time.monotonic() - started, f"{type(error).__name__}: {error}"
    took = time.monotonic() - started
    try:
        return json.loads(said), took, ""
    except ValueError:
        return None, took, f"not JSON: {said[:160]!r}"


def unload(model: str) -> None:
    body = json.dumps({"model": model, "messages": [], "keep_alive": 0}).encode()
    request = urllib.request.Request(OLLAMA_CHAT, data=body, headers={"Content-Type": "application/json"})
    try:
        urllib.request.urlopen(request, timeout=30).read()
    except Exception as error:  # noqa: BLE001 - a courtesy, never a failure
        print(f"  (could not unload {model}: {error})")


class Candidate(translate.Translator):
    """The daemon's translator - its chunking, its halving of a chunk that
    came back misnumbered, its re-asking of a cue that lost a speaker - with
    the one request it makes routed through ollama's own API, where a model
    that reasons out loud can be told not to. What is measured is then what
    would ship with this model and brief, repairs included; the first draft
    of this tool sent the bare request and counted every misnumbered chunk
    against the model, which the daemon would have halved and re-asked."""

    def __init__(self, model: str, brief: str, code: str, timeout: float) -> None:
        super().__init__(model=model, target_code=code, timeout=timeout)
        self._brief = brief
        self.seconds = 0.0
        self.requests = 0
        self.failures: list[str] = []

    @property
    def brief(self) -> str:  # type: ignore[override]
        return self._brief.format(source=self.source, target=self.target, code=self.target_code)

    def _ask(self, prompt: str, what: str) -> dict[int, str] | None:  # type: ignore[override]
        answer, took, why = ask_ollama(self.model, self.brief, prompt, self.timeout)
        self.seconds += took
        self.requests += 1
        if answer is None:
            self.failures.append(f"{what}: {why}")
            return None
        return translate._numbered(answer, self.target_code)


def run_model(model: str, brief: str, cues: list, start: int, stop: int, code: str, timeout: float) -> dict:
    """The daemon's walk over the slice, repairs and all."""
    translator = Candidate(model, brief, code, timeout)
    lines: dict[int, str] = {}
    missing: list[int] = []
    unrepaired: list[int] = []
    repaired: list[int] = []
    for first in range(start, stop, CHUNK):
        last = min(first + CHUNK, stop)
        attempt = translator.chunk_lines(cues, first, last, floor=start)
        lines.update(attempt.lines)
        missing.extend(attempt.missing)
        unrepaired.extend(attempt.unrepaired)
        repaired.extend(attempt.repaired)
    asked = stop - start
    # A cue left in the source language on purpose is not a translation; it
    # is graded as what it is, and counted here as what the daemon reports.
    return {
        "lines": {str(n): lines[n] for n in sorted(lines)},
        "seconds": round(translator.seconds, 1),
        "per_line": round(translator.seconds / asked, 2) if asked else 0,
        "requests": translator.requests,
        "missing": len(missing),
        "dropped_speakers": len(unrepaired),
        "repaired": len(repaired),
        "failures": translator.failures,
    }


def run_google(cues: list, start: int, stop: int, key: str) -> dict:
    lines: dict[int, str] = {}
    started = time.monotonic()
    for first in range(start, stop, 50):
        last = min(first + 50, stop)
        batch = [cues[i].text for i in range(first, last)]
        body = urllib.parse.urlencode(
            [("q", text) for text in batch] + [("source", "en"), ("target", "tr"), ("format", "text"), ("key", key)]
        ).encode("utf-8")
        request = urllib.request.Request("https://translation.googleapis.com/language/translate/v2", data=body)
        with urllib.request.urlopen(request, timeout=60) as response:
            answer = json.loads(response.read().decode("utf-8"))
        for offset, row in enumerate(answer["data"]["translations"]):
            lines[first + offset + 1] = row["translatedText"]
    seconds = time.monotonic() - started
    return {
        "lines": {str(n): lines[n] for n in sorted(lines)},
        "seconds": round(seconds, 1),
        "per_line": round(seconds / (stop - start), 2),
        "missing": (stop - start) - len(lines),
        "dropped_speakers": sum(
            1 for n, text in lines.items() if translate.speakers(cues[n - 1].text) >= 2 and translate.speakers(text) < translate.speakers(cues[n - 1].text)
        ),
        "failures": [],
    }


# --- the grader ---------------------------------------------------------------

# Each line as a pair, the Turkish directly under its English. The first
# grading pass (claude-sonnet-5) read the English slice as one block and the
# candidate as another, cross-referenced by number, and scored a candidate
# whose answers had drifted three lines down as "ok" on the drifted lines -
# the Turkish was fluent and about the same scene, and the grader matched it
# by topic. The shifted control caught the uniform shift and not this. The
# second pass changed the grader (claude-opus-5) and the shape together, so
# which of the two is what caught the drift is not separated. Pairs make the
# question local either way: is THIS Turkish THIS English line.
GRADER = """\
You are grading Turkish subtitle translations of English television dialogue (a workplace comedy, spoken lines). Below, every numbered line is given as a pair: the English line, then the candidate's Turkish for that same number. The English lines are in order, so the neighbours are the scene's context.

The commonest failure in these candidates is DRIFT: the Turkish under a number is the translation of a neighbouring English line (one or several lines away), not of the line it sits under. Check for it on every line first. A fluent Turkish sentence that translates a different line is accuracy 1 with issue "wrong-line", however good it reads.

For EVERY pair, score:
- accuracy, 1-5: 5 = the meaning of THIS English line in THIS scene is fully preserved; 3 = the gist is there but something is lost or added; 2 = a real part of the meaning is wrong; 1 = a different meaning, another line's content, untranslated English, empty, or nonsense.
- naturalness, 1-5: 5 = reads like a professional Turkish subtitle, everyday spoken Turkish a native speaker would actually say, short; 3 = understandable but stiff, bookish or word-for-word; 1 = broken Turkish. An empty answer is 1.
- issue: the worst thing wrong, one of: ok, wrong-line, mistranslation, unnatural, untranslated, truncated, extra-content, wrong-register, broken-turkish.

Score the pair you are given, not the candidate as a whole.

Answer with JSON only: {"lines": [{"n": <number>, "accuracy": <1-5>, "naturalness": <1-5>, "issue": "<tag>"}]}, one entry per numbered line, in order.
"""

SCHEMA = {
    "type": "object",
    "properties": {
        "lines": {
            "type": "array",
            "items": {
                "type": "object",
                "properties": {
                    "n": {"type": "integer"},
                    "accuracy": {"type": "integer"},
                    "naturalness": {"type": "integer"},
                    "issue": {"type": "string"},
                },
                "required": ["n", "accuracy", "naturalness", "issue"],
            },
        }
    },
    "required": ["lines"],
}


def grade(cues: list, start: int, stop: int, lines: dict[str, str], model: str, budget: float) -> tuple[dict, float, float]:
    pairs = "\n\n".join(
        f"{n}\nEN: {json.dumps(cues[n - 1].text, ensure_ascii=False)}\nTR: {json.dumps(lines.get(str(n), ''), ensure_ascii=False)}"
        for n in range(start + 1, stop + 1)
    )
    prompt = f"{GRADER}\n\n=== The pairs ===\n\n{pairs}\n"
    started = time.monotonic()
    done = subprocess.run(
        [
            "claude", "-p", "--model", model, "--output-format", "json", "--json-schema", json.dumps(SCHEMA),
            "--restricted", "--no-session-persistence", "--max-budget-usd", str(budget),
        ],
        input=prompt, capture_output=True, text=True, check=False,
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


def summarise(graded: dict, asked: int) -> dict:
    rows = [row for row in graded.get("lines", []) if isinstance(row, dict)]
    if not rows:
        return {"graded": 0}
    accuracy = [int(row["accuracy"]) for row in rows]
    natural = [int(row["naturalness"]) for row in rows]
    issues: dict[str, int] = {}
    for row in rows:
        issues[str(row.get("issue") or "?")] = issues.get(str(row.get("issue") or "?"), 0) + 1
    return {
        "graded": len(rows),
        "accuracy_mean": round(sum(accuracy) / len(accuracy), 2),
        "naturalness_mean": round(sum(natural) / len(natural), 2),
        "accuracy_le2": sum(1 for a in accuracy if a <= 2),
        "both_ge4": sum(1 for a, b in zip(accuracy, natural) if a >= 4 and b >= 4),
        "issues": dict(sorted(issues.items(), key=lambda kv: -kv[1])),
    }


# --- the run ------------------------------------------------------------------


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--job", type=Path, required=True, help="a cache/translate-jobs/<key> directory")
    parser.add_argument("--start", type=int, default=240, help="first cue, 0-based")
    parser.add_argument("--limit", type=int, default=60)
    parser.add_argument("--candidate", action="append", default=[], help="model@brief, or shipped / shifted / google")
    parser.add_argument("--judge", action="store_true", help="grade with claude -p")
    parser.add_argument("--judge-model", default="claude-opus-5")
    parser.add_argument("--budget", type=float, default=1.5, help="max USD per grading call")
    parser.add_argument("--timeout", type=float, default=900.0)
    parser.add_argument("--out", type=Path, required=True, help="directory for answers.json, judged.json, transcript.md")
    parser.add_argument("--reuse", action="store_true", help="keep answers.json entries already there; run only what is missing")
    args = parser.parse_args()

    cues, shipped = load_job(args.job)
    stop = min(len(cues), args.start + args.limit)
    asked = stop - args.start
    args.out.mkdir(parents=True, exist_ok=True)
    answers_path = args.out / "answers.json"
    answers: dict[str, dict] = json.loads(answers_path.read_text(encoding="utf-8")) if args.reuse and answers_path.exists() else {}
    print(f"{args.job.name}: {len(cues)} cues; measuring {args.start + 1}-{stop} ({asked} lines)\n")

    key = ""
    config = Path(__file__).resolve().parents[1] / "config.local.json"
    if config.exists():
        key = str(json.loads(config.read_text(encoding="utf-8")).get("google_api_key") or "")

    for name in args.candidate:
        if name in answers:
            print(f"{name:28s} kept from answers.json")
            continue
        if name == "shipped":
            lines = {str(n): shipped.get(n, "") for n in range(args.start + 1, stop + 1)}
            answers[name] = {"lines": lines, "seconds": 0, "per_line": 0, "missing": sum(1 for v in lines.values() if not v), "dropped_speakers": 0, "failures": []}
        elif name == "shifted":
            lines = {str(n): shipped.get(n - 1, "") for n in range(args.start + 1, stop + 1)}
            answers[name] = {"lines": lines, "seconds": 0, "per_line": 0, "missing": 0, "dropped_speakers": 0, "failures": ["control: every line is the one above it"]}
        elif name == "google":
            if not key:
                print("google: no google_api_key in config.local.json; skipped")
                continue
            answers[name] = run_google(cues, args.start, stop, key)
        else:
            model, _, brief_name = name.partition("@")
            brief = BRIEFS.get(brief_name or "current")
            if brief is None:
                raise SystemExit(f"{name}: no brief called {brief_name!r}; have {sorted(BRIEFS)}")
            unload(model)
            answers[name] = run_model(model, brief, cues, args.start, stop, "tr", args.timeout)
            unload(model)
        got = answers[name]
        print(f"{name:28s} {got['seconds']:7.1f}s  {got['per_line']:5.2f}s/line  missing {got['missing']:3d}  dropped speakers {got['dropped_speakers']:3d}  repaired {got.get('repaired', 0):2d}  requests {got.get('requests', 0):2d}" + (f"  [{len(got['failures'])} failures]" if got["failures"] else ""))
        for why in got["failures"][:3]:
            print(f"    {why}")
        answers_path.write_text(json.dumps(answers, ensure_ascii=False, indent=2), encoding="utf-8")

    judged_path = args.out / "judged.json"
    judged: dict[str, dict] = json.loads(judged_path.read_text(encoding="utf-8")) if judged_path.exists() else {}
    if args.judge:
        print()
        for name in args.candidate:
            if name not in answers or name in judged:
                continue
            graded, cost, took = grade(cues, args.start, stop, answers[name]["lines"], args.judge_model, args.budget)
            judged[name] = {"scores": graded, "cost_usd": round(cost, 3), "seconds": round(took, 1), "judge": args.judge_model, "summary": summarise(graded, asked)}
            judged_path.write_text(json.dumps(judged, ensure_ascii=False, indent=2), encoding="utf-8")
            s = judged[name]["summary"]
            print(f"{name:28s} graded {s.get('graded', 0):3d}  accuracy {s.get('accuracy_mean', 0):4.2f}  natural {s.get('naturalness_mean', 0):4.2f}  acc<=2 {s.get('accuracy_le2', 0):3d}  both>=4 {s.get('both_ge4', 0):3d}  ${cost:.3f} {took:.0f}s")

    # The table, and the transcript for reading by eye.
    names = [n for n in args.candidate if n in answers]
    print("\ncandidate                    s/line  missing  dropped  accuracy  natural  acc<=2  both>=4  worst issues")
    for name in sorted(names, key=lambda n: -(judged.get(n, {}).get("summary", {}).get("accuracy_mean") or 0)):
        a = answers[name]
        s = judged.get(name, {}).get("summary", {})
        worst = ", ".join(f"{k} {v}" for k, v in list(s.get("issues", {}).items())[:3] if k != "ok")
        print(
            f"{name:28s} {a['per_line']:6.2f}  {a['missing']:7d}  {a['dropped_speakers']:7d}  "
            f"{s.get('accuracy_mean', 0):8.2f}  {s.get('naturalness_mean', 0):7.2f}  {s.get('accuracy_le2', 0):6d}  {s.get('both_ge4', 0):7d}  {worst}"
        )

    out = [f"# Translation quality: {args.job.name}, lines {args.start + 1}-{stop}\n"]
    out.append("Scores are the grader's (accuracy / naturalness, 1-5), read the line.\n")
    for n in range(args.start + 1, stop + 1):
        out.append(f"\n### {n}\n\n**EN:** {cues[n - 1].text.replace(chr(10), ' / ')}\n")
        out.append("| candidate | Turkish | acc | nat | issue |\n|---|---|---|---|---|")
        for name in names:
            text = answers[name]["lines"].get(str(n), "").replace("\n", " / ").replace("|", "\\|")
            row = next((r for r in judged.get(name, {}).get("scores", {}).get("lines", []) if isinstance(r, dict) and int(r.get("n", -1)) == n), None)
            acc = row["accuracy"] if row else ""
            nat = row["naturalness"] if row else ""
            issue = row.get("issue", "") if row else ""
            out.append(f"| {name} | {text} | {acc} | {nat} | {issue} |")
    (args.out / "transcript.md").write_text("\n".join(out) + "\n", encoding="utf-8")
    print(f"\nwrote {answers_path}, {judged_path}, {args.out / 'transcript.md'}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
