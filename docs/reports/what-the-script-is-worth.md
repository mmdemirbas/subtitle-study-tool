---
title: What the whole script is worth
summary: The extension holds every line of the film before it plays. Measured against three real subtitle files - what that makes possible, what the current marking gets wrong, and what to build next.
---

> [!TLDR]
> The plan in [Beyond subtitles](beyond-subtitles.md) (30 July) is spent: five of its six items have shipped. This one re-ranks what is left against measurements taken from the repo's own corpus rather than against intuition.
>
> - **28.0% of what the overlay marks in English is a proper noun** - 239 of 860 marks in part one, 193 of 682 in part two. Names are rare by rank and are not vocabulary, and they win the two-per-line budget because "not in the table" outranks everything.
> - **A short pre-study list is worth having.** The 40 commonest rare words of part one cover 33.3% of every rare-word occurrence in it; 20.6% once names are taken out.
> - **Turkish is not the same problem at the same setting.** 34.1% of its tokens count as rare against 12.0% in English, and its pre-teach curve is half as steep. The threshold slider is not comparable across languages, and Turkish needs lemmatisation before any of this pays.
> - **One defect found while measuring:** every Turkish word beginning with capital İ is ranked as rarer than the 30,000th word in the table.

This is a teaching document, not a catalogue: it is ordered by the question a reader has at each point, and the ideas at the end only make sense after the four measurements before them. If you want the idea list alone, it is [in section six](#ideas).

## What has been built since the last plan? {#since}

The earlier report ended with a six-item build order. It is worth being explicit about which of them exist, because a re-ranking that quietly re-proposes shipped work is worse than no re-ranking.

```oku-table
{"headers":["From the 30 July plan","State today","Where it lives"],"rows":[["Replay and slow the line","**Shipped**, as the T and Y keys plus `pauseAtLineEnd`, which stops at the end of every line once per line","`content.js`"],["Known-word highlighting","**Shipped**, as the rarity marking driven by a 30,000-word table per language, with the threshold as a slider","`study/rarity.js`, `study.js`"],["Click a word, meaning, save with its sentence","**Shipped**, as hover-to-look-up, click-to-pin, D-to-save, and the deck exporting TSV and JSON","`study.js`, `study/deck.js`, `options.js`"],["Automatic sync by VAD","**Not built.** What shipped instead is the aligner, which measures the offset between two subtitle files rather than against the audio","`align.js`"],["Multi-source fetching","**Not built.** OpenSubtitles is still the only source","`provider.js`"],["Catch me up","**Not built**, and still behind the same unmade decision about a model","-"],["Dual subtitles in the overlay","**Shipped** - and it was the enabler for everything below, because it is what puts a human translation of the current line on the screen","`content.js`"]]}
```

Two items are outstanding, and they are the two that need something the tool does not have today: an audio path, and a model. Everything proposed below deliberately needs neither.

## What does the file know that the line does not? {#asset}

The overlay works one line at a time because that is all a viewer needs while a film runs. The *file* holds more: every word of the script, with its timing, before a frame has played. The first thing that falls out of reading the whole of it is that the reading load is not spread evenly.

```oku-chart
{"type":"line","title":"Rare words per minute of dialogue - Battlestar Galactica, part one (EN)","x_label":"Minute of the film","y_label":"Words rarer than rank 4000","series":[{"label":"per minute","color":"accent","data":[{"x":1,"y":0},{"x":2,"y":0},{"x":3,"y":0},{"x":4,"y":0},{"x":5,"y":0},{"x":6,"y":10},{"x":7,"y":19},{"x":8,"y":15},{"x":9,"y":13},{"x":10,"y":14},{"x":11,"y":7},{"x":12,"y":14},{"x":13,"y":2},{"x":14,"y":10},{"x":15,"y":5},{"x":16,"y":5},{"x":17,"y":4},{"x":18,"y":1},{"x":19,"y":4},{"x":20,"y":27},{"x":21,"y":5},{"x":22,"y":13},{"x":23,"y":4},{"x":24,"y":15},{"x":25,"y":29},{"x":26,"y":13},{"x":27,"y":13},{"x":28,"y":2},{"x":29,"y":17},{"x":30,"y":12},{"x":31,"y":5},{"x":32,"y":4},{"x":33,"y":3},{"x":34,"y":6},{"x":35,"y":4},{"x":36,"y":6},{"x":37,"y":6},{"x":38,"y":8},{"x":39,"y":12},{"x":40,"y":14},{"x":41,"y":9},{"x":42,"y":4},{"x":43,"y":5},{"x":44,"y":20},{"x":45,"y":2},{"x":46,"y":10},{"x":47,"y":13},{"x":48,"y":15},{"x":49,"y":9},{"x":50,"y":27},{"x":51,"y":21},{"x":52,"y":19},{"x":53,"y":16},{"x":54,"y":3},{"x":55,"y":11},{"x":56,"y":4},{"x":57,"y":11},{"x":58,"y":6},{"x":59,"y":21},{"x":60,"y":9},{"x":61,"y":14},{"x":62,"y":6},{"x":63,"y":10},{"x":64,"y":5},{"x":65,"y":9},{"x":66,"y":3},{"x":67,"y":15},{"x":68,"y":15},{"x":69,"y":9},{"x":70,"y":16},{"x":71,"y":25},{"x":72,"y":6},{"x":73,"y":5},{"x":74,"y":17},{"x":75,"y":23},{"x":76,"y":15},{"x":77,"y":10},{"x":78,"y":5},{"x":79,"y":6},{"x":80,"y":0},{"x":81,"y":13},{"x":82,"y":5},{"x":83,"y":6},{"x":84,"y":22},{"x":85,"y":14},{"x":86,"y":7},{"x":87,"y":19},{"x":88,"y":17},{"x":89,"y":20},{"x":90,"y":9},{"x":91,"y":12},{"x":92,"y":11},{"x":93,"y":10},{"x":94,"y":1}]}]}
```

Minute 25 carries 29 rare words; minute 18 carries one; six minutes carry none at all. The median minute has 10. A setting that pauses at the end of *every* line - which is what `pauseAtLineEnd` does today - spends the same amount of the viewer's attention on minute 18 as on minute 25, and it is minute 25 where the help is wanted.

The same file also says how fast each line has to be read. Across part one the median cue runs at 12 characters per second, the 90th percentile at 20.8, and **24.1% of cues exceed 17 characters per second**, which is the usual professional ceiling for adult subtitling. Part two agrees: 22.5%. So roughly a quarter of the lines in an ordinary film are already too fast to read comfortably in a first language, before any of them is in a second.

> [!NOTE]
> Both numbers come from the file alone. Nothing here needs the film to be playing, an audio path, a model, or a network call - which is why this class of feature is cheap in a way the outstanding items from the last plan are not.

## Who is spending the marking budget? {#names}

Two words per line get marked. Working out which two is a ranking problem, and a word absent from the frequency table is treated as rarer than anything in it - so an absent word always wins. Proper nouns are absent, or nearly so.

```oku-chart
{"type":"stacked-bar","title":"What the overlay would mark across a whole film, at rank 4000","categories":["EN part one","EN part two","TR part one"],"series":[{"label":"vocabulary","color":"accent","values":[621,489,1120]},{"label":"proper nouns","color":"warn","values":[239,193,141]}]}
```

Of the 860 marks the overlay would place across part one, **239 are proper nouns** - Galactica, Cylon, Colonial, Apollo, Caprica, Viper, Boomer. Part two: 193 of 682. That is 28% of a deliberately scarce resource spent on words that are not vocabulary in any useful sense; a viewer learns "Galactica" from the first thirty seconds of the film, not from a card.

The 25 of the 72 most-repeated rare words that are names make the same point from the other side. "Cylon" appears 17 times in part one. Under the current rule it is marked 17 times.

> [!IMPORTANT]
> This is not an argument for hiding names. A viewer *does* want to know that Caprica is a place and Boomer is a person - it is exactly the kind of thing a subtitle strips away. The argument is that a name is a different **kind** of thing from a word to learn, and putting it in the same two-per-line queue means the film's actual vocabulary is being crowded out by its cast list.

## Is there a short list worth learning beforehand? {#preteach}

If the rare words of a film were all different, pre-study would be pointless - a list of 535 one-off words is a dictionary, not homework. They are not all different, and the shape of the repetition decides whether pre-study is worth building.

```oku-chart
{"type":"line","title":"How much of the rare-word traffic the commonest N of them account for","x_label":"Words learnt beforehand, commonest first","y_label":"Share of all rare-word occurrences (%)","series":[{"label":"EN, names in","color":"accent","data":[{"x":10,"y":14.5},{"x":20,"y":23.2},{"x":30,"y":29},{"x":40,"y":33.3},{"x":50,"y":36.8},{"x":60,"y":40},{"x":70,"y":43.1},{"x":80,"y":45.4},{"x":90,"y":47.5},{"x":100,"y":49.6},{"x":110,"y":51.7},{"x":120,"y":53.8},{"x":130,"y":55.9},{"x":140,"y":57.9},{"x":150,"y":59.7},{"x":160,"y":60.8}]},{"label":"EN, names out","color":"success","data":[{"x":10,"y":9.1},{"x":20,"y":13.9},{"x":30,"y":17.5},{"x":40,"y":20.6},{"x":50,"y":23.4},{"x":60,"y":25.5},{"x":70,"y":27.6},{"x":80,"y":29.7},{"x":90,"y":31.8},{"x":100,"y":33.9},{"x":110,"y":35.8},{"x":120,"y":36.8},{"x":130,"y":37.9},{"x":140,"y":38.9},{"x":150,"y":40},{"x":160,"y":41}]},{"label":"TR, names out","color":"warn","data":[{"x":10,"y":5.1},{"x":20,"y":7.8},{"x":30,"y":10.1},{"x":40,"y":11.9},{"x":50,"y":13.6},{"x":60,"y":15.3},{"x":70,"y":16.8},{"x":80,"y":18},{"x":90,"y":19.1},{"x":100,"y":20.3},{"x":110,"y":21.4},{"x":120,"y":22.6},{"x":130,"y":23.7},{"x":140,"y":24.9},{"x":150,"y":26.1},{"x":160,"y":27.2}]}]}
```

Read the middle line - English with proper nouns taken out, which is the honest one: in English, **40 words learnt beforehand cover a fifth of every rare-word occurrence in the film, and 160 words cover two fifths**. That is a real lever - it is the difference between being interrupted 956 times and being interrupted 560 times - and producing the list costs one pass over a file the tool has already downloaded.

The top line is the same measurement with names left in, and the gap between the two lines is the same finding as the previous section, drawn a different way: about a third of the apparent benefit of pre-study is the film teaching you its own cast list.

## Why Turkish behaves differently {#turkish}

The bottom line of that chart is Turkish, and it is half as steep. The same 160 words cover 27.2% instead of 41%. At the same threshold, 34.1% of Turkish tokens count as rare against 12.0% of English ones, and the overlay would mark 993 distinct words in the Turkish file against 486 in the English one.

That is a property of the language, not of the film: Turkish inflects, so *gelmek*, *geliyor*, *gelecekti* and *gelmeliydi* are four table entries where English would have two, and the corpus rank of each inflected form is much lower than the rank of the idea. The consequences are concrete:

- **The threshold slider does not mean the same thing in two languages.** Rank 4000 is "past the first year" in English and something much stricter in Turkish. Calibrating it by *marks per minute* rather than by rank would make one setting mean one thing.
- **Pre-study in Turkish needs lemmatisation to be worth doing.** A list of inflected forms is not a list of words.

While measuring this, a defect turned up that is worth fixing whatever else happens.

```oku-annotated-code
{"src":"// study.js\nspan.dataset.w = match[0].toLowerCase();   // (1)\n\n// what that produces for a Turkish sentence-initial word\n\"İyi\".toLowerCase()   // \"i\\u0307yi\" - i + COMBINING DOT ABOVE   (2)\n\n// and what the table holds\nWORDS.indexOf(\"iyi\")     //    25   (3)\nWORDS.indexOf(\"i\\u0307yi\")  //    -1   (4)","lang":"javascript","annotations":[{"id":1,"content":"Every word of every cue is lowercased here before it is ranked. The same value is what the lookup, the deck and the strip all carry."},{"id":2,"content":"Unicode case folding maps capital dotted İ to <code>i</code> plus a combining dot, because that is what round-trips in most languages. Turkish is the language where it does not."},{"id":3,"content":"<code>iyi</code> - \"good\" - is the 26th commonest word in the Turkish subtitle corpus."},{"id":4,"content":"The folded form is in no table, and absent means rarer than the 30,000th word. So it is marked, and being the rarest thing in the line it always wins one of the two places."}]}
```

Measured on the Turkish file: 66 of its 5,122 tokens lowercase to a form carrying a combining dot, and **60 of those 66 are words the table knows once the dot is removed** - `iyi` (rank 25) 13 times, `iki` (rank 113) 11 times, `işte` (rank 118) 3 times. Every one of them is currently presented to the reader as a very rare word.

The fix is one normalisation step at the point of `toLowerCase`, and it belongs there rather than in the table, because the deck and the lookup want the corrected form too. **Not fixed in this round** - it is a separate change from the ones this report proposes, and it wants its own test.

## What the script makes possible, by when it helps {#ideas}

Everything below needs only the subtitle file and the playhead. The "needs" column is what stops it being free.

```oku-table
{"headers":["Idea","When it helps","What it needs beyond what exists","Rough cost"],"rows":[["**Name chips.** Mark a proper noun as a name rather than as a word to learn, in its own colour, outside the two-per-line vocabulary budget.","During","A name test. Capitalisation across the whole file is the cheap one and it is what section three measures with; the file gives every occurrence, so it is far more reliable than judging one line.","Half a day"],["**Pre-flight list.** Before pressing play: the film's repeated rare words, names separated, with the option to send them to the deck.","Before","Nothing. One pass over the file the tool already holds. Spoiler-safe by construction if it shows words and never lines.","1 day"],["**Difficulty preview.** Rare-word density and reading speed for this file, so a film can be chosen by whether it is readable.","Before","Nothing. The same pass. Wants a calibration across a few films before it can put a number on a dial.","1 day"],["**Adaptive pause.** Stop at the end of a line only when that line is heavy - many rare words, or above 17 characters per second - instead of every line.","During","A per-cue load score, computed once at attach. `pauseAtLineEnd` already owns the pausing.","1 day"],["**Concordance.** When a word is looked up, show every other line in this film where it appears, with its timestamp, and let one be jumped to.","During","An index of word to cue, built at attach. The strongest use of holding the whole file: the best example sentence for a word is one from the film being watched.","2 days"],["**Search the dialogue.** Type a phrase, jump to the line.","During","The same index, plus a result list in the panel.","1 day"],["**Cloze the line.** Hide one rare word in the known-language line until the cue ends, so the sentence is a question rather than a translation.","During","A rendering mode on the second subtitle. Cheap; the risk is that it is annoying rather than that it is hard.","1 day"],["**Session report.** At the end: what was met, what was saved, which lines were replayed, what share of the film's rare words are now in the deck.","After","Counters the study path does not keep today, and a place to show them.","2 days"],["**Export the aligned pair.** The two subtitles, line by line, as one file - a parallel corpus of the film.","After","Nothing. The aligner already knows the correspondence.","Half a day"],["**Personal frequency.** Rank by how often *you* have met a word across every film watched, not by how often the corpus has.","Across films","A per-word counter surviving across attachments, and a decision about where it lives. This is the one that makes the threshold slider unnecessary.","3 days"],["**File health on attach.** Say when a subtitle file is malformed rather than silently dropping the bad parts.","Before","A validation pass. The Turkish translation in this repo has 12 cues reading `00:41:23,***`, which currently vanish without a word.","Half a day"]]}
```

## The two decisions worth making first {#decisions}

Two of those items are not independent, and choosing wrongly makes the others harder.

```oku-compare-grid
{"cards":[{"t":"Names: a filter, or a kind?","verdict":"good","b":"**A kind.** Filtering names out of the marking is the smaller change and it throws away something the viewer wants - a subtitle strips the information that Caprica is a place. Giving a name its own chip keeps it and stops it competing for the vocabulary budget. Costs a colour and a branch; the name test is the same either way."},{"t":"Turkish: lemmatise, or a bigger table?","verdict":"warn","b":"**Neither yet, and know why.** A bigger table does not help - the problem is that inflected forms are genuinely rarer, not that they are missing. A lemmatiser is the right answer and is a real dependency (Zemberek is JVM, so it would live in the daemon, which the extension is deliberately able to run without). The İ normalisation is separate, cheap, and worth doing on its own first."}]}
```

## What I would build first {#plan}

Ordered by what each one unlocks, not by size.

```oku-step-flow
{"ordered":true,"steps":[{"t":"Normalise the Turkish dotted i","meta":"hours · no dependency","b":"A correctness fix with a measured impact: 60 occurrences in one file, all of them common words presented as very rare. Every other Turkish measurement in this report is slightly wrong until it lands, which is the real argument for doing it first."},{"t":"Name chips","meta":"half a day · no dependency","b":"Returns 28% of the marking budget to vocabulary, and it is the same test the pre-flight list needs. Measure it the same way afterwards: marks per film, split by kind."},{"t":"The pre-flight list","meta":"1 day · no dependency","b":"The first thing here that changes how a film is watched rather than how it is annotated. 40 words for a fifth of the traffic is the number to beat, and it is worth showing the reader that number so the list has a stated value."},{"t":"Adaptive pause","meta":"1 day · no dependency","b":"Turns an existing setting most people will not leave on into one they might. The per-cue score it needs is the same one the difficulty preview shows."},{"t":"Concordance and dialogue search","meta":"2-3 days · one index","b":"Both fall out of one word-to-cue index built at attach. This is the pair that is genuinely impossible without holding the whole file, so it is where the asset is actually spent."}]}
```

Everything on that list is offline, needs no new permission, no model and no new service, and none of it touches the fetch or sync paths.

## How these numbers were produced {#method}

Every figure above comes from three files in this repo, measured by a script committed beside them. Re-run it and the numbers regenerate.

```bash
cd browser-extension
node tools/measure-script.mjs \
  ../srt-viewer/subtitles/Battlestar.Galactica.Miniseries.S00E01.2003.1080p.BluRay-EN.srt
# --lang and --rank override the defaults; output is JSON
```

The script uses the extension's own tokeniser (`WORD_PATTERN`, the apostrophe fallback for contractions), its own generated frequency tables, its own three-letter floor and its own two-marks-per-line rule, so "a word this counts" is a word the overlay would have marked.

Scope, stated rather than implied:

- **Three files, one production, two languages.** Battlestar Galactica is science fiction with an unusually heavy proper-noun load, so the 28% name share is likely to be at the high end. The direction is not in doubt; the exact figure is one production's.
- **The name test is capitalisation**, not a knowledge base: a word capitalised where a sentence did not just start, in at least half of its occurrences. It will miss a lower-case name and catch a stray emphatic capital.
- **The Turkish file is machine-translated** (`gpt5-thinking-web`), which is what a translated subtitle in this workflow actually is, and its 12 malformed cues are excluded from the timing statistics rather than repaired.
- The reading-speed ceiling of 17 characters per second is a subtitling convention, not a measurement of this reader.

```oku-info-tip
{"summary":"Why the file rather than the line - the same measurement seen from the overlay's position","content":["The overlay ranks the words of one cue, twenty times a second, and never sees the next line. Every number in this report needed two things it does not have: the whole file at once, and the ability to count the same word across it.","That difference is the whole of what is proposed here. A per-line view can tell you that <em>reckoning</em> is rare. Only a whole-file view can tell you that it is said eight times, that six of them are in the last twenty minutes, and that learning it before you start removes eight interruptions rather than one.",{"k":"code","src":"# what the overlay knows at 00:41:23\n{ cue: \"...the reckoning is upon us\", ranks: { reckoning: 16400 } }\n\n# what the file knows before the film starts\n{ reckoning: { rank: 16400, count: 8, first: 2483000, name: false } }","lang":"python"}]}
```
