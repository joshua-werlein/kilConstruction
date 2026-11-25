// KIL Construction Contact Worker: kilcon.work/api/contact.
//
// Two callers, one pipeline (size/length caps -> honeypot -> rate limit -> phone/input checks ->
// Turnstile -> Resend):
//   - The /contact page's ordinary HTML form POST. Answered with 303 redirects
//     back to /contact (?sent=1 or ?err=...), exactly as before 2026-11-23.
//   - The apparel page's asynchronous request (fetch with Accept: application/json
//     from an allowed Origin). Answered with JSON: {ok:true} only after Resend
//     accepts the message, otherwise {ok:false, error:<code>} with a matching status.
//
// Bindings expected:
//  - RESEND_API_KEY  (Secret)
//  - FROM_EMAIL      (Text, a verified Resend sender, e.g. "KilCon <contact@kilcon.work>")
//  - TO_EMAIL        (Text, contractor inbox)
//  - TURNSTILE_SECRET (Secret; required on kilcon.work)
//  - CONTACT_LIMITER (Durable Object namespace, class ContactRateLimiter in
//                      src/rate-limiter.js): the authoritative limiter, 3 accepted
//                      requests per rolling 60 s per client. Fails closed (503).

import { limiterKey } from "./rate-limiter.js";
export { ContactRateLimiter } from "./rate-limiter.js";

// How long to wait for the limiter before failing closed.
const LIMITER_TIMEOUT_MS = 3000;

export default {
  async fetch(request, env) {
    return router(request, env);
  },
};

async function router(request, env) {
  const url = new URL(request.url);

  if (request.method === "OPTIONS" && url.pathname === "/api/contact") {
    const origin = request.headers.get("Origin") || "";
    const allow = allowedOrigins(env).includes(origin) ? origin : "https://kilcon.work";

    return new Response(null, {
      status: 204,
      headers: {
        "access-control-allow-origin": allow,
        "access-control-allow-methods": "POST,OPTIONS",
        "access-control-allow-headers": "content-type",
        "cache-control": "no-store",
        ...SECURITY_HEADERS,
      },
    });
  }

  if (url.pathname === "/api/contact" && request.method === "POST") {
    return handleContact(request, env);
  }

  return new Response("Not found", { status: 404 });
}

const SECURITY_HEADERS = {
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "strict-origin-when-cross-origin",
  "Permissions-Policy": "camera=(), microphone=(), geolocation=()",
  "X-Frame-Options": "DENY",
};

const PROD_ORIGINS = ["https://kilcon.work"];
// `astro dev` (localhost:4321) talks only to a local `wrangler dev` Worker
// (npm run dev:contact-worker), which passes --var ALLOW_DEV_ORIGINS:true.
// Production never sets that variable, so it never trusts a localhost origin.
// (A hostname check can't tell them apart: wrangler dev rewrites request.url
// to the route host, kilcon.work.)
const DEV_ORIGINS = ["http://localhost:4321", "http://127.0.0.1:4321"];

function allowedOrigins(env) {
  return env?.ALLOW_DEV_ORIGINS === "true" ? [...PROD_ORIGINS, ...DEV_ORIGINS] : PROD_ORIGINS;
}

// Server-side input limits (characters, after trimming). The apparel page caps
// name 100 / email 254 / notes 500, so its generated message stays well under
// MAX.message. Anything larger is refused as "input" before Turnstile or Resend.
export const MAX = {
  body: 32 * 1024,     // bytes, from Content-Length, checked before parsing
  name: 100,
  email: 254,          // RFC 5321 path limit
  phone: 40,           // raw text as typed; digits are checked separately
  address: 300,
  message: 5000,
  token: 2048,         // Turnstile tokens are at most 2048 characters
};

// ====== Rate limiting (Durable Object, authoritative) ====================

/**
 * {ok:true} | {ok:false, retryAfter} | {unavailable:true}. Never fails open: a
 * missing binding, an error or a timeout is "unavailable", and nothing is sent.
 */
async function checkRateLimit(env, ip) {
  const ns = env.CONTACT_LIMITER;
  if (!ns) {
    console.error("[rateLimit] CONTACT_LIMITER binding missing");
    return { unavailable: true };
  }
  let timer;
  try {
    const stub = ns.get(ns.idFromName(limiterKey(ip)));
    const timeout = new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error("limiter timeout")), LIMITER_TIMEOUT_MS);
    });
    const r = await Promise.race([stub.hit(), timeout]);
    if (r && r.ok === true) return { ok: true };
    if (r && r.ok === false) return { ok: false, retryAfter: r.retryAfter };
    console.error("[rateLimit] unexpected limiter answer");
    return { unavailable: true };
  } catch (e) {
    console.error("[rateLimit] limiter unavailable:", e?.message || e);
    return { unavailable: true };
  } finally {
    clearTimeout(timer);
  }
}

// ====== Small helpers ===================================================

function textResponse(body, status = 200) {
  return new Response(body, {
    status,
    headers: {
      "content-type": "text/plain; charset=utf-8",
      "cache-control": "no-store",
      ...SECURITY_HEADERS,
    },
  });
}

/** An asynchronous caller asked for JSON (the apparel page's fetch). */
function wantsJson(request) {
  return (request.headers.get("Accept") || "").toLowerCase().includes("application/json");
}

// Outcome -> [JSON status, form-mode response]. Form mode is unchanged from the
// original handler: redirects for everything except provider and unexpected errors.
const OUTCOMES = {
  sent:       [200, () => redirectBack("")],
  honeypot:   [200, () => redirectBack("")], // bots see success; nothing is sent
  rate:       [429, () => redirectBack("?err=rate")],
  phone:      [400, () => redirectBack("?err=phone")],
  input:      [400, () => redirectBack("?err=input")],
  captcha:    [403, () => redirectBack("?err=captcha")],
  server:     [500, () => redirectBack("?err=server")],
  // The rate limiter could not be reached: fail closed and ask the customer to retry.
  unavailable: [503, () => redirectBack("?err=server")],
  delivery:   [502, () => textResponse("Email provider error", 502)],
  media_type: [415, () => textResponse("Send as form-urlencoded", 415)],
  error:      [500, () => textResponse("Something went wrong. Please try again later.", 500)],
};

function jsonResponse(request, env, outcome, retryAfter) {
  const [status] = OUTCOMES[outcome] ?? OUTCOMES.error;
  const ok = outcome === "sent" || outcome === "honeypot";
  const origin = request.headers.get("Origin") || "";
  const headers = {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    "access-control-allow-origin": allowedOrigins(env).includes(origin) ? origin : "https://kilcon.work",
    vary: "Origin",
    ...SECURITY_HEADERS,
  };
  if (outcome === "rate") headers["retry-after"] = String(retryAfter || 60);
  if (outcome === "unavailable") headers["retry-after"] = "30";
  return new Response(JSON.stringify(ok ? { ok: true } : { ok: false, error: outcome }), { status, headers });
}

// --- Contact handler ---
async function handleContact(request, env) {
  if (!request || !request.headers) {
    return textResponse("Bad request", 400);
  }
  const json = wantsJson(request);
  if (json && !allowedOrigins(env).includes(request.headers.get("Origin") || "")) {
    // JSON answers are only for the site's own pages.
    return new Response(JSON.stringify({ ok: false, error: "origin" }), {
      status: 403,
      headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", ...SECURITY_HEADERS },
    });
  }
  const ctx = {};
  const outcome = await processContact(request, env, ctx);
  if (json) return jsonResponse(request, env, outcome, ctx.retryAfter);
  return (OUTCOMES[outcome] ?? OUTCOMES.error)[1]();
}

/** Runs the checks and delivery. Returns an outcome key of OUTCOMES. */
async function processContact(request, env, ctx = {}) {
  const ct = request.headers.get("content-type") || "";
  if (
    !ct.includes("application/x-www-form-urlencoded") &&
    !ct.includes("multipart/form-data")
  ) {
    if (ct.includes("application/json")) {
      return "media_type";
    }
  }

  const declared = Number(request.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > MAX.body) {
    return "input";
  }

  try {
    const form = await request.formData();

    const name    = (form.get("name")    || "").toString().trim();
    const email   = (form.get("email")   || "").toString().trim();
    const address = (form.get("address") || "").toString().trim();
    const message = (form.get("message") || "").toString().trim();

    // honeypot
    const company = (form.get("company") || "").toString().trim();
    if (company) { return "honeypot"; }

    // Length caps before any external call (rate limiter, Turnstile, Resend).
    const rawPhoneText = (form.get("phone") || "").toString().trim();
    const tokenText = (form.get("cf-turnstile-response") || "").toString();
    if (
      name.length > MAX.name || email.length > MAX.email ||
      address.length > MAX.address || message.length > MAX.message ||
      rawPhoneText.length > MAX.phone || tokenText.length > MAX.token
    ) {
      return "input";
    }

    // Rate limiting (Durable Object). Before Turnstile, so unverified floods count too.
    const ip = request.headers.get("CF-Connecting-IP") || "unknown";
    const limit = await checkRateLimit(env, ip);
    if (limit.unavailable) return "unavailable";
    if (!limit.ok) {
      ctx.retryAfter = limit.retryAfter;
      return "rate";
    }

    const cfToken = (form.get("cf-turnstile-response") || "").toString();

    const rawPhone = (form.get("phone") || "").toString().trim();
    const digits = rawPhone.replace(/\D/g, "");
    if (digits && (digits.length < 7 || digits.length > 15)) {
      return "phone";
    }
    const phone = digits;

    const emailOk = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
    if (name.length < 2 || !emailOk || message.length < 10) {
      return "input";
    }

    const host = request.headers.get("Host") || "";
    const isProd = host.includes("kilcon.work");
    const requireCaptcha = true;

    if (requireCaptcha) {
      if (!cfToken) {
        console.warn("No Turnstile token submitted");
        return "captcha";
      }

      if (typeof env.TURNSTILE_SECRET === "string" && env.TURNSTILE_SECRET) {
        let verify;
        try {
          const vr = await fetch("https://challenges.cloudflare.com/turnstile/v0/siteverify", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
              secret: env.TURNSTILE_SECRET,
              response: cfToken,
              remoteip: request.headers.get("CF-Connecting-IP") || undefined,
            }),
          });
          verify = await vr.json();
        } catch (ve) {
          console.warn("Turnstile verification fetch error:", ve);
          return "captcha";
        }

        if (!verify || !verify.success) {
          console.warn("Turnstile failed:", verify?.["error-codes"]);
          return "captcha";
        }
      } else if (isProd) {
        console.warn("TURNSTILE_SECRET missing");
        return "captcha";
      }
    }

    const subject = `New inquiry from ${name}`;
    const msgHtml = esc(message).replace(/\n/g, "<br>");
    const html = `
      <h2>New Contact Form Submission</h2>
      <p><strong>Name:</strong> ${esc(name)}</p>
      <p><strong>Email:</strong> ${esc(email)}</p>
      <p><strong>Phone:</strong> ${esc(phone)}</p>
      <p><strong>Job Address:</strong> ${esc(address)}</p>
      <p><strong>Message:</strong><br>${msgHtml}</p>
      <hr><p>Sent: ${new Date().toISOString()}</p>
    `;

    if (
      typeof env.RESEND_API_KEY !== "string" || !env.RESEND_API_KEY ||
      typeof env.FROM_EMAIL !== "string"     || !env.FROM_EMAIL ||
      typeof env.TO_EMAIL !== "string"       || !env.TO_EMAIL
    ) {
      console.error("Contact worker misconfigured: missing email env");
      return "server";
    }

    let r;
    try {
      r = await fetch("https://api.resend.com/emails", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${env.RESEND_API_KEY}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          from: env.FROM_EMAIL,
          to: [env.TO_EMAIL],
          subject,
          html,
          reply_to: email,
          tags: [{ name: "source", value: "kilcon-work-contact" }],
        }),
      });
    } catch (eSend) {
      console.error("Email send error:", eSend);
      return "delivery";
    }

    if (!r.ok) {
      const text = await r.text();
      console.error("Email provider responded not OK:", text);
      return "delivery";
    }

    return "sent";

  } catch (e) {
    console.error("handleContact unexpected error:", e);
    return "error";
  }
}

function redirectBack(suffix = "") {
  return Response.redirect(
    "https://kilcon.work/contact" + (suffix || "?sent=1"),
    303
  );
}

function esc(s) {
  return String(s)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}
