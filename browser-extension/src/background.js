/* Service worker: the keyboard-shortcut path.
 *
 * The popup exists for when you want to choose. This is for when you don't:
 * one shortcut goes from "film playing, no subtitles" to "subtitles on screen"
 * with nothing in between.
 */

import { attachToTab, fetchSubtitle, health, pickBest, search, tabStatus } from "./daemon.js";

const DEFAULT_LANGUAGES = ["en", "tr"];
const TOP_FRAME = 0;

chrome.commands.onCommand.addListener(async (command) => {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id) return;

  if (command === "toggle-overlay") {
    await toggleOverlay(tab.id);
  } else if (command === "auto-attach") {
    await autoAttach(tab);
  }
});

async function toggleOverlay(tabId) {
  const status = await tabStatus(tabId);
  const frameId = status?.frameId ?? TOP_FRAME;
  try {
    const result = await chrome.tabs.sendMessage(tabId, { type: "sso:toggleVisible" }, { frameId });
    if (!result?.ok) await notify(tabId, frameId, "Nothing attached yet");
  } catch {
    await notify(tabId, TOP_FRAME, "Nothing attached yet");
  }
}

async function autoAttach(tab) {
  // Resolve the frame holding the player once, so every message below - status
  // toasts included - lands where the video is. In fullscreen that is the only
  // frame being rendered, so a toast anywhere else would be invisible.
  const status = await tabStatus(tab.id);
  const frameId = status?.frameId ?? TOP_FRAME;

  if (status && !status.hasVideo) {
    await notify(tab.id, frameId, "No video playing on this page");
    return;
  }

  try {
    await notify(tab.id, frameId, "Looking for subtitles…");

    const config = await health();
    const languages = config.default_languages?.length
      ? config.default_languages
      : DEFAULT_LANGUAGES;

    const found = await search({ title: tab.title, languages });
    if (found.error) {
      await notify(tab.id, frameId, found.error);
      return;
    }

    const best = pickBest(found.results, languages);
    if (!best) {
      await notify(tab.id, frameId, `No subtitles found for "${found.used?.query || tab.title}"`);
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
    await notify(tab.id, frameId, error.message || "Something went wrong");
  }
}

/* Status goes through the content script's toast rather than chrome.notifications
 * so it lands on top of the video, including in fullscreen, where a system
 * notification would not be seen. */
async function notify(tabId, frameId, message) {
  try {
    await chrome.tabs.sendMessage(tabId, { type: "sso:toast", message }, { frameId });
  } catch {
    // No content script in that frame; nothing to show it on.
  }
}
