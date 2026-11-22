# Facebook integration: final deployment plan

Status: **ready for approval; not deployed.** Branch `task/facebook-integration-final`, local and
not pushed. Deploy only when the owner confirms no historical import is running.

## What ships together

| Change | Where it's documented |
|---|---|
| **Website galleries as import destinations.** Import Approved Photos lists every Projects, New Construction, Remodels and Furniture folder, grouped by category. On confirm it creates or reuses the link (no duplicate images or galleries). | docs/facebook-photo-review.md, *Importing into existing website galleries* |
| **Caption hashtags** `#project` `#newconstruction` `#remodels` `#furniture` `#highlight`, plus migration 018 | docs/facebook-hashtags.md |
| **Create New Gallery** in Import Approved Photos. It checks existing galleries first: an exact match is refused and selected instead; a similar name needs "Create anyway". It needs a confirmation, and the new gallery stays off the site until photos are imported. | docs/facebook-photo-review.md, below |
| **Automatic galleries for new posts, with holds:** a distinctive new album creates its gallery; an exact-name album joins the existing one; similar or vague albums, captions naming several galleries, and finished-job posts without an album are **held for review** instead of being guessed. | docs/facebook-webhook.md §3 |

**Unchanged:**
- **Flags:** `FB_REVIEWED_IMPORT_ENABLED=true`, `FB_HISTORICAL_IMPORT_ENABLED=false`,
  `FB_DISCOVERY_ENABLED=false`, `FB_AUTO_IMPORT=true`.
- **Bindings, secrets, routes and cron:** the Worker is deployed with `versions upload` and
  `versions deploy` only.
- **Data:** album mappings, gallery categories, review decisions, duplicate protection and
  mixed-album behaviour.

**Tests on the branch:**
- site 90/90 and Worker 201/201;
- `tsc` 0 errors (the Manage Images script is also clean under `--strict`);
- `astro build` and the Worker bundle succeed, keeping the three flags above;
- mutation checks: the live-only tag rule, the album-hold rule, and the duplicate-gallery check
  each fail their tests when broken;
- a browser harness run for the destination dropdown, the website-gallery import and Create New
  Gallery.

**Behaviour changes to know about:**
- A finished-job post with no album used to create a gallery named after its caption's first
  sentence. Now it's held, with that sentence offered as a suggestion.
- A new album named like an existing website gallery used to create a duplicate gallery (for
  example `lake-house-2`). Now it joins the existing one.

## Migration 018

**What it does.** It adds `facebook_photos.highlight` and `highlight_locked`: integers, `NOT NULL
DEFAULT 0`, with a 0/1 check. It's additive, so older code ignores it.

**Checked 2026-11-22, read-only:**
- it's the only pending migration, and production has no `highlight` columns;
- applied to a local copy of production's exact `facebook_photos` definition, it gives existing rows
  `0/0`, and the check rejects bad values;
- no production caption or post contains a control tag, so nothing changes retroactively.

**Backup.** Record a D1 Time Travel bookmark immediately before applying it.

**Rollback.** Leave 018 in place; the previous code ignores it. Restoring D1 to the bookmark is a
last resort only, because it would also undo imports and decisions made after it.

## Order (each step is verified before the next)

0. **Preflight:**
   - the owner confirms no import is running;
   - `git fetch` (owner commits), and the README PR #2 branch is unchanged;
   - Worker = `fc198011`, Pages = `e828a3b5`;
   - a per-table D1 snapshot;
   - 122/122 production checks.
1. **D1 bookmark:** `wrangler d1 time-travel info kilcon-db`, and record it.
2. **Migration:** `wrangler d1 migrations apply kilcon-db --remote` (applies only 018).
   - `pragma_table_info` shows both columns.
   - The snapshot diff shows only the new columns (all 0).
   - The production checks still pass. The current code ignores the columns.
3. **Worker:**
   - merge `task/facebook-integration-final` into `main` (fast-forward), local only;
   - `wrangler versions upload`;
   - `versions view` diff against `fc198011`: **only the tag may differ**, with the same
     bindings, secrets and flags;
   - `versions deploy <id>@100%`.
4. **Pages:** `git push origin main`, which deploys the review page (destinations, Create New
   Gallery, held notes) and the Manage Images Highlights buttons. Wait for the build.
5. **Validation:** nothing is created and no category changes. Every step below is read-only, or
   a dry run.
   - Production checks; the new endpoints (`gallery-create`, `import-plan`, `import-run`)
     return 401 signed out, and form posts return 415.
   - **D1 snapshot diff:** projects, mappings, decisions and categories are unchanged.
   - **Highlights:** `?list=highlights` shows the manual images, unchanged.
   - **Owner, signed in, in Import Approved Photos:** the dropdown lists website galleries by
     category, and the destination check names a website gallery.
   - **Create New Gallery:** "Check name" on an existing name, for example "Ganz Garage",
     reports it exists. Don't create one during validation.
   - **Don't use Add to Highlights during validation:** it permanently locks that photo's
     choice.
6. **README:** push `f8e2b46` to the PR #2 branch (no force), mark it ready, and merge.
7. **First real use:**
   - the contractor's next post into a new named album creates its gallery, in the tagged
     category;
   - an ambiguous post appears on the review page as held.

**Rollback:**
- **Worker:** `wrangler versions deploy fc198011-3d43-4be5-af96-dcf691da44fc@100%`.
- **Pages:** `e828a3b5`.
- **Migration 018:** stays.
- **Held review rows:** these are ordinary Review later decisions, which the owner can clear or
  change.

## After this: automatic discovery (separate approval)

Enable `FB_DISCOVERY_ENABLED`:
- **Webhooks stay the primary trigger:** with discovery on, events go through the discovery
  engine.
- **Fallback:** the hourly cron adds a bounded reconcile scan with a future-only cutoff, fixed at
  its first run.
- **Rules:** the same album rules and holds apply. Branding is excluded, and tests cover it.
- **Verify:** the subscription, retries, album-only additions, removals and holds.
