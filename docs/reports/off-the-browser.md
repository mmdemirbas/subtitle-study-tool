---
title: Taking the study surface off the browser
summary: What it would cost to have this experience over local files - inside mpv, IINA, VLC or Elmedia, or in the browser itself. With the codec wall measured rather than assumed.
---

> [!TLDR]
> The question is "how do I get this over a local film". Four of the five answers are ports; the fifth is a setting.
>
> - **The browser is already a local player.** The content script matches `<all_urls>` in every frame, so a `file://` page carrying a `<video>` gets the whole surface unchanged - overlay, panel, study strips, deck, aligner. It needs one toggle in `chrome://extensions`.
> - **The wall is one codec, and it is the audio.** Measured on Chrome 151: a Matroska file with H.264 *and* one with HEVC both play from `file://`, while AC-3 audio decodes **zero bytes** in both. The film plays silently. Re-encoding only the audio fixed it in 0.38s per minute of video, video stream copied.
> - **IINA's plugin overlay is a web view.** Of the four native players it is the only one where the existing UI could be carried across rather than rewritten. macOS only, and the JS context is sandboxed from IINA's own API.
> - **mpv can carry every requirement**, through JSON IPC or a script, but the UI has to be rewritten in ASS and per-word hovering means drawing the subtitle yourself.
> - **VLC cannot host this surface.** A Lua extension gets a dialog window of grid widgets and nine OSD text positions. Your installed VLC 3.0.23 has no second subtitle track at all.
> - **Elmedia documents no plugin or scripting API.**

## What does this experience actually require of a host? {#requirements}

Before comparing players it is worth naming what has to be true, because "port the extension" is not one thing. Eight capabilities carry the current surface, and they are not equally hard to find.

```oku-diagram
{"src":"flowchart LR\n  subgraph W[\"What the reader sees\"]\n    D[\"Two subtitle boxes,\\nplaced and resized\"]\n    S[\"Word strips\\n+ focus box\"]\n    P[\"Control panel,\\nsearch and timing\"]\n  end\n  subgraph N[\"What it needs from the host\"]\n    C1[\"playhead, read ~20x/s\"]\n    C2[\"draw arbitrary UI\\nover the video\"]\n    C3[\"hit-test one WORD\\nunder the pointer\"]\n    C4[\"two subtitle tracks,\\nindependent offsets\"]\n    C5[\"load a subtitle\\nfile at runtime\"]\n    C6[\"keys that do not\\nfight the player\"]\n    C7[\"network calls\\n(search, lookup)\"]\n    C8[\"persistent storage\\nfor the deck\"]\n  end\n  D --> C1 & C2 & C4 & C5\n  S --> C2 & C3 & C7 & C8\n  P --> C2 & C6 & C7","caption":"The three surfaces on the left are the product. The eight on the right are what a host has to provide for them to exist at all - and hit-testing a single word is the one that decides most of the comparison."}
```

Capability three is the discriminator. Everything else is available in some form nearly everywhere; "which word is under the pointer, right now, in a line that was laid out by somebody else" is a question only a host that lets you *lay out the text yourself* can answer.

## What does each host offer? {#matrix}

```oku-table
{"headers":["Capability","Browser (today)","mpv","IINA","VLC 3.0 Lua","Elmedia"],"rows":[["Playhead","`video.currentTime`, already read 20x/s","`time-pos` property, observable","`iina.mpv` property access","`vlc.var` / input time","No documented API"],["Draw UI over the video","Full DOM in a shadow root","ASS text via `osd-overlay`, bitmaps via `overlay-add`","**A web view.** HTML, CSS, WebGL","`osd.message` at one of nine fixed positions","-"],["Hit-test a word","Native: the word is an element","Only if you draw the line yourself and compute rectangles from `osd-dimensions`","Native inside the web view, once you draw the line there","**No**","-"],["Two subtitles, independent offsets","Two boxes, `offsetMs` each","`sid` + `secondary-sid`, `sub-delay` + `secondary-sub-delay`","Inherited from mpv","**Not in 3.0.23.** Reported for 4.0, still pre-release","Single track"],["Load a subtitle at runtime","`attach()` with parsed cues","`sub-add <url>`","Same","Playlist / input item","Manual, via the open dialog"],["Keys","Bound in-page, off by default","`mp.add_key_binding`","Same, plus menu items","`vlc.keyboard`-less; extension menu only","-"],["Network","Service worker with host permissions","No sandbox: the script can open sockets, or the IPC client does it","Plugin permissions in `Info.json`","Lua `vlc.stream` / `vlc.net`","-"],["Storage","`chrome.storage`, unlimited","Files beside the script","Plugin data directory","Files","-"]]}
```

Two columns are answers and three are not. IINA and the browser can host the surface as it exists; mpv can host a rewritten one; VLC and Elmedia cannot host it at all.

## mpv: everything, in a different language {#mpv}

mpv exposes more of itself than any of the others. Three ways in - as a UNIX process, as `libmpv`, or as a script (Lua, JavaScript on MuJS, or a C plugin) - and a JSON IPC socket for an external program.

```oku-annotated-code
{"src":"mpv --input-ipc-server=/tmp/mpvsock film.mkv\n\n{\"command\":[\"observe_property\",1,\"time-pos\"]}                (1)\n{\"command\":[\"observe_property\",2,\"sub-text\"]}\n{\"command\":[\"observe_property\",3,\"secondary-sub-text\"]}     (2)\n\n{\"command\":[\"sub-add\",\"/films/tr.srt\",\"auto\",\"Turkish\",\"tr\"]} (3)\n{\"command\":[\"set_property\",\"secondary-sid\",2]}\n{\"command\":[\"set_property\",\"secondary-sub-delay\",-1.25]}      (4)\n\n{\"command\":[\"osd-overlay\",0,\"ass-events\",                     (5)\n  \"{\\\\an5\\\\pos(960,120)\\\\c&H00D0FF&}reckoning{\\\\r} - hesaplasma\",\n  0,0,960,540,true]}","lang":"json","annotations":[{"id":1,"content":"The playhead, pushed rather than polled. This is the one requirement mpv answers better than the browser does."},{"id":2,"content":"Both subtitle tracks as plain text, with <code>sub-text/ass</code> and <code>sub-text/ass-full</code> if the styling matters. The pairing this tool is built on comes free."},{"id":3,"content":"An external file loaded mid-playback, exactly as the extension attaches one."},{"id":4,"content":"Per-track offsets: <code>sub-delay</code> and <code>secondary-sub-delay</code> are two independent numbers, which is the same model the extension already has."},{"id":5,"content":"The UI. ASS positioning tags can draw almost anything, but it is a text format with no layout engine and no events - the ID namespace is per client, so at least two scripts cannot fight over it."}]}
```

What that buys and what it does not:

- **The data model is already there.** Two tracks, two delays, the current text of each, the playhead. Nothing has to be invented, and `align.js` would work unchanged on the cue lists.
- **The UI is a rewrite.** `panel.css` is 61KB of CSS and `overlay.css` is another 22KB; none of it survives. ASS gives positioning and colour, not flexbox, not container queries, not a shadow root.
- **Hovering a word means owning the line.** mpv reports the subtitle's *text*, never its geometry. To know that the pointer is over "reckoning" you would set `--sub-visibility=no`, draw the line yourself with `osd-overlay`, and compute each word's rectangle from `osd-dimensions` and your own font metrics. That is a real piece of work, and it is the piece that makes the study surface what it is.
- **The IPC socket is explicitly insecure** - the manual says so, and the `run` command is exposed over it. Local use only, and the socket path matters.

## IINA: the overlay is a web view {#iina}

IINA is mpv underneath, with a macOS interface and a JavaScript plugin system on JavaScriptCore. Its `Overlay` module is the one thing in this whole comparison that changes the answer: it renders **HTML, CSS and WebGL on top of the video**, either from a file or by setting content and style directly.

```oku-compare-grid
{"cards":[{"t":"Carries across almost unchanged","verdict":"good","b":"`overlay.css`, `study.css`, `panel.css` and the DOM building in `content.js` / `study.js` / `panel.js`. The overlay is a web view, so the boxes, the strips, the focus box, the hover, the per-word hit-testing and the drag-to-place all keep working the way they do now. `align.js`, `rarity.js`, `deck.js` and the frequency tables are plain modules and move as-is."},{"t":"Has to be rebuilt","verdict":"warn","b":"Everything that reaches for the browser: `chrome.storage` becomes the plugin's data directory, the service worker's fetches become plugin HTTP calls declared in `Info.json`, and every read of `video.currentTime` becomes an observed mpv property arriving by `iina.postMessage`. The web view is sandboxed from IINA's API - it can only exchange messages with the plugin script, which is the same shape as the extension's frame-to-worker calls."},{"t":"Does not carry across at all","verdict":"bad","b":"The frame model, the CC handle, ad-drift detection, the site-level auto-attach, `chrome.commands`, and the whole hostile-page defence - the shadow root, `all: initial`, adopted stylesheets. Inside a plugin's own web view there is no hostile page to defend against, so most of that is not lost, it is unnecessary."}]}
```

The cost of IINA is what it is not: macOS only, one player, and a plugin system whose JavaScript engine version tracks the OS. The cost of *not* choosing it is that no other native player lets the existing interface exist.

## VLC: what a Lua extension can and cannot draw {#vlc}

VLC's Lua surface is documented in the source's own README, and it is smaller than its reputation suggests. Five script types exist - playlist parsers, art fetchers, interfaces, extensions and services discovery - and an *extension* gets exactly two output channels.

```
-- 1. a dialog window (Lua), laid out on a grid of widgets
local d = vlc.dialog("Subtitle study")
d:add_label("reckoning", 1, 1, 1, 1)
d:add_html("<b>hesaplasma</b> - a settling of accounts", 1, 2, 4, 1)
d:add_button("Save", save_word, 1, 3, 1, 1)
d:show()

-- 2. text on the video, at one of nine fixed anchors
vlc.osd.message("reckoning - hesaplasma", channel, "bottom-left", 4000000)
```

*The whole of what a VLC extension can put on the screen, from the API in `share/lua/README.txt`.*

A dialog is a separate window with widgets placed by row and column; `osd.message` writes a line of text at one of nine anchors for a number of microseconds. There is no element under the pointer, no hover, no layout, no shadow root, and no way to know where a word was drawn.

Two further findings, both from the copy of VLC on this machine:

- **VLC 3.0.23 has no second subtitle track.** `--longhelp --advanced` lists no `--secondary-*` subtitle option at all. Dual subtitles are reported in the VideoLAN forums as a VLC 4.0 feature, and 4.0 is still pre-release.
- **The only extension VLC ships is VLSub** - which is, precisely, an OpenSubtitles *downloader* written in Lua. That is the shape a VLC integration would take: fetch and attach, not study.

> [!NOTE]
> This does not say VLC is a poor player. It says the thing being ported is a user interface, and VLC's extension API was designed for fetchers and playlist parsers rather than for interfaces over the picture. A "port to VLC" would keep the search, the ranking, the download and the sync, and drop everything the last three months of work went into.

## Elmedia: nothing documented {#elmedia}

Elmedia is closed source. Its own feature pages describe subtitle handling - external SRT, SSA and SMIL, encoding options, subtitle burning - and neither the vendor site nor a targeted search surfaces a plugin API, an SDK, a scripting dictionary or an automation interface.

Stated at the right strength: **no integration surface is documented.** That is not the same as proving none exists - an AppleScript dictionary can ship without being advertised, and the honest way to settle it is `sdef /Applications/Elmedia*.app` on a machine that has it installed. If it turns out to expose only play, pause and open, that is still not enough for anything here: the requirement that fails is drawing over the video, and no scripting dictionary provides that.

## The browser is already a local player {#browser}

The cheapest option is the one that needs no port. The extension's content script matches `<all_urls>` in all frames; Chrome's match-pattern documentation says `<all_urls>` covers `file:///` once the user grants it, which is a checkbox on the extension's own page in `chrome://extensions`. Open a local video in a tab and the overlay, the panel, the study strips, the deck and the aligner are all there, because none of them know or care what the page is.

So the only question is what Chrome can decode. That is measurable, so it was measured rather than looked up.

```oku-chart
{"type":"bar","title":"Audio bytes decoded in one second of playback - Chrome 151, three Matroska files over file://","rows":[{"label":"MKV · H.264 · AAC","value":11596,"display":"11,596 bytes"},{"label":"MKV · H.264 · AC-3","value":0,"display":"nothing"},{"label":"MKV · HEVC · AC-3","value":0,"display":"nothing"}]}
```

Every one of the three files played, and every one decoded video - 9,282, 9,326 and 8,370 bytes in the same second, the HEVC file included. `currentTime` advanced, `videoWidth` was 320, no `MediaError` fired. **The two AC-3 files decoded no audio at all** - `webkitAudioDecodedByteCount` stayed at zero while the video counter climbed - and nothing in the page said so. A film would play as a silent film.

That is a much narrower problem than "the browser cannot play films", and it has a cheap fix, because the video stream does not need touching:

```bash
# audio re-encoded, video copied, container rewritten
ffmpeg -i film.mkv -c:v copy -c:a aac -movflags +faststart film.mp4
# measured: 60s of 1280x720 in 0.38s real on this machine
```

At that rate a 90-minute film is well under a minute of work. The comparison transcode - re-encoding the video as well - took 1.28s real and 7.3s of CPU for the same minute, and that figure should *not* be extrapolated: the test source is synthetic and trivially compressible, where real film content is not. The remux figure generalises because the video stream is copied byte-for-byte whatever it contains.

```oku-info-tip
{"summary":"Where that remux should live, and why the daemon is the obvious host","content":["The daemon already runs on 127.0.0.1:8791, already holds an on-disk cache, and already has a Python HTTP surface the extension talks to. Handing it a local path and getting back a URL the browser can play is a small addition to something that exists, rather than a new component.","It also solves a second problem quietly: a file served over HTTP supports range requests and seeking without the browser holding the whole thing, and the page can then be a normal page rather than a <code>file://</code> one - which means the file-access toggle stops being necessary at all.",{"k":"code","src":"POST /local/open   {\"path\": \"/films/bsg.mkv\"}\n  -> {\"url\": \"http://127.0.0.1:8791/local/3f2a\", \"remuxed\": true,\n      \"why\": \"ac-3 audio is not decodable in this browser\"}","lang":"json"},"The check for whether a remux is needed is the same <code>canPlayType</code> probe used above, run in the page and sent to the daemon - so a machine whose browser handles the file is never asked to wait."]}
```

## What I would do, and in what order {#plan}

```oku-step-flow
{"ordered":true,"steps":[{"t":"Turn on file access and watch something","meta":"5 minutes · no code","b":"`chrome://extensions` -> this extension -> Allow access to file URLs. Open an MP4 with H.264 and AAC in a tab and press the attach shortcut. This is the honest first step because it either delivers the whole experience today or produces a specific failure worth fixing."},{"t":"A local-file page in the extension","meta":"1 day","b":"An extension page with a file picker, a `<video>`, and nothing else - so the film is not at the mercy of whatever Chrome's built-in viewer does, drag-and-drop works, and the last-opened folder can be remembered. The overlay attaches to it unchanged."},{"t":"Codec probe and a spoken reason","meta":"half a day","b":"Run `canPlayType` on the file's actual tracks and say what will happen before it plays. A silent film with no message is the worst failure available here, and it is the default one."},{"t":"Remux through the daemon","meta":"2 days","b":"`-c:v copy -c:a aac`, cached beside the subtitle cache, served over the loopback origin the extension already talks to. Clears the only measured wall, and removes the need for the file-access toggle as a side effect."},{"t":"Only then, decide about IINA","meta":"a week or more","b":"It is the only native player whose overlay is a web view, so it is the only one worth the port - but it buys a second player on one operating system, and everything above buys every film on every platform the browser runs on. Worth doing when the browser path has been used enough to know what it lacks."}]}
```

mpv and VLC do not appear on that list, and the reason is worth stating plainly rather than leaving as an omission: mpv would mean rewriting the interface in a text format that has no events, and VLC would mean not having the interface. Neither is a bad player; both are bad hosts *for this*.

## Questions this leaves open {#questions}

```oku-table
{"headers":["Question","Why it decides something"],"rows":[["Is the local-file case actually about films, or about lectures and recordings?","A downloaded film is MKV with AC-3 and needs the remux. A phone recording or a YouTube download is MP4 with AAC and needs nothing at all. If it is mostly the latter, step four never has to be built."],["Does your Chrome behave like the one measured?","Chrome 151.0.7922.138 on this machine, headless, Apple Silicon. HEVC support in particular is hardware- and platform-dependent, and a machine that lacks it fails differently - video, not audio."],["Would a standalone app ever be wanted?","Wrapping the existing web UI around libmpv (Tauri or Electron) is the fifth option and the largest: it keeps every line of the interface, gains every codec, and costs an installer, an update path and a platform matrix. Only worth raising if the answer to the first question is 'films, always, and I want one icon in the dock'."],["Is Elmedia specifically wanted, or a player that plays anything?","If it is the second, this is settled: the browser plus a remux, or IINA. If it is specifically Elmedia, the next step is `sdef` against the installed app to see whether anything is scriptable at all."]]}
```

## How this was established {#sources}

Split by how each claim was arrived at, because they are not equally strong.

**Run on this machine** - Chrome 151.0.7922.138, macOS on Apple Silicon, 18 August 2026:

- Three Matroska files built with ffmpeg 9.0 (`testsrc` + `sine`), played from `file://` with `webkitAudioDecodedByteCount` and `webkitVideoDecodedByteCount` read after one second of playback.
- `canPlayType` across thirteen MIME strings: `ac-3`, `ec-3` and `audio/vnd.dts` all answered `""`; `hvc1`, `hev1`, `av01`, `vp9` and Matroska with H.264 all answered `probably`.
- `ffmpeg -c:v copy -c:a aac` timed on 60 seconds of 1280x720.
- VLC 3.0.23 Vetinari: `--longhelp --advanced` searched for a secondary subtitle option (none), and `share/lua/extensions/` listed (VLSub only).

**Read in the vendor's documentation:**

- [mpv manual](https://mpv.io/manual/stable/) - `sub-text`, `secondary-sub-text`, `sub-text/ass`, `sid` / `secondary-sid`, `sub-delay` / `secondary-sub-delay`, `sub-add`, `osd-overlay`, `overlay-add`, `osd-dimensions`, `--input-ipc-server` and its security note, the Lua / JavaScript / C plugin backends.
- [IINA plugin API](https://docs.iina.io/) and [Overlay](https://docs.iina.io/interfaces/IINA.API.Overlay.html) - the overlay as a web view, `loadFile`, `simpleMode`, `setContent`, `setStyle`, `setClickable`, `postMessage` / `onMessage`, the per-player plugin instance, JavaScriptCore.
- [VLC Lua README](https://raw.githubusercontent.com/videolan/vlc/master/share/lua/README.txt) - the five script types, `vlc.dialog` and its grid widgets, `osd.message` with nine positions.
- [Chrome match patterns](https://developer.chrome.com/docs/extensions/develop/concepts/match-patterns) - `file:///` requires the user to grant access manually.
- [MDN container formats](https://developer.mozilla.org/en-US/docs/Web/Media/Guides/Formats/Containers) - which containers browsers support. Note that the measurement above contradicts the obvious reading of this page: Matroska is not listed, and Chrome played it anyway.

**Weaker, and marked as such:**

- VLC 4.0 dual subtitles: [VideoLAN forum threads](https://forum.videolan.org/viewtopic.php?f=7&t=154662), not vendor documentation, and 4.0 is unreleased.
- Elmedia having no plugin API: an absence across [the vendor's own feature pages](https://mac.eltima.com/media-player.html) and a targeted search. An absence is not a proof.
