// Historical photo review: the per-photo import gate and the admin-only
// comparison endpoints behind /admin/facebook-review.
//
// Security model
// - Every endpoint is reached only through /api/gallery-api/facebook/admin/*,
//   which index.js guards with requireAdmin (SameSite=Strict admin cookie).
// - The Page token stays in the Worker. The browser receives photo IDs and
//   image bytes proxied through these endpoints, never Graph or CDN URLs.
// - Decisions are labels in D1 (migration 017). Nothing here imports, moves
//   or deletes a photo.
//
// Import gate (reviewGate), applied before any project assignment or D1 claim:
// - "skip" or "later"                     -> never imported, by any path
// - "import"                              -> allowed
// - historical mode, no decision          -> excluded (history import, legacy
//   backfill, and webhook edits of posts the site has never seen)
// - live mode, no decision                -> allowed (new posts and photos)
// Which mode applies is decided from what happened, never from a date:
// see webhookReviewMode.

const ID = /^[0-9_]{1,64}$/;
const CURSOR = /^[A-Za-z0-9_=-]{1,2048}$/;
const DECISIONS = new Set(["import", "skip", "later"]);
const IMAGE_TYPES = new Set(["image/jpeg", "image/png", "image/webp"]);
const IMAGE_KEY_EXT = /\.(jpe?g|png|webp|avif)$/i;
const MAX_PREVIEW_BYTES = 8 * 1024 * 1024;
const PREVIEW_MIN_WIDTH = 320;
const ALBUM_PAGE = 50;
const MAX_DECISIONS_PER_REQUEST = 100;
const PRIVATE_IMAGE_CACHE = "private, max-age=3600";

function missingTable(e) {
  return /no such table/i.test(String(e?.message || e));
}

/** The stored decision for a photo, or null (none, or migration 017 not applied yet). */
export async function reviewDecisionFor(db, photoId) {
  if (!db) return null;
  try {
    const row = await db.prepare(`SELECT decision FROM facebook_photo_reviews WHERE fb_photo_id = ?`).bind(photoId).first();
    return row?.decision || null;
  } catch (e) {
    if (missingTable(e)) return null;
    throw e;
  }
}

/**
 * null when the photo may be imported; otherwise the exclusion reason
 * ("review-skip" | "review-later" | "review-unreviewed").
 * mode: "live" (new content) or "historical". Anything else counts as
 * historical, so a caller that forgets the mode fails closed.
 */
export async function reviewGate(env, photoId, { mode } = {}) {
  const decision = await reviewDecisionFor(env.DB, photoId);
  if (decision === "skip") return "review-skip";
  if (decision === "later") return "review-later";
  if (decision === "import") return null;
  return mode === "live" ? null : "review-unreviewed";
}

/**
 * Review mode for a webhook event, from the event itself rather than a date.
 * - "add": Meta reports new content (a new post, or a photo newly added to
 *   any album) -> live.
 * - "edited": live only for a post the website already knows: imported
 *   earlier (facebook_posts) or announced by an "add" event (which may still
 *   be queued). An edit of a post the site never saw is historical content
 *   and needs an Import decision. A photo edit without a post id is
 *   historical too.
 */
export async function webhookReviewMode(db, row) {
  if (row?.verb === "add") return "live";
  const postId = typeof row?.post_id === "string" && ID.test(row.post_id) ? row.post_id : null;
  if (!postId || !db) return "historical";
  const known = await db
    .prepare(`SELECT (SELECT COUNT(*) FROM facebook_posts WHERE fb_post_id = ?1)
                   + (SELECT COUNT(*) FROM facebook_webhook_events WHERE post_id = ?1 AND verb = 'add') AS n`)
    .bind(postId)
    .first();
  return known?.n ? "live" : "historical";
}

// --- helpers -----------------------------------------------------------------

function safeKey(raw, roots) {
  const key = typeof raw === "string" ? raw : "";
  if (!key || key.length > 300 || key.includes("..") || key.includes("//") || key.includes("\\")) return null;
  if (/[\u0000-\u001f\u007f]/.test(key)) return null;
  if (!roots.some((r) => key.startsWith(r)) || !IMAGE_KEY_EXT.test(key)) return null;
  return key;
}

function nextCursor(page) {
  if (!page?.paging?.next) return null;
  const after = page.paging.cursors?.after;
  if (!after || !CURSOR.test(after)) throw new Error("Unsupported Graph cursor");
  return after;
}

function pickPreview(images) {
  const list = (Array.isArray(images) ? images : []).filter((i) => i && typeof i.source === "string");
  if (!list.length) return null;
  const byWidth = [...list].sort((a, b) => (Number(a.width) || 0) - (Number(b.width) || 0));
  return byWidth.find((i) => (Number(i.width) || 0) >= PREVIEW_MIN_WIDTH) || byWidth.at(-1);
}

async function decisionsFor(db, ids) {
  const out = new Map();
  if (!ids.length) return out;
  try {
    for (let i = 0; i < ids.length; i += 90) {
      const chunk = ids.slice(i, i + 90);
      const { results = [] } = await db
        .prepare(`SELECT fb_photo_id, decision, duplicate_of, note, updated_at FROM facebook_photo_reviews WHERE fb_photo_id IN (${chunk.map(() => "?").join(",")})`)
        .bind(...chunk)
        .all();
      for (const r of results) out.set(r.fb_photo_id, r);
    }
  } catch (e) {
    if (!missingTable(e)) throw e;
  }
  return out;
}

async function importStates(db, ids) {
  const out = new Map();
  for (let i = 0; i < ids.length; i += 90) {
    const chunk = ids.slice(i, i + 90);
    if (!chunk.length) break;
    const { results = [] } = await db
      .prepare(`SELECT fb_photo_id, status, hidden, master_key FROM facebook_photos WHERE fb_photo_id IN (${chunk.map(() => "?").join(",")})`)
      .bind(...chunk)
      .all();
    for (const r of results) {
      out.set(r.fb_photo_id, r.status === "imported" && r.master_key ? (r.hidden ? "hidden" : "imported") : r.status);
    }
  }
  return out;
}

// --- endpoints ---------------------------------------------------------------

async function reviewAlbums(env, h) {
  const pageId = h.configuredPageId(env);
  if (!pageId) return h.jsonResult({ error: "FB_PAGE_ID is not configured" }, 500);
  const budget = h.newBudget(20);
  const albums = [];
  let after = null;
  for (let n = 0; n < 10; n++) {
    const page = await h.graphGet(env, `${pageId}/albums`, { fields: "id,name,count,from,created_time", limit: ALBUM_PAGE, after }, budget);
    for (const a of page?.data || []) {
      if (!ID.test(a?.id || "")) continue;
      if (a.from?.id && String(a.from.id) !== pageId) continue;
      albums.push({ id: a.id, name: String(a.name || "").slice(0, 200), count: Number(a.count) || 0, createdTime: a.created_time || null });
    }
    after = nextCursor(page);
    if (!after) break;
  }
  const targets = await h.readAlbumTargets(env);
  let decisionRows = [];
  try {
    decisionRows = (await env.DB.prepare(`SELECT album_id, decision, COUNT(*) AS n FROM facebook_photo_reviews GROUP BY album_id, decision`).all()).results || [];
  } catch (e) {
    if (!missingTable(e)) throw e;
  }
  const importedRows = (await env.DB.prepare(`SELECT album_id, COUNT(*) AS n FROM facebook_photos WHERE status = 'imported' AND master_key IS NOT NULL GROUP BY album_id`).all()).results || [];
  const mappingRows = (await env.DB.prepare(`SELECT m.album_id, p.id, p.name, p.linked_prefix FROM facebook_album_mappings m JOIN facebook_projects p ON p.id = m.project_id`).all()).results || [];
  const imported = new Map(importedRows.map((r) => [r.album_id, r.n]));
  const mapping = new Map(mappingRows.map((r) => [r.album_id, { projectId: r.id, name: r.name, prefix: r.linked_prefix }]));
  const decisions = new Map();
  for (const r of decisionRows) {
    const d = decisions.get(r.album_id) || { import: 0, skip: 0, later: 0 };
    d[r.decision] = r.n;
    decisions.set(r.album_id, d);
  }
  const suggestion = (name) => h.classifyAlbum(name, targets, h.GENERIC_WORDS).candidates
    .map((t) => ({ value: t.value, name: t.name, category: t.category, prefix: t.prefix || null, source: t.source, id: t.id ?? null }));
  return h.jsonResult({
    albums: albums.map((a) => ({
      ...a,
      kind: h.albumCollectionKind(a.name),
      suggested: suggestion(a.name),
      mapping: mapping.get(a.id) || null,
      decisions: decisions.get(a.id) || { import: 0, skip: 0, later: 0 },
      imported: imported.get(a.id) || 0,
    })),
    galleries: targets.map((t) => ({ value: t.value, name: t.name, category: t.category, prefix: t.prefix || null, source: t.source, id: t.id ?? null })),
    historicalImportEnabled: env.FB_HISTORICAL_IMPORT_ENABLED === "true",
  });
}

async function reviewAlbum(env, request, h) {
  const url = new URL(request.url);
  const albumId = url.searchParams.get("id") || "";
  const after = url.searchParams.get("after");
  if (!ID.test(albumId)) return h.jsonResult({ error: "Invalid album id" }, 400);
  if (after !== null && !CURSOR.test(after)) return h.jsonResult({ error: "Invalid cursor" }, 400);
  const pageId = h.configuredPageId(env);
  const budget = h.newBudget(6);
  const album = await h.graphGet(env, albumId, { fields: "id,name,from" }, budget);
  if (album?.id !== albumId || (album.from?.id && String(album.from.id) !== pageId)) {
    return h.jsonResult({ error: "Not found" }, 404);
  }
  const page = await h.graphGet(env, `${albumId}/photos`, { fields: "id,created_time,from", limit: ALBUM_PAGE, after: after || undefined }, budget);
  const photos = [];
  let foreign = 0;
  for (const p of page?.data || []) {
    if (!ID.test(p?.id || "")) continue;
    if (String(p.from?.id || "") !== pageId) { foreign++; continue; }
    photos.push({ id: p.id, createdTime: p.created_time || null });
  }
  const ids = photos.map((p) => p.id);
  const [decisions, states] = await Promise.all([decisionsFor(env.DB, ids), importStates(env.DB, ids)]);
  return h.jsonResult({
    album: { id: albumId, name: String(album.name || "").slice(0, 200), kind: h.albumCollectionKind(album.name) },
    photos: photos.map((p) => {
      const d = decisions.get(p.id);
      return { ...p, state: states.get(p.id) || null, decision: d?.decision || null, duplicateOf: d?.duplicate_of || null, note: d?.note || null };
    }),
    foreignSkipped: foreign,
    next: nextCursor(page),
  });
}

function imageResponse(body, contentType) {
  return {
    response: new Response(body, {
      headers: { "Content-Type": contentType, "Cache-Control": PRIVATE_IMAGE_CACHE, "X-Content-Type-Options": "nosniff" },
    }),
  };
}

// Admin image endpoints cost Graph calls (shared with live webhook imports)
// and image transformations. One admin key per endpoint; the binding's limit
// is set in wrangler.toml (REVIEW_LIMITER). A missing binding (local tests)
// does not block.
async function limited(env, key) {
  if (!env.REVIEW_LIMITER) return null;
  const { success } = await env.REVIEW_LIMITER.limit({ key });
  if (success) return null;
  return {
    response: new Response(JSON.stringify({ error: "Too many image requests; retrying shortly" }), {
      status: 429,
      headers: { "Content-Type": "application/json", "Retry-After": "10", "Cache-Control": "no-store" },
    }),
  };
}

// Proxied Facebook previews are cached inside the Worker (Cache API) under a
// synthetic key that no public route can reach, so repeat views make no
// Graph calls. The cache is checked only after admin auth (index.js).
const PREVIEW_CACHE_TTL = 86400;
const previewCacheKey = (id) => new Request(`https://review-cache.internal/facebook-preview/${id}`);

async function reviewImage(env, request, h, cache) {
  const id = new URL(request.url).searchParams.get("id") || "";
  if (!ID.test(id)) return h.jsonResult({ error: "Invalid photo id" }, 400);
  const hit = cache ? await cache.match(previewCacheKey(id)) : undefined;
  if (hit) return imageResponse(hit.body, hit.headers.get("Content-Type") || "image/jpeg");
  const throttled = await limited(env, "review-image");
  if (throttled) return throttled;
  const pageId = h.configuredPageId(env);
  const photo = await h.graphGet(env, id, { fields: "id,from,images" }, h.newBudget(3));
  if (photo?.id !== id || String(photo.from?.id || "") !== pageId) return h.jsonResult({ error: "Not found" }, 404);
  const best = pickPreview(photo.images);
  if (!best) return h.jsonResult({ error: "Not found" }, 404);
  const src = h.assertFacebookCdnUrl(best.source);
  const resp = await fetch(src, { redirect: "manual", signal: AbortSignal.timeout(15000) });
  if (!resp.ok) return h.jsonResult({ error: "Image unavailable" }, 502);
  const type = (resp.headers.get("Content-Type") || "").split(";")[0].trim().toLowerCase();
  if (!IMAGE_TYPES.has(type)) return h.jsonResult({ error: "Unsupported image type" }, 502);
  if (Number(resp.headers.get("Content-Length") || "0") > MAX_PREVIEW_BYTES) return h.jsonResult({ error: "Image too large" }, 502);
  const bytes = await resp.arrayBuffer();
  if (bytes.byteLength > MAX_PREVIEW_BYTES) return h.jsonResult({ error: "Image too large" }, 502);
  if (cache) {
    await cache.put(previewCacheKey(id), new Response(bytes.slice(0), {
      headers: { "Content-Type": type, "Cache-Control": `public, max-age=${PREVIEW_CACHE_TTL}` },
    })).catch(() => {});
  }
  return imageResponse(bytes, type);
}

async function reviewSiteGallery(env, request, h) {
  const url = new URL(request.url);
  const roots = h.MANUAL_PROJECT_ROOTS;
  const all = url.searchParams.get("all") === "1";
  const projectId = url.searchParams.get("project");
  if (projectId !== null) {
    // A Facebook project (e.g. Ganz Garage): its imported photos, served by photo-file.
    if (!/^\d{1,9}$/.test(projectId)) return h.jsonResult({ error: "Invalid project" }, 400);
    const { results = [] } = await env.DB
      .prepare(`SELECT fb_photo_id FROM facebook_photos WHERE project_id = ? AND status = 'imported' AND master_key IS NOT NULL ORDER BY fb_created_time LIMIT 500`)
      .bind(Number(projectId))
      .all();
    return h.jsonResult({ items: results.map((r) => ({ facebookPhotoId: r.fb_photo_id })) });
  }
  let prefixes;
  if (all) prefixes = roots;
  else {
    const prefix = url.searchParams.get("prefix") || "";
    const known = (await h.listManualProjects(env)).map((p) => p.prefix);
    if (!known.includes(prefix)) return h.jsonResult({ error: "Unknown gallery" }, 404);
    prefixes = [prefix];
  }
  const items = [];
  for (const prefix of prefixes) {
    let cursor;
    do {
      const res = await env.GALLERY_BUCKET.list({ prefix, cursor, limit: 1000 });
      for (const o of res.objects || []) {
        const key = safeKey(o.key, roots);
        if (key) items.push({ key, gallery: key.slice(0, key.lastIndexOf("/") + 1) });
      }
      cursor = res.truncated ? res.cursor : undefined;
    } while (cursor && items.length < 2000);
  }
  return h.jsonResult({ items: items.slice(0, 2000) });
}

async function reviewSiteImage(env, request, h) {
  const key = safeKey(new URL(request.url).searchParams.get("key"), h.MANUAL_PROJECT_ROOTS);
  if (!key) return h.jsonResult({ error: "Invalid key" }, 400);
  const throttled = await limited(env, "review-site-image");
  if (throttled) return throttled;
  const obj = await env.GALLERY_BUCKET.get(key);
  if (!obj) return h.jsonResult({ error: "Not found" }, 404);
  if (env.IMAGES) {
    try {
      const out = await env.IMAGES.input(obj.body).transform({ width: 400, fit: "scale-down" }).output({ format: "image/jpeg", quality: 75 });
      return imageResponse(await out.response().arrayBuffer(), "image/jpeg");
    } catch (e) {
      console.warn("[facebook-review] resize failed; serving original:", h.redact(e?.message || e, env));
      const again = await env.GALLERY_BUCKET.get(key);
      if (!again) return h.jsonResult({ error: "Not found" }, 404);
      return imageResponse(again.body, again.httpMetadata?.contentType || "image/jpeg");
    }
  }
  return imageResponse(obj.body, obj.httpMetadata?.contentType || "image/jpeg");
}

function validDuplicateOf(raw, roots) {
  if (raw === undefined || raw === null || raw === "") return null;
  if (typeof raw !== "string") throw new Error("Invalid duplicateOf");
  if (raw.startsWith("facebook:") && ID.test(raw.slice(9))) return raw;
  const key = safeKey(raw, roots);
  if (!key) throw new Error("Invalid duplicateOf");
  return key;
}

async function reviewDecisions(env, request, h) {
  const type = (request.headers.get("Content-Type") || "").split(";")[0].trim().toLowerCase();
  if (type !== "application/json") return h.jsonResult({ error: "JSON required" }, 415);
  const body = await request.json().catch(() => null);
  const list = Array.isArray(body?.decisions) ? body.decisions : null;
  if (!list || !list.length || list.length > MAX_DECISIONS_PER_REQUEST) {
    return h.jsonResult({ error: `Send 1-${MAX_DECISIONS_PER_REQUEST} decisions` }, 400);
  }
  const statements = [];
  const seen = new Set();
  try {
    for (const d of list) {
      const photoId = String(d?.photoId || "");
      if (!ID.test(photoId) || seen.has(photoId)) throw new Error("Invalid or repeated photoId");
      seen.add(photoId);
      if (d.decision === "clear") {
        statements.push(env.DB.prepare(`DELETE FROM facebook_photo_reviews WHERE fb_photo_id = ?`).bind(photoId));
        continue;
      }
      if (!DECISIONS.has(d.decision)) throw new Error("Invalid decision");
      const albumId = d.albumId == null || d.albumId === "" ? null : String(d.albumId);
      if (albumId !== null && !ID.test(albumId)) throw new Error("Invalid albumId");
      const duplicateOf = d.decision === "skip" ? validDuplicateOf(d.duplicateOf, h.MANUAL_PROJECT_ROOTS) : null;
      const note = d.note == null ? null : String(d.note).slice(0, 500);
      statements.push(env.DB
        .prepare(`INSERT INTO facebook_photo_reviews (fb_photo_id, album_id, decision, duplicate_of, note)
                  VALUES (?, ?, ?, ?, ?)
                  ON CONFLICT(fb_photo_id) DO UPDATE SET
                    album_id = COALESCE(excluded.album_id, album_id), decision = excluded.decision,
                    duplicate_of = excluded.duplicate_of, note = excluded.note,
                    updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')`)
        .bind(photoId, albumId, d.decision, duplicateOf, note));
    }
  } catch (e) {
    return h.jsonResult({ error: e.message }, 400);
  }
  await env.DB.batch(statements);
  return h.jsonResult({ ok: true, saved: statements.length });
}

async function reviewSummary(env, h) {
  let byDecision = [];
  let readyToImport = 0;
  try {
    byDecision = (await env.DB.prepare(`SELECT decision, COUNT(*) AS n FROM facebook_photo_reviews GROUP BY decision`).all()).results || [];
    readyToImport = (await env.DB.prepare(`SELECT COUNT(*) AS n FROM facebook_photo_reviews r LEFT JOIN facebook_photos p ON p.fb_photo_id = r.fb_photo_id
      WHERE r.decision = 'import' AND (p.fb_photo_id IS NULL OR p.status = 'failed')`).first())?.n || 0;
  } catch (e) {
    if (!missingTable(e)) throw e;
    return h.jsonResult({ migrated: false, decisions: { import: 0, skip: 0, later: 0 }, readyToImport: 0 });
  }
  const decisions = { import: 0, skip: 0, later: 0 };
  for (const r of byDecision) decisions[r.decision] = r.n;
  return h.jsonResult({ migrated: true, decisions, readyToImport });
}

/**
 * Dispatch for /facebook/admin/review-*. Returns a handler result or null.
 * opts.cache defaults to the Workers Cache API (tests inject their own).
 */
export async function handleReviewAdmin(request, env, sub, h, opts = {}) {
  const method = request.method;
  const cache = "cache" in opts ? opts.cache : globalThis.caches?.default;
  if (sub === "review-albums" && method === "GET") return await reviewAlbums(env, h);
  if (sub === "review-album" && method === "GET") return await reviewAlbum(env, request, h);
  if (sub === "review-image" && method === "GET") return await reviewImage(env, request, h, cache);
  if (sub === "review-site-gallery" && method === "GET") return await reviewSiteGallery(env, request, h);
  if (sub === "review-site-image" && method === "GET") return await reviewSiteImage(env, request, h);
  if (sub === "review-decisions" && method === "POST") return await reviewDecisions(env, request, h);
  if (sub === "review-summary" && method === "GET") return await reviewSummary(env, h);
  return null;
}
