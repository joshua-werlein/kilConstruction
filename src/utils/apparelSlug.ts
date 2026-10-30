// Same shape the gallery worker's slugifyName() produces: lowercase letters and
// digits joined by single dashes.
export const APPAREL_SLUG_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const MAX_SLUG_LENGTH = 80;

/**
 * Returns the canonical (lowercase) slug, or null when the value isn't a valid
 * apparel slug. Callers redirect when the result differs from the input.
 */
export function normalizeApparelSlug(raw: string | undefined | null): string | null {
    if (typeof raw !== "string" || raw.length > MAX_SLUG_LENGTH) return null;
    const slug = raw.toLowerCase();
    return APPAREL_SLUG_RE.test(slug) ? slug : null;
}
