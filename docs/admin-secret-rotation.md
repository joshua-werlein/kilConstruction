# ADMIN_SECRET rotation: Pages, kilcon-site, Gallery Worker

Status: **prepared; nothing changed.** Each production step needs the owner's approval.

## Why

`ADMIN_SECRET` signs the `admin_auth` cookie (`src/utils/adminToken.ts`, HMAC-SHA256, 7-day
token, `ver` = `SESSION_VERSION`). **Three places verify that cookie, and all three must hold the
same value:**

| Where | Uses it for |
|---|---|
| Pages project `kilconstruction` (live Astro 5 site, rollback target after cutover) | signing in at `/admin` and every admin page |
| `kilcon-site` Worker (Astro 7, staged, unrouted) | the same, after cutover |
| `kilcon-gallery-worker` | every admin call to `/api/gallery-api/*`: Manage Images, upload, Facebook review and import |

The owner doesn't know the production value, and Cloudflare can't show it. The repo's
gitignored `.env` does contain an `ADMIN_SECRET`, but that file is a **local development**
config: it also holds Cloudflare's test Turnstile key and a `127.0.0.1` contact endpoint. So it
can't be trusted to be the production value.

**`SESSION_VERSION` stays `"3"` everywhere.** A new secret already invalidates every existing
session. Changing the version as well would add a fourth place to get wrong.

## Effects

- **Admin sessions:** everyone signed in is signed out once and signs in again with the
  unchanged username and password.
- **Public pages** are unaffected. Contact, reviews, galleries, apparel and Facebook webhooks
  don't use this secret.
- **Short gap:** from the Gallery Worker change until Pages runs its new deployment, gallery
  administration on the live site answers 401. Steps 3 and 4 are therefore back to back.

## How the value is entered

The owner runs `scripts/set-admin-secret.ps1 -Target <site|pages|gallery>` in their own
PowerShell window:
- **Hidden entry:** the value is typed twice into hidden prompts, at least 32 characters with
  no spaces, and piped to Wrangler on stdin. It never appears on screen, in shell history, in
  logs or in chat.
- **Same value each time:** paste one value, generated and kept in a password manager, for every
  target.
- **After each target:** tell Claude "done: site", "done: pages" or "done: gallery", and never
  the value.

## Sequence (each step needs approval at the time)

0. **Preflight (Claude, read-only):**
   - the Gallery Worker's deployed version equals its latest uploaded version (`0c251687` on
     2026-11-22). `secret put` builds the new version from the latest uploaded one, and Claude
     checks again just before the change.
   - the Pages live deployment is `449b7a41` (commit `9ac0524`, Astro 5);
   - production checks pass.
1. **`site`** (owner): `kilcon-site` is unrouted, so nothing changes for visitors. The owner
   also sets `ADMIN_USER` and `ADMIN_PASS` there (see docs/astro7-migration.md).
2. **`pages`** (owner): the Pages secret is stored, but **it takes effect only on the next Pages
   deployment**, so nothing changes yet.
3. **Pages redeploy** (Claude): retry deployment `449b7a41`, which rebuilds **commit `9ac0524`**
   (Astro 5) with the new secret.
   - **Don't use any other method.** `main` is now Astro 7, and automatic production builds are
     paused, so neither a push nor a new build from `main` may be used.
   - Claude confirms that the new deployment's commit is `9ac0524`, it succeeded, and it is
     now canonical.
   - If the retry fails or builds anything else, stop. `449b7a41` stays live, and the old
     secret still matches the Gallery Worker.
4. **`gallery`** (owner, immediately after step 3): a new Gallery Worker version with the same
   code and bindings goes live at once.
   - **Claude checks:** the deployed version changed only in its secret (diff against
     `0c251687`), the routes are unchanged, and the Facebook health check is ok.
5. **Verify (owner signs in, Claude checks):**
   - **Live Pages site:** at `https://kilcon.work/admin`, sign in, then check that Manage Images
     lists galleries (Gallery API 200), Upload, the Facebook review page and Import Approved
     Photos load, and an apparel save works.
   - **Staged `kilcon-site`:** sign in on its temporary `workers.dev` URL, and check that the
     admin pages load. Gallery administration there can only be fully checked after cutover,
     because its admin pages call the same-origin `/api/gallery-api`.

## Rollback

- **Old value:** the previous value is unknown, so it can't be put back. Rollback means
  **setting a new value on all three again** with the same script.
- **Pages:** if step 3 fails, `449b7a41` stays live with the old secret. Don't run step 4. The
  site keeps working on the old value until a retry succeeds.
- **Gallery Worker:** a new secret creates a new version. `wrangler versions deploy
  0c251687…@100%` restores the old secret along with the old version, so it is a real rollback
  for step 4, provided Pages also still has the old value.
