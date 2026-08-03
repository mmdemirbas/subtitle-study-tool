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

  await renderCache();
}

// --- the cache table --------------------------------------------------------

const BYTE_UNITS = ["B", "kB", "MB"];

function humanSize(bytes) {
  let value = Number(bytes) || 0;
  let unit = 0;
  while (value >= 1024 && unit < BYTE_UNITS.length - 1) {
    value /= 1024;
    unit++;
  }
  return `${value < 10 && unit > 0 ? value.toFixed(1) : Math.round(value)} ${BYTE_UNITS[unit]}`;
}

/* Absolute dates rather than "3 days ago": the question this column answers is
 * usually "is this the copy I fetched before or after I fixed the title", and a
 * relative label makes that harder, not easier. The time is kept because
 * several downloads in one evening is the common case; the year is dropped for
 * the current one, which is most of them, so the column stays narrow enough for
 * the Delete button to fit beside it. */
function whenDownloaded(secondsSinceEpoch) {
  if (!secondsSinceEpoch) return "—";
  const at = new Date(Number(secondsSinceEpoch) * 1000);
  const sameYear = at.getFullYear() === new Date().getFullYear();
  const date = at.toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
    ...(sameYear ? {} : { year: "numeric" }),
  });
  const time = at.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
  return `${date}, ${time}`;
}

function describe(entry) {
  const name = entry.movie_name || entry.release || entry.file_name || `file ${entry.file_id}`;
  const detail = entry.release && entry.release !== name ? entry.release : "";
  return { name, detail };
}

async function renderCache() {
  const { entries, daemon_running: daemonRunning, pending_deletions: pending } =
    await call("cacheList");

  const rows = el("cacheRows");
  rows.replaceChildren();

  const total = entries.reduce((sum, entry) => sum + (Number(entry.bytes) || 0), 0);
  el("cacheLine").textContent = entries.length
    ? `${entries.length} subtitle${entries.length === 1 ? "" : "s"}, ${humanSize(total)}` +
      (daemonRunning ? "" : " — the daemon is stopped, so only this side is listed")
    : "Nothing downloaded yet";
  el("cacheEmpty").hidden = entries.length > 0;
  el("cacheTable").hidden = entries.length === 0;

  el("cachePending").hidden = !pending;
  if (pending) {
    el("cachePending").textContent =
      `${pending} deletion${pending === 1 ? "" : "s"} waiting for the daemon. ` +
      `${pending === 1 ? "It is" : "They are"} applied automatically the next time it runs.`;
  }

  for (const entry of entries) {
    const { name, detail } = describe(entry);
    const row = document.createElement("tr");

    const film = document.createElement("td");
    film.className = "film";
    film.title = `${name}${detail ? `\n${detail}` : ""}`;
    film.append(document.createTextNode(name));
    if (detail) {
      const sub = document.createElement("span");
      sub.textContent = detail;
      film.append(sub);
    }

    const language = document.createElement("td");
    language.textContent = (entry.language || "—").toUpperCase();

    const when = document.createElement("td");
    when.textContent = whenDownloaded(entry.cached_at);

    const size = document.createElement("td");
    size.className = "num";
    size.textContent = humanSize(entry.bytes);

    const held = document.createElement("td");
    held.className = "held";
    for (const where of entry.held_by) {
      const tag = document.createElement("b");
      tag.dataset.where = where;
      tag.textContent = where === "daemon" ? "daemon" : "browser";
      held.append(tag);
    }

    const actions = document.createElement("td");
    const remove = document.createElement("button");
    remove.type = "button";
    remove.className = "link";
    remove.textContent = "Delete";
    remove.title = `Delete "${name}" from every store`;
    remove.addEventListener("click", async () => {
      remove.disabled = true;
      const result = await call("cacheDelete", { fileId: entry.file_id });
      el("cacheResult").textContent = result.everywhere
        ? `Deleted "${name}".`
        : `Deleted "${name}" here. The daemon still has it; it will go on the next sync.`;
      await renderCache();
    });
    actions.append(remove);

    row.append(film, language, when, size, held, actions);
    rows.append(row);
  }
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
  el("cacheResult").textContent = "Syncing…";
  const result = await call("sync");
  if (result?.transportError) {
    el("cacheResult").textContent = result.transportError;
    return;
  }
  const parts = [];
  if (result.deleted) parts.push(`${result.deleted} deletion(s) applied`);
  if (result.pushed) parts.push(`${result.pushed} sent to the daemon`);
  if (result.pulled) parts.push(`${result.pulled} copied here`);
  if (result.failed) parts.push(`${result.failed} failed`);
  el("cacheResult").textContent = parts.length ? parts.join(", ") : "Already in step";
  await refresh();
});

el("clearSearches").addEventListener("click", async () => {
  const result = await call("cacheClear", { options: { searchesOnly: true } });
  el("cacheResult").textContent = `Forgot ${result.searches} cached search(es). Downloads kept.`;
  await renderCache();
});

el("clearAll").addEventListener("click", async () => {
  /* The only irreversible thing on this page, and the cost of a mistake is
   * real: re-downloading is metered at ten a day. So it asks, and it says how
   * many rather than "are you sure?". */
  const { entries } = await call("cacheList");
  if (!entries.length) return;
  const ok = confirm(
    `Delete ${entries.length} downloaded subtitle(s)?\n\n` +
      "Getting them again costs download quota - 5 a day anonymously, 10 with an account.",
  );
  if (!ok) return;

  const result = await call("cacheClear");
  el("cacheResult").textContent = result.everywhere
    ? `Deleted ${result.subtitles} subtitle(s) from both stores.`
    : `Deleted ${result.subtitles} here. The daemon is stopped; its copies go on the next sync.`;
  await refresh();
});

load();
