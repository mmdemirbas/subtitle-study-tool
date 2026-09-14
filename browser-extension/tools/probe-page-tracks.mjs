/* What the extension makes of a page's own subtitles, on a real page.
 *
 *   PLAYWRIGHT_PATH=/opt/homebrew/lib/node_modules/@playwright/mcp/node_modules \
 *     node tools/probe-page-tracks.mjs http://localhost:5173/title/tt41297712
 *
 * Launches Chromium with this directory loaded as an unpacked extension, opens
 * the page, starts the film with a click in the middle of the picture (and
 * `k` / space if that did nothing), then asks the extension's own service
 * worker three things through the same messages it uses itself:
 *
 *   - what the frame lists as the page's own subtitles (`sso:pageSubtitles`),
 *     printed with the URLs' hosts and each track's format and shift, never
 *     the URL itself;
 *   - whether the worker can fetch the first one and how many cues it reads
 *     (a plain fetch from the worker's side, counted by `-->`);
 *   - and, with the site switched to automatic for this run, what got
 *     attached (`sso:status`), which is the whole path end to end.
 *
 * Written for the standard <track> path (see "the subtitles a page carries
 * the standard way" in CLAUDE.md), first run against the local catalogue app.
 * Needs a real Chrome for the codecs a film uses. The daemon, if running,
 * gets the run's trace lines like any other playback. */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";

const url = process.argv[2];
if (!url) {
  console.error("usage: node tools/probe-page-tracks.mjs <url>");
  process.exit(2);
}
const EXT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const require_ = createRequire(import.meta.url);
const mod = await import(
  pathToFileURL(require_.resolve("playwright-core", { paths: [process.env.PLAYWRIGHT_PATH, EXT] })).href
);
const chromium = mod.chromium ?? mod.default?.chromium;

const profile = fs.mkdtempSync(path.join(os.tmpdir(), "ssoprobe-"));
const ctx = await chromium.launchPersistentContext(profile, {
  channel: "chromium",
  // Headed with HEADED=1, to watch it; the extension loads either way.
  headless: !process.env.HEADED,
  viewport: { width: 1280, height: 800 },
  args: [`--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`, "--autoplay-policy=no-user-gesture-required", "--mute-audio"],
});

// Nothing here is worth more than four minutes; a hang says as much as a failure.
const deadline = setTimeout(() => { console.log("VERDICT gave up after four minutes"); process.exit(1); }, 240000);
deadline.unref?.();
const step = (what) => console.log(`[${new Date().toISOString().slice(11, 19)}] ${what}`);

try {
  step("waiting for the extension's worker");
  const sw = ctx.serviceWorkers()[0] || (await ctx.waitForEvent("serviceworker", { timeout: 15000 }));
  step("worker up");
  // Automatic on this site for the run, the way the settings window would set it.
  await sw.evaluate(async (origin) => {
    const sites = (await chrome.storage.local.get("sso:autoSites"))["sso:autoSites"] || {};
    sites[origin] = true;
    await chrome.storage.local.set({ "sso:autoSites": sites });
  }, new URL(url).origin);

  step("site set to automatic; opening the page");
  const page = ctx.pages()[0] || (await ctx.newPage());
  // The content script's own errors land in the page's console, and nowhere else this can see.
  page.on("console", (message) => { if (message.type() === "error") console.log("page console:", message.text().slice(0, 300)); });
  page.on("pageerror", (error) => console.log("page error:", String(error).slice(0, 300)));
  await page.goto(url, { waitUntil: "domcontentloaded" });
  await page.waitForSelector("video", { timeout: 30000 });
  step("a <video> is on the page");

  const playing = () =>
    page.waitForFunction(() => { const v = document.querySelector("video"); return v && v.readyState >= 2 && v.currentTime > 0; }, null, { timeout: 20000 }).then(() => true, () => false);
  const box = await page.locator("video").first().boundingBox();
  if (box) await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
  console.log("waiting for the film to play...");
  let started = await playing();
  for (const key of ["k", " "]) {
    if (started) break;
    await page.keyboard.press(key);
    started = await playing();
  }
  console.log("playing:", started);

  // What the document carries, seen from the page's world: counts only.
  console.log("document:", JSON.stringify(await page.evaluate(() => {
    const v = document.querySelector("video");
    return {
      tracks: [...v.querySelectorAll("track")].map((t) => ({ kind: t.kind, srclang: t.srclang, label: t.label, hasSrc: Boolean(t.src), mode: t.track?.mode })),
      textTracks: [...v.textTracks].map((t) => ({ kind: t.kind, language: t.language, mode: t.mode, cues: t.cues ? t.cues.length : null })),
      offset: v.dataset.ssoTimeOffset ?? null,
      nowPlaying: Boolean(v.dataset.ssoNowPlaying),
      siteName: document.querySelector('meta[property="og:site_name"]')?.content ?? null,
    };
  })));

  /* The worker handle is taken fresh each time, and each evaluate is raced
   * against a clock: an MV3 worker stops after thirty idle seconds and comes
   * back as a new one on the next message, and an evaluate that was in
   * flight on the old handle never settles. */
  // The LAST one: a worker Chrome stopped and started again is a second entry, and the first is a corpse.
  const worker = async () => ctx.serviceWorkers().at(-1) || ctx.waitForEvent("serviceworker", { timeout: 15000 });
  const inWorker = async (fn, arg) => {
    for (let attempt = 0; attempt < 3; attempt++) {
      const handle = await worker();
      const answer = await Promise.race([
        handle.evaluate(fn, arg).catch((error) => ({ __failed: String(error?.message || error) })),
        new Promise((resolve) => setTimeout(() => resolve({ __timedOut: true }), 8000)),
      ]);
      if (answer?.__timedOut) { step(`the worker did not answer in 8s (attempt ${attempt + 1})`); continue; }
      if (answer?.__failed) { step(`the worker refused: ${answer.__failed}`); continue; }
      return answer;
    }
    return null;
  };
  const askFrame = (type) =>
    inWorker(async (type) => {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      const frames = await chrome.webNavigation.getAllFrames({ tabId: tab.id });
      for (const frame of frames) {
        try {
          const answer = await chrome.tabs.sendMessage(tab.id, { type }, { frameId: frame.frameId });
          if (answer && (type !== "sso:status" || answer.hasVideo)) return answer;
        } catch {
          // no content script in this frame
        }
      }
      return null;
    }, type);

  // The frame's list, as the worker sees it at fetch time - URLs kept out of the print.
  const listed = await new Promise((resolve) => setTimeout(resolve, 2500)).then(() => askFrame("sso:pageSubtitles"));
  const host = (u) => { try { return new URL(u).host; } catch { return "?"; } };
  console.log("frame lists:", JSON.stringify(listed && {
    site: listed.site,
    titleId: listed.titleId,
    tracks: listed.tracks.map((t) => ({ id: t.id, format: t.format, displayName: t.displayName, host: host(t.url), shiftMs: t.shiftMs ?? 0, cues: t.cues?.length })),
  }));

  // Can the worker fetch it, and is it a subtitle?
  const first = listed?.tracks?.find((t) => /^https?:/.test(t.url));
  if (first) {
    const got = await inWorker(async (u) => {
      const response = await fetch(u);
      const text = await response.text();
      return { status: response.status, type: response.headers.get("content-type"), bytes: text.length, head: text.slice(0, 12), cues: (text.match(/-->/g) || []).length };
    }, first.url);
    console.log("worker fetched the first:", JSON.stringify({ id: first.id, ...got }));
  }

  /* The whole path: the programme mark went to the worker, the plan took the
   * page's own, the frame attached them. Polled from INSIDE one evaluate, for
   * up to a minute: the debugger session an evaluate holds is what keeps an
   * MV3 worker from being stopped as idle, and a worker stopped between two
   * evaluates never answered the second one on this machine (2026-09-14). */
  const status = await Promise.race([
    (await worker()).evaluate(async () => {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      const frames = await chrome.webNavigation.getAllFrames({ tabId: tab.id });
      const ask = async () => {
        for (const frame of frames) {
          try {
            const answer = await chrome.tabs.sendMessage(tab.id, { type: "sso:status" }, { frameId: frame.frameId });
            if (answer?.hasVideo) return answer;
          } catch {
            // no content script in this frame
          }
        }
        return null;
      };
      let last = null;
      for (let i = 0; i < 60; i++) {
        last = await ask();
        if (last?.attached) break;
        await new Promise((resolve) => setTimeout(resolve, 1000));
      }
      return last;
    }).catch((error) => ({ __failed: String(error?.message || error) })),
    new Promise((resolve) => setTimeout(() => resolve({ __timedOut: true }), 90000)),
  ]);
  console.log("attached:", JSON.stringify(status && (status.__failed || status.__timedOut ? status : {
    attached: status.attached,
    tracks: (status.tracks || []).filter((t) => t.attached).map((t) => ({ slot: t.slot, fileId: t.fileId, label: t.label, cues: t.cueCount, offsetMs: t.offsetMs })),
    currentTime: status.currentTime,
    seconds: status.seconds,
  })));
  /* What the worker wrote down during the run, read out of its own buffer
   * rather than waited for at the daemon - the buffer flushes every eight
   * seconds and a closed browser does not flush. Plans, errors and toasts. */
  const wrote = await inWorker(async () => {
    const stored = await chrome.storage.local.get("sso:trace");
    const held = Array.isArray(stored["sso:trace"]) ? stored["sso:trace"] : [];
    return held.filter((e) => ["autoAttach", "error", "said", "attach", "pageFetch"].includes(e.kind)).map((e) => {
      if (e.kind === "autoAttach") return { at: e.at, kind: e.kind, decision: e.plan?.decision, reason: e.plan?.reason || e.plan?.secondReason, own: e.plan?.own, best: e.plan?.best?.file_id, second: e.plan?.second?.file_id, skipped: e.skipped };
      if (e.kind === "said") return { at: e.at, kind: e.kind, message: e.message };
      if (e.kind === "error") return { at: e.at, kind: e.kind, message: e.message, stack: String(e.stack || "").slice(0, 200) };
      return { at: e.at, kind: e.kind, fileId: e.fileId, cueCount: e.cueCount, error: e.error, label: e.label };
    });
  });
  console.log("the worker wrote:", JSON.stringify(wrote));
} finally {
  await ctx.close();
  fs.rmSync(profile, { recursive: true, force: true });
}
