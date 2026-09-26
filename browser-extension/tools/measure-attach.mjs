/* What attaching two subtitles costs the page's own thread, and where it goes.
 *
 *   PLAYWRIGHT_PATH=/opt/homebrew/lib/node_modules/@playwright/mcp/node_modules \
 *     node tools/measure-attach.mjs [reps=3]
 *
 * The extension's perf lines put every long task of the last evening at the
 * moment subtitles attached - 263, 141 and 262ms - and the sampler times
 * none of what an attach does in the page: the aligner, the cue index, the
 * map, study mode's marks. This replays an attach of a real pair (the
 * repo's Battlestar Galactica EN and TR, the Turkish shifted 2.5s with every
 * fourth line dropped, so the two read as different releases) in the
 * extension's own world on tests/frames/player.html, with study mode on, and
 * reports the page's main-thread time, the longest its timer waited, and the
 * functions the time went to, from a CPU profile of that page.
 *
 * Headless Chromium. A long-task observer is blind there (see
 * measure-storage-echo.mjs), so the time comes from the protocol.
 *
 * Measured 2026-09-26, M1 Max, 1154 EN against 856 TR cues, three runs:
 *
 *                                       align.js on the page   in the worker
 *   the page's timer, longest wait            86-96ms              1-14ms
 *   sampled in the extension's scripts        89-102ms             1-4ms
 *   main-thread tasks in the window           125-182ms            29-67ms
 *
 * With the aligner on the page, all but a few milliseconds of the attach was
 * align.js (nearestOffset, windowOffset). The attach still takes ~85ms to
 * finish, now waiting on the worker rather than holding the page.
 */
import { createRequire } from "node:module";
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseSrt } from "../src/subtitles/srt.js";

const EXT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const ROOT = path.resolve(EXT, "..");
const REPS = Number(process.argv[2] || 3);
const PORT = 9691;
const FILM = "srt-viewer/subtitles/Battlestar.Galactica.Miniseries.S00E01.2003.1080p.BluRay";

/* Read with the extension's own parser, so the cues are the ones it would
 * attach. A hand-rolled one turned the Turkish file's eleven "00:41:23,***"
 * stamps into NaN, which the worker rightly refused, and the page aligned
 * locally - a profile of the tool's bug rather than the extension. */
const readSrt = (file) => parseSrt(readFileSync(file, "utf8")).map((cue) => ({ start: cue.startMs, end: cue.endMs, text: cue.text }));
const english = readSrt(path.join(ROOT, `${FILM}-EN.srt`));
const turkish = readSrt(path.join(ROOT, `${FILM}-TR-gpt5-thinking-web.srt`))
  .filter((_, i) => i % 4 !== 3)
  .map((cue) => ({ ...cue, start: cue.start + 2500, end: cue.end + 2500 }));

const require_ = createRequire(import.meta.url);
const mod = await import(pathToFileURL(require_.resolve("playwright-core", { paths: [process.env.PLAYWRIGHT_PATH, EXT] })).href);
const chromium = mod.chromium ?? mod.default?.chromium;
const server = spawn("python3", [path.join(EXT, "tests", "serve.py"), String(PORT)], { cwd: EXT, stdio: "ignore" });
const profile = mkdtempSync(path.join(tmpdir(), "sso-attach-"));
await new Promise((r) => setTimeout(r, 800));
const ctx = await chromium.launchPersistentContext(profile, {
  channel: "chromium",
  headless: true,
  args: [`--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`, "--autoplay-policy=no-user-gesture-required"],
});
try {
  const worker = ctx.serviceWorkers()[0] || (await ctx.waitForEvent("serviceworker", { timeout: 15000 }));
  // A thrown-away profile: its log must not land in the reader's daemon.
  await worker.evaluate(() => chrome.storage.local.set({ "sso:settings": { diagnostics: false } }));
  const page = await ctx.newPage();
  const cdp = await ctx.newCDPSession(page);
  const worlds = new Map();
  cdp.on("Runtime.executionContextCreated", ({ context }) => {
    if (context.auxData?.type === "isolated") worlds.set(context.id, context);
  });
  cdp.on("Runtime.executionContextDestroyed", ({ executionContextId }) => worlds.delete(executionContextId));
  cdp.on("Runtime.executionContextsCleared", () => worlds.clear());
  await cdp.send("Runtime.enable");
  await cdp.send("Performance.enable");
  await cdp.send("Profiler.enable");
  await cdp.send("Profiler.setSamplingInterval", { interval: 200 });

  await page.goto(`http://127.0.0.1:${PORT}/tests/frames/player.html`);
  await page.waitForFunction(() => document.querySelector("video")?.readyState >= 1, null, { timeout: 15000 });
  await page.waitForTimeout(3000); // the content scripts, at document_idle

  const inWorld = async (expression) => {
    const { frameTree } = await cdp.send("Page.getFrameTree");
    const world = [...worlds.values()].find((c) => c.name === "Subtitle Overlay" && c.auxData?.frameId === frameTree.frame.id);
    if (!world) throw new Error("no extension world on the page");
    const { result, exceptionDetails } = await cdp.send("Runtime.evaluate", { expression, contextId: world.id, returnByValue: true, awaitPromise: true });
    if (exceptionDetails) throw new Error(exceptionDetails.exception?.description || exceptionDetails.text);
    return result.value;
  };
  const metrics = async () => Object.fromEntries((await cdp.send("Performance.getMetrics")).metrics.map((m) => [m.name, m.value]));

  await inWorld(`(async () => { await window.__ssoApi.setStudyEnabled?.(true); return true; })()`);
  await page.waitForTimeout(1500);
  await inWorld(`window.__sso_cues = ${JSON.stringify({ english, turkish })}; true`);
  console.log(`attaching ${english.length} EN then ${turkish.length} TR cues, study on, ${REPS} times`);

  for (let rep = 0; rep < REPS; rep++) {
    await inWorld(`(async () => { for (const s of [1, 0]) if (window.__ssoApi.status().tracks[s]?.attached) window.__ssoApi.detach(s); return true; })()`);
    await page.waitForTimeout(1000);
    await page.evaluate(() => {
      window.__gap = 0;
      let last = performance.now();
      clearInterval(window.__beat);
      window.__beat = setInterval(() => {
        const now = performance.now();
        window.__gap = Math.max(window.__gap, now - last - 10);
        last = now;
      }, 10);
    });
    const before = await metrics();
    await cdp.send("Profiler.start");
    /* A new file id each run: the extension keeps the offset it found per
     * file, and a file it has timed before is not aligned again. */
    const calls = await inWorld(`(async () => {
      const api = window.__ssoApi, t = performance.now();
      await api.attach({ cues: window.__sso_cues.english, label: "EN · measure", fileId: ${91001 + rep * 10}, language: "en", slot: 0 });
      const first = performance.now() - t;
      await api.attach({ cues: window.__sso_cues.turkish, label: "TR · measure", fileId: ${91002 + rep * 10}, language: "tr", slot: 1 });
      return { first: Math.round(first), second: Math.round(performance.now() - t - first), offsetMs: api.status().tracks[1].offsetMs };
    })()`);
    await page.waitForTimeout(3000); // marks and whatever else settles after
    const { profile: cpu } = await cdp.send("Profiler.stop");
    const after = await metrics();
    const gap = Math.round(await page.evaluate(() => window.__gap));
    const d = (k) => Math.round((after[k] - before[k]) * 1000);

    // Self time per function, from the samples.
    const byId = new Map(cpu.nodes.map((n) => [n.id, n]));
    const self = new Map();
    cpu.samples.forEach((id, i) => {
      const n = byId.get(id);
      const f = n.callFrame;
      const where = f.url ? `${f.url.split("/").pop()}:${f.lineNumber + 1}` : "";
      const key = `${f.functionName || "(anonymous)"} ${where}`.trim();
      self.set(key, (self.get(key) || 0) + (cpu.timeDeltas[i] || 0) / 1000);
    });
    const ours = [...self].filter(([k]) => /\.js:\d+$/.test(k) && /(content|panel|study|align)\.js/.test(k)).reduce((s, [, ms]) => s + ms, 0);
    console.log(
      `\nrun ${rep + 1}: attach EN ${calls.first}ms, TR ${calls.second}ms (TR offset ${calls.offsetMs}ms) · ` +
        `tasks ${d("TaskDuration")}ms, script ${d("ScriptDuration")}ms, layout ${d("LayoutDuration")}ms, style ${d("RecalcStyleDuration")}ms · ` +
        `longest timer wait ${gap}ms · sampled in content scripts ${Math.round(ours)}ms`,
    );
    for (const [key, ms] of [...self].sort((a, b) => b[1] - a[1]).slice(0, 10)) console.log(`  ${ms.toFixed(1).padStart(7)}ms  ${key}`);

    /* Who called the extension's heaviest code: the stack under the samples
     * spent in our files, grouped by the first caller outside align.js. */
    const parent = new Map();
    for (const n of cpu.nodes) for (const c of n.children || []) parent.set(c, n.id);
    const callers = new Map();
    cpu.samples.forEach((id, i) => {
      let n = byId.get(id);
      if (!/(content|panel|study|align)\.js/.test(n.callFrame.url)) return;
      const chain = [];
      for (let at = id; at && chain.length < 12; at = parent.get(at)) {
        const f = byId.get(at).callFrame;
        if (f.url) chain.push(`${f.functionName || "(anonymous)"}@${f.url.split("/").pop()}:${f.lineNumber + 1}`);
      }
      const outside = chain.filter((c) => !c.includes("align.js")).slice(0, 3).join(" < ") || "(align.js only)";
      callers.set(outside, (callers.get(outside) || 0) + (cpu.timeDeltas[i] || 0) / 1000);
    });
    for (const [chain, ms] of [...callers].sort((a, b) => b[1] - a[1]).slice(0, 5)) console.log(`  caller ${ms.toFixed(1).padStart(6)}ms  ${chain}`);
  }
} finally {
  await ctx.close();
  server.kill();
  rmSync(profile, { recursive: true, force: true });
}
