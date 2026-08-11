/* Popup: status and a launcher.
 *
 * Searching, timing and appearance all live in the in-page control panel
 * instead of here, for one reason: a toolbar popup cannot be opened while the
 * page is fullscreen, which is exactly when those controls are wanted. Keeping
 * a second search UI here would also mean maintaining two of everything.
 */

import { DaemonDownError, health, tabStatus } from "./daemon.js";

const ui = {
  daemonState: document.getElementById("daemon-state"),
  blocker: document.getElementById("blocker"),
  blockerMessage: document.getElementById("blocker-message"),
  blockerHint: document.getElementById("blocker-hint"),
  main: document.getElementById("main"),
  pageState: document.getElementById("page-state"),
  attached: document.getElementById("attached"),
  find: document.getElementById("find"),
  panel: document.getElementById("panel"),
  toggle: document.getElementById("toggle"),
  diagnose: document.getElementById("diagnose"),
  diagnoseNote: document.getElementById("diagnose-note"),
  shortcuts: document.getElementById("shortcuts"),
  editShortcuts: document.getElementById("edit-shortcuts"),
};

const session = { tab: null, frameId: 0 };

/* Run a click handler that awaits something, and say so when it fails.
 *
 * chrome.runtime.sendMessage rejects on a channel failure - the extension
 * reloaded under this popup, a worker that threw while starting - and an async
 * click handler drops that rejection on the floor. The popup then closes, or
 * does not, with nothing said. */
const onClick = (node, work) =>
  node.addEventListener("click", () => {
    Promise.resolve()
      .then(work)
      .catch((error) => {
        ui.diagnoseNote.hidden = false;
        ui.diagnoseNote.textContent = String(error?.message || error);
      });
  });

init().catch((error) => block(error?.message || "Something went wrong.", ""));

async function init() {
  [session.tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!session.tab?.id) return block("No active tab.", "");

  await renderShortcuts();

  let config;
  try {
    config = await health();
  } catch (error) {
    if (error instanceof DaemonDownError) {
      return block(
        "The subtitle daemon is not running.",
        "cd subtitle-study-tool/subtitle-daemon\n./run.sh",
      );
    }
    throw error;
  }

  setPill(
    config.authenticated ? "signed in" : config.has_api_key ? "anonymous" : "no API key",
    config.has_api_key ? "pill--ok" : "pill--bad",
  );

  if (!config.has_api_key) {
    return block(
      "No OpenSubtitles API key configured. Create one (free) at " +
        "opensubtitles.com/en/consumers, put it in config.local.json and restart the daemon.",
      "cd subtitle-study-tool/subtitle-daemon\ncp config.example.json config.local.json",
    );
  }

  await refresh();
}

async function refresh() {
  const status = await tabStatus(session.tab.id);
  session.frameId = status?.frameId ?? 0;

  if (!status) {
    ui.pageState.textContent =
      "The extension is not running on this page. Reload the tab and try again.";
    ui.find.disabled = true;
    ui.panel.disabled = true;
    return;
  }

  ui.pageState.textContent = status.hasVideo
    ? "Video detected on this page."
    : "No video detected yet. Start playback, then try again.";

  if (status.attached) {
    ui.attached.hidden = false;
    ui.attached.textContent = `${status.label || "Attached"} · ${status.cueCount} lines`;
    ui.toggle.hidden = false;
    ui.toggle.textContent = status.visible ? "Hide subtitles" : "Show subtitles";
  }
}

// --- actions ----------------------------------------------------------------

onClick(ui.find, async () => {
  // Same path as the keyboard shortcut, including the match-quality gate that
  // opens the panel instead of attaching something unrelated.
  await chrome.runtime.sendMessage({ type: "sso:command", command: "auto-attach" });
  window.close();
});

onClick(ui.panel, async () => {
  // Via the worker, so it re-injects into a tab still running an older content
  // script rather than failing silently.
  await chrome.runtime.sendMessage({ type: "sso:command", command: "toggle-panel" });
  window.close();
});

onClick(ui.toggle, async () => {
  const result = await send({ type: "sso:toggleVisible" });
  if (result?.ok) ui.toggle.textContent = result.visible ? "Hide subtitles" : "Show subtitles";
});

/* Capture before opening the report, and stay open while it runs: the popup
 * closing would take the capture with it. The worker opens the report tab, and
 * that is what closes the popup. */
onClick(ui.diagnose, async () => {
  ui.diagnose.disabled = true;
  ui.diagnoseNote.hidden = false;
  ui.diagnoseNote.textContent = "Asking every frame…";
  try {
    const report = await chrome.runtime.sendMessage({
      type: "sso:daemon",
      op: "diagnose",
      args: { tabId: session.tab.id },
    });
    if (!report || report.error) {
      ui.diagnoseNote.textContent = report?.error || "Could not reach the service worker.";
      ui.diagnose.disabled = false;
      return;
    }
    ui.diagnoseNote.textContent = `Captured ${report.frames?.length ?? 0} frame(s). Opening…`;
    // Same as the control panel's copy: the worker owns opening an extension
    // page. Opening the report tab is what closes the popup.
    await chrome.runtime.sendMessage({ type: "sso:openReport" });
  } catch (error) {
    ui.diagnoseNote.textContent = String(error?.message || error);
    ui.diagnose.disabled = false;
  }
});

ui.editShortcuts.addEventListener("click", () => {
  chrome.tabs.create({ url: "chrome://extensions/shortcuts" });
});

async function send(message) {
  try {
    return await chrome.tabs.sendMessage(session.tab.id, message, { frameId: session.frameId });
  } catch {
    return null;
  }
}

// --- chrome ------------------------------------------------------------------

async function renderShortcuts() {
  const commands = await chrome.commands.getAll();
  const labels = {
    "auto-attach": "Find subtitles",
    "toggle-panel": "Control panel",
    "toggle-overlay": "Hide / show",
  };

  ui.shortcuts.replaceChildren(
    ...commands
      .filter((command) => labels[command.name])
      .map((command) => {
        const row = document.createElement("div");
        row.className = "shortcut";
        const name = document.createElement("span");
        name.textContent = labels[command.name];
        const keys = document.createElement("kbd");
        keys.textContent = command.shortcut || "unset";
        if (!command.shortcut) keys.className = "kbd--unset";
        row.append(name, keys);
        return row;
      }),
  );
}

function setPill(text, className) {
  ui.daemonState.textContent = text;
  ui.daemonState.className = `pill ${className}`;
}

function block(message, hint) {
  ui.main.hidden = true;
  ui.blocker.hidden = false;
  ui.blockerMessage.textContent = message;
  ui.blockerHint.textContent = hint;
  ui.blockerHint.hidden = !hint;
  if (ui.daemonState.textContent === "checking…") setPill("offline", "pill--bad");
}
