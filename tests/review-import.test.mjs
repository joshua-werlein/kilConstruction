// Run: npm run test:site
// "Import Approved Photos" on /admin/facebook-review: helper logic and page
// wiring. Endpoint behaviour (auth, switch, limits, duplicates, partial
// failures, no scans) is tested against real local D1/R2 in
// workers/kilcon-gallery-worker/test/facebook-review.test.mjs.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { DEFAULT_BATCH, chunk, confirmText, destinationMode, reasonLabel, runFlags, summarizeDryRun, summarizeImport } from "../src/lib/review-import.js";

const read = (p) => readFile(new URL(p, import.meta.url), "utf8");
const page = await read("../src/pages/admin/facebook-review.astro");
const script = await read("../src/pages/admin/facebook-review-script.ts");
const worker = await read("../workers/kilcon-gallery-worker/src/facebook.js");
const toml = await read("../workers/kilcon-gallery-worker/wrangler.toml");
const code = (s) => s.replace(/^\s*\/\/.*$/gm, "");

test("batches are bounded to the Worker limit", () => {
  assert.match(worker, new RegExp(`const MAX_TARGETED_PHOTOS = ${DEFAULT_BATCH};`));
  const ids = Array.from({ length: 23 }, (_, i) => String(i));
  assert.deepEqual(chunk(ids, 10).map((b) => b.length), [10, 10, 3]);
  assert.deepEqual(chunk(ids, 0).map((b) => b.length), [10, 10, 3], "bad sizes fall back to 10");
  assert.deepEqual(chunk([], 10), []);
});

test("destination: a linked album is fixed; unsorted albums are always mixed; others link on confirmation", () => {
  const galleries = [{ id: 1, name: "Ganz Garage" }, { id: 5, name: "Ripley" }];
  const linked = destinationMode({ linked: { id: 5, name: "Ripley", usable: true }, galleries }, { kind: "project" });
  assert.deepEqual([linked.mode, linked.gallery.id, linked.galleries.length], ["linked", 5, 0]);
  assert.deepEqual(runFlags(linked, { mixed: true, dryRun: false }), { mixedAlbum: false, linkFirst: false }, "a linked album never runs as mixed");

  const mobile = destinationMode({ linked: null, galleries }, { kind: "generic" });
  assert.deepEqual([mobile.mode, mobile.mixedLocked, mobile.mixedDefault], ["choose", true, true]);
  assert.deepEqual(runFlags(mobile, { mixed: true, dryRun: false }), { mixedAlbum: true, linkFirst: false });

  const ganz = destinationMode({ linked: null, galleries }, { kind: "project" });
  assert.deepEqual([ganz.mixedLocked, ganz.mixedDefault], [false, false]);
  assert.deepEqual(runFlags(ganz, { mixed: false, dryRun: true }), { mixedAlbum: true, linkFirst: false }, "the check never links anything");
  assert.deepEqual(runFlags(ganz, { mixed: false, dryRun: false }), { mixedAlbum: false, linkFirst: true });
  assert.deepEqual(runFlags(ganz, { mixed: true, dryRun: false }), { mixedAlbum: true, linkFirst: false });
  assert.equal(destinationMode({ linked: { id: 9, name: "x", usable: false } }, {}).usable, false);
});

test("dry-run and import summaries", () => {
  const dry = summarizeDryRun([
    { photos: [{ id: "1", outcome: "new" }, { id: "2", outcome: "existing", reason: "already-imported" }, { id: "3", outcome: "refused", reason: "review-skip" }] },
    { error: "Too many import requests" },
    { photos: [{ id: "4", outcome: "new" }] },
  ], new Set(["4"]));
  assert.deepEqual(dry.newIds, ["1", "4"]);
  assert.deepEqual(dry.existing, [{ id: "2", reason: "already on the website" }]);
  assert.deepEqual(dry.refused, [{ id: "3", reason: "marked Duplicate / Skip" }]);
  assert.deepEqual([dry.errors, dry.likelyDuplicates], [["Too many import requests"], ["4"]]);
  assert.match(confirmText(dry, "Ripley"), /^Import 2 approved photos into "Ripley" and publish them on the website\? 1 of them look like duplicates/);

  const done = summarizeImport([
    { imported: 1, photos: [{ id: "1", outcome: "imported" }] },
    { error: "Expected 2 new photos but found 1; nothing was imported", photos: [{ id: "5", outcome: "existing", reason: "already-imported" }] },
    { imported: 1, failed: [{ id: "7" }], photos: [{ id: "6", outcome: "imported" }, { id: "7", outcome: "failed", reason: "Image download failed (404)" }] },
    { error: "Reviewed importing is switched off" },
  ]);
  assert.equal(done.imported, 2);
  assert.deepEqual(done.failed, [{ id: "7", reason: "Image download failed (404)" }]);
  assert.equal(done.errors.length, 2);
  assert.equal(reasonLabel("branding-album"), "branding photos are never imported");
  assert.equal(reasonLabel("<b>x</b>"), "<b>x</b>", "unknown reasons are shown as text, never parsed");
});

test("the button uses only the scoped import endpoints; nothing else can start an import", () => {
  const s = code(script);
  for (const needle of ["import-plan?albumId=", "`${API}/import-run`", 'postJson("album-link"', "confirm: plan.confirmation", "expectedCount: batches[i].length", "importDialog.showModal()"]) {
    assert.ok(s.includes(needle), needle);
  }
  assert.doesNotMatch(s, /backfill|discovery|authorizeHistorical|FB_HISTORICAL/, "never the historical or discovery import");
  assert.doesNotMatch(s, /innerHTML|outerHTML|insertAdjacentHTML|document\.write/);
  assert.match(s, /importCheck\.disabled = importing \|\| !plan \|\| !plan\.pending\.length \|\| !g \|\| .* \|\| pending\.size > 0;/, "unsaved decisions block the import");
  assert.match(s, /importConfirm\.disabled = !plan\.enabled;/, "the server switch is respected");
  assert.match(s, /await openAlbum\(a\); \/\/ reloads photos/, "the album refreshes after importing");
  assert.match(s, /if \(r\.error\) break;/, "a refused batch stops the run");
});

test("the page has the import panel and a confirmation dialog", () => {
  for (const id of ["rv-import", "rv-import-summary", "rv-import-gallery", "rv-import-mixed", "rv-import-check", "rv-import-status", "rv-import-report", "rv-import-dialog", "rv-import-confirm", "rv-import-cancel"]) {
    assert.match(page, new RegExp(`id="${id}"`), id);
  }
  assert.match(page, />Import Approved Photos</);
});

test("the scoped switch is on; the global historical import and discovery stay off", () => {
  assert.match(toml, /^FB_REVIEWED_IMPORT_ENABLED = "true"/m); // enabled 2026-11-22 with owner approval
  assert.match(toml, /^FB_HISTORICAL_IMPORT_ENABLED = "false"/m);
  assert.match(toml, /^FB_DISCOVERY_ENABLED = "false"/m);
  assert.match(worker, /export const IMPORT_CONFIRMATION = "IMPORT APPROVED";/);
  assert.match(worker, /if \(env\.FB_REVIEWED_IMPORT_ENABLED !== "true"\) return jsonResult\(\{ error: "Reviewed importing is switched off" \}, 403\);/);
});

test("the destination list groups website and Facebook galleries by category", async () => {
  const { galleryGroups, destinationBody } = await import("../src/lib/review-import.js");
  const groups = galleryGroups([
    { value: "project:1", id: 1, name: "Ganz Garage", category: "projects", source: "facebook" },
    { value: "manual:Furniture/Cutting Boards/", id: null, name: "Cutting Boards", category: "furniture", linkedPrefix: "Furniture/Cutting Boards/", source: "website" },
    { value: "project:9", id: 9, name: "Schwennson House", category: "projects", linkedPrefix: "Projects/Schwennson House/", source: "website" },
    { value: "manual:Remodels/3D_Autobody/", id: null, name: "3D Autobody", category: "remodels", source: "website" },
    { value: "", name: "bad" }, null,
  ]);
  assert.deepEqual(groups.map((g) => [g.label, g.items.map((i) => i.label)]), [
    ["Projects", ["Ganz Garage (Facebook gallery)", "Schwennson House (website gallery)"]],
    ["Remodels", ["3D Autobody (website gallery)"]],
    ["Furniture", ["Cutting Boards (website gallery)"]],
  ]);
  assert.deepEqual(destinationBody({ id: 9, linkedPrefix: "Projects/Schwennson House/" }), { projectId: 9 }, "a linked gallery is named by its record");
  assert.deepEqual(destinationBody({ id: null, linkedPrefix: "Furniture/Cutting Boards/" }), { linkedPrefix: "Furniture/Cutting Boards/" });
  assert.deepEqual(destinationBody({}), {});
});

test("confirming into a website gallery creates or reuses its link before importing; the check never does", () => {
  const s = code(script);
  const check = s.slice(s.indexOf('importCheck.addEventListener("click"'), s.indexOf('importCancel.addEventListener'));
  const confirm = s.slice(s.indexOf('importConfirm.addEventListener("click"'));
  assert.match(check, /\.\.\.destinationBody\(g\)/);
  assert.doesNotMatch(check, /project-create|album-link/, "the check writes nothing");
  const create = confirm.indexOf('postJson("project-create", { name: dry.gallery.name, linkedPrefix: dry.gallery.linkedPrefix })');
  const link = confirm.indexOf('postJson("album-link"');
  const run = confirm.indexOf("postBatch({ dryRun: false");
  assert.ok(create > 0 && create < link && link < run, "link record, then album link, then import");
  assert.match(confirm, /if \(dry\.gallery\.id === null\)/, "only for a gallery that isn't linked yet");
  assert.match(s, /el\("optgroup", \{ label: group\.label \}\)/);
});
