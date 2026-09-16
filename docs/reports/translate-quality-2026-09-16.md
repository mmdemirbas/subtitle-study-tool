# Which translator makes dialogue worth reading, and what each one costs

The bake-off of 2026-09-10 chose the local default on numbering and speed and
said in its own words that it measured fluency "not at all". An episode was
then watched through it, and the reader reported the other half: "it
translates, but not very well. It misses the point most of the time. It is
not supposed to translate a book or academic language; it is supposed to
translate daily speech." This measures that half, on that episode.

The decision this feeds: what the daemon translates a whole subtitle with
when nothing names a model, and what it is worth naming one for.

## What was run

```
uv run python tools/translate_quality.py \
  --job cache/translate-jobs/page-tt41297712-eng-subtitle-cf52c882-tr \
  --start 240 --limit 60 --judge --out ../docs/reports/translate-quality-2026-09-16 \
  --candidate shipped --candidate shifted --candidate google \
  --candidate gemma3:4b@current --candidate gemma3:4b@spoken \
  --candidate qwen3:4b@spoken --candidate qwen3:14b@spoken --candidate qwen3:14b@current \
  --candidate qwen3.6:35b-a3b@spoken --candidate qwen3.6:35b-a3b@current
```

- **Input:** lines 241-300 of Not Suitable for Work S01E01 (2026), the page's
  own English track, which is the file the reader translated on 09-14. A
  workplace comedy; two friends at home, then a first day at work. 24 of the
  60 cues have a line break, 7 of those two speakers.
- **A candidate** is a model on this machine and a brief, run the way the
  daemon runs it: forty cues a request, four of the previous chunk carried
  as context, greedy decode, JSON out, a misnumbered chunk halved and asked
  again, a cue that lost a speaker asked for alone. Through ollama's own
  `/api/chat` with `think: false`, for the reason under "What was found on
  the way". Two briefs: `current`, the one that shipped, and `spoken`, which
  names the register and carries eight example lines of it - see
  `tools/translate_quality.py`.
- **Three candidates are not models.** `shipped` is what the daemon actually
  made for this job on 09-14, read off its chunk files - what the reader saw.
  `google` is Google Translate v2, every physical line of a cue as its own
  string, with the key already in `config.local.json`. `shifted` is `shipped`
  moved down one cue, a control for the grader.
- **The grader** is `claude-opus-5` through `claude -p`, one call per
  candidate: every line as a pair, the English and the candidate's Turkish
  directly under it, scored for accuracy (this line's meaning in this scene,
  1-5) and naturalness (reads like a Turkish subtitle a native speaker would
  say, 1-5) with the worst thing wrong tagged. $2.68 for the ten calls of
  this pass; a first pass through `claude-sonnet-5` cost about $1.50 more and
  is kept beside it, for the reason under the control below.
- **Artifacts**, all under `translate-quality-2026-09-16/`: `answers.json`
  (every candidate's every line, with timings and repair counts),
  `judged.json` (every score), `transcript.md` (the 60 lines side by side
  with the scores, for reading by eye), and
  `judged-first-pass-sonnet-blocks.json`, the grading pass that is not used.

## What the candidates did

| candidate | s/line | requests | accuracy | naturalness | lines ≤2 | lines ≥4 on both | worst two tags |
|---|---|---|---|---|---|---|---|
| google | 0.02 | 1 | **4.52** | **4.30** | 5 | 46 | mistranslation 9, wrong-register 4 |
| qwen3.6:35b-a3b@current | 1.58 | 6 | 4.25 | 3.92 | 7 | 37 | unnatural 10, mistranslation 6 |
| qwen3.6:35b-a3b@spoken | 0.85 | 2 | 4.18 | 3.82 | 7 | 37 | unnatural 12, mistranslation 6 |
| qwen3:14b@current | 7.89 | 11 | 3.58 | 3.33 | 12 | 21 | mistranslation 12, unnatural 10 |
| qwen3:14b@spoken | 3.21 | 2 | 3.55 | 3.53 | 15 | 22 | mistranslation 14, unnatural 12 |
| shipped (gemma3:4b, 09-14) | - | - | 3.27 | 2.95 | 21 | 14 | unnatural 13, mistranslation 9 |
| gemma3:4b@current | 5.49 | 28 | 3.12 | 2.82 | 21 | 14 | unnatural 13, extra-content 9 |
| gemma3:4b@spoken | 1.84 | 17 | 2.93 | 3.00 | 25 | 19 | mistranslation 9, truncated 8 |
| qwen3:4b@spoken | 1.46 | 8 | 2.68 | 3.03 | 30 | 13 | mistranslation 21, broken-turkish 8 |
| shifted (control) | - | - | 1.35 | 3.00 | 54 | 3 | wrong-line 48 |

Seconds per line are wall clock on this machine with nothing else heavy
running, including every halving and repair request; "requests" is how many
the 60 lines took. A 1000-cue episode at these rates: Google under a minute,
qwen3.6:35b-a3b 14 minutes, qwen3:14b 53 minutes, gemma3:4b 30 to 90
minutes depending on how many chunks come back misnumbered - the two real
jobs of 09-14 ran at 1.8 and 3.6 seconds a line.

**The control held.** `shifted` scored 1.35 with 48 of 60 tagged wrong-line,
so the grader reads the line it is given. A first grading pass did not: it
was given the English slice as one block and the candidate as another, and
scored gemma3:4b's drifted lines - the Turkish of line 250 filed under 248 -
as "ok" at 4 and 5, because the sentence was fluent and about the scene.
That pass is kept as `judged-first-pass-sonnet-blocks.json` and is not used
here; the pairs are what made the question local.

**What "misses the point" was, in the file the reader watched.** Of the 60
lines, 21 scored 2 or under. Line 249, "but I don't have any credibility
because I hate all your boyfriends", came out as "Tamam, her şey yolunda
gitti çünkü artık burada yaşayabilirsin" - line 250's content, one down.
Line 252, "I get paid crumbs to be screamed at by my boss", came out as
"patronum bana paralarımın pırpırlarını veriyor". Line 275, "My Achilles
flared", as "Ayaklarımın altında Ayak Hızlısı devreye girdi". Lines 261-265
each ended in "- A." or "- B.": the brief's own example of a two-speaker
line, echoed. The same model and brief re-run through the daemon's repairs
scored 3.12: the halving recovers the numbering of a chunk, not the meaning
of its lines.

**What the two that score well get wrong.** Google's nine mistranslations are
what a line-at-a-time system cannot see: "the super" is "apartman
yöneticisi", which is right, and "taking his name off our mailbox" across
the next line is "adını değiştirmek", which is not; "I did not, and never
say that again" loses its "never say that again" to a future tense. Its four
wrong-register lines are "siz" between two friends on a sofa - "tüm erkek
arkadaşlarınızdan", "Kendinizi ortaya koyun" - a formality no scene here
asked for. qwen3.6:35b-a3b sees the scene and keeps "sen" throughout, and is
the stiffer of the two on a third of its lines: "Kendini dışarıya aç" for
"put yourself out there", "Jocelyn, hanımım" for "Jocelyn, my lady", "Hemşire
biraz havalıydı" for "the nurse was kinda hot". Both are readable
throughout; neither produced a line a reader would call nonsense.

**The brief is not the lever.** On every model the two briefs are within the
grader's noise on accuracy (4.25 against 4.18, 3.58 against 3.55, 3.12
against 2.93). What `spoken` changes is the wall clock on the two larger
models - 0.85 against 1.58 seconds a line, 3.2 against 7.9 - because fewer
chunks come back misnumbered and have to be halved; and it carries no
literal example for a model to echo. The model's size is the lever: 4B to
14B is one point of accuracy, 14B to the 35B mixture is another.

## What was found on the way

**The qwen3 family was written off on a transport detail.** The first
bake-off measured qwen3:4b at 10.47 seconds a line through ollama's
OpenAI-shaped `/v1/chat/completions` and dropped the family for speed. That
number is the model reasoning before every answer: the OpenAI shape has no
field that turns it off, and `chat_template_kwargs` is ignored there.
Measured on qwen3:4b with an 18-token answer, `think: false` in the body:
95 seconds through `/v1/chat/completions`, about two through `/api/chat`
with the flag honoured. The daemon now speaks to ollama through `/api/chat`
(`chat.ollama_native`), which is what puts the 35B mixture at 0.85 seconds a
line.

**A grader needs the pair, not the page.** Above. The general form: a
per-line score asked across two blocks is matched by topic when the line is
plausible, and the failure that matters most in this work - the right words
under the wrong number - is exactly the plausible one.

## What was not measured

- **Memory while the 35B runs.** 22.6 GB resident for the length of the job,
  and ollama keeps it loaded for five minutes after. The complaint that
  started the gloss bake-off was this model making the machine unusable when
  it was resident for the whole film; a whole-file job is fourteen minutes
  up front and then nothing, which is a different shape of cost, and nobody
  has watched a film beside it yet.
- **gemma3:12b, aya-expanse, hunyuan-mt.** Not on this machine; a pull ran at
  233 KB/s on the day and was stopped. `translategemma:4b` was run with the
  spoken brief and renumbered every chunk from 1, as in the first bake-off;
  its line is left out of the table above because 42 of its 60 answers
  could not be filed under a cue.
- **A second slice, or another programme.** Sixty lines of one episode. The
  ranking has a full point between each of its three tiers, which is larger
  than anything the grader's noise showed between briefs; the absolute
  numbers are this slice's.
- **A human Turkish subtitle as the reference.** Same limitation as the two
  reports before: nothing line-aligned exists for this episode. The grader is
  a model; the transcript is there for a native speaker to disagree with it.
- **Gemini.** No key on the machine; the free tier is one console step away
  and was not taken here.

## Recommendation

Stated as a recommendation, separate from the evidence above.

**When nothing names a model, use Google Translate if its key is configured,
gemma3:4b if not.** This is what the daemon now does, and it is the rule the
gloss tier has followed for the same key since 09-06. On this slice it is a
1.2-point gain in accuracy over what the reader watched, and the wait goes
from an hour to under a minute. The first 500,000 characters a month are free
(a $10 credit; an episode is about 45,000 characters, so about eleven a
month), $20 a million after -
https://cloud.google.com/translate/pricing, read directly. The subtitle text
leaves the machine; nothing about the reader does.

**Name `qwen3.6:35b-a3b` in `translate_model` to keep it local.** 4.2
against 4.5, fourteen minutes an episode, 22.6 GB while it runs. The reader
has said what this model does to the machine when it stays resident; for a
job that runs once and unloads, that is theirs to try.

**Keep the spoken brief.** Equal on accuracy, half the wall clock on the
models where the wall clock matters, and it cannot be echoed.

**Do not spend more on the 4B tier.** Three briefs and three 4B models sit
between 2.7 and 3.3, a point under the next size up, with the failure
modes - drift, invention, echo - that no brief fixed. The reader's
suggestion, subtitle material as examples, was tried in its cheap form (eight
example lines in the brief) and moved nothing at this size. The expensive
form, fine-tuning on an aligned subtitle corpus, is the one thing here not
tried; it is a project, and the two options above are configuration.
