// Pure helpers for the Facebook section of Manage Images (/admin/manage).
// Facebook galleries live in D1 (facebook_projects / facebook_photos) and their
// files sit flat under Facebook/ in R2, so they are not R2 folders. The page
// manages them only through the existing Facebook admin API.

export const PURGE_PHRASE = "PERMANENTLY DELETE"; // must match the Worker's PURGE_CONFIRMATION
export const PURGE_BATCH = 50; // Worker PURGE_BATCH
export const UPDATE_BATCH = 200; // Worker photo-update limit

const CATEGORY_LABELS = {
  projects: "Projects",
  "new-construction": "New Construction",
  remodels: "Remodels",
  furniture: "Furniture",
};

export function categoryLabel(value) {
  return CATEGORY_LABELS[value] || "Projects";
}

/** Gallery cards for the Facebook section, from the admin overview response. */
export function facebookGalleries(overview) {
  const projects = Array.isArray(overview?.projects) ? overview.projects : [];
  return projects
    .filter((p) => Number.isInteger(p?.id) && p.id > 0)
    .map((p) => {
      const recent = p.kind === "recent";
      const linked = typeof p.linkedPrefix === "string" && p.linkedPrefix ? p.linkedPrefix.replace(/\/$/, "") : null;
      let where;
      if (p.hidden) where = "Hidden from the website";
      else if (linked) where = `Shown inside the manual gallery ${linked}`;
      else if (p.publicPath) where = `Shown at ${p.publicPath}`;
      else where = "Not shown yet (no visible photos)";
      const name = String(p.name || p.slug || `Project ${p.id}`);
      return {
        id: p.id,
        name,
        slug: String(p.slug || ""),
        badge: recent ? "Facebook · Recent updates" : "Facebook",
        category: recent ? "Recent Project Updates" : categoryLabel(p.category),
        where,
        publicPath: !p.hidden && !linked && typeof p.publicPath === "string" && p.publicPath.startsWith("/") ? p.publicPath : null,
        linkedPrefix: linked,
        hidden: !!p.hidden,
        photoCount: Number(p.photoCount) || 0,
        visibleCount: Number(p.visibleCount) || 0,
        searchText: [name, p.slug, linked, recent ? "recent" : categoryLabel(p.category), "facebook"].filter(Boolean).join(" ").toLowerCase(),
      };
    });
}

export function matchesSearch(gallery, query) {
  const q = String(query || "").trim().toLowerCase();
  return !q || gallery.searchText.includes(q);
}

/** Display state of one photo from /facebook/admin/photos. */
export function photoState(p) {
  if (p?.deleted) return { key: "deleted", label: "Permanently deleted" };
  if (p?.removedOnFacebook) return { key: "removed", label: p.deleteAfter ? "Removed on Facebook (deletion scheduled)" : "Removed on Facebook" };
  if (p?.status === "failed") return { key: "failed", label: "Import failed" };
  if (p?.status !== "imported") return { key: "importing", label: "Importing" };
  if (p?.hidden) return { key: "hidden", label: "Hidden" };
  return { key: "visible", label: "Visible" };
}

/** Which selected photos each action would actually change. */
export function actionTargets(photos) {
  const list = Array.isArray(photos) ? photos : [];
  const ids = (f) => list.filter(f).map((p) => p.photoId);
  return {
    hide: ids((p) => !p.deleted && !p.hidden),
    // The Worker only restores photos that still exist and are not removed on Facebook.
    restore: ids((p) => !p.deleted && p.hidden && !p.removedOnFacebook),
    move: ids((p) => !p.deleted),
    purge: ids((p) => !p.deleted),
    highlightOn: ids((p) => !p.deleted && !p.highlight),
    highlightOff: ids((p) => !p.deleted && p.highlight),
  };
}

/** Destinations for "Move to", excluding the gallery being viewed. */
export function moveTargets(overview, currentId) {
  return facebookGalleries(overview)
    .filter((g) => g.id !== currentId)
    .map((g) => ({ id: g.id, label: `${g.name} (${g.category}${g.hidden ? ", hidden" : ""})` }));
}

export function purgeConfirmed(text) {
  return String(text ?? "").trim() === PURGE_PHRASE;
}

export function chunk(list, size) {
  const out = [];
  for (let i = 0; i < list.length; i += size) out.push(list.slice(i, i + size));
  return out;
}

/** Preview URLs from the API are same-origin admin paths; anything else is dropped. */
export function safeAdminPath(value) {
  return typeof value === "string" && /^\/api\/gallery-api\/facebook\/admin\/photo-file\?id=[0-9_]{1,64}$/.test(value) ? value : null;
}
