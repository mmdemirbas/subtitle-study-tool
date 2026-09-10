/* The harness page, driven by a real mouse and keyboard.
 *
 *   PLAYWRIGHT_PATH=/opt/homebrew/lib/node_modules/@playwright/mcp \
 *     node tests/realinput.mjs
 *
 * Everything in harness.html dispatches its own events, and for almost every
 * question that is the right instrument: it is fast, it runs in one page, and
 * the browser treats a dispatched click as a click. It is the wrong instrument
 * for exactly two things, and both were reported as bugs the suite was green
 * on:
 *
 * - Pointer capture. A synthetic pointer id cannot be captured, so a dispatched
 *   dblclick reached the subtitle's name whatever the card's drag handler had
 *   captured. Through Chromium's own input pipeline the press WAS captured,
 *   the click was delivered to the card instead of the name, and "double-click
 *   the name to replace it" did nothing on any panel with two subtitles - the
 *   panel most readers have.
 * - Key events across a shadow boundary as the page sees them. A dispatched
 *   key from inside the shadow root is not the same event sequence the
 *   browser generates from a keypress, and a player listening on the document
 *   in the capture phase hears the real one first.
 *
 * So this opens the same page with ?manual - set up, nothing running - and
 * asks those two questions with page.mouse and page.keyboard. Small on
 * purpose: everything that CAN be asked from inside the page is asked there.
 */

import { spawn } from "node:child_process";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const EXT = path.resolve(here, "..");
const PORT = Number(process.argv[2] || 9641);
const require_ = createRequire(import.meta.url);
const mod = await import(
  pathToFileURL(require_.resolve("playwright-core", { paths: [process.env.PLAYWRIGHT_PATH, EXT] })).href
);
const chromium = mod.chromium ?? mod.default?.chromium;

const results = [];
const t = (name, ok, detail = "") => results.push({ name, ok: Boolean(ok), detail });

const server = spawn("python3", [path.join(EXT, "tests", "serve.py"), String(PORT)], { cwd: EXT, stdio: "ignore" });
await new Promise((r) => setTimeout(r, 800));
const browser = await chromium.launch({ channel: "chromium", headless: true });
const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
page.on("pageerror", (e) => console.log("PAGEERROR", e.message));

/* The panel's shadow root is found by what is in it, not by which host it is:
 * the harness has several windows and their order is not a promise. */
const panel = () =>
  page.evaluate(() => {
    const host = [...document.querySelectorAll("div")].find((d) => d.shadowRoot?.querySelector(".sso-track__label"));
    return host ? host.shadowRoot.querySelector(".sso-win__title").textContent : null;
  });

try {
  await page.goto(`http://127.0.0.1:${PORT}/tests/harness.html?manual`, { waitUntil: "domcontentloaded" });
  await page.waitForFunction(() => document.querySelector("#summary")?.textContent === "manual", null, { timeout: 30000 });

  // --- a real double-click on the name, with two subtitles attached ----------
  await page.evaluate(async () => {
    const api = window.__ssoApi;
    await api.attach({ cues: [{ start: 500, end: 4000, text: "one" }], label: "EN · One", fileId: 771, language: "en", slot: 0 });
    await api.attach({ cues: [{ start: 500, end: 4000, text: "iki" }], label: "TR · Two", fileId: 772, language: "tr", slot: 1 });
    await window.__ssoPanel.show();
  });
  await page.waitForTimeout(400);
  const name = await page.evaluate(() => {
    const host = [...document.querySelectorAll("div")].find((d) => d.shadowRoot?.querySelector(".sso-track__label"));
    const shadow = host.shadowRoot;
    shadow.querySelector(".sso-panel__back")?.click();
    const cards = [...shadow.querySelectorAll(".sso-track")].filter((c) => !c.hidden);
    const r = cards[0].querySelector(".sso-track__label").getBoundingClientRect();
    return { x: r.left + Math.min(20, r.width / 2), y: r.top + r.height / 2, cards: cards.length };
  });
  t("two subtitles are on the panel", name.cards === 2, `${name.cards} cards`);
  const before = await panel();
  await page.mouse.dblclick(name.x, name.y);
  await page.waitForTimeout(300);
  const after = await panel();
  t(
    "a real double-click on the name asks for a different subtitle, with two attached",
    /find/i.test(after || ""),
    `"${before}" -> "${after}"`,
  );
  // And a real single click still only selects: back on the root, click once.
  await page.evaluate(() => {
    const host = [...document.querySelectorAll("div")].find((d) => d.shadowRoot?.querySelector(".sso-track__label"));
    host.shadowRoot.querySelector(".sso-panel__back")?.click();
  });
  await page.waitForTimeout(200);
  await page.mouse.click(name.x, name.y);
  await page.waitForTimeout(300);
  t("a real single click on the name does not leave the subtitles", !/find/i.test((await panel()) || ""), await panel());

  // --- a real space in the search box, with a player listening ---------------
  /* The page stands in for the player: it listens on the document in BOTH
   * phases and on the window in the bubble phase, and counts every key event
   * that reaches it. A player that pauses on space does so from one of these. */
  await page.evaluate(() => {
    window.__heard = [];
    const note = (where) => (event) => window.__heard.push(`${where}:${event.type}`);
    for (const type of ["keydown", "keyup", "keypress"]) {
      document.addEventListener(type, note("document-capture"), true);
      document.addEventListener(type, note("document-bubble"), false);
      window.addEventListener(type, note("window-bubble"), false);
    }
  });
  await page.evaluate(async () => {
    const host = [...document.querySelectorAll("div")].find((d) => d.shadowRoot?.querySelector(".sso-track__label"));
    const shadow = host.shadowRoot;
    // Open Find and put the caret in the box.
    [...shadow.querySelectorAll(".sso-track")].filter((c) => !c.hidden)[0].querySelector(".sso-track__label")
      .dispatchEvent(new MouseEvent("dblclick", { bubbles: true, composed: true }));
    await new Promise((r) => setTimeout(r, 200));
    shadow.querySelector("input[placeholder]").focus();
  });
  await page.keyboard.type("monk ");
  await page.keyboard.press("Space");
  await page.waitForTimeout(150);
  const typed = await page.evaluate(() => {
    const host = [...document.querySelectorAll("div")].find((d) => d.shadowRoot?.querySelector(".sso-track__label"));
    return {
      value: host.shadowRoot.querySelector("input[placeholder]").value,
      heard: window.__heard.filter((h) => !/keypress/.test(h)),
    };
  });
  t("the space is typed into the box", typed.value === "monk  ", JSON.stringify(typed.value));
  t(
    "and the player hears none of the keys typed into it",
    typed.heard.length === 0,
    typed.heard.length ? `heard ${[...new Set(typed.heard)].join(", ")}` : "",
  );

  /* The guard is only for a field. A key with a panel BUTTON focused still
   * reaches the document, which is how the nudge bindings in content.js hear
   * it. That is the other half of the contract and it has to stay true. */
  await page.evaluate(() => {
    window.__heard = [];
    const host = [...document.querySelectorAll("div")].find((d) => d.shadowRoot?.querySelector(".sso-track__label"));
    host.shadowRoot.querySelector(".sso-panel__back").focus();
  });
  await page.keyboard.press("KeyJ");
  await page.waitForTimeout(100);
  const onButton = await page.evaluate(() => window.__heard);
  t("a key on a focused panel button still reaches the document", onButton.some((h) => h === "document-capture:keydown"), onButton.join(", "));
} finally {
  await browser.close();
  server.kill();
}

const passed = results.filter((r) => r.ok).length;
for (const r of results) console.log(`${r.ok ? "PASS" : "FAIL"} - ${r.name}${r.detail && !r.ok ? `\n       ${r.detail}` : ""}`);
console.log(`${passed}/${results.length} passed`);
process.exit(passed === results.length ? 0 : 1);
