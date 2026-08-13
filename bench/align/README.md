# Alignment bake-off

Runs every subtitle-alignment method over every pair of subtitle files in the
repository and prints numbers that can be compared. It exists because the
aligner's design questions kept being settled by argument.

```bash
node bench/align/run.mjs          # the table
node bench/align/run.mjs --json   # also writes results.json
```

No dependencies, no network. It reads `subtitle-daemon/cache/subtitles/` and
`srt-viewer/subtitles/` directly.

## What it measures, and why three numbers rather than one

**ROC AUC** is the ranking, and it is the only number here that survives having
no threshold chosen. Nothing is tuned to produce it.

**Recall at zero false accepts** is the operating point this product actually
has. A shift applied without asking on two unrelated films is the failure the
whole aligner exists to prevent, so the question is: with the threshold pushed
to wherever it must go to admit not one wrong pair, how many right pairs are
still recognised? A method that wins on AUC and loses here is the wrong trade.

**Shift error**, because a score that ranks perfectly and times badly is
useless.

## Where the labels come from

Derived, never hand-written. Every cached download carries the `movie_name` it
was fetched under, so "same film" is something the files say about themselves.
A hand-kept list against a cache that grows every time somebody watches
something rots, and when it rots it calls correct answers failures — which is
exactly what happened to `subtitle-daemon/tests/test_align.py` before it was
changed to derive them too.

A file whose sidecar carries no identity is **refused**, not guessed at. One
missing field would otherwise produce 53 wrong labels in silence. Add it to
`NO_METADATA` in `corpus.mjs` with the film it belongs to.

## There is no ground truth for the shifts

Nobody has labelled the true offset for these pairs, so the bench does not
pretend otherwise. A same-film pair whose methods land within 250ms of each
other is taken as settled at their median; the rest are reported as **disputed**
rather than averaged into a truth that would then be scored against.

Disputed pairs are judged by two referees that belong to no method — how many
cue *starts* line up after the shift, and how much *speech overlaps* after it.
One favours the point methods by construction and the other the interval
methods, so a shift winning both is winning on the other side's terms. When
they disagree, the bench says so and picks nobody.

## The control that makes the split measurement trustworthy

The last section asks whether one shift is even the right model, by cutting the
timeline into six segments and letting each choose its own offset. Six free
segments can always find something better than one shift, so a gain alone
proves nothing.

The calibration is the pairs that should gain nothing: two files already
sharing a timeline have no drift to recover. They gain **0.0** overlap points.
Pairs whose segments want offsets more than five seconds apart gain **12.0**.
That gap is what makes the finding a measurement rather than an artefact of the
freedom given to the fit.

## Adding a method

Implement `{ name, about, run(a, b) }` in `methods.mjs` and add it to
`METHODS`. `run` returns `{ shiftMs, scores: { … } }`, where every score is
"higher means surer these are the same film". Return several — the bench scores
each one separately, and which statistic discriminates is usually not obvious
in advance. A method must not read the pair's label; there is no ground truth
in that scope for exactly that reason.

The incumbent is loaded from `browser-extension/src/align.js` rather than
reimplemented. A bake-off whose baseline is a paraphrase of the baseline
measures the paraphrase.
