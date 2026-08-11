# srt-viewer

**"SRT Study Tool v7"** — one HTML file, opened in a browser, for studying two
subtitle files side by side **when there is no video**.

```bash
cd srt-viewer && ./run-http-server-here.sh     # then open srt-viewer.html
```

It came first. The browser extension does the same job over a film that is
actually streaming; this does it over the `.srt` files on their own, which is
the case where you have the subtitles and not the release, or you want to read
ahead, or you are working through a scene without a player in the way.

## What it does

- Two subtitle files in two columns, paired by timecode rather than by row
  number, so a language that merges two lines into one still lines up.
- Its **own virtual clock** — press play and the subtitles advance at the
  film's pace with no video attached. Start the film in another window at the
  same moment and the two stay together.
- Word and phrase lookup on selection, and a personal dictionary.

## What is in here

| Path | What |
|---|---|
| `srt-viewer.html` | the whole application, one file, no build step |
| `subtitles/` | the working corpus: Battlestar Galactica, English and two machine-translated Turkish files |
| `old-versions/` | v1 to v6, kept because each one is a different answer to the pairing problem |
| `TODO.md` | the original feature list this was built against |

The `subtitles/` files are also the corpus `subtitle-daemon/tests/test_align.py`
runs the aligner over, which is why they are in version control. Three of them
have a whitespace diff that has been in the working tree for a long time —
leave it alone, see the root `CLAUDE.md`.

The Turkish files were produced by `../srt-translator/`, which is where the
names come from (`-TR-gpt5-thinking-web`, `-TR-gpt5-nano-0.27dollars`).

## State

Working, and no longer where the effort goes. Anything about studying a film
that is *playing* belongs in `../browser-extension/`; this stays useful for the
no-video case and as the place the corpus lives.
