# Alignment bake-off

Runs every subtitle-alignment method over every pair of subtitle files in the
repository and prints numbers that can be compared. It exists because the
aligner's design questions kept being settled by argument.

```bash
node bench/align/shapes.mjs     # what the truth IS, per pair
node bench/align/run.mjs --same # the accuracy tables, in about a minute
node bench/align/run.mjs        # the above plus discrimination, in about twenty
node bench/align/regress.mjs    # does the candidate make any pair worse?
```

No dependencies, no network. It reads `subtitle-daemon/cache/subtitles/` and
`srt-viewer/subtitles/` directly. `expand.mjs` is the one exception - it fetches
through the daemon, on a budget, and stops before the reader's quota runs out.

The full account of what all this measured is in
`docs/reports/auto-sync-2026-08-16.md`.

## Where the truth comes from

**Cue text**, in `truth.mjs`. Timings are the thing under test, so a truth built
from timings is a tautology. Two releases of the same film in the same language
usually carry the same words - one file is very often a re-timing of the other -
so matching cue text gives a correspondence that owes nothing to any method
here, and every matched pair is a point on the true warp. Unique-exact-match
plus a longest increasing subsequence, which is the anchor trick `diff` uses.

It **refuses** rather than guesses. Of 379 same-film pairs it settles 162;
of the rest, 202 are cross-language and share no text by construction and 15 are
independent transcriptions with too few identical lines. Both refusals are
printed. Those four numbers are what `shapes.mjs` printed against a 277-file
corpus, and the corpus grows whenever `expand.mjs` runs - the figures earlier in
this paragraph were 283, 137 and 131 when the corpus was smaller. The refused half is scored by referees instead, in its own table,
labelled as objectives rather than truth.

This replaced a consensus - a pair where the methods landed within 250ms of each
other was "settled" at their median. That was honest about not knowing and had
one failure it could not see: the settled pairs are the pairs the methods find
easy, so every timing number described the easy half of the corpus.

## What it measures, and why several numbers rather than one

**ROC AUC** is the ranking, and the only number here that survives having no
threshold chosen. Nothing is tuned to produce it.

**Recall at zero false accepts** is the operating point this product has. A
shift applied without asking on two unrelated films is the failure the aligner
exists to prevent, so: with the threshold pushed to wherever it must go to admit
not one wrong pair, how many right pairs are still recognised?

**Share of the film inside 250ms**, pooled over every cue of every pair, rather
than one error per pair. A method that is exact for eight minutes and twenty
seconds out for the other forty is not 71% right.

**Broken out by what the truth turned out to be**, because the averages hide the
finding. Every method puts 99-100% of a flat pair in the right place; the
interval methods manage 13-16% of a framerate pair, and the shipped aligner 52%
of a staircase.

## Adding a method

Implement `{ name, about, run(a, b) }` in `methods.mjs` and add it to
`METHODS`. `run` returns `{ at, scores }`.

`at` is a **function** - where in B does the moment at `x` in A happen - not a
number. It used to be `shiftMs`, and the bench compared those numbers across
methods to decide who agreed with whom, which is meaningless for a method that
returns a shift only valid next to its rate. Every pair whose releases differ by
a framerate was recorded as a three-way dispute between one right answer and two
wrong ones. `straight(rate, shiftMs)` builds one for the ordinary case.

`scores` is a map, and every entry is "higher means surer these are the same
film". Return several - the bench scores each separately, and which statistic
discriminates is usually not obvious in advance.

A method must not read the pair's label. There is no ground truth in that scope
for exactly that reason.

**Anything that ships is loaded, never reimplemented.** `starts` and `split` are
both `align.js`, called two different ways. A bake-off whose baseline is a
paraphrase of the baseline measures the paraphrase - and that applies the moment
a candidate ships, not only to the incumbent it started against. `split` was
designed as a copy in this file and the copy was deleted when it moved.

## Before changing any constant, run regress.mjs

```bash
node bench/align/regress.mjs                  # split against starts
node bench/align/regress.mjs --against overlap --candidate split
```

It prints every pair the candidate loses ground on and exits non-zero if there
are any. A better average bought by breaking pairs that already worked is not an
improvement, and the first version of the piecewise method did exactly that on
four pairs the shipped aligner already put 100% right.

Two of those four turned out to be the **oracle** being wrong rather than the
candidate, which is the useful thing about a regression list: it does not know
which side is at fault, so it makes you go and look.

## Where the labels come from

Derived, never hand-written, in `corpus.mjs`. Every cached download carries the
`movie_name` it was fetched under, and everything `expand.mjs` fetched is
recorded in `labels.json` by the thing that did the searching. A hand-kept list
against a cache that grows every time somebody watches something rots, and when
it rots it calls correct answers failures - which is exactly what happened to
`subtitle-daemon/tests/test_align.py` before it was changed to read the same
file.

A file whose sidecar carries no identity is **refused**, not guessed at. One
missing field would otherwise produce dozens of wrong labels in silence.

Language is detected from the words rather than read from the sidecar, because
the sidecar says `null` for every file downloaded while watching - and a Turkish
subtitle named `The.Americans.S02E09.1080p.WEB-DL.srt` is not a rare accident.

## Growing the corpus

```bash
node bench/align/expand.mjs --dry            # what it would cost, in downloads
node bench/align/expand.mjs --budget 30      # spend at most 30
```

Searching is free; downloading spends the reader's OpenSubtitles quota - the
same quota they need to watch something tonight - so this takes a hard budget
and stops when the daemon reports fewer than 15 downloads left.

Four English releases per title, because the oracle can only settle pairs that
share text: k files of one title in one language are k(k-1)/2 pairs it can
label, where a new title adds them one at a time. The Turkish file is fetched
too, because the cross-language pair is what the aligner meets in production,
and it is measured against the referees rather than the oracle.
