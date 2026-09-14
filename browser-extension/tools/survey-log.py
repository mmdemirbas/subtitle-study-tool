"""What the running log is made of.

Reads every subtitle-daemon/logs/<date>.jsonl and prints counts: lines and
bytes by kind, by day, by host; every error message and where it came from;
every message shown to the reader; which perf windows had anything of ours
in them; what the automatic attach decided and why. Numbers only - no line
of the log is printed whole, so the output is safe to paste.

    python3 browser-extension/tools/survey-log.py            # both passes
    python3 browser-extension/tools/survey-log.py kinds      # the second pass only

Written for docs/reports/under-the-hood-2026-09-14.md; run it again after a
change to trace() to see what the change did to the log.
"""
import sys
from pathlib import Path

LOGS = Path(__file__).resolve().parents[2] / "subtitle-daemon" / "logs"
PASS = sys.argv[1] if len(sys.argv) > 1 else "all"


def pass_one():
    import json, glob, collections, re
    kinds = collections.Counter()
    errors = collections.Counter()
    said = collections.Counter()
    perf = []
    hosts = collections.Counter()
    attach_fail = collections.Counter()
    transport = collections.Counter()
    by_day = collections.Counter()
    files = sorted(glob.glob(str(LOGS / "*.jsonl")))
    n = 0
    sample_err = {}
    for f in files:
        day = f.split("/")[-1][:10]
        for line in open(f, encoding="utf-8", errors="replace"):
            try: e = json.loads(line)
            except Exception: continue
            n += 1
            k = e.get("kind") or e.get("type") or "?"
            kinds[k] += 1
            by_day[day] += 1
            h = e.get("host") or e.get("site") or (e.get("url") or "")[:40]
            if h: hosts[h] += 1
            if k in ("error", "unhandled", "workerError", "rejection") or "error" in str(k).lower():
                msg = str(e.get("message") or e.get("error") or e.get("reason") or e.get("detail") or e)[:160]
                msg = re.sub(r"\d+", "N", msg)
                errors[(k, msg)] += 1
                sample_err.setdefault((k, msg), (day, json.dumps(e)[:500]))
            if k == "said":
                t = str(e.get("message") or "")[:120]
                t = re.sub(r"\d+", "N", t)
                said[t] += 1
            if k == "perf":
                perf.append(e)
            if k in ("autoAttach", "attachFailed", "fetch") and (e.get("reason") or e.get("error") or e.get("failed")):
                attach_fail[(k, str(e.get("reason") or e.get("error") or e.get("failed"))[:100])] += 1
            s = json.dumps(e)
            if "transportError" in s: transport[k] += 1
    print("entries", n, "files", len(files))
    print("\n== kinds"); [print(f"{c:7d} {k}") for k, c in kinds.most_common(60)]
    print("\n== by day"); [print(f"{c:7d} {k}") for k, c in sorted(by_day.items())]
    print("\n== hosts"); [print(f"{c:7d} {k}") for k, c in hosts.most_common(20)]
    print("\n== errors"); [print(f"{c:5d} {k} | {m}") for (k, m), c in errors.most_common(40)]
    print("\n== error samples")
    for key, (day, s) in list(sample_err.items())[:40]: print(day, s[:300])
    print("\n== said"); [print(f"{c:5d} {t}") for t, c in said.most_common(50)]
    print("\n== attach failures"); [print(f"{c:5d} {k} {r}") for (k, r), c in attach_fail.most_common(30)]
    print("\n== transportError by kind", dict(transport))
    print("\n== perf lines", len(perf))
    if perf:
        ours = [p for p in perf if (p.get("ours") or p.get("ourMs") or 0)]
        print("sample", json.dumps(perf[-1])[:600])


def pass_two():
    import json, glob, collections, re
    files = sorted(glob.glob(str(LOGS / "*.jsonl")))
    size = collections.Counter(); cnt = collections.Counter()
    perf_attached = collections.Counter(); perf_host = collections.Counter()
    err_file = collections.Counter()
    looking = collections.Counter(); looking_days = collections.Counter()
    sync_by_attach = collections.Counter()
    auto = collections.Counter()
    align_ans = collections.Counter()
    warm = collections.Counter()
    comeon = collections.Counter()
    panel_sizes = []
    for f in files:
        day = f.split("/")[-1][:10]
        for line in open(f, encoding="utf-8", errors="replace"):
            try: e = json.loads(line)
            except Exception: continue
            k = e.get("kind") or "?"
            size[k] += len(line); cnt[k] += 1
            if k == "perf":
                perf_attached[(bool(e.get("attached")), e.get("role"), bool(e.get("panel")))] += 1
                u = (e.get("tab") or {}).get("url") or ""
                perf_host[re.sub(r"^(https?://[^/]+).*", r"\1", u)] += 1
            if k == "error":
                err_file[re.sub(r"\?.*", "", str(e.get("file") or e.get("source") or ""))[:80]] += 1
            if k == "said" and str(e.get("text", "")).startswith("Looking for"):
                looking[(e.get("host") or e.get("site") or "?")] += 1; looking_days[day] += 1
            if k == "said" and "come on by themselves" in str(e.get("text", "")):
                comeon[day] += 1
            if k == "autoAttach":
                p = e.get("plan") or {}
                auto[(bool(p.get("best")), str(p.get("reason") or e.get("reason") or p.get("secondReason") or "")[:60])] += 1
            if k == "align":
                a = e.get("answer"); align_ans[str(a.get("answer") if isinstance(a, dict) else a)[:40]] += 1
            if k == "warmNext":
                warm[str(e.get("reason") or e.get("outcome") or e.get("declined") or "")[:60]] += 1
            if k == "panel":
                panel_sizes.append(len(line))
    tot = sum(size.values())
    print("total bytes", tot)
    print("== bytes by kind"); [print(f"{size[k]:10d} {100*size[k]/tot:5.1f}% {cnt[k]:6d} {k} avg {size[k]//max(cnt[k],1)}") for k in sorted(size, key=lambda k: -size[k])[:14]]
    print("\n== perf (attached, role, panel)"); [print(c, k) for k, c in perf_attached.most_common()]
    print("\n== perf hosts"); [print(c, k) for k, c in perf_host.most_common(15)]
    print("\n== error files"); [print(c, k) for k, c in err_file.most_common(10)]
    print("\n== 'Looking for' by host", looking.most_common(10)); print("by day", sorted(looking_days.items()))
    print("\n== 'come on by themselves' by day", sorted(comeon.items()))
    print("\n== autoAttach (hasBest, reason)"); [print(c, k) for k, c in auto.most_common(20)]
    print("\n== align answers", align_ans.most_common())
    print("\n== warmNext", warm.most_common(10))
    print("\n== panel entry sizes: n", len(panel_sizes), "max", max(panel_sizes or [0]), "avg", sum(panel_sizes)//max(len(panel_sizes),1))


if PASS in ("all", "lines"):
    pass_one()
if PASS in ("all", "kinds"):
    print("\n" + "=" * 72 + "\n")
    pass_two()
