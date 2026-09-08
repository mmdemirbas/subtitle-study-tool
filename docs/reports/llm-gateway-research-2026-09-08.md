# One endpoint, many models: what exists, and what this repo would actually gain

8 September 2026. Research only - nothing here was implemented.

## The question

The ask, in the words it was asked in: stop hard-coding a specific LLM into
every project. Define *a service* - one endpoint the clients point at - so the
backend model can move between something running on this Mac and something
running in a data centre without any client changing. Reuse the same pattern in
the other projects. Does that already exist, or does it have to be written?

The workload that has to survive the answer is concrete: take a ~1000-line
English `.srt`, translate the whole file to Turkish in one pre-processing pass
at the start of an episode, at a quality the current machine translation does
not reach, and return in the same pass a list of words, phrases and idioms worth
studying.

Two things are worth saying before anything else, because they change what the
rest of the document is for.

**The client side of this is already built.** `subtitle-daemon` does not
hard-code a model. `lookups.py` sends the OpenAI chat-completions shape to a URL
that comes from config, with a model name that comes from config and an optional
bearer key that comes from config:

- `DEFAULT_GLOSS_URL = "http://127.0.0.1:11434/v1/chat/completions"`
  (`lookups.py:137`)
- `gloss_model` / `gloss_url` / `gloss_api_key` in `Config`, overridable by
  `GLOSS_MODEL` / `GLOSS_URL` / `GLOSS_API_KEY` (`config.py`)
- the request body carries `model`, `messages`, `temperature: 0`,
  `response_format: {"type": "json_object"}` and
  `chat_template_kwargs: {"enable_thinking": false}`; the key, when present,
  goes on as `Authorization: Bearer` (`lookups.py:875-921`)

So the question is not "how do we stop hard-coding a model". It is "what goes at
the other end of that URL so that one URL can reach both a local model and a
cloud model".

**The measurements below were taken on this machine today**, not recalled:
MacBook Pro, Apple M1 Max, 64 GB, ollama 0.33.2, against the 1154-cue
`Battlestar.Galactica.Miniseries.S00E01` English `.srt` already in the repo.

---

## What the standard actually is, in 2026

There are three wire formats in circulation, not one, and the ranking between
them is not what it was two years ago.

**1. OpenAI `/v1/chat/completions` is what everything speaks.** Every candidate
surveyed below exposes it, including the two local runtimes and all four hosted
routers. Cloudflare's page for its unified endpoint states the reason plainly:
it "offers an OpenAI-compatible `/chat/completions` endpoint, enabling
integration with multiple AI providers using a single URL"
([developers.cloudflare.com/ai-gateway/usage/chat-completion](https://developers.cloudflare.com/ai-gateway/usage/chat-completion/)).
Anthropic ships a compatibility layer for it on its own API
([platform.claude.com/docs/en/api/openai-sdk](https://platform.claude.com/docs/en/api/openai-sdk)).
This is the format the daemon already sends.

**2. The OpenAI Responses API has reached the local runtimes.** Ollama lists
`/v1/responses` among its OpenAI-compatible endpoints
([docs.ollama.com/openai](https://docs.ollama.com/openai)), LM Studio lists
`POST /v1/responses`
([lmstudio.ai/docs/app/api/endpoints/openai](https://lmstudio.ai/docs/app/api/endpoints/openai)),
and llama.cpp's server documents `/v1/responses` with a worked example
([llama.cpp `tools/server/README.md`](https://github.com/ggml-org/llama.cpp/blob/master/tools/server/README.md)).
It is spreading, but it has not replaced chat-completions anywhere in this
survey - every runtime that has Responses also still has chat-completions.

**3. Anthropic's Messages API is being implemented as a second target by
gateways and runtimes.** LiteLLM's proxy documents itself as
"Anthropic-compatible: `/messages`"
([docs.litellm.ai/docs/proxy/user_keys](https://docs.litellm.ai/docs/proxy/user_keys)),
and LM Studio's developer docs index carries an "Anthropic Compatibility -
Messages API endpoints" section
([lmstudio.ai/docs/developer](https://lmstudio.ai/docs/developer)).

**What this means for the decision:** chat-completions is the format with the
widest support and the one the daemon already emits, so nothing has displaced
it for this use. The caveat that matters is not the format, it is *how much of
the format* a given endpoint honours - see "Structured output" below, where
Anthropic's own compatibility layer ignores exactly the field this repo depends
on.

---

## The option space, enumerated before any of it is scored

Six shapes of answer exist. Listing all six first, so the comparison is not
built around a conclusion:

1. **Do nothing new.** Keep pointing `GLOSS_URL` at one endpoint and change the
   three config values by hand when the backend changes.
2. **A local runtime that also reaches hosted models** - Ollama, LM Studio.
3. **A self-hosted router** - LiteLLM Proxy, Portkey Gateway.
4. **A hosted router** - OpenRouter, Cloudflare AI Gateway, Vercel AI Gateway,
   Helicone AI Gateway.
5. **A local serving engine only, with no routing** - llama.cpp server, vLLM.
6. **Write a small shim in this repo** - a table of named services in
   `config.local.json`, resolved by the daemon.

### The axes, and why these

- **Both local and cloud from one endpoint.** This is the literal request. An
  option that reaches only one side does not answer it.
- **Works with the request the daemon already sends**, unchanged:
  `response_format: {"type": "json_object"}`, `temperature: 0`, bearer key.
  Anything that needs the daemon rewritten is a bigger change than it looks.
- **JSON-schema-level structured output.** The pass has to return per-line
  translations *and* a study list in one response. `json_object` gets JSON;
  a schema is what keeps the array lengths honest, and this repo has already
  been burned by a short array (`lookups.py:946` - a short array pairs every
  gloss after the gap with the wrong word).
- **What has to be installed and kept running.** `subtitle-daemon` is
  stdlib-only. A dependency tree or a container is a real cost here, not a
  rounding error.
- **Where the subtitle file goes.** The existing comment at `lookups.py:132`
  makes the position explicit: "a subtitle file is exactly the kind of thing
  worth not sending anywhere."
- **Behaviour when a backend is down**, since the daemon already implements its
  own fall-through to Google and then the archive.
- **License and operator**, because the pattern is meant to be reused in other
  projects, some of which are not this one's threat model.

Cost and latency are handled separately, in their own section, because they are
properties of the *model* chosen rather than of the endpoint that reaches it.

---

## The candidates

"Local + cloud from one URL" is the first column because it is the question.

| Candidate | Local + cloud from one URL | Config | Auth | Streaming | Structured output | Install | License / operator |
|---|---|---|---|---|---|---|---|
| **Ollama** | **Yes** - run-verified below; local models and `*-cloud` models answer on the same `127.0.0.1:11434/v1` | model name only | key "required but ignored" locally ([docs](https://docs.ollama.com/openai)); `OLLAMA_API_KEY` bearer for the hosted host | yes (`stream`) | `response_format` listed as a supported field ([docs](https://docs.ollama.com/openai)) | already installed here | MIT, self-run; cloud side operated by Ollama |
| **LM Studio** | Local yes; hosted models not documented - see the recommendation | GUI + `lms` CLI | server auth page exists | yes | `response_format` with `type: "json_schema"`, `strict`, `schema`; GGUF via llama.cpp grammars, MLX via Outlines ([docs](https://lmstudio.ai/docs/app/api/structured-output)) | app, or `llmster` daemon via `curl -fsSL https://lmstudio.ai/install.sh` ([docs](https://lmstudio.ai/docs/developer)) | proprietary app, self-run |
| **LiteLLM Proxy** | **Yes** - one `model_list` holds `openai/…`, `azure/…` and `ollama/mistral` with `api_base` side by side ([docs](https://docs.litellm.ai/docs/proxy/configs)) | `config.yaml`; named aliases per entry | `LITELLM_MASTER_KEY`; virtual keys need a database ([docs](https://docs.litellm.ai/docs/proxy/docker_quick_start)) | yes | `response_format: {type: "json_schema", …, strict: true}` documented as working for OpenAI, Azure, xAI, Google AI Studio, Vertex, Bedrock, **Anthropic**, Groq, **Ollama**, Databricks ([docs](https://docs.litellm.ai/docs/completion/json_mode)) | Docker container on :4000, or the Python package | MIT outside `enterprise/`, which has its own license ([LICENSE](https://github.com/BerriAI/litellm/blob/main/LICENSE)) |
| **OpenRouter** | Cloud only | model string `provider/model` | bearer | yes | `response_format: {type: "json_schema", strict: true}` ([docs](https://openrouter.ai/docs/features/structured-outputs)) | nothing | hosted; "passes through the pricing of the underlying providers" ([FAQ](https://openrouter.ai/docs/faq)); BYOK costs "5% of what the same model/provider would cost normally", free below a plan allowance ([BYOK docs](https://openrouter.ai/docs/use-cases/byok)) |
| **Cloudflare AI Gateway** | Cloud only (its own Workers AI + third parties) | model string `provider/model` | `Authorization` for the provider + `cf-aig-authorization` | yes | pass-through | nothing | hosted. **The Universal Endpoint is marked Deprecated** ([docs](https://developers.cloudflare.com/ai-gateway/usage/universal/)); `/compat/chat/completions` is "deprecated for single-model calls" in favour of `api.cloudflare.com/client/v4/accounts/{id}/ai/v1/chat/completions`, but is still **required for dynamic routing** ([docs](https://developers.cloudflare.com/ai-gateway/usage/chat-completion/)) |
| **Vercel AI Gateway** | Cloud only | model string `provider/model` | `Authorization: Bearer $AI_GATEWAY_API_KEY` | yes | pass-through | nothing | hosted; `https://ai-gateway.vercel.sh/v1/chat/completions` ([docs](https://vercel.com/docs/ai-gateway)) |
| **Portkey Gateway** | Cloud, plus self-hosting | JSON config | bearer | yes | pass-through | npm or Docker | open source; "1600+ language, vision, audio, and image models"; a 2.0 pre-release is merging the enterprise core into open source ([README](https://github.com/Portkey-AI/gateway)) |
| **Helicone AI Gateway** | Cloud only | model string | `HELICONE_API_KEY` | yes | pass-through | nothing | hosted at `https://ai-gateway.helicone.ai`, "100+ models … with automatic logging, observability, and fallbacks" ([docs](https://docs.helicone.ai/getting-started/quick-start)) |
| **llama.cpp server** | Local only | CLI flags; `--alias` renames the model id | optional API key | yes | `response_format` takes `{"type":"json_object"}` **and** a `schema`, enforced by grammar-based sampling ([README](https://github.com/ggml-org/llama.cpp/blob/master/tools/server/README.md)) | one binary | MIT, self-run |
| **vLLM** | Local only | CLI | optional | yes | yes | **experimental on macOS**: "users must build from source to natively run on macOS", FP32/FP16 only, CI-smoke-tested; Metal acceleration is a separate community plugin, `vllm-metal` ([docs](https://docs.vllm.ai/en/latest/getting_started/installation/cpu.html)) | Apache-2.0, self-run |

### The Ollama result, verified rather than assumed

The guess in the original question - that Ollama might already do this - is
correct, and it is the single fact in this document most likely to change what
gets built.

Run today against the daemon's own default URL, with no prior `ollama pull`:

```
POST http://127.0.0.1:11434/v1/chat/completions
{"model":"gpt-oss:120b-cloud", "messages":[{"role":"user","content":"hi"}], "max_tokens":5}
→ 200, {"model":"gpt-oss:120b", ..., "usage":{"prompt_tokens":68,...}}
```

`gpt-oss:120b-cloud` is not in `ollama list` on this machine. The local server
answered anyway, which means the model ran on Ollama's side and came back
through the same loopback endpoint. That matches the documented intent - cloud
models are "automatically offloaded to Ollama's cloud service … making it
possible to keep using your local tools while running larger models"
([docs.ollama.com/cloud](https://docs.ollama.com/cloud)).

Three limits on that, all documented:

- The cloud catalogue is open-weight models. Claude and Gemini are not in it.
- Models are retired on a published schedule; the docs already list
  `minimax-m2.5` and `kimi…` retiring 31 July 2026, and warn that "tools and
  applications relying on Ollama Cloud models may need to be updated to keep
  working" ([docs](https://docs.ollama.com/cloud)).
- A subtitle file sent to a `-cloud` model leaves the machine. Ollama documents
  a local-only mode that disables cloud features
  ([FAQ](https://docs.ollama.com/faq)), which is the switch to know about if
  that matters for a given film.

---

## Structured output, since the pass has to return two things at once

The pass must return per-line translations **and** a study list in one response,
and the daemon already rejects an answer whose array length does not match the
question. So schema-level enforcement is the difference between a contract and a
hope.

| Endpoint | `json_object` | `json_schema` |
|---|---|---|
| llama.cpp server | yes | yes, grammar-enforced ([README](https://github.com/ggml-org/llama.cpp/blob/master/tools/server/README.md)) |
| LM Studio | yes | yes; llama.cpp grammars for GGUF, Outlines for MLX. Documented caveat: "Not all models are capable of structured output, particularly LLMs below 7B parameters" ([docs](https://lmstudio.ai/docs/app/api/structured-output)) |
| Ollama | `response_format` listed as supported ([docs](https://docs.ollama.com/openai)) | not separately documented on that page - unverified |
| LiteLLM Proxy | yes | yes, with a named provider list including Anthropic and Ollama ([docs](https://docs.litellm.ai/docs/completion/json_mode)) |
| OpenRouter | yes | yes, `strict: true` ([docs](https://openrouter.ai/docs/features/structured-outputs)) |
| **Anthropic's OpenAI-compat layer** | **no** | **no** |

That last row is the one to read twice, because it is the collision between
this repo's existing request and the model most likely to meet the quality bar.
Anthropic documents `response_format` as **"Ignored. For JSON output, use
Structured Outputs with the native Claude API"**, and `strict` on tool functions
likewise as **"Ignored"**
([platform.claude.com/docs/en/api/openai-sdk](https://platform.claude.com/docs/en/api/openai-sdk)).
The same page frames the whole layer as "primarily intended to test and compare
model capabilities, and is not considered a long-term or production-ready
solution for most use cases." Pointing `GLOSS_URL` straight at
`https://api.anthropic.com/v1/` would therefore silently drop the field the
daemon's JSON contract rests on - it would not error, it would just stop being
enforced. Also ignored on that path: `seed`, `presence_penalty`,
`frequency_penalty`, `reasoning_effort`; `n` must be exactly 1; prompt caching
is unavailable.

---

## Claude specifically

**The supported programmatic path is the Claude API.** Model ids and prices come
from
[platform.claude.com/docs/en/about-claude/pricing](https://platform.claude.com/docs/en/about-claude/pricing):
Opus 5 `claude-opus-5` at $5/MTok in and $25/MTok out; Sonnet 5
`claude-sonnet-5` at $2/$10; Haiku 4.5 `claude-haiku-4-5` at $1/$5. The Batch
API is a 50% discount on both input and output. One note that affects any token
estimate: "Claude 4.7 and later models … use a newer tokenizer … This tokenizer
produces approximately 30% more tokens for the same text."

**Claude Code can be driven headlessly, and it has real structured output.**
`claude -p` is the documented non-interactive mode; `--output-format json`
returns a payload including `total_cost_usd`, and `--json-schema` with a JSON
Schema puts a validated object in a `structured_output` field. stdin piping
works (`cat build-error.txt | claude -p '…'`), capped at 10 MB
([code.claude.com/docs/en/headless](https://code.claude.com/docs/en/headless)).
For a one-off "translate this file well, right now", that is a genuinely usable
tool today with nothing to build.

**As a *backend* for the daemon it has documented properties that argue against
it**, all from the same page:

- It is an agent, not a completion endpoint. Without `--bare` a `-p` session
  "loads the same context an interactive session would", including hooks, MCP
  servers, skills, plugins and `CLAUDE.md` from the working directory - and it
  does so "even in a folder you've never trusted", with no trust dialog.
- `--bare` fixes that but changes the billing: "bare mode doesn't use your
  subscription login", so `ANTHROPIC_API_KEY` must be set. The subscription
  does not carry the batch job.
- Cost figures reported are "client-side estimates" and "can differ from your
  actual bill" ([costs](https://code.claude.com/docs/en/costs)).
- Agent-loop latency is unbounded by design - the docs discuss a ten-minute
  idle ceiling on background work as the safety net.

So: appropriate as a hand-run tool while the prompt is being designed;
a poor fit as the thing a daemon calls once per episode, because it buys the
API's cost without the API's determinism. Rate limits on the API path itself are
per-organisation and tiered, reported back in
`anthropic-ratelimit-*` response headers
([rate limits](https://platform.claude.com/docs/en/api/rate-limits)); the exact
tier this account sits in was not checked.

---

## Cost and latency for the actual workload

### Token shape

Measured on the real file: 50 subtitle lines plus the system prompt tokenised to
610 prompt tokens, and a 48-line Turkish answer to 654 completion tokens (both
from ollama's `usage`, so a different tokenizer than Anthropic's or Google's).
Scaled to the file's 1154 cues that is roughly **13k input / 16k output**, before
the study list. Adding the word/phrase/idiom list, and allowing for Claude's
newer tokenizer, the planning figure below is **15k input / 25k output**. That is
an estimate built on a measured anchor, not a measurement.

### Cloud cost per episode, at list prices

Arithmetic shown so it can be re-run with a different token shape.

| Model | Standard | Batch |
|---|---|---|
| Claude Opus 5 | 0.015×$5 + 0.025×$25 = **$0.70** | **$0.35** |
| Claude Sonnet 5 | 0.015×$2 + 0.025×$10 = **$0.28** | **$0.14** |
| Claude Haiku 4.5 | 0.015×$1 + 0.025×$5 = **$0.14** | **$0.07** |
| Gemini 3.8 Flash | 0.013×$0.75 + 0.020×$3.75 = **$0.085** | **$0.043** |
| Gemini 3.5 Flash-Lite | 0.013×$0.30 + 0.020×$2.50 = **$0.054** | **$0.027** |

Claude prices: [platform.claude.com/docs/en/about-claude/pricing](https://platform.claude.com/docs/en/about-claude/pricing).
Gemini prices: [ai.google.dev/gemini-api/docs/pricing](https://ai.google.dev/gemini-api/docs/pricing)
(Gemini 3.8 Flash at $0.75/$3.75 standard and $0.375/$1.875 batch, both marked
"through Dec 31, 2026"; Gemini 3.5 Flash-Lite at $0.30/$2.50). A ten-episode
season is therefore about **$7 on Opus 5, $2.80 on Sonnet 5, $0.85 on Gemini 3.8
Flash**, and about half those on the batch endpoints. Routing through OpenRouter
does not change the model price - it "passes through the pricing of the
underlying providers" - but credit top-ups carry a platform fee and BYOK carries
5% above a per-plan free allowance
([BYOK docs](https://openrouter.ai/docs/use-cases/byok)).

### Cloud latency - estimate, not measured

No cloud key was exercised for this document. The pass is output-bound at
20-30k tokens; at a typical large-model output rate a single sequential request
lands in the **5-12 minute** range, and splitting the file into ~12 concurrent
100-line chunks reduces it to the slowest chunk, in the **40-90 second** range.
Both are estimates. The Batch API trades latency for the 50% discount and is the
natural fit for a pre-processing pass that runs before the episode starts.

### Local latency on this Mac - measured today

Same file, same daemon-shaped request (`temperature: 0`,
`response_format: json_object`), against `127.0.0.1:11434`:

| model | lines in | lines back | wall clock | s/line |
|---|---|---|---|---|
| `gemma3:4b` (3.3 GB) | 25 | 24 | 11.1s | 0.44 |
| `gemma3:4b` | 50 | **33** | 7.6s | 0.15 |
| `translategemma:4b` (3.3 GB) | 50 | 48 | 13.8s | 0.28 |
| `qwen3.6:35b-a3b` (22 GB MoE) | 50 (cold) | 50 | 342.8s | 6.86 |
| `qwen3.6:35b-a3b` | 50 (warm) | 50 | 354.0s | 7.08 |
| `qwen3.6:35b-a3b` | 100 (warm) | 100 | 443.2s | 4.43 |

Two things that table says. First, the fast small models **break the contract**:
`gemma3:4b` returned 33 translations for 50 lines and 24 for 25, and the daemon
already treats a short array as worse than no answer. Second, the model that
holds the contract is the 22 GB one, and extrapolating its 100-line rate to the
whole 1154-cue file gives roughly **85 minutes** for one episode - an
extrapolation from measurement, not a measured full run.

Quality is a separate axis and this repo has already measured it: on the
thirteen-word bake-off in
`docs/reports/which-model-glosses-2026-09-06.md`, `qwen3.6:35b-a3b` scored
10/13 accepted and 4/6 contextual, `qwen3:14b` 6/13, `translategemma:4b` 3/13,
`gemma3:4b` 2/13. The local option that is fast enough is the one that is not
accurate enough, and vice versa.

**vLLM does not change this picture on this hardware.** Its own docs call macOS
support experimental, source-build-only, FP32/FP16, with Metal acceleration
living in a separate community plugin
([docs](https://docs.vllm.ai/en/latest/getting_started/installation/cpu.html)).

---

## What actually matters for this repo

- **The client contract is not the problem and should not be reopened.** The
  daemon sends the format everything speaks, to a configurable URL, with a
  configurable model and key. Changing that costs work and buys nothing.
- **The one thing missing is plurality.** There is one URL, not a table of named
  services, so switching backends means editing config rather than naming a
  different service. That is a small gap, and it is exactly the gap a router
  fills.
- **`response_format` is load-bearing here**, which rules out the most obvious
  direct route to Claude and makes "does this endpoint honour the field, or
  quietly drop it" the sharpest question to ask of any candidate.
- **The privacy comment at `lookups.py:132` is a design decision, not a
  preference.** Any recommendation that sends whole subtitle files out has to
  say so, and the local-only escape hatch has to stay reachable.
- **Nothing here needs streaming.** The pass is a batch job before playback.
  That removes a column most gateway comparisons weight heavily.
- **The daemon is stdlib-only.** A Docker container next to it is a bigger
  change to how this project is run than the size of its config file suggests.

---

## Recommendation

Stated as a recommendation, separate from the evidence above.

**1. Keep the client contract exactly as it is.** OpenAI chat-completions, one
base URL, one model string, one bearer key. It is the interoperable shape, and
it is already implemented.

**2. For the reusable cross-project "define a service" pattern, LiteLLM Proxy is
the closest match to what was described.** One `config.yaml` holds named
aliases, each pointing at a different provider - including
`model: ollama/mistral` with an `api_base` beside cloud entries in the same list
- and clients address the alias, never the provider. It is MIT outside
`enterprise/`, it speaks chat-completions *and* Anthropic `/messages`, and it
documents `json_schema` pass-through for Anthropic and Ollama among others. The
cost is a container on :4000 and a YAML file per machine. One documented trap to
respect if it is adopted: without a database, `litellm_settings.max_budget` "is
not a spend cap … the proxy keeps serving requests past $100 with no
per-request error", and virtual keys do not work at all
([docs](https://docs.litellm.ai/docs/proxy/docker_quick_start)).

**3. For this repo today, there is a smaller step that needs no new service.**
Ollama is already installed, already the default URL, and - verified by running
it - already routes `*-cloud` model names out to hosted hardware through the
same loopback endpoint. Setting `gloss_model` to a cloud model name is a config
change with no code change, and it lifts the ceiling from what fits in 64 GB to
what Ollama hosts. It does not reach Claude or Gemini, and it does send the text
off-machine.

**4. If the quality bar turns out to be Claude, do not point `GLOSS_URL` at
`api.anthropic.com`.** `response_format` is documented as ignored there. Either
put a translating router in front of it, or give the pre-pass its own native
Messages-API path with Structured Outputs and leave the gloss tier on
chat-completions. The second is more code and more determinism.

**5. Use `claude -p --output-format json --json-schema` by hand to find out what
"high quality" looks like before wiring anything.** It is the cheapest way to
see a good answer for this file. Do not make it the daemon's backend, for the
reasons in the Claude section.

**6. Suggested order of work:** run the pre-pass by hand against Sonnet 5 and
Gemini 3.8 Flash on one episode and compare against the current output; only
then decide whether the routing layer is LiteLLM or a fifteen-line service table
in `config.local.json`. At $0.28 and $0.085 an episode, the experiment is
cheaper than the decision.

**Marked unverified, as required:**

- *LM Studio addressing hosted/cloud models through one endpoint* -
  **candidate, needs docs verification.** Its developer docs index lists only
  local serving surfaces, and "LM Link" is documented as using "a model loaded
  on a remote device … from any machine on the same link", which is your own
  hardware, not a hosted provider
  ([docs](https://lmstudio.ai/docs/developer/core/lmlink)). LM Studio was not
  installed and no hosted provider was attempted, so "LM Studio cannot do this"
  is not asserted.
- *Ollama `json_schema` support* - **needs docs verification.** The OpenAI
  compatibility page lists `response_format` as supported without saying which
  variants.
- *Portkey Gateway's license and the 2.0 pre-release status* - **candidate,
  needs docs verification.** Read from the README's badges and banner only; the
  LICENSE file was not opened.
- *Helicone AI Gateway self-hosting* - **candidate, needs docs verification.**
  Only the hosted quickstart was read.
- *Whether today's Ollama cloud call was billed, free-tier, or drawing on a
  prior `ollama signin` on this machine* - not determined.

---

## What it costs to build

| Path | Work | Ongoing |
|---|---|---|
| Change `gloss_model` to an Ollama cloud model | minutes; no code | nothing new to run |
| Named-service table in `config.local.json`, resolved in `config.py` | roughly 30-60 lines plus tests; touches `config.py` and the three fields in `Lookups.__init__` | nothing new to run |
| LiteLLM Proxy in front of everything | a `config.yaml`, a container, and pointing `GLOSS_URL` at `:4000` | a container per machine that runs the daemon |
| Native Anthropic Messages path for the pre-pass | a new code path in `lookups.py` that does not share `_gloss`'s body builder; Structured Outputs schema; its own error handling | an API key |

The middle two are not exclusive. A service table whose values happen to be
LiteLLM aliases is the same table as one whose values are direct provider URLs.

---

## Open questions

1. **What does the study list actually have to contain?** Per-line translation
   plus "words, phrases and idioms" is the spec so far. The schema decides how
   much of this is a prompt problem and how much is a model problem, and it is
   the input to any quality comparison.
2. **Is one request for 1000 lines the right unit at all?** The daemon already
   learned this lesson at word scale - `GLOSS_BATCH = 20`, so "a failure loses
   twenty answers rather than six hundred". A 1000-line single shot has the
   same failure shape, one size larger.
3. **Does the pre-pass replace the gloss tier or sit above it?** If a whole-file
   translation exists on disk, the per-word contextual gloss has a different job
   and possibly a cheaper model.
4. **Which side of the privacy line is a subtitle file on?** The answer changes
   whether the default backend is local, Ollama-cloud, or a frontier API, and it
   is the one question here that is not technical.
5. **Does the Batch API's latency fit the workflow?** A pass that runs when the
   episode is picked, not when play is pressed, would halve the cost.
6. **Anthropic rate-limit tier for this account** - not checked, and it bounds
   how many episodes can be pre-processed in a burst.

---

## Verification log

Everything above is one of: read in the vendor's own documentation (linked
inline), read in this repository's source, or executed on this machine on
8 September 2026. The executed items are: the Ollama cloud-model probe against
`127.0.0.1:11434/v1/chat/completions`; the six local translation timings; and
`ollama list` / `ollama --version` (0.33.2) / `system_profiler` for the machine
description. The `which-model-glosses-2026-09-06.md` figures are quoted from
that report, not re-run. Every cost figure is arithmetic over a published price
list and an estimated token count; every latency figure for a cloud model is an
estimate and is labelled as one.
