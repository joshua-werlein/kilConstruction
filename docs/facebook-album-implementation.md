# Facebook albums and post discovery — local implementation, pending approval

## November 15 follow-up: project descriptions and release order

- Current GitHub `main` was verified at `8a5f5ff`. Its only change since the
  album branch diverged is the Node.js `22.23.5` pin. It was merged locally
  without changing the album commit or the earlier security fixes.
- A read-only production D1 lookup found migration `014` recorded and `015`
  and `016` absent. A second read-only lookup confirmed eight distinct visible
  `ganz-garage` photos, all from one post and all with captions identical to
  that post's stored text. No production rows were changed.
- `016_facebook_project_descriptions.sql` adds a nullable admin override and
  distinguishes a photo's own caption from the post-text fallback on future
  imports. Existing captions, IDs, image URLs and objects are untouched.
  The Worker reuses the first recorded eligible post with a visible photo in
  the gallery; later posts and older history discovered later do not displace
  it. The selected source can change if it is removed or no longer visible.
  The text of the selected source follows edits on Facebook unless overridden.
  An administrator can save text, save blank to hide it, or return to the
  automatic description. Recent Project Updates does not pick a project-wide
  Facebook caption. Legacy captions equal to the stored post text (ignoring
  whitespace) are suppressed only in public rendering.
- Reconciliation no longer treats an ambiguous Graph `100/33` lookup by
  itself as a removal. A signed removal event preserves the existing
  confirmation flow; a clear unpublished/hidden post can still be hidden by
  periodic verification. Album-only removals without a reliable signal may
  require admin review.

Use this updated order after separate approvals:

1. Reconfirm GitHub/CI state, Pages branch deployment behavior, the production
   Worker/Pages rollback IDs, D1 migration ledger and a recovery bookmark.
   Ensure no automatic Pages production cutover can get ahead of D1/Worker.
2. In the Worker directory, inspect pending migrations with
   `npx wrangler d1 migrations list kilcon-db --remote`. If `015` and `016`
   are the only pending migrations, apply both in order using
   `npx wrangler d1 migrations apply kilcon-db --remote` **after approval**.
   If the ledger and schema disagree or unrelated migrations are pending,
   stop and investigate. Do not rerun migrations already recorded.
3. Deploy the matching Worker, then Pages, with `FB_DISCOVERY_ENABLED="false"`
   and the existing post importer enabled. Keep existing secret bindings and
   security rules. Verify Ganz Garage has the same eight IDs and renders one
   description, then smoke-check the old webhook path, admin and public routes.
4. In `/admin/facebook`, choose **Preview (dry run)**. This combined preview
   works while album automation is off. Review access errors, coverage and
   destinations; rerun preview after assigning albums. Do not click **Import
   history** until separately approved.
5. After the preview proves access and the owner approves ongoing discovery,
   enable `FB_DISCOVERY_ENABLED`, record the first reconciliation cutoff and
   verify both a normal post and an album-only upload. The historical import
   is still a distinct decision; when approved, use the reviewed admin preview
   and explicit import confirmation. The first reconciliation picks up only
   uploads whose creation dates meet its cutoff.
6. If the release causes regressions, restore the captured secure Pages/Worker
   deployments. Leave additive migrations `015`/`016` in place; do not roll
   back the shared database or remove content without separate approval.

The October handoff and validation below remain as a record of the original
album implementation.

No commit, push, deployment, production migration, historical import, Meta setting
change, or secret update is authorized by this document. Those actions require
the owner's approval. The implementation is staged with `FB_DISCOVERY_ENABLED`
set to `"false"`.

## Verified handoff

- Local HEAD, cached origin/main, and a read-only GitHub remote check agreed on
  `912d8536d86dbcd91b74ff18b43c80f5b28b72fc` before edits. The working tree was clean.
- Claude's apparel slug validation is in that commit and is unchanged here.
- A read-only Cloudflare Pages metadata request confirmed `ADMIN_PASS` has type
  `secret_text` for both production and preview in `kilconstruction`. No secret
  value was retrieved or displayed. The owner also confirmed both tasks complete.

## What changed

`facebook-discovery.js` traverses Page albums, each album's photo edge, Page
posts, attachments and nested subattachment pages. It rebuilds requests from
validated Graph paths/cursors; it never follows a pagination URL containing a
token. Unexpected pagination shapes are reported as incomplete, not discarded.

The adapter in `facebook.js` reuses existing photo claims, Facebook photo IDs,
private/public R2 copies, visibility controls, galleries and retention. Each
photo is grouped independently, preventing a mixed-album post from assigning
every photo using the first photo's album. Established mappings and individual
manual assignments win. Clear album-name matches link to manual galleries.
Uncertain near-matches and generic albums use Recent Project Updates.

The admin preview scans albums and posts, deduplicates IDs across all batches,
reports album-only and overlapping photos, proposed galleries, suppressed photos
and errors, and offers per-album destinations. Changing a destination requires
another preview. Preview writes no D1/R2 state and downloads no image originals.
Its continuation and report live only in the open browser tab; closing/reloading
the tab restarts preview. Stop/resume within that tab is supported.

Historical import requires the authenticated admin route plus
`authorizeHistorical: true`; the UI additionally requires a completed preview
and a confirmation. Its checkpoints live in D1, so closing the browser or
restarting the Worker does not lose import progress. Historical jobs are never
driven by cron. The older post-only API remains compatible for existing callers;
the admin UI explicitly selects `discovery: true` for the new combined scan.

New webhook discovery is enabled only by the new feature switch. It checkpoints
large attachment traversals on the existing event row. The old handler remains
available when the feature is off. Photo-only events do not require a normal post.

## Migration and settings

Apply `migrations/015_facebook_discovery.sql` before running the updated Worker.
It creates:

- `facebook_discovery_jobs`: separate history/reconciliation traversal states,
  fenced writer leases, attempts, retry dates and sanitized failures.
- `facebook_album_mappings`: multiple albums can target one existing project;
  administrator choices persist for future uploads.
- `facebook_albums`: album names, descriptions and timestamps.
- `facebook_webhook_events.discovery_state`: resumable attachment traversal.

It does not change apparel/order tables or move existing R2 objects. The existing
DB and both R2 bindings are reused. No new hosting service or secret is required.

`FB_DISCOVERY_ENABLED="false"` stages complete automatic discovery off.
After approval, `"true"` enables the complete webhook path and reconciliation.
The existing integration/auto-import switches still apply. Turning auto-import
off keeps new imports paused while preserving existing removal/retention work.

## Changed files and validation

Files changed or added:

- `workers/kilcon-gallery-worker/src/facebook.js`
- `workers/kilcon-gallery-worker/src/facebook-discovery.js` (new)
- `workers/kilcon-gallery-worker/test/facebook.test.mjs`
- `workers/kilcon-gallery-worker/wrangler.toml`
- `migrations/015_facebook_discovery.sql` (new)
- `src/pages/admin/facebook.astro`
- `src/pages/admin/facebook-script.ts`
- `src/pages/admin/facebook-discovery-ui.ts` (new)
- `src/pages/privacy.astro` (album metadata disclosure and accurate update date)
- `tests/legal-pages.test.mjs` (legal pages retain their own revision dates)
- This implementation/rollout document (new)

Final local validation, October 29, 2026:

- Worker and security tests: **98 passed**, including 27 complete-discovery tests.
- Site/legal/apparel slug tests: **12 passed**.
- TypeScript: `tsc --noEmit` passed.
- Astro production build passed, including public gallery sitemap reads.
- Worker `wrangler deploy --dry-run` bundle passed; no deployment occurred.
- `git diff --check` passed. Claude's apparel slug files have no local diff.

The tests exercise real local D1/R2 through the Cloudflare emulator; all Graph
and image/CDN requests are mocked. The emulator needed execution outside the
filesystem sandbox to start. Logs were redirected into ignored workspace paths.
The initial sandboxed build's public sitemap lookups could not resolve DNS; the
final build with network access completed those lookups successfully. No test
accessed production D1/R2. No real Meta access token was used in tests.

## Reconciliation and API budget

Keep the existing hourly schedule `17 * * * *`. Each invocation continues a
bounded traversal, rather than starting a full scan on every run. After a scan
finishes, wait six hours before starting the next pass. Scan latency grows with
the accessible archive size; immediate notifications still use webhooks.

The scheduled path allocates up to 20 external Graph/CDN requests for pending
webhook work and up to 20 for reconciliation (960 external requests/day maximum
from that path at 24 invocations/day, excluding live webhook requests, admin
actions and existing retention/storage operations). A discovery batch also has
a 12-task limit. Graph pages request ten items. Old album photos can be filtered
from the ID/date inventory without fetching their full image metadata. Rotating
verification checks up to two existing imported objects during a reconciliation
batch using the established removal-confirmation/retention policy.

The first reconciliation job establishes a permanent cutoff at that first run.
Only photos with a creation timestamp on/after it are eligible for automatic
discovery imports. Resetting a traversal does not widen that cutoff. This is
intentional: merely deploying the feature must not authorize the historical
archive. Historical photos require a separately approved admin import.

Claims use five-minute renewable leases and a unique token on checkpoint writes.
Photo-ID uniqueness remains the second concurrency defense. Failed tasks stay
at the head of their queue. Retries use exponential delays with jitter, capped
at six hours; after five failed batches, the job stops for explicit admin retry.
Failures/status appear on the admin overview when the feature is enabled.

## Permissions and unverified Meta behavior

The current Page token must be tested against `/{page-id}/albums`,
`/{album-id}/photos`, `/{page-id}/posts`, and a paginated attachment result.
Do not request more permissions unless one of these calls provides evidence
that the current grants are insufficient. No permission, app mode, subscription
or token was changed during implementation.

Official references attempted during investigation:

- https://developers.facebook.com/docs/graph-api/reference/page/albums/
- https://developers.facebook.com/docs/graph-api/reference/album/photos/
- https://developers.facebook.com/docs/graph-api/reference/post/attachments/

Meta returned access/rate-limit errors to the documentation reader. The current
token is stored as a Cloudflare secret and was not extracted. Therefore live
album access, current permission requirements and exact nested pagination URL
shapes remain verification gates. Mock tests prove handling of the implemented
contract, not completeness of Meta's accessible history. The new health check,
when the feature is enabled, independently tests album and album-photo reads;
an empty album list is reported as having no album available to test.

## Limits to present honestly

- Coverage means *accessible* API objects; deleted, restricted or inaccessible
  historical content cannot be guaranteed. Errors leave the scan incomplete.
- The reconciliation cutoff deliberately excludes unknown old/backdated photos.
  A newly uploaded photo with a backdated Facebook creation time may need the
  explicit historical scan; do not silently widen the cutoff to recover it.
- Full visual/byte comparison with manually uploaded website photos is not
  performed in preview. Potential duplicate candidates use a stored Facebook ID
  or an ID-like filename. Recompressed/reuploaded images with different IDs may
  remain duplicates. The UI explicitly says visual matching was not performed.
- Admin preview totals are deduplicated by photo ID in the browser, and proposal
  names are grouped there. No immutable import manifest is persisted by preview;
  Facebook can change between preview and import. Re-preview before approval if
  the source or administrator mappings changed.
- New album mappings apply to new imports, not already manually placed photos.
- Graph/CDN budgets do not account for all D1/R2 binding operations. Use a local
  or staging runtime to measure CPU/operation use; no free-tier guarantee is made.
- Graph error 100/33 has multiple meanings. Periodic verification alone does
  not start retention for this error; a signed removal event uses the existing
  confirmation flow. Temporary errors do not trigger removal.

## Deployment plan — execute only after approval

1. Review the complete diff and validation results; confirm main still contains
   Claude's security changes. Commit/push only with explicit owner approval.
2. Capture the current production Worker version and Pages deployment IDs and
   a D1 recovery bookmark. Record counts and representative manual gallery URLs.
   Do not use a pre-security-release deployment as the rollback target.
3. Test migration 015 and the combined preview on an isolated environment with
   local/staging data and the intended runtime limits. Re-run all test suites.
4. With migration approval, apply pending migrations from the gallery Worker
   directory using `npx wrangler d1 migrations apply kilcon-db --remote`.
   Inspect the pending list first: do not apply unrelated pending migrations.
5. With deployment approval, deploy the Worker with complete discovery still
   disabled, then deploy the matching Pages admin assets. Keep all existing
   secret bindings; do not replace secrets with plaintext vars.
6. Verify login, apparel slug handling, galleries, reviews, unauthorized admin
   rejection, and the normal webhook route. Confirm the intended Worker version.
7. Run the read-only historical preview below. Report scope/errors and review
   project mappings. Do not press Import history.
8. Obtain separate approval to enable future reconciliation and/or run the
   historical import. Enable the feature only after migration and source access
   checks. Record its initial cutoff and verify a bounded future-photo event.

## Complete read-only historical preview after deployment

1. Sign in and open `/admin/facebook`. Do not use Subscribe or Import history.
2. Click Preview (dry run). It sends authenticated POSTs to
   `/api/gallery-api/facebook/backfill` with `{discovery:true,dryRun:true}` and
   the browser continuation on subsequent requests. POST is used because the
   continuation can exceed safe URL lengths; this mode still writes no data.
3. Keep the tab open until Complete, or Stop after the current batch. Inspect
   albums/posts scanned, unique IDs, album-only/overlap counts, already imported
   and suppressed items, duplicate candidates, assignments and failures.
4. Choose album destinations where needed, then run Preview again. Do not import
   with incomplete results. Investigate any access failure before requesting a
   permission change.
5. Check that Facebook-photo table counts and R2 object counts did not change
   because of preview (independent live webhooks may legitimately change them).
6. Present the report for approval. Historical import remains a separate action.

## Rollback

First pause complete discovery with `FB_DISCOVERY_ENABLED="false"` using the
approved deployment process. If all imports must stop, also set the existing
`FB_AUTO_IMPORT="false"`; retention/removals continue under the established
policy. Restore the captured Worker and Pages versions, both from after Claude's
security fixes. Leave migration 015 and imported-photo rows in place: the added
tables/column are compatible with the old importer. Do not drop tables or restore
the entire shared database, which would affect unrelated orders. Already imported
photos remain governed by existing admin hide/move/delete controls. Any content
removal requires its own explicit authorization.
