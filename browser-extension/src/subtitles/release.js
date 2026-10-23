/* What a release name says about the picture it was made for, and how well a
 * subtitle's release agrees with the video's.
 *
 * Two subtitles of one film can be minutes apart. Zodiac's director's cut runs
 * four and a half minutes longer than the theatrical cut, in four inserts, and
 * a subtitle timed to the theatrical cut is right for 45 minutes and then
 * wrong by 14, 30, 46, 80 and finally 123 seconds. The aligner can follow that
 * staircase against a second subtitle; nothing can follow it for the first,
 * because there is nothing to follow it against. The cheapest fix is not to
 * attach the wrong cut: the video's own frame was titled
 * "Zodiac.2007.DC.1080p.BluRay.x265-RARBG.mp4", OpenSubtitles had English and
 * Turkish files named for the director's cut, and the extension attached the
 * two named "Zodiac (2007)" - because a release that is only the title scores
 * 1.0 against the title and a release that says what it is scores 0.81.
 *
 * So the edition decides first, then the platform, then the source, then the
 * release group. A field the subtitle does not state is neither for nor
 * against: most uploads say nothing, and most of those are the ordinary cut.
 */

const EDITIONS = [
  ["dc", /\b(?:dc|director'?s?[ ._-]*cut|directors[ ._-]*cut)\b/i],
  ["extended", /\bextended\b/i],
  ["unrated", /\b(?:unrated|uncut)\b/i],
  ["imax", /\bimax\b/i],
  ["theatrical", /\btheatrical\b/i],
  ["final", /\bfinal[ ._-]*cut\b/i],
];

/* The streaming services' scene tags. A stream from one of these is the WEB-DL
 * the tag names, so a subtitle made for it is timed to this very picture. */
const PLATFORMS = [
  ["amzn", /\b(?:amzn|amazon)\b/i],
  ["nf", /\b(?:nf|netflix)\b/i],
  ["dsnp", /\b(?:dsnp|disney\+?)\b/i],
  ["hmax", /\b(?:hmax|hbo(?:[ ._-]*max)?)\b/i],
  ["atvp", /\b(?:atvp|apple[ ._-]*tv\+?)\b/i],
];

const SOURCES = [
  ["bluray", /\b(?:blu-?ray|bdrip|brrip|bdremux|bd25|bd50|remux)\b/i],
  ["web", /\b(?:web-?dl|webrip|web)\b/i],
  ["hddvd", /\bhd-?dvd\b/i],
  ["dvd", /\b(?:dvd-?rip|dvdscr|dvd5|dvd9|dvd)\b/i],
  ["tv", /\b(?:hdtv|pdtv|sdtv|dsr)\b/i],
];

/* Host to platform, for a stream that has no release name at all - which is
 * every stream on the services themselves. */
const HOSTS = [
  [/(?:^|\.)primevideo\.com$|(?:^|\.)amazon\./i, "amzn"],
  [/(?:^|\.)netflix\.com$/i, "nf"],
  [/(?:^|\.)disneyplus\.com$/i, "dsnp"],
  [/(?:^|\.)(?:max|hbomax)\.com$/i, "hmax"],
  [/(?:^|\.)tv\.apple\.com$/i, "atvp"],
];

const firstOf = (table, text) => {
  for (const [name, pattern] of table) if (pattern.test(text)) return name;
  return null;
};

/* The group is the scene's signature, after the last hyphen: "x265-RARBG",
 * "XviD-DiAMOND". Two files from one group's rip carry one timing. */
function groupOf(text) {
  const bare = String(text).replace(/\.(?:mp4|mkv|avi|m4v|webm|srt|ass|vtt|sub)$/i, "");
  const found = /-([A-Za-z0-9]{2,15})\s*$/.exec(bare);
  return found ? found[1].toLowerCase() : null;
}

/* Whether a string is a release name at all, rather than a title: it carries
 * at least one of the tokens a scene release is made of. */
const RELEASE_SHAPE = /\b(?:1080p|720p|2160p|480p|4k|uhd|bluray|blu-ray|brrip|bdrip|webrip|web-?dl|dvdrip|hdrip|hdtv|x264|x265|h\.?264|h\.?265|hevc|xvid|remux)\b/i;

export function looksLikeRelease(text) {
  return RELEASE_SHAPE.test(String(text || ""));
}

/**
 * The fields a release name states. `title` is removed first, so a film whose
 * title contains a tag - "DC League of Super-Pets" - is not read as a
 * director's cut.
 */
export function describeRelease(text, { title = "" } = {}) {
  let rest = String(text || "");
  const words = String(title || "").split(/[\s._-]+/).filter((word) => word.length > 1);
  for (const word of words) rest = rest.replace(new RegExp(`\\b${word.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "ig"), " ");
  const platform = firstOf(PLATFORMS, rest);
  return {
    edition: firstOf(EDITIONS, rest),
    platform,
    source: platform ? "web" : firstOf(SOURCES, rest),
    group: looksLikeRelease(text) ? groupOf(text) : null,
  };
}

export function platformOfHost(host) {
  for (const [pattern, platform] of HOSTS) if (pattern.test(String(host || ""))) return platform;
  return null;
}

/**
 * What the page says about the picture: the first title candidate shaped like
 * a release name, and the service the stream comes from. Null fields where the
 * page says nothing, which is the ordinary case.
 */
export function videoRelease(context, { host = "" } = {}) {
  const named = (context?.candidates || []).map((c) => c?.text).find(looksLikeRelease) || "";
  const found = describeRelease(named, { title: context?.title });
  const platform = found.platform || platformOfHost(host);
  return { ...found, platform, source: platform ? "web" : found.source, name: named || null };
}

/**
 * How well a subtitle's release agrees with the video's, as a number to sort
 * by: positive agrees, negative contradicts, 0 says nothing either way.
 *
 * The edition outweighs everything because a wrong cut is minutes of film; a
 * platform or a group is the same encode, which is the same timing to the
 * frame; a source family is likelier to share a cut and a frame rate than not.
 * A subtitle claiming an edition the video does not have is counted against,
 * because the video saying nothing most often means the ordinary cut.
 */
export function releaseAffinity(video, subtitle) {
  if (!video) return 0;
  let score = 0;
  if (video.edition && subtitle.edition) score += video.edition === subtitle.edition ? 8 : -8;
  else if (!video.edition && subtitle.edition && subtitle.edition !== "theatrical") score -= 2;
  if (video.platform && subtitle.platform) score += video.platform === subtitle.platform ? 4 : 0;
  if (video.source && subtitle.source) score += video.source === subtitle.source ? 2 : 0;
  if (video.group && subtitle.group && video.group === subtitle.group) score += 3;
  return score;
}
