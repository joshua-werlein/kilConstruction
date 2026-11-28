# Private file WAF rule

Audit 2026-11-27, following `C:\Users\Jwerl\dev\.archives\development-audits\2026-11-27-kil-construction-waf-audit-brief.md`.
Reference: the Grayz'n Buffalo rule `Block private file probes` (activated 2026-11-27).
**Status: active since 2026-11-28 00:36 UTC (owner-approved).** Rule `Block private file probes`, ID `c3a39f2657dd479d89e58c7c828fd300`, Block, first of 5 custom rules. [Live rule](https://dash.cloudflare.com/8481dbc471ac3a4aa14cc26ea366f956/kilcon.work/security/security-rules/custom-rules/c3a39f2657dd479d89e58c7c828fd300)

## Activation record (2026-11-28)

- Created with status Disabled, order First. The editor reported "Rule validation passed" once an action was chosen, and Cloudflare saved it (5/5). While disabled, `/wrangler.toml` and `images.kilcon.work/.env` still returned 404.
- Set to Active. The existing rules (Facebook image bypass, private review storage, leaked credentials, AI crawl) and the rate limit are unchanged and Active, now in positions 2–5.
- **Blocked (Cloudflare 403 `text/html`, no redirect)** on `kilcon.work` and `images.kilcon.work`: `/.env`, `/.git/config`, `/wrangler.toml`, `/WRANGLER.TOML`, `/.dev.vars`, `/backup.sql`, `/Facebook/.env`, `/.wrangler/state/x`, `/_astro/a.js.map`, `/migration-014-baseline.json`, `/node_modules/.package-lock.json`, encoded `/.%65nv` and `//.env` (normalization). `www` answers 301 to the apex first (redirect rules run before custom rules); the apex then blocks.
- **Unchanged:** 13 pages and static files 200 (including `/.well-known/security.txt`); `/admin` 200 and `/admin/dashboard` 302; gallery lists 200, `?all=1` 401; reviews summary/list 200, admin list 401, unknown photo 404; Stripe 410 (GET and POST); Meta webhook bad verify token 403, unsigned POST 401; `/api/csp-report` GET 405; www and HTTP 301; gallery image and `/cdn-cgi/image` thumbnail 200; Facebook full and `w/480` 200; Reviews 403, Facebook `/cdn-cgi/image` and `%2F` bypasses 403, `kilcon.work/cdn-cgi/image/…/Reviews` 403.
- **Write paths (invalid Turnstile token, nothing sent):** contact form 303 `?err=captcha`; JSON contact (apparel path) 403 `captcha`; review submit 303 `?err=captcha#leave-review`.
- Security Events (30 min): every Block came from the verification client. No third-party traffic was blocked.

## Baseline (read-only, 2026-11-27)

| Item | Value |
| --- | --- |
| Zone | `kilcon.work`, Free plan, active |
| Workers at 100% | kilcon-site `e7ba9fe0`, Gallery `f2796e0d`, Contact `2e22c765` (no drift from the tracker) |
| Worker routes (7) | `kilcon.work/*` → site; `kilcon.work/api/gallery-api*`, `kilcon.work/api/reviews*`, `images.kilcon.work/Reviews/*`, `images.kilcon.work/Facebook/*` → Gallery; `kilcon.work/api/contact*`, `www.kilcon.work/api/contact*` → Contact |
| R2 | `kilcon-gallery`: custom domain `images.kilcon.work`, r2.dev off; 458 objects, all images except 2 empty folder markers. `kilcon-private`: no custom domain, r2.dev off |
| Custom rules (dashboard, 2026-11-28 00:20 UTC) | **4 of 5 used, 1 free.** All Block, all Active: 1 `Block Facebook image bypass (cdn-cgi, encoded paths)`; 2 `Block private review storage`; 3 `Leaked credential protection`; 4 `AI Crawl Control - Block AI bots by User Agent` (rules 3 and 4 were not in the project docs) |
| Rate limiting | 1 of 1: `KilCon API Abuse Protection`, `starts_with(http.request.uri.path, "/api/") and not cf.client.bot`, per IP, 50 requests / 10 s, Block 10 s, first, Active |
| Managed rules | None (Free plan); response rules: Cloudflare default protection |
| Redirect rules | 1 `Redirect from HTTP to HTTPS`, 2 `Redirect from WWW to root`, both enabled. They run before custom rules, so `www` probes get 301 first |
| URL normalization | Cloudflare mode; normalize incoming URLs on; normalize to origin off (same as Grayz'n Buffalo) |
| MFA | Two-factor active on the signed-in user (TOTP, backup codes) |

## Exposure findings

- **No private file is exposed.** 40 private paths × 3 hosts were probed (headers only): `kilcon.work` → site 404 (`text/html`); `www` → 301 to the apex (the same path then 404s); `images.kilcon.work` → R2 404, and `/Facebook/.env` gets the Gallery Worker's 404.
- **Clean build:** 0 source maps (`upload_source_maps: false`, none in `dist/`); no env files, configs or backups in `dist/client`; the adapter's `.assetsignore` keeps `wrangler.json` and `.dev.vars` out of the upload; the build check found production public values only. No secret patterns in client assets.
- **Positive baseline:** pages 200; `/admin` login 200; `?all=1` 401; reviews summary/list 200; admin list 401; Stripe checkout/webhook 410; Meta webhook bad verify token 403, unsigned POST 401; `images.kilcon.work/Reviews/*` 403 (edge); gallery image and `/cdn-cgi/image` thumbnail 200; Facebook image 200; contact POST without Turnstile 303.
- The rule is defence in depth: today's protection is that nothing private is in the asset directory or the public bucket. The rule keeps a future mistake (a stray `.env`, a dump uploaded to R2) from being served.

## Proposed rule

- **Name:** `Block private file probes`. **Action:** Block. **Placement:** first in custom rules (before the four existing rules; all block, so order only affects which rule is logged). It uses the last free slot (5 of 5).
- **Expression:** `docs/waf-private-file-rule.txt` (1,773 characters; the Free limit is 4,096). Compared with Grayz'n Buffalo, it covers all three hostnames and adds this project's local-only files (`.wrangler/`, `.astro/`, `migration-014-baseline.json`, `fbvt.tmp`, `nul`, `CNAME`, `migrations/`, `dist/`, `node_modules/`, `_astro/*.map`). It drops PHP/FTP paths that don't apply here.
- `wildcard` is case-insensitive; the exact list compares the lower-cased path. `/.well-known/` is always exempt.
- **Offline check:** `node scripts/check-waf-rule.mjs <r2-keys.txt>` evaluates the expression against 46 probes × 3 hosts, 41 positive controls (the brief's list: `/.well-known/`, gallery and Facebook images, `/cdn-cgi/image`, `/api/contact` on both hosts, `/api/reviews*`, `/api/gallery-api*`, the Meta webhook, Stripe, admin pages, `/api/csp-report`, challenge platform), every built asset, every page route and every R2 key. Result: all probes blocked; nothing legitimate blocked.

## Rule editor check (2026-11-28, unsaved)

- The expression was typed into a new, unsaved custom rule. The editor holds it byte for byte (SHA-256 match with the single-line form, 1,689 / 4,000 characters). The draft was discarded by leaving the page; nothing was saved or deployed.
- The editor doesn't parse expressions before Deploy: an intentionally invalid suffix showed no error and caused no API call. The expression builder can't represent `lower()` or `wildcard`. The Rule simulator traces only active rules. **Server-side syntax validation therefore happens on save.**
- Every construct (`lower(...) in {...}`, `starts_with`, `not`, `wildcard`) is in the live Grayz'n Buffalo rule, which Cloudflare accepted.
- Safest activation: save the rule as **Disabled** (Cloudflare validates it with no effect on traffic), confirm it saved, then set it Active.

## Activation requirements (owner)

1. Recheck that the custom rules are still 4 of 5 and unchanged.
2. Create `Block private file probes` with the expression from `docs/waf-private-file-rule.txt` (multi-line or single-line), action Block, order First, status **Disabled**, and save. A syntax error is reported here.
3. Set it Active, then run the verification below. Do not edit or reorder the existing rules.

No code deploy is required for the rule. The security.txt change ships with the next kilcon-site deploy (push to `main`).

## Verification after activation

- **Blocked (403, Cloudflare block page, no redirect) on `kilcon.work` and `images.kilcon.work`:** `/.env`, `/.git/config`, `/wrangler.toml`, `/.dev.vars`, `/backup.sql`, `/WRANGLER.TOML`, `/Facebook/.env`. `www` gives 403 for the same paths (or 301 first if the redirect runs before the WAF).
- **Unchanged:** pages 200; `/.well-known/security.txt` 200 `text/plain`; gallery image and thumbnail 200; Facebook image 200; `images.kilcon.work/Reviews/*` 403 and Facebook bypass URLs 403 (existing rules); `?all=1` 401; admin list 401; Stripe 410; webhook 403/401; contact POST without Turnstile 303 `?err=captcha`; `/api/csp-report` POST 204.
- **Write paths:** contact and apparel with a bad Turnstile token (captcha error, nothing sent); review submit with a bad token (`?err=captcha`); a signed Meta delivery is not reproducible without the app secret, so watch Security Events and Gallery logs for the next real webhook (expect 200, no block).
- Security Events: filter on the new rule for 24 h and check that every hit is a probe.

## Rollback

1. Security → Security rules → Custom rules → **Block private file probes** → Disable (or delete). Leave the Reviews rule, the Facebook image rule and the rate limit untouched.
2. Recheck `/wrangler.toml` → site 404, `images.kilcon.work/.env` → R2 404; home 200; a gallery image and a Facebook image 200; `images.kilcon.work/Reviews/x.jpg` 403 (image privacy retained).
3. security.txt rollback, if ever needed: revert its commit and push (kilcon-site redeploy), or `versions deploy e7ba9fe0-b7ae-4d6e-be49-8081d399b4ef@100% --name kilcon-site`.

## security.txt

`Expires` moved from `2026-12-31T23:59:59Z` to `2027-11-26T23:59:59Z`, under a year from the 2026-11-28 00:16 UTC edit (RFC 9116). `Policy:` was removed: it pointed to the privacy page, and the site has no vulnerability disclosure policy. The file now ends with a newline. The contact `kil.con.contact@gmail.com` is the same inbox as the Contact Worker's `TO_EMAIL` and the address on the contact, privacy and data-deletion pages. The edge serves the file with `max-age=0, must-revalidate`, so the new file appears right after deploy. Set a reminder to renew it before 2027-11-26.

## List and export query review

No export endpoints exist. Findings, by risk:

| Endpoint | Columns | Pagination / bound | Finding |
| --- | --- | --- | --- |
| `GET /api/reviews` (public) | Explicit (`reviewsToPublic`) | Page ≤ 100, size ≤ 50 | OK. Each request reads **every** review record from both buckets before slicing (`listReviews`), so cost grows with the number of reviews; mitigated by `READ_LIMITER` and the zone rate limit. |
| `GET /api/reviews/summary` (public) | Aggregates only | Reads every record | Same full scan. |
| `GET /api/reviews/admin/list` (admin) | `...r`: the full stored record | None | **Medium:** unbounded, not explicit. Admin only, so no exposure; recommend an explicit field list and `page`/`pageSize` like the public list. |
| `adminPhotos` (FB admin) | `SELECT *` mapped to explicit output | `LIMIT 500` | Low: bounded; change `SELECT *` to the mapped columns. |
| FB health / `loadProject` | `SELECT p.*` mapped by `projectOut` | Projects unbounded (small table); failures `LIMIT 20` | Low: explicit columns recommended. |
| Gallery lists (public) | R2 listing | One R2 page (≤ 1,000), no cursor | Bounded, but silently truncates past 1,000 keys per level. |
| Site apparel admin / `/api/item` | Explicit | Small tables, unbounded | OK. |

These are recommendations only. By owner decision (2026-11-28) they are not implemented in this task.
