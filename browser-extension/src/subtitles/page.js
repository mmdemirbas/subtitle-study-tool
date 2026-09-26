/**
 * A page's own subtitle track, fetched and read into cues.
 *
 * The ears (`src/sites/*.js`) name each track's `format`, and this is the one
 * place that knows what each name means on the wire:
 *
 *   ttml      one TTML file (Prime Video, Netflix)
 *   vtt       one WebVTT file (YouTube, Netflix when asked for it)
 *   srt       one SRT file (a player handed a sidecar)
 *   hls-vtt   an HLS media playlist of WebVTT segments (Disney+)
 *   dash      a DASH MPD; `dash.representation` names the text track in it
 *   cues      nothing to fetch: the cues came with the track, read off the
 *             browser's own text track in the page
 *   auto      a URL that says nothing (`/subtitle?path=...`): the first bytes
 *             decide between the three file kinds
 *
 * A track read off the document - a <track> element or a text track - is on
 * the ELEMENT's clock, and carries `shiftMs` from the frame when that clock
 * is not the film's (a player streaming from an offset). It is added to every
 * cue here, so what attaches is on the film's clock like everything else.
 *
 * Runs in the service worker, whose `fetch` has the host permissions and no
 * CORS to argue with. Segments go six at a time, which is what a browser
 * gives one host anyway. A cue that a segment boundary wrote into two
 * segments counts once (`joinSegments`).
 */

import { textRepresentations, ttmlDocumentsIn } from "./dash.js";
import { parseSrt } from "./srt.js";
import { parseTtml } from "./ttml.js";
import { joinSegments, parseVtt, segmentUrls } from "./vtt.js";
import { letGo } from "../http.js";

const AT_A_TIME = 6;

async function fetchAll(urls, read) {
  const parts = new Array(urls.length);
  let next = 0;
  let failed = 0;
  const worker = async () => {
    while (next < urls.length) {
      const index = next++;
      try {
        const response = await fetch(urls[index]);
        if (!response.ok) {
          letGo(response);
          throw new Error(String(response.status));
        }
        parts[index] = await read(response);
      } catch {
        failed += 1;
        parts[index] = [];
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(AT_A_TIME, urls.length) }, worker));
  return { parts, failed };
}

/* One document of a known kind into cues; `auto` reads the first bytes. */
function readText(text, kind) {
  if (kind === "auto") kind = sniff(text);
  if (kind === "vtt") return parseVtt(text);
  if (kind === "srt") return parseSrt(text);
  return parseTtml(text);
}

function sniff(text) {
  const head = text.slice(0, 300).replace(/^\uFEFF/, "").trimStart();
  if (head.startsWith("WEBVTT")) return "vtt";
  if (head.startsWith("<")) return "ttml";
  if (/^\d+\s*\r?\n\s*\d\d:\d\d:\d\d[,.]\d{3}\s*-->/.test(head)) return "srt";
  return "vtt";
}

function shifted(cues, shiftMs) {
  const by = Number(shiftMs) || 0;
  if (!by) return cues;
  return cues.map((cue) => ({ ...cue, startMs: cue.startMs + by, endMs: cue.endMs + by }));
}

/* What a DASH representation's mime type says its bytes are. */
function kindOf(representation) {
  if (/vtt/.test(representation.mimeType)) return "vtt";
  if (/mp4/.test(representation.mimeType)) return /wvtt/.test(representation.codecs) ? "wvtt" : "stpp";
  return "ttml";
}

/**
 * Fetch and read `track`. Resolves to `{ cues, note }` where `note` is what
 * the trace should record beside the count - the format, the segment count,
 * how many failed - or throws an Error whose message the reader can act on.
 */
export async function readPageTrack(track) {
  const { cues, note } = await readTrack(track);
  if (track.shiftMs) note.shiftMs = Number(track.shiftMs) || 0;
  return { cues: shifted(cues, track.shiftMs), note };
}

async function readTrack(track) {
  const format = track.format || "ttml";
  const note = { format, segments: 0, failed: 0, bytes: 0 };

  if (format === "cues") {
    const cues = (Array.isArray(track.cues) ? track.cues : [])
      .filter((cue) => Number.isFinite(cue?.startMs) && Number.isFinite(cue?.endMs) && typeof cue.text === "string")
      .map((cue) => ({ startMs: cue.startMs, endMs: cue.endMs, text: cue.text }));
    return { cues, note };
  }

  if (format === "hls-vtt" || format === "dash") {
    const response = await fetch(track.url);
    if (!response.ok) {
      letGo(response);
      throw new Error(`The page's own subtitle could not be fetched (${response.status})`);
    }
    const manifest = await response.text();
    note.bytes = manifest.length;

    let urls;
    let kind = "vtt";
    if (format === "hls-vtt") {
      urls = segmentUrls(manifest, track.url);
    } else {
      const wanted = String(track.dash?.representation ?? "");
      const listed = textRepresentations(manifest, track.url);
      const representation = listed.find((r) => r.id === wanted) || listed.find((r) => r.lang === track.code) || listed[0];
      if (!representation) throw new Error("The manifest names no text track this could read");
      kind = kindOf(representation);
      note.mimeType = representation.mimeType;
      note.codecs = representation.codecs;
      if (kind === "wvtt") throw new Error("The page's subtitles are WebVTT inside MP4 samples, which this cannot read yet");
      if (representation.file) {
        const one = await fetch(representation.file);
        if (!one.ok) {
          letGo(one);
          throw new Error(`The page's own subtitle could not be fetched (${one.status})`);
        }
        const cues = kind === "stpp"
          ? joinSegments(ttmlDocumentsIn(new Uint8Array(await one.arrayBuffer())).map(parseTtml))
          : readText(await one.text(), kind);
        return { cues, note };
      }
      urls = representation.segments;
    }
    note.segments = urls.length;
    const read = kind === "stpp"
      ? async (response) => joinSegments(ttmlDocumentsIn(new Uint8Array(await response.arrayBuffer())).map(parseTtml))
      : async (response) => readText(await response.text(), kind);
    const { parts, failed } = await fetchAll(urls, read);
    note.failed = failed;
    if (urls.length && failed === urls.length) throw new Error("None of the page's subtitle segments could be fetched");
    return { cues: joinSegments(parts), note };
  }

  const response = await fetch(track.url);
  if (!response.ok) {
    letGo(response);
    throw new Error(`The page's own subtitle could not be fetched (${response.status})`);
  }
  const text = await response.text();
  note.bytes = text.length;
  if (!text.trim()) {
    /* YouTube answers 200 and nothing to a timedtext request without the
     * player's proof-of-origin token; see src/sites/youtube.js. */
    throw new Error("The page sent an empty file - turn the player's own captions on once, then try again");
  }
  return { cues: readText(text, format), note };
}
