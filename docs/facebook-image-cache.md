# Facebook image caching: investigation and proposed fix

Status: **investigation and design only. Nothing changed in production.** Measured 2026-11-21.

## Evidence

### What is served today

All Facebook photos are served from the public R2 custom domain `images.kilcon.work`.

| Request | Stored on R2 | Served to browser | Edge cache |
|---|---|---|---|
| `GET /Facebook/<id>.jpg` | `public, max-age=3600` (seen with HEAD) | `public, max-age=14400` | MISS → HIT |
| `GET /cdn-cgi/image/width=480,fit=cover,quality=80/Facebook/<id>.jpg` | n/a | `public, max-age=14400` | MISS → HIT |
| Same, at any other width, or via `kilcon.work/cdn-cgi/image/.../https://images.kilcon.work/Facebook/<id>.jpg` | n/a | `public, max-age=14400` | cached separately |
| `GET /Facebook/<missing>.jpg` (404) | n/a | `max-age=14400` | EXPIRED → HIT (404s are edge-cached) |
| Admin gallery image (`/Projects/...`) | *no Cache-Control* | `max-age=14400` | HIT |
| Pages static asset (`/_astro/*.css`, `/favicon.svg`) | `max-age=0, must-revalidate` | `public, max-age=14400, must-revalidate` | n/a |

### What overrides the headers

Shorter-than-4 h origin values are raised to 4 h on **both** hosts, and responses with no
`Cache-Control` get 4 h added. That is the documented behavior of the zone-wide
**Browser Cache TTL = 4 hours** setting: Cloudflare overrides the origin when its value is
lower than the setting, or when the origin sends none.

A Cache Rule scoped to images would not affect Pages assets, so the cause is the zone setting.

The wrangler token can't read zone settings or Cache Rules. **Confirm in the dashboard:**
Caching → Configuration → Browser Cache TTL, and Caching → Cache Rules.

### What is not affected

**Worker responses are not raised.** Before the 2026-11-19 release, review photos were
served by the Gallery Worker with `public, max-age=300`, and browsers received exactly that,
with no `CF-Cache-Status` (see `security-release-2026-11-19.md` §C).

### What happens when a photo is hidden

When a photo is hidden, deleted or unpublished on Facebook, or hidden by an admin or with
its project, `reconcilePhoto()` deletes the public R2 object immediately (`src/facebook.js`).
The master copy stays in the private bucket.

So the origin is correct within seconds. All remaining exposure is cached copies:

- **Full images at the edge:** until the edge TTL expires, about 1 h if it follows the stored `max-age`.
- **Every variant URL already cached at the edge:** variants can be requested at any width, through either host.
- **Browsers that already loaded the photo:** up to 4 h.
- **Restored photos:** a visitor who got the cached 404 keeps seeing a broken image for up to 4 h after the photo is restored.

Gallery listings are not a source of exposure. The gallery API is `no-store`, and the SSR pages aren't edge-cached, so a hidden photo leaves the gallery pages at once.

## Options considered

| Option | Browser TTL | Invalidation | Cost and risk |
|---|---|---|---|
| A. Zone Browser Cache TTL → "Respect existing headers" | 300 s, once R2 metadata changes | none (≤5 min) | **Zone-wide.** Admin gallery images (no header) and Pages assets lose browser caching. Rejected. |
| B. Cache Rule (host `images.kilcon.work`, path contains `/Facebook/`, Browser TTL "respect origin") + rewrite the R2 metadata of the 8 objects + `PUBLIC_CACHE_CONTROL` | 300 s | none. Stale ≤5 min at the edge and in browsers. Unclear whether the rule matches `/cdn-cgi/image/` variants. | One zone rule, an R2 data change, no code risk. |
| C. Purge on hide (Cache Purge API) | needs B too | edge only. Each variant URL must be listed, and arbitrary widths can't be enumerated. | **Needs a purge token.** Not necessary given D. |
| **D. Worker-gated Facebook images (recommended)** | **300 s** | **Immediate at the edge, for full images and variants.** Only browsers holding a copy keep it, for ≤300 s. | New Worker route plus an Images binding. 1 Worker request and 1 R2 HEAD per image view. No purge token. |

## Recommended design (D)

### 1. Worker route

Add `images.kilcon.work/Facebook/*` → `kilcon-gallery-worker`, like the existing `Reviews/*` route.

Set the route's request-limit failure mode to **fail open**. If the Free-plan daily limit
(100k requests) is reached, requests fall through to R2. Hidden photos are already deleted
there, so they still return 404.

### 2. Handler `serveFacebookImage(request, env)`

**Accepted requests.** GET and HEAD only. Two path forms, anything else returns 404 `no-store`:

- `/Facebook/<digits>.jpg` (full image)
- `/Facebook/w/<480|600|1200|2000>/<digits>.jpg` (variant)

**Visibility gate, on every request and before any cache lookup:**
`GALLERY_BUCKET.head("Facebook/<id>.jpg")`. The public object exists only while the photo is
visible, so this is the single source of truth.

- If the object is missing, return 404 with `Cache-Control: no-store`.

**Full image.**

1. `GALLERY_BUCKET.get(key, { onlyIf: request.headers })` handles `ETag` and 304 responses.
2. Respond `Cache-Control: public, max-age=300`, with the `ETag`, the stored `Content-Type` and `X-Content-Type-Options: nosniff`.

**Variant.**

1. Look up `caches.default` by the variant URL.
2. On a miss, transform with the **Images binding**:
   `env.IMAGES.input(obj.body).transform({ width, fit: "cover" }).output({ format: "image/jpeg", quality: 80 })`.
   It reads the R2 body directly, with no URL fetch, so there is no request loop and no dependence on `/cdn-cgi/image`.
3. Store the result in `caches.default` with a long internal TTL (`s-maxage=86400`).
4. Serve it to the browser with `public, max-age=300`.

A stale cache entry is never served after a hide, because the gate runs first. **No purge is ever needed.**

### 3. URLs the site emits

`buildThumbUrl()` emits `https://images.kilcon.work/Facebook/w/480/<id>.jpg` for Facebook
keys only. Non-Facebook images keep their `/cdn-cgi/image/` URLs.

The site's `withWidth()` helpers (`projects/index.astro` and the three `services/*/index.astro`)
also rewrite `/Facebook/w/\d+/` to the allowed widths 600, 1200 and 2000.

### 4. Optional zone hardening (WAF custom rule)

Block requests where:

```
starts_with(http.request.uri.path, "/cdn-cgi/image/") and http.request.uri.path contains "/Facebook/"
```

This stops arbitrary-width variants that would bypass the gate. Without it, a variant that
was **already** edge-cached before a hide stays reachable at its exact URL until it expires.
After the hide, uncached variants fail because the R2 source is gone.

## Cached 404s

- **Edge-cached 404s** under `/Facebook/*` are never served again, because the Worker route runs before the cache. New 404s are `no-store`.
- **Browser-cached 404s from before the deploy** (`max-age=14400`) can't be cleared server-side. They expire within 4 h. All 8 current photos are visible, so no visitor should have one.

## Existing 8 images: R2 metadata

**No update needed under D.** The Worker sets the response headers, so the stored
`cacheControl` (`public, max-age=3600`) is no longer sent for `/Facebook/*`. It only matters
again if the route is removed.

Under option B, all 8 objects would need their metadata rewritten in place, and
`PUBLIC_CACHE_CONTROL` changed to `public, max-age=300`.

## Things to confirm before building

1. Image Transformations or the Images binding are available on the account's Free plan, and the monthly quota (5,000 unique transformations) is acceptable. About 8 photos × 4 widths today; historical album import will raise it.
2. The dashboard values of Browser Cache TTL and Cache Rules (see Evidence).
3. Worker request volume after historical import. Each Facebook image view costs one Worker request. The 300 s browser TTL and `loading="lazy"` limit repeats.

## Deploy order and rollback (needs approval)

1. **Worker:** `versions upload --tag <commit>`, then `versions deploy`. This adds the route, the Images binding and the handler.
2. **Verify** the full image, each variant, a 404, and a 304 revalidation:
   - Status codes are as expected.
   - `Cache-Control` is `public, max-age=300`, or `no-store` on 404s.
   - Edge behavior is correct.
3. **Pages:** deploy the `withWidth()` change.
4. **Rollback:** `npx wrangler rollback b5ad9617-2324-4aca-962f-2ac1c3e33b76`, **then remove the `images.kilcon.work/Facebook/*` route** in the dashboard (Workers → Routes).
   - Routes aren't versioned, so a rollback alone leaves the route pointing at old code that doesn't handle it.
   - The rolled-back Worker emits `/cdn-cgi/image/` thumbnail URLs again.
   - The 8 R2 objects are untouched.
