# srt_translate.py
#!/usr/bin/env python3
"""
Translate an SRT file with high-quality MT (OpenAI / DeepL / Google v2 / Azure / LibreTranslate).
- Preserves SRT timings and line breaks
- Batching + retry/backoff for robustness
- SQLite cache to avoid re-translation of repeated cues
- Provider-specific options (keys, region/model, endpoint)
- Outputs a .srt in the target language

Usage (examples):
  python srt_translate.py input.srt --provider openai --openai-model gpt-4o-mini --tgt tr --api-key $OPENAI_API_KEY
  python srt_translate.py input.srt --provider deepl --tgt tr --api-key $DEEPL_API_KEY
  python srt_translate.py input.srt --provider google --tgt tr --api-key $GOOGLE_API_KEY
  python srt_translate.py input.srt --provider azure --tgt tr --api-key $AZURE_TRANSLATOR_KEY --azure-region westeurope
  python srt_translate.py input.srt --provider libre --endpoint http://localhost:5000/translate --tgt tr

Helpful flags:
  --batch 25                # how many cues per API call (OpenAI batches multiple items)
  --out out.tr.srt          # custom output path
  --src en --tgt tr         # language codes
  --cache-db .srt_cache.sqlite
  --dry-run                 # just prints first few planned translations
"""

from __future__ import annotations
import argparse, os, re, sys, json, time, sqlite3, textwrap
from typing import List, Dict, Tuple
import requests
from tqdm import tqdm

# ========= SRT parsing / formatting =========

TIME_RE = re.compile(
    r"(?P<h1>\d{1,2}):(?P<m1>\d{2}):(?P<s1>\d{2})(?:[,\.](?P<ms1>\d{1,3}))?\s*-->\s*"
    r"(?P<h2>\d{1,2}):(?P<m2>\d{2}):(?P<s2>\d{2})(?:[,\.](?P<ms2>\d{1,3}))?"
)

def _to_ms(h, m, s, ms):
    return (int(h)*3600 + int(m)*60 + int(s))*1000 + int((ms or "0").ljust(3, "0")[:3])

def parse_srt(text: str) -> List[Dict]:
    blocks = re.split(r"\n\s*\n", text.replace("\r", "").strip())
    cues = []
    for b in blocks:
        lines = [ln for ln in b.split("\n") if ln.strip() != ""]
        if not lines:
            continue
        # Optional numeric index
        i = 0
        if re.fullmatch(r"\d+", lines[0].strip()):
            i = 1
        if i >= len(lines):
            continue
        m = TIME_RE.search(lines[i])
        if not m:
            continue
        start = _to_ms(m["h1"], m["m1"], m["s1"], m["ms1"])
        end   = _to_ms(m["h2"], m["m2"], m["s2"], m["ms2"])
        body_lines = lines[i+1:]
        body = "\n".join(body_lines)
        cues.append({"start": start, "end": end, "text": body})
    return cues

def _fmt_time(ms: int) -> str:
    h = ms // 3600000
    ms2 = ms % 3600000
    m = ms2 // 60000
    ms3 = ms2 % 60000
    s = ms3 // 1000
    ms4 = ms3 % 1000
    return f"{h:02}:{m:02}:{s:02},{ms4:03}"

def format_srt(cues: List[Dict]) -> str:
    out = []
    for i, c in enumerate(cues, 1):
        out.append(f"{i}")
        out.append(f"{_fmt_time(c['start'])} --> {_fmt_time(c['end'])}")
        out.append(c["text"])
        out.append("")  # blank line
    return "\n".join(out)

# ========= SQLite cache =========

def cache_init(db_path: str):
    conn = sqlite3.connect(db_path)
    conn.execute("""
        CREATE TABLE IF NOT EXISTS cache (
          provider TEXT NOT NULL,
          model    TEXT NOT NULL,
          src      TEXT NOT NULL,
          tgt      TEXT NOT NULL,
          text     TEXT NOT NULL,
          trans    TEXT NOT NULL,
          PRIMARY KEY (provider, model, src, tgt, text)
        )
    """)
    conn.commit()
    return conn

def cache_get_many(conn, provider: str, model: str, src: str, tgt: str, texts: List[str]) -> Dict[str, str]:
    if not texts:
        return {}
    qmarks = ",".join("?" for _ in texts)
    cur = conn.execute(
        f"SELECT text, trans FROM cache WHERE provider=? AND model=? AND src=? AND tgt=? AND text IN ({qmarks})",
        (provider, model, src, tgt, *texts)
    )
    return {row[0]: row[1] for row in cur.fetchall()}

def cache_put_many(conn, provider: str, model: str, src: str, tgt: str, pairs: List[Tuple[str, str]]):
    if not pairs:
        return
    conn.executemany(
        "INSERT OR REPLACE INTO cache(provider, model, src, tgt, text, trans) VALUES (?,?,?,?,?,?)",
        [(provider, model, src, tgt, t, tr) for (t, tr) in pairs]
    )
    conn.commit()

# ========= Providers =========

class ProviderError(Exception):
    pass

def _backoff_sleep(attempt: int):
    # Exponential backoff with jitter
    time.sleep(min(20, (2 ** attempt)) + (0.1 * attempt))

def _chunk(lst: List[str], n: int):
    for i in range(0, len(lst), n):
        yield lst[i:i+n]

def translate_libre(endpoint: str, items: List[str], src: str, tgt: str, timeout=30) -> List[str]:
    out = []
    for t in items:
        data = {"q": t, "source": src, "target": tgt, "format": "text"}
        r = requests.post(endpoint, data=data, timeout=timeout)
        if r.status_code >= 400:
            raise ProviderError(f"LibreTranslate HTTP {r.status_code} {r.text[:200]}")
        j = r.json()
        if isinstance(j, list) and j and "translatedText" in j[0]:
            out.append(j[0]["translatedText"])
        elif isinstance(j, dict) and "translatedText" in j:
            out.append(j["translatedText"])
        elif isinstance(j, dict) and "result" in j:
            out.append(j["result"])
        else:
            raise ProviderError("LibreTranslate unexpected response")
    return out

def translate_deepl(endpoint: str, api_key: str, items: List[str], src: str, tgt: str, timeout=30) -> List[str]:
    # Preserve formatting & treat tags as XML/HTML where possible
    out = []
    for t in items:
        data = {
            "text": t,
            "source_lang": src.upper(),
            "target_lang": tgt.upper(),
            "preserve_formatting": "1",          # keep line breaks
            "split_sentences": "nonewlines",     # don't split on newlines
            # "tag_handling": "xml",             # optional: if your cues have <i>..</i>, uncomment
        }
        headers = {"Authorization": f"DeepL-Auth-Key {api_key}"}
        r = requests.post(endpoint, data=data, headers=headers, timeout=timeout)
        if r.status_code >= 400:
            raise ProviderError(f"DeepL HTTP {r.status_code} {r.text[:200]}")
        j = r.json()
        tr = j.get("translations", [{}])[0].get("text")
        if tr is None:
            raise ProviderError("DeepL unexpected response")
        out.append(tr)
    return out

def translate_google_v2(endpoint: str, api_key: str, items: List[str], src: str, tgt: str, timeout=30) -> List[str]:
    # Google v2 supports batching 'q' repeated
    params = {"key": api_key}
    data = [("q", t) for t in items]
    data += [("source", src), ("target", tgt), ("format", "text")]  # or "html" if you want tags handled
    r = requests.post(endpoint, params=params, data=data, timeout=timeout)
    if r.status_code >= 400:
        raise ProviderError(f"Google v2 HTTP {r.status_code} {r.text[:200]}")
    j = r.json()
    trans = j.get("data", {}).get("translations", [])
    if len(trans) != len(items):
        raise ProviderError("Google v2: response length mismatch")
    return [t.get("translatedText", "") for t in trans]

def translate_azure(endpoint: str, api_key: str, region: str, items: List[str], src: str, tgt: str, timeout=30) -> List[str]:
    # Azure supports batching with JSON array
    url = f"{endpoint}&from={src}&to={tgt}&textType=plain"  # change to html if you want tag handling
    body = [{"Text": t} for t in items]
    headers = {
        "Content-Type": "application/json",
        "Ocp-Apim-Subscription-Key": api_key,
        "Ocp-Apim-Subscription-Region": region or "",
    }
    r = requests.post(url, headers=headers, json=body, timeout=timeout)
    if r.status_code >= 400:
        raise ProviderError(f"Azure HTTP {r.status_code} {r.text[:200]}")
    j = r.json()
    out = []
    for entry in j:
        trans = entry.get("translations", [])
        if not trans:
            out.append("")
        else:
            out.append(trans[0].get("text", ""))
    if len(out) != len(items):
        raise ProviderError("Azure: response length mismatch")
    return out

def translate_openai_chat(endpoint: str, api_key: str, model: str, items: List[str], src: str, tgt: str, timeout=60) -> List[str]:
    """
    Batches items into one chat call and forces JSON output.
    """
    # System prompt: keep it strict to avoid explanations
    system = (
        "You are a professional subtitle translator. Translate ONLY the given items from "
        f"{src} to {tgt}. Preserve line breaks and inline tags (<i>, </i>, etc.). "
        "Return strictly a JSON object with key 't' whose value is an array of strings, "
        "one per input item, same order and same length. No extra text."
    )
    user_payload = {"src": src, "tgt": tgt, "items": items}
    headers = {"Authorization": f"Bearer {api_key}", "Content-Type": "application/json"}
    data = {
        "model": model,
        "messages": [
            {"role": "system", "content": system},
            {"role": "user", "content": json.dumps(user_payload, ensure_ascii=False)},
        ],
        "temperature": 1.0, # TODO: gpt-5-nano doesn't support 0.2
        # response_format works on modern OpenAI models; if unsupported, we still try to parse
        "response_format": {"type": "json_object"}
    }
    r = requests.post(endpoint, headers=headers, json=data, timeout=timeout)
    if r.status_code >= 400:
        raise ProviderError(f"OpenAI HTTP {r.status_code} {r.text[:200]}")
    j = r.json()
    try:
        content = j["choices"][0]["message"]["content"]
    except Exception:
        raise ProviderError("OpenAI: unexpected response")
    try:
        parsed = json.loads(content)
        arr = parsed.get("t", [])
        if not isinstance(arr, list) or len(arr) != len(items):
            raise ValueError("bad length")
        return [str(x) for x in arr]
    except Exception:
        # Fallback: treat as single blob -> split heuristically
        # (rarely needed; JSON mode should work on current models)
        return content.split("\n")[:len(items)]

# ========= Orchestration =========

def translate_all(
        provider: str,
        endpoint: str,
        api_key: str,
        openai_model: str,
        azure_region: str,
        src: str,
        tgt: str,
        texts: List[str],
        batch_size: int,
        conn: sqlite3.Connection,
) -> List[str]:
    """Translate list of texts with caching and batching per provider."""
    model_id = {
        "openai": openai_model or "gpt-4o-mini",
        "deepl": "deepl",
        "google": "google-v2",
        "azure": "azure",
        "libre": "libre",
    }.get(provider, "unknown")

    # Load from cache first
    cached = cache_get_many(conn, provider, model_id, src, tgt, texts)
    need_indices = [i for i, t in enumerate(texts) if t not in cached]
    results: List[str] = [""] * len(texts)

    # Put cached in place
    for i, t in enumerate(texts):
        if t in cached:
            results[i] = cached[t]

    if not need_indices:
        return results

    # Unique texts to translate (avoid duplicates within the same run)
    pending_texts = []
    idx_map = {}  # text -> list of indices to fill
    for i in need_indices:
        t = texts[i]
        if t not in idx_map:
            idx_map[t] = []
            pending_texts.append(t)
        idx_map[t].append(i)

    # Process in batches
    pb = tqdm(total=len(pending_texts), desc=f"Translating ({provider})", unit="cue")
    new_cache_pairs: List[Tuple[str, str]] = []

    for chunk in _chunk(pending_texts, batch_size):
        # Retry with backoff on transient errors (429/5xx/timeouts)
        attempt = 0
        while True:
            try:
                if provider == "libre":
                    outs = translate_libre(endpoint, chunk, src, tgt)
                elif provider == "deepl":
                    outs = translate_deepl(endpoint, api_key, chunk, src, tgt)
                elif provider == "google":
                    outs = translate_google_v2(endpoint, api_key, chunk, src, tgt)
                elif provider == "azure":
                    outs = translate_azure(endpoint, api_key, azure_region, chunk, src, tgt)
                elif provider == "openai":
                    outs = translate_openai_chat(endpoint, api_key, openai_model or "gpt-4o-mini", chunk, src, tgt)
                else:
                    raise ProviderError(f"Unknown provider: {provider}")
                if len(outs) != len(chunk):
                    raise ProviderError("Batch length mismatch")
                # Fill outputs
                for t, tr in zip(chunk, outs):
                    for i in idx_map[t]:
                        results[i] = tr
                    new_cache_pairs.append((t, tr))
                pb.update(len(chunk))
                break
            except requests.RequestException as e:
                # network errors -> backoff
                attempt += 1
                if attempt > 5:
                    raise ProviderError(f"Network error after retries: {e}")
                _backoff_sleep(attempt)
            except ProviderError as e:
                # 4xx could be permanent (bad key, quota, etc.) -> raise immediately
                msg = str(e)
                if "HTTP 4" in msg:
                    pb.close()
                    raise
                attempt += 1
                if attempt > 5:
                    pb.close()
                    raise
                _backoff_sleep(attempt)

    pb.close()
    # Write to cache
    cache_put_many(conn, provider, model_id, src, tgt, new_cache_pairs)
    return results

# ========= CLI =========

def guess_out_path(in_path: str, tgt: str) -> str:
    base, ext = os.path.splitext(in_path)
    return f"{base}.{tgt}.srt"

def main():
    ap = argparse.ArgumentParser(
        description="Translate SRT with OpenAI/DeepL/Google/Azure/Libre. Preserves timing and line breaks.",
        formatter_class=argparse.ArgumentDefaultsHelpFormatter,
    )
    ap.add_argument("inp", help="input .srt path")
    ap.add_argument("--out", help="output .srt path (default: input.<tgt>.srt)")
    ap.add_argument("--src", default="en", help="source language code")
    ap.add_argument("--tgt", default="tr", help="target language code")
    ap.add_argument("--provider", choices=["openai", "deepl", "google", "azure", "libre"], default="openai")
    ap.add_argument("--endpoint", default=None, help="override API endpoint (required for libre; optional for others)")
    ap.add_argument("--api-key", default=None, help="API key (or use env vars)")
    ap.add_argument("--openai-model", default="gpt-4o-mini", help="OpenAI model name")
    ap.add_argument("--azure-region", default=None, help="Azure Translator region, e.g., westeurope")
    ap.add_argument("--batch", type=int, default=20, help="batch size (OpenAI batches per request; others may batch/loop)")
    ap.add_argument("--cache-db", default=".srt_cache.sqlite", help="sqlite cache path")
    ap.add_argument("--dry-run", action="store_true", help="show plan and first translations without writing file")
    args = ap.parse_args()

    # Resolve endpoints & keys
    provider = args.provider
    endpoint = args.endpoint
    api_key = args.api_key or os.getenv({
                                            "openai": "OPENAI_API_KEY",
                                            "deepl":  "DEEPL_API_KEY",
                                            "google": "GOOGLE_API_KEY",
                                            "azure":  "AZURE_TRANSLATOR_KEY",
                                            "libre":  "LIBRETRANSLATE_KEY"  # if your instance requires it; otherwise leave blank
                                        }[provider], "")

    default_endpoints = {
        "openai": "https://api.openai.com/v1/chat/completions",
        "deepl":  "https://api-free.deepl.com/v2/translate",
        "google": "https://translation.googleapis.com/language/translate/v2",
        "azure":  "https://api.cognitive.microsofttranslator.com/translate?api-version=3.0",
        "libre":  "http://localhost:5000/translate",
    }
    if endpoint is None:
        endpoint = default_endpoints[provider]

    if provider in ("openai", "deepl", "google", "azure") and not api_key:
        sys.exit(f"[error] --api-key or relevant env var is required for provider '{provider}'")

    if provider == "azure" and not (args.azure_region or os.getenv("AZURE_TRANSLATOR_REGION")):
        sys.exit("[error] --azure-region or AZURE_TRANSLATOR_REGION env var is required for Azure provider")

    azure_region = args.azure_region or os.getenv("AZURE_TRANSLATOR_REGION", "")

    # Load SRT
    with open(args.inp, "r", encoding="utf-8") as f:
        raw = f.read()
    cues = parse_srt(raw)
    if not cues:
        sys.exit("[error] No cues parsed from input SRT")

    texts = [c["text"] for c in cues]

    # Create cache
    conn = cache_init(args.cache_db)

    # Dry-run preview
    if args.dry_run:
        print(f"Provider: {provider} | Endpoint: {endpoint}")
        print(f"Source: {args.src}  Target: {args.tgt}  Batch: {args.batch}")
        print(f"Cues: {len(cues)}  Unique texts: {len(set(texts))}")
        preview = texts[:3]
        print("\n--- Preview (first 3 cues) ---")
        for i, t in enumerate(preview, 1):
            replaced = t.replace('\\n', ' / ')
            print(f"{i}. {replaced}")
        print("\nRun without --dry-run to actually translate.")
        return

    # Translate
    try:
        translated = translate_all(
            provider=provider,
            endpoint=endpoint,
            api_key=api_key,
            openai_model=args.openai_model,
            azure_region=azure_region,
            src=args.src,
            tgt=args.tgt,
            texts=texts,
            batch_size=args.batch,
            conn=conn,
        )
    except ProviderError as e:
        sys.exit(f"[provider-error] {e}")
    except Exception as e:
        sys.exit(f"[fatal] {e}")

    # Build output cues
    out_cues = []
    for c, tr in zip(cues, translated):
        out_cues.append({"start": c["start"], "end": c["end"], "text": tr})

    out_path = args.out or guess_out_path(args.inp, args.tgt)
    with open(out_path, "w", encoding="utf-8") as f:
        f.write(format_srt(out_cues))
    print(f"[ok] Wrote: {out_path}")

if __name__ == "__main__":
    main()
