# Security release 2026-11-19: upload validation, review-photo revocation, `/_image`

**Status: DEPLOYED and verified 2026-11-19.** Both components are live (Pages first, then the
Worker, as planned). No rollback was needed. Sections 1–6 below are the pre-release record; the
deployment record is in section 7.

Two independent components:

| Component | Commits | Deployed |
|---|---|---|
| **Pages site** (`kilconstruction`) | `fc7e645`, `b915243` | Git push `b5bed1a..b915243` to `main` → Pages deployment `1030adad-a2ed-406b-856c-e47383a4b140` |
| **Gallery Worker** (`kilcon-gallery-worker`) | `2812a2d` (from tree `b915243`) | `wrangler versions upload` + `versions deploy` → version `b5ad9617-2324-4aca-962f-2ac1c3e33b76`, deployment `b0feb45b-1d21-4bd2-90d1-d67e50514673` |

Either one could ship without the other (see "Compatibility").

---

## 1. Production baseline (read 2026-11-19, read-only)

| Item | Value |
|---|---|
| GitHub `main` | `b5bed1a` (same tree as `6d10a8e`) |
| Pages production (live) | `7d46f050-dde1-4221-a9bc-f872755304d0`, source `6d10a8e` |
| Pages newest row | `fa143698-5426-4076-91ca-845236717586`, source `b5bed1a`, status *Idle* (`[CF-Pages-Skip]`, identical tree) |
| Gallery Worker | `1b3a60ec-ba12-4086-806b-973991fb9b6b` at 100%, tag `6d10a8e` |
| Previous Worker version | `cf8fcf94-316b-49d6-b933-1ae15e6930b0` |
| Worker bindings | `DB`=kilcon-db, `GALLERY_BUCKET`=kilcon-gallery, `PRIVATE_BUCKET`=kilcon-private, `READ_LIMITER`, `WRITE_LIMITER` |
| Worker flags | `FB_INTEGRATION_ENABLED=true`, `FB_AUTO_IMPORT=true`, `FB_DISCOVERY_ENABLED=false`, `FB_HISTORICAL_IMPORT_ENABLED=false` |
| Astro / adapter / Node | 5.16.4 / @astrojs/cloudflare 12.6.10 / 22.23.5 |

`wrangler.toml` isn't changed by this release, so a deploy keeps every binding, var, route and cron as is.

## 2. Containment status (live, status codes and counts only)

`bash workers/kilcon-gallery-worker/scripts/verify-review-privacy.sh` with a **non-existent**
probe key: **47 pass, 0 fail**. A 403 on a non-existent key means the WAF blocked it before the
origin; a 404 would have meant it reached R2.

| # | Historical exposure | Now |
|---|---|---|
| E1 | `?project=photos` / `=data` slug lookup | 404 |
| E2 | `images.kilcon.work/Reviews/photos/…` | 403 (WAF) |
| E3 | `images.kilcon.work/Reviews/data/<id>.json` | 403 (WAF) |
| E4 | r2.dev photos and records | 401; r2.dev disabled on both buckets |
| E5 | `%2F`, `%52`, `./`, `x/../` variants | 403 ×6 |
| E6 | `/cdn-cgi/image/` on both hosts, including `%2F` | 403 ×3 |
| E7 | `?project=constructor/x` | 404 (was 500) |

R2 inventory (Cloudflare API, counts only):

- `kilcon-gallery`: 351 objects, all under `Apparel, Facebook, Furniture, Highlights, New Construction, Projects, Remodels`. **0** keys under `Reviews/` or `reviews/`, **0** keys matching `/review/i`, **0** `.json`.
- `kilcon-private`: 5 review objects (2 photos, 3 records), 8 Facebook masters, 12 migration manifests. No r2.dev, no custom domain.
- Manifests: copy and verify runs (5/5, `allVerified: true`), then `delete-public` at **2026-10-18 22:21:58Z** → `{"deleted":5}`.

D1 `kilcon-db` ledger (`d1_migrations`, SELECT only, `rows_written: 0`): 10 rows. **015 and 016 were applied 2026-11-16 01:05:03**, and `wrangler d1 migrations list --remote` reports nothing pending. All six schema objects they create exist. The repo has 10 migration files, matching the ledger one-to-one.

**Not readable with the current credentials:** WAF custom rules and their order, cache rules,
URL normalization, Image Transformations settings, page rules, and audit logs. All return
`Authentication error` for the wrangler OAuth token, whose zone scope is `zone (read)` only.
To read them, use a token with:

- Zone → **Zone WAF: Read** (custom rules)
- Zone → **Config Rules: Read**, **Cache Rules: Read**, **Transform Rules: Read** (rulesets by phase)
- Zone → **Zone Settings: Read** (normalization, image_resizing, cache level, browser TTL)
- Zone → **Page Rules: Read**
- Account → **Account Settings: Read** plus **Audit Logs: Read** (WAF, R2 and purge history)

Cloudflare keeps no purge history outside the audit log.

## 3. Findings and fixes

### B. Gallery upload validation (Worker) — confirmed, fixed

Before: `POST /api/gallery-api/upload` (admin only) buffered the whole body with
`request.formData()` and had no size limit. It accepted any file whose client MIME type started
with `image/`, or that had no type at all, and stored `value.type || "image/jpeg"` as the
Content-Type. The bytes were never inspected, and rejected files were skipped silently with `ok: true`.

After (`src/imageValidation.js`, used by both upload and review submit):

- **Body bound.** A declared `Content-Length` over the limit gets 413 before any read. Without one, a counting reader stops at the limit. Gallery: **50 MB / 50 files** per request. Review form: **16 MB**.
- **Per file.** Non-empty, **≤ 25 MB** for gallery files (same ceiling as Facebook imports) and **≤ 15 MB** for review photos (unchanged).
- **Formats.** Only JPEG, PNG, WebP and AVIF, the same set the site already served (`IMAGE_EXT`). HEIC is still refused; iOS converts to JPEG for `accept="image/*"`.
- **Structural header checks**, not a 3-byte prefix:
  - JPEG: a real first marker whose segment fits in the file
  - PNG: an IHDR chunk with non-zero size
  - WebP: the RIFF size fits, plus a VP8 chunk
  - AVIF: an ftyp box with an avif/avis brand

  Real phone JPEGs, including EXIF and Samsung trailers, pass.
- **Consistency.** The sniffed format must match the extension. A client MIME type, if one is sent, must agree with the sniffed format (`image/jpg` and `image/pjpeg` are accepted aliases; empty or `application/octet-stream` is ignored).
- **Stored type** is the sniffed type, and the `File` is passed to R2 without an extra copy.
- **Keys:**
  - Kept: `sanitizeKey` (public roots only, image extension, no `.`/`..`).
  - Added: no control, bidi or zero-width characters, no padded segments, ≤ 200 characters per segment, ≤ 512 bytes per key.
  - `Reviews/`, `Facebook/` and `Migrations/` are not writable.
- **Response.** Adds `rejected: [{name, reason}]` and `limits`. Returns 400 if nothing valid was uploaded. Existing fields are unchanged.

Admin page (`src/pages/admin/upload-script.ts`, planner in `src/lib/upload-batching.js`):
pre-checks extension, empty and over-25-MB files, and groups small files into requests of
**≤ 20 MB / ≤ 20 files**. The 20 MB figure is a grouping target, not a file limit: a valid
file of 20–25 MB is sent **alone in its own request** (≈25 MB + multipart overhead, half the
50 MB Worker limit). It reports each rejection and escapes the result HTML. Previously server
URLs were interpolated raw. `tests/upload-batching.test.mjs` sends the planner's batches to the
real Worker handler as browser-style requests (serialized body + `Content-Length`): 20 MB ±1 B,
25 MB −1 B / exact, a single 21 MB and a single 25 MB JPEG, mixed batches, and server-side rejects.

### C. Review-photo revocation (Worker) — confirmed, fixed

Before: approved photos were sent with `Cache-Control: public, max-age=300`. Live: no
`CF-Cache-Status`, because Worker responses aren't edge-cached. So for up to 5 minutes after a
review was hidden or deleted, browsers and any shared proxy could keep showing the photo.

After:

- Approved photos are sent with `private, no-cache` plus an `ETag`. Every reuse revalidates, and the access check runs **before** the conditional 304. A withdrawn review answers 404 even to `If-None-Match`.
- Pending and hidden photos (admin view) stay `private, no-store`, with no ETag.
- Requests carrying `Via: image-resizing` get 404, so Image Transformations can't make and cache a resized copy that would outlive a withdrawal. The site never resizes review photos.
- Gallery images and JSON responses are unchanged.

### D. Astro `/_image` (Pages) — confirmed, fixed differently than proposed

- **Live:** `https://kilcon.work/_image?href=/robots.txt` returns **200**. The adapter's default `compile` endpoint fetches any same-origin `href` and returns it as is.
- **WAF bypass:** `/_image?href=/cdn-cgi/image/…/Reviews/…` reached the origin (404, not the WAF's 403), because the WAF rules match on path and the target sits in the query string. It only returns nothing because the public `Reviews/` objects are deleted.
- **Not used:** nothing in `src/` imports `astro:assets`. Thumbnails use Cloudflare Image Transformations (`/cdn-cgi/image/…`), which are independent of Astro.
- **`imageService: 'passthrough'` was rejected.** In Astro 5.16 the route is still injected, now backed by the generic endpoint. That endpoint **forwards every request header, including the `admin_auth` cookie**, to the same-origin fetch, and replies with `Cache-Control: public, max-age=31536000`. That's worse than today.
- **Implemented:**
  - `cloudflare({ imageService: 'custom' })`, which stops the adapter overriding the endpoint
  - `image.service: passthroughImageService()`
  - `image.endpoint.entrypoint: ./src/image-endpoint-disabled.js`, which answers 404 `no-store` to every method and never fetches
- **Effect on the bundle:** the build drops the `image-endpoint` and `sharp` chunks and the adapter's sharp warning. `_routes.json` has the same entries.
- **Local `wrangler pages dev`:** the baseline build returns 200 on `/_image?href=/robots.txt` and the patched build returns 404. Every other probed route behaves the same in both.

## 4. Tests

| Command | Result |
|---|---|
| `npm ci` | ok |
| `npm run test:site` | **27/27** (5 new in `tests/image-endpoint.test.mjs`, 8 in `tests/upload-batching.test.mjs`) |
| `npm run test:gallery-worker` | **125/125** (16 new in `test/upload-security.test.mjs`; all 109 existing pass, including the webhook signature, dedup, auto-import, tombstone and reimport tests) |
| `npm run build` | ok |
| `wrangler deploy --dry-run` | ok; bindings and vars unchanged |
| `tsc --strict` on `upload-script.ts` | ok |

Mutation checks: each of these was reverted on its own and caught by at least one new test.

- public cache
- Via check
- trusting the client MIME type
- the MIME consistency check
- the size limit
- the declared-length check
- structural JPEG validation
- the safe-key check
- a 304 without the approval check

Existing-test changes:
- The JPEG and PNG fixtures are now real 2×2 images (`test/imageFixtures.mjs`). The old 12-byte stubs are correctly refused as truncated.
- One assertion changed from `/public/` to `private, no-cache`.

`astro check` isn't run because `@astrojs/check` isn't installed, and no dependencies were added.

## 5. Deployment

### Compatibility

- **New site + old Worker:** smaller batches are fine, and an absent `rejected` field is handled.
- **Old site + new Worker:** works, except a single selection over 50 MB, which now gets 413 instead of succeeding up to Cloudflare's 100 MB body limit.

**Recommended order: Pages first, then the Worker.**

### 🔒 Pages (site)

1. Review the `fix(site)` commit. Merge the branch into `main` and push. This triggers the Pages Git build. Don't add `[CF-Pages-Skip]`.
2. Wait for the build: `npx wrangler pages deployment list --project-name kilconstruction --environment production` (with `CLOUDFLARE_ACCOUNT_ID=8481dbc471ac3a4aa14cc26ea366f956`).
3. Verify:
   - `curl -s -o /dev/null -w '%{http_code}' 'https://kilcon.work/_image?href=/robots.txt'` returns **404**
   - the verification script shows 47 pass
   - project, service and apparel pages and thumbnails render
   - `/admin/upload`: upload 2–3 phone photos and check them in the gallery, then delete them
4. **Rollback:** Dashboard → Pages → kilconstruction → Deployments → `7d46f050` → *Rollback to this deployment*. Or revert the merge and push.

The merge also carries the Worker commit. That's harmless: Pages doesn't deploy `workers/`.

### 🔒 Gallery Worker

1. From `workers/kilcon-gallery-worker/`: `npx wrangler deployments list` and confirm `1b3a60ec` is still current.
2. `npx wrangler deploy --tag <commit> --message "Upload validation and review-photo revocation"`.
3. Verify:
   - the script again (47 pass)
   - `curl -sD - -o /dev/null https://kilcon.work/api/reviews/photo?id=<approved id>` shows `Cache-Control: private, no-cache` and an `ETag`
   - a repeat request with `If-None-Match` returns 304
   - in admin: hide a test review and check its photo URL returns 404 right away, then re-approve it
   - upload one image through `/admin/upload`, then delete it
   - Facebook: `/admin/facebook` health is green, and the next real Page post imports. Don't send fake events.
4. **Rollback:** `npx wrangler rollback 1b3a60ec-ba12-4086-806b-973991fb9b6b`. It brings back the 5-minute public cache and the unvalidated upload, but no data changes.

There are no D1 migrations, R2 writes, secret changes, route changes or flag changes.

### Cache invalidation

**No purge is required for this release:**

- `/api/reviews/photo` and `/_image` responses aren't edge-cached (no `CF-Cache-Status`, `DYNAMIC`).
- Browser copies of photos sent with `max-age=300` expire on their own within 5 minutes of the Worker deploy.
- The legacy public review objects were deleted on 2026-10-18. Their transformed variants had at most a 4-hour edge TTL, and the WAF evaluates before cache anyway.

**Optional (🔒, separate approval):** Custom Purge by prefix for `images.kilcon.work/Reviews/` and
`kilcon.work/cdn-cgi/image/` as belt and braces, if the audit log shows these were never purged.
The second one also re-transforms gallery thumbnails on their next view.

## 6. Remaining risks

1. **WAF and cache rules weren't read directly** (missing permissions, section 2). The behavioural evidence is strong: 403 on every variant.
2. **Third-party copies.** Anything saved by others before 2026-10-18 can't be revoked.
3. **Facebook photos.**
   - Facebook-imported gallery photos are public with `public, max-age=3600`.
   - Thumbnails are edge-cached with `max-age=14400`.
   - So a photo hidden or removed on Facebook can stay visible for up to 1 h in browsers and up to 4 h as a thumbnail.
   - **Correction (2026-11-21):** live GETs show browsers receive `max-age=14400` for full images too. The zone's 4 h Browser Cache TTL raises the stored 3600, and 404s are cached as well. See `facebook-image-cache.md`.

   This is gallery content, not review content, and was left unchanged to avoid disturbing live automation. Follow-up: purge on hide, which needs a Cache Purge token in the Worker, or shorter TTLs.
4. **Facebook image type.** The Facebook importer takes the image type from fbcdn's `Content-Type` (host allow-list, 25 MB cap) without sniffing the bytes. Low risk.
5. **Dependencies.** `npm audit` reports 22 issues (1 critical, 20 high).
   - Removing `/_image` mitigates the adapter's image-endpoint SSRF and Astro's remote-allowlist advisories.
   - The `define:vars` XSS was addressed in `912d853`.
   - Most of the rest are build-time tooling.
   - A full fix needs Astro 7 / adapter 14, which is out of scope.
6. **Worker route.** The `images.kilcon.work/Reviews/*` Worker route is defense in depth only. The WAF and the deletion are the real controls.

---

## 7. Deployment record (2026-11-19)

### Pages — 22:02 UTC

- **Preflight:**
  - No drift: `origin/main` was still `b5bed1a`. Site 27/27, Worker 125/125, build OK.
  - Only Pages deploys from `main`. There are no GitHub workflows, and the Pages build runs only `npm run build`.
  - Earlier pushes to `main` never created Worker deployments; every Worker deployment on record is a manual `wrangler` deploy.
  - Workers Builds trigger settings couldn't be read (permission), so that conclusion rests on the deployment history.
- **Deploy:** fast-forward push `b5bed1a..b915243` to `main` → deployment `1030adad-a2ed-406b-856c-e47383a4b140` (commit `b915243b8e46cd05ec6450ebfad5566745acb17b`), now canonical. Built with Node 22.23.5. Rollback target `7d46f050` (`6d10a8e`) is still available.
- **`/_image`:**
  - Every GET and HEAD variant returns 404 `no-store`: same-origin, absolute, resize-URL and review-photo `href`s, plus case and path variants. Before, `?href=/robots.txt` and `?href=/llms.txt` returned 200.
  - POSTs get 403 from Astro's origin check.
  - A protocol-relative `href` (`//…`) gets a 403 "Blocked" from an edge rule before reaching the app.
- **Rest of the site:** the route snapshot diff shows only the three `/_image` rows changed. Privacy script 47/0. The served upload bundle is byte-identical to the local build. DNS, TLS and Pages bindings are unchanged.
- **Runtime:** 93 Pages invocations during verification, 0 exceptions, 0 error logs, 0 5xx.
- **Not tested:** a logged-in admin upload (no credentials).

### Gallery Worker — 22:11 UTC

- **Preflight:**
  - Worker source on `main` is identical to `2812a2d`, and `wrangler.toml` is unchanged since `b5bed1a`.
  - The deployed version `1b3a60ec` had bindings, vars and 5 secrets matching `wrangler.toml`.
  - Routes and the `17 * * * *` cron were as configured, with no concurrent versions.
  - 125/125 tests and the dry-run (173.41 KiB) passed.
- **Deploy:** `wrangler deploy` doesn't take `--tag` or `--message` in 4.49. That attempt failed with a usage error before uploading, so nothing changed. Used the established versions flow instead:
  - `wrangler versions upload --tag b915243` created version `b5ad9617-2324-4aca-962f-2ac1c3e33b76`.
  - `wrangler versions deploy b5ad9617…@100%` created deployment `b0feb45b-1d21-4bd2-90d1-d67e50514673`.
  - Routes and cron weren't touched (`versions` doesn't modify triggers), and they're unchanged afterwards.
- **Verification (read-only; no production uploads, withdrawals or Facebook events):**
  - Bindings, vars, secret names and handlers are identical between `1b3a60ec` and `b5ad9617`. Facebook flags are unchanged: `FB_INTEGRATION_ENABLED=true`, `FB_AUTO_IMPORT=true`, discovery and historical import `false`.
  - 15-endpoint snapshot identical to pre-deploy: galleries 200, `?project=photos` 404, `?all=1` 401, admin list 401, anonymous upload 401, webhook bad token 403, non-multipart review submit 400.
  - Approved review photo: 200 `image/jpeg`, `Cache-Control: private, no-cache`, an `ETag`, the sandbox CSP and `nosniff`.
    - `If-None-Match` with the matching ETag gets a body-less 304; a mismatched ETag gets 200.
    - `Via: image-resizing` gets 404. Resize URLs on both hosts get 403 at the edge.
    - Every photo URL in `/api/reviews` is the gated endpoint.
  - The public review form refuses a 17 MB body with 413 before parsing.
  - Privacy script 47/0. R2 r2.dev is still disabled on both buckets, the private bucket has no domain, and DNS and TLS are unchanged.
  - Facebook data is unchanged (11 events, 8 imported photos; read-only query).
- **Runtime:**
  - Tail: 60 invocations, all on `b5ad9617`, all `ok`, 0 exceptions, 0 5xx. The only warnings were 3 webhook rejections caused by the deliberate bad-token and unsigned probes.
  - Analytics: 0 errors since the deploy; 0 errors in the previous 24 h (550 requests on `1b3a60ec`).
- **Rollback (not needed):** `npx wrangler rollback 1b3a60ec-ba12-4086-806b-973991fb9b6b`. The version is still available.

### Still open

- WAF, cache-rule, Workers Builds and audit-log configuration haven't been independently audited (missing read permissions; see section 2).
- Withdrawal was proven by automated tests and by the live headers/304 behaviour, not by hiding a real production review (that wasn't authorized).
- The Facebook gallery photo TTLs (1 h browser, 4 h edge thumbnails), the importer's content-type trust, and the `npm audit` items in section 6 remain.
- No cache purge was performed or required.
