/* Whether a page's film can be seeked by writing the element's clock.
 *
 *   node tools/probe-seek.mjs <url>        (from browser-extension/)
 *
 * The overlay steps a line by writing `video.currentTime`. A stream produced
 * as it is sent cannot be seeked that way at all: the write comes back as 0 on
 * the next read, with `seeking` and `seeked` fired to say it happened, and the
 * film carries on from the start of the stream. That is what this asks a page.
 *
 * Measured against the local player on 2026-08-23, remuxing a .mkv:
 * `seekable` [0, 0], `buffered` [0.08, 8.02], and all three writes below -
 * backwards inside the buffer, forwards past it, backwards past zero - read
 * back 0. A page in that state needs `data-sso-seek="film"` and an `sso:seek`
 * listener; see the README's timing contract.
 *
 * Needs a real Chrome for the codecs a film uses:
 *   PLAYWRIGHT_PATH=/opt/homebrew/lib/node_modules/@playwright/mcp/node_modules \
 *     node tools/probe-seek.mjs http://localhost:5173/title/tt4331672
 */
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";

const url = process.argv[2];
if (!url) {
  console.error("usage: node tools/probe-seek.mjs <url>");
  process.exit(2);
}
const require_ = createRequire(import.meta.url);
const mod = await import(
  pathToFileURL(require_.resolve("playwright-core", { paths: [process.env.PLAYWRIGHT_PATH] })).href
);
const chromium = mod.chromium ?? mod.default?.chromium;

const browser = await chromium.launch({
  channel: "chrome",
  headless: false,
  args: ["--autoplay-policy=no-user-gesture-required", "--mute-audio"],
});
const page = await (await browser.newContext({ viewport: { width: 1280, height: 800 } })).newPage();
await page.goto(url, { waitUntil: "domcontentloaded" });
await page.waitForSelector("video", { timeout: 30000 });

const read = () =>
  page.evaluate(() => {
    const v = document.querySelector("video");
    const ranges = (r) => Array.from({ length: r.length }, (_, i) => [+r.start(i).toFixed(2), +r.end(i).toFixed(2)]);
    const offset = Number(v.dataset.ssoTimeOffset ?? NaN);
    return {
      element: +v.currentTime.toFixed(2),
      offset: Number.isFinite(offset) ? offset : null,
      film: +(v.currentTime + (Number.isFinite(offset) ? offset : 0)).toFixed(2),
      duration: Number.isFinite(v.duration) ? +v.duration.toFixed(2) : v.duration,
      seekable: ranges(v.seekable),
      buffered: ranges(v.buffered),
      asks: v.dataset.ssoSeek ?? null,
    };
  });

/* One click in the middle of the picture, which is what "play" means nearly
 * everywhere. A page that wants something else can be started by hand while
 * this waits. */
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
if (!started) {
  /* Nothing below means anything against an element with no film in it: a
   * write to a clock that is not running is just a number being remembered. */
  console.log("VERDICT the film never started - start it by hand and run this again");
  await browser.close();
  process.exit(1);
}
/* Far enough in that a step backwards is a real ask. A stream that has only
 * been open two seconds clamps every backwards write to zero, and a write that
 * asks for where the film already is proves nothing either way. */
await page
  .waitForFunction(() => (document.querySelector("video")?.currentTime ?? 0) >= 8, null, { timeout: 30000 })
  .catch(() => {});
console.log("state", JSON.stringify(await read()));

const tried = [];
for (const [name, delta] of [["backwards, inside the buffer", -3], ["forwards, past the buffer", 25], ["backwards, past its start", -60]]) {
  const before = await read();
  // What the element would do with it anyway, so the read-back is comparable.
  const asked = Math.max(0, before.element + delta);
  const seen = await page.evaluate(async (t) => {
    const v = document.querySelector("video");
    const events = [];
    const on = (n) => () => events.push(n);
    const a = on("seeking"), b = on("seeked");
    v.addEventListener("seeking", a);
    v.addEventListener("seeked", b);
    v.currentTime = t;
    const immediate = +v.currentTime.toFixed(2);
    await new Promise((r) => setTimeout(r, 2500));
    v.removeEventListener("seeking", a);
    v.removeEventListener("seeked", b);
    return { immediate, events };
  }, asked);
  const took = Math.abs(seen.immediate - asked) <= 1;
  // A write that asks for where the film already is says nothing about seeking.
  if (Math.abs(asked - before.element) > 0.5) tried.push(took);
  console.log("write", JSON.stringify({ name, asked: +asked.toFixed(2), readBack: seen.immediate, took, events: seen.events, after: await read() }));
  await page.waitForTimeout(1200);
}

const state = await read();
console.log(
  !tried.length
    ? "VERDICT nothing could be asked for - the stream was too short to step in"
    : tried.every(Boolean)
    ? "VERDICT the element seeks - the overlay can step a line by writing the clock"
    : state.asks === "film"
      ? "VERDICT the element refuses, and the page says it takes asks - the overlay will ask"
      : "VERDICT the element refuses and the page says nothing - this page needs data-sso-seek",
);
await browser.close();
