# Historical Facebook photo review

Status: **built and tested locally on branch `task/historical-photo-review`. NOT deployed.**
Base commit `25687ff`. It needs migration 017 plus a Worker and a Pages deploy, each with owner approval.

## What it does

`/admin/facebook-review` is an admin-only page for deciding, photo by photo, which historical
Facebook photos may be imported. It never imports, moves, hides or deletes anything. It stores
decision labels in D1. The reviewed historical import (on `/admin/facebook`) then imports only
photos labelled **Import**.

### The page

```
┌ Review historical Facebook photos ─────────────────────────────────────────────┐
│ Import 0 · Duplicate/Skip 0 · Review later 0 · Approved, not yet imported 0     │
├──────────────────────┬──────────────────────────────────────────────────────────┤
│ Project albums       │ Schwennson                Compare with [Projects/Schw… ▾]│
│  Schwennson   31·0·0 │ [Mark likely duplicates as Duplicate] [Mark remaining …] │
│  Gibson       19·0·0 │ 22 likely duplicates, 3 possible matches.                │
│  …                   │ Facebook photos                  │ Website gallery       │
│ Unsorted uploads     │ ┌──────┐ ┌──────┐ ┌──────┐       │ ┌────┐ ┌────┐ ┌────┐  │
│  Mobile uploads 91   │ │photo │ │photo │ │photo │       │ │site│ │site│ │site│  │
│ Branding (never)     │ │Likely│ │      │ │Poss. │       │ └────┘ └────┘ └────┘  │
│  Profile pictures    │ │dup(2)│ │      │ │(8)   │       │                       │
│                      │ │[Dup][Import][Later]  …         │                       │
└──────────────────────┴──────────────────────────────────────────────────────────┘
```

- **Albums.** Albums are listed in three groups, each with its photo count, how many are reviewed, and how many are already on the website:
  - **Project albums.**
  - **Unsorted uploads.** Generic albums such as Mobile uploads. They are compared with **all** website galleries by default; a photo marked Import there gets its project in the import step.
  - **Branding.** Profile and cover pictures. Shown read-only; they are never imported.
- **Compare with.** The gallery on the right defaults to the album's existing mapping, then to the suggested match. Name matching includes spelling hints such as "Pfafe" → Pfaffe House, and **both** category copies of a project. You can also choose any manual gallery, a Facebook project (for example Ganz Garage), "All website galleries" or nothing. The choice is remembered per album in your browser only.
- **Likely-duplicate badges.**
  - The page fingerprints every image in your browser using the same perceptual hash as the Phase 2 analysis.
  - "Likely duplicate" means 5 bits or fewer apart; "possible match" means 6–10. The distance is shown on the badge.
  - The badge's thumbnail jumps to and highlights the matching website photo.
  - Fingerprints are hints: crops or heavy edits may not match. Always look before deciding.
- **Decisions.**
  - Each Facebook photo has **Duplicate / Skip**, **Import** and **Review later**. Clicking the active choice clears it.
  - Decisions save automatically (batched, retried on failure). "Duplicate" also records which website photo it duplicates.
  - Photos already imported, and branding photos, have no buttons.
- **Bulk actions** apply only to *unreviewed* photos in the open album and need a second click to confirm:
  - *Mark likely duplicates as Duplicate*
  - *Mark remaining unreviewed as Import*
  - *Mark remaining unreviewed as Review later*

## Import rules (per-photo exclusion)

`reviewGate` in `workers/kilcon-gallery-worker/src/facebook-review.js` runs in `importPhoto`, the
single entry point for every import path. It also runs earlier in the webhook and discovery
paths, so no project is created for photos that are all excluded. The gate always runs **before**
the D1 claim: an excluded photo leaves no row and no R2 object behind, so it can be imported later.

| Decision | History import (`Import history`, legacy backfill) | Webhook, reconciliation, retries |
|---|---|---|
| **Import** | imported | imported |
| **Duplicate / Skip** | excluded | excluded (always) |
| **Review later** | excluded | excluded if the photo is older than the cutoff |
| none (unreviewed) | excluded | excluded if the photo is older than the cutoff; newer photos import as before |

- **Cutoff.** `FB_HISTORY_REVIEW_CUTOFF = "2026-11-15T00:00:00Z"` in `wrangler.toml` marks photos as historical. This closes a gap: a webhook *edit* of an old post previously imported that post's photos with no review.
- **Idempotent.**
  - Photo IDs are unique, and claims and leases are unchanged.
  - Re-running the history import imports nothing twice.
  - Photos approved later are picked up by the next run.
- **The dry-run preview mirrors the gate.** Unapproved photos show as `excluded` with reason `review-unreviewed`, `review-later` or `review-skip`, so the preview counts are the real import counts.
- **Migration 017 not applied.** Then history imports exclude everything (they fail closed), while live imports of new photos continue.

## Security

- **Admin only.** Every endpoint is under `/api/gallery-api/facebook/admin/review-*` behind `requireAdmin`; the cookie is `SameSite=Strict`. Decisions also require a JSON content type.
- **The Page token never leaves the Worker.** It is sent to Graph in a header. The browser receives only photo IDs and image bytes proxied through the Worker, with `private, max-age=3600` and `nosniff`. No Graph or CDN URL reaches the page.
- **Image proxy.** It only fetches Page-owned photos (`from` = Page) from Facebook CDN hosts. It checks the content type (JPEG, PNG or WebP), caps size at 8 MB, and uses no redirects.
- **Website images.** Only manual project galleries (`Projects/`, `New Construction/`, `Remodels/`, `Furniture/`) are listed or served. Reviews, Facebook, Highlights and Apparel are refused, as are traversal and non-image keys.
- **The page builds DOM nodes only.** There is no HTML string injection.

## Endpoints

| Endpoint | Purpose |
|---|---|
| `GET review-albums` | Page albums (kind, count, suggestions, mapping, decision and import counts), plus gallery targets |
| `GET review-album?id=&after=` | 50 photos per page, with decision and import state; verifies album and photo ownership |
| `GET review-image?id=` | Small Facebook rendition (≥ 320 px), proxied |
| `GET review-site-gallery?prefix=` / `?all=1` / `?project=` | Manual gallery keys, or a Facebook project's photo IDs |
| `GET review-site-image?key=` | Website image, resized to 400 px with the Images binding (falls back to the original) |
| `POST review-decisions` | Up to 100 `{photoId, albumId, decision: import\|skip\|later\|clear, duplicateOf?, note?}`; validated as a whole batch before writing |
| `GET review-summary` | Counts per decision and "approved, not yet imported" |

## Tests (local)

- **Worker:** 157/157, including 12 new tests in `test/facebook-review.test.mjs`:
  - history gating, idempotent and concurrent runs;
  - the webhook edit of an old post;
  - newer posts and skip overrides;
  - the missing migration;
  - authentication and the integration switch;
  - every endpoint, including SSRF, ownership, traversal, content type, batch validation and token leakage.

  Disabling the gate makes 5 of them fail. The existing history tests now approve their photos first.
- **Site:** 58/58, including `photo-hash.test.mjs` (5) and `facebook-review-page.test.mjs` (9).
- **TypeScript and build:** `tsc --noEmit` reports 0 errors, and `astro build` passes.
- **Not verifiable locally:** the interactive page against real data. The Page token exists only in production, and no browser was connected. Check the UI after deployment.

## Deploy (needs approval)

1. **Migration:** `npx wrangler d1 migrations list kilcon-db --remote`. If only 017 is pending, `npx wrangler d1 migrations apply kilcon-db --remote`. It is additive (one new table).
2. **Worker:**
   - `versions upload --tag <commit>`, then `versions deploy <id>@100%`. Do **not** run `triggers deploy`, so the image route stays Fail closed.
   - Live effect: webhook edits of posts created before 2026-11-15 no longer import unreviewed photos. New posts are unchanged.
3. **Pages:** merge to `main`. This adds the review page, the "Review photos" link and the import hint.
4. **Verify:**
   - Endpoints return 401 without a session.
   - Signed in, `/admin/facebook-review` lists 31 albums; a project album shows photos, fingerprints and badges; a decision persists after reload.
   - A dry-run preview shows unreviewed photos as excluded.
5. **Rollback:**
   - Worker: `wrangler rollback 1494935c-6fae-419f-bc87-0b4f66456a93`.
   - Pages: roll back to `bd120cd6`.
   - Migration 017 and saved decisions can stay; the old code ignores them.

**Cost of a full review** (399 Facebook photos, every website gallery):

- About 400 image-proxy requests, each one Graph call plus one CDN fetch.
- About 330 website thumbnails, each one R2 read plus one image transformation (about 330 unique this month).
- Repeat views come from the browser cache for an hour.

All of this is within the Free plan.
