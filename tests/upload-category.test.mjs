// Run: npm run test:site
// Regression: /admin/upload used to default to "Highlights", so a test image
// went to the home-page rotator (2026-11-21). The category must now be chosen
// explicitly, and nothing can be uploaded until it is.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { UPLOAD_CATEGORIES, isValidUploadCategory } from "../src/lib/upload-category.js";

const read = (p) => readFile(new URL(p, import.meta.url), "utf8");
const page = await read("../src/pages/admin/upload.astro");
const script = await read("../src/pages/admin/upload-script.ts");

function categorySelect() {
  const m = /<select\b[^>]*\bid="category"[^>]*>([\s\S]*?)<\/select>/.exec(page);
  assert.ok(m, "category <select> present");
  const tag = /<select\b[^>]*\bid="category"[^>]*>/.exec(page)[0];
  const options = [...m[1].matchAll(/<option\b([^>]*)>([^<]*)<\/option>/g)].map(([, attrs, label]) => ({
    value: /\bvalue="([^"]*)"/.exec(attrs)?.[1],
    selected: /\bselected\b/.test(attrs),
    disabled: /\bdisabled\b/.test(attrs),
    label: label.trim(),
  }));
  return { tag, options };
}

test("only exact category names are valid; blank, placeholder and variants are not", () => {
  for (const c of UPLOAD_CATEGORIES) assert.equal(isValidUploadCategory(c), true, c);
  for (const v of ["", " ", "Choose a category", "highlights", " Highlights", "Highlights ", "HIGHLIGHTS",
                   "Projects/", "Reviews", "Facebook", "__NEW__", undefined, null, 0, {}]) {
    assert.equal(isValidUploadCategory(v), false, JSON.stringify(v));
  }
});

test("categories match the Gallery Worker's ALLOWED_ROOTS", async () => {
  const worker = await read("../workers/kilcon-gallery-worker/src/index.js");
  const block = /const ALLOWED_ROOTS = \[([\s\S]*?)\];/.exec(worker);
  assert.ok(block, "ALLOWED_ROOTS found");
  const roots = [...block[1].matchAll(/"([^"]+)"/g)].map((m) => m[1]);
  assert.deepEqual([...roots].sort(), [...UPLOAD_CATEGORIES].sort());
});

test("the category select starts on a blank, required 'Choose a category' option", () => {
  const { tag, options } = categorySelect();
  assert.match(tag, /\brequired\b/, "browser blocks submit while the blank option is selected");
  assert.deepEqual(options[0], { value: "", selected: true, disabled: true, label: "Choose a category" });
  assert.equal(options.filter((o) => o.selected).length, 1, "only the placeholder is pre-selected");
  assert.deepEqual(options.slice(1).map((o) => o.value), [...UPLOAD_CATEGORIES], "real options, same order as the Worker list");
  const highlights = options.find((o) => o.value === "Highlights");
  assert.equal(highlights.selected, false, "Highlights is never the default");
  assert.notEqual(options[0].value, "Highlights");
});

test("Upload button and folder list are disabled in the markup until a category is chosen", () => {
  assert.match(page, /<button\b[^>]*\bid="submitBtn"[^>]*\bdisabled\b/);
  assert.match(page, /<select\b[^>]*\bid="subfolder-select"[^>]*\bdisabled\b/);
});

test("the script validates the category before planning or sending any upload", () => {
  assert.match(script, /import \{ isValidUploadCategory \} from "\.\.\/\.\.\/lib\/upload-category\.js";/);
  const submit = script.indexOf('formEl.addEventListener("submit"');
  const check = script.indexOf("if (!isValidUploadCategory(category))", submit);
  const plan = script.indexOf("planUploadBatches(", submit);
  const send = script.indexOf("${API_BASE}/upload", submit);
  assert.ok(submit > 0 && check > submit, "submit handler checks the category");
  assert.ok(check < plan && check < send, "check happens before batching and before any request");
  assert.doesNotMatch(script, /ALLOWED_CATEGORIES/, "single source of truth: src/lib/upload-category.js");
  assert.doesNotMatch(script, /categoryEl\.value\s*=\s*["']/, "the script never picks a category itself");
});

test("controls are synced from the category, never force-enabled", () => {
  assert.match(script, /function syncControls\(\): void \{[\s\S]*?submitBtn\.disabled = !valid;[\s\S]*?\}/);
  assert.match(script, /subfolderSelectEl\.disabled = !valid \|\| categoryEl\.value === "Highlights";/);
  const initCall = script.indexOf("syncControls();", script.indexOf("function syncControls"));
  assert.ok(initCall > 0 && initCall < script.indexOf("loadAllFolders()"), "synced on page load");
  const change = script.slice(script.indexOf('categoryEl.addEventListener("change"'));
  assert.match(change.slice(0, 300), /syncControls\(\);/, "synced when the category changes");
  assert.doesNotMatch(script, /submitBtn\.disabled = false/, "no path re-enables Upload without a valid category");
  assert.match(script, /\} finally \{\s*syncControls\(\);\s*\}/);
});

test("folder selection and batching are unchanged", () => {
  assert.match(script, /subfolderSelectEl\.value === "__NEW__"/);
  assert.match(script, /sanitizeSubfolderInput\(subfolder\)/);
  assert.match(script, /isHighlights\s*\?\s*`\$\{category\}\/\$\{cleanedName\}`/);
  assert.match(script, /planUploadBatches\(Array\.from\(files\)/);
});
