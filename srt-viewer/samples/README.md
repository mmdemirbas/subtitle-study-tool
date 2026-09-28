# Samples

`night-ferry-EN.srt` and `night-ferry-TR.srt` are one short scene - two
strangers on a night ferry - written for this repository in English and
Turkish. 84 cues, six minutes, and the two files share every cue boundary,
the way two languages from the same release do. There are italic cues and
two-line cues, so the parsers see both.

They are the committed test data: `subtitle-daemon/tests/test_js_parity.py`
runs both parsers over them, and the tools that need a file default to them.
They are too short to say anything about alignment on a real film; the tests
that do read the local corpus in `../subtitles/` when it is there.

Same license as the repository.
