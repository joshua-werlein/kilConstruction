// --- Facebook Page webhook + automatic gallery publishing ----------------
//
//   GET  /api/gallery-api/facebook/webhook   Meta verification challenge
//   POST /api/gallery-api/facebook/webhook   X-Hub-Signature-256 verified; each
//        Page `feed` change goes into the D1 inbox and the request returns 200.
//   Processing runs afterwards (ctx.waitUntil + cron sweeper) and only when
//   FB_AUTO_IMPORT === "true".
//   POST /api/gallery-api/facebook/backfill  admin-only historical import.
//   /api/gallery-api/facebook/admin/*        admin controls (see handleFacebookAdmin).
//
// Storage model
//   PRIVATE_BUCKET  Facebook/<photoId>.<ext>   master copy, never public
//   GALLERY_BUCKET  Facebook/<photoId>.<ext>   public copy, exists only while
//                                              the photo is visible
//   D1              projects, posts, photos, admin decisions (source of truth)
//
// Visibility = photo imported AND photo not hidden AND project not hidden.
// reconcilePhoto() makes the public copy match that rule, so hidden photos are
// not reachable on images.kilcon.work. Masters are never deleted, and nothing
// outside the Facebook/ prefix is ever written or deleted by this module.
//
// Secrets (never logged): FB_APP_SECRET, FB_VERIFY_TOKEN, FB_PAGE_ACCESS_TOKEN

export const FACEBOOK_PREFIX = "Facebook/";
export const RECENT_SLUG = "recent-project-updates";
const RECENT_NAME = "Recent Project Updates";

const MAX_BODY_BYTES = 512 * 1024;
const MAX_PAYLOAD_CHARS = 16 * 1024;
const MAX_IMAGE_BYTES = 25 * 1024 * 1024;
const MAX_ATTEMPTS = 5;
const MAX_BACKFILL_POSTS = 10;
const WAITUNTIL_BATCH = 5;
const CRON_BATCH = 10;
// Outbound fetches per invocation (Graph + image downloads). Stays under the
// Workers Free plan limit of 50 subrequests.
const FETCH_BUDGET = 40;
const PUBLIC_CACHE_CONTROL = "public, max-age=3600";

const ID_RE = /^[0-9_]{1,64}$/;
const GRAPH_VERSION_RE = /^v\d{1,3}\.\d{1,2}$/;
const ALLOWED_IMAGE_HOST = /(^|\.)(fbcdn\.net|facebook\.com)$/i;
const EXT_BY_TYPE = {
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
};

// Public categories a Facebook project may appear in, and the R2 roots whose
// manually uploaded folders count as existing projects.
const FB_CATEGORIES = ["projects", "new-construction", "remodels", "furniture"];
const MANUAL_PROJECT_ROOTS = ["Projects/", "New Construction/", "Remodels/", "Furniture/"];

const POST_FIELDS =
  "id,message,created_time,permalink_url,from," +
  "attachments{type,target,subattachments.limit(100){type,target}}";
const PHOTO_FIELDS = "id,images,created_time,name,link,from,album{id,name}";

const GENERIC_ALBUM_RE =
  /^(timeline photos|mobile uploads|profile pictures|cover photos|untitled album|instagram photos|photos from .*)$/i;
const COMPLETION_RE =
  /\b(completed?|finished|finish(ed)? up|wrapped up|all done|final (reveal|result|product)s?|before (and|&) after|project complete)\b/i;
// Words too generic to identify a specific project by themselves.
const GENERIC_WORDS = new Set([
  "the", "and", "a", "an", "of", "for", "new", "project", "projects", "build", "job",
  "deck", "decks", "kitchen", "kitchens", "bath", "bathroom", "bathrooms", "remodel",
  "remodels", "construction", "furniture", "cabinet", "cabinets", "house", "home",
  "garage", "addition", "porch", "roof", "basement", "epoxy", "custom",
]);

const NOW_SQL = "strftime('%Y-%m-%dT%H:%M:%fZ','now')";

// Content confirmed deleted/unpublished on Facebook is hidden at once and
// permanently deleted after FB_REMOVED_RETENTION_DAYS (1-30; the privacy
// policy promises at most 30) unless the post comes back on Facebook first.
const DEFAULT_REMOVED_RETENTION_DAYS = 30;
const MAX_REMOVED_RETENTION_DAYS = 30;
// Purge work per invocation: each photo is ~10 R2/D1 operations, which keeps
// a run well under the Workers per-invocation limits. The rest waits an hour.
const PURGE_BATCH = 50;
// Processed inbox rows are dropped after this long (Meta retries for 36 h).
const EVENT_RETENTION_DAYS = 30;
const REMOVABLE_ITEMS = ["photo", "status", "post"];

// --- small helpers --------------------------------------------------------

const encoder = new TextEncoder();

function text(body, status = 200) {
  return new Response(body, {
    status,
    headers: {
      "Content-Type": "text/plain; charset=utf-8",
      "X-Content-Type-Options": "nosniff",
      "Cache-Control": "no-store",
    },
  });
}

function bytesToHex(bytes) {
  let out = "";
  for (let i = 0; i < bytes.length; i++) out += bytes[i].toString(16).padStart(2, "0");
  return out;
}

function hexToBytes(hex) {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.substr(i * 2, 2), 16);
  return out;
}

function timingSafeEqual(a, b) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  return diff === 0;
}

async function sha256Hex(input) {
  const data = typeof input === "string" ? encoder.encode(input) : input;
  return bytesToHex(new Uint8Array(await crypto.subtle.digest("SHA-256", data)));
}

async function hmacSha256(secret, data) {
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const bytes = typeof data === "string" ? encoder.encode(data) : data;
  return new Uint8Array(await crypto.subtle.sign("HMAC", key, bytes));
}

// Compare digests so string length doesn't leak through timing.
async function safeEqualStrings(a, b) {
  const [da, db] = await Promise.all([
    crypto.subtle.digest("SHA-256", encoder.encode(String(a ?? ""))),
    crypto.subtle.digest("SHA-256", encoder.encode(String(b ?? ""))),
  ]);
  return timingSafeEqual(new Uint8Array(da), new Uint8Array(db));
}

// Deterministic JSON so retried deliveries hash identically.
function stableStringify(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  const keys = Object.keys(value).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(value[k])}`).join(",")}}`;
}

function cleanId(raw) {
  if (raw === undefined || raw === null) return null;
  const s = String(raw);
  return ID_RE.test(s) ? s : null;
}

function cleanShort(raw, max = 32) {
  if (typeof raw !== "string") return null;
  return raw.slice(0, max);
}

function slugify(name) {
  return (
    String(name || "")
      .toLowerCase()
      .trim()
      .replace(/[^a-z0-9]+/gi, "-")
      .replace(/-+/g, "-")
      .replace(/^-|-$/g, "") || "project"
  );
}

function normalizeWords(s) {
  return String(s || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

// Graph returns "2026-10-01T12:00:00+0000"; store ISO-8601 UTC.
function toIso(fbTime) {
  if (typeof fbTime !== "string") return null;
  const d = new Date(fbTime.replace(/([+-]\d{2})(\d{2})$/, "$1:$2"));
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

function firstLine(s, max = 140) {
  const line = String(s || "").split(/\r?\n/).map((l) => l.trim()).find(Boolean) || "";
  return line.length > max ? `${line.slice(0, max - 1).trimEnd()}…` : line;
}

// Strip anything that looks like a Meta access token before logging/storing.
export function redact(message, env) {
  let s = String(message ?? "");
  const token = env?.FB_PAGE_ACCESS_TOKEN;
  if (token) s = s.split(token).join("[redacted]");
  const secret = env?.FB_APP_SECRET;
  if (secret) s = s.split(secret).join("[redacted]");
  s = s.replace(/EAA[A-Za-z0-9]{10,}/g, "[redacted]");
  s = s.replace(/(access_token|appsecret_proof)=[^&\s]+/gi, "$1=[redacted]");
  return s.slice(0, 500);
}

function configuredPageId(env) {
  return cleanId(env.FB_PAGE_ID);
}

export function removedRetentionDays(env) {
  const n = Math.floor(Number(env.FB_REMOVED_RETENTION_DAYS));
  if (!Number.isFinite(n) || n < 1) return DEFAULT_REMOVED_RETENTION_DAYS;
  return Math.min(n, MAX_REMOVED_RETENTION_DAYS);
}

export function autoImportEnabled(env) {
  return env.FB_AUTO_IMPORT === "true";
}

class BudgetExhausted extends Error {
  constructor() {
    super("Fetch budget exhausted; will resume");
    this.name = "BudgetExhausted";
  }
}

function newBudget(n = FETCH_BUDGET) {
  return {
    remaining: n,
    take() {
      if (this.remaining <= 0) throw new BudgetExhausted();
      this.remaining--;
    },
  };
}

async function setState(db, key, value) {
  await db
    .prepare(
      `INSERT INTO facebook_sync_state (key, value, updated_at) VALUES (?, ?, ${NOW_SQL})
       ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`
    )
    .bind(key, value)
    .run();
}

async function getState(db, key) {
  const row = await db.prepare(`SELECT value FROM facebook_sync_state WHERE key = ?`).bind(key).first();
  return row ? row.value : null;
}

// --- signature verification -------------------------------------------

export async function verifyMetaSignature(rawBytes, header, appSecret) {
  if (!appSecret) return false;
  const m = /^sha256=([0-9a-f]{64})$/i.exec(String(header || "").trim());
  if (!m) return false;
  const expected = await hmacSha256(appSecret, rawBytes);
  return timingSafeEqual(expected, hexToBytes(m[1].toLowerCase()));
}

// --- webhook entry point ----------------------------------------------

export async function handleFacebookWebhook(request, env, ctx) {
  if (request.method === "GET") return handleVerification(request, env);
  if (request.method === "POST") return handleNotification(request, env, ctx);
  return text("Method not allowed", 405);
}

async function handleVerification(request, env) {
  if (!env.FB_VERIFY_TOKEN) {
    console.error("[facebook] FB_VERIFY_TOKEN is not configured");
    return text("Not configured", 500);
  }

  const params = new URL(request.url).searchParams;
  const mode = params.get("hub.mode");
  const token = params.get("hub.verify_token");
  const challenge = params.get("hub.challenge") || "";

  const tokenOk = await safeEqualStrings(token, env.FB_VERIFY_TOKEN);
  if (mode === "subscribe" && tokenOk && /^[A-Za-z0-9_.-]{1,512}$/.test(challenge)) {
    return text(challenge, 200);
  }

  console.warn("[facebook] webhook verification rejected");
  return text("Forbidden", 403);
}

async function handleNotification(request, env, ctx) {
  if (!env.FB_APP_SECRET) {
    console.error("[facebook] FB_APP_SECRET is not configured");
    return text("Not configured", 500);
  }

  const declared = Number(request.headers.get("Content-Length") || "0");
  if (declared > MAX_BODY_BYTES) return text("Payload too large", 413);

  const raw = new Uint8Array(await request.arrayBuffer());
  if (raw.byteLength > MAX_BODY_BYTES) return text("Payload too large", 413);

  const sigOk = await verifyMetaSignature(
    raw,
    request.headers.get("X-Hub-Signature-256"),
    env.FB_APP_SECRET
  );
  if (!sigOk) {
    console.warn("[facebook] invalid webhook signature");
    return text("Invalid signature", 401);
  }

  let body;
  try {
    body = JSON.parse(new TextDecoder().decode(raw));
  } catch {
    return text("Bad JSON", 400);
  }

  if (body?.object !== "page") return text("Ignored", 200);

  const events = await extractFeedEvents(body, env);
  if (!events.length) return text("EVENT_RECEIVED", 200);

  if (!env.DB) {
    // Non-2xx makes Meta redeliver once the binding is fixed.
    console.error("[facebook] Missing DB binding");
    return text("Not configured", 500);
  }

  const inserted = await recordEvents(env.DB, events);
  await setState(env.DB, "last_event_received_at", new Date().toISOString());
  console.log("[facebook] webhook received", { changes: events.length, inserted });

  const auto = autoImportEnabled(env);
  const removals = events.some((e) => e.verb === "remove" || e.verb === "hide");
  if (inserted > 0 && (auto || removals) && ctx?.waitUntil) {
    ctx.waitUntil(
      processPendingEvents(env, { limit: WAITUNTIL_BATCH, removalsOnly: !auto }).catch((e) =>
        console.error("[facebook] background processing error:", redact(e?.message || e, env))
      )
    );
  }

  return text("EVENT_RECEIVED", 200);
}

// Feed items that can carry Page photos. Everything else (comments,
// reactions, shares, ...) is dropped before it is stored.
const FEED_ITEMS = ["photo", "status", "post", "album", "photo-album"];

// Only the fields processing needs: no message text, names or links, so the
// inbox never holds visitors' (or anyone's) personal content.
function minimalPayload(value) {
  const out = {};
  for (const k of ["item", "verb", "post_id", "photo_id", "published", "created_time"]) {
    if (value[k] !== undefined && (typeof value[k] !== "object" || value[k] === null)) out[k] = value[k];
  }
  const fromId = cleanId(value?.from?.id);
  if (fromId) out.from = { id: fromId };
  if (Array.isArray(value.photo_ids)) out.photo_ids = value.photo_ids.map(cleanId).filter(Boolean).slice(0, 100);
  return out;
}

export async function extractFeedEvents(body, env) {
  const pageFilter = configuredPageId(env);
  const out = [];
  const entries = Array.isArray(body?.entry) ? body.entry.slice(0, 100) : [];

  for (const entry of entries) {
    const pageId = cleanId(entry?.id);
    if (!pageId) continue;
    if (pageFilter && pageId !== pageFilter) continue;

    const changes = Array.isArray(entry?.changes) ? entry.changes.slice(0, 100) : [];
    for (const change of changes) {
      if (change?.field !== "feed") continue;
      const value = change.value && typeof change.value === "object" ? change.value : null;
      if (!value) continue;
      if (!FEED_ITEMS.includes(value.item)) continue;
      // Visitor posts arrive on the same feed; they are never stored.
      const fromId = cleanId(value?.from?.id);
      if (fromId && fromId !== pageId) continue;

      // Dedupe on the full change (two different edits must both be kept);
      // store only the minimal fields.
      const full = stableStringify(value);
      const payload = stableStringify(minimalPayload(value));
      if (full.length > MAX_PAYLOAD_CHARS) {
        console.warn("[facebook] dropping oversized change payload");
        continue;
      }

      out.push({
        dedupeKey: await sha256Hex(`${pageId}|feed|${full}`),
        pageId,
        field: "feed",
        item: cleanShort(value.item),
        verb: cleanShort(value.verb),
        postId: cleanId(value.post_id),
        photoId: cleanId(value.photo_id),
        payload,
      });
    }
  }

  return out;
}

async function recordEvents(db, events) {
  const stmts = events.map((e) =>
    db
      .prepare(
        `INSERT OR IGNORE INTO facebook_webhook_events
           (dedupe_key, page_id, field, item, verb, post_id, photo_id, payload)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .bind(e.dedupeKey, e.pageId, e.field, e.item, e.verb, e.postId, e.photoId, e.payload)
  );
  const results = await db.batch(stmts);
  return results.reduce((n, r) => n + (r?.meta?.changes || 0), 0);
}

// --- event processing ---------------------------------------------------

// removalsOnly: with FB_AUTO_IMPORT off, remove/hide events are still acted
// on (they only ever take content down); imports wait for the switch.
export async function processPendingEvents(env, { limit = CRON_BATCH, removalsOnly = false } = {}) {
  const db = env.DB;
  if (!db) throw new Error("Missing DB binding");

  const { results = [] } = await db
    .prepare(
      `SELECT id, page_id, item, verb, post_id, photo_id, payload, attempts
         FROM facebook_webhook_events
        WHERE status IN ('pending','retry') AND attempts < ?
          ${removalsOnly ? "AND verb IN ('remove','hide')" : ""}
        ORDER BY id
        LIMIT ?`
    )
    .bind(MAX_ATTEMPTS, limit)
    .all();

  const summary = { processed: 0, done: 0, ignored: 0, retry: 0, failed: 0, deferred: 0 };
  const budget = newBudget();

  for (const row of results) {
    // Leave the rest for the next run rather than starting an event we can't finish.
    if (budget.remaining < 3) {
      summary.deferred++;
      continue;
    }

    // Claim the row so waitUntil and cron never process the same event twice.
    const claim = await db
      .prepare(
        `UPDATE facebook_webhook_events
            SET status = 'processing', attempts = attempts + 1, updated_at = ${NOW_SQL}
          WHERE id = ? AND status IN ('pending','retry')`
      )
      .bind(row.id)
      .run();
    if (!claim?.meta?.changes) continue;

    summary.processed++;
    const attempts = (row.attempts || 0) + 1;

    let status;
    let note = null;
    let attemptsSql = "attempts";
    try {
      const outcome = await processEvent(env, row, budget);
      status = outcome.status;
      note = outcome.note || null;
    } catch (e) {
      if (e instanceof BudgetExhausted) {
        // Not a failure: progress so far is kept, the rest resumes next run.
        status = "retry";
        note = "deferred: fetch budget";
        attemptsSql = "attempts - 1";
      } else {
        status = attempts >= MAX_ATTEMPTS ? "failed" : "retry";
        note = redact(e?.message || e, env);
        console.error("[facebook] event processing failed", { id: row.id, attempts, error: note });
      }
    }

    summary[status] = (summary[status] || 0) + 1;
    await db
      .prepare(
        `UPDATE facebook_webhook_events
            SET status = ?, last_error = ?, attempts = ${attemptsSql}, updated_at = ${NOW_SQL}
          WHERE id = ?`
      )
      .bind(status, note, row.id)
      .run();
    if (status === "done") await setState(db, "last_success_at", new Date().toISOString());
  }

  return summary;
}

async function processEvent(env, row, budget) {
  const pageId = configuredPageId(env);
  if (!pageId) throw new Error("FB_PAGE_ID is not configured");
  if (row.page_id !== pageId) return { status: "ignored", note: "other page" };

  let value;
  try {
    value = JSON.parse(row.payload);
  } catch {
    return { status: "ignored", note: "unparseable payload" };
  }

  // Visitor posts on the Page arrive on the same feed; only import the Page's own.
  const fromId = cleanId(value?.from?.id);
  if (fromId && fromId !== pageId) return { status: "ignored", note: "not posted by page" };

  if (row.verb === "remove" || row.verb === "hide") return await handleRemoval(env, row, budget);

  if (row.verb !== "add" && row.verb !== "edited") {
    return { status: "ignored", note: `verb ${row.verb || "none"}` };
  }
  if (!["photo", "status", "post", "album", "photo-album"].includes(row.item)) {
    return { status: "ignored", note: `item ${row.item || "none"}` };
  }
  if (value.published === 0 || value.published === false) {
    return { status: "ignored", note: "unpublished" };
  }

  // Single photo → photo_id; album additions → photo_ids; multi-photo posts
  // are resolved from the post's attachments.
  const hintPhotoIds = [];
  if (row.photo_id) hintPhotoIds.push(row.photo_id);
  if (Array.isArray(value.photo_ids)) {
    hintPhotoIds.push(...value.photo_ids.map(cleanId).filter(Boolean).slice(0, 100));
  }

  const r = await ingestPost(env, {
    postId: row.post_id,
    hintPhotoIds,
    source: "webhook",
    budget,
    // Edits must re-read the post so caption changes are picked up.
    photoEvent: row.item === "photo" && row.verb === "add",
  });
  if (r.ignored) return { status: "ignored", note: r.ignored };
  return {
    status: "done",
    note: `imported ${r.imported}, skipped ${r.skipped}; project ${r.project?.slug || "-"} (${r.project?.reason || "-"})`,
  };
}

// --- removals on Facebook ----------------------------------------------
//
// A Page-authored remove/hide of a post or photo is acted on only once Graph
// confirms the content is gone (code 100 / subcode 33) or unpublished/hidden.
// Any other error throws, so the event retries (up to MAX_ATTEMPTS) and a
// transient failure never hides anything. Comments, reactions and visitor
// content never count. Confirmed removals hide the photos (public copy
// deleted, master kept) and schedule permanent deletion.

async function handleRemoval(env, row, budget) {
  if (!REMOVABLE_ITEMS.includes(row.item)) {
    return { status: "ignored", note: `${row.item || "none"} ${row.verb}` };
  }
  const db = env.DB;
  const byPhoto = row.item === "photo" && !!row.photo_id;
  const { results = [] } = await (byPhoto
    ? db.prepare(`SELECT fb_photo_id FROM facebook_photos WHERE fb_photo_id = ? AND master_key IS NOT NULL`).bind(row.photo_id)
    : db.prepare(`SELECT fb_photo_id FROM facebook_photos WHERE fb_post_id = ? AND master_key IS NOT NULL`).bind(row.post_id || "")
  ).all();
  if (!results.length) return { status: "ignored", note: `${row.verb}: nothing imported` };

  const gone = await confirmUnavailable(env, byPhoto ? row.photo_id : row.post_id, byPhoto ? "photo" : "post", budget);
  if (!gone) return { status: "ignored", note: `${row.verb} not confirmed; still on Facebook` };

  const days = removedRetentionDays(env);
  for (const r of results) {
    await db
      .prepare(
        `UPDATE facebook_photos
            SET hidden_reason = CASE WHEN hidden = 1 THEN COALESCE(hidden_reason, 'admin') ELSE 'removed_on_facebook' END,
                hidden = 1,
                removed_on_facebook_at = COALESCE(removed_on_facebook_at, ${NOW_SQL}),
                purge_after = COALESCE(purge_after, strftime('%Y-%m-%dT%H:%M:%fZ','now','+${days} days')),
                updated_at = ${NOW_SQL}
          WHERE fb_photo_id = ?`
      )
      .bind(r.fb_photo_id)
      .run();
    await reconcilePhoto(env, r.fb_photo_id);
  }
  if (row.post_id && !byPhoto) {
    await db
      .prepare(`UPDATE facebook_posts SET removed_on_facebook_at = ${NOW_SQL}, updated_at = ${NOW_SQL} WHERE fb_post_id = ?`)
      .bind(row.post_id)
      .run();
  }
  return { status: "done", note: `hid ${results.length} photo(s) removed on Facebook; deleting in ${days} days` };
}

async function confirmUnavailable(env, id, kind, budget) {
  if (!cleanId(id)) return false;
  try {
    const obj = await graphGet(env, id, { fields: kind === "post" ? "id,is_published,is_hidden" : "id" }, budget);
    return kind === "post" && (obj?.is_published === false || obj?.is_hidden === true);
  } catch (e) {
    // 100/33: "object does not exist, cannot be loaded due to missing permissions".
    if (e?.graphCode === 100 && e?.graphSubcode === 33) return true;
    throw e;
  }
}

// Content that comes back on Facebook (republished, or still attached to a
// post we can read) is shown again if only the removal hid it.
async function restoreReturned(env, photoIds) {
  for (const id of photoIds) {
    const r = await env.DB
      .prepare(
        `UPDATE facebook_photos
            SET hidden = CASE WHEN hidden_reason = 'removed_on_facebook' THEN 0 ELSE hidden END,
                hidden_reason = CASE WHEN hidden_reason = 'removed_on_facebook' THEN NULL ELSE hidden_reason END,
                removed_on_facebook_at = NULL, purge_after = NULL, updated_at = ${NOW_SQL}
          WHERE fb_photo_id = ? AND removed_on_facebook_at IS NOT NULL AND master_key IS NOT NULL`
      )
      .bind(id)
      .run();
    if (r?.meta?.changes) await reconcilePhoto(env, id);
  }
}

// Permanent deletion once the retention period has passed (hourly cron).
// Idempotent: overlapping runs select the same rows and deletes are no-ops.
// `now` is injectable so tests can run the 30-day clock.
export async function purgeExpiredRemovals(env, { now = new Date() } = {}) {
  const { results = [] } = await env.DB
    .prepare(
      `SELECT fb_photo_id, fb_post_id FROM facebook_photos
        WHERE purge_after IS NOT NULL AND purge_after <= ? AND master_key IS NOT NULL
        ORDER BY purge_after
        LIMIT ?`
    )
    .bind(now.toISOString(), PURGE_BATCH)
    .all();
  if (!results.length) return 0;
  const { purged, failed } = await purgePhotos(env, results, [], "deleted after removal on Facebook");
  console.log("[facebook] retention purge", { purged, failed });
  return purged;
}

// Data minimisation for the inbox: processed rows are not needed once Meta's
// retry window has passed.
async function pruneProcessedEvents(env, { now = new Date() } = {}) {
  const cutoff = new Date(now.getTime() - EVENT_RETENTION_DAYS * 86400000).toISOString();
  await env.DB
    .prepare(`DELETE FROM facebook_webhook_events WHERE status IN ('done','ignored') AND updated_at < ?`)
    .bind(cutoff)
    .run();
}

// Retention work only: D1 + R2, never Facebook. Runs on every cron tick,
// including while the integration or imports are switched off, so the
// privacy policy's deletion promises keep holding.
export async function runRetention(env, { now = new Date() } = {}) {
  if (!env.DB || !env.PRIVATE_BUCKET || !env.GALLERY_BUCKET) return 0;
  try {
    const purged = await purgeExpiredRemovals(env, { now });
    await pruneProcessedEvents(env, { now });
    return purged;
  } catch (e) {
    // Tables missing (migration not applied) or a transient error: next hour.
    console.error("[facebook] retention run failed; will retry", redact(e?.message || e, env));
    return 0;
  }
}

// --- ingest one Facebook post (webhook + backfill share this) -----------

function attachmentPhotoIds(post) {
  const ids = [];
  for (const att of post?.attachments?.data || []) {
    if (att?.type === "photo" && cleanId(att?.target?.id)) ids.push(att.target.id);
    for (const sub of att?.subattachments?.data || []) {
      if (sub?.type === "photo" && cleanId(sub?.target?.id)) ids.push(sub.target.id);
    }
  }
  return ids;
}

async function ingestPost(env, { postId, hintPhotoIds = [], source, post = null, budget, dryRun = false, photoEvent = false }) {
  const db = env.DB;
  const pageId = configuredPageId(env);
  if (!pageId) throw new Error("FB_PAGE_ID is not configured");

  // A per-photo event for photos we already have needs no Graph calls at all.
  if (photoEvent && hintPhotoIds.length) {
    let known = 0;
    for (const id of hintPhotoIds) {
      const row = await getPhotoRow(db, id);
      if (row && row.status !== "failed") known++;
    }
    if (known === hintPhotoIds.length) return { imported: 0, skipped: known, project: null, photos: known };
  }

  postId = cleanId(postId);
  if (!post && postId) {
    try {
      post = await graphGet(env, postId, { fields: POST_FIELDS }, budget);
    } catch (e) {
      // Photo-only events can still be imported from their photo ids.
      if (e instanceof BudgetExhausted || !hintPhotoIds.length) throw e;
      console.warn("[facebook] post lookup failed; using photo ids only:", redact(e?.message || e, env));
    }
  }
  if (post && cleanId(post?.from?.id) && post.from.id !== pageId) {
    return { ignored: "not posted by page" };
  }

  const photoIds = [...new Set([...hintPhotoIds, ...attachmentPhotoIds(post)])];
  if (!photoIds.length) return { ignored: "no photos" };

  if (!dryRun && post) {
    await refreshPostText(db, post);
    await restoreReturned(env, photoIds);
  }

  // Skip photos we already have (any status but failed); admin decisions on
  // them are never revisited by sync.
  const pending = [];
  let skipped = 0;
  for (const id of photoIds) {
    const row = await getPhotoRow(db, id);
    if (row && row.status !== "failed") skipped++;
    else pending.push({ id, row });
  }
  if (!pending.length) return { imported: 0, skipped, project: null, photos: photoIds.length };

  // Grouping needs one photo's details (album); the rest are fetched one at a
  // time while importing, so a large album makes steady progress per run.
  const isForeign = (photo) => cleanId(photo?.from?.id) && photo.from.id !== pageId;
  let first = null;
  while (pending.length && !first) {
    const photo = await graphGet(env, pending[0].id, { fields: PHOTO_FIELDS }, budget);
    if (isForeign(photo)) {
      pending.shift();
      skipped++;
    } else {
      first = photo;
    }
  }
  if (!first) return { imported: 0, skipped, project: null, photos: photoIds.length };

  const context = {
    postId: postId || cleanId(post?.id),
    message: typeof post?.message === "string" ? post.message : first.name || "",
    createdTime: toIso(post?.created_time) || toIso(first.created_time),
    permalink: typeof post?.permalink_url === "string" ? post.permalink_url : null,
  };

  const project = await assignProject(env, {
    context,
    photos: [first],
    photoCount: pending.length,
    dryRun,
    source,
  });
  if (dryRun) {
    return { imported: 0, skipped, project, newPhotos: pending.length, photos: photoIds.length, context };
  }

  if (context.postId) {
    await db
      .prepare(
        `INSERT INTO facebook_posts (fb_post_id, page_id, message, created_time, permalink, project_id, grouping_reason, source)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(fb_post_id) DO UPDATE SET
           message = excluded.message, permalink = COALESCE(excluded.permalink, permalink),
           updated_at = ${NOW_SQL}`
      )
      .bind(
        context.postId,
        pageId,
        context.message.slice(0, 5000),
        context.createdTime,
        context.permalink,
        project.id,
        project.reason,
        source
      )
      .run();
  }

  let imported = 0;
  for (const { id } of pending) {
    const photo = id === first.id ? first : await graphGet(env, id, { fields: PHOTO_FIELDS }, budget);
    if (isForeign(photo)) {
      skipped++;
      continue;
    }
    const r = await importPhoto(env, photo, { context, projectId: project.id, source, budget });
    if (r.imported) imported++;
    else skipped++;
  }
  return { imported, skipped, project, photos: photoIds.length };
}

// An edited caption replaces the stored post text, and the caption of every
// photo that was showing the old post text. Photos with their own Facebook
// caption keep it. Grouping and admin decisions are not revisited.
async function refreshPostText(db, post) {
  const postId = cleanId(post?.id);
  if (!postId || typeof post.message !== "string") return false;
  const old = await db.prepare(`SELECT message FROM facebook_posts WHERE fb_post_id = ?`).bind(postId).first();
  if (!old) return false;

  const message = post.message.slice(0, 5000);
  if ((old.message || "") === message) return false;
  // Text deleted on request stays deleted, even if the post is edited later.
  const live = await db
    .prepare(`SELECT COUNT(*) AS n FROM facebook_photos WHERE fb_post_id = ? AND master_key IS NOT NULL`)
    .bind(postId)
    .first();
  if (!live?.n) return false;
  await db.batch([
    db
      .prepare(
        `UPDATE facebook_photos SET caption = ?, updated_at = ${NOW_SQL}
          WHERE fb_post_id = ? AND caption IS ? AND master_key IS NOT NULL`
      )
      .bind(message || null, postId, old.message || null),
    db
      .prepare(
        `UPDATE facebook_posts SET message = ?, permalink = COALESCE(?, permalink), updated_at = ${NOW_SQL}
          WHERE fb_post_id = ?`
      )
      .bind(message, typeof post.permalink_url === "string" ? post.permalink_url : null, postId),
  ]);
  return true;
}

// --- project grouping ---------------------------------------------------
//
// In order:
//   1. post already grouped (re-delivery, edit, or added photos) → same project
//   2. photos in one named Facebook album → that album's project (create once)
//   3. caption names exactly one existing project (multi-word, non-generic
//      name; manual galleries included) → that project
//   4. "completed build" evidence: ≥3 photos and completion wording → new
//      project named from the caption
//   5. otherwise → Recent Project Updates

async function assignProject(env, { context, photos, photoCount = photos.length, dryRun }) {
  const db = env.DB;

  if (context.postId) {
    const post = await db
      .prepare(
        `SELECT p.id, p.slug, p.name FROM facebook_posts fp JOIN facebook_projects p ON p.id = fp.project_id
          WHERE fp.fb_post_id = ?`
      )
      .bind(context.postId)
      .first();
    if (post) return { ...post, reason: "post", action: "reuse" };
  }

  const albums = new Map();
  for (const p of photos) {
    const id = cleanId(p?.album?.id);
    const name = typeof p?.album?.name === "string" ? p.album.name.trim() : "";
    if (id && name && !GENERIC_ALBUM_RE.test(name)) albums.set(id, name);
  }
  if (albums.size === 1) {
    const [[albumId, albumName]] = [...albums];
    const existing = await db
      .prepare(`SELECT id, slug, name FROM facebook_projects WHERE fb_album_id = ?`)
      .bind(albumId)
      .first();
    if (existing) return { ...existing, reason: "album", action: "reuse" };
    if (dryRun) return { id: null, slug: null, name: albumName, reason: "album", action: "create" };
    return {
      ...(await createProject(env, { name: albumName, albumId, reason: "album" })),
      reason: "album",
      action: "create",
    };
  }

  const matches = await matchExistingProjects(env, context.message);
  if (matches.length === 1) {
    const m = matches[0];
    if (m.id) return { id: m.id, slug: m.slug, name: m.name, reason: "caption", action: "reuse" };
    // Manual R2 gallery: reuse (or create once) a link row pointing at it.
    if (dryRun) return { id: null, slug: null, name: m.name, reason: "caption", action: "link" };
    const linked = await getOrCreateLinkedProject(env, m.prefix, m.name, "auto");
    return { ...linked, reason: "caption", action: "link" };
  }

  if (photoCount >= 3 && COMPLETION_RE.test(context.message || "")) {
    const name = projectNameFromCaption(context.message, context.createdTime);
    if (dryRun) return { id: null, slug: null, name, reason: "completed-build", action: "create" };
    return {
      ...(await createProject(env, { name, reason: "completed-build" })),
      reason: "completed-build",
      action: "create",
    };
  }

  if (dryRun) return { id: null, slug: RECENT_SLUG, name: RECENT_NAME, reason: "ambiguous", action: "recent" };
  return { ...(await getRecentProject(env)), reason: "ambiguous", action: "recent" };
}

function significantName(name) {
  const words = normalizeWords(name).split(" ").filter(Boolean);
  if (words.length < 2) return null;
  if (!words.some((w) => w.length >= 3 && !GENERIC_WORDS.has(w))) return null;
  return words.join(" ");
}

async function matchExistingProjects(env, message) {
  const caption = ` ${normalizeWords(message)} `;
  if (caption.trim().length < 3) return [];

  const candidates = [];
  const { results = [] } = await env.DB
    .prepare(
      `SELECT id, slug, name, linked_prefix FROM facebook_projects WHERE kind = 'project'`
    )
    .all();
  const linkedPrefixes = new Set();
  for (const r of results) {
    candidates.push({ id: r.id, slug: r.slug, name: r.name });
    if (r.linked_prefix) linkedPrefixes.add(r.linked_prefix);
  }
  for (const m of await listManualProjects(env)) {
    if (!linkedPrefixes.has(m.prefix)) candidates.push({ id: null, prefix: m.prefix, name: m.name });
  }

  const seen = new Set();
  const out = [];
  for (const c of candidates) {
    const n = significantName(c.name);
    if (!n || !caption.includes(` ${n} `)) continue;
    const key = c.id ? `id:${c.id}` : `prefix:${c.prefix}`;
    if (!seen.has(key)) {
      seen.add(key);
      out.push(c);
    }
  }
  return out;
}

function projectNameFromCaption(message, createdIso) {
  let line = firstLine(message, 400)
    .replace(/https?:\/\/\S+/g, "")
    .replace(/[#@]\w+/g, "")
    .replace(/[^\p{L}\p{N}\s'&,.\-]/gu, "")
    .replace(/\s+/g, " ")
    .trim();
  line = line.split(/(?<=[.!?])\s/)[0].replace(/[.,!?\s]+$/, "");
  if (line.length > 60) line = line.slice(0, 60).replace(/\s+\S*$/, "");
  if (line.split(" ").length >= 2 && line.length >= 8) return line;

  const d = createdIso ? new Date(createdIso) : new Date();
  const month = d.toLocaleDateString("en-US", { month: "long", year: "numeric", timeZone: "UTC" });
  return `Project – ${month}`;
}

async function r2ProjectSlugs(env) {
  const slugs = new Set();
  for (const m of await listManualProjects(env)) slugs.add(slugify(m.name));
  return slugs;
}

async function createProject(env, { name, albumId = null, reason, category = "projects", createdBy = "auto", linkedPrefix = null }) {
  const db = env.DB;
  const cleanName = String(name).trim().slice(0, 80) || "Project";
  const taken = await r2ProjectSlugs(env);
  const base = slugify(cleanName);

  for (let i = 1; i <= 50; i++) {
    const slug = i === 1 ? base : `${base}-${i}`;
    if (slug === RECENT_SLUG || taken.has(slug)) continue;
    const ins = await db
      .prepare(
        `INSERT OR IGNORE INTO facebook_projects
           (slug, name, kind, category, fb_album_id, linked_prefix, created_by, grouping_reason, name_locked)
         VALUES (?, ?, 'project', ?, ?, ?, ?, ?, ?)`
      )
      .bind(slug, cleanName, category, albumId, linkedPrefix, createdBy, reason, createdBy === "admin" ? 1 : 0)
      .run();
    if (ins?.meta?.changes) {
      return await db.prepare(`SELECT id, slug, name FROM facebook_projects WHERE slug = ?`).bind(slug).first();
    }
    // Lost a race on the unique album / linked prefix: use the winner.
    if (albumId) {
      const row = await db
        .prepare(`SELECT id, slug, name FROM facebook_projects WHERE fb_album_id = ?`)
        .bind(albumId)
        .first();
      if (row) return row;
    }
    if (linkedPrefix) {
      const row = await db
        .prepare(`SELECT id, slug, name FROM facebook_projects WHERE linked_prefix = ?`)
        .bind(linkedPrefix)
        .first();
      if (row) return row;
    }
  }
  throw new Error("Could not allocate a project slug");
}

async function getOrCreateLinkedProject(env, prefix, name, createdBy) {
  const row = await env.DB
    .prepare(`SELECT id, slug, name FROM facebook_projects WHERE linked_prefix = ?`)
    .bind(prefix)
    .first();
  if (row) return row;
  return await createProject(env, { name, reason: "linked", createdBy, linkedPrefix: prefix });
}

async function getRecentProject(env) {
  await env.DB
    .prepare(
      `INSERT OR IGNORE INTO facebook_projects (slug, name, kind, category, created_by, grouping_reason)
       VALUES (?, ?, 'recent', 'projects', 'auto', 'ambiguous')`
    )
    .bind(RECENT_SLUG, RECENT_NAME)
    .run();
  return await env.DB
    .prepare(`SELECT id, slug, name FROM facebook_projects WHERE slug = ?`)
    .bind(RECENT_SLUG)
    .first();
}

// Existing manually uploaded galleries (R2 folders) that count as projects.
async function listManualProjects(env) {
  const out = [];
  for (const root of MANUAL_PROJECT_ROOTS) {
    const res = await env.GALLERY_BUCKET.list({ prefix: root, delimiter: "/" });
    for (const prefix of res.delimitedPrefixes || []) {
      const name = prefix.replace(/\/$/, "").split("/").pop().replace(/[_]+/g, " ");
      out.push({ prefix, name });
    }
  }
  return out;
}

// --- photo import + publication ------------------------------------------

async function getPhotoRow(db, photoId) {
  return await db
    .prepare(`SELECT fb_photo_id, status, hidden, project_id, project_locked FROM facebook_photos WHERE fb_photo_id = ?`)
    .bind(photoId)
    .first();
}

function pickLargestImage(images) {
  if (!Array.isArray(images)) return null;
  let best = null;
  for (const img of images) {
    if (!img || typeof img.source !== "string") continue;
    const w = Number(img.width) || 0;
    if (!best || w > (Number(best.width) || 0)) best = img;
  }
  return best;
}

function assertFacebookCdnUrl(raw) {
  const u = new URL(raw);
  if (u.protocol !== "https:" || !ALLOWED_IMAGE_HOST.test(u.hostname)) {
    throw new Error("Image URL is not a Facebook CDN URL");
  }
  return u.toString();
}

async function importPhoto(env, photo, { context = {}, projectId, source, budget }) {
  const db = env.DB;
  if (!db || !env.GALLERY_BUCKET || !env.PRIVATE_BUCKET) {
    throw new Error("Missing DB, GALLERY_BUCKET or PRIVATE_BUCKET binding");
  }

  const photoId = cleanId(photo?.id);
  if (!photoId) throw new Error("Photo has no valid id");
  const pageId = configuredPageId(env);

  // Claim: a new row, or a previously failed one. A failed row keeps any
  // admin-chosen project and hidden flag.
  const ins = await db
    .prepare(
      `INSERT OR IGNORE INTO facebook_photos (fb_photo_id, fb_post_id, page_id, source, status, project_id)
       VALUES (?, ?, ?, ?, 'importing', ?)`
    )
    .bind(photoId, cleanId(context.postId), pageId || "", source, projectId)
    .run();
  if (!ins?.meta?.changes) {
    const retry = await db
      .prepare(
        `UPDATE facebook_photos
            SET status = 'importing',
                project_id = CASE WHEN project_locked = 1 OR project_id IS NOT NULL THEN project_id ELSE ? END,
                updated_at = ${NOW_SQL}
          WHERE fb_photo_id = ? AND status = 'failed'`
      )
      .bind(projectId, photoId)
      .run();
    if (!retry?.meta?.changes) return { imported: false, reason: "duplicate" };
  }

  try {
    const best = pickLargestImage(photo.images);
    if (!best) throw new Error("Photo has no downloadable image");
    const src = assertFacebookCdnUrl(best.source);

    // The extension isn't known until download, so look for any existing master.
    let masterKey = null;
    let contentType = null;
    let size = null;
    for (const [type, ext] of Object.entries(EXT_BY_TYPE)) {
      const head = await env.PRIVATE_BUCKET.head(`${FACEBOOK_PREFIX}${photoId}.${ext}`);
      if (head) {
        masterKey = `${FACEBOOK_PREFIX}${photoId}.${ext}`;
        contentType = type;
        size = head.size;
        break;
      }
    }

    if (!masterKey) {
      budget?.take();
      const resp = await fetch(src, { redirect: "manual" });
      if (!resp.ok) throw new Error(`Image download failed (${resp.status})`);

      contentType = (resp.headers.get("Content-Type") || "").split(";")[0].trim().toLowerCase();
      const ext = EXT_BY_TYPE[contentType];
      if (!ext) throw new Error(`Unsupported image type ${contentType || "unknown"}`);
      if (Number(resp.headers.get("Content-Length") || "0") > MAX_IMAGE_BYTES) {
        throw new Error("Image too large");
      }
      const bytes = await resp.arrayBuffer();
      if (bytes.byteLength > MAX_IMAGE_BYTES) throw new Error("Image too large");

      masterKey = `${FACEBOOK_PREFIX}${photoId}.${ext}`;
      size = bytes.byteLength;
      await env.PRIVATE_BUCKET.put(masterKey, bytes, {
        httpMetadata: { contentType },
        customMetadata: { source: "facebook", fbPhotoId: photoId },
      });
    }

    const caption =
      typeof photo.name === "string" && photo.name.trim()
        ? photo.name
        : context.message || null;

    await db
      .prepare(
        `UPDATE facebook_photos
            SET status = 'imported', master_key = ?, content_type = ?, bytes = ?, width = ?, height = ?,
                caption = ?, fb_created_time = ?, permalink = ?, album_id = ?, album_name = ?,
                fb_post_id = COALESCE(fb_post_id, ?), last_error = NULL, updated_at = ${NOW_SQL}
          WHERE fb_photo_id = ?`
      )
      .bind(
        masterKey,
        contentType,
        size,
        Number(best.width) || null,
        Number(best.height) || null,
        caption ? caption.slice(0, 5000) : null,
        toIso(photo.created_time) || context.createdTime || null,
        typeof photo.link === "string" ? photo.link.slice(0, 500) : context.permalink,
        cleanId(photo?.album?.id),
        typeof photo?.album?.name === "string" ? photo.album.name.slice(0, 200) : null,
        cleanId(context.postId),
        photoId
      )
      .run();

    await reconcilePhoto(env, photoId);
    return { imported: true, key: masterKey };
  } catch (e) {
    const msg = e instanceof BudgetExhausted ? e.message : redact(e?.message || e, env);
    await db
      .prepare(
        `UPDATE facebook_photos SET status = 'failed', last_error = ?, updated_at = ${NOW_SQL}
          WHERE fb_photo_id = ?`
      )
      .bind(msg, photoId)
      .run();
    if (e instanceof BudgetExhausted) throw e;
    throw new Error(msg);
  }
}

// Make the public copy match the visibility rule. Idempotent; safe to run
// concurrently. Only touches GALLERY_BUCKET keys under Facebook/ that this
// module wrote (customMetadata.source === "facebook").
export async function reconcilePhoto(env, photoId) {
  const db = env.DB;
  const row = await db
    .prepare(
      `SELECT ph.fb_photo_id, ph.status, ph.hidden, ph.master_key, ph.content_type,
              ph.public_key, p.hidden AS project_hidden
         FROM facebook_photos ph LEFT JOIN facebook_projects p ON p.id = ph.project_id
        WHERE ph.fb_photo_id = ?`
    )
    .bind(photoId)
    .first();
  if (!row || !row.master_key) return { visible: false };

  const publicKey = row.master_key; // same key, different (public) bucket
  if (!publicKey.startsWith(FACEBOOK_PREFIX)) throw new Error("Unexpected master key");

  const visible =
    row.status === "imported" && !row.hidden && row.project_hidden !== null && !row.project_hidden;

  const existing = await env.GALLERY_BUCKET.head(publicKey);
  if (visible) {
    if (!existing) {
      const master = await env.PRIVATE_BUCKET.get(row.master_key);
      if (!master) throw new Error("Master copy missing");
      await env.GALLERY_BUCKET.put(publicKey, await master.arrayBuffer(), {
        httpMetadata: { contentType: row.content_type || "image/jpeg", cacheControl: PUBLIC_CACHE_CONTROL },
        customMetadata: { source: "facebook", fbPhotoId: row.fb_photo_id },
      });
    }
    if (row.public_key !== publicKey) {
      await db
        .prepare(`UPDATE facebook_photos SET public_key = ?, updated_at = ${NOW_SQL} WHERE fb_photo_id = ?`)
        .bind(publicKey, photoId)
        .run();
    }
    return { visible: true };
  }

  if (existing && existing.customMetadata?.source === "facebook") {
    await env.GALLERY_BUCKET.delete(publicKey);
  }
  if (row.public_key !== null) {
    await db
      .prepare(`UPDATE facebook_photos SET public_key = NULL, updated_at = ${NOW_SQL} WHERE fb_photo_id = ?`)
      .bind(photoId)
      .run();
  }
  return { visible: false };
}

async function reconcileProject(env, projectId) {
  const { results = [] } = await env.DB
    .prepare(`SELECT fb_photo_id FROM facebook_photos WHERE project_id = ?`)
    .bind(projectId)
    .all();
  for (const r of results) await reconcilePhoto(env, r.fb_photo_id);
  return results.length;
}

// --- public gallery integration (called from index.js) ------------------
//
// These fail soft: if D1 is unbound or the migration hasn't been applied, the
// existing R2 gallery keeps working with no Facebook content.

function formatPosted(iso) {
  if (!iso) return "Project photo";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "Project photo";
  return `Posted ${d.toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric", timeZone: "UTC" })}`;
}

function toItem(row, urls) {
  const full = urls.publicUrl(row.public_key);
  const ext = row.public_key.split(".").pop();
  const date = (row.fb_created_time || "").slice(0, 10) || "0000-00-00";
  return {
    // Name sorts chronologically on the project page (it sorts by name).
    name: `${date}_${row.fb_photo_id}.${ext}`,
    full,
    thumb: urls.thumbUrl(full),
    description: firstLine(row.caption) || formatPosted(row.fb_created_time),
    createdTime: row.fb_created_time || null,
    id: row.fb_photo_id,
    source: "facebook",
  };
}

const VISIBLE_PHOTO_SQL = `ph.status = 'imported' AND ph.hidden = 0 AND ph.public_key IS NOT NULL
  AND p.hidden = 0`;

export async function listFacebookProjects(env, category, urls) {
  if (!env.DB || !FB_CATEGORIES.includes(category)) return [];
  try {
    const { results = [] } = await env.DB
      .prepare(
        `SELECT p.id, p.slug, p.name, p.kind, ph.fb_photo_id, ph.public_key, ph.fb_created_time, ph.caption
           FROM facebook_projects p JOIN facebook_photos ph ON ph.project_id = p.id
          WHERE p.category = ? AND p.linked_prefix IS NULL AND ${VISIBLE_PHOTO_SQL}
          ORDER BY ph.fb_created_time DESC
          LIMIT 5000`
      )
      .bind(category)
      .all();

    const byProject = new Map();
    for (const r of results) {
      if (!byProject.has(r.id)) byProject.set(r.id, { meta: r, rows: [] });
      byProject.get(r.id).rows.push(r);
    }

    const out = [];
    for (const { meta, rows } of byProject.values()) {
      const previews = rows.slice(0, 3).map((r) => {
        const full = urls.publicUrl(r.public_key);
        return { full, thumb: urls.thumbUrl(full) };
      });
      const latest = rows[0].fb_created_time || "";
      out.push({
        slug: meta.slug,
        prefix: null,
        name: meta.name,
        year: latest.slice(0, 4),
        location: "",
        summary: "",
        previews,
        images: { thumb: previews[0].thumb, full: previews[0].full },
        source: "facebook",
      });
    }
    return out;
  } catch (e) {
    console.error("[facebook] listFacebookProjects error:", e?.message || e);
    return [];
  }
}

// key: "slug" or "category/slug" (as accepted by ?project=)
export async function getFacebookProject(env, key, urls) {
  if (!env.DB) return null;
  let category = null;
  let slug = key;
  if (key.includes("/")) [category, slug] = key.split("/", 2);
  if (category && !FB_CATEGORIES.includes(category)) return null;

  try {
    const project = await env.DB
      .prepare(
        `SELECT id, slug, name, category FROM facebook_projects
          WHERE slug = ? AND hidden = 0 AND linked_prefix IS NULL`
      )
      .bind(slug)
      .first();
    if (!project || (category && project.category !== category)) return null;

    const { results = [] } = await env.DB
      .prepare(
        `SELECT ph.fb_photo_id, ph.public_key, ph.fb_created_time, ph.caption
           FROM facebook_photos ph JOIN facebook_projects p ON p.id = ph.project_id
          WHERE p.id = ? AND ${VISIBLE_PHOTO_SQL}
          ORDER BY ph.fb_created_time`
      )
      .bind(project.id)
      .all();
    if (!results.length) return null;

    return { project: { name: project.name, description: "" }, items: results.map((r) => toItem(r, urls)) };
  } catch (e) {
    console.error("[facebook] getFacebookProject error:", e?.message || e);
    return null;
  }
}

// Facebook photos merged into an existing manual gallery (R2 prefix).
export async function getLinkedFacebookItems(env, prefix, urls) {
  if (!env.DB || !prefix) return [];
  try {
    const { results = [] } = await env.DB
      .prepare(
        `SELECT ph.fb_photo_id, ph.public_key, ph.fb_created_time, ph.caption
           FROM facebook_photos ph JOIN facebook_projects p ON p.id = ph.project_id
          WHERE p.linked_prefix = ? AND ${VISIBLE_PHOTO_SQL}
          ORDER BY ph.fb_created_time`
      )
      .bind(prefix)
      .all();
    return results.map((r) => toItem(r, urls));
  } catch (e) {
    console.error("[facebook] getLinkedFacebookItems error:", e?.message || e);
    return [];
  }
}

// --- Graph API ----------------------------------------------------------

function graphGet(env, path, params = {}, budget = null) {
  return graphRequest(env, "GET", path, params, budget);
}

async function graphRequest(env, method, path, params = {}, budget = null) {
  const token = env.FB_PAGE_ACCESS_TOKEN;
  if (!token) throw new Error("FB_PAGE_ACCESS_TOKEN is not configured");

  const version = env.FB_GRAPH_VERSION;
  if (!GRAPH_VERSION_RE.test(version || "")) throw new Error("FB_GRAPH_VERSION is invalid");
  if (!/^(me|[0-9_]{1,64}(\/(photos|posts|subscribed_apps))?)$/.test(path)) throw new Error("Invalid Graph path");

  budget?.take();

  const url = new URL(`https://graph.facebook.com/${version}/${path}`);
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== null) url.searchParams.set(k, String(v));
  }
  // appsecret_proof ties the token to this app, limiting damage if it ever leaks.
  if (env.FB_APP_SECRET) {
    url.searchParams.set("appsecret_proof", bytesToHex(await hmacSha256(env.FB_APP_SECRET, token)));
  }

  // Token goes in a header so it never appears in URLs or logs.
  const resp = await fetch(url.toString(), { method, headers: { Authorization: `Bearer ${token}` } });
  const data = await resp.json().catch(() => null);
  if (!resp.ok || data?.error) {
    const code = data?.error?.code ?? "?";
    const err = new Error(`Graph API error ${resp.status}/${code}: ${redact(data?.error?.message || "", env)}`);
    err.graphStatus = resp.status;
    err.graphCode = data?.error?.code ?? null;
    err.graphSubcode = data?.error?.error_subcode ?? null;
    throw err;
  }
  return data;
}

// --- historical backfill (admin only; caller enforces requireAdmin) ----
//
// Walks the Page's own posts newest → oldest, using the same ingestPost +
// grouping as the webhook. Resumable: the cursor is returned and stored in D1
// (pass {resume:true} to continue from it). A batch that runs out of fetch
// budget returns the same cursor so the remainder is picked up next call;
// finished photos are skipped cheaply via D1.

export async function runFacebookBackfill(request, env) {
  const pageId = configuredPageId(env);
  if (!pageId) return { status: 500, body: { error: "FB_PAGE_ID is not configured" } };
  if (!env.DB) return { status: 500, body: { error: "Missing DB binding" } };

  const input = await request.json().catch(() => ({}));
  const dryRun = input?.dryRun !== false;
  let limit = Math.floor(Number(input?.limit) || 5);
  limit = Math.min(Math.max(limit, 1), MAX_BACKFILL_POSTS);

  let after = typeof input?.after === "string" ? input.after : null;
  if (!after && input?.resume === true) after = await getState(env.DB, "backfill_cursor");
  if (after && !/^[A-Za-z0-9_=-]{1,512}$/.test(after)) {
    return { status: 400, body: { error: "Invalid cursor" } };
  }

  const budget = newBudget();
  try {
    const page = await graphGet(
      env,
      `${pageId}/posts`,
      { fields: POST_FIELDS, limit, after },
      budget
    );
    const posts = (page?.data || []).filter((p) => cleanId(p?.id));
    const next = page?.paging?.next ? page?.paging?.cursors?.after || null : null;

    const result = {
      dryRun, scanned: posts.length, withoutPhotos: 0, oldestCreatedTime: null,
      posts: [], imported: 0, skipped: 0, failed: [], next, complete: true,
    };
    for (const post of posts) {
      const t = toIso(post.created_time);
      if (t && (!result.oldestCreatedTime || t < result.oldestCreatedTime)) result.oldestCreatedTime = t;
    }

    for (const post of posts) {
      if (!attachmentPhotoIds(post).length) {
        result.withoutPhotos++;
        continue;
      }
      try {
        const r = await ingestPost(env, { postId: post.id, post, source: "backfill", budget, dryRun });
        result.imported += r.imported || 0;
        result.skipped += r.skipped || 0;
        result.posts.push({
          postId: post.id,
          createdTime: toIso(post.created_time),
          caption: firstLine(post.message, 120) || null,
          photos: r.photos || 0,
          newPhotos: dryRun ? r.newPhotos || 0 : r.imported || 0,
          project: r.project ? { name: r.project.name, action: r.project.action, reason: r.project.reason } : null,
          ignored: r.ignored || null,
        });
      } catch (e) {
        if (e instanceof BudgetExhausted) {
          // Re-run this same page next time; completed photos are skipped.
          result.complete = false;
          result.next = after;
          break;
        }
        result.failed.push({ postId: post.id, error: redact(e?.message || e, env) });
      }
    }

    if (!dryRun) {
      if (result.complete) await setState(env.DB, "backfill_cursor", result.next || "");
      await setState(env.DB, "last_backfill_at", new Date().toISOString());
      if (result.imported) await setState(env.DB, "last_success_at", new Date().toISOString());
      console.log("[facebook] backfill batch", {
        imported: result.imported,
        skipped: result.skipped,
        failed: result.failed.length,
        complete: result.complete,
      });
    }
    return { status: 200, body: result };
  } catch (e) {
    const msg = e instanceof BudgetExhausted ? e.message : redact(e?.message || e, env);
    console.error("[facebook] backfill error:", msg);
    return { status: 502, body: { error: msg } };
  }
}

// --- admin controls (caller enforces requireAdmin) -----------------------

function jsonResult(body, status = 200) {
  return { status, body };
}

function projectOut(r) {
  const visible = !r.hidden && (r.visible_count || 0) > 0;
  let publicPath = null;
  if (visible && !r.linked_prefix) {
    publicPath = r.category === "projects" ? `/projects/${r.slug}` : `/services/${r.category}/${r.slug}`;
  }
  return {
    id: r.id,
    slug: r.slug,
    name: r.name,
    kind: r.kind,
    category: r.category,
    hidden: !!r.hidden,
    linkedPrefix: r.linked_prefix || null,
    nameLocked: !!r.name_locked,
    photoCount: r.photo_count || 0,
    visibleCount: r.visible_count || 0,
    publicPath,
  };
}

async function loadProject(db, id) {
  return await db
    .prepare(
      `SELECT p.*,
              (SELECT COUNT(*) FROM facebook_photos ph WHERE ph.project_id = p.id) AS photo_count,
              (SELECT COUNT(*) FROM facebook_photos ph WHERE ph.project_id = p.id
                 AND ph.status = 'imported' AND ph.hidden = 0 AND ph.public_key IS NOT NULL) AS visible_count
         FROM facebook_projects p WHERE p.id = ?`
    )
    .bind(id)
    .first();
}

export async function handleFacebookAdmin(request, env, sub, urls) {
  const db = env.DB;
  if (!db) return jsonResult({ error: "Missing DB binding" }, 500);

  try {
    if (sub === "overview" && request.method === "GET") return await adminOverview(env);
    if (sub === "photos" && request.method === "GET") return await adminPhotos(env, request, urls);
    if (sub === "photo-file" && request.method === "GET") return await adminPhotoFile(env, request);
    if (sub === "health" && request.method === "GET") return await adminHealth(env);
    if (request.method !== "POST") return jsonResult({ error: "Not found" }, 404);

    const body = await request.json().catch(() => ({}));
    if (sub === "subscribe") return await adminSubscribe(env, body);
    if (sub === "purge") return await adminPurge(env, body);
    if (sub === "project-update") return await adminProjectUpdate(env, body);
    if (sub === "project-create") return await adminProjectCreate(env, body);
    if (sub === "photo-update") return await adminPhotoUpdate(env, body);
    if (sub === "retry") return await adminRetry(env);
    return jsonResult({ error: "Not found" }, 404);
  } catch (e) {
    const msg = redact(e?.message || e, env);
    console.error("[facebook] admin error:", msg);
    return jsonResult({ error: "Admin action failed" }, 500);
  }
}

async function adminOverview(env) {
  const db = env.DB;
  const [events, photos, failures, projects, state] = await Promise.all([
    db.prepare(`SELECT status, COUNT(*) AS n FROM facebook_webhook_events GROUP BY status`).all(),
    db
      .prepare(
        `SELECT SUM(status = 'imported' AND master_key IS NOT NULL) AS imported, SUM(status = 'failed') AS failed,
                SUM(hidden = 1 AND master_key IS NOT NULL) AS hidden,
                SUM(status = 'imported' AND master_key IS NULL) AS deleted,
                SUM(purge_after IS NOT NULL AND master_key IS NOT NULL) AS scheduled FROM facebook_photos`
      )
      .first(),
    db
      .prepare(
        `SELECT 'event' AS kind, CAST(id AS TEXT) AS ref, attempts, last_error AS error, updated_at
           FROM facebook_webhook_events WHERE status IN ('retry','failed')
         UNION ALL
         SELECT 'photo', fb_photo_id, NULL, last_error, updated_at
           FROM facebook_photos WHERE status = 'failed'
         ORDER BY updated_at DESC LIMIT 20`
      )
      .all(),
    db
      .prepare(
        `SELECT p.*,
                (SELECT COUNT(*) FROM facebook_photos ph WHERE ph.project_id = p.id) AS photo_count,
                (SELECT COUNT(*) FROM facebook_photos ph WHERE ph.project_id = p.id
                   AND ph.status = 'imported' AND ph.hidden = 0 AND ph.public_key IS NOT NULL) AS visible_count
           FROM facebook_projects p ORDER BY p.kind = 'recent' DESC, p.updated_at DESC`
      )
      .all(),
    db.prepare(`SELECT key, value FROM facebook_sync_state`).all(),
  ]);

  const st = Object.fromEntries((state.results || []).map((r) => [r.key, r.value]));
  const counts = { pending: 0, processing: 0, retry: 0, done: 0, ignored: 0, failed: 0 };
  for (const r of events.results || []) counts[r.status] = r.n;

  return jsonResult({
    autoImport: autoImportEnabled(env),
    sync: {
      lastEventReceivedAt: st.last_event_received_at || null,
      lastSuccessAt: st.last_success_at || null,
      lastBackfillAt: st.last_backfill_at || null,
      backfillCursor: st.backfill_cursor || null,
      events: counts,
      photos: {
        imported: photos?.imported || 0,
        failed: photos?.failed || 0,
        hidden: photos?.hidden || 0,
        deleted: photos?.deleted || 0,
        scheduledForDeletion: photos?.scheduled || 0,
      },
      removedRetentionDays: removedRetentionDays(env),
      recentFailures: (failures.results || []).map((r) => ({
        kind: r.kind,
        ref: r.ref,
        attempts: r.attempts,
        error: r.error,
        updatedAt: r.updated_at,
      })),
    },
    projects: (projects.results || []).map(projectOut),
    manualProjects: await listManualProjects(env),
  });
}

async function adminPhotos(env, request, urls) {
  const params = new URL(request.url).searchParams;
  let stmt;
  if (params.get("hidden") === "1") {
    stmt = env.DB.prepare(
      `SELECT * FROM facebook_photos WHERE hidden = 1 ORDER BY fb_created_time DESC LIMIT 500`
    );
  } else {
    const projectId = Number(params.get("projectId"));
    if (!Number.isInteger(projectId) || projectId < 1) return jsonResult({ error: "projectId required" }, 400);
    stmt = env.DB
      .prepare(`SELECT * FROM facebook_photos WHERE project_id = ? ORDER BY fb_created_time DESC LIMIT 500`)
      .bind(projectId);
  }
  const { results = [] } = await stmt.all();
  return jsonResult({
    photos: results.map((r) => ({
      photoId: r.fb_photo_id,
      postId: r.fb_post_id,
      projectId: r.project_id,
      hidden: !!r.hidden,
      projectLocked: !!r.project_locked,
      status: r.status,
      caption: r.caption ? r.caption.slice(0, 500) : null,
      createdTime: r.fb_created_time,
      permalink: r.permalink,
      removedOnFacebook: !!r.removed_on_facebook_at,
      deleted: isPurged(r),
      hiddenReason: isPurged(r) ? null : r.hidden_reason || null,
      deleteAfter: isPurged(r) ? null : r.purge_after || null,
      error: r.last_error,
      previewUrl: isPurged(r) ? null : `/api/gallery-api/facebook/admin/photo-file?id=${encodeURIComponent(r.fb_photo_id)}`,
      publicUrl: r.public_key ? urls.publicUrl(r.public_key) : null,
    })),
  });
}

async function adminPhotoFile(env, request) {
  const id = cleanId(new URL(request.url).searchParams.get("id"));
  if (!id) return jsonResult({ error: "Not found" }, 404);
  const row = await env.DB
    .prepare(`SELECT master_key FROM facebook_photos WHERE fb_photo_id = ?`)
    .bind(id)
    .first();
  if (!row?.master_key || !env.PRIVATE_BUCKET) return jsonResult({ error: "Not found" }, 404);
  const obj = await env.PRIVATE_BUCKET.get(row.master_key);
  if (!obj) return jsonResult({ error: "Not found" }, 404);
  return {
    response: new Response(obj.body, {
      headers: {
        "Content-Type": obj.httpMetadata?.contentType || "image/jpeg",
        "Cache-Control": "private, no-store",
        "X-Content-Type-Options": "nosniff",
      },
    }),
  };
}

async function adminProjectUpdate(env, body) {
  const id = Number(body?.projectId);
  if (!Number.isInteger(id)) return jsonResult({ error: "projectId required" }, 400);
  const project = await loadProject(env.DB, id);
  if (!project) return jsonResult({ error: "Not found" }, 404);

  const sets = [];
  const binds = [];
  if (body.name !== undefined) {
    const name = String(body.name).trim().slice(0, 80);
    if (!name) return jsonResult({ error: "Name required" }, 400);
    // Slug stays the same so existing URLs keep working.
    sets.push("name = ?", "name_locked = 1");
    binds.push(name);
  }
  if (body.hidden !== undefined) {
    sets.push("hidden = ?");
    binds.push(body.hidden ? 1 : 0);
  }
  if (body.category !== undefined) {
    if (!FB_CATEGORIES.includes(body.category)) return jsonResult({ error: "Invalid category" }, 400);
    sets.push("category = ?");
    binds.push(body.category);
  }
  if (!sets.length) return jsonResult({ error: "Nothing to update" }, 400);

  await env.DB
    .prepare(`UPDATE facebook_projects SET ${sets.join(", ")}, updated_at = ${NOW_SQL} WHERE id = ?`)
    .bind(...binds, id)
    .run();
  if (body.hidden !== undefined) await reconcileProject(env, id);

  return jsonResult({ ok: true, project: projectOut(await loadProject(env.DB, id)) });
}

async function adminProjectCreate(env, body) {
  const name = String(body?.name || "").trim().slice(0, 80);
  if (!name) return jsonResult({ error: "Name required" }, 400);

  if (body.linkedPrefix !== undefined && body.linkedPrefix !== null && body.linkedPrefix !== "") {
    const prefix = String(body.linkedPrefix);
    const manual = await listManualProjects(env);
    if (!manual.some((m) => m.prefix === prefix)) return jsonResult({ error: "Unknown gallery" }, 400);
    const p = await getOrCreateLinkedProject(env, prefix, name, "admin");
    return jsonResult({ ok: true, project: projectOut(await loadProject(env.DB, p.id)) });
  }

  const category = body.category === undefined ? "projects" : body.category;
  if (!FB_CATEGORIES.includes(category)) return jsonResult({ error: "Invalid category" }, 400);
  const p = await createProject(env, { name, reason: "admin", category, createdBy: "admin" });
  return jsonResult({ ok: true, project: projectOut(await loadProject(env.DB, p.id)) });
}

async function adminPhotoUpdate(env, body) {
  const ids = Array.isArray(body?.photoIds) ? body.photoIds.map(cleanId).filter(Boolean) : [];
  if (!ids.length || ids.length > 200) return jsonResult({ error: "photoIds required (max 200)" }, 400);

  const sets = [];
  const binds = [];
  let where = "fb_photo_id = ?";
  if (body.hidden !== undefined) {
    // Content removed on Facebook can't be restored here: it is shown again
    // only if the post comes back on Facebook, and is deleted when its
    // recovery period ends. Restore skips those photos (and deleted ones).
    if (body.hidden) sets.push("hidden = 1", "hidden_reason = COALESCE(hidden_reason, 'admin')");
    else {
      sets.push("hidden = 0", "hidden_reason = NULL");
      where += " AND removed_on_facebook_at IS NULL AND master_key IS NOT NULL";
    }
  }
  if (body.projectId !== undefined) {
    const target = await loadProject(env.DB, Number(body.projectId));
    if (!target) return jsonResult({ error: "Unknown project" }, 400);
    // project_locked: sync never moves this photo again.
    sets.push("project_id = ?", "project_locked = 1");
    binds.push(target.id);
  }
  if (!sets.length) return jsonResult({ error: "Nothing to update" }, 400);

  let updated = 0;
  for (const id of ids) {
    const r = await env.DB
      .prepare(`UPDATE facebook_photos SET ${sets.join(", ")}, updated_at = ${NOW_SQL} WHERE ${where}`)
      .bind(...binds, id)
      .run();
    if (r?.meta?.changes) {
      updated++;
      await reconcilePhoto(env, id);
    }
  }
  return jsonResult({ ok: true, updated, skipped: ids.length - updated });
}

// Configuration and token check for the admin page. Reports whether each
// secret is set, never its value.
async function adminHealth(env) {
  const pageId = configuredPageId(env);
  const appId = cleanId(env.FB_APP_ID);
  const out = {
    integrationEnabled: env.FB_INTEGRATION_ENABLED === "true",
    autoImport: autoImportEnabled(env),
    graphVersion: env.FB_GRAPH_VERSION || null,
    pageIdConfigured: !!pageId,
    appIdConfigured: !!appId,
    secrets: {
      appSecret: !!env.FB_APP_SECRET,
      verifyToken: !!env.FB_VERIFY_TOKEN,
      pageAccessToken: !!env.FB_PAGE_ACCESS_TOKEN,
    },
    token: "untested",
    page: null,
    subscription: null,
    feedSubscribed: null,
    errors: [],
  };
  if (!env.FB_PAGE_ACCESS_TOKEN) return jsonResult(out);

  // With a Page token, /me is the Page itself: this proves which Page the
  // token belongs to, and that FB_PAGE_ID names the same Page.
  try {
    const p = await graphGet(env, "me", { fields: "id,name" });
    out.page = { id: cleanId(p?.id), name: typeof p?.name === "string" ? p.name.slice(0, 200) : null };
    if (!pageId) out.token = "page-id-missing";
    else out.token = out.page.id === pageId ? "ok" : "wrong-page";
  } catch (e) {
    out.token = "error";
    out.errors.push(redact(e?.message || e, env));
    return jsonResult(out);
  }
  if (out.token !== "ok") return jsonResult(out);

  try {
    const s = await graphGet(env, `${pageId}/subscribed_apps`);
    out.subscription = (s?.data || []).slice(0, 20).map((a) => ({
      id: cleanId(a?.id),
      name: typeof a?.name === "string" ? a.name.slice(0, 200) : null,
      fields: Array.isArray(a?.subscribed_fields)
        ? a.subscribed_fields.filter((f) => typeof f === "string").slice(0, 50)
        : [],
    }));
    const ours = appId ? out.subscription.filter((a) => a.id === appId) : out.subscription;
    out.feedSubscribed = ours.some((a) => a.fields.includes("feed"));
  } catch (e) {
    out.errors.push(redact(e?.message || e, env));
  }
  return jsonResult(out);
}

// Page-level webhook registration (POST /{page-id}/subscribed_apps). Uses the
// stored Page token, so the token never has to leave Cloudflare.
async function adminSubscribe(env, body) {
  if (body?.confirm !== "SUBSCRIBE FEED") {
    return jsonResult({ error: 'Confirmation required: {"confirm":"SUBSCRIBE FEED"}' }, 400);
  }
  const pageId = configuredPageId(env);
  if (!pageId) return jsonResult({ error: "FB_PAGE_ID is not configured" }, 500);
  try {
    const r = await graphRequest(env, "POST", `${pageId}/subscribed_apps`, { subscribed_fields: "feed" });
    console.log("[facebook] page subscription updated", { success: r?.success === true });
    return jsonResult({ ok: r?.success === true });
  } catch (e) {
    return jsonResult({ error: redact(e?.message || e, env) }, 502);
  }
}

// Permanent removal, e.g. for a data-deletion request. Deletes the public copy
// and the private master, clears captions, links and webhook payloads, and
// keeps a contentless tombstone row (imported, no master) so later webhooks
// and backfills skip the photo instead of re-importing it. Only keys under
// Facebook/ are touched, so manual galleries and reviews are never affected.
const PURGE_CONFIRMATION = "PERMANENTLY DELETE";
const NOT_PURGED_SQL = `NOT (status = 'imported' AND master_key IS NULL)`;

export function isPurged(row) {
  return row?.status === "imported" && !row?.master_key;
}

async function adminPurge(env, body) {
  if (body?.confirm !== PURGE_CONFIRMATION) {
    return jsonResult({ error: `Confirmation required: {"confirm":"${PURGE_CONFIRMATION}"}` }, 400);
  }
  const db = env.DB;
  let stmt;
  if (Array.isArray(body?.photoIds)) {
    const ids = [...new Set(body.photoIds.map(cleanId).filter(Boolean))];
    if (!ids.length || ids.length > PURGE_BATCH) return jsonResult({ error: `photoIds required (max ${PURGE_BATCH})` }, 400);
    stmt = db
      .prepare(`SELECT fb_photo_id, fb_post_id FROM facebook_photos WHERE fb_photo_id IN (${ids.map(() => "?").join(",")})`)
      .bind(...ids);
  } else if (body?.postId !== undefined) {
    const postId = cleanId(body.postId);
    if (!postId) return jsonResult({ error: "Invalid postId" }, 400);
    stmt = db.prepare(`SELECT fb_photo_id, fb_post_id FROM facebook_photos WHERE fb_post_id = ?`).bind(postId);
  } else if (body?.projectId !== undefined) {
    const projectId = Number(body.projectId);
    if (!Number.isInteger(projectId) || projectId < 1) return jsonResult({ error: "Invalid projectId" }, 400);
    stmt = db
      .prepare(`SELECT fb_photo_id, fb_post_id FROM facebook_photos WHERE project_id = ? AND ${NOT_PURGED_SQL} LIMIT ?`)
      .bind(projectId, PURGE_BATCH);
  } else if (body?.all === true) {
    stmt = db
      .prepare(`SELECT fb_photo_id, fb_post_id FROM facebook_photos WHERE ${NOT_PURGED_SQL} LIMIT ?`)
      .bind(PURGE_BATCH);
  } else {
    return jsonResult({ error: "Choose photoIds, postId, projectId or all" }, 400);
  }

  const { results = [] } = await stmt.all();
  const { purged, failed, posts } = await purgePhotos(env, results, body?.postId !== undefined ? [cleanId(body.postId)] : []);
  const left = await db.prepare(`SELECT COUNT(*) AS n FROM facebook_photos WHERE ${NOT_PURGED_SQL}`).first();
  console.log("[facebook] purge", { purged, posts });
  return jsonResult({ ok: failed === 0, purged, failed, posts, remainingFacebookPhotos: left?.n || 0 });
}

async function purgePhotos(env, results, extraPostIds = [], reason = "deleted on request") {
  const db = env.DB;
  const posts = new Set(extraPostIds.filter(Boolean));
  let purged = 0;
  let failed = 0;
  for (const r of results) {
    const id = cleanId(r.fb_photo_id);
    if (!id) continue;
    // One failing photo must not stop the rest; it is retried next run
    // (its row still has a master_key, so it is selected again).
    try {
    // Every possible key for this photo, so a master stranded by a failed
    // import is removed too. Public objects are deleted only if this module
    // wrote them.
    for (const ext of Object.values(EXT_BY_TYPE)) {
      const key = `${FACEBOOK_PREFIX}${id}.${ext}`;
      const pub = await env.GALLERY_BUCKET.head(key);
      if (pub && pub.customMetadata?.source === "facebook") await env.GALLERY_BUCKET.delete(key);
      await env.PRIVATE_BUCKET.delete(key);
    }
    await db
      .prepare(
        `UPDATE facebook_photos
            SET status = 'imported', hidden = 1, project_locked = 1, master_key = NULL, public_key = NULL,
                content_type = NULL, bytes = NULL, width = NULL, height = NULL, caption = NULL,
                fb_created_time = NULL, permalink = NULL, album_id = NULL, album_name = NULL,
                hidden_reason = 'deleted', purge_after = NULL,
                last_error = ?, updated_at = ${NOW_SQL}
          WHERE fb_photo_id = ?`
      )
      .bind(reason, id)
      .run();
    if (r.fb_post_id) posts.add(r.fb_post_id);
    purged++;
    } catch (e) {
      failed++;
      console.error("[facebook] purge failed for one photo; will retry", redact(e?.message || e, env));
    }
  }

  const ids = results.map((r) => r.fb_photo_id);
  for (const postId of posts) {
    await db.batch([
      db
        .prepare(`UPDATE facebook_posts SET message = NULL, permalink = NULL, updated_at = ${NOW_SQL} WHERE fb_post_id = ?`)
        .bind(postId),
      db.prepare(`UPDATE facebook_webhook_events SET payload = '{}', updated_at = ${NOW_SQL} WHERE post_id = ?`).bind(postId),
    ]);
  }
  for (const id of ids) {
    await db
      .prepare(`UPDATE facebook_webhook_events SET payload = '{}', updated_at = ${NOW_SQL} WHERE photo_id = ?`)
      .bind(id)
      .run();
  }

  return { purged, failed, posts: posts.size };
}

// Re-queue failed events and retry a few failed photos right away.
async function adminRetry(env) {
  const db = env.DB;
  const ev = await db
    .prepare(
      `UPDATE facebook_webhook_events SET status = 'retry', attempts = 0, updated_at = ${NOW_SQL}
        WHERE status = 'failed'`
    )
    .run();

  const { results = [] } = await db
    .prepare(`SELECT fb_photo_id, fb_post_id, project_id FROM facebook_photos WHERE status = 'failed' LIMIT 5`)
    .all();
  const budget = newBudget();
  let requeuedPhotos = 0;
  for (const r of results) {
    try {
      const photo = await graphGet(env, r.fb_photo_id, { fields: PHOTO_FIELDS }, budget);
      const projectId = r.project_id || (await getRecentProject(env)).id;
      const out = await importPhoto(env, photo, {
        context: { postId: r.fb_post_id },
        projectId,
        source: "webhook",
        budget,
      });
      if (out.imported) requeuedPhotos++;
    } catch (e) {
      if (e instanceof BudgetExhausted) break;
      // Still failed; the error is stored on the row for the overview.
    }
  }
  return jsonResult({ ok: true, requeuedEvents: ev?.meta?.changes || 0, requeuedPhotos });
}

// --- cron sweeper ---------------------------------------------------------

export async function handleFacebookScheduled(env, { now = new Date() } = {}) {
  if (!env.DB) return null;
  await runRetention(env, { now });
  if (!autoImportEnabled(env)) {
    // Removals still take content down while imports are paused.
    const summary = await processPendingEvents(env, { limit: CRON_BATCH, removalsOnly: true });
    if (summary.processed) console.log("[facebook] cron processed removals", summary);
    return null;
  }

  // Recover rows stranded by an evicted isolate.
  await env.DB.batch([
    env.DB.prepare(
      `UPDATE facebook_webhook_events SET status = 'retry', updated_at = ${NOW_SQL}
        WHERE status = 'processing'
          AND updated_at < strftime('%Y-%m-%dT%H:%M:%fZ','now','-15 minutes')`
    ),
    env.DB.prepare(
      `UPDATE facebook_photos SET status = 'failed', last_error = 'stale import', updated_at = ${NOW_SQL}
        WHERE status = 'importing'
          AND updated_at < strftime('%Y-%m-%dT%H:%M:%fZ','now','-15 minutes')`
    ),
  ]);

  const summary = await processPendingEvents(env, { limit: CRON_BATCH });
  if (summary.processed) console.log("[facebook] cron processed", summary);
  return summary;
}
