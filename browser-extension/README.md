# Subtitle Overlay (browser extension)

Puts subtitles on a video that has none, in the tab you are already watching.

## Install

Chrome, Edge, Brave or any Chromium browser:

1. Open `chrome://extensions`
2. Turn on **Developer mode** (top right)
3. **Load unpacked** → select this `browser-extension/` directory
4. Open the extension's **options** and paste an OpenSubtitles API key
   (opensubtitles.com → your account → Consumers → new consumer)

There is no icon file, so the toolbar shows a default placeholder. Pin it.

## Do I need the daemon?

Not for subtitles. The extension does the whole thing itself — search, rank,
download, decode, annotate, cache — and only defers to the daemon when the
daemon happens to be running.

Start the daemon (`cd ../subtitle-daemon && ./run.sh`) when you want:

- **Local transcription**, for a film with no subtitle anywhere. That needs a
  model and audio capture, which a browser extension cannot do.
- **The cache on disk**, shared with the SRT viewer and surviving a browser
  profile reset.
- **The API key out of the browser**, in `config.local.json` instead.

When it is running it answers everything and the extension's own key is unused.

### Two caches, kept in step

The extension cannot read or write the daemon's cache folder — an extension has
no filesystem. So each keeps its own store with the same schema, and whenever
the daemon is running, anything either side has downloaded is copied to the
other. A download is never spent twice, whichever side spent it the first time.

The copy runs automatically when the daemon comes up, before any search. There
is a **Sync now** button on the options page if you want to force it.

### Managing what has been downloaded

The options page lists every subtitle held, with the film, language, when it was
downloaded, its size, and which store it is in. Each row has a **Delete**, and
there is a **Delete all subtitles** — which asks first, because getting them
again is metered.

**Forget cached searches** is separate and safe: it only drops the six-hour
memory of search results, so the next search asks OpenSubtitles again. Searching
is free and unlimited; downloading is not.

Deleting with the daemon stopped still works. The deletion is queued and applied
the moment the daemon next runs — without that, the next sync would see the
daemon still holding the file, decide the browser was missing it, and copy it
back, so the delete button would quietly undo itself.

### Is it really the same subtitle?

The pipeline exists twice — Python in the daemon, JavaScript here — so the two
are checked against each other rather than trusted. The symbol tables are
generated from the Python (`subtitle-daemon/tools/export_tables.py`), and
`subtitle-daemon/tests/test_js_parity.py` runs both copies over the same
annotations and subtitle files and diffs every cue: same runs, same symbols,
same speaker colours, same encoding, same match scores.

### After changing the code

Reloading the extension does **not** update tabs that are already open — they
keep running the previous content script until navigated, which makes changes
look like they did nothing. The service worker now re-injects on install and
update, and repairs a stale tab on the next command, so a page reload should no
longer be necessary. If something still looks unchanged, reload the page.

New keyboard commands are a separate trap: Chrome does not always bind a
`suggested_key` that was added to an extension already installed. Check
`chrome://extensions/shortcuts` — the popup lists the live bindings, and shows
*unset* when this has happened.

## Use

**The fast path:** press <kbd>⌘⇧S</kbd>. It works out what the page is playing,
searches, and puts the best match on screen. If nothing matches the title well
it opens the control panel instead of guessing — it will not spend a download
on a film it is not confident about.

With two languages in your preferences it attaches **both** — the first in each
language, side by side. That costs two downloads instead of one, which is the
whole cost of a dual-language setup and is why it only happens when the second
language matched the film as well as the first did. One language configured, or
nothing good in the second: one subtitle, exactly as before.

**The control panel:** <kbd>⌘⇧K</kbd>. Search, timing, appearance and key
bindings, in a draggable panel over the video. This is the main surface. It
lives in the page rather than in the toolbar popup because **a popup cannot be
opened while the page is fullscreen**, which is exactly when you need to fix
timing.

**The CC button** fades in over the video when you move the mouse, and opens the
same panel. It appears only where there is something to watch: not on a page
without a video, and not over a feed row playing a hover preview — a preview is
a real `<video>` with the film's whole duration, which is why the button used to
turn up on the YouTube home page. It is ruled out by sitting inside the link
that opens it, and by being a small part of the window. A player it declines to
decorate is still reachable with <kbd>⌘⇧K</kbd> and from the toolbar.

The toolbar popup is a launcher and a status readout — which side is answering,
whether a subtitle is attached, and the current shortcuts.

### Keys

The in-page keys are **off until you turn them on**, in the panel's Keys
section. They are nine unmodified letters on a page that belongs to somebody
else, and a player that binds letters of its own would fight them.

| Key | Effect |
|---|---|
| <kbd>⌘⇧S</kbd> | Find and attach subtitles |
| <kbd>⌘⇧K</kbd> | Control panel |
| <kbd>⌘⇧X</kbd> | Hide / show subtitles |
| <kbd>G</kbd> / <kbd>H</kbd> | Shift subtitles 0.25s earlier / later |
| <kbd>Shift</kbd> + <kbd>G</kbd> / <kbd>H</kbd> | Shift by 1s |
| <kbd>T</kbd> / <kbd>Y</kbd> | Play this line again / skip to the next line |
| <kbd>B</kbd> | Reset the offset |
| <kbd>P</kbd> | Control panel |
| <kbd>V</kbd> | Hide / show subtitles |
| <kbd>S</kbd> | Study mode |
| <kbd>D</kbd> | Save the word at the top of the study rail |

<kbd>T</kbd> and <kbd>Y</kbd> sit directly above <kbd>G</kbd> and <kbd>H</kbd>,
which is why they were picked: the pair below moves the subtitle against the
film, the pair above moves the film itself, and both keep the same left-is-back,
right-is-forward sense. <kbd>T</kbd> starts the line being spoken over — which is
what you want after missing one — so it takes a second press to reach the line
before. Both are also buttons on each subtitle's card in the panel.

With two subtitles attached the nudge and line keys act on one of them, and the
panel says which. Working it out from where the pointer happens to be resting
would make the answer depend on something you are not looking at.

In-page bindings are stored as the **character the keyboard types**, not the
physical key. They were codes once, which keeps a binding in the same place on
every layout — but the place is the only thing about it you cannot see: on a
Turkish Q layout the two keys right of P print ğ and ü, and "the shortcut is
`BracketLeft`" tells nobody which key to press. The defaults are letters for the
same reason, since a letter is on every Latin layout without a modifier. All of
them are rebindable in the panel: click a binding, press the key you want. The
⌫ beside each one switches that binding off by itself.

The ⌘⇧ shortcuts are Chrome's, changed at `chrome://extensions/shortcuts`.

The offset is remembered per subtitle file, so a film you come back to keeps
the correction you already made.

## Two subtitles at once

The language you are learning and the one you already know, on screen together,
timed against the same clock. Left and right halves by default; **Stacked** puts
one above the other; either way each box is dragged and resized on its own, and
the arrangement buttons are one-shot actions rather than a mode, so they never
argue with a drag.

Two rather than any number. A third line has nowhere to go that is not on top of
the film, and the moment the count is open-ended every part of this — which one
the keys move, which one is being learnt, where they all go — turns into a
question that has to be asked. Two is what a learner uses and it leaves all of
those answers implicit.

The offsets are separate, because they belong to the files: two subtitles for
the same film are routinely timed against different releases, so syncing one
says nothing about the other. Ad breaks are shared, because an ad interrupts the
video rather than one of the files.

The boxes are anchored by their **bottom** edges. That is what keeps a two-line
cue beside a one-line cue reading as a pair, and it also stops a subtitle
sliding down the screen as a sentence grows onto a second line.

## Study mode

Press <kbd>S</kbd>. The words in each line that are rare in film dialogue get
underlined, and a column at the side says what they mean as the film runs —
without the mouse being touched. <kbd>D</kbd> keeps the one at the top, with the
line it was said in, the same moment in the other subtitle, the film and the
timestamp.

The line is the point. A word list is nearly useless a week later — "warrant" on
its own is four meanings and no register — whereas the same word under the
sentence somebody said it in, in a film you watched, is a memory you already
have. So an entry is saved with all of that or not at all. The options page
lists the deck and exports it as TSV for Anki, or JSON for everything.

**What counts as rare** is a rank in a frequency list built from the
OpenSubtitles corpus, which is the right corpus for the question: a word can be
common in print and vanishingly rare in speech. The threshold is a slider,
because the right value is a property of the reader — around rank 2,000 for a
beginner, 12,000 for somebody comfortable — and nothing else can know which of
those is on the sofa. The tables are generated by `tools/build-frequency.mjs`
from hermitdave/FrequencyWords (MIT) and committed.

**Gestures.** Hovering a word looks it up, because a click is a pause and the
film is playing. Clicking a word pins its card; clicking anywhere else on the
subtitle still reaches the player, and dragging still moves the box, both
exactly as with study mode off. Shift and sweep across several words looks up
the phrase — idioms are the reason: "give it a rest" is four common words and
looking up any one of them answers nothing.

Words only become individual elements while study mode is on, so nothing about
ordinary watching changes when it is off — including the cost of rendering every
line of every film.

**Where definitions come from.** The daemon when it is running. Without it the
extension can ask `api.dictionaryapi.dev` itself, but only after you allow it on
the options page — the extension declares one host permission today and that
stays true for anyone who never turns lookup on. Marking rare words and saving
them with their line need no network at all, so they work either way; the
definition is enrichment and its absence is reported as such.

There is no translation. That would mean either a hosted API with a key and a
cost per call or a local model that has to be resident, and neither decision has
been made. It matters less than it sounds: with two subtitles up, the sentence
is already translated by a human in the other one, and the card shows that line.

## When a page does not work

The control panel has **Diagnose this page**. It asks every frame of the page
what it can see, runs the real search-and-decide code, and opens a report.
Nothing is downloaded — searching is free, and the capture never fetches a
subtitle.

It exists because the failures worth diagnosing are invisible from any one
place. The page metadata is in one frame and the video in another; the title
that got searched for is not the title on screen; the content script loaded in
three frames and not the fourth. Each of those is a question about which frame
saw what, and no frame can answer it about the others — only the service worker
can, because it is the only thing that can address them all.

The report leads with the answer rather than the data: which frame the extension
believed and why, what it searched for and where that title came from, whether a
season and episode were sent, and what it decided. Then the same search run
against the top frame, so "it asked the wrong frame" is a comparison instead of
a theory.

Two things are worth knowing about it:

- **It reports what the code does, not a description of it.** The auto-attach
  decision is one function, called by the shortcut and by the report. A second
  copy would drift, and a diagnostic that disagrees with the code it describes
  sends you after the wrong bug with a document backing you up.
- **It carries no secrets.** No API key, no cookies, no media URLs. Frame
  addresses are cut back to their origin and first path segment, because a
  player's URL is often a signed one. The page's own address stays — it is the
  thing being diagnosed.

## Why sync is not a problem here

The usual difficulty with an external subtitle track is guessing how far ahead
or behind the video it is, then watching that guess drift.

None of that applies in a browser. The `<video>` element exposes
`currentTime`, and the overlay reads it 20 times a second. Seeking, pausing,
buffering and playback-rate changes are all reflected immediately, because the
overlay is not keeping its own clock — there is nothing to drift.

What remains is the offset baked into the subtitle file itself, from being
timed against a different release of the film. That is a constant, you set it
once with <kbd>G</kbd> and <kbd>H</kbd>, and it is saved.

## Working out what is playing

The tab title is the weakest signal available. Prime Video calls a detail page
`Prime Video: Crime 101`; other sites bolt on resolutions, episode numbers and
marketing. So the content script reads `og:title`, `twitter:title` and JSON-LD
`Movie`/`TVEpisode` entries first — what the site tells crawlers the page is
about — and falls back to the tab title only if none of those exist.

Whatever comes out is still a guess, so the panel shows it and lets you correct
it, and auto-attach refuses to download anything that does not match it well.
That guard exists because the first version had none: it downloaded the top
fuzzy hit for `Prime Video: Crime 101` and displayed subtitles for an unrelated
2007 Japanese horror film.

## Why the panel is in a shadow root

Injected UI competes with the host page's stylesheet, and the page usually
wins. Verified against a page carrying two rules of a kind streaming sites ship
routinely:

| Page rule | Effect on a light-DOM panel |
|---|---|
| `button { font-size: 40px !important }` | every control resized |
| `div { line-height: 3; letter-spacing: 2px }` | inherited through, layout pulled apart |

`all: initial` on the panel root does not help: it resets the root only, never
its descendants. A shadow boundary does, so the panel lives in one.

Two consequences worth knowing before editing:

- The host element carries **geometry only** — position, width, z-index, all
  inline `!important`. Nothing visual, because anything visual there would be
  fighting the page forever. Appearance is on `.sso-panel` inside the shadow.
  `:host` rules are not used for anything load-bearing: inline `!important`
  outranks them, and page rules outrank `:host` for normal declarations anyway.
- Events crossing a shadow boundary are **retargeted to the host**, so
  `event.target` at document level reports a plain div. The key handler reads
  `event.composedPath()[0]` instead; otherwise typing `[` or `]` into the
  panel's own search box would nudge the subtitle timing.

Styles load as a constructable stylesheet via `adoptedStyleSheets` rather than
a `<style>` element, because adopted sheets are not subject to the page's
Content-Security-Policy and streaming sites tend to ship a strict `style-src`.

## Two implementation details that matter

**Fullscreen.** When a player goes fullscreen the browser renders only the
fullscreen element's subtree, so an overlay parented to `<body>` silently
disappears. The overlay re-parents itself to `document.fullscreenElement` on
every fullscreen change.

**Frames.** Streaming players usually live in an iframe, so the content script
runs in all frames. Frames without a usable video do nothing; the popup and the
service worker enumerate frames and address the one that has the player. That
also keeps status messages visible in fullscreen, where a toast in the top
frame would not be rendered.

The video is chosen as the largest one with a duration over a minute,
preferring a playing one — which skips ad slots, preview loops and hidden
elements.

**Daemon calls go through the service worker.** MV3 content scripts cannot make
cross-origin requests with extension permissions, and the daemon's origin
allowlist would refuse the page's origin anyway. The panel and popup both send
their daemon calls to the background worker, which is the only thing holding
the host permission.

## Boundaries

- The extension talks only to `http://127.0.0.1:8791`. It has no other host
  permission, so the OpenSubtitles API key never enters a web page. The
  dictionary origin is declared as *optional* and requested on the options page,
  so it is granted only by someone who wants lookup without the daemon.
- The deck is stored in the browser and goes nowhere. Nothing about what you
  watched or saved leaves the machine unless you export it.
- **DRM-protected video** (Netflix, Prime Video, Disney+) works for the
  overlay: the DOM overlay draws over protected video, and `currentTime` is
  readable. What will not work is future audio capture for live transcription,
  since protected streams yield silence.
- Subtitle text is inserted with `textContent`, never `innerHTML`, so subtitle
  markup cannot execute in the page.

## Not done yet

- No icon assets.
- Only tested against Chromium. The manifest is plain MV3 and `moz-extension://`
  is already in the daemon's origin allowlist, but Firefox is untested.
- Live transcription fallback is not wired in — see the repo README.
