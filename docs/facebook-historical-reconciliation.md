# Historical Facebook album reconciliation — Phase 2 report (2026-11-21)

**Status (2026-11-22):**
- **Imported:** Ganz Garage only (7 approved photos, 15 in total; see docs/facebook-photo-review.md).
- **Duplicates:** the visual duplicate check is done (§10).
- **Remaining:** about 109 importable photos, pending the owner's decisions in §10.
- **Switches:** historical import and discovery remain disabled.

§1–§9 are the original 2026-11-21 analysis.

## 1. Sources

- **Preview:** `kilcon-facebook-album-review-complete (2).json`, schemaVersion 2, status `complete`,
  draft unchanged. It is byte-identical to the two `…-complete.json` reports saved on 2026-11-15
  (SHA-256 `16f0d7ea…`), so the Facebook-side inventory has not changed since then.
- **Website:** a public gallery API inventory and every public original downloaded read-only:
  - 35 manual galleries with 327 images
  - 14 Highlights images
  - 8 Facebook-imported photos

  These total 349 against 351 objects in R2; 2 objects are unlisted, probably folder markers.
- **Visual comparison:** a local 64-bit perceptual hash (dHash, EXIF-orientation corrected) of all
  349 website images. Inside the website set, duplicates sit at Hamming distance ≤ 5 and unrelated
  images at ≥ 16, with nothing in between, so the threshold is reliable for this collection.

## 2. Coverage verification

| Check | Result |
|---|---|
| Albums | **31** (baseline 30, +1) |
| Album pages / post pages | 4 / 9, with no pagination or cursor errors |
| Posts returned / verified | **87 / 87**. Unknown author 0, other author 0. The baseline's "0 verified posts" defect is resolved. |
| Unique photo IDs | **399** (baseline 388, +11) |
| Photos in albums *and* posts / album-only / post-only | 364 / 35 / 0 |
| Photos in more than one album | 0 (album membership sums to exactly 399) |
| Photo album field ≠ listing album | 0 |
| Already imported | **8**: exactly the eight Ganz Garage IDs, all in album "Ganz Garage" (`122234637104318503`) |
| Excluded | **5**: Profile pictures 4, Cover photos 1 |
| New photo IDs | **386** (399 − 8 − 5) |
| Albums needing a decision | 22 |
| Warnings / coverage errors | 0 / 0 |
| ID or filename duplicates against the website | 0. No website file has a Facebook-style name, so **ID matching cannot find duplicates**. |
| Visual duplicates checked by preview | **No** |

## 3. Website-side findings

1. **The same project appears in two categories.** These are deliberate copies; hash distance is ≤ 5.

   | Pair | Duplicated photos |
   |---|---|
   | Schwennson: Projects ↔ New Construction | 22 |
   | Ford Kitchen: Projects ↔ Remodels | 17 |
   | Gibson | 16 |
   | Pfaffe | 14 |
   | Pritchard | 14 |
   | Tyman | 7 |
   | Wheelman: Projects ↔ Remodels | 6 |
   | Loretta | 5 |
   | Riesman | 5 |

   Highlights images are copies of project photos. One file in `Remodels/Ford_Kitchen_Remodel/` is
   duplicated inside the same folder.
2. **The 8 imported Ganz Garage photos match nothing on the site.** The nearest distance is 16–18.
3. **All manual galleries were uploaded 13 Nov – 19 Dec 2025**, when the site was built, and cover
   the same projects as the Facebook albums. Many counts are identical, which strongly suggests the
   manual galleries were built from the same photo sets posted to Facebook, under new IDs.

## 4. Visual duplicates: Facebook ↔ website (blocking item)

The 386 new Facebook images could not be compared. The report has no image URLs by design, the
Page token is a Cloudflare secret, and no browser session was available. **Different Facebook
IDs do not mean different images.** The count evidence below shows heavy overlap is likely.
The website hashes are ready, so the comparison takes minutes once Facebook images are available
read-only:

- **(a) No code change:** the owner exports the Page's photos with Meta's own download tool and
  shares the local folder. CDN filenames usually embed the photo ID; any remaining images can be
  matched by hash and album.
- **(b) Small code change** (needs deploy approval): the dry-run preview adds the smallest image
  rendition URL per photo to the in-browser review report only. `displayText` currently redacts all
  URLs, so the fbcdn image field would need an explicit, validated exception. I download the
  thumbnails locally and compare hashes.

## 5. Per-album reconciliation and recommendation

"Likely new" is the lower bound `max(0, Facebook − largest matching website gallery)`. The upper
bound is the full Facebook count. Visual checking (§4) decides the exact number.

### A. Albums that already have a website gallery: 17 albums, 211 photos

| Facebook album | FB | Website gallery (photos) | Twin in other category | Count | Likely new (min) | Recommended destination | Preview proposal |
|---|---|---|---|---|---|---|---|
| Schwennson | 31 | Projects/Schwennson House (22) | New Construction/Schwennson_House_and_Shop (23) | FB +8 | 8 | Link → **Projects/Schwennson House**; new photos only | Recent ⚠️ |
| Ford kitchen | 20 | Projects/Ford Kitchen (18) | Remodels/Ford_Kitchen_Remodel (17) | +2 | 2 | Link → Projects/Ford Kitchen; new only | link ✓ |
| Gibson | 19 | Projects/Gibson House (16) | New Construction/Gibson_House (18) | +1 | 1 | Link → **Projects/Gibson House**; new only | Recent ⚠️ |
| Pfafe | 19 | Projects/Pfaffe House (14) | New Construction/Pfaffe_House (16) | +3 | 3 | Link → **Projects/Pfaffe House** (spelling); new only | Recent ⚠️ |
| Kiley porch | 17 | Projects/Kiley Enclosed Porch (17) | — | **=** | 0 | Link → Projects/Kiley Enclosed Porch; probably all duplicates | Recent ⚠️ |
| D.Dahl Porch | 16 | Projects/D. Dahl Porch (16) | — | **=** | 0 | Link → Projects/D. Dahl Porch; probably all duplicates | link ✓ |
| Pritchard | 14 | Projects/Pritchard Airplane Hanger (14) | New Construction/… (14) | **=** | 0 | Link → Projects/Pritchard Airplane Hanger; probably all duplicates | Recent ⚠️ |
| Cabinets | 13 | Furniture/Cabinets (13) | — | **=** | 0 | Link → Furniture/Cabinets; probably all duplicates | Recent ⚠️ |
| Wheelman Performance | 9 | Projects/Wheelman_Performance (6) | Remodels/Wheelman_Performance (6) | +3 | 3 | Link → **Remodels/Wheelman_Performance** (the earlier draft chose Remodels) or Projects; new only | Recent ⚠️ |
| Loretta | 9 | Projects/Lorretta_s Shed (5) | New Construction/Loretta's_Shed (5) | +4 | 4 | Link → Projects/Lorretta_s Shed; new only | Recent ⚠️ |
| Kiley Lean-to | 8 | Projects/Kiley Lean-to (8) | — | **=** | 0 | Link; probably all duplicates | link ✓ |
| Kitelinger House | 8 | New Construction/Kitelinger Shell (15) | — | −7 | 0 | Link → New Construction/Kitelinger Shell; probably all duplicates | Recent ⚠️ |
| Cutting boards | 7 | Furniture/Cutting Boards (2) | — | +5 | 5 | Link; new only | link ✓ |
| Tyman | 6 | Projects/Tyman Shop and House Shell (8) | New Construction/Tyman_House_and_Shop_Shell (7) | −2 | 0 | Link → Projects/Tyman…; probably all duplicates | Recent ⚠️ |
| Fox Hollow Retriever | 6 | Projects/Fox_Hollow_Retriever (7) | — | −1 | 0 | Link; probably all duplicates | link ✓ |
| Riesman | 5 | Projects/Riesman Shed (5) | New Construction/Riesman Shed (5) | **=** | 0 | Link → Projects/Riesman Shed; probably all duplicates | Recent ⚠️ |
| Dahl | 4 | Remodels/J&A_Dahl (4) | — | **=** | 0 | Link → **Remodels/J&A_Dahl**, not D. Dahl Porch | Recent ⚠️ |

**Group A:** 211 Facebook photos. Genuinely new photos are **between 26 and 211**; the count
evidence points to the low end. **Do not import Group A until §4 is done**: linking an album to a
manual gallery adds every Facebook photo to that gallery's page, which would show duplicates
side by side.

### B. Albums with no website gallery: 11 albums, 84 photos

| Facebook album | Photos | Recommendation |
|---|---|---|
| Bisek | 15 | New project "Bisek" (owner: name/category) |
| Pongratz | 13 | New project "Pongratz" |
| Jsme | 13 | New project; **owner to supply a display name** ("Jsme" is unclear) |
| Rieck Deck | 12 | New project "Rieck Deck" (preview proposal: create). The name-match to Ganz Re-Deck is spurious (shared word "deck"). |
| Ganz Garage (new 7) | 7 | Existing Facebook project Ganz Garage (ID 1), as proposed. Visually check them against the 8 already imported. |
| Ganz | 7 | Older, separate album (`122153213372318503`). Probably the deck job: link → **Projects/Ganz Re-Deck** (1 photo) after a visual check. Owner to confirm. |
| Home | 7 | **Hold**: generic name. Owner to identify; exclude if not a client project. |
| E. Fankhauser | 3 | Merge with "Fankhauser" into **one** new project (5 photos), if it is the same client |
| Fankhauser | 2 | See E. Fankhauser |
| Zingshiem | 3 | New small project, or Recent Project Updates |
| Ripley | 2 | New small project, or Recent Project Updates |

### C. Generic album: 1 album, 91 photos

| Mobile uploads | 91 | **Exclude from the historical import** until the visual check. Phone uploads mix job-site photos (many likely already in galleries or in project albums) with non-project content. Never make this album a project. Afterwards, import only reviewed, visually-new photos into specific projects or Recent Project Updates. |
|---|---|---|

### D. Excluded: keep excluded

Profile pictures (4) and Cover photos (1) are branding, not projects.

**Reconciliation of counts:** A 211 + B 84 + C 91 = **386 new**. Adding D 5 and the 8 already
imported gives **399**.

## 6. Proposed import plan (each step needs separate approval)

| Step | Scope | Photos |
|---|---|---|
| 0 | **Corrections and evidence** (§7). Visual check (§4). Re-run the preview just before importing. | 0 |
| 1 | **Group B with new destinations**: Bisek 15, Pongratz 13, Jsme 13, Rieck Deck 12, Ganz Garage +7, Fankhauser 5, Zingshiem 3, Ripley 2 | **70** (minus any visual duplicates) |
| 2 | **Held items after owner answers**: Ganz (7), Home (7) | 0–14 |
| 3 | **Group A**, only visually-new photos, linked to the recommended galleries | 26–211, decided by §4 |
| 4 | **Mobile uploads**, only reviewed visually-new photos | 0–91 |
| — | **Never import**: Profile pictures, Cover photos | 5 excluded |

Expected outcome if the count evidence holds: roughly **100–130** genuinely new photos rather
than 386, and **no** new galleries for projects that already exist.

Free-plan budget for a full import of ≤ 386 photos:

| Resource | Use |
|---|---|
| Graph requests | Hundreds |
| R2 writes | ≤ 772 (master + public copy each; the limit is 1M a month) |
| D1 writes | A few thousand (the limit is 100k a day) |
| Thumbnail transformations | ≤ 386 a month (the limit is 5,000) |

Run Step 1 as a small first batch to measure Worker CPU on the Free plan (10 ms/request) before
continuing; large-image validation is the risk.

## 7. Import mechanism: corrections recommended before running it

1. **There is no per-photo exclusion** (important). Historical import maps whole albums only
   (album → project / recent / exclude). Partially duplicated albums cannot be imported selectively.
   - **Add `excludePhotoIds`** to the historical-import request: validated IDs, persisted in the job state, honoured by `visit()`.
   - Show it in the review UI, loadable from the reconciliation result.
   - The alternative, importing everything and hiding duplicates afterwards, stores and briefly publishes duplicates. Not recommended.
2. **Visual-duplicate evidence** (§4, option a or b). The preview's duplicate check is ID/filename-only and finds nothing here.
3. **Duplicate galleries.** Several albums should share one destination (Fankhauser + E. Fankhauser), and auto-created names can be poor ("Jsme").
   - **Pre-create** new projects with admin *project-create* (explicit name and category), then map albums to `project:<id>`. This avoids duplicate and oddly named galleries.
   - `linked_prefix` is unique, so two albums cannot each create a link to the same manual folder.
4. **Cross-category twins.** A linked Facebook album appears only in the manual gallery it links to. Pick the canonical gallery per project; above, Projects is chosen except Wheelman/Remodels, Dahl/Remodels and Kitelinger/New Construction. Accept that its twin in the other category will not show the new Facebook photos, unless they are added there manually.
5. **Staged visibility (optional).** An "import hidden" option would let imported photos be reviewed in `/admin/facebook` before they appear publicly.
6. **Storage order.** The importer still writes a public R2 copy per photo. If private-only storage (the deferred follow-up) is planned, do it **before** the historical import, to avoid creating and later deleting hundreds of public copies.
7. **Already fine:**
   - The dry-run is read-only (verified in code).
   - The import route is server-blocked (`FB_HISTORICAL_IMPORT_ENABLED=false`).
   - Post coverage is now verified (87/87).
   - The scan stops rather than skipping when a photo's ownership can't be verified. That is conservative and was not triggered in this run.

## 8. Decisions needed from the owner

1. Visual-check source: (a) Meta Page photo export, or (b) the approved preview enhancement.
2. Canonical gallery for the cross-category projects (Schwennson, Gibson, Pfaffe, Pritchard,
   Tyman, Riesman, Loretta: Projects or New Construction; Wheelman and Ford: Projects or Remodels).
3. Display name and category for new projects: Bisek, Pongratz, **Jsme**, Rieck Deck, Zingshiem,
   Ripley, and Fankhauser (merge E. Fankhauser?).
4. "Ganz" (7): Ganz Re-Deck, Ganz Garage, or a new project? "Home" (7): what is it?
5. Kitelinger House → Kitelinger Shell, and Dahl → J&A Dahl. Confirm.
6. Mobile uploads: exclude now and review later (recommended)?
7. Build the per-photo exclusion (§7.1) and project pre-creation flow, or accept album-level imports.
8. Private-only storage before or after the import?

## 9. Local evidence (scratchpad; temporary, not committed)

The analyzer, inventory, hashes and duplicate pairs are in the session scratchpad `phase2/`
folder. They are regenerable from the public site, and the Facebook-side comparison needs only the
images from §4.

## 10. Visual duplicate check, done 2026-11-22 (resolves §4)

**Method.** I ran a read-only pass in the owner's signed-in browser, using the same admin
endpoints, image sizes and dHash code as the comparison page (`src/lib/photo-hash.js`):
- `review-albums` and `review-album` for every album, photo, import state and decision;
- `review-site-gallery?all=1` and `review-site-image` for all **310** manual website images;
- `review-image` for all **394** non-branding Facebook photos, including the 15 already
  imported.

Each Facebook photo was compared with every website image and with every other Facebook photo.
There were 0 errors, and no D1, R2 or Meta writes. The per-photo results are kept in the owner's
browser, in local storage under `kil-recon-2026-11-22` on kilcon.work, for the decisions step.

**The distances separate cleanly.** For the 379 photos not yet imported, the nearest website
image is at:

| Distance | Photos | Meaning |
|---|---|---|
| 0–2 | 179 | the same picture |
| 3–5 | 20 | the same picture (recompressed or resized) |
| 6 | 1 | probably the same picture (a Ganz album photo against 3D Autobody) |
| 11–13 | 9 | unrelated pictures (for example cutting boards against a Wheelman exterior); treated as new |
| 14+ | 170 | new |

The 9 photos at 11–13 are listed in the browser results. A glance on the review page settles
them. Fingerprints can miss heavy crops or rotations, so "new" still means "check by eye before
Import".

### Albums that already have a website gallery (211 photos)

| Album | Photos | Duplicates of the website | New | The duplicates match |
|---|---|---|---|---|
| Schwennson | 31 | 23 | **8** | Projects/Schwennson House 22, New Construction 1 |
| Ford kitchen | 20 | 17 | **3** | Projects/Ford Kitchen 17 |
| Gibson | 19 | 18 | **1** | Projects/Gibson House 16, New Construction 2 |
| Pfafe | 19 | 16 | **3** | Projects/Pfaffe House 14, New Construction 2 |
| Kiley porch | 17 | 17 | 0 | Projects/Kiley Enclosed Porch |
| D.Dahl Porch | 16 | 10 | **6** | Projects/D. Dahl Porch |
| Pritchard | 14 | 14 | 0 | Projects/Pritchard Airplane Hanger |
| Cabinets | 13 | 13 | 0 | Furniture/Cabinets |
| Wheelman Performance | 9 | 4 | **5** | Projects/Wheelman_Performance |
| Loretta | 9 | 7 | **2** | Projects/Lorretta_s Shed |
| Kiley Lean-to | 8 | 7 | **1** | Projects/Kiley Lean-to |
| Kitelinger House | 8 | 7 | **1** | New Construction/Kitelinger Shell |
| Cutting boards | 7 | 2 | **5** | Furniture/Cutting Boards |
| Tyman | 6 | 3 | **3** | Projects/Tyman Shop and House Shell |
| Fox Hollow Retriever | 6 | 6 | 0 | Projects/Fox_Hollow_Retriever |
| Riesman | 5 | 5 | 0 | Projects/Riesman Shed |
| Dahl | 4 | 4 | 0 | Remodels/J&A_Dahl |
| **Total** | **211** | **173** | **38** | |

### Albums with no website gallery (77 photos)

| Album | Photos | New | Notes |
|---|---|---|---|
| Bisek | 15 | 15 | |
| Pongratz | 13 | 13 | 10 are also in Mobile uploads |
| Jsme | 13 | 13 | all 13 are also in Mobile uploads; the name is still unexplained |
| Rieck Deck | 12 | 12 | 4 are also in Mobile uploads |
| Home | 7 | 7 | 2 are also in Mobile uploads; still unidentified |
| E. Fankhauser | 3 | 3 | |
| Fankhauser | 2 | 2 | both are also in Mobile uploads |
| Zingshiem | 3 | 3 | |
| Ripley | 2 | 2 | |
| **Ganz** | 7 | **0–1** | **Not the deck job.** 5 photos duplicate Remodels/3D_Autobody (distances 0–6), and 1 is the Ganz Re-Deck website photo (distance 0). The 7th (`…648318503`) is a 3D Autobody exterior that isn't on the site; it is also in Mobile uploads. |

### Mobile uploads (91 photos)

| Group | Photos | Treatment |
|---|---|---|
| Duplicates a website photo | 21 | never import (9 Furniture/Cabinets, 3 Remodels/3D_Autobody, …) |
| Duplicates a photo in a project album | 37 | never import from Mobile uploads; import the album copy instead (Jsme 13, Pongratz 10, Ganz Garage 5 already imported, Rieck 4, Fankhauser 2, Home 2, Ganz 1) |
| Appears nowhere else | 33 | **hold**, kept separate until each can be matched to a project |

**Totals:**
- **Group A:** 38 new (plus at most 1 grey-zone photo).
- **Group B:** 70 new (plus at most 1 in Ganz).
- **Mobile uploads:** 33 unique, held.

That is **about 109 importable photos**, not 379, and no project needs a second gallery. The
branding albums (Profile pictures 4, Cover photos 1) stay excluded.

### Decisions for the owner (replaces §8)

1. **Canonical gallery for projects that exist in two categories.** The Facebook duplicates
   match the Projects copies almost entirely, so I recommend:
   - Projects/ for Schwennson, Gibson, Pfaffe, Ford, Wheelman, Loretta, Tyman, Pritchard and
     Riesman;
   - New Construction/Kitelinger Shell, the only copy;
   - Remodels/J&A_Dahl.

   The twin in the other category won't show the new Facebook photos. Removing the twin folders
   would delete R2 files, so it needs its own decision; I recommend leaving them for now.
2. **New galleries.** For each, confirm or give a display name and category:
   - Bisek, Pongratz and Rieck Deck;
   - **Jsme**, which needs a real name;
   - Zingshiem and Ripley;
   - **Fankhauser**: one gallery for "E. Fankhauser" + "Fankhauser"?
   - **Home**: what is it, or should it be excluded?
3. **Ganz album.** Skip the 6 duplicates. The 7th: import it into Remodels/3D_Autobody, or skip it?
4. **Recording the duplicates.** Do you approve saving **Skip** decisions with `duplicate_of`
   for the duplicates? That's the 173 from Group A, 6 from Ganz, and the 58 duplicate copies in
   Mobile uploads. Then the review page shows them as decided.
   - This only writes `facebook_photo_reviews` rows.
   - It never approves anything.
   - Import decisions stay yours, photo by photo.
5. **Mobile uploads:** keep the 33 unique photos held (recommended).

### Owner decisions (2026-11-22) and the evidence behind them

1. **Twin galleries stay.** The canonical destination is Projects/, except New
   Construction/Kitelinger Shell and Remodels/J&A_Dahl.
2. **New galleries:** Bisek, Pongratz, Rieck Deck, Zingshiem and Ripley.
   - They default to Projects/. Nothing seen so far points to another category, but captions
     aren't available from the review API, so the owner can change the category on
     `/admin/facebook` later.
   - No existing gallery has any of these names.
3. **Jsme and Home are held** until their identities are confirmed.
4. **Fankhauser: no merge.**
   - E. Fankhauser has 3 photos from 2026-10-19; Fankhauser has 2 from 2024-09-26. That's two
     years apart.
   - No photo of one resembles any of the other: the nearest distances are 18–20.
   - So they are not confirmed as one project. Keep them separate; each needs a display name
     before it is created.
5. **The Ganz album is two projects, matched photo by photo:**

   | Photo | Date | Nearest website image | Distance | Plan |
   |---|---|---|---|---|
   | `122153213516318503` | 2024-12-23 | Remodels/3D_Autobody/3D_Autobody_Exterior_1 | 1 | Skip (duplicate) |
   | `122153213558318503` | 2024-12-23 | …/3D_Autobody_Exterior_4 | 5 | Skip (duplicate, medium confidence) |
   | `122153213600318503` | 2024-12-23 | …/3D_Autobody_Exterior_3 | 2 | Skip (duplicate) |
   | `122153213690318503` | 2024-12-23 | …/3D_Autobody_Exterior_2 | 0 | Skip (duplicate) |
   | `122180740952318503` | 2025-06-22 | Projects/Ganz Re-Deck/Ganz_Re-Deck | 0 | Skip (duplicate) |
   | `122153213480318503` | 2024-12-23 | …/3D_Autobody_Exterior_5 | **6** | **Owner's eye**: just outside the automatic threshold |
   | `122153213648318503` | 2024-12-23 | …/3D_Autobody_Exterior_3 | 13 | **Held** (the 7th photo): a 3D Autobody exterior from the same day; not on the website |

6. **The duplicate Skip plan is prepared but not saved.**
   - **Count:** 236 photos, all at distance 5 or less, and none with a decision yet.
   - **Confidence:** 216 high (distance 0–2), 20 medium (3–5), **0 ambiguous**.
     - Every Group A and Ganz match is in that album's own gallery.
     - The 179 website images involved were re-fingerprinted, and none is low-detail (all
       between 12 and 52 bits set).
     - The 58 Mobile-upload duplicates point to the matching website image (21) or to the
       project-album copy (37, as `facebook:<id>`).
   - **Not included:** the distance-6 Ganz photo above (so 236, not 237).
   - **Where it is:** in the owner's browser, local storage `kil-skip-plan-2026-11-22` on
     kilcon.work. Each row carries its distance and confidence in the note.
   - **Saving it:** needs the owner's approval. At save time each photo's current decision is
     re-checked, and only undecided photos are written.

### Phase C batch plan (each batch needs approval; nothing approved automatically)

For each batch:
1. Create the gallery (`project-create`), or the Facebook gallery linked to the manual folder.
2. Run `album-link`.
3. **The owner marks Import** for the new photos on the review page.
4. Targeted dry run: it must show `new = n`, `refused 0`.
5. Turn historical import on with a `--var` version, run with `expectedCount`, then turn it off at once.
6. Verify: gallery count, every image loads, D1 snapshot diff, production checks.

| # | Batch | Destination | New photos |
|---|---|---|---|
| 1 | Ripley | new Projects/ gallery "Ripley" | 2 |
| 2 | Zingshiem | new "Zingshiem" | 3 |
| 3 | Rieck Deck | new "Rieck Deck" | 12 (4 copies in Mobile uploads are skipped) |
| 4 | Pongratz | new "Pongratz" | 13 (10 copies in Mobile uploads skipped) |
| 5 | Bisek | new "Bisek" | 15 |
| 6–18 | Group A, one album per batch | linked to its canonical manual gallery | 38 in total: Schwennson 8, D.Dahl Porch 6, Wheelman 5, Cutting boards 5, Ford 3, Pfaffe 3, Tyman 3, Loretta 2, Gibson 1, Kiley Lean-to 1, Kitelinger 1 |
| held | Jsme 13, Home 7, E. Fankhauser 3, Fankhauser 2, Ganz `…480` and `…648`, Mobile uploads (33 unique) | after the owner identifies them; Mobile uploads and Ganz use mixed-album batches | — |

Group A albums with no new photos (Kiley porch, Pritchard, Cabinets, Fox Hollow, Riesman and
Dahl) need no batch. Their duplicates are covered by the Skip plan.
