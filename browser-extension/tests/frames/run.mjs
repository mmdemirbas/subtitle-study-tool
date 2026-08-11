/* Where the extension draws when the video is in a cross-origin frame.
 *
 *   node tests/frames/run.mjs            (from browser-extension/)
 *
 * The fourth check, and the only one that runs the real extension in a real
 * browser. The other three cannot ask this question at all: harness.html and
 * fallback.html are single documents, and worker.mjs stubs the browser away -
 * so everything about nested frames, cross-origin players and a parent page
 * painting over the player has been checked by hand until now, which means it
 * has mostly not been checked.
 *
 * Two ports, because two ports are two origins. A same-origin iframe would
 * miss the whole point: the extension can reach across a same-origin boundary
 * and cannot reach across this one.
 *
 * Needs playwright-core, which this repository does not depend on. Point
 * PLAYWRIGHT_PATH at any checkout that has it:
 *
 *   PLAYWRIGHT_PATH=~/somewhere/node_modules node tests/frames/run.mjs
 */
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const EXT = path.resolve(here, "..", "..");
const TOP_PORT = 9481;
const PLAYER_PORT = 9482;

const require_ = createRequire(import.meta.url);
let chromium;
try {
  const where = [process.env.PLAYWRIGHT_PATH, process.cwd(), here].filter(Boolean);
  const mod = await import(pathToFileURL(require_.resolve("playwright-core", { paths: where })).href);
  chromium = mod.chromium ?? mod.default?.chromium;
  if (!chromium) throw new Error("no chromium export");
} catch {
  console.error(
    "playwright-core is not resolvable from here. This check needs a real browser:\n" +
      "  npm i playwright-core   (anywhere)\n" +
      "  PLAYWRIGHT_PATH=<that>/node_modules node tests/frames/run.mjs",
  );
  process.exit(2);
}

const results = [];
const t = (name, ok, detail = "") => results.push({ name, ok: Boolean(ok), detail });

const servers = [TOP_PORT, PLAYER_PORT].map((port) =>
  spawn("python3", [path.join(EXT, "tests", "serve.py"), String(port)], {
    cwd: EXT,
    stdio: "ignore",
  }),
);
await new Promise((r) => setTimeout(r, 900));

const profile = fs.mkdtempSync(path.join(os.tmpdir(), "ssoframes-"));
const ctx = await chromium.launchPersistentContext(profile, {
  channel: "chromium",
  headless: true,
  viewport: null,
  args: [`--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`, "--window-size=1400,860"],
});

try {
  const sw = ctx.serviceWorkers()[0] || (await ctx.waitForEvent("serviceworker", { timeout: 15000 }));
  const page = ctx.pages()[0] || (await ctx.newPage());

  /* Every frame's own account of itself, gathered through the worker. The
   * content scripts are in the isolated world, so nothing the page evaluates
   * can see them; sso:diagnose is the surface built for exactly this. */
  const frames = async () =>
    sw.evaluate(async () => {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      const all = await chrome.webNavigation.getAllFrames({ tabId: tab.id });
      const out = [];
      for (const f of all) {
        try {
          const seen = await chrome.tabs.sendMessage(tab.id, { type: "sso:diagnose" }, { frameId: f.frameId });
          out.push({
            frameId: f.frameId,
            url: f.url,
            isTopFrame: seen.isTopFrame,
            hasVideo: seen.hasPlayableVideo,
            isSubject: seen.isPageSubject,
            surfaces: (seen.surfaces || []).map((s) => s.surface),
          });
        } catch {
          out.push({ frameId: f.frameId, url: f.url, absent: true });
        }
      }
      return out;
    });

  /* A surface is reported by the class list of the shadow root's first child,
   * so ".sso-win sso-panel" is one surface with two classes. Matching on the
   * whole string missed the panel entirely the first time this ran. */
  const has = (frame, name) =>
    Boolean(frame?.surfaces?.some((s) => s.split(/\s+/).includes(name)));
  const wake = async () => {
    // The CC handle only appears with pointer movement, by design.
    await page.mouse.move(600, 400);
    await page.mouse.move(640, 420);
    await page.waitForTimeout(700);
  };

  /* Poll to a deadline rather than sleeping a guessed interval.
   *
   * A fixed wait here is a coin toss on a cold profile: the extension has to
   * install, the frame has to load a video file over a socket, and the frame
   * roles are settled by a tick that is deliberately slow when there is
   * nothing attached. Measured: the same assertion failed on the first run of
   * a fresh profile and passed on both repeats. */
  const until = async (what, ms = 8000) => {
    const deadline = Date.now() + ms;
    for (;;) {
      const seen = await what();
      if (seen) return seen;
      if (Date.now() > deadline) return null;
      await page.waitForTimeout(200);
    }
  };

  // ---------------------------------------------------------------- nested --
  await page.goto(`http://127.0.0.1:${TOP_PORT}/tests/frames/top.html?playerPort=${PLAYER_PORT}`, {
    waitUntil: "domcontentloaded",
  });
  await page.waitForTimeout(400);

  /* The pointer move is what builds anything, and it only counts once the
   * video is loadable - so keep moving until something is drawn rather than
   * moving once and hoping the file arrived first. */
  let seen =
    (await until(async () => {
      await wake();
      const all = await frames();
      const inner = all.find((f) => f.frameId !== 0 && !f.absent);
      return inner?.surfaces?.length ? all : null;
    })) ?? (await frames());
  const top = seen.find((f) => f.frameId === 0);
  const player = seen.find((f) => f.frameId !== 0 && !f.absent);

  t("the vehicle really is two frames with the video in the nested one",
    Boolean(top && player) && top.isTopFrame && !player.isTopFrame && player.hasVideo && !top.hasVideo,
    JSON.stringify(seen.map((f) => ({ id: f.frameId, top: f.isTopFrame, video: f.hasVideo }))));

  t("the cue overlay is built where the video is",
    has(player, "sso-root"),
    `player frame surfaces: [${player?.surfaces?.join(", ") ?? "-"}]`);

  /* The four below are the point of the exercise. A surface drawn inside the
   * player's frame cannot out-rank anything the top document paints over that
   * frame - the top layer is per document - so the chrome has to be built in
   * the top frame when the video is not there.
   *
   * The CC button is not a surface of its own; it lives in the overlay host's
   * shadow root beside the cue boxes, so it is found among that surface's
   * targets. Which is the better question anyway: a button that exists and
   * cannot be pressed is the defect, not the absence of one. */
  const ccButton = async (frameId) =>
    sw.evaluate(async (id) => {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      const seen = await chrome.tabs.sendMessage(tab.id, { type: "sso:diagnose" }, { frameId: id });
      for (const surface of seen.surfaces || []) {
        const cc = (surface.targets || []).find((x) => x.label === "Subtitle controls");
        if (cc) return { surface: surface.surface, ...cc };
      }
      return { none: true, surfaces: (seen.surfaces || []).map((x) => x.surface) };
    }, frameId);

  let cc = (await until(async () => {
    const seen = await ccButton(0);
    return seen.none ? null : seen;
  })) ?? (await ccButton(0));
  t("the CC handle is drawn in the top frame, where the video is not",
    !cc.none && cc.rendered !== false && cc.reachable,
    JSON.stringify(cc));

  /* And the whole reason it is up there. With the site's overlay on, a button
   * drawn inside the player's frame is behind a box in this document and the
   * press is the site's. One drawn here is not. */
  await page.evaluate(() => window.__intercept(true));
  await wake();
  cc = await ccButton(0);
  t("and it can still be pressed through the page's own full-viewport overlay",
    !cc.none && cc.rendered !== false && cc.reachable,
    JSON.stringify(cc));
  await page.evaluate(() => window.__intercept(false));

  await sw.evaluate(async () => {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    /* Through the worker's own command path, not addressed by hand: which
     * frame the panel opens in is part of what is being checked, and the
     * worker decides that from tabStatus. Injected into a frame because the
     * worker does not receive its own runtime messages - this is the popup's
     * route, from a real content-script context. */
    await chrome.scripting.executeScript({
      target: { tabId: tab.id, frameIds: [0] },
      func: () => chrome.runtime.sendMessage({ type: "sso:command", command: "toggle-panel" }),
    });
  });
  await page.waitForTimeout(900);
  seen = await frames();

  t("the control panel opens in the top frame",
    has(seen.find((f) => f.frameId === 0), "sso-panel"),
    `top frame surfaces: [${seen.find((f) => f.frameId === 0)?.surfaces?.join(", ") ?? "-"}]`);

  /* And it has to know something. The panel opening in the top frame is only
   * half of it: that frame has no video, so its own status says hasVideo
   * false, the empty state reads "No video on this page" and even the button
   * that would find a subtitle is hidden. A surface that takes clicks and
   * knows nothing is not better than one that knows everything and takes
   * none. */
  const state = await sw.evaluate(async () => {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    return chrome.tabs.sendMessage(tab.id, { type: "sso:status" }, { frameId: 0 });
  });
  t("the top frame knows there is a video, and where the film is up to",
    state?.hasVideo === true && Number.isFinite(state?.duration),
    JSON.stringify({ hasVideo: state?.hasVideo, duration: state?.duration,
                     currentTime: state?.currentTime }));

  /* And the end of it: with the site painting over everything, is a press on
   * the panel still ours? Asked of the top document the way a click is. */
  await page.evaluate(() => window.__intercept(true));
  await page.waitForTimeout(200);
  const reach = await sw.evaluate(async () => {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    const seen = await chrome.tabs.sendMessage(tab.id, { type: "sso:diagnose" }, { frameId: 0 });
    const panel = (seen.surfaces || []).find((s) => s.surface.split(/\s+/).includes("sso-panel"));
    if (!panel) return { none: true };
    const drawn = (panel.targets || []).filter((x) => x.rendered !== false);
    return {
      total: drawn.length,
      reachable: drawn.filter((x) => x.reachable).length,
      covered: drawn.filter((x) => !x.reachable).map((x) => `${x.label}: ${(x.coveredBy || [])[0]}`),
    };
  });
  t("its controls are reachable through the page's own full-viewport overlay",
    !reach.none && reach.total > 0 && reach.reachable === reach.total,
    JSON.stringify(reach));
  await page.evaluate(() => window.__intercept(false));

  await page.evaluate(() => window.__intercept(false));

  /* --- and the other direction: does a press up here reach the film? -------
   *
   * Everything above is about being seen and being clickable. This is the half
   * that makes the button worth pressing: the panel is in a document with no
   * video in it, so every control on it has to act on one somewhere else.
   * Asked through executeScript because __ssoApi lives in the isolated world,
   * which is where a content script's own call would come from. */
  const pressInTopFrame = async (method, args) =>
    sw.evaluate(async ([m, a]) => {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      const [{ result }] = await chrome.scripting.executeScript({
        target: { tabId: tab.id, frameIds: [0] },
        func: (method, args) => Boolean(window.__ssoApi?.[method]?.(...args)) || true,
        args: [m, a],
      });
      return result;
    }, [method, args]);

  const playerFrameId = player.frameId;
  const playerSays = async () =>
    sw.evaluate(async (id) => {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      return chrome.tabs.sendMessage(tab.id, { type: "sso:status" }, { frameId: id });
    }, playerFrameId);

  await pressInTopFrame("setVisible", [false]);
  const hidden = await until(async () => ((await playerSays())?.visible === false ? true : null), 3000);
  await pressInTopFrame("setVisible", [true]);
  const shown = await until(async () => ((await playerSays())?.visible === true ? true : null), 3000);
  t("a control pressed in the top frame acts on the video in the other one",
    Boolean(hidden && shown),
    JSON.stringify({ hidden: Boolean(hidden), shown: Boolean(shown) }));

  /* --- the two ways this arrangement goes stale ---------------------------- */

  /* Reloading the extension replaces the top frame's script under an open tab,
   * and the replacement starts out knowing nothing. Without the push learning
   * it was dropped, the page would be left with no button at all and nothing
   * to put one back. */
  await sw.evaluate(async () => {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    await chrome.scripting.executeScript({
      target: { tabId: tab.id, frameIds: [0] },
      files: ["src/align.js", "src/content.js", "src/panel.js", "src/study.js"],
    });
  });
  const returned = await until(async () => {
    // Keep the pointer moving: the button fades after 2.6s of stillness, by
    // design, and a poll that only looks would be racing that timer.
    await wake();
    const seen = await ccButton(0);
    return seen.none || !seen.reachable ? null : seen;
  }, 12000);
  t("the button comes back when the top frame's script is replaced under it",
    Boolean(returned),
    JSON.stringify(returned ?? (await ccButton(0))));

  /* And the reverse: the site tears the player out, or navigates it away. The
   * button must not outlive the film - a control that opens a panel reporting
   * a video that is not there is worse than no control. */
  await page.evaluate(() => document.getElementById("player").remove());
  /* On the role, not on whether the button can be clicked. It fades on its own
   * after 2.6 seconds of stillness, so "not reachable" would pass with the
   * whole arrangement still in place and nothing having noticed - which is
   * what the first draft of this check measured. */
  const roleIn = async (frameId) =>
    sw.evaluate(async (id) => {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      const seen = await chrome.tabs
        .sendMessage(tab.id, { type: "sso:diagnose" }, { frameId: id })
        .catch(() => null);
      return seen?.frameRole ?? "absent";
    }, frameId);

  const wentAway = await until(async () => {
    await wake();
    return (await roleIn(0)) === "solo" ? true : null;
  }, 10000);
  t("and the top frame stops being the controls when the video's frame goes",
    Boolean(wentAway),
    `top frame role: ${await roleIn(0)}`);

  // ------------------------------------------------------- the ordinary page --
  /* Nothing above may cost anything on a page whose video IS in the top frame,
   * which is most of them. Same page, opened directly. */
  await page.goto(`http://127.0.0.1:${PLAYER_PORT}/tests/frames/player.html`, {
    waitUntil: "domcontentloaded",
  });
  await page.waitForTimeout(400);
  seen =
    (await until(async () => {
      await wake();
      const all = await frames();
      return all.find((f) => f.frameId === 0)?.surfaces?.length ? all : null;
    })) ?? (await frames());
  const only = seen.find((f) => f.frameId === 0);

  t("a video in the top frame still draws everything in that one frame",
    Boolean(only) && only.isTopFrame && only.hasVideo && has(only, "sso-root"),
    JSON.stringify({ frames: seen.length, surfaces: only?.surfaces }));
  t("and there is no second frame doing anything",
    seen.filter((f) => !f.absent).length === 1,
    `${seen.length} frame(s)`);
} finally {
  await ctx.close();
  fs.rmSync(profile, { recursive: true, force: true });
  for (const s of servers) s.kill();
}

for (const r of results) console.log(r.ok ? "PASS" : "FAIL", "-", r.name, r.ok ? "" : `→ ${r.detail}`);
const passed = results.filter((r) => r.ok).length;
console.log(`\n${passed}/${results.length} passed`);
process.exit(passed === results.length ? 0 : 1);
