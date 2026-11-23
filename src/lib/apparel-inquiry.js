// Apparel "Request This Item" workflow (replaces Stripe checkout, 2026-11-22).
//
// The item page collects item, size, quantity and optional notes, then sends the
// customer to the existing /contact form with the message prefilled. The contact
// form (Turnstile, honeypot, rate limit, Resend delivery in the Contact Worker) is
// unchanged: nothing here sends anything.
//
// Item, size and quantity travel in the /contact query string (not personal data).
// Notes may contain personal details, so they travel in sessionStorage instead and
// never appear in a URL, server log or Referer.

export const INQUIRY_PARAM = "inquiry";
export const INQUIRY_VALUE = "apparel";
export const OTHER_SIZE = "__other__";
export const STANDARD_SIZES = ["S", "M", "L", "XL", "XXL", "XXXL", "XXXXL"];
export const MAX_QTY = 99;
export const MAX_SIZE_LENGTH = 30;
export const MAX_TITLE_LENGTH = 80;
export const MAX_NOTES_LENGTH = 500;
export const NOTES_STORAGE_KEY = "kil-apparel-inquiry-notes";

const SLUG_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

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

/** Query string for /contact (no notes). */
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
