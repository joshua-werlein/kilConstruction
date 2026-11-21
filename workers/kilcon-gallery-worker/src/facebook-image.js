// Gated delivery of Facebook-imported photos: images.kilcon.work/Facebook/*
// (Worker route). See docs/facebook-image-cache.md.
//
// Every request is checked against D1 before anything is served, including a
// cached copy, so hiding, deleting or unpublishing a photo takes effect at once.
// Bytes always come from the PRIVATE bucket's master copy, never from the
// public bucket. Failures are closed: any error answers 503 no-store and
// never falls through to R2.
//
//   /Facebook/<id>.<ext>          full image       public, max-age=300
//   /Facebook/w/480/<id>.<ext>    480px thumbnail  public, max-age=300 (edge-cached by the Worker)
//   anything else, hidden, deleted, unknown        404 no-store

import { FACEBOOK_PREFIX, VISIBLE_PHOTO_SQL } from "./facebook.js";

export const FB_IMAGE_HOST = "images.kilcon.work";
export const FB_IMAGE_BROWSER_CACHE = "public, max-age=300";
// Widths the gate will produce. The site only uses the 480px thumbnail; each
// extra width is another unique transformation per photo per month.
export const FB_THUMB_WIDTH = 480;
export const FB_VARIANT_WIDTHS = Object.freeze([FB_THUMB_WIDTH]);
// Lifetime of the Worker's own edge copy of a variant (Cache API). Safe to be
// long: the D1 check runs before every cache lookup.
const VARIANT_EDGE_CACHE = "public, s-maxage=86400";

const TYPE_BY_EXT = Object.freeze({ jpg: "image/jpeg", png: "image/png", webp: "image/webp" });
const FULL_RE = /^\/Facebook\/(\d{1,32})\.(jpg|png|webp)$/;
const VARIANT_RE = /^\/Facebook\/w\/(\d{1,4})\/(\d{1,32})\.(jpg|png|webp)$/;

const NO_STORE = Object.freeze({
  "Cache-Control": "no-store",
  "Content-Type": "text/plain; charset=utf-8",
  "X-Content-Type-Options": "nosniff",
});

function plain(status, text, extra = {}) {
  return new Response(text, { status, headers: { ...NO_STORE, ...extra } });
}
const notFound = () => plain(404, "Not found");

/** Strict, canonical paths only: no decoding, no extra segments, no other widths. */
export function parseFacebookImagePath(pathname) {
  let m = FULL_RE.exec(pathname);
  if (m) return { id: m[1], ext: m[2], width: null };
  m = VARIANT_RE.exec(pathname);
  if (m) {
    const width = Number(m[1]);
    // Canonical digits only ("0480" would otherwise alias 480).
    if (!FB_VARIANT_WIDTHS.includes(width) || String(width) !== m[1]) return null;
    return { id: m[2], ext: m[3], width };
  }
  return null;
}

/** The photo's private master key if, and only if, the photo is publicly visible right now. */
async function visibleMasterKey(env, id, ext) {
  if (env.FB_INTEGRATION_ENABLED !== "true" || !env.DB) return null;
  const row = await env.DB
    .prepare(
      `SELECT ph.master_key FROM facebook_photos ph JOIN facebook_projects p ON p.id = ph.project_id
        WHERE ph.fb_photo_id = ? AND ${VISIBLE_PHOTO_SQL}`
    )
    .bind(id)
    .first();
  const key = `${FACEBOOK_PREFIX}${id}.${ext}`;
  return row?.master_key === key ? key : null;
}

function imageHeaders(contentType, etag) {
  const h = {
    "Content-Type": contentType,
    "Cache-Control": FB_IMAGE_BROWSER_CACHE,
    "X-Content-Type-Options": "nosniff",
  };
  if (etag) h.ETag = etag;
  return h;
}

function etagMatches(request, etag) {
  const inm = request.headers.get("If-None-Match");
  if (!inm || !etag) return false;
  return inm.trim() === "*" || inm.split(",").map((s) => s.trim().replace(/^W\//, "")).includes(etag);
}

async function serveFull(request, env, key, ext) {
  const obj = await env.PRIVATE_BUCKET.get(key);
  if (!obj) return notFound();
  const headers = imageHeaders(TYPE_BY_EXT[ext], obj.httpEtag);
  if (etagMatches(request, obj.httpEtag)) {
    await obj.body?.cancel?.();
    return new Response(null, { status: 304, headers });
  }
  headers["Content-Length"] = String(obj.size);
  return new Response(request.method === "HEAD" ? null : obj.body, { status: 200, headers });
}

async function transformVariant(env, key, width) {
  const obj = await env.PRIVATE_BUCKET.get(key);
  if (!obj) return null;
  try {
    if (!env.IMAGES) throw new Error("IMAGES binding missing");
    const out = await env.IMAGES.input(obj.body)
      .transform({ width, fit: "scale-down" })
      .output({ format: "image/jpeg", quality: 80 });
    const body = await out.response().arrayBuffer();
    return { body, type: "image/jpeg", etag: `"w${width}-${obj.etag}"`, cacheable: true };
  } catch (e) {
    // Quota (9422), oversized input, or binding outage. The photo is visible
    // (the gate already passed), so serving the original is not a bypass. It
    // is not cached, so the next request tries the transformation again.
    console.warn("[facebook-image] transform failed; serving original:", e?.message || e);
    const orig = await env.PRIVATE_BUCKET.get(key);
    if (!orig) return null;
    return { body: await orig.arrayBuffer(), type: TYPE_BY_EXT[key.split(".").pop()], etag: orig.httpEtag, cacheable: false };
  }
}

async function serveVariant(request, env, ctx, cache, key, parsed) {
  const cacheKey = new Request(`https://${FB_IMAGE_HOST}/Facebook/w/${parsed.width}/${parsed.id}.${parsed.ext}`);
  let body;
  let type;
  let etag;
  const hit = cache ? await cache.match(cacheKey) : undefined;
  if (hit) {
    body = hit.body;
    type = hit.headers.get("Content-Type") || "image/jpeg";
    etag = hit.headers.get("ETag");
  } else {
    const v = await transformVariant(env, key, parsed.width);
    if (!v) return notFound();
    ({ body, type, etag } = v);
    if (v.cacheable && cache) {
      const stored = new Response(v.body.slice(0), { headers: { "Content-Type": type, ETag: etag, "Cache-Control": VARIANT_EDGE_CACHE } });
      const put = cache.put(cacheKey, stored);
      if (ctx?.waitUntil) ctx.waitUntil(put); else await put;
    }
  }
  const headers = imageHeaders(type, etag);
  const notModified = etagMatches(request, etag);
  if ((notModified || request.method === "HEAD") && hit) await hit.body?.cancel?.();
  if (notModified) return new Response(null, { status: 304, headers });
  return new Response(request.method === "HEAD" ? null : body, { status: 200, headers });
}

/**
 * Entry point for requests on images.kilcon.work/Facebook/*.
 * `opts.cache` defaults to the Workers Cache API (tests inject their own).
 */
export async function serveFacebookImage(request, env, ctx, opts = {}) {
  const cache = "cache" in opts ? opts.cache : globalThis.caches?.default;
  try {
    if (request.method !== "GET" && request.method !== "HEAD") {
      return plain(405, "Method not allowed", { Allow: "GET, HEAD" });
    }
    const parsed = parseFacebookImagePath(new URL(request.url).pathname);
    if (!parsed) return notFound();
    const key = await visibleMasterKey(env, parsed.id, parsed.ext);
    if (!key) return notFound();
    return parsed.width
      ? await serveVariant(request, env, ctx, cache, key, parsed)
      : await serveFull(request, env, key, parsed.ext);
  } catch (e) {
    console.error("[facebook-image] failed closed:", e?.message || e);
    return plain(503, "Temporarily unavailable", { "Retry-After": "30" });
  }
}

/** Thumbnail URL for a Facebook public key ("Facebook/<id>.<ext>"), or null for other keys. */
export function facebookThumbUrl(base, path) {
  const m = /^Facebook\/(\d{1,32}\.(?:jpg|png|webp))$/.exec(path);
  return m ? `${base.replace(/\/+$/, "")}/Facebook/w/${FB_THUMB_WIDTH}/${m[1]}` : null;
}
