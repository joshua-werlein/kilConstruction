# Historical Facebook preview investigation

No production changes were made. The November 15 release and the normal
Facebook post importer remain in place. This follow-up is local only.

## Verified production destinations

D1 contained one Facebook project: **ID 1**, slug `ganz-garage`, name Ganz
Garage, no linked folder, existing Facebook album ID `122234637104318503`.
The following repeated choices are distinct manual folder identifiers,
not multiple Facebook projects in D1:

| Display name | Existing destination IDs (R2 prefixes) |
| --- | --- |
| Wheelman Performance | `Projects/Wheelman_Performance/`; `Remodels/Wheelman_Performance/` |
| Tyman Shop and House Shell / Tyman House and Shop Shell | `Projects/Tyman Shop and House Shell/`; `New Construction/Tyman_House_and_Shop_Shell/` |
| Gibson House | `Projects/Gibson House/`; `New Construction/Gibson_House/` |
| Pfaffe House | `Projects/Pfaffe House/`; `New Construction/Pfaffe_House/` |
| Pritchard Airplane Hanger | `Projects/Pritchard Airplane Hanger/`; `New Construction/Pritchard_Airplane_Hanger/` |
| Riesman Shed | `Projects/Riesman Shed/`; `New Construction/Riesman Shed/` |

The old chooser concatenated both sources by display name. That also
allowed a linked D1 row and its own R2 folder to be offered twice if one
existed. The revised chooser removes duplicate identities (same folder)
only. Separate folders, even exact name matches, retain separate choices
and display their paths. Existing saved mappings remain authoritative.

## Preview completeness

The reported run discovered 30 albums and 388 unique photos, with eight
already imported, no metadata-based manual duplicate candidates, and zero
verified posts. The UI retained aggregate proposals: 304 Recent Project
Updates, 7 Ganz Garage, 12 Rieck Deck, 7 Cutting Boards, 16 D. Dahl Porch,
8 Kiley Lean-to, 20 Ford Kitchen, and 6 Fox Hollow Retriever. These totals
sum to 380 proposed photos, in addition to the 8 already imported.

The implementation queues the posts edge after the album tasks. The old
counter recorded only posts surviving a strict author check; Meta could
return an empty edge or return posts with absent/nonmatching author IDs
and produce the same zero. A Graph request or cursor failure was designed
to stop traversal, but an HTTP failure outside the batch response only
showed a transient status and did not visibly mark the report partial.
The historical browser report contains neither raw counts nor request
traces, so a specific live Meta cause has not been established. The
current public Meta references were not retrievable during investigation.

The local fix reports post pages read, posts returned, verified posts,
unknown authors and other authors separately. Unverified authors are
still excluded. Unexpected zero verified posts despite known imported
history, missing post-page evidence, unknown authors, and failed requests
are visible partial coverage, and the review UI does not unlock import.
Ambiguous album proposals also require an explicit decision, including
the option to keep them in Recent Project Updates or exclude them.
“Seen in albums, not in scanned posts” is not evidence of album-only
provenance when post coverage is partial.

## Source album inventory from the existing browser preview

The production page showed the following source albums and unsaved draft
selections. Counts on that release are by **proposal**, not by **source
album**, and its read-only path stores no album inventory or preview
photo IDs in D1. The browser draft was inspected and left unchanged.
The table separates plausible destinations from confirmed assignments;
an em dash means the old preview did not disclose that source count.

| Source album | Source photo count evidence | Existing destination or review recommendation |
| --- | --- | --- |
| Ganz Garage | 8 already imported with this album ID; full source total unknown | Ganz Garage (D1 ID 1; established album ID) |
| E. Fankhauser | — | Review; compare with Fankhauser album before considering a new project |
| Mobile uploads | — | Mixed album; review contents or exclude, never make it a project |
| Profile pictures | — | Exclude branding photos from historical import |
| Rieck Deck | — | Existing preview proposed 12 to Rieck Deck; review before creating a new project |
| Wheelman Performance | — | Review Projects vs Remodels; observed unsaved draft selects Remodels |
| Zingshiem | — | Review; no verified match |
| Cutting boards | — | Furniture / Cutting Boards; old proposal 7 |
| Ripley | — | Review; no verified match |
| D.Dahl Porch | — | Projects / D. Dahl Porch, punctuation-normalized; old proposal 16 |
| Kiley Lean-to | — | Projects / Kiley Lean-to; old proposal 8 |
| Kiley porch | — | Kiley Enclosed Porch is the strongest name hint; confirm distinct from Kiley Lean-to |
| Cabinets | — | Furniture / Cabinets by title; review because the title is broad |
| Ford kitchen | — | Projects / Ford Kitchen is exact; Remodels / Ford Kitchen Remodel is a distinct destination; old proposal 20 |
| Riesman | — | Review two Riesman Shed folders |
| Tyman | — | Review the two Tyman folders; observed unsaved draft selects New Construction |
| Ganz | — | Review Ganz Garage vs Ganz Re-Deck; observed unsaved draft selects Ganz Garage |
| Bisek | — | Review; no verified match |
| Loretta | — | Review Projects / Lorretta s Shed vs New Construction / Loretta's Shed |
| Gibson | — | Review two Gibson House folders |
| Kitelinger House | — | Kitelinger Shell is a candidate, not a confirmed match |
| Pfafe | — | Spelling hint to Pfaffe House; review both folders |
| Dahl | — | Unresolved: D. Dahl Porch and J&A Dahl are distinct candidates |
| Pongratz | — | Review; no verified match |
| Schwennson | — | Review Schwennson House vs Schwennson House and Shop |
| Fankhauser | — | Review alongside E. Fankhauser |
| Fox Hollow Retriever | — | Projects / Fox Hollow Retriever; old proposal 6 |
| Pritchard | — | Review the two Pritchard Airplane Hanger folders |
| Jsme | — | Review; no verified match |
| Home | — | Generic description; review or exclude if unrelated |

The seven reported Ganz Garage proposals were separate from the eight
“already imported” entries under the old preview's photo-ID check for
this project. This classification does not prove pixel/content uniqueness
or that the source was the abbreviated Ganz album. Production D1 confirms
the eight existing IDs, but the seven new proposed IDs were not exposed
by the old UI. The new downloadable review report includes the exact
per-album IDs, matched destinations and already-imported status, with no
credentials, captions, or image downloads. That is the evidence needed
to close the remaining overlap and per-album count questions.

## Safe next step

Review and approve the local preview/report changes alone, then run a
fresh read-only preview and export the review report. Reconcile source
counts against the aggregate, compare Ganz IDs, and resolve the Wheelman,
Tyman, Dahl, and other ambiguous rows before considering historical
import. An exclusion in this UI is a draft for the historical run, not
a global rule for future Facebook posts. Keep reconciliation off and
leave current galleries and assignments untouched.
