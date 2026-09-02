/* Service worker: the keyboard-shortcut path, and the only place that talks to
 * the daemon.
 *
 * MV3 content scripts cannot make cross-origin requests with extension
 * permissions, and the daemon would refuse a page origin anyway, so the panel
 * and the popup both route their daemon calls through here.
 */

import {
  DaemonDownError,
  attachToTab,
  forEpisode,
  gloss as glossWords,
  pageContextForTab,
  pickBest,
  pickSecondLanguage,
  subtitleContext,
  tabStatus,
} from "./daemon.js";
/* Every call that used to go straight to the daemon goes through the provider,
 * which prefers the daemon and does the work here when it is not running. */
import {
  cacheClear,
  cacheDelete,
  cacheEntries,
  fetchSubtitle,
  preferredLanguages,
  search,
  status as providerStatus,
  syncNow,
  updateSettings,
} from "./provider.js";
/* Study mode lives in the worker for two reasons: the rarity tables are large
 * enough that one copy per frame would be wasteful, and the dictionary is a
 * cross-origin call, which an MV3 content script cannot make with extension
 * permissions. */
import { capture, lastReport, usePlanner } from "./diagnose.js";
import * as trace from "./trace.js";
import * as deck from "./study/deck.js";
import { canReachDictionary, lookup } from "./study/lookup.js";
import { rank } from "./study/rarity.js";

const TOP_FRAME = 0;

/* Reloading an extension does NOT update tabs that are already open: they keep
 * running the content script from the previous version until navigated. That
 * makes every change invisible on the tab you are testing on, and the symptom
 * is silence - a new command arrives and nothing in the page knows about it.
 *
 * So on install and on update, inject the current scripts into every tab that
 * already matches. Frames that already have them exit on their own guard, so
 * re-injection is harmless. */
/* Nothing here should ever put a download bubble on screen.
 *
 * The log writes a file every few seconds while a film is playing, and a
 * browser announcing each one is worse than not recording at all. Guarded
 * because the permission can be absent on an older build and the whole worker
 * must not fail to start over a notification setting. */
try {
  chrome.downloads?.setUiOptions?.({ enabled: false });
} catch {
  // Older Chrome, or the permission was declined. The log still writes.
}

/* The worker's own failures, recorded rather than lost to a console nobody has
 * open. An unhandled rejection in here is invisible from the page and from the
 * report, and it is exactly the class of thing that makes a button do nothing. */
globalThis.addEventListener("error", (event) => {
  trace.record("error", {
    where: "worker",
    message: String(event.message || event.error?.message || event.error || "error"),
    stack: String(event.error?.stack || "").slice(0, 2000),
    file: `${event.filename || ""}:${event.lineno || 0}`,
  });
});
globalThis.addEventListener("unhandledrejection", (event) => {
  trace.record("error", {
    where: "worker",
    unhandledRejection: true,
    message: String(event.reason?.message || event.reason || "rejection"),
    stack: String(event.reason?.stack || "").slice(0, 2000),
  });
});

chrome.runtime.onInstalled.addListener(async () => {
  const injectable = await chrome.tabs.query({ url: ["http://*/*", "https://*/*"] });
  await Promise.all(injectable.map((tab) => inject(tab.id)));
});

/* Put the current content scripts into one tab, every frame of it.
 *
 * One function with two callers, and both of them used to open with an
 * insertCSS whose `files` came from `content_scripts[0].css` - a key this
 * manifest does not have, because every stylesheet here is fetched at runtime
 * and adopted into a shadow root instead (see the notes in content.js on
 * style-src). So `files` was undefined, and Chrome answers that with
 *
 *   Exactly one of 'css' and 'files' must be specified.
 *
 * Both calls sat in one try, so the executeScript below it - the line that
 * does the actual work - was never reached. Neither re-injection had ever run.
 *
 * tests/worker.mjs could not see it: its stub manifest returned
 * `content_scripts: [{ js: [], css: [] }]`, supplying the key the real one
 * lacks, and its scripting stub accepted arguments the API rejects. The stub
 * now mirrors the real manifest.
 */
async function inject(tabId) {
  if (!tabId) return false;
  const scripts = chrome.runtime.getManifest().content_scripts?.[0];
  if (!scripts?.js?.length) return false;

  // Only if there is any, and never in the same try as the scripts: a
  // stylesheet that fails to insert must not cost the injection.
  if (scripts.css?.length) {
    try {
      await chrome.scripting.insertCSS({
        target: { tabId, allFrames: true },
        files: scripts.css,
      });
    } catch {
      // Styling is not what makes the extension work.
    }
  }

  try {
    await chrome.scripting.executeScript({
      target: { tabId, allFrames: true },
      files: scripts.js,
    });
    return true;
  } catch {
    // A restricted page (chrome://, the web store), or a tab this extension
    // has no host permission for.
    return false;
  }
}

// --- sites that put subtitles on by themselves ------------------------------

/* Per site, not everywhere.
 *
 * "Everywhere" means a news clip, a product tour and an embedded trailer each
 * spending one of ten daily downloads on subtitles nobody wanted. A site you
 * have watched something on with subtitles is a statement about how you watch
 * there; a site you have never used this on is not, and guessing on its behalf
 * is the kind of help that has to be switched off.
 *
 * Three states, not two. Absent means never decided, and the first attach on
 * the site decides it. `false` means the reader turned it off, and is why this
 * stores a value rather than deleting the key - deleting would let the next
 * manual attach turn it straight back on, which is a switch that does not work.
 */
const AUTO_SITES_KEY = "sso:autoSites";

function originOf(url) {
  try {
    return new URL(url).origin;
  } catch {
    return "";
  }
}

async function autoSites() {
  const stored = await chrome.storage.local.get(AUTO_SITES_KEY);
  const sites = stored[AUTO_SITES_KEY];
  return sites && typeof sites === "object" ? sites : {};
}

async function autoSiteEnabled(url) {
  const origin = originOf(url);
  return Boolean(origin && (await autoSites())[origin] === true);
}

async function setAutoSite(url, enabled) {
  const origin = originOf(url);
  if (!origin) return { origin: "", enabled: false, decided: false };
  const sites = await autoSites();
  sites[origin] = Boolean(enabled);
  await chrome.storage.local.set({ [AUTO_SITES_KEY]: sites });
  return { origin, enabled: Boolean(enabled), decided: true };
}

/** The first attach on a site decides it, and says so once. */
async function rememberSite(sender) {
  const tab = sender?.tab;
  const origin = originOf(tab?.url || "");
  if (!tab?.id || !origin) return { ok: false };
  const sites = await autoSites();
  if (origin in sites) return { ok: true, already: true };

  await setAutoSite(tab.url, true);
  /* Announced on the page it applies to, once. A behaviour that starts
   * happening by itself and was never mentioned reads as the tool doing
   * something nobody asked for, which is how a good default gets switched off. */
  const status = await tabStatus(tab.id);
  await notify(
    tab.id,
    status?.frameId ?? TOP_FRAME,
    "Subtitles will come on by themselves here - the settings window can stop that",
  );
  return { ok: true, already: false };
}

/* One attempt per programme per tab. Every frame of the page reports the
 * change, and the tick that reports it runs twenty times a second. */
const handledProgramme = new Map();
chrome.tabs.onRemoved.addListener((tabId) => handledProgramme.delete(tabId));

async function onProgrammeChange(sender, mark) {
  const tab = sender?.tab;
  if (!tab?.id || !tab.url || !mark) return { ok: false };
  if (handledProgramme.get(tab.id) === mark) return { ok: false, reason: "already handled" };
  handledProgramme.set(tab.id, mark);

  if (!(await autoSiteEnabled(tab.url))) return { ok: false, reason: "not this site" };

  /* No hasVideo gate here any more, and it is removed as a hazard rather than
   * as the bug.
   *
   * The frame does not announce a programme until it has picked a film, so in
   * practice this gate agreed. But the mark is written down as handled at the
   * top of this function, so any moment it disagreed - a stream restarting
   * mid-seek is one, where the arrived length goes short again - cost the one
   * attempt for that programme with no way back. autoAttach waits for the film
   * itself now, and refuses only when the page says none is coming. */
  const status = await tabStatus(tab.id);
  const frameId = status?.frameId ?? TOP_FRAME;

  /* Whatever is on screen belongs to the programme that just ended, so it goes
   * - but not until there is something to put up in its place.
   *
   * It used to go first, on the argument that the last episode's lines over
   * this one read as a sync fault rather than as the wrong file. True, and it
   * traded a wrong subtitle for no subtitle every time the search that follows
   * came back empty. Twice in one evening on 2026-08-23 that is exactly what
   * happened - "Nothing matched "The Americans" well" against a film that had
   * had both languages on it a second earlier, 39 and 26 minutes in. Reported
   * as "my subtitles are gone again in the middle of the movie".
   *
   * autoAttach drops them at the point it has a result to attach, so a search
   * that finds nothing now costs nothing. The window where the old lines are
   * still up is the download, which is the same window the reader would spend
   * looking at an empty picture otherwise. */
  await autoAttach(tab, frameId, status, { replacing: Boolean(status?.attached) });
  return { ok: true };
}

// --- which frame does what --------------------------------------------------

/* Two frames, one film, and no way for them to speak except through here.
 *
 * Sites that embed a player from another host put the video in a cross-origin
 * frame and then paint over it. Measured on streaming-site.example: an <iframe> appended
 * to <html>, fixed, inset 0, z-index 2147483647, taking every click on the
 * page. The top layer is per document, so nothing drawn inside the player's
 * frame can get above that - the whole frame is behind it. The CC button was
 * visible and every press went to the site.
 *
 * So the frames divide the work. The frame with the video keeps the subtitles,
 * because that is where the picture is and where a word has to be clicked. The
 * top frame gets the button and the panel, because that is the document the
 * page is painting in. Different origins, so every word between them is
 * carried here.
 *
 * On the ordinary page, where the video is in the top frame, none of this runs
 * and nothing changes.
 */
const videoFrames = new Map(); // tabId -> the frame holding the video, when it is not the top one

chrome.tabs.onRemoved.addListener((tabId) => videoFrames.delete(tabId));

/* A frame saying whether it holds the film - and being told what that makes it.
 *
 * The answer matters: a frame told it is the video frame stops drawing its own
 * CC button, because the top frame is drawing one. If the top frame did not
 * take the job - no content script there, an extension page, a sandboxed
 * document - the answer is "solo" and the player's frame keeps its button. One
 * button either way, and never none.
 */
async function noteFrameRole(sender, hasSubject) {
  const tabId = sender?.tab?.id;
  const frameId = sender?.frameId;
  if (tabId == null || frameId == null) return { ok: false, role: "solo" };

  if (!hasSubject) {
    /* Only the frame that claimed it may give it up. Every frame of the page
     * reports, so a sibling frame whose preview stopped playing must not
     * unseat the player. */
    if (videoFrames.get(tabId) === frameId) {
      videoFrames.delete(tabId);
      await send(tabId, TOP_FRAME, { type: "sso:frameRole", role: "solo" });
    }
    return { ok: true, role: "solo" };
  }

  if (frameId === TOP_FRAME) {
    videoFrames.delete(tabId);
    return { ok: true, role: "solo" };
  }

  videoFrames.set(tabId, frameId);
  const answer = await send(tabId, TOP_FRAME, {
    type: "sso:frameRole",
    role: "chrome",
    videoFrameId: frameId,
  });
  if (!answer?.ok) {
    videoFrames.delete(tabId);
    return { ok: true, role: "solo" };
  }
  return { ok: true, role: "video" };
}

async function relay(message, sender) {
  const tabId = sender?.tab?.id;
  if (tabId == null) return null;
  const to = message.type === "sso:toChrome" ? TOP_FRAME : videoFrames.get(tabId);
  // Never back to the sender: a frame that was both would talk to itself.
  if (to == null || to === sender.frameId) return null;
  return send(tabId, to, message.message);
}

// --- daemon proxy for panel.js and popup.js ---------------------------------

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.type === "sso:frameRole") {
    noteFrameRole(sender, Boolean(message.hasSubject)).then(sendResponse, () =>
      sendResponse({ ok: false, role: "solo" }),
    );
    return true;
  }

  if (message?.type === "sso:toChrome" || message?.type === "sso:toVideo") {
    // A frame that has gone is not an error here; the sender reads null as
    // "nobody is listening" and carries on alone.
    relay(message, sender).then(sendResponse, () => sendResponse(null));
    return true;
  }

  if (message?.type === "sso:daemon") {
    handleDaemonCall(message.op, message.args || {}, sender)
      .then(sendResponse)
      // Transport failures are reported as data rather than thrown, so the
      // caller gets a message instead of an unresolved promise.
      .catch((error) => sendResponse({ transportError: describe(error) }));
    return true;
  }

  /* The panel is inside a page, which cannot open an extension page itself.
   * Sending it here is the only route, and it keeps the deck one click from
   * where the words are saved rather than somewhere in the browser's menus. */
  /* Two reports from the page, both about what is playing rather than about
   * what the reader pressed. They are separate messages because they answer
   * different questions: one says this site is used this way, the other says
   * what is playing has changed. */
  if (message?.type === "sso:attached") {
    rememberSite(sender).then(sendResponse, () => sendResponse({ ok: false }));
    return true;
  }

  if (message?.type === "sso:programme") {
    onProgrammeChange(sender, message.mark).then(sendResponse, (error) =>
      sendResponse({ ok: false, error: describe(error) }),
    );
    return true;
  }

  if (message?.type === "sso:openReport") {
    chrome.tabs
      .create({ url: chrome.runtime.getURL("src/report.html") })
      .then(() => sendResponse({ ok: true }), () => sendResponse({ ok: false }));
    return true;
  }

  if (message?.type === "sso:openOptions") {
    chrome.tabs
      .create({ url: chrome.runtime.getURL(`src/options.html${message.hash || ""}`) })
      .then(() => sendResponse({ ok: true }), () => sendResponse({ ok: false }));
    return true;
  }

  // The popup's buttons run the same paths as the keyboard shortcuts, so the
  // match-quality gate and error handling cannot drift between the two.
  if (message?.type === "sso:command") {
    runCommand(message.command)
      .then(() => sendResponse({ ok: true }))
      .catch((error) => sendResponse({ ok: false, error: describe(error) }));
    return true;
  }

  return false;
});

async function handleDaemonCall(op, args, sender) {
  switch (op) {
    case "health":
      return providerStatus();
    case "search": {
      const languages = args.languages?.length ? args.languages : await preferredLanguages();
      return search({ ...args, languages });
    }
    case "fetch":
      return fetchSubtitle(args.fileId, args.context || {});
    case "settings":
      return updateSettings(args.patch || {});

    /* The panel runs inside the player's frame, which on an embedded player can
     * see neither the page's metadata nor the episode list - and cannot reach
     * across the origin boundary to look. The worker can address every frame,
     * so the panel asks it, the way it already asks for everything else. */
    case "pageContext": {
      const tab = await tabToDiagnose(args.tabId, sender);
      if (!tab?.id) return { error: "no tab" };
      const status = await tabStatus(tab.id);
      return pageContextForTab(tab, status?.frameId ?? TOP_FRAME);
    }
    /* The panel's switch for this site. It asks the worker rather than reading
     * storage itself, because the panel runs inside the page - and inside an
     * embedded player that page is not the site the reader means. */
    case "autoSite": {
      const tab = await tabToDiagnose(args.tabId, sender);
      if (!tab?.url) return { origin: "", enabled: false };
      return { origin: originOf(tab.url), enabled: await autoSiteEnabled(tab.url) };
    }
    case "autoSiteSet": {
      const tab = await tabToDiagnose(args.tabId, sender);
      if (!tab?.url) return { origin: "", enabled: false };
      return setAutoSite(tab.url, args.enabled);
    }

    case "sync":
      return syncNow();
    case "cacheList":
      return cacheEntries();
    case "cacheDelete":
      return cacheDelete(args.fileId);
    case "cacheClear":
      return cacheClear(args.options || {});

    /* Study operations answer from the worker without necessarily touching the
     * daemon, but they arrive on the same channel: the panel and the overlay
     * already have one way to ask the worker something, and a second one would
     * be two things to keep in step for no gain. */
    case "rank":
      return { ranks: await rank(args.words || [], args.language) };
    case "lookup":
      return lookup({
        query: args.query,
        language: args.language,
        target: args.target,
        sentence: args.sentence,
      });
    /* Straight to the daemon rather than through study/lookup.js, because there
     * is no in-extension version of this to fall back to: glossing a word in
     * its line needs a model, and a model needs either a key or something
     * listening on this machine. Neither belongs in a content script. Down, and
     * every word simply falls back to being asked for one at a time. */
    case "gloss":
      return glossWords(args.items || [], args.language, args.target).catch(() => ({}));
    case "lookupReady":
      return { dictionary: await canReachDictionary() };
    case "deckSave":
      return deck.save(args.entry || {});
    case "deckTerms":
      return { terms: await deck.terms() };
    case "deckList":
      return { entries: await deck.all() };
    case "deckRemove":
      return deck.remove(args.id);
    case "deckClear":
      return deck.clear();

    /* Diagnostics. `capture` runs a search, which is free; nothing here spends
     * download quota. */
    /* Which tab to diagnose, in the order of how sure we are:
     *
     *   an explicit id   the report page re-capturing the tab it is about
     *   the sender's tab the control panel, which is inside the page itself
     *   the active tab   anything else
     *
     * The active tab is the fallback rather than the rule because the two
     * surfaces that ask for this are both cases where it is wrong: the panel
     * lives in the page (so the sender is the answer, and it stays right if the
     * user switches tabs while it works) and the report page is a tab of its
     * own, where the active tab is the report rather than the film. */
    case "diagnose": {
      const tab = await tabToDiagnose(args.tabId, sender);
      if (!tab?.id) return { error: "that tab is gone" };
      await ensureInjected(tab.id);
      return capture(tab);
    }
    case "lastDiagnostic":
      return (await lastReport()) || { error: "nothing captured yet" };

    /* Kept as it happens, so a question about a page does not have to be
     * answered by asking somebody to make it go wrong again. See trace.js. */
    case "trace": {
      await trace.record(args.kind, await traceDetail(args, sender));
      return { ok: true };
    }
    case "traceLog":
      return { entries: await trace.entries(), state: await trace.state(), folder: trace.FOLDER };
    case "traceFlush":
      // force, because this one was asked for: if the daemon is down it writes
      // a file rather than reporting that it is still holding everything.
      return trace.flush({ force: Boolean(args.force) });
    case "traceClear":
      await trace.clear();
      return { ok: true };

    default:
      return { error: `unknown daemon operation: ${op}` };
  }
}

/* What a trace entry carries beyond what the page sent.
 *
 * Only the worker can address every frame, so the shape of the page - which
 * frame holds the film, what each one drew, what is covering it - is gathered
 * here rather than by whichever frame happened to raise the event. Everything
 * else is passed through as the page reported it.
 */
async function traceDetail(args, sender) {
  const tab = sender?.tab;
  const detail = { ...(args.detail || {}) };
  if (tab?.id != null) detail.tab = { id: tab.id, url: tab.url, title: tab.title };
  if (!args.frames) return detail;

  const frames = await chrome.webNavigation.getAllFrames({ tabId: tab.id }).catch(() => []);
  detail.frames = await Promise.all(
    (frames || []).map(async (frame) => {
      const seen = await chrome.tabs
        .sendMessage(tab.id, { type: "sso:diagnose" }, { frameId: frame.frameId })
        .catch(() => null);
      return {
        frameId: frame.frameId,
        parentFrameId: frame.parentFrameId,
        url: frame.url,
        reachable: Boolean(seen),
        report: seen,
      };
    }),
  );
  return detail;
}

// --- commands ---------------------------------------------------------------

/* One copy of the auto-attach decision, shared with the diagnostic report.
 * Registered rather than imported, because the planner lives here - the
 * alternative is an import cycle between this file and diagnose.js. */
usePlanner(planAutoAttach);

chrome.commands.onCommand.addListener(runCommand);

async function runCommand(command) {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id) return;

  await ensureInjected(tab.id);

  const status = await tabStatus(tab.id);
  /* What the shortcut was asked for and what it found, before it acts. A
   * command that appears to do nothing is one of the two most common reports,
   * and the answer is nearly always in which frame the worker addressed. */
  trace.record("command", {
    command,
    tab: { id: tab.id, url: tab.url, title: tab.title },
    frameId: status?.frameId ?? null,
    chromeFrameId: status?.chromeFrameId ?? null,
    hasVideo: status?.hasVideo ?? false,
    attached: status?.attached ?? false,
    trackCount: status?.trackCount ?? 0,
  });
  const frameId = status?.frameId ?? TOP_FRAME;
  /* The panel opens where the controls are, which is not always where the
   * video is. Toasts deliberately stay in the video's frame: they only have to
   * be seen, and when a nested player goes fullscreen the top frame's document
   * is not being painted at all. */
  const panelFrame = status?.chromeFrameId ?? frameId;

  if (command === "toggle-panel") {
    const result = await send(tab.id, panelFrame, { type: "sso:togglePanel" });
    if (!result?.ok) {
      // Reaching here means the page refused injection, so there is nowhere to
      // draw a toast either. The badge is the only surface left.
      await flagBadge(tab.id, "!");
    }
  } else if (command === "toggle-overlay") {
    const result = await send(tab.id, frameId, { type: "sso:toggleVisible" });
    if (!result?.ok) await notify(tab.id, frameId, "Nothing attached yet");
  } else if (command === "auto-attach") {
    // One shortcut, three states. With nothing attached it finds subtitles;
    // after that it toggles them off and on. Re-running the search on every
    // press would be both slower and useless - the subtitle is already there,
    // and there was previously no way to turn it off without a second binding
    // that Chrome may never have registered.
    if (status?.attached) {
      const result = await send(tab.id, frameId, { type: "sso:toggleVisible" });
      if (result?.ok) {
        await notify(tab.id, frameId, result.visible ? "Subtitles on" : "Subtitles off");
      }
      return;
    }
    await autoAttach(tab, frameId, status);
  }
}

/* How long to wait for a film to turn up, and how often to look.
 *
 * A page with a play button has a programme long before it has a picture, and
 * a stream produced as it is sent is not a film to this extension until enough
 * of it has arrived to be worth subtitling. Measured on the catalogue app,
 * same file and same machine: playable 409ms after pressing play on one run,
 * still not playable after five seconds on the next. Twenty seconds covers
 * both with room, and costs nothing when the film is already there.
 *
 * Only while the page says a film is coming. `videoComing` is a <video> of a
 * player's size that is simply too short so far, so a page with nothing to
 * subtitle is still refused at once rather than after a silent wait. */
const VIDEO_WAIT_MS = 20000;
const VIDEO_POLL_MS = 250;

async function waitForVideo(tabId, first) {
  if (first?.hasVideo) return first;
  let last = first;
  const until = Date.now() + VIDEO_WAIT_MS;
  while (Date.now() < until) {
    await new Promise((resume) => setTimeout(resume, VIDEO_POLL_MS));
    const status = await tabStatus(tabId);
    if (status) last = status;
    if (status?.hasVideo) return status;
    // The player went away while this waited - a page navigated, a preview
    // stopped. Nothing is coming, so stop waiting for it.
    if (status && !status.videoComing) return status;
  }
  return last;
}

/* Work out what auto-attach should do, without doing any of it.
 *
 * Split out from autoAttach so the diagnostic report can state what the
 * shortcut would do rather than re-deriving it. A second copy of this reasoning
 * would drift from the first, and a diagnostic that disagrees with the code it
 * describes is worse than no diagnostic - it sends the reader after the wrong
 * bug with a document backing them up.
 *
 * Searching costs nothing. Downloading does, and none happens here.
 */
async function planAutoAttach(tab, frameId) {
  const languages = await preferredLanguages();
  /* Every frame contributes what it knows and the best of it is used. Prefer
   * what the page says it is over the tab title: Prime Video titles a detail
   * page "Prime Video: Crime 101"; og:title says "Crime 101". And prefer
   * whichever frame names the episode, which on an embedded player is often
   * the player's frame and nowhere else. */
  const context = await pageContextForTab(tab, frameId);
  const { title, year, season, episode, imdbId } = context;
  /* An id, where the page announced one, is what turns the search from two
   * calls into one: the daemon resolves a title through /features before it
   * can search exactly, and an id it was given needs no resolving. It also
   * ends the whole class of wrong-film failures - "Prime Video: Crime 101"
   * returning Ekusute - because there is no fuzzy step left to be wrong. */
  const found = await search({ title, year, season, episode, languages, imdb_id: imdbId });

  const plan = {
    languages,
    title,
    year,
    titleSource: context.titleSource,
    episodeSource: context.episodeSource,
    context,
    found,
  };

  if (found.error) return { ...plan, decision: "error", reason: found.error };

  const query = found.used?.query || title;
  const threshold = found.auto_attach_threshold ?? 0.75;
  /* Among the results that are this episode, when the search asked for one.
   *
   * pickBest ranks by language and then by score and does not look at the
   * episode at all, so on the one path where a resolved search comes back with
   * other instalments - the episode has no subtitles, so the daemon falls back
   * to the series as a whole - it could pick any of them. The second language
   * has filtered first all along; this is the same rule for the first. With
   * nothing left after the filter the old behaviour stands: rank everything,
   * and let the score below decide. */
  const forThis = forEpisode(found.results, found.used);
  const best = pickBest(forThis.length ? forThis : found.results, languages);
  Object.assign(plan, { query, threshold, best });

  if (!best) {
    return { ...plan, decision: "nothing-found", reason: `No subtitles found for "${query}"` };
  }

  /* A series whose episode nobody could name is not a confident match, whatever
   * the title scored.
   *
   * Measured on one: the title resolves perfectly, fifty results come back
   * spanning four seasons, and twenty-six of them share the winning score - so
   * the tiebreaks decide which episode gets downloaded, and those are language
   * and whether a file is already on disk. Neither knows what is on screen. The
   * result is a subtitle for the right series and the wrong episode, which is
   * indistinguishable from one that has drifted and sends the viewer looking at
   * the timing for an hour.
   *
   * So it refuses, exactly as it does for a film that matched badly, and for
   * the same reason: it will not spend a download on a guess. */
  const wantsEpisode = /tv|show|series|episode/i.test(found.resolved?.type || "");
  const askedEpisode = found.used?.season != null || found.used?.episode != null;
  if (wantsEpisode && !askedEpisode) {
    return {
      ...plan,
      decision: "unknown-episode",
      reason: `"${query}" is a series and nothing on the page says which episode — pick one in the panel`,
    };
  }

  /* Refuse to spend a download on something that does not look like what was
   * asked for. Searching "Prime Video: Crime 101" once returned "Ekusute" and
   * "Major Crimes", both of which were downloaded and displayed because
   * nothing checked. Open the panel instead and let a human decide.
   *
   * ...but not when the daemon already answered that question, and better.
   *
   * `match_score` compares the query against the uploader's own movie_name and
   * release string. That is the only guard there is on the fuzzy path, where
   * the search was `query=` and OpenSubtitles will confidently return an
   * unrelated film. It is not a guard at all once the title has RESOLVED: the
   * index matched the title at this very threshold, the search then went out by
   * the feature's own id with the season and episode on it, and every row that
   * came back is that programme by construction. What the score measures there
   * is how an uploader chose to name their file.
   *
   * Measured on The Americans, from the log on 2026-08-23. Season 3 episode 13
   * resolved to tt2149175 with no rivals, and all seven results were S03E13 -
   * every one of them refused at 0.70. Episode 12 the same day attached at 0.85,
   * and the whole of the difference is that one uploader had called their file
   * "The Americans S03E12" while the rest carried a release name: "The
   * Americans - S03E13  March 8, 1983" has three words after the series name,
   * "I Am Abassin Zadran" has four, and the coverage term divides by them. So
   * the gate was passing or failing on the length of the episode's title.
   *
   * The same argument was already written down one function over, for the
   * second language of a pair, and acted on there. This is it applied to the
   * first.
   *
   * What it gives up: a title that resolves to the WRONG programme is now
   * attached without a second opinion. The second opinion was worth nothing -
   * the release names of the wrong programme describe the wrong programme, and
   * score exactly as well as the right one's would. `ambiguous_title` is the
   * case where the daemon says it could not tell two titles apart, and there
   * the score still decides.
   *
   * `identified` carries all of that, and is set on every row by the provider
   * rather than worked out here: the panel asks the same question of the same
   * rows, in a process this module cannot be imported into. */
  if (!best.identified && (best.match_score ?? 0) < threshold) {
    return {
      ...plan,
      decision: "too-weak",
      reason: `Nothing matched "${query}" well — pick one in the panel`,
    };
  }

  /* The second language, if one is configured and the search turned up a good
   * enough match for it.
   *
   * Never the file already going into the first slot. pickBest ranks by
   * language before anything else, so `best` is normally in the first preferred
   * language and this looks at the rest - but when the search finds nothing at
   * all in that language, `best` falls through to the second one, and the old
   * code then picked the very same file again. The result was one subtitle in
   * both boxes, on top of itself, which reads as the pair being broken rather
   * than as one language being unavailable.
   *
   * So the second is chosen from the languages `best` did not take. A pair is
   * two languages; two files in one language is not a lesser version of that,
   * it is a different thing nobody asked for. */
  /* The second language, and why there is not one. The rule lives beside
   * pickBest in daemon.js, where it can be tested without a browser. */
  const { result: second, reason: secondReason } = pickSecondLanguage({
    results: found.results,
    languages,
    taken: best.language,
    used: found.used,
    resolved: Boolean(found.resolved?.imdb_id),
    threshold,
    query,
  });

  return { ...plan, second, secondReason, decision: "attach", reason: "" };
}

async function autoAttach(tab, frameId, status, { replacing = false } = {}) {
  /* No film, and the page itself says none is on its way.
   *
   * Refused here rather than after the search, and not inside the try below:
   * a search that fails for its own reasons would otherwise report ITS error
   * for a page that simply has nothing to subtitle, which is how this first
   * came back wrong - "Something went wrong" where "No video playing on this
   * page" is the whole answer. */
  if (status && !status.hasVideo && !status.videoComing) {
    await notify(tab.id, frameId, "No video playing on this page");
    return;
  }

  try {
    /* The search needs the page, not the picture.
     *
     * This used to read hasVideo once, up here, and give up for good if the
     * film had not started - which on a page with a play button is every time,
     * and a few hundred milliseconds after pressing play is most times. What
     * it cost was the whole feature: "it fails to find subtitles, and even
     * video for a while - I need to try multiple times".
     *
     * Nothing about finding a subtitle needs a video. The title, the season
     * and the episode are on the page before anything plays, so the search
     * starts now and the wait for a film is spent on it rather than in front
     * of it. By the time a download is back there is nearly always somewhere
     * to put it. */
    const film = waitForVideo(tab.id, status);
    await notify(tab.id, frameId, "Looking for subtitles…");

    const plan = await planAutoAttach(tab, frameId);
    // The whole decision, including the results it ranked, so "it picked the
    // wrong subtitle" can be answered without running the search again.
    trace.record("autoAttach", { frameId, plan });

    /* Before any of the plan is acted on, including the branches that open the
     * panel: a page with no film is not a page to ask somebody to choose a
     * subtitle for. The frame is re-read from the answer, because the film may
     * have appeared in one that had nothing in it when this started. */
    const ready = await film;
    if (!ready?.hasVideo) {
      await notify(tab.id, ready?.frameId ?? frameId, "No video playing on this page");
      return;
    }
    frameId = ready.frameId ?? frameId;
    status = ready;

    if (plan.decision === "error" || plan.decision === "nothing-found") {
      await notify(tab.id, frameId, plan.reason);
      return;
    }

    // Both of these mean "a human has to choose", so both open the panel -
    // in the frame that draws it, which on a nested player is not this one.
    if (plan.decision === "too-weak" || plan.decision === "unknown-episode") {
      await send(tab.id, status?.chromeFrameId ?? frameId, { type: "sso:togglePanel" });
      await notify(tab.id, frameId, plan.reason);
      return;
    }

    const { best, second, found, secondReason } = plan;

    /* The moment the last programme's subtitles stop being the best thing on
     * screen: there is a result, and there is a film to put it on. Every way
     * of finding nothing has already returned above without touching them.
     *
     * Both slots, not only the ones about to be filled - a pair replaced by a
     * single language would otherwise leave the other slot holding the last
     * episode. The content script stashes what it takes off for half a minute,
     * so the panel still offers it back. */
    if (replacing) await send(tab.id, frameId, { type: "sso:detach" });

    /* The second is tried whatever the first did.
     *
     * `return` here meant one failed download cost both subtitles, and the
     * second one is a different file - often a different language, sometimes
     * already in the cache - so there was no reason for it to share the first
     * one's luck. Reported as "sometimes it fails to put both of them
     * correctly". Each says for itself what went wrong; attachOne marks the
     * second so two failures do not read as one repeated. */
    await attachOne(tab, frameId, best, found, 0);

    /* The second language, chosen by planAutoAttach above.
     *
     * This is where dual subtitles stop being a thing you assemble by hand: the
     * languages are already in preferences, best-first, and the search already
     * asked for all of them.
     *
     * Silence was the wrong answer when it does not arrive. Reported: "either
     * TR or both TR+EN are not loaded, I need to add manually each time" - and
     * with nothing said, a pair that came back as one subtitle is
     * indistinguishable from the feature being broken. It says which language
     * it could not fill and why, so the next move is obvious. */
    if (second) {
      await attachOne(tab, frameId, second, found, 1);
    } else if (secondReason) {
      await notify(tab.id, frameId, `Only ${best.language?.toUpperCase() || "one"}: ${secondReason}`);
    }
  } catch (error) {
    await notify(tab.id, frameId, describe(error));
  }
}

/** Download one result and put it on the named track. False if it did not land. */
async function attachOne(tab, frameId, result, found, slot) {
  const subtitle = await fetchSubtitle(result.file_id, subtitleContext(result, found.resolved));
  if (subtitle.error) {
    /* A failure on the second subtitle is a note, not an error: the first one
     * is already on screen and the film is watchable. Saying "download failed"
     * with subtitles running would read as though nothing had worked. */
    const prefix = slot > 0 ? "Second subtitle: " : "";
    await notify(
      tab.id,
      frameId,
      subtitle.quota_exceeded
        ? `${prefix}daily download limit reached - pick something already cached`
        : `${prefix}${subtitle.error}`,
    );
    return false;
  }

  await attachToTab(tab.id, {
    cues: subtitle.cues,
    label: `${result.language.toUpperCase()} · ${result.release || result.movie_name}`,
    fileId: result.file_id,
    language: result.language,
    slot,
  });
  return true;
}

// --- helpers ----------------------------------------------------------------

function describe(error) {
  if (error instanceof DaemonDownError) return error.message;
  return error?.message || "Something went wrong";
}

async function tabToDiagnose(tabId, sender) {
  if (tabId != null) {
    return chrome.tabs.get(Number(tabId)).catch(() => null);
  }
  if (sender?.tab?.id != null) return sender.tab;
  const [active] = await chrome.tabs.query({ active: true, currentWindow: true });
  return active || null;
}

/* Self-heal a tab whose content script predates the current version, or has
 * none because the tab was open before the extension was installed. Cheap: one
 * message round trip when everything is already in place. */
async function ensureInjected(tabId) {
  try {
    const alive = await chrome.tabs.sendMessage(tabId, { type: "sso:ping" });
    if (alive?.version === chrome.runtime.getManifest().version) return true;
  } catch {
    // No content script at all, or it is old enough to not know about ping.
  }
  return inject(tabId);
}

async function send(tabId, frameId, message) {
  try {
    return await chrome.tabs.sendMessage(tabId, message, { frameId });
  } catch {
    return null;
  }
}

/* Status goes through the content script's toast rather than chrome.notifications
 * so it lands on top of the video, including in fullscreen, where a system
 * notification would not be seen. */
async function notify(tabId, frameId, message) {
  await send(tabId, frameId, { type: "sso:toast", message });
}

/* Last-resort feedback for pages the extension cannot draw on at all, so a
 * keypress is never answered with complete silence. */
async function flagBadge(tabId, text) {
  try {
    await chrome.action.setBadgeText({ tabId, text });
    await chrome.action.setBadgeBackgroundColor({ tabId, color: "#c2503f" });
    setTimeout(() => chrome.action.setBadgeText({ tabId, text: "" }).catch(() => {}), 4000);
  } catch {
    // Tab closed.
  }
}
