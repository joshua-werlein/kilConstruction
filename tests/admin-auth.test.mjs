// Run: npm run test:site
// Timing-safe admin comparisons, admin token verification and POST-only logout.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { safeEquals, timingSafeEqualBytes, isSameOriginRequest } from "../src/utils/adminAuth.ts";
import { createAdminToken, verifyAdminToken } from "../src/utils/adminToken.ts";

const read = (p) => readFile(new URL(p, import.meta.url), "utf8");

async function withNative(fn) {
  const calls = [];
  crypto.subtle.timingSafeEqual = (a, b) => {
    calls.push([a.byteLength, b.byteLength]);
    if (a.byteLength !== b.byteLength) throw new TypeError("unequal lengths");
    return a.every((x, i) => x === b[i]);
  };
  try { await fn(calls); } finally { delete crypto.subtle.timingSafeEqual; }
}

test("safeEquals: contents, lengths, unicode and empty values (fallback and native paths)", async () => {
  assert.equal(typeof crypto.subtle.timingSafeEqual, "undefined", "Node has no native timingSafeEqual");
  const cases = async () => {
    assert.equal(await safeEquals("admin", "admin"), true);
    assert.equal(await safeEquals("admin", "admiN"), false);
    assert.equal(await safeEquals("pw", "a much longer password"), false);
    assert.equal(await safeEquals("", ""), true);
    assert.equal(await safeEquals("", "x"), false);
    assert.equal(await safeEquals("pässwörd✓", "pässwörd✓"), true);
    assert.equal(await safeEquals("pässwörd✓", "passwörd✓"), false);
  };
  await cases();
  await withNative(async (calls) => {
    await cases();
    assert.ok(calls.length > 0 && calls.every(([a, b]) => a === 32 && b === 32), "only 32-byte digests reach the native compare");
  });
});

test("timingSafeEqualBytes never hands unequal lengths to the native function", async () => {
  await withNative(async (calls) => {
    assert.equal(timingSafeEqualBytes(new Uint8Array([1, 2]), new Uint8Array([1])), false);
    assert.equal(calls.length, 0);
  });
});

test("the login page compares username and password with safeEquals, always both", async () => {
  const page = await read("../src/pages/admin.astro");
  assert.match(page, /await Promise\.all\(\[\s*safeEquals\(userStr, ADMIN_USER\),\s*safeEquals\(passStr, ADMIN_PASS\),\s*\]\)/);
  assert.doesNotMatch(page, /[^.]\b(userStr|passStr) === /);
});

test("verifyAdminToken accepts a valid token and rejects tampering, wrong version and expiry", async () => {
  const secret = "test-secret", ver = "3";
  const token = await createAdminToken(secret, ver);
  assert.equal(await verifyAdminToken(token, secret, ver), true);
  const [payload, sig] = token.split(".");
  const flipped = sig.slice(0, -1) + (sig.endsWith("A") ? "B" : "A");
  for (const bad of [`${payload}.${flipped}`, `${payload}.${sig.slice(0, -2)}`, `${payload}.${sig}AA`, `${payload}.`, payload, "", "a.b.c"]) {
    assert.equal(await verifyAdminToken(bad, secret, ver), false, bad);
  }
  assert.equal(await verifyAdminToken(token, "other-secret", ver), false);
  assert.equal(await verifyAdminToken(token, secret, "4"), false);
  const realNow = Date.now;
  try {
    Date.now = () => realNow() + 7 * 60 * 60 * 1000; // past the 6 h TTL
    assert.equal(await verifyAdminToken(token, secret, ver), false);
  } finally { Date.now = realNow; }
});

test("isSameOriginRequest: Origin must match; Sec-Fetch-Site only when Origin is absent", () => {
  const req = (headers) => new Request("https://kilcon.work/admin/logout", { method: "POST", headers });
  assert.equal(isSameOriginRequest(req({ Origin: "https://kilcon.work" })), true);
  assert.equal(isSameOriginRequest(req({ Origin: "https://evil.example" })), false);
  assert.equal(isSameOriginRequest(req({ Origin: "http://kilcon.work" })), false);
  assert.equal(isSameOriginRequest(req({ Origin: "null" })), false);
  assert.equal(isSameOriginRequest(req({ Origin: "https://evil.example", "Sec-Fetch-Site": "same-origin" })), false);
  assert.equal(isSameOriginRequest(req({ "Sec-Fetch-Site": "same-origin" })), true);
  assert.equal(isSameOriginRequest(req({ "Sec-Fetch-Site": "cross-site" })), false);
  assert.equal(isSameOriginRequest(req({})), false);
});

test("logout is POST-only, same-origin checked, and the layout uses a POST form", async () => {
  const page = await read("../src/pages/admin/logout.astro");
  const layout = await read("../src/layout/AdminLayout.astro");
  const code = page.replace(/^\s*\/\/.*$/gm, "");
  // GET/HEAD only redirect; the cookie is cleared after the method and origin checks.
  const getIdx = code.indexOf('request.method === "GET"');
  const originIdx = code.indexOf("!isSameOriginRequest(request)");
  const clearIdx = code.indexOf('Astro.cookies.set("admin_auth", ""');
  assert.ok(getIdx > -1 && originIdx > getIdx && clearIdx > originIdx, "method check, then origin check, then clear");
  assert.match(code, /status: 303, headers: \{ Location: "\/admin\/dashboard"/);
  assert.match(code, /status: 405/);
  assert.match(code, /status: 403/);
  assert.match(code, /maxAge: 0/);
  assert.match(layout, /<form method="POST" action="\/admin\/logout"[^>]*>\s*<button type="submit"[^>]*>Logout<\/button>/);
  assert.doesNotMatch(layout, /href="\/admin\/logout"/);
  // No other page links to a GET logout.
  const { readdir } = await import("node:fs/promises");
  const files = await readdir(new URL("../src", import.meta.url), { recursive: true });
  for (const f of files.filter((f) => /\.(astro|ts|js)$/.test(f))) {
    const src = await readFile(new URL(`../src/${f.replace(/\\/g, "/")}`, import.meta.url), "utf8");
    assert.doesNotMatch(src, /href=["']\/admin\/logout/, f);
  }
});
