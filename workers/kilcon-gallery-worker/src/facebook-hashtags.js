// Caption control tags for new Facebook posts (spec: docs/facebook-hashtags.md).
// #project / #newconstruction / #remodels / #furniture choose the category of
// a NEW gallery created by the post; #highlight adds its photos to Highlights.
// Not wired into the import paths yet.

const CATEGORY_TAGS = {
  project: "projects",
  projects: "projects",
  newconstruction: "new-construction",
  remodel: "remodels",
  remodels: "remodels",
  furniture: "furniture",
};
const HIGHLIGHT_TAGS = new Set(["highlight", "highlights"]);
const isControl = (tag) => tag in CATEGORY_TAGS || HIGHLIGHT_TAGS.has(tag);

// A tag starts at the beginning or after a non-word character, and ends at a non-word character.
const TAG_RE = /(^|[^\p{L}\p{N}_#&])#([\p{L}\p{N}_]+)/gu;

/** { category: string|null, highlight: boolean, conflict: boolean, tags: string[] } */
export function parseControlTags(text) {
  const found = [];
  for (const m of String(text ?? "").matchAll(TAG_RE)) {
    const tag = m[2].toLowerCase();
    if (isControl(tag)) found.push(tag);
  }
  const categories = [...new Set(found.filter((t) => t in CATEGORY_TAGS).map((t) => CATEGORY_TAGS[t]))];
  return {
    // Two different category tags: don't guess.
    category: categories.length === 1 ? categories[0] : null,
    conflict: categories.length > 1,
    highlight: found.some((t) => HIGHLIGHT_TAGS.has(t)),
    tags: [...new Set(found)],
  };
}

/** Caption for display: the control tags removed; other hashtags and text kept. */
export function stripControlTags(text) {
  if (typeof text !== "string") return text;
  return text
    .replace(TAG_RE, (all, lead, tag) => (isControl(tag.toLowerCase()) ? lead : all))
    .split("\n")
    .map((line) => line.replace(/[ \t]{2,}/g, " ").trimEnd())
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}
