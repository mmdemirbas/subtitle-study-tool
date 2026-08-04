/* Render a captured diagnostic.
 *
 * The report is a nested object and the useful parts are three levels down, so
 * this pulls the three questions that actually get asked to the top - which
 * frame was believed, which episode was searched for, and what the search made
 * of it - and leaves the whole thing at the bottom for pasting.
 */

const call = (op, args = {}) => chrome.runtime.sendMessage({ type: "sso:daemon", op, args });
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
