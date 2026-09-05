# Beyond subtitles: what this tool could become

The tool currently solves one problem well — a film with no subtitles gets
subtitles, synced to the page's own clock, one click away. This is about what
else it could do with what it already knows.

## What we already have that most tools don't

Worth naming, because the good ideas all fall out of these rather than out of
"what features could a video player have":

1. **The exact playback position**, every 50 ms, from `video.currentTime`.
2. **The entire script of the film**, as timed text, before it plays.
3. **A local process** that can hold state, call APIs and keep a cache, without
   anything leaving the machine unless we choose.
4. **A rendering surface over the video** that survives fullscreen.
5. **A local Whisper stack** already built, currently unused.

Knowing both *the whole script* and *exactly where the viewer is in it* is the
unusual combination. Almost everything below is a consequence of it.

## The constraint that shapes everything: spoilers

Any feature that draws on the script has to answer one question first: **does
this reveal something the viewer has not reached yet?**

A cast list spoils that a character appears in act three. A plot summary
destroys the film. Even a vocabulary list, sorted by frequency, quietly leaks
that a word nobody has said yet will matter later.

This is not a caveat to bolt on afterwards. It is the design constraint, and it
happens to be one we are unusually well placed to honour — we know the
timestamp of every line, so "only what has already happened" is a filter we can
actually implement, not a promise we have to make carefully. **Everything below
is scoped to `currentTime` unless it says otherwise.**

A general rule worth adopting: *the tool may explain the past and the present;
it may never explain the future.*

---

## Layer 1 — Understanding the words

The stated goal is language learning, so this is the layer with the clearest
payoff, and the cheapest to build.

**Read this as the pitch it was, not as a list of what is missing.** Five of the
six below have since been built, and the page has not been rewritten around
them: 1.1 click a word (the lookup popup in `study.js`), 1.2 save the word with
its line and export it (`study/deck.js`, TSV and Anki), 1.3 rarity highlighting
(the marked words in study mode, from a static frequency list as predicted),
1.5 idiom and phrase marking (`study/phrases.js`), and 1.6 two subtitles at once
in the overlay. Of 1.4, the replay key shipped as **T**; playing one cue at
0.75x did not. What remains unbuilt is Layer 2 and beyond.

### 1.1 Click a word, get its meaning
Make cue text selectable, pause on click, show definition + translation +
pronunciation. The study viewer already has a dictionary drawer and a selection
popup — this is bringing that to the overlay.

*Cost:* moderate. The overlay currently refuses pointer events so it never
eats a click meant for the player; making words clickable without breaking
that needs care.

### 1.2 Save the word, keep the list
One click adds the word, the sentence it appeared in, the film and the
timestamp to a personal deck. Export to Anki or CSV later.

The sentence is the point. A word list is nearly useless; a word *with the line
that taught it* is what makes it stick. We have the line for free.

*Cost:* low. The daemon already has a cache directory and a JSON habit.

### 1.3 Rarity highlighting
Colour or underline words by frequency rank, so the three words in a line that
are actually worth learning stand out from the forty that aren't.

*Cost:* low, and **fully offline** — a word-frequency list is a static file.
No API, no spoiler risk, no cost per use. Probably the best value-per-effort
item on this page.

### 1.4 Replay the line / slow the line
A key that jumps back to the start of the current cue and replays it. Another
that plays just this cue at 0.75×, then restores speed.

*Cost:* very low — we know the cue's start and end, and we have the `<video>`
element. Perhaps twenty lines. For language learning this is the single most
used control in every dedicated tool, and we are two hotkeys away from it.

### 1.5 Idiom and slang flagging
Mark phrases whose meaning is not the sum of their words — the things a
dictionary lookup actively misleads you about.

*Cost:* moderate. A curated idiom list gets the common cases offline; an LLM
gets the long tail with cost and latency.

### 1.6 Dual subtitles in the overlay
Target language above, native below. The study viewer does this already; the
overlay does not. Needs two subtitle files, which the daemon can already fetch.

---

## Layer 2 — Understanding the story

This is the layer the question is really about, and the one where the spoiler
constraint bites hardest.

### 2.1 "Catch me up" — a recap of what has happened so far
Summarise the film **from the subtitles up to `currentTime` and no further**.
Come back from the kitchen, press a key, read four sentences.

This is the strongest idea here, and it is only safe because we can bound the
input by timestamp. Give the same feature to a tool that does not know where
you are and it either spoils the film or refuses to be useful.

*Cost:* moderate — needs an LLM. But the input is small and cacheable per
(film, checkpoint), so a re-ask at the same point is free.

### 2.2 "Who is that?" — progressive character roster
A character list that only contains people who have already appeared, with the
number of lines each has spoken so far. Built from speaker labels, which the
annotation work already extracts and colours.

Note how well this composes with what exists: speaker names are already parsed,
already coloured, already stable across cues. A roster is mostly presentation.

*Cost:* low if built from speaker labels alone. Higher, and spoiler-risky, if
we pull cast photos from TMDB — a cast list is ordered by billing, which leaks
who matters.

### 2.3 "What did they just say?"
A key that explains the last line: not translate — *explain*. Why it was funny,
what the reference was, what the tone was. Scoped to dialogue up to now.

*Cost:* moderate, LLM per use, but tiny prompts.

### 2.4 Scene map
Chapter markers derived from gaps between cues — a 20-second silence is almost
always a scene boundary. Lets you jump back to "the restaurant scene" without
scrubbing.

*Cost:* low, offline, derived from data we already hold. Spoiler-safe if
labelled by timestamp rather than by content, or if labels are revealed only
once passed.

---

## Layer 3 — Understanding the world

### 3.1 Reference explainer
Proper nouns, places, historical events, songs, brands. Built from named
entities in the cues so far.

*Cost:* moderate. Genuinely useful for films leaning on a culture the viewer
does not share, which is much of the point of watching foreign films.

### 3.2 Pre-flight briefing
Before pressing play: setting, era, and any cultural background needed to
follow it — deliberately excluding plot. A "what you need to know going in"
card, which is the one place a *non*-time-scoped summary is safe, because it is
explicitly about the world rather than the story.

---

## Layer 4 — Making the core flow better

Less glamorous, more likely to be used every single session.

### 4.1 Automatic sync, using Whisper
The one manual step left in the core flow is nudging the offset when a subtitle
was timed against a different release.

We can remove it. Transcribe 60 seconds of tab audio with the local Whisper
build, cross-correlate it against the subtitle's cue timings, and compute the
offset directly. No guessing, no bracket keys.

This is my favourite item on the page: it uses the Whisper stack that is
already built and idle, needs no API, no network and no LLM, and it deletes a
step rather than adding a feature.

### 4.2 Gap filling
When a subtitle is missing a stretch of dialogue, transcribe just that stretch.
Same machinery as 4.1.

### 4.3 Bookmarks
A key that saves the current cue, timestamp and a screenshot. Export the set
afterwards as notes. Cheap, and pairs with 1.2.

---

## What I would build first

In order, on the basis of value per unit of effort and risk:

1. **Replay / slow the current line** (1.4) — hours of work, used constantly.
2. **Rarity highlighting** (1.3) — offline, no cost per use, no spoiler risk,
   directly serves the learning goal.
3. **Click a word → meaning → save with its sentence** (1.1 + 1.2) — the core
   language-learning loop, and the study viewer already has half of it.
4. **Automatic sync via Whisper** (4.1) — removes the last manual step and
   finally uses the local stack.
5. **Catch me up** (2.1) — the strongest "understand the film better" feature,
   and the one that best justifies the spoiler-scoping machinery.

Items 1–4 need no LLM and no new external service. Only item 5 does.

## The decision that item 5 forces

The daemon has no runtime dependencies today, and that is deliberate — it
starts with nothing installed, which is what makes the one-click path one
click. An LLM feature changes that: an API key, a cost per use, latency, and a
privacy question, since the subtitles of what you are watching would leave the
machine.

Two ways out, both real:

- **Local model via Ollama.** Nothing leaves the machine; quality is lower and
  it needs the model resident. The study viewer already speaks Ollama, so there
  is precedent in this repo.
- **Hosted API, explicitly opt-in**, off by default, with the daemon showing
  what it is about to send.

Worth deciding before building anything in Layer 2, because it determines
whether that layer is a small feature or a new dependency surface.
