// Run: npm run test:site
// Apparel direct submission (src/lib/apparel-submit.js) against the real Contact
// Worker code with Turnstile and Resend mocked: the page's request and the
// Worker's JSON answers are tested end to end.
import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { buildSubmission, submitInquiry, interpretResponse, messageFor, SUBMIT_MESSAGES } from "../src/lib/apparel-submit.js";
import { validateRequestForm } from "../src/lib/apparel-inquiry.js";
import worker from "../workers/kilcon-contact/src/index.js";

const ENDPOINT = "https://kilcon.work/api/contact";
const realFetch = globalThis.fetch;
let outbound; let turnstile; let resend; let limited; let sentEmails;

beforeEach(() => {
  outbound = []; sentEmails = []; turnstile = { success: true }; resend = { status: 200 }; limited = false;
  // Calls the Contact Worker itself (Turnstile and Resend are faked behind it).
  globalThis.fetch = async (url, init) => {
    if (String(url).includes("siteverify")) return new Response(JSON.stringify(turnstile));
    if (String(url).includes("api.resend.com")) { sentEmails.push(JSON.parse(init.body)); return new Response("{}", { status: resend.status }); }
    throw new Error(`unexpected ${url}`);
  };
  console.warn = () => {}; console.error = () => {};
});
afterEach(() => { globalThis.fetch = realFetch; });

const env = () => ({
  RESEND_API_KEY: "re_test", FROM_EMAIL: "KilCon <contact@kilcon.work>", TO_EMAIL: "owner@example.com", TURNSTILE_SECRET: "ts",
  WRITE_LIMITER: { limit: async () => ({ success: !limited }) },
});

/** What the browser does: a same-origin POST, answered by the Worker. */
const browserFetch = async (url, init) => {
  outbound.push({ url, init });
  const req = new Request(url, { method: init.method, body: init.body, headers: { ...init.headers, Origin: "https://kilcon.work", Host: "kilcon.work", "CF-Connecting-IP": "203.0.113.5" } });
  return worker.fetch(req, env());
};

function validForm(over = {}) {
  const r = validateRequestForm({ name: "Pat Doe", email: "pat@example.com", slug: "t-shirts", title: "T-Shirts", size: "__other__", customSize: "Youth M", quantity: "3", notes: "Navy, by Friday", ...over });
  assert.equal(r.ok, true);
  return buildSubmission({ request: r.request, contact: r.contact, token: "tok-1" });
}

test("success: the Worker answers ok only after Resend accepts; the email carries the request and Reply-To", async () => {
  const result = await submitInquiry(browserFetch, ENDPOINT, validForm());
  assert.deepEqual(result, { ok: true });
  assert.equal(sentEmails.length, 1);
  assert.equal(sentEmails[0].reply_to, "pat@example.com");
  const html = sentEmails[0].html.replace(/\r/g, "");
  for (const s of ["Pat Doe", "Item: T-Shirts", "Requested size (not listed): Youth M", "Quantity: 3", "Notes: Navy, by Friday"]) assert.ok(html.includes(s), s);
});

test("privacy: POST body only; the URL never carries name, email or notes; no cookies; no redirects", async () => {
  await submitInquiry(browserFetch, ENDPOINT, validForm());
  const [{ url, init }] = outbound;
  assert.equal(url, ENDPOINT, "no query string");
  assert.equal(init.method, "POST");
  assert.ok(init.body instanceof FormData);
  assert.equal(init.headers.Accept, "application/json");
  assert.equal(init.credentials, "omit");
  assert.equal(init.redirect, "error");
  assert.deepEqual([...init.body.keys()].sort(), ["cf-turnstile-response", "company", "email", "message", "name"]);
});

test("validation errors from the Worker map to the input message and send nothing", async () => {
  const fields = { ...validForm(), name: "P" }; // bypasses the page's own validation
  const result = await submitInquiry(browserFetch, ENDPOINT, fields);
  assert.deepEqual(result, { ok: false, code: "input" });
  assert.match(messageFor(result.code), /check your name, email address/);
  assert.equal(sentEmails.length, 0);
  // The page's own validation stops bad entries before any request.
  assert.deepEqual(validateRequestForm({ name: "", email: "x", slug: "t-shirts", size: "", quantity: "0" }).errors, ["name", "email", "size"], "item checks stop at the first problem");
});

test("rate limit: 429 -> 'wait a minute' and nothing sent", async () => {
  limited = true;
  const result = await submitInquiry(browserFetch, ENDPOINT, validForm());
  assert.deepEqual(result, { ok: false, code: "rate" });
  assert.match(messageFor("rate"), /wait a minute/);
  assert.equal(sentEmails.length, 0);
});

test("Turnstile failure or expired token: captcha -> complete it again", async () => {
  turnstile = { success: false, "error-codes": ["timeout-or-duplicate"] };
  let result = await submitInquiry(browserFetch, ENDPOINT, validForm());
  assert.deepEqual(result, { ok: false, code: "captcha" });
  assert.match(messageFor("captcha"), /complete it again/);
  turnstile = { success: true };
  result = await submitInquiry(browserFetch, ENDPOINT, { ...validForm(), "cf-turnstile-response": "" });
  assert.deepEqual(result, { ok: false, code: "captcha" });
  assert.equal(sentEmails.length, 0);
});

test("email delivery failure: Resend rejects -> delivery error, never success, details kept", async () => {
  resend = { status: 500 };
  const result = await submitInquiry(browserFetch, ENDPOINT, validForm());
  assert.deepEqual(result, { ok: false, code: "delivery" });
  assert.match(messageFor("delivery"), /still here/);
});

test("network failure, redirects and non-JSON answers are errors, never success", async () => {
  assert.deepEqual(await submitInquiry(async () => { throw new TypeError("offline"); }, ENDPOINT, validForm()), { ok: false, code: "network" });
  const html = async () => new Response("<html>", { status: 200, headers: { "content-type": "text/html" } });
  assert.deepEqual(await submitInquiry(html, ENDPOINT, validForm()), { ok: false, code: "server" });
  assert.deepEqual(interpretResponse(200, { ok: "yes" }), { ok: false, code: "server" });
  assert.deepEqual(interpretResponse(429, null), { ok: false, code: "rate" });
  assert.deepEqual(interpretResponse(403, null), { ok: false, code: "captcha" });
  assert.deepEqual(interpretResponse(502, { ok: false, error: "made-up" }), { ok: false, code: "server" });
  assert.equal(messageFor("unknown"), SUBMIT_MESSAGES.server);
});

test("honeypot is passed through; a filled one looks like success to a bot but sends nothing", async () => {
  const r = validateRequestForm({ name: "Bot Name", email: "b@example.com", slug: "coats", size: "M", quantity: "1" });
  const fields = buildSubmission({ request: r.request, contact: r.contact, token: "t", honeypot: "Acme" });
  assert.equal(fields.company, "Acme");
  assert.deepEqual(await submitInquiry(browserFetch, ENDPOINT, fields), { ok: true });
  assert.equal(sentEmails.length, 0);
});
