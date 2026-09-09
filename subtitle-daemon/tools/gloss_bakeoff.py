"""Which model should gloss the words, on this machine.

    uv run python tools/gloss_bakeoff.py [model ...]

Reported after a season of watching: "your model choice is too big. nothing else
can run in this computer when you run that much big models." The configured
qwen3.6:35b-a3b is 22.6 GB resident and answered about a word every twenty to
thirty-five seconds, which is both of the complaints that came with it - the
translations are late, and the ones that arrive late are the ones the tier below
answered instead.

So this asks the question with numbers rather than by reasoning about parameter
counts. Every candidate answers the SAME set of words through the daemon's own
`_gloss`, so what is measured is the request the daemon really sends, including
the strict JSON contract and the answer-count check that refuses a short array.

The set is small and hand-built, and every item has an accepted-answer list
written before any model was run. Half of them are words whose meaning is
decided by the line they are in - "shotgun" shouted at a car is not a gun, and
"domestic" beside "foreign" is not "yerli" - because that is the whole reason
this tier exists. A model that gets the bare-word ones right and the contextual
ones wrong is not better than the free translator underneath it.

Accuracy here is agreement with a short list of acceptable Turkish forms, not a
judgement of fluency. It is a screen, not a verdict: it separates a model that
can do this from one that cannot, and the ones that pass are worth reading by
eye afterwards - which is what the transcript this prints is for.
"""

from __future__ import annotations

import argparse
import json
import sys
import time
import urllib.request
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "src"))

from subtitle_daemon.lookups import Ask, Lookups  # noqa: E402

OLLAMA = "http://127.0.0.1:11434"

# Not a model name: the tier below every model, asked for by name so it can be
# put in the same table.
GOOGLE = "google-translate"


def google_key() -> str:
    """The reader's own key, read where the daemon reads it."""
    settings = Path(__file__).resolve().parent.parent / "config.local.json"
    if not settings.exists():
        return ""
    return json.loads(settings.read_text()).get("google_api_key", "")

# One question per line, with what a Turkish speaker would accept for it.
#
# `context` marks the ones whose answer cannot be had from the word alone. They
# are the ones that decide this: a model that only manages the others is doing
# what Google already does for nothing, in twenty seconds instead of a quarter
# of one.
CASES: list[dict] = [
    {
        "term": "domestic",
        "line": 'from threats both foreign and domestic."',
        "before": "to protect the United States",
        "after": "That is what I swore.",
        "ok": ["iç", "içeriden", "yurtiçi", "ülke içi", "iç kaynaklı"],
        "context": True,
    },
    {
        "term": "shotgun",
        "line": "- See ya. Shotgun! - Bye.",
        "before": "We're going now.",
        "after": "Put your seatbelt on.",
        "ok": ["ön koltuk", "ön koltuğu", "ön koltuk benim", "öne ben"],
        "context": True,
    },
    {
        "term": "spare",
        "line": "We are down to one spare engine.",
        "before": "How bad is it?",
        "after": "Then we have no margin.",
        "ok": ["yedek"],
        "context": True,
    },
    {
        "term": "spare",
        "line": "Can you spare a minute?",
        "before": "I know you're busy.",
        "after": "It won't take long.",
        "ok": ["ayırmak", "ayırmak mı", "ayır", "vermek", "ayırabilmek"],
        "context": True,
    },
    {
        "term": "bug",
        "line": "They found a bug in the ambassador's phone.",
        "before": "The sweep came back.",
        "after": "Someone has been listening.",
        "ok": ["dinleme cihazı", "böcek", "gizli dinleme cihazı", "dinleme aygıtı"],
        "context": True,
    },
    {
        "term": "draft",
        "line": "He got his draft notice last week.",
        "before": "What happened to him?",
        "after": "He ships out in the spring.",
        "ok": ["celp", "askerlik celbi", "askere çağrı", "celp kağıdı", "askerlik daveti"],
        "context": True,
    },
    {"term": "medic", "line": "Her husband was a medic in the American army.",
     "before": "What did he do?", "after": "He served two tours.",
     "ok": ["sıhhiye", "sıhhiyeci", "sağlık görevlisi", "askeri sağlıkçı", "sağlık eri"],
     "context": False},
    {"term": "vault", "line": "That is the vault.",
     "before": "Where do they keep it?", "after": "Nobody goes in alone.",
     "ok": ["kasa", "kasa dairesi", "hazine dairesi"], "context": False},
    {"term": "courier", "line": "I am a courier, so...",
     "before": "What is it you do?", "after": "I move things for people.",
     "ok": ["kurye", "haberci", "ulak"], "context": False},
    {"term": "pantry", "line": "Who's going to the pantry with Mary?",
     "before": "We need more hands.", "after": "I'll go.",
     "ok": ["kiler", "erzak odası", "kumanya odası", "yiyecek deposu"], "context": False},
    {"term": "collaborator", "line": "A collaborator.",
     "before": "What did they call him?", "after": "He never denied it.",
     "ok": ["işbirlikçi", "iş birlikçi", "hain"], "context": False},
    {"term": "asparagus", "line": "Mashed potatoes and gravy and asparagus.",
     "before": "What's for dinner?", "after": "You hate asparagus.",
     "ok": ["kuşkonmaz"], "context": False},
    # The one that has to come back EMPTY. The system prompt asks for "" on a
    # proper noun, and a model that translates a character's name puts a wrong
    # word under it on screen.
    {"term": "Paige", "line": "Paige, come down here.",
     "before": "Dinner's ready.", "after": "Coming!",
     "ok": [""], "context": False},
]


def fold(text: str) -> str:
    return " ".join(str(text).strip().lower().replace("ı", "i").split())


def unload(model: str) -> None:
    """Let the next candidate have the memory. Without this, three models sit
    resident at once and the machine this is meant to protect is the one paying
    for the measurement."""
    body = json.dumps({"model": model, "keep_alive": 0}).encode()
    request = urllib.request.Request(
        f"{OLLAMA}/api/generate", data=body, headers={"Content-Type": "application/json"}
    )
    try:
        urllib.request.urlopen(request, timeout=60).read()
    except OSError:
        pass


def plainly(model: str, ask: Ask, timeout: float) -> str:
    """One word, one request, no JSON.

    A model trained for translation and nothing else may not be able to hold the
    daemon's contract - an array of exactly N answers, in order, as JSON - and
    refusing it on that alone would confuse "cannot translate" with "cannot
    format". This asks the question the way such a model expects it, so the two
    can be told apart. It is slower by construction: one request per word rather
    than one per batch.
    """
    body = json.dumps(
        {
            "model": model,
            "messages": [
                {
                    "role": "user",
                    "content": (
                        f'In the subtitle line "{ask.line}", what does "{ask.term}" mean in '
                        f"Turkish? Answer with one to three words and nothing else."
                    ),
                }
            ],
            "temperature": 0,
        }
    ).encode()
    request = urllib.request.Request(
        f"{OLLAMA}/v1/chat/completions", data=body,
        headers={"Content-Type": "application/json"},
    )
    try:
        with urllib.request.urlopen(request, timeout=timeout) as response:
            raw = json.loads(response.read().decode("utf-8"))
        said = raw["choices"][0]["message"]["content"]
    except Exception:
        return ""
    # The same shortening the daemon applies, so the two modes are comparable.
    from subtitle_daemon.chat import THINKING
    from subtitle_daemon.lookups import _short_gloss

    return _short_gloss(THINKING.sub("", said).strip().splitlines()[0] if said.strip() else "", ask.term)


def run(model: str, timeout: float) -> dict:
    glosser = Lookups(
        Path(tempdir),
        gloss_model=model,
        gloss_url=f"{OLLAMA}/v1/chat/completions",
        google_key=google_key(),
    )
    asks = [Ask(c["term"], c["line"], c["before"], c["after"]) for c in CASES]

    # The tier that answers today, scored on the same words, so "is a local
    # model worth its memory" is a comparison and not an opinion. Google never
    # sees the line - that is the whole shape of the result and the reason the
    # contextual column is reported separately.
    if model == GOOGLE:
        started = time.monotonic()
        said = [glosser._fetch_google(ask.term, "en", "tr") for ask in asks]
        took = time.monotonic() - started
        rows = [
            {
                "term": case["term"],
                "context": case["context"],
                "answer": answer,
                "right": fold(answer) in [fold(x) for x in case["ok"]],
            }
            for case, answer in zip(CASES, said)
        ]
        return {"model": model, "took": took, "cold": 0.0, "refused": False, "rows": rows}

    # Loading and answering are two different costs and only one of them is
    # about the model being good.
    #
    # The first version of this timed them together and read the total as
    # throughput. It is not: a single-word request against a cold qwen3:14b took
    # 74.8 seconds and generated eight tokens. Nearly all of that was 9.3 GB
    # coming off disk on a machine already under load. Warm, the same request
    # took 1.3 seconds.
    #
    # Which one the reader feels depends on whether the model is resident when
    # the film starts, and that is a property of its size and of how long ollama
    # keeps it - not of how well it translates. Both are reported.
    unload(model)
    started = time.monotonic()
    if args.plain:
        plainly(model, asks[0], timeout)
    else:
        glosser._gloss(asks[:1], "en", "tr", timeout, film="The Americans")
    cold = time.monotonic() - started

    started = time.monotonic()
    if args.plain:
        said = [plainly(model, ask, timeout) for ask in asks]
    else:
        said = glosser._gloss(asks, "en", "tr", timeout, film="The Americans")
    took = time.monotonic() - started
    unload(model)

    # None is the daemon's word for "could not be asked" - a malformed answer, a
    # wrong-length array, or the clock. It is not the same as a row of blanks,
    # and for a candidate model it is a hard failure: the contract is part of
    # what is being tested.
    if said is None or not any(said):
        return {"model": model, "took": took, "cold": cold, "refused": said is None, "rows": []}

    rows = []
    for case, answer in zip(CASES, said):
        rows.append({
            "term": case["term"],
            "context": case["context"],
            "answer": answer,
            "right": fold(answer) in [fold(x) for x in case["ok"]],
        })
    return {"model": model, "took": took, "cold": cold, "refused": False, "rows": rows}


parser = argparse.ArgumentParser()
parser.add_argument("models", nargs="*", help="ollama model names; default is every candidate")
parser.add_argument("--timeout", type=float, default=900.0)
parser.add_argument(
    "--plain",
    action="store_true",
    help="one word per request, plain text back, instead of the daemon's JSON contract",
)
args = parser.parse_args()

import tempfile  # noqa: E402

tempdir = tempfile.mkdtemp()

wanted = args.models or [GOOGLE]

contextual = sum(1 for c in CASES if c["context"])
print(f"{len(CASES)} words, {contextual} of them decided by the line they are in\n")

results = []
for model in wanted:
    print(f"--- {model}", flush=True)
    result = run(model, args.timeout)
    results.append(result)
    if not result["rows"]:
        why = "the contract was broken" if result["refused"] else "every answer was empty"
        print(f"    nothing usable after {result['took']:.0f}s - {why}\n", flush=True)
        continue
    right = sum(1 for r in result["rows"] if r["right"])
    rightc = sum(1 for r in result["rows"] if r["right"] and r["context"])
    print(f"    {result['cold']:.0f}s to load, then {result['took']:.0f}s for {len(CASES)} words "
          f"({result['took'] / len(CASES):.1f}s each), "
          f"{right}/{len(CASES)} accepted, {rightc}/{contextual} of the contextual ones")
    for r in result["rows"]:
        mark = "ok " if r["right"] else "NO "
        kind = "line" if r["context"] else "word"
        print(f"      {mark} {kind}  {r['term']:14} {r['answer']!r}")
    print(flush=True)

print("\nsummary")
print(f"  {'model':26} {'seconds':>8} {'a word':>8} {'accepted':>10} {'contextual':>11}")
for r in results:
    if not r["rows"]:
        said = "refused" if r["refused"] else "empty"
        print(f"  {r['model']:26} {r['cold']:7.0f} {r['took']:7.0f} {'-':>8} {said:>10} {'-':>11}")
        continue
    right = sum(1 for x in r["rows"] if x["right"])
    rightc = sum(1 for x in r["rows"] if x["right"] and x["context"])
    print(f"  {r['model']:26} {r['cold']:7.0f} {r['took']:7.0f} {r['took'] / len(CASES):8.1f} "
          f"{f'{right}/{len(CASES)}':>10} {f'{rightc}/{contextual}':>11}")
