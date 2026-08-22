---
title: What five days of the running log say
eyebrow: Log review
date: 2026-08-22
audience: Maintainer
summary: Every open question closed against the running log rather than argued, and one recommendation for what to build next - drawn from the 438 things the extension actually said to the reader over five days of viewing.
---

> [!TLDR]
> **Nearly a third of everything this extension says to the reader is the reader
> fixing the sync by hand.** 138 of 438 messages, 29 gestures, five days.
>
> - The aligner is not the problem. It answered `apply` on 43 of 70 attempts,
>   median coverage 1.00.
> - At the moment of correction the two subtitles were routinely showing
>   **different lines of dialogue** while both reported a cue on screen. The pair
>   is lined up with itself and out against the film.
> - Nothing in the extension measures where the film's dialogue actually is. That
>   gap is what the hand is filling, 29 times in five days.
> - Recommendation: spend half an hour finding out whether the player's audio is
>   readable. If it is, `alignSteps()` already does the rest.

This is a **teaching** document, not a reference: it is ordered as the questions
came up, and each section raises the next one. The question-by-question answers
you asked for are collected in the last section, which *is* a reference.

The source is `subtitle-daemon/logs/*.jsonl` - 3,596 entries over 2026-08-11 to
2026-08-17, none unparseable. Everything below is counted from it.

## What does the extension spend its breath on? {#census}

`said` is the extension's entire error and status surface - every toast the
reader sees. There are 438 of them, and they are not evenly spread.

```oku-chart
{"type":"bar","title":"What the extension said, 5 days (438 messages, numbers folded to N)","rows":[{"label":"Subtitle N held back N.Ns","value":104,"display":"104"},{"label":"Looking for subtitles…","value":55,"display":"55"},{"label":"Subtitle N on - EN · the.americans","value":36,"display":"36"},{"label":"Subtitle N held back Ns","value":34,"display":"34"},{"label":"Subtitles will come on by themselves","value":24,"display":"24"},{"label":"Subtitle N on - TR · The.Americans","value":19,"display":"19"},{"label":"Study mode on","value":11,"display":"11"},{"label":"not certain - use Line up on its card","value":10,"display":"10"},{"label":"Subtitle drifting N.N% fast","value":9,"display":"9"},{"label":"Nothing matched … well","value":5,"display":"5"}]}
```

The top line and the fourth are the same event at two precisions: the toast shown
when a subtitle is moved by hand. Together they are **138 of 438, 31.5%**. Nothing
else in the log comes close - the second-placed message is the search starting.

That is a lot of hand-correcting for a tool whose aligner is supposed to have
already done it. So the obvious next question is whether the aligner is failing.

## Is the aligner failing, then? {#aligner}

No. It ran 70 times and refused only three.

```oku-chart
{"type":"bar","title":"70 alignment attempts, by verdict","rows":[{"label":"apply (took it silently)","value":43,"display":"43"},{"label":"offer (asked first)","value":24,"display":"24"},{"label":"no (refused)","value":3,"display":"3"}]}
```

Median coverage across all 70 was **1.00** and median confidence **11.64**, against
an auto threshold the code sets far below that. Twelve answers carried a
staircase rather than a single shift - five with one act, seven with two - and
both recorded outcomes were `taken`, both two-act. So acts are real, they reach
readers, and readers accept them.

Timing memory works too: on the three sites where the reader actually watches,
**72% to 84% of attaches** arrived with the timing already known from last time.

| Host | Attaches | Timing remembered |
|---|---:|---:|
| streaming-site.example | 73 | 53 (72%) |
| streaming-site-2.example | 25 | 21 (84%) |
| streaming-site-3.example | 5 | 4 (80%) |
| 127.0.0.1 (test vehicles) | 44 | 0 (0%) |

So the machine is doing its job and the hand is still needed. What is it
correcting?

## What was on screen when the hand moved? {#moment}

Every by-hand correction writes a `sync` record carrying, for each attached
subtitle, the cue under the playhead: its index, its text, and how far the
playhead was from it. That last field, `awayMs`, was meant to answer "was the
other subtitle already right?".

**It cannot.** `awayMs` is 0 whenever a cue is on screen, which says nothing
about whether it is the *correct* cue. Here are the five corrections larger than
three seconds, with what each subtitle was showing at that instant:

```oku-table
{"headers":["Gesture","On screen, subtitle 1 (EN)","On screen, subtitle 2 (TR)","Same line?"],"rows":[["drag slot 0 **+4523ms**","i=54 · \"Emmit Conners died at the age of four\"","i=75 · \"KGB'den ortağı da Leanne Riley'nin…\"","**no** - 21 cues apart"],["drag slot 1 **+4656ms**","i=54 · \"Emmit Conners died at the age of four\"","i=73 · \"Emmett Connors, rakun ısırığından…\"","yes - this is the fix landing"],["drag slot 0 **+4376ms**","i=162 · \"Anecdotal.\"","i=174 · \"Doksan altı!\"","**no** - 12 cues apart"],["drag slot 1 **+11406ms**","i=241 · \"Is Sandra home?\"","i=235 · \"Pek bir şey yok, sende?\"","**no** - 6 cues apart"],["drag slot 1 **-6216ms**","i=244 · \"No.\"","i=237 · \"Yok, daha gelmedi.\"","**no** - 7 cues apart"]]}
```

Both subtitles reported `awayMs: 0` on four of those five rows. Both had a line
on screen. The lines were different lines.

Row two is the interesting one: it is the same reader, four seconds after row
one, moving the *other* subtitle onto the line the first one had just been moved
to. Two gestures to fix one thing.

Five further corrections happened where the other subtitle had **no cue within
11 to 30 seconds** - the scenes where The Americans burns its Russian dialogue
into the picture and the English file goes quiet. Those are genuinely one-sided
and the hand is the only available answer.

So the pair is usually lined up with *itself*, and out against the *film*. Which
raises the question of whether last week's change already covers it.

## Does "the first subtitle leads" already fix this? {#lead}

Partly, and less than row two above suggests. Nine of the 29 gestures were a
second correction on the other subtitle within two minutes. Carrying the lead's
move to the follower would have left these residuals:

```oku-chart
{"type":"bar","title":"Residual left on the follower if the lead's move had carried (ms, absolute)","rows":[{"label":"+4523 then +4656","value":133,"display":"133 ms - collapsed"},{"label":"-716 then -789","value":73,"display":"73 ms - collapsed"},{"label":"+74 then +1683","value":1609,"display":"1,609 ms"},{"label":"-2807 then +67","value":2874,"display":"2,874 ms"},{"label":"+4376 then -404","value":4780,"display":"4,780 ms"},{"label":"+4656 then -716","value":5372,"display":"5,372 ms"},{"label":"-943 then +4523","value":5466,"display":"5,466 ms"},{"label":"-702 then +11406","value":12108,"display":"12,108 ms"}]}
```

Two pairs collapse to nothing - 133ms and 73ms are below anything a reader would
chase. The rest do not: they are independent corrections that happen to be
adjacent in time, and under the new model the lead's move now drags the follower
through them as well.

**That is untested against real use.** The change landed on 2026-08-17 and the
log ends on 2026-08-17. The honest position is that it banks two of 29 gestures
for certain and changes the behaviour of seven more in a direction nobody has
observed yet.

## So what is actually missing? {#missing}

There are two alignments in this system and only one of them is measured.

```oku-diagram
{"src":"flowchart LR\n    subgraph measured [\"measured, and working\"]\n    A[\"subtitle 1<br/>cue start times\"] <-->|\"align / alignSteps<br/>43 of 70 applied<br/>median coverage 1.00\"| B[\"subtitle 2<br/>cue start times\"]\n    end\n    subgraph unmeasured [\"not measured by anything\"]\n    P[\"the pair, as one\"] <-->|\"the reader's ear<br/>29 gestures in 5 days\"| F[\"the film's own dialogue\"]\n    end\n    measured --> unmeasured","caption":"The aligner answers where two subtitle files sit relative to each other. Where the pair sits relative to the film is supplied by a human hand on a 180px strip."}
```

`align()` and `alignSteps()` take two lists of cue start times and return an
offset, a rate, a confidence and a staircase of acts. They are indifferent to
where those lists came from. If one of the two lists were **speech onsets
detected in the film's own audio**, the same function would return the absolute
anchor, with the same confidence gate and the same act handling already
benchmarked over 137 pairs.

The missing piece is therefore not alignment. It is one list of numbers.

### The recommendation

**Spend thirty minutes establishing whether the audio is readable, before
building anything.** All 29 corrections happened on `streaming-site.example`, a
cross-origin player. `AudioContext.createMediaElementSource()` on a cross-origin
media element without permissive CORS yields silence rather than an error, so
this either works or is a dead end, and which one is a fact about those specific
players that I have not tested.

- **If the audio is readable** - build the onset detector and feed `alignSteps()`.
  Everything downstream exists. This removes the gesture rather than making it
  cheaper.
- **If it is not** - make the ear cheaper to spend instead of the hand: one
  keystroke meaning *"the line I am hearing starts now"*, which snaps the nearest
  cue onto the playhead. The reader's ear is the only ground truth this tool ever
  gets about the film, and today expressing it costs a drag on a 180-pixel strip
  and a visual check.

**Either way, the free thing first:** next week's log now has a real before. 29
gestures over five days, on a named site, with a known message mix. Re-run this
count after the lead-carries-follower change has had a week of use - it is the
first change here with a measurable baseline.

## The other questions, answered {#answers}

Reference section. Each of these was left open in an earlier session.

```oku-table
{"headers":["Question","Answer","How it was established"],"rows":[["How many subtitle lines are ever on screen at once?","**At most three.** Across all 180 files, 138 never overlap, 35 peak at one extra line, 7 peak at two. Longest single cue is 231.7s.","Swept the corpus counting cues whose start falls inside another cue's span. The original sweep over every .srt under ~ was killed; this one is scoped to the 180 files the extension actually reads."],["Does the second subtitle land *mistimed* or *missing*?","**Missing, when it fails at all.** 41 of 46 tab-days attached both slots, 5 attached only slot 0. No attach ever landed with zero cues. Separately the pair is often mutually out - see above - which is the other reading of \"not correctly\".","147 attach records grouped by tab and day."],["Are acts reaching real sessions?","**Yes.** 12 of 70 aligner answers carried a staircase (5 one-act, 7 two-act) and both recorded outcomes were `taken`, both two-act. Two outcomes is a thin sample.","align and alignOutcome records."],["Is `sso:setOffset` in content.js dead?","**Yes.** The handler at content.js:5598 is the only occurrence anywhere in src/ or tests/. Nothing sends it.","Grep across the whole extension."],["Does the movies server bind to the network?","**Not as it runs.** The live process is bound to `127.0.0.1:5173`. The exposure is latent, not live: the project depends on `@sveltejs/adapter-node`, which defaults to `0.0.0.0`, so `node build` would publish it. Set `HOST=127.0.0.1` before it is ever run that way.","`lsof -nP -iTCP:5173 -sTCP:LISTEN` plus the package.json dependency list."],["Should a bare `♪♪` be hidden along with `_`?","**Still yours to decide.** It is dropped today. Music *with* lyrics is untouched.","Shipped in 576950b; one line to reverse."]]}
```

## Two things about the log itself {#log-hygiene}

Neither is urgent; both are cheap.

**The error channel is 100% noise.** All 16 `error` entries in five days are
`ResizeObserver loop completed with undelivered notifications`, a benign browser
warning. A real error would land in a stream that a reader has learned to ignore.

**The perf sampler records every tab, not every viewing.** 1,446 of 3,596 entries
are `perf`, and **1,424 of them are from tabs with nothing attached** - claude.ai,
YouTube, Google Notebook. Each carries the tab's title and URL, so five days of
log is also five days of browsing history. It is gitignored and untracked, so
this is a local-tidiness point rather than a leak.

The measurement those records exist for is already settled and still holds: our
share of long-task time is **0.07%** across all 1,446 windows. Restricted to the
19 windows with a subtitle attached it is 8.26% of 13 seconds - too small a
sample to mean much, and worth re-reading once the sampler is narrowed.
