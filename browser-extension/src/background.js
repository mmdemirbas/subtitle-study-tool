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
  fetchSubtitle,
  health,
  pickBest,
  search,
  tabStatus,
} from "./daemon.js";

const DEFAULT_LANGUAGES = ["en", "tr"];
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

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type === "sso:daemon") {
    handleDaemonCall(message.op, message.args || {})
      .then(sendResponse)
      // Transport failures are reported as data rather than thrown, so the
      // caller gets a message instead of an unresolved promise.
      .catch((error) => sendResponse({ transportError: describe(error) }));
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

async function handleDaemonCall(op, args) {
  switch (op) {
    case "health":
      return health();
    case "search": {
      const languages = args.languages?.length ? args.languages : await preferredLanguages();
      return search({ ...args, languages });
    }
    case "fetch":
      return fetchSubtitle(args.fileId);
    default:
      return { error: `unknown daemon operation: ${op}` };
  }
}

async function preferredLanguages() {
  try {
    const config = await health();
    return config.default_languages?.length ? config.default_languages : DEFAULT_LANGUAGES;
  } catch {
    return DEFAULT_LANGUAGES;
  }
}

// --- commands ---------------------------------------------------------------

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
    await autoAttach(tab, frameId, status);
  }
}

async function autoAttach(tab, frameId, status) {
  if (status && !status.hasVideo) {
    await notify(tab.id, frameId, "No video playing on this page");
    return;
  }

  try {
    await notify(tab.id, frameId, "Looking for subtitles…");

    const languages = await preferredLanguages();
    // Prefer what the page says it is over the tab title. Prime Video titles a
    // detail page "Prime Video: Crime 101"; og:title says "Crime 101".
    const title = await bestTitleForTab(tab, frameId);
    const found = await search({ title, languages });

    if (found.error) {
      await notify(tab.id, frameId, found.error);
      return;
    }

    const query = found.used?.query || title;
    const threshold = found.auto_attach_threshold ?? 0.75;
    const best = pickBest(found.results, languages);

    if (!best) {
      await notify(tab.id, frameId, `No subtitles found for "${query}"`);
      return;
    }

    /* Refuse to spend a download on something that does not look like what was
     * asked for. Searching "Prime Video: Crime 101" once returned "Ekusute" and
     * "Major Crimes", both of which were downloaded and displayed because
     * nothing checked. Open the panel instead and let a human decide. */
    if ((best.match_score ?? 0) < threshold) {
      await send(tab.id, frameId, { type: "sso:togglePanel" });
      await notify(
        tab.id,
        frameId,
        `Nothing matched "${query}" well — pick one in the panel`,
      );
      return;
    }

    const subtitle = await fetchSubtitle(best.file_id);
    if (subtitle.error) {
      await notify(
        tab.id,
        frameId,
        subtitle.quota_exceeded
          ? "Daily download limit reached - pick something already cached"
          : subtitle.error,
      );
      return;
    }

    await attachToTab(tab.id, {
      cues: subtitle.cues,
      label: `${best.language.toUpperCase()} · ${best.release || best.movie_name}`,
      fileId: best.file_id,
    });
  } catch (error) {
    await notify(tab.id, frameId, describe(error));
  }
}

// --- helpers ----------------------------------------------------------------

function describe(error) {
  if (error instanceof DaemonDownError) return error.message;
  return error?.message || "Something went wrong";
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
