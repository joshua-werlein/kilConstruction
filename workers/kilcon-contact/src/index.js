/**
 * Welcome to Cloudflare Workers! This is your first worker.
 *
 * - Run "npm run dev" in your terminal to start a development server
 * - Open a browser tab at http://localhost:8787/ to see your worker in action
 * - Run "npm run deploy" to publish your worker
 *
 * Learn more at https://developers.cloudflare.com/workers/
 */

// Bindings expected (add in Settings → Variables):
//  - RESEND_API_KEY  (Secret)
//  - FROM_EMAIL      (Text, a verified Resend sender, e.g. "KilCon <contact@kilcon.work>")
//  - TO_EMAIL        (Text, contractor inbox)
//  - TURNSTILE_SECRET (Text, optional)
//  - RATE_LIMIT_KV   (KV Namespace binding)
/* global RESEND_API_KEY, FROM_EMAIL, TO_EMAIL, TURNSTILE_SECRET, RATE_LIMIT_KV */

addEventListener("fetch", (event) => event.respondWith(router(event)));

async function router(event) {
  const request = event.request;
  const url = new URL(request.url);

  if (request.method === "OPTIONS" && url.pathname === "/api/contact") {
    const origin = request.headers.get("Origin") || "";
    const allow = ALLOWED_ORIGINS.includes(origin) ? origin : "https://kilcon.work";

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
    return handleContact(request);
  }

  return new Response("Not found", { status: 404 });
}

const SECURITY_HEADERS = {
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "strict-origin-when-cross-origin",
  "Permissions-Policy": "camera=(), microphone=(), geolocation=()",
  "X-Frame-Options": "DENY",
};

const ALLOWED_ORIGINS = [
  "https://kilcon.work",
  "http://localhost:4321",
];

// ====== KV-backed rate limiting =========================================

async function rateLimit(request, key, { windowMs, max }) {
  const ip = request.headers.get("CF-Connecting-IP") || "unknown";
  const maxEffective = ip === "unknown" ? Math.min(max, 2) : max;
  const kvKey = `rl:${ip}:${key}`;
  const now = Date.now();

  try {
    const raw = await RATE_LIMIT_KV.get(kvKey);
    let entry = raw ? JSON.parse(raw) : null;

    if (!entry || now > entry.expires) {
      entry = { count: 1, expires: now + windowMs };
      await RATE_LIMIT_KV.put(kvKey, JSON.stringify(entry), {
        expirationTtl: Math.ceil(windowMs / 1000),
      });
      return true;
    }

    entry.count++;
    await RATE_LIMIT_KV.put(kvKey, JSON.stringify(entry), {
      expirationTtl: Math.ceil((entry.expires - now) / 1000),
    });
    return entry.count <= maxEffective;
  } catch (e) {
    console.error("[rateLimit] KV error:", e);
    return true; // fail open
  }
}

// ====== Small helper ====================================================

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

// --- Contact handler ---
async function handleContact(request) {
  if (!request || !request.headers) {
    return textResponse("Bad request", 400);
  }
  const ct = request.headers.get("content-type") || "";
  if (
    !ct.includes("application/x-www-form-urlencoded") &&
    !ct.includes("multipart/form-data")
  ) {
    if (ct.includes("application/json")) {
      return textResponse("Send as form-urlencoded", 415);
    }
  }

  try {
    const form = await request.formData();

    const name    = (form.get("name")    || "").toString().trim();
    const email   = (form.get("email")   || "").toString().trim();
    const address = (form.get("address") || "").toString().trim();
    const message = (form.get("message") || "").toString().trim();

    // honeypot
    const company = (form.get("company") || "").toString().trim();
    if (company) { return redirectBack(request, ""); }

    // KV-backed rate limiting
    const allowed = await rateLimit(request, "contact", {
      windowMs: 10 * 60_000,
      max: 10,
    });
    if (!allowed) {
      return redirectBack(request, "?err=rate");
    }

    const cfToken = (form.get("cf-turnstile-response") || "").toString();

    const rawPhone = (form.get("phone") || "").toString().trim();
    const digits = rawPhone.replace(/\D/g, "");
    if (digits && (digits.length < 7 || digits.length > 15)) {
      return redirectBack(request, "?err=phone");
    }
    const phone = digits;

    const emailOk = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
    if (name.length < 2 || !emailOk || message.length < 10) {
      return redirectBack(request, "?err=input");
    }

    const host = request.headers.get("Host") || "";
    const isProd = host.includes("kilcon.work");
    const requireCaptcha = true;

    if (requireCaptcha) {
      if (!cfToken) {
        console.warn("No Turnstile token submitted");
        return redirectBack(request, "?err=captcha");
      }

      if (typeof TURNSTILE_SECRET === "string" && TURNSTILE_SECRET) {
        let verify;
        try {
          const vr = await fetch("https://challenges.cloudflare.com/turnstile/v0/siteverify", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
              secret: TURNSTILE_SECRET,
              response: cfToken,
              remoteip: request.headers.get("CF-Connecting-IP") || undefined,
            }),
          });
          verify = await vr.json();
        } catch (ve) {
          console.warn("Turnstile verification fetch error:", ve);
          return redirectBack(request, "?err=captcha");
        }

        if (!verify || !verify.success) {
          console.warn("Turnstile failed:", verify?.["error-codes"]);
          return redirectBack(request, "?err=captcha");
        }
      } else if (isProd) {
        console.warn("TURNSTILE_SECRET missing");
        return redirectBack(request, "?err=captcha");
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
      typeof RESEND_API_KEY !== "string" || !RESEND_API_KEY ||
      typeof FROM_EMAIL !== "string"     || !FROM_EMAIL ||
      typeof TO_EMAIL !== "string"       || !TO_EMAIL
    ) {
      console.error("Contact worker misconfigured: missing email env");
      return redirectBack(request, "?err=server");
    }

    let r;
    try {
      r = await fetch("https://api.resend.com/emails", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${RESEND_API_KEY}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          from: FROM_EMAIL,
          to: [TO_EMAIL],
          subject,
          html,
          reply_to: email,
          tags: [{ name: "source", value: "kilcon-work-contact" }],
        }),
      });
    } catch (eSend) {
      console.error("Email send error:", eSend);
      return textResponse("Email provider error", 502);
    }

    if (!r.ok) {
      const text = await r.text();
      console.error("Email provider responded not OK:", text);
      return textResponse("Email provider error", 502);
    }

    return redirectBack(request, "");

  } catch (e) {
    console.error("handleContact unexpected error:", e);
    return textResponse("Something went wrong. Please try again later.", 500);
  }
}

function redirectBack(request, suffix = "") {
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