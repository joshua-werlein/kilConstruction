# Security release: private review photos and records

**Status:** ready for review. **Nothing in this document has been run against production.**
Every step marked 🔒 changes production and needs explicit approval first.

Scope: close the public exposure of review attachments **and review records**.
Facebook sync ships in the same Worker bundle but is fully inert
(`FB_INTEGRATION_ENABLED="false"`, `FB_AUTO_IMPORT="false"`, no cron). No Meta configuration,
no D1 migration and no backfill are part of this release.

---

## 1. Confirmed cause

Investigated 2026-10-18 using status codes and response metadata only. No image contents were viewed.

| # | Exposure | Cause | Baseline |
|---|---|---|---|
| E1 | `GET /api/gallery-api?project=photos` (also `=data`) lists review photos | `findPrefixBySlug()` searched every top-level R2 folder, including `Reviews/`. The slug `photos` matched `Reviews/photos/`. | 200, 2 photos |
| E2 | `https://images.kilcon.work/Reviews/photos/…` | `images.kilcon.work` is an R2 custom domain serving the **whole** `kilcon-gallery` bucket, and review photos were stored in it | 200 |
| E3 | **Review records** `https://images.kilcon.work/Reviews/data/<id>.json` | Records are in the same public bucket. They contain the full name (even when the client chose a short public name), location and marketing consent. IDs of approved reviews are published by `/api/reviews`. | 200 |
| E4 | `https://pub-2dbd9bf3….r2.dev/Reviews/…` (photos and records) | **r2.dev public access is enabled** on `kilcon-gallery`. It's outside the zone, so WAF and Worker routes can't protect it. | 200 |
| E5 | Encoded and normalized paths: `Reviews%2Fphotos`, `%52eviews`, `Reviews/./photos`, `Reviews/x/../photos` | R2 and Cloudflare decode or normalize these before the lookup. A Worker route pattern `Reviews/*` would not match `%2F`. | 200 |
| E6 | Resizing: `images.kilcon.work/cdn-cgi/image/…/Reviews/…`, and `kilcon.work/cdn-cgi/image/…/https://images.kilcon.work/Reviews/…` | Image Transformations always allow sources from the same zone | 200, `CF-Cache-Status: HIT`, `max-age=14400` |
| E7 | `?project=constructor/x` | `CATEGORY_PREFIX[...]` resolved an inherited object property | 500 (no data leaked) |

Not exposed: `?project=reviews/photos`, `?list=reviews`, `?all=1` without admin, directory listing, lowercase `/reviews/…` (R2 keys are case-sensitive), and double-encoded `%252F`.

Cache: direct objects are `DYNAMIC` (not edge-cached). **Resized variants are cached for up to 4 h.**

---

## 2. Review of the local fixes

An independent security review ran alongside, and all its findings are addressed below.

| Area | Implementation | Status |
|---|---|---|
| E1 slug/category lookup | Slug lookup only searches the public roots (`Highlights, Projects, New Construction, Remodels, Furniture, Apparel`). Category lookup uses `Object.hasOwn(CATEGORY_PREFIX)`. A final root check runs in `getProject`. | ✅ fixed (E1, E7) |
| Review photos at rest | New photos are written **only** to `PRIVATE_BUCKET` (`kilcon-private`) | ✅ |
| **Review records at rest** | New and edited records are written **only** to `PRIVATE_BUCKET`. Reads prefer the private copy; legacy public records are read-only fallbacks until migrated. *(Added this round, E3.)* | ✅ |
| Fail closed | No `PRIVATE_BUCKET` binding → submissions return 500. Nothing ever falls back to the public bucket. | ✅ |
| Serving photos | Only `GET /api/reviews/photo?id=`:<br>• approved → public<br>• pending/hidden → admins only<br>• anything else → identical 404<br>The ID and key are validated against the review's own folder. | ✅ |
| **Stored XSS** (found in review) | Uploads must pass an extension allow-list *and* a magic-byte check (JPEG/PNG/WebP/AVIF). The client MIME type is ignored. Responses take their type from the extension, plus `CSP: default-src 'none'; sandbox`, `nosniff` and `Content-Disposition: inline`. | ✅ fixed |
| Public JSON | `/api/reviews` and the admin list hand out only the gated URL, never `images.kilcon.work/Reviews/…`. Old records with only `photoUrl` still resolve. | ✅ |
| Admin access | `admin_auth` is `Path=/`, `SameSite=Strict`, host-only, so it reaches same-origin `/api/reviews/photo` | ✅ verified in code |
| Admin endpoints | Review IDs are validated (`REVIEW_ID_RE`) on status, reply and delete | ✅ fixed |
| Open redirect (pre-existing) | The review form redirect only goes to `ALLOWED_ORIGINS` | ✅ fixed |
| Image domain | Route `images.kilcon.work/Reviews/*` → Worker returns 404 | ⚠️ defense in depth only. Cloudflare doesn't document Worker routes on R2 custom domains, and the route can't match `%2F` variants. **WAF and deletion are the real controls.** |
| Facebook code | Inert behind `FB_INTEGRATION_ENABLED`: every `/facebook/*` route 404s, public galleries never query D1, cron isn't registered | ✅ tested |

**Tests:** `npm run test:gallery-worker` passes all 47.
- New: private-only storage, fail-closed, disguised SVG/HTML uploads, the sandbox CSP, legacy-record fallback, ID validation, the redirect, prototype keys, the full migration lifecycle, and the inert Facebook switch.
- Mutation checks: storing records publicly fails 3 tests; echoing the stored Content-Type fails 1.

**Other checks:** `npm run build` passes, and `wrangler deploy --dry-run` passes. In the local Workers runtime:
- `?project=photos` → 404.
- Pending photo → 404 public, 200 admin.
- Approved photo → 200 `image/jpeg` with the CSP.
- SVG-as-.jpg → 400.
- Migration inventory → copy → verify is all verified.

**Not verifiable locally:** R2 custom-domain routing, WAF behavior, the r2.dev and resizing paths. These are covered by the live checklist (section 8).

---

## 3. Code changes in this release

| File | Change |
|---|---|
| `workers/kilcon-gallery-worker/src/index.js` | Lookup fixes, gated photo endpoint, private-only review writes, ID validation, redirect fix, Facebook master switch, migration route |
| `workers/kilcon-gallery-worker/src/reviewPrivacy.js` | **New:** private-first review storage, content-type safety, migration (inventory / copy / verify / gated delete) with manifests |
| `workers/kilcon-gallery-worker/src/facebook.js` | Must ship because `index.js` imports it; **inert** in this release |
| `workers/kilcon-gallery-worker/wrangler.toml` | `account_id`, `PRIVATE_BUCKET` binding, `images.kilcon.work/Reviews/*` route, `FB_INTEGRATION_ENABLED="false"`, D1 binding (unused while disabled), cron **commented out** |
| `workers/kilcon-gallery-worker/test/facebook.test.mjs` | 47 tests |
| `workers/kilcon-gallery-worker/scripts/verify-review-privacy.sh` | **New:** live verification, status codes only |
| `package.json` | `test:gallery-worker` script |

**No Astro changes are needed.** The pages already render whatever `photoUrl` the Worker returns.

When you commit, **leave these out of the security commit** (they belong to the Facebook rollout):
- `src/pages/admin/facebook.astro`
- `src/pages/admin/facebook-script.ts`
- the dashboard link in `src/pages/admin/dashboard.astro`
- the `fb-*` styles in `src/styles/admin.css`
- optionally `migrations/013_facebook_sync.sql`

If Pages deploys from a git push, a commit without them leaves the live site unchanged.

---

## 4. Cloudflare changes (exact)

All of these happen in the **Kil.con.contact** account (`8481dbc471ac3a4aa14cc26ea366f956`), zone `kilcon.work`. Run commands from `workers/kilcon-gallery-worker/`.

| Step | Command / setting | Reversible |
|---|---|---|
| Create the private bucket | `npx wrangler r2 bucket create kilcon-private` | Yes (keep it) |
| Verify it's private | `npx wrangler r2 bucket dev-url get kilcon-private` → *disabled*<br>`npx wrangler r2 bucket domain list kilcon-private` → *none* | – |
| Deploy the Worker | `npx wrangler deploy` | `npx wrangler rollback <id>` |
| Disable r2.dev on the gallery | `npx wrangler r2 bucket dev-url disable kilcon-gallery` | `… dev-url enable` (would re-expose) |
| WAF custom rule | Dashboard → kilcon.work → Security → WAF → Custom rules (expression below) | Toggle off / delete |
| Purge | Dashboard → Caching → Configuration → Custom Purge: by URL (each deleted key), then by prefix `images.kilcon.work/Reviews/` | – |

Nothing in the repo or the deployed config references the r2.dev URL. The site uses `images.kilcon.work`.

`wrangler deploy` replaces the Worker's vars, bindings and routes with what `wrangler.toml` lists.
- The deployed config was checked on 2026-10-18 (version `659fdd03-26a1-4e91-9fb3-e17da4b17d42`) and matches it plus the new items.
- Secrets (`ADMIN_SECRET`, `TURNSTILE_SECRET`) are never removed by a deploy.

---

## 5. WAF rule

**Where:** zone `kilcon.work` → Security → WAF → **Custom rules** → Create rule.
- Name: `Block private review storage`
- Action: **Block**
- Place it **first**.

```
(http.host eq "images.kilcon.work" and lower(url_decode(http.request.uri.path, "r")) contains "reviews")
or (starts_with(http.request.uri.path, "/cdn-cgi/image/") and lower(url_decode(http.request.uri.path, "r")) contains "reviews")
or (lower(url_decode(http.request.uri.path, "r")) contains "/reviews/photos/")
or (lower(url_decode(http.request.uri.path, "r")) contains "/reviews/data/")
```

How the expression works:
- `url_decode(…, "r")` decodes recursively, which catches `%2F` and `%252F`. `lower()` catches case variants. Dot segments and `%52`-style encodings are already normalized by Cloudflare's default URL normalization.
- **Clause 1:** anything mentioning "reviews" on the image domain. No public gallery folder name, and none of the previews or Highlights files I sampled, contains "review".
- **Clause 2:** resizing URLs on *any* zone host, including `kilcon.work/cdn-cgi/image/…/https://images.kilcon.work/Reviews/…`.
- **Clauses 3–4:** private storage paths on any host, such as `www`.
- These never match the site's own `/reviews` page or `/api/reviews/{summary,submit,photo,admin/…}`.

> ⚠️ Cloudflare doesn't document whether WAF custom rules evaluate on `/cdn-cgi/image/` paths.
> Section 8 tests this live. If resizing URLs still return 200 after the rule is on, the remaining
> protection is deleting the public copies (step 7) and purging, so do that step promptly.

Free plan: 5 custom rules; this uses 1.

---

## 6. Deployment order

| # | Step | Production change | Gate to continue |
|---|---|---|---|
| 0 | Local pre-flight: review the diff, run `npm run test:gallery-worker` (47 pass), `npx wrangler deploy --dry-run`, commit the security subset (section 3) | none | all green |
| 1 🔒 | Create `kilcon-private`. Verify no dev URL and no domain. | new empty bucket | both checks private |
| 2 🔒 | `npx wrangler deploy`. **Record the previous version id** (`npx wrangler deployments list`). | Worker code + route | Checklist A, C and D pass |
| 3 🔒 | `npx wrangler r2 bucket dev-url disable kilcon-gallery` | r2.dev off | r2.dev checks blocked; site images still load |
| 4 🔒 | Add the WAF rule (section 5) | WAF | Checklist B passes; Security Events show the blocks; site images load |
| 5 🔒 | Migration: inventory → copy → verify (section 7). This only writes to the private bucket. | private bucket writes | `allVerified: true`; approved photos display; admin sees pending photos |
| 6 | **Approval checkpoint.** Review the verify manifest. | – | your explicit OK |
| 7 🔒 | `delete-public` with that manifest (within 24 h), then purge by URL and by prefix | deletes public review objects only | Full checklist passes; inventory shows `total: 0` |
| 8 | Monitor for 48 h: Worker logs (`npx wrangler tail`), WAF Security Events, `/reviews` and admin | – | – |

- **Astro:** no deploy needed for this release.
- **D1:** no migration in this release (`013_facebook_sync.sql` waits for the Facebook rollout).
- **Facebook:** `FB_INTEGRATION_ENABLED` and `FB_AUTO_IMPORT` stay `"false"`; no Meta tokens, secrets or subscriptions.
- **Between steps 2 and 7:** steps 3–4 close direct access. Until step 7 the legacy files still exist in the public bucket, so do steps 2 → 4 back to back.

---

## 7. Review-photo migration

The admin endpoint is `POST https://kilcon.work/api/reviews/admin/migrate`. Run it from the browser console on kilcon.work while logged in as admin:

```js
const mig = (body) => fetch("/api/reviews/admin/migrate", {
  method: "POST", credentials: "include",
  headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
}).then((r) => r.json());

const inv = await mig({ action: "inventory" });  // 1. list everything under Reviews/ (read-only)
const cp  = await mig({ action: "copy" });       // 2. copy to kilcon-private
const ver = await mig({ action: "verify" });     // 3. byte-compare + resolve check
ver.allVerified; ver.summary; ver.manifestKey;    //    review before step 6
```

**`inventory`** counts data records, photos and other objects, and shows which already have a private copy. It writes nothing.

**`copy`**
- Copies each missing object to `kilcon-private` under the **same key**, with SHA-256, source ETag, size and time in its metadata.
- Reads the copy back and hash-checks it.
- **Never overwrites** an existing private object; re-running is safe.
- Writes a manifest to `kilcon-private:Migrations/reviews/<time>-copy.json`.

**`verify`**
- For every public object, compares SHA-256 against the private copy.
- For photos, also checks that the owning review resolves to that key and records its status. Photos with no review are flagged as orphans but still verified.
- A private record that an admin edited after copying is accepted as `verified-private-newer`.
- Writes `…-verify.json` with `allVerified`.

**Before approving deletion:**
- `ver.allVerified === true`, and `ver.summary` has only `verified*` keys.
- `/reviews` and the homepage show the approved photos; check one in the browser.
- The admin reviews page shows pending photo thumbnails.
- The pending photo returns 404 when logged out (checklist C).

**`delete-public`** (step 7, after approval):

```js
await mig({ action: "delete-public", manifest: ver.manifestKey, confirm: "DELETE PUBLIC REVIEW COPIES" });
```

- It refuses if the confirm phrase is wrong, the manifest isn't a verify manifest, `allVerified` is false, or the manifest is older than 24 h.
- Before deleting each object it checks again that the public ETag is unchanged and that the private copy still has the manifest's hash. Anything that changed is skipped, not deleted.
- It deletes only keys listed in the manifest, so gallery images can't be touched.
- It writes a `…-delete.json` manifest.

**Recovery:** every manifest, and every byte, stays in `kilcon-private`; masters are never deleted. For failures, re-run `copy` then `verify`. The endpoint lists every failure by key.

---

## 8. Production verification checklist

Script: `bash workers/kilcon-gallery-worker/scripts/verify-review-privacy.sh`

It sends status-code-only requests and discards bodies. Optional inputs:
- `PHOTO_KEY`: a legacy photo key, from the inventory.
- `PENDING_ID`: a pending or hidden review id.
- `ADMIN_COOKIE`: an admin session. It is never echoed.

The **baseline** column is today's production result (2026-10-18).

| Check | Expected after release | Baseline |
|---|---|---|
| **A. API** | | |
| `?project=photos`, `?project=data` | 404 | **200 / 200** |
| `?project=reviews/photos`, `Reviews/photos`, `../Reviews` | 404 / 404 / 400 | 404 / 404 / 400 |
| `?project=constructor/x` | 404 or 400 | **500** |
| `?list=reviews` / `?all=1` (no admin) | 400 / 401 | 400 / 401 |
| `/api/gallery-api/facebook/webhook` | 404 | 404 |
| `/api/reviews/admin/migrate` without admin | 401 | 404 (doesn't exist yet) |
| **B. Direct and transformed** (after steps 3–4; 403 from WAF, 404 after step 7) | | |
| images direct, `%2F`, `photos%2F`, `%52`, `./`, `x/../` | 403/404 | **200 ×6** |
| images resizing, resizing with `%2F` | 403/404 | **200 / 200** |
| kilcon.work resizing with absolute images src | 403/404 | **200** |
| r2.dev direct photo | 401/403/404 | **200** |
| Review record JSON on images / r2.dev | 403/404 | **200 / 200** |
| **C. Review photos** | | |
| `/api/reviews` contains no `images.kilcon.work/Reviews` | true | **false** |
| Approved photo via `/api/reviews/photo` | 200 `image/*` + CSP sandbox | 404 (doesn't exist yet) |
| Unknown / malformed id | 404 / 404 | 404 / 404 |
| Pending or hidden photo, logged out | 404 | – |
| Pending or hidden photo, admin / admin list | 200 / 200 | – |
| **D. Site health** | | |
| `/`, `/projects`, `/services/*`, `/apparel`, `/reviews`, `/contact`, `/privacy`, `/sitemap.xml` | 200 | 200 |
| `list=projects`, `list=highlights`, `/api/reviews/summary` | 200 | 200 |
| A project page, a gallery image, a gallery thumbnail | 200 | 200 |
| An apparel page and `/api/item` | 200 | 200 |

**Manual checks:**
- On `/reviews`, approved photos render.
- On `/admin/reviews`, pending thumbnails render.
- Submit a test review with a photo, then confirm it isn't public and that the admin can see it. Delete it afterwards.
- Under Security → Events, the blocked requests show the new rule.

After step 7, run the script again. B should still be blocked, now 404 at origin even without WAF. The step-5 `inventory` should report `total: 0`.

---

## 9. Rollback and recovery

Principle: **fix forward.** Rolling back to version `659fdd03` brings back E1 and stores new reviews publicly again. Use it only as a short emergency step, with protections in place.

| Failure | Action | Exposure while recovering |
|---|---|---|
| `wrangler deploy` errors | Nothing changes; deploys are atomic. Fix and redeploy. | Unchanged from baseline |
| Deployed Worker breaks galleries/reviews | 1. Keep r2.dev disabled and the WAF rule on.<br>2. Add a temporary WAF rule: `(http.request.uri.path eq "/api/gallery-api" and lower(url_decode(http.request.uri.query, "r")) contains "project=photos") or (http.request.uri.path eq "/api/gallery-api" and lower(url_decode(http.request.uri.query, "r")) contains "project=data")`<br>3. `npx wrangler rollback 659fdd03-26a1-4e91-9fb3-e17da4b17d42`<br>4. Fix forward and redeploy. | Old code writes new reviews to the public bucket (blocked by WAF). Keep the rollback window short. |
| No D1 migration in this release | – | – |
| Approved review photos don't show | Check `/api/reviews/photo?id=` status. If 404, check that the record resolves (`verify` manifest `resolves`). The endpoint reads private, then legacy public, so before step 7 nothing is lost. | None |
| Incomplete or failed copy | Re-run `copy` (idempotent), then `verify`. Deletion is impossible until `allVerified`. | None (WAF holds) |
| After deletion, a photo is missing | It must be in `kilcon-private` (hash-checked before delete). Look up its key in the delete manifest. **Never** restore to the public bucket. | None |
| WAF blocks legitimate images | Security → Events → identify the rule match → turn the rule **off**, then narrow it (drop clause 1 and keep clauses 2–4). | r2.dev is still off; repeat the B checks quickly |
| r2.dev turns out to be needed | Don't re-enable it before step 7. After step 7 the bucket has no review objects and re-enabling is low risk. | – |
| PRIVATE_BUCKET binding missing | Review submissions fail with 500 (fail closed); reviews and galleries still display. Add the binding and redeploy. | None |

Never delete `kilcon-private` or anything under `Migrations/reviews/`.

---

## 10. Remaining risks and open questions

1. **WAF on `/cdn-cgi/image/`** isn't documented. Until step 7, resized URLs may still serve cached variants for up to 4 h. Shorten that window by doing steps 2 → 7 the same day once you approve.
2. **The Worker route on the R2 custom domain** isn't documented. It's defense in depth only; check its behavior with checklist B.
3. **Other copies:** links to review photos in old emails or search-engine caches, or images already saved by third parties, can't be revoked.
4. **Pages deployment:** I don't know whether Pages deploys automatically on git push. Confirm this before committing, and keep the Facebook admin files out of that commit.
5. **Existing WAF, cache, Transformations or Access rules** on the zone weren't inspected; that needs a dashboard view or an API token. Check whether any rule conflicts with the new one.
6. **Legacy public review records stay** (blocked) until step 7, and admin edits made before then are saved privately. Approved reviews keep showing either way.
7. **Rate limits:** `/api/reviews/photo` uses `READ_LIMITER` (60 per 10 s per IP). That's enough for a page of 10 photos.
