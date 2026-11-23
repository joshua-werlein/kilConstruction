// Run: npm run test:site
// Apparel "Request This Item" (replaces Stripe checkout, 2026-11-22).
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import {
  sizeOptions, validateInquiry, inquiryQuery, parseInquiry, formatInquiryMessage, cleanNotes,
  OTHER_SIZE, STANDARD_SIZES, MAX_NOTES_LENGTH, NOTES_STORAGE_KEY,
} from "../src/lib/apparel-inquiry.js";

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
  assert.match(page, /sessionStorage\.setItem\(NOTES_STORAGE_KEY/);
  assert.doesNotMatch(page, /stripe|checkout|Checkout|define:vars/i);
});

test("contact page: prefill only, same form, endpoint and Turnstile", async () => {
  const page = await read("src/pages/contact.astro");
  assert.match(page, /parseInquiry\(params, notes\)/);
  assert.match(page, /if \(message && !message\.value\.trim\(\)\) message\.value = formatInquiryMessage/, "never overwrites typed text");
  assert.match(page, /sessionStorage\.removeItem\(NOTES_STORAGE_KEY\)/);
  assert.match(page, /note\.textContent = /, "text, never HTML");
  assert.doesNotMatch(page, /innerHTML/);
  assert.match(page, /action=\{ENDPOINT\}/);
  assert.match(page, /class="cf-turnstile"/);
  assert.match(page, /name="company"/, "honeypot kept");
  assert.equal(NOTES_STORAGE_KEY, "kil-apparel-inquiry-notes");
});

test("the Contact Worker is untouched by this change", async () => {
  const worker = await read("workers/kilcon-contact/src/index.js");
  assert.doesNotMatch(worker, /apparel/i, "no apparel-specific handling: requests are ordinary messages");
  assert.match(worker, /cf-turnstile-response/);
  assert.match(worker, /api\.resend\.com/);
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
