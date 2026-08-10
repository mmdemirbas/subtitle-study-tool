/* Turn a browser tab title into something worth searching for.
 *
 * Port of subtitle-daemon/src/subtitle_daemon/titles.py.
 *
 * The one rule worth restating: stripping may only remove a *suffix or prefix*,
 * and only if something is left over. "Free Willy" and "The Full Monty" have to
 * survive a noise list containing "free" and "full".
 */

const LEADING_NOISE = /^\s*(?:\(\d+\)|[▶●▪•])\s*/;

/* Kept as bare class *contents* so it can be embedded both as its own class and
 * inside a larger one. Wrapping it in brackets here would nest brackets at the
 * second use site and silently break the pattern. */
const SEPARATOR_CHARS = "\\-|–—·•:";
const SEPARATOR = `[${SEPARATOR_CHARS}]`;

/* Branding appears at BOTH ends in the wild: Prime Video detail pages title
 * themselves "Prime Video: Crime 101", while player pages use "Crime 101 -
 * Prime Video". Stripping only the suffix leaves the site name in the query,
 * which turns a title search into a fuzzy match against the word "prime" - the
 * bug that returned "Ekusute" and "Major Crimes" for Crime 101. */
const SITE_NAMES =
  "(?:netflix|prime\\s*video|amazon(?:\\s*prime(?:\\s*video)?)?|disney\\+?" +
  "|hulu|hbo(?:\\s*max)?|max|apple\\s*tv\\+?|paramount\\+?|peacock" +
  "|youtube(?:\\s*tv)?|vimeo|dailymotion|crunchyroll" +
  "|plex|jellyfin|emby|mubi|blutv|exxen|gain|tabii|tod)";

const SITE_SUFFIX = new RegExp(`\\s*${SEPARATOR}\\s*${SITE_NAMES}\\s*$`, "i");
const SITE_PREFIX = new RegExp(`^\\s*${SITE_NAMES}\\s*${SEPARATOR}\\s*`, "i");

// "Watch <title>" openers, stripped only when a title follows.
const WATCH_PREFIX = /^\s*(?:watch|stream|play)\s+(?=\S)/i;

const WATCH_NOISE_WORD =
  "(?:watch(?:ing)?|online|free|full|movie|film|stream(?:ing)?" +
  "|hd|fhd|uhd|4k|1080p?|720p?|2160p?" +
  "|izle|seyret|tek|par[çc]a|dizi|b[öo]l[üu]m" +
  "|t[üu]rk[çc]e|dublaj|altyaz[ıi]l[ıi]|altyaz[ıi]" +
  "|subtitled|subbed|dubbed|eng|tr)";

const WATCH_NOISE_TAIL = new RegExp(
  `\\s*${SEPARATOR}?\\s*(?:\\b${WATCH_NOISE_WORD}\\b[\\s${SEPARATOR_CHARS}]*)+$`,
  "i",
);

/* Release-scene tokens. Everything from the first one onward is metadata, and
 * their presence is also what makes a bare year trustworthy as a year. */
const RELEASE_TOKENS = new RegExp(
  "\\b(?:1080p|720p|2160p|480p|4k|uhd|hdr|hdrip|bluray|blu-ray" +
    "|brrip|bdrip|webrip|web-?dl|dvdrip|hdtv|camrip" +
    "|x264|x265|h\\.?264|h\\.?265|hevc|xvid|avc" +
    "|aac|ac3|dts|ddp?5\\.1|atmos|truehd" +
    "|remux|proper|repack|extended|uncut|remastered)\\b",
  "i",
);

const EPISODE_PATTERNS = [
  /\bS(\d{1,2})\s*[.\-_ ]?\s*E(\d{1,3})\b/i,
  /\b(\d{1,2})x(\d{1,3})\b/i,
  /\bseason\s*(\d{1,2})\D{1,10}episode\s*(\d{1,3})\b/i,
];

const YEAR_RANGE = "(?:19[0-9]{2}|20[0-4][0-9])";

/* A year is only *removed* when it is bracketed, or when the string is a scene
 * release where dots delimit fields. A bare trailing number is left alone,
 * because "Blade Runner 2049" is a real title. */
const YEAR_BRACKETED = new RegExp(`[([]\\s*(${YEAR_RANGE})\\s*[)\\]]`);
// JavaScript has lookbehind, so Python's (?<=\.)...(?=\.) ports directly.
const YEAR_DOTTED = new RegExp(`(?<=\\.)(${YEAR_RANGE})(?=\\.)`);

const TRAILING_YEAR = new RegExp(`\\s(${YEAR_RANGE})$`);

/**
 * Remove a matching prefix or suffix, but never everything.
 *
 * The guard keeps a title made entirely of noise words from being reduced to an
 * empty query - "Prime Video" on its own stays as it is.
 */
function stripRepeatedly(text, pattern, limit = 3) {
  let current = text;
  for (let i = 0; i < limit; i++) {
    const stripped = current.replace(pattern, "").trim();
    if (stripped === current || !stripped) break;
    current = stripped;
  }
  return current;
}

/** Python's str.strip(chars): trim any of these characters from both ends. */
function stripChars(text, chars) {
  let start = 0;
  let end = text.length;
  while (start < end && chars.includes(text[start])) start++;
  while (end > start && chars.includes(text[end - 1])) end--;
  return text.slice(start, end);
}

/**
 * Turn what the reader typed, or what the page says, into a search.
 *
 * Port of titles.resolve in subtitle_daemon/titles.py. One function rather than
 * the rule written out at each search path, because it WAS written out twice
 * and only the daemon's copy was corrected when the rule changed - so a fix
 * that four suites agreed was complete never reached the path that runs when
 * the daemon is down, which is the ordinary case.
 *
 * Markers found in the searched text win over the ones the caller passed.
 */
export function resolve({ title = "", query = "", year = null, season = null, episode = null } = {}) {
  const guessed = guess(query || title);
  return {
    query: guessed.query || query || "",
    year: guessed.year ?? year ?? null,
    season: guessed.season ?? season ?? null,
    episode: guessed.episode ?? episode ?? null,
  };
}

/** Extract a searchable title, and season/episode/year when confident. */
export function guess(raw) {
  let text = String(raw || "").replace(LEADING_NOISE, "").trim();

  /* Site branding first: it sits outside the watch-noise, and some pages stack
   * two separators ("Title - Watch Online - SomeSite"). Both ends, because
   * branding leads on some pages and trails on others. */
  text = stripRepeatedly(text, SITE_PREFIX);
  text = stripRepeatedly(text, SITE_SUFFIX);
  text = stripRepeatedly(text, WATCH_NOISE_TAIL);
  text = stripRepeatedly(text, SITE_SUFFIX);
  text = stripRepeatedly(text, WATCH_PREFIX, 1);

  /* Looked for BEFORE the episode marker is cut away, not after.
   *
   * A scene release puts the marker in front of the quality tokens -
   * "The.Americans.2013.S02E04.1080p.BluRay.x264" - so cutting at the marker
   * first removed every token this test looks for, and the string stopped
   * counting as a scene release exactly when it most obviously was one. */
  const sceneRelease = RELEASE_TOKENS.test(text);

  let season = null;
  let episode = null;
  for (const pattern of EPISODE_PATTERNS) {
    const match = pattern.exec(text);
    if (match) {
      season = Number(match[1]);
      episode = Number(match[2]);
      // Everything from the marker onward is episode metadata, not title.
      text = text.slice(0, match.index);
      break;
    }
  }

  let year = null;

  // Cut at the first release-scene token; the title precedes it.
  const release = RELEASE_TOKENS.exec(text);
  if (release) text = text.slice(0, release.index);

  for (const pattern of [YEAR_BRACKETED, YEAR_DOTTED]) {
    const match = pattern.exec(text);
    if (match && (pattern === YEAR_BRACKETED || sceneRelease)) {
      const candidate =
        text.slice(0, match.index) + " " + text.slice(match.index + match[0].length);
      if (stripChars(candidate, " .-|:")) {
        year = Number(match[1]);
        text = candidate;
        break;
      }
    }
  }

  // Scene releases use dots and underscores as spaces. Only treat dots that way
  // when there are several, so "Mr. Robot" keeps its period.
  if ((text.match(/\./g) || []).length >= 2) text = text.replace(/\./g, " ");
  text = text.replace(/_/g, " ");

  text = text.replace(/[[\](){}]/g, " ");
  text = text.replace(/\s{2,}/g, " ");
  text = stripChars(text, " -|–—·•:,.");

  /* A trailing bare year is still metadata when something else in the string
   * has already said this is a listing rather than a title: release tokens, or
   * an episode marker. "Dallas 2012 S02E04" is the reboot's year and a season,
   * not a programme called "Dallas 2012". */
  if (year === null && (sceneRelease || season !== null)) {
    const trailing = TRAILING_YEAR.exec(text);
    if (trailing && text.slice(0, trailing.index).trim()) {
      year = Number(trailing[1]);
      text = text.slice(0, trailing.index).trim();
    }
  }

  /* The same year twice. Streaming pages print it once beside the title and
   * again in the listing line under it: "The Americans (2013) 2013 - S02 E04"
   * is what one of them actually shows. */
  if (year !== null) text = dropNumber(text, year);

  return { query: text, year, season, episode };
}

/**
 * Remove a standalone number, unless it was the whole title.
 *
 * Guarded on both sides so a year inside a longer run of digits survives, and
 * guarded on the result so "1917" does not become an empty query for a film
 * whose title is its year.
 */
function dropNumber(text, number) {
  const without = stripChars(
    text.replace(new RegExp(`(?<!\\d)${number}(?!\\d)`, "g"), " ").replace(/\s{2,}/g, " "),
    " -|–—·•:,.",
  );
  return without || text;
}
