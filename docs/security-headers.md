# Security headers (report-only CSP)

Status: **deployed 2026-11-21.** Pages deployment `ea36b012-fd57-4c84-b3aa-8bddacc299a8` from
`main` `f33023e`. The CSP is report-only; enforcement is not enabled.

Rollback point: Pages `1cd87df8-3b6e-4530-99a4-5980f8f86d03` (`ff36da0`, a README-only change).
It carries the same site code as `1030adad` (`b915243`), which remains available as a fallback.

### Deployment record (2026-11-21)

- **Merge:** the branch was rebased onto `ff36da0` (a README edit pushed to `main` at 10:03, which
  had deployed as `1cd87df8`). Tests were rerun after the rebase: site 37/37, Worker 125/125, build OK.
  Pushed `ff36da0..f33023e`, and it was live in about 45 s.
- **Live headers on `/`:** `X-Frame-Options`, `Referrer-Policy`, `Permissions-Policy`,
  `Cross-Origin-Opener-Policy` and `Content-Security-Policy-Report-Only` each appear exactly once.
  HSTS and nosniff appear once each (from the zone). There is no enforcing `Content-Security-Policy`.
- **Live checks (read-only):**
  - 19 pages return their expected status with the CSP: home, contact, reviews, apparel and an apparel item, projects and a project, services, legal pages, `/admin`, protected admin pages (302) and 404.
  - Turnstile script and site key are present on `/contact` and `/reviews`.
  - Apparel checkout code is present, and `/api/item` returns 200.
  - The admin login form renders.
  - The gallery API, review photos (`private, no-cache`) and Facebook images return 200; `/_image` returns 404.
- **Not verified:** in-browser behavior (the Turnstile challenge, the console for report-only
  violations, a real checkout and a real login). The Chrome extension was not connected, and no
  production login or Stripe session was attempted.
- **Cleanup:** the branch `security/headers-report-only` was deleted locally after confirming its
  content was in `main`. It was never pushed.

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
