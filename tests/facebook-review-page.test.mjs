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
