// What a captureStream() does when its element gets a new src: the events
// on the stream and its tracks, and the level read off the first track, a
// source on the whole stream, and the track added last. Silent:
// --disable-audio-output, never --mute-audio.
//
//   PLAYWRIGHT_PATH=<dir with playwright-core> node tools/capture-track/run.mjs
import { spawn } from "node:child_process";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";
const here = path.dirname(fileURLToPath(import.meta.url));
const EXT = path.resolve(here, "../..");  // browser-extension/
const require_ = createRequire(import.meta.url);
const mod = await import(pathToFileURL(require_.resolve("playwright-core", { paths: [process.env.PLAYWRIGHT_PATH] })).href);
const chromium = mod.chromium ?? mod.default?.chromium;
const PORT = 9681;
const server = spawn("python3", [path.join(EXT, "tests", "serve.py"), String(PORT)], { cwd: EXT, stdio: "ignore" });
await new Promise((r) => setTimeout(r, 1000));
const browser = await chromium.launch({ channel: "chromium", headless: true, ignoreDefaultArgs: ["--mute-audio"], args: ["--disable-audio-output", "--autoplay-policy=no-user-gesture-required"] });
try {
  const page = await browser.newPage();
  await page.goto(`http://127.0.0.1:${PORT}/tools/capture-track/page.html`);
  await page.waitForFunction(() => window.R?.samples?.length > 8, null, { timeout: 15000 });
  await page.evaluate(() => { R.events.push({ t: Math.round(performance.now()), what: "SWITCH" }); const v = document.getElementById("v"); v.src = "/tests/frames/clip.mp4?restarted"; v.play(); });
  await page.waitForTimeout(4000);
  const out = await page.evaluate(() => ({ events: R.events, samples: R.samples.filter((_, i) => i % 2 === 0) }));
  for (const e of out.events) console.log("EVENT", JSON.stringify(e));
  for (const s of out.samples) console.log("SAMPLE", JSON.stringify(s));
} finally { await browser.close(); server.kill(); }
