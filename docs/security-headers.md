# Security headers (report-only CSP)

Status: **implemented on branch `security/headers-report-only`, not deployed.**
Production rollback point: Pages deployment `1030adad` (`b915243`). The doc-only
`31ffec1` on `main` was skipped (`[CF-Pages-Skip]`), so `1030adad` is still the live build.

## Why middleware, not `public/_headers`

`astro.config.mjs` uses `output: 'server'`. Every page and API route is answered by
`_worker.js`; only `sitemap.xml` is prerendered. Cloudflare Pages applies `_headers`
rules to static assets only, not to Functions or `_worker.js` responses. So the headers
are added in `src/middleware.ts`, which runs for every on-demand response.

Static files (`/_astro/*`, `robots.txt`, `favicon.svg`, images) don't need these headers:
CSP and frame protection only matter for documents. They already get `nosniff` from the zone.

## Headers added

| Header | Value |
|---|---|
| `X-Frame-Options` | `DENY` |
| `Referrer-Policy` | `strict-origin-when-cross-origin` |
| `Permissions-Policy` | `camera=(), microphone=(), geolocation=(), usb=()` |
| `Cross-Origin-Opener-Policy` | `same-origin-allow-popups` |
| `Content-Security-Policy-Report-Only` | see `src/utils/securityHeaders.ts` |

These are not set here, because the Cloudflare zone already sends them:

- `Strict-Transport-Security` (`max-age=15552000; includeSubDomains`)
- `X-Content-Type-Options: nosniff`

A header a route already set is never overwritten. Responses with immutable headers,
such as `Response.redirect`, are re-wrapped so the headers can be added.

### CSP (report-only)

```
default-src 'self'; script-src 'self' 'unsafe-inline' https://challenges.cloudflare.com;
style-src 'self' 'unsafe-inline'; img-src 'self' data: blob: https://images.kilcon.work;
font-src 'self'; connect-src 'self' https://challenges.cloudflare.com;
frame-src https://challenges.cloudflare.com; manifest-src 'self'; object-src 'none';
base-uri 'self'; form-action 'self'; frame-ancestors 'none'
```

What each source is for:

| Source | Used for |
|---|---|
| `challenges.cloudflare.com` | Turnstile on `/contact` and `/reviews`: its `api.js` script and widget iframe. |
| `images.kilcon.work` | R2 gallery images and their `/cdn-cgi/image/` variants. |
| `'self'` | Same-origin APIs: `/api/stripe/checkout`, `/api/item`, `/api/reviews/*`, `/api/gallery-api/*`, `/api/admin/*`. |
| `form-action 'self'` | The contact form (`https://kilcon.work/api/contact` in production) and the admin login (a POST to `/admin`). |
| `'unsafe-inline'` in `script-src` | The `define:vars` scripts Astro inlines (contact, reviews, apparel) and Cloudflare's inline bootstrap scripts. |
| `'unsafe-inline'` in `style-src` | Inline `style=""` attributes (projects, apparel). |

Two cases fall outside CSP:

- **Stripe Checkout:** `/apparel/[slug]` reaches Checkout through `location.href = url`. Navigation isn't governed by CSP, and no Stripe script is loaded.
- **`www.kilcon.work`:** it 301-redirects to the apex domain, so `'self'` is always `https://kilcon.work`.

## Verification (2026-11-21, local)

- `npm run test:site`: 37/37 (`tests/security-headers.test.mjs` adds 10 tests). `npm run test:gallery-worker`: 125/125.
- `npm run build` passes, and the middleware is bundled (`dist/_worker.js/_astro-internal_middleware.mjs`).
- The built output was served with `wrangler pages dev`, bound to a **local** Gallery Worker with simulated D1/R2. Every page had all 5 headers and no enforcing CSP:

  | Response | Routes |
  |---|---|
  | 200 | `/`, `/contact`, `/reviews`, `/apparel`, `/apparel/t-shirts`, `/projects`, `/projects/ganz-garage`, `/services/remodels`, `/admin`, `/privacy` |
  | 302 (admin auth redirect) | `/admin/upload` |
  | 404 | unknown page |
  | 500 (no local product data) | `/api/item` |

- **Admin login:** a same-origin POST with wrong credentials re-renders with the headers, and `Set-Cookie` passes through unchanged (unit test). A cross-origin POST is still refused with 403 by Astro's own origin check, which is unchanged.
- **Unaffected:** gallery uploads, review submission and the Facebook webhook are served by the Gallery Worker (`/api/gallery-api*`, `/api/reviews*` routes), not Pages. The contact form goes to the `kilcon-contact` Worker. The middleware doesn't touch them.

## Known gaps

- If a page throws before returning a response, Astro's bare 500 is produced outside middleware and has no headers. The same goes for Astro's CSRF 403. Both are empty or plain-text bodies.
- There is no CSP report endpoint yet. Violations appear only in the browser console.

## Deploy (needs approval)

1. Merge the branch to `main` without `[CF-Pages-Skip]`. That push builds and deploys Pages.
2. Check the live headers:
   ```
   curl -sI https://kilcon.work/ | grep -iE "x-frame|referrer-policy|permissions-policy|cross-origin-opener|content-security-policy"
   ```
   Expect exactly one HSTS and one nosniff header (from the zone), and no `Content-Security-Policy` header.
3. Open `/contact`, `/reviews` (Turnstile), `/apparel/<slug>` (checkout), `/admin` (login, upload) and `/projects` in a browser. Check the console for `[Report Only]` violations.
4. **Rollback:** Dashboard → Pages → kilconstruction → Deployments → `1030adad` → *Rollback*. Or revert the merge and push.

## Before enforcing

1. Collect violations for about a week. A report endpoint is an optional follow-up.
2. Replace `'unsafe-inline'` in `script-src` with hashes or nonces, which means removing `define:vars`.
3. Rename the header to `Content-Security-Policy`.
