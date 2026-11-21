# Facebook image caching: gated delivery

Status: **implemented and tested on branch `feat/facebook-image-gate`. NOT deployed.**
No production Cloudflare rule, route, R2 object or D1 row has been changed.
Investigation 2026-11-21; implementation 2026-11-21.

## 1. Problem (measured live)

All Facebook photos are served from the public R2 custom domain `images.kilcon.work`.

| Request | Stored on R2 | Browser receives | Edge |
|---|---|---|---|
| `/Facebook/<id>.jpg` | `public, max-age=3600` | `public, max-age=14400` | MISS → HIT |
| `/cdn-cgi/image/<any params>/Facebook/<id>.jpg`, on either host | n/a | `public, max-age=14400` | HIT, one entry per parameter set |
| `/Facebook/<missing>.jpg` (404) | n/a | `max-age=14400` | EXPIRED → HIT |
| Manual gallery image | none | `max-age=14400` | HIT |
| Pages asset | `max-age=0, must-revalidate` | `public, max-age=14400, must-revalidate` | n/a |

### Why browsers get 4 hours

The zone's **Browser Cache TTL is 4 hours**. Cloudflare raises any shorter origin value to
4 hours, and adds 4 hours when the origin sends none. This happens on both hosts.

Worker responses are **not** raised: pre-release review photos at `max-age=300` reached
browsers as 300. The wrangler token can't read zone settings; confirm the value under
Caching → Configuration.

### What hiding a photo leaves behind

`reconcilePhoto()` deletes the public R2 copy within seconds of a hide, delete or unpublish.
Galleries stop listing the photo at once, because the gallery API is `no-store`. But cached
copies remain reachable:

- **Full image at the edge:** about 1 hour.
- **Every resized URL already cached:** up to the edge TTL.
- **Browsers that already loaded it:** up to 4 hours.
- **Restored photos:** a visitor who got the cached 404 sees a broken image for up to 4 hours.

## 2. Could a narrowly scoped Cache Rule solve it? No

A rule matching host `images.kilcon.work` with path starting `/Facebook/`, set to
Browser TTL "respect origin" and Edge TTL "respect origin", plus R2 metadata rewritten to
`max-age=300`, would bound exposure to about 5 minutes. It falls short on every requirement
that matters:

| Requirement | Cache Rule result |
|---|---|
| Hidden photo unreachable | No. It is still served from the edge and from browsers for up to 300 s, because nothing checks visibility. |
| Resized variants | Unknown and unbounded. Each `/cdn-cgi/image` parameter set is cached separately, and it isn't documented that the rule applies to transformed responses. A Cache Rule can't make browsers cache *less* than the origin says. |
| Old transformation URLs and arbitrary parameters | Still work for visible photos; already-cached copies of hidden ones persist. |
| Cached 404s | Needs status-code TTL handling, and pre-change browser 404s persist anyway. |
| No production data change | Needs the metadata of every Facebook object in R2 rewritten. |

The only token-free ways to make a hide take effect immediately are to check visibility on
every request (the gate below) or to block the request before the cache (WAF).

## 3. Implementation (`workers/kilcon-gallery-worker`)

### Route

`images.kilcon.work/Facebook/*` → `kilcon-gallery-worker` (`wrangler.toml`).

The route's request-limit failure mode must be **Fail closed**. Do not use Fail open: it
would send requests to R2 when the daily Worker limit is hit.

### `src/facebook-image.js`, on every request

1. **GET and HEAD only.** Anything else gets 405 `no-store`.
2. **Strict canonical paths only.** No decoding, no extra segments, no leading-zero widths, and the extension must match the stored key.
   - `/Facebook/<digits>.<jpg|png|webp>`: full image.
   - `/Facebook/w/480/<digits>.<ext>`: thumbnail. 480 is the **only** width the site uses; adding one is a one-line change and costs one unique transformation per photo per month.
3. **Visibility gate in D1, before any cache lookup.** It uses the same `VISIBLE_PHOTO_SQL` as the gallery listings (now exported):
   - status `imported`, not hidden, `public_key` set;
   - project not hidden;
   - `FB_INTEGRATION_ENABLED = "true"`.
4. **Bytes come from the private master** (`PRIVATE_BUCKET`), never from the public bucket.
5. **Thumbnails** are resized from the master with the **Images binding**, so no `/cdn-cgi/image` URL is involved.
   - Each thumbnail is stored in the Worker Cache API for 24 h. That's safe because the gate runs first.
   - If the transformation fails (quota error 9422, input over 20 MB, binding outage), the original is served **uncached**. The gate has already passed, so this is not a bypass.
6. **Visible responses** get `Cache-Control: public, max-age=300`, an `ETag`, 304 revalidation, and `nosniff`.
7. **Missing, hidden, deleted or unknown** → 404 `no-store`.
8. **Any error** (D1, R2 or Cache API) → **503 `no-store`**. Nothing falls through to R2.

### Other changes

- **`buildThumbUrl()`:** Facebook keys now get `https://images.kilcon.work/Facebook/w/480/<id>.<ext>`. Manual gallery images keep `/cdn-cgi/image/...` (unchanged; asserted by the existing upload test).
- **`[images] binding = "IMAGES"`** added.
- **No site (Pages) change is needed.**
  - `ProjectCard` shows only the thumbnail.
  - The detail pages' srcset `.replace('=s0', …)` already never matched.
  - The index pages' preload `withWidth()` simply doesn't rewrite the new URL, so it preloads the thumbnail actually displayed.
- **The existing public R2 copies are left untouched.** No R2 change is needed. They exist only for visible photos, are no longer used, and keep a rollback possible.

## 4. Bypass analysis

| Path | After deploy |
|---|---|
| `images.kilcon.work/Facebook/<id>.jpg`, including edge-cached copies from before the deploy | Goes to the Worker; the route runs before the cache. **Gated.** |
| `images.kilcon.work/Facebook/w/<other>/…`, `?width=…`, `0480`, wrong extension, extra segments | **404 `no-store`.** Query strings are ignored and never reach the cache key. |
| `images.kilcon.work/cdn-cgi/image/<any>/Facebook/…` and `kilcon.work/cdn-cgi/image/<any>/https://images.kilcon.work/Facebook/…` | Bypass Workers. Hidden photos aren't in the public bucket, but **already-cached variants stay reachable**. **Needs the WAF rule.** |
| Encoded or case variants (`/Facebook%2F…`, `/%46acebook/…`, `/facebook/…`) | Don't match the route pattern; R2 may normalize them to the public copy (`security-deployment-plan.md` E5). Visible photos only, but cached copies persist. **Covered by the WAF rule.** |
| r2.dev | Disabled on both buckets (checked 2026-11-21). |
| Other custom domains | None. `kilcon-gallery` has only `images.kilcon.work`; `kilcon-private` has none. |
| `www.kilcon.work` | 301 to the apex. |
| `*.workers.dev` | Not served: the gate runs only for host `images.kilcon.work`. |

### WAF custom rule: required, action **Block**

```
(starts_with(http.request.uri.path, "/cdn-cgi/image/") and lower(url_decode(http.request.uri.path, "r")) contains "facebook")
or (http.host eq "images.kilcon.work" and lower(url_decode(http.request.uri.path, "r")) contains "facebook"
    and not starts_with(http.request.uri.path, "/Facebook/"))
```

- It mirrors the existing Reviews rule.
- The WAF is verified to evaluate `/cdn-cgi/image/` paths: Reviews variants return 403 on both hosts.
- **False positives:** none among the 198 public gallery URLs. Facebook covers stop using `/cdn-cgi/image` with this deploy.
- **Plan capacity:** the Free plan allows 5 custom rules; this would be the second.

## 5. Tests

- `test/facebook-image.test.mjs` (20 tests, real local D1/R2): visible, private-only, 304/HEAD, thumbnail plus cache hit, query strings, hide with a cached thumbnail (the cache is never read), stale public copy, a real hide → restore through `reconcilePhoto`, deleted, hidden project, importing, integration off, 14 bypass paths, encoded prefixes, methods, other hosts, D1 / R2 / Cache API failures (503 `no-store`), transformation quota failure and a missing binding, and the URL helpers.
- **Real runtime** (`wrangler dev --local`, local D1/R2 only, Images binding local mode):
  - Thumbnail is a real 480×252 JPEG of 13 KB.
  - Full image is 59 KB, served from the private master rather than a decoy public copy.
  - 304 works for both.
  - `w/600` → 404 `no-store`.
  - Hide → 404 on the next request; restore → 200; project hide → 404; delete → 404.
- Totals: Worker suite **145/145**, site suite **37/37**. `wrangler deploy --dry-run` bundles fine (179 KiB, 43 KiB gzip) with `env.IMAGES`.

## 6. Costs and limits

| Resource | Free plan | Estimated use |
|---|---|---|
| **Image Transformations** (shared by the binding and `/cdn-cgi/image`; unique per image and parameters per calendar month) | 5,000/month. Over the limit, new transformations fail (9422) and cached ones keep working. No charge. | Facebook: ≤ 388 with 388 photos × 1 width. Manual galleries: about 198 thumbnails + 3 × ~40 cover preloads ≈ 320. **Total ≈ 700–800/month.** A failed transformation serves the original. |
| **Workers requests** (account-wide, all Workers) | 100,000/day, then the route fails closed (error 1027) | 1 per Facebook image view; repeats within 5 min come from the browser cache. ~50 images per visitor × 100 visitors ≈ 5k/day; 1,000 visitors ≈ 50k/day. |
| Workers CPU | 10 ms/request | D1, R2 and Images are I/O. The original-image fallback buffers up to 25 MB, the only CPU-heavy path. |
| D1 reads | 5M rows/day | About 2 rows per image request. |
| R2 Class B | 10M/month | 1 per full image, plus 1 per thumbnail cache miss. |

**Main operational risk: the shared 100k/day Worker limit.** When it's exhausted, every
Worker route fails closed until 00:00 UTC: galleries, reviews, the Facebook webhook (Meta
retries) and now images.

Mitigations, either of which needs approval:

- **Workers Paid** ($5/month: 10M requests/month included, no daily cliff). Recommended before the historical import of 388+ photos.
- **A WAF rate-limiting rule** (Free: 1 rule, 10 s period) on `images.kilcon.work/Facebook/*`. It blocks scrapers before they consume Worker requests.

## 7. Deploy runbook (needs approval)

Current rollback points: Worker version `b5ad9617-2324-4aca-962f-2ac1c3e33b76`; Pages unaffected.

1. **Upload the version** (no traffic change):
   `npx wrangler versions upload --tag <commit> --message "Gated Facebook images"`.
   This also confirms the account accepts the `IMAGES` binding.
2. **Add the route while the old code is live:** `npx wrangler triggers deploy`. It applies `wrangler.toml` routes and crons.
   - The old code answers `/Facebook/*` with 404 `no-store` for a few seconds, so nothing is cached.
   - The reverse order would let R2 404s for the new thumbnail URLs be browser-cached for 4 h.
3. **Deploy the version:** `npx wrangler versions deploy <version-id>@100% -y`.
4. **Dashboard:** set the `images.kilcon.work/Facebook/*` route's failure mode to **Fail closed**, and confirm `kilcon.work/api/*` and `Reviews/*` too.
5. **Verify:**
   - Full image, thumbnail, 304 and `w/600` → 404 all behave as tested.
   - The gallery API thumbnails are `/Facebook/w/480/…`.
   - The projects pages render.
6. **Add the WAF rule** (§4), then verify that the Facebook `/cdn-cgi/image/` URLs return 403 on both hosts and that manual gallery thumbnails still load.

## 8. Rollback

1. Disable the WAF rule first; otherwise the old code's `/cdn-cgi/image` Facebook thumbnails are blocked.
2. `npx wrangler rollback b5ad9617-2324-4aca-962f-2ac1c3e33b76`. The old code emits `/cdn-cgi/image` thumbnails again. Facebook full images return 404 `no-store` until step 3.
3. **Remove the `images.kilcon.work/Facebook/*` route** in Dashboard → Workers → kilcon-gallery-worker → Domains & Routes. Routes aren't versioned, so a rollback alone keeps the route. Requests then reach the untouched public R2 copies again.
4. Check with curl that `/Facebook/<id>.jpg` returns 200 from R2.

No D1 or R2 data changes, so nothing else needs undoing.

## 9. Follow-up (separate approval): private-only storage

Stop writing public Facebook copies in `reconcilePhoto()`, and delete the existing ones
(an R2 change; 8 objects today). After that the public bucket holds no Facebook bytes, so
even a removed route or a WAF misconfiguration can't expose a photo.

Trade-off: a rollback would then have to recreate the public copies from the private masters.
