/* Decoding subtitle bytes and turning SRT into cues.
 *
 * Port of subtitle-daemon/src/subtitle_daemon/subtitles.py.
 */

import { CANDIDATE_ENCODINGS } from "./tables.generated.js";
import { parse, plainText, runToJson, toVtt as markupToVtt } from "./markup.js";

/* Signs a decode went wrong even though it did not fail: U+FFFD, and the C1
 * control block, which is what cp1254 bytes turn into once latin-1 mangles
 * them.
 *
 * Written as escapes, not as the characters themselves. It held the literal
 * U+0080 and U+009F, which are invisible in every editor and survive only as
 * long as nothing normalises the file - and if they were ever lost, this would
 * still be a valid regex matching almost nothing, so every mangled decode would
 * score clean and the encoding heuristic would quietly pick the wrong one. */
const MOJIBAKE = /[\uFFFD\u0080-\u009F]/g;

/* Letters that indicate a decode went right for the languages in play: Turkish
 * c-cedilla, g-breve, dotless i, dotted I, o/u-diaeresis, s-cedilla, plus the
 * circumflex vowels of older orthography. */
const EXPECTED_LETTERS = /[çğıİöşüÇĞÖŞÜâîû]/g;

/* Something to read: any letter in any script, or any digit.
 *
 * A cue whose whole content is punctuation is a mark the subtitler left to say
 * something is happening that they are not writing down - and the overlay draws
 * it as a box over the picture at the exact moment the picture is carrying the
 * words instead of the file. Reported as a subtitle that is "only - or _ ...
 * blocking the view unnecessarily".
 *
 * Measured over the 180 files in the download cache: 415 of 170,252 cues have
 * nothing to read in them, spread over 16 files. 232 are a lone "_", 88 a run
 * of asterisks, 73 are music marks with no lyrics, 8 a lone copyright sign, and
 * the rest are stray dots and dashes. The Americans is the worked example and
 * the one already documented elsewhere in this repository: the show burns
 * English subtitles into the picture for the Russian dialogue, and the English
 * .srt writes "_" through those scenes so the reader can see the file has not
 * given up. One episode spends 67 of its 626 cues that way.
 *
 * Letters and digits rather than a list of the marks actually seen, because the
 * next file will use a different one and an allowlist has to be extended for
 * every one of them. This is exactly Python's `[^\W_]` - checked over all
 * 1,114,112 code points, the two disagree on none - so the daemon's copy of
 * this parser cannot drift from it. */
const READABLE = /[\p{L}\p{N}]/u;

const TIMECODE =
  /(\d{1,3}):(\d{2}):(\d{2})[,.](\d{1,3})\s*-->\s*(\d{1,3}):(\d{2}):(\d{2})[,.](\d{1,3})/;

/* Python's encoding names against the labels the Encoding Standard uses.
 *
 * `latin-1` is deliberately absent: in the Encoding Standard "iso-8859-1" is an
 * alias for windows-1252, which maps 0x80-0x9F onto printable characters
 * instead of the C1 controls latin-1 gives. Those C1 controls are exactly what
 * the mojibake penalty looks for, so routing latin-1 through TextDecoder would
 * score a mangled decode as clean and hand back the wrong text. It is done by
 * hand below instead. */
const DECODER_LABELS = {
  "utf-8-sig": "utf-8",
  "utf-8": "utf-8",
  cp1254: "windows-1254",
  cp1251: "windows-1251",
  cp1250: "windows-1250",
};

/** latin-1 is the identity map from byte to code point. */
function decodeLatin1(bytes) {
  let out = "";
  for (let i = 0; i < bytes.length; i += 1024) {
    out += String.fromCharCode.apply(null, bytes.subarray(i, i + 1024));
  }
  return out;
}

/* `fatal` mirrors Python, where `bytes.decode(enc)` raises on a byte the
 * encoding does not define. Without it TextDecoder silently substitutes U+FFFD
 * and every candidate "succeeds", which would discard the whole point of
 * scoring them. */
function tryDecode(bytes, encoding) {
  if (encoding === "latin-1") return decodeLatin1(bytes);
  const label = DECODER_LABELS[encoding];
  if (!label) return null;
  try {
    return new TextDecoder(label, { fatal: true }).decode(bytes);
  } catch {
    return null;
  }
}

const countOf = (text, pattern) => (text.match(pattern) || []).length;

/**
 * Decode subtitle bytes, returning `{text, encoding}`.
 *
 * Valid UTF-8 wins outright. Everything else is scored, because latin-1 never
 * fails and would otherwise always win.
 *
 * The short-circuit is not an optimisation, it is the correctness fix. Scoring
 * UTF-8 against the 8-bit encodings looks even-handed and is not: the bytes of
 * a music note, E2 99 AA, read as cp1250 give "â™Ş", and the trailing Ş is a
 * Turkish letter the scoring rewards. So a UTF-8 file full of "♪♪♪" scored
 * *higher* as cp1250 and every note became mojibake - 92 occurrences in an
 * eight-subtitle corpus.
 */
export function decode(bytes) {
  for (const encoding of ["utf-8-sig", "utf-8"]) {
    const text = tryDecode(bytes, encoding);
    if (text !== null) return { text, encoding };
  }

  let bestText = "";
  let bestEncoding = "latin-1";
  let bestScore = -Infinity;

  for (const encoding of CANDIDATE_ENCODINGS) {
    const text = tryDecode(bytes, encoding);
    if (text === null) continue;
    const score = -20 * countOf(text, MOJIBAKE) + countOf(text, EXPECTED_LETTERS);
    if (score > bestScore) {
      bestText = text;
      bestEncoding = encoding;
      bestScore = score;
    }
  }

  return { text: bestText, encoding: bestEncoding };
}

/**
 * Parse SRT text into cues, skipping malformed blocks rather than failing.
 *
 * Real files carry stray blank lines, missing indices and occasional garbage.
 * One bad block should cost one cue, not the whole file.
 */
export function parseSrt(text) {
  const normalised = String(text || "")
    .replace(/\r\n/g, "\n")
    .replace(/\r/g, "\n")
    .replace(/^﻿+/, "");
  const cues = [];

  for (const rawBlock of normalised.split(/\n{2,}/)) {
    const block = rawBlock.replace(/^\n+|\n+$/g, "");
    if (!block) continue;

    const match = TIMECODE.exec(block);
    if (!match) continue;

    const lines = block.split("\n");
    // Content is everything after the line holding the timecode. The index line
    // above it, when present, is discarded.
    const timecodeLine = lines.findIndex((line) => TIMECODE.test(line));
    const content = lines.slice(timecodeLine + 1).join("\n").trim();
    /* Markup comes off first. The copyright cues are written
     * `<font color=orange>©`, so the letters in the tag would answer for the
     * text if this read the raw block. This also covers the empty block the
     * check here used to test for on its own. */
    if (!READABLE.test(plainText(parse(content)))) continue;

    const start = toMs(match[1], match[2], match[3], match[4]);
    const end = toMs(match[5], match[6], match[7], match[8]);
    if (end < start) continue;

    cues.push({ startMs: start, endMs: end, text: content });
  }

  cues.sort((a, b) => a.startMs - b.startMs);
  return cues;
}

/**
 * Render cues in the shape the overlay consumes.
 *
 * `text` is the dialogue with markup removed. `runs` carries the same text
 * split by formatting, and is omitted for cues that have neither formatting nor
 * annotations - which is most of them.
 */
export function toJson(cues) {
  return cues.map((cue) => {
    const parsed = parse(cue.text);
    const entry = { start: cue.startMs, end: cue.endMs, text: plainText(parsed) };
    /* kind counts as much as styling: a cue that is only "[indistinct
     * chatter]" carries no formatting but still needs its run, or the renderer
     * cannot tell it apart from speech. */
    if (parsed.runs.some((run) => run.styles.length || run.color || run.kind)) {
      entry.runs = parsed.runs.map(runToJson);
    }
    if (parsed.vertical) entry.vertical = parsed.vertical;
    return entry;
  });
}

/** Render cues as WebVTT, translating inline markup into VTT tags. */
/* Words, as the daemon's subtitles.measure counts them: runs of letters and
 * digits, over the RENDERED text, so markup and positioning tags are already
 * gone and neither side has to strip them again. */
const WORD = /[\p{L}\p{N}]+/gu;

/**
 * How much is actually said in a subtitle: lines, and words.
 *
 * Two uploads of one film are routinely not the same subtitle. One carries
 * every line; another only the parts spoken in a foreign language; a third was
 * cut down by whoever retimed it. A search result says how often a file was
 * downloaded and nothing at all about what is in it, so these two numbers are
 * what separate "the whole film" from "a quarter of it".
 *
 * Port of `measure` in subtitle-daemon/src/subtitle_daemon/subtitles.py.
 */
export function measure(rendered) {
  let words = 0;
  for (const cue of rendered) words += String(cue.text || "").match(WORD)?.length || 0;
  return { lines: rendered.length, words };
}

export function toVtt(cues) {
  const parts = ["WEBVTT", ""];
  cues.forEach((cue, index) => {
    const parsed = parse(cue.text);
    // \anN maps onto a cue setting; VTT positions from the top, so "top" is a
    // small percentage and the default bottom is left unstated.
    let settings = "";
    if (parsed.vertical === "top") settings = " line:10%";
    else if (parsed.vertical === "middle") settings = " line:50%";

    parts.push(String(index + 1));
    parts.push(`${fmtVtt(cue.startMs)} --> ${fmtVtt(cue.endMs)}${settings}`);
    parts.push(markupToVtt(parsed));
    parts.push("");
  });
  return parts.join("\n");
}

function toMs(hours, minutes, seconds, fraction) {
  // SRT fractions are milliseconds, but files in the wild sometimes write one
  // or two digits. Pad rather than misread ",5" as 5 ms.
  const millis = Number(fraction.padEnd(3, "0").slice(0, 3));
  return ((Number(hours) * 60 + Number(minutes)) * 60 + Number(seconds)) * 1000 + millis;
}

function fmtVtt(ms) {
  const total = Math.max(0, ms);
  const hours = Math.floor(total / 3600000);
  const minutes = Math.floor((total % 3600000) / 60000);
  const seconds = Math.floor((total % 60000) / 1000);
  const millis = total % 1000;
  return (
    `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}:` +
    `${String(seconds).padStart(2, "0")}.${String(millis).padStart(3, "0")}`
  );
}
