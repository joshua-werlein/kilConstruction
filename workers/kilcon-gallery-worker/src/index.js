/**
 * Welcome to Cloudflare Workers! This is your first worker.
 *
 * - Run "npm run dev" in your terminal to start a development server
 * - Open a browser tab at http://localhost:8787/ to see your worker in action
 * - Run "npm run deploy" to publish your worker
 *
 * Learn more at https://developers.cloudflare.com/workers/
 */

import {
  handleFacebookWebhook,
  handleFacebookScheduled,
  runFacebookBackfill,
  handleFacebookAdmin,
  listFacebookProjects,
  getFacebookProject,
  getLinkedFacebookItems,
} from "./facebook.js";
import {
  REVIEWS_PHOTO_PREFIX,
  REVIEW_ID_RE,
  photoContentType,
  sniffImageType,
  getReview,
  putReview,
  listReviews,
  deleteReview,
  savePhoto,
  photoResponse,
  reviewPhotoKey,
  runReviewMigration,
} from "./reviewPrivacy.js";

// Facebook sync ships disabled. Until FB_INTEGRATION_ENABLED = "true", every
// Facebook route 404s, public galleries never query D1, and cron is a no-op.
function fbEnabled(env) {
  return env.FB_INTEGRATION_ENABLED === "true";
}

async function checkRateLimit(limiter, key) {
  try {
    const { success } = await limiter.limit({ key });
    return success;
  } catch (e) {
    console.error("[rateLimit] binding error:", e);
    return true; // fail open
  }
}

// --- Admin token helpers (must match createAdminToken) -----------------

function base64urlToUint8Array(base64url) {
  const base64 =
    base64url.replace(/-/g, "+").replace(/_/g, "/") +
    "===".slice((base64url.length + 3) % 4);

  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);

  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }

  return bytes;
}

function uint8ArrayToBase64url(bytes) {
  let binary = "";
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]);
  }

  const base64 = btoa(binary);
  return base64.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

async function signPayloadB64(payloadB64, secret) {
  const encoder = new TextEncoder();

  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );

  const sig = await crypto.subtle.sign("HMAC", key, encoder.encode(payloadB64));
  return uint8ArrayToBase64url(new Uint8Array(sig));
}

async function verifyAdminToken(token, secret, sessionVersion) {
  if (!token || !secret) return false;

  const parts = token.split(".");
  if (parts.length !== 2) return false;

  const payloadB64 = parts[0];
  const sigB64 = parts[1];

  // Compute expected signature
  let expectedSigB64;
  try {
    expectedSigB64 = await signPayloadB64(payloadB64, secret);
  } catch {
    return false;
  }

  // constant-time-ish compare
  if (expectedSigB64.length !== sigB64.length) return false;

  let diff = 0;
  for (let i = 0; i < expectedSigB64.length; i++) {
    diff |= expectedSigB64.charCodeAt(i) ^ sigB64.charCodeAt(i);
  }
  if (diff !== 0) return false;

  // validate payload
  try {
    const payloadBytes = base64urlToUint8Array(payloadB64);
    const json = new TextDecoder().decode(payloadBytes);
    const payload = JSON.parse(json);

    const nowSeconds = Math.floor(Date.now() / 1000);

    if (typeof payload.exp !== "number" || payload.exp < nowSeconds) {
      return false;
    }

    if (typeof payload.iat === "number" && payload.iat > nowSeconds + 60) {
      return false;
    }

    // New: require matching session version
    if (typeof payload.ver !== "string" || payload.ver !== sessionVersion) {
      return false;
    }

    return true;
  } catch {
    return false;
  }
}

const ALLOWED_ORIGINS = [
  "https://kilcon.work",
  "http://localhost:4321"
];

const SECURITY_HEADERS = {
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "strict-origin-when-cross-origin",
  "Permissions-Policy": "camera=(), microphone=(), geolocation=()",
  "X-Frame-Options": "DENY",
  "Cache-Control": "no-store",
};

function json(obj, status = 200, request) {
  const origin = request?.headers.get("Origin") || "";
  const allow = ALLOWED_ORIGINS.includes(origin) ? origin : "https://kilcon.work";

  return new Response(JSON.stringify(obj), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Access-Control-Allow-Origin": allow,
      "Access-Control-Allow-Credentials": "true",
      ...SECURITY_HEADERS,
    },
  });
}

const IMAGE_EXT = /\.(jpe?g|png|webp|avif)$/i;
const MAX_REVIEW_PHOTO_BYTES = 15 * 1024 * 1024;
const PUBLIC_REVIEW_PHOTO_BASE = "https://kilcon.work/api/reviews/photo";
// Public R2 custom domain; the images.kilcon.work/Reviews/* route lands here.
const PUBLIC_IMAGE_HOST = "images.kilcon.work";

function slugifyName(name) {
  return (name || "")
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/gi, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "") || "project";
}

const CATEGORY_PREFIX = {
  projects: "Projects/",
  furniture: "Furniture/",
  "new-construction": "New Construction/",
  remodels: "Remodels/",
  apparel: "Apparel/",
};

const PUBLIC_LIST_KEYS = [
  "projects",
  "furniture",
  "new-construction",
  "remodels",
  "apparel",
];

// roots allowed for admin operations
const ALLOWED_ROOTS = [
  "Highlights",
  "Projects",
  "New Construction",
  "Remodels",
  "Furniture",
  "Apparel",
];

// --- helpers for admin security + keys ---------------------------------

function parseCookies(header) {
  const out = {};
  if (!header) return out;
  const parts = header.split(";");
  for (const part of parts) {
    const [name, ...rest] = part.split("=");
    if (!name) continue;
    const key = decodeURIComponent(name.trim());
    const value = decodeURIComponent(rest.join("=").trim() || "");
    if (!key) continue;
    out[key] = value;
  }
  return out;
}

async function requireAdmin(request, env) {
  const secret = env.ADMIN_SECRET;
  const sessionVersion = env.SESSION_VERSION ?? "1";

  if (!secret || !sessionVersion) {
    console.error("[gallery-api] Missing ADMIN_SECRET or SESSION_VERSION in env");
    return json({ error: "Something went wrong. Please try again later." }, 500, request);
  }

  const cookieHeader = request.headers.get("Cookie") || "";
  const cookies = parseCookies(cookieHeader);
  const token = cookies["admin_auth"] || "";

  try {
    const ok = await verifyAdminToken(token, secret, sessionVersion);
    if (!ok) {
      return json({ error: "Unauthorized" }, 401, request);
    }
    return null;
  } catch (err) {
    console.error("[gallery-api] admin token verify error:", err);
    return json({ error: "Unauthorized" }, 401, request);
  }
}


function sanitizePrefix(raw) {
  if (!raw) return null;

  const cleaned = String(raw).replace(/\\/g, "/").trim();
  if (!cleaned) return null;

  const parts = cleaned.split("/").filter(Boolean);
  if (!parts.length) return null;

  const root = parts[0];
  if (!ALLOWED_ROOTS.includes(root)) return null;

  // no traversal / odd segments
  if (parts.some((p) => p === "." || p === "..")) return null;

  return parts.join("/");
}

function sanitizeKey(raw) {
  const key = sanitizePrefix(raw);
  if (!key) return null;

  // Reject directory-marker "objects"
  if (key.endsWith("/")) return null;

  const parts = key.split("/").filter(Boolean);
  if (parts.length < 2) return null; // must be Root/<file> at least

  const root = parts[0];
  const file = parts[parts.length - 1] || "";
  if (!file) return null;

  // Enforce image extension for ALL gallery file operations
  if (!IMAGE_EXT.test(file)) return null;

  // Highlights must be flat: Highlights/<file> only
  if (root === "Highlights") {
    if (parts.length !== 2) return null;
    return `Highlights/${file}`;
  }

  return key;
}

// --- main worker --------------------------------------------------------
export default {
  async fetch(request, env, ctx) {
    try {
      const url = new URL(request.url);
      const pathname = url.pathname;
      const params = url.searchParams;

      // Review attachments are never served straight from the public bucket;
      // approved photos go through /api/reviews/photo instead.
      if (url.hostname === PUBLIC_IMAGE_HOST) {
        return new Response("Not found", { status: 404, headers: SECURITY_HEADERS });
      }

      // --- Handle OPTIONS (CORS preflight) ---
      if (request.method === "OPTIONS") {
        const origin = request.headers.get("Origin") || "";
        const allow = ALLOWED_ORIGINS.includes(origin)
          ? origin
          : "https://kilcon.work";

        return new Response(null, {
          status: 204,
          headers: {
            "Access-Control-Allow-Origin": allow,
            "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
            "Access-Control-Allow-Headers": "Content-Type",
            "Access-Control-Allow-Credentials": "true",
            "Access-Control-Max-Age": "86400",
            ...SECURITY_HEADERS,
          },
        });
      }

      // ---------- REVIEWS ROUTES ---------------------------------------

      if (pathname === "/api/reviews/summary" && request.method === "GET") {
        const ip = request.headers.get("CF-Connecting-IP") || "unknown";
        if (!await checkRateLimit(env.READ_LIMITER, `reviews-summary:${ip}`)) {
            return json({ error: "Too many requests" }, 429, request);
        }
        return await handleReviewsSummary(request, env);
      }

      if (pathname === "/api/reviews" && request.method === "GET") {
        const ip = request.headers.get("CF-Connecting-IP") || "unknown";
        if (!await checkRateLimit(env.READ_LIMITER, `reviews-list:${ip}`)) {
            return json({ error: "Too many requests" }, 429, request);
        }
        return await handleReviewsPublicList(request, env);
      }

      if (pathname === "/api/reviews/photo" && request.method === "GET") {
        const ip = request.headers.get("CF-Connecting-IP") || "unknown";
        if (!await checkRateLimit(env.READ_LIMITER, `review-photo:${ip}`)) {
            return json({ error: "Too many requests" }, 429, request);
        }
        return await handleReviewPhoto(request, env, url);
      }

      if (pathname === "/api/reviews/admin/migrate" && request.method === "POST") {
        const authResp = await requireAdmin(request, env);
        if (authResp) return authResp;
        const { status, body } = await runReviewMigration(request, env);
        return json(body, status, request);
      }

      if (pathname === "/api/reviews/submit" && request.method === "POST") {
        const ip = request.headers.get("CF-Connecting-IP") || "unknown";
        if (!await checkRateLimit(env.WRITE_LIMITER, `review-submit:${ip}`)) {
            return json({ error: "Too many submissions" }, 429, request);
        }
        return await handleReviewsSubmit(request, env);
      }

      // Admin reviews
      if (pathname === "/api/reviews/admin/list" && request.method === "GET") {
        return await handleReviewsAdminList(request, env);
      }

      if (pathname === "/api/reviews/admin/status" && request.method === "POST") {
        return await handleReviewsAdminStatus(request, env);
      }

      if (pathname === "/api/reviews/admin/reply" && request.method === "POST") {
        return await handleReviewsAdminReply(request, env);
      }

      if (pathname === "/api/reviews/admin/delete" && request.method === "POST") {
        return await handleReviewsAdminDelete(request, env);
      }

      // ---------- FACEBOOK PAGE WEBHOOK (public, signature-verified) ----

      if (pathname.startsWith("/api/gallery-api/facebook/") && !fbEnabled(env)) {
        return json({ error: "Not found" }, 404, request);
      }

      if (pathname === "/api/gallery-api/facebook/webhook") {
        return await handleFacebookWebhook(request, env, ctx);
      }

      if (pathname === "/api/gallery-api/facebook/backfill" && request.method === "POST") {
        const authResp = await requireAdmin(request, env);
        if (authResp) return authResp;
        const { status, body } = await runFacebookBackfill(request, env);
        return json(body, status, request);
      }

      if (pathname.startsWith("/api/gallery-api/facebook/admin/")) {
        const authResp = await requireAdmin(request, env);
        if (authResp) return authResp;
        const sub = pathname.slice("/api/gallery-api/facebook/admin/".length);
        const result = await handleFacebookAdmin(request, env, sub, galleryUrls(env));
        if (result.response) return result.response;
        return json(result.body, result.status, request);
      }

       // ---------- ADMIN ROUTES (all require admin_auth cookie) ----------

      if (pathname === "/api/gallery-api/upload" && request.method === "POST") {
        return await handleUpload(request, env);
      }

      if (pathname === "/api/gallery-api/list-images" && request.method === "GET") {
        return await listImages(env, request, url);
      }

      if (pathname === "/api/gallery-api/delete" && request.method === "POST") {
        return await deleteFile(env, request);
      }

      if (pathname === "/api/gallery-api/delete-project" && request.method === "POST") {
        return await deleteProject(env, request);
      }

      if (pathname === "/api/gallery-api/rename" && request.method === "POST") {
        return await renameObject(env, request);
      }

      if (pathname === "/api/gallery-api/rename-prefix" && request.method === "POST") {
        return handleRenamePrefix(request, env);
      }

      // ---------- PUBLIC READ ROUTES ------------------------------------

      if (pathname === "/api/gallery-api" && params.has("project")) {
        // Public read — NO rate limiting
        if (request.method !== "GET") {
          return json({ error: "Method not allowed" }, 405, request);
        }
        return await getProject(params.get("project"), env, request);
      }

      if (pathname === "/api/gallery-api") {
        if (request.method !== "GET") {
          return json({ error: "Method not allowed" }, 405, request);
        }
        // Normalize list param
        const rawList = params.get("list");
        const listParam = rawList ? rawList.toString().trim() : null;
      
        // Normalize & clamp all flag
        const allParam = params.get("all");
        const listAll = allParam === "1";

        // ADMIN-ONLY: ?all=1 enumerates all roots — require admin cookie
        if (listAll) {
          const authResp = await requireAdmin(request, env);
          if (authResp) return authResp;
        }
      
        // Validate listParam if present
        if (
          listParam &&
          !PUBLIC_LIST_KEYS.includes(listParam) &&
          listParam !== "highlights"
        ) {
          return json({ error: "Invalid list parameter" }, 400, request);
        }
      
        // Dedicated highlights handler
        if (listParam === "highlights") {
          return await listHighlights(env, request);
        }
      
        const onlyPrefix =
          listParam && CATEGORY_PREFIX[listParam]
            ? CATEGORY_PREFIX[listParam]
            : null;
      
        // Public pages: ?list=projects / ?list=furniture / ?list=new-construction / ?list=remodels / ?list=apparel
        // Admin manage page: ?all=1 (no list) → see EVERYTHING
        return await listProjects(env, request, { listAll, onlyPrefix, listParam });
      }

      // IMPORTANT: 404 with CORS
      return json({ error: "Not found" }, 404, request);
    } catch (err) {
      console.error("Gallery worker error:", err);
      return json({ error: "Internal error" }, 500, request);
    }
  },

  async scheduled(controller, env, ctx) {
    if (!fbEnabled(env)) return;
    ctx.waitUntil(
      handleFacebookScheduled(env).catch((err) =>
        console.error("[facebook] scheduled error:", err?.message || err)
      )
    );
  },
};
 
// ---------- LIST PROJECTS ----------
async function listProjects(env, request, { listAll = false, onlyPrefix = null, listParam = null } = {}) {
  try {
    const projects = [];
    const root = await env.GALLERY_BUCKET.list({ prefix: "", delimiter: "/" });

    let level1 = (root.delimitedPrefixes || []).filter((p) => {
      const rootName = p.replace(/\/$/, "");
      return ALLOWED_ROOTS.includes(rootName);
    });    

    if (!listAll) {
      if (onlyPrefix) {
        // Public: restrict to a single top-level directory
        level1 = level1.filter((p) => p === onlyPrefix);
      } else {
        // Backwards-compatible default: only “Projects/”
        level1 = level1.filter((p) => p === "Projects/");
      }
    }

    for (const prefix1 of level1) {
      const level1List = await env.GALLERY_BUCKET.list({
        prefix: prefix1,
        delimiter: "/",
      });

      const level2 = level1List.delimitedPrefixes || [];

      if (level2.length) {
        for (const prefix2 of level2) {
          const project = await buildProjectFromPrefix(env, prefix2);
          if (project) projects.push(project);
        }
      } else {
        const project = await buildProjectFromPrefix(env, prefix1);
        if (project) projects.push(project);
      }
    }

    // Facebook-imported projects join the public category lists (not the
    // admin ?all=1 view, which manages R2 folders only).
    if (!listAll && fbEnabled(env)) {
      const category = listParam || "projects";
      projects.push(...(await listFacebookProjects(env, category, galleryUrls(env))));
    }

    const payloadKey =
      listAll || !listParam || listParam === "projects"
      ? "projects"
      : listParam;

    return json({ [payloadKey]: projects }, 200, request);
  } catch (err) {
    console.error("listProjects error:", err);
    return json({ projects: [], error: "Failed to list projects" }, 500, request);
  }
}

async function listHighlights(env, request) {
  try {
    const bucket = env.GALLERY_BUCKET;
    if (!bucket) {
      console.error("[listHighlights] Missing GALLERY_BUCKET binding");
      return json({ items: [], error: "Something went wrong. Please try again later." }, 500, request);
    }

    // Grab everything under Highlights/
    const list = await bucket.list({ prefix: "Highlights/" });

    const items = [];

    for (const obj of list.objects) {
      if (!IMAGE_EXT.test(obj.key)) continue;
      if (obj.key.split("/").filter(Boolean).length !== 2) continue;

      const full = publicUrl(obj.key, env);
      const name = obj.key.split("/").pop() || "";

      items.push({
        name,
        full,
        thumb: buildThumbUrl(full, env),
      });
    }

    // Optional: stable order
    items.sort((a, b) => a.name.localeCompare(b.name));

    return json({ items }, 200, request);
  } catch (err) {
    console.error("[listHighlights] error:", err);
    return json({ items: [], error: "Something went wrong. Please try again later." }, 500, request);
  }
}

async function buildProjectFromPrefix(env, prefix) {
  const list = await env.GALLERY_BUCKET.list({ prefix });

  const previews = [];

  for (const obj of list.objects) {
    if (!IMAGE_EXT.test(obj.key)) continue;

    const url = publicUrl(obj.key, env);
    previews.push(url);

    if (previews.length >= 3) break;
  }

  if (!previews.length) return null;

  // prefix like "Projects/Ganz Re-Deck/" -> "Ganz Re-Deck"
  const trimmed = prefix.replace(/\/$/, "");
  const parts = trimmed.split("/");
  const folderName = parts[parts.length - 1].replace(/[_]+/g, " ");
  const slug = slugifyName(folderName);

  return {
    slug,
    prefix,
    name: folderName,
    year: "",
    location: "",
    summary: "",
    previews: previews.map((u) => ({ full: u, thumb: buildThumbUrl(u, env), })),
    images: { thumb: buildThumbUrl(previews[0], env), full: previews[0] },
  };
}

async function findPrefixByCategoryAndSlug(env, categoryKey, slug) {
  const wanted = String(slug || "").toLowerCase();

  // Map the category (e.g. "furniture") to an actual R2 prefix (e.g. "Furniture/")
  // Only known public categories; never fall back to an arbitrary R2 root.
  const categoryName = String(categoryKey || "").toLowerCase();
  if (!Object.hasOwn(CATEGORY_PREFIX, categoryName)) return null;
  let topPrefix = CATEGORY_PREFIX[categoryName];

  if (!topPrefix.endsWith("/")) {
    topPrefix = topPrefix + "/";
  }

  // List subfolders under that top-level prefix
  const level1List = await env.GALLERY_BUCKET.list({
    prefix: topPrefix,
    delimiter: "/",
  });

  const level2 = level1List.delimitedPrefixes || [];

  // Case 1: category has subfolders: Furniture/Cabinets/, Furniture/Epoxy/, etc.
  if (level2.length) {
    for (const prefix2 of level2) {
      const trimmed = prefix2.replace(/\/$/, "");
      const name = trimmed.split("/").pop() || "";
      if (slugifyName(name) === wanted) {
        return prefix2;
      }
    }
  } else {
    // Case 2: no subfolders, images directly in the category folder
    const trimmed = topPrefix.replace(/\/$/, "");
    const name = trimmed.split("/").pop() || "";
    if (slugifyName(name) === wanted) {
      return topPrefix;
    }
  }

  return null;
}

async function findPrefixBySlug(env, slug) {
  const wanted = String(slug || "").toLowerCase();

  // Top level
  const root = await env.GALLERY_BUCKET.list({ prefix: "", delimiter: "/" });
  // Only public gallery roots: Reviews/, Facebook/ and any other storage
  // prefixes must never be addressable through ?project=<slug>.
  let level1 = (root.delimitedPrefixes || []).filter((p) =>
    ALLOWED_ROOTS.includes(p.replace(/\/$/, ""))
  );

  for (const prefix1 of level1) {
    const list1 = await env.GALLERY_BUCKET.list({
      prefix: prefix1,
      delimiter: "/",
    });
    const level2 = list1.delimitedPrefixes || [];

    if (level2.length) {
      for (const prefix2 of level2) {
        const trimmed = prefix2.replace(/\/$/, "");
        const name = trimmed.split("/").pop() || "";
        if (slugifyName(name) === wanted) return prefix2;
      }
    } else {
      const trimmed = prefix1.replace(/\/$/, "");
      const name = trimmed.split("/").pop() || "";
      if (slugifyName(name) === wanted) return prefix1;
    }
  }

  return null;
}

// ---------- SINGLE PROJECT ----------
async function getProject(projectKey, env, request) {
  try {
    if (typeof projectKey !== "string" || projectKey.length > 256) {
      return json({ project: null, items: [] }, 400, request);
    }

    const normalizedKey = projectKey.trim().toLowerCase();

    // Allow only slugs and category/slug: letters, numbers, dashes, slashes
    if (!/^[a-z0-9\-\/]+$/.test(normalizedKey)) {
      return json({ project: null, items: [] }, 400, request);
    }

    let prefix = null;

    // support "category/slug" syntax, e.g. "furniture/decks"
    if (normalizedKey.includes("/")) {
      const [categoryPart, slugPartRaw] = normalizedKey.split("/", 2);
      const slugPart = slugPartRaw || "";

      // Try to find within a specific category
      prefix = await findPrefixByCategoryAndSlug(env, categoryPart, slugPart);
    }

    // Backwards-compatible fallback: plain slug (old behavior)
    if (!prefix) {
      prefix = await findPrefixBySlug(env, normalizedKey);
    }

    // Defense in depth: whatever resolved the prefix, it must be a public root.
    if (prefix && !ALLOWED_ROOTS.includes(prefix.split("/")[0])) prefix = null;

    if (!prefix) {
      const fb = fbEnabled(env) ? await getFacebookProject(env, normalizedKey, galleryUrls(env)) : null;
      if (fb) return json(fb, 200, request);
      return json({ project: null, items: [] }, 404, request);
    }

    const list = await env.GALLERY_BUCKET.list({ prefix });

    const items = [];

    for (const obj of list.objects) {
      if (!IMAGE_EXT.test(obj.key)) continue;

      const full = publicUrl(obj.key, env);
      const thumb = buildThumbUrl(full, env);
      const fileName = obj.key.split("/").pop();

      items.push({
        name: fileName,
        full,
        thumb,
      });
    }

    // Facebook photos merged into this gallery (caption match or admin move)
    if (fbEnabled(env)) items.push(...(await getLinkedFacebookItems(env, prefix, galleryUrls(env))));

    items.sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: "base" }));

    // Drop just the top-level folder (Projects/Furniture/New Construction/Remodels/etc.)
    const projectFolder = prefix
      .split("/")
      .filter(Boolean)
      .slice(1) // remove top-level category
      .join(" ")
      .replace(/[_]+/g, " ");

    const project = {
      name: projectFolder,
      description: "",
    };

    return json({ project, items }, 200, request);
  } catch (err) {
    console.error("getProject error:", err, "projectKey=", projectKey);
    return json(
      { project: null, items: [], error: "Failed to load project" },
      500,
      request
    );
  }
}

const THUMB_PARAMS = "width=480,fit=cover,quality=80";

function buildThumbUrl(full, env) {
  // If you haven't wired a thumbnail base, just fall back to full
  const baseForResize = env.THUMB_BASE_URL || null;
  if (!baseForResize) return full;

  try {
    const u = new URL(full);
    const path = u.pathname.replace(/^\/+/, "");
    const base = baseForResize.replace(/\/+$/, "");
    return `${base}/cdn-cgi/image/${THUMB_PARAMS}/${path}`;
  } catch (e) {
    console.warn("buildThumbUrl failed for", full, e);
    return full;
  }
}

// ---------- ADMIN IMPLEMENTATIONS --------------------------------------

// POST /api/gallery-api/upload  (multipart/form-data)
async function handleUpload(request, env) {
  const authResp = await requireAdmin(request, env);
  if (authResp) return authResp;

  const bucket = env.GALLERY_BUCKET;
  if (!bucket) {
    console.error("[upload] Missing GALLERY_BUCKET binding");
    return json({ error: "Something went wrong. Please try again later." }, 500, request);
  }

  const form = await request.formData();

  let uploaded = 0;
  const urls = [];

  for (const [fieldName, value] of form.entries()) {
    if (fieldName === "notes") continue;
    if (!(value instanceof File)) continue;

    const key = sanitizeKey(fieldName);
    if (!key) {
      console.warn("[upload] rejected key", fieldName);
      continue;
    }

    // enforce MIME starts with image/
    if (value.type && !value.type.startsWith("image/")) {
      console.warn("[upload] rejected non-image contentType", value.type, fieldName);
      continue;
    }

    const arrayBuffer = await value.arrayBuffer();
    await bucket.put(key, arrayBuffer, {
      httpMetadata: {
        contentType: value.type || "image/jpeg",
      },
    });
    uploaded++;
    urls.push(publicUrl(key, env));
  }

  return json({ ok: true, uploaded, urls }, 200, request);
}

// GET /api/gallery-api/list-images?prefix=Projects/Foo/
async function listImages(env, request, url) {
  const authResp = await requireAdmin(request, env);
  if (authResp) return authResp;

  const rawPrefix = url.searchParams.get("prefix");
  let prefix = sanitizePrefix(rawPrefix);
  if (!prefix) {
    return json({ objects: [], error: "Invalid prefix" }, 400, request);
  }
  // normalize to folder prefix
  if (!prefix.endsWith("/")) prefix += "/";
  
  const bucket = env.GALLERY_BUCKET;
  if (!bucket) {
    console.error("[list-images] Missing GALLERY_BUCKET binding");
    return json({ objects: [], error: "Something went wrong. Please try again later." }, 500, request);
  }

  try {
    const list = await bucket.list({ prefix });

    const objects = (list.objects || [])
      .filter((obj) => IMAGE_EXT.test(obj.key))
      .map((obj) => ({
        key: obj.key,
        name: obj.key.split("/").pop() || "",
        size: obj.size ?? null,
        uploaded: obj.uploaded
          ? new Date(obj.uploaded).toISOString()
          : null,
      }));

    return json({ objects }, 200, request);
  } catch (err) {
    console.error("[list-images] error for prefix", prefix, err);
    return json(
      { objects: [], error: "Failed to list images" },
      500,
      request,
    );
  }
}

// POST /api/gallery-api/delete  { "key": "Projects/Foo/img.jpg" }
async function deleteFile(env, request) {
  const authResp = await requireAdmin(request, env);
  if (authResp) return authResp;

  const bucket = env.GALLERY_BUCKET;
  if (!bucket) {
    console.error("[delete] Missing GALLERY_BUCKET binding");
    return json({ error: "Something went wrong. Please try again later." }, 500, request);
  }

  const body = await request.json().catch(() => ({}));
  const rawKey = typeof body.key === "string" ? body.key : null;
  const key = sanitizeKey(rawKey);

  if (!key) {
    return json({ error: "Invalid key" }, 400, request);
  }

  try {
    await bucket.delete(key);
    return json({ ok: true }, 200, request);
  } catch (err) {
    console.error("[delete] Failed:", err);
    return json({ error: "Delete failed." }, 500, request);
  }
}

// POST /api/gallery-api/delete-project  { "prefix": "Projects/Foo/" }
async function deleteProject(env, request) {
  const authResp = await requireAdmin(request, env);
  if (authResp) return authResp;

  const bucket = env.GALLERY_BUCKET;
  if (!bucket) {
    console.error("[delete-project] Missing GALLERY_BUCKET binding");
    return json({ error: "Something went wrong. Please try again later." }, 500, request);
  }

  const body = await request.json().catch(() => ({}));
  const rawPrefix = typeof body.prefix === "string" ? body.prefix : null;
  let prefix = sanitizePrefix(rawPrefix);

  if (!prefix) {return json({ error: "Invalid prefix" }, 400, request); }

  if (!prefix.endsWith("/")) prefix += "/";

  try {
    let cursor = undefined;
    const keys = [];

    do {
      const res = await bucket.list({ prefix, cursor });
      for (const obj of res.objects || []) {
        keys.push(obj.key);
      }
      cursor = res.truncated ? res.cursor : undefined;
    } while (cursor);

    if (keys.length > 0) {
      await bucket.delete(keys);
    }

    return json({ ok: true, deleted: keys.length }, 200, request);
  } catch (err) {
    console.error("[delete-project] Failed:", err);
    return json({ error: "Delete failed" }, 500, request);
  }
}

// POST /api/gallery-api/rename  { "oldKey": "...", "newKey": "..." }
async function renameObject(env, request) {
  const authResp = await requireAdmin(request, env);
  if (authResp) return authResp;

  const bucket = env.GALLERY_BUCKET;
  if (!bucket) {
    console.error("[rename] Missing GALLERY_BUCKET binding");
    return json({ error: "Something went wrong. Please try again later." }, 500, request);
  }

  const body = await request.json().catch(() => ({}));
  const oldKey = sanitizeKey(typeof body.oldKey === "string" ? body.oldKey : null);
  const newKey = sanitizeKey(typeof body.newKey === "string" ? body.newKey : null);

  if (!oldKey || !newKey) {
    return json({ error: "Invalid key" }, 400, request);
  }

  try {
    const obj = await bucket.get(oldKey);
    if (!obj || !obj.body) {
      return json({ error: "Source not found" }, 404, request);
    }

    await bucket.put(newKey, obj.body, {
      httpMetadata: obj.httpMetadata,
    });
    await bucket.delete(oldKey);

    console.log("[rename] success", { oldKey, newKey });

    return json({ ok: true }, 200, request);
  } catch (err) {
    console.error("[rename] Failed:", err);
    return json({ error: "Rename failed." }, 500, request);
  }
}

async function handleRenamePrefix(request, env) {
  // Require admin cookie like other admin routes
  const authResp = await requireAdmin(request, env);
  if (authResp) return authResp;

  const bucket = env.GALLERY_BUCKET;
  if (!bucket) {
    console.error("[rename-prefix] Missing GALLERY_BUCKET binding");
    return json({ error: "Something went wrong. Please try again later." }, 500, request);
  }

  const body = await request.json().catch(() => null);
  if (!body || !body.oldPrefix || !body.newPrefix) {
    return json({ error: "oldPrefix and newPrefix required" }, 400, request);
  }

  // Sanitize and normalise both prefixes
  const oldRaw = String(body.oldPrefix || "");
  const newRaw = String(body.newPrefix || "");

  let oldPrefix = sanitizePrefix(oldRaw);
  let newPrefix = sanitizePrefix(newRaw);

  if (!oldPrefix || !newPrefix) {
    return json({ error: "Invalid prefix" }, 400, request);
  }

  if (!oldPrefix.endsWith("/")) oldPrefix += "/";
  if (!newPrefix.endsWith("/")) newPrefix += "/";

  const oldRoot = oldPrefix.split("/").filter(Boolean)[0] || "";
  const newRoot = newPrefix.split("/").filter(Boolean)[0] || "";
  if (!oldRoot || !newRoot || oldRoot !== newRoot) {
    return json({ error: "Root cannot be changed" }, 400, request);
  }

  console.log("[rename-prefix] renaming", oldPrefix, "→", newPrefix);

  let movedCount = 0;
  let cursor = undefined;

  try {
    do {
      const res = await bucket.list({ prefix: oldPrefix, cursor });
      const objects = res.objects || [];
      
      for (const obj of objects) {
        const oldKey = obj.key;
        if (!IMAGE_EXT.test(oldKey)) continue;
        
        const suffix = oldKey.slice(oldPrefix.length);
        const newKey = newPrefix + suffix;

        // Same pattern as renameObject: get → put → delete
        const src = await bucket.get(oldKey);
        if (!src || !src.body) {
          console.warn("[rename-prefix] source missing for", oldKey);
          continue;
        }
        const safeNewKey = sanitizeKey(newKey);
        if (!safeNewKey) {
          console.warn("[rename-prefix] rejected newKey", newKey);
          continue;
        }

        await bucket.put(safeNewKey, src.body, {
          httpMetadata: src.httpMetadata,
        });
        await bucket.delete(oldKey);

        movedCount++;
      }

      cursor = res.truncated ? res.cursor : undefined;
    } while (cursor);

    return json({ ok: true, moved: movedCount }, 200, request);
  } catch (err) {
    console.error("[rename-prefix] error:", err);
    return json({ error: "Rename prefix failed." }, 500, request);
  }
}

// ---------- HELPERS ----------
function galleryUrls(env) {
  return {
    publicUrl: (key) => publicUrl(key, env),
    thumbUrl: (full) => buildThumbUrl(full, env),
  };
}

function publicUrl(key, env) {
  const base = env.BUCKET_BASE_URL; // e.g. "https://pub-xxxx.r2.dev"
  return `${base}/${encodeURIComponent(key).replace(/%2F/g, "/")}`;
}

// ================== REVIEWS IMPLEMENTATION =============================

async function listAllReviews(env) {
  return await listReviews(env);
}

function reviewsToPublic(rec, env) {
  return {
    id: rec.id,
    createdAt: rec.createdAt,
    rating: rec.rating,
    text: rec.text,
    clientNamePublic: rec.clientNamePublic,
    projectType: rec.projectType,
    location: rec.location || null,
    photoUrl: reviewPhotoUrl(rec, env),
    adminReply: rec.adminReply || null,
    adminReplyAt: rec.adminReplyAt || null,
    featured: !!rec.featured,
  };
}

function buildPublicName(full, showFull) {
  const trimmed = (full || "").trim();
  if (!trimmed) return "Client";
  if (showFull) return trimmed;

  const parts = trimmed.split(/\s+/);
  const first = parts[0] || "";
  const last = parts[1] || "";
  const cap = (s) => s.charAt(0).toUpperCase() + s.slice(1);

  if (last) return `${cap(first)} ${last.charAt(0).toUpperCase()}.`;
  return cap(first);
}

function clampRating(raw) {
  if (!raw) return null;
  const n = Number(raw);
  if (!Number.isFinite(n)) return null;
  const r = Math.round(n);
  if (r < 1 || r > 5) return null;
  return r;
}

// Review photos are served only through /api/reviews/photo, which checks
// approval; the stored photoUrl (public bucket URL) is never handed out.
// Review photos are served only through /api/reviews/photo, which checks
// approval; the stored photoUrl (public bucket URL) is never handed out.
function reviewPhotoUrl(rec, env) {
  if (!reviewPhotoKey(rec, env)) return null;
  return `${PUBLIC_REVIEW_PHOTO_BASE}?id=${encodeURIComponent(rec.id)}`;
}



// GET /api/reviews/photo?id=r_...  approved reviews publicly, any review for admins
// GET /api/reviews/photo?id=r_...  approved reviews publicly, any review for admins
async function handleReviewPhoto(request, env, url) {
  const id = url.searchParams.get("id") || "";
  const notFound = () => json({ error: "Not found" }, 404, request);
  if (!REVIEW_ID_RE.test(id)) return notFound();

  const rec = await getReview(env, id);
  const key = rec ? reviewPhotoKey(rec, env) : null;
  if (!key) return notFound();

  const approved = rec.status === "approved";
  if (!approved) {
    // Same 404 for non-admins so the response doesn't reveal a private review.
    const authResp = await requireAdmin(request, env);
    if (authResp) return notFound();
  }

  const resp = await photoResponse(env, key, { publicCache: approved });
  return resp || notFound();
}

// ---- public: summary ----
async function handleReviewsSummary(request, env) {
  try {
    const all = await listAllReviews(env);
    const approved = all.filter((r) => r.status === "approved");

    if (!approved.length) {
      return json({
        averageRating: 0,
        totalReviews: 0,
        ratingBreakdown: { 5: 0, 4: 0, 3: 0, 2: 0, 1: 0 },
      }, 200, request);
    }

    const breakdown = { 5: 0, 4: 0, 3: 0, 2: 0, 1: 0 };
    let sum = 0;
    for (const r of approved) {
      sum += r.rating;
      breakdown[r.rating] = (breakdown[r.rating] || 0) + 1;
    }
    const avg = sum / approved.length;

    return json({
      averageRating: Math.round(avg * 10) / 10,
      totalReviews: approved.length,
      ratingBreakdown: breakdown,
    }, 200, request);
  } catch (e) {
    console.error("[reviews] summary error:", e);
    return json({ error: "Failed to load summary" }, 500, request);
  }
}

// ---- public: list ----
async function handleReviewsPublicList(request, env) {
  try {
    const url = new URL(request.url);

    // Sanitize projectType
    let projectType = url.searchParams.get("projectType");
    if (projectType) {
      projectType = projectType.toString().trim();
      // Hard cap length to avoid nonsense input
      if (projectType.length > 50) {
        projectType = null;
      }
    }

    // Safe pagination: clamp page and pageSize
    const rawPage = Number(url.searchParams.get("page") || "1");
    let page = Number.isFinite(rawPage) ? Math.floor(rawPage) : 1;
    if (page < 1) page = 1;
    if (page > 100) page = 100;
    
    const rawPageSize = Number(url.searchParams.get("pageSize") || "10");
    let pageSize = Number.isFinite(rawPageSize) ? Math.floor(rawPageSize) : 10;
    if (pageSize < 1) pageSize = 1;
    if (pageSize > 50) pageSize = 50; // prevent massive slices

    const all = await listAllReviews(env);
    let filtered = all.filter((r) => r.status === "approved");

    if (projectType) {
      filtered = filtered.filter((r) => r.projectType === projectType);
    }

    const hasTypeFilter = !!projectType;

    filtered.sort((a, b) => {
      // When not filtered by category, featured reviews float to top
      if (!hasTypeFilter) {
        const af = a.featured ? 1 : 0;
        const bf = b.featured ? 1 : 0;
        if (bf !== af) {
          return bf - af; // featured (1) before non-featured (0)
        }
      }

      // Tie-breaker (or when category filter is active): newest first
      return new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime();
    });

    const start = (page - 1) * pageSize;
    const slice = filtered.slice(start, start + pageSize);

    return json({
      total: filtered.length,
      page,
      pageSize,
      reviews: slice.map((r) => reviewsToPublic(r, env)),
    }, 200, request);
  } catch (e) {
    console.error("[reviews] list error:", e);
    return json({ error: "Failed to list reviews" }, 500, request);
  }
}

// ---- public: submit ----
async function handleReviewsSubmit(request, env) {
  try {
    // Review records and photos are private; refuse rather than fall back
    // to the world-readable gallery bucket.
    if (!env.PRIVATE_BUCKET) {
      console.error("[reviews] Missing PRIVATE_BUCKET binding; refusing submission");
      const accept = request.headers.get("Accept") || "";
      if (accept.includes("text/html")) {
        return redirectReviews(request, "?err=server");
      }
      return json({ error: "Something went wrong. Please try again later." }, 500, request);
    }

    const ct = request.headers.get("content-type") || "";

    if (!ct.includes("multipart/form-data")) {
      // HTML form posts should be multipart; others get a JSON error
      const accept = request.headers.get("Accept") || "";

      if (accept.includes("text/html")) {
        return redirectReviews(request, "?err=input");
      }

      return json({ error: "Expected multipart/form-data" }, 400, request);
    }

    const form = await request.formData();

    const name = (form.get("name") || "").toString().trim();
    const projectType = ((form.get("projectType") || "other").toString().trim()) || "other";
    const location = (form.get("location") || "").toString().trim();
    const rating = clampRating((form.get("rating") || "").toString());
    const text = (form.get("text") || "").toString().trim();

    const showFullName = (form.get("showFullName") || "").toString() === "on";
    const allowMarketing = (form.get("allowMarketing") || "").toString() === "on";
    const cfToken = (form.get("cf-turnstile-response") || "").toString();

    if (name.length < 2 || !rating || text.length < 40) {
      const accept = request.headers.get("Accept") || "";
      if (accept.includes("text/html")) {
        return redirectReviews(request, "?err=input");
      }
      return json({ error: "Invalid input" }, 400, request);
    }

    // Optional Turnstile verify if bound
    if (env.TURNSTILE_SECRET) {
      try {
        const vr = await fetch("https://challenges.cloudflare.com/turnstile/v0/siteverify", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            secret: env.TURNSTILE_SECRET,
            response: cfToken,
            remoteip: request.headers.get("CF-Connecting-IP") || undefined,
          }),
        });
        const verify = await vr.json();
        if (!verify || !verify.success) {
          console.warn("[reviews] Turnstile failed:", verify);
          const accept = request.headers.get("Accept") || "";

          if (accept.includes("text/html")) {
            return redirectReviews(request, "?err=captcha");
          }
          return json({ error: "Captcha failed" }, 400, request);
        }
      } catch (e) {
        console.warn("[reviews] Turnstile error:", e);
        const accept = request.headers.get("Accept") || "";

        if (accept.includes("text/html")) {
          return redirectReviews(request, "?err=captcha");
        }
        return json({ error: "Captcha failed" }, 400, request);
      }
    }

    const ts = new Date().toISOString().replace(/[:.]/g, "-");
    const rand = Math.random().toString(36).slice(2, 8);
    const id = `r_${ts}_${rand}`;

    // optional photo
    let photoKey = null;
    const photo = form.get("photo");
    if (photo instanceof File && photo.size > 0) {
      const safeName =
        (photo.name || "photo.jpg").replace(/[^a-zA-Z0-9._-]+/g, "_") || "photo.jpg";
      
        // Enforce allowed image extensions, and check the bytes really are that
      // format (the client-supplied MIME type is never trusted or stored).
      const expectedType = photoContentType(safeName);
      const photoBytes = expectedType && photo.size <= MAX_REVIEW_PHOTO_BYTES
        ? await photo.arrayBuffer()
        : null;
      const typeOk = !!photoBytes && sniffImageType(photoBytes) === expectedType;

      if (!typeOk) {
        const accept = request.headers.get("Accept") || "";
        if (accept.includes("text/html")) {
          return redirectReviews(request, "?err=photo");
        }
        return json({ error: "Invalid photo type" }, 400, request);
      }

      photoKey = `${REVIEWS_PHOTO_PREFIX}${id}/${safeName}`;
      await savePhoto(env, photoKey, photoBytes);
    }

    const rec = {
      id,
      createdAt: new Date().toISOString(),
      status: "pending",
      featured: false,
      rating,
      text,
      clientNameFull: name,
      clientNamePublic: buildPublicName(name, showFullName),
      projectType,
      location: location || null,
      photoKey,
      photoUrl: null,
      allowMarketing,
      adminReply: null,
      adminReplyAt: null,
    };

    await putReview(env, rec);

     // Decide response based on client
     const accept = request.headers.get("Accept") || "";

     // Browser form post → redirect back with ?sent=1
     if (accept.includes("text/html")) {
       return redirectReviews(request, "?sent=1");
     }
    
    // API clients → JSON
    return json({ ok: true }, 200, request);
  } catch (e) {
    console.error("[reviews] submit error:", e);
    const accept = request.headers.get("Accept") || "";
    if (accept.includes("text/html")) {
      // Generic server error for browsers
      return redirectReviews(request, "?err=server");
    }
    return json({ error: "Failed to submit review" }, 500, request);
  }
}

/**
 * Helper: redirect back to the reviews page with a given suffix
 * e.g. "?sent=1" or "?err=captcha"
 */
function redirectReviews(request, suffix) {
  const ref = request.headers.get("Referer");
  let origin = "https://kilcon.work";

  if (ref) {
    try {
      const u = new URL(ref);
      if (ALLOWED_ORIGINS.includes(u.origin)) origin = u.origin;
    } catch {
      // keep default origin
    }
  }

  const target = `${origin}/reviews${suffix || ""}#leave-review`;
  return Response.redirect(target, 303);
}

// ---- admin: list ----
async function handleReviewsAdminList(request, env) {
  const auth = await requireAdmin(request, env);
  if (auth) return auth;

  try {
    const url = new URL(request.url);
    const statusFilter = url.searchParams.get("status");
    const projectType = url.searchParams.get("projectType");

    const all = await listAllReviews(env);
    let filtered = all;
    if (statusFilter) {
      filtered = filtered.filter((r) => r.status === statusFilter);
    }
    if (projectType) {
      filtered = filtered.filter((r) => r.projectType === projectType);
    }

    filtered.sort(
      (a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()
    );

    return json(
      { reviews: filtered.map((r) => ({ ...r, photoUrl: reviewPhotoUrl(r, env) })) },
      200,
      request
    );
  } catch (e) {
    console.error("[reviews] admin list error:", e);
    return json({ error: "Failed to load reviews" }, 500, request);
  }
}

// ---- admin: status / featured ----
async function handleReviewsAdminStatus(request, env) {
  const auth = await requireAdmin(request, env);
  if (auth) return auth;

  try {
    const body = await request.json().catch(() => ({}));
    const id = String(body.id || "");
    const status = String(body.status || "");
    const featured = !!body.featured;

    if (!REVIEW_ID_RE.test(id) || !["pending", "approved", "hidden"].includes(status)) {
      return json({ error: "Invalid input" }, 400, request);
    }

    const rec = await getReview(env, id);
    if (!rec) return json({ error: "Not found" }, 404, request);

    rec.status = status;
    rec.featured = featured;

    // Saved to the private bucket; a legacy public copy is superseded.
    await putReview(env, rec);

    return json({ ok: true }, 200, request);
  } catch (e) {
    console.error("[reviews] admin status error:", e);
    return json({ error: "Failed to update status" }, 500, request);
  }
}

// ---- admin: reply ----
async function handleReviewsAdminReply(request, env) {
  const auth = await requireAdmin(request, env);
  if (auth) return auth;

  try {
    const body = await request.json().catch(() => ({}));
    const id = String(body.id || "");
    const replyText = String(body.replyText || "").trim();

    if (!REVIEW_ID_RE.test(id)) return json({ error: "Invalid input" }, 400, request);

    const rec = await getReview(env, id);
    if (!rec) return json({ error: "Not found" }, 404, request);

    rec.adminReply = replyText || null;
    rec.adminReplyAt = replyText ? new Date().toISOString() : null;

    await putReview(env, rec);

    return json({ ok: true }, 200, request);
  } catch (e) {
    console.error("[reviews] admin reply error:", e);
    return json({ error: "Failed to save reply" }, 500, request);
  }
}

// ---- admin: delete ----
async function handleReviewsAdminDelete(request, env) {
  const auth = await requireAdmin(request, env);
  if (auth) return auth;

  try {
    const body = await request.json().catch(() => ({}));
    const id = String(body.id || "");
    if (!REVIEW_ID_RE.test(id)) return json({ error: "Invalid input" }, 400, request);

    const deletedPhotos = await deleteReview(env, id);
    return json({ ok: true, deletedPhotos }, 200, request);
  } catch (e) {
    console.error("[reviews] admin delete error:", e);
    return json({ error: "Failed to delete review" }, 500, request);
  }
}
