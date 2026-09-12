/**
 * DASH manifests, for the text tracks a player is given in one.
 *
 * An MPD names its subtitle tracks as `<AdaptationSet>`s with
 * `contentType="text"` or a text mime type - `text/vtt`, `application/ttml+xml`,
 * or `application/mp4` carrying `stpp` (TTML in MP4 samples) or `wvtt` (WebVTT
 * in MP4 samples) - each with a `lang`, a `<Role>`, sometimes a `<Label>`, and
 * one or more `<Representation>`s that say where the bytes are: a `<BaseURL>`
 * for one whole file, or a `<SegmentTemplate>` / `<SegmentList>` for a run of
 * segments. This reads that much, resolves every URL the way the player does
 * (MPD, then Period, then AdaptationSet, then Representation `<BaseURL>`s,
 * each against the one before), and hands back a list the worker can fetch.
 *
 * No DOMParser: this runs in the service worker. The regexes assume the
 * element nesting the spec requires and nothing about prefixes or attribute
 * order. `$Number$`, `$Time$`, `$RepresentationID$` and `$Bandwidth$` are
 * substituted, with the `%0Nd` widths the spec allows.
 *
 * Written from the DASH-IF interoperability points and ISO 23009-1, not from
 * any one site's manifest: the first tabii playback with this installed is
 * what will say which of these shapes that player is given. See
 * `src/sites/streams.js`.
 */

const ELEMENT = (name) => new RegExp(`<(?:[\\w-]+:)?${name}\\b([^>]*?)(?:/>|>([\\s\\S]*?)</(?:[\\w-]+:)?${name}\\s*>)`, "g");
const ATTRIBUTE = /([\w:.-]+)\s*=\s*"([^"]*)"/g;
const TEXT_MIME = /^(text\/vtt|application\/ttml\+xml|application\/mp4)$/;

function attributes(text) {
  const found = {};
  for (const match of String(text || "").matchAll(ATTRIBUTE)) found[match[1].replace(/^[\w-]+:/, "")] = match[2];
  return found;
}

function children(inner, name) {
  return [...String(inner || "").matchAll(ELEMENT(name))].map((match) => ({ attrs: attributes(match[1]), inner: match[2] || "" }));
}

/* The inner text of the first `<name>` child, trimmed. */
function textOf(inner, name) {
  const first = children(inner, name)[0];
  return first ? first.inner.replace(/<[^>]*>/g, "").trim() : "";
}

/* An ISO 8601 duration - `PT1H2M3.5S`, `PT600S`, `P0DT0H10M` - in seconds. */
export function durationSeconds(text) {
  const match = /^P(?:(\d+(?:\.\d+)?)D)?(?:T(?:(\d+(?:\.\d+)?)H)?(?:(\d+(?:\.\d+)?)M)?(?:(\d+(?:\.\d+)?)S)?)?$/.exec(String(text || "").trim());
  if (!match) return null;
  const [, d, h, m, s] = match.map((value) => (value === undefined ? 0 : Number(value)));
  return d * 86400 + h * 3600 + m * 60 + s;
}

function resolve(base, relative) {
  try {
    return new URL(relative, base).href;
  } catch {
    return base;
  }
}

/* A BaseURL under `inner`, applied to `base`; the element's own base when it
 * names none. */
function baseUrlIn(inner, base) {
  const own = textOf(inner, "BaseURL");
  return own ? resolve(base, own) : base;
}

function fill(template, values) {
  return String(template).replace(/\$(RepresentationID|Number|Time|Bandwidth)(?:%0(\d+)d)?\$/g, (whole, name, width) => {
    const value = values[name];
    if (value === undefined) return whole;
    return width ? String(value).padStart(Number(width), "0") : String(value);
  }).replace(/\$\$/g, "$");
}

/* The segment URLs a template produces, from a timeline when it has one and
 * from a fixed duration over the period's length when it has not. */
function templateSegments(template, base, values, periodSeconds) {
  const attrs = template.attrs;
  const media = attrs.media;
  if (!media) return [];
  const timescale = Number(attrs.timescale) > 0 ? Number(attrs.timescale) : 1;
  const startNumber = attrs.startNumber !== undefined ? Number(attrs.startNumber) : 1;
  const urls = [];
  const timeline = children(template.inner, "SegmentTimeline")[0];
  if (timeline) {
    let number = startNumber;
    let time = 0;
    for (const s of children(timeline.inner, "S")) {
      if (s.attrs.t !== undefined) time = Number(s.attrs.t);
      const duration = Number(s.attrs.d) || 0;
      const repeat = Number(s.attrs.r) || 0;
      for (let i = 0; i <= repeat && urls.length < 100000; i += 1) {
        urls.push(resolve(base, fill(media, { ...values, Number: number, Time: time })));
        number += 1;
        time += duration;
      }
    }
    return urls;
  }
  const duration = Number(attrs.duration);
  if (!(duration > 0) || !(periodSeconds > 0)) return [];
  const count = Math.ceil((periodSeconds * timescale) / duration);
  for (let i = 0; i < count && i < 100000; i += 1) {
    urls.push(resolve(base, fill(media, { ...values, Number: startNumber + i, Time: i * duration })));
  }
  return urls;
}

/**
 * Every text representation an MPD names, with its URLs resolved:
 * `{ id, adaptation, lang, mimeType, codecs, role, label, file, segments }`
 * where exactly one of `file` (a whole file) and `segments` (a run of URLs,
 * the initialization segment first when there is one) is set.
 */
export function textRepresentations(mpd, mpdUrl) {
  const text = String(mpd || "");
  const root = /<(?:[\w-]+:)?MPD\b([^>]*)>/.exec(text);
  const rootAttrs = root ? attributes(root[1]) : {};
  const rootInner = text.slice(root ? root.index + root[0].length : 0);
  const mpdBase = baseUrlIn(rootInner.replace(/<(?:[\w-]+:)?Period\b[\s\S]*$/, ""), mpdUrl);
  const found = [];
  let adaptationIndex = -1;
  children(rootInner, "Period").forEach((period) => {
    const periodSeconds = durationSeconds(period.attrs.duration) ?? durationSeconds(rootAttrs.mediaPresentationDuration) ?? 0;
    const periodBase = baseUrlIn(period.inner.replace(/<(?:[\w-]+:)?AdaptationSet\b[\s\S]*$/, ""), mpdBase);
    for (const set of children(period.inner, "AdaptationSet")) {
      adaptationIndex += 1;
      const representations = children(set.inner, "Representation");
      const mime = set.attrs.mimeType || representations[0]?.attrs.mimeType || "";
      const codecs = set.attrs.codecs || representations[0]?.attrs.codecs || "";
      const isText = set.attrs.contentType === "text" || TEXT_MIME.test(mime) && (mime !== "application/mp4" || /stpp|wvtt/.test(codecs));
      if (!isText) continue;
      const role = children(set.inner, "Role").map((r) => r.attrs.value).filter(Boolean).join(" ");
      const accessibility = children(set.inner, "Accessibility").map((r) => r.attrs.value).filter(Boolean).join(" ");
      const label = textOf(set.inner, "Label");
      const setBase = baseUrlIn(set.inner.replace(/<(?:[\w-]+:)?Representation\b[\s\S]*$/, ""), periodBase);
      const setTemplate = children(set.inner.replace(/<(?:[\w-]+:)?Representation\b[\s\S]*?<\/(?:[\w-]+:)?Representation\s*>/g, ""), "SegmentTemplate")[0];
      for (const rep of representations) {
        const id = rep.attrs.id || "";
        const values = { RepresentationID: id, Bandwidth: rep.attrs.bandwidth || "" };
        const repBase = baseUrlIn(rep.inner, setBase);
        const template = children(rep.inner, "SegmentTemplate")[0] || setTemplate;
        const list = children(rep.inner, "SegmentList")[0];
        const entry = {
          id,
          adaptation: set.attrs.id || String(adaptationIndex),
          lang: set.attrs.lang || rep.attrs.lang || "",
          mimeType: rep.attrs.mimeType || mime,
          codecs: rep.attrs.codecs || codecs,
          role,
          accessibility,
          label,
          file: "",
          segments: [],
        };
        if (list) {
          const init = children(list.inner, "Initialization")[0]?.attrs.sourceURL;
          entry.segments = [
            ...(init ? [resolve(repBase, init)] : []),
            ...children(list.inner, "SegmentURL").map((s) => s.attrs.media).filter(Boolean).map((media) => resolve(repBase, media)),
          ];
        } else if (template) {
          const init = template.attrs.initialization ? [resolve(repBase, fill(template.attrs.initialization, values))] : [];
          entry.segments = [...init, ...templateSegments(template, repBase, values, periodSeconds)];
        } else if (repBase !== setBase || textOf(rep.inner, "BaseURL")) {
          entry.file = repBase;
        } else if (textOf(set.inner.replace(/<(?:[\w-]+:)?Representation\b[\s\S]*$/, ""), "BaseURL")) {
          entry.file = setBase;
        }
        if (entry.file || entry.segments.length) found.push(entry);
      }
    }
  });
  return found;
}

/**
 * The TTML documents inside a run of `stpp` MP4 segments. Each media segment's
 * `mdat` holds one whole TTML document; the bytes are read as UTF-8 and the
 * `<tt>...</tt>` taken out, which needs no box parsing. Times inside are on
 * the media timeline (DASH-IF IOP, ISO 14496-30), so the documents concatenate
 * like the segments do. `wvtt` samples are a different animal - cue boxes with
 * their timing in the track's sample table - and are not read here.
 */
export function ttmlDocumentsIn(bytes) {
  const text = new TextDecoder("utf-8", { fatal: false }).decode(bytes);
  return [...text.matchAll(/<(?:[\w-]+:)?tt\b[\s\S]*?<\/(?:[\w-]+:)?tt\s*>/g)].map((match) => match[0]);
}
