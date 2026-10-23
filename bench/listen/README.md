# Listening bench

Measures the extension's ear - `browser-extension/src/listen.js`, the shipped
file, loaded as it is - against films whose subtitle is timed to their own
picture. A subtitle carried inside a release is the one file that is known to
be right for that release's sound, so displacing it by a known amount and
asking the ear where it belongs has an answer to check against.

```bash
node bench/listen/features.mjs <media> <name> [audio index] [subtitle stream]
node bench/listen/replay.mjs               # the decision rule, as the extension applies it
node bench/listen/replay.mjs --truths 0,250,-700,1500   # a right file, and small errors
node bench/listen/blocks.mjs               # one block at a time: how lines are placed
```

`features.mjs` takes a film's sound the way an `AnalyserNode` sees it in
Chrome - 48kHz, a 2048-sample Blackman window every 50ms, the speech band
(300-3400Hz) of the middle and of the sides of the stereo mix - and writes it
to `films/<name>.json`, with the embedded text subtitle as `films/<name>.srt`.
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

## What it said on 2026-10-23

Ten films: three episodes of a 2026 web series, and seven feature films from
1990 to 2024, one of them (Flow) without dialogue.

Displaced by -21.35s, +4s and +37.2s, 477 listenings: 405 right, 10 within
500ms, none further out, 62 never applied, 32 of those on Flow. Half had
applied by the fourth minute and nine in ten by the tenth. Displaced by 0,
+250ms, -700ms and +1.5s, 636 listenings: 590 right, 6 within 500ms, none
further out, 40 never. Not displaced at all, 159 listenings: one moved the
file, by 500ms, on Truman from the 25th minute, and moved it back eight
minutes later.

The answers within 500ms are mostly Love Actually, whose lines the ear puts
about 350ms earlier than its subtitler did: `blocks.mjs` shows that file's
bias at -200ms where the other films with dialogue sit between -50 and +100. Block by block,
placing a line by its first part and then by the whole lands 722 of 914
two-minute blocks within a second; placing it by the whole alone, 635.

None of those 636 listenings applied a rate: a constant shift is not a drift.

A drift is. With the subtitle also running 0.1% slow (`--whole --truths 4000
--slow 0.1`), heard from start to end, the nine films with dialogue were on
screen within 300ms for 43.0% to 89.6% of their length, and within a second
for 80.6% to 97.2%; every one was given 24 against 23.976 (1.001). With
`--no-rates` the same nine were within 300ms for 0.0% to 28.9%. The two
shortest, 32-minute episodes are the lowest, because a rate needs twenty
minutes of blocks before it is fitted. Made for 25 frames against 23.976
(`--slow 4.096`), six of the nine were stretched by exactly that conversion,
after which 37.3% to 92.8% of each film was within 300ms; Love Actually, the
first episode and Truman were left as they were, nothing applied - which is
also what they would have had without a rate.

`la-tigole` is one release of Love Actually against the subtitle of another,
the case the ear exists for. Its `.truth.json` says where that subtitle
belongs: a straight line through the blocks' answers from -22.9s, 59ms later
every minute - the two releases differ by 0.098% in speed, which is 24 against
23.976 frames a second. Heard from the first minute to the last
(`--whole --truths 0 la-tigole`) the ear fitted that rate, took it as 1.001,
and kept the subtitle within 300ms for 79.2% of the film and within a second
for 88.0%. With offsets alone it was 5.6% and 62.8%.

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
