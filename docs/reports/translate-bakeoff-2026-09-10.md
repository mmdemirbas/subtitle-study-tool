# Which model on this machine can translate an episode, and stay lined up

The pre-translate trial of 2026-09-08 showed what a good whole-file answer looks
like and said not to ship the instrument that produced it, because every
`claude -p` invocation re-sends Claude Code's own system prompt. This asks what a
model already on this machine does with the same job.

The decision this feeds: the extension is to offer "there is no Turkish subtitle
for this - shall I make one?", and the local tier is to be the default.

## What was run

```
uv run python tools/translate_bakeoff.py \
  translategemma:4b gemma3:4b qwen3:4b --limit 40 --chunk 40
```

- **Input:** cues 301-340 of the Battlestar Galactica miniseries part one, the
  slice next to the one the pre-translate trial used. **25 of the 40 have a line
  break inside them**, which turns out to be the whole story.
- **Asked for:** a Turkish line per numbered English line, JSON, greedy decode,
  four lines of the previous chunk carried in as read-only context. The
  vocabulary half of the pre-translate brief was left out, because a 2B
  translation model will not do it and asking would have measured
  prompt-following instead of translation.
- **Transcript:** `translate-bakeoff-2026-09-10/transcript-300-339.json`, every
  answer from every model, for reading by eye.

## What is measured, and what is not

Not fluency. A subtitle cue is a numbered box with a start and an end, and the
failure that matters is one where the words are fine and they are attached to
the wrong moment.

- **numbering** - the `n` values returned are exactly the ones asked for.
- **lost a speaker** - a cue whose lines start with `-` holds that many
  speakers, and the translation has to hold as many.
- **reflowed** - the line count changed but no speaker was lost.

The last two started as one measure and had to be split. Counted together, every
model "reshaped" 25 of 40 cues, which reads as catastrophic. Separated, 24 of
those are a two-line cue coming back as one line carrying both halves - a
renderer re-wraps it and nobody watching can tell - and **one** is content
leaving the file.

## What the models did

| model | numbering | lost a speaker | reflowed | s/line | 1154-cue episode |
|---|---|---|---|---|---|
| gemma3:4b | ok | 1 of 40 cues | 24 | 0.48 | 9.1 min |
| translategemma:4b | 7 invented numbers | 1 of 40 cues | 24 | 0.50 | 9.6 min |
| qwen3:4b | ok | 1 of 40 cues | 19 | 10.47 | 201.3 min |
| kaelri/qwen3.5-mt:2b | returned an empty body | - | - | - | - |

`kaelri/qwen3.5-mt:2b` answered `''` to a request with
`response_format: json_object`. It is a translation model without a JSON mode,
not a model that failed the task.

`translategemma:4b` returned seven `n` values outside the range it was asked
for. The numbers it invents are the reason it is not the fast winner despite
matching gemma3 on speed: an answer filed under a line number nobody asked about
is an answer that lands on the wrong cue if a caller trusts `n`.

Episode figures are `s/line × 1154`, extrapolated from a 40-cue slice on an
otherwise-busy machine. They are the right order of magnitude and not a
benchmark.

## The one cue that loses content, in both fast models

```
304
- Secretary Roslin.
- Yes.
```

| | |
|---|---|
| gemma3:4b | `- Sekreter Roslin.` |
| translategemma:4b | `Sekreter Roslin.` |

"- Yes." is not in the output. In an earlier probe at a different chunk size,
translategemma instead emitted it as its own numbered answer, which renumbered
every line after it while still returning the count that was asked for - the
count check passed and the file was wrong from cue 304 to the end.

**This is detectable.** The speaker-dash count is exactly the signal the
bake-off scores on, so a caller can find the affected cue and re-ask for it
alone. That is a repair the current `tools/pretranslate.py` does not do: it keys
answers by `int(row["n"]) - 1` and trusts them.

## What was not measured

- **qwen3:14b and qwen3.6:35b-a3b.** Not run. The 4B of the same family reads at
  10.47 s/line, which is 3.4 hours an episode, and the complaint that started
  the gloss bake-off was a 22.6 GB model making the machine unusable. The family
  was dropped on speed and memory, not on quality - nothing here says how well
  they translate.
- **Quality against a human translation.** Same limitation as the pre-translate
  trial: the repo's Turkish miniseries file is not line-aligned with the
  English, so any per-line score would be measuring the segmentation.
- **A hosted endpoint.** Not run here. The pre-translate trial measured
  `claude-sonnet-5` at $0.223 per 120 lines through the CLI instrument, and the
  gateway research put the same work against a raw API at about $0.28 an
  episode.
- **Longer chunks.** Everything here is a single 40-cue request. Whether 120
  holds up locally is open; a failure at 120 costs 120 answers.

## Recommendation

Stated as a recommendation, separate from the evidence above.

**gemma3:4b as the local default.** It is the only candidate that got the
numbering right at a speed that finishes an episode while you make coffee, and
3.3 GB is a size the machine can hold alongside everything else.

**Do not trust `n` without checking it.** Reject a chunk whose returned numbers
are not exactly the ones asked for, and re-ask any cue whose speaker count
dropped. Both checks are cheap, both are already written in
`tools/translate_bakeoff.py:score`, and without them the failure is a subtitle
that looks finished and is off by one from cue 304 onward.

**Keep the hosted path as a switch, not a fork.** The daemon already speaks
OpenAI chat-completions for glossing; the same three settings pointed at a
hosted endpoint should be all that changes.
