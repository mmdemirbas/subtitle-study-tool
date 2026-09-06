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

Whether `/no_think` in the system prompt or `think: false` in the body fixes it
was not established: the machine reached a load average of 206 and ollama was no
longer running. **This is the open question**, and it is worth answering, because
if the reasoning can be switched off then a 2.5 GB qwen3 may be both light and
accurate - which is the combination nothing in the table currently offers.

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
