# Historical Facebook album reconciliation — Phase 2 report (2026-11-21)

**Status: analysis only.** Nothing has been imported. Discovery and historical import remain
disabled. No D1, R2, mapping, Meta or Cloudflare changes were made. This file is uncommitted
pending review.

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
