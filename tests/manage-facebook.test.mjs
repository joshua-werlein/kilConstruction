// Run: npm run test:site
// Facebook galleries in Manage Images (/admin/manage): helper logic and page
// wiring. The API behaviour is tested against real local D1/R2 in
// workers/kilcon-gallery-worker/test/facebook.test.mjs ("Manage Images: ...").
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import {
  PURGE_PHRASE, PURGE_BATCH, UPDATE_BATCH, actionTargets, chunk, facebookGalleries,
  matchesSearch, moveTargets, photoState, purgeConfirmed, safeAdminPath,
} from "../src/lib/manage-facebook.js";

const read = (p) => readFile(new URL(p, import.meta.url), "utf8");
const page = await read("../src/pages/admin/manage.astro");
const script = await read("../src/pages/admin/manage-facebook.ts");
const manualScript = await read("../src/pages/admin/manage-script.ts");
const worker = await read("../workers/kilcon-gallery-worker/src/facebook.js");
const code = (s) => s.replace(/^\s*\/\/.*$/gm, "");

const overview = {
  projects: [
    { id: 1, slug: "ganz-garage", name: "Ganz Garage", kind: "project", category: "projects", hidden: false, linkedPrefix: null, photoCount: 15, visibleCount: 15, publicPath: "/projects/ganz-garage" },
    { id: 2, slug: "recent", name: "Recent Project Updates", kind: "recent", category: "projects", hidden: false, linkedPrefix: null, photoCount: 3, visibleCount: 2, publicPath: "/projects/recent" },
    { id: 3, slug: "pfaffe", name: "Pfaffe", kind: "project", category: "remodels", hidden: false, linkedPrefix: "Remodels/Pfaffe/", photoCount: 4, visibleCount: 4, publicPath: null },
    { id: 4, slug: "old", name: "Old Job", kind: "project", category: "furniture", hidden: true, linkedPrefix: null, photoCount: 1, visibleCount: 0, publicPath: "/services/furniture/old" },
    { id: 0, name: "bad" }, null,
  ],
};

test("Facebook galleries are listed with a Facebook badge, category and where they appear", () => {
  const g = facebookGalleries(overview);
  assert.deepEqual(g.map((x) => x.id), [1, 2, 3, 4], "invalid rows dropped");
  assert.deepEqual([g[0].badge, g[0].category, g[0].publicPath, g[0].where], ["Facebook", "Projects", "/projects/ganz-garage", "Shown at /projects/ganz-garage"]);
  assert.deepEqual([g[1].badge, g[1].category], ["Facebook · Recent updates", "Recent Project Updates"]);
  assert.deepEqual([g[2].where, g[2].publicPath, g[2].category], ["Shown inside the manual gallery Remodels/Pfaffe", null, "Remodels"]);
  assert.deepEqual([g[3].where, g[3].publicPath, g[3].hidden], ["Hidden from the website", null, true]);
  assert.ok(matchesSearch(g[0], "GANZ") && matchesSearch(g[0], "facebook") && matchesSearch(g[2], "remodels/pfaffe"));
  assert.ok(!matchesSearch(g[0], "pfaffe") && matchesSearch(g[0], "  "));
  assert.deepEqual(facebookGalleries({}), []);
  assert.equal(facebookGalleries({ projects: [{ id: 9, name: "x", publicPath: "javascript:alert(1)" }] })[0].publicPath, null, "only site paths are linked");
});

test("photo states and which photos each action changes", () => {
  const visible = { photoId: "1", status: "imported", hidden: false };
  const hidden = { photoId: "2", status: "imported", hidden: true };
  const removed = { photoId: "3", status: "imported", hidden: true, removedOnFacebook: true, deleteAfter: "2026-12-20" };
  const deleted = { photoId: "4", status: "imported", hidden: false, deleted: true };
  const failed = { photoId: "5", status: "failed", hidden: false };
  assert.deepEqual([visible, hidden, removed, deleted, failed].map((p) => photoState(p).key), ["visible", "hidden", "removed", "deleted", "failed"]);
  assert.match(photoState(removed).label, /deletion scheduled/);
  assert.deepEqual(actionTargets([visible, hidden, removed, deleted, failed]), {
    hide: ["1", "5"],
    restore: ["2"], // photos removed on Facebook can't be restored here (the Worker refuses too)
    move: ["1", "2", "3", "5"],
    purge: ["1", "2", "3", "5"],
    highlightOn: ["1", "2", "3", "5"],
    highlightOff: [],
  });
  assert.deepEqual(actionTargets([{ ...visible, highlight: true }, { ...deleted, highlight: true }]).highlightOff, ["1"], "deleted photos are left alone");
  assert.deepEqual(actionTargets(null), { hide: [], restore: [], move: [], purge: [], highlightOn: [], highlightOff: [] });
});

test("move targets exclude the current gallery; permanent deletion needs the exact phrase", () => {
  assert.deepEqual(moveTargets(overview, 1).map((t) => t.id), [2, 3, 4]);
  assert.equal(moveTargets(overview, 1).find((t) => t.id === 4).label, "Old Job (Furniture, hidden)");
  assert.equal(purgeConfirmed("PERMANENTLY DELETE"), true);
  for (const bad of ["permanently delete", "PERMANENTLY", "", null, undefined]) assert.equal(purgeConfirmed(bad), false, String(bad));
  assert.deepEqual(chunk([1, 2, 3, 4, 5], 2), [[1, 2], [3, 4], [5]]);
});

test("the page's limits and phrase match the Worker", () => {
  assert.match(worker, new RegExp(`const PURGE_CONFIRMATION = "${PURGE_PHRASE}";`));
  assert.match(worker, new RegExp(`const PURGE_BATCH = ${PURGE_BATCH};`));
  assert.match(worker, new RegExp(`ids\\.length > ${UPDATE_BATCH}\\) return jsonResult\\(\\{ error: "photoIds required \\(max ${UPDATE_BATCH}\\)" \\}`));
});

test("preview images are only same-origin admin photo-file paths", () => {
  assert.equal(safeAdminPath("/api/gallery-api/facebook/admin/photo-file?id=122234637260318503"), "/api/gallery-api/facebook/admin/photo-file?id=122234637260318503");
  for (const bad of ["https://evil.example/x.jpg", "//evil.example/x", "/api/gallery-api/facebook/admin/photo-file?id=1&x=y", "javascript:alert(1)", null, 5]) {
    assert.equal(safeAdminPath(bad), null, String(bad));
  }
});

test("Manage Images stays admin-only and keeps Facebook galleries in their own list", () => {
  assert.match(page, /await verifyAdminToken\(auth, ADMIN_SECRET, SESSION_VERSION\)/);
  assert.match(page, /if \(!isAdmin\) \{\s*return new Response\(null, \{\s*status: 302,\s*headers: \{ Location: "\/admin" \},/);
  assert.match(page, /<ul id="results" class="results-list"/, "manual R2 folders unchanged");
  assert.match(page, /id="mf-section" data-fb-api="\/api\/gallery-api\/facebook\/admin" hidden/, "same-origin Facebook admin API; hidden until loaded");
  assert.match(page, /<ul id="mf-results" class="results-list">/);
  assert.match(page, /initManagePage\(\);\s*initManageFacebook\(\);/);
  // The manual bulk delete only reads checkboxes inside the manual list.
  assert.match(manualScript, /listEl\.querySelectorAll<HTMLInputElement>\("\.select-checkbox:checked"\)/);
  assert.match(manualScript, /document\.getElementById\("results"\)/);
});

test("the Facebook section uses only Facebook admin endpoints and never parses text as HTML", () => {
  const s = code(script);
  for (const sub of ['"/overview"', "`/photos?projectId=${encodeURIComponent(String(g.id))}`", '"/photo-update"', '"/purge"']) assert.ok(s.includes(sub), sub);
  for (const forbidden of [/\/delete-project/, /["`/]delete["`]/, /\/rename/, /list-images/, /\?all=1/, /graph\.facebook\.com/, /fbcdn/, /https?:\/\//,
    /innerHTML|outerHTML|insertAdjacentHTML|document\.write/, /select-checkbox/]) {
    assert.doesNotMatch(s, forbidden, String(forbidden));
  }
  assert.match(s, /credentials: "include"/);
  assert.match(s, /className: "mf-select"/, "Facebook checkboxes are never picked up by the manual bulk delete");
  assert.match(s, /confirm: PURGE_PHRASE/);
  assert.match(s, /purgeBtn\.disabled = !purgeConfirmed\(phrase\.value\)/, "permanent deletion stays disabled until the phrase is typed");
  assert.match(s, /window\.confirm\(`Permanently delete/);
  assert.match(s, /safeAdminPath\(p\.previewUrl\)/);
  assert.match(s, /if \(e\?\.status === 404\) \{ section\.hidden = true; return; \}/, "integration switched off: the section stays hidden");
});
