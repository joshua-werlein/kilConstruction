// Run: npm run test:contact-worker
// Contact Worker: the /contact form keeps its redirects; the apparel page's
// asynchronous requests (Accept: application/json) get explicit JSON results.
import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import worker from "../src/index.js";

const ENDPOINT = "https://kilcon.work/api/contact";
const realFetch = globalThis.fetch;
let calls;
let turnstile; // siteverify result, or "throw"
let resend;    // { status, body } or "throw"

beforeEach(() => {
  calls = [];
  turnstile = { success: true };
  resend = { status: 200, body: '{"id":"email_1"}' };
  globalThis.fetch = async (url, init) => {
    calls.push({ url: String(url), body: init?.body ? JSON.parse(init.body) : null });
    if (String(url).includes("turnstile")) {
      if (turnstile === "throw") throw new Error("network");
      return new Response(JSON.stringify(turnstile), { headers: { "content-type": "application/json" } });
    }
    if (String(url).includes("api.resend.com")) {
      if (resend === "throw") throw new Error("network");
      return new Response(resend.body, { status: resend.status });
    }
    throw new Error(`unexpected fetch ${url}`);
  };
  globalThis.console.warn = () => {};
  globalThis.console.error = () => {};
});
afterEach(() => { globalThis.fetch = realFetch; });


/** A CONTACT_LIMITER namespace stub: hit(key) decides the answer. */
const limiterNs = (hit) => ({
  idFromName: (key) => ({ key }),
  get: (id) => ({ hit: () => hit(id.key) }),
});

const env = (over = {}) => ({
  RESEND_API_KEY: "re_test",
  FROM_EMAIL: "KilCon <contact@kilcon.work>",
  TO_EMAIL: "owner@example.com",
  TURNSTILE_SECRET: "ts_test",
  CONTACT_LIMITER: limiterNs(async () => ({ ok: true, remaining: 2 })),
  ...over,
});

const FIELDS = {
  name: "Pat Doe",
  email: "pat@example.com",
  message: "Apparel request\nItem: T-Shirts\nSize: L\nQuantity: 2",
  "cf-turnstile-response": "token-123",
};

function post({ fields = FIELDS, json = true, origin = "https://kilcon.work", contentType } = {}) {
  const fd = new FormData();
  for (const [k, v] of Object.entries(fields)) fd.set(k, v);
  const headers = { Host: "kilcon.work", "CF-Connecting-IP": "203.0.113.9" };
  if (json) headers.Accept = "application/json";
  if (origin) headers.Origin = origin;
  if (contentType) return new Request(ENDPOINT, { method: "POST", headers: { ...headers, "content-type": contentType }, body: "{}" });
  return new Request(ENDPOINT, { method: "POST", headers, body: fd });
}

const body = async (res) => JSON.parse(await res.text());
const resendCalls = () => calls.filter((c) => c.url.includes("api.resend.com"));

// ---------- asynchronous (JSON) ----------

test("json: success only after Resend accepts; Reply-To is the customer", async () => {
  const res = await worker.fetch(post(), env());
  assert.equal(res.status, 200);
  assert.deepEqual(await body(res), { ok: true });
  assert.match(res.headers.get("content-type"), /application\/json/);
  assert.equal(res.headers.get("cache-control"), "no-store");
  const [sent] = resendCalls();
  assert.equal(sent.body.reply_to, "pat@example.com");
  assert.deepEqual(sent.body.to, ["owner@example.com"]);
  assert.match(sent.body.html.replace(/\r/g, ""), /Item: T-Shirts<br>Size: L/);
  const verify = calls.find((c) => c.url.includes("siteverify"));
  assert.equal(verify.body.response, "token-123");
  assert.equal(verify.body.remoteip, "203.0.113.9");
});

test("json: validation errors are 400 input/phone and send nothing", async () => {
  for (const fields of [
    { ...FIELDS, name: "P" },
    { ...FIELDS, email: "not-an-email" },
    { ...FIELDS, message: "short" },
  ]) {
    const res = await worker.fetch(post({ fields }), env());
    assert.equal(res.status, 400);
    assert.deepEqual(await body(res), { ok: false, error: "input" });
  }
  const res = await worker.fetch(post({ fields: { ...FIELDS, phone: "12" } }), env());
  assert.deepEqual([res.status, await body(res)], [400, { ok: false, error: "phone" }]);
  assert.equal(resendCalls().length, 0);
});

test("json: rate limit is 429 with the limiter's Retry-After, checked before Turnstile", async () => {
  let key;
  const res = await worker.fetch(post(), env({ CONTACT_LIMITER: limiterNs(async (k) => { key = k; return { ok: false, retryAfter: 42 }; }) }));
  assert.equal(res.status, 429);
  assert.equal(res.headers.get("retry-after"), "42");
  assert.deepEqual(await body(res), { ok: false, error: "rate" });
  assert.equal(key, "v4:203.0.113.9", "one limiter object per client IP");
  assert.equal(calls.length, 0, "no Turnstile or Resend call");
});

test("json: Turnstile missing, rejected (expired/duplicate) or unreachable is 403 captcha", async () => {
  const { "cf-turnstile-response": _, ...noToken } = FIELDS;
  let res = await worker.fetch(post({ fields: noToken }), env());
  assert.deepEqual([res.status, await body(res)], [403, { ok: false, error: "captcha" }]);

  turnstile = { success: false, "error-codes": ["timeout-or-duplicate"] };
  res = await worker.fetch(post(), env());
  assert.deepEqual([res.status, await body(res)], [403, { ok: false, error: "captcha" }]);

  turnstile = "throw";
  res = await worker.fetch(post(), env());
  assert.deepEqual([res.status, await body(res)], [403, { ok: false, error: "captcha" }]);

  turnstile = { success: true };
  res = await worker.fetch(post(), env({ TURNSTILE_SECRET: "" }));
  assert.deepEqual([res.status, await body(res)], [403, { ok: false, error: "captcha" }], "fails closed on kilcon.work without a secret");
  assert.equal(resendCalls().length, 0);
});

test("json: Resend rejection or network failure is 502 delivery, never ok", async () => {
  resend = { status: 422, body: '{"message":"invalid"}' };
  let res = await worker.fetch(post(), env());
  assert.deepEqual([res.status, await body(res)], [502, { ok: false, error: "delivery" }]);
  resend = "throw";
  res = await worker.fetch(post(), env());
  assert.deepEqual([res.status, await body(res)], [502, { ok: false, error: "delivery" }]);
});

test("json: missing email configuration is 500 server", async () => {
  const res = await worker.fetch(post(), env({ RESEND_API_KEY: "" }));
  assert.deepEqual([res.status, await body(res)], [500, { ok: false, error: "server" }]);
});

test("json: honeypot looks like success to bots but sends nothing", async () => {
  const res = await worker.fetch(post({ fields: { ...FIELDS, company: "Spam Inc" } }), env());
  assert.deepEqual([res.status, await body(res)], [200, { ok: true }]);
  assert.equal(calls.length, 0);
});

test("json: only the site's own origins get JSON answers", async () => {
  for (const origin of ["https://evil.example", ""]) {
    const res = await worker.fetch(post({ origin }), env());
    assert.equal(res.status, 403);
    assert.deepEqual(await body(res), { ok: false, error: "origin" });
  }
  assert.equal(calls.length, 0);
});

test("json: a JSON body is refused with 415", async () => {
  const res = await worker.fetch(post({ contentType: "application/json" }), env());
  assert.deepEqual([res.status, await body(res)], [415, { ok: false, error: "media_type" }]);
});

// ---------- ordinary /contact form (unchanged) ----------

test("form: success and honeypot redirect to /contact?sent=1", async () => {
  let res = await worker.fetch(post({ json: false }), env());
  assert.equal(res.status, 303);
  assert.equal(res.headers.get("location"), "https://kilcon.work/contact?sent=1");
  assert.equal(resendCalls().length, 1);
  res = await worker.fetch(post({ json: false, fields: { ...FIELDS, company: "x" } }), env());
  assert.equal(res.headers.get("location"), "https://kilcon.work/contact?sent=1");
});

test("form: errors redirect with ?err= exactly as before; provider failure stays a 502 text page", async () => {
  const cases = [
    [{ fields: { ...FIELDS, name: "P" } }, {}, "?err=input"],
    [{ fields: { ...FIELDS, phone: "12" } }, {}, "?err=phone"],
    [{}, { CONTACT_LIMITER: limiterNs(async () => ({ ok: false, retryAfter: 60 })) }, "?err=rate"],
    [{}, { RESEND_API_KEY: "" }, "?err=server"],
  ];
  for (const [opts, over, suffix] of cases) {
    const res = await worker.fetch(post({ json: false, ...opts }), env(over));
    assert.equal(res.status, 303, suffix);
    assert.equal(res.headers.get("location"), `https://kilcon.work/contact${suffix}`);
  }
  turnstile = { success: false };
  let res = await worker.fetch(post({ json: false }), env());
  assert.equal(res.headers.get("location"), "https://kilcon.work/contact?err=captcha");
  resend = { status: 500, body: "down" };
  turnstile = { success: true };
  res = await worker.fetch(post({ json: false }), env());
  assert.equal(res.status, 502);
  assert.equal(await res.text(), "Email provider error");
});

test("form: a cross-origin form post still works as before (no origin check on the form path)", async () => {
  const res = await worker.fetch(post({ json: false, origin: "" }), env());
  assert.equal(res.headers.get("location"), "https://kilcon.work/contact?sent=1");
});

test("limiter failures fail closed: 503, nothing verified or sent", async () => {
  const failing = {
    "throws": limiterNs(async () => { throw new Error("Durable Object reset"); }),
    "odd answer": limiterNs(async () => ({})),
    "missing binding": undefined,
  };
  for (const [label, ns] of Object.entries(failing)) {
    const res = await worker.fetch(post(), env({ CONTACT_LIMITER: ns }));
    assert.equal(res.status, 503, label);
    assert.equal(res.headers.get("retry-after"), "30", label);
    assert.deepEqual(await body(res), { ok: false, error: "unavailable" }, label);
    const form = await worker.fetch(post({ json: false }), env({ CONTACT_LIMITER: ns }));
    assert.equal(form.headers.get("location"), "https://kilcon.work/contact?err=server", label);
  }
  assert.equal(calls.length, 0, "no Turnstile or Resend call");
});

test("a limiter that never answers fails closed after the timeout", async () => {
  const started = Date.now();
  const res = await worker.fetch(post(), env({ CONTACT_LIMITER: limiterNs(() => new Promise(() => {})) }));
  assert.equal(res.status, 503);
  assert.ok(Date.now() - started >= 2900, "waited for the 3 s timeout");
  assert.equal(calls.length, 0);
});

test("limiter key: IPv4 as is, IPv6 by /64, no raw address beyond that", async () => {
  const { limiterKey } = await import("../src/rate-limiter.js");
  assert.equal(limiterKey("203.0.113.9"), "v4:203.0.113.9");
  assert.equal(limiterKey("2001:db8:abcd:12:1:2:3:4"), "v6:2001:db8:abcd:12::/64");
  assert.equal(limiterKey("2001:DB8:abcd:0012::99"), "v6:2001:db8:abcd:12::/64", "same /64, other host");
  assert.equal(limiterKey("2001:db8::1"), "v6:2001:db8:0:0::/64");
  assert.notEqual(limiterKey("2001:db8:abcd:13::1"), limiterKey("2001:db8:abcd:12::1"));
  assert.equal(limiterKey(""), "v4:unknown");
});

// ---------- input-length limits (2026-11-24) ----------

import { MAX } from "../src/index.js";

test("limits: each field at its cap is accepted", async () => {
  const fields = {
    ...FIELDS,
    name: "N".repeat(MAX.name),
    email: `${"e".repeat(MAX.email - "@example.com".length)}@example.com`,
    phone: "(715) 867-5309".padEnd(MAX.phone, " ") + "", // trimmed back to 14 chars
    address: "A".repeat(MAX.address),
    message: "M".repeat(MAX.message),
  };
  const res = await worker.fetch(post({ fields }), env());
  assert.deepEqual([res.status, await body(res)], [200, { ok: true }]);
});

test("limits: one character over any cap is 400 input, before the limiter, Turnstile or Resend", async () => {
  const over = {
    name: "N".repeat(MAX.name + 1),
    email: `${"e".repeat(MAX.email + 1 - "@example.com".length)}@example.com`,
    phone: "1".repeat(MAX.phone + 1),
    address: "A".repeat(MAX.address + 1),
    message: "M".repeat(MAX.message + 1),
    "cf-turnstile-response": "t".repeat(MAX.token + 1),
  };
  for (const [field, value] of Object.entries(over)) {
    let limited = 0;
    const res = await worker.fetch(post({ fields: { ...FIELDS, [field]: value } }),
      env({ CONTACT_LIMITER: limiterNs(async () => { limited++; return { ok: true }; }) }));
    assert.deepEqual([res.status, await body(res)], [400, { ok: false, error: "input" }], field);
    assert.equal(limited, 0, `${field}: limiter not consumed`);
  }
  assert.equal(calls.length, 0, "no Turnstile or Resend calls");
});

test("limits: the /contact form redirects oversized input to ?err=input", async () => {
  const res = await worker.fetch(post({ json: false, fields: { ...FIELDS, message: "M".repeat(MAX.message + 1) } }), env());
  assert.equal(res.headers.get("location"), "https://kilcon.work/contact?err=input");
});

test("limits: a declared body over 32 KB is refused without parsing", async () => {
  const req = new Request(ENDPOINT, {
    method: "POST",
    headers: { Host: "kilcon.work", Origin: "https://kilcon.work", Accept: "application/json",
      "content-type": "application/x-www-form-urlencoded", "content-length": String(MAX.body + 1) },
    body: "name=x",
  });
  const res = await worker.fetch(req, env());
  assert.deepEqual([res.status, await body(res)], [400, { ok: false, error: "input" }]);
  assert.equal(calls.length, 0);
});

// ---------- dev origins (2026-11-24) ----------

test("origins: production never trusts localhost; only ALLOW_DEV_ORIGINS (wrangler dev) does", async () => {
  for (const origin of ["http://localhost:4321", "http://127.0.0.1:4321"]) {
    const prod = await worker.fetch(post({ origin }), env());
    assert.equal(prod.status, 403, `prod refuses ${origin}`);
    const pre = await worker.fetch(new Request(ENDPOINT, { method: "OPTIONS", headers: { Origin: origin } }), env());
    assert.equal(pre.headers.get("access-control-allow-origin"), "https://kilcon.work");
    const dev = await worker.fetch(post({ origin }), env({ ALLOW_DEV_ORIGINS: "true" }));
    assert.equal(dev.status, 200, `dev accepts ${origin}`);
    assert.equal(dev.headers.get("access-control-allow-origin"), origin);
  }
  // Only the exact string "true" opts in.
  assert.equal((await worker.fetch(post({ origin: "http://localhost:4321" }), env({ ALLOW_DEV_ORIGINS: "1" }))).status, 403);
});

test("config: the Durable Object limiter is bound and migrated; no test-only window in production", async () => {
  const { readFile } = await import("node:fs/promises");
  const toml = await readFile(new URL("../wrangler.toml", import.meta.url), "utf8");
  assert.match(toml, /\[\[durable_objects\.bindings\]\]\s*name = "CONTACT_LIMITER"\s*class_name = "ContactRateLimiter"/);
  assert.match(toml, /\[\[migrations\]\]\s*tag = "v1"\s*new_sqlite_classes = \["ContactRateLimiter"\]/);
  assert.doesNotMatch(toml, /^\s*RATE_LIMIT_WINDOW_MS\s*=/m, "the window override is test-only");
  assert.doesNotMatch(toml, /^\s*name = "WRITE_LIMITER"/m, "the approximate binding is gone");
  assert.match(toml, /^workers_dev = false/m);
  const { LIMIT, WINDOW_MS, windowMs } = await import("../src/rate-limiter.js");
  assert.deepEqual([LIMIT, WINDOW_MS, windowMs({})], [3, 60_000, 60_000]);
  assert.equal(windowMs({ RATE_LIMIT_WINDOW_MS: "999999" }), 60_000, "can never lengthen or disable the window");
  assert.equal(windowMs({ RATE_LIMIT_WINDOW_MS: "0" }), 60_000);
});
