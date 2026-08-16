---
title: The episode that needed five corrections
summary: Why the sync on The Americans S02E09 had to be fixed several times, measured on the files themselves - and what it says about an aligner that answers with one number.
---

> [!TLDR]
> The two releases of that episode do not differ by a delay. They differ by a **staircase**: six plateaus, five jumps, 30.55 seconds from end to end. No single shift and no single rate can cover it, so a viewer has to correct it once per plateau.
>
> - The same staircase was measured twice over, in Turkish and in English, by different subtitlers. It is a property of the **video releases**, not of any subtitle.
> - `align.js` answers this pair with one number at confidence 61 and verdict **apply**. That number is right to within a second over 15 of the 50 minutes where a shift can be measured, and out by more than two seconds over 35 of them.
> - The English/Turkish gap is a second, unrelated problem, and it is content: 12% of the English lines are sound descriptions with no Turkish counterpart, and one Turkish line in four merges two English ones.
> - Nothing recorded any of the corrections while they were being made. That is fixed - every by-hand correction now writes down where it was, how large it was, and which line was on screen.

This is a teaching document, not a reference: it follows the question a viewer
would ask, in the order they would ask it. The numbers behind every claim come
from `bench/align/piecewise.mjs`, which is in the repository and re-runnable.

## Why did one episode need correcting several times? {#question}

The obvious answer - "the subtitle was late" - predicts one correction. A delay
is a constant. You find it once, you take it out, and it stays out for the rest
of the film. Two corrections would mean the file drifts, which is a rate, and a
rate is also fixed once.

Neither shape produces *several* corrections at different points. So before
touching any code the first question is what the relationship between these two
files actually is, and the way to find out is to stop asking for one answer.

`piecewise.mjs` cuts the film into windows and finds the best shift inside each
window on its own. Three shapes come out, and they need three different fixes:

```oku-table
{"headers":["What the column looks like","What it means","What fixes it"],"rows":[["Flat","One shift is right for the whole film","An offset. The aligner just has to find the right peak."],["Sloped","The two files run at different speeds","A rate. No offset can ever fix it - it is right in one place and wrong everywhere else."],["Stepped","The two files are **cut** differently","Neither. Every plateau needs its own number."]]}
```

## What the measurement says {#staircase}

The Americans S02E09 has three Turkish subtitles on OpenSubtitles. All three
carry the same 533-line translation, by the same translator, re-timed for a
different release. Comparing two of them isolates the release difference with
nothing else in the way - the words are identical, so any disagreement is
timing and only timing.

```oku-chart
{"type":"line","title":"WEB-DL against HDTV, measured independently in two languages","x_label":"minute of the episode","y_label":"shift needed, seconds","series":[{"label":"Turkish pair (3630184 / 3630754)","color":"accent","data":[{"x":0,"y":1},{"x":2,"y":5.3},{"x":4,"y":5.3},{"x":8,"y":11.85},{"x":10,"y":11.85},{"x":12,"y":11.85},{"x":14,"y":11.85},{"x":16,"y":11.85},{"x":18,"y":18.8},{"x":20,"y":18.8},{"x":22,"y":18.8},{"x":24,"y":18.8},{"x":26,"y":18.8},{"x":28,"y":24.8},{"x":30,"y":24.8},{"x":32,"y":24.8},{"x":34,"y":24.8},{"x":36,"y":30.55},{"x":38,"y":30.55},{"x":40,"y":30.55},{"x":44,"y":30.55}]},{"label":"English pair (3630038 / 3629971)","color":"warn","data":[{"x":6,"y":5.29},{"x":8,"y":11.8},{"x":10,"y":11.85},{"x":14,"y":11.65},{"x":20,"y":18.76},{"x":22,"y":19},{"x":24,"y":18.86},{"x":26,"y":18.7},{"x":32,"y":24.99},{"x":34,"y":24.9},{"x":40,"y":30.66},{"x":44,"y":30.61}]}]}
```

Every Turkish window in that chart matched **100%** of its lines - the shift is
not an estimate with error bars, it is the number at which every line in the
window lands on a line in the other file.

The English pair is the check that matters. Two different subtitlers, a
different language, 725 and 728 lines against the Turkish 533, and it produces
the same six plateaus to within 250 milliseconds. Two independent measurements
of the same quantity agreeing is what makes this a property of the **video**
rather than of anybody's subtitle.

**Why this matters:** a viewer moving between these two releases has to make
five corrections, of 4.30s, 6.55s, 6.95s, 6.00s and 5.75s, and no amount of
work on a one-number aligner will reduce that to fewer than five.

### It is not one episode {#s02e04}

S02E04 has three Turkish files for three releases, same translation again:

```oku-table
{"headers":["Pair","Plateaus","Total","What align.js says"],"rows":[["S02E09 · HDTV vs WEB-DL","1.00 → 5.30 → 11.85 → 18.80 → 24.80 → 30.55","30.55s","**apply**, 11.85s, confidence 61.5"],["S02E04 · HDTV vs WEB-DL","0.85 → 5.95 → 10.60 → 15.55 → 20.15","20.15s","**apply**, 5.38s, confidence 62.1"],["S02E04 · HDTV vs DVDRip","1.80 → 4.20 → 8.60 → 11.00 → 13.80","13.80s","**apply**, 4.20s, confidence 65.4"]]}
```

Five and four jumps, of four to seven seconds each. That size and count is what
a US network drama's act breaks look like, and two of the five S02E09
transitions are bracketed inside the file's two longest silences - 143 seconds
at 06:41 and 34 seconds at 18:38. **This part is an inference from the shape,
not an observation**: I have not compared the two video files, only the
subtitles timed against them. The remaining transitions are bracketed to within
a minute, which is not tight enough to name the silence they sit in.

## What our aligner does with a stepped pair {#aligner}

It answers. Confidently. With one number.

```oku-chart
{"type":"bar","title":"S02E09 Turkish pair: what align.js's single 11.85s answer is worth","rows":[{"label":"minutes where it is right to within 1s","value":15,"display":"15 min"},{"label":"minutes where it is out by more than 2s","value":35,"display":"35 min"}]}
```

The verdict is `apply`, not `offer` - the threshold that exists to stop exactly
this is a coverage gate, and coverage here is 0.39, comfortably above it. The
gate is doing its job: it is designed to catch a *wrong peak*, and this is not
a wrong peak. 11.85 seconds is the correct shift for the third plateau, which
happens to be where most of the votes are. There is no defect in the search.
The defect is in the shape of the answer.

> [!IMPORTANT]
> A single shift is not right or wrong. It is right over part of the film and
> wrong over the rest, and the fraction is what the viewer experiences. Nothing
> in the extension has ever reported that fraction, so an answer that covers a
> third of an episode and an answer that covers all of it look identical from
> the outside - both arrive as one number with a confidence beside it.

### The one case it gets exactly right {#same-timeline}

The English 2HD file and the Turkish 2HD file line up at **0 milliseconds**,
coverage 0.96, confidence 371. The Turkish subtitle was built on that English
one and inherited its timing exactly. So when both subtitles come from the same
release, today's aligner is not merely adequate, it is precise - and that is
worth protecting, because it is the case that any future piecewise aligner must
not make worse.

## Is the language gap a separate problem? {#languages}

Yes, and it is content rather than a defect. With the timeline difference
removed - the 2HD pair above, which shares a clock exactly - the two files can
be compared line by line:

```oku-chart
{"type":"bar","title":"How 725 English lines map onto 533 Turkish lines","rows":[{"label":"one Turkish line covering one English line","value":413,"display":"413"},{"label":"one Turkish line covering two English lines","value":114,"display":"114"},{"label":"English lines with no Turkish line at all","value":88,"display":"88 - all sound descriptions"},{"label":"one Turkish line covering three","value":3,"display":"3"},{"label":"Turkish lines with no English line","value":3,"display":"3 - the credit and the title card"}]}
```

The 88 are `[ Laughter ]`, `[ Brakes hiss ]`, `[ Engine idling ]` - the English
file is a hearing-impaired transcript and the Turkish one is not. For a matcher
that votes on cue **start times** those 88 are pure noise, and the 114 merges
mean a quarter of the remaining lines start at a time the other file has no
reason to share.

That is the whole of why cross-language coverage on this series runs at 0.25
while same-timeline coverage runs at 0.96. It is not something to fix in the
aligner. It is a reason to prefer a same-language reference when one exists,
and a reason not to read a low coverage as a bad file.

## Why we could not have known {#blind}

Nothing recorded the corrections. The offset is a single number that the next
correction overwrites; the list the drift estimator keeps lives in memory and
dies with the tab. So the one measurement this extension ever gets that is
grounded in a human ear - *at this moment, this line is this far out* - was
being thrown away every time it was made.

Five corrections in an episode is five measurements of the true offset at five
points in the film. That is precisely the data needed to see a staircase, and
it was the data being discarded.

Every by-hand correction now writes a `sync` line to the daemon log:

```oku-table
{"headers":["Field","What it carries","Why it is there"],"rows":[["`how`","key, drag, typed, reset, command","A drag aimed at a picture and a keystroke held down are different acts with different accuracy."],["`streamMs` / `fileMs`","where in the film, and where in this subtitle's own clock","Two clocks. The gap between them is the thing being corrected."],["`fromMs` / `toMs` / `byMs`","the offset before and after","A correction is a measurement of a change, not of a state."],["`tracks[].cue`","for **every** attached subtitle: cue index, its time in its own file, how far the playhead was from it, and its first 90 characters","The number alone cannot be replayed against a file on another machine. The text can. And whether the *other* subtitle was already right at that moment separates \"this file is out\" from \"these two disagree\"."]]}
```

One gesture is one record. A drag used to call `setOffset` on every pointer
move - about sixty times for a deliberate aim - which would have written the
same line sixty times, and was already filling the drift estimator's eight-deep
memory with points at a single instant.

## What to change, in order {#changes}

Stated as recommendations, separately from the evidence above.

```oku-step-flow
{"steps":[{"t":"Snap a correction to local agreement","b":"When a correction is made, the right number is almost always the one that makes the nearby lines of the two subtitles coincide. Searching a few seconds around where the hand landed and settling on that peak turns an approximate drag into an exact one. It does not need a new aligner, it does not guess, and it makes each of the five corrections land first time. This is the smallest change with the largest effect on the reported experience."},{"t":"Say what a single shift covers","b":"The aligner already knows which cues voted for the answer it gives. The share of the film those votes span is a number it can report, and 'this covers the middle third' is a different sentence from 'these look 11.85s apart'. It costs nothing, and it stops a stepped pair from arriving disguised as a solved one."},{"t":"Segment when the votes say so","b":"A stepped pair shows up in the vote histogram as several peaks of comparable weight rather than one. Splitting the film at the widest silences and aligning the segments independently is what alass does with its split penalty, and the measurement above says the breaks fall at scene boundaries, which is a strong and cheap constraint. This is the real fix and the largest piece of work."},{"t":"Prefer a reference from the same release","b":"When two subtitles come from the same release the answer is exact - 0ms at coverage 0.96. The release name is already in the label. Ranking a search result by whether it agrees with a subtitle already attached, rather than only by title match, would have avoided this episode entirely."}]}
```

> [!NOTE]
> One thing this document cannot say is which files were actually on screen
> during the session that prompted it. The daemon was not running, so there is
> no record. The English file the extension ranks first for this episode
> (`the.americans.s02e09`, match score 0.75, the auto-attach threshold exactly)
> belongs to none of the three timing families measured here - while the
> 57,000-download WEB-DL file scores 0.625 and is not auto-attached. That is
> worth a look on its own, and it is a hypothesis, not a finding.
