/* Does a search survive the page saying what it is playing?
 *
 *   PLAYWRIGHT_PATH=... node tools/probe-find-screen.mjs [port]   (from browser-extension/)
 *
 * The Find screen is emptied when the programme changes, which is right: the
 * results are about the last film. A programme that was UNKNOWN and is now
 * known is not a change, though - the mark is empty until a page announces
 * itself or its video reports a length over a minute, and a search made in
 * that window was thrown away the moment the page spoke.
 *
 * Prints the mark before and after, how many results the search returned, and
 * how many are left. Before the fix in panel.js this read found 1, left 0.
 * The harness cannot host this as a case: nothing resets the settled mark once
 * a programme is named, so the state exists at only one point in a run, and a
 * case that names a programme early costs the later ones the programme change
 * that clears measured ad time.
 *
 * Still open, and NOT what this probe covers: an inferred mark being replaced
 * by an announced one for the same film. That is a real change of mark and the
 * panel cannot tell it from a change of film.
 */
import { spawn } from "node:child_process";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";
const here = path.dirname(fileURLToPath(import.meta.url));
const EXT = path.resolve(here, "..");
const PORT = Number(process.argv[2] || 9675);
const require_ = createRequire(import.meta.url);
const mod = await import(pathToFileURL(require_.resolve("playwright-core", { paths: [process.env.PLAYWRIGHT_PATH, EXT] })).href);
const chromium = mod.chromium ?? mod.default?.chromium;
const server = spawn("python3", [path.join(EXT, "tests", "serve.py"), String(PORT)], { cwd: EXT, stdio: "ignore" });
await new Promise((r) => setTimeout(r, 900));
const browser = await chromium.launch({ channel: "chromium", headless: true });
const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
page.on("pageerror", (e) => console.log("PAGEERROR", e.message));
try {
  await page.goto(`http://127.0.0.1:${PORT}/tests/harness.html`, { waitUntil: "domcontentloaded" });
  await page.waitForFunction(() => !/running/.test(document.querySelector("#summary")?.textContent || "running"), null, { timeout: 300000 });
  const out = await page.evaluate(async () => {
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    const panelShadow = () => [...document.querySelectorAll("div")]
      .find((d) => d.shadowRoot?.querySelector(".sso-panel"))?.shadowRoot;
    const video = document.getElementById("v");
    delete video.dataset.ssoNowPlaying;
    /* Held under the minute an inferred mark needs, for the whole probe.
     * Without it the mark settles to "7200|<page title>" while the search is
     * still running, and what follows is an inferred mark being replaced by an
     * announced one - the open question, not the one measured here. */
    const ownDuration = Object.getOwnPropertyDescriptor(video, "duration");
    Object.defineProperty(video, "duration", { get: () => 30, configurable: true });
    await sleep(400);
    const before = window.__ssoApi.status().programme ?? null;

    await window.__ssoPanel.show();
    await sleep(250);
    const panel = panelShadow();
    panel.querySelector(".sso-panel__back")?.click();
    await sleep(120);
    const add = panel.querySelector(".sso-add");
    if (add && !add.hidden) { add.click(); await sleep(200); }
    const search = [...panel.querySelectorAll("button")].find((b) => b.textContent === "Search");
    if (!search) return { error: "no Search button", before };
    search.click();
    await sleep(600);
    const found = panel.querySelectorAll(".sso-result").length;

    // What a page that announces its programme does, at the moment it does it.
    video.dataset.ssoNowPlaying = JSON.stringify({
      v: 1, kind: "episode", title: "The Americans", year: 2013,
      season: 3, episode: 9, imdb: "tt4331672",
    });
    await sleep(900);
    const left = panel.querySelectorAll(".sso-result").length;
    const filedAgainst = window.__ssoApi.status().programme ?? null;
    delete video.dataset.ssoNowPlaying;
    if (ownDuration) Object.defineProperty(video, "duration", ownDuration);
    else delete video.duration;
    window.__ssoPanel.hide();
    return { before, after: filedAgainst, found, left };
  });
  console.log(JSON.stringify(out));
} finally { await browser.close(); server.kill(); }
