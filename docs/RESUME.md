# KIL Construction — resume / handoff (updated 2026-11-22)

Work is in progress on completing the Facebook gallery integration, before the Astro 7 migration.
Production is stable and verified. Start here; the linked docs hold the details.

## Production now

| Component | Live | Rollback target |
|---|---|---|
| Pages (`kilconstruction`) | `fa396306` from branch `hotfix/astro5-apparel-auth` `556c10e` (= `9ac0524` + apparel save auth). **Automatic production builds OFF**; `main` is Astro 7 | `449b7a41` (`9ac0524`, without the hotfix: do not use), `388e94dd` |
| Gallery Worker (`kilcon-gallery-worker`) | `0c251687-4c6e-40e5-984e-035f884e14b9`, tag `5b0da7f`. **Automatic discovery on** (twice daily), webhooks on, reviewed import on, historical import off | `--config workers/kilcon-gallery-worker/wrangler.toml versions deploy 5d25e58b-e0f1-4708-85b5-a9adb8472f6e@100%` (discovery off), then `a97a5c14` |
| D1 `kilcon-db` | Migrations through **018** (Highlights columns, applied 2026-11-22 at 21:03 UTC); none pending | Bookmark before 018: `00000701-00000000-0000512b-5f6fb82a7244937f8c056e501f191ff1`. Leave 018 in place on rollback; older code ignores it. |
| Cloudflare | WAF rule *Block Facebook image bypass (cdn-cgi, encoded paths)*; route `images.kilcon.work/Facebook/*` **Fail closed**; hourly cron `17 * * * *` | Image-gate rollback order: docs/facebook-image-cache.md §8 |

- **Worker flags:**
  - `FB_INTEGRATION_ENABLED=true`
  - `FB_AUTO_IMPORT=true`
  - `FB_DISCOVERY_ENABLED=true`: reconciliation runs at 12:00 and 18:00 America/Chicago (runs start at :17). The future-only cutoff is `2026-11-22T22:53:16.402Z`.
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

**The final Facebook deployment is done** (2026-11-22, 21:02–21:30 UTC). It followed
docs/facebook-final-deployment.md:
- the D1 bookmark, then 018;
- the Worker: its bindings diff showed only the tag changed, then deploy;
- Pages, then validation, then README PR #2 merged (`b419e7c`).

**Verified:**
- **Production checks:** 122/122 after every step.
- **Signed out:** every new endpoint returns 401 `no-store`.
- **Highlights:** still the 14 manual images; no Facebook ones yet.
- **D1:** unchanged apart from the two 018 columns (all 0). The original photo columns are
  byte-identical to before (`1f4ecf4f68db`).
- **Owner's data:** 22 photos, 237 decisions, 3 galleries and 2 album links, all untouched.
- **Signed-in, read-only:**
  - the dropdown lists 31 galleries by category, including the website galleries Cabinets,
    Cutting Boards and Epoxy;
  - Create New Gallery's check refuses "Ganz Garage" (409, existing) and accepts an unused name
    as a dry run, with nothing created;
  - Manage Images shows the Highlights buttons (not clicked).

**Not yet seen in production:** hashtag categorization, `#highlight`, and holds on real new
posts. No new Facebook post has arrived since the deploy. All three are covered by tests; check
them on the contractor's next posts.

**Review filters deployed** (`9ac0524`, Pages `449b7a41`): photos marked Duplicate / Skip and already-imported photos are hidden by default. Display only. 146/146 production checks.

The owner has finished the historical imports: 115 photos across 20 galleries. Mobile uploads stays held.

**Phase D done (2026-11-22/23):** automatic discovery is permanently enabled. See docs/facebook-final-deployment.md, *Phase D result*.

**Next:** the Astro 7 migration, on local worktree `.worktrees/kil-construction/astro7-migration` (branch `task/astro7-migration`), not deployed.

## Remaining steps, in order (each needs the owner's approval)

1. ~~Save the Skip plan~~: done (216 high-confidence Skips). The owner reviews the 20 medium-confidence matches by eye.
2. **Phase C, done by the owner from the review page** once the scoped switch is on.
   - **Order:** Ripley, Zingshiem, Rieck Deck, Pongratz, Bisek, then the Group A albums. See the
     batch plan in reconciliation §10.
   - **Galleries:** choose any existing Facebook or website gallery, or use **Create New
     Gallery** in the panel. The page creates or reuses the link on confirmation.
   - **After each batch:** I verify on request (gallery count, images, D1 diff, production
     checks).
3. ~~Deploy mixed-album import~~: done (`2d8f323`). Mixed albums (Ganz, Mobile uploads) are
   imported with the "several projects" option.
4. **Held items:**
   - Jsme and Home (identity);
   - E. Fankhauser and Fankhauser (display names; separate galleries);
   - Ganz `…480` (distance 6) and `…648`;
   - Mobile uploads' 33 unique photos.
5. **Phase D, after the archive is reconciled.** Enable `FB_DISCOVERY_ENABLED`, with approval:
   a `--var` version first, then a `wrangler.toml` commit.
   - **Triggers:** webhooks stay the primary trigger; with discovery on, events go through the
     discovery engine.
   - **Fallback scan:** the hourly cron adds a bounded reconcile scan. Its cutoff is set at the
     first run and never widens, so it is future-only. The same album rules and holds apply, and
     branding is excluded. Tests cover all of this.
   - **Before enabling:**
     - live webhook health (token, `feed` subscription, an empty queue);
     - a real end-to-end new post (none since 2026-11-15) to confirm automatic import, and a
       held-post check;
     - confirm Graph album and photo read access with the health check in discovery mode;
     - a D1 bookmark.
   - **After enabling:**
     - watch the first scheduled reconcile run (its cutoff is recorded, and no historical photo
       is imported);
     - check retries, album-only additions, removals, and that no gallery is duplicated.
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
- **Always pass `--config workers/<worker>/wrangler.toml`** to Wrangler for the Gallery and Contact Workers. After an Astro 7 build, `.wrangler/deploy/config.json` at the repo root redirects config-less Wrangler commands to the *site* Worker.
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
| `main` | `= origin/main` at `b419e7c` |
| `task/facebook-integration-final`, `task/import-manual-galleries`, `task/facebook-hashtags`, `task/review-import-workflow`, `task/mixed-album-import` | Merged and deleted locally |
| `docs/kil-readme-align-20261122` | PR #2 merged (`b419e7c`). Local copy deleted; the **remote branch is kept**, since deleting it needs the owner's approval |
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
