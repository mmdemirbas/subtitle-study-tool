/* OpenSubtitles REST client, for when the daemon is not running.
 *
 * Port of subtitle-daemon/src/subtitle_daemon/opensubtitles.py. Response shapes
 * are read defensively for the same reason as there: they were confirmed
 * against live calls rather than a spec, so a renamed field should cost one
 * result, not the request.
 *
 * Quota: searching is unlimited, downloading is not - 5 a day anonymous, 10 for
 * a free account. cache.js is what keeps this inside that.
 */

export const API_BASE = "https://api.opensubtitles.com/api/v1";
export const USER_AGENT = "subtitle-study-tool v0.1.0";
const TIMEOUT_MS = 20000;

export class OpenSubtitlesError extends Error {
  constructor(message, { status = null, quotaExceeded = false } = {}) {
    super(message);
    this.name = "OpenSubtitlesError";
    this.status = status;
    // Separated from a generic failure because the remedy differs: wait or sign
    // in, rather than retry.
    this.quotaExceeded = quotaExceeded;
  }
}

const asInt = (value) => {
  if (typeof value === "boolean" || value === null || value === undefined) return null;
  const number = Number(value);
  return Number.isFinite(number) ? Math.trunc(number) : null;
};

const asFloat = (value) => {
  if (typeof value === "boolean" || value === null || value === undefined) return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
};

/* OpenSubtitles returns movie_name for films as "2015 - Sicario". Left in place
 * it costs every exact title a chunk of its match score, because the year is
 * compared against the title the user asked for. */
const YEAR_PREFIX = /^\s*(19[0-9]{2}|20[0-4][0-9])\s*[-–—]\s*(?=\S)/;

function splitYearPrefix(name) {
  const match = YEAR_PREFIX.exec(name);
  if (!match) return [name.trim(), null];
  return [name.slice(match[0].length).trim(), Number(match[1])];
}

function parseFeature(item) {
  const attributes = item && item.attributes;
  if (!attributes || typeof attributes !== "object") return null;
  if (attributes.imdb_id === null || attributes.imdb_id === undefined) return null;
  const featureType = String(attributes.feature_type || "");
  return {
    imdb_id: String(attributes.imdb_id),
    title: String(attributes.title || ""),
    year: asInt(attributes.year),
    feature_type: featureType,
    subtitles_count: asInt(attributes.subtitles_count) || 0,
    is_series: ["tvshow", "episode"].includes(featureType.toLowerCase()),
  };
}

function parseSearchItem(item) {
  const attributes = item && item.attributes;
  if (!attributes || typeof attributes !== "object") return null;

  const files = attributes.files;
  if (!Array.isArray(files) || !files.length) return null;
  const first = files[0];
  if (!first || typeof first !== "object") return null;
  if (!Number.isInteger(first.file_id)) return null;

  const feature =
    attributes.feature_details && typeof attributes.feature_details === "object"
      ? attributes.feature_details
      : {};

  const [movieName, nameYear] = splitYearPrefix(
    String(feature.movie_name || feature.title || ""),
  );

  return {
    file_id: first.file_id,
    subtitle_id: String(item.id || ""),
    language: String(attributes.language || "").toLowerCase(),
    release: String(attributes.release || first.file_name || ""),
    movie_name: movieName,
    year: asInt(feature.year) ?? nameYear,
    season: asInt(feature.season_number),
    episode: asInt(feature.episode_number),
    download_count: asInt(attributes.download_count) || 0,
    from_trusted: Boolean(attributes.from_trusted),
    hearing_impaired: Boolean(attributes.hearing_impaired),
    /* What is IN the file, as far as a search result can say before it is
     * downloaded. foreign_parts_only is the one that changes the answer most:
     * it means the upload deliberately carries only the lines spoken in
     * another language, so a reader choosing on download count alone picks a
     * file with a tenth of the dialogue in it and cannot see why. */
    foreign_parts_only: Boolean(attributes.foreign_parts_only),
    machine_translated: Boolean(attributes.machine_translated),
    ai_translated: Boolean(attributes.ai_translated),
    /* The uploaders' own verdict. Votes travel with it because a 10 from one
     * person and a 9 from four hundred are not the same claim. */
    ratings: asFloat(attributes.ratings) || null,
    votes: asInt(attributes.votes) || 0,
    fps: asFloat(attributes.fps),
    url: String(attributes.url || ""),
  };
}

/* Trusted uploads first, then popularity. Hearing-impaired versions sink
 * slightly: correct subtitles, but their sound annotations are noise when the
 * goal is following dialogue. */
function rankingKey(result) {
  return [
    result.from_trusted ? 1 : 0,
    result.hearing_impaired ? -1 : 0,
    result.download_count,
  ];
}

function compareDescending(a, b) {
  const left = rankingKey(a);
  const right = rankingKey(b);
  for (let i = 0; i < left.length; i++) {
    if (left[i] !== right[i]) return right[i] - left[i];
  }
  return 0;
}

async function translateHttpError(response) {
  let detail = "";
  try {
    const parsed = await response.json();
    if (parsed && typeof parsed === "object") {
      detail = String(parsed.message || parsed.error || "");
    }
  } catch {
    // A non-JSON error body is normal; the status carries the meaning.
  }

  const lowered = detail.toLowerCase();
  if (response.status === 406 || lowered.includes("quota") || lowered.includes("limit")) {
    return new OpenSubtitlesError(detail || "daily download limit reached", {
      status: response.status,
      quotaExceeded: true,
    });
  }
  if (response.status === 401) {
    return new OpenSubtitlesError(detail || "OpenSubtitles rejected the API key", {
      status: response.status,
    });
  }
  if (response.status === 429) {
    return new OpenSubtitlesError(detail || "rate limited, slow down", {
      status: response.status,
    });
  }
  return new OpenSubtitlesError(detail || `OpenSubtitles returned HTTP ${response.status}`, {
    status: response.status,
  });
}

export class Client {
  constructor(apiKey) {
    this.apiKey = apiKey;
    this.token = null;
  }

  /** Look a title up in the index. Free, and says when nothing exists. */
  async features(query) {
    if (!query) return [];
    const payload = await this.request("GET", "/features", { params: { query } });
    if (!Array.isArray(payload.data)) return [];
    return payload.data.map(parseFeature).filter(Boolean);
  }

  /** Search for subtitles. Unlimited, so callers may retry freely. */
  async search({
    query = "",
    languages = [],
    year = null,
    season = null,
    episode = null,
    imdbId = null,
    parentImdbId = null,
    mediaType = null,
  } = {}) {
    const params = {};
    // The API wants languages comma-separated and, per its own best-practice
    // note, parameters in alphabetical order.
    if (languages.length) params.languages = [...languages].sort().join(",");
    if (query) params.query = query;
    if (year) params.year = String(year);
    if (season !== null && season !== undefined) params.season_number = String(season);
    if (episode !== null && episode !== undefined) params.episode_number = String(episode);
    if (imdbId) params.imdb_id = String(imdbId).replace(/^tt/, "");
    if (parentImdbId) params.parent_imdb_id = String(parentImdbId).replace(/^tt/, "");
    if (mediaType) params.type = mediaType;

    const payload = await this.request("GET", "/subtitles", { params });
    if (!Array.isArray(payload.data)) return [];
    return payload.data.map(parseSearchItem).filter(Boolean).sort(compareDescending);
  }

  /** Resolve a file_id to subtitle bytes. Costs one unit of daily quota. */
  async download(fileId) {
    const payload = await this.request("POST", "/download", { body: { file_id: fileId } });

    const link = payload.link;
    if (typeof link !== "string" || !link) {
      throw new OpenSubtitlesError(
        String(payload.message || "download response contained no link"),
      );
    }

    const content = await this.fetchFile(link);
    const remaining = payload.remaining;
    return {
      content,
      fileName: String(payload.file_name || `${fileId}.srt`),
      remaining: typeof remaining === "number" ? Math.trunc(remaining) : null,
      resetTime: payload.reset_time ? String(payload.reset_time) : null,
    };
  }

  async request(method, path, { params = null, body = null } = {}) {
    let url = `${API_BASE}${path}`;
    if (params && Object.keys(params).length) {
      // Alphabetical order and + for spaces, both per the API's guidance.
      const search = new URLSearchParams();
      for (const key of Object.keys(params).sort()) search.set(key, params[key]);
      url = `${url}?${search.toString()}`;
    }

    const headers = {
      "Api-Key": this.apiKey,
      "User-Agent": USER_AGENT,
      Accept: "application/json",
    };
    if (body !== null) headers["Content-Type"] = "application/json";
    if (this.token) headers.Authorization = `Bearer ${this.token}`;

    const response = await withTimeout((signal) =>
      fetch(url, {
        method,
        headers,
        body: body === null ? undefined : JSON.stringify(body),
        signal,
      }),
    );

    if (!response.ok) throw await translateHttpError(response);
    try {
      const parsed = await response.json();
      return parsed && typeof parsed === "object" && !Array.isArray(parsed)
        ? parsed
        : { data: parsed };
    } catch {
      throw new OpenSubtitlesError("OpenSubtitles returned a non-JSON response");
    }
  }

  /** Fetch the subtitle from the one-shot download link. */
  async fetchFile(link) {
    const response = await withTimeout((signal) =>
      fetch(link, { headers: { "User-Agent": USER_AGENT }, signal }),
    );
    if (!response.ok) throw await translateHttpError(response);

    const bytes = new Uint8Array(await response.arrayBuffer());
    /* fetch already unwraps Content-Encoding: gzip, which is the case the
     * daemon handles by hand. What it does not unwrap is a body that is a gzip
     * *file* rather than a gzip-encoded response, so the magic number is
     * checked as well. Both shapes occur. */
    if (bytes.length > 2 && bytes[0] === 0x1f && bytes[1] === 0x8b) return gunzip(bytes);
    return bytes;
  }
}

async function gunzip(bytes) {
  const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream("gzip"));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

/* fetch has no timeout of its own, and a download that hangs would leave the
 * user looking at a spinner with no way to tell it apart from a slow one. */
async function withTimeout(run) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    return await run(controller.signal);
  } catch (error) {
    if (error.name === "AbortError") {
      throw new OpenSubtitlesError("OpenSubtitles did not respond in time");
    }
    throw new OpenSubtitlesError(`could not reach OpenSubtitles: ${error.message}`);
  } finally {
    clearTimeout(timer);
  }
}
