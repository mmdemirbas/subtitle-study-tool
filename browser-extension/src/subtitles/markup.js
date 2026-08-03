/* Inline markup in subtitle text.
 *
 * Port of subtitle-daemon/src/subtitle_daemon/markup.py. Three dialects appear
 * in practice - HTML-ish tags, BBCode, and SubStation overrides - and the
 * output is styled runs rather than a string of markup, so the renderer sets
 * text content and no subtitle can inject markup into a page.
 */

import {
  NAMED_COLORS,
  TAG_NAMES,
  VERTICAL_BY_ALIGNMENT,
} from "./tables.generated.js";
import {
  MUSIC,
  MUSIC_COLOR,
  SOUND,
  SOUND_COLOR,
  SPEAKER,
  findAnnotations,
  speakerColor,
  symbolFor,
} from "./annotations.js";

export const ITALIC = "i";
export const BOLD = "b";
export const UNDERLINE = "u";
export const STRIKE = "s";

const NAMED_COLOR_SET = new Set(NAMED_COLORS);
const ANNOTATION_COLORS = { [SOUND]: SOUND_COLOR, [MUSIC]: MUSIC_COLOR };

const HEX_COLOR = /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{4}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/;
const SSA_HEX = /^&h([0-9a-f]{6})&?$/;
const FONT_COLOR = /\bcolor\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/i;
const SSA_STYLE = /([ibus])([01])/g;
const SSA_ALIGN = /an([1-9])\b/;

/* Python writes this with re.VERBOSE across a dozen lines; JavaScript has no
 * verbose mode, so the alternatives are joined here with their names intact.
 * Order is load-bearing - the first alternative that matches at a position
 * wins, in both engines - so it must stay as it is in the Python. */
const TOKEN = new RegExp(
  [
    "(?<html_open><\\s*(?<html_open_name>i|em|b|strong|u|s|strike|del)\\s*>)",
    "(?<html_close><\\s*/\\s*(?<html_close_name>i|em|b|strong|u|s|strike|del)\\s*>)",
    "(?<font><\\s*font\\b(?<font_attrs>[^>]*)>)",
    "(?<font_close><\\s*/\\s*font\\s*>)",
    "(?<bb_open>\\[(?<bb_open_name>i|b|u|s)\\])",
    "(?<bb_close>\\[/(?<bb_close_name>i|b|u|s)\\])",
    "(?<bb_color>\\[color\\s*=\\s*(?<bb_color_value>[^\\]]{1,32})\\])",
    "(?<bb_color_close>\\[/color\\])",
    "(?<ssa>\\{\\\\(?<ssa_body>[^}]{0,200})\\})",
    "(?<legacy>\\{\\s*y\\s*:\\s*(?<legacy_body>[ibus]{1,4})\\s*\\})",
  ].join("|"),
  "gi",
);

/** A span of text, the styles covering it, and what kind of text it is. */
function run(text, styles = [], color = null, kind = null, symbol = null) {
  return { text, styles, color, kind, symbol };
}

export function runToJson(item) {
  const payload = { text: item.text };
  if (item.styles.length) payload.styles = [...item.styles].sort();
  if (item.color) payload.color = item.color;
  if (item.kind) payload.kind = item.kind;
  if (item.symbol) payload.symbol = item.symbol;
  return payload;
}

const sameStyles = (a, b) => a.length === b.length && a.every((value, i) => value === b[i]);

/** Split cue text into styled runs, discarding markup the renderer cannot use. */
export function parse(text) {
  const source = String(text || "");
  const runs = [];
  // Counters rather than flags: nested or repeated open tags are common, and a
  // single closing tag should not cancel two levels of italics.
  const depth = { [ITALIC]: 0, [BOLD]: 0, [UNDERLINE]: 0, [STRIKE]: 0 };
  // A stack, so a closing tag restores the enclosing colour. Entries may be
  // null: a colour that failed validation still needs a slot, or its closing
  // tag would pop somebody else's.
  const colors = [];
  let vertical = null;
  let buffer = "";

  const currentColor = () => (colors.length ? colors[colors.length - 1] : null);
  const pushColor = (value) => colors.push(value || currentColor());

  const flush = () => {
    if (!buffer) return;
    const active = Object.keys(depth)
      .filter((name) => depth[name] > 0)
      .sort();
    runs.push(run(buffer, active, currentColor()));
    buffer = "";
  };

  let position = 0;
  TOKEN.lastIndex = 0;
  for (const match of source.matchAll(TOKEN)) {
    buffer += source.slice(position, match.index);
    position = match.index + match[0].length;
    const g = match.groups;

    if (g.html_open) {
      flush();
      depth[TAG_NAMES[g.html_open_name.toLowerCase()]] += 1;
    } else if (g.html_close) {
      flush();
      const name = TAG_NAMES[g.html_close_name.toLowerCase()];
      depth[name] = Math.max(0, depth[name] - 1);
    } else if (g.bb_open) {
      flush();
      depth[TAG_NAMES[g.bb_open_name.toLowerCase()]] += 1;
    } else if (g.bb_close) {
      flush();
      const name = TAG_NAMES[g.bb_close_name.toLowerCase()];
      depth[name] = Math.max(0, depth[name] - 1);
    } else if (g.font) {
      flush();
      pushColor(safeColor(fontColor(g.font_attrs)));
    } else if (g.font_close || g.bb_color_close) {
      flush();
      if (colors.length) colors.pop();
    } else if (g.bb_color) {
      flush();
      pushColor(safeColor(g.bb_color_value));
    } else if (g.ssa) {
      flush();
      const body = g.ssa_body;
      SSA_STYLE.lastIndex = 0;
      for (const style of body.matchAll(SSA_STYLE)) {
        const mapped = TAG_NAMES[style[1]];
        depth[mapped] = style[2] === "1" ? depth[mapped] + 1 : Math.max(0, depth[mapped] - 1);
      }
      const align = SSA_ALIGN.exec(body);
      if (align) vertical = VERTICAL_BY_ALIGNMENT[align[1]];
      // Everything else in an override block - \pos, \fad, \c, \blur - is
      // positioning or effects this renderer does not implement. Dropping it is
      // the point: it must not reach the screen as text.
    } else if (g.legacy) {
      flush();
      for (const letter of g.legacy_body.toLowerCase()) depth[TAG_NAMES[letter]] += 1;
    }
  }

  buffer += source.slice(position);
  flush();

  const merged = mergeAdjacent(runs.filter((item) => item.text));
  return { runs: splitAnnotations(merged), vertical };
}

/**
 * Separate speaker labels and sound descriptions into their own runs.
 *
 * Runs after this are homogeneous: entirely dialogue, or entirely one
 * annotation. That is what lets a renderer dim the non-speech parts and colour
 * the names without re-parsing the text.
 */
function splitAnnotations(runs) {
  const out = [];
  for (const item of runs) {
    const spans = findAnnotations(item.text);
    if (!spans.length) {
      out.push(item);
      continue;
    }

    let cursor = 0;
    for (const span of spans) {
      if (span.start > cursor) {
        out.push(run(item.text.slice(cursor, span.start), item.styles, item.color));
      }

      /* Every annotation gets a colour, because none of it is ordinary speech
       * and hue says that faster than dimming does. A colour set explicitly in
       * the file outranks both - the author meant that colour. */
      let color = item.color;
      if (color === null) {
        color = ANNOTATION_COLORS[span.kind] || null;
        if (span.kind === SPEAKER) color = speakerColor(span.inner);
      }

      out.push(
        run(
          item.text.slice(span.start, span.end),
          item.styles,
          color,
          span.kind,
          symbolFor(span.inner),
        ),
      );
      cursor = span.end;
    }

    if (cursor < item.text.length) {
      out.push(run(item.text.slice(cursor), item.styles, item.color));
    }
  }
  return out.filter((item) => item.text);
}

/** Join neighbouring runs that share formatting, so output stays compact. */
function mergeAdjacent(runs) {
  const merged = [];
  for (const item of runs) {
    const previous = merged.length ? merged[merged.length - 1] : null;
    // kind and symbol take part in the comparison: a speaker label and the
    // dialogue after it can share styling but must stay separate runs.
    if (
      previous &&
      sameStyles(previous.styles, item.styles) &&
      previous.color === item.color &&
      previous.kind === item.kind &&
      previous.symbol === item.symbol
    ) {
      merged[merged.length - 1] = run(
        previous.text + item.text,
        item.styles,
        item.color,
        item.kind,
        item.symbol,
      );
    } else {
      merged.push(item);
    }
  }
  return merged;
}

export function plainText(parsed) {
  return parsed.runs.map((item) => item.text).join("");
}

/** Render runs as WebVTT cue text, escaping the dialogue itself. */
export function toVtt(parsed) {
  return parsed.runs
    .map((item) => {
      let text = item.text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
      // WebVTT has no strikethrough and no inline colour without a stylesheet,
      // so only the tags it defines are emitted; the rest degrade to plain.
      for (const style of [ITALIC, BOLD, UNDERLINE]) {
        if (item.styles.includes(style)) text = `<${style}>${text}</${style}>`;
      }
      return text;
    })
    .join("");
}

function fontColor(attributes) {
  const match = FONT_COLOR.exec(attributes || "");
  if (!match) return null;
  return match[1] || match[2] || match[3] || null;
}

/**
 * Accept only colours that cannot escape a CSS value slot.
 *
 * Subtitle text is untrusted input heading for a style property, so this is an
 * allowlist: a hex literal, or a name from the CSS colour list. Anything else -
 * `red; background: url(...)`, `expression(...)` - is dropped and the text
 * renders unstyled.
 */
function safeColor(value) {
  if (!value) return null;
  const candidate = value.trim().replace(/^["']+|["']+$/g, "").toLowerCase();
  if (HEX_COLOR.test(candidate)) return candidate;
  if (NAMED_COLOR_SET.has(candidate)) return candidate;
  // SubStation's &HBBGGRR& form, occasionally seen in converted files.
  const ssa = SSA_HEX.exec(candidate);
  if (ssa) {
    const [blue, green, red] = [ssa[1].slice(0, 2), ssa[1].slice(2, 4), ssa[1].slice(4, 6)];
    return `#${red}${green}${blue}`;
  }
  return null;
}
