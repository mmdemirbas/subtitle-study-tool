# What gets marked, and what comes back

3 September 2026. Two questions were asked of the study rail: how well is it
choosing the words worth stopping on, and how well is it translating them given
the context. Neither was answerable when they were asked, because nothing was
written down. This says what was built to answer them, what the first answers
were, and which of them have been acted on.

## What was built

`glossAhead` in `study.js` walks a whole subtitle in one pass at attach and asks
for every meaning in it. It is the only place that sees the entire population -
every word marked, every word refused, and what came back for each - and it used
to throw all of that away once the cache was warm.

It now writes one `marks` record per film per subtitle into the running log, and
`tools/study-report.mjs` reads them back. The record carries the terms, their
ranks, whether each was a phrase, and the answer; it does not carry the lines
they were said in, because the subtitle file is on disk already and a log
holding the dialogue is a copy of the subtitle rather than a record about it.

**The refusals are the half that decides it.** A rule judged on the words that
survive it is judged against a population it curated itself, so a name rule
eating half the film cannot appear in its own output. The record counts all five
ways a word fails to be marked: a name, too short, common enough already, no
rank to judge it by, over the line's two-per-line cap.

## Where the numbers come from

The record is new, so no watched film has produced one yet. Everything below is
measured offline instead, over the **175 English subtitle files in this
machine's cache**: 156,780 cues, 913,114 words, 12,501 minutes of runtime. Two
different tools:

- the corpus sweep uses `tools/measure-script.mjs`, which reimplements the
  marking rule, so its totals are close to but not identical to the extension's;
- the rank and tokenising counts run the shipped table through the real
  fallback in `src/study/rarity.js` and the real pattern from `study.js`.

The translation half is measured over the **140 answers in the daemon's
translation cache**. Every one was written on 2 September, so that store is one
day of use, not a season of it.

## Detection: what it marks

| | |
|---|---|
| marked | 71,359 words, 0.46 a cue, 5.7 a minute |
| of them proper nouns | 24.2% |
| of them phrases | 12.1% |
| share of all words spoken | 7.8% |
| rare words a minute | median 4, worst film 58 |

Nearly a quarter of every mark is a proper noun. That is the largest single
group and it is the next thing worth attacking: `paige` is marked in 60 of the
175 films, `soviet` in 25, `pastor` in 18, `gabriel` in 16, `kgb` in 16,
`emmett` in 13. The name rule looks for a word capitalised in mid-sentence at
least half the times it appears, which a character name at the start of a line
of dialogue fails.

## Detection: two defects found and fixed

**"I'll" was one of the rarest words in English.** A contraction is ranked by
the part before the apostrophe - this is what makes "don't" as common as "don"
and "Ankara'ya" as common as "Ankara". The table's builder demanded at least two
letters, so "i" was not in it, the fallback found nothing, and "i'll" came back
unrankable. Unrankable is read as rarer than the 30,000th word. It was marked in
**150 of the 175 films**, "i've" in 113.

Single letters are in the tables now. Words the table cannot rank at all fell
from 89,698 to 19,079 - from 9.5% of every word spoken to 2.0% - and what
remains is almost entirely proper nouns and subtitle credits.

**"Soldiers--" was not a word.** Subtitles break a line off with a dash, and the
word pattern took the dash into the word. No table holds "soldiers--", so the
commonest words in the language were marked as the rarest: **827 marks** across
the corpus, on "just--" 31 times, "you--" 28, "that--" 18, "and--" 14, "the--"
9. It cost twice - the mark took one of the two places on its line, and the
answer was filed under "you--", where nothing looking up "you" will find it.
Four of the 140 cached answers are keyed that way.

A word now has to end in a letter as well as start with one.

## Detection: still open

**Subtitle credits are studied as dialogue.** 43 of the 175 files carry a line
like "Sync and corrections by n17t01 www.addic7ed.com". `www`, `addic`, `synced`
and `corrections` are all in the answer cache, so the reader has been shown
them. Small in volume, cheap to filter, and it looks like a bug to whoever sees
it.

**Proper nouns, as above.** 24.2% of marks, and the repeat list is almost
entirely character names.

**A phrasal verb behind an infinitive** was reported and fixed the same day:
"do you want to find out" marked `want out`, which is not a phrase, and hid
`find out`, which is. Over the corpus, 214 of the 5,178 separated matches span a
"to" and every one sampled was wrong.

## Translation: what the 140 cached answers say

The answers are mostly right, and demonstrably context-aware:

| word | line | answer |
|---|---|---|
| shotgun | "- See ya. Shotgun! - Bye." | ön koltuk |
| spare | "We are down to one spare engine." | yedek |
| spare | (a different line) | kıyamamak |
| rides | "You guys have rides home?" | araç |
| domestic | "from threats both foreign and domestic." | yerli |

The first four are the sense the line calls for rather than the dictionary's
first entry, which is the whole point of sending the line. The fifth is wrong:
in "foreign and domestic" the sense is internal, "iç", not "yerli" as in
domestically produced. `medic` came back "sağlamacı", which is not the Turkish
word for a medic.

Nothing came back empty, nothing came back as markup, and one answer of 140
handed the word back unchanged.

**One answer costs several calls.** The cache is keyed by word *and* line, which
is right - "spare a minute" and "a spare tyre" are different questions - but it
means `pastor` was asked eight times in one show, once per line it appeared in.
Whether that is worth changing depends on what a call costs, which is not
measured yet.

## What is not measured

**Whether telling the model which film it is watching improves the answer.** The
context was added and the measurement was attempted three times; the local model
could not be driven on this machine (load average above 50, the model unloaded
between batches) and five of fifteen batches timed out. The effect is unknown,
not small.

**Anything from a real viewing.** The `marks` record exists but no film has been
watched since. Run `node tools/study-report.mjs` after the next one.
