/* Capture everything needed to explain why a page did not work.
 *
 * The failures worth diagnosing are all invisible from any single vantage
 * point. The metadata lives in one frame and the video in another; the title
 * that got searched for is not the title on the screen; the content script
 * loaded in three frames and not the fourth. Each of those is a question about
 * which frame saw what, and no frame can answer it about the others.
 *
 * So this runs in the service worker, which is the only thing that can address
 * every frame, and it does three things:
 *
 *   - asks each frame what it can see
 *   - asks the *real* decision code what it would do, rather than describing it
 *   - runs the search a second time against the top frame's title, so the two
 *     can be compared instead of argued about
 *
 * It costs no download quota. Searching is free and unlimited; nothing here
 * fetches a subtitle.
 */

import { tabStatus } from "./daemon.js";
import { preferredLanguages, status as providerStatus } from "./provider.js";

const TOP_FRAME = 0;
const REPORT_KEY = "sso:lastDiagnostic";
const SCHEMA = 1;

/* Results are the bulkiest part of a report by a wide margin and the tail of
 * them is never what was wrong. Enough to see the shape of the ranking and the
 * ties at the top, then a count of what was dropped - never a silent cut. */
const MAX_RESULTS = 12;

export async function capture(tab) {
  const startedAt = new Date().toISOString();
  const frames = await collectFrames(tab.id);
  const status = await tabStatus(tab.id);
  const videoFrameId = status?.frameId ?? TOP_FRAME;

  const [provider, languages] = await Promise.all([providerStatus(), preferredLanguages()]);

  /* The comparison the whole report exists for. `plan` is what the shortcut
   * would actually do, from the frame it actually asks. `fromTopFrame` is the
   * same search against the page's own metadata. If those two disagree, the
   * frame the worker addresses is the bug. */
  const plan = await planFor(tab, videoFrameId);
  const fromTopFrame =
    videoFrameId === TOP_FRAME ? null : await planFor(tab, TOP_FRAME, { label: "top frame" });

  const report = {
    schema: SCHEMA,
    startedAt,
    extensionVersion: chrome.runtime.getManifest().version,
    userAgent: navigator.userAgent,

    // The id travels with the report so re-capturing from the report page acts
    // on the tab the report is about, not on the report's own tab.
    tab: { id: tab.id, url: tab.url, title: tab.title },

    provider: {
      servedBy: provider?.served_by ?? null,
      daemonRunning: provider?.served_by === "daemon",
      hasApiKey: Boolean(provider?.has_api_key),
      languages,
    },

    /* Which frame the worker talks to, and why. This is the single most useful
     * line in the report: everything the extension believes about the page
     * comes from this frame. */
    frameChoice: {
      videoFrameId,
      chosenBecause: status?.hasVideo
        ? "first frame reporting a playable video"
        : "no frame reported a video; fell back to the top frame",
      frameCount: frames.length,
      framesWithContentScript: frames.filter((f) => f.reachable).length,
      framesWithVideo: frames.filter((f) => f.report?.videoCount > 0).length,
      framesWithTitleCandidates: frames.filter((f) => f.report?.titleCandidates?.length > 0).length,
    },

    frames,
    plan,
    fromTopFrame,
    episodes: summariseEpisodes(frames, plan, fromTopFrame),
  };

  await chrome.storage.local.set({ [REPORT_KEY]: report }).catch(() => {});
  return report;
}

export async function lastReport() {
  const stored = await chrome.storage.local.get(REPORT_KEY);
  return stored[REPORT_KEY] || null;
}

// --- the frames -------------------------------------------------------------

async function collectFrames(tabId) {
  let frames = [];
  try {
    frames = (await chrome.webNavigation.getAllFrames({ tabId })) || [];
  } catch {
    frames = [{ frameId: TOP_FRAME, url: "unknown", parentFrameId: -1 }];
  }

  return Promise.all(
    frames.map(async (frame) => {
      const entry = {
        frameId: frame.frameId,
        parentFrameId: frame.parentFrameId,
        url: shortenUrl(frame.url),
        origin: originOf(frame.url),
        reachable: false,
        report: null,
      };
      try {
        const report = await chrome.tabs.sendMessage(
          tabId,
          { type: "sso:diagnose" },
          { frameId: frame.frameId },
        );
        if (report) {
          entry.reachable = true;
          entry.report = report;
        }
      } catch (error) {
        /* Not reachable is a finding, not a failure. A frame with no content
         * script is one the extension is blind to - which is the explanation
         * when a page "does nothing". */
        entry.unreachableBecause = String(error?.message || error).slice(0, 120);
      }
      return entry;
    }),
  );
}

function originOf(url) {
  try {
    return new URL(url).origin;
  } catch {
    return url || "unknown";
  }
}

/* A player frame's URL is frequently a signed, single-use link, and a report is
 * written to be pasted somewhere. The origin plus the first path segment says
 * which player is in use - which is the whole diagnostic value of it - and the
 * token is not carried along. */
function shortenUrl(url) {
  try {
    const parsed = new URL(url);
    // about:blank, data:, blob: - no origin, nothing sensitive, and mangling
    // them into "null/" loses the one thing they were saying.
    if (!/^https?:$/.test(parsed.protocol)) return url;
    const segments = parsed.pathname.split("/").filter(Boolean);
    const rest = segments.length > 1 || parsed.search ? "/…" : "";
    return `${parsed.origin}/${segments[0] || ""}${rest}`;
  } catch {
    return url || "unknown";
  }
}

// --- the decision -----------------------------------------------------------

/* Imported lazily to avoid a cycle: background.js imports this file, and the
 * planner lives there because autoAttach needs it too. Keeping one copy of the
 * decision is the point - a diagnostic that re-derives it can disagree with the
 * code it is describing. */
let planner = null;

export function usePlanner(fn) {
  planner = fn;
}

async function planFor(tab, frameId, { label = "" } = {}) {
  if (!planner) return { error: "no planner registered" };
  try {
    const plan = await planner(tab, frameId);
    return condensePlan(plan, { frameId, label });
  } catch (error) {
    return { frameId, label, error: String(error?.message || error) };
  }
}

function condensePlan(plan, { frameId, label }) {
  const results = plan.found?.results || [];
  return {
    frameId,
    label,
    // What was asked, which is what most reports turn out to be about.
    askedWith: {
      title: plan.title,
      titleSource: plan.titleSource,
      year: plan.year,
      languages: plan.languages,
    },
    // What the daemon made of it after cleaning the title up.
    searchedFor: plan.found?.used || null,
    resolved: plan.found?.resolved || null,
    lowConfidence: plan.found?.low_confidence ?? null,
    threshold: plan.threshold ?? null,

    decision: plan.decision,
    reason: plan.reason,
    best: describeResult(plan.best),
    second: describeResult(plan.second),

    resultCount: results.length,
    resultsOmitted: Math.max(0, results.length - MAX_RESULTS),
    results: results.slice(0, MAX_RESULTS).map(describeResult),

    /* A series whose results span several episodes is the shape that produces
     * a confident wrong answer, so it is counted rather than left to be spotted
     * by reading the list. */
    distinctEpisodes: countEpisodes(results),
    topScoreTies: countTopTies(results),
  };
}

function describeResult(result) {
  if (!result) return null;
  return {
    fileId: result.file_id,
    language: result.language,
    name: result.movie_name,
    release: result.release,
    season: result.season ?? null,
    episode: result.episode ?? null,
    score: result.match_score,
    cached: Boolean(result.cached),
    downloads: result.download_count,
  };
}

function countEpisodes(results) {
  const seen = new Set();
  for (const result of results) {
    if (result.season != null || result.episode != null) {
      seen.add(`S${result.season}E${result.episode}`);
    }
  }
  return [...seen].slice(0, 20);
}

/* How many results share the winning score. More than one means the ordering
 * past that point decides which subtitle gets attached, and the tiebreaks -
 * language, then whether a file is already on disk - know nothing about which
 * episode is on screen. */
function countTopTies(results) {
  if (results.length === 0) return 0;
  const top = Math.max(...results.map((r) => r.match_score ?? 0));
  return results.filter((r) => (r.match_score ?? 0) === top).length;
}

// --- the episode question ---------------------------------------------------

/* Pulled to the top of the report because on a series it is nearly always the
 * answer, and it is buried three levels down in the per-frame data otherwise. */
function summariseEpisodes(frames, plan, fallbackPlan) {
  const markers = [];
  let total = 0;
  let omitted = 0;
  for (const frame of frames) {
    const episodes = frame.report?.episodes;
    if (!episodes) continue;
    total += episodes.total;
    omitted += episodes.omitted;
    for (const marker of episodes.markers) markers.push({ ...marker, frameId: frame.frameId });
  }

  // Selected-first ordering is done frame-side; re-applied here because the
  // frames are merged and one frame's unselected markers would otherwise sort
  // ahead of another frame's selected one.
  markers.sort((a, b) => Number(b.selected) - Number(a.selected));
  const selected = markers.filter((marker) => marker.selected);
  const fromTitle = frames.map((f) => f.report?.episodeInTitle).find(Boolean) || null;
  const fromUrl = frames.map((f) => f.report?.episodeInUrl).find(Boolean) || null;

  const searched = plan?.searchedFor || {};

  /* What kind of thing this is, which decides whether a missing episode
   * matters. Taken from the believed frame, and from the top frame when that
   * one resolved nothing - otherwise a report where the believed frame failed
   * outright says "not resolved" next to "the page says S1E1", which reads as
   * though the series could not be identified at all when in fact it was
   * identified perfectly from a frame nobody asked. */
  const resolved = plan?.resolved || fallbackPlan?.resolved || null;
  return {
    // What the search actually asked for. null,null on a series is the defect.
    searchedSeason: searched.season ?? null,
    searchedEpisode: searched.episode ?? null,
    resolvedType: resolved?.type ?? null,
    resolvedFrom: plan?.resolved ? "the frame it believes" : resolved ? "the top frame" : null,

    // What the page could have told it.
    selectedOnPage: selected.slice(0, 5),
    fromTitle,
    fromUrl,
    markersFound: total,
    markersOmitted: omitted,
    sample: markers.slice(0, 8),

    verdict: verdictFor(plan, resolved?.type ?? null, selected, fromTitle, fromUrl),
  };
}

function verdictFor(plan, resolvedType, selected, fromTitle, fromUrl) {
  const searched = plan?.searchedFor || {};
  const asked = searched.season != null || searched.episode != null;
  const isSeries = /tv|show|series|episode/i.test(resolvedType || "");
  const available = selected[0] || fromTitle || fromUrl;

  if (asked) return "the search named an episode";
  if (!isSeries && !available) return "not a series, and no episode markers on the page";
  if (available) {
    return `the search named no episode, but the page says S${available.season}E${available.episode}`;
  }
  return "the search named no episode, and none could be found on the page";
}
