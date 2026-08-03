/* Settings page.
 *
 * Runs in an extension page, so it could import provider.js directly - but the
 * service worker holds the probe state and the LocalService instance, and two
 * copies of those would disagree about whether the daemon is up. So it asks the
 * worker, the same way the panel does.
 */

const call = (op, args = {}) =>
  chrome.runtime.sendMessage({ type: "sso:daemon", op, args });

const el = (id) => document.getElementById(id);

async function refresh() {
  const status = await call("health");

  if (status?.transportError) {
    el("statusLine").textContent = "Could not reach the extension's service worker";
    el("statusLine").dataset.kind = "stuck";
    return;
  }

  if (status.served_by === "daemon") {
    el("statusLine").textContent = "The daemon is running and answering";
    el("statusLine").dataset.kind = "daemon";
    el("statusNote").textContent = status.has_api_key
      ? "Subtitles come from the daemon, which holds its own key and cache."
      : "The daemon is running but has no API key configured.";
  } else if (status.has_api_key) {
    el("statusLine").textContent = "The extension is answering on its own";
    el("statusLine").dataset.kind = "extension";
    el("statusNote").textContent =
      "The daemon is not running. Start it only when you need local transcription.";
  } else {
    el("statusLine").textContent = "No subtitles can be fetched yet";
    el("statusLine").dataset.kind = "stuck";
    el("statusNote").textContent =
      "The daemon is not running and no API key is set here. Add one below, or start the daemon.";
  }

  const held = status.cached_subtitles;
  el("cacheLine").textContent =
    held === undefined
      ? "Held by the daemon on disk."
      : `${held} subtitle${held === 1 ? "" : "s"} held in the browser.`;
}

async function load() {
  const stored = await chrome.storage.local.get("sso:provider");
  const config = stored["sso:provider"] || {};
  el("apiKey").value = config.apiKey || "";
  el("languages").value = (config.languages || ["en", "tr"]).join(", ");
  await refresh();
}

el("save").addEventListener("click", async () => {
  const languages = el("languages")
    .value.split(",")
    .map((part) => part.trim().toLowerCase())
    .filter(Boolean);
  await call("settings", {
    patch: {
      apiKey: el("apiKey").value.trim(),
      languages: languages.length ? languages : ["en", "tr"],
    },
  });
  el("saved").textContent = "Saved";
  setTimeout(() => (el("saved").textContent = ""), 2000);
  await refresh();
});

el("reveal").addEventListener("change", (event) => {
  el("apiKey").type = event.target.checked ? "text" : "password";
});

el("refresh").addEventListener("click", refresh);

el("sync").addEventListener("click", async () => {
  el("syncResult").textContent = "Syncing…";
  const result = await call("sync");
  if (result?.transportError) {
    el("syncResult").textContent = result.transportError;
    return;
  }
  const parts = [];
  if (result.pushed) parts.push(`${result.pushed} sent to the daemon`);
  if (result.pulled) parts.push(`${result.pulled} copied here`);
  if (result.failed) parts.push(`${result.failed} failed`);
  el("syncResult").textContent = parts.length ? parts.join(", ") : "Already in step";
  await refresh();
});

load();
