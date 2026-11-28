# Security headers (CSP)

Status: **CSP enforced from 2026-11-24** (`kilcon-site`; see "Enforcement" below). It was first
deployed report-only on 2026-11-21 (Pages `ea36b012`, `main` `f33023e`).

Rollback point: Pages `1cd87df8-3b6e-4530-99a4-5980f8f86d03` (`ff36da0`, a README-only change).
It carries the same site code as `1030adad` (`b915243`), which remains available as a fallback.

## Enforcement (audited 2026-11-23, enforced 2026-11-24)

`CSP_ENFORCE = true` in `src/utils/securityHeaders.ts` sends **`Content-Security-Policy`**, with
no report-only copy. `tests/security-headers.test.mjs` pins it.

**History:**
- **Report-only first:** shipped 2026-11-23 (`kilcon-site` `45bda3aa`, then `c87b2e4e`).
- **Missing origin found:** the production browser check showed that Cloudflare edge-injects Web
  Analytics (`static.cloudflareinsights.com`, which reports to `cloudflareinsights.com`). Both
  were added before enforcing.
- **Pre-enforcement check:** each production page's real HTML (including edge injections) was
  rendered in a same-origin frame under the enforcing policy (as a `<meta>` CSP), and violations
  were collected. That covered the public pages, a project page, the apparel page with Turnstile,
  and the signed-in admin pages.

**Rollback:** set `CSP_ENFORCE = false` (and update the pinning test), or roll `kilcon-site` back
to the previous version.

### Why it's safe to enforce

- **Live pages (read-only):** `/`, `/contact`, `/reviews`, `/apparel`, `/apparel/t-shirts`,
  `/projects`, `/admin` and `/privacy` were fetched on 2026-11-23. Every external `src`,
  `srcset` and `action` is `kilcon.work`, `images.kilcon.work` or `challenges.cloudflare.com`.
  `www.facebook.com` appears only in links, which are navigation and not governed by CSP.
- **Inline scripts:** at enforcement time the only inline scripts were the `is:inline` status
  scripts and Cloudflare's challenge-platform bootstrap. Since 2026-11-25 our own pages have none
  (see [Inline scripts](#inline-scripts-and-unsafe-inline)). The bootstrap loads
  `/cdn-cgi/challenge-platform/…`, which is same-origin. `'unsafe-inline'` stays, and no
  `define:vars` remain.
- **Admin pages:** every image, preview and `fetch` is same-origin
  (`/api/gallery-api/facebook/admin/photo-file`, `review-site-image` and the other
  `/api/gallery-api/*` and `/api/reviews/*` paths), or `blob:` for upload previews. Images come
  from `images.kilcon.work`.
- **Forms:** forms post to `/admin`, `/api/contact` and `/api/reviews/submit` (all same-origin)
  and redirect back to `kilcon.work`. The apparel form is a same-origin GET.
- **Drift guard:** `tests/security-headers.test.mjs` fails if `src/` gains an absolute origin
  that the policy doesn't allow.

### After deploy

In a browser, check the console on `/contact` and `/reviews` (Turnstile), `/apparel/<item>`, and
the admin pages: login, upload, manage, Facebook review and reviews. Look for `Refused to …`
errors. **Rollback:** roll back to the previous `kilcon-site` version, or set
`CSP_ENFORCE = false` and push.

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
| `Content-Security-Policy` | see `src/utils/securityHeaders.ts`; HTML responses add a per-response nonce and `report-uri` |

These are not set here, because the Cloudflare zone already sends them:

- `Strict-Transport-Security` (`max-age=15552000; includeSubDomains`)
- `X-Content-Type-Options: nosniff`

A header a route already set is never overwritten. Responses with immutable headers,
such as `Response.redirect`, are re-wrapped so the headers can be added.

### CSP (enforced since 2026-11-24)

The source of truth is `CSP_DIRECTIVES` in `src/utils/securityHeaders.ts`. As of 2026-11-28 (HTML responses;
non-HTML responses send the same policy without the nonce and `report-uri`):

```
default-src 'self'; script-src 'self' 'nonce-<fresh 128-bit per response>' https://challenges.cloudflare.com
https://static.cloudflareinsights.com; style-src 'self' 'unsafe-inline';
img-src 'self' data: blob: https://images.kilcon.work; font-src 'self';
connect-src 'self' https://challenges.cloudflare.com https://cloudflareinsights.com;
frame-src https://challenges.cloudflare.com; manifest-src 'self'; object-src 'none';
base-uri 'self'; form-action 'self'; frame-ancestors 'none'; report-uri /api/csp-report
```

What each source is for:

| Source | Used for |
|---|---|
| `challenges.cloudflare.com` | Turnstile on `/contact` and `/reviews`: its `api.js` script and widget iframe. |
| `images.kilcon.work` | R2 gallery images and their `/cdn-cgi/image/` variants. |
| `'self'` | Same-origin APIs: `/api/stripe/checkout`, `/api/item`, `/api/reviews/*`, `/api/gallery-api/*`, `/api/admin/*`. |
| `form-action 'self'` | The contact form (`https://kilcon.work/api/contact` in production) and the admin login (a POST to `/admin`). |
| `'nonce-…'` in `script-src` | Cloudflare's injected challenge-platform bootstrap (Bot Fight Mode / JavaScript Detections) on every page; Cloudflare copies the header's nonce onto it. Our own scripts are same-origin `/_astro/*.js` files. No `'unsafe-inline'` since 2026-11-28. |
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

## Inline scripts and 'unsafe-inline'

Since 2026-11-25 (Release D of the maintenance backlog) the site ships **no inline scripts of its own**:

- The contact status line (`?sent` / `?err`) moved from an `is:inline` script into
  `src/lib/contact-status.js`. The page's bundled module calls it first, before the draft restore
  that reads the `status--error` class it sets.
- The reviews URL tidy-up is a normal bundled `<script>` (its messages are server-rendered).
- `astro.config.mjs` sets `vite.build.assetsInlineLimit` to a function that never inlines
  scripts. Astro otherwise inlines any processed script under 4 KB that imports nothing; that had
  inlined the reviews script and the admin apparel variant editor. CSS inlining is unchanged.
- `tests/csp-inline-scripts.test.mjs` fails if an `is:inline` or `define:vars` script returns,
  or if the inline-limit setting is lost.

The one inline script left is **Cloudflare's challenge-platform bootstrap** (`window.__CF$cv$params`).
It is injected at the edge on every HTML page and its content changes per request, so it cannot
be hashed. Cloudflare documents that it adds the page's CSP **nonce** to the scripts it injects
when the `Content-Security-Policy` header carries one
([JavaScript detections](https://developers.cloudflare.com/cloudflare-challenges/challenge-types/javascript-detections/)).
Bot protection stays on; turning it off is an owner decision and not planned.

**Plan for removing `'unsafe-inline'` from `script-src`:**

1. Done: our own inline scripts are removed (the enforced policy is unchanged).
2. Done (2026-11-26 to 2026-11-28): send a nonce-based `Content-Security-Policy-Report-Only` header **alongside** the
   enforced policy, and confirm Cloudflare nonces its bootstrap (see
   [Nonce report-only observation](#nonce-report-only-observation)).
3. Done 2026-11-28: the nonce moved into the enforced header and `'unsafe-inline'` left
   `script-src`; the report-only header is retired. `style-src 'unsafe-inline'` is separate and stays.
   See [Nonce enforcement](#nonce-enforcement-2026-11-28).

## Nonce enforcement (2026-11-28)

- `htmlCsp(nonce)` in `src/utils/securityHeaders.ts` builds the enforced policy for **HTML responses**: `script-src 'self' 'nonce-<n>' https://challenges.cloudflare.com https://static.cloudflareinsights.com`, plus `report-uri /api/csp-report`. Every other directive is unchanged. Non-HTML responses get `CSP` without a nonce.
- **Why it was ready:** the 48-hour report-only window (2026-11-26 00:17 UTC to 2026-11-28) logged 0 reports from real pages; the only 3 `[csp-report]` lines were the synthetic `MAINTENANCE-SYNTHETIC-REPORT` check. On `/`, `/contact`, `/reviews`, `/projects`, `/apparel` and `/admin`, the injected bootstrap carried the header's nonce. The admin apparel variant editor saved under the report-only policy with no report; the owner confirmed it works.
- Enforced violations now reach `/api/csp-report` and Workers Logs (`[csp-report]`, `"disposition":"enforce"`).
- HTML must not be cached at the edge (the nonce would repeat). No cache rule caches HTML today.
- **Rollback:** redeploy the previous kilcon-site version (enforced `'unsafe-inline'` plus the nonce report-only header), then revert the commit.

## Nonce report-only observation (2026-11-26 to 2026-11-28, retired)

`CSP_NONCE_REPORT_ONLY` in `src/utils/securityHeaders.ts` added a second header to **HTML responses only**:

```
Content-Security-Policy-Report-Only: <the enforced policy, with script-src
  'self' 'nonce-<fresh 128-bit value per response>' https://challenges.cloudflare.com
  https://static.cloudflareinsights.com  (no 'unsafe-inline')>; report-uri /api/csp-report
```

- It **blocks nothing**. The enforced `Content-Security-Policy` header is unchanged and keeps `'unsafe-inline'`.
- Browsers POST violations to `/api/csp-report` (`src/pages/api/csp-report.ts`). The endpoint always
  answers 204, reads at most 8 KB, and logs one line per violation to Workers Logs:
  `[csp-report] {"directive":…,"blocked":…,"page":…,"source":…,"line":…,"sample":…}`. URLs keep
  origin and path only (no query or fragment). Nothing is stored. It shares the `LOGIN_LIMITER`
  binding under its own `csp-report:<ip>` key (5 per minute per IP).
- Before deployment, a headless-browser check against a local production build found one more
  inline script of our own: the reviews filter's `<select onchange=…>`. It is now a listener in
  the bundled script, and `tests/csp-inline-scripts.test.mjs` rejects `on*=` handlers and
  `javascript:` URLs.

**What the window must show (24–48 h after deployment):**

1. Workers Logs for `kilcon-site`, filtered by `[csp-report]`. Expected: none from our pages. A
   report with `blocked":"inline"` and a `window.__CF$cv$params`-style sample means Cloudflare did
   **not** nonce its bootstrap based on the report-only header.
2. In a browser on `/`, `/contact`, `/reviews` and `/admin`: the injected bootstrap `<script>`
   carries the response's nonce (`document.scripts` → `nonce`), and the console shows no
   `[Report Only]` violations.
3. Reports from browser extensions (`chrome-extension:`, `moz-extension:` sources) are noise.

**Then:** if the bootstrap is nonced and no unexplained reports appear, a separate approved
release moves the nonce into the enforced header and removes `'unsafe-inline'` from `script-src`.
If Cloudflare only nonces scripts for the enforced header, the alternatives are an owner decision:
keep `'unsafe-inline'`, or turn off JavaScript Detections / Bot Fight Mode. Turn the observation
off by setting `CSP_NONCE_REPORT_ONLY = false`, or roll back the site version.

## Known gaps

- If a page throws before returning a response, Astro's bare 500 is produced outside middleware and has no headers. The same goes for Astro's CSRF 403. Both are empty or plain-text bodies.
- Only HTML responses carry `report-uri`; non-HTML responses run no scripts.

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
2. Replace `'unsafe-inline'` in `script-src` with hashes or nonces, which means removing `define:vars`. (Superseded: see [Inline scripts and 'unsafe-inline'](#inline-scripts-and-unsafe-inline).)
3. Rename the header to `Content-Security-Policy`.
