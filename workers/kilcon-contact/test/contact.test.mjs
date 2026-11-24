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

const env = (over = {}) => ({
  RESEND_API_KEY: "re_test",
  FROM_EMAIL: "KilCon <contact@kilcon.work>",
  TO_EMAIL: "owner@example.com",
  TURNSTILE_SECRET: "ts_test",
  WRITE_LIMITER: { limit: async () => ({ success: true }) },
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

test("json: rate limit is 429 with Retry-After, checked before Turnstile", async () => {
  let key;
  const res = await worker.fetch(post(), env({ WRITE_LIMITER: { limit: async (o) => { key = o.key; return { success: false }; } } }));
  assert.equal(res.status, 429);
  assert.equal(res.headers.get("retry-after"), "60");
  assert.deepEqual(await body(res), { ok: false, error: "rate" });
  assert.equal(key, "contact:203.0.113.9", "same limiter key as the contact form");
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
    [{}, { WRITE_LIMITER: { limit: async () => ({ success: false }) } }, "?err=rate"],
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

test("a failing rate-limit binding fails open, as before", async () => {
  const res = await worker.fetch(post(), env({ WRITE_LIMITER: { limit: async () => { throw new Error("binding"); } } }));
  assert.equal(res.status, 200);
});
