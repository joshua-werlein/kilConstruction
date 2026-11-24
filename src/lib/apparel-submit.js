// Apparel "Request This Item": direct, asynchronous submission from the item page
// to the existing Contact Worker (kilcon.work/api/contact), which runs the same
// honeypot, rate limit, Turnstile and Resend delivery as the /contact form.
//
// The request is a POST body (multipart form data) with Accept: application/json,
// so the Worker answers {ok:true} only after Resend accepts the message, or
// {ok:false, error:<code>}. Nothing personal is ever put in a URL.

import { formatInquiryMessage } from "./apparel-inquiry.js";

/** Customer-facing text for each Contact Worker error code. */
export const SUBMIT_MESSAGES = Object.freeze({
  captcha: "The verification expired or didn't pass. Please complete it again, then press Request This Item.",
  rate: "Too many requests from your connection. Please wait a minute, then try again.",
  input: "Please check your name, email address and request, then try again.",
  phone: "Please check your details, then try again.",
  delivery: "We couldn't send your request just now. Your details are still here: please try again in a moment.",
  server: "We couldn't send your request just now. Your details are still here: please try again in a moment.",
  network: "We couldn't reach our server. Check your connection, then try again. Your details are still here.",
  origin: "This form can't be sent from here. Please use our contact page.",
  verification: "Please complete the verification below, then press Request This Item.",
});

export function messageFor(code) {
  return SUBMIT_MESSAGES[code] ?? SUBMIT_MESSAGES.server;
}

/**
 * The form fields the Contact Worker reads. The honeypot is passed through as is
 * (empty for people). Phone and address are left out (optional on the Worker).
 */
export function buildSubmission({ request, contact, token, honeypot = "" }) {
  return {
    name: contact.name,
    email: contact.email,
    message: formatInquiryMessage(request),
    company: honeypot,
    "cf-turnstile-response": token,
  };
}

/** Map a Worker response to {ok:true} or {ok:false, code}. Never trusts a non-JSON body. */
export function interpretResponse(status, body) {
  if (status === 200 && body && body.ok === true) return { ok: true };
  const code = body && typeof body.error === "string" && body.error in SUBMIT_MESSAGES ? body.error
    : status === 429 ? "rate"
    : status === 403 ? "captcha"
    : status === 400 ? "input"
    : "server";
  return { ok: false, code };
}

/**
 * POST the request. `fetchImpl` is window.fetch in the browser (injectable for tests).
 * Resolves to {ok:true} or {ok:false, code}; never throws.
 */
export async function submitInquiry(fetchImpl, endpoint, fields) {
  const fd = new FormData();
  for (const [k, v] of Object.entries(fields)) fd.set(k, v ?? "");
  let res;
  try {
    res = await fetchImpl(endpoint, {
      method: "POST",
      body: fd,
      headers: { Accept: "application/json" },
      credentials: "omit",
      cache: "no-store",
      redirect: "error",
    });
  } catch {
    return { ok: false, code: "network" };
  }
  let body = null;
  try {
    if ((res.headers.get("content-type") || "").includes("application/json")) body = await res.json();
  } catch { /* not JSON */ }
  return interpretResponse(res.status, body);
}
