# Listening bench

Measures the extension's ear - `browser-extension/src/listen.js`, the shipped
file, loaded as it is - against films whose subtitle is timed to their own
picture. A subtitle carried inside a release is the one file that is known to
be right for that release's sound, so displacing it by a known amount and
asking the ear where it belongs has an answer to check against.

```bash
node bench/listen/features.mjs <media> <name> [audio index] [subtitle stream]
node bench/listen/train.mjs [--write]      # fit the speech model; --write puts it in listen.js
node bench/listen/replay.mjs               # the decision rule, as the extension applies it
node bench/listen/replay.mjs --truths 0,250,-700,1500   # a right file, and small errors
node bench/listen/replay.mjs --start-only  # one listening from each film's first frame
node bench/listen/blocks.mjs               # one block at a time: how lines are placed
node bench/listen/music.mjs                # what the ear makes of music and of the opening
```

`features.mjs` takes a film's sound the way an `AnalyserNode` sees it in
Chrome - 48kHz, a 2048-sample Blackman window every 50ms, the middle and the
sides of the stereo mix - and runs the shipped `createFeatures` over it,
writing the fifteen features of every frame to `films/<name>.f32` (and the
speech band, for the older scripts, to `films/<name>.json`), with the embedded
text subtitle as `films/<name>.srt`. `film.mjs` is what the other scripts read
a film through. A change to `createFeatures` makes every `.f32` stale: run
`features.mjs` on each film again, then `train.mjs --write`.

`train.mjs` fits the speech model - a logistic regression on the features and
their squares - with each film's own subtitle as the label: a frame inside a
line is speech, a frame a second or more from any line is not, anything
between is left out, and so is a line that only describes a sound
("[door opens]", "(footsteps walking)"). It reports each film held out of its
own fit, by frame AUC and by how many 60-second windows `placeLines` puts
within 300ms, and `--write` fits on the films `training.txt` names and
replaces what is between `/* model:begin */` and `/* model:end */` in
`listen.js`. Every other film is a test: the model meets it as it ships, and
the report marks it `test`. `replay.mjs` measures the model that ships, on the
films it was fitted on and on the tests.
`films/` is gitignored: the subtitle is the film's text, and the levels are its
sound. The audio index counts audio streams (`0:a:N`); the subtitle is an
absolute stream number (`0:N`), because a release's first subtitle stream is
often a picture-based one that cannot be read as text.

`replay.mjs` starts a listening every `--every` minutes (5) and lets it run for
`--minutes` (20), with the subtitle displaced by each of `--truths`. A run is
right when what was applied by the end is within 300ms of the displacement, and
"never" when nothing was applied and the subtitle was still more than 300ms
out. `--whole` listens from the first frame to the last instead. `--slow 0.1` makes
the subtitle's clock run 0.1% slow as well as displaced, and `--no-rates` keeps
the ear to offsets, for the comparison. A film with a
`<name>.truth.json` has a subtitle from another release and is measured only
when named; the file gives where its lines belong as `offsetMs` plus
`msPerMinute` for every minute in.

## What it said on 2026-10-25, with the learned detector

Ten films fitted: three episodes of a 2026 web series, and seven feature
films from 1990 to 2024, one of them (Flow) without dialogue. Eleven more are
tests, never fitted: five first episodes of series from 2003 to 2020 (one with
hearing-impaired subtitles marking a fifth of its lines as sounds), and six
films from 2005 to 2025, one of them in Japanese with English subtitles.

The detector first. Held out of its own fit, the nine fitted films with
dialogue score a frame AUC of 0.798 to 0.956, and the eleven tests 0.831 to
0.899; Flow has no line that is not a sound, so nothing to score. The
hand-written rule it replaced - band above a running floor, centred, syllabic
- scored 0.621 to 0.740 on the first nine (Flow 0.587), counted with sound
lines as speech (the rule is `listen.js` at 533bff7).

The ten were first fitted with sound lines as speech, Flow's 255 of them
included. Leaving them out moved the tables below by a few listenings, all
the same way: 427 right of the 477 displaced where it had been 423, 602 of
636 where it had been 600, 28 of 30 from the first frame where it had been
27, and no right file moved. Fitting on all twenty-one instead was worse, and
all of it on one film: Love Actually, where three of 24 listenings of a right
file moved it by 400 to 500ms and ten displaced ones landed 300 to 500ms out.
So the eleven stay tests.

Then the decision, with one-minute blocks, two of them agreeing with the last
six (`--block-s`, `--agree` and `--recent` sweep these):

| Listenings | Right (300ms) | Within 500ms | Wrong | Never | First apply p50 / p90 |
|---|---|---|---|---|---|
| displaced by -21.35s, +4s, +37.2s (477) | 427 | 1 | 0 | 49, 31 of them Flow | 2.0 / 8.0 min |
| displaced by 0, +250ms, -700ms, +1.5s (636) | 602 | 0 | 0 | 34 | 3.0 / 10.0 min |
| not displaced (159) | 159 | 0 | 0 | - | one moved it |
| the tests, displaced by the first three (456) | 452 | 4 | 0 | 0 | 2.0 / 6.0 min |
| the tests, displaced by the second four (608) | 605 | 2 | 0 | 1 | 2.0 / 7.0 min |
| the tests, not displaced (152) | 152 | 0 | 0 | - | none moved |

The one that moved a right file was Goodfellas from its 105th minute: 400ms at
the 107th, back at the 110th. From each film's first frame (`--start-only`,
30 listenings) 28 applied the right shift, none a wrong one, and the first
correction came a median 2.1 minutes after the first line, 8.5 at p90 - the
two that never applied are Flow, and its third, right at the eleventh minute,
is the p90. The 33 from the tests' first frames were all right, 3.4 minutes
after the first line at the median, 6.7 at p90. The rule of thumb on two-minute blocks, run
the same way (the detector of 533bff7 over the `.json` levels), was right on 21,
never applied on 6 and took 4.0 minutes at the median, 6.0 at p90.

The block length was chosen on those columns. Every length from 30 seconds to
two minutes was run with two, three and four blocks agreeing: 30 seconds at
two blocks was the only one with wrong answers (six displaced, two on a right
file), more blocks agreeing
never gained a right answer and always cost minutes, and two-minute blocks
decided at a median 4.0 minutes from the start against 2.1.

Placing a line by its first part and then by the whole lands 766 of 914
two-minute blocks within a second (`blocks.mjs`), and 841 of the tests' 900;
by the whole alone, 739 and 814. The
rule of thumb gave 722 and 635.

A drift (`--whole --truths 4000 --slow 0.1`): the nine films with dialogue were
on screen within 300ms for 61.3% to 94.8% of their length, within a second for
81.2% to 98.1%, every one given 24 against 23.976 (1.001). Made for 25 frames
against 23.976 (`--slow 4.096`): seven of the nine were stretched by exactly
that conversion, after which 63.0% to 94.5% of each film was within 300ms; Love
Actually and Matrix were left as they were, nothing applied. The other way
round, made for 23.976 and played at 25 (`--slow -4.271`), eight of nine, 67.9%
to 94.7%, Love Actually left. Of the eleven tests made for 25 frames, nine,
49.3% to 93.9%; Saving Hope and Batman Begins were left, and Batman Begins is
the one the refit lost - the model fitted with sound lines as speech took it
and kept it 82.9% within 300ms. A conversion is judged on four two-minute
stretches whatever the block length. Read off the one-minute blocks
themselves, six of them each agreeing, it was five of nine both ways - the one
column the shorter block had lost on - and every other table here is the same
to the line under both.

`la-tigole` is one release of Love Actually against the subtitle of another,
the case the ear exists for. Its `.truth.json` says where that subtitle
belongs: a straight line through the blocks' answers from -22.9s, 59ms later
every minute - the two releases differ by 0.098% in speed, which is 24 against
23.976 frames a second. Heard from the first minute to the last
(`--whole --truths 0 la-tigole`) the ear fitted that rate, took it as 1.001,
and kept the subtitle within 300ms for 87.7% of the film and within a second
for 94.8%. The rule of thumb kept it 79.2% and 88.0%; offsets alone, 5.6% and
62.8%.

**Music.** `music.mjs` gives the mean speech probability inside a line, five
seconds or more from any line (music, effects, silence, unsubtitled speech),
and over the opening before the first line:

| Film | In a line | Far from lines | Opening (min) | Opening |
|---|---|---|---|---|
| fightclub | 72.0% | 36.1% | 2.1 | 20.8% |
| flow | 48.3% | 32.8% | 2.1 | 12.6% |
| goodfellas | 82.4% | 40.3% | 1.0 | 9.0% |
| loveactually | 65.0% | 29.8% | 1.6 | 18.5% |
| matrix | 67.1% | 30.0% | 0.8 | 13.4% |
| nsfw-e01 | 85.3% | 17.9% | 0.3 | 7.8% |
| nsfw-e03 | 87.4% | 18.6% | 0.3 | 4.9% |
| nsfw-e07 | 85.9% | 14.6% | 0.2 | 7.9% |
| onceupon | 82.0% | 27.9% | 0.0 | - |
| truman | 72.4% | 33.9% | 0.3 | 0.0% |

What is far from any line - music, effects, silence - is heard as less likely
speech than a line on every film with dialogue, by 35 to 71 points, and the
openings sit lower still. It is not heard as nothing: a
probability of 0.3 over a song is what the decision rule has to survive, and
the listenings from each film's first frame, which begin on those openings,
are the measurement that it does - none of the 30 applied a wrong shift, nor
any of the tests' 33.

## What it cannot hear from the element

Chrome refuses `captureStream()` for a video whose data comes from another
origin without CORS ("SecurityError: Failed to execute 'captureStream' on
'HTMLMediaElement': Cannot capture from element with cross-origin data") and
for one with MediaKeys ("NotSupportedError: ... Stream capture not supported
with EME"), both observed in Chrome; the second was Shaka playing Widevine,
2026-10-23. A player that streams through Media Source Extensions without DRM
(hls.js, dash.js, Shaka) fetches its own data and can be heard.

Both are heard from the tab instead, after the reader presses the extension's
button on it (`browser-extension/src/tab-ear.js`). Nothing here replays that
path - the bench reads decoded films, not a browser - and what is known about
it is from Chrome: the tab capture of the Widevine film read the same levels
as `captureStream()` of the clear copy (300-3400Hz median -65.9dB against
-67.4dB), and against the frames clip's known tone envelope the tab's sound
reached its analyser 45ms and 70ms later than the element's copy reached the
page's, in two runs. The extension takes 50ms off every tab reading for that.
The offscreen document first read its analysers on a timer, which fired 4 to
126ms apart (median 57, p90 102); replayed over the three episodes with the
features read at those gaps, 72.9% of the frames were heard, every answer was
still right, and the first correction came a median 4.1 minutes in against
2.0. The windows are now cut on the audio thread (`ear-tap.js`): 600 readings
in every 30 seconds of six runs, 49.8ms apart at the median, and the capture
60 to 80ms behind the element's copy in four of them and 35 to 40ms ahead in
two.
