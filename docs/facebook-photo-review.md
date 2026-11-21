# Historical Facebook photo review

Status: **built and tested locally on branch `task/historical-photo-review`. NOT deployed.**
Base commit `25687ff`. It needs migration 017 plus a Worker and a Pages deploy, each with owner approval.

## What it does

`/admin/facebook-review` is an admin-only page for deciding, photo by photo, which historical
Facebook photos may be imported. It never imports, moves, hides or deletes anything. It stores
decision labels in D1 (migration 017). The reviewed historical import (on `/admin/facebook`)
then imports only photos labelled **Import**.

### The page

```
┌ Review historical Facebook photos ─────────────────────────────────────────────┐
│ Import 0 · Duplicate/Skip 0 · Review later 0 · Approved, not yet imported 0     │
├──────────────────────┬──────────────────────────────────────────────────────────┤
│ Project albums       │ Schwennson                Compare with [Projects/Schw… ▾]│
│  Schwennson   31·0·0 │ [Mark likely duplicates as Duplicate] [Mark remaining …] │
│  Gibson       19·0·0 │ 22 likely duplicates, 3 possible matches.                │
│  …                   │ Facebook photos                  │ Website gallery       │
│ Unsorted uploads     │ ┌──────┐ ┌──────┐ ┌──────┐       │ ┌────┐ ┌────┐ ┌────┐  │
│  Mobile uploads 91   │ │photo │ │photo │ │photo │       │ │site│ │site│ │site│  │
│ Branding (never)     │ │Likely│ │      │ │Poss. │       │ └────┘ └────┘ └────┘  │
│  Profile pictures    │ │dup(2)│ │      │ │(8)   │       │                       │
│                      │ │[Dup][Import][Later]  …         │                       │
└──────────────────────┴──────────────────────────────────────────────────────────┘
```

- **Albums.** Albums are listed in three groups, each with its photo count, how many are reviewed, and how many are already on the website:
  - **Project albums.**
  - **Unsorted uploads.** Generic albums such as Mobile uploads. They are compared with **all** website galleries by default; a photo marked Import there gets its project in the import step.
  - **Branding.** Profile and cover pictures. Shown read-only; they are never imported.
- **Compare with.** The gallery on the right defaults to the album's existing mapping, then to the suggested match. Name matching includes spelling hints such as "Pfafe" → Pfaffe House, and **both** category copies of a project. You can also choose any manual gallery, a Facebook project (for example Ganz Garage), "All website galleries" or nothing. The choice is remembered per album in your browser only.
- **Likely-duplicate badges.**
  - The page fingerprints every image in your browser using the same perceptual hash as the Phase 2 analysis.
  - "Likely duplicate" means 5 bits or fewer apart; "possible match" means 6–10. The distance is shown on the badge.
  - The badge's thumbnail jumps to and highlights the matching website photo.
  - Fingerprints are hints: crops or heavy edits may not match. Always look before deciding.
- **Decisions.**
  - Each Facebook photo has **Duplicate / Skip**, **Import** and **Review later**. Clicking the active choice clears it.
  - Decisions save automatically (batched, retried on failure). "Duplicate" also records which website photo it duplicates.
  - Photos already imported, and branding photos, have no buttons.
- **Bulk actions** apply only to *unreviewed* photos in the open album and need a second click to confirm:
  - *Mark likely duplicates as Duplicate*
  - *Mark remaining unreviewed as Import*
  - *Mark remaining unreviewed as Review later*

## Import approval rules (no dates)

`reviewGate` (`workers/kilcon-gallery-worker/src/facebook-review.js`) runs inside `importPhoto`,
the single entry point for every import path. It also runs earlier in the webhook and discovery
paths, so no project is created for photos that are all excluded. The gate always runs **before**
the D1 claim: an excluded photo leaves no row and no R2 object behind, so it can be imported later.

| Decision | Historical import paths | Live webhook (new content) |
|---|---|---|
| **Import** | imported | imported |
| **Duplicate / Skip** | never | never |
| **Review later** | never | never |
| none (unreviewed) | **excluded** | **imported automatically** (unchanged behaviour) |

Which column applies is decided from **what happened**, never from a date (`webhookReviewMode`):

- **Historical (needs an Import decision):**
  - *Import history* (complete discovery) and the legacy post backfill.
  - A webhook **`edited`** event for a post the website has never seen. That is an old post being edited, which previously imported its photos with no review.
  - A photo edit that carries no post id.
- **Live (imports automatically unless marked Skip or Later):**
  - A webhook **`add`** event: a new post, or a photo newly added to any album.
  - An **`edited`** event for a post the website already knows, either imported earlier (`facebook_posts`) or announced by an `add` event in the inbox. That covers photos added to a recent post, and an edit delivered alongside its post's `add`.
  - Scheduled reconciliation, which already only considers uploads after its own first run.
  - Admin retries of photos that were already claimed.
- **Fail-closed defaults:** `importPhoto`, `ingestPost` and the discovery batch treat a missing mode as historical. If migration 017 isn't applied, historical paths exclude everything and live imports continue.
- **Idempotent:**
  - Photo IDs are unique; claims, leases and webhook dedupe are unchanged.
  - Replays and simultaneous history and webhook runs import each approved photo exactly once.
  - Photos approved later are picked up by the next run.
- **Existing content:** already-imported photos are reported as `existing` and never touched. That includes the eight Ganz Garage photos.
- **Preview:** the dry-run preview mirrors the gate (`excluded`, with reason `review-unreviewed`, `review-later` or `review-skip`), so its counts are the real import counts.

## Security review

| Area | Control |
|---|---|
| Admin authentication | Every endpoint is under `/api/gallery-api/facebook/admin/review-*`, behind `requireAdmin` in `index.js`. The admin cookie is HMAC-signed and `SameSite=Strict`. The integration switch 404s everything. Decisions also require `Content-Type: application/json`, so no cross-site form posts. The page itself is server-side admin-gated. |
| Token protection | The Page token stays in the Worker and goes to Graph in an `Authorization` header, never in a URL. Graph error text is redacted, and admin failures return a generic message. The browser receives only photo IDs and proxied image bytes; tests assert no token, `access_token` or fbcdn URL reaches any response. |
| Image proxy access | Facebook previews are proxied only for **Page-owned** photos. The CDN must be on the Facebook allow-list, no redirects are followed, the type must be JPEG, PNG or WebP, and size is capped at 8 MB. Website images are served only from `Projects/`, `New Construction/`, `Remodels/` and `Furniture/`. Reviews, Facebook, Highlights and Apparel are refused, as are traversal, double slashes, control characters and non-image keys. |
| Rate limiting | New `REVIEW_LIMITER` binding: 300 requests per minute per endpoint (`review-image`, `review-site-image`), checked **before** any Graph call or R2 read, returning 429 with `Retry-After`. The page backs off and retries. Facebook previews are cached in the Worker for 24 h, so repeat views make no Graph calls. That protects the Page token's Graph quota, which live webhook imports share. |
| Public exposure | Proxied images are `Cache-Control: private` with `nosniff`, so they are never stored by the shared Cloudflare cache. The Worker's own preview cache uses an internal key (`review-cache.internal`) that no public route can reach, and it is only read after admin auth. Image responses carry no CORS headers; JSON responses allow only `https://kilcon.work` (and the existing dev origin). Nothing here writes to R2 or changes photo visibility. The page's JS bundle contains no secrets. |
| Page code | The page builds DOM nodes only; there is no HTML string injection, and IDs are URI-encoded and CSS-escaped. |

**Residual items (pre-existing, not changed here):**

- `photo-file` serves a project's private masters, hidden ones included, to admins. The review page uses it only to compare against Facebook projects such as Ganz Garage.
- `http://localhost:4321` is an allowed credentialed CORS origin for development.

## Endpoints

| Endpoint | Purpose |
|---|---|
| `GET review-albums` | Page albums (kind, count, suggestions, mapping, decision and import counts), plus gallery targets |
| `GET review-album?id=&after=` | 50 photos per page, with decision and import state; verifies album and photo ownership |
| `GET review-image?id=` | Small Facebook rendition (≥ 320 px), proxied; cached in the Worker; rate limited |
| `GET review-site-gallery?prefix=` / `?all=1` / `?project=` | Manual gallery keys, or a Facebook project's photo IDs |
| `GET review-site-image?key=` | Website image resized to 400 px (Images binding, falls back to the original); rate limited |
| `POST review-decisions` | Up to 100 `{photoId, albumId, decision: import\|skip\|later\|clear, duplicateOf?, note?}`; the whole batch is validated before writing |
| `GET review-summary` | Counts per decision and "approved, not yet imported" |

## Tests (local, final)

- **Worker: 163/163.** `test/facebook-review.test.mjs` has 18 tests:
  - history gating, idempotent re-runs and later approvals;
  - concurrent history runs;
  - an edit of an unknown post, with exact replays;
  - new-post auto-import, with skip and later still blocking, and replays;
  - edits of known posts, including an edit and its `add` in one delivery;
  - a photo added to an old album;
  - **the eight already-imported photos unchanged** across history runs, edits and replays (rows, objects and projects compared);
  - **a simultaneous history import with webhook replays**;
  - gate and mode rules, including the missing migration and an invalid post id;
  - authentication and the integration switch;
  - all endpoints: SSRF, ownership, traversal, content type, batch validation, token leakage;
  - the Worker cache (no Graph call on a hit, internal key, behind auth) and the rate limit (429 before any Graph or R2 access).

  The existing history tests approve their photos first; the existing webhook tests are otherwise unchanged.
- **Mutation checks:**
  - Disabling the gate fails 5 tests.
  - Forcing the webhook mode to always "live" fails 2.
  - Forcing it to always "historical" fails 5.
- **Site: 58/58,** including `photo-hash.test.mjs` (5) and `facebook-review-page.test.mjs` (9).
- **Other checks:**
  - `tsc --noEmit` reports 0 errors, and `astro build` passes.
  - `wrangler deploy --dry-run` reports 199 KiB (48 KiB gzip), with bindings `IMAGES` and `REVIEW_LIMITER` (300/60s).
- **Not verifiable locally:** the interactive page against real Facebook data. The Page token exists only in production, and no browser was connected. It is checked in step 7 of the deployment.

## D1 migration and deployment sequence (needs approval)

Run from `workers/kilcon-gallery-worker` with `CLOUDFLARE_ACCOUNT_ID=8481dbc471ac3a4aa14cc26ea366f956`.

0. **Preflight.**
   - `git fetch`: `main` is still `25687ff`, or only docs/README commits have been added since.
   - Re-run both suites.
   - Record the production Worker version (`1494935c…`) and Pages deployment (`bd120cd6…`).
   - Record a D1 Time Travel bookmark: `npx wrangler d1 time-travel info kilcon-db`.
1. **Migration 017.**
   - Run `npx wrangler d1 migrations list kilcon-db --remote`. It must list **only** `017_facebook_photo_reviews.sql`; otherwise stop.
   - Run `npx wrangler d1 migrations apply kilcon-db --remote`. It is additive: one new table and one index. No existing table is changed.
   - Verify: `SELECT name FROM sqlite_master WHERE name='facebook_photo_reviews'`, and that the 8 `facebook_photos` rows are unchanged.
2. **Worker upload** (no traffic yet): `npx wrangler versions upload --tag <branch head> --message "Photo review + per-photo import gate"`. This confirms the account accepts the `REVIEW_LIMITER` binding (namespace `1003`).
3. **Worker deploy:** `npx wrangler versions deploy <new-version-id>@100% -y`.
   - **Do not run** `wrangler deploy` or `wrangler triggers deploy`. That keeps the dashboard-created `images.kilcon.work/Facebook/*` route on Fail closed, and the cron unchanged.
4. **Verify the Worker:**
   - all `review-*` endpoints return 401 without a session;
   - the webhook still answers 403 to a bad verify token and 401 to an unsigned POST;
   - all eight Facebook photos still load through the image gate;
   - the gallery and reviews APIs return 200;
   - a live tail shows no exceptions.
5. **Pages:** fast-forward `main` to the branch and push **without** `[CF-Pages-Skip]`. Pages then builds the review page, the "Review photos" link and the import hint.
6. **Verify Pages:** `/admin/facebook-review` redirects to `/admin` when signed out. The site security headers and the 67-check production verification still pass.
7. **Owner check** (signed in): open the review page and confirm:
   - 31 albums are listed;
   - a project album shows photos and badges;
   - one decision persists after reload, and is then cleared;
   - `/admin/facebook` → *Preview (dry run)* shows unreviewed photos as excluded.
8. **Cleanup:** after verification, `git branch -d task/historical-photo-review`. The branch was never pushed.

## Rollback

| Layer | Action | Notes |
|---|---|---|
| Worker | `npx wrangler rollback 1494935c-6fae-419f-bc87-0b4f66456a93` | Restores the image gate without review endpoints or the review gate; routes are unaffected. |
| Pages | Dashboard → Pages → kilconstruction → Deployments → `bd120cd6` → *Rollback* | Or revert the merge on `main`. |
| D1 | **Leave migration 017 in place.** | The old code never reads `facebook_photo_reviews`. Saved decisions survive and apply again on redeploy. Dropping the table is unnecessary and would lose decisions. |
| Rate limiter | Nothing to undo | The old version simply doesn't bind it. |

After a Worker rollback, the previous behaviour returns:

- an "Import history" run would import every photo regardless of decisions (it remains disabled by `FB_HISTORICAL_IMPORT_ENABLED="false"`);
- a webhook edit of an old post would import its photos again.

**Cost of a full review** (399 Facebook photos, every website gallery):

- About 400 Graph calls and CDN fetches, once; repeats are cached for 24 h in the Worker and 1 h in the browser.
- About 330 website thumbnails (R2 reads plus image transformations, about 330 unique this month).
- About 800 Worker requests.

All of this is within the Free plan.
