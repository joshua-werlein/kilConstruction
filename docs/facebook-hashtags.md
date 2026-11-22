# Facebook caption hashtags: spec and status

Status: **implemented and tested locally on branch `task/facebook-hashtags` (uncommitted); not
deployed.**
- **Highlights** need D1 migration 018 (additive).
- **Category tags and caption hiding** work without it.

## For the contractor: caption hashtags

Hashtags are **optional**. Posting to the KIL Construction Facebook Page works exactly as before,
and new photos still appear on the website automatically. Add a tag only to fine-tune where
a post goes. You can put it anywhere in the caption, in capitals or lower case.

| Tag | What it does |
|---|---|
| `#project` | A post that starts a new gallery puts it under **Projects**. That's also the default with no tag. |
| `#newconstruction` | A post that starts a new gallery puts it under **New Construction**. |
| `#remodels` | A post that starts a new gallery puts it under **Remodels**. |
| `#furniture` | A post that starts a new gallery puts it under **Furniture**. |
| `#highlight` | The photos also appear in the **homepage Highlights**, as well as in their gallery. |

**Good to know**
- **What starts a new gallery:** posting photos into a new named Facebook album, or a finished-job
  post with 3 or more photos (for example "finished", "completed", "before & after").
- **Everyday progress posts** still go to *Recent Project Updates*; a tag doesn't change that.
- **Existing galleries:** a tag never moves or renames one, and never changes its category.
- **Combining tags:** use only one of the four category tags per post. With two, for example
  `#remodels #furniture`, both are ignored. `#highlight` can go with any of them.
- **Hidden on the website:** these five tags don't appear in captions there. Other hashtags (for
  example `#DeckLife`) show as written.
- **Highlights later:** you can add `#highlight` by editing a post's caption afterwards, or remove it
  the same way.
- **The website owner always has the final say:** any gallery, category or Highlights choice
  made on the website stays as it is, whatever later posts say.
- **Old posts** already brought in through the historical review aren't affected by tags.

Example: `Finished the Bisek pole barn! #newconstruction #highlight`

## Owner decisions (2026-11-22)

1. **Category tags** set the category **only when a new post creates a new gallery**. A post that
   joins an existing gallery never changes that gallery's category, so admin choices win.
   - `#project` / `#projects` → `projects`
   - `#newconstruction` → `new-construction`
   - `#remodel` / `#remodels` → `remodels`
   - `#furniture` → `furniture`

   Two different category tags in one caption are ignored; nothing is guessed. Tags never force
   a gallery: a post that would go to Recent Project Updates still does.
2. **`#highlight` / `#highlights`** also adds the post's photos to the homepage Highlights. They
   stay in their gallery too. An admin can add or remove a photo on `/admin/manage`, and that
   choice is locked: tags never override it.
3. **Captions on the website:** the control tags above are hidden. Other hashtags and all other
   text are shown as written.
4. **Scope:** the tags apply to new posts and to edits of posts already on the site. Historical
   imports (Import Approved Photos, targeted import, the full historical scan) ignore them.

## Implementation

**Parser.** `src/facebook-hashtags.js` provides `parseControlTags` and `stripControlTags`.
- A tag must start a word: `email#project`, `##project` and `&#project` don't count.
- Look-alikes such as `#projectmanager` are ignored.

**Migration.** `migrations/018_facebook_highlights.sql` adds `facebook_photos.highlight` and
`highlight_locked` (0/1, default 0). It is additive; older code ignores it.

**Live paths only.** `liveTags(message, reviewMode)` returns no tags unless
`reviewMode === "live"`.
- `ingestPost`, then `assignProject`, passes the category to `createProject` for album rule 2
  and completed-build rule 4.
- Discovery's album-create branch does the same.
- `importPhoto` sets `highlight = 1` after the commit when the live context has `#highlight`.

**Edits.** In `refreshPostText` (an edit of a post already on the site), `highlight` follows the
tag on that post's photos where `highlight_locked = 0`. The category is not re-applied.

**Displayed text.** `stripControlTags` is applied to each photo description and to the gallery
description taken from the post. Admin description overrides are shown exactly as typed.

**Highlights.** `listFacebookHighlights` returns visible photos only (`VISIBLE_PHOTO_SQL`), with
gated `/Facebook/w/480/` thumbnails, newest first, at most 60. They are appended after the manual
`Highlights/` images in `?list=highlights`.

**Admin.**
- `photo-update {highlight: true|false}` sets `highlight_locked = 1`. It returns 409 before
  migration 018.
- `photos` returns `highlight` and `highlightLocked`.
- Manage Images has **Add to Highlights** / **Remove from Highlights** and a ★ Highlight label.

**Without migration 018:**
- imports, category tags and caption hiding work;
- Highlights lists only the manual images;
- the admin highlight action returns 409.

`test/facebook.test.mjs` runs without 018 on purpose, to prove this.

## Tests

- **Parser:** 3 tests (`test/facebook-hashtags.test.mjs`).
- **Behaviour:** 5 tests in `test/facebook-review.test.mjs`, which runs with migration 018:
  - **new galleries:** a new gallery gets the tagged category; existing galleries are unchanged;
    conflicting tags are ignored; no duplicate galleries;
  - **completed builds:** a completed-build post uses its tag, while an untagged progress post
    still goes to Recent;
  - **Highlights:**
    - on and off through caption edits;
    - the admin lock in both directions;
    - hidden photos excluded;
    - gated thumbnails;
    - input validation;
    - the admin listing fields;
  - **historical imports:** the targeted import ignores tags, which are still hidden in the
    caption;
  - **the full historical scan** ignores tags. This is mutation-checked: making the tags apply
    to historical content fails it.
- **Fail-soft:** 1 test, without migration 018.
- **Manage Images:** the helper tests were updated for the Highlights actions.

## Deployment and validation plan (needs approval; not while the owner is importing)

**Ready:**
- Branch `task/facebook-hashtags`, commit `df4e677`, based on `main` `c2d3dd7`.
- Site 86/86, Worker 192/192, `tsc` 0 errors (strict on the Manage Images script), build OK.
- The Worker bundle keeps `FB_REVIEWED_IMPORT_ENABLED="true"`, `FB_HISTORICAL_IMPORT_ENABLED="false"`
  and `FB_DISCOVERY_ENABLED="false"`.

**Migration 018 checks (2026-11-22, read-only):**
- It's the only pending migration, and production has no `highlight` columns yet.
- Applied to a local copy of production's exact `facebook_photos` definition, it gives existing rows
  `highlight = 0` and `highlight_locked = 0`, and the 0/1 check rejects bad values.
- It's an additive `ADD COLUMN` with defaults, so the change is quick.
- **Unrelated pre-existing issue:** a fresh local chain of all migrations fails at
  `012_order_items_snapshot.sql`, an apparel-orders migration that production applied long ago.

**Order.** Each step is verified before the next:

0. **Preflight:**
   - the owner confirms no import is running;
   - `git fetch` (owner commits);
   - Worker status = `fc198011`;
   - a per-table D1 snapshot;
   - the production checks.
1. **D1 backup:** `wrangler d1 time-travel info kilcon-db`, and record the bookmark.
2. **Migration:** `wrangler d1 migrations apply kilcon-db --remote` (applies only 018).
   - **Verify:** `pragma_table_info` shows both columns.
   - **Verify:** every Facebook table is unchanged apart from the two new columns, all 0.
   - **Verify:** the production checks pass. The live code ignores the columns.
3. **Worker:**
   - merge `task/facebook-hashtags` to `main` (fast-forward), locally only, not pushed yet;
   - `wrangler versions upload`;
   - `versions view` diff against `fc198011`: **only the tag may differ**, with the same bindings,
     secrets and flags;
   - `versions deploy <id>@100%`.

   Never `wrangler deploy` or `triggers deploy`, so routes and the cron stay as they are.
4. **Pages:** push `main`, which deploys the Manage Images Highlights buttons. Wait for the
   deployment.
5. **Validation**, with no galleries created and no categories changed:
   - **production checks:** 122 + the new endpoints signed out;
   - `?list=highlights` returns the manual Highlights unchanged, with no Facebook items yet;
   - every gallery and project category is unchanged (D1 snapshot diff); the counts of
     galleries, mappings and decisions are unchanged;
   - public captions are unchanged: no existing caption contains a control tag, which a
     read-only D1 query confirms;
   - the owner's Manage Images shows the new buttons. Add to Highlights is **not** clicked during
     validation, because it locks that photo's choice.
6. **README:** push the reconciling commit to the PR #2 branch, mark it ready, and merge.
7. **First real use (owner):** the next new Facebook post with `#highlight` appears in the homepage
   Highlights. With a category tag, a new album's gallery appears in that category.

**Rollback:**
- **Worker:** `wrangler versions deploy fc198011-3d43-4be5-af96-dcf691da44fc@100%`.
- **Pages:** the previous deployment.
- **Migration 018:** leave it in place; older code ignores it.
- **Restoring D1 to the step 1 bookmark is a last resort.** It would also undo any imports or
  decisions made after it.
