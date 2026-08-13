/* Render a captured diagnostic.
 *
 * The report is a nested object and the useful parts are three levels down, so
 * this pulls the three questions that actually get asked to the top - which
 * frame was believed, which episode was searched for, and what the search made
 * of it - and leaves the whole thing at the bottom for pasting.
 */

import { reportPageErrors } from "./page-errors.js";

// Everything else records its failures; these pages did not. See page-errors.js.
reportPageErrors("report page");


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

let report = null;

async function load({ fresh = false } = {}) {
  el("captured").textContent = fresh ? "Capturing…" : "Loading…";
  // Re-capture the tab this report is about. Without the id the worker would
  // fall back to the active tab, which from here is this report.
  report = await call(
    fresh ? "diagnose" : "lastDiagnostic",
    fresh && report?.tab?.id != null ? { tabId: report.tab.id } : {},
  );

  if (!report || report.error) {
    el("captured").textContent =
      report?.error === "nothing captured yet"
        ? "Nothing captured yet. Open the page you want to diagnose, then use Capture in the control panel."
        : report?.error || "Could not reach the extension's service worker.";
    return;
  }

  render();
}

function render() {
  el("captured").textContent =
    `${report.tab.url} — captured ${new Date(report.startedAt).toLocaleString()}` +
    ` · extension ${report.extensionVersion}` +
    ` · ${report.provider.daemonRunning ? "daemon answering" : "extension answering on its own"}`;

  renderVerdict();
  renderFrames();
  renderSurfaces();
  renderEpisode();
  renderPlans();
  el("raw").textContent = JSON.stringify(report, null, 2);
}

// --- the verdict ------------------------------------------------------------

/* One sentence naming the most likely cause, in the order the causes actually
 * occur. Ordered rather than scored, because these are not independent: a frame
 * with no metadata explains a bad title, which explains everything after it,
 * and reporting all three at once would hide which one to fix. */
function renderVerdict() {
  const { plan, fromTopFrame, episodes, frameChoice } = report;
  const line = el("verdict");
  const detail = el("verdict-detail");

  const usedFallback = /tab\.title/.test(plan?.askedWith?.titleSource || "");
  const topDisagrees =
    fromTopFrame && fromTopFrame.askedWith?.title !== plan?.askedWith?.title;

  if (usedFallback && topDisagrees) {
    line.textContent = "The metadata was read from the wrong frame.";
    line.dataset.kind = "stuck";
    detail.textContent =
      `Frame ${frameChoice.videoFrameId} holds the video but has no page metadata, so the search ` +
      `fell back to the tab title, "${plan.askedWith.title}". The top frame would have said ` +
      `"${fromTopFrame.askedWith.title}".`;
    return;
  }

  if (episodes.verdict.startsWith("the search named no episode, but")) {
    line.textContent = "The search did not name an episode, but the page knew which one.";
    line.dataset.kind = "stuck";
    const found = episodes.selectedOnPage[0] || episodes.fromTitle || episodes.fromUrl;
    detail.textContent =
      `The page says S${found.season}E${found.episode}. The search asked for the series only, so ` +
      `results span ${episodes_span()} and the top score is shared by ` +
      `${plan.topScoreTies} of them — the tie is broken on language and on what is already ` +
      `downloaded, neither of which knows which episode is playing.`;
    return;
  }

  if (plan?.decision === "too-weak") {
    line.textContent = "Nothing matched the page well enough to attach.";
    line.dataset.kind = "stuck";
    detail.textContent =
      `Best match "${plan.best?.name}" scored ${plan.best?.score} against a threshold of ` +
      `${plan.threshold}, so it refused rather than guess. It searched for ` +
      `"${plan.searchedFor?.query}".`;
    return;
  }

  if (plan?.decision === "nothing-found" || plan?.decision === "error") {
    line.textContent = plan.reason || "The search returned nothing.";
    line.dataset.kind = "stuck";
    detail.textContent = `It searched for "${plan.searchedFor?.query ?? plan.askedWith?.title}".`;
    return;
  }

  line.textContent = "It would attach a subtitle.";
  line.dataset.kind = "daemon";
  detail.textContent = plan?.best
    ? `"${plan.best.name}" at ${plan.best.score}` +
      (plan.second ? `, plus "${plan.second.name}" as the second subtitle.` : ".")
    : "";
}

function episodes_span() {
  const list = report.plan?.distinctEpisodes || [];
  if (list.length === 0) return "no episodes";
  const seasons = new Set(list.map((item) => item.split("E")[0]));
  return `${list.length} episodes across ${seasons.size} season(s)`;
}

// --- frames -----------------------------------------------------------------

function renderFrames() {
  const { frameChoice, frames } = report;
  el("frame-summary").textContent =
    `Frame ${frameChoice.videoFrameId} is believed — ${frameChoice.chosenBecause}. ` +
    `${frameChoice.frameCount} frame(s), ${frameChoice.framesWithContentScript} running the ` +
    `content script, ${frameChoice.framesWithVideo} with a video, ` +
    `${frameChoice.framesWithTitleCandidates} with page metadata.`;

  const rows = el("frames-rows");
  rows.replaceChildren();

  for (const frame of frames) {
    const row = document.createElement("tr");
    if (frame.frameId === frameChoice.videoFrameId) row.className = "believed";

    const id = document.createElement("td");
    id.textContent = frame.frameId === 0 ? "0 (top)" : String(frame.frameId);
    if (frame.frameId === frameChoice.videoFrameId) {
      const tag = document.createElement("b");
      tag.textContent = "believed";
      id.append(" ", tag);
    }

    const origin = document.createElement("td");
    origin.className = "film";
    origin.title = frame.url;
    origin.textContent = frame.origin;

    const cell = (value) => {
      const td = document.createElement("td");
      td.className = "num";
      td.textContent = String(value);
      return td;
    };

    const script = document.createElement("td");
    script.textContent = frame.reachable ? "yes" : "no";
    if (!frame.reachable) script.dataset.bad = "true";

    row.append(
      id,
      origin,
      cell(frame.report?.videoCount ?? 0),
      cell(frame.report?.titleCandidates?.length ?? 0),
      cell(frame.report?.episodes?.total ?? 0),
      script,
    );
    rows.append(row);
  }
}

// --- the surfaces -----------------------------------------------------------

/* Why a surface will not take a click.
 *
 * Two findings, and they point at different places. Something over a button is
 * named outright and lives in that button's own document. A button that is
 * topmost in a frame below the top one is a different answer: the obstruction
 * is in a document this frame cannot see or reach past, so the fix is to draw
 * the surface somewhere else rather than to raise it. Both are stated, because
 * mistaking the second for "nothing is wrong" is the whole trap.
 */
function renderSurfaces() {
  const wrap = el("surfaces");
  wrap.replaceChildren();

  const drawn = report.frames.filter((frame) => frame.report?.surfaces?.length);
  el("surfaces-empty").hidden = drawn.length > 0;
  if (!drawn.length) {
    el("surfaces-summary").textContent = "Nothing drawn.";
    return;
  }

  let blocked = 0;
  let nested = 0;

  for (const frame of drawn) {
    const heading = document.createElement("h3");
    const where = frame.frameId === 0 ? "frame 0 (top)" : `frame ${frame.frameId}`;
    heading.textContent = `${where} — ${frame.origin}`;
    wrap.append(heading);

    for (const surface of frame.report.surfaces) {
      const block = document.createElement("div");

      const title = document.createElement("p");
      title.className = "note";
      title.textContent =
        `${surface.surface} · ${surface.rect[2]}x${surface.rect[3]} at ` +
        `(${surface.rect[0]}, ${surface.rect[1]}) · z-index ${surface.zIndex} · ` +
        `pointer-events ${surface.pointerEvents} · ` +
        `${surface.inTopLayer ? "in the top layer" : "not in the top layer"}`;
      block.append(title);

      for (const target of surface.targets || []) {
        const line = document.createElement("p");
        line.className = "status";
        if (target.rendered === false) {
          line.textContent = `“${target.label}” — not rendered (zero size)`;
        } else if (target.coveredBy?.length) {
          blocked += 1;
          line.dataset.bad = "true";
          line.textContent = `“${target.label}” — covered by ${target.coveredBy.join(" ← ")}`;
        } else if (frame.frameId !== 0) {
          nested += 1;
          line.textContent =
            `“${target.label}” — topmost here, but this frame is not the top one. ` +
            `Anything the page above draws over this frame covers it and cannot be seen from in here.`;
        } else {
          line.textContent = `“${target.label}” — reachable`;
        }
        block.append(line);
      }

      wrap.append(block);
    }
  }

  el("surfaces-summary").textContent = blocked
    ? `${blocked} button(s) have something over them. The first name on each line is what takes the click.`
    : nested
      ? `Nothing in these frames covers the extension's buttons, but ${nested} of them are drawn ` +
        `below the top frame. If they still will not take a click, the obstruction is in the page above.`
      : "Every button the extension drew is reachable where it was drawn.";
}

// --- the episode ------------------------------------------------------------

function renderEpisode() {
  const { episodes } = report;
  const facts = el("episode-facts");
  facts.replaceChildren();

  const asked =
    episodes.searchedSeason == null && episodes.searchedEpisode == null
      ? "nothing — the series only"
      : `S${episodes.searchedSeason}E${episodes.searchedEpisode}`;
  const onPage = episodes.selectedOnPage[0];

  for (const [term, value, bad] of [
    ["The search asked for", asked, episodes.searchedSeason == null],
    [
      "Resolved as",
      episodes.resolvedType
        ? `${episodes.resolvedType} (from ${episodes.resolvedFrom})`
        : "not resolved",
      false,
    ],
    [
      "Marked as chosen on the page",
      onPage ? `S${onPage.season}E${onPage.episode} — "${onPage.text}"` : "nothing found",
      !onPage,
    ],
    ["In the page title", episodes.fromTitle ? episodes.fromTitle.matched : "no", false],
    ["In the URL", episodes.fromUrl ? episodes.fromUrl.matched : "no", false],
    [
      "Markers found in total",
      `${episodes.markersFound}` +
        (episodes.markersOmitted ? ` (${episodes.markersOmitted} not listed)` : ""),
      false,
    ],
  ]) {
    const dt = document.createElement("dt");
    dt.textContent = term;
    const dd = document.createElement("dd");
    dd.textContent = value;
    if (bad) dd.dataset.bad = "true";
    facts.append(dt, dd);
  }

  const rows = el("markers-rows");
  rows.replaceChildren();
  const markers = episodes.sample || [];
  el("markers-wrap").hidden = markers.length === 0;
  el("markers-empty").hidden = markers.length > 0;

  for (const marker of markers) {
    const row = document.createElement("tr");
    const text = document.createElement("td");
    text.textContent = marker.text;
    const reads = document.createElement("td");
    reads.textContent = `S${marker.season}E${marker.episode}`;
    const where = document.createElement("td");
    where.className = "film";
    where.title = marker.path;
    where.textContent = `frame ${marker.frameId} · ${marker.path}`;
    const chosen = document.createElement("td");
    chosen.textContent = marker.selected ? marker.selectedBecause.join(", ") : "—";
    row.append(text, reads, where, chosen);
    rows.append(row);
  }
}

// --- what was searched ------------------------------------------------------

function renderPlans() {
  const { plan, fromTopFrame } = report;
  el("search-compare").textContent = fromTopFrame
    ? "The same search run twice: once from the frame the extension believes, once from the top " +
      "frame. If these differ, the frame it believes is the problem."
    : "The video and the page metadata are in the same frame, so there is only one search to show.";

  const wrap = el("plans");
  wrap.replaceChildren();
  for (const item of [plan, fromTopFrame].filter(Boolean)) wrap.append(planBlock(item));
}

function planBlock(plan) {
  const box = document.createElement("div");
  box.className = "plan";

  const head = document.createElement("h3");
  head.textContent =
    plan.label || (plan.frameId === 0 ? "From frame 0 (top)" : `From frame ${plan.frameId}`);
  box.append(head);

  if (plan.error) {
    const error = document.createElement("p");
    error.className = "note";
    error.dataset.bad = "true";
    error.textContent = plan.error;
    box.append(error);
    return box;
  }

  const facts = document.createElement("dl");
  facts.className = "facts";
  for (const [term, value] of [
    ["Title sent", `${plan.askedWith.title} (from ${plan.askedWith.titleSource})`],
    ["Cleaned to", plan.searchedFor?.query ?? "—"],
    [
      "Season / episode sent",
      plan.searchedFor?.season == null
        ? "none"
        : `S${plan.searchedFor.season}E${plan.searchedFor.episode}`,
    ],
    ["Resolved to", plan.resolved?.title ? `${plan.resolved.title} (${plan.resolved.type})` : "nothing"],
    ["Decision", `${plan.decision}${plan.reason ? ` — ${plan.reason}` : ""}`],
    ["Results", `${plan.resultCount}${plan.resultsOmitted ? ` (${plan.resultsOmitted} not listed)` : ""}`],
    ["Episodes among them", (plan.distinctEpisodes || []).join(", ") || "none stated"],
    ["Tied at the top score", String(plan.topScoreTies)],
  ]) {
    const dt = document.createElement("dt");
    dt.textContent = term;
    const dd = document.createElement("dd");
    dd.textContent = value;
    facts.append(dt, dd);
  }
  box.append(facts);

  if (plan.results?.length) {
    const table = document.createElement("table");
    const head2 = document.createElement("thead");
    const hr = document.createElement("tr");
    for (const name of ["Lang", "Name", "Ep", "Score", "Held"]) {
      const th = document.createElement("th");
      th.scope = "col";
      th.textContent = name;
      hr.append(th);
    }
    head2.append(hr);
    const body = document.createElement("tbody");
    for (const result of plan.results) {
      const tr = document.createElement("tr");
      if (plan.best && result.fileId === plan.best.fileId) tr.className = "believed";
      for (const value of [
        (result.language || "").toUpperCase(),
        result.name || result.release || "",
        result.season == null ? "—" : `S${result.season}E${result.episode}`,
        result.score ?? "",
        result.cached ? "cached" : "",
      ]) {
        const td = document.createElement("td");
        td.textContent = String(value);
        tr.append(td);
      }
      body.append(tr);
    }
    table.append(head2, body);
    const scroll = document.createElement("div");
    scroll.className = "table-scroll";
    scroll.append(table);
    box.append(scroll);
  }

  return box;
}

// --- the running log ---------------------------------------------------------

/* Separate from the report above, and deliberately so.
 *
 * The report is one moment, captured because somebody pressed a button. This
 * is what happened while nobody was pressing anything - which is where the two
 * questions that keep needing an answer live: what does that page actually
 * look like, and which two files was the aligner given when it said no.
 */
let traceLog = [];
let traceState = null;
let traceFolder = "subtitle-overlay-log";

const AGES = [
  [1000, "just now"],
  [60_000, (ms) => `${Math.round(ms / 1000)}s ago`],
  [3_600_000, (ms) => `${Math.round(ms / 60_000)}m ago`],
];

function ago(at) {
  const ms = Date.now() - new Date(at).getTime();
  for (const [limit, said] of AGES) if (ms < limit) return typeof said === "function" ? said(ms) : said;
  return new Date(at).toLocaleString();
}

async function loadTrace() {
  const answer = await call("traceLog");
  traceLog = Array.isArray(answer?.entries) ? answer.entries : [];
  traceState = answer?.state || null;
  traceFolder = answer?.folder || traceFolder;
  renderTrace();
}

function renderTrace() {
  const summary = el("trace-summary");
  const list = el("trace-list");
  list.textContent = "";

  /* What is on disk first, and what is still in hand second. The folder is the
   * record; the buffer is the few seconds that have not reached it yet, and
   * confusing the two is how somebody concludes there is nothing to look at. */
  const sent = traceState?.sentToDaemon || 0;
  const files = traceState?.filesWritten || 0;
  const out = sent || files
    ? `${traceState.entriesSent} entries sent out` +
      (sent ? `, ${sent} batch${sent === 1 ? "" : "es"} to the daemon (subtitle-daemon/logs/)` : "") +
      (files ? `, ${files} file${files === 1 ? "" : "s"} downloaded under ${traceFolder}/` : "") +
      ` — ${(traceState.bytesOut / 1048576).toFixed(1)}MB`
    : "nothing sent out yet";
  const waiting = traceLog.length
    ? `${traceLog.length} held here (${ago(traceLog[0].at)} onwards)`
    : "nothing held";
  /* Not an error when the daemon is simply not running. It says so, and says
   * that the entries are being kept, because "held in the browser" and "lost"
   * are the two readings and only one of them is true. */
  const trouble = traceState?.lastError
    ? ` · ${traceState.lastError} — entries are being kept, not dropped`
    : "";
  summary.textContent = `${out} · ${waiting}${trouble}`;

  if (!traceLog.length) return;

  // Newest first: the thing that just went wrong is the thing being looked for.
  for (const entry of [...traceLog].reverse()) {
    const row = document.createElement("details");
    row.className = "frame";
    const head = document.createElement("summary");
    head.textContent = `${ago(entry.at)} · ${describeEntry(entry)}`;
    const body = document.createElement("pre");
    body.className = "raw";
    /* The timings are the bulk of an alignment entry and unreadable by eye, so
     * the page shows their shape and the file keeps the numbers. */
    body.textContent = JSON.stringify(entry, readableTimes, 2);
    row.append(head, body);
    list.appendChild(row);
  }
}

function readableTimes(key, value) {
  if (key !== "times" || !Array.isArray(value)) return value;
  return `${value.length} cue gaps, kept in the saved file`;
}

function describeEntry(entry) {
  if (entry.kind === "panel") {
    const frames = entry.frames || [];
    const withVideo = frames.filter((f) => f.report?.hasPlayableVideo).length;
    const roles = frames.map((f) => `${f.frameId}:${f.report?.frameRole ?? "-"}`).join(" ");
    return `panel ${entry.open ? "opened" : "closed"} · ${frames.length} frames, ${withVideo} with a film · roles ${roles}`;
  }
  if (entry.kind === "align") {
    const answer = entry.answer || {};
    const pair = (entry.tracks || [])
      .map((t) => `${(t.language || "?").toUpperCase()} ${t.cueCount}`)
      .join(" against ");
    return `line up · ${pair} · ${answer.verdict ?? "?"} at confidence ${answer.confidence ?? "?"}, coverage ${answer.coverage ?? "?"}`;
  }
  if (entry.kind === "alignOutcome") {
    return `the reader ${entry.outcome} that alignment`;
  }
  return entry.kind;
}

const saveTrace = () => {
  const text = JSON.stringify({ savedAt: new Date().toISOString(), entries: traceLog }, null, 2);
  const url = URL.createObjectURL(new Blob([text], { type: "application/json" }));
  const link = document.createElement("a");
  link.href = url;
  link.download = `subtitle-trace-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, "")}.json`;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
};

const sayOnTrace = (text) => {
  el("trace-said").textContent = text;
  setTimeout(() => (el("trace-said").textContent = ""), 2500);
};

el("trace-flush").addEventListener("click", async () => {
  const answer = await call("traceFlush");
  await loadTrace();
  sayOnTrace(
    answer?.empty ? "Nothing was held." :
    answer?.held ? `The daemon is not running, so ${answer.held} entries are still here.` :
    answer?.ok ? `Sent ${answer.entries} entries to ${answer.file || answer.destination}.` :
    `Could not send it: ${answer?.reason || answer?.transportError || "unknown"}`,
  );
});

el("trace-download").addEventListener("click", () => {
  if (!traceLog.length) return sayOnTrace("Nothing held - what has gone out is already saved.");
  saveTrace();
});

el("trace-clear").addEventListener("click", async () => {
  await call("traceClear");
  await loadTrace();
  sayOnTrace("Cleared.");
});

// --- actions ----------------------------------------------------------------

el("recapture").addEventListener("click", () => load({ fresh: true }));

el("copy").addEventListener("click", async () => {
  if (!report) return;
  await navigator.clipboard.writeText(JSON.stringify(report, null, 2));
  el("copied").textContent = "Copied.";
  setTimeout(() => (el("copied").textContent = ""), 2000);
});

el("download").addEventListener("click", () => {
  if (!report) return;
  const url = URL.createObjectURL(
    new Blob([JSON.stringify(report, null, 2)], { type: "application/json" }),
  );
  const link = document.createElement("a");
  link.href = url;
  link.download = `subtitle-diagnostic-${report.startedAt.slice(0, 19).replace(/[:T]/g, "")}.json`;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
});

/* Opened with #capture from the control panel, which means "diagnose the tab I
 * was just looking at" - the capture has already run, so this only renders. */
load({ fresh: false });
/* Independent of the report above, and not gated on it: the log is worth
 * reading on a page that has never had a capture taken, which is most of them. */
loadTrace();
