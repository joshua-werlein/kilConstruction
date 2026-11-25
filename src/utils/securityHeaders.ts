// Security headers for every on-demand (server-rendered) response.
//
// Why middleware and not public/_headers: the site builds with
// `output: 'server'`, so pages and API routes are answered by _worker.js.
// Cloudflare Pages does not apply _headers rules to Functions/_worker.js
// responses, only to static assets.
//
// Deliberately NOT set here (already added at the Cloudflare zone, so setting
// them would duplicate the header):
//   Strict-Transport-Security, X-Content-Type-Options
//
// The CSP is ENFORCED since 2026-11-24, after a report-only period and production
// browser checks (docs/security-headers.md). To fall back to report-only, set
// CSP_ENFORCE to false.

/** Third-party origins the browser legitimately loads from. */
export const TURNSTILE_ORIGIN = "https://challenges.cloudflare.com";
export const IMAGES_ORIGIN = "https://images.kilcon.work";
// Cloudflare Web Analytics: injected at the edge (not in the HTML source). The
// beacon script loads from static.cloudflareinsights.com and reports to
// cloudflareinsights.com. Found in the 2026-11-23 production report-only check.
export const CF_INSIGHTS_SCRIPT_ORIGIN = "https://static.cloudflareinsights.com";
export const CF_INSIGHTS_REPORT_ORIGIN = "https://cloudflareinsights.com";

export const CSP_DIRECTIVES: ReadonlyArray<readonly [string, string]> = [
  ["default-src", "'self'"],
  // 'unsafe-inline': only Cloudflare's injected challenge-platform bootstrap
  // (per-request content, so no hash). Our own pages have no inline scripts since
  // 2026-11-25 (tests/csp-inline-scripts.test.mjs). It stays until a nonce-based
  // report-only policy has passed its observation window (docs/security-headers.md).
  ["script-src", `'self' 'unsafe-inline' ${TURNSTILE_ORIGIN} ${CF_INSIGHTS_SCRIPT_ORIGIN}`],
  ["style-src", "'self' 'unsafe-inline'"],
  // data:/blob: cover inline SVG and admin upload previews.
  ["img-src", `'self' data: blob: ${IMAGES_ORIGIN}`],
  ["font-src", "'self'"],
  ["connect-src", `'self' ${TURNSTILE_ORIGIN} ${CF_INSIGHTS_REPORT_ORIGIN}`],
  ["frame-src", TURNSTILE_ORIGIN],
  ["manifest-src", "'self'"],
  ["object-src", "'none'"],
  ["base-uri", "'self'"],
  // The contact form posts to https://kilcon.work/api/contact (same origin).
  // Apparel "Request This Item" is a same-origin GET navigation to /contact.
  ["form-action", "'self'"],
  ["frame-ancestors", "'none'"],
];

export const CSP = CSP_DIRECTIVES.map(([k, v]) => `${k} ${v}`).join("; ");

/** true: Content-Security-Policy (blocks). false: Content-Security-Policy-Report-Only. */
export const CSP_ENFORCE = true;
export const CSP_HEADER = CSP_ENFORCE ? "Content-Security-Policy" : "Content-Security-Policy-Report-Only";

export const SECURITY_HEADERS: Readonly<Record<string, string>> = Object.freeze({
  "X-Frame-Options": "DENY",
  "Referrer-Policy": "strict-origin-when-cross-origin",
  "Permissions-Policy": "camera=(), microphone=(), geolocation=(), usb=()",
  // allow-popups keeps window.open/target=_blank flows (Facebook links) working.
  "Cross-Origin-Opener-Policy": "same-origin-allow-popups",
  [CSP_HEADER]: CSP,
});

/**
 * Adds SECURITY_HEADERS to a response. A header the route already set is left
 * alone. Responses with immutable headers (e.g. Response.redirect, or a
 * fetch() passed straight through) are re-wrapped so the headers can be set.
 */
export function applySecurityHeaders(response: Response): Response {
  const missing = Object.entries(SECURITY_HEADERS).filter(([k]) => !response.headers.has(k));
  if (missing.length === 0) return response;
  try {
    for (const [k, v] of missing) response.headers.set(k, v);
    return response;
  } catch {
    const copy = new Response(response.body, response);
    for (const [k, v] of missing) copy.headers.set(k, v);
    return copy;
  }
}
