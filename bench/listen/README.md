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
between is left out. It reports each film held out of its own fit, by frame
AUC and by how many 60-second windows `placeLines` puts within 300ms, and
`--write` fits on every film and replaces what is between `/* model:begin */`
and `/* model:end */` in `listen.js`. `replay.mjs` then measures the model
that ships, and the films it was fitted on are the films it is measured on;
the held-out report is the check that this is not all it knows.
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

## What it said on 2026-10-23, with the learned detector

Ten films: three episodes of a 2026 web series, and seven feature films from
1990 to 2024, one of them (Flow) without dialogue.

The detector first. Held out of its own fit, the nine films with dialogue
score a frame AUC of 0.794 to 0.953 (Flow 0.648); the hand-written rule it
replaced - band above a running floor, centred, syllabic - scored 0.621 to
0.740 (Flow 0.587), counted the same way (the rule is `listen.js` at 533bff7).

Then the decision, with one-minute blocks, two of them agreeing with the last
six (`--block-s`, `--agree` and `--recent` sweep these):

| Listenings | Right (300ms) | Within 500ms | Wrong | Never | First apply p50 / p90 |
|---|---|---|---|---|---|
| displaced by -21.35s, +4s, +37.2s (477) | 423 | 1 | 0 | 53, 33 of them Flow | 2.0 / 8.0 min |
| displaced by 0, +250ms, -700ms, +1.5s (636) | 600 | 0 | 0 | 36 | 3.0 / 10.0 min |
| not displaced (159) | 159 | 0 | 0 | - | one moved it |

The one that moved a right file was Goodfellas from its 105th minute: 400ms at
the 107th, back at the 110th. From each film's first frame (`--start-only`,
30 listenings) 27 applied the right shift, none a wrong one, and the first
correction came a median 2.1 minutes after the first line, 6.0 at p90 - the
three that never applied are Flow.

The block length was chosen on those columns. Every length from 30 seconds to
two minutes was run with two, three and four blocks agreeing: 30 seconds at
two blocks was the only one with wrong answers (six displaced, two on a right
file), more blocks agreeing
never gained a right answer and always cost minutes, and two-minute blocks
decided at a median 4.0 minutes from the start against 2.1.

Placing a line by its first part and then by the whole lands 766 of 914
two-minute blocks within a second (`blocks.mjs`); by the whole alone, 737. The
rule of thumb gave 722 and 635.

A drift (`--whole --truths 4000 --slow 0.1`): the nine films with dialogue were
on screen within 300ms for 61.3% to 94.3% of their length, within a second for
81.2% to 98.1%, every one given 24 against 23.976 (1.001). Made for 25 frames
against 23.976 (`--slow 4.096`): five of the nine were stretched by exactly
that conversion, after which 54.0% to 93.1% of each film was within 300ms; Love
Actually, Matrix, the first episode and Truman were left as they were, nothing
applied. With two-minute blocks it was seven of nine, and that is the one
column the shorter block loses on.

`la-tigole` is one release of Love Actually against the subtitle of another,
the case the ear exists for. Its `.truth.json` says where that subtitle
belongs: a straight line through the blocks' answers from -22.9s, 59ms later
every minute - the two releases differ by 0.098% in speed, which is 24 against
23.976 frames a second. Heard from the first minute to the last
(`--whole --truths 0 la-tigole`) the ear fitted that rate, took it as 1.001,
and kept the subtitle within 300ms for 86.2% of the film and within a second
for 94.8%. The rule of thumb kept it 79.2% and 88.0%; offsets alone, 5.6% and
62.8%.

**Music.** `music.mjs` gives the mean speech probability inside a line, five
seconds or more from any line (music, effects, silence, unsubtitled speech),
and over the opening before the first line:

| Film | In a line | Far from lines | Opening (min) | Opening |
|---|---|---|---|---|
| fightclub | 73.4% | 38.7% | 2.1 | 23.4% |
| flow | 50.9% | 35.0% | 2.1 | 14.3% |
| goodfellas | 83.3% | 42.3% | 1.0 | 11.0% |
| loveactually | 66.5% | 31.6% | 1.6 | 20.5% |
| matrix | 68.5% | 32.3% | 0.8 | 15.0% |
| nsfw-e01 | 86.1% | 19.0% | 0.3 | 8.4% |
| nsfw-e03 | 88.1% | 20.2% | 0.3 | 5.8% |
| nsfw-e07 | 86.6% | 15.6% | 0.2 | 8.4% |
| onceupon | 82.8% | 29.6% | 0.0 | - |
| truman | 73.6% | 35.8% | 0.3 | 0.0% |

What is far from any line - music, effects, silence - is heard as less likely
speech than a line on every film with dialogue, by 35 to 71 points, and the
openings sit lower still. It is not heard as nothing: a
probability of 0.3 over a song is what the decision rule has to survive, and
the listenings from each film's first frame, which begin on those openings,
are the measurement that it does - none of the 30 applied a wrong shift.

## What it cannot hear

Chrome refuses `captureStream()` for a video whose data comes from another
origin without CORS - observed, "SecurityError: Failed to execute
'captureStream' on 'HTMLMediaElement': Cannot capture from element with
cross-origin data". Encrypted media is expected to be refused too, and has not
been observed here yet; the first `listenEar` line from such a site will say
what Chrome does. Every streaming service that sells films encrypts them;
on those the page usually carries its own subtitles, timed to the picture,
which is better than anything heard. A player that streams through Media
Source Extensions (hls.js, dash.js, Shaka without DRM) fetches its own data
and can be heard.
