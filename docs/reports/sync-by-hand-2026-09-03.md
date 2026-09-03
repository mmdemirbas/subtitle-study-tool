# What the log says about correcting sync by hand

3 September 2026. "Sync is still not smooth. We should use every means of
making this smoother. Ideally, I should just open a video and the relevant
subtitles should be auto-loaded and auto-synced based on all available clues
smartly so I can just watch it without even touching the subtitle overlay
panel."

This reads the running log rather than reproducing anything. Everything below
comes from `subtitle-daemon/logs/*.jsonl`, eight days between 11 August and 2
September 2026: 880 `sync` records, 643 `attach`, 325 `autoAttach`, 244 `align`.

## How much correcting is actually happening

| | |
|---|---|
| by-hand corrections | 880, in 63 sittings |
| per sitting | median 10, worst 109 |
| by gesture | drag 685, snap 141, reset 41, key 7, set 6 |
| size of one correction | median 908ms, p10 110ms, p90 7.6s |

**The corrections do not converge.** One sitting moved the offset a net 0.9
seconds while dragging through 136 seconds of it; another 1.5 seconds net over
205 seconds of moving; the worst, 6.4 seconds net over 569. The reader is aiming
at the same value again and again.

Nineteen percent of corrections are under 250ms, which is smaller than the
reader can see a line move.

## Why the drift control never fired

Every one of the ten most-corrected sittings has a systematic slope through the
corrections: 477 to 715ms of drift per minute of film, 20 to 30 seconds by the
end of a 45-minute episode. There is a control for exactly that. Across all 880
corrections **the rate was changed six times**.

Two defects, both now fixed (`1a4eb5a`):

**The span was measured in the order the corrections were made.** A reader does
not correct a film front to back - one sitting goes 44m, 44m, 1m, 2m, 9m, 0m,
1m - so the twenty-minute bar a rate needs was being asked of the reader's route
through the film rather than of the film. A measurement made across a whole
episode was discarded because the last two nudges were minutes apart.

**The estimate was a line through two of the points.** The reader's aim
scatters: seven corrections inside one minute of "Experimental Prototype City of
Tomorrow" ran 13.4, 13.5, 12.9, 10.5, 10.6, 10.2 and 10.5 seconds. The first
correction was worse, because the eviction rule keeps it forever and the log
holds opening guesses of +105.4s and -47.1s. It is the median of every pairwise
slope now.

Replayed over the log's own corrections, 39 sittings of six or more: the
two-point line had an answer for 24 of them and the median of slopes for 27, and
against the slope each whole sitting supports the median error falls from 83ms
per minute to 35 - from 3.7 seconds of residual by the end of an episode to 1.6.

## What the drift is not

The rates the corrections imply are **not framerate conversions**. Over the 30
sittings with a slope above 100ms per minute, the implied rate is 1.0084 to
1.0125 and the nearest standard ratio is 0.7% to 1.3% away - which over an
episode is 20 seconds of disagreement. Two sittings imply 0.68 and 0.82, which
are not rates at all.

So the named-ratio branch in `driftEstimate` is doing no work on this corpus,
and a fix that assumed framerate would be fixing something else.

## Slope or staircase - not settled

A player that inserts ads gains time at each break, and the extension already
models that: `alignSteps` produces per-act offsets and the seven recorded
alignment outcomes carry 2, 3, 5 and 6 acts. So the alternative reading is that
the offset is a staircase, and a straight line through a staircase looks like a
slope.

Fitted both ways over the 24 sittings with six or more distinct correction
moments, a two-step staircase describes 13 of them better and a straight line
describes 11. **A staircase has one more free parameter than a line**, so it
should win more often than not on residual alone; that it only wins about half
the time means the line is genuinely the better description of the other half.

The shape is not the same from film to film. That is as far as this data goes,
and it is the reason nothing was built on it: applying a rate to a film that
steps, or steps to a film that drifts, both make it worse.

## The aligner is working

244 alignments: 189 said apply, 52 offer, 3 no. Median confidence 42.7, median
coverage 0.42. It is not the weak link.

What it cannot do is the case the request is really about. It aligns one
subtitle against **another subtitle**, so with a single file attached there is
nothing to align to, and the reader is the only source of truth about where the
film is.

## Leads not followed

**A quarter of attaches carry a subtitle whose last cue lands after the film
ends** - 164 of 641, and the p90 is 9.4 times the film's length. If that were
trustworthy it would be a rate estimate available before a frame plays. It is
not trustworthy yet: `filmSeconds` documents players that report the length of
what has arrived rather than the length of the film, so some of those ratios are
measuring a duration that was still growing.

**The search result names the subtitle's framerate.** `autoAttach` plans carry
`best.fps` - 23.976 on the record read here - and nothing uses it. A browser does
not expose the video's framerate, so this is half a ratio; whether the other half
can be had is unexamined.

## Recommendation

The estimator fix is in. Before anything else is built on top of it, the next
sitting's log should be read back to see whether the drift is now offered when it
should be - that is one film's worth of waiting, and it costs nothing.

The slope-or-staircase question needs deciding before either is applied
automatically, and this corpus does not decide it.
