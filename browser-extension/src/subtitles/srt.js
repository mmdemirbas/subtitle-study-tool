/* Decoding subtitle bytes and turning SRT into cues.
 *
 * Port of subtitle-daemon/src/subtitle_daemon/subtitles.py.
 */

import { CANDIDATE_ENCODINGS } from "./tables.generated.js";
import { parse, plainText, runToJson, toVtt as markupToVtt } from "./markup.js";

/* Signs a decode went wrong even though it did not fail: U+FFFD, and the C1
 * control block, which is what cp1254 bytes turn into once latin-1 mangles
 * them. */
const MOJIBAKE = /[�-]/g;

/* Letters that indicate a decode went right for the languages in play: Turkish
 * c-cedilla, g-breve, dotless i, dotted I, o/u-diaeresis, s-cedilla, plus the
 * circumflex vowels of older orthography. */
const EXPECTED_LETTERS = /[çğıİöşüÇĞÖŞÜâîû]/g;

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
    if (!content) continue;

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
