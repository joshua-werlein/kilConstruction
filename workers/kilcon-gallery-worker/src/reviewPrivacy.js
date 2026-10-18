// --- Review storage: private by default -----------------------------------
//
// Review records (Reviews/data/<id>.json, which hold the client's full name,
// location and marketing consent) and review photos (Reviews/photos/<id>/<file>)
// are written ONLY to PRIVATE_BUCKET, which has no public access.
//
// GALLERY_BUCKET is world-readable through images.kilcon.work (and r2.dev if
// enabled), so legacy objects there are treated as read-only fallbacks until the
// migration below has copied, verified and (with explicit approval) removed them.
// Reads always prefer the private copy.

export const REVIEWS_PREFIX = "Reviews/";
export const REVIEWS_DATA_PREFIX = "Reviews/data/";
export const REVIEWS_PHOTO_PREFIX = "Reviews/photos/";
export const REVIEW_ID_RE = /^r_[A-Za-z0-9_-]{1,80}$/;

const MIGRATION_PREFIX = "Migrations/reviews/";
const DELETE_CONFIRMATION = "DELETE PUBLIC REVIEW COPIES";
const MAX_MIGRATION_OBJECTS = 1000;
const MANIFEST_MAX_AGE_MS = 24 * 60 * 60 * 1000;

const TYPE_BY_EXT = {
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  png: "image/png",
  webp: "image/webp",
  avif: "image/avif",
};

// --- helpers ------------------------------------------------------------

function extOf(key) {
  const m = /\.([a-z0-9]+)$/i.exec(String(key || ""));
  return m ? m[1].toLowerCase() : "";
}

// Content type is derived from the extension, never from client input.
export function photoContentType(key) {
  return TYPE_BY_EXT[extOf(key)] || null;
}

// Identify the real format from magic bytes (JPEG, PNG, WebP, AVIF).
export function sniffImageType(bytes) {
  const b = new Uint8Array(bytes.slice(0, 16));
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return "image/jpeg";
  if (b.length >= 8 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47 &&
      b[4] === 0x0d && b[5] === 0x0a && b[6] === 0x1a && b[7] === 0x0a) return "image/png";
  const ascii = (from, to) => String.fromCharCode(...b.slice(from, to));
  if (b.length >= 12 && ascii(0, 4) === "RIFF" && ascii(8, 12) === "WEBP") return "image/webp";
  if (b.length >= 12 && ascii(4, 8) === "ftyp" && ["avif", "avis"].includes(ascii(8, 12))) return "image/avif";
  return null;
}

export function dataKey(id) {
  return `${REVIEWS_DATA_PREFIX}${id}.json`;
}

export function isReviewPhotoKey(key, id) {
  return (
    typeof key === "string" &&
    key.startsWith(`${REVIEWS_PHOTO_PREFIX}${id}/`) &&
    !key.slice(REVIEWS_PHOTO_PREFIX.length + id.length + 1).includes("/") &&
    !key.includes("..") &&
    !!photoContentType(key)
  );
}

// The photo key for a record: photoKey, or (very old records) derived from the
// stored public photoUrl. Always validated against the record's own folder.
export function reviewPhotoKey(rec, env) {
  const id = String(rec?.id || "");
  if (!REVIEW_ID_RE.test(id)) return null;
  if (isReviewPhotoKey(rec.photoKey, id)) return rec.photoKey;

  const base = env?.BUCKET_BASE_URL ? `${env.BUCKET_BASE_URL.replace(/\/+$/, "")}/` : null;
  if (base && typeof rec.photoUrl === "string" && rec.photoUrl.startsWith(base)) {
    try {
      const key = decodeURIComponent(rec.photoUrl.slice(base.length));
      if (isReviewPhotoKey(key, id)) return key;
    } catch {
      // ignore malformed URL
    }
  }
  return null;
}

async function sha256Hex(buf) {
  const d = new Uint8Array(await crypto.subtle.digest("SHA-256", buf));
  return [...d].map((x) => x.toString(16).padStart(2, "0")).join("");
}

function requirePrivate(env) {
  if (!env.PRIVATE_BUCKET) throw new Error("PRIVATE_BUCKET binding is not configured");
  return env.PRIVATE_BUCKET;
}

// --- records -------------------------------------------------------------

export async function getReview(env, id) {
  if (!REVIEW_ID_RE.test(String(id || ""))) return null;
  const key = dataKey(id);
  let obj = env.PRIVATE_BUCKET ? await env.PRIVATE_BUCKET.get(key) : null;
  if (!obj) obj = await env.GALLERY_BUCKET.get(key);
  if (!obj) return null;
  try {
    const rec = JSON.parse(await obj.text());
    return rec && rec.id === id ? rec : null;
  } catch {
    return null;
  }
}

// Writes go to the private bucket only; fails closed if it isn't bound.
export async function putReview(env, rec) {
  if (!REVIEW_ID_RE.test(String(rec?.id || ""))) throw new Error("Invalid review id");
  await requirePrivate(env).put(dataKey(rec.id), JSON.stringify(rec), {
    httpMetadata: { contentType: "application/json; charset=utf-8" },
  });
}

async function readRecords(bucket, into) {
  let cursor = undefined;
  do {
    const res = await bucket.list({ prefix: REVIEWS_DATA_PREFIX, cursor });
    for (const o of res.objects || []) {
      try {
        const stored = await bucket.get(o.key);
        if (!stored) continue;
        const rec = JSON.parse(await stored.text());
        if (rec && REVIEW_ID_RE.test(String(rec.id || "")) && o.key === dataKey(rec.id)) {
          into.set(rec.id, rec);
        }
      } catch (e) {
        console.warn("[reviews] failed to parse record", o.key, e?.message || e);
      }
    }
    cursor = res.truncated ? res.cursor : undefined;
  } while (cursor);
}

// Legacy (public) records first, then private ones override by id.
export async function listReviews(env) {
  const byId = new Map();
  await readRecords(env.GALLERY_BUCKET, byId);
  if (env.PRIVATE_BUCKET) await readRecords(env.PRIVATE_BUCKET, byId);
  return [...byId.values()];
}

async function deletePrefix(bucket, prefix) {
  const keys = [];
  let cursor = undefined;
  do {
    const res = await bucket.list({ prefix, cursor });
    for (const o of res.objects || []) keys.push(o.key);
    cursor = res.truncated ? res.cursor : undefined;
  } while (cursor);
  if (keys.length) await bucket.delete(keys);
  return keys.length;
}

// Admin-requested delete of one review (existing behavior), in both buckets.
export async function deleteReview(env, id) {
  if (!REVIEW_ID_RE.test(String(id || ""))) throw new Error("Invalid review id");
  let photos = 0;
  for (const bucket of [env.GALLERY_BUCKET, env.PRIVATE_BUCKET].filter(Boolean)) {
    await bucket.delete(dataKey(id));
    photos += await deletePrefix(bucket, `${REVIEWS_PHOTO_PREFIX}${id}/`);
  }
  return photos;
}

// --- photos ----------------------------------------------------------------

export async function savePhoto(env, key, bytes) {
  const contentType = photoContentType(key);
  if (!contentType) throw new Error("Unsupported photo type");
  await requirePrivate(env).put(key, bytes, { httpMetadata: { contentType } });
}

// Response for an authorized photo request. Type comes from the extension and
// the response is sandboxed, so a disguised file can't run as a document.
export async function photoResponse(env, key, { publicCache }) {
  const contentType = photoContentType(key);
  if (!contentType) return null;
  let obj = env.PRIVATE_BUCKET ? await env.PRIVATE_BUCKET.get(key) : null;
  if (!obj) obj = await env.GALLERY_BUCKET.get(key);
  if (!obj) return null;
  return new Response(obj.body, {
    status: 200,
    headers: {
      "Content-Type": contentType,
      "Content-Disposition": `inline; filename="photo.${extOf(key)}"`,
      "Content-Security-Policy": "default-src 'none'; sandbox",
      "X-Content-Type-Options": "nosniff",
      "Referrer-Policy": "no-referrer",
      "Cross-Origin-Resource-Policy": "same-origin",
      "Cache-Control": publicCache ? "public, max-age=300" : "private, no-store",
    },
  });
}

// --- migration of legacy public objects --------------------------------
//
// POST /api/reviews/admin/migrate  (admin only; caller enforces requireAdmin)
//   { action: "inventory" }   list every public Reviews/* object and its private state
//   { action: "copy" }        copy missing objects to PRIVATE_BUCKET, hash-verified;
//                             never overwrites an existing private object
//   { action: "verify" }      byte-compare every public object with its private copy,
//                             check each review resolves, and store a manifest
//   { action: "delete-public", manifest, confirm: "DELETE PUBLIC REVIEW COPIES" }
//                             delete ONLY public objects listed as verified in a
//                             recent verify manifest, after re-checking each one
// Manifests are stored in PRIVATE_BUCKET under Migrations/reviews/ and returned.

async function listPublicReviewObjects(env) {
  const out = [];
  let cursor = undefined;
  do {
    const res = await env.GALLERY_BUCKET.list({ prefix: REVIEWS_PREFIX, cursor });
    for (const o of res.objects || []) {
      out.push({ key: o.key, size: o.size, etag: o.etag });
      if (out.length > MAX_MIGRATION_OBJECTS) throw new Error("Too many objects for one migration run");
    }
    cursor = res.truncated ? res.cursor : undefined;
  } while (cursor);
  return out;
}

function classify(key) {
  if (key.startsWith(REVIEWS_DATA_PREFIX)) {
    const id = key.slice(REVIEWS_DATA_PREFIX.length).replace(/\.json$/, "");
    return { kind: "data", reviewId: REVIEW_ID_RE.test(id) ? id : null };
  }
  if (key.startsWith(REVIEWS_PHOTO_PREFIX)) {
    const id = key.slice(REVIEWS_PHOTO_PREFIX.length).split("/")[0];
    return { kind: "photo", reviewId: REVIEW_ID_RE.test(id) ? id : null };
  }
  return { kind: "other", reviewId: null };
}

function migrationContentType(key, kind, httpMetadata) {
  if (kind === "data") return "application/json; charset=utf-8";
  return photoContentType(key) || "application/octet-stream";
}

async function storeManifest(env, kind, manifest) {
  const key = `${MIGRATION_PREFIX}${manifest.createdAt.replace(/[:.]/g, "-")}-${kind}.json`;
  await env.PRIVATE_BUCKET.put(key, JSON.stringify(manifest, null, 2), {
    httpMetadata: { contentType: "application/json; charset=utf-8" },
  });
  return key;
}

async function inventory(env) {
  const objects = await listPublicReviewObjects(env);
  const entries = [];
  for (const o of objects) {
    const { kind, reviewId } = classify(o.key);
    const priv = await env.PRIVATE_BUCKET.head(o.key);
    entries.push({
      key: o.key,
      kind,
      reviewId,
      publicSize: o.size,
      publicEtag: o.etag,
      privateExists: !!priv,
      privateSize: priv?.size ?? null,
      copiedFromEtag: priv?.customMetadata?.sourceEtag ?? null,
    });
  }
  const summary = {
    total: entries.length,
    data: entries.filter((e) => e.kind === "data").length,
    photos: entries.filter((e) => e.kind === "photo").length,
    other: entries.filter((e) => e.kind === "other").length,
    alreadyPrivate: entries.filter((e) => e.privateExists).length,
  };
  return { status: 200, body: { action: "inventory", summary, entries } };
}

async function copy(env) {
  const objects = await listPublicReviewObjects(env);
  const createdAt = new Date().toISOString();
  const entries = [];
  for (const o of objects) {
    const { kind, reviewId } = classify(o.key);
    const entry = { key: o.key, kind, reviewId, publicEtag: o.etag, publicSize: o.size };
    try {
      if (await env.PRIVATE_BUCKET.head(o.key)) {
        // Never overwrite: a private object may be newer (e.g. an admin edit).
        entry.result = "already-private";
      } else {
        const src = await env.GALLERY_BUCKET.get(o.key);
        if (!src) {
          entry.result = "missing";
        } else {
          const bytes = await src.arrayBuffer();
          const sha256 = await sha256Hex(bytes);
          await env.PRIVATE_BUCKET.put(o.key, bytes, {
            httpMetadata: { contentType: migrationContentType(o.key, kind, src.httpMetadata) },
            customMetadata: { sha256, sourceEtag: src.etag, sourceSize: String(bytes.byteLength), migratedAt: createdAt },
          });
          const check = await env.PRIVATE_BUCKET.get(o.key);
          const checkSha = check ? await sha256Hex(await check.arrayBuffer()) : null;
          entry.sha256 = sha256;
          entry.result = checkSha === sha256 ? "copied" : "copy-verify-failed";
        }
      }
    } catch (e) {
      entry.result = "error";
      entry.error = String(e?.message || e).slice(0, 200);
    }
    entries.push(entry);
  }
  const manifest = {
    type: "copy",
    createdAt,
    entries,
    summary: countBy(entries, "result"),
  };
  manifest.manifestKey = await storeManifest(env, "copy", manifest);
  return { status: 200, body: manifest };
}

function countBy(entries, field) {
  const out = {};
  for (const e of entries) out[e[field]] = (out[e[field]] || 0) + 1;
  return out;
}

async function verify(env) {
  const objects = await listPublicReviewObjects(env);
  const createdAt = new Date().toISOString();
  const entries = [];
  for (const o of objects) {
    const { kind, reviewId } = classify(o.key);
    const entry = { key: o.key, kind, reviewId, publicEtag: o.etag, publicSize: o.size };
    try {
      const [pub, priv] = await Promise.all([env.GALLERY_BUCKET.get(o.key), env.PRIVATE_BUCKET.get(o.key)]);
      if (!pub) {
        entry.result = "public-gone";
      } else if (!priv) {
        entry.result = "missing-private";
      } else {
        const [pubBytes, privBytes] = await Promise.all([pub.arrayBuffer(), priv.arrayBuffer()]);
        entry.publicSha256 = await sha256Hex(pubBytes);
        entry.privateSha256 = await sha256Hex(privBytes);
        if (entry.publicSha256 === entry.privateSha256) {
          entry.result = "verified";
        } else if (kind === "data") {
          // The private record was updated after copying (admin status/reply).
          // It supersedes the public one if it is a valid record for the same id.
          let ok = false;
          try {
            const rec = JSON.parse(new TextDecoder().decode(privBytes));
            ok = rec?.id === reviewId && !!reviewId;
          } catch {
            ok = false;
          }
          entry.result = ok ? "verified-private-newer" : "mismatch";
        } else {
          entry.result = "mismatch";
        }
      }

      // Photos: confirm the owning review resolves to this key, so approved
      // photos keep displaying from the private copy.
      if (kind === "photo" && entry.result.startsWith("verified")) {
        const rec = reviewId ? await getReview(env, reviewId) : null;
        entry.reviewStatus = rec?.status ?? null;
        entry.resolves = !!rec && reviewPhotoKey(rec, env) === o.key;
        if (!rec) entry.note = "orphan photo (no review record)";
      }
    } catch (e) {
      entry.result = "error";
      entry.error = String(e?.message || e).slice(0, 200);
    }
    entries.push(entry);
  }

  const summary = countBy(entries, "result");
  const allVerified = entries.length > 0 && entries.every((e) => e.result.startsWith("verified"));
  const manifest = { type: "verify", createdAt, allVerified, summary, entries };
  manifest.manifestKey = await storeManifest(env, "verify", manifest);
  return { status: 200, body: manifest };
}

async function deletePublic(env, input) {
  if (input?.confirm !== DELETE_CONFIRMATION) {
    return { status: 400, body: { error: `confirm must equal "${DELETE_CONFIRMATION}"` } };
  }
  const manifestKey = String(input?.manifest || "");
  if (!manifestKey.startsWith(MIGRATION_PREFIX) || !manifestKey.endsWith("-verify.json") || manifestKey.includes("..")) {
    return { status: 400, body: { error: "manifest must be a verify manifest key" } };
  }
  const mObj = await env.PRIVATE_BUCKET.get(manifestKey);
  if (!mObj) return { status: 404, body: { error: "Manifest not found" } };
  const manifest = JSON.parse(await mObj.text());
  if (manifest.type !== "verify" || !manifest.allVerified) {
    return { status: 409, body: { error: "Manifest is not fully verified; nothing deleted" } };
  }
  if (Date.now() - new Date(manifest.createdAt).getTime() > MANIFEST_MAX_AGE_MS) {
    return { status: 409, body: { error: "Manifest is older than 24h; run verify again" } };
  }

  const createdAt = new Date().toISOString();
  const entries = [];
  for (const m of manifest.entries) {
    const entry = { key: m.key, kind: m.kind };
    try {
      // Re-check at delete time: public unchanged since verify, private intact.
      const head = await env.GALLERY_BUCKET.head(m.key);
      if (!head) {
        entry.result = "already-gone";
      } else if (head.etag !== m.publicEtag) {
        entry.result = "skipped-public-changed";
      } else {
        const priv = await env.PRIVATE_BUCKET.get(m.key);
        const privSha = priv ? await sha256Hex(await priv.arrayBuffer()) : null;
        if (!privSha || privSha !== m.privateSha256) {
          entry.result = "skipped-private-changed";
        } else {
          await env.GALLERY_BUCKET.delete(m.key);
          entry.result = "deleted";
        }
      }
    } catch (e) {
      entry.result = "error";
      entry.error = String(e?.message || e).slice(0, 200);
    }
    entries.push(entry);
  }
  const result = { type: "delete-public", createdAt, fromManifest: manifestKey, summary: countBy(entries, "result"), entries };
  result.manifestKey = await storeManifest(env, "delete", result);
  console.log("[reviews] public copies deleted", result.summary);
  return { status: 200, body: result };
}

export async function runReviewMigration(request, env) {
  if (!env.PRIVATE_BUCKET) return { status: 500, body: { error: "PRIVATE_BUCKET binding is not configured" } };
  const input = await request.json().catch(() => ({}));
  try {
    switch (input?.action || "inventory") {
      case "inventory":
        return await inventory(env);
      case "copy":
        return await copy(env);
      case "verify":
        return await verify(env);
      case "delete-public":
        return await deletePublic(env, input);
      default:
        return { status: 400, body: { error: "Unknown action" } };
    }
  } catch (e) {
    console.error("[reviews] migration error:", e?.message || e);
    return { status: 500, body: { error: "Migration failed" } };
  }
}
