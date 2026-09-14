/* What the source is made of: every top-level definition under src/, its
 * length, the ones over 80 lines, the ones nothing else names, and the ones
 * only a test names. Plus timers, listeners and layout reads per big file.
 *
 *     node browser-extension/tools/survey-code.mjs
 *
 * Written for docs/reports/under-the-hood-2026-09-14.md. A name counted once
 * is defined and never used; twice with the second in tests/ is test-only. */
import fs from "node:fs"; import path from "node:path"; import { fileURLToPath } from "node:url";
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const files = [];
(function walk(d) { for (const f of fs.readdirSync(d)) { const p = path.join(d, f); if (fs.statSync(p).isDirectory()) { if (!/node_modules|fixtures|bench|tools/.test(p)) walk(p); } else if (/\.(m?js|html)$/.test(f)) files.push(p); } })(path.join(root, "src"));
(function walk(d) { for (const f of fs.readdirSync(d)) { const p = path.join(d, f); if (fs.statSync(p).isDirectory()) walk(p); else if (/\.(m?js|html)$/.test(f)) files.push(p); } })(path.join(root, "tests"));
const src = Object.fromEntries(files.map((f) => [f, fs.readFileSync(f, "utf8")]));
const all = Object.values(src).join("\n");
// functions per file with length
const long = []; const defs = [];
for (const f of files.filter((f) => f.startsWith(root + "/src"))) {
  const lines = src[f].split("\n");
  const re = /^(\s*)(?:export\s+)?(?:async\s+)?function\s+([A-Za-z_$][\w$]*)\s*\(|^(\s*)(?:export\s+)?const\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?(?:\([^)]*\)|[A-Za-z_$][\w$]*)\s*=>/;
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(re); if (!m) continue;
    const indent = (m[1] ?? m[3]).length; const name = m[2] ?? m[4];
    // find end: next line with same indent starting with '}' or ');'
    let j = i + 1; for (; j < lines.length; j++) { const l = lines[j]; if (l.trim() && l.search(/\S/) <= indent && /^[\s]*[}\)]/.test(l)) break; }
    const len = j - i + 1; defs.push({ f, name, i: i + 1, len });
    if (len > 80) long.push({ f, name, i: i + 1, len });
  }
}
long.sort((a, b) => b.len - a.len);
console.log("== functions > 80 lines:", long.length);
for (const l of long.slice(0, 40)) console.log(String(l.len).padStart(5), path.basename(l.f) + ":" + l.i, l.name);
// dead: name referenced only once across src+tests
const counts = {}; for (const d of defs) { const re = new RegExp("\\b" + d.name.replace(/\$/g, "\\$") + "\\b", "g"); counts[d.name] = (all.match(re) || []).length; }
const dead = defs.filter((d) => counts[d.name] <= 1);
console.log("\n== defined and referenced nowhere else (src+tests):", dead.length);
for (const d of dead) console.log(path.basename(d.f) + ":" + d.i, d.name, "len", d.len);
const testOnly = defs.filter((d) => { const inSrc = (Object.entries(src).filter(([f]) => f.includes("/src/")).map(([, s]) => s).join("\n").match(new RegExp("\\b" + d.name + "\\b", "g")) || []).length; return inSrc === 1 && counts[d.name] > 1; });
console.log("\n== referenced only from tests:", testOnly.length);
for (const d of testOnly) console.log(path.basename(d.f) + ":" + d.i, d.name, "len", d.len);
// misc counts
for (const f of ["src/content.js", "src/panel.js", "src/study.js"]) {
  const s = src[root + "/" + f];
  console.log("\n==", f, "setInterval", (s.match(/setInterval\(/g) || []).length, "setTimeout", (s.match(/setTimeout\(/g) || []).length, "addEventListener", (s.match(/addEventListener\(/g) || []).length, "removeEventListener", (s.match(/removeEventListener\(/g) || []).length, "TODO/FIXME", (s.match(/TODO|FIXME|XXX|HACK/g) || []).length, "functions", defs.filter((d) => d.f.endsWith(f)).length, "requestAnimationFrame", (s.match(/requestAnimationFrame\(/g) || []).length, "getBoundingClientRect", (s.match(/getBoundingClientRect\(/g) || []).length);
}
