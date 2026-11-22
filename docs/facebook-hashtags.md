# Facebook caption hashtags: spec and status

Status: **implemented and tested locally on branch `task/facebook-hashtags` (uncommitted); not
deployed.**
- **Highlights** need D1 migration 018 (additive).
- **Category tags and caption hiding** work without it.

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

## Deploy (needs approval)

1. Record a D1 bookmark, then apply migration 018 to `kilcon-db`.
2. **Worker:** `versions upload`, then a bindings diff, then `versions deploy`.
3. **Pages:** deploy the Manage Images buttons.
4. Run the production checks.
5. **Owner test:** a new post tagged `#highlight` appears in the homepage Highlights.

**Rollback:** redeploy the previous Worker and Pages versions. Leave migration 018 in place;
older code ignores it.
