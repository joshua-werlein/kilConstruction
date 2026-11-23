# Facebook integration: final deployment plan

Status: **deployed 2026-11-22** (Worker `a97a5c14`, Pages `c3148851`, then `388e94dd` with the README). Branch `task/facebook-integration-final`, merged and
deleted. It was deployed while the owner had paused historical imports. See docs/RESUME.md for the verification results.

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
6. **README:** push `f8e2b46` and `2e80705` to the PR #2 branch (no force), mark it ready, and merge.
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

## Phase D: automatic discovery, staged rollout (approved 2026-11-22; paused at preflight)

**Preflight results (2026-11-22 21:58 UTC):**

| Check | Result |
|---|---|
| Live Worker `a97a5c14`: flags | `FB_DISCOVERY_ENABLED=false`, `FB_HISTORICAL_IMPORT_ENABLED=false`, `FB_REVIEWED_IMPORT_ENABLED=true`, `FB_AUTO_IMPORT=true` |
| Discovery jobs | **0** rows, so the first scheduled run creates the reconcile job and records its cutoff |
| Photos | 115, all `imported`; none mid-import |
| Review decisions | 113 Import, 226 Skip; 6 Import-approved photos in 2 albums are not imported (see below) |
| Production checks | 146/146 |
| Webhook token, `feed` subscription, album and photo read access | **Not verified.** The admin session in the agent's browser had expired. This is the blocker. |

**How the cutoff works (code-reviewed):**
- **When it's set.** The first scheduled `reconcile` run creates its job with `cutoff = that run's
  time`. Every photo created before it is skipped (`outside-cutoff`), so historical Mobile uploads
  are never imported. A restart keeps the cutoff, and it never widens.
- **Line up the activation with the next cron run** (`17 * * * *`), so the cutoff is within a
  minute or two of the activation. Webhooks cover new posts between the two.
- **Removals:** the scheduled scan's removal re-check never hides a photo because Graph reports
  it unavailable. It needs an explicit unpublish or hide (`confirmUnavailable` with
  `hasRemovalEvent=false`).
- **Unchanged webhook behaviour:** an edit event for an old post the site never imported is
  historical. It can import only photos with an Import decision. 6 such photos exist, in albums
  `122150124368318503` and `122130061988318503`. Mark them Duplicate / Skip or Review later if
  they should never import.

**Procedure, once the owner is signed in:**
1. **Health check, signed in** (`GET /facebook/admin/health`): the token is `ok`, `feedSubscribed`,
   no errors. `review-albums` and `review-album` list albums and photos.
2. **D1 bookmark:** `wrangler d1 time-travel info kilcon-db`.
3. **Stage:** `wrangler versions upload --var FB_DISCOVERY_ENABLED:true`, then a bindings diff
   against `a97a5c14` (only that variable and the tag may differ), then `versions deploy <id>@100%`.
   Do this at about :15.
4. **After the :17 run:**
   - a `reconcile` job row exists, and its `state.cutoff` is that run's time;
   - status `pending` or `complete` with no `last_error`;
   - the photo count is unchanged, with no new Review later holds;
   - `facebook_albums` is filled in;
   - production checks;
   - `GET health` shows `albumAccess` / `albumPhotoAccess` `ok`.

   The first full scan spans several hourly runs, at 20 Graph calls each, which is within Free-plan
   limits.
5. **Make it permanent:** set `FB_DISCOVERY_ENABLED = "true"` in `wrangler.toml` and commit with
   `[CF-Pages-Skip]`. Then `versions upload`, a diff against the staged version (only the tag may
   differ), then `versions deploy`.
6. **Real-world checks:** the contractor's next posts. A new named album creates its gallery in
   the tagged category, `#highlight` appears on the homepage, an ambiguous post is held, and
   duplicates and retries don't re-import.

**Rollback:**
- **Worker:** `wrangler versions deploy a97a5c14-1f3d-40ca-ae73-773a33a4db93@100%` (discovery off).
- **The reconcile job row** can stay; it's ignored while discovery is off.
- **D1 bookmark:** a last resort only.

### Phase D result: automatic discovery ENABLED (2026-11-22/23)

**Schedule (owner request):** reconciliation runs twice daily, at **12:00 and 18:00 America/Chicago**,
and daylight saving time is handled through `Intl`.
- **When it actually runs:** the existing hourly cron (`17 * * * *`) fires inside each slot hour,
  so runs start at 12:17 and 18:17 local time, at most once per slot (`discovery_last_slot`).
  Cron triggers were **not** changed, so there was no `triggers deploy` and no route risk. A
  minute-0 trigger can be added in the dashboard later without a code change.
- **Webhooks stay immediate.** Retention, retries and stale-import recovery still run every hour.

**Cutoff:** recorded at activation through `POST /facebook/admin/discovery-start`:
**`2026-11-22T22:53:16.402Z`**, 3 s after the switch went on. It never moves.

| Step | Result |
|---|---|
| Signed-in health (before) | token ok, `feed` subscribed, secrets present, albums (31) and album photos listed |
| D1 bookmark | `00000709-00000000-0000512b-2528ca732fdd6680e6e0a5031f3b6e65` (22:51 UTC) |
| Schedule code, discovery off | Worker `5d25e58b` (`e8c3cdd`); the diff showed only the tag changed; 146/146 checks |
| Staged on | Worker `c0c60d43` (`--var FB_DISCOVERY_ENABLED:true`, only that variable changed) at 22:53:13; cutoff recorded; health `albumAccess` / `albumPhotoAccess` ok |
| 23:17 UTC (17:17 CST) tick | no scan (no slot, no albums read); job untouched |
| 00:17 UTC (18:17 CST) slot | scanned; slot `2026-11-22 18:00 America/Chicago`; 10 albums read; status pending, no error. Photos (115), decisions (339), galleries (19) and mappings (20) unchanged: nothing historical imported or held |
| Permanent | `wrangler.toml` `FB_DISCOVERY_ENABLED = "true"` (`5b0da7f`); Worker `0c251687`, only the tag differed from `c0c60d43`; deployed 00:33:58 UTC; 146/146 checks; D1 unchanged; health ok |

**Rollback:** `wrangler versions deploy 5d25e58b-e0f1-4708-85b5-a9adb8472f6e@100% --config workers/kilcon-gallery-worker/wrangler.toml` (same code, discovery off).

**Still to see in real use:**
- the first full pass completing over several slots (20 Graph calls per run);
- a missed or album-only photo being found;
- the contractor's next posts: new gallery, category tag, `#highlight`, an ambiguous hold;
- a retry after a Graph error.
