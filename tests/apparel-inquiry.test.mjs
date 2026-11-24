// Run: npm run test:site
// Apparel "Request This Item" (replaces Stripe checkout, 2026-11-22).
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import {
  sizeOptions, validateInquiry, inquiryQuery, parseInquiry, formatInquiryMessage, cleanNotes,
  OTHER_SIZE, STANDARD_SIZES, MAX_NOTES_LENGTH, NOTES_STORAGE_KEY,
  validateName, validateEmail, validateRequestForm, encodeHandoff, decodeHandoff,
  HANDOFF_STORAGE_KEY, HANDOFF_MAX_AGE_MS,
} from "../src/lib/apparel-inquiry.js";
import { encodeDraft, decodeDraft, DRAFT_MAX_AGE_MS } from "../src/lib/contact-draft.js";

const root = new URL("../", import.meta.url);
const read = (p) => readFile(new URL(p, root), "utf8");

test("size options: enabled sizes are listed, otherwise every defined size, always plus Other", () => {
  const rows = [
    { size: "S", active: 0, stock: 0 }, { size: "M", active: 1, stock: 3 }, { size: "L", active: 1, stock: 0 },
  ];
  assert.deepEqual(sizeOptions(rows), [
    { value: "M", label: "M (in stock)" }, { value: "L", label: "L" },
    { value: OTHER_SIZE, label: "Other size (not listed)" },
  ]);
  // Production today: 7 sizes, none enabled -> all 7 offered (stock and price never block a request).
  const none = STANDARD_SIZES.map((size) => ({ size, active: 0, stock: 0 }));
  assert.deepEqual(sizeOptions(none).map((o) => o.value), [...STANDARD_SIZES, OTHER_SIZE]);
  // No database rows at all -> standard sizes.
  assert.deepEqual(sizeOptions([]).map((o) => o.value), [...STANDARD_SIZES, OTHER_SIZE]);
  assert.deepEqual(sizeOptions(null).map((o) => o.value), [...STANDARD_SIZES, OTHER_SIZE]);
});

test("validation: size, custom size, quantity and item", () => {
  const base = { slug: "coats", title: "Coats", size: "XL", quantity: "2", notes: "" };
  assert.deepEqual(validateInquiry(base), { ok: true, request: { slug: "coats", title: "Coats", size: "XL", customSize: false, quantity: 2, notes: "" } });
  assert.equal(validateInquiry({ ...base, size: "" }).error, "size");
  assert.equal(validateInquiry({ ...base, size: OTHER_SIZE, customSize: "  " }).error, "custom_size");
  const other = validateInquiry({ ...base, size: OTHER_SIZE, customSize: "5XL tall" });
  assert.equal(other.request.size, "5XL tall");
  assert.equal(other.request.customSize, true);
  for (const q of ["0", "100", "1.5", "-1", "abc", "", "1e2"]) assert.equal(validateInquiry({ ...base, quantity: q }).error, "quantity", q);
  for (const s of ["../x", "Coats", "a b", "", "a".repeat(81)]) assert.equal(validateInquiry({ ...base, slug: s }).error, "item", s);
});

test("text is cleaned: control characters, whitespace and length", () => {
  const r = validateInquiry({ slug: "t-shirts", title: "T\u0000-Shirts\n\n", size: OTHER_SIZE, customSize: "x".repeat(50), quantity: 1, notes: "a\r\n\r\n\r\n\r\nb\u0007" + "n".repeat(600) });
  assert.equal(r.request.title, "T -Shirts");
  assert.equal(r.request.size.length, 30);
  assert.ok(r.request.notes.startsWith("a\n\nb "));
  assert.equal(r.request.notes.length, MAX_NOTES_LENGTH);
  assert.equal(cleanNotes("  hi  "), "hi");
});

test("round trip: the /contact URL carries item, size and quantity but never notes", () => {
  const { request } = validateInquiry({ slug: "coats", title: "Coats", size: OTHER_SIZE, customSize: "Tall L", quantity: 3, notes: "Call me at 555-0100" });
  const qs = inquiryQuery(request);
  assert.ok(!qs.includes("555") && !qs.toLowerCase().includes("notes"), "notes stay out of the URL");
  const back = parseInquiry(new URLSearchParams(qs), request.notes);
  assert.deepEqual(back, request);
  // Tampered or absent parameters are ignored.
  assert.equal(parseInquiry(new URLSearchParams("item=coats&size=M&qty=1")), null);
  assert.equal(parseInquiry(new URLSearchParams("inquiry=apparel&item=../x&size=M&qty=1")), null);
  assert.equal(parseInquiry(new URLSearchParams("inquiry=apparel&item=coats&size=M&qty=500")), null);
});

test("message: readable, long enough for the Contact Worker, mentions unlisted sizes", () => {
  const listed = formatInquiryMessage({ slug: "coats", title: "Coats", size: "XL", customSize: false, quantity: 2, notes: "" });
  assert.equal(listed, "Apparel request\nItem: Coats\nSize: XL\nQuantity: 2\n\nPlease confirm price and availability.");
  assert.ok(listed.length >= 10);
  const custom = formatInquiryMessage({ slug: "coats", title: "Coats", size: "5XL", customSize: true, quantity: 1, notes: "Navy" });
  assert.match(custom, /Requested size \(not listed\): 5XL/);
  assert.match(custom, /Notes: Navy/);
});

test("item page: Request This Item replaces checkout, no Stripe, no inline data", async () => {
  const page = await read("src/pages/apparel/[slug].astro");
  assert.match(page, />Request This Item</);
  assert.match(page, /action="\/contact"/);
  assert.match(page, /name="qty"[^>]*max=\{MAX_QTY\}/);
  assert.match(page, /id="notesInput"[^>]*maxlength=\{MAX_NOTES_LENGTH\}/);
  assert.match(page, /sizeOptions\(variantRows\)/);
  assert.match(page, /ORDER BY CASE size WHEN 'S' THEN 1 WHEN 'M' THEN 2/, "size values are quoted SQL literals");
  assert.match(page, /validateRequestForm\(/);
  assert.match(page, /submitInquiry\(/, "sent directly from the item page");
  assert.doesNotMatch(page, /location\.(assign|href\s*=)|sessionStorage/, "no redirect to /contact and no hand-off with JavaScript on");
  assert.doesNotMatch(page, /stripe|checkout|Checkout|define:vars/i);
});

test("contact page: prefill only, same form, endpoint and Turnstile", async () => {
  const page = await read("src/pages/contact.astro");
  assert.match(page, /decodeHandoff\(raw, params\.get\("item"\)/, "handoff only for the item in the URL");
  assert.match(page, /parseInquiry\(params, handoff\?\.notes/);
  assert.match(page, /if \(field && value && !field\.value\.trim\(\)\) field\.value = value;/, "never overwrites typed text");
  for (const id of ["name", "email", "message"]) assert.ok(page.includes(`fill("${id}"`), id);
  assert.match(page, /sessionStorage\.removeItem\(HANDOFF_STORAGE_KEY\)/, "read once");
  assert.match(page, /sessionStorage\.removeItem\(NOTES_STORAGE_KEY\)/, "legacy key cleared");
  assert.match(page, /note\.textContent = /, "text, never HTML");
  assert.doesNotMatch(page, /innerHTML/);
  assert.match(page, /action=\{ENDPOINT\}/);
  assert.match(page, /class="cf-turnstile"/);
  assert.match(page, /name="company"/, "honeypot kept");
  assert.equal(NOTES_STORAGE_KEY, "kil-apparel-inquiry-notes");
});

test("the Contact Worker has one pipeline for both callers (behaviour is tested in workers/kilcon-contact/test)", async () => {
  const worker = await read("workers/kilcon-contact/src/index.js");
  assert.doesNotMatch(worker, /form\.get\("(item|size|qty|slug)"\)/, "no apparel-specific fields: requests are ordinary messages");
  assert.match(worker, /cf-turnstile-response/);
  assert.match(worker, /api\.resend\.com/);
  assert.match(worker, /reply_to: email/);
  assert.match(worker, /if \(json\) return jsonResponse\(request, outcome\);/);
});

test("Stripe endpoints answer 410 and read nothing", async () => {
  for (const f of ["checkout", "webhook"]) {
    const src = await read(`src/pages/api/stripe/${f}.ts`);
    assert.doesNotMatch(src, /runtimeEnv|env\.|STRIPE_|\.prepare\(|fetch\(/, `${f}: no env, secrets, DB or network`);
    assert.match(src, /status: 410/);
    assert.match(src, /export const ALL: APIRoute/);
  }
});

test("no site code needs Stripe secrets or the payments switch", async () => {
  const { readdir } = await import("node:fs/promises");
  const walk = async (dir, out = []) => {
    for (const e of await readdir(new URL(dir, root), { withFileTypes: true })) {
      const p = `${dir}/${e.name}`;
      if (e.isDirectory()) await walk(p, out); else if (/\.(astro|ts|js|mjs)$/.test(e.name)) out.push(p);
    }
    return out;
  };
  for (const f of await walk("src")) {
    assert.doesNotMatch(await read(f), /STRIPE_SECRET_KEY|STRIPE_WEBHOOK_SECRET|PAYMENTS_ENABLED|checkout\.stripe\.com|api\.stripe\.com/, f);
  }
});

test("admin apparel save requires an admin session and no Stripe Price ID; history is never rewritten", async () => {
  const src = await read("src/pages/api/admin/apparel/variants.save.ts");
  const authAt = src.indexOf("verifyAdminToken(auth, ADMIN_SECRET, SESSION_VERSION)");
  assert.ok(authAt > 0, "verifies the admin session");
  assert.ok(authAt < src.indexOf("request.json()"), "before reading the body");
  assert.ok(authAt < src.indexOf("db.prepare"), "before touching the database");
  assert.match(src, /return json\(\{ error: "unauthorized" \}, 401\)/);
  assert.doesNotMatch(src, /active_requires_stripe_price_id|active_requires_price/);
  assert.doesNotMatch(src, /stripe_price_id = \?/, "stripe_price_id is never written");
  assert.doesNotMatch(src, /DELETE|DROP|apparel_orders/i, "orders are never touched");
  const editor = await read("src/pages/admin/apparel/[slug].astro");
  assert.doesNotMatch(editor, /Stripe Price ID<\/th>|class="stripe admin-input"|stripePriceId/);
});

test("retiring payments adds no migration: order tables and records stay as they are", async () => {
  const { readdir } = await import("node:fs/promises");
  // 010/011 rebuilt apparel_orders long before this change (already applied in production).
  const LAST_APPLIED = "018_facebook_highlights.sql";
  const files = (await readdir(new URL("migrations/", root))).sort();
  assert.equal(files.at(-1), LAST_APPLIED, "a new migration needs its own review; this change must not add one");
});

test("names: letters in any script with spaces, hyphens, apostrophes and periods; 2-100 characters", () => {
  for (const n of ["Li", "Ana María O’Neil", "José-Luis Pérez", "Mary-Kate O'Brien Jr.", "  Sam   Lee  ", "Nguyễn Văn An", "Zoë"]) {
    assert.equal(validateName(n).ok, true, n);
  }
  assert.equal(validateName("  Sam   Lee  ").value, "Sam Lee");
  assert.equal(validateName("Bob\u0000").value, "Bob", "control characters are stripped, not kept");
  for (const n of ["", " ", "A", "R2D2", "<script>", "a@b.com", "-Bob", "'Bob", "x".repeat(101)]) {
    assert.equal(validateName(n).ok, false, JSON.stringify(n));
  }
});

test("emails: practical format, length-capped, stricter than the Contact Worker", () => {
  const workerAccepts = (e) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e); // workers/kilcon-contact/src/index.js
  for (const e of ["a@b.co", "first.last+tag@sub.example.org", "o'neil@example.ie", "x_y@mail-host.com"]) {
    assert.equal(validateEmail(e).ok, true, e);
    assert.equal(workerAccepts(validateEmail(e).value), true, `worker accepts ${e}`);
  }
  for (const e of ["", "a@b", "a b@c.com", "a@-b.com", "a@b-.com", "a..b@c.com", ".a@c.com", "a.@c.com", "\"x\"@y.com",
    "a@b.c", "a@b.c1", "a@@b.com", "<a@b.com>", `${"a".repeat(65)}@b.com`, `a@${"b".repeat(250)}.com`]) {
    assert.equal(validateEmail(e).ok, false, JSON.stringify(e));
  }
  assert.equal(validateEmail("  a@b.co ").value, "a@b.co");
});

test("request form: name and email required, every error reported in form order", () => {
  const base = { name: "Pat Doe", email: "pat@example.com", slug: "coats", title: "Coats", size: "M", quantity: "1", notes: "Navy" };
  const ok = validateRequestForm(base);
  assert.equal(ok.ok, true);
  assert.deepEqual(ok.contact, { name: "Pat Doe", email: "pat@example.com" });
  assert.equal(ok.request.notes, "Navy");
  assert.deepEqual(validateRequestForm({ ...base, name: "", email: "bad" }).errors, ["name", "email"]);
  assert.deepEqual(validateRequestForm({ ...base, email: "", size: "" }).errors, ["email", "size"]);
  assert.equal(validateRequestForm({ ...base, name: " " }).error, "name");
  // Other size and quantity rules still apply.
  assert.deepEqual(validateRequestForm({ ...base, size: OTHER_SIZE, customSize: "" }).errors, ["custom_size"]);
  assert.equal(validateRequestForm({ ...base, size: OTHER_SIZE, customSize: "Youth M" }).request.size, "Youth M");
  assert.deepEqual(validateRequestForm({ ...base, quantity: "0" }).errors, ["quantity"]);
});

test("handoff: name, email and notes reach /contact only via sessionStorage, for the same item, once and fresh", () => {
  const now = 1_800_000_000_000;
  const { request, contact } = validateRequestForm({ name: "Pat Doe", email: "pat@example.com", slug: "coats", title: "Coats", size: "L", quantity: "2", notes: "Call 555-0100" });
  const raw = encodeHandoff({ slug: request.slug, ...contact, notes: request.notes }, now);
  const qs = inquiryQuery(request);
  for (const secret of ["Pat", "pat", "%40", "555"]) assert.ok(!qs.includes(secret), `URL has no ${secret}`);
  assert.deepEqual(decodeHandoff(raw, "coats", now + 1000), { name: "Pat Doe", email: "pat@example.com", notes: "Call 555-0100" });
  assert.equal(decodeHandoff(raw, "t-shirts", now), null, "another item's details are not used");
  assert.equal(decodeHandoff(raw, "coats", now + HANDOFF_MAX_AGE_MS + 1), null, "expired");
  assert.equal(decodeHandoff(raw, "coats", now - 120_000), null, "from the future");
  assert.equal(decodeHandoff(null, "coats", now), null);
  assert.equal(decodeHandoff("{not json", "coats", now), null);
  assert.equal(decodeHandoff("x".repeat(5000), "coats", now), null);
  const tampered = JSON.stringify({ ...JSON.parse(raw), email: "<img src=x onerror=alert(1)>" });
  assert.equal(decodeHandoff(tampered, "coats", now), null, "tampered fields are rejected, not rendered");
  assert.equal(HANDOFF_STORAGE_KEY, "kil-apparel-inquiry");
  assert.notEqual(HANDOFF_STORAGE_KEY, NOTES_STORAGE_KEY);
});

test("item page: Full Name and Email Address are required, accessible, and never sent in the no-JS GET", async () => {
  const page = await read("src/pages/apparel/[slug].astro");
  assert.match(page, /<label for="nameInput">Full Name<\/label>/);
  assert.match(page, /<label for="emailInput">Email Address<\/label>/);
  const tag = (id) => page.match(new RegExp(`<(?:input|textarea)[^>]*id="${id}"[^>]*>`))?.[0] ?? "";
  for (const id of ["nameInput", "emailInput", "notesInput"]) {
    assert.ok(tag(id), id);
    assert.doesNotMatch(tag(id), /\sname=/, `${id} has no name attribute, so the GET fallback can't put it in the URL`);
  }
  assert.match(tag("nameInput"), /autocomplete="name"/);
  assert.match(tag("emailInput"), /type="email"[^>]*autocomplete="email"/);
  for (const id of ["nameInput", "emailInput"]) assert.match(tag(id), /required aria-required="true" aria-describedby="\w+Error"/, id);
  for (const id of ["nameError", "emailError", "sizeError", "customSizeError", "qtyError"]) assert.ok(page.includes(`id="${id}"`), id);
  assert.match(page, /setAttribute\("aria-invalid", "true"\)/);
  assert.match(page, /first\?\.focus\(\)/, "focus moves to the first invalid field");
  assert.match(page, /id="requestError"[^>]*role="alert"/);
  assert.match(page, /value=\{o\.value\}/, "size options kept");
  assert.match(page, /id="customSize"/, "Other size kept");
  assert.doesNotMatch(page, /innerHTML/);
  // Honeypot and Turnstile have no `name`, so neither can reach the no-JS GET URL.
  assert.doesNotMatch(tag("apparelCompany"), /\sname=/);
  const widget = page.match(/<div\s+id="apparelTurnstile"[\s\S]*?>/)?.[0] ?? "";
  assert.doesNotMatch(widget, /cf-turnstile/, "explicit render only (no implicit widget)");
  assert.match(widget, /data-sitekey=\{TURNSTILE_SITE_KEY\}/);
  assert.match(page, /<script src="https:\/\/challenges\.cloudflare\.com\/turnstile\/v0\/api\.js\?render=explicit&onload=kilApparelTurnstileLoad" async defer><\/script>/);
  assert.match(page, /"response-field": false,/, "no hidden token input in the GET form");
  assert.match(page, /"refresh-expired": "auto",/);
  assert.match(page, /size: widget\.clientWidth < 300 \? "compact" : "flexible",/, "narrow phones get the compact widget");
  assert.match(page, /Object\.assign\(window, \{ kilApparelTurnstileLoad: renderTurnstile \}\);\s*renderTurnstile\(\);/, "renders whichever script loads first");
  assert.match(page, /min-height: 44px; \/\* touch target \*\//);
  assert.match(page, /<noscript>[\s\S]*contact page[\s\S]*<\/noscript>/);
});

test("item page: one request at a time, success only on {ok:true}, entries kept on failure", async () => {
  const page = await read("src/pages/apparel/[slug].astro");
  const handler = page.slice(page.indexOf('form.addEventListener("submit"'));
  assert.ok(handler.indexOf("if (inFlight) return;") < handler.indexOf("submitInquiry("), "double submissions are ignored");
  assert.ok(handler.indexOf("setBusy(true)") < handler.indexOf("submitInquiry("), "button disabled while sending");
  assert.match(handler, /if \(!token \|\| expired\)/, "missing or expired Turnstile token blocks sending");
  assert.match(handler, /resetTurnstile\(\); \/\/ a token is valid for one verification only/);
  const okAt = handler.indexOf("if (outcome.ok)");
  assert.ok(okAt > 0 && handler.indexOf("form.reset()") > okAt, "fields are cleared only after success");
  assert.ok(handler.indexOf("success.focus()") > okAt);
  assert.match(handler, /setError\(messageFor\(outcome\.code\), outcome\.code\);/);
  assert.match(page, /id="requestSuccess" class="apparel-success" role="status" tabindex="-1" hidden/);
  assert.match(page, /\.apparel-form\[hidden\],/, "global form{display:grid} can't defeat hidden");
  assert.match(page, /data-endpoint=\{CONTACT_ENDPOINT\}/);
});

test("contact draft: kept in sessionStorage only to survive an error redirect, capped and expiring", async () => {
  const now = 1_800_000_000_000;
  const raw = encodeDraft({ name: "Pat", email: "pat@example.com", phone: "715", address: "1 Main", message: "m".repeat(9000), company: "spam" }, now);
  const back = decodeDraft(raw, now + 1);
  assert.equal(back.name, "Pat");
  assert.equal(back.message.length, 5000);
  assert.equal("company" in back, false, "honeypot is never saved");
  assert.equal(decodeDraft(raw, now + DRAFT_MAX_AGE_MS + 1), null);
  assert.equal(decodeDraft("{", now), null);
  assert.equal(decodeDraft(JSON.stringify({ v: 1, t: now, name: { x: 1 } }), now).name, "");
  const page = await read("src/pages/contact.astro");
  assert.match(page, /returnedWithError \? decodeDraft\(/, "restored only after an error");
  assert.match(page, /sessionStorage\.removeItem\(DRAFT_STORAGE_KEY\)/, "discarded otherwise, and after reading");
  assert.match(page, /autocomplete="name"/);
  assert.match(page, /autocomplete="email"/);
});
