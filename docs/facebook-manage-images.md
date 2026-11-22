# Facebook galleries in Manage Images

Status: **deployed 2026-11-22**: Pages `584403a7` (`bd707ef`), Worker `93b9f92b` (flags unchanged). Signed in, the owner's browser shows Ganz Garage with 15 of 15 photos visible, all 15 thumbnails loading and selectable, permanent deletion locked, and the 35 manual folders unchanged (`Apparel/Coats/` expands with its 2 files). Production checks: 122/122.
It is Pages-only: the Worker code is unchanged; only Worker tests were added.

## Problem

Ganz Garage (Facebook project 1, 15 photos) did not appear on `/admin/manage`.

- **Cause.** Manage Images lists only manual galleries: the R2 folders under `Projects/`,
  `New Construction/`, `Remodels/`, `Furniture/` and `Highlights/`, read from
  `GET /api/gallery-api?all=1`.
- **Facebook galleries are different.** They are D1 rows (`facebook_projects` /
  `facebook_photos`), and all their files sit flat under `Facebook/<photoId>.<ext>` in R2.
  So there is no folder to list.
- **Correct behaviour.** The Worker's manual-folder endpoints (`delete`, `delete-project`,
  `rename`, `rename-prefix`, `list-images`) refuse any key outside the manual roots. So
  Facebook files could never be managed as folders, and must not be.

## What changed

`/admin/manage` now has two sections. **Manual galleries (R2 folders)** is unchanged.
**Facebook galleries** is new and is built from the existing Facebook admin API:

| Action | Endpoint (admin cookie required) | Rules |
|---|---|---|
| List galleries | `GET /facebook/admin/overview` | Badge **Facebook** or **Facebook · Recent updates**. Shows the category, visible/total counts, and where it appears: a public page, inside a linked manual gallery, hidden, or not shown yet. Includes a link to *Gallery settings* on `/admin/facebook`. |
| Photos | `GET /facebook/admin/photos?projectId=` | Thumbnails come from the private `photo-file` path only (any other URL is dropped). States: Visible, Hidden, Removed on Facebook, Import failed, Permanently deleted. |
| Hide / Restore | `POST /facebook/admin/photo-update {hidden}` | Only the photos the action would change are sent. Photos removed on Facebook or deleted can't be restored, which the Worker enforces too. |
| Move | `POST /facebook/admin/photo-update {projectId}` | Destinations are the other Facebook galleries. A moved photo is `project_locked`, so sync never moves it back. |
| Permanent deletion | `POST /facebook/admin/purge {photoIds, confirm}` | The button stays disabled until `PERMANENTLY DELETE` is typed, followed by a browser confirmation. Batches of 50. The Worker requires the same phrase. |

Names, categories, new galleries and linking a gallery to a manual folder stay on
`/admin/facebook`.

**Safety:**
- The Facebook section has its own list and checkbox class (`mf-select`). The manual
  *Delete selected* only reads checkboxes inside the manual list.
- All text goes in `textContent`. The section talks only to same-origin admin endpoints.
- It hides itself when the integration is switched off (the endpoint returns 404).
- CSS classes use the `mf-` prefix, so the existing `/admin/facebook` styles (`fb-*`) are
  untouched.

## Files

- `src/lib/manage-facebook.js`: pure helpers (gallery cards, photo states, action targets, move
  targets, purge phrase, safe preview paths).
- `src/pages/admin/manage-facebook.ts`: the section's DOM and actions.
- `src/pages/admin/manage.astro`: the new section and script; the admin check is unchanged.
- `src/styles/admin.css`: additive `mf-*` rules.

## Tests

- **`tests/manage-facebook.test.mjs` (7 site tests):**
  - helper logic;
  - the purge phrase and batch limits match the Worker;
  - preview URLs are restricted;
  - the page stays admin-only;
  - the lists are separate;
  - only Facebook admin endpoints are called;
  - no HTML parsing.
- **`workers/kilcon-gallery-worker/test/facebook.test.mjs` (2 new tests), against real local D1/R2:**
  - the page helpers drive hide, restore, move and purge end to end;
  - `?all=1` never lists a Facebook folder;
  - every manual R2 endpoint refuses `Facebook/` keys in both directions, and storage stays unchanged;
  - all four actions require the admin cookie.
- **Browser check (local harness, mocked API, 360 px wide):**
  - 3 gallery cards and 15 photo tiles render, with no horizontal overflow;
  - Hide sends only the visible photo;
  - Move sends the chosen gallery;
  - deletion stays disabled until the exact phrase is typed;
  - search filters Facebook galleries;
  - the outcome message stays visible after the reload.
- **Totals:** site 80/80, Worker 170/170, `tsc` 0 errors (the new script is also clean under
  `--strict`), `astro build` OK.

## Rollback

Pages `02aaaf2a`; Worker `npx wrangler versions deploy 8c893925-6546-41fd-ad68-16e056de7d39@100%`.
