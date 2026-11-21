// Admin upload categories. The category must be chosen explicitly: the
// <select> starts on a blank "Choose a category" option, and nothing is
// uploaded until a valid category is selected. (Highlights used to be the
// default, which sent a test upload to the home-page rotator on 2026-11-21.)
//
// Must match ALLOWED_ROOTS in workers/kilcon-gallery-worker/src/index.js;
// a site test checks it.

export const UPLOAD_CATEGORIES = Object.freeze([
  "Highlights",
  "Projects",
  "New Construction",
  "Remodels",
  "Furniture",
  "Apparel",
]);

/** True only for an exact, explicitly chosen category name. */
export function isValidUploadCategory(value) {
  return typeof value === "string" && UPLOAD_CATEGORIES.includes(value);
}
