// Run: npm run test:site
// Security headers are added by Astro middleware (src/middleware.ts) because
// the site is server-rendered: Cloudflare Pages does not apply public/_headers
// to _worker.js responses.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import {
  SECURITY_HEADERS,
  CSP_DIRECTIVES,
  CSP,
  CSP_ENFORCE,
  TURNSTILE_ORIGIN,
  IMAGES_ORIGIN,
  CF_INSIGHTS_SCRIPT_ORIGIN,
  CF_INSIGHTS_REPORT_ORIGIN,
  applySecurityHeaders,
} from "../src/utils/securityHeaders.ts";

const SITE_ORIGIN = "https://kilcon.work";
const directive = (name) => new Map(CSP_DIRECTIVES).get(name)?.split(/\s+/) ?? [];

test("adds every security header with its exact value", () => {
  const res = applySecurityHeaders(new Response("<h1>ok</h1>", { headers: { "Content-Type": "text/html" } }));
  assert.equal(res.headers.get("X-Frame-Options"), "DENY");
  assert.equal(res.headers.get("Referrer-Policy"), "strict-origin-when-cross-origin");
  assert.equal(res.headers.get("Permissions-Policy"), "camera=(), microphone=(), geolocation=(), usb=()");
  assert.equal(res.headers.get("Cross-Origin-Opener-Policy"), "same-origin-allow-popups");
  assert.equal(res.headers.get(CSP_ENFORCE ? "Content-Security-Policy" : "Content-Security-Policy-Report-Only"), CSP);
  assert.equal(res.headers.get("Content-Type"), "text/html");
});

test("exactly one CSP header (enforced or report-only per CSP_ENFORCE); HSTS and nosniff are left to the Cloudflare zone", () => {
  const res = applySecurityHeaders(new Response("x"));
  const [on, off] = CSP_ENFORCE
    ? ["Content-Security-Policy", "Content-Security-Policy-Report-Only"]
    : ["Content-Security-Policy-Report-Only", "Content-Security-Policy"];
  assert.equal(res.headers.get(on), CSP);
  assert.equal(res.headers.get(off), null, "never both");
  assert.equal(res.headers.get("Strict-Transport-Security"), null, "zone already sends HSTS");
  assert.equal(res.headers.get("X-Content-Type-Options"), null, "zone already sends nosniff");
  for (const name of Object.keys(SECURITY_HEADERS)) {
    assert.doesNotMatch(name,/^(strict-transport-security|x-content-type-options)$/i);
  }
});

test("a header a route already set is not overwritten", () => {
  const res = applySecurityHeaders(
    new Response("x", { headers: { "X-Frame-Options": "SAMEORIGIN", "Referrer-Policy": "no-referrer" } }),
  );
  assert.equal(res.headers.get("X-Frame-Options"), "SAMEORIGIN");
  assert.equal(res.headers.get("Referrer-Policy"), "no-referrer");
  assert.equal(res.headers.get("Permissions-Policy"), SECURITY_HEADERS["Permissions-Policy"]);
});

test("immutable responses (Response.redirect) are re-wrapped, keeping status and Location", () => {
  const original = Response.redirect("https://checkout.stripe.com/c/pay/cs_test_x", 303);
  assert.throws(() => original.headers.set("X-Test", "1"), "precondition: headers are immutable");
  const res = applySecurityHeaders(original);
  assert.equal(res.status, 303);
  assert.equal(res.headers.get("Location"), "https://checkout.stripe.com/c/pay/cs_test_x");
  assert.equal(res.headers.get("X-Frame-Options"), "DENY");
});

test("status, body, and other headers are preserved (404 page, JSON API, Set-Cookie)", async () => {
  const notFound = applySecurityHeaders(new Response("<p>missing</p>", { status: 404 }));
  assert.equal(notFound.status, 404);
  assert.equal(await notFound.text(), "<p>missing</p>");

  const api = new Response(JSON.stringify({ ok: true }), {
    status: 201,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
  });
  api.headers.append("Set-Cookie", "admin_session=abc; HttpOnly; Secure; SameSite=Strict; Path=/");
  const out = applySecurityHeaders(api);
  assert.equal(out.status, 201);
  assert.deepEqual(await out.json(), { ok: true });
  assert.equal(out.headers.get("Cache-Control"), "no-store");
  assert.match(out.headers.get("Set-Cookie"), /^admin_session=abc; HttpOnly/);
});

test("streamed (SSR) bodies pass through unread", async () => {
  const stream = new ReadableStream({ start(c) { c.enqueue(new TextEncoder().encode("streamed")); c.close(); } });
  const streamed = applySecurityHeaders(new Response(stream));
  assert.equal(streamed.bodyUsed, false);
  assert.equal(await streamed.text(), "streamed");
  assert.equal(streamed.headers.get("X-Frame-Options"), "DENY");
});

test("CSP allows exactly what the site loads: Turnstile, gallery images, same-origin APIs", () => {
  assert.deepEqual(directive("default-src"), ["'self'"]);
  assert.ok(directive("script-src").includes(TURNSTILE_ORIGIN), "Turnstile api.js");
  assert.ok(directive("script-src").includes("'unsafe-inline'"), "define:vars inline scripts");
  assert.deepEqual(directive("frame-src"), [TURNSTILE_ORIGIN], "Turnstile widget iframe only");
  assert.ok(directive("img-src").includes(IMAGES_ORIGIN), "R2 gallery images");
  assert.ok(directive("img-src").includes("blob:"), "admin upload previews");
  assert.deepEqual(directive("form-action"), ["'self'"]);
  assert.deepEqual(directive("frame-ancestors"), ["'none'"]);
  assert.deepEqual(directive("object-src"), ["'none'"]);
  assert.deepEqual(directive("base-uri"), ["'self'"]);
  assert.ok(!CSP.includes("unsafe-eval"), "no eval needed");
});

// Guards drift: a new third-party <script src>, <iframe src>, or absolute
// <form action> in the source must be allowed by the policy (or fail here).
async function sourceFiles(dir) {
  const out = [];
  for (const e of await readdir(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) out.push(...(await sourceFiles(p)));
    else if (/\.(astro|ts|tsx|js|mjs)$/.test(e.name)) out.push(p);
  }
  return out;
}
const originOf = (u) => new URL(u).origin;
const allowedBy = (name, origin) =>
  directive(name).includes(origin) || (origin === SITE_ORIGIN && directive(name).includes("'self'"));

test("every external script, iframe, and form target in src/ is covered by the CSP", async () => {
  const files = await sourceFiles(new URL("../src", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1"));
  const found = { script: new Set(), frame: new Set(), form: new Set() };
  for (const f of files) {
    const src = await readFile(f, "utf8");
    for (const m of src.matchAll(/<script[^>]*\ssrc=["'](https:\/\/[^"']+)["']/gi)) found.script.add(originOf(m[1]));
    for (const m of src.matchAll(/<iframe[^>]*\ssrc=["'](https:\/\/[^"']+)["']/gi)) found.frame.add(originOf(m[1]));
    for (const m of src.matchAll(/<form[^>]*\saction=["'](https:\/\/[^"']+)["']/gi)) found.form.add(originOf(m[1]));
  }
  assert.ok(found.script.has(TURNSTILE_ORIGIN), "scanner sees the Turnstile script (sanity check)");
  for (const o of found.script) assert.ok(allowedBy("script-src", o), `script-src allows ${o}`);
  for (const o of found.frame) assert.ok(allowedBy("frame-src", o), `frame-src allows ${o}`);
  for (const o of found.form) assert.ok(allowedBy("form-action", o), `form-action allows ${o}`);
});

test("contact form posts to the same origin in production", async () => {
  const page = await readFile(new URL("../src/pages/contact.astro", import.meta.url), "utf8");
  assert.match(page, /action=\{ENDPOINT\}/);
  assert.match(page, /const ENDPOINT = CONTACT_ENDPOINT;/);
  // Production build value, observed live on 2026-11-21.
  assert.ok(allowedBy("form-action", originOf("https://kilcon.work/api/contact")));
});

test("middleware applies the headers to every on-demand response", async () => {
  const mw = await readFile(new URL("../src/middleware.ts", import.meta.url), "utf8");
  assert.match(mw, /export const onRequest = defineMiddleware\(/);
  assert.match(mw, /return applySecurityHeaders\(await next\(\)\);/);
  const cfg = await readFile(new URL("../astro.config.mjs", import.meta.url), "utf8");
  assert.match(cfg, /output:\s*'server'/, "server output is why middleware (not _headers) is used");
});

// The CSP is enforced, so every absolute URL in src/ must be either allowed by a
// fetch directive or navigation/metadata only (links and XML/JSON-LD namespaces).
test("every absolute origin in src/ is covered by the enforced CSP or is navigation-only", async () => {
  const files = await sourceFiles(new URL("../src", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1"));
  const NAVIGATION_ONLY = new Set(["https://www.facebook.com", "https://schema.org", "http://www.w3.org", "http://www.sitemaps.org"]);
  const fetchable = new Set([SITE_ORIGIN, IMAGES_ORIGIN, TURNSTILE_ORIGIN, CF_INSIGHTS_SCRIPT_ORIGIN, CF_INSIGHTS_REPORT_ORIGIN]);
  assert.ok(directive("script-src").includes(CF_INSIGHTS_SCRIPT_ORIGIN), "Cloudflare Web Analytics beacon (edge-injected)");
  assert.ok(directive("connect-src").includes(CF_INSIGHTS_REPORT_ORIGIN), "Web Analytics reports");
  for (const f of files) {
    for (const m of (await readFile(f, "utf8")).matchAll(/https?:\/\/[A-Za-z0-9.-]+/g)) {
      assert.ok(fetchable.has(m[0]) || NAVIGATION_ONLY.has(m[0]), `${f}: ${m[0]} is not allowed by the CSP`);
    }
  }
  assert.ok(directive("img-src").includes(IMAGES_ORIGIN));
  assert.ok(directive("connect-src").includes(TURNSTILE_ORIGIN));
});

// Enforced since 2026-11-24 (production browser checks passed). Changing this back to
// report-only must be a deliberate edit of this test, not a stray flag flip.
test("production policy is enforced", () => {
  assert.equal(CSP_ENFORCE, true);
  assert.equal(SECURITY_HEADERS["Content-Security-Policy"], CSP);
  assert.equal(SECURITY_HEADERS["Content-Security-Policy-Report-Only"], undefined);
});

// --- Nonce report-only observation policy (2026-11-26) ---------------------
import {
  CSP_NONCE_REPORT_ONLY,
  CSP_REPORT_PATH,
  NONCE_REPORT_ONLY_HEADER,
  nonceReportOnlyCsp,
  generateNonce,
} from "../src/utils/securityHeaders.ts";
import { parseCspReports, MAX_REPORT_BYTES } from "../src/lib/csp-report.js";

const html = () => new Response("<h1>ok</h1>", { headers: { "Content-Type": "text/html; charset=utf-8" } });
const parse = (policy) => new Map(policy.split(/;\s*/).map((d) => { const [k, ...v] = d.split(/\s+/); return [k, v]; }));

test("the enforced policy is unchanged and still allows 'unsafe-inline' during observation", () => {
  assert.equal(CSP_ENFORCE, true);
  assert.ok(directive("script-src").includes("'unsafe-inline'"), "unsafe-inline stays until the window passes");
  assert.ok(!CSP.includes("nonce-"), "no nonce in the enforced header yet");
  assert.equal(applySecurityHeaders(html()).headers.get("Content-Security-Policy"), CSP);
});

test("HTML responses get a nonce report-only policy: enforced policy minus 'unsafe-inline', plus nonce and report-uri", () => {
  assert.equal(CSP_NONCE_REPORT_ONLY, true);
  const ro = applySecurityHeaders(html()).headers.get(NONCE_REPORT_ONLY_HEADER);
  assert.ok(ro, "present on HTML");
  const p = parse(ro);
  const script = p.get("script-src");
  assert.equal(script[0], "'self'");
  assert.match(script[1], /^'nonce-[A-Za-z0-9+/]{22}=='$/);
  assert.ok(!script.includes("'unsafe-inline'"));
  assert.deepEqual(script.filter((s) => !s.startsWith("'nonce-")), directive("script-src").filter((s) => s !== "'unsafe-inline'"));
  for (const [k] of CSP_DIRECTIVES) if (k !== "script-src") assert.deepEqual(p.get(k), directive(k), k);
  assert.deepEqual(p.get("report-uri"), [CSP_REPORT_PATH]);
});

test("the nonce is fresh per response and 128-bit", () => {
  const seen = new Set();
  for (let i = 0; i < 50; i++) {
    const n = generateNonce();
    assert.equal(atob(n).length, 16);
    seen.add(n);
    seen.add(parse(applySecurityHeaders(html()).headers.get(NONCE_REPORT_ONLY_HEADER)).get("script-src")[1]);
  }
  assert.equal(seen.size, 100);
  assert.match(nonceReportOnlyCsp("abc"), /script-src 'self' 'nonce-abc' /);
});

test("non-HTML responses (JSON, redirects, plain text, assets) get no report-only header", () => {
  const json = new Response("{}", { headers: { "Content-Type": "application/json" } });
  assert.equal(applySecurityHeaders(json).headers.get(NONCE_REPORT_ONLY_HEADER), null);
  assert.equal(applySecurityHeaders(Response.redirect("https://kilcon.work/", 302)).headers.get(NONCE_REPORT_ONLY_HEADER), null);
  assert.equal(applySecurityHeaders(new Response("x")).headers.get(NONCE_REPORT_ONLY_HEADER), null);
  assert.equal(applySecurityHeaders(new Response(null, { status: 204 })).headers.get(NONCE_REPORT_ONLY_HEADER), null);
});

test("a report-only header a route set is not overwritten", () => {
  const r = new Response("<p>", { headers: { "Content-Type": "text/html", [NONCE_REPORT_ONLY_HEADER]: "default-src 'none'" } });
  assert.equal(applySecurityHeaders(r).headers.get(NONCE_REPORT_ONLY_HEADER), "default-src 'none'");
});

test("CSP reports: both formats parsed; query strings and fragments dropped; bounded", () => {
  const legacy = JSON.stringify({ "csp-report": {
    "document-uri": "https://kilcon.work/contact?name=Jane&email=j@example.com#x",
    "violated-directive": "script-src-elem", "effective-directive": "script-src-elem",
    "blocked-uri": "inline", "source-file": "https://kilcon.work/contact?x=1", "line-number": 12,
    "script-sample": "(function(){function c(){var b=a.contentDocument||(a.contentWindow&&a.contentWindow.document)", "disposition": "report",
  } });
  const [r] = parseCspReports(legacy);
  assert.deepEqual(r, { directive: "script-src-elem", blocked: "inline", page: "https://kilcon.work/contact",
    source: "https://kilcon.work/contact", line: 12, sample: "(function(){function c(){var b=a.contentDocument||(a.content", disposition: "report" });
  assert.ok(!JSON.stringify(r).includes("Jane") && !JSON.stringify(r).includes("example.com"));

  const modern = JSON.stringify([
    { type: "csp-violation", body: { documentURL: "https://kilcon.work/reviews?sent=1", effectiveDirective: "script-src-elem", blockedURL: "https://evil.example/x.js?t=1", disposition: "report" } },
    { type: "deprecation", body: {} },
  ]);
  assert.deepEqual(parseCspReports(modern).map((x) => [x.page, x.blocked]), [["https://kilcon.work/reviews", "https://evil.example/x.js"]]);

  for (const bad of ["", "not json", "null", "{}", "[]", JSON.stringify({ "csp-report": "x" }), "x".repeat(MAX_REPORT_BYTES + 1)]) {
    assert.deepEqual(parseCspReports(bad), [], bad.slice(0, 20));
  }
  const many = JSON.stringify(Array.from({ length: 50 }, () => ({ type: "csp-violation", body: { blockedURL: "inline" } })));
  assert.equal(parseCspReports(many).length, 10);
});

test("the report endpoint answers 204, is rate-limited, and only logs parsed summaries", async () => {
  const src = await readFile(new URL("../src/pages/api/csp-report.ts", import.meta.url), "utf8");
  assert.match(src, /status: 204/);
  assert.match(src, /limiter\.limit\(\{ key: `csp-report:\$\{ip\}` \}\)/);
  assert.match(src, /parseCspReports\(/);
  assert.match(src, /console\.log\("\[csp-report\]", JSON\.stringify\(report\)\)/);
  assert.doesNotMatch(src, /console\.log\([^)]*text\b/, "the raw body is never logged");
});
