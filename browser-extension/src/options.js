/* Settings page.
 *
 * Runs in an extension page, so it could import provider.js directly - but the
 * service worker holds the probe state and the LocalService instance, and two
 * copies of those would disagree about whether the daemon is up. So it asks the
 * worker, the same way the panel does.
 */

import { reportPageErrors } from "./page-errors.js";

// Everything else records its failures; these pages did not. See page-errors.js.
reportPageErrors("settings page");


/* Never rejects, the same contract content.js gives the panel.
 *
 * sendMessage rejects when the channel fails rather than when the work does -
 * the extension reloaded under this page, or a worker that threw while
 * starting - and every caller here is inside a click handler that cannot
 * catch. Answering in the shape the worker already uses for its own failures
 * means one failure mode to read instead of two, and no dropped rejection. */
const call = (op, args = {}) =>
  chrome.runtime
    .sendMessage({ type: "sso:daemon", op, args })
    .catch((error) => ({ transportError: String(error?.message || error) }));

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
  } else if (status.daemon_blocked) {
    /* Something else is on the daemon's port, which is not the same as the
     * daemon being stopped and does not have the same answer: starting it now
     * fails with the port already in use. Said plainly, because the symptom
     * when this happened was two days of translations that arrived late and
     * knew nothing about their line, with nothing on any surface saying why. */
    el("statusLine").textContent = "Something else is on the daemon's port";
    el("statusLine").dataset.kind = "stuck";
    el("statusNote").textContent =
      `${status.daemon_blocked} The extension is doing the work itself, so ` +
      "subtitles still arrive - but word meanings lose the line they were said " +
      "in, which is what makes them right. Find what is holding the port and " +
      "stop it, then start the daemon.";
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

/* Fetched once, drawn on every keystroke. The same split the deck uses: a
 * search that went back to the worker for 273 entries per character typed would
 * be answering with the list it already has. */
let cacheEntries = [];
let cacheDaemonRunning = false;

async function renderCache() {
  const { entries, daemon_running: daemonRunning, pending_deletions: pending } =
    await call("cacheList");
  cacheEntries = entries || [];
  cacheDaemonRunning = Boolean(daemonRunning);

  el("cachePending").hidden = !pending;
  if (pending) {
    el("cachePending").textContent =
      `${pending} deletion${pending === 1 ? "" : "s"} waiting for the daemon. ` +
      `${pending === 1 ? "It is" : "They are"} applied automatically the next time it runs.`;
  }
  drawCache();
}

function drawCache() {
  const needle = el("cacheSearch").value.trim().toLowerCase();
  /* Matched against what is on the row and what is behind it: the film's name,
   * the release string under it, and the language. A reader looking for one
   * subtitle among 273 knows one of those three, and which one it is depends on
   * whether they are looking for an episode or for the copy of it that syncs. */
  const shown = needle
    ? cacheEntries.filter((entry) => {
        const { name, detail } = describe(entry);
        return [name, detail, entry.language, entry.release, entry.movie_name]
          .filter(Boolean)
          .join(" ")
          .toLowerCase()
          .includes(needle);
      })
    : cacheEntries;

  const rows = el("cacheRows");
  rows.replaceChildren();

  const total = shown.reduce((sum, entry) => sum + (Number(entry.bytes) || 0), 0);
  const said = `${shown.length} subtitle${shown.length === 1 ? "" : "s"}, ${humanSize(total)}`;
  el("cacheLine").textContent = cacheEntries.length
    ? (needle ? `${said}, of ${cacheEntries.length}` : said) +
      (cacheDaemonRunning ? "" : " — the daemon is stopped, so only this side is listed")
    : "Nothing downloaded yet";
  el("cacheEmpty").hidden = cacheEntries.length > 0;
  // A search that matched nothing is not an empty store, and saying "nothing
  // downloaded yet" to someone holding 273 subtitles reads as data loss.
  el("cacheNoMatch").hidden = !(cacheEntries.length > 0 && shown.length === 0);
  el("cacheTable").hidden = shown.length === 0;

  for (const entry of shown) {
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

// --- the deck ---------------------------------------------------------------

/* Entries are held in the browser rather than in the daemon, because saving has
 * to work on the key that saves it, mid-film, whether or not a local service
 * happens to be running. Export is what gets them out - into Anki, or into
 * anything else. */

let deckEntries = [];

async function renderDeck() {
  const { entries } = await call("deckList");
  /* Through the deck's own reader, so an entry saved when a card carried one
   * paired line and one saved since it carried a list both arrive here in the
   * same shape. Done once on load rather than at each place that reads them. */
  const { pairedOf } = await import("./study/deck.js");
  deckEntries = (entries || []).map((entry) => ({ ...entry, paired: pairedOf(entry) }));
  drawDeck();
}

function drawDeck() {
  const needle = el("deckSearch").value.trim().toLowerCase();
  const shown = needle
    ? deckEntries.filter((entry) =>
        [entry.term, entry.sentence, ...entry.paired.map((line) => line.text), entry.title]
          .join(" ")
          .toLowerCase()
          .includes(needle),
      )
    : deckEntries;

  el("deckLine").textContent = deckEntries.length
    ? needle
      ? `${shown.length} of ${deckEntries.length} saved`
      : `${deckEntries.length} saved`
    : "Nothing saved yet";
  el("deckEmpty").hidden = deckEntries.length > 0;
  // Same distinction as the cache: nothing matched is not nothing saved.
  el("deckNoMatch").hidden = !(deckEntries.length > 0 && shown.length === 0);
  el("deckTable").hidden = shown.length === 0;

  const rows = el("deckRows");
  rows.replaceChildren();

  // Newest first: the words from the film you just watched are the ones you
  // came here to look at.
  for (const entry of [...shown].reverse()) {
    const row = document.createElement("tr");

    const term = document.createElement("td");
    term.className = "term";
    term.textContent = entry.term;
    if (entry.phonetic) {
      const phonetic = document.createElement("span");
      phonetic.textContent = entry.phonetic;
      term.append(phonetic);
    }

    const detail = document.createElement("td");
    detail.className = "entry";
    const sense = entry.definitions?.[0];
    if (sense) {
      detail.append(document.createTextNode(`${sense.partOfSpeech}: ${sense.sense}`));
    }
    for (const [text, kind] of [
      [entry.sentence, "line"],
      ...entry.paired.map((line) => [line.text, "paired"]),
      [[entry.title, entry.timeMs != null ? formatTime(entry.timeMs) : ""]
        .filter(Boolean)
        .join(" · "), "where"],
    ]) {
      if (!text) continue;
      const line = document.createElement("span");
      line.dataset.kind = kind;
      line.textContent = text;
      detail.append(line);
    }

    const language = document.createElement("td");
    language.textContent = (entry.language || "—").toUpperCase();

    const when = document.createElement("td");
    when.textContent = entry.savedAt ? whenDownloaded(Date.parse(entry.savedAt) / 1000) : "—";

    const actions = document.createElement("td");
    const remove = document.createElement("button");
    remove.type = "button";
    remove.className = "link";
    remove.textContent = "Delete";
    remove.title = `Forget "${entry.term}"`;
    remove.addEventListener("click", async () => {
      remove.disabled = true;
      await call("deckRemove", { id: entry.id });
      el("deckResult").textContent = `Deleted "${entry.term}".`;
      await renderDeck();
    });
    actions.append(remove);

    row.append(term, detail, language, when, actions);
    rows.append(row);
  }
}

function formatTime(ms) {
  const total = Math.max(0, Math.round(Number(ms) / 1000));
  const parts = [Math.floor(total / 3600), Math.floor((total % 3600) / 60), total % 60];
  return parts.map((part) => String(part).padStart(2, "0")).join(":");
}

/* Downloaded through a blob URL rather than written anywhere: an extension page
 * has no filesystem, and this keeps the export a normal browser download that
 * lands wherever downloads land. */
function download(name, text, type) {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const link = document.createElement("a");
  link.href = url;
  link.download = name;
  link.click();
  // Revoked on the next turn of the event loop; revoking synchronously races
  // the download in some builds.
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

async function exportDeck(format) {
  if (deckEntries.length === 0) {
    el("deckResult").textContent = "Nothing to export yet.";
    return;
  }
  const { serialise } = await import("./study/deck.js");
  const stamp = new Date().toISOString().slice(0, 10);
  if (format === "json") {
    download(`subtitle-words-${stamp}.json`, serialise(deckEntries, "json"), "application/json");
  } else {
    download(`subtitle-words-${stamp}.tsv`, serialise(deckEntries, "tsv"), "text/tab-separated-values");
  }
  el("deckResult").textContent = `Exported ${deckEntries.length} word(s).`;
}

// --- the lookup permissions ---------------------------------------------------

/* Two origins, granted and revoked together: they are one feature to the reader
 * - "look this word up" - and splitting them into two switches would ask about
 * a distinction that only exists in the implementation. */
const DICTIONARY_ORIGINS = {
  origins: ["https://api.dictionaryapi.dev/*", "https://api.mymemory.translated.net/*"],
};

async function renderDictionary() {
  const granted = await chrome.permissions.contains(DICTIONARY_ORIGINS);
  el("dictLine").textContent = granted
    ? "Allowed. The extension can look words up and translate them on its own when the daemon is stopped."
    : "Not allowed. Definitions and translations need the daemon running.";
  el("dictLine").dataset.kind = granted ? "daemon" : "extension";
  el("dictGrant").hidden = granted;
  el("dictRevoke").hidden = !granted;
}

async function load() {
  const stored = await chrome.storage.local.get("sso:provider");
  const config = stored["sso:provider"] || {};
  el("apiKey").value = config.apiKey || "";
  el("languages").value = (config.languages || ["en", "tr"]).join(", ");
  await refresh();
  await renderDeck();
  await renderDictionary();
  // The panel's "Saved words" button links straight here.
  if (location.hash === "#deck") el("deck").scrollIntoView({ block: "start" });
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

el("cacheSearch").addEventListener("input", drawCache);
el("deckSearch").addEventListener("input", drawDeck);
el("deckExportTsv").addEventListener("click", () => exportDeck("tsv"));
el("deckExportJson").addEventListener("click", () => exportDeck("json"));

el("deckClear").addEventListener("click", async () => {
  if (deckEntries.length === 0) return;
  /* Asks, and says how many. Unlike the subtitle cache this costs no quota to
   * rebuild - it cannot be rebuilt at all, because the films have been watched
   * and the lines have gone past. */
  const ok = confirm(
    `Delete ${deckEntries.length} saved word(s)?\n\n` +
      "These cannot be recovered. Export first if you want to keep them.",
  );
  if (!ok) return;
  await call("deckClear");
  el("deckResult").textContent = "Deleted every saved word.";
  await renderDeck();
});

el("dictGrant").addEventListener("click", async () => {
  // Must be called from a user gesture; Chrome refuses the prompt otherwise.
  await chrome.permissions.request(DICTIONARY_ORIGINS).catch(() => false);
  await renderDictionary();
});

el("dictRevoke").addEventListener("click", async () => {
  await chrome.permissions.remove(DICTIONARY_ORIGINS).catch(() => false);
  await renderDictionary();
});

load();
