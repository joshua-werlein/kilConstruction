// Apparel "Request This Item" workflow (replaces Stripe checkout, 2026-11-22).
//
// The item page collects item, size, quantity and optional notes, then sends the
// customer to the existing /contact form with the message prefilled. The contact
// form (Turnstile, honeypot, rate limit, Resend delivery in the Contact Worker) is
// unchanged: nothing here sends anything.
//
// Item, size and quantity travel in the /contact query string (not personal data).
// The customer's name, email and notes are personal, so they travel in this tab's
// sessionStorage (same origin, cleared when read, expires after 30 minutes) and
// never appear in a URL, server log or Referer. The contact form is prefilled
// with them so the customer doesn't type their name and email twice.

export const INQUIRY_PARAM = "inquiry";
export const INQUIRY_VALUE = "apparel";
export const OTHER_SIZE = "__other__";
export const STANDARD_SIZES = ["S", "M", "L", "XL", "XXL", "XXXL", "XXXXL"];
export const MAX_QTY = 99;
export const MAX_SIZE_LENGTH = 30;
export const MAX_TITLE_LENGTH = 80;
export const MAX_NOTES_LENGTH = 500;
export const MAX_NAME_LENGTH = 100;
export const MAX_EMAIL_LENGTH = 254;
/** Before 2026-11-23 only notes were handed over, under this key. Still cleared on read. */
export const NOTES_STORAGE_KEY = "kil-apparel-inquiry-notes";
/** Name, email and notes for /contact (sessionStorage, JSON). */
export const HANDOFF_STORAGE_KEY = "kil-apparel-inquiry";
export const HANDOFF_MAX_AGE_MS = 30 * 60 * 1000;

const SLUG_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
// Letters (any script), combining marks, spaces, apostrophes, periods, commas and
// hyphens; must start with a letter. At least 2 characters (the Contact Worker's minimum).
const NAME_RE = /^[\p{L}\p{M}][\p{L}\p{M}'’ .,-]*$/u;
// A practical address check, stricter than the Contact Worker's, so anything that
// passes here is accepted there: no spaces, quotes or brackets; a dotted domain of
// letters, digits and inner hyphens; a top-level domain of 2+ letters.
const EMAIL_RE = /^[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]{1,64}@(?:[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?\.)+[A-Za-z]{2,63}$/;

/** Collapse whitespace and drop control characters; cap the length. */
export function cleanText(value, max) {
  return String(value ?? "")
    .replace(/[\u0000-\u001f\u007f]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, max);
}

/** Like cleanText but keeps line breaks (for notes). */
export function cleanNotes(value) {
  return String(value ?? "")
    .replace(/\r\n?/g, "\n")
    .replace(/[\u0000-\u0009\u000b-\u001f\u007f]+/g, " ")
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim()
    .slice(0, MAX_NOTES_LENGTH);
}

/**
 * Size choices for the request form. Sizes enabled in admin are "listed"; when an
 * item has none enabled, its defined sizes (or the standard set) are offered so the
 * customer can still ask. Stock and price never block a request.
 * @param {{size: string, active?: number|boolean, stock?: number}[]} variants
 */
export function sizeOptions(variants) {
  const list = Array.isArray(variants) ? variants.filter((v) => v && typeof v.size === "string" && v.size) : [];
  const enabled = list.filter((v) => Number(v.active) === 1);
  const base = enabled.length ? enabled : list.length ? list : STANDARD_SIZES.map((size) => ({ size }));
  const seen = new Set();
  const options = [];
  for (const v of base) {
    const size = cleanText(v.size, MAX_SIZE_LENGTH);
    if (!size || seen.has(size)) continue;
    seen.add(size);
    const inStock = Number(v.active) === 1 && Number(v.stock) > 0;
    options.push({ value: size, label: inStock ? `${size} (in stock)` : size });
  }
  options.push({ value: OTHER_SIZE, label: "Other size (not listed)" });
  return options;
}

function parseQuantity(raw) {
  const s = String(raw ?? "").trim();
  if (!/^\d{1,3}$/.test(s)) return null;
  const n = Number(s);
  return n >= 1 && n <= MAX_QTY ? n : null;
}

/**
 * Validate the request form. Returns {ok:true, request} or {ok:false, error}.
 * @param {{slug:string, title?:string, size?:string, customSize?:string, quantity?:string|number, notes?:string}} input
 */
export function validateInquiry(input) {
  const slug = String(input?.slug ?? "");
  if (!SLUG_RE.test(slug) || slug.length > 80) return { ok: false, error: "item" };
  const title = cleanText(input?.title, MAX_TITLE_LENGTH) || slug;
  const picked = cleanText(input?.size, MAX_SIZE_LENGTH);
  const custom = cleanText(input?.customSize, MAX_SIZE_LENGTH);
  let size;
  let customSize = false;
  if (picked === OTHER_SIZE) {
    if (!custom) return { ok: false, error: "custom_size" };
    size = custom;
    customSize = true;
  } else if (picked) {
    size = picked;
  } else {
    return { ok: false, error: "size" };
  }
  const quantity = parseQuantity(input?.quantity);
  if (quantity === null) return { ok: false, error: "quantity" };
  return { ok: true, request: { slug, title, size, customSize, quantity, notes: cleanNotes(input?.notes) } };
}

/** Validate a full name. Returns {ok:true, value} or {ok:false}. */
export function validateName(raw) {
  const value = cleanText(raw, MAX_NAME_LENGTH + 1);
  if (value.length < 2 || value.length > MAX_NAME_LENGTH || !NAME_RE.test(value)) return { ok: false };
  return { ok: true, value };
}

/** Validate an email address. Returns {ok:true, value} or {ok:false}. */
export function validateEmail(raw) {
  const value = String(raw ?? "").trim();
  if (value.length > MAX_EMAIL_LENGTH || !EMAIL_RE.test(value) || value.includes("..") ||
      value.startsWith(".") || value.includes(".@")) return { ok: false };
  return { ok: true, value };
}

/**
 * Validate the whole Request This Item form (contact details first, in form order).
 * Returns {ok:true, request, contact:{name,email}} or {ok:false, error, errors}.
 */
export function validateRequestForm(input) {
  const errors = [];
  const name = validateName(input?.name);
  if (!name.ok) errors.push("name");
  const email = validateEmail(input?.email);
  if (!email.ok) errors.push("email");
  const inquiry = validateInquiry(input);
  if (!inquiry.ok) errors.push(inquiry.error);
  if (errors.length) return { ok: false, error: errors[0], errors };
  return { ok: true, request: inquiry.request, contact: { name: name.value, email: email.value } };
}

/** sessionStorage value carrying name, email and notes to /contact for this item only. */
export function encodeHandoff({ slug, name, email, notes }, now = Date.now()) {
  return JSON.stringify({ v: 1, slug, name, email, notes: notes || "", t: now });
}

/**
 * Read the handoff back on /contact. Returns {name, email, notes} only when it is
 * for this item, fresh, and every field still validates; otherwise null.
 */
export function decodeHandoff(raw, slug, now = Date.now()) {
  if (typeof raw !== "string" || !raw || raw.length > 4000) return null;
  let data;
  try { data = JSON.parse(raw); } catch { return null; }
  if (!data || data.v !== 1 || data.slug !== slug || typeof data.t !== "number") return null;
  if (now - data.t > HANDOFF_MAX_AGE_MS || data.t - now > 60 * 1000) return null;
  const name = validateName(data.name);
  const email = validateEmail(data.email);
  if (!name.ok || !email.ok) return null;
  return { name: name.value, email: email.value, notes: cleanNotes(data.notes) };
}

/** Query string for /contact (no name, email or notes). */
export function inquiryQuery(request) {
  const qs = new URLSearchParams();
  qs.set(INQUIRY_PARAM, INQUIRY_VALUE);
  qs.set("item", request.slug);
  qs.set("title", request.title);
  qs.set("size", request.size);
  if (request.customSize) qs.set("custom", "1");
  qs.set("qty", String(request.quantity));
  return qs.toString();
}

/** Read an apparel request back from the /contact URL (plus notes). Null if absent or invalid. */
export function parseInquiry(searchParams, notes = "") {
  if (!searchParams || searchParams.get(INQUIRY_PARAM) !== INQUIRY_VALUE) return null;
  const custom = searchParams.get("custom") === "1";
  const result = validateInquiry({
    slug: searchParams.get("item") ?? "",
    title: searchParams.get("title") ?? "",
    size: custom ? OTHER_SIZE : searchParams.get("size") ?? "",
    customSize: custom ? searchParams.get("size") ?? "" : "",
    quantity: searchParams.get("qty") ?? "",
    notes,
  });
  return result.ok ? result.request : null;
}

/** The contact-form message text. The Contact Worker requires at least 10 characters. */
export function formatInquiryMessage(request) {
  const lines = [
    "Apparel request",
    `Item: ${request.title}`,
    `${request.customSize ? "Requested size (not listed)" : "Size"}: ${request.size}`,
    `Quantity: ${request.quantity}`,
  ];
  if (request.notes) lines.push(`Notes: ${request.notes}`);
  lines.push("", "Please confirm price and availability.");
  return lines.join("\n");
}
