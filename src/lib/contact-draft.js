import { CONTACT_LIMITS } from "./contact-limits.js";

// Contact form draft: keeps what the customer typed if the Contact Worker sends
// them back with an error (?err=captcha, rate, input…), which reloads /contact
// with an empty form. Stored only in this tab's sessionStorage, never in a URL,
// read once, and discarded after a successful send or 30 minutes.

export const DRAFT_STORAGE_KEY = "kil-contact-draft";
export const DRAFT_MAX_AGE_MS = 30 * 60 * 1000;
/** Field name -> maximum length kept. */
// Same caps as the form and the Contact Worker (src/lib/contact-limits.js).
export const DRAFT_FIELDS = { ...CONTACT_LIMITS };

/** @param {Record<string, unknown>} values */
export function encodeDraft(values, now = Date.now()) {
  const data = { v: 1, t: now };
  for (const [k, max] of Object.entries(DRAFT_FIELDS)) data[k] = String(values?.[k] ?? "").slice(0, max);
  return JSON.stringify(data);
}

/** Returns the saved fields (strings only, capped) or null when absent, stale or malformed. */
export function decodeDraft(raw, now = Date.now()) {
  if (typeof raw !== "string" || !raw || raw.length > 12000) return null;
  let data;
  try { data = JSON.parse(raw); } catch { return null; }
  if (!data || data.v !== 1 || typeof data.t !== "number") return null;
  if (now - data.t > DRAFT_MAX_AGE_MS || data.t - now > 60 * 1000) return null;
  const out = {};
  for (const [k, max] of Object.entries(DRAFT_FIELDS)) out[k] = typeof data[k] === "string" ? data[k].slice(0, max) : "";
  return out;
}
