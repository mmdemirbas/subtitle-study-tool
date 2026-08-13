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
            overlay: seen.overlay,
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
  /* Longer than the rest, because this is the cold one: the extension has to
   * install, the frame has to pull a video file over a socket, and the roles
   * are settled by a tick that is deliberately slow with nothing attached.
   * Measured: this assertion failed on roughly one run in three at 8s. The
   * failure detail carries hasVideo and isSubject, so a recurrence says
   * whether the wait was the problem or the video was. */
  let seen =
    (await until(async () => {
      await wake();
      const all = await frames();
      const inner = all.find((f) => f.frameId !== 0 && !f.absent);
      return inner?.surfaces?.length ? all : null;
    }, 20000)) ?? (await frames());
  const top = seen.find((f) => f.frameId === 0);
  const player = seen.find((f) => f.frameId !== 0 && !f.absent);

  t("the vehicle really is two frames with the video in the nested one",
    Boolean(top && player) && top.isTopFrame && !player.isTopFrame && player.hasVideo && !top.hasVideo,
    JSON.stringify(seen.map((f) => ({ id: f.frameId, top: f.isTopFrame, video: f.hasVideo }))));

  t("the cue overlay is built where the video is",
    has(player, "sso-root"),
    JSON.stringify({
      surfaces: player?.surfaces ?? null,
      hasVideo: player?.hasVideo,
      isSubject: player?.isSubject,
      overlay: player?.overlay,
    }));

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

  /* --- what is written down while nobody is asking ------------------------
   *
   * The panel opening is the moment the shape of the page is worth keeping:
   * three documents, one cross-origin, and which of them holds the film
   * decides everything. Recorded then rather than when somebody thinks to
   * press a diagnostic button, because by then the player has often navigated.
   */
  const traceLog = async () =>
    sw.evaluate(async () => {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      const [{ result }] = await chrome.scripting.executeScript({
        target: { tabId: tab.id, frameIds: [0] },
        func: () => chrome.runtime.sendMessage({ type: "sso:daemon", op: "traceLog", args: {} }),
      });
      return result?.entries || [];
    });

  const panelTrace = await until(async () => {
    const log = await traceLog();
    return log.filter((entry) => entry.kind === "panel").pop() || null;
  }, 6000);
  t("opening the panel writes down what the page looked like",
    Boolean(panelTrace) &&
      (panelTrace.frames || []).length >= 2 &&
      panelTrace.frames.some((f) => f.report?.frameRole === "chrome") &&
      panelTrace.frames.some((f) => f.report?.frameRole === "video"),
    JSON.stringify(
      (panelTrace?.frames || []).map((f) => ({ id: f.frameId, role: f.report?.frameRole })),
    ),
  );

  /* And the one that makes a failed alignment reproducible. Two subtitles are
   * pushed into the frame with the film, then lined up from the frame with the
   * controls - which is also the forwarding path under a second name. */
  await sw.evaluate(async (frameId) => {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    const cues = (count, step, from) =>
      Array.from({ length: count }, (_, i) => ({
        start: from + i * step,
        end: from + i * step + 900,
        text: `line ${i}`,
      }));
    await chrome.tabs.sendMessage(
      tab.id,
      { type: "sso:attach", payload: { cues: cues(60, 1000, 0), label: "EN test", fileId: 101, language: "en", slot: 0 } },
      { frameId },
    );
    await chrome.tabs.sendMessage(
      tab.id,
      { type: "sso:attach", payload: { cues: cues(60, 1000, 4000), label: "TR test", fileId: 102, language: "tr", slot: 1 } },
      { frameId },
    );
  }, playerFrameId);
  await page.waitForTimeout(600);
  await pressInTopFrame("autoAlign", [1, {}]);

  const alignTrace = await until(async () => {
    const log = await traceLog();
    return log.filter((entry) => entry.kind === "align").pop() || null;
  }, 6000);
  t("and every attempt to line two subtitles up keeps both files' timings",
    Boolean(alignTrace) &&
      (alignTrace.tracks || []).length === 2 &&
      alignTrace.tracks.every(
        (track) =>
          Array.isArray(track.times) &&
          track.times.length === 60 &&
          // The ends too: they are what the aligner is not given today and what
          // a better one would need, so a log without them is not reusable.
          Array.isArray(track.ends) &&
          track.ends.length === 60,
      ) &&
      typeof alignTrace.answer?.verdict === "string",
    JSON.stringify({
      verdict: alignTrace?.answer?.verdict,
      shiftMs: alignTrace?.answer?.shiftMs,
      kept: (alignTrace?.tracks || []).map(
        (x) => `${x.language}: ${x.times?.length} starts, ${x.ends?.length} ends`,
      ),
    }),
  );

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

  /* --- fullscreen, which undoes everything above ---------------------------
   *
   * Only the fullscreen element's subtree is painted and only it is given
   * pointer events, so while the player's frame is fullscreen nothing the top
   * document draws can be pressed - and the site's overlay is not on screen
   * either, which was the whole reason to be up there. So the controls go back
   * to the film's frame, and the site keeps the fullscreen session it asked
   * for.
   *
   * Both halves are checked, because the extension used to answer "an <iframe>
   * is fullscreen" by requesting fullscreen on that iframe's PARENT. That is a
   * race with the site's own session, and measured over six runs of this
   * vehicle it went the extension's way four times and the site's way twice -
   * and on the two where the site won there was no pressable control anywhere
   * on the page. Which is exactly the report: everything works until you go
   * fullscreen. */
  await page.goto(`http://127.0.0.1:${TOP_PORT}/tests/frames/top.html?playerPort=${PLAYER_PORT}&depth=2`, {
    waitUntil: "domcontentloaded",
  });
  await page.waitForTimeout(400);
  await until(async () => {
    await wake();
    const all = await frames();
    return all.find((f) => f.frameId === 0)?.surfaces?.length ? all : null;
  });

  const film = page.frames().find((f) => f.url().includes("player.html"));
  await film.evaluate(() => {
    /* What a player's own fullscreen button does: its container, not the
     * <video>, from inside the frame the video is in. */
    const go = document.createElement("button");
    go.id = "sso-test-fs";
    go.style.cssText = "position:fixed;left:2px;top:2px;z-index:9";
    go.addEventListener("click", () => document.getElementById("v").parentElement.requestFullscreen?.());
    document.body.appendChild(go);
  });
  await film.click("#sso-test-fs");
  await page.waitForTimeout(1200);
  await wake();

  const heldBy = await page.evaluate(() =>
    document.fullscreenElement
      ? `${document.fullscreenElement.tagName}${document.fullscreenElement.id ? "#" + document.fullscreenElement.id : ""}`
      : "none",
  );
  t("the site keeps the fullscreen session it asked for",
    heldBy === "IFRAME#player",
    `the top document's fullscreen element is ${heldBy}`);

  /* Every surface in every frame, so "is there a way in" is asked of the page
   * rather than of a frame chosen in advance. */
  const pressable = async (label) =>
    sw.evaluate(async (want) => {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      const all = await chrome.webNavigation.getAllFrames({ tabId: tab.id });
      for (const f of all) {
        const seen = await chrome.tabs
          .sendMessage(tab.id, { type: "sso:diagnose" }, { frameId: f.frameId })
          .catch(() => null);
        for (const surface of seen?.surfaces || []) {
          const hit = (surface.targets || []).find(
            (x) => x.label === want && x.rendered !== false && x.reachable,
          );
          if (hit) return { frameId: f.frameId, at: hit.at };
        }
      }
      return null;
    }, label);

  /* Generous, and it has to be: entering fullscreen is a role change that
   * crosses the worker twice, and the tick that notices it is the slow one.
   * The detail names every frame's role and whether its overlay was built and
   * parented, because "nothing is pressable" on its own cannot tell a frame
   * that never took the job from one that took it and drew nothing. */
  const ccInFullscreen = await until(async () => {
    await wake();
    return pressable("Subtitle controls");
  }, 20000);
  t("there is still a button that can be pressed once the player is fullscreen",
    Boolean(ccInFullscreen),
    ccInFullscreen
      ? `frame ${ccInFullscreen.frameId}`
      : JSON.stringify(
          (await frames()).map((f) => ({
            id: f.frameId,
            video: f.hasVideo,
            subject: f.isSubject,
            overlay: f.overlay,
            surfaces: f.surfaces,
          })),
        ));

  /* And the end of it, as a reader performs it: press the button, press
   * something on what opens. A hit test is not a click - the first version of
   * this check watched for the panel's host rather than its box and reported
   * a press as landing when nothing had happened. */
  if (ccInFullscreen) {
    await page.mouse.click(ccInFullscreen.at[0], ccInFullscreen.at[1]);
    await page.waitForTimeout(900);
    const close = await until(async () => pressable("Close"), 4000);
    t("pressing it opens a panel there that answers its own controls",
      Boolean(close) && close.frameId === ccInFullscreen.frameId,
      JSON.stringify({ cc: ccInFullscreen.frameId, panel: close?.frameId ?? null }));
  } else {
    t("pressing it opens a panel there that answers its own controls", false, "no button to press");
  }

  /* --- and leaving fullscreen has to bring it back out of the player --------
   *
   * Reported as: open the panel in fullscreen, leave fullscreen, and the panel
   * is stuck inside the player's rectangle and clipped at its edges, so it
   * cannot be dragged anywhere else.
   *
   * The panel above was built in the FILM's frame, which is correct while that
   * frame is fullscreen - it stops claiming the subject, so it draws its own
   * controls. Leaving fullscreen hands the controls back to the top frame and
   * the panel stayed where it was built: inside an iframe, which is one box in
   * its parent's layout and cannot paint outside it. Nothing about z-index or
   * the top layer can lift it out, because the top layer is per document.
   *
   * So the assertion is WHICH FRAME the panel is in afterwards, not whether one
   * exists. Before the fix a panel was still pressable here, in frame 2, which
   * is exactly the complaint rather than the absence of one. */
  if (ccInFullscreen) {
    await page.evaluate(() => document.exitFullscreen?.().catch(() => {}));
    await page.waitForTimeout(1200);
    const backOut = await until(async () => {
      await wake();
      const seen = await pressable("Close");
      // Wait for it to have MOVED, not merely to exist: the panel the film's
      // frame drew is still there for a moment while the roles change hands.
      return seen && seen.frameId === 0 ? seen : null;
    }, 20000);
    const stillInside = backOut ? null : await pressable("Close");
    t("leaving fullscreen brings the panel back out of the player's frame",
      Boolean(backOut),
      backOut
        ? "panel is in the top frame"
        : stillInside
          ? `panel is still in frame ${stillInside.frameId}, where it is clipped`
          : "no panel anywhere after leaving fullscreen");
  } else {
    t("leaving fullscreen brings the panel back out of the player's frame", false,
      "never got a panel in fullscreen to bring back");
  }

  /* --- and the switch that has to reach the film from wherever it is thrown --
   *
   * Reported as "I cannot see the study panel". Study is one setting shared by
   * the whole browser, but study.js runs in every frame and each keeps its own
   * copy, so "shared" was only true at load. Thrown in a frame with no subtitle
   * in it - the top one, which is where the panel is, or whichever has focus
   * when the key is pressed - it set enabled=true there, built nothing, and
   * said "Study mode on" anyway.
   *
   * Measured on this vehicle before the fix, in fullscreen: the top frame read
   * on=true and the film's frame read on=false, and there was no rail in any of
   * the three documents. So the assertion is the RAIL, in the frame that has
   * the film, from a switch thrown somewhere else - not the flag, which is
   * exactly what was already true while nothing appeared. */
  const studyState = async () =>
    sw.evaluate(async () => {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      const all = await chrome.webNavigation.getAllFrames({ tabId: tab.id });
      const out = [];
      for (const f of all) {
        const got = await chrome.scripting
          .executeScript({
            target: { tabId: tab.id, frameIds: [f.frameId] },
            func: () => {
              let rail = null;
              for (const node of document.querySelectorAll("*")) {
                const first = node.shadowRoot?.firstElementChild;
                if (typeof first?.className === "string" && first.className.includes("sso-rail")) {
                  const box = node.getBoundingClientRect();
                  rail = [Math.round(box.width), Math.round(box.height)];
                }
              }
              return {
                on: Boolean(window.__ssoStudy?.settings?.().enabled),
                attached: Boolean(window.__ssoApi?.status?.().attached),
                rail,
              };
            },
          })
          .catch(() => null);
        if (got?.[0]?.result) out.push({ frameId: f.frameId, ...got[0].result });
      }
      return out;
    });

  /* A subtitle first: study reads cues, so with nothing attached it correctly
   * builds nothing and this would assert against the wrong reason. The page was
   * navigated for the fullscreen section above, which detached what the earlier
   * section attached. */
  const filmFrameId = (await studyState()).at(-1)?.frameId;
  await sw.evaluate(async (frameId) => {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    const cues = Array.from({ length: 40 }, (_, i) => ({
      start: i * 1000,
      end: i * 1000 + 900,
      text: `the quixotic ephemeral line ${i}`,
    }));
    await chrome.tabs.sendMessage(
      tab.id,
      { type: "sso:attach", payload: { cues, label: "EN study", fileId: 909, language: "en", slot: 0 } },
      { frameId },
    );
  }, filmFrameId);
  await page.waitForTimeout(500);

  await sw.evaluate(async () => {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    await chrome.scripting.executeScript({
      target: { tabId: tab.id, frameIds: [0] },
      func: () => window.__ssoApi?.setStudyEnabled?.(true),
    });
  });

  const studyReached = await until(async () => {
    await wake();
    const all = await studyState();
    const film = all.find((f) => f.attached);
    return film?.on && film.rail && film.rail[0] > 0 ? all : null;
  }, 15000);
  t("study switched on away from the film still builds the rail where the film is",
    Boolean(studyReached),
    JSON.stringify(await studyState()));

  /* And whether a press on it is ours, with the site painting over everything.
   *
   * This is the one surface that cannot be moved to the top frame - the rail
   * needs the cue text, and the cue text is where the film is - so it is the
   * only one still exposed to a parent-document overlay. docs/reports/
   * click-blocking-2026-08-08.md established the mechanism and could not
   * observe it end to end.
   *
   * It has to be a real click from the TOP document, and that is the whole
   * subtlety. Asking the film's frame whether its own rail is reachable gives a
   * false pass every time: document.elementsFromPoint inside a frame knows
   * nothing about a box in its PARENT, so the frame reports itself unobstructed
   * while the parent takes the press. The counter in top.html is the witness -
   * it counts what the interceptor swallows - so a click that never reaches it
   * is a click the rail got.
   */
  if (studyReached) {
    const railAt = await (async () => {
      const film = page.frames().find((f) => f.url().includes("player.html"));
      const inside = await film.evaluate(() => {
        for (const node of document.querySelectorAll("*")) {
          const first = node.shadowRoot?.firstElementChild;
          if (typeof first?.className === "string" && first.className.includes("sso-rail")) {
            const box = node.getBoundingClientRect();
            return { x: box.left + box.width / 2, y: box.top + 8 };
          }
        }
        return null;
      });
      if (!inside) return null;
      // boundingBox resolves through however many frames deep this is, which
      // the vehicle varies on purpose (?depth=2).
      const frameBox = await (await film.frameElement()).boundingBox();
      return frameBox ? { x: frameBox.x + inside.x, y: frameBox.y + inside.y } : null;
    })();

    await page.evaluate(() => { window.__intercept(true); window.__stolen = 0; });
    await page.waitForTimeout(200);
    if (railAt) await page.mouse.click(railAt.x, railAt.y);
    await page.waitForTimeout(300);
    const stolen = await page.evaluate(() => window.__stolen);
    await page.evaluate(() => window.__intercept(false));
    /* KNOWN GAP, recorded rather than asserted away.
     *
     * This press IS swallowed today, and that is the honest state of the
     * product: every other surface was moved to the top frame, and the rail
     * cannot follow while it reads cue text out of the frame the film is in.
     * The report called it open; this is the first time it has been observed
     * rather than argued from the platform's rules.
     *
     * It is written as "still swallowed" so the suite stays green on today's
     * behaviour AND fails the moment that changes - including when somebody
     * fixes it, at which point this becomes `stolen === 0` and the name loses
     * its KNOWN GAP. A check that simply failed would be a red suite nobody
     * reads, and deleting it would lose the only evidence there is.
     *
     * It does not fire on the site that prompted it: streaming-site.example no longer
     * paints such an overlay, so the reader sees no symptom. The exposure is
     * to the class of page, not to that page.
     */
    t("KNOWN GAP - a press on the study rail is still taken by a full-viewport page overlay",
      Boolean(railAt) && stolen > 0,
      railAt
        ? `swallowed ${stolen} at ${Math.round(railAt.x)},${Math.round(railAt.y)}` +
          (stolen === 0 ? " - IT IS FIXED: invert this check and rename it" : "")
        : "could not find the rail to press");
  } else {
    t("KNOWN GAP - a press on the study rail is still taken by a full-viewport page overlay",
      false, "no rail was built to press");
  }

  // And off again, so the ordinary-page section below starts where it expects.
  await sw.evaluate(async () => {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    await chrome.scripting.executeScript({
      target: { tabId: tab.id, frameIds: [0] },
      func: () => window.__ssoApi?.setStudyEnabled?.(false),
    });
  });
  await page.waitForTimeout(400);

  await page.evaluate(() => document.exitFullscreen?.()).catch(() => {});
  await page.waitForTimeout(600);

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
