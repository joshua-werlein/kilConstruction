# KIL Construction — resume / handoff (updated 2026-11-22)

Work is in progress on completing the Facebook gallery integration, before the Astro 7 migration.
Production is stable and verified. Start here; the linked docs hold the details.

## Production now

| Component | Live | Rollback target |
|---|---|---|
| Pages (`kilconstruction`) | `e828a3b5` from `main` `2d8f323` (Import Approved Photos) | `584403a7` (`bd707ef`), then `02aaaf2a` |
| Gallery Worker (`kilcon-gallery-worker`) | `fc198011-3d43-4be5-af96-dcf691da44fc`, tag `e4369de` (scoped reviewed import **on**) | `npx wrangler versions deploy 33c469b5-1c20-449f-bb7c-859358f93693@100%` (switch off), then `93b9f92b` |
| D1 `kilcon-db` | Migrations through **017**. 018 (Highlights) is written on branch `task/facebook-hashtags` and not applied | Bookmark before `2d8f323`: `000006f3-00000000-0000512b-7d027c724b7152aa3ec2ef66f0d1f5cc`. Before the Ganz import: `000006d6-00000000-0000512b-2269b9f882efa19e8fc0885a612689b6` |
| Cloudflare | WAF rule *Block Facebook image bypass (cdn-cgi, encoded paths)*; route `images.kilcon.work/Facebook/*` **Fail closed**; hourly cron `17 * * * *` | Image-gate rollback order: docs/facebook-image-cache.md §8 |

- **Worker flags:**
  - `FB_INTEGRATION_ENABLED=true`
  - `FB_AUTO_IMPORT=true`
  - `FB_DISCOVERY_ENABLED=false`
  - `FB_HISTORICAL_IMPORT_ENABLED=false` (stays off permanently)
  - `FB_REVIEWED_IMPORT_ENABLED=true`: the scoped switch for Import Approved Photos. The owner
    approved turning it on, and it went on 2026-11-22 at 19:52 UTC. After that, 122/122
    production checks passed and D1 was unchanged.
- **Verified after `2d8f323`** (2026-11-22, 18:35 UTC):
  - 122/122 production checks passed.
  - `import-plan` and `import-run` return 401 `no-store` signed out, and a form-encoded POST is
    also refused.
  - D1 was unchanged by the deploy.
  - The signed-in check is pending: the owner's admin session had expired.
- **Plan and bindings:** Workers **Free** plan. Bindings are unchanged; I diffed them against
  the previous version before deploying.
- **Data:**
  - Ganz Garage (project 1) has **15** photos.
  - Review decisions: 7 Import (Ganz Garage, done) and **216 Skip**. The Skips were saved
    2026-11-22 at 17:20 UTC: all high-confidence visual duplicates (distance 0–2), re-checked
    against D1 first, each with `duplicate_of` evidence. The 20 medium-confidence matches are
    left undecided for the owner.
  - **Ripley** gallery: project `5`, Projects, empty, not public yet. It is linked to album
    `122203565678318503`.
  - D1 bookmark from before the Skip save: `000006e6-00000000-0000512b-887ad3972528c2c10e9776b04d53b3d5`.
- **Verified on 2026-11-22, after `bd707ef`:**
  - **Production checks:** 122/122 passed.
  - **Signed-out access:** `/admin/manage` redirects to `/admin`, and `album-link` and
    `overview` return 401 `no-store`.
  - **Manage Images, signed in:** Ganz Garage shows 15 of 15 photos visible. All 15 are
    manageable, and the 35 manual folders work unchanged.
  - **Webhook health:** the token is OK, `feed` is subscribed, auto-import is on, the queue is
    empty and there are 0 failures.
  - **Not yet seen:** an end-to-end auto-import of a *new* Facebook post. The last event was
    2026-11-15. Check it after the owner's next post: `/admin/facebook` shows the event `done`,
    and the photos appear.

## Done on 2026-11-22

1. **Comparison UI** deployed (Pages `02aaaf2a`).
2. **Targeted import** (`d8ff7a9`): the 7 Ganz Garage photos were imported. Historical import
   was on for about 2½ minutes.
3. **Phase A, Manage Images**, deployed (`bd707ef`). See docs/facebook-manage-images.md.
4. **Worker safety**, deployed (`bd707ef`):
   - **`album-link`.**
   - **Branding albums are never imported, on any path.** Before this, profile and cover
     photos were excluded only by the historical import.
5. **Phase B duplicate check:** about 109 importable photos; the duplicates are graded.
6. **Owner decisions** recorded, with their evidence, in
   docs/facebook-historical-reconciliation.md §10:
   - twins kept;
   - 5 new galleries;
   - Jsme and Home held;
   - Fankhauser not merged (the photos don't confirm one project);
   - Ganz matched photo by photo.
7. **Skip plan prepared, not saved:** 236 duplicates, 216 high and 20 medium confidence, 0
   ambiguous. It's in the owner's browser at `kil-skip-plan-2026-11-22`.
8. **Mixed-album import prepared** (local branch `task/mixed-album-import`, uncommitted): per-batch
   destinations for albums like Mobile uploads and Ganz, with no mapping written.
   - Tests: Worker 176/176, site 80/80.
   - Mutation check: the linked-album refusal is enforced.

## Next actionable step

**Ripley is done.** The owner imported its 2 photos with the button. I verified both: stored,
visible, and all 4 image URLs return 200.

The owner is now reviewing and importing the remaining historical photos.

**Hashtags: ready, awaiting approval, and only when no import is running.**
- **Code:** branch `task/facebook-hashtags` (`a5db749`), committed and not pushed.
- **Plan:** the contractor guide and the deployment, validation and rollback plan are in
  docs/facebook-hashtags.md on that branch.
- **Order:** D1 bookmark, then migration 018, then the Worker, then Pages, then validation.

**README:** the reconciling commit `f8e2b46` sits on top of the owner's PR #2 branch, locally
and unpushed. Push it and merge only after the hashtag deploy is verified.

**After that:** enable automatic discovery (Phase D), with approval.

## Remaining steps, in order (each needs the owner's approval)

1. ~~Save the Skip plan~~: done (216 high-confidence Skips). The owner reviews the 20 medium-confidence matches by eye.
2. **Phase C, done by the owner from the review page** once the scoped switch is on.
   - **Order:** Ripley, Zingshiem, Rieck Deck, Pongratz, Bisek, then the Group A albums. See the
     batch plan in reconciliation §10.
   - **Galleries:** a new gallery is created on `/admin/facebook`. The page links the album on
     confirmation.
   - **After each batch:** I verify on request (gallery count, images, D1 diff, production
     checks).
3. ~~Deploy mixed-album import~~: done (`2d8f323`). Mixed albums (Ganz, Mobile uploads) are
   imported with the "several projects" option.
4. **Held items:**
   - Jsme and Home (identity);
   - E. Fankhauser and Fankhauser (display names; separate galleries);
   - Ganz `…480` (distance 6) and `…648`;
   - Mobile uploads' 33 unique photos.
5. **Phase D, after the archive is reconciled.** Enable `FB_DISCOVERY_ENABLED`.
   - Webhooks stay the primary trigger: with discovery on, events go through the discovery
     engine.
   - The hourly cron adds a bounded reconcile scan. Its cutoff is set at the first run and
     never widens, so it is future-only.
   - Tests cover the cutoff and branding exclusion.
   - Before enabling: verify the subscription, retries, album-only additions and removals.
6. **Cleanup and the remaining deferred items:**
   - delete `task/review-comparison-ui` (merged), once the owner authorizes it;
   - private-only storage;
   - sharper comparison images;
   - CSP enforcement;
   - `npm audit` (Astro 7);
   - the localhost CORS origin;
   - WAF rate limiting.

## Rules that must survive

- **Historical import needs an explicit per-photo Import decision.** Skip and Review later never
  import. Branding albums never import. New webhook posts import automatically.
- **Never run `wrangler deploy` or `wrangler triggers deploy` for the gallery Worker.** Use
  `versions upload`, diff the bindings, then `versions deploy`. Turn historical import on only
  through a `--var` version, and back off right after the run.
- **Before any push to `main`, run `git fetch`.** The owner sometimes edits README on GitHub.
- **Use the pinned Node.** `C:\Users\Jwerl\dev\.tools\node-security-20261111\node-v22.23.5-win-x64`.
  Wrangler needs `CLOUDFLARE_ACCOUNT_ID=8481dbc471ac3a4aa14cc26ea366f956`.
- **Chrome session limits** (owner's browser, for signed-in work):
  - screenshots time out;
  - script output is truncated at about 1,000 characters;
  - avoid waiting on lazy images;
  - so analyse in-page.

## Repository state

| Item | State |
|---|---|
| `main` | `= origin/main` (`2d8f323` plus docs) |
| `task/facebook-hashtags` | Local, committed (`a5db749`), not pushed: caption hashtags + migration 018; **keep** |
| `docs/kil-readme-align-20261122` (local) | The owner's PR #2 branch + 1 local commit `f8e2b46` (README reconcile); push after the hashtag deploy |
| `task/review-import-workflow`, `task/mixed-album-import` | Merged into `2d8f323` and deleted |
| `docs/kil-readme-align-20261122` (draft PR #2) | The owner's README branch; **don't overwrite**; merge last |
| `task/facebook-integration-completion` | Merged (`bd707ef`) and deleted |
| `task/review-comparison-ui` | Merged; delete |
| `backup-pre-revert` | Unmerged; the owner's backup; keep |
| `codex/facebook-album-integration` | Merged; another agent's branch; delete only with the owner's approval |
| Worktrees `kil-release-main`, `readme-refresh` | Not created in this work; left alone |

## Document map

| Topic | Document |
|---|---|
| Manage Images: Facebook galleries | docs/facebook-manage-images.md |
| Photo review, targeted and mixed-album import, `album-link` | docs/facebook-photo-review.md |
| Reconciliation, duplicate check, decisions, batch plan (§10) | docs/facebook-historical-reconciliation.md |
| Image gate, WAF, cache and costs | docs/facebook-image-cache.md |
| Security headers (CSP report-only) | docs/security-headers.md |
| Album discovery mechanics | docs/facebook-album-implementation.md |
| Webhook setup | docs/facebook-webhook.md |
