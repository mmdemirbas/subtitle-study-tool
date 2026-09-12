/**
 * TTML, which is what a streaming player is given.
 *
 * OpenSubtitles hands out SRT; the page's own player is handed XML. Prime Video
 * calls the format TTMLv2 and serves it as `.dfxp` - a `<p begin end>` per
 * line, `<span>` for a style, `<br/>` for a line break, and the styles named in
 * `<head>` rather than written on the line. Read here into the same cues
 * `parseSrt` makes, so everything after the parse - the overlay, study, the
 * aligner, the by-ear list - never learns there was a second format.
 *
 * No DOMParser: this runs in the service worker, which has none. A regex over
 * `<p>` blocks is enough for the shape a player is fed, and the one thing a
 * real parser would add - namespaces - is handled by matching the local name
 * (`tts:fontStyle`, `fontStyle`) rather than the prefix, since a document may
 * call the namespace anything.
 *
 * Times are ABSOLUTE, on the title's own clock, and that is the point of the
 * whole feature: a line the page's player would draw at 00:12:03.400 is drawn
 * by the overlay at the same moment, with nothing to line up.
 */

import { parse, plainText } from "./markup.js";
import { READABLE } from "./srt.js";

const PARAGRAPH = /<(?:[\w-]+:)?p\b([^>]*)>([\s\S]*?)<\/(?:[\w-]+:)?p>/g;
const STYLE = /<(?:[\w-]+:)?style\b([^>]*)\/?>/g;
const ATTRIBUTE = /(?:[\w-]+:)?([\w-]+)\s*=\s*"([^"]*)"/g;
const BREAK = /<(?:[\w-]+:)?br\b[^>]*\/?>/gi;
const SPAN_OPEN = /<(?:[\w-]+:)?span\b([^>]*)>/gi;
const SPAN_CLOSE = /<\/(?:[\w-]+:)?span\s*>/gi;
/* Every tag but the two the pipeline reads, which lineText has just written. */
const OTHER_TAG = /<(?!\/?(?:i|b)>)[^>]+>/g;

const ENTITIES = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " };

/* Attributes by local name. `tts:fontStyle="italic" style="s1"` reads as
 * { fontStyle: "italic", style: "s1" }; a prefix, whatever it is, is dropped. */
function attributes(text) {
  const found = {};
  for (const match of text.matchAll(ATTRIBUTE)) found[match[1]] = match[2];
  return found;
}

/* A TTML time expression in milliseconds, or null.
 *
 * `00:12:03.400` is what Prime writes. The rest is the spec's other spellings
 * - `12.5s`, `750ms`, `00:12:03:12` with frames, and `Nt` ticks against the
 * document's tickRate - which cost nothing to accept and would otherwise make
 * a whole file vanish over one attribute this had not seen. */
export function toMs(expression, { frameRate = 30, tickRate = 1 } = {}) {
  const text = String(expression ?? "").trim();
  if (!text) return null;
  let match = /^(\d+):(\d{2}):(\d{2})(?:[.,](\d+)|:(\d+))?$/.exec(text);
  if (match) {
    const base = ((Number(match[1]) * 60 + Number(match[2])) * 60 + Number(match[3])) * 1000;
    if (match[4] !== undefined) return base + Number(match[4].padEnd(3, "0").slice(0, 3));
    if (match[5] !== undefined) return base + Math.round((Number(match[5]) / frameRate) * 1000);
    return base;
  }
  match = /^(\d+(?:\.\d+)?)(h|m|s|ms|f|t)$/.exec(text);
  if (!match) return null;
  const value = Number(match[1]);
  switch (match[2]) {
    case "h": return Math.round(value * 3600000);
    case "m": return Math.round(value * 60000);
    case "s": return Math.round(value * 1000);
    case "ms": return Math.round(value);
    case "f": return Math.round((value / frameRate) * 1000);
    case "t": return Math.round((value / tickRate) * 1000);
    default: return null;
  }
}

/* The line's text in the markup the rest of the pipeline reads: `<i>`, `<b>`,
 * and "\n" between the lines a `<br/>` separated. A style is either written on
 * the span or named on it and defined in the head, and a line-level style
 * covers every span that does not say otherwise. */
function lineText(inner, own, styles) {
  const resolve = (attrs) => ({
    italic: attrs.fontStyle === "italic" || Boolean(styles[attrs.style]?.italic),
    bold: attrs.fontWeight === "bold" || Boolean(styles[attrs.style]?.bold),
  });
  const wrap = (text, { italic, bold }) => {
    let out = text;
    if (bold) out = `<b>${out}</b>`;
    if (italic) out = `<i>${out}</i>`;
    return out;
  };
  const base = resolve(own);
  let text = inner.replace(BREAK, "\n");
  /* Spans, innermost first, so a nested one is resolved before the one around
   * it sees it as plain text. */
  const SPAN = /<(?:[\w-]+:)?span\b([^>]*)>((?:(?!<(?:[\w-]+:)?span\b)[\s\S])*?)<\/(?:[\w-]+:)?span\s*>/i;
  for (let guard = 0; guard < 64; guard += 1) {
    const match = SPAN.exec(text);
    if (!match) break;
    const style = resolve(attributes(match[1]));
    const styled = wrap(match[2], { italic: style.italic && !base.italic, bold: style.bold && !base.bold });
    text = text.slice(0, match.index) + styled + text.slice(match.index + match[0].length);
  }
  text = text.replace(SPAN_OPEN, "").replace(SPAN_CLOSE, "").replace(OTHER_TAG, "");
  text = text.replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (whole, name) => {
    if (name[0] === "#") {
      const code = name[1].toLowerCase() === "x" ? parseInt(name.slice(2), 16) : parseInt(name.slice(1), 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : whole;
    }
    return ENTITIES[name.toLowerCase()] ?? whole;
  });
  /* xml:space is "default" unless said otherwise: runs of whitespace are one
   * space, and a pretty-printed file's newlines inside a <p> are not breaks. */
  const lines = text
    .split("\n")
    .map((line) => line.replace(/[ \t\r\f\v]+/g, " ").trim())
    .filter(Boolean);
  return wrap(lines.join("\n"), base);
}

/**
 * Parse TTML text into the same cues `parseSrt` makes: `{ startMs, endMs,
 * text }` with inline markup, sorted, one bad block costing one cue.
 */
export function parseTtml(xml) {
  const text = String(xml || "");
  const root = /<(?:[\w-]+:)?tt\b([^>]*)>/.exec(text);
  const rootAttrs = root ? attributes(root[1]) : {};
  const rates = {
    frameRate: Number(rootAttrs.frameRate) > 0 ? Number(rootAttrs.frameRate) : 30,
    tickRate: Number(rootAttrs.tickRate) > 0 ? Number(rootAttrs.tickRate) : 1,
  };

  const styles = {};
  for (const match of text.matchAll(STYLE)) {
    const attrs = attributes(match[1]);
    if (attrs.id) styles[attrs.id] = { italic: attrs.fontStyle === "italic", bold: attrs.fontWeight === "bold" };
  }

  const cues = [];
  for (const match of text.matchAll(PARAGRAPH)) {
    const attrs = attributes(match[1]);
    const start = toMs(attrs.begin, rates);
    let end = toMs(attrs.end, rates);
    if (end === null && attrs.dur !== undefined && start !== null) {
      const dur = toMs(attrs.dur, rates);
      if (dur !== null) end = start + dur;
    }
    if (start === null || end === null || end < start) continue;
    const content = lineText(match[2], attrs, styles);
    if (!READABLE.test(plainText(parse(content)))) continue;
    cues.push({ startMs: start, endMs: end, text: content });
  }

  cues.sort((a, b) => a.startMs - b.startMs);
  return cues;
}
