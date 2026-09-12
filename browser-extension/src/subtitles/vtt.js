/**
 * WebVTT, and the HLS playlists a player is given it in.
 *
 * Disney+ hands its player an HLS master playlist; each subtitle language in
 * it is another playlist of `.vtt` segments, a few minutes each, timed on the
 * title's own clock. Netflix serves WebVTT when asked for it and TTML when not
 * (see `ttml.js`). Both are read here into the same cues `parseSrt` makes, so
 * everything after the parse never learns there was a third format.
 *
 * No DOMParser and no TextTrack: this runs in the service worker. A VTT cue is
 * an optional identifier line, a timing line with `-->`, and text until a
 * blank line; that is a split on blank lines and a regex on the timing, which
 * is all the shape a player is fed needs. `<i>` and `<b>` are kept for the
 * pipeline; `<c.classname>`, `<v Speaker>` and the rest are removed around
 * their text, since a class is a colour in the player's stylesheet and a
 * voice tag is a speaker the line already names with a dash.
 */

import { parse, plainText } from "./markup.js";
import { READABLE } from "./srt.js";

const TIMING = /^(\d+:)?(\d{1,2}):(\d{2})[.,](\d{1,3})\s+-->\s+(\d+:)?(\d{1,2}):(\d{2})[.,](\d{1,3})/;
const OTHER_TAG = /<(?!\/?(?:i|b)>)[^>]*>/g;
const ENTITIES = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", lrm: "‎", rlm: "‏" };

function stampMs(hours, minutes, seconds, fraction) {
  const h = hours ? Number(hours.slice(0, -1)) : 0;
  return ((h * 60 + Number(minutes)) * 60 + Number(seconds)) * 1000 + Number(fraction.padEnd(3, "0"));
}

function cueText(lines) {
  let text = lines.join("\n").replace(OTHER_TAG, "");
  text = text.replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (whole, name) => {
    if (name[0] === "#") {
      const code = name[1].toLowerCase() === "x" ? parseInt(name.slice(2), 16) : parseInt(name.slice(1), 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : whole;
    }
    return ENTITIES[name.toLowerCase()] ?? whole;
  });
  return text
    .split("\n")
    .map((line) => line.replace(/[ \t\r\f\v]+/g, " ").trim())
    .filter(Boolean)
    .join("\n");
}

/**
 * Parse one WebVTT document into `{ startMs, endMs, text }` cues, sorted, one
 * bad block costing one cue. The header, NOTE, STYLE and REGION blocks and
 * the `X-TIMESTAMP-MAP` line an HLS segment carries are all skipped: the
 * timestamps a streaming player's segments carry are already on the title's
 * clock, which is what the whole feature rests on.
 */
export function parseVtt(text) {
  const blocks = String(text || "").replace(/\r\n?/g, "\n").split(/\n{2,}/);
  const cues = [];
  for (const block of blocks) {
    const lines = block.split("\n");
    let at = lines.findIndex((line) => TIMING.test(line));
    if (at < 0 || at > 1) continue;
    const match = TIMING.exec(lines[at]);
    const startMs = stampMs(match[1], match[2], match[3], match[4]);
    const endMs = stampMs(match[5], match[6], match[7], match[8]);
    if (endMs < startMs) continue;
    const content = cueText(lines.slice(at + 1));
    if (!READABLE.test(plainText(parse(content)))) continue;
    cues.push({ startMs, endMs, text: content });
  }
  cues.sort((a, b) => a.startMs - b.startMs);
  return cues;
}

/**
 * The cues of several segments as one file. A cue that spans a segment
 * boundary is written into both segments in full, so the same timing and
 * text twice over is one cue, not two.
 */
export function joinSegments(segments) {
  const seen = new Set();
  const cues = [];
  for (const cue of segments.flat()) {
    const key = `${cue.startMs}|${cue.endMs}|${cue.text}`;
    if (seen.has(key)) continue;
    seen.add(key);
    cues.push(cue);
  }
  cues.sort((a, b) => a.startMs - b.startMs);
  return cues;
}

/* The attribute list of an `#EXT-X-MEDIA` line: `KEY=VALUE` pairs separated
 * by commas, with a quoted value allowed to hold commas of its own. */
function attributes(line) {
  const found = {};
  const PAIR = /([A-Z0-9-]+)=("([^"]*)"|[^,]*)/g;
  for (const match of line.matchAll(PAIR)) found[match[1]] = match[3] ?? match[2];
  return found;
}

/**
 * The subtitle renditions an HLS master playlist names, each with its own
 * playlist URL resolved against the master's. `#EXT-X-MEDIA:TYPE=SUBTITLES`
 * lines only; the audio and video groups beside them are not read.
 */
export function subtitleRenditions(master, masterUrl) {
  const found = [];
  for (const raw of String(master || "").split(/\r?\n/)) {
    if (!raw.startsWith("#EXT-X-MEDIA:")) continue;
    const attrs = attributes(raw.slice("#EXT-X-MEDIA:".length));
    if (attrs.TYPE !== "SUBTITLES" || !attrs.URI) continue;
    let url = "";
    try {
      url = new URL(attrs.URI, masterUrl).href;
    } catch {
      continue;
    }
    found.push({
      name: attrs.NAME || "",
      language: attrs.LANGUAGE || "",
      forced: attrs.FORCED === "YES",
      characteristics: attrs.CHARACTERISTICS || "",
      url,
    });
  }
  return found;
}

/** The segment URLs of a media playlist, resolved against the playlist's. */
export function segmentUrls(playlist, playlistUrl) {
  const urls = [];
  for (const raw of String(playlist || "").split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    try {
      urls.push(new URL(line, playlistUrl).href);
    } catch {
      // A line the player could not fetch either.
    }
  }
  return urls;
}
