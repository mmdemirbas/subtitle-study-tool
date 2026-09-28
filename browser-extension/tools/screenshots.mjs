/* The screenshots in docs/images/, taken from the extension itself.
 *
 *   PLAYWRIGHT_PATH=/opt/homebrew/lib/node_modules/@playwright/mcp/node_modules \
 *     node tools/screenshots.mjs
 *
 * Loads the unpacked extension in Chromium, plays tools/shots/stage.html - an
 * original scene, not a film - and attaches the sample pair from
 * srt-viewer/samples/ through the worker's own "sso:attach", so the panel and
 * study mode see the tracks the way they would after a real attach. The viewer
 * shot loads the same pair into srt-viewer.html.
 *
 * Study mode's meanings come from the daemon when it is running on this
 * machine; without it the focus box says no dictionary is available, and the
 * study shots are not worth keeping.
 */
import { createRequire } from "node:module";
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseSrt } from "../src/subtitles/srt.js";

const EXT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const ROOT = path.resolve(EXT, "..");
const OUT = path.join(ROOT, "docs/images");
const SAMPLES = path.join(ROOT, "srt-viewer/samples");
const PORT = 9731;
const SIZE = { width: 1280, height: 720 };

const readSrt = (file) => parseSrt(readFileSync(path.join(SAMPLES, file), "utf8")).map((cue) => ({ start: cue.startMs, end: cue.endMs, text: cue.text }));
const english = readSrt("night-ferry-EN.srt");
const turkish = readSrt("night-ferry-TR.srt");

const require_ = createRequire(import.meta.url);
const mod = await import(pathToFileURL(require_.resolve("playwright-core", { paths: [process.env.PLAYWRIGHT_PATH, EXT] })).href);
const chromium = mod.chromium ?? mod.default?.chromium;

mkdirSync(OUT, { recursive: true });
const server = spawn("python3", [path.join(EXT, "tests", "serve.py"), String(PORT)], { cwd: EXT, stdio: "ignore" });
const profile = mkdtempSync(path.join(tmpdir(), "sso-shots-"));
await new Promise((r) => setTimeout(r, 900));
const ctx = await chromium.launchPersistentContext(profile, {
  channel: "chromium",
  headless: true,
  viewport: SIZE,
  args: [`--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`, "--autoplay-policy=no-user-gesture-required"],
});

/* Toasts are transient (TOAST_MS, ACTION_TOAST_MS in content.js); wait them
 * out rather than photograph one over the picture. */
const shot = async (page, name) => {
  await page
    .waitForFunction(() => ![...document.querySelectorAll("div")].some((d) => d.shadowRoot?.querySelector(".sso-toast")?.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true })), null, { timeout: 15000 })
    .catch(() => console.warn(`${name}: a toast was still up`));
  await page.screenshot({ path: path.join(OUT, `${name}.png`) });
  console.log("wrote", `docs/images/${name}.png`);
};
/* The overlay lives in a shadow root on a host div; the panel and the focus
 * box in their own. */
const inShadow = (page, marker, fn) =>
  page.evaluate(
    ({ marker, src }) => {
      const root = [...document.querySelectorAll("div")].find((d) => d.shadowRoot?.querySelector(marker))?.shadowRoot;
      return root ? new Function("root", src)(root) : null;
    },
    { marker, src: `return (${fn})(root);` },
  );

try {
  const sw = ctx.serviceWorkers()[0] || (await ctx.waitForEvent("serviceworker", { timeout: 15000 }));
  const page = ctx.pages()[0] || (await ctx.newPage());
  await page.goto(`http://127.0.0.1:${PORT}/tools/shots/stage.html`, { waitUntil: "load" });
  await page.waitForFunction(() => document.querySelector("video").readyState >= 1);
  await page.waitForTimeout(1000);

  const attached = await sw.evaluate(async ({ english, turkish }) => {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    const attach = (cues, label, fileId, language, slot) =>
      chrome.tabs.sendMessage(tab.id, { type: "sso:attach", payload: { cues, label, fileId, language, slot } }, { frameId: 0 });
    return [await attach(english, "night-ferry-EN.srt", 701, "en", 0), await attach(turkish, "night-ferry-TR.srt", 702, "tr", 1)];
  }, { english, turkish });
  for (const answer of attached) if (!answer?.ok) throw new Error(`attach refused: ${JSON.stringify(answer)}`);

  const seek = (seconds) =>
    page.evaluate((s) => {
      const v = document.querySelector("video");
      v.pause();
      v.currentTime = s;
    }, seconds);

  // 1. Two languages on the same clock.
  await seek(92);
  await page.waitForTimeout(1200);
  await page.mouse.move(640, 200);
  await shot(page, "two-subtitles");

  // 2. The panel, from the CC handle.
  await inShadow(page, ".sso-handle", (root) => root.querySelector(".sso-handle").click());
  await page.waitForTimeout(1200);
  await shot(page, "panel");
  await page.keyboard.press("Escape");
  await inShadow(page, ".sso-handle", (root) => root.querySelector(".sso-handle").click());
  await page.waitForTimeout(600);

  // 3. Study mode on a line with a rare word in it.
  await sw.evaluate(async () => {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    await chrome.scripting.executeScript({ target: { tabId: tab.id, frameIds: [0] }, func: () => window.__ssoApi.setStudyEnabled(true) });
  });
  await seek(196);
  await page.waitForTimeout(4000);
  await shot(page, "study");

  // 4. The viewer, with the same pair and no video.
  const viewer = await ctx.newPage();
  await viewer.goto(pathToFileURL(path.join(ROOT, "srt-viewer/srt-viewer.html")).href, { waitUntil: "load" });
  await viewer.setInputFiles("#left", path.join(SAMPLES, "night-ferry-EN.srt"));
  await viewer.setInputFiles("#right", path.join(SAMPLES, "night-ferry-TR.srt"));
  await viewer.click("#load");
  // The configuration box is open on a first visit; the rows are the picture.
  await viewer.evaluate(() => { document.querySelector("details.box").open = false; });
  await viewer.waitForTimeout(1200);
  await shot(viewer, "viewer");
} finally {
  await ctx.close();
  server.kill();
  rmSync(profile, { recursive: true, force: true });
}
