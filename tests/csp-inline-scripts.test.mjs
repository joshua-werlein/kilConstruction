// Run: npm run test:site
// Our own pages ship no inline <script>s, so the CSP's 'unsafe-inline' is only
// needed for Cloudflare's injected challenge-platform bootstrap.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import config from "../astro.config.mjs";
import { applyContactStatus, contactStatusFor, CONTACT_STATUS_MESSAGES } from "../src/lib/contact-status.js";

const srcDir = new URL("../src/", import.meta.url);

test("no is:inline or define:vars scripts in src/", async () => {
  const files = (await readdir(srcDir, { recursive: true })).filter((f) => f.endsWith(".astro"));
  assert.ok(files.length > 10);
  for (const f of files) {
    const src = await readFile(new URL(f.replace(/\\/g, "/"), srcDir), "utf8");
    const code = src.replace(/<!--[\s\S]*?-->/g, "");
    assert.doesNotMatch(code, /<script\b[^>]*\bis:inline\b/, f);
    assert.doesNotMatch(code, /<script\b[^>]*\bdefine:vars\b/, f);
  }
});

test("no inline event-handler attributes (on*=) or javascript: URLs in src/ or public/", async () => {
  // A nonce policy blocks these (script-src-attr); found by the report-only check on /reviews.
  for (const base of ["../src/", "../public/"]) {
    const dir = new URL(base, import.meta.url);
    const files = (await readdir(dir, { recursive: true })).filter((f) => /\.(astro|html|js|ts)$/.test(f));
    for (const f of files) {
      const src = (await readFile(new URL(f.replace(/\\/g, "/"), dir), "utf8")).replace(/<!--[\s\S]*?-->/g, "");
      assert.doesNotMatch(src, /<[a-z][^>]*\son[a-z]+\s*=\s*["'{]/i, `${base}${f}`);
      assert.doesNotMatch(src, /\bhref\s*=\s*["']javascript:/i, `${base}${f}`);
    }
  }
});

test("the reviews filter submits from the bundled script", async () => {
  const page = await readFile(new URL("pages/reviews.astro", srcDir), "utf8");
  assert.match(page, /<select name="type" id="review-type-filter">/);
  assert.match(page, /getElementById\("review-type-filter"\)[\s\S]*typeFilter\?\.addEventListener\("change", \(\) => typeFilter\.form\?\.submit\(\)\)/);
});

test("Astro never inlines processed scripts; CSS keeps the default limit", () => {
  const limit = config.vite?.build?.assetsInlineLimit;
  assert.equal(typeof limit, "function");
  for (const f of ["_astro/reviews.astro_astro_type_script_index_0_lang.ts", "x.js", "x.mjs"]) assert.equal(limit(f), false, f);
  for (const f of ["_astro/AdminLayout.css", "logo.svg", "font.woff2"]) assert.equal(limit(f), undefined, f);
});

test("contact status: same messages and precedence as the former inline script", () => {
  assert.deepEqual(contactStatusFor("?sent=1"), { kind: "success", message: CONTACT_STATUS_MESSAGES.sent, param: "sent" });
  assert.equal(contactStatusFor("?sent=1&err=captcha").kind, "success");
  assert.equal(contactStatusFor("?err=captcha").message, "Please complete the CAPTCHA and try again.");
  assert.equal(contactStatusFor("?err=phone").message, "Please enter a valid phone number or leave it blank.");
  assert.match(contactStatusFor("?err=input").message, /up to 5,000/);
  for (const e of ["server", "rate", "unknown", "sent", "other", "__proto__", "constructor"]) {
    assert.equal(contactStatusFor(`?err=${e}`).message, CONTACT_STATUS_MESSAGES.other, e);
  }
  assert.equal(contactStatusFor("?sent=0"), null);
  assert.equal(contactStatusFor(""), null);
});

function fakeElement(classes) {
  const set = new Set(classes);
  return {
    textContent: "",
    classList: { add: (c) => set.add(c), remove: (...cs) => cs.forEach((c) => set.delete(c)), contains: (c) => set.has(c) },
    classes: set,
  };
}

test("applyContactStatus sets the status class and removes only its parameter", () => {
  const calls = [];
  const hist = { replaceState: (...a) => calls.push(a) };
  const el = fakeElement(["status", "status--empty"]);
  const st = applyContactStatus(el, new URL("https://kilcon.work/contact?err=captcha&inquiry=apparel&item=hat"), hist);
  assert.equal(st.kind, "error");
  assert.equal(el.classList.contains("status--error"), true, "draft restore reads this class");
  assert.equal(el.classList.contains("status--empty"), false);
  assert.equal(el.textContent, CONTACT_STATUS_MESSAGES.captcha);
  assert.deepEqual(calls, [[{}, "", "/contact?inquiry=apparel&item=hat"]]);

  const ok = fakeElement(["status", "status--empty"]);
  applyContactStatus(ok, new URL("https://kilcon.work/contact?sent=1"), hist);
  assert.equal(ok.classList.contains("status--success"), true);
  assert.equal(calls.at(-1)[2], "/contact");

  const none = fakeElement(["status", "status--empty"]);
  const before = calls.length;
  assert.equal(applyContactStatus(none, new URL("https://kilcon.work/contact"), hist), null);
  assert.equal(calls.length, before, "no history change without a status");
  assert.equal(applyContactStatus(null, new URL("https://kilcon.work/contact?sent=1"), hist), null);
});

test("the contact page applies the status before the draft restore reads it", async () => {
  const page = await readFile(new URL("pages/contact.astro", srcDir), "utf8");
  const apply = page.indexOf('applyContactStatus(document.getElementById("result"))');
  const restore = page.indexOf('classList.contains("status--error")');
  assert.ok(apply > -1 && restore > apply);
});
