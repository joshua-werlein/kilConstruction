# Facebook Page → Website Gallery

The contractor posts project photos to the KIL Construction Facebook Page. The website imports, groups and publishes them on its own; nobody has to approve them or redeploy.

| Part | Where |
|---|---|
| Webhook, import, grouping, admin API | `workers/kilcon-gallery-worker/src/facebook.js` |
| Routing, public gallery merge, review-photo security | `workers/kilcon-gallery-worker/src/index.js` |
| D1 schema | `migrations/013_facebook_sync.sql` |
| Admin page | `src/pages/admin/facebook.astro` + `facebook-script.ts` (linked from the dashboard) |
| Tests | `workers/kilcon-gallery-worker/test/facebook.test.mjs` (`npm run test:gallery-worker`) |

Meta app: **KIL Construction Gallery Sync**. Graph API **v26.0**, the current version (released 2026-07-29).

---

## 1. How automatic publishing works

```text
Contractor posts on Facebook
  │
  ▼  POST https://kilcon.work/api/gallery-api/facebook/webhook   (X-Hub-Signature-256)
Gallery Worker
  1. verify HMAC-SHA256(raw body, FB_APP_SECRET)          bad → 401
  2. keep object=page, field=feed, entry.id = FB_PAGE_ID
  3. INSERT OR IGNORE into D1 facebook_webhook_events     (content-hash dedupe)
  4. 200 EVENT_RECEIVED                                    (Meta never waits on imports)
  │
  ▼  ctx.waitUntil, plus an hourly cron for retries   (only if FB_AUTO_IMPORT="true")
  5. GET /{post-id}: message, date, permalink, attachments → photo ids
  6. GET /{photo-id}: full-size image URL, caption, album
  7. pick or create a project (section 3)
  8. download (fbcdn.net only) → PRIVATE_BUCKET  Facebook/<photoId>.<ext>   (master)
  9. publish copy               → GALLERY_BUCKET  Facebook/<photoId>.<ext>   (public)
  │
  ▼
/api/gallery-api?list=projects and ?project=<slug> include the photo at once.
The Astro pages render on the server through the GALLERY_WORKER binding,
so the photo is live on /projects without a deploy.
```

**Visibility rule:** a public copy exists only when the photo is imported, the photo is not hidden, and its project is not hidden. `reconcilePhoto()` enforces this after every import and every admin change. Hidden content has no public URL at all, because the master copy lives in a bucket with no public access.

**What D1 records**
- `facebook_posts`: post id, message, original publication time, permalink, project, and grouping reason.
- `facebook_photos`: photo id, post id, album, caption, original time, permalink, master and public keys, size, the admin flags (`hidden`, `project_locked`), and status.
- `facebook_projects`: slug, name, category, album, linked manual gallery, and the admin flags (`hidden`, `name_locked`).
- `facebook_sync_state`: last event received, last successful sync, last backfill, and the backfill cursor.

---

## 2. Historical import (backfill)

Admin-only: `POST /api/gallery-api/facebook/backfill`. It runs independently of `FB_AUTO_IMPORT` and uses exactly the same import, grouping and visibility code as the webhook.

| Body field | Default | Meaning |
|---|---|---|
| `dryRun` | `true` | Show what would be imported and how it would be grouped. Writes nothing and downloads nothing. |
| `limit` | 5 (max 10) | Posts per call. |
| `after` | – | An explicit cursor. |
| `resume` | `false` | Continue from the cursor stored in D1. |

The response contains `posts[]` (each with its planned or actual `project`), plus `imported`, `skipped`, `failed[]`, `next` and `complete`.

- **Resumable:** the cursor is stored after every complete batch. If a batch runs out of its outbound-request budget (40 per call, which keeps it under the Workers Free plan limit), it returns `complete:false` with the same cursor. Repeat the call; photos already imported are skipped without any API calls.
- **Non-destructive:**
  - Existing projects are never renamed.
  - Manual R2 galleries are never written to.
  - Existing objects are never overwritten.
  - Admin decisions are never changed.
- **Preserved per photo:** post id, photo id, caption or post message, original publication date, and Facebook permalink.

```js
// Browser console on https://kilcon.work while logged in to /admin
const bf = (body) => fetch("/api/gallery-api/facebook/backfill", {
  method: "POST", credentials: "include",
  headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
}).then((r) => r.json());

await bf({ dryRun: true, limit: 5 });            // preview grouping
await bf({ dryRun: false, limit: 5 });           // import the first batch
await bf({ dryRun: false, limit: 5, resume: true }); // repeat until next === null
```

---

## 3. Project grouping rules

The contractor never has to use hashtags, special captions or another app. Each post is placed by the first rule that applies:

| # | Evidence | Result |
|---|---|---|
| 1 | The post was already grouped (a redelivery, an edit, or photos added later) | Same project |
| 2 | Its photos are in one **named** Facebook album. Default albums such as Timeline Photos and Mobile Uploads don't count. | That album's project, created once |
| 3 | The caption contains the full name of exactly **one** existing project. The name must have at least two words, at least one of them not generic (so "Deck" or "Kitchen Remodel" never match). Existing manual galleries count. | That project. Matching a manual gallery merges the photos into it. |
| 4 | Completed-build evidence: **3 or more photos** and wording such as finished, completed, wrapped up or before & after | A new project named from the caption's first sentence |
| 5 | Anything else | **Recent Project Updates** |

- **Progress posts:** typically land in Recent Project Updates (rule 5), or in the project's album (rule 2) if the contractor uses one.
- **Fixing placement:** an admin can move photos later, and the moves stick.
- **Slugs:** a new project never takes the slug of an existing manual gallery; it gets a numbered suffix such as `lake-house-2`.
- **Where projects appear:** on `/projects` by default. An admin can change the category to new-construction, remodels or furniture.

---

## 4. Admin controls (`/admin/facebook`, uses the existing admin login)

| Action | Effect | Kept during future syncs |
|---|---|---|
| Hide or restore a project | Removes or restores the public copies of all its photos | Yes. Later photos added to a hidden project also stay hidden. |
| Hide or restore photos | Removes or restores each public copy; the master is kept | Yes (`hidden`) |
| Rename a project | Changes the display name. The slug and URL stay the same. | Yes (`name_locked`) |
| Move photos | Reassigns them to another project | Yes (`project_locked`) |
| New project / merge into a manual gallery | Creates a target to move photos into | – |
| Change category | Moves the project to another public listing | Yes |
| Retry failed | Re-queues failed events and re-imports up to 5 failed photos now | – |
| **Delete permanently** (photos) | For removal / data-deletion requests. Deletes the public copy **and** the private master, and clears the caption, permalink, post text and webhook payloads. A content-free tombstone row stays so the photo is never re-imported, and Restore cannot bring it back. | Yes |
| Connection check | Shows which Page the stored token belongs to, whether it matches `FB_PAGE_ID`, and whether the `feed` subscription is active. Secret values are never shown. | – |
| Historical import | Dry-run preview report, then a batched import you can stop and resume | – |
| Status panel | Auto-import on/off, last event received, last successful sync, last backfill, counts, recent failures | – |

Each photo shows a **Facebook** badge, a link to its Facebook permalink, and a private preview. Previews come from `/api/gallery-api/facebook/admin/photo-file`, which requires the admin cookie, so hidden photos can still be checked.

### Removals on Facebook (migration 014)

| Step | Behaviour |
|---|---|
| Trigger | A signed, Page-authored `feed` event with verb `remove` or `hide` and item `status`, `post` or `photo`. Comment, reaction and visitor events are dropped before they are stored. Removal events are processed **even while `FB_AUTO_IMPORT` is off**, because they only ever take content down. |
| Confirm | Graph is asked about the post or photo. It counts as removed only on error **100 / subcode 33** (object does not exist) or a post with `is_published:false` / `is_hidden:true`. Any other error (5xx, rate limit, invalid or expired token, missing permission, unknown field) throws, the event retries up to 5 times, then it is marked `failed` and **nothing is hidden**. |
| Hide | `hidden = 1`, `hidden_reason = 'removed_on_facebook'` (an earlier admin hide keeps `'admin'`), `purge_after = now + FB_REMOVED_RETENTION_DAYS`. The value is 1–30 days, **capped at 30** in code to match `/privacy`. The public copy is deleted at once; the private master is kept. |
| Recover | Only if the post comes back on Facebook (edit or republish event, or backfill). Photos hidden only by the removal are then shown again and the deadline is cleared. **Admin Restore is refused** for photos removed on Facebook (the response reports them as `skipped`), so the site never keeps showing content that is gone from Facebook. |
| Delete | `runRetention` permanently deletes due photos with the tombstone purge: masters, public copies, captions, links, post text and webhook payloads. **Delete permanently** in the admin does the same at once, with no recovery period. |

**When retention runs:** on every hourly cron tick (`17 * * * *`):
- while imports are paused
- while `FB_INTEGRATION_ENABLED="false"` (the kill switch stops all Facebook traffic but not due deletions)
- even with no webhook traffic at all

Each tick handles up to 50 photos, oldest deadline first, which is about 10 R2/D1 operations per photo, well inside Worker limits. The rest continues the next hour. Runs are idempotent: overlapping ticks select the same rows, and deletes are no-ops. A photo that fails (an R2 error, say) doesn't block the others; its row keeps `master_key`, so it is retried next tick. If the tables are missing or D1 errors, the run logs the error and retries next hour.

**Inbox minimisation:** only Page-authored photo, status, post and album changes are stored, and the stored payload has IDs and flags only: `item`, `verb`, `post_id`, `photo_id`, `photo_ids`, `published`, `created_time`, `from.id`. No message text, names or links are stored. Dedupe still hashes the full change. Processed (`done`/`ignored`) rows are deleted after 30 days; Meta retries for at most 36 h.

Manual R2 galleries and reviews are never touched by any of this.

The purge API is `POST /api/gallery-api/facebook/admin/purge` with `{"confirm":"PERMANENTLY DELETE"}` plus one of:
- `photoIds: [...]` (up to 50)
- `postId`
- `projectId`
- `all: true`, which works in batches of 50; repeat it until `remainingFacebookPhotos` is 0

It only touches `Facebook/` keys, so manual galleries and reviews are never affected. `photoIds` takes up to 50 per call; the admin UI splits larger selections into batches. Use `all: true` if the Meta connection is discontinued (Platform Terms §3.d).

---

## 5. Security changes

### Review attachments (fixed vulnerability)

**Before the fix:**
- `GET /api/gallery-api?project=photos` matched the `Reviews/photos/` folder and returned photos from pending and hidden reviews. It was confirmed live on 2026-10-18, returning 2 photos.
- Every review photo was also directly downloadable from `images.kilcon.work`, the public R2 custom domain for the whole `kilcon-gallery` bucket. Image resizing URLs (`/cdn-cgi/image/...`) worked too.

**After the fix:**
- Slug lookup (`?project=<slug>`) only searches the public gallery roots: Highlights, Projects, New Construction, Remodels, Furniture and Apparel.
- `category/slug` only accepts known categories. A resolved prefix is checked against the public roots once more before anything is listed.
- New review photos are stored in **`PRIVATE_BUCKET`** (`kilcon-private`, which has no public access). If that binding is missing, photo uploads are refused rather than falling back to the public bucket.
- Review photos are served only by `GET /api/reviews/photo?id=…`:
  - Approved reviews: public.
  - Pending and hidden reviews: admins only. Everyone else gets 404.
  - The stored key must be inside the review's own folder.
- The public and admin review JSON hand out only that gated URL, never a raw `images.kilcon.work` URL.
- A Worker route `images.kilcon.work/Reviews/*` returns 404.
- Review **records** are private too, and legacy photos and records are migrated with `POST /api/reviews/admin/migrate` (inventory → copy → verify → gated delete). The full security release and its runbook are in [`security-deployment-plan.md`](security-deployment-plan.md).
- Recommended: a Cloudflare WAF rule (step 7 below). It also blocks the `/cdn-cgi/image/` resizing path and doesn't depend on Worker-route behavior on an R2 custom domain.

### Facebook automation

| Concern | Control |
|---|---|
| Forged webhooks | Constant-time HMAC check of the raw body with the App Secret. Missing secret → fails closed (500). Bad signature → 401. Body ≤ 512 KB. |
| Secrets | `FB_APP_SECRET`, `FB_VERIFY_TOKEN` and `FB_PAGE_ACCESS_TOKEN` are Wrangler secrets, never in `[vars]` or the repo. |
| Token exposure | The token is sent in the `Authorization` header with `appsecret_proof`, never in a URL. Error text is redacted (the token, the secret, `EAA…` patterns, `access_token=`) before logging, storing in D1, or returning to the admin. |
| Duplicates | Event content hash (UNIQUE). One row per photo (PRIMARY KEY). One row per post. Unique album and linked-gallery keys on projects. A known photo costs zero API calls. |
| Overlapping jobs | Events and photos are claimed with conditional `UPDATE`s. Project creation relies on unique constraints. Public-copy reconciliation is idempotent. All of this is tested with concurrent workers. |
| Failed downloads | The photo is marked `failed` and the event moves to `retry`. The cron retries up to 5 attempts, and admins can retry. Running out of the request budget doesn't use up an attempt. |
| SSRF | Images download only over HTTPS from `*.fbcdn.net` / `*.facebook.com`, with `redirect: manual`. Only JPEG, PNG and WebP up to 25 MB. |
| Hidden or staged content | Never present in the public bucket (see the visibility rule). |
| Visitor posts on the Page | Ignored unless `from.id` equals `FB_PAGE_ID`. |
| Existing content | Only `Facebook/` keys written by this code are ever written or deleted in the public bucket. Manual galleries, reviews, apparel and orders are untouched. |
| Kill switch | `FB_AUTO_IMPORT="false"`: events are recorded and nothing is imported or published. Remove/hide events are still confirmed with Graph and acted on, because they only take content down. `FB_INTEGRATION_ENABLED="false"` stops all Facebook traffic. |

---

## 6. Cloudflare configuration

All resources are in the **Kil.con.contact** account (`account_id` is set in `wrangler.toml`).

| Kind | Name | Notes |
|---|---|---|
| Secret | `FB_APP_SECRET` | App Dashboard → App settings → Basic → App secret |
| Secret | `FB_VERIFY_TOKEN` | Random string (see below); also entered in Meta |
| Secret | `FB_PAGE_ACCESS_TOKEN` | Long-lived Page token (section 7) |
| Secret | `ADMIN_SECRET`, `TURNSTILE_SECRET` | Existing; unchanged |
| Var | `FB_PAGE_ID` | Numeric Page ID. **Required.** |
| Var | `FB_APP_ID` | Meta App ID (public). Lets the health check pick out this app's subscription. |
| Var | `FB_GRAPH_VERSION` | `v26.0` |
| Var | `FB_INTEGRATION_ENABLED` | Master switch. `"false"` (shipped) → every `/facebook/*` route 404s and galleries never query D1. |
| Var | `FB_AUTO_IMPORT` | `"false"` until you enable it |
| Var | `FB_REMOVED_RETENTION_DAYS` | `"30"`. Recovery period for content removed on Facebook (1–30; the code caps it at the 30 days `/privacy` promises; a test checks this). |
| R2 | `GALLERY_BUCKET` → `kilcon-gallery` | Existing, public through `images.kilcon.work` |
| R2 | `PRIVATE_BUCKET` → `kilcon-private` | Must never get a custom domain or r2.dev access. |
| D1 | `DB` → `kilcon-db` | Existing database. `migrations_dir` points at the repo-root `migrations/`. |
| Cron | `17 * * * *` | Hourly. Never polls Facebook for new posts. Always runs due retention deletes and inbox pruning (D1/R2 only). With `FB_INTEGRATION_ENABLED="true"` it also processes remove/hide events; with both switches `"true"` it also retries failed imports. |
| Route | `images.kilcon.work/Reviews/*` | Blocks direct access to review files. |

Apply the schema from `workers/kilcon-gallery-worker/`:

```sh
npx wrangler d1 migrations list  kilcon-db --remote   # 013 + 014 applied: should report "No migrations to apply"
npx wrangler d1 migrations apply kilcon-db --remote   # applies it and records it in d1_migrations
```

Generate the verify token locally and pipe it straight into the secret, so it is never printed:

```sh
node -e "process.stdout.write(require('crypto').randomBytes(32).toString('base64url'))" > fbvt.tmp
npx wrangler secret put FB_VERIFY_TOKEN < fbvt.tmp
# open fbvt.tmp once to paste the value into Meta (stage L4), then delete it
```

- `wrangler secret put NAME` prompts for the value, so it never lands in shell history.
- It creates a new version of the *currently deployed* code with the secret added; it doesn't upload local code.
- Alternatively, set secrets in the dashboard: Workers & Pages → `kilcon-gallery-worker` → Settings → Variables and Secrets → Add → Type **Secret**.

---

## 7. Meta permissions and access token

Never paste a token or the App Secret into chat, source files or Git. Keep tokens only on Meta's own pages, and send them straight into Cloudflare.

| Permission | Why |
|---|---|
| `pages_show_list` | List the Page in `/me/accounts`. |
| `pages_manage_metadata` | `POST /{page-id}/subscribed_apps` (Page-level webhook registration). |
| `pages_read_engagement` | Read the Page's posts and photos. |
| `pages_read_user_content` | Required by `/{page-id}/posts` and `/feed` per Meta's reference. **Add it to the use case.** |

No publishing (`pages_manage_posts`) or comment permissions are needed.

The token must come from a person with the MANAGE, CREATE_CONTENT or MODERATE task on the Page.

**"No configurations available"**
- Explorer's *Facebook Login for Business* option lists saved FLB configurations, and none exist yet.
- Configurations are optional. Either:
  - (a) choose **Get User Access Token** with permission checkboxes, or
  - (b) create one: App Dashboard → Facebook Login for Business → Configurations → Create configuration → **User access token** → asset: the KIL Construction Page → the four permissions above.

**Getting a never-expiring Page token**
1. Open [Graph API Explorer](https://developers.facebook.com/tools/explorer/).
   - Meta App: *KIL Construction Gallery Sync*.
   - User or Page: **User Token**.
   - Add the four permissions (or pick the configuration).
   - Click **Generate Access Token** and allow access to the KIL Construction Page.
2. Click the ⓘ next to the token → **Open in Access Token Tool**, then **Extend Access Token**. This gives a long-lived user token of about 60 days. Meta's tool performs the exchange, so the App Secret is never used outside Meta.
3. Back in Explorer, paste the long-lived user token into the token field and run `GET me/accounts?fields=id,name,tasks`.
   - Confirm the KIL Construction Page appears and `tasks` includes `MANAGE` or `CREATE_CONTENT`.
   - Note the Page `id`. It is the public value for `FB_PAGE_ID`.
4. In Explorer, set User or Page to **KIL Construction**. Explorer derives the Page token from the long-lived user token.
5. In the [Access Token Debugger](https://developers.facebook.com/tools/debug/accesstoken/), check:
   - Type **Page**
   - Page ID matches
   - Expires **Never**
   - Scopes include the four permissions
   - the Data Access Expires date (record it)
6. Copy the Page token, run `npx wrangler secret put FB_PAGE_ACCESS_TOKEN`, and paste at the hidden prompt. Clear the clipboard and close Explorer.
7. Check `/admin/facebook` → **Check connection**. It should show the Page name and "Working".

**Page token invalidation**
- The token is invalidated by a password change, a lost Page role, or removing the app.
- If data access expires, re-run steps 1–6. The health check shows Graph code 190 when that happens.

**App mode / review**
- **Development mode:** Meta delivers only dashboard test notifications. Production `feed` events need the app in **Live** mode.
- **Going live** needs:
  - app icon (512–1024 px)
  - Privacy Policy URL `https://kilcon.work/privacy`
  - data-deletion instructions URL
  - category
- **Standard Access** covers data of people with a role on the app. The Page admin is an app admin, so App Review and Business Verification should not be needed. Advanced Access needs both, but is required only for other people's Pages.
- Meta does not state this combination outright. Confirm by checking that a real post arrives after going Live (stage L6).
- **Hardening:** App settings → Advanced → **Require App Secret** = Yes. Every Worker call already sends `appsecret_proof`.

---

## 8. Enabling production safely (staged; each stage needs approval)

**Prerequisite:** the review-privacy release ([`security-deployment-plan.md`](security-deployment-plan.md)) must be deployed and verified, including deletion of the legacy public review copies.

| Stage | Action | Verify |
|---|---|---|
| L1 ✅ | `wrangler d1 migrations apply kilcon-db --remote` (013 only). Done 2026-10-18. | 5 `facebook_*` tables exist; reviews, apparel and orders unaffected |
| L1b ✅ | Applied 2026-10-19 (`d1_migrations` id 8). Same command; applies `014_facebook_removal_retention.sql` only (adds 2 nullable columns). **Must come before L2**: the new Worker code reads these columns. | `PRAGMA table_info(facebook_photos)` lists `hidden_reason` and `purge_after`; other tables unchanged |
| L2 | Deploy the Worker with `FB_PAGE_ID`, `FB_APP_ID`, `FB_INTEGRATION_ENABLED="true"`, **`FB_AUTO_IMPORT="false"`**; deploy Pages with `/admin/facebook` | privacy script passes; galleries unchanged; webhook GET with a wrong token → 403 |
| L3 | Set `FB_APP_SECRET`, `FB_VERIFY_TOKEN`, `FB_PAGE_ACCESS_TOKEN` (section 7) | Check connection → Working |
| L4 | Meta → Webhooks → Page: callback `https://kilcon.work/api/gallery-api/facebook/webhook` + verify token → Verify and save → subscribe `feed`. Then **Subscribe Page to feed** on `/admin/facebook` (or `POST {page-id}/subscribed_apps?subscribed_fields=feed` in Explorer) | Meta shows verified; Check connection → Subscribed. A dashboard **Test** event gets 200, but it is ignored: it carries a sample Page ID, not `FB_PAGE_ID`. Real events are confirmed in L6. |
| L5 | `/admin/facebook` → **Preview (dry run)** | report reviewed: posts, date range, photos, duplicates, proposed galleries, Recent fallback, errors |
| L6 | Switch the app to **Live**; confirm a real post is recorded as `pending`. Then (after L5/L7, with approval) set `FB_AUTO_IMPORT="true"` and deploy. The authoritative order is the checklist in [`facebook-launch-resume.md`](facebook-launch-resume.md). | a real Page post appears on kilcon.work within about a minute |
| L7 | `/admin/facebook` → **Import history** | counts match the preview; spot-check galleries |

**To pause imports:** set `FB_AUTO_IMPORT = "false"` and redeploy. Events keep being recorded and are processed once you turn it back on. To turn everything off, set `FB_INTEGRATION_ENABLED = "false"`.

## 9. Recovery and troubleshooting

| Symptom | Check / fix |
|---|---|
| Meta "callback could not be verified" | `FB_VERIFY_TOKEN` mismatch, or the secret isn't set (the Worker returns 500). |
| Webhook POSTs 401 in the logs | `FB_APP_SECRET` is wrong or was rotated in Meta. Update the secret; Meta retries for up to 36 h. |
| Events stay `pending` | `FB_AUTO_IMPORT` isn't `"true"`, or the cron isn't deployed. |
| Test events arrive but real posts don't | App still in Development mode, Page not subscribed (Check connection), or `pages_read_user_content` missing. |
| Caption edited on Facebook | The edit event updates the stored caption; photos with their own caption keep it. |
| Events `retry` / `failed` | Error text is on `/admin/facebook`. Graph code 190 means the token is invalid: generate a new one (section 7). |
| Photo on Facebook but not on the site | It may be in Recent Project Updates, hidden by an admin, or a visitor post. Check `facebook_photos` (below). |
| Hidden photo still loads | Browsers may cache the public copy for up to 1 h (`max-age=3600`). The object itself is deleted at once. |
| Big albums import slowly | Each run makes at most 40 outbound requests; the hourly cron (or the next event) continues. |

```sql
-- npx wrangler d1 execute kilcon-db --remote --command "<query>"
SELECT status, COUNT(*) FROM facebook_webhook_events GROUP BY status;
SELECT id, attempts, last_error FROM facebook_webhook_events WHERE status IN ('retry','failed') ORDER BY id DESC LIMIT 20;
SELECT fb_photo_id, status, hidden, project_id, public_key IS NOT NULL AS public, last_error FROM facebook_photos ORDER BY updated_at DESC LIMIT 20;
SELECT id, slug, name, hidden, grouping_reason, linked_prefix FROM facebook_projects;
SELECT * FROM facebook_sync_state;
-- re-queue one failed event
UPDATE facebook_webhook_events SET status = 'retry', attempts = 0 WHERE id = ?;
```

Masters in `kilcon-private` are deleted only by **Delete permanently** or by the retention purge, which runs after a removal on Facebook is confirmed and the recovery period passes. Hiding never deletes them. Restoring a photo hidden by an admin republishes it from the master copy. Restore is refused for photos removed on Facebook; they come back only if the post returns on Facebook.
