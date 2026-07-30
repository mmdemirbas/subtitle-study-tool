---
title: Beyond subtitles
accent: amber
eyebrow: Product direction
subtitle: What this tool could become once it stops being a subtitle fetcher — with the prior art that already exists, and the spoiler question answered properly
audience: Muhammed
date: 2026-07-30
read_time: 18 min
order: 10
summary: Sixteen ideas across four layers, measured against the tools that already do some of this, with a five-tier spoiler model and a recommended build order.
---

> [!TLDR]
> The tool already does something the established language-learning extensions
> cannot: it **finds subtitles for video that has none**. Everything worth
> building next should lean on that, not compete with it.
>
> - **Two corrections to my earlier plan.** `ffsubsync` already solves automatic
>   sync using voice-activity detection — cheaper and better than the Whisper
>   approach I recommended. And `asbplayer` already implements most of the
>   language layer, open source.
> - **Spoilers are the central design constraint**, and they leak through
>   channels that look harmless — a cast list ordered by billing, a vocabulary
>   list, a chapter name. Five opt-in tiers below, defaulting to strict.
> - **Recommended first slice:** replay-the-line, known-word highlighting,
>   click-to-save with the sentence. No LLM, no new service, roughly a week.

## The two assets nobody else has {#assets}

Every idea below is a consequence of two facts, so they are worth stating
before the ideas.

```oku-kpi-grid
{"k":"kpi-grid","tiles":[
  {"num":"50 ms","label":"how often we know the exact playback position"},
  {"num":"100%","label":"of the script, available before it plays"},
  {"num":"0","label":"platforms whose own subtitles we depend on"},
  {"num":"9,254","label":"cues already parsed, classified and measured"}
]}
```

Knowing **the whole script in advance** and **exactly where the viewer is in
it** is the unusual combination. A recap that cannot spoil, a vocabulary list
scoped to what you have heard, a character roster that reveals people as they
appear — none of these are possible without both halves.

The third asset is quieter but decides feasibility: a **local daemon** that can
hold state, cache, and call things, plus a **built Whisper stack** currently
sitting idle.

## What already exists {#prior-art}

I researched this before writing recommendations, and it changed two of them.
The field splits cleanly in three.

```oku-table
{"k": "table", "headers": ["Tool", "What it does", "Needs the platform to have subtitles?", "Overlap with us"], "rows": [["Language Reactor", "Dual subtitles, word lookup, saved phrases, Anki export. 2–3M users, the default in this space.", "Yes", "Layer 1"], ["asbplayer", "Open source. Subtitle sync onto streaming video, Anki cards with audio + screenshot via AnkiConnect, condensed playback, auto-pause per subtitle, word styling by known/unknown status.", "You supply the file", "Layer 1, heavily"], ["Trancy", "AI bilingual subtitles across 8+ platforms, pronunciation scoring, grammar analysis, Anki sync.", "Yes", "Layer 1"], ["Migaku", "SRS-first, deep Anki integration, Netflix and Disney+ sentence mining.", "Yes", "Layer 1"], ["Prime Video X-Ray / Apple TV InSight", "Cast and music for the current scene, updating as scenes change. X-Ray Recaps adds AI spoiler-free episode summaries.", "Platform-native", "Layer 2"], ["ffsubsync / alass", "Automatic subtitle synchronisation by voice-activity detection, 20–30 s per film.", "No", "Layer 4"]]}
```

> [!IMPORTANT]
> **Read the third column.** Every language-learning extension in this space
> assumes the subtitles already exist — they attach to Netflix's own track, or
> to a file you found yourself. Our tool starts one step earlier: it *finds and
> fetches* the subtitle for video that has none. That is the gap we already
> fill, and it is why "build a worse Language Reactor" is the wrong direction.

### Two corrections to what I recommended before

I ranked these in the earlier notes without doing this research. Both rankings
were wrong.

```oku-compare-grid
{"k":"compare-grid","cards":[
  {"t":"Auto-sync: I said Whisper. It should be VAD.","verdict":"bad","b":"I proposed transcribing 60 seconds of audio and cross-correlating the text against cue timings. `ffsubsync` solves the same problem by discretising both sides into 10 ms windows and asking only *is there speech here* — a voice-activity detector, not a transcriber. Language-agnostic, far cheaper, 20–30 s for a whole film. The Whisper build is not the right tool for this job; WebRTC or Silero VAD is."},
  {"t":"Layer 1: mostly already built, and open source","verdict":"warn","b":"`asbplayer` already does Anki cards with audio and screenshot, condensed playback that skips unsubtitled stretches, auto-pause at each subtitle boundary, and word styling driven by known/unknown status synced from Anki. That is more than I proposed. The question is no longer *what to build* but *what to borrow, and what only we can do*."}
]}
```

## The spoiler problem, properly {#spoilers}

You suggested softening this with opt-in, which is right. But the reason it
needs care is not the obvious one, so let me be concrete about what actually
leaks.

### Direct spoilers are the easy case

A plot summary, a character's fate, an ending. Everybody sees these coming and
nobody ships them by accident.

### The leaks that get shipped by accident

```oku-step-flow
{"k": "step-flow", "ordered": false, "steps": [{"t": "Cast list from TMDB", "b": "Billing order tells you who matters. A face you have not seen yet tells you someone is still coming."}, {"t": "Character roster with line counts", "b": "A character with 200 lines who has said 3 so far is about to become important. A character whose count stops growing has died or left."}, {"t": "Vocabulary list for the film", "b": "Word frequency over the whole script leaks theme. Twelve occurrences of a word nobody has said yet is a plot point."}, {"t": "Chapter or scene names", "b": "Descriptive labels are miniature summaries — \"the hospital\", \"the funeral\"."}, {"t": "A recap that quotes dialogue", "b": "Even correctly time-scoped, an LLM can quote a line from its own training data about the film."}, {"t": "Runtime remaining per character", "b": "Reveals structure: who is in the third act."}]}
```

The asymmetry is what makes this worth designing around rather than
apologising for: **the cost is irreversible and one-sided**. A feature that is
mildly useful cannot compensate for permanently damaging a first viewing. That
argues for default-strict, not for default-off-by-a-warning-dialog.

### How the playhead makes this tractable

We are unusually well placed here. "Only what has already happened" is not a
promise we make carefully — it is a filter over cue timestamps.

```oku-diagram
{"k":"diagram","caption":"Everything that reads the script passes through the same gate. The tier setting decides how far past the playhead the gate opens.","src":"flowchart LR\n  A[\"Full subtitle file\\n(all cues)\"] --> G{{\"Spoiler gate\\ncurrentTime + tier\"}}\n  P[\"video.currentTime\"] --> G\n  T[\"Tier setting\\nT0..T4\"] --> G\n  G -->|\"cues where end <= now\"| S[\"Safe context\"]\n  G -.->|\"blocked at T0/T1/T2\"| F[\"Future cues\"]\n  S --> R[\"Recap\"]\n  S --> V[\"Vocabulary\"]\n  S --> C[\"Character roster\"]\n  F -.->|\"unlocked at T3/T4\"| R"}
```

### Five tiers, defaulting to strict

```oku-step-flow
{"k":"step-flow","ordered":false,"steps":[
  {"t":"T0 — Strict","meta":"default","b":"Nothing beyond the playhead, ever. Vocabulary, recaps and rosters are built only from cues that have already been displayed."},
  {"t":"T1 — Scene-scoped","meta":"the X-Ray model","b":"Who is on screen now, what is playing now. Amazon and Apple both chose this, and it is a genuinely good default for a *context* feature: current-scene-only is spoiler-safe by construction."},
  {"t":"T2 — Everything so far","meta":"recommended once trusted","b":"Recaps, rosters of characters already seen, vocabulary from dialogue already heard. Still strictly past-only, but aggregates across the whole viewing rather than the current scene."},
  {"t":"T3 — Film-wide, non-plot","meta":"opt-in per film","b":"Full vocabulary list before you start, difficulty rating, cultural and historical background. Deliberately excludes plot. Useful for pre-study — knowing the hard words before you begin is the single biggest comprehension lever."},
  {"t":"T4 — Unrestricted","meta":"rewatch mode","b":"Plot, trivia, analysis, endings. Not dangerous when there is nothing left to spoil."}
]}
```

Two refinements that make the tiers pleasant rather than bureaucratic:

**Rewatch mode is one switch, not five.** Somebody rewatching a film has no
spoilers to protect. A single toggle that jumps to T4 for this title is worth
more than any amount of per-feature configuration, and it is remembered per
IMDb id, so it stays set for that film.

**Per-instance reveal beats per-feature settings.** Where something might
spoil, blur it and let a click reveal it. The decision happens at the moment of
curiosity with full knowledge of the cost, instead of in a settings panel weeks
earlier. This is the pattern that lets T3 and T4 content exist safely inside a
T0 session.

## The idea catalogue {#ideas}

Sixteen ideas, four layers. Position on the chart is effort against value —
both my estimates, and both arguable.

```oku-chart
{"k": "chart", "type": "scatter", "title": "Effort against value (bottom-right is where to start)", "x_label": "Effort →", "y_label": "Value →", "series": [{"color": "accent", "label": "Layer 1 — words", "data": [{"x": 1, "y": 9, "label": "1.4 Replay / slow line"}, {"x": 2, "y": 8, "label": "1.3 Known-word highlighting"}, {"x": 4, "y": 9, "label": "1.1 Click a word"}, {"x": 3, "y": 8, "label": "1.2 Save with sentence"}, {"x": 6, "y": 5, "label": "1.5 Idiom flagging"}, {"x": 4, "y": 6, "label": "1.6 Dual subtitles"}]}, {"color": "warn", "label": "Layer 2 — story", "data": [{"x": 6, "y": 8, "label": "2.1 Catch me up"}, {"x": 3, "y": 6, "label": "2.2 Character roster"}, {"x": 5, "y": 6, "label": "2.3 Explain that line"}, {"x": 3, "y": 4, "label": "2.4 Scene map"}]}, {"color": "muted", "label": "Layer 3 — world", "data": [{"x": 7, "y": 5, "label": "3.1 Reference explainer"}, {"x": 4, "y": 5, "label": "3.2 Pre-flight briefing"}]}, {"color": "success", "label": "Layer 4 — core flow", "data": [{"x": 3, "y": 9, "label": "4.1 Auto-sync (VAD)"}, {"x": 5, "y": 5, "label": "4.2 Gap filling"}, {"x": 2, "y": 6, "label": "4.3 Bookmarks"}, {"x": 6, "y": 7, "label": "4.4 Multi-source"}]}]}
```

### Layer 1 — understanding the words

```oku-step-flow
{"k": "step-flow", "ordered": false, "steps": [{"t": "1.4 Replay and slow the current line", "meta": "Cost / dependency: Hours. No dependency. asbplayer's auto-pause is the same family.", "b": "A key that jumps to the start of the current cue and replays it. Another that plays just that cue at 0.75× and restores speed after. We know the cue boundaries and hold the video element."}, {"t": "1.3 Known-word highlighting", "meta": "Cost / dependency: Low. A static list, fully offline, no API and no spoiler risk at T0 since it needs no lookahead.", "b": "Colour words by how common they are, so the two or three worth learning in a line stand out from the forty that are not. SUBTLEX is a frequency corpus built from 51M words of film subtitles — exactly the register we are in, and better correlated with human word-recognition than general corpora. Later: drive it from words you have actually saved, which is what asbplayer does."}, {"t": "1.1 Click a word for meaning", "meta": "Cost / dependency: Moderate. The overlay refuses pointer events so it never eats a click meant for the player; making words clickable without losing that needs care.", "b": "Pause, show definition, translation, pronunciation. The study viewer already has a dictionary drawer and a selection popup."}, {"t": "1.2 Save the word with its sentence", "meta": "Cost / dependency: Low. The daemon already has a cache directory and a JSON habit. AnkiConnect is a local HTTP API, so no cloud.", "b": "One click stores word, the line it appeared in, the film and the timestamp. Export to Anki or CSV. The sentence is the point — a bare word list does not stick, and we have the line for free."}, {"t": "1.5 Idiom and slang flagging", "meta": "Cost / dependency: Moderate. Curated list offline; LLM for the long tail.", "b": "Mark phrases whose meaning is not the sum of their words — the cases where a dictionary lookup actively misleads."}, {"t": "1.6 Dual subtitles in the overlay", "meta": "Cost / dependency: Moderate. Mostly layout and a second fetch.", "b": "Target language above, native below. The study viewer does this; the overlay does not. The daemon can already fetch both."}]}
```

### Layer 2 — understanding the story

```oku-step-flow
{"k": "step-flow", "ordered": false, "steps": [{"t": "2.1 Catch me up", "meta": "Tier: T2", "b": "Summarise the film from subtitles up to the playhead and no further. Come back from the kitchen, press a key, read four sentences. Amazon shipped this as X-Ray Recaps, which is validation that it is wanted — but theirs is per-episode and Prime-only, and ours is bounded by your actual position, on any platform."}, {"t": "2.2 Character roster", "meta": "Tier: T2 from labels; T1 if scene-scoped like X-Ray", "b": "Who has appeared so far, built from the speaker labels the annotation work already extracts and colours. Composes almost for free: names are already parsed, already coloured, already stable across cues."}, {"t": "2.3 Explain that line", "meta": "Tier: T2", "b": "Not translate — explain. Why it was funny, what the reference was, what the tone was. Scoped to dialogue up to now."}, {"t": "2.4 Scene map", "meta": "Tier: T0 if labelled by timestamp; T3 if labelled by content", "b": "Chapter markers from gaps between cues — a 20-second silence is almost always a scene boundary. Jump back to a scene without scrubbing."}]}
```

### Layer 3 — understanding the world

```oku-step-flow
{"k": "step-flow", "ordered": false, "steps": [{"t": "3.1 Reference explainer", "meta": "Tier: T2", "b": "Proper nouns, places, historical events, songs, brands — built from named entities in the cues so far. Most valuable exactly when watching films from a culture you do not share, which is much of the point."}, {"t": "3.2 Pre-flight briefing", "meta": "Tier: T3", "b": "Before pressing play: setting, era, and the cultural background needed to follow it, explicitly excluding plot. The one place a non-time-scoped summary is safe, because it is about the world rather than the story."}]}
```

### Layer 4 — making the core flow better

```oku-step-flow
{"k": "step-flow", "ordered": false, "steps": [{"t": "4.1 Automatic sync", "meta": "Cost / dependency: Moderate. Needs tab audio capture and a VAD. Either vendor ffsubsync or reimplement the correlation, which is not large.", "b": "The last manual step in the core flow is nudging the offset when a subtitle was timed against a different release. ffsubsync's method removes it: discretise the subtitle's cue timings and the tab's audio into 10 ms speech / not-speech windows, then cross-correlate. Language-agnostic, no transcription."}, {"t": "4.2 Gap filling", "meta": "Cost / dependency: Moderate, and the one real use for the local Whisper stack.", "b": "When a subtitle is missing a stretch of dialogue, transcribe just that stretch. This is where the Whisper build genuinely earns its place."}, {"t": "4.3 Bookmarks", "meta": "Cost / dependency: Low.", "b": "A key that saves the current cue, timestamp and a screenshot; export the set as notes afterwards. Pairs with 1.2."}, {"t": "4.4 Multi-source fetching", "meta": "Cost / dependency: Moderate. Source abstraction, and file ids become source-qualified, which touches the cache and the extension contract.", "b": "SubDL alongside OpenSubtitles: 300 downloads a day anonymous against 10, plus 2,000 free search requests. Effectively removes quota as a concern and removes single-vendor risk."}]}
```

## What I would build, in order {#plan}

Revised after the research. Everything here except the last item needs no LLM
and no new external service.

```oku-step-flow
{"k":"step-flow","ordered":true,"steps":[
  {"t":"Replay and slow the line","meta":"~half a day · no dependency","b":"The most-used control in every dedicated language-learning tool, and we are two hotkeys from it."},
  {"t":"Known-word highlighting","meta":"~1 day · offline word list","b":"Free at runtime, no spoiler exposure, and it directly answers \"which of these words is worth my attention\"."},
  {"t":"Click a word → meaning → save with its sentence","meta":"~3 days · optional AnkiConnect","b":"The core language-learning loop. The study viewer already has half of it, and AnkiConnect is local so nothing leaves the machine."},
  {"t":"Automatic sync by VAD","meta":"~3 days · tab audio + VAD","b":"Deletes the last manual step rather than adding a feature. Use ffsubsync's approach, not Whisper."},
  {"t":"Multi-source fetching","meta":"~2 days · SubDL","b":"300 downloads/day instead of 10, and no single-vendor dependency."},
  {"t":"Catch me up","meta":"~3 days · needs the LLM decision below","b":"The strongest comprehension feature, and the one that justifies the tier machinery."}
]}
```

## The decision that item 6 forces {#llm-decision}

The daemon has **no runtime dependencies** today, deliberately — it starts with
nothing installed, which is what makes the one-click path one click. Anything
in Layer 2 changes that.

```oku-compare-grid
{"k":"compare-grid","cards":[
  {"t":"Local model via Ollama","verdict":"good","b":"Nothing leaves the machine. Quality is lower and the model has to be resident, but a four-sentence recap from time-bounded input is not a hard generation task. **There is precedent in this repo** — the study viewer already speaks Ollama."},
  {"t":"Hosted API, opt-in","verdict":"warn","b":"Better output, real cost per use, and the subtitles of whatever you are watching leave the machine. Workable if it is off by default and the daemon shows exactly what it is about to send — but it changes the privacy story of a tool that currently has a clean one."},
  {"t":"Neither, for now","verdict":"neutral","b":"Items 1–5 are all useful and need no model. Deferring costs nothing except item 6, and the tier machinery is worth building anyway for the roster and vocabulary features."}
]}
```

> [!NOTE]
> Worth settling **before** building anything in Layer 2, not during. It decides
> whether that layer is a small feature or a new dependency surface, and the
> answer probably differs for you (Ollama, privacy-preserving, already on your
> machine) versus anyone else who might use this.

## Open questions {#questions}

```oku-table
{"k": "table", "headers": ["Question", "Why it matters"], "rows": [["Borrow from asbplayer or build?", "It is open source and does Layer 1 well. Reading its approach to Anki mining and condensed playback would save days. Whether to depend on it, copy from it, or ignore it is a real fork."], ["Which language pair matters most?", "EN→TR changes what is worth building. Turkish dictionary and frequency data is thinner than for major pairs, which pushes toward LLM lookup for 1.1 sooner than I would otherwise suggest."], ["Is this for you, or for other people too?", "A personal tool can assume Ollama, an API key and a terminal. A shared one cannot, and that changes item 6 and the whole install story."], ["Rewatch mode as the primary spoiler control?", "If most of your viewing is first-watch, T0 default plus per-instance reveal is enough and the tier system can stay simple."]]}
```

## Sources {#sources}

Everything in the prior-art section was checked against these rather than
recalled. The quota and feature figures are as documented on 2026-07-30.

- [ffsubsync documentation](https://ffsubsync.readthedocs.io/) — the 10 ms
  window / VAD cross-correlation method, and the 20–30 s figure
- [asbplayer](https://github.com/asbplayer/asbplayer) — condensed playback,
  auto-pause, AnkiConnect mining, word-status styling
- [SUBTLEX word frequency norms](https://www.ugent.be/pp/experimentele-psychologie/en/research/documents/subtlexus)
  and the [word list](https://github.com/words/subtlex-word-frequencies) —
  51M words of subtitle corpus
- [Prime Video X-Ray Recaps](https://dig.watch/updates/prime-videos-x-ray-recaps-offers-personalised-spoiler-free-synopses)
  and [Apple TV InSight](https://www.digitaltrends.com/home-theater/apple-tv-insight-feature/)
  — current-scene scoping as a spoiler strategy
- [SubDL API](https://subdl.com/api-doc) — 2,000 search requests/day free,
  300 anonymous downloads/day
- [Language Reactor alternatives comparison](https://lexpresso.io/blog/language-reactor-vs-migaku-vs-trancy-vs-lexpresso/)
  — feature sets across the category
