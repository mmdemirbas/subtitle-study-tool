/* What a storage write in the worker costs a page that has nothing to do with it.
 *
 *   PLAYWRIGHT_PATH=/opt/homebrew/lib/node_modules/@playwright/mcp/node_modules \
 *     node tools/measure-storage-echo.mjs [frames=0,3] [reps=6]
 *
 * chrome.storage.onChanged hands every listener the old and the new value of
 * whatever changed, and study.js listens in every frame of every tab. Until
 * 2026-09-26 the running log rewrote one 4.8MB value on every line. If that
 * change is delivered into each frame, its cost lands on the page's own main
 * thread - where a freeze is - and not only in the worker. This measures it:
 * the unpacked extension, headless, a page of N same-origin frames, and the
 * page's main-thread time after the worker rewrites one key at each size,
 * beside a window of the same length with no write at all.
 *
 * Measured 2026-09-26, M1 Max, Playwright's Chromium headless, 6 writes each.
 * The page's content script IS handed the whole value, old and new - 3000 +
 * 3000 entries for the 4.8MB write - and it costs the page's own thread:
 *
 *   frames  write   main-thread ms per 1.5s window    longest timer wait
 *        0  1KB       3                                 3ms
 *        0  4.8MB    13                                 7ms
 *        3  none      3                                 2ms
 *        3  256KB     5                                 (one 407ms outlier)
 *        3  1MB       9                                 5ms
 *        3  4.8MB    28 (median wait 19ms)            104ms
 *
 * So the old one-array log put 10-25ms on the page per line and the odd
 * 100ms stall, growing with its size and with the page's frames; the pieces
 * (at most 256KB) cost what a 1KB write does. Two 409ms waits in small-write
 * rows did not follow the size and did not recur - the machine, not this.
 *
 * Two controls run first, because the first version of this printed a column
 * of zeroes that measured nothing: a PerformanceObserver for long tasks
 * reports nothing headless (a 120ms loop went unseen), and Playwright keeps
 * an isolated world of its own in every frame, so "the first isolated world"
 * is not the extension's.
 */
import { createRequire } from "node:module";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const EXT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const FRAMES = (process.argv[2] || "0,3").split(",").map(Number);
const REPS = Number(process.argv[3] || 6);
const SIZES = [
  ["none", 0],
  ["1KB", 1],
  ["256KB", 160],
  ["1MB", 640],
  ["4.8MB", 3000],
];
const WINDOW_MS = 1500;

const require_ = createRequire(import.meta.url);
const mod = await import(pathToFileURL(require_.resolve("playwright-core", { paths: [process.env.PLAYWRIGHT_PATH, EXT] })).href);
const chromium = mod.chromium ?? mod.default?.chromium;

const profile = mkdtempSync(path.join(tmpdir(), "sso-echo-"));
const ctx = await chromium.launchPersistentContext(profile, {
  channel: "chromium",
  headless: true,
  args: [`--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`],
});
try {
  const worker = ctx.serviceWorkers()[0] || (await ctx.waitForEvent("serviceworker", { timeout: 15000 }));
  // This profile is thrown away; its log must not land in the reader's daemon.
  await worker.evaluate(() => chrome.storage.local.set({ "sso:settings": { diagnostics: false } }));
  const page = await ctx.newPage();
  await page.route("http://echo.test/**", (route) => {
    const n = Number(new URL(route.request().url()).searchParams.get("frames") || 0);
    const body = route.request().url().includes("/frame")
      ? "<!doctype html><title>frame</title><p>frame</p>"
      : `<!doctype html><title>page</title><p>page</p>${"<iframe src='/frame'></iframe>".repeat(n)}`;
    return route.fulfill({ contentType: "text/html", body });
  });

  /* The extension's own worlds, found through the protocol: a content script
   * runs in an isolated world the page cannot see, and the only way to ask
   * whether it is there - and what the storage event hands it - is to
   * evaluate inside it, chosen by the extension's name on the main frame.
   * Playwright keeps an isolated world of its own in every frame too. */
  const cdp = await ctx.newCDPSession(page);
  const worlds = new Map();
  cdp.on("Runtime.executionContextCreated", ({ context }) => {
    if (context.auxData?.type === "isolated") worlds.set(context.id, context);
  });
  cdp.on("Runtime.executionContextDestroyed", ({ executionContextId }) => worlds.delete(executionContextId));
  cdp.on("Runtime.executionContextsCleared", () => worlds.clear());
  await cdp.send("Runtime.enable");
  await cdp.send("Performance.enable");
  const ours = async () => {
    const { frameTree } = await cdp.send("Page.getFrameTree");
    return [...worlds.values()].find((c) => c.name === "Subtitle Overlay" && c.auxData?.frameId === frameTree.frame.id);
  };
  const inWorld = async (expression) => {
    const world = await ours();
    if (!world) return "no extension world on the main frame";
    const { result, exceptionDetails } = await cdp.send("Runtime.evaluate", { expression, contextId: world.id, returnByValue: true, awaitPromise: true });
    return exceptionDetails ? `threw: ${exceptionDetails.exception?.description?.split("\n")[0]}` : result.value;
  };
  /* Main-thread time, two ways. The protocol's TaskDuration is every task the
   * renderer ran, all frames of the page included; the heartbeat is the
   * longest the page's own timer was kept waiting, which is what a freeze is
   * to the page. A long-task observer is not used: headless, it reported
   * nothing for a 120ms loop. */
  const taskSeconds = async () => (await cdp.send("Performance.getMetrics")).metrics.find((m) => m.name === "TaskDuration").value;
  const startBeat = () =>
    page.evaluate(() => {
      window.__gap = 0;
      let last = performance.now();
      clearInterval(window.__beat);
      window.__beat = setInterval(() => {
        const now = performance.now();
        window.__gap = Math.max(window.__gap, now - last - 10);
        last = now;
      }, 10);
    });
  const window_ = async (work) => {
    await startBeat();
    const before = await taskSeconds();
    await work();
    await page.waitForTimeout(WINDOW_MS);
    const task = Math.round(((await taskSeconds()) - before) * 1000);
    const gap = Math.round(await page.evaluate(() => window.__gap));
    return { task, gap };
  };

  console.log(`frames  write   main-thread ms per ${WINDOW_MS}ms window (median of ${REPS}) · longest wait of the page's timer · what the page's content script was handed`);
  for (const frames of FRAMES) {
    await page.goto(`http://echo.test/?frames=${frames}`);
    await page.waitForTimeout(3000); // the content scripts, at document_idle, in every frame

    /* Two controls before any number is believed: a task the page is known to
     * run has to show up, and the extension has to be in the page listening,
     * or a column of zeroes measures nothing. */
    const control = await window_(() => page.evaluate(() => {
      const until = performance.now() + 120;
      while (performance.now() < until);
    }));
    const listening = await inWorld(`(() => {
      window.__echo = [];
      chrome.storage.onChanged.addListener((changes) => {
        const change = changes["sso:echoProbe"];
        if (change) window.__echo.push({ newItems: change.newValue?.length ?? 0, oldItems: change.oldValue?.length ?? 0 });
      });
      return typeof window.__ssoStudy === "object" ? "study.js is here" : "study.js is NOT here";
    })()`);
    console.log(`  control: a 120ms loop read as ${control.task}ms of tasks and a ${control.gap}ms wait · ${listening}`);

    const median = (xs) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)];
    for (const [label, entries] of SIZES) {
      const per = [];
      for (let rep = 0; rep < REPS; rep++) {
        per.push(await window_(async () => {
          if (!entries) return;
          await worker.evaluate((n) => {
            const log = Array.from({ length: n }, (_, i) => ({ at: new Date().toISOString(), kind: "survey", i, pad: "x".repeat(1500) }));
            return chrome.storage.local.set({ "sso:echoProbe": log });
          }, entries);
        }));
      }
      const handed = await inWorld(`(() => { const e = window.__echo.at(-1); window.__echo.length = 0; return e ? e.newItems + " new + " + e.oldItems + " old entries" : "nothing"; })()`);
      console.log(
        `${String(frames).padStart(6)}  ${label.padEnd(6)}  ${String(median(per.map((p) => p.task))).padStart(5)}ms of tasks · ${String(median(per.map((p) => p.gap))).padStart(4)}ms wait (max ${Math.max(...per.map((p) => p.gap))}) · ${handed}`,
      );
    }
    await worker.evaluate(() => chrome.storage.local.remove("sso:echoProbe"));
  }
} finally {
  await ctx.close();
  rmSync(profile, { recursive: true, force: true });
}
