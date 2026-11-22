# KIL Construction — resume / handoff (updated 2026-11-22)

Work is in progress on completing the Facebook gallery integration (Phases A–D), before the
Astro 7 migration. Production is stable and verified. Changes awaiting approval are on the local
branch `task/facebook-integration-completion` (uncommitted). Start here; the linked docs hold
the details.

## Production now

| Component | Live | Rollback target |
|---|---|---|
| Pages (`kilconstruction`) | `02aaaf2a` from `main` `9aa5b0a` (comparison UI) | `dccbe970` (`47dc2e7`) |
| Gallery Worker (`kilcon-gallery-worker`) | `8c893925-6546-41fd-ad68-16e056de7d39`, tag `d8ff7a9` (targeted import) | `npx wrangler versions deploy 18177ff4-7e57-46cd-89bb-7857b84b3ab1@100%` |
| D1 `kilcon-db` | Migrations through **017**; none pending | Bookmark from before the Ganz import: `000006d6-00000000-0000512b-2269b9f882efa19e8fc0885a612689b6` |
| Cloudflare | WAF rule *Block Facebook image bypass (cdn-cgi, encoded paths)*; route `images.kilcon.work/Facebook/*` **Fail closed**; hourly cron `17 * * * *` | Image-gate rollback order: docs/facebook-image-cache.md §8 |

- **Worker flags:**
  - `FB_INTEGRATION_ENABLED=true`
  - `FB_AUTO_IMPORT=true`
  - `FB_DISCOVERY_ENABLED=false`
  - `FB_HISTORICAL_IMPORT_ENABLED=false`
- **Plan and bindings:** Workers **Free** plan. Bindings `IMAGES` and `REVIEW_LIMITER`.
- **Data:** Ganz Garage (project 1) has **15** photos: 8 from the webhook, plus 7 from the
  targeted import on 2026-11-22. Review decisions: 7 Import (Ganz Garage). There are no album
  mappings.
- **Last verified:** 2026-11-22. 122/122 production checks passed, and all 30 Ganz image URLs
  load.

## Done on 2026-11-22

1. **Comparison UI** deployed to Pages (`02aaaf2a`). The owner checked it.
2. **Targeted import** mode added (`d8ff7a9`, Worker `8c893925`). The 7 Ganz Garage photos were
   imported with historical import on for about 2½ minutes. See docs/facebook-photo-review.md
   §Targeted import.
3. **Phase A, Manage Images** (local, not deployed): Facebook galleries now appear on
   `/admin/manage`, with hide, restore, move and permanent deletion through the Facebook admin
   API. See docs/facebook-manage-images.md.
4. **Phase B, visual duplicate check** (read-only) of all 379 remaining photos: about 109
   importable, the rest duplicates. See docs/facebook-historical-reconciliation.md §10.
5. **Phase C preparation** (local): a new `POST /facebook/admin/album-link` links an album to an
   existing gallery without importing. It refuses branding and unsorted albums, Recent Project
   Updates, foreign albums and albums already linked elsewhere.
6. **Phase D preparation** (local): **fix.** Profile pictures and cover photos were not
   excluded on the live webhook path, nor in scheduled discovery; only the historical import
   excluded them. They are now refused on every path (ingestPost, discovery visit, importPhoto).

## Branch `task/facebook-integration-completion` (uncommitted, from `main` `d8ff7a9`)

| Area | Files |
|---|---|
| Manage Images (Pages) | `src/pages/admin/manage.astro`, `src/pages/admin/manage-facebook.ts`, `src/lib/manage-facebook.js`, `src/styles/admin.css` |
| Worker | `workers/kilcon-gallery-worker/src/facebook.js` (`album-link`, branding guard) |
| Tests | `tests/manage-facebook.test.mjs` (7), `test/facebook.test.mjs` (+2), `test/facebook-review.test.mjs` (+4) |
| Docs | this file, `facebook-manage-images.md`, `facebook-photo-review.md`, `facebook-historical-reconciliation.md` §10 |

**Tests:** site 80/80, Worker 174/174, `tsc` 0 errors, `astro build` OK, Worker bundle dry run OK.

**Mutation checks:**
- breaking the targeted-import album checks fails a test;
- disabling the branding guard fails both branding tests.

## Remaining steps, in order (each needs the owner's approval)

1. **Approve and deploy the branch.**
   - Commit and merge to `main`.
   - **Pages:** a push without `[CF-Pages-Skip]` deploys Manage Images.
   - **Worker:** `versions upload`, then `versions deploy`, with the flags unchanged (album-link and
     the branding guard).
   - Run the production checks.
   - **Owner check:** `/admin/manage` lists Ganz Garage with 15 photos.
2. **Owner decisions** in docs/facebook-historical-reconciliation.md §10:
   - canonical galleries for the cross-category projects;
   - names for the new galleries (Jsme, Home, Fankhauser merge);
   - the 7th Ganz photo;
   - recording Skip decisions for the 237 duplicates (Group A 173 + Ganz 6 + Mobile uploads 58).
3. **The owner marks Import** on the review page, photo by photo, for the approved new photos.
4. **Phase C, per album, in small batches:**
   1. create the gallery (`project-create`), or link it to its manual folder;
   2. run `album-link`;
   3. targeted dry run;
   4. turn historical import on, then run;
   5. turn it off at once;
   6. verify.
5. **Phase D, after the archive is reconciled.** Enable `FB_DISCOVERY_ENABLED`; it needs
   approval. The effects:
   - Webhook events then go through the discovery engine.
   - The hourly cron adds a bounded reconcile scan, with a future-only cutoff fixed at the
     first run.
   - Verify:
     - the webhook subscription;
     - retries;
     - photos added only to an album;
     - removals;
     - that branding albums are excluded.
6. **Cleanup and the remaining deferred items:**
   - delete `task/review-comparison-ui` (merged);
   - private-only Facebook storage;
   - sharper comparison images;
   - CSP enforcement;
   - `npm audit` (Astro 7);
   - the localhost CORS origin;
   - WAF rate limiting.

## Rules that must survive

- **Historical import needs an explicit per-photo Import decision.** Duplicate / Skip and Review
  later never import. New webhook posts import automatically. Branding albums never import.
- **Never run `wrangler deploy` or `wrangler triggers deploy` for the gallery Worker.** Use
  `versions upload` then `versions deploy`. Turn historical import on only through a `--var`
  version, and back off right after.
- **Before any push to `main`, run `git fetch`.** The owner sometimes edits README on GitHub.
- **Use the pinned Node.** `C:\Users\Jwerl\dev\.tools\node-security-20261111\node-v22.23.5-win-x64`.
  Wrangler needs `CLOUDFLARE_ACCOUNT_ID=8481dbc471ac3a4aa14cc26ea366f956`.
- **Use the owner's browser for signed-in work** (Chrome extension). Screenshots time out in that
  session, so check pages by script.

## Repository state

| Item | State |
|---|---|
| `main` | `= origin/main` at `d8ff7a9` |
| `task/facebook-integration-completion` | Local and uncommitted; this work; **keep** |
| `task/review-comparison-ui` | Merged; delete after the owner approves |
| `backup-pre-revert` | Unmerged; the owner's backup; keep |
| `codex/facebook-album-integration` | Merged; another agent's branch; delete only with the owner's approval |
| Worktrees `kil-release-main`, `readme-refresh` | Not created in this work; left alone |

## Document map

| Topic | Document |
|---|---|
| Manage Images: Facebook galleries | docs/facebook-manage-images.md |
| Photo review, targeted import, deploy and rollback | docs/facebook-photo-review.md |
| Historical reconciliation and the duplicate check (§10) | docs/facebook-historical-reconciliation.md |
| Image gate, WAF, cache and costs | docs/facebook-image-cache.md |
| Security headers (CSP report-only) | docs/security-headers.md |
| Album discovery mechanics | docs/facebook-album-implementation.md |
| Webhook setup | docs/facebook-webhook.md |
