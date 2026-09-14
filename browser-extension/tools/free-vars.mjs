/* What a function in panel.js reaches for in the panel's own scope - the
 * size of the seam a split would have to cut.
 *
 *     node browser-extension/tools/free-vars.mjs buildTimeline 1507 2221
 *
 * Arguments: a name for the output, the first and last line of the function.
 * Written for docs/reports/under-the-hood-2026-09-14.md. */
import fs from "node:fs"; import path from "node:path"; import { fileURLToPath } from "node:url";
const src = fs.readFileSync(path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "src", "panel.js"), "utf8").split("\n");
const [name, from, to] = process.argv.slice(2);
const body = src.slice(from - 1, to).join("\n");
// panel-level declarations (indent 2)
const top = new Set();
for (const l of src) { const m = l.match(/^  (?:async\s+)?(?:function\s+([A-Za-z_$][\w$]*)|(?:const|let|var)\s+([A-Za-z_$][\w$]*)|(?:const|let)\s+\{([^}]*)\})/); if (m) { if (m[1]) top.add(m[1]); if (m[2]) top.add(m[2]); if (m[3]) for (const p of m[3].split(",")) top.add(p.trim().split(":").pop().trim()); } }
// identifiers used in body, minus those declared inside the body
const inner = new Set();
for (const l of body.split("\n")) { const m = l.match(/^\s{4,}(?:async\s+)?(?:function\s+([A-Za-z_$][\w$]*)|(?:const|let|var)\s+([A-Za-z_$][\w$]*))/); if (m) inner.add(m[1] || m[2]); }
const used = new Map();
for (const m of body.matchAll(/(?<![.\w$])([A-Za-z_$][\w$]*)\b/g)) { const id = m[1]; if (top.has(id) && !inner.has(id)) used.set(id, (used.get(id) || 0) + 1); }
console.log(name, "free panel-scope identifiers:", used.size);
console.log([...used.entries()].sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k}(${v})`).join(" "));
