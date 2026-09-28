# subtitle-study-tool — working notes for Claude

`README.md` says what each directory is *for*. This file says what you need to
know before changing anything in it. Read both.

## Where the work happens

Almost every session touches `browser-extension/`. It has its own
`CLAUDE.md` with the architecture, the frame model and the invariants that
keep getting rediscovered — **read it before editing anything under
`browser-extension/src/`.**

The other directories are largely stable:

| Directory | Touch it when |
|---|---|
| `browser-extension/` | the overlay, the panel, the study surfaces, subtitle fetch/sync |
| `subtitle-daemon/` | OpenSubtitles access, the on-disk cache, local transcription |
| `srt-viewer/` | the standalone dual-subtitle study page (no video) |
| `srt-translator/` | batch `.srt` translation CLI |
| `subgen/` | Whisper transcription |
| `docs/` | reports and bake-offs; `docs/reports/` is where review write-ups land |

`vendor/` and `models/` are gitignored multi-gigabyte restores from
`scripts/setup-whisper.sh`. Never read them, never search them.

## Conventions that are not obvious from the code

**Commit messages are prose, and carry no AI trace.** Look at `git log`: a
short declarative subject that reads like a sentence about the user's
experience ("Stop at the end of each line, for the reading that needs it"),
then paragraphs explaining what was wrong, what was measured, and what was
deliberately *not* changed. No bullet lists, no `feat:` prefixes, no
`Co-Authored-By`, no 🤖 trailer, no em-dashes (` - ` is used instead). Match
this. It is the repo's house style, not a preference to re-litigate.

**Numbers belong in the message.** The existing commits quote measured
values — "397px of name in 155px of card", "715px and 729px". If a change was
driven by a measurement, the measurement goes in the message.

**Comments explain the failure that forced the code.** The source is dense
with block comments naming the reported symptom ("reported as 'I cannot see
any CC button'"). When you fix something subtle, leave that kind of comment —
it is what stops the next session undoing it.

## Working files that must never be staged

`HANDOFF.md`, `TASK.md`, `SPEC.md`, `REVIEW.md`, `code-review.md`, `notes/`.
These are session artifacts.

**The repository is public; some data beside it is not.** These paths are
gitignored and must stay out of version control - never force-add them, never
copy them into a tracked directory:

- `srt-viewer/subtitles/` - copyrighted film subtitles, the local corpus the
  aligner tests and the bench read when present. Committed test data goes in
  `srt-viewer/samples/`, which is original.
- The directories under `docs/engine-bakeoff/` - transcripts of private
  recordings. Only its README is tracked.
- Report artifacts that quote a film's subtitles line by line (listed in
  `.gitignore`).

The history was rewritten once to remove these; anything re-added is public
the moment it is pushed.

## Nothing is pushed

The whole local history is unpushed by design. Pushing is the user's step.
