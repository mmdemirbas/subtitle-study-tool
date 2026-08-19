---
title: Hearing the film
summary: What a local file and its subtitle make possible that a streaming tab never could - starting from the fact that this tool has never once heard the film it is subtitling.
---

> [!TLDR]
> Every hard problem in this tool is hard for one reason: it has never heard the film. A file on your own disk changes exactly that, and the catalogue app has already paid for the first pass over the audio.
>
> - **The aligner has no ground truth.** `align.js` decides whether two subtitles line up by comparing their cue times *to each other*. On a real cross-language pair that is 1,173 English cues against 915 Turkish ones, a median nearest-start gap of 505ms against a 250ms tolerance, and a coverage of 0.25. Two files agreeing means they agree with each other, not with the picture.
> - **The sound is the cheap half of the file.** The catalogue app already builds a 1,200-bucket loudness envelope from 4kHz mono audio, and measured **2.9 seconds for a 46-minute episode**. Speech-versus-silence is one more pass over the same samples.
> - **Sync stops being an inference and becomes a measurement.** The staircase this repo found - six plateaus at 1.00, 5.30, 11.85, 18.80, 24.80 and 30.55 seconds - stops being something to detect from two text files and becomes something to read off the audio, act by act.
> - **Per-line audio is the study feature a streaming tab cannot have at all.** Replay this line, loop it, slow it without pitch shift, and put it on a card that carries its own sound.
> - **Word timings are the thing the study strip is missing.** The strip already knows which word you pointed at; it does not know when that word is said.
> - **Recommendation: speech-versus-silence first.** It is the cheapest thing on the list and it is the input to the two most valuable ones.

**A note on evidence.** Everything called *measured* below carries a number from this repository, from the catalogue app, or from a run recorded here. Everything else is a proposal and says so. Two costs that matter to the ranking - a speech detector and a transcription pass - have **not** been measured on this machine, and are marked where they appear.

## What is actually new when the film is on your own disk? {#new}

Not local playback. That already works: the content script matches `<all_urls>` in every frame, so a page carrying a `<video>` gets the whole surface - overlay, panel, study strips, deck, aligner - whether the bytes come from a CDN or from `~/Downloads`. That was measured in [Taking the study surface off the browser](off-the-browser.html), and the local catalogue app is now one of those pages.

What is new is that **a second program can read the sound**, and this one already does.

<svg viewBox="0 0 720 152" role="img" aria-label="The panel timeline strip as it exists today: position and cue density, with the sound unavailable">
  <text class="okt-diag-label soft" x="0" y="12">THE STRIP TODAY</text>
  <text class="okt-diag-label" x="0" y="44">position</text>
  <rect class="okt-diag-node plain" x="148.0" y="32" width="558.0" height="14" rx="7"/>
  <rect class="okt-diag-node accent" x="148.0" y="32" width="278" height="14" rx="7"/>
  <line class="okt-diag-edge strong" x1="426.0" y1="26" x2="426.0" y2="52"/>
  <text class="okt-diag-label" x="0" y="86">cue density</text>
  <text class="okt-diag-label faint" x="0" y="100">the file you attached</text>
  <rect class="okt-diag-fill-3" x="148.0" y="80.9" width="4.6" height="9.1" rx="1"/>
  <rect class="okt-diag-fill-3" x="155.8" y="67.9" width="4.6" height="22.1" rx="1"/>
  <rect class="okt-diag-fill-3" x="163.5" y="67.9" width="4.6" height="22.1" rx="1"/>
  <rect class="okt-diag-fill-3" x="171.2" y="67.9" width="4.6" height="22.1" rx="1"/>
  <rect class="okt-diag-fill-3" x="179.0" y="67.9" width="4.6" height="22.1" rx="1"/>
  <rect class="okt-diag-fill-3" x="186.8" y="67.9" width="4.6" height="22.1" rx="1"/>
  <rect class="okt-diag-fill-3" x="194.5" y="67.9" width="4.6" height="22.1" rx="1"/>
  <rect class="okt-diag-fill-3" x="202.2" y="67.9" width="4.6" height="22.1" rx="1"/>
  <rect class="okt-diag-fill-3" x="210.0" y="67.9" width="4.6" height="22.1" rx="1"/>
  <rect class="okt-diag-fill-3" x="217.8" y="67.9" width="4.6" height="22.1" rx="1"/>
  <rect class="okt-diag-fill-3" x="225.5" y="67.9" width="4.6" height="22.1" rx="1"/>
  <rect class="okt-diag-fill-3" x="233.2" y="67.9" width="4.6" height="22.1" rx="1"/>
  <rect class="okt-diag-fill-3" x="241.0" y="67.9" width="4.6" height="22.1" rx="1"/>
  <rect class="okt-diag-fill-3" x="248.8" y="67.9" width="4.6" height="22.1" rx="1"/>
  <rect class="okt-diag-fill-3" x="256.5" y="80.9" width="4.6" height="9.1" rx="1"/>
  <rect class="okt-diag-fill-3" x="295.2" y="67.9" width="4.6" height="22.1" rx="1"/>
  <rect class="okt-diag-fill-3" x="303.0" y="67.9" width="4.6" height="22.1" rx="1"/>
  <rect class="okt-diag-fill-3" x="310.8" y="80.9" width="4.6" height="9.1" rx="1"/>
  <rect class="okt-diag-fill-3" x="318.5" y="67.9" width="4.6" height="22.1" rx="1"/>
  <rect class="okt-diag-fill-3" x="326.2" y="67.9" width="4.6" height="22.1" rx="1"/>
  <rect class="okt-diag-fill-3" x="334.0" y="67.9" width="4.6" height="22.1" rx="1"/>
  <rect class="okt-diag-fill-3" x="341.8" y="67.9" width="4.6" height="22.1" rx="1"/>
  <rect class="okt-diag-fill-3" x="349.5" y="67.9" width="4.6" height="22.1" rx="1"/>
  <rect class="okt-diag-fill-3" x="357.2" y="67.9" width="4.6" height="22.1" rx="1"/>
  <rect class="okt-diag-fill-3" x="365.0" y="67.9" width="4.6" height="22.1" rx="1"/>
  <rect class="okt-diag-fill-3" x="372.8" y="67.9" width="4.6" height="22.1" rx="1"/>
  <rect class="okt-diag-fill-3" x="380.5" y="67.9" width="4.6" height="22.1" rx="1"/>
  <rect class="okt-diag-fill-3" x="388.2" y="67.9" width="4.6" height="22.1" rx="1"/>
  <rect class="okt-diag-fill-3" x="396.0" y="67.9" width="4.6" height="22.1" rx="1"/>
  <rect class="okt-diag-fill-3" x="403.8" y="67.9" width="4.6" height="22.1" rx="1"/>
  <rect class="okt-diag-fill-3" x="411.5" y="67.9" width="4.6" height="22.1" rx="1"/>
  <rect class="okt-diag-fill-3" x="419.2" y="67.9" width="4.6" height="22.1" rx="1"/>
  <rect class="okt-diag-fill-3" x="427.0" y="67.9" width="4.6" height="22.1" rx="1"/>
  <rect class="okt-diag-fill-3" x="434.8" y="67.9" width="4.6" height="22.1" rx="1"/>
  <rect class="okt-diag-fill-3" x="442.5" y="67.9" width="4.6" height="22.1" rx="1"/>
  <rect class="okt-diag-fill-3" x="450.2" y="67.9" width="4.6" height="22.1" rx="1"/>
  <rect class="okt-diag-fill-3" x="458.0" y="67.9" width="4.6" height="22.1" rx="1"/>
  <rect class="okt-diag-fill-3" x="465.8" y="67.9" width="4.6" height="22.1" rx="1"/>
  <rect class="okt-diag-fill-3" x="473.5" y="67.9" width="4.6" height="22.1" rx="1"/>
  <rect class="okt-diag-fill-3" x="481.2" y="67.9" width="4.6" height="22.1" rx="1"/>
  <rect class="okt-diag-fill-3" x="489.0" y="67.9" width="4.6" height="22.1" rx="1"/>
  <rect class="okt-diag-fill-3" x="496.8" y="67.9" width="4.6" height="22.1" rx="1"/>
  <rect class="okt-diag-fill-3" x="504.5" y="67.9" width="4.6" height="22.1" rx="1"/>
  <rect class="okt-diag-fill-3" x="512.2" y="67.9" width="4.6" height="22.1" rx="1"/>
  <rect class="okt-diag-fill-3" x="520.0" y="67.9" width="4.6" height="22.1" rx="1"/>
  <rect class="okt-diag-fill-3" x="527.8" y="67.9" width="4.6" height="22.1" rx="1"/>
  <rect class="okt-diag-fill-3" x="535.5" y="67.9" width="4.6" height="22.1" rx="1"/>
  <rect class="okt-diag-fill-3" x="543.2" y="67.9" width="4.6" height="22.1" rx="1"/>
  <rect class="okt-diag-fill-3" x="551.0" y="67.9" width="4.6" height="22.1" rx="1"/>
  <rect class="okt-diag-fill-3" x="558.8" y="67.9" width="4.6" height="22.1" rx="1"/>
  <rect class="okt-diag-fill-3" x="566.5" y="67.9" width="4.6" height="22.1" rx="1"/>
  <rect class="okt-diag-fill-3" x="574.2" y="67.9" width="4.6" height="22.1" rx="1"/>
  <rect class="okt-diag-fill-3" x="582.0" y="67.9" width="4.6" height="22.1" rx="1"/>
  <rect class="okt-diag-fill-3" x="589.8" y="67.9" width="4.6" height="22.1" rx="1"/>
  <rect class="okt-diag-fill-3" x="597.5" y="67.9" width="4.6" height="22.1" rx="1"/>
  <rect class="okt-diag-fill-3" x="605.2" y="67.9" width="4.6" height="22.1" rx="1"/>
  <rect class="okt-diag-fill-3" x="613.0" y="67.9" width="4.6" height="22.1" rx="1"/>
  <rect class="okt-diag-fill-3" x="620.8" y="67.9" width="4.6" height="22.1" rx="1"/>
  <rect class="okt-diag-fill-3" x="628.5" y="67.9" width="4.6" height="22.1" rx="1"/>
  <rect class="okt-diag-fill-3" x="636.2" y="67.9" width="4.6" height="22.1" rx="1"/>
  <rect class="okt-diag-fill-3" x="644.0" y="67.9" width="4.6" height="22.1" rx="1"/>
  <rect class="okt-diag-fill-3" x="651.8" y="67.9" width="4.6" height="22.1" rx="1"/>
  <rect class="okt-diag-fill-3" x="690.5" y="80.9" width="4.6" height="9.1" rx="1"/>
  <text class="okt-diag-label faint" x="0" y="132">the sound</text>
  <rect class="okt-diag-group" x="148.0" y="116" width="558.0" height="24" rx="5" stroke-dasharray="5 4"/>
  <text class="okt-diag-label faint" x="427.0" y="132" text-anchor="middle">no way to reach it from a streaming site</text>
</svg>

The strip in the control panel today carries two things: where you are, and where the lines are. Both come from files. The third row is the one that has never been available - not because nobody wrote the code, but because a browser extension on a streaming site has no path to the decoded audio of a DRM-protected stream, and no path to the file either.

On a local file both of those stop being true, and the catalogue app has already walked most of the way: `waveform.ts` builds a loudness envelope, `storyboard.ts` samples 40 frames, `probe.ts` reads the container, and `vtt.ts` serves the sidecar subtitles. None of that was built for this tool. All of it is on the same disk.

That is the whole of the opportunity, and the rest of this page is what it is worth. The first question is what the absence has been costing.

## What has the aligner been doing without it? {#today}

Comparing two subtitles to each other, and nothing else.

`align()` is handed two lists of cue start times and searches for the shift that pairs the most of them. It is a good answer to the question it is asked, and the question is missing a participant. Three consequences, all measured on this repository's corpus:

**Cross-language pairs are the worst case, and they are the ordinary case here.** Two subtitlers break the same dialogue into different lines, so the two files do not have the same events in them. Measured on The Americans S02E09: 1,173 English cues against 915 Turkish, a median gap between nearest starts of 505ms against a 250ms tolerance, coverage 0.25, confidence 3.8 to 6.1. Also measured on that episode: 88 of 725 English lines are sound description with no Turkish counterpart at all, and 114 Turkish lines merge two English ones.

**A confident answer can be the wrong answer.** The show burns English subtitles into the picture for the Russian dialogue, so the English `.srt` is silent through those scenes. A competing peak 3.4 seconds away won and was applied silently at confidence 8.3. The fix was a coverage gate, which turns `apply` into `offer` - it does not make the right peak win, because nothing in two text files knows which peak is right.

**One number is often the wrong shape of answer.** Two releases of one episode gave six plateaus with five jumps of four to seven seconds at scene boundaries:

```oku-chart
{"type":"bar","rows":[{"label":"Act 1","value":1.0,"display":"1.00 s"},{"label":"Act 2","value":5.3,"display":"5.30 s"},{"label":"Act 3","value":11.85,"display":"11.85 s"},{"label":"Act 4","value":18.8,"display":"18.80 s"},{"label":"Act 5","value":24.8,"display":"24.80 s"},{"label":"Act 6","value":30.55,"display":"30.55 s"}]}
```

The offset a broadcast episode needs, act by act, measured on The Americans S02E09 - two Turkish files carrying the same 533-line translation retimed for two releases. The two English files for the same episode give the same six to within 250ms, which is what makes it a property of the video releases rather than of any subtitle. `alignSteps()` now finds these from the text alone, and it works:

```oku-chart
{"type":"grouped-bar","title":"Share of the film placed within 250ms","categories":["All 137 pairs (mean)","41 staircase pairs (median)"],"series":[{"label":"align(), one offset","color":"warn","values":[86.4,50]},{"label":"alignSteps(), one per act","color":"accent","values":[94.6,90]}]}
```

Two different statistics in one figure, deliberately: the left pair is the mean over every pair in the corpus, the right pair is the median over the 41 whose truth is a staircase, because that subset is where the difference lives. Both are from `bench/align/regress.mjs`.

That is a real gain and it came from the text alone. The point of this page is that **it is still an inference**, and there is a measurement sitting on the same disk that would replace it. So: what would that measurement cost?

## What would it cost to listen? {#cost}

Three tiers, and they are not close to each other in price.

```oku-table
{"headers":["Tier","What it produces","What it costs","What it answers"],"rows":[["**Loudness**","1,200 buckets across the film, from 4kHz mono","**Measured: 2.9s for a 46-minute episode**, one pass, already built and cached per file by the catalogue app","Where the talking stops, where the action is, where the credits start"],["**Speech**","Speech-versus-silence regions, and therefore speech onsets","One more pass over the same 4kHz samples. **Not measured here** - a VAD at this sample rate is normally a fraction of the envelope pass, since the samples are already decoded","Where a line *starts being said*, which is the thing a cue start claims to be"],["**Words**","A transcript with per-word times","`subgen/` already vendors faster-whisper. **Not measured here**, and it is the expensive tier by a wide margin - minutes rather than seconds, per film","What is said, when each word is said, and who says it"]]}
```

The ranking that follows is the shape of the whole page: the first tier is free because it is already built, the second is cheap and buys most of the sync value, and the third is expensive and buys the study features. Nothing here needs the third tier to be useful.

One more property of tier two worth stating plainly: **it does not need to understand anything.** A speech detector does not care what language the film is in, does not need a model per language, and cannot be wrong about vocabulary because it never has any. That is why it is the recommendation at the end.

## What does listening buy for sync? {#sync}

It replaces "do these two files agree" with "does this file agree with the picture", which is the question that was always being asked.

Concretely, per act: the offset is the median of `speech onset - cue start` over the pairs in that act, and an act boundary is where that median jumps. Both halves of the staircase - the plateaus and where they break - fall out of one measurement rather than out of a search. Four things change:

- **The answer needs one subtitle, not two.** Today an alignment needs a second file to compare against, so the first subtitle you attach is unaligned by construction. Against the audio, one file is enough.
- **The failure the coverage gate exists for cannot happen the same way.** A competing peak 3.4 seconds away only wins because both candidates are made of the same kind of evidence. Speech onsets are different evidence; a peak that puts dialogue in silence is visibly wrong.
- **The tool can say how sure it is, and be right about that.** Today's confidence is a binomial score over pairings between two files. Against speech, it is the spread of the residuals - the same statistic `snapNear` already trusts, where genuine snaps measured 67 to 139ms of spread and injected errors from -480 to +480ms came back to within a millisecond of the truth.
- **A file that is wrong for this release becomes distinguishable from a file that is wrong everywhere.** A constant residual is a shift; a residual that drifts is a frame-rate mismatch; a residual that jumps is the staircase; a residual that is noise is the wrong episode.

<svg viewBox="0 0 720 324" role="img" aria-label="The same strip with the film on disk: position, loudness, speech, cue starts carrying a visible lag, chapters and word timings">
  <text class="okt-diag-label soft" x="0" y="12">THE SAME STRIP, FILM ON DISK</text>
  <text class="okt-diag-label" x="0" y="44">position</text>
  <rect class="okt-diag-node plain" x="148.0" y="32" width="558.0" height="14" rx="7"/>
  <rect class="okt-diag-node accent" x="148.0" y="32" width="278" height="14" rx="7"/>
  <line class="okt-diag-edge strong" x1="426.0" y1="26" x2="426.0" y2="52"/>
  <text class="okt-diag-label" x="0" y="86">loudness</text>
  <text class="okt-diag-label faint" x="0" y="100">already built</text>
  <rect class="okt-diag-fill-1" x="148.0" y="79.4" width="4.6" height="12.6" rx="1"/>
  <rect class="okt-diag-fill-1" x="155.8" y="69.9" width="4.6" height="22.1" rx="1"/>
  <rect class="okt-diag-fill-1" x="163.5" y="66.5" width="4.6" height="25.5" rx="1"/>
  <rect class="okt-diag-fill-1" x="171.2" y="70.7" width="4.6" height="21.3" rx="1"/>
  <rect class="okt-diag-fill-1" x="179.0" y="69.9" width="4.6" height="22.1" rx="1"/>
  <rect class="okt-diag-fill-1" x="186.8" y="64.3" width="4.6" height="27.7" rx="1"/>
  <rect class="okt-diag-fill-1" x="194.5" y="66.5" width="4.6" height="25.5" rx="1"/>
  <rect class="okt-diag-fill-1" x="202.2" y="74.6" width="4.6" height="17.4" rx="1"/>
  <rect class="okt-diag-fill-1" x="210.0" y="68.2" width="4.6" height="23.8" rx="1"/>
  <rect class="okt-diag-fill-1" x="217.8" y="67.9" width="4.6" height="24.1" rx="1"/>
  <rect class="okt-diag-fill-1" x="225.5" y="75.2" width="4.6" height="16.8" rx="1"/>
  <rect class="okt-diag-fill-1" x="233.2" y="73.5" width="4.6" height="18.5" rx="1"/>
  <rect class="okt-diag-fill-1" x="241.0" y="66.8" width="4.6" height="25.2" rx="1"/>
  <rect class="okt-diag-fill-1" x="248.8" y="67.6" width="4.6" height="24.4" rx="1"/>
  <rect class="okt-diag-fill-1" x="256.5" y="87.5" width="4.6" height="4.5" rx="1"/>
  <rect class="okt-diag-fill-1" x="264.2" y="85.6" width="4.6" height="6.4" rx="1"/>
  <rect class="okt-diag-fill-1" x="272.0" y="85.0" width="4.6" height="7.0" rx="1"/>
  <rect class="okt-diag-fill-1" x="279.8" y="86.7" width="4.6" height="5.3" rx="1"/>
  <rect class="okt-diag-fill-1" x="287.5" y="86.7" width="4.6" height="5.3" rx="1"/>
  <rect class="okt-diag-fill-1" x="295.2" y="67.6" width="4.6" height="24.4" rx="1"/>
  <rect class="okt-diag-fill-1" x="303.0" y="71.6" width="4.6" height="20.4" rx="1"/>
  <rect class="okt-diag-fill-1" x="310.8" y="77.7" width="4.6" height="14.3" rx="1"/>
  <rect class="okt-diag-fill-1" x="318.5" y="68.5" width="4.6" height="23.5" rx="1"/>
  <rect class="okt-diag-fill-1" x="326.2" y="65.7" width="4.6" height="26.3" rx="1"/>
  <rect class="okt-diag-fill-1" x="334.0" y="70.4" width="4.6" height="21.6" rx="1"/>
  <rect class="okt-diag-fill-1" x="341.8" y="69.0" width="4.6" height="23.0" rx="1"/>
  <rect class="okt-diag-fill-1" x="349.5" y="64.3" width="4.6" height="27.7" rx="1"/>
  <rect class="okt-diag-fill-1" x="357.2" y="67.4" width="4.6" height="24.6" rx="1"/>
  <rect class="okt-diag-fill-1" x="365.0" y="74.9" width="4.6" height="17.1" rx="1"/>
  <rect class="okt-diag-fill-1" x="372.8" y="69.0" width="4.6" height="23.0" rx="1"/>
  <rect class="okt-diag-fill-1" x="380.5" y="69.3" width="4.6" height="22.7" rx="1"/>
  <rect class="okt-diag-fill-1" x="388.2" y="74.9" width="4.6" height="17.1" rx="1"/>
  <rect class="okt-diag-fill-1" x="396.0" y="71.8" width="4.6" height="20.2" rx="1"/>
  <rect class="okt-diag-fill-1" x="403.8" y="65.7" width="4.6" height="26.3" rx="1"/>
  <rect class="okt-diag-fill-1" x="411.5" y="67.4" width="4.6" height="24.6" rx="1"/>
  <rect class="okt-diag-fill-1" x="419.2" y="73.0" width="4.6" height="19.0" rx="1"/>
  <rect class="okt-diag-fill-1" x="427.0" y="65.7" width="4.6" height="26.3" rx="1"/>
  <rect class="okt-diag-fill-1" x="434.8" y="65.1" width="4.6" height="26.9" rx="1"/>
  <rect class="okt-diag-fill-1" x="442.5" y="72.1" width="4.6" height="19.9" rx="1"/>
  <rect class="okt-diag-fill-1" x="450.2" y="71.8" width="4.6" height="20.2" rx="1"/>
  <rect class="okt-diag-fill-1" x="458.0" y="64.0" width="4.6" height="28.0" rx="1"/>
  <rect class="okt-diag-fill-1" x="465.8" y="64.6" width="4.6" height="27.4" rx="1"/>
  <rect class="okt-diag-fill-1" x="473.5" y="70.4" width="4.6" height="21.6" rx="1"/>
  <rect class="okt-diag-fill-1" x="481.2" y="64.0" width="4.6" height="28.0" rx="1"/>
  <rect class="okt-diag-fill-1" x="489.0" y="64.0" width="4.6" height="28.0" rx="1"/>
  <rect class="okt-diag-fill-1" x="496.8" y="64.0" width="4.6" height="28.0" rx="1"/>
  <rect class="okt-diag-fill-1" x="504.5" y="64.0" width="4.6" height="28.0" rx="1"/>
  <rect class="okt-diag-fill-1" x="512.2" y="64.0" width="4.6" height="28.0" rx="1"/>
  <rect class="okt-diag-fill-1" x="520.0" y="68.5" width="4.6" height="23.5" rx="1"/>
  <rect class="okt-diag-fill-1" x="527.8" y="75.5" width="4.6" height="16.5" rx="1"/>
  <rect class="okt-diag-fill-1" x="535.5" y="69.9" width="4.6" height="22.1" rx="1"/>
  <rect class="okt-diag-fill-1" x="543.2" y="69.6" width="4.6" height="22.4" rx="1"/>
  <rect class="okt-diag-fill-1" x="551.0" y="74.1" width="4.6" height="17.9" rx="1"/>
  <rect class="okt-diag-fill-1" x="558.8" y="70.4" width="4.6" height="21.6" rx="1"/>
  <rect class="okt-diag-fill-1" x="566.5" y="64.8" width="4.6" height="27.2" rx="1"/>
  <rect class="okt-diag-fill-1" x="574.2" y="67.1" width="4.6" height="24.9" rx="1"/>
  <rect class="okt-diag-fill-1" x="582.0" y="72.4" width="4.6" height="19.6" rx="1"/>
  <rect class="okt-diag-fill-1" x="589.8" y="65.7" width="4.6" height="26.3" rx="1"/>
  <rect class="okt-diag-fill-1" x="597.5" y="66.0" width="4.6" height="26.0" rx="1"/>
  <rect class="okt-diag-fill-1" x="605.2" y="73.5" width="4.6" height="18.5" rx="1"/>
  <rect class="okt-diag-fill-1" x="613.0" y="72.7" width="4.6" height="19.3" rx="1"/>
  <rect class="okt-diag-fill-1" x="620.8" y="69.3" width="4.6" height="22.7" rx="1"/>
  <rect class="okt-diag-fill-1" x="628.5" y="70.7" width="4.6" height="21.3" rx="1"/>
  <rect class="okt-diag-fill-1" x="636.2" y="74.4" width="4.6" height="17.6" rx="1"/>
  <rect class="okt-diag-fill-1" x="644.0" y="66.2" width="4.6" height="25.8" rx="1"/>
  <rect class="okt-diag-fill-1" x="651.8" y="64.8" width="4.6" height="27.2" rx="1"/>
  <rect class="okt-diag-fill-1" x="659.5" y="84.7" width="4.6" height="7.3" rx="1"/>
  <rect class="okt-diag-fill-1" x="667.2" y="83.9" width="4.6" height="8.1" rx="1"/>
  <rect class="okt-diag-fill-1" x="675.0" y="82.5" width="4.6" height="9.5" rx="1"/>
  <rect class="okt-diag-fill-1" x="682.8" y="84.2" width="4.6" height="7.8" rx="1"/>
  <rect class="okt-diag-fill-1" x="690.5" y="86.4" width="4.6" height="5.6" rx="1"/>
  <rect class="okt-diag-fill-1" x="698.2" y="84.4" width="4.6" height="7.6" rx="1"/>
  <text class="okt-diag-label" x="0" y="140">speech</text>
  <text class="okt-diag-label faint" x="0" y="154">one more pass</text>
  <rect class="okt-diag-fill-2" x="155.8" y="126.0" width="4.6" height="14.0" rx="1"/>
  <rect class="okt-diag-fill-2" x="163.5" y="126.0" width="4.6" height="14.0" rx="1"/>
  <rect class="okt-diag-fill-2" x="171.2" y="126.0" width="4.6" height="14.0" rx="1"/>
  <rect class="okt-diag-fill-2" x="179.0" y="126.0" width="4.6" height="14.0" rx="1"/>
  <rect class="okt-diag-fill-2" x="186.8" y="126.0" width="4.6" height="14.0" rx="1"/>
  <rect class="okt-diag-fill-2" x="194.5" y="126.0" width="4.6" height="14.0" rx="1"/>
  <rect class="okt-diag-fill-2" x="202.2" y="126.0" width="4.6" height="14.0" rx="1"/>
  <rect class="okt-diag-fill-2" x="210.0" y="126.0" width="4.6" height="14.0" rx="1"/>
  <rect class="okt-diag-fill-2" x="217.8" y="126.0" width="4.6" height="14.0" rx="1"/>
  <rect class="okt-diag-fill-2" x="225.5" y="126.0" width="4.6" height="14.0" rx="1"/>
  <rect class="okt-diag-fill-2" x="233.2" y="126.0" width="4.6" height="14.0" rx="1"/>
  <rect class="okt-diag-fill-2" x="241.0" y="126.0" width="4.6" height="14.0" rx="1"/>
  <rect class="okt-diag-fill-2" x="248.8" y="126.0" width="4.6" height="14.0" rx="1"/>
  <rect class="okt-diag-fill-2" x="295.2" y="126.0" width="4.6" height="14.0" rx="1"/>
  <rect class="okt-diag-fill-2" x="303.0" y="126.0" width="4.6" height="14.0" rx="1"/>
  <rect class="okt-diag-fill-2" x="318.5" y="126.0" width="4.6" height="14.0" rx="1"/>
  <rect class="okt-diag-fill-2" x="326.2" y="126.0" width="4.6" height="14.0" rx="1"/>
  <rect class="okt-diag-fill-2" x="334.0" y="126.0" width="4.6" height="14.0" rx="1"/>
  <rect class="okt-diag-fill-2" x="341.8" y="126.0" width="4.6" height="14.0" rx="1"/>
  <rect class="okt-diag-fill-2" x="349.5" y="126.0" width="4.6" height="14.0" rx="1"/>
  <rect class="okt-diag-fill-2" x="357.2" y="126.0" width="4.6" height="14.0" rx="1"/>
  <rect class="okt-diag-fill-2" x="365.0" y="126.0" width="4.6" height="14.0" rx="1"/>
  <rect class="okt-diag-fill-2" x="372.8" y="126.0" width="4.6" height="14.0" rx="1"/>
  <rect class="okt-diag-fill-2" x="380.5" y="126.0" width="4.6" height="14.0" rx="1"/>
  <rect class="okt-diag-fill-2" x="388.2" y="126.0" width="4.6" height="14.0" rx="1"/>
  <rect class="okt-diag-fill-2" x="396.0" y="126.0" width="4.6" height="14.0" rx="1"/>
  <rect class="okt-diag-fill-2" x="403.8" y="126.0" width="4.6" height="14.0" rx="1"/>
  <rect class="okt-diag-fill-2" x="411.5" y="126.0" width="4.6" height="14.0" rx="1"/>
  <rect class="okt-diag-fill-2" x="419.2" y="126.0" width="4.6" height="14.0" rx="1"/>
  <rect class="okt-diag-fill-2" x="427.0" y="126.0" width="4.6" height="14.0" rx="1"/>
  <rect class="okt-diag-fill-2" x="434.8" y="126.0" width="4.6" height="14.0" rx="1"/>
  <rect class="okt-diag-fill-2" x="442.5" y="126.0" width="4.6" height="14.0" rx="1"/>
  <rect class="okt-diag-fill-2" x="450.2" y="126.0" width="4.6" height="14.0" rx="1"/>
  <rect class="okt-diag-fill-2" x="458.0" y="126.0" width="4.6" height="14.0" rx="1"/>
  <rect class="okt-diag-fill-2" x="465.8" y="126.0" width="4.6" height="14.0" rx="1"/>
  <rect class="okt-diag-fill-2" x="473.5" y="126.0" width="4.6" height="14.0" rx="1"/>
  <rect class="okt-diag-fill-2" x="481.2" y="126.0" width="4.6" height="14.0" rx="1"/>
  <rect class="okt-diag-fill-2" x="489.0" y="126.0" width="4.6" height="14.0" rx="1"/>
  <rect class="okt-diag-fill-2" x="496.8" y="126.0" width="4.6" height="14.0" rx="1"/>
  <rect class="okt-diag-fill-2" x="504.5" y="126.0" width="4.6" height="14.0" rx="1"/>
  <rect class="okt-diag-fill-2" x="512.2" y="126.0" width="4.6" height="14.0" rx="1"/>
  <rect class="okt-diag-fill-2" x="520.0" y="126.0" width="4.6" height="14.0" rx="1"/>
  <rect class="okt-diag-fill-2" x="527.8" y="126.0" width="4.6" height="14.0" rx="1"/>
  <rect class="okt-diag-fill-2" x="535.5" y="126.0" width="4.6" height="14.0" rx="1"/>
  <rect class="okt-diag-fill-2" x="543.2" y="126.0" width="4.6" height="14.0" rx="1"/>
  <rect class="okt-diag-fill-2" x="551.0" y="126.0" width="4.6" height="14.0" rx="1"/>
  <rect class="okt-diag-fill-2" x="558.8" y="126.0" width="4.6" height="14.0" rx="1"/>
  <rect class="okt-diag-fill-2" x="566.5" y="126.0" width="4.6" height="14.0" rx="1"/>
  <rect class="okt-diag-fill-2" x="574.2" y="126.0" width="4.6" height="14.0" rx="1"/>
  <rect class="okt-diag-fill-2" x="582.0" y="126.0" width="4.6" height="14.0" rx="1"/>
  <rect class="okt-diag-fill-2" x="589.8" y="126.0" width="4.6" height="14.0" rx="1"/>
  <rect class="okt-diag-fill-2" x="597.5" y="126.0" width="4.6" height="14.0" rx="1"/>
  <rect class="okt-diag-fill-2" x="605.2" y="126.0" width="4.6" height="14.0" rx="1"/>
  <rect class="okt-diag-fill-2" x="613.0" y="126.0" width="4.6" height="14.0" rx="1"/>
  <rect class="okt-diag-fill-2" x="620.8" y="126.0" width="4.6" height="14.0" rx="1"/>
  <rect class="okt-diag-fill-2" x="628.5" y="126.0" width="4.6" height="14.0" rx="1"/>
  <rect class="okt-diag-fill-2" x="636.2" y="126.0" width="4.6" height="14.0" rx="1"/>
  <rect class="okt-diag-fill-2" x="644.0" y="126.0" width="4.6" height="14.0" rx="1"/>
  <rect class="okt-diag-fill-2" x="651.8" y="126.0" width="4.6" height="14.0" rx="1"/>
  <text class="okt-diag-label" x="0" y="180">cue starts</text>
  <text class="okt-diag-label faint" x="0" y="194">the file you attached</text>
  <rect class="okt-diag-fill-3" x="164.0" y="177.1" width="4.6" height="4.9" rx="1"/>
  <rect class="okt-diag-fill-3" x="171.8" y="170.1" width="4.6" height="11.9" rx="1"/>
  <rect class="okt-diag-fill-3" x="179.5" y="170.1" width="4.6" height="11.9" rx="1"/>
  <rect class="okt-diag-fill-3" x="187.2" y="170.1" width="4.6" height="11.9" rx="1"/>
  <rect class="okt-diag-fill-3" x="195.0" y="170.1" width="4.6" height="11.9" rx="1"/>
  <rect class="okt-diag-fill-3" x="202.8" y="170.1" width="4.6" height="11.9" rx="1"/>
  <rect class="okt-diag-fill-3" x="210.5" y="170.1" width="4.6" height="11.9" rx="1"/>
  <rect class="okt-diag-fill-3" x="218.2" y="170.1" width="4.6" height="11.9" rx="1"/>
  <rect class="okt-diag-fill-3" x="226.0" y="170.1" width="4.6" height="11.9" rx="1"/>
  <rect class="okt-diag-fill-3" x="233.8" y="170.1" width="4.6" height="11.9" rx="1"/>
  <rect class="okt-diag-fill-3" x="241.5" y="170.1" width="4.6" height="11.9" rx="1"/>
  <rect class="okt-diag-fill-3" x="249.2" y="170.1" width="4.6" height="11.9" rx="1"/>
  <rect class="okt-diag-fill-3" x="257.0" y="170.1" width="4.6" height="11.9" rx="1"/>
  <rect class="okt-diag-fill-3" x="264.8" y="170.1" width="4.6" height="11.9" rx="1"/>
  <rect class="okt-diag-fill-3" x="272.5" y="177.1" width="4.6" height="4.9" rx="1"/>
  <rect class="okt-diag-fill-3" x="311.2" y="170.1" width="4.6" height="11.9" rx="1"/>
  <rect class="okt-diag-fill-3" x="319.0" y="170.1" width="4.6" height="11.9" rx="1"/>
  <rect class="okt-diag-fill-3" x="326.8" y="177.1" width="4.6" height="4.9" rx="1"/>
  <rect class="okt-diag-fill-3" x="334.5" y="170.1" width="4.6" height="11.9" rx="1"/>
  <rect class="okt-diag-fill-3" x="342.2" y="170.1" width="4.6" height="11.9" rx="1"/>
  <rect class="okt-diag-fill-3" x="350.0" y="170.1" width="4.6" height="11.9" rx="1"/>
  <rect class="okt-diag-fill-3" x="357.8" y="170.1" width="4.6" height="11.9" rx="1"/>
  <rect class="okt-diag-fill-3" x="365.5" y="170.1" width="4.6" height="11.9" rx="1"/>
  <rect class="okt-diag-fill-3" x="373.2" y="170.1" width="4.6" height="11.9" rx="1"/>
  <rect class="okt-diag-fill-3" x="381.0" y="170.1" width="4.6" height="11.9" rx="1"/>
  <rect class="okt-diag-fill-3" x="388.8" y="170.1" width="4.6" height="11.9" rx="1"/>
  <rect class="okt-diag-fill-3" x="396.5" y="170.1" width="4.6" height="11.9" rx="1"/>
  <rect class="okt-diag-fill-3" x="404.2" y="170.1" width="4.6" height="11.9" rx="1"/>
  <rect class="okt-diag-fill-3" x="412.0" y="170.1" width="4.6" height="11.9" rx="1"/>
  <rect class="okt-diag-fill-3" x="419.8" y="170.1" width="4.6" height="11.9" rx="1"/>
  <rect class="okt-diag-fill-3" x="427.5" y="170.1" width="4.6" height="11.9" rx="1"/>
  <rect class="okt-diag-fill-3" x="435.2" y="170.1" width="4.6" height="11.9" rx="1"/>
  <rect class="okt-diag-fill-3" x="443.0" y="170.1" width="4.6" height="11.9" rx="1"/>
  <rect class="okt-diag-fill-3" x="450.8" y="170.1" width="4.6" height="11.9" rx="1"/>
  <rect class="okt-diag-fill-3" x="458.5" y="170.1" width="4.6" height="11.9" rx="1"/>
  <rect class="okt-diag-fill-3" x="466.2" y="170.1" width="4.6" height="11.9" rx="1"/>
  <rect class="okt-diag-fill-3" x="474.0" y="170.1" width="4.6" height="11.9" rx="1"/>
  <rect class="okt-diag-fill-3" x="481.8" y="170.1" width="4.6" height="11.9" rx="1"/>
  <rect class="okt-diag-fill-3" x="489.5" y="170.1" width="4.6" height="11.9" rx="1"/>
  <rect class="okt-diag-fill-3" x="497.2" y="170.1" width="4.6" height="11.9" rx="1"/>
  <rect class="okt-diag-fill-3" x="505.0" y="170.1" width="4.6" height="11.9" rx="1"/>
  <rect class="okt-diag-fill-3" x="512.8" y="170.1" width="4.6" height="11.9" rx="1"/>
  <rect class="okt-diag-fill-3" x="520.5" y="170.1" width="4.6" height="11.9" rx="1"/>
  <rect class="okt-diag-fill-3" x="528.2" y="170.1" width="4.6" height="11.9" rx="1"/>
  <rect class="okt-diag-fill-3" x="536.0" y="170.1" width="4.6" height="11.9" rx="1"/>
  <rect class="okt-diag-fill-3" x="543.8" y="170.1" width="4.6" height="11.9" rx="1"/>
  <rect class="okt-diag-fill-3" x="551.5" y="170.1" width="4.6" height="11.9" rx="1"/>
  <rect class="okt-diag-fill-3" x="559.2" y="170.1" width="4.6" height="11.9" rx="1"/>
  <rect class="okt-diag-fill-3" x="567.0" y="170.1" width="4.6" height="11.9" rx="1"/>
  <rect class="okt-diag-fill-3" x="574.8" y="170.1" width="4.6" height="11.9" rx="1"/>
  <rect class="okt-diag-fill-3" x="582.5" y="170.1" width="4.6" height="11.9" rx="1"/>
  <rect class="okt-diag-fill-3" x="590.2" y="170.1" width="4.6" height="11.9" rx="1"/>
  <rect class="okt-diag-fill-3" x="598.0" y="170.1" width="4.6" height="11.9" rx="1"/>
  <rect class="okt-diag-fill-3" x="605.8" y="170.1" width="4.6" height="11.9" rx="1"/>
  <rect class="okt-diag-fill-3" x="613.5" y="170.1" width="4.6" height="11.9" rx="1"/>
  <rect class="okt-diag-fill-3" x="621.2" y="170.1" width="4.6" height="11.9" rx="1"/>
  <rect class="okt-diag-fill-3" x="629.0" y="170.1" width="4.6" height="11.9" rx="1"/>
  <rect class="okt-diag-fill-3" x="636.8" y="170.1" width="4.6" height="11.9" rx="1"/>
  <rect class="okt-diag-fill-3" x="644.5" y="170.1" width="4.6" height="11.9" rx="1"/>
  <rect class="okt-diag-fill-3" x="652.2" y="170.1" width="4.6" height="11.9" rx="1"/>
  <rect class="okt-diag-fill-3" x="660.0" y="170.1" width="4.6" height="11.9" rx="1"/>
  <rect class="okt-diag-fill-3" x="667.8" y="170.1" width="4.6" height="11.9" rx="1"/>
  <rect class="okt-diag-fill-3" x="706.5" y="177.1" width="4.6" height="4.9" rx="1"/>
  <line class="okt-diag-edge faint dashed" x1="155.75" y1="138" x2="155.75" y2="170"/>
  <line class="okt-diag-edge faint dashed" x1="171.75" y1="138" x2="171.75" y2="170"/>
  <line class="okt-diag-edge fail" x1="155.75" y1="155" x2="171.75" y2="155"/>
  <path class="okt-diag-arrow fail" d="M 155.75 155 l 5 -3 v 6 z M 171.75 155 l -5 -3 v 6 z"/>
  <text class="okt-diag-label fail" x="148.0" y="216">this offset is the sync error, and against the speech row it is now measurable</text>
  <line class="okt-diag-edge faint dashed" x1="148.0" y1="228" x2="706.0" y2="228"/>
  <text class="okt-diag-label" x="0" y="256">chapters</text>
  <text class="okt-diag-label faint" x="0" y="270">in the container</text>
  <rect class="okt-diag-node" x="148.0" y="244" width="146" height="14" rx="3"/>
  <rect class="okt-diag-node" x="298.0" y="244" width="192" height="14" rx="3"/>
  <rect class="okt-diag-node" x="494.0" y="244" width="116" height="14" rx="3"/>
  <rect class="okt-diag-node" x="614.0" y="244" width="92" height="14" rx="3"/>
  <text class="okt-diag-label" x="0" y="298">this line</text>
  <text class="okt-diag-label faint" x="0" y="312">word by word</text>
  <rect class="okt-diag-node accent" x="328.0" y="288" width="34" height="16" rx="3"/>
  <rect class="okt-diag-node plain" x="366.0" y="288" width="52" height="16" rx="3"/>
  <rect class="okt-diag-node plain" x="422.0" y="288" width="26" height="16" rx="3"/>
  <rect class="okt-diag-node plain" x="452.0" y="288" width="70" height="16" rx="3"/>
  <text class="okt-diag-label faint" x="532.0" y="300">only reachable with word timings</text>
</svg>

Each panel is the same quantity - how far a cue start sits from the nearest speech onset - drawn across the film, with zero as the dashed line. The shapes are schematic; what is not schematic is that these four are distinguishable from each other, and that today's confidence score collapses all four into one number.

The last one is worth its own sentence. **The extension currently cannot tell "wrong episode" from "hard pair"** - both look like low coverage - and it is the difference between "press this button" and "download a different file".

## What does it buy for the timeline? {#timeline}

The strip becomes an instrument rather than a progress bar. Every lane below exists on disk today except the last one.

<svg viewBox="0 0 722 84" role="img" aria-label="Four shapes the residual can take, and what each one means">
  <rect class="okt-diag-group" x="0" y="12" width="158" height="64" rx="5"/>
  <line class="okt-diag-edge faint dashed" x1="8" y1="38.0" x2="150" y2="38.0"/>
  <polyline class="okt-diag-edge ok" points="8.0,31.3 25.8,31.3 43.5,31.3 61.2,31.3 79.0,31.3 96.8,31.3 114.5,31.3 132.2,31.3 150.0,31.3"/>
  <text class="okt-diag-label strong ok" x="8" y="60">a shift</text>
  <text class="okt-diag-label faint" x="8" y="72">one number fixes it</text>
  <rect class="okt-diag-group" x="188" y="12" width="158" height="64" rx="5"/>
  <line class="okt-diag-edge faint dashed" x1="196" y1="38.0" x2="338" y2="38.0"/>
  <polyline class="okt-diag-edge " points="196.0,38.0 213.8,39.4 231.5,40.8 249.2,42.2 267.0,43.6 284.8,45.0 302.5,46.4 320.2,47.8 338.0,49.2"/>
  <text class="okt-diag-label strong " x="196" y="60">a frame rate</text>
  <text class="okt-diag-label faint" x="196" y="72">a rate, not an offset</text>
  <rect class="okt-diag-group" x="376" y="12" width="158" height="64" rx="5"/>
  <line class="okt-diag-edge faint dashed" x1="384" y1="38.0" x2="526" y2="38.0"/>
  <polyline class="okt-diag-edge strong" points="384.0,34.6 401.8,34.6 419.5,34.6 437.2,42.5 455.0,42.5 472.8,42.5 490.5,49.8 508.2,49.8 526.0,49.8"/>
  <text class="okt-diag-label strong accent" x="384" y="60">the staircase</text>
  <text class="okt-diag-label faint" x="384" y="72">one number per act</text>
  <rect class="okt-diag-group" x="564" y="12" width="158" height="64" rx="5"/>
  <line class="okt-diag-edge faint dashed" x1="572" y1="38.0" x2="714" y2="38.0"/>
  <polyline class="okt-diag-edge fail" points="572.0,38.0 589.8,48.6 607.5,29.0 625.2,43.6 643.0,25.4 660.8,49.8 678.5,35.2 696.2,45.8 714.0,27.4"/>
  <text class="okt-diag-label strong fail" x="572" y="60">the wrong file</text>
  <text class="okt-diag-label faint" x="572" y="72">nothing will fix it</text>
</svg>

Reading it as a reader rather than as a list of lanes: the loudness row says where the film is quiet, the speech row turns that into a yes-or-no, and the cue row is drawn against it. **A cue block sitting over silence is a sync error you can see without measuring anything** - which is the same argument the catalogue app already made for putting a waveform under its own scrubber, applied to the thing this tool is actually for.

Two more lanes are free once the file is local:

- **Chapters.** `waveform.ts` already extracts them (`chaptersOf`). A broadcast episode's act breaks are frequently in the container's chapter list, which means the staircase's boundaries may be sitting in the file, already correct, needing no detection at all.
- **Frames.** `storyboard.ts` samples 40 frames per film at 8 per row. Hovering the strip could show the picture at that moment, which turns "line this up by eye" into a two-second job instead of a drag-and-check loop.

## What does it buy while you are reading a line? {#reading}

This is where the local file stops being a sync convenience and becomes a feature nobody can copy on a streaming site.

**Replay this line.** The single most useful thing in language study, and it is a `<audio>` element pointed at a byte range of a file you own: play 0:22:11.4 to 0:22:14.9, loop it, slow it to 0.7x without pitch shift. Today the only way to hear a line again is to seek the film back, which resets the picture, the pause state and your place in the strip.

**Highlight the word being said.** The study strip already knows which word you pointed at, because it draws the line itself and every word is an element. What it does not know is *when* that word is said, so the highlight cannot follow the voice. Word timings - the third tier - close that, and the surface to show them on is already built.

**Speaker colour without brackets.** `annotations.py` already classifies `[Ormon]` and `[sighs]` out of cue text and colours the speaker - measured at 47 speaker attributions, 30 sound descriptions and 13 `[indistinct chatter]` in one file. That only works when the subtitler wrote them. Diarisation gives the same thing for the files that did not, and `subgen/src/diarization.py` is currently a documented stub with pyannote unwired.

**A card that carries its own sound.** The deck exists. On a local file a card can hold the line, its audio, and the frame it was said over, which is the difference between a word list and something worth revising from.

**Shadowing.** Record yourself over the line and compare the two envelopes. Proposal, unbuilt, and the cheapest of the four to prototype because the envelope code exists on both sides.

## What does it buy before you press play? {#before}

`tools/measure-script.mjs` already measures a whole subtitle with the extension's own rules. Run over the Turkish subtitle for one episode it found 33.2% of tokens rare against 12.0% in English, 981 distinct words the overlay would mark against 486, and a 160-word pre-teach covering 27.0% of the text against 41%. The whole of [What the script is worth](what-the-script-is-worth.html) is that measurement.

```oku-chart
{"type":"grouped-bar","title":"The same episode, the same threshold, two languages (%)","categories":["Tokens the overlay would mark as rare","Text covered by pre-teaching 160 words"],"series":[{"label":"English","color":"accent","values":[12.0,41.0]},{"label":"Turkish","color":"warn","values":[33.2,27.0]}]}
```

Both bars are percentages of the same episode's script, measured by `tools/measure-script.mjs`. The Turkish subtitle marks nearly three times as much as rare and pays back less than two thirds as much for the same pre-teaching, which is the finding that a threshold slider cannot be shared across languages.

That runs offline, from the subtitle alone. On a local library **it can run at scan time, for everything**, next to the loudness pass that already does. What that turns into:

- Difficulty on the title card, before you commit two hours to it.
- A pre-watch briefing: the twenty words that carry this episode, with their lines and - once the audio is indexed - the sound of each.
- An answer to "what should I watch next", ranked by whether it is a step up from the last one rather than by rating.

None of that needs the extension to be running, or the film to be playing. It needs the file and the subtitle in the same place, which is the situation this page is about.

## How would the two programs talk to each other? {#contract}

Three shapes, and they are not alternatives - they suit different payloads.

```oku-table
{"headers":["Shape","What it carries well","What it costs","Verdict"],"rows":[["**Data attributes on the `<video>`**","Scalars that change as you watch: the stream offset, the film's length. Shipped today as `data-sso-time-offset` and `data-sso-duration`","Nothing. No handshake, no port, no origin question. The page sets an attribute; the extension reads it","**Keep for scalars.** It is already the fix for the overlay not appearing"],["**A JSON blob in the page**","Cue-level extras: speech regions, chapters, word times","Grows the page by the size of the data, on every navigation, for a reader who may never turn the study surface on","**Avoid.** The payload is exactly the part that does not belong in a document"],["**Daemon to app over loopback**","Everything heavy: envelopes, speech regions, transcripts, per-line audio ranges","Both have to be running. The daemon is already on `127.0.0.1:8791`, the app on `5173`, and the daemon is the side that already vendors Whisper","**The one to build**, when there is something heavy to carry"]]}
```

The interesting property of the third row is that **the work belongs on the daemon side anyway**. It already owns the on-disk cache, it already has transcription, and it is already the thing the extension asks when it needs something a browser cannot do. The catalogue app would contribute the one thing it has and the daemon does not: the path of the file you are actually watching, which it can put in a data attribute alongside the two that are already there.

```oku-diagram
{"src":"flowchart LR\n  A[\"catalogue app\\n:5173\"] -->|\"data-sso-file-path\\ndata-sso-time-offset\\ndata-sso-duration\"| B[\"extension\\nin the tab\"]\n  B -->|\"what is at 22:11 in this file?\"| C[\"daemon\\n:8791\"]\n  C -->|\"speech regions, cue residuals,\\nline audio, word times\"| B\n  C -.->|\"reads the same file\"| D[(\"the .mkv\\non disk\")]\n  A -.->|\"already built:\\nenvelope, frames, chapters\"| D","caption":"The path of the file is the only new thing the page has to say. Everything after that is between the extension and the daemon, which is where the on-disk cache and the transcription already live."}
```

## Where would I start? {#start}

Recommendation, separated from the evidence above and ranked by what it returns for what it costs.

```oku-step-flow
{"steps":[{"t":"Speech regions, cached per file","b":"One pass over audio already decoded once. Nothing on screen changes yet - this is the input to the next two, and the only step whose cost is near zero."},{"t":"Residuals against the strip","b":"Draw cue starts against speech onsets in the panel map. A mis-synced subtitle becomes visible rather than measurable, which is the cheapest possible use of the data."},{"t":"Per-act offsets from the audio","b":"Median residual per act, act boundaries where it jumps. Replaces the two-file search with a measurement, and reports a spread instead of a binomial score. Check it against `bench/align/regress.mjs`, which already refuses any change that makes a pair worse."},{"t":"Replay this line","b":"A byte range of a file you own, looped, at 0.7x. The first thing on this page that a streaming tab cannot have at all."},{"t":"Word times, and the highlight that follows the voice","b":"The expensive tier. Worth it after the four above, not before - and the surface to show it on already exists."}]}
```

One thing not on that list, deliberately. **Do not start with transcription.** It is the tier everything else on this page is often assumed to need, it is the only one that costs minutes per film, and every step above it works without a single word being recognised.
