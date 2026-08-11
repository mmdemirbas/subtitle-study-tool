/* Render icons/icon.svg to the PNG sizes Chrome asks for.
 *
 *   node tools/build-icons.mjs
 *
 * Chrome will scale one PNG to every size it needs, and the result at 16px is
 * a blur - which is the size that decides whether the extension can be found
 * in a toolbar. So each size is rendered from the vector at its own scale.
 *
 * Rendered through headless Chromium rather than a raster library: it is the
 * renderer that will actually draw this, there is no image dependency to add
 * for four files that change once a year, and Playwright is already here for
 * the test harness.
 */
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));

/* Resolved rather than imported, because this repository has no node_modules
 * and is not getting one for a script that runs when the icon changes. Point
 * PLAYWRIGHT_PATH at any checkout that has playwright-core, or run it from
 * one:
 *
 *   PLAYWRIGHT_PATH=~/somewhere/node_modules node tools/build-icons.mjs
 */
const require_ = createRequire(import.meta.url);
const search = [process.env.PLAYWRIGHT_PATH, process.cwd(), here].filter(Boolean);
let chromium;
try {
  const mod = await import(pathToFileURL(require_.resolve("playwright-core", { paths: search })).href);
  chromium = (mod.chromium ?? mod.default?.chromium);
  if (!chromium) throw new Error("playwright-core resolved but has no chromium export");
} catch {
  console.error(
    "playwright-core is not resolvable from here.\n" +
      "The PNGs in icons/ are committed, so this is only needed to regenerate them:\n" +
      "  npm i playwright-core   (anywhere)\n" +
      "  PLAYWRIGHT_PATH=<that>/node_modules node tools/build-icons.mjs",
  );
  process.exit(1);
}

const icons = path.join(here, "..", "icons");
const svg = fs.readFileSync(path.join(icons, "icon.svg"), "utf8");
const SIZES = [16, 32, 48, 128];

const browser = await chromium.launch({ channel: "chromium", headless: true });
const page = await browser.newPage({ deviceScaleFactor: 1 });

for (const size of SIZES) {
  // Transparent behind it, or every rounded corner comes out with a white
  // wedge in it against a dark toolbar.
  await page.setContent(
    `<html><body style="margin:0;background:transparent">` +
      svg.replace(/width="128" height="128"/, `width="${size}" height="${size}"`) +
      `</body></html>`,
    { waitUntil: "load" },
  );
  await page.setViewportSize({ width: size, height: size });
  const shot = await page.locator("svg").screenshot({ omitBackground: true });
  fs.writeFileSync(path.join(icons, `icon-${size}.png`), shot);
  console.log(`icons/icon-${size}.png  ${shot.length} bytes`);
}

await browser.close();
