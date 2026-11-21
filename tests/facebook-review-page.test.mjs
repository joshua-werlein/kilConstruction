// Run: npm run test:site
// Wiring checks for the admin historical-photo review page. The endpoint and
// gate behaviour is tested against real local D1/R2 in
// workers/kilcon-gallery-worker/test/facebook-review.test.mjs.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const read = (p) => readFile(new URL(p, import.meta.url), "utf8");
const page = await read("../src/pages/admin/facebook-review.astro");
const script = await read("../src/pages/admin/facebook-review-script.ts");
const sync = await read("../src/pages/admin/facebook.astro");

test("the review page is admin-only", () => {
  assert.match(page, /await verifyAdminToken\(auth, ADMIN_SECRET, SESSION_VERSION\)/);
  assert.match(page, /if \(!isAdmin\) \{\s*return new Response\(null, \{ status: 302, headers: \{ Location: "\/admin" \} \}\);/);
});

test("the browser only talks to same-origin admin endpoints; no token, Graph or CDN URLs", () => {
  assert.match(page, /data-admin-api="\/api\/gallery-api\/facebook\/admin"/, "same origin, so canvas hashing works");
  for (const forbidden of [/graph\.facebook\.com/, /fbcdn/, /access_token/i, /FB_PAGE_ACCESS_TOKEN/, /https?:\/\//]) {
    assert.doesNotMatch(script.replace(/^\s*\/\/.*$/gm, ""), forbidden, String(forbidden));
  }
  for (const sub of ["review-albums", "review-album?id=", "review-image?id=", "review-site-gallery", "review-site-image?key=", "review-decisions", "review-summary"]) {
    assert.ok(script.includes(sub), sub);
  }
  assert.match(script, /credentials: "include"/);
});

test("untrusted text is never parsed as HTML", () => {
  assert.doesNotMatch(script, /innerHTML|outerHTML|insertAdjacentHTML|document\.write/);
  assert.match(script, /textContent/);
  assert.match(script, /encodeURIComponent\(a\.id\)/);
  assert.match(script, /CSS\.escape\(/);
});

test("decisions are saved as JSON batches of at most 100 and retried on failure", () => {
  assert.match(script, /api\("review-decisions", \{ method: "POST", headers: \{ "Content-Type": "application\/json" \}/);
  assert.match(script, /\.slice\(0, 100\)/);
  assert.match(script, /Retrying in 5 seconds/);
  assert.match(script, /decision: decision \|\| "clear"/, "clicking the active choice clears it");
});

test("three choices per photo; branding and already-imported photos are read-only", () => {
  assert.match(script, /\["skip", "Duplicate \/ Skip"\], \["import", "Import"\], \["later", "Review later"\]/);
  assert.match(script, /const locked = current\?\.kind === "branding" \|\| p\.state === "imported" \|\| p\.state === "hidden";/);
});

test("bulk actions only touch unreviewed photos and need a second click", () => {
  assert.match(script, /const reviewable = \(\) => current && current\.kind !== "branding" \? photos\.filter\(\(p\) => !p\.decision && !p\.state\) : \[\];/);
  assert.match(script, /Click again to confirm/);
  assert.match(script, /matches\.get\(p\.id\)\?\.level === "likely"/);
});

test("unsorted albums (Mobile uploads) are listed separately and compared with all galleries", () => {
  assert.match(page, /id="rv-list-generic"/);
  assert.match(page, /Unsorted uploads/);
  assert.match(script, /a\.kind === "generic" \? "all" : "none"/);
});

test("duplicate detection uses the shared perceptual hash on same-origin images", () => {
  assert.match(script, /import \{ dHashFromRgba, bestMatch \} from "\.\.\/\.\.\/lib\/photo-hash\.js";/);
  assert.match(script, /getImageData\(0, 0, 9, 8\)/);
  assert.match(script, /Fingerprints are a hint: look before deciding/);
});

test("the sync page links to the review page and states the import rule", () => {
  assert.match(sync, /href="\/admin\/facebook-review"/);
  assert.match(sync, /only photos marked <strong>Import<\/strong>/);
  assert.match(sync, /New posts on the Page still import automatically/);
});

test("rate-limited image requests back off and retry instead of failing the review", () => {
  assert.match(script, /if \(res\.status === 429\) \{ await sleep\(\(Number\(res\.headers\.get\("Retry-After"\)\) \|\| 10\) \* 1000\); continue; \}/);
  assert.match(script, /return null; \/\/ not remembered: retried the next time the album is opened/);
  assert.match(script, /retryingImg\(\{ src: fbImage\(p\.id\)/);
});

// --- layout regression (2026-11-21): the page's scoped <style> never matched
// the album rows, cards and badges that the script creates, so they rendered
// unstyled (album names and counts ran together, no selection highlight).
const styleBlocks = [...page.matchAll(/<style\b([^>]*)>([\s\S]*?)<\/style>/g)];
const css = styleBlocks.map((m) => m[2]).join("\n");

test("review styles are global (script-created elements need them) and namespaced under #rv-root", () => {
  assert.ok(styleBlocks.length >= 1);
  for (const [, attrs] of styleBlocks) assert.match(attrs, /\bis:global\b/, "no scoped <style> blocks on this page");
  const selectors = css.replace(/\/\*[\s\S]*?\*\//g, "").replace(/@media[^{]+\{/g, "").split("}")
    .map((r) => r.split("{")[0].trim()).filter(Boolean);
  for (const sel of selectors) for (const part of sel.split(",")) {
    assert.match(part.trim(), /^#rv-root\b/, `selector must be namespaced: ${part.trim()}`);
  }
  assert.match(css, /#rv-root \[hidden\] \{ display: none !important; \}/, "global display rules must not unhide [hidden]");
});

test("every class the script assigns has a style rule", async () => {
  const adminCss = await read("../src/styles/admin.css");
  const used = new Set();
  // class: "a b" literals, class: `rv-badge ${cls}`, classList.add/remove("x"), and badge levels.
  for (const m of script.matchAll(/class: [`"]([^`"]+)[`"]/g)) m[1].replace(/\$\{[^}]*\}/g, " ").split(/\s+/).forEach((c) => c && used.add(c));
  for (const m of script.matchAll(/classList\.(?:add|remove|toggle)\("([^"]+)"\)/g)) used.add(m[1]);
  if (/rv-badge--\$\{m\.level\}/.test(script)) { used.add("rv-badge--likely"); used.add("rv-badge--possible"); }
  assert.ok(used.has("rv-row") && used.has("rv-row-name") && used.has("rv-card"), "scanner sanity check");
  for (const cls of used) {
    if (!cls.startsWith("rv-")) { assert.ok(adminCss.includes(`.${cls}`), `admin.css defines .${cls}`); continue; }
    assert.ok(new RegExp(`\.${cls}(?![a-z-])`).test(css), `page CSS defines .${cls}`);
  }
});

test("album rows: separate clickable rows with name, counts, progress and a selected state", () => {
  assert.match(script, /class: "rv-row", "data-album": a\.id/);
  assert.match(script, /el\("span", \{ class: "rv-row-name" \}, a\.name\)/);
  assert.match(script, /el\("span", \{ class: "rv-row-meta" \}\)/);
  assert.match(script, /el\("progress", \{ class: "rv-row-progress"/);
  assert.match(script, /btn\.setAttribute\("aria-current", "true"\)/);
  assert.match(css, /#rv-root \.rv-row\[aria-current="true"\] \{[^}]*box-shadow/);
  assert.match(css, /#rv-root \.rv-row-meta \{ display: flex;/, "counts on their own line, never run into the name");
  assert.match(css, /#rv-root \.rv-row:focus-visible/);
});

test("album list scrolls independently; workspace uses the remaining width", () => {
  assert.match(css, /#rv-root \.rv-albums \{\s*position: sticky;[^}]*max-height: calc\(100vh - 7rem\);[^}]*overflow-y: auto;/);
  assert.match(css, /#rv-root \.rv-layout \{ display: grid; grid-template-columns: minmax\(240px, 300px\) minmax\(0, 1fr\);/);
  assert.match(css, /#rv-root \.rv-columns \{ display: grid; grid-template-columns: minmax\(0, 3fr\) minmax\(0, 2fr\);/);
  assert.match(page, /<AdminLayout wide /, "wide admin card on this page");
});

test("only the review page opts into the wide admin card", async () => {
  const layout = await read("../src/layout/AdminLayout.astro");
  const adminCss = await read("../src/styles/admin.css");
  assert.match(layout, /wide = false,/);
  assert.match(layout, /class=\{wide \? "admin-card admin-card--wide" : "admin-card"\}/);
  assert.match(adminCss, /\.admin-card \{\s*width: 100%;\s*max-width: 900px;/, "default card unchanged");
  assert.match(adminCss, /\.admin-card--wide \{\s*max-width: min\(1680px, 100%\);\s*text-align: left;/);
  const { readdir } = await import("node:fs/promises");
  const pages = (await readdir(new URL("../src/pages/admin/", import.meta.url))).filter((f) => f.endsWith(".astro"));
  for (const f of pages) {
    const src = await read(`../src/pages/admin/${f}`);
    assert.equal(/<AdminLayout\b[^>]*\bwide\b/.test(src), f === "facebook-review.astro", f);
  }
});

test("empty state until an album is selected", () => {
  assert.match(page, /<section id="rv-empty"[^>]*>\s*<h2 class="rv-empty-title">Select an album to begin<\/h2>/);
  assert.match(page, /<section id="rv-album"[^>]*hidden>/);
  assert.match(script, /emptyEl\.hidden = true;\s*albumEl\.hidden = false;/);
});

test("responsive: single column with a scrollable album list on phones", () => {
  assert.match(css, /@media \(max-width: 1200px\) \{\s*#rv-root \.rv-columns \{ grid-template-columns: minmax\(0, 1fr\); \}/);
  assert.match(css, /@media \(max-width: 860px\) \{[\s\S]*#rv-root \.rv-layout \{ grid-template-columns: minmax\(0, 1fr\); \}[\s\S]*#rv-root \.rv-albums \{ position: static; max-height: 45vh; \}/);
  assert.match(script, /window\.matchMedia\("\(max-width: 860px\)"\)\.matches/);
});
