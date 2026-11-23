// Run: npm run test:site
// The apparel slug comes straight from the URL and is written into an inline
// <script> via define:vars, so it must be validated before rendering.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { normalizeApparelSlug } from "../src/utils/apparelSlug.ts";

test("valid slugs pass unchanged; mixed case normalizes to lowercase", () => {
  for (const s of ["coats", "cups", "flannels", "sweatshirts", "t-shirts", "a1-b2-c3"]) {
    assert.equal(normalizeApparelSlug(s), s);
  }
  assert.equal(normalizeApparelSlug("T-Shirts"), "t-shirts");
});

test("script breakouts and malformed slugs are rejected", () => {
  for (const s of [
    "</script><script>alert(1)</script>", "x</SCRIPT><img src=x onerror=alert(1)>", "</ScRiPt >",
    'a"b', "a'b", "a<b", "a b", "a_b", "a.b", "a/b", "a\\b", "-bad", "bad-", "a--b", "",
    " x", "t-shirts\n", "%3C", "a".repeat(81), undefined, null,
  ]) {
    assert.equal(normalizeApparelSlug(s), null, `rejects ${JSON.stringify(s)}`);
  }
  assert.equal(normalizeApparelSlug("a".repeat(80)), "a".repeat(80));
});

test("the apparel page validates the slug before anything uses it", async () => {
  const page = await readFile(new URL("../src/pages/apparel/[slug].astro", import.meta.url), "utf8");
  const validate = page.indexOf("normalizeApparelSlug(rawSlug)");
  assert.ok(validate > 0, "page calls normalizeApparelSlug");
  for (const use of ["const env = runtimeEnv;", "searchParams.set(\"project\"", "<script is:inline define:vars"]) {
    assert.ok(page.indexOf(use) > validate, `${use} comes after validation`);
  }
});
