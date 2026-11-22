# Historical Facebook photo review

Status: **deployed 2026-11-21; comparison UI and targeted import added 2026-11-22.**

| Component | Version |
|---|---|
| Migration 017 | Applied (D1 restore bookmark from before it: `0000069f-00000000-0000512a-70c3e47bc9e5d69d289848bace0ac932`) |
| Worker | `8c893925` (tag `d8ff7a9`, targeted import; historical import off). Before it: `18177ff4` (`780127e`) |
| Pages | `02aaaf2a` (`9aa5b0a`, side-by-side comparison cards). Rollback: `dccbe970` (`47dc2e7`) |

- **2026-11-21:** production checks 67/67; signed-out access refused; the hourly cron was verified; 31 albums listed.
- **2026-11-22, comparison UI:** deployed with 94/94 production checks. The owner tested the page and saved 7 Import decisions for Ganz Garage, after checking duplicates by eye.
- **2026-11-22, first historical import:** the 7 Ganz Garage photos were imported (see [Targeted import](#targeted-import-one-album-explicit-photo-ids)).

See docs/RESUME.md. The sections below describe the design as built.

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

## Targeted import (one album, explicit photo IDs)

The full historical import scans every album, and its button stays disabled until every album
has a destination. To import one reviewed album without touching the others, the admin-only
backfill endpoint has a targeted mode (`d8ff7a9`):

```
POST /api/gallery-api/facebook/backfill
{ "targeted": true, "dryRun": true|false, "albumId": "<album>", "projectId": <existing project>,
  "photoIds": ["…", …], "expectedCount": <n, required for a real run> }
```

**Checks, done before anything is written.** A real run refuses the whole batch if any check
fails:
- **Destination:** an existing, visible project already linked to the album, through
  `fb_album_id` or an album mapping.
- **Each photo:**
  - has an **Import** decision recorded for that same album;
  - Graph confirms the album and that the Page owns the photo;
  - its largest image is on a Facebook CDN host;
  - 1–10 unique IDs per request.
- **Count:** `expectedCount` must equal the number of new photos.

**Duplicates.** Photos already on the site are reported as `existing` before any Graph call
or download. The usual claim step stops two runs from importing the same photo twice.

**Writes.** A run writes only:
- the `facebook_photos` rows for new photos;
- their R2 objects (private master, plus a public copy while public copies are still written);
- `last_backfill_at` and `last_success_at`.

It never touches album mappings, projects, posts, review decisions, discovery jobs or the
backfill cursor. Webhook auto-import is unchanged.

**Dry run.** It works with historical import off. It looks up only the requested photos,
downloads nothing and writes nothing.

**Tests.** 5 tests in `test/facebook-review.test.mjs`. One is a mutation check that proved the
album checks are enforced.

### Import Approved Photos on the review page (local, branch `task/review-import-workflow`, not deployed)

The owner's whole workflow: review photos, mark **Import**, click **Import Approved Photos**,
confirm. No console commands, and no global switch is turned on and off.

**On the page**, in each album's *Import approved photos* panel:
1. **Plan** (`GET import-plan?albumId=`, D1 only). It shows:
   - how many approved photos are not yet imported, and how many already are;
   - the destination.
2. **Destination:**
   - **Linked album:** the destination is fixed.
   - **Unlinked album:** choose a gallery. If the album holds several projects, tick the box and
     the batch goes only to that gallery, with no link written (Ganz).
   - **Unsorted albums** (Mobile uploads) are always handled that way.
3. **Check** (dry run), in batches of 10. It reports the new photos, those already imported, those
   that can't be imported (with reasons), and those the page's fingerprints flag as likely
   duplicates of website photos. It writes nothing; it never links an album.
4. **Confirmation dialog:** "Import n approved photos into ⟨gallery⟩ and publish them?" It lists
   each photo and warns about likely duplicates. **Cancel** changes nothing.
5. **Import:** if the album should be linked, `album-link` runs first. Then the same batches go
   through `POST import-run`, with `confirm` and the exact `expectedCount` each time.
   - Progress is shown per batch.
   - A refused batch stops the run (for example, the count changed since the check).
   - Partial failures (207) carry on. They are listed, and the photos can be imported again.
6. **Refresh:** the album reloads, so imported photos move to *Already on the website*.

The button stays disabled while decisions are unsaved, and while the server switch is off (the
check still works).

**On the Worker**, `POST /facebook/admin/import-run` refuses in each of these cases:

| Case | Response |
|---|---|
| No admin cookie (route-level `requireAdmin`) | 401 |
| `FB_INTEGRATION_ENABLED` not `"true"` | 404 |
| The body isn't JSON | 415, so a form post (CSRF) can't trigger it |
| A real run while `FB_REVIEWED_IMPORT_ENABLED` isn't `"true"` | 403 (this is the scoped switch) |
| A real run without `confirm: "IMPORT APPROVED"` | 400 |
| Rate limit exceeded (`REVIEW_LIMITER`, separate keys for checks and real runs) | 429 |
| A real run with the limiter binding missing | 503 (fails closed) |
| More than 10 IDs, or no `expectedCount` | 400 |
| Any photo fails a `runTargetedImport` check, or the count changed | 409; nothing is written |

`runTargetedImport` checks each photo for an Import decision for this album, confirms the album
and Page with Graph, refuses branding photos and photos already imported, and enforces the
destination and link rules.

It takes explicit photo IDs only, and never lists albums or posts, so it can't start a
historical scan. `FB_HISTORICAL_IMPORT_ENABLED` stays `"false"`.

**Tests:**
- **Worker:** 7 new tests against real local D1/R2. They cover:
  - the plan;
  - an import with global historical import off;
  - auth, the switch, the confirmation, JSON-only, rate limit and kill switch;
  - batch limits;
  - unapproved, wrong-album, linked-as-mixed and count-changed refusals;
  - two overlapping runs importing each photo once;
  - a partial failure, then a retry;
  - mixed albums;
  - that webhook auto-import is unaffected.

  Mutation checks prove the confirmation and switch checks are enforced.
- **Site:** 6 new tests (`tests/review-import.test.mjs`).
- **Browser harness** (mocked API): the linked, unlinked multi-batch with a failure, and mixed
  album flows all behaved as designed, as did cancel and unsaved decisions. There's no overflow
  at 360 px.
- **Totals:** site 86/86, Worker 183/183.

**To deploy (needs approval):**
1. Commit and merge.
2. **Pages:** a push without `[CF-Pages-Skip]`.
3. **Worker:** `versions upload`, then a bindings diff, then `versions deploy`. The scoped switch
   ships `"false"`.
4. **Owner check:** the Ripley dry run on the page.
5. **Turn the scoped switch on permanently**, with separate approval: a version with
   `--var FB_REVIEWED_IMPORT_ENABLED:true`, plus the same change committed to `wrangler.toml`.
6. **The owner imports Ripley** with the button.

**Rollback:** set the scoped switch back to `"false"`, or redeploy the previous versions.

### Importing into existing website galleries (local, branch `task/import-manual-galleries`, not deployed)

**The problem.** The destination dropdown listed only Facebook galleries (D1 projects). A manual
R2 gallery, such as Furniture/Cutting Boards, could only be chosen after someone linked it on
`/admin/facebook`.

**The fix:**
- **`import-plan` lists every eligible website gallery**, grouped by category (Projects, New
  Construction, Remodels, Furniture). It comes from the R2 folders, plus the visible Facebook
  galleries.
  - Highlights and Apparel are never offered, and hidden galleries are left out.
  - A website gallery that's already linked appears once, by its record (`project:<id>`).
  - An unlinked one appears as `manual:<folder>`.
- **The check** (`import-run`, dry run) can name an unlinked website gallery by `linkedPrefix`.
  - It runs every per-photo check and creates nothing.
  - The folder must be one of the listed website galleries.
  - A real run by folder is refused (409) until the link exists.
- **Confirm** first creates or reuses the link with the existing `project-create { name,
  linkedPrefix }`. That reuses an existing link and never makes a second one. Then it links the
  album (unless the album holds several projects), then imports by record.
  - The linked record takes the folder's category.
  - Its photos appear **inside the existing website gallery**. No duplicate images, and no
    second public gallery.
- **Unchanged:** album mappings, existing gallery categories, duplicate protection, review
  decisions and mixed-album behaviour.
- **Internal only:** the preview destination used for the check is an internal parameter, so the
  historical backfill route can't be given one in a request body.

**Tests:**
- **Worker, 4 new:**
  - the grouped list: manual galleries included, Highlights, Apparel and hidden galleries left out,
    linked galleries listed once;
  - a check-then-import straight into Furniture/Cutting Boards: link reused, 1 manual + 2
    imported photos in that gallery, still one gallery card, Duplicate / Skip photo left out;
  - a mixed album into a website gallery, with no mapping;
  - folder validation, and the preview can't be injected.
- **Site, 2 new:** the grouping and destination fields; on confirm the order is link record, then
  album link, then import, and the check never writes.
- **Browser harness:** the grouped dropdown and the full flow behaved as described.
- **Totals:** site 88/88, Worker 187/187.

### Mixed albums (deployed in `2d8f323`)

Some albums hold several projects. Mobile uploads is one; the "Ganz" album holds 3D Autobody
and Ganz Re-Deck.

- **How it works.** With `mixedAlbum: true`, each batch names its own destination gallery. No
  album mapping is written, so later photos in that album aren't affected. Each imported photo
  is set `project_locked`, so sync never moves it.
- **Refusals:**
  - an album already linked to a gallery is refused in mixed mode; import it normally;
  - without `mixedAlbum`, an unlinked album is refused;
  - branding-album photos are refused in both modes.
- **Unchanged:** all other checks (an Import decision, the album and owner confirmed by Graph,
  and `expectedCount`).

**Tests:** 2 more, plus a mutation check. Worker 176/176.

### Linking an album first: `POST /facebook/admin/album-link` (deployed `bd707ef`)

`{ albumId, projectId }` links one album to one existing gallery without importing anything,
by writing one locked mapping row. Use it for a gallery created by hand or linked to a manual
folder. It refuses:
- branding and unsorted albums;
- Recent Project Updates;
- albums the Page doesn't own;
- albums already linked elsewhere.

### Procedure (used 2026-11-22 for Ganz Garage)

1. **Dry run:** signed in, from the browser console. It must show `new = n`, `existing 0` and
   `refused 0`.
2. **Turn the import on:** `wrangler versions upload --var FB_HISTORICAL_IMPORT_ENABLED:true`,
   then `versions deploy <id>@100%`.
3. **Real run:** use `expectedCount: n`.
4. **Turn it off at once:** `versions deploy <flag-off version>@100%`.
5. **Verify:** compare a per-table D1 snapshot with the baseline. Check the gallery count, that
   every image loads, and the production checks.

Never use `wrangler deploy` for this Worker. The flag in `wrangler.toml` stays `"false"`.

### 2026-11-22 run: Ganz Garage

- **Album and destination:** `122234637104318503` into project 1, Ganz Garage.
- **Photos:**
  - `122234637260318503`
  - `122234637308318503`
  - `122234637350318503`
  - `122234637404318503`
  - `122234637452318503`
  - `122234637494318503`
  - `122234637542318503`
- **Dry run:** 7 new / 0 existing / 0 refused, and D1 was unchanged afterwards.
- **Import window:** version `64c8142e` was live from 15:49:09 to 15:51:36 UTC. The run returned
  `imported: 7` with no failures.
- **Result:** Ganz Garage went from 8 to 15 photos, and all 30 image URLs (full size and
  thumbnail) load.
  - **Changed:** only `facebook_photos` (+7) and the two sync timestamps.
  - **Unchanged:** projects, mappings, posts, decisions, jobs, albums, events, and the original
    8 rows (byte-identical).
  - **Checks:** 122/122 production checks passed.
- **Restore bookmark** from before the import:
  `000006d6-00000000-0000512b-2269b9f882efa19e8fc0885a612689b6`.

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

### Create New Gallery and automatic holds (local, branch `task/facebook-integration-final`, not deployed)

**Create New Gallery** sits inside the *Import approved photos* panel. Enter a name, choose
Projects, New Construction, Remodels or Furniture, then click **Check name**.

`POST /facebook/admin/gallery-create` (admin, JSON body only) checks every Facebook and website
gallery first:
- **An exact name match** (ignoring case and spacing) is refused (409), and the page selects that
  gallery instead.
- **A similar name** is refused unless `allowSimilar: true`. The page offers "Create anyway".
- **A real create** needs a browser confirmation and `confirm: "CREATE GALLERY"`.
- **The new gallery** is empty, so it stays off the website until photos are imported. It becomes
  a destination at once.

**Automatic holds.** New posts whose project is ambiguous are held: see docs/facebook-webhook.md
§3. A held photo gets a **Review later** decision with a "Held automatically: …" note, and that
note is shown on its card. The panel prefills a suggested name when one was noted. A held photo
is never imported until the owner marks it Import. An existing owner decision is never
overwritten.

**Tests** (Worker, real local D1/R2):
- **new posts and albums:** distinctive, exact-name, linked and existing albums;
- **holds:** a similar album, a generic album, a caption naming several galleries, and a
  finished-job post with no album;
- **retries and edits:** duplicate deliveries and edits never import or duplicate, and the
  owner's decision wins;
- **importing held photos:** a held photo is approved, then imported through a new gallery;
- **Create New Gallery:** exact, website-gallery and similar matches, validation, auth, form
  posts, confirmation and no duplicate;
- **discovery and history:** scheduled discovery holds too, and historical scans write nothing.

The site tests cover the form's wiring.
