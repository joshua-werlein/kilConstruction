// KIL Construction Contact Worker: kilcon.work/api/contact.
//
// Two callers, one pipeline (honeypot -> rate limit -> phone/input checks ->
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
//  - WRITE_LIMITER   (Rate limit binding — namespace 1002, shared with
//                      kilcon-gallery-worker's /api/reviews/submit limiter)

export default {
  async fetch(request, env) {
    return router(request, env);
  },
};

async function router(request, env) {
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

const ALLOWED_ORIGINS = [
  "https://kilcon.work",
  "http://localhost:4321",
];

// ====== Rate limiting (native binding) ==================================

async function checkRateLimit(limiter, key) {
  try {
    const { success } = await limiter.limit({ key });
    return success;
  } catch (e) {
    console.error("[rateLimit] binding error:", e);
    return true; // fail open
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
  delivery:   [502, () => textResponse("Email provider error", 502)],
  media_type: [415, () => textResponse("Send as form-urlencoded", 415)],
  error:      [500, () => textResponse("Something went wrong. Please try again later.", 500)],
};

function jsonResponse(request, outcome) {
  const [status] = OUTCOMES[outcome] ?? OUTCOMES.error;
  const ok = outcome === "sent" || outcome === "honeypot";
  const origin = request.headers.get("Origin") || "";
  const headers = {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    "access-control-allow-origin": ALLOWED_ORIGINS.includes(origin) ? origin : "https://kilcon.work",
    vary: "Origin",
    ...SECURITY_HEADERS,
  };
  if (outcome === "rate") headers["retry-after"] = "60";
  return new Response(JSON.stringify(ok ? { ok: true } : { ok: false, error: outcome }), { status, headers });
}

// --- Contact handler ---
async function handleContact(request, env) {
  if (!request || !request.headers) {
    return textResponse("Bad request", 400);
  }
  const json = wantsJson(request);
  if (json && !ALLOWED_ORIGINS.includes(request.headers.get("Origin") || "")) {
    // JSON answers are only for the site's own pages.
    return new Response(JSON.stringify({ ok: false, error: "origin" }), {
      status: 403,
      headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", ...SECURITY_HEADERS },
    });
  }
  const outcome = await processContact(request, env);
  if (json) return jsonResponse(request, outcome);
  return (OUTCOMES[outcome] ?? OUTCOMES.error)[1]();
}

/** Runs the checks and delivery. Returns an outcome key of OUTCOMES. */
async function processContact(request, env) {
  const ct = request.headers.get("content-type") || "";
  if (
    !ct.includes("application/x-www-form-urlencoded") &&
    !ct.includes("multipart/form-data")
  ) {
    if (ct.includes("application/json")) {
      return "media_type";
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
    if (company) { return "honeypot"; }

    // Rate limiting (native binding)
    const ip = request.headers.get("CF-Connecting-IP") || "unknown";
    const allowed = await checkRateLimit(env.WRITE_LIMITER, `contact:${ip}`);
    if (!allowed) {
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
