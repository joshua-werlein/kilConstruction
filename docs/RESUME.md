# KIL Construction — resume / handoff (paused 2026-11-21)

Development is **paused**. Production is stable and verified. One reviewed-but-undeployed UI
commit is waiting on a local branch. Start here; the linked docs hold the details.

## Production now

| Component | Live | Rollback target |
|---|---|---|
| Pages (`kilconstruction`) | `dccbe970` from `main` `47dc2e7` (review-page layout fix) | `c9e92942` (`780127e`), then `bd120cd6` (`4040b3f`) |
| Gallery Worker (`kilcon-gallery-worker`) | `18177ff4-7e57-46cd-89bb-7857b84b3ab1`, tag `780127e` (photo review + per-photo import gate) | `npx wrangler rollback 1494935c-6fae-419f-bc87-0b4f66456a93` |
| D1 `kilcon-db` | Migrations through **017** (`facebook_photo_reviews`); none pending | Time Travel bookmark from before 017: `0000069f-00000000-0000512a-70c3e47bc9e5d69d289848bace0ac932`. Leave 017 in place on any rollback; the old code ignores it. |
| Cloudflare | WAF rule *Block Facebook image bypass (cdn-cgi, encoded paths)*; route `images.kilcon.work/Facebook/*` set to **Fail closed**; hourly cron `17 * * * *` (verified running 21:17 UTC on `18177ff4`) | Image-gate rollback order: docs/facebook-image-cache.md §8 |

- **Unchanged by design:** zone Browser Cache TTL (4 h), the 8 public Facebook R2 copies, Workers **Free** plan.
- **Worker flags:**
  - `FB_INTEGRATION_ENABLED=true`
  - `FB_AUTO_IMPORT=true`
  - `FB_DISCOVERY_ENABLED=false`
  - `FB_HISTORICAL_IMPORT_ENABLED=false` (no historical import has run)
- **Bindings:** `IMAGES`, and `REVIEW_LIMITER` (namespace 1003, 300 per 60 s per endpoint).
- **Data:** 8 Facebook photos (Ganz Garage, project ID 1), all imported and visible. 0 review decisions are saved.

### Verified 2026-11-21

- **Production checks:** 67/67. All 8 photos load through the gate. These are blocked:
  - old `/cdn-cgi/image` URLs on both hosts;
  - arbitrary widths;
  - encoded and lower-case paths.

  Reviews, admin endpoints and the webhook are protected; galleries, apparel and the site work.
- **Signed out:** `/admin/facebook-review` redirects to `/admin`, and every `review-*` endpoint returns 401 `no-store`.
- **Owner check:** the review page loads, lists **31 albums**, and Ganz Garage displays.
- **Not yet verified:** the owner's temporary Review later save and clear on Ganz Garage (step 3 below).

## Outstanding work: branch `task/review-comparison-ui`, commit `eca9ad3`

Local only, never pushed. Based on `main` `47dc2e7`. Presentation-only (review page, its script and tests):

- **Comparison cards:** each Facebook photo shown beside its closest existing-website photo, at the same size, labelled **Facebook** / **Existing website**.
- **Sources:** album, date and ID; gallery, file, and "Manually uploaded" or "Previously imported from Facebook".
- **No match:** the card says why there is no match.
- **Large view:** a clickable duplicate badge opens a side-by-side dialog.
- **Buttons:** decision buttons under each pair.
- **Separate section:** photos already imported (Ganz Garage's 8) are listed apart from the 7 needing review.

Tests on `eca9ad3`: site **73/73**, Worker **163/163**, `tsc` 0 errors, `astro build` OK. On `main` `47dc2e7`: site 66/66, Worker 163/163.

The local preview HTML files and their generator scripts are in the paused session's scratchpad, which is temporary. Rebuild them, or simply deploy and look.

**Known limitation:** the large view uses the existing preview sizes (Facebook ≥ 320 px, website 400 px). Sharper images need a small Worker change, a size option on `review-image`, which has not been made.

## Remaining steps, in order

1. **Review `eca9ad3`.** Check out `task/review-comparison-ui`, run `npm run test:site` and `npm run test:gallery-worker` with Node 22.23.5, then `npm run build`. Approve the presentation.
2. **Deploy it (Pages only).**
   - `git fetch`. `main` has moved ahead by docs-only commits since `47dc2e7`, starting with this handoff.
   - Run `git switch task/review-comparison-ui && git rebase origin/main`. No conflicts are expected: the branch only touches the review page, its script and tests.
   - Re-run both suites and the build.
   - Then `git switch main && git merge --ff-only task/review-comparison-ui`, and push without `[CF-Pages-Skip]`.
   - Confirm the new Pages deployment, run the 67 production checks, and confirm the signed-out redirect.
   - Rollback: Pages `dccbe970`.
3. **Owner check on the live page.** On `/admin/facebook-review`, open Ganz Garage:
   - the 7 photos needing review and the 8 already imported should appear in separate sections;
   - mark one photo **Review later**, reload and confirm it persisted, then click again to clear it and confirm.
4. **Close out the code work.**
   - Record the comparison-UI deployment in `docs/facebook-photo-review.md` with a docs-only `[CF-Pages-Skip]` commit.
   - Delete `task/review-comparison-ui` with `git branch -d`; it was never pushed.
5. **The owner reviews all albums** on `/admin/facebook-review`: Duplicate / Skip, Import or Review later for each of the **386** new photos.
   - Resolve the open mapping decisions in docs/facebook-historical-reconciliation.md §8: the canonical gallery per cross-category project, new project names and categories ("Jsme", Fankhauser merge), "Ganz" (7), "Home" (7), and Mobile uploads (91).
   - Expected: about 26–211 genuinely new photos in albums that already have a gallery, and 84 in albums that do not.
6. **Prepare and approve the historical import** (separate approval).
   - Create the new projects with admin *project-create*.
   - Re-run *Preview (dry run)*: only photos marked Import should show as new.
   - Then enable `FB_HISTORICAL_IMPORT_ENABLED` (a Worker deploy) and run a small first batch to check Free-plan CPU before continuing.
   - Keep `FB_DISCOVERY_ENABLED=false` unless that is approved separately.
7. **Deferred follow-ups** (each needs its own approval):
   - private-only Facebook storage (stop writing public copies, delete the 8 existing ones);
   - sharper large comparison images (Worker size option);
   - CSP enforcement after the report-only period;
   - `npm audit` (Astro 7 / adapter 14);
   - remove the `http://localhost:4321` credentialed CORS origin;
   - a WAF rate-limiting rule if Worker request usage approaches the Free limit.

## Rules that must survive the pause

- **Historical import needs an explicit per-photo Import decision.** Duplicate / Skip and Review later never import by any route. New webhook posts (`add`, or edits of posts already on the site) still import automatically. **No date cutoff is used.** Rules: docs/facebook-photo-review.md.
- **Never run `wrangler deploy` or `wrangler triggers deploy` for the gallery Worker.** Use `versions upload` then `versions deploy`, so the dashboard-created Fail-closed image route stays as it is. Re-check the route after any trigger change.
- **Before any push to `main`, check for owner commits.** The owner sometimes edits README directly on GitHub (`ff36da0`, `776df6e`), so run `git fetch` first.
- **Use the pinned Node.** `C:\Users\Jwerl\dev\.tools\node-security-20261111\node-v22.23.5-win-x64`. Wrangler needs `CLOUDFLARE_ACCOUNT_ID=8481dbc471ac3a4aa14cc26ea366f956`.
- **Use the owner's browser for dashboard and signed-in work.** The wrangler token cannot read or change WAF, routes or zone settings, and calling the Cloudflare API with its OAuth token is blocked in auto mode. Dashboard steps and signed-in admin checks are done by the owner, or through the Chrome extension when it is connected.

## Repository state at pause

| Item | State |
|---|---|
| `main` | `= origin/main`, plus this handoff (docs only) |
| `task/review-comparison-ui` | Unmerged, local (`eca9ad3`); **keep** |
| `backup-pre-revert` | Unmerged, 30 commits, owner's backup; keep |
| `codex/facebook-album-integration` | Fully merged; created by another agent, so delete only with owner approval |
| Worktree `.tools/node-security-20261111/kil-release-main` | Not created in this work; left alone |
| Worktree `.worktrees/kil-construction/readme-refresh` | Not created in this work; left alone |

## Document map

| Topic | Document |
|---|---|
| Photo review design, rules, deploy and rollback | docs/facebook-photo-review.md |
| Phase 2 reconciliation (31 albums, 399 photos, decisions) | docs/facebook-historical-reconciliation.md |
| Image gate, WAF, cache and costs | docs/facebook-image-cache.md |
| Security headers (CSP report-only) | docs/security-headers.md |
| Security release (2026-11-19) | docs/security-release-2026-11-19.md |
| Album discovery and preview mechanics | docs/facebook-album-implementation.md |
| Webhook setup | docs/facebook-webhook.md |
