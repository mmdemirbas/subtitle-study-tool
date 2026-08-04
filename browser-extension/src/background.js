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
  bestTitleForTab,
  pickBest,
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
chrome.runtime.onInstalled.addListener(async () => {
  const injectable = await chrome.tabs.query({ url: ["http://*/*", "https://*/*"] });
  const scripts = chrome.runtime.getManifest().content_scripts?.[0];
  if (!scripts) return;

  await Promise.all(
    injectable.map(async (tab) => {
      if (!tab.id) return;
      try {
        await chrome.scripting.insertCSS({
          target: { tabId: tab.id, allFrames: true },
          files: scripts.css,
        });
        await chrome.scripting.executeScript({
          target: { tabId: tab.id, allFrames: true },
          files: scripts.js,
        });
      } catch {
        // Restricted pages (chrome://, the web store) refuse injection.
      }
    }),
  );
});

// --- daemon proxy for panel.js and popup.js ---------------------------------

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
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
      return lookup({ query: args.query, language: args.language });
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

    default:
      return { error: `unknown daemon operation: ${op}` };
  }
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
  const frameId = status?.frameId ?? TOP_FRAME;

  if (command === "toggle-panel") {
    const result = await send(tab.id, frameId, { type: "sso:togglePanel" });
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
  // Prefer what the page says it is over the tab title. Prime Video titles a
  // detail page "Prime Video: Crime 101"; og:title says "Crime 101".
  const { title, year, source } = await bestTitleForTab(tab, frameId);
  const found = await search({ title, year, languages });

  const plan = { languages, title, year, titleSource: source, found };

  if (found.error) return { ...plan, decision: "error", reason: found.error };

  const query = found.used?.query || title;
  const threshold = found.auto_attach_threshold ?? 0.75;
  const best = pickBest(found.results, languages);
  Object.assign(plan, { query, threshold, best });

  if (!best) {
    return { ...plan, decision: "nothing-found", reason: `No subtitles found for "${query}"` };
  }

  /* Refuse to spend a download on something that does not look like what was
   * asked for. Searching "Prime Video: Crime 101" once returned "Ekusute" and
   * "Major Crimes", both of which were downloaded and displayed because
   * nothing checked. Open the panel instead and let a human decide. */
  if ((best.match_score ?? 0) < threshold) {
    return {
      ...plan,
      decision: "too-weak",
      reason: `Nothing matched "${query}" well — pick one in the panel`,
    };
  }

  /* The second language, if one is configured and the search turned up a good
   * enough match for it. */
  const second = languages
    .slice(1)
    .map((language) => pickBest(found.results.filter((r) => r.language === language), [language]))
    .find((result) => result && (result.match_score ?? 0) >= threshold);

  return { ...plan, second, decision: "attach", reason: "" };
}

async function autoAttach(tab, frameId, status) {
  if (status && !status.hasVideo) {
    await notify(tab.id, frameId, "No video playing on this page");
    return;
  }

  try {
    await notify(tab.id, frameId, "Looking for subtitles…");

    const plan = await planAutoAttach(tab, frameId);

    if (plan.decision === "error" || plan.decision === "nothing-found") {
      await notify(tab.id, frameId, plan.reason);
      return;
    }

    if (plan.decision === "too-weak") {
      await send(tab.id, frameId, { type: "sso:togglePanel" });
      await notify(tab.id, frameId, plan.reason);
      return;
    }

    const { best, second, found } = plan;

    if (!(await attachOne(tab, frameId, best, found, 0))) return;

    /* The second language, chosen by planAutoAttach above.
     *
     * This is where dual subtitles stop being a thing you assemble by hand: the
     * languages are already in preferences, best-first, and the search already
     * asked for all of them. Silence is the right answer when there is no
     * second language configured or nothing in it matched - the first subtitle
     * is on screen either way, which is what the shortcut promised. */
    if (second) await attachOne(tab, frameId, second, found, 1);
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

  const scripts = chrome.runtime.getManifest().content_scripts?.[0];
  if (!scripts) return false;

  try {
    await chrome.scripting.insertCSS({
      target: { tabId, allFrames: true },
      files: scripts.css,
    });
    await chrome.scripting.executeScript({
      target: { tabId, allFrames: true },
      files: scripts.js,
    });
    return true;
  } catch {
    return false; // restricted page
  }
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
