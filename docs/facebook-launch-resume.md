# Facebook gallery automation: launch and resume checklist

Last updated 2026-10-19 (contractor confirmations recorded; predeployment checks re-run). Pick up at the first ⬜ in **Deployment sequence**.

The full runbook is [`facebook-webhook.md`](facebook-webhook.md). The security release is in [`security-deployment-plan.md`](security-deployment-plan.md).

No credentials appear here. Never paste tokens or secrets into chat, docs, or Git.

## Confirmed identifiers (public, not secrets)

| | Value | Where it is set |
|---|---|---|
| Meta app | KIL Construction Gallery Sync | |
| App ID | `1427044999395408` | `FB_APP_ID` in `workers/kilcon-gallery-worker/wrangler.toml` (local). A test checks the exact value. |
| Page ID | `305397115992497` | `FB_PAGE_ID` (local). A test checks the exact value. |
| Webhook callback | `https://kilcon.work/api/gallery-api/facebook/webhook` | Covered by the existing Worker route `kilcon.work/api/gallery-api*` |
| Legal URLs | `https://kilcon.work/privacy`, `/data-deletion`, `/terms` | `/data-deletion` is not deployed yet |

## Completed ✅

| Area | State |
|---|---|
| Security release | Deployed and verified. Review data is private, the legacy public copies are deleted, `r2.dev` is off, and the WAF rule is active. |
| D1 013 + 014 | 013 applied (id 7). 014 applied 2026-10-19 00:58 UTC (id 8) after a 7/7 preflight; restore point taken just before: `0000009a-00000000-00005109-c9ee6211f5f1162bc4fb9402d6594220`. Verify 6/6. The `facebook_*` tables are empty. |
| Meta tokens | Facebook Login for Business configuration created. Page token: Type Page, Valid, Expires Never. Permissions confirmed. Real posts and multi-photo posts were read. |
| Cloudflare secrets | `FB_APP_SECRET`, `FB_VERIFY_TOKEN` and `FB_PAGE_ACCESS_TOKEN` are set (names checked only). |
| Local code | Removal/retention policy, permanent delete, inbox minimisation, legal pages, and type fixes. Re-run 2026-10-19: 71 Worker tests and 9 site tests pass; tsc reports 0 errors; the build and dry run succeed. |
| Contractor confirmation | All seven business-practice items confirmed by the owner 2026-10-19 (below). |

## Current production state

- **Live Worker:** `ed738015` (security-release code). Facebook is off (`FB_INTEGRATION_ENABLED="false"`, empty Page ID), so nothing imports.
- **Website:** the old `/privacy` and `/terms` are live. `/data-deletion` and `/admin/facebook` return 404.
- **D1:** 013 and 014 applied; nothing pending.
- **Meta:** the app is unpublished, no webhook is configured, and the Page is not subscribed.
- **Git:** `662dedd`. Everything since is uncommitted (list at the end).

Re-verified read-only on 2026-10-19:
- Wrangler is on the **Kil.con.contact** account (`8481dbc4…`).
- Live version `ed738015` has `FB_INTEGRATION_ENABLED "false"` and `FB_PAGE_ID ""`.
- All three `FB_*` secrets exist (names only).
- D1 reports no pending migrations: 013 is id 7 and 014 is id 8. There are 5 `facebook_*` tables, `facebook_photos` has 25 columns, and `idx_facebook_photos_purge_after` exists.
- Row counts match the 014 baseline: apparel items 5, variants 35, orders 10, order items 8, Stripe events 11, webhook audit 2, Facebook 0.
- The privacy script passed 37, failed 0 and skipped 2. The skips need `PHOTO_KEY` and `PENDING_ID`.
- `/data-deletion` and `/admin/facebook` return 404, as expected.
- The repo has no CI. A push to `main` only builds the Pages site, and the Worker deploys only through `wrangler deploy`.

## Legal pages

✅ The site owner approved the three drafts, the 30-day recovery period and the two Terms additions (2026-10-18). ✅ The contractor confirmed the business-practice claims below (2026-10-19), so the pages are cleared to publish. The final revision date is October 18, 2026; bump `LAST_UPDATED` (a test keeps the three pages in sync) if the text changes again. No response-time promise was added, by decision.

The privacy text says the galleries "may include" Facebook photos, so it is accurate **before** activation and can be published at step 5.

### Contractor confirmations (business practices the website code can't prove)

✅ **All seven were confirmed by the business owner on 2026-10-19.** These are **owner-confirmed business practices, not code-verified facts.** They depend on how the business operates offline. Re-confirm them if the practices, ownership or contact details change. The legal wording was rechecked against them and needed no change.

The code was checked: there are no trackers, analytics, ad pixels or marketing-list integrations. The only outbound services are Stripe, Resend, Turnstile, the Graph API (Page token and IDs only) and links to facebook.com. The website therefore sells and shares nothing. The contractor must confirm the offline practices:

1. ✅ KIL Construction does not sell or rent customer information (contact details, order details, reviews) to anyone, and shares it only with the listed providers.
2. ✅ Reviews are used in marketing only when the reviewer ticked "You may use my review in marketing materials".
3. ✅ Contact emails are deleted from the inbox when no longer needed and on request.
4. ✅ Order records are kept only as needed for fulfillment, accounting, or legal obligations.
5. ✅ Someone checks the inbox for deletion requests and handles them (verify the sender, delete, reply).
6. ✅ KIL Construction has the rights and any needed permissions to display its Facebook Page project photos on the website.
7. ✅ Business identity "KIL Construction", governing law Wisconsin, and contact `kil.con.contact@gmail.com` are correct.

## Deployment sequence (each ⬜ is an approval checkpoint)

| # | Step | Verify |
|---|---|---|
| 1 | ✅ **Approve the legal pages**: the owner approved them 2026-10-18, and the contractor confirmed the business practices 2026-10-19 | |
| 2 | ⬜ **Prepare Meta App Settings → Basic**: icon (no Meta logos, no "Facebook" or "FB"), category, contact email, App Domain `kilcon.work`. **Enter the three URLs only after step 5**, because Meta may fetch them. | Fields filled; nothing published |
| 3 | ✅ **Applied D1 migration 014** on 2026-10-19 00:58 UTC (`d1_migrations` id 8). Preflight 7/7, verify 6/6. | Done: 25 columns, index present, all row counts unchanged |
| 4 | ⬜ **Commit** to `main` (one release commit; see the plan below) | `git status` clean of these files |
| 5 | ⬜ **Deploy the website**: push to `main`. Cloudflare Pages deploys it automatically (confirmed: no CI, and the Worker is unaffected). This ships the legal pages, the footer link and `/admin/facebook`. Until step 6, `/admin/facebook` loads but its API calls 404. | `/privacy`, `/terms`, `/data-deletion` return 200; footer links; then enter the URLs in Meta (step 2) |
| 6 | ⬜ **Deploy the webhook-enabled Worker**: `npx wrangler deploy` from `workers/kilcon-gallery-worker`, with `FB_AUTO_IMPORT="false"` | Dry run first shows both IDs, `FB_INTEGRATION_ENABLED "true"`, `FB_AUTO_IMPORT "false"`, `FB_REMOVED_RETENTION_DAYS "30"`. The deploy output must list the `17 * * * *` schedule: **the live Worker has no cron today** (the security release shipped with it commented out). |
| 7 | ⬜ **Verify security and site** | Privacy script passes (webhook wrong token → 403, unsigned POST → 401). All 220 gallery images 200. Reviews, apparel and contact OK. `/admin/facebook` → Check connection: "Working", KIL Construction |
| 8 | ⬜ **Configure and verify the Meta Page webhook**: Webhooks → Page → callback URL + verify token → Verify and save | Meta shows verified |
| 9 | ⬜ **Subscribe to `feed`**: turn on the field, then `/admin/facebook` → Subscribe Page to feed | Check connection: "Subscribed" |
| 9a | ⬜ **Publish the Meta app** (Publish → Go live; complete any Data Use Checkup). Standard Access only. **Needed for step 10:** Development mode delivers only dashboard test events. | App shows Live |
| 10 | ⬜ **Confirm real webhook delivery**: publish a real Page post | "Last event received" updates; the event waits as `pending` because imports are off |
| 11 | ⬜ **Historical import dry run**: `/admin/facebook` → Preview | Review posts, date range, photos, duplicates, proposed galleries, Recent fallback, errors |
| 12 | ⬜ **Approve and run the historical import** (Import history; resumable) | Counts match the preview; spot-check galleries |
| 13 | ⬜ **Enable automatic imports**: `FB_AUTO_IMPORT="true"`, deploy | Pending events (including the step 10 post) are processed |
| 14 | ⬜ **Verify a real post appears on kilcon.work** without a rebuild. Then optionally delete or unpublish a test post and check it leaves the site and shows "Removed on Facebook — deletes …" in the admin. | **Only now is the integration operational.** |

Dependencies that differ from a plain list:
- **3 before 6:** the new Worker reads the 014 columns.
- **5 before entering the URLs in step 2:** Meta should see live pages.
- **9a before 10:** real events need Live mode.
- **12 before 13 is safe:** removals are processed while imports are paused, so history imported at step 12 is still taken down if its post is deleted.

### Migration 014 procedure (step 3)

Run from `workers/kilcon-gallery-worker`. The check script is read-only.

```sh
bash scripts/migration-014-check.sh preflight   # 7 gates must PASS; records the row-count baseline and prints the restore point
npx wrangler d1 migrations apply kilcon-db --remote   # APPROVAL REQUIRED; applies 014 only, recorded as d1_migrations id 8
bash scripts/migration-014-check.sh verify      # 014 recorded, nothing pending, 25 columns, index exists, all row counts unchanged
```

**Preflight gates:**
- the right Cloudflare account
- 013 is the last applied migration, and 014 is the only pending one
- `facebook_photos` has the 23 columns from 013, and neither new column exists
- the new index doesn't exist
- the baseline row counts are captured

The last preflight run (2026-10-18, read-only) passed 7/7. The baseline was apparel items 5, variants 35, orders 10, order items 8, Stripe events 11, webhook audit 2, and all Facebook tables 0. The restore point was `00000099-00000000-00005109-9e2b1cefecc6b1dcc9e0b9eca53b4e6c`. Re-run the preflight right before applying.

**Why it's safe:**
- 014 only adds two nullable columns and one index.
- Its `UPDATE` touches 0 rows, because the Facebook tables are empty.
- The live Worker (`ed738015`) never names the new columns, so the site is unaffected between steps 3 and 6.

**If the verify fails:** stop, and do not deploy the Worker. Do **not** restore the whole database without separate approval, because it could erase unrelated production changes such as orders. A targeted fix (for example, dropping the new index) is preferred.

## Required Cloudflare configuration (`kilcon-gallery-worker`)

| Kind | Name | Value / state |
|---|---|---|
| Var | `FB_INTEGRATION_ENABLED` | `"true"` (local) |
| Var | `FB_AUTO_IMPORT` | `"false"` until step 13 |
| Var | `FB_PAGE_ID` / `FB_APP_ID` | as above (local) |
| Var | `FB_GRAPH_VERSION` | `"v26.0"` |
| Var | `FB_REMOVED_RETENTION_DAYS` | `"30"` (code caps it at 30) |
| Secret | `FB_APP_SECRET`, `FB_VERIFY_TOKEN`, `FB_PAGE_ACCESS_TOKEN` | ✅ set |
| Cron | `17 * * * *` | Hourly. Retention deletes and inbox pruning always run (no Facebook calls). Removal events are processed while imports are paused. Import retries run only with `FB_AUTO_IMPORT="true"`. It never polls Facebook for new posts. |
| D1 | `kilcon-db` | 013 ✅, 014 ✅ (no migrations pending) |
| R2 | `kilcon-gallery` (public), `kilcon-private` (private) | ✅ |

## Meta requirements (verified vs assumed)

| Item | Status | Source |
|---|---|---|
| Privacy Policy URL | **Verified mandatory** (Platform Terms §4: must explain the processing and how to request deletion; the drafts do both) | https://developers.facebook.com/terms/dfc_platform_terms/ |
| Data Deletion Instructions URL | **Verified sufficient**: Meta accepts an instructions URL *or* a callback | https://developers.facebook.com/docs/development/create-an-app/app-dashboard/data-deletion-callback/ |
| Terms of Service URL, App icon, Category, Contact email | **Verified: required to switch to Live** per the Basic Settings doc. Icon size isn't stated. | https://developers.facebook.com/docs/development/create-an-app/app-dashboard/basic-settings/ |
| App Domains | Optional | same |
| Business verification, App Review, Advanced Access | **Verified not required** for Standard Access used only by people with an app role | https://developers.facebook.com/docs/development/release/ , https://developers.facebook.com/docs/graph-api/overview/access-levels/ |
| Data Use Checkup | **Unresolved**: Meta's docs contradict each other; complete it if prompted | https://developers.facebook.com/docs/development/maintaining-data-access/data-use-checkup |
| Live webhook delivery for the admin's own Page with Standard Access | **Assumption** (likely, not stated outright). Confirmed only by step 10. | https://developers.facebook.com/docs/graph-api/webhooks |
| Reading `is_hidden` on posts with these permissions | **Assumption.** If unreadable, hide/unpublish events retry then fail **without hiding**; deleted posts are still detected. Step 14 tests it. | https://developers.facebook.com/docs/graph-api/reference/post/ |

## Handling a deletion request

1. Check the request comes from the email address on record. Ask for a reply from that address if needed.
2. **Facebook photo:** `/admin/facebook` → select it → **Delete permanently**. This is immediate (no recovery period). It removes the public copy, the private original, the caption, link, post text and webhook data, and keeps an ID-only tombstone so the photo is never re-imported. Nothing is deleted on Facebook; the Page owner does that on Facebook.
3. **Review:** delete it in the reviews admin. The record and photos are removed from both buckets.
4. **Contact message:** delete it from the inbox. Resend's delivery logs follow Resend's retention.
5. **Order:** there is no admin UI. Remove the contact fields with a D1 update, unless they're needed for accounting or legal reasons. Stripe keeps its own records.
6. Reply to confirm.

**Discontinuing the Meta connection:**
- Run `purge` with `{"all":true,"confirm":"PERMANENTLY DELETE"}` until 0 photos remain.
- Set `FB_INTEGRATION_ENABLED="false"` and deploy.
- Delete the 3 `FB_*` secrets.
- Remove the app from the Page.

## Limitations

- Older history may be unreachable (Graph returns about 600 ranked posts per year).
- The Page token breaks on a password change, a lost Page role, or app removal. Check connection then shows "Rejected by Facebook"; regenerate it per runbook section 7. Removal events retry and then fail without hiding anything while the token is broken. Re-run them with **Retry failed** after fixing it.

## Uncommitted files

- **Worker** (includes the new read-only `scripts/migration-014-check.sh`):
  - `workers/kilcon-gallery-worker/src/facebook.js`, `src/index.js`
  - `test/facebook.test.mjs`
  - `wrangler.toml`
  - `scripts/verify-review-privacy.sh`
- **Migrations:** `migrations/013_facebook_sync.sql` (applied), `migrations/014_facebook_removal_retention.sql` (applied)
- **Admin:** `src/pages/admin/facebook.astro`, `facebook-script.ts`, `dashboard.astro`, `src/styles/admin.css`. Type-only fixes in `manage-script.ts`, `reviews-script.ts`, `upload-script.ts`.
- **Legal:**
  - `src/pages/privacy.astro`
  - `src/pages/data-deletion.astro` (new)
  - `src/pages/terms.astro`
  - `src/layout/MainLayout.astro`
  - `src/pages/sitemap.xml.ts`
  - `tests/legal-pages.test.mjs` (new)
  - `package.json`
- **Docs:** `docs/facebook-webhook.md`, `docs/facebook-launch-resume.md`, `docs/kilcon-dev-context.md`, `.gitignore`
