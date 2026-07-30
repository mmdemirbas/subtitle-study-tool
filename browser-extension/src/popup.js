/* Popup: search, pick, attach.
 *
 * Opening the popup runs a search immediately, because searching is free and
 * the answer is nearly always "the first result". Downloading is what costs
 * quota, so that stays behind a deliberate click.
 */

import {
  DaemonDownError,
  attachToTab,
  fetchSubtitle,
  health,
  offsetKey,
  search,
  tabStatus,
} from "./daemon.js";

const ui = {
  daemonState: document.getElementById("daemon-state"),
  blocker: document.getElementById("blocker"),
  blockerMessage: document.getElementById("blocker-message"),
  blockerHint: document.getElementById("blocker-hint"),
  main: document.getElementById("main"),
  query: document.getElementById("query"),
  searchAgain: document.getElementById("search-again"),
  guessNote: document.getElementById("guess-note"),
  attached: document.getElementById("attached"),
  offsetControls: document.getElementById("offset-controls"),
  offsetValue: document.getElementById("offset-value"),
  toggle: document.getElementById("toggle"),
  resultsState: document.getElementById("results-state"),
  results: document.getElementById("results"),
};

const session = {
  tab: null,
  frameId: 0,
  languages: ["en", "tr"],
  attachedFileId: null,
  visible: true,
};

// --- startup ----------------------------------------------------------------

init().catch(showUnexpected);

async function init() {
  [session.tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!session.tab?.id) {
    return block("No active tab.", "");
  }

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

  if (config.default_languages?.length) session.languages = config.default_languages;

  setPill(
    config.authenticated ? "signed in" : config.has_api_key ? "anonymous" : "no API key",
    config.has_api_key ? "pill--ok" : "pill--bad",
  );

  if (!config.has_api_key) {
    return block(
      "No OpenSubtitles API key configured. Create one (free) at opensubtitles.com/en/consumers, " +
        "then put it in config.local.json and restart the daemon.",
      "cd subtitle-study-tool/subtitle-daemon\ncp config.example.json config.local.json",
    );
  }

  await refreshAttachedState();

  ui.query.value = session.tab.title || "";
  await runSearch({ useTitle: true });
}

// --- attached state ---------------------------------------------------------

async function refreshAttachedState() {
  const status = await tabStatus(session.tab.id);
  session.frameId = status?.frameId ?? 0;

  if (!status?.hasVideo) {
    ui.resultsState.textContent =
      "No video detected on this page. Start playback, then reopen this popup.";
  }

  if (status?.attached) {
    session.visible = status.visible;
    ui.attached.hidden = false;
    ui.attached.textContent = `Attached: ${status.label || `${status.cueCount} lines`}`;
    ui.offsetControls.hidden = false;
    ui.offsetValue.textContent = formatOffset(status.offsetMs);
    ui.toggle.textContent = status.visible ? "Hide" : "Show";
  }
}

function formatOffset(ms) {
  const seconds = (ms / 1000).toFixed(2).replace(/\.?0+$/, "");
  return `${ms > 0 ? "+" : ""}${seconds || "0"}s`;
}

// --- search -----------------------------------------------------------------

async function runSearch({ useTitle }) {
  ui.results.replaceChildren();
  ui.resultsState.hidden = false;
  ui.resultsState.textContent = "Searching…";

  let found;
  try {
    found = useTitle
      ? await search({ title: session.tab.title, languages: session.languages })
      : await search({ query: ui.query.value.trim(), languages: session.languages });
  } catch (error) {
    ui.resultsState.textContent = error.message;
    return;
  }

  if (useTitle && found.used?.query) {
    // Show what the guesser made of the tab title, and let it be corrected.
    ui.query.value = found.used.query;
    const extras = [];
    if (found.used.year) extras.push(String(found.used.year));
    if (found.used.season != null) {
      extras.push(`S${found.used.season}E${found.used.episode}`);
    }
    ui.guessNote.textContent = extras.length
      ? `Guessed from the tab title · ${extras.join(" · ")}`
      : "Guessed from the tab title";
  }

  if (found.error) {
    ui.resultsState.textContent = found.error;
    return;
  }

  const results = found.results || [];
  if (results.length === 0) {
    ui.resultsState.textContent = "Nothing found. Try editing the title above.";
    return;
  }

  ui.resultsState.hidden = true;
  renderResults(results);
}

function renderResults(results) {
  const items = results.slice(0, 25).map((result) => {
    const button = document.createElement("button");
    button.className = "result";
    button.type = "button";

    const top = document.createElement("div");
    top.className = "result__top";

    const language = document.createElement("span");
    language.className = "result__lang";
    language.textContent = (result.language || "??").toUpperCase();

    const name = document.createElement("span");
    name.className = "result__name";
    name.textContent = result.movie_name || result.release || "Untitled";

    top.append(language, name);

    if (result.cached) top.append(tag("cached", "tag--free"));
    else if (result.from_trusted) top.append(tag("trusted"));
    if (result.hearing_impaired) top.append(tag("HI"));

    const release = document.createElement("span");
    release.className = "result__release";
    const bits = [result.release, result.year, `${result.download_count} downloads`]
      .filter(Boolean)
      .join(" · ");
    release.textContent = bits;

    button.append(top, release);
    button.addEventListener("click", () => attach(result, button));

    const item = document.createElement("li");
    item.append(button);
    return item;
  });

  ui.results.replaceChildren(...items);
}

function tag(text, extraClass) {
  const span = document.createElement("span");
  span.className = extraClass ? `tag ${extraClass}` : "tag";
  span.textContent = text;
  return span;
}

// --- attach -----------------------------------------------------------------

async function attach(result, button) {
  const originalText = button.textContent;
  setBusy(true);
  ui.resultsState.hidden = false;
  ui.resultsState.textContent = result.cached ? "Loading…" : "Downloading…";

  try {
    const subtitle = await fetchSubtitle(result.file_id);
    if (subtitle.error) {
      ui.resultsState.textContent = subtitle.quota_exceeded
        ? "Daily download limit reached. Cached subtitles are still free to use."
        : subtitle.error;
      return;
    }

    const label = `${(result.language || "").toUpperCase()} · ${
      result.release || result.movie_name
    }`;
    await attachToTab(session.tab.id, {
      cues: subtitle.cues,
      label,
      fileId: result.file_id,
    });

    session.attachedFileId = result.file_id;
    session.visible = true;

    const stored = await chrome.storage.local.get(offsetKey(result.file_id));
    ui.attached.hidden = false;
    ui.attached.textContent = `Attached: ${label} (${subtitle.cues.length} lines)`;
    ui.offsetControls.hidden = false;
    ui.offsetValue.textContent = formatOffset(Number(stored[offsetKey(result.file_id)]) || 0);
    ui.toggle.textContent = "Hide";
    ui.resultsState.hidden = true;
  } catch (error) {
    ui.resultsState.textContent = error.message;
  } finally {
    button.textContent = originalText;
    setBusy(false);
  }
}

function setBusy(busy) {
  for (const button of document.querySelectorAll("button")) button.disabled = busy;
}

// --- controls ---------------------------------------------------------------

ui.searchAgain.addEventListener("click", () => {
  ui.guessNote.textContent = "";
  runSearch({ useTitle: false }).catch(showUnexpected);
});

ui.query.addEventListener("keydown", (event) => {
  if (event.key === "Enter") {
    ui.guessNote.textContent = "";
    runSearch({ useTitle: false }).catch(showUnexpected);
  }
});

for (const button of document.querySelectorAll("[data-nudge]")) {
  button.addEventListener("click", async () => {
    const response = await sendToVideoFrame({
      type: "sso:nudge",
      deltaMs: Number(button.dataset.nudge),
    });
    if (response?.ok) ui.offsetValue.textContent = formatOffset(response.offsetMs);
  });
}

ui.toggle.addEventListener("click", async () => {
  const response = await sendToVideoFrame({ type: "sso:toggleVisible" });
  if (response?.ok) {
    session.visible = response.visible;
    ui.toggle.textContent = response.visible ? "Hide" : "Show";
  }
});

async function sendToVideoFrame(message) {
  try {
    return await chrome.tabs.sendMessage(session.tab.id, message, { frameId: session.frameId });
  } catch {
    return null;
  }
}

// --- failure surfaces -------------------------------------------------------

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

function showUnexpected(error) {
  block(error?.message || "Something went wrong.", "");
}
