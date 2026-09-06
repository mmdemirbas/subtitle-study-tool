# Which model glosses the words, and what it costs the machine

6 September 2026. Reported together: "your model choice is too big. nothing else
can run in this computer when you run that much big models", and "the
translations are late and not accurate."

They turned out to be two separate faults. This covers the model; the other one
is in `065fb28` and is summarised at the bottom because it is the larger half of
why the translations were bad.

## What each candidate measured

`subtitle-daemon/tools/gloss_bakeoff.py`, thirteen words with their subtitle
lines and their neighbours, six of them words whose meaning is decided by the
line they are in. Every candidate answers through the daemon's own `_gloss`, so
what is measured is the request the daemon really sends, including the strict
JSON contract. Accepted means it matched a short list of acceptable Turkish
forms written before any model ran.

| model | size | load | 13 words warm | a word | accepted | contextual |
|---|---|---|---|---|---|---|
| phi4-mini | 2.5 GB | 11s | 3s | 0.2s | 0/13 | 0/6 |
| gemma3:4b | 3.3 GB | 8s | 4s | 0.3s | 2/13 | 0/6 |
| qwen3:4b | 2.5 GB | 107s | 392s | 30.1s | 4/13 | 1/6 |
| qwen3:14b | 9.3 GB | 49s | 434s | 33.4s | 6/13 | 3/6 |
| qwen3.6:35b-a3b | 22.6 GB | 133s | 283s | 21.8s | 10/13 | 4/6 |
| qwen2.5vl:7b | 6.0 GB | - | - | - | broke the contract | - |

Google Translate, for comparison, answers a bare word in 0.23 seconds and holds
no memory on this machine at all.

Three things in that table are worth reading twice.

**phi4-mini does not translate.** It handed every English word back unchanged.
Fast and useless.

**gemma3:4b is 70 times faster than the big one and gets the meanings wrong.**
"asparagus" came back "brüksel mantarı", which is not a thing; "Paige" came back
"Paige geliyor" where a proper noun must come back empty; "shotgun" shouted at a
departing car came back as the gun. Its speed is real and so is its unsuitability.

**The 14B dense model is slower than the 35B.** The big one is a mixture of
experts with about 3B parameters active per token, so file size is not the thing
that predicts speed here.

## Why the qwen3 models are so slow

Not size. Measured on a one-item request:

| request | prompt tokens | output tokens | time |
|---|---|---|---|
| gemma3:4b, the daemon's shape | 242 | 18 | 2.1s |
| qwen3:4b, the daemon's shape | 3826 | 10 | 165.5s |
| qwen3:4b, without `response_format` | 240 | 3597 | 297.7s |

The qwen3 family reasons before answering, and `chat_template_kwargs:
{enable_thinking: false}` - which the daemon sends - is **not honoured through
ollama's OpenAI-compatible endpoint**. Dropping it changed nothing. So a gloss
that needs about ten tokens costs several thousand, which is roughly two hundred
times the compute for the same answer.

### Answered: the switch exists, and it does not rescue the small model

Four ways of asking for it, on qwen3:4b, same two words each time:

| how the request was made | time | prompt tokens | output tokens |
|---|---|---|---|
| as the daemon sends it | 459.5s | 7181 | 12 |
| `/no_think` appended to the system prompt | 329.0s | 4690 | 15 |
| `"think": false` in the body | 621.6s | 7181 | 12 |
| **`"reasoning_effort": "none"`** | **9.3s** | **279** | 24 |

Only the last one works, and it is a **49x** difference. The two the daemon and
the obvious documentation suggest - `chat_template_kwargs` and `think` - removed
nothing at all.

The mechanism is not what the name suggests. **The cost was in the prompt, not
the answer.** Twelve output tokens either way; 7181 input tokens against 279. A
reasoning scaffold is being prefilled into the request, and `reasoning_effort`
is what stops it being built.

**It does not make the model good.** Re-running the whole thirteen-word set:

| qwen3:4b | a word | accepted | contextual |
|---|---|---|---|
| reasoning on | 30.1s | 4/13 | 1/6 |
| reasoning off | 0.6s | 1/13 | 0/6 |

Fifty times faster and worse: `meyve` (fruit) for pantry, `yaprak` (leaf) for
asparagus, `kargo` for courier. The reasoning was doing real work for a model
this small.

So `reasoning_effort` stays out of the daemon. A field that trades quality for
speed is not a default; it is a property of whichever model is configured, and
it belongs in the bake-off - where it is now - until a model that needs it is
chosen. The open question is closed: switching the reasoning off is possible and
it is not the answer.

## What was changed

`gloss_model` is now empty in `config.local.json`, so the local tier is off and
Google answers. That is zero memory, zero compute on this machine, and 0.23
seconds a word measured through the running daemon. The cost is the contextual
half: Google reads the word, not the line, so it gets "domestic" beside "foreign"
wrong as "yerel" and "shotgun" wrong as the gun.

This is a setting, not a removal. Putting a model name back turns the tier on,
and everything below it - the adaptive batch, the per-call budget, the fall
through to Google for whatever the model does not reach - already works.

**Reopen when the machine is quiet**, with one small request: if `/no_think` or
`think: false` suppresses the reasoning tokens, re-run the bake-off on
`qwen3:4b` and `qwen3.6:35b-a3b` and read this table again.

## Google Translate, since it was asked about

It is already wired in, and since the local tier was switched off it is what
answers every prefetched word. `_fill_context_free` in `lookups.py` calls it;
`translate` has called it for the by-hand path all along. Measured through the
running daemon on four fresh words: 0.91 seconds, 0.23 a word.

**It is free at this volume, and that is from Google's own pricing page rather
than from memory.** The first 500,000 characters a month are free, "applied as
$10 credit every month"; over that, NMT text translation is $20.00 per million
characters.

What this project sends, measured: the average term actually asked about in the
answer cache on this machine is 7.4 characters (n=144), and the marking rule
produces about 400 marks a film. That is **2,972 characters a film**, so about
**168 films a month before anything is charged**, and $0.06 a film after that.

The line is only ever the word. Google's API takes a string and returns a
string, so the tier below the model cannot be given the sentence even if it were
free to do so - which is the whole reason the model tier exists and the whole of
what is lost while it is off.

### And it is good, on the same thirteen words

`gloss_bakeoff.py google-translate` runs the free tier through the same set with
the same accepted-answer lists:

| | a word | accepted | contextual |
|---|---|---|---|
| google-translate | 1.0s | **8/13** | 1/6 |
| qwen3.6:35b-a3b (22.6 GB) | 21.8s | 10/13 | 4/6 |
| qwen3:14b (9.3 GB) | 33.4s | 6/13 | 2/6 |
| qwen3:4b (2.5 GB) | 30.1s | 4/13 | 1/6 |
| gemma3:4b (3.3 GB) | 0.3s | 2/13 | 0/6 |
| phi4-mini (2.5 GB) | 0.2s | 0/13 | 0/6 |

Google beats every local model measured except the 22.6 GB one, at a twentieth
of its latency and none of its memory.

**The split is the finding, not the total.** Google got **7 of the 7 bare-word
cases**, including returning nothing at all for the proper noun `Paige` - a
perfect score on the half of the problem that does not need the line. All five
of its misses are contextual, and they are the same five a reader would notice:

      domestic   "foreign and domestic"        yerel        (local, as in a local shop)
      shotgun    shouted at a car              av tüfeği    (the gun)
      spare      "one spare engine"            kıyamamak    (to not have the heart to)
      spare      "can you spare a minute"      kıyamamak    (the same answer, again)
      draft      a draft notice                taslak       (a rough version)

The two `spare` lines returning the identical string is the mechanism in one
line: Google is asked the word, so it answers the word, so it cannot answer two
different questions that share one.

### The other half of "late" was never the model

Google was being asked one word at a time. `_fill_context_free` looped over the
film's words and each one was its own TLS handshake and round trip.

Against the live API, twenty words:

| | time | a word |
|---|---|---|
| one request per word | 54.29s | 2.71s |
| one request | 0.44s | 0.022s |

**123 times, and the same twenty answers to the byte.** A film marks about 400
words, so the prefetch was an eighteen-minute job where nine seconds was
available - and eighteen minutes is longer than the reader keeps looking at the
chip. This is a plain shape of the complaint that has nothing to do with which
model is configured, and it was there whether the model tier was on or off.

The v2 reference is explicit that the parameter is repeatable: *"Provide an
array of strings to translate multiple phrases. The maximum number of strings is
128."* (https://cloud.google.com/translate/docs/reference/rest/v2/translate)

Batch size is where the cost is not:

| words in one request | time |
|---|---|
| 1 | 1.21s |
| 32 | 0.38s |
| 128 | 0.52s |

The round trip is the cost; the words are free. So the six-second timeout keeps
about ten times the headroom it needs at the documented maximum.

Through the restarted daemon, on thirty words it had never seen: **0.71 seconds,
0.024 a word.** Twenty-three came back with a meaning and seven were dropped as
echoes, which is the right answer for words like `futtock` and `orlop` that
Google hands straight back.

**What batching costs:** a request that fails now loses 128 words instead of
one. Nothing is written to the cache on a failure, so the next prefetch asks
again, and a word the reader actually clicks still takes the by-hand path - one
word, then the archive. The failure is a page of empty chips that fills in, not
a wrong answer.

**What this changes.** The local tier is not competing for the whole job. Google
already holds 7 of 13 for free, at 1 second and no memory. The only work left
for a model on this machine is the 6 contextual words, and the measured range
there is 0/6 to 4/6. A candidate that does not beat 1/6 is buying nothing at all,
whatever its total looks like - `gemma3:4b` at 2/13 is worse than doing nothing.

## Purpose-built translation models, since they were suggested

Two exist as ollama pulls and neither had been tried:

- **`translategemma`** (4b, 12b, 27b) - Google's, built on Gemma 3, "helping
  people communicate across 55 languages", 2.3M downloads, in the official
  library.
- **`kaelri/qwen3.5-mt:2b`** - Alibaba's Qwen3.5 tuned for translation,
  described by its author as "uncensored, **non-thinking** ... input text,
  output translation, nothing else". The non-thinking part matters: reasoning
  tokens are exactly what made every general-purpose qwen3 unusable here.

Measured, on the same thirteen words, with the machine at load 13:

| | to load | a word | accepted | contextual |
|---|---|---|---|---|
| translategemma:4b | 11s | 0.6s | 1/13 | 1/6 |
| kaelri/qwen3.5-mt:2b | 89s | - | refused the contract | - |
| google-translate | - | 1.0s | 8/13 | 1/6 |

**Neither is worth configuring.** `translategemma:4b` is fast and holds the JSON
contract, and answers one of thirteen: `depo` (warehouse) for vault, `biber`
(pepper) for asparagus, `mesajcı` for courier, `Paige gel` for the name Paige.
It gave `yedek` for both `spare` lines, the same shape of miss as Google, so it
is not reading the line either. It is a sentence translator being handed a word.

`kaelri/qwen3.5-mt:2b` could not return the array at all - every request came
back as something that is not JSON, twice, so the daemon's answer-count check
refused it.

**`--plain` separates the two failures, and the separation does not rescue
either model.** Asked one word per request with the answer taken as raw text:

| plain mode | to load | a word | accepted | contextual |
|---|---|---|---|---|
| translategemma:4b | 5s | 0.3s | 3/13 | 1/6 |
| kaelri/qwen3.5-mt:2b | 77s | 59.9s | 1/13 | 0/6 |

So qwen3.5-mt's problem really was formatting - it answers when asked plainly -
and behind the formatting is 1 of 13 at **sixty seconds a word**, which is the
configured 22.6 GB model's latency from a 2 GB model. Eight of its thirteen
answers were empty.

translategemma does better without the JSON wrapper, 3 of 13 rather than 1, so
the contract costs it something real. It is still less than half of Google's 8,
and what it returns is a dictionary entry rather than a gloss: `Yedek, fazladan`
for spare, `Doktor, hemşire` for medic, `Anlamı yok.` - "it has no meaning" - for
shotgun. The chip has room for one answer.

## The axis that was not tested: a hosted model, free

Everything above is either local and small, local and huge, or a translator that
never sees the line. The gap is a model that reads the line and costs nothing,
and Gemini's free tier is exactly that shape.

**It fits with no code change.** The daemon's gloss tier already speaks the
OpenAI chat-completions protocol, and Gemini publishes an OpenAI-compatible
endpoint. `gloss_url`, `gloss_model` and `gloss_api_key` are all it needs:

```json
"gloss_model": "gemini-3.5-flash-lite",
"gloss_url": "https://generativelanguage.googleapis.com/v1beta/openai/chat/completions",
"gloss_api_key": "<the same key>"
```

**Free, from the pricing page rather than from memory.** Flash-Lite's free tier
reads "Free of charge" for both input and output tokens, and
`gemini-3.5-flash-lite` is described there as "optimized for high-volume agentic
tasks, **translation**, and simple data processing".
(https://ai.google.dev/gemini-api/docs/pricing) The free tier's stated cost is
that content is used to improve Google's products, which was asked about and
answered: "I don't have privacy concerns here."

**One step is not mine to take.** The key already in `config.local.json` is
valid, but the Gemini API is not enabled on its project:

    403 Gemini API has not been used in project 515973764373 before or it is
    disabled.

Enabling it is a click in that project's console. Until then this is measured as
far as it can be measured from here: the transport is right, the key is right,
the tier is free, and the quality is unknown because the request cannot be made.
It is the one candidate left that could hold the six contextual words, and it is
the only one that costs neither memory nor money.

## The larger half of "late and not accurate"

The daemon was not running. Port 8791 had been held since 4 September by a static
file server from another project, and every gloss request went to it and came
back as an HTML error page. Nothing failed visibly, because the extension does
the work itself when the daemon is absent - so meanings were fetched live as each
line reached the screen instead of ahead of the film, and they came from a tier
that never sees the line. The running log has no entries after 2 September.

The daemon listens on 8794 now, and the settings page says which of the two is
wrong when it cannot reach it - nothing listening, or something else listening.
See `065fb28`.

## Where this leaves the setting

Recommendation: **leave `gloss_model` empty and let Google answer**, now that it
answers in one request instead of four hundred.

The basis, separated from it. Seven candidates have been measured against the
same thirteen words with the same accepted-answer lists:

| | resident | a word | accepted | contextual |
|---|---|---|---|---|
| google-translate | none | 0.024s (batched) | 8/13 | 1/6 |
| qwen3.6:35b-a3b | 22.6 GB | 21.8s | 10/13 | 4/6 |
| qwen3:14b | 9.3 GB | 33.4s | 6/13 | 2/6 |
| qwen3:4b | 2.5 GB | 30.1s | 4/13 | 1/6 |
| translategemma:4b | 3.3 GB | 0.3s | 3/13 | 1/6 |
| gemma3:4b | 3.3 GB | 0.3s | 2/13 | 0/6 |
| kaelri/qwen3.5-mt:2b | 2.0 GB | 59.9s | 1/13 | 0/6 |
| phi4-mini | 2.5 GB | 0.2s | 0/13 | 0/6 |

Only one row beats Google, and it is the row that produced the report: 22.6 GB
resident, which was the complaint. Every model that fits alongside the reader's
other work scores below the tier it would be sitting on top of, so configuring
any of them makes the glosses worse and the machine slower at the same time.

What is still unmeasured is the hosted free tier, because the API is not enabled
on the key's project. That is the one candidate that could hold the six
contextual words without costing memory, and it is where this should be picked
up.

The bake-off runs any of these again in one command, including the free tier:

```bash
cd subtitle-daemon
uv run python tools/gloss_bakeoff.py google-translate translategemma:4b
uv run python tools/gloss_bakeoff.py kaelri/qwen3.5-mt:2b --plain
```
