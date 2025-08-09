# str-translator

A simple command-line tool to translate SRT subtitle files using various translation providers like
OpenAI, DeepL, Google Cloud, Azure, and LibreTranslate.

<!-- TOC -->

* [str-translator](#str-translator)
    * [Quick Start](#quick-start)
        * [Common Flags](#common-flags)
    * [Providers](#providers)
        * [1) OpenAI (Chat Completions)](#1-openai-chat-completions)
        * [2) DeepL API (Free/Pro)](#2-deepl-api-freepro)
        * [3) Google Cloud Translation (v2)](#3-google-cloud-translation-v2)
        * [4) Azure Translator](#4-azure-translator)
        * [5) LibreTranslate (Self-hosted or Public)](#5-libretranslate-self-hosted-or-public)
    * [Tips](#tips)
    * [Examples](#examples)

<!-- TOC -->

## Quick Start

```bash
python3 -m venv .venv && source .venv/bin/activate
pip install -r requirements.txt

# Basic usage (English -> Turkish, OpenAI)
python srt_translate.py input.srt --provider openai --openai-model gpt-4o-mini --tgt tr --api-key $OPENAI_API_KEY

````

### Common Flags

* `--src en --tgt tr`  Language codes.
* `--batch 20`         Batch size per API call (OpenAI batches; others may loop).
* `--out out.tr.srt`   Output path (default: `input.<tgt>.srt`).
* `--cache-db .srt_cache.sqlite`  SQLite cache (dedupes repeated cues).
* `--dry-run`          Show plan/preview only.

---

## Providers

### 1) OpenAI (Chat Completions)

High quality; preserves style well.

**Setup**

1. Get an API key from OpenAI and export it:

   ```bash
   export OPENAI_API_KEY=sk-...
   ```
2. (Optional) Pick a model (e.g., `gpt-4o-mini`).

**Run**

```bash
python srt_translate.py input.srt \
  --provider openai \
  --openai-model gpt-4o-mini \
  --tgt tr \
  --api-key $OPENAI_API_KEY \
  --batch 20
```

**Notes**

* Increase `--batch` to reduce requests; decrease if responses get too large.
* If you use a non-default endpoint, pass `--endpoint`.

---

### 2) DeepL API (Free/Pro)

Strong EN↔TR quality; good with punctuation and brevity.

**Setup**

1. Create a DeepL API (Free or Pro) key:

   ```bash
   export DEEPL_API_KEY=...
   ```
2. Endpoint:

* Free: `https://api-free.deepl.com/v2/translate`
* Pro:  `https://api.deepl.com/v2/translate`

**Run**

```bash
python srt_translate.py input.srt \
  --provider deepl \
  --tgt tr \
  --api-key $DEEPL_API_KEY \
  --endpoint https://api-free.deepl.com/v2/translate
```

**Notes**

* The script sets `preserve_formatting=1` and avoids splitting on newlines.
* If your SRT has `<i>…</i>` tags, DeepL handles them well; you can switch to HTML/XMl handling in
  code if needed.

---

### 3) Google Cloud Translation (v2)

Reliable and scalable; requires a GCP project with billing enabled.

**Setup**

1. Enable **Cloud Translation API** in your GCP project.
2. Create an API key and export:

   ```bash
   export GOOGLE_API_KEY=...
   ```
3. Default endpoint: `https://translation.googleapis.com/language/translate/v2`

**Run**

```bash
python srt_translate.py input.srt \
  --provider google \
  --tgt tr \
  --api-key $GOOGLE_API_KEY
```

**Notes**

* v2 API uses the key in the query string; restrict the key in GCP.
* Batching is supported in one request; script maps responses back to cues.

---

### 4) Azure Translator

Good quality; fast. **Region is required** with the key.

**Setup**

1. Create an **Azure Translator** resource (get **key** and **region**).

   ```bash
   export AZURE_TRANSLATOR_KEY=...
   export AZURE_TRANSLATOR_REGION=westeurope   # example
   ```
2. Endpoint (default):
   `https://api.cognitive.microsofttranslator.com/translate?api-version=3.0`

**Run**

```bash
python srt_translate.py input.srt \
  --provider azure \
  --tgt tr \
  --api-key $AZURE_TRANSLATOR_KEY \
  --azure-region $AZURE_TRANSLATOR_REGION
```

**Notes**

* The script posts JSON arrays (batched) and preserves line breaks.

---

### 5) LibreTranslate (Self-hosted or Public)

Free if self-hosted; quality varies but useful as a fallback.

**Setup (self-host)**

```bash
docker run --rm -p 5000:5000 libretranslate/libretranslate
# endpoint will be: http://localhost:5000/translate
```

**Run**

```bash
python srt_translate.py input.srt \
  --provider libre \
  --endpoint http://localhost:5000/translate \
  --tgt tr
```

**Notes**

* Some public instances rate-limit or block automated requests; self-hosting is recommended.

---

## Tips

* **Quality order (typical)**: OpenAI ≈ DeepL ≥ Azure ≥ Google >> Libre (varies by content).
* **Caching**: Repeated lines (e.g., “Thank you.”) are cached in `.srt_cache.sqlite` to save time
  and quota.
* **Rate limits / 4xx**:

    * `401/403`: invalid key / wrong endpoint / missing region (Azure).
    * `429`: too many requests → lower `--batch`; the script retries with backoff.
* **Languages**: Use `--src` and `--tgt` ISO codes (`en`, `tr`, …).
* **Output**: Timings and line breaks are preserved exactly; result is standard `.srt`.

## Examples

```bash
# OpenAI, EN -> TR, default batch 20
python srt_translate.py movie.en.srt --provider openai --openai-model gpt-4o-mini --tgt tr --api-key $OPENAI_API_KEY

# DeepL Free
python srt_translate.py movie.en.srt --provider deepl --tgt tr --api-key $DEEPL_API_KEY --endpoint https://api-free.deepl.com/v2/translate

# Google v2
python srt_translate.py movie.en.srt --provider google --tgt tr --api-key $GOOGLE_API_KEY

# Azure
python srt_translate.py movie.en.srt --provider azure --tgt tr --api-key $AZURE_TRANSLATOR_KEY --azure-region westeurope

# LibreTranslate (local)
python srt_translate.py movie.en.srt --provider libre --endpoint http://localhost:5000/translate --tgt tr
```
