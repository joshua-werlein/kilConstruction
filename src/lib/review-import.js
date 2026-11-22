// Pure helpers for "Import Approved Photos" on /admin/facebook-review.
// The Worker enforces every rule again; these only shape requests and text.

export const DEFAULT_BATCH = 10; // Worker MAX_TARGETED_PHOTOS

export function chunk(list, size) {
  const n = Number.isInteger(size) && size > 0 ? size : DEFAULT_BATCH;
  const out = [];
  for (let i = 0; i < list.length; i += n) out.push(list.slice(i, i + n));
  return out;
}

/**
 * How the destination is chosen for this album.
 * - linked: the album already feeds a gallery; that is the only destination.
 * - choose: pick a gallery. Unsorted albums (Mobile uploads) are always
 *   "mixed" (nothing is linked). A project album is linked to the chosen
 *   gallery on confirmation unless the owner says it holds several projects.
 */
export function destinationMode(plan, album) {
  const galleries = Array.isArray(plan?.galleries) ? plan.galleries : [];
  if (plan?.linked) {
    return { mode: "linked", gallery: plan.linked, usable: !!plan.linked.usable, galleries: [], mixedLocked: false, mixedDefault: false };
  }
  const unsorted = album?.kind === "generic";
  return { mode: "choose", gallery: null, usable: true, galleries, mixedLocked: unsorted, mixedDefault: unsorted };
}

const GROUPS = [
  ["projects", "Projects"],
  ["new-construction", "New Construction"],
  ["remodels", "Remodels"],
  ["furniture", "Furniture"],
];

/** Destination options grouped by category; website (manual) galleries are labelled as such. */
export function galleryGroups(galleries) {
  const list = Array.isArray(galleries) ? galleries.filter((g) => g && typeof g.value === "string" && g.value) : [];
  return GROUPS.map(([key, label]) => ({
    label,
    items: list.filter((g) => (GROUPS.some(([k]) => k === g.category) ? g.category : "projects") === key)
      .map((g) => ({ value: g.value, label: g.source === "website" ? `${g.name} (website gallery)` : `${g.name} (Facebook gallery)` })),
  })).filter((g) => g.items.length);
}

/** Request fields naming the destination: a record id, or a website folder that isn't linked yet. */
export function destinationBody(gallery) {
  if (Number.isInteger(gallery?.id) && gallery.id > 0) return { projectId: gallery.id };
  if (typeof gallery?.linkedPrefix === "string" && gallery.linkedPrefix) return { linkedPrefix: gallery.linkedPrefix };
  return {};
}

export const GALLERY_CONFIRMATION = "CREATE GALLERY"; // Worker GALLERY_CONFIRMATION

/** The first "suggested name" recorded on automatically held photos, if any. */
export function suggestedGalleryName(photos) {
  for (const p of Array.isArray(photos) ? photos : []) {
    const m = /suggested name: ([^;]{2,80})/.exec(typeof p?.note === "string" ? p.note : "");
    if (m) return m[1].trim();
  }
  return "";
}

/** Human summary of a gallery-create check. */
export function galleryCheckText(result, name, categoryLabel) {
  if (result?.existing?.length) return `A gallery named "${result.existing[0].name}" already exists. Choose it as the destination instead.`;
  if (result?.similar?.length) return `Similar galleries exist: ${result.similar.map((g) => g.name).join(", ")}. Create "${name}" only if it is a different project.`;
  if (result?.ok) return `"${name}" doesn't exist yet. Create it under ${categoryLabel}?`;
  return result?.error ? String(result.error) : "Could not check that name.";
}

/** Request flags for a destination: dry runs on an unlinked album always use mixed mode. */
export function runFlags(dest, { mixed, dryRun }) {
  if (dest.mode === "linked") return { mixedAlbum: false, linkFirst: false };
  if (mixed) return { mixedAlbum: true, linkFirst: false };
  return dryRun ? { mixedAlbum: true, linkFirst: false } : { mixedAlbum: false, linkFirst: true };
}

const REASONS = {
  "review-unreviewed": "not marked Import",
  "review-skip": "marked Duplicate / Skip",
  "review-later": "marked Review later",
  "review-album-mismatch": "approved for a different album",
  "album-mismatch": "Facebook reports a different album",
  "not-page-photo": "not posted by the Page",
  "no-facebook-image": "no downloadable image",
  "graph-id-mismatch": "Facebook returned a different photo",
  "branding-album": "branding photos are never imported",
  "already-imported": "already on the website",
  suppressed: "hidden or removed earlier",
};

export function reasonLabel(reason) {
  return REASONS[reason] || String(reason || "unknown reason").slice(0, 120);
}

/** Combine dry-run batch responses. `likely` is the set of IDs the page fingerprinted as likely duplicates. */
export function summarizeDryRun(responses, likely = new Set()) {
  const out = { newIds: [], existing: [], refused: [], errors: [], likelyDuplicates: [] };
  for (const r of responses) {
    if (r?.error) { out.errors.push(String(r.error).slice(0, 200)); continue; }
    for (const p of r?.photos || []) {
      if (p.outcome === "new") { out.newIds.push(p.id); if (likely.has(p.id)) out.likelyDuplicates.push(p.id); }
      else if (p.outcome === "existing") out.existing.push({ id: p.id, reason: reasonLabel(p.reason) });
      else out.refused.push({ id: p.id, reason: reasonLabel(p.reason) });
    }
  }
  return out;
}

/** Combine real-run batch responses. */
export function summarizeImport(responses) {
  const out = { imported: 0, failed: [], skipped: [], errors: [] };
  for (const r of responses) {
    if (r?.error && !Array.isArray(r?.photos)) { out.errors.push(String(r.error).slice(0, 200)); continue; }
    if (r?.error) out.errors.push(String(r.error).slice(0, 200));
    for (const p of r?.photos || []) {
      if (p.outcome === "imported") out.imported++;
      else if (p.outcome === "failed") out.failed.push({ id: p.id, reason: String(p.reason || "failed").slice(0, 200) });
      else out.skipped.push({ id: p.id, reason: reasonLabel(p.reason) });
    }
  }
  return out;
}

export function confirmText(summary, galleryName) {
  const n = summary.newIds.length;
  const lines = [`Import ${n} approved photo${n === 1 ? "" : "s"} into "${galleryName}" and publish ${n === 1 ? "it" : "them"} on the website?`];
  if (summary.likelyDuplicates.length) lines.push(`${summary.likelyDuplicates.length} of them look like duplicates of website photos. Check them first, or mark them Duplicate / Skip.`);
  if (summary.existing.length) lines.push(`${summary.existing.length} already on the website will be left alone.`);
  if (summary.refused.length) lines.push(`${summary.refused.length} can't be imported and will be left out.`);
  return lines.join(" ");
}
