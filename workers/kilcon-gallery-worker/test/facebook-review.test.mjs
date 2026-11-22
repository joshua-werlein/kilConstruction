// Run: npm run test:gallery-worker   (from repo root)
// Historical photo review: the per-photo import gate (every import path) and
// the admin-only comparison endpoints. Real local D1 + R2 (Miniflare);
// Graph and CDN requests are stubbed; nothing leaves the machine.

import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { getPlatformProxy } from "wrangler";

import worker from "../src/index.js";
import { runFacebookDiscovery } from "../src/facebook.js";
import { reviewGate, webhookReviewMode } from "../src/facebook-review.js";
import { JPEG } from "./imageFixtures.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "../../..");
const APP_SECRET = "test-app-secret";
const PAGE_TOKEN = "EAAtestPageAccessTokenValue1234567890";
const PAGE_ID = "1111111111";
const ADMIN_SECRET = "test-admin-secret";
const SITE = "https://kilcon.work";
const ADMIN = `${SITE}/api/gallery-api/facebook/admin`;
const OLD = "2025-06-01T12:00:00+0000";
const NEW = "2026-11-20T12:00:00+0000";

let proxy, baseEnv, graph, cdn, fetchCalls;
const realFetch = globalThis.fetch;
const realConsole = { log: console.log, warn: console.warn, error: console.error };

const makeEnv = (o = {}) => ({
  ...baseEnv,
  FB_APP_SECRET: APP_SECRET, FB_VERIFY_TOKEN: "vt", FB_PAGE_ACCESS_TOKEN: PAGE_TOKEN, FB_PAGE_ID: PAGE_ID,
  FB_GRAPH_VERSION: "v26.0", FB_INTEGRATION_ENABLED: "true", FB_AUTO_IMPORT: "true",
  FB_HISTORICAL_IMPORT_ENABLED: "true",
  READ_LIMITER: { limit: async () => ({ success: true }) }, WRITE_LIMITER: { limit: async () => ({ success: true }) },
  REVIEW_LIMITER: { limit: async () => ({ success: true }) },
  ADMIN_SECRET, SESSION_VERSION: "3", ...o,
});
const makeCtx = () => { const pending = []; return { pending, waitUntil: (p) => pending.push(p), passThroughOnException() {} }; };

async function adminCookie() {
  const now = Math.floor(Date.now() / 1000);
  const b64u = (b) => btoa(String.fromCharCode(...b)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
  const payload = b64u(new TextEncoder().encode(JSON.stringify({ iat: now, exp: now + 600, ver: "3" })));
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(ADMIN_SECRET), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return `admin_auth=${payload}.${b64u(new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(payload))))}`;
}
async function call(url, { method = "GET", body, admin = true, env = makeEnv(), headers = {}, raw } = {}) {
  const h = { ...headers };
  if (admin) h.Cookie = await adminCookie();
  if (body !== undefined && !h["Content-Type"]) h["Content-Type"] = "application/json";
  const ctx = makeCtx();
  const res = await worker.fetch(new Request(url.startsWith("http") ? url : `${SITE}${url}`, {
    method, headers: h, body: raw !== undefined ? raw : body === undefined ? undefined : JSON.stringify(body),
  }), env, ctx);
  await Promise.all(ctx.pending);
  return res;
}
const rows = async (sql, ...b) => (await baseEnv.DB.prepare(sql).bind(...b).all()).results;
const keys = async (bucket) => (await bucket.list()).objects.map((o) => o.key).sort();
async function sign(body) {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(APP_SECRET), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return "sha256=" + [...new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(body)))].map((x) => x.toString(16).padStart(2, "0")).join("");
}
async function webhook(values, env = makeEnv()) {
  const body = JSON.stringify({ object: "page", entry: [{ id: PAGE_ID, time: 1, changes: values.map((value) => ({ field: "feed", value })) }] });
  const ctx = makeCtx();
  const res = await worker.fetch(new Request(`${SITE}/api/gallery-api/facebook/webhook`, {
    method: "POST", headers: { "Content-Type": "application/json", "X-Hub-Signature-256": await sign(body) }, body,
  }), env, ctx);
  await Promise.all(ctx.pending);
  return res;
}
async function decide(decisions) {
  return call(`${ADMIN}/review-decisions`, { method: "POST", body: { decisions } });
}

// Graph fixtures -------------------------------------------------------------
function stubPhoto(id, { created = OLD, album = { id: "500", name: "Harper Barn" }, fromId = PAGE_ID, smallHost = "scontent.xx.fbcdn.net" } = {}) {
  const small = `https://${smallHost}/s320/${id}.jpg`, tiny = `https://scontent.xx.fbcdn.net/s130/${id}.jpg`, big = `https://scontent.xx.fbcdn.net/big/${id}.jpg`;
  graph.set(id, { id, name: "", created_time: created, link: `https://www.facebook.com/photo/?fbid=${id}`, from: { id: fromId }, album,
    images: [{ width: 130, height: 98, source: tiny }, { width: 2048, height: 1536, source: big }, { width: 320, height: 240, source: small }] });
  for (const u of [tiny, small, big]) cdn.set(u, { bytes: JPEG, type: "image/jpeg" });
}
function stubAlbum(albumId, name, ids, opts = {}) {
  for (const id of ids) stubPhoto(id, { ...opts, album: { id: albumId, name } });
  graph.set(albumId, { id: albumId, name, from: { id: PAGE_ID } });
  graph.set(`${albumId}/photos`, (url) => {
    const after = url.searchParams.get("after");
    const start = after ? Number(after.slice(1)) : 0;
    const size = Number(url.searchParams.get("limit")) || 10;
    const page = ids.slice(start, start + size);
    const more = start + size < ids.length;
    return {
      data: page.map((id) => ({ id, created_time: graph.get(id).created_time, from: { id: PAGE_ID } })),
      paging: more ? { cursors: { after: `c${start + size}` }, next: `https://graph.facebook.com/v26.0/${albumId}/photos?after=c${start + size}` } : {},
    };
  });
}
function stubPageAlbums(albums) {
  graph.set(`${PAGE_ID}/albums`, { data: albums.map(([id, name, count, from = PAGE_ID]) => ({ id, name, count, from: { id: from } })), paging: {} });
  graph.set(`${PAGE_ID}/posts`, { data: [], paging: {} });
}
function stubPost(postId, ids, created = OLD) {
  graph.set(postId, { id: postId, message: "Old job", created_time: created, from: { id: PAGE_ID }, permalink_url: `https://www.facebook.com/${postId}`,
    attachments: { data: [{ type: "album", subattachments: { data: ids.map((id) => ({ type: "photo", target: { id } })) } }] } });
}
async function historyRun(env = makeEnv(), extra = {}) {
  for (let n = 0; n < 50; n++) {
    const r = await (await runFacebookDiscovery(env, { dryRun: false, authorizeHistorical: true, ...extra })).body;
    extra = {};
    if (r.complete || r.errors?.length) return r;
  }
  throw new Error("history did not complete");
}

before(async () => {
  proxy = await getPlatformProxy({ configPath: path.join(repoRoot, "workers/kilcon-gallery-worker/wrangler.toml"), persist: false });
  baseEnv = proxy.env;
  for (const file of ["013_facebook_sync.sql", "014_facebook_removal_retention.sql", "015_facebook_discovery.sql", "016_facebook_project_descriptions.sql", "017_facebook_photo_reviews.sql"]) {
    const sql = await readFile(path.join(repoRoot, "migrations", file), "utf8");
    const statements = sql.split("\n").filter((l) => !l.trim().startsWith("--")).join("\n").split(";").map((s) => s.trim()).filter(Boolean);
    await baseEnv.DB.batch(statements.map((s) => baseEnv.DB.prepare(s)));
  }
});
after(async () => { globalThis.fetch = realFetch; Object.assign(console, realConsole); await proxy?.dispose(); });
beforeEach(async () => {
  graph = new Map(); cdn = new Map(); fetchCalls = [];
  for (const k of ["log", "warn", "error"]) console[k] = (...a) => { if (process.env.DEBUG_LOGS) realConsole[k](...a); };
  globalThis.fetch = async (input, init = {}) => {
    const url = new URL(typeof input === "string" ? input : input.url);
    fetchCalls.push({ url, init });
    if (url.hostname === "graph.facebook.com") {
      const fx = graph.get(url.pathname.replace(/^\/v26\.0\//, ""));
      if (!fx) return Response.json({ error: { message: "not found", code: 100, error_subcode: 33 } }, { status: 400 });
      return Response.json(typeof fx === "function" ? fx(url) : fx);
    }
    const img = cdn.get(url.toString());
    if (img) return new Response(img.bytes, { headers: { "Content-Type": img.type } });
    return new Response("nope", { status: 404 });
  };
  await baseEnv.DB.batch(["facebook_photo_reviews", "facebook_discovery_jobs", "facebook_album_mappings", "facebook_albums", "facebook_webhook_events",
    "facebook_photos", "facebook_posts", "facebook_projects", "facebook_sync_state"].map((t) => baseEnv.DB.prepare(`DELETE FROM ${t}`)));
  for (const b of [baseEnv.GALLERY_BUCKET, baseEnv.PRIVATE_BUCKET]) { const k = await keys(b); if (k.length) await b.delete(k); }
});

// --- gate: history import ----------------------------------------------------

test("history import: unreviewed photos are excluded; nothing is claimed, created or stored", async () => {
  stubPageAlbums([["500", "Harper Barn", 3]]);
  stubAlbum("500", "Harper Barn", ["9001", "9002", "9003"]);
  const previewPhotos = [];
  let state;
  for (let n = 0; n < 50; n++) {
    const b = (await runFacebookDiscovery(makeEnv(), { dryRun: true, ...(state ? { state } : {}) })).body;
    previewPhotos.push(...b.photos);
    state = b.nextState;
    if (b.complete || b.errors.length) break;
  }
  const r = await historyRun();
  assert.equal(r.complete, true);
  const outcomes = r.photos.map((p) => [p.id, p.outcome, p.project?.reason]);
  assert.deepEqual(outcomes, [["9001", "excluded", "review-unreviewed"], ["9002", "excluded", "review-unreviewed"], ["9003", "excluded", "review-unreviewed"]]);
  for (const t of ["facebook_photos", "facebook_projects", "facebook_album_mappings", "facebook_posts"]) assert.equal((await rows(`SELECT * FROM ${t}`)).length, 0, t);
  assert.deepEqual(await keys(baseEnv.PRIVATE_BUCKET), []);
  assert.deepEqual(await keys(baseEnv.GALLERY_BUCKET), []);
  assert.ok(!fetchCalls.some((c) => c.url.hostname.endsWith("fbcdn.net")), "no image downloads");
  assert.deepEqual(previewPhotos.map((p) => [p.id, p.outcome]), [["9001", "excluded"], ["9002", "excluded"], ["9003", "excluded"]], "dry-run preview mirrors the gate");
});

test("history import imports exactly the approved photos, is idempotent, and picks up later approvals", async () => {
  stubPageAlbums([["500", "Harper Barn", 4]]);
  stubAlbum("500", "Harper Barn", ["9101", "9102", "9103", "9104"]);
  assert.equal((await decide([
    { photoId: "9101", albumId: "500", decision: "import" },
    { photoId: "9102", albumId: "500", decision: "later" },
    { photoId: "9103", albumId: "500", decision: "skip", duplicateOf: "Projects/Harper Barn/1.jpg" },
  ])).status, 200);
  const first = await historyRun();
  assert.deepEqual(first.photos.map((p) => [p.id, p.outcome]),
    [["9101", "imported"], ["9102", "excluded"], ["9103", "excluded"], ["9104", "excluded"]]);
  assert.deepEqual((await rows("SELECT fb_photo_id, status FROM facebook_photos")).map((r) => [r.fb_photo_id, r.status]), [["9101", "imported"]]);

  const again = await historyRun(makeEnv(), { restart: true });
  assert.ok(again.photos.every((p) => p.id === "9101" ? p.outcome === "existing" : p.outcome === "excluded"), "re-run imports nothing new");
  assert.equal((await rows("SELECT * FROM facebook_photos")).length, 1);
  assert.deepEqual(await keys(baseEnv.PRIVATE_BUCKET), ["Facebook/9101.jpg"]);

  await decide([{ photoId: "9102", albumId: "500", decision: "import" }]);
  const third = await historyRun(makeEnv(), { restart: true });
  assert.equal(third.photos.find((p) => p.id === "9102").outcome, "imported");
  assert.deepEqual((await rows("SELECT fb_photo_id FROM facebook_photos ORDER BY fb_photo_id")).map((r) => r.fb_photo_id), ["9101", "9102"]);
  assert.deepEqual(await keys(baseEnv.PRIVATE_BUCKET), ["Facebook/9101.jpg", "Facebook/9102.jpg"]);
  assert.equal((await rows("SELECT * FROM facebook_projects")).length, 1, "one gallery, not one per run");
});

test("concurrent history runs never import a photo twice", async () => {
  stubPageAlbums([["500", "Harper Barn", 2]]);
  stubAlbum("500", "Harper Barn", ["9151", "9152"]);
  await decide([{ photoId: "9151", decision: "import" }, { photoId: "9152", decision: "import" }]);
  await Promise.all([historyRun(), historyRun()].map((p) => p.catch(() => null)));
  await historyRun(makeEnv(), { restart: true });
  assert.deepEqual((await rows("SELECT fb_photo_id FROM facebook_photos ORDER BY fb_photo_id")).map((r) => r.fb_photo_id), ["9151", "9152"]);
  assert.deepEqual(await keys(baseEnv.PRIVATE_BUCKET), ["Facebook/9151.jpg", "Facebook/9152.jpg"]);
});

// --- gate: live paths ----------------------------------------------------------

// --- gate: live webhook paths (no dates involved) --------------------------------

const ganzLike = Array.from({ length: 8 }, (_, i) => String(9800 + i));

test("an edit of a post the site never imported is historical: excluded until approved, replays import only approved photos", async () => {
  stubAlbum("600", "Old Job", ["9201", "9202"], { created: OLD });
  stubPost(`${PAGE_ID}_77`, ["9201", "9202"], OLD);
  const edit = { item: "status", verb: "edited", post_id: `${PAGE_ID}_77`, published: 1, from: { id: PAGE_ID } };
  assert.equal((await webhook([edit])).status, 200);
  assert.equal((await rows("SELECT * FROM facebook_photos")).length, 0);
  assert.equal((await rows("SELECT * FROM facebook_projects")).length, 0, "no empty gallery created");
  assert.deepEqual(await keys(baseEnv.PRIVATE_BUCKET), []);

  await decide([{ photoId: "9202", decision: "import" }, { photoId: "9201", decision: "later" }]);
  await webhook([{ ...edit, message: "edit 2" }]);
  await webhook([{ ...edit, message: "edit 2" }]); // exact replay
  assert.deepEqual((await rows("SELECT fb_photo_id FROM facebook_photos")).map((r) => r.fb_photo_id), ["9202"]);
  assert.deepEqual(await keys(baseEnv.PRIVATE_BUCKET), ["Facebook/9202.jpg"]);
});

test("new posts (add) import automatically with no review; skip and later still block; replays never duplicate", async () => {
  stubAlbum("700", "New Job", ["9301", "9302", "9303"], { created: OLD }); // dates are irrelevant now
  stubPost(`${PAGE_ID}_88`, ["9301", "9302", "9303"], OLD);
  await decide([{ photoId: "9302", decision: "skip" }, { photoId: "9303", decision: "later" }]);
  const add = { item: "status", verb: "add", post_id: `${PAGE_ID}_88`, published: 1, from: { id: PAGE_ID } };
  await webhook([add]);
  await webhook([add]); // replay of the same delivery
  assert.deepEqual((await rows("SELECT fb_photo_id, status FROM facebook_photos")).map((r) => [r.fb_photo_id, r.status]), [["9301", "imported"]]);
  assert.deepEqual(await keys(baseEnv.PRIVATE_BUCKET), ["Facebook/9301.jpg"]);
  assert.equal((await rows("SELECT * FROM facebook_projects")).length, 1);
});

test("edits of a known post import newly added photos automatically, even when the add event is in the same delivery", async () => {
  stubAlbum("710", "Fresh Job", ["9351", "9352"], { created: NEW });
  stubPost(`${PAGE_ID}_91`, ["9351"], NEW);
  await webhook([{ item: "status", verb: "add", post_id: `${PAGE_ID}_91`, published: 1, from: { id: PAGE_ID } }]);
  stubPost(`${PAGE_ID}_91`, ["9351", "9352"], NEW); // owner adds a photo to the recent post
  await webhook([{ item: "status", verb: "edited", post_id: `${PAGE_ID}_91`, published: 1, from: { id: PAGE_ID }, message: "added one" }]);
  assert.deepEqual((await rows("SELECT fb_photo_id FROM facebook_photos ORDER BY fb_photo_id")).map((r) => r.fb_photo_id), ["9351", "9352"]);

  // Edit listed before its post's add in one delivery: events are stored first,
  // so the add is visible and the edit counts as live.
  stubAlbum("720", "Same Delivery", ["9361"], { created: NEW });
  stubPost(`${PAGE_ID}_92`, ["9361"], NEW);
  await webhook([
    { item: "photo", verb: "edited", post_id: `${PAGE_ID}_92`, photo_id: "9361", published: 1, from: { id: PAGE_ID } },
    { item: "status", verb: "add", post_id: `${PAGE_ID}_92`, published: 1, from: { id: PAGE_ID } },
  ]);
  assert.equal((await rows("SELECT 1 FROM facebook_photos WHERE fb_photo_id = '9361'")).length, 1);
});

test("a photo newly added to an old album (photo add) imports automatically", async () => {
  stubAlbum("730", "Old Album", ["9371"], { created: OLD });
  await webhook([{ item: "photo", verb: "add", photo_id: "9371", published: 1, from: { id: PAGE_ID } }]);
  assert.deepEqual((await rows("SELECT fb_photo_id, status FROM facebook_photos")).map((r) => [r.fb_photo_id, r.status]), [["9371", "imported"]]);
});

test("the eight already-imported photos are untouched by history runs, edits and replays", async () => {
  stubPageAlbums([["122234637104318503", "Ganz Garage", 8]]);
  stubAlbum("122234637104318503", "Ganz Garage", ganzLike, { created: NEW });
  stubPost(`${PAGE_ID}_95`, ganzLike, NEW);
  await webhook([{ item: "status", verb: "add", post_id: `${PAGE_ID}_95`, published: 1, from: { id: PAGE_ID } }]);
  const snapshot = async () => ({
    rows: await rows("SELECT fb_photo_id, status, hidden, project_id, master_key, public_key, updated_at FROM facebook_photos ORDER BY fb_photo_id"),
    priv: await keys(baseEnv.PRIVATE_BUCKET), pub: await keys(baseEnv.GALLERY_BUCKET),
    projects: await rows("SELECT id, slug, name, hidden FROM facebook_projects"),
  });
  const before = await snapshot();
  assert.equal(before.rows.length, 8);

  const history = await historyRun();
  assert.ok(history.photos.every((p) => p.outcome === "existing"), "already imported, not excluded or re-imported");
  await webhook([{ item: "status", verb: "edited", post_id: `${PAGE_ID}_95`, published: 1, from: { id: PAGE_ID } }]);
  await webhook([{ item: "status", verb: "add", post_id: `${PAGE_ID}_95`, published: 1, from: { id: PAGE_ID } }]);
  await historyRun(makeEnv(), { restart: true });
  assert.deepEqual(await snapshot(), before, "rows, objects and projects unchanged");
});

test("a simultaneous history import and webhook replay import an approved photo exactly once", async () => {
  stubPageAlbums([["740", "Race Job", 2]]);
  stubAlbum("740", "Race Job", ["9391", "9392"], { created: OLD });
  stubPost(`${PAGE_ID}_96`, ["9391", "9392"], OLD);
  await decide([{ photoId: "9391", decision: "import" }, { photoId: "9392", decision: "import" }]);
  const edit = { item: "status", verb: "edited", post_id: `${PAGE_ID}_96`, published: 1, from: { id: PAGE_ID } };
  await Promise.all([historyRun().catch(() => null), webhook([edit]), webhook([{ ...edit, message: "x" }]), historyRun().catch(() => null)]);
  await historyRun(makeEnv(), { restart: true });
  assert.deepEqual((await rows("SELECT fb_photo_id, status FROM facebook_photos ORDER BY fb_photo_id")).map((r) => [r.fb_photo_id, r.status]),
    [["9391", "imported"], ["9392", "imported"]]);
  assert.deepEqual(await keys(baseEnv.PRIVATE_BUCKET), ["Facebook/9391.jpg", "Facebook/9392.jpg"]);
});

test("gate rules and webhook review mode, including a database without migration 017", async () => {
  const env = makeEnv();
  assert.equal(await reviewGate(env, "1", { mode: "historical" }), "review-unreviewed");
  assert.equal(await reviewGate(env, "1", { mode: "live" }), null);
  assert.equal(await reviewGate(env, "1", {}), "review-unreviewed", "a missing mode fails closed");
  assert.equal(await reviewGate(env, "1", { mode: "LIVE" }), "review-unreviewed");
  await decide([{ photoId: "1", decision: "later" }]);
  assert.equal(await reviewGate(env, "1", { mode: "live" }), "review-later", "later never imports");
  await decide([{ photoId: "1", decision: "skip" }]);
  assert.equal(await reviewGate(env, "1", { mode: "live" }), "review-skip");
  await decide([{ photoId: "1", decision: "import" }]);
  assert.equal(await reviewGate(env, "1", { mode: "historical" }), null);

  const db = baseEnv.DB;
  assert.equal(await webhookReviewMode(db, { verb: "add", post_id: "1_2" }), "live");
  assert.equal(await webhookReviewMode(db, { verb: "edited", post_id: "1_2" }), "historical");
  assert.equal(await webhookReviewMode(db, { verb: "edited" }), "historical", "photo edit without a post");
  await db.prepare("INSERT INTO facebook_posts (fb_post_id, page_id, message, source) VALUES ('1_2', ?, '', 'webhook')").bind(PAGE_ID).run();
  assert.equal(await webhookReviewMode(db, { verb: "edited", post_id: "1_2" }), "live", "post already on the site");
  await db.prepare("INSERT INTO facebook_webhook_events (dedupe_key, page_id, field, item, verb, post_id, payload, status) VALUES ('k', ?, 'feed', 'status', 'add', '1_3', '{}', 'pending')").bind(PAGE_ID).run();
  assert.equal(await webhookReviewMode(db, { verb: "edited", post_id: "1_3" }), "live", "add event still queued");
  assert.equal(await webhookReviewMode(db, { verb: "edited", post_id: "1_3' OR 1=1 --" }), "historical", "invalid post id");

  const noTable = { prepare(sql) {
    if (sql.includes("facebook_photo_reviews")) throw new Error("D1_ERROR: no such table: facebook_photo_reviews: SQLITE_ERROR");
    return baseEnv.DB.prepare(sql);
  } };
  assert.equal(await reviewGate(makeEnv({ DB: noTable }), "1", { mode: "historical" }), "review-unreviewed", "history fails closed");
  assert.equal(await reviewGate(makeEnv({ DB: noTable }), "1", { mode: "live" }), null, "live imports unaffected");
});

// --- endpoints -----------------------------------------------------------------

const SUBS = ["review-albums", "review-album?id=500", "review-image?id=9001", "review-site-gallery?all=1", "review-site-image?key=Projects/A/1.jpg", "review-summary"];

test("review endpoints are admin-only and disabled with the integration switch", async () => {
  for (const s of SUBS) assert.equal((await call(`${ADMIN}/${s}`, { admin: false })).status, 401, s);
  assert.equal((await call(`${ADMIN}/review-decisions`, { method: "POST", body: { decisions: [] }, admin: false })).status, 401);
  for (const s of SUBS) assert.equal((await call(`${ADMIN}/${s}`, { env: makeEnv({ FB_INTEGRATION_ENABLED: "false" }) })).status, 404, s);
});

test("review-albums lists Page albums with kinds, suggestions, decision and import counts", async () => {
  await baseEnv.GALLERY_BUCKET.put("Projects/Harper Barn/1.jpg", JPEG);
  await baseEnv.GALLERY_BUCKET.put("New Construction/Harper_Barn/1.jpg", JPEG);
  stubPageAlbums([["500", "Harper Barn", 3], ["501", "Mobile uploads", 91], ["502", "Profile pictures", 4], ["503", "Visitor album", 2, "999"]]);
  await decide([{ photoId: "9001", albumId: "500", decision: "import" }, { photoId: "9002", albumId: "500", decision: "skip" }]);
  const j = await (await call(`${ADMIN}/review-albums`)).json();
  assert.deepEqual(j.albums.map((a) => [a.id, a.kind]), [["500", "project"], ["501", "generic"], ["502", "branding"]], "foreign album dropped");
  const barn = j.albums[0];
  assert.deepEqual(barn.decisions, { import: 1, skip: 1, later: 0 });
  assert.ok(barn.suggested.some((s) => s.prefix === "Projects/Harper Barn/"));
  assert.ok(barn.suggested.some((s) => s.prefix === "New Construction/Harper_Barn/"), "cross-category twin offered too");
  assert.ok(j.galleries.length >= 2);
  assert.doesNotMatch(JSON.stringify(j), new RegExp(`${PAGE_TOKEN}|access_token|fbcdn`));
});

test("review-album paginates, verifies ownership and joins decisions and import state", async () => {
  const ids = Array.from({ length: 55 }, (_, i) => String(9400 + i));
  stubAlbum("510", "Big Job", ids);
  await decide([{ photoId: "9400", albumId: "510", decision: "skip", duplicateOf: "Projects/Big Job/a.jpg", note: "same as a" }]);
  await baseEnv.DB.prepare("INSERT INTO facebook_photos (fb_photo_id, page_id, source, status, master_key, hidden) VALUES ('9401', ?, 'webhook', 'imported', 'Facebook/9401.jpg', 0)").bind(PAGE_ID).run();
  const p1 = await (await call(`${ADMIN}/review-album?id=510`)).json();
  assert.equal(p1.photos.length, 50);
  assert.equal(p1.next, "c50");
  assert.deepEqual([p1.photos[0].decision, p1.photos[0].duplicateOf, p1.photos[0].note], ["skip", "Projects/Big Job/a.jpg", "same as a"]);
  assert.equal(p1.photos[1].state, "imported");
  const p2 = await (await call(`${ADMIN}/review-album?id=510&after=c50`)).json();
  assert.equal(p2.photos.length, 5);
  assert.equal(p2.next, null);
  graph.set("520", { id: "520", name: "Not ours", from: { id: "999" } });
  assert.equal((await call(`${ADMIN}/review-album?id=520`)).status, 404);
  assert.equal((await call(`${ADMIN}/review-album?id=../x`)).status, 400);
  assert.equal((await call(`${ADMIN}/review-album?id=510&after=../../etc`)).status, 400);
});

test("review-image proxies a small rendition privately and never exposes the token or CDN URL", async () => {
  stubPhoto("9501");
  const res = await call(`${ADMIN}/review-image?id=9501`);
  assert.equal(res.status, 200);
  assert.equal(res.headers.get("Cache-Control"), "private, max-age=3600");
  assert.equal(res.headers.get("X-Content-Type-Options"), "nosniff");
  assert.equal(res.headers.get("Content-Type"), "image/jpeg");
  assert.equal((await res.arrayBuffer()).byteLength, JPEG.byteLength);
  const cdnHits = fetchCalls.filter((c) => c.url.hostname.endsWith("fbcdn.net")).map((c) => c.url.pathname);
  assert.deepEqual(cdnHits, ["/s320/9501.jpg"], "smallest rendition at least 320 px");
  assert.ok(![...res.headers.values()].some((v) => v.includes(PAGE_TOKEN) || v.includes("fbcdn")));
  const graphCall = fetchCalls.find((c) => c.url.hostname === "graph.facebook.com");
  assert.ok(!graphCall.url.toString().includes(PAGE_TOKEN), "token sent in a header, not the URL");

  stubPhoto("9502", { fromId: "999" });
  assert.equal((await call(`${ADMIN}/review-image?id=9502`)).status, 404, "visitor photo");
  stubPhoto("9503", { smallHost: "evil.example" });
  const evil = await call(`${ADMIN}/review-image?id=9503`);
  assert.notEqual(evil.status, 200);
  assert.ok(!fetchCalls.some((c) => c.url.hostname === "evil.example"), "SSRF: non-Facebook host never fetched");
  stubPhoto("9504");
  cdn.set("https://scontent.xx.fbcdn.net/s320/9504.jpg", { bytes: new TextEncoder().encode("<svg/>"), type: "image/svg+xml" });
  assert.equal((await call(`${ADMIN}/review-image?id=9504`)).status, 502);
  assert.equal((await call(`${ADMIN}/review-image?id=abc`)).status, 400);
});

test("review-site-gallery and review-site-image only expose manual project galleries", async () => {
  for (const k of ["Projects/Harper Barn/1.jpg", "Projects/Harper Barn/2.jpg", "Remodels/Kitchen/k.jpg", "Reviews/photos/r.jpg", "Facebook/1.jpg", "Highlights/h.jpg", "Apparel/Coats/c.jpg"]) {
    await baseEnv.GALLERY_BUCKET.put(k, JPEG);
  }
  const one = await (await call(`${ADMIN}/review-site-gallery?prefix=${encodeURIComponent("Projects/Harper Barn/")}`)).json();
  assert.deepEqual(one.items.map((i) => i.key), ["Projects/Harper Barn/1.jpg", "Projects/Harper Barn/2.jpg"]);
  const all = await (await call(`${ADMIN}/review-site-gallery?all=1`)).json();
  assert.deepEqual(all.items.map((i) => i.key).sort(), ["Projects/Harper Barn/1.jpg", "Projects/Harper Barn/2.jpg", "Remodels/Kitchen/k.jpg"]);
  for (const p of ["Reviews/photos/", "Facebook/", "Highlights/", "Projects/"]) {
    assert.equal((await call(`${ADMIN}/review-site-gallery?prefix=${encodeURIComponent(p)}`)).status, 404, p);
  }
  const img = await call(`${ADMIN}/review-site-image?key=${encodeURIComponent("Projects/Harper Barn/1.jpg")}`);
  assert.equal(img.status, 200);
  assert.equal(img.headers.get("Cache-Control"), "private, max-age=3600");
  for (const k of ["Reviews/photos/r.jpg", "Facebook/1.jpg", "Highlights/h.jpg", "Projects/../Reviews/photos/r.jpg", "Projects/Harper Barn/1.txt", "Projects//1.jpg"]) {
    assert.equal((await call(`${ADMIN}/review-site-image?key=${encodeURIComponent(k)}`)).status, 400, k);
  }
  assert.equal((await call(`${ADMIN}/review-site-image?key=${encodeURIComponent("Projects/Harper Barn/missing.jpg")}`)).status, 404);

  await baseEnv.DB.prepare("INSERT INTO facebook_projects (id, slug, name) VALUES (7, 'ganz-garage', 'Ganz Garage')").run();
  await baseEnv.DB.prepare("INSERT INTO facebook_photos (fb_photo_id, page_id, source, status, master_key, project_id) VALUES ('9601', ?, 'webhook', 'imported', 'Facebook/9601.jpg', 7)").bind(PAGE_ID).run();
  assert.deepEqual((await (await call(`${ADMIN}/review-site-gallery?project=7`)).json()).items, [{ facebookPhotoId: "9601" }]);
});

test("review-decisions validates the whole batch before writing, upserts and clears", async () => {
  const bad = [
    [{ decisions: [] }, 400], [{ decisions: Array.from({ length: 101 }, (_, i) => ({ photoId: String(i + 1), decision: "import" })) }, 400],
    [{ decisions: [{ photoId: "1", decision: "import" }, { photoId: "x", decision: "import" }] }, 400],
    [{ decisions: [{ photoId: "1", decision: "import" }, { photoId: "1", decision: "skip" }] }, 400],
    [{ decisions: [{ photoId: "1", decision: "publish" }] }, 400],
    [{ decisions: [{ photoId: "1", decision: "skip", duplicateOf: "Reviews/photos/r.jpg" }] }, 400],
    [{ decisions: [{ photoId: "1", decision: "skip", duplicateOf: "https://evil.example/x.jpg" }] }, 400],
    [{ decisions: [{ photoId: "1", albumId: "../2", decision: "import" }] }, 400],
  ];
  for (const [body, status] of bad) assert.equal((await decide(body.decisions)).status, status, JSON.stringify(body).slice(0, 80));
  assert.equal((await rows("SELECT * FROM facebook_photo_reviews")).length, 0, "nothing written by a rejected batch");
  const form = await call(`${ADMIN}/review-decisions`, { method: "POST", raw: "decisions=1", headers: { "Content-Type": "application/x-www-form-urlencoded" } });
  assert.equal(form.status, 415, "JSON only (no cross-site form posts)");

  assert.equal((await decide([
    { photoId: "1", albumId: "500", decision: "skip", duplicateOf: "Projects/Harper Barn/1.jpg", note: "n".repeat(600) },
    { photoId: "2", albumId: "500", decision: "skip", duplicateOf: "facebook:122238483140318503" },
    { photoId: "3", decision: "later" },
  ])).status, 200);
  let r = await rows("SELECT fb_photo_id, album_id, decision, duplicate_of, length(note) AS n FROM facebook_photo_reviews ORDER BY fb_photo_id");
  assert.deepEqual(r.map((x) => [x.fb_photo_id, x.album_id, x.decision, x.duplicate_of, x.n]),
    [["1", "500", "skip", "Projects/Harper Barn/1.jpg", 500], ["2", "500", "skip", "facebook:122238483140318503", null], ["3", null, "later", null, null]]);
  await decide([{ photoId: "1", decision: "import" }, { photoId: "3", decision: "clear" }]);
  r = await rows("SELECT fb_photo_id, album_id, decision, duplicate_of FROM facebook_photo_reviews ORDER BY fb_photo_id");
  assert.deepEqual(r.map((x) => [x.fb_photo_id, x.album_id, x.decision, x.duplicate_of]),
    [["1", "500", "import", null], ["2", "500", "skip", "facebook:122238483140318503"]], "album kept, duplicate link dropped, cleared row gone");
  const summary = await (await call(`${ADMIN}/review-summary`)).json();
  assert.deepEqual(summary, { migrated: true, decisions: { import: 1, skip: 1, later: 0 }, readyToImport: 1 });
});

test("review-image is cached inside the Worker, so repeat views make no Graph calls", async () => {
  stubPhoto("9701");
  const store = new Map();
  const realCaches = globalThis.caches;
  globalThis.caches = { default: {
    async match(req) { const e = store.get(req.url); return e ? new Response(e.body.slice(0), { headers: e.headers }) : undefined; },
    async put(req, res) { store.set(req.url, { body: await res.arrayBuffer(), headers: [...res.headers] }); },
  } };
  try {
    assert.equal((await call(`${ADMIN}/review-image?id=9701`)).status, 200);
    const graphBefore = fetchCalls.filter((c) => c.url.hostname === "graph.facebook.com").length;
    const again = await call(`${ADMIN}/review-image?id=9701`);
    assert.equal(again.status, 200);
    assert.equal(again.headers.get("Cache-Control"), "private, max-age=3600", "browser copy stays private");
    assert.equal(fetchCalls.filter((c) => c.url.hostname === "graph.facebook.com").length, graphBefore, "no Graph call on a cache hit");
    assert.deepEqual([...store.keys()], ["https://review-cache.internal/facebook-preview/9701"], "internal key, not a public URL");
    assert.equal((await call(`${ADMIN}/review-image?id=9701`, { admin: false })).status, 401, "cache is behind admin auth");
  } finally {
    globalThis.caches = realCaches;
  }
});

test("image endpoints are rate limited before any Graph call or R2 read", async () => {
  stubPhoto("9702");
  await baseEnv.GALLERY_BUCKET.put("Projects/Harper Barn/1.jpg", JPEG);
  const keysSeen = [];
  const env = makeEnv({ REVIEW_LIMITER: { limit: async ({ key }) => { keysSeen.push(key); return { success: false }; } } });
  for (const url of [`${ADMIN}/review-image?id=9702`, `${ADMIN}/review-site-image?key=${encodeURIComponent("Projects/Harper Barn/1.jpg")}`]) {
    const res = await call(url, { env });
    assert.equal(res.status, 429, url);
    assert.equal(res.headers.get("Retry-After"), "10");
    assert.equal(res.headers.get("Cache-Control"), "no-store");
  }
  assert.deepEqual(keysSeen, ["review-image", "review-site-image"], "one key per endpoint");
  assert.ok(!fetchCalls.some((c) => c.url.hostname === "graph.facebook.com"), "no Graph call when throttled");
});

// --- targeted import: one album, explicit photo IDs, existing project --------

const GANZ = "122234637104318503";
const seven = Array.from({ length: 7 }, (_, i) => String(9700 + i));
const BACKFILL = `${SITE}/api/gallery-api/facebook/backfill`;
const targeted = (body, env) => call(BACKFILL, { method: "POST", body: { targeted: true, albumId: GANZ, photoIds: seven, ...body }, env });

// Production-like state: Ganz Garage (8 imported by webhook) plus 7 older album
// photos approved for import, an approved photo in another album, and an
// unreviewed photo in the Ganz album.
async function ganzSetup() {
  stubPageAlbums([[GANZ, "Ganz Garage", 16], ["600", "Ganz", 2]]);
  stubAlbum(GANZ, "Ganz Garage", [...ganzLike, ...seven, "9799"], { created: OLD });
  for (const id of ganzLike) stubPhoto(id, { created: NEW, album: { id: GANZ, name: "Ganz Garage" } });
  stubAlbum("600", "Ganz", ["9601", "9602"], { created: OLD });
  stubPost(`${PAGE_ID}_95`, ganzLike, NEW);
  await webhook([{ item: "status", verb: "add", post_id: `${PAGE_ID}_95`, published: 1, from: { id: PAGE_ID } }]);
  const [project] = await rows("SELECT id, fb_album_id FROM facebook_projects");
  assert.equal(project.fb_album_id, GANZ);
  assert.equal((await rows("SELECT * FROM facebook_photos")).length, 8);
  assert.equal((await decide([
    ...seven.map((photoId) => ({ photoId, albumId: GANZ, decision: "import" })),
    { photoId: "9601", albumId: "600", decision: "import" },
    { photoId: "9602", albumId: "600", decision: "later" },
  ])).status, 200);
  return project.id;
}
const snapshotAll = async () => ({
  photos: await rows("SELECT fb_photo_id, status, hidden, project_id, master_key, public_key, updated_at FROM facebook_photos ORDER BY fb_photo_id"),
  projects: await rows("SELECT * FROM facebook_projects ORDER BY id"),
  mappings: await rows("SELECT * FROM facebook_album_mappings ORDER BY album_id"),
  posts: await rows("SELECT * FROM facebook_posts ORDER BY fb_post_id"),
  reviews: await rows("SELECT * FROM facebook_photo_reviews ORDER BY fb_photo_id"),
  jobs: await rows("SELECT * FROM facebook_discovery_jobs"),
  albums: await rows("SELECT * FROM facebook_albums"),
  cursor: await rows("SELECT * FROM facebook_sync_state WHERE key = 'backfill_cursor'"),
  priv: await keys(baseEnv.PRIVATE_BUCKET), pub: await keys(baseEnv.GALLERY_BUCKET),
});

test("targeted dry run reports exactly the approved album photos and changes nothing, even with historical import off", async () => {
  const projectId = await ganzSetup();
  const before = await snapshotAll();
  const calls = fetchCalls.length;
  const res = await targeted({ dryRun: true, projectId }, makeEnv({ FB_HISTORICAL_IMPORT_ENABLED: "false" }));
  assert.equal(res.status, 200);
  const r = await res.json();
  assert.equal(r.dryRun, true);
  assert.deepEqual(r.destination, { id: projectId, slug: "ganz-garage", name: "Ganz Garage" });
  assert.deepEqual([r.requested, r.new, r.existing, r.refused, r.imported], [7, 7, 0, 0, 0]);
  assert.deepEqual(r.photos.map((p) => [p.id, p.outcome]), seven.map((id) => [id, "new"]));
  assert.ok(!JSON.stringify(r).includes("fbcdn"), "no Graph payloads or CDN URLs in the response");
  const made = fetchCalls.slice(calls);
  assert.ok(!made.some((c) => c.url.hostname.endsWith("fbcdn.net")), "no image downloads");
  assert.deepEqual(made.map((c) => c.url.pathname.split("/").pop()), seven,
    "only the seven requested photos are looked up; no Page, album or post scan");
  assert.deepEqual(await snapshotAll(), before, "dry run writes nothing");
});

test("targeted real run needs the historical-import switch", async () => {
  const projectId = await ganzSetup();
  const before = await snapshotAll();
  const res = await targeted({ dryRun: false, projectId, expectedCount: 7 }, makeEnv({ FB_HISTORICAL_IMPORT_ENABLED: "false" }));
  assert.equal(res.status, 403);
  assert.deepEqual(await snapshotAll(), before);
});

test("targeted import adds exactly the seven photos to the existing project and leaves everything else unchanged", async () => {
  const projectId = await ganzSetup();
  const before = await snapshotAll();
  const res = await targeted({ dryRun: false, projectId, expectedCount: 7 });
  assert.equal(res.status, 200);
  const r = await res.json();
  assert.deepEqual([r.imported, r.failed.length], [7, 0]);
  assert.deepEqual(r.photos.map((p) => p.outcome), Array(7).fill("imported"));

  const after = await snapshotAll();
  const added = after.photos.filter((p) => !before.photos.some((b) => b.fb_photo_id === p.fb_photo_id));
  assert.deepEqual(added.map((p) => p.fb_photo_id), seven);
  assert.ok(added.every((p) => p.status === "imported" && p.project_id === projectId && p.hidden === 0 && p.public_key), "published in Ganz Garage");
  assert.deepEqual(after.photos.filter((p) => ganzLike.includes(p.fb_photo_id)), before.photos, "the eight existing photos are untouched");
  for (const k of ["projects", "mappings", "posts", "reviews", "jobs", "albums", "cursor"]) assert.deepEqual(after[k], before[k], `${k} unchanged`);
  assert.deepEqual(after.priv, [...before.priv, ...seven.map((id) => `Facebook/${id}.jpg`)].sort());
  assert.ok(!after.photos.some((p) => ["9601", "9602", "9799"].includes(p.fb_photo_id)), "other albums and unreviewed photos are not imported");
  const gallery = await (await call(`${SITE}/api/gallery-api?project=ganz-garage`, { admin: false })).json();
  assert.equal(gallery.items.length, 15);

  // Re-running is a no-op: duplicates are detected before any Graph call or download.
  const calls = fetchCalls.length;
  const dry = await (await targeted({ dryRun: true, projectId })).json();
  assert.deepEqual([dry.new, dry.existing], [0, 7]);
  const rerun = await targeted({ dryRun: false, projectId, expectedCount: 7 });
  assert.equal(rerun.status, 409, "expected count no longer matches");
  assert.equal(fetchCalls.length, calls, "no Graph calls or downloads for already-imported photos");
  assert.equal((await rows("SELECT * FROM facebook_photos")).length, 15);
});

test("targeted import refuses the whole batch when any photo or the destination fails a check", async () => {
  const projectId = await ganzSetup();
  const before = await snapshotAll();
  const attempt = async (body, env) => {
    const res = await targeted({ dryRun: false, projectId, expectedCount: 7, ...body }, env);
    return [res.status, await res.json()];
  };
  const reason = (r, id) => r.photos?.find((p) => p.id === id)?.reason;
  const last = seven[6];
  const others = seven.slice(0, 6);

  let [status, r] = await attempt({ photoIds: [...others, "9799"] });
  assert.equal(status, 409); assert.equal(reason(r, "9799"), "review-unreviewed");
  [status, r] = await attempt({ photoIds: [...others, "9602"] });
  assert.equal(status, 409); assert.equal(reason(r, "9602"), "review-later");
  [status, r] = await attempt({ photoIds: [...others, "9601"] });
  assert.equal(status, 409); assert.equal(reason(r, "9601"), "review-album-mismatch", "approved, but in another album");

  // Facebook reports a different album, a different owner, or a non-Facebook image host.
  stubPhoto(last, { album: { id: "600", name: "Ganz" } });
  [status, r] = await attempt({});
  assert.equal(status, 409); assert.equal(reason(r, last), "album-mismatch");
  stubPhoto(last, { album: { id: GANZ, name: "Ganz Garage" }, fromId: "999" });
  [status, r] = await attempt({});
  assert.equal(status, 409); assert.equal(reason(r, last), "not-page-photo");
  stubPhoto(last, { album: { id: GANZ, name: "Ganz Garage" } });
  graph.get(last).images = [{ width: 2048, height: 1536, source: "https://evil.example/x.jpg" }];
  [status, r] = await attempt({});
  assert.equal(status, 409); assert.equal(reason(r, last), "no-facebook-image");
  stubPhoto(last, { album: { id: GANZ, name: "Ganz Garage" } });

  [status, r] = await attempt({ expectedCount: 6 });
  assert.equal(status, 409); assert.match(r.error, /Expected 6 new photos but found 7/);
  assert.equal((await targeted({ dryRun: false, projectId })).status, 400, "expectedCount is required");

  // Destination checks.
  assert.equal((await attempt({ albumId: "600" }))[0], 409, "album not linked to the project");
  assert.equal((await attempt({ projectId: 999 }))[0], 404);
  await baseEnv.DB.prepare("UPDATE facebook_projects SET hidden = 1 WHERE id = ?").bind(projectId).run();
  assert.equal((await attempt({}))[0], 409, "hidden project");
  await baseEnv.DB.prepare("UPDATE facebook_projects SET hidden = 0 WHERE id = ?").bind(projectId).run();

  // Input validation.
  for (const body of [{ photoIds: [] }, { photoIds: Array.from({ length: 11 }, (_, i) => String(9000 + i)) },
    { photoIds: [seven[0], seven[0]] }, { photoIds: ["1 OR 1=1"] }, { albumId: "x" }, { projectId: "1" }]) {
    assert.equal((await attempt(body))[0], 400, JSON.stringify(body));
  }
  assert.equal((await call(BACKFILL, { method: "POST", admin: false, body: { targeted: true, dryRun: true } })).status, 401);

  assert.deepEqual(await snapshotAll(), before, "every refusal wrote nothing");
});

test("automatic import of new posts still works after a targeted import", async () => {
  const projectId = await ganzSetup();
  assert.equal((await targeted({ dryRun: false, projectId, expectedCount: 7 })).status, 200);
  stubPhoto("9790", { created: NEW, album: { id: GANZ, name: "Ganz Garage" } });
  stubPost(`${PAGE_ID}_97`, ["9790"], NEW);
  await webhook([{ item: "status", verb: "add", post_id: `${PAGE_ID}_97`, published: 1, from: { id: PAGE_ID } }]);
  const row = (await rows("SELECT status, project_id FROM facebook_photos WHERE fb_photo_id = '9790'"))[0];
  assert.deepEqual([row.status, row.project_id], ["imported", projectId], "new post imports with no review into the same project");
  assert.equal((await rows("SELECT * FROM facebook_photos")).length, 16);
});

// --- album-link: connect an album to an existing gallery without importing ----

const LINK = `${ADMIN}/album-link`;
const link = (body, opts = {}) => call(LINK, { method: "POST", body, ...opts });

test("album-link connects an album to a manual-folder gallery, then a targeted import fills it", async () => {
  const projectId = await ganzSetup();
  // A manual gallery and the Facebook gallery linked to it (admin project-create).
  await baseEnv.GALLERY_BUCKET.put("Projects/Schwennson House/1_Schwennson_Exterior_1.jpg", JPEG, { httpMetadata: { contentType: "image/jpeg" } });
  const created = await (await call(`${ADMIN}/project-create`, { method: "POST", body: { name: "Schwennson House", linkedPrefix: "Projects/Schwennson House/" } })).json();
  const schwennsonId = created.project.id;
  stubPageAlbums([[GANZ, "Ganz Garage", 16], ["700", "Schwennson", 3]]);
  stubAlbum("700", "Schwennson", ["9901", "9902", "9903"], { created: OLD });
  await decide([{ photoId: "9901", albumId: "700", decision: "import" }, { photoId: "9902", albumId: "700", decision: "import" }, { photoId: "9903", albumId: "700", decision: "skip", duplicateOf: "Projects/Schwennson House/1_Schwennson_Exterior_1.jpg" }]);

  const before = await snapshotAll();
  const body = { targeted: true, albumId: "700", projectId: schwennsonId, photoIds: ["9901", "9902"] };
  assert.equal((await call(BACKFILL, { method: "POST", body: { ...body, dryRun: true } })).status, 409, "not linked yet: refused");

  const res = await link({ albumId: "700", projectId: schwennsonId });
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { ok: true, changed: true, albumId: "700", album: "Schwennson", project: { id: schwennsonId, slug: created.project.slug, name: "Schwennson House" } });
  const after = await snapshotAll();
  assert.deepEqual(after.mappings, [{ album_id: "700", project_id: schwennsonId, locked: 1 }]);
  for (const k of ["photos", "projects", "posts", "reviews", "jobs", "priv", "pub"]) assert.deepEqual(after[k], before[k], `${k} unchanged by linking`);
  assert.equal((await (await link({ albumId: "700", projectId: schwennsonId })).json()).changed, false, "re-linking is a no-op");

  const dry = await (await call(BACKFILL, { method: "POST", body: { ...body, dryRun: true } })).json();
  assert.deepEqual([dry.new, dry.existing, dry.refused, dry.destination.id], [2, 0, 0, schwennsonId]);
  const run = await (await call(BACKFILL, { method: "POST", body: { ...body, dryRun: false, expectedCount: 2 } })).json();
  assert.equal(run.imported, 2);
  const page = await (await call(`${SITE}/api/gallery-api?project=schwennson-house`, { admin: false })).json();
  assert.equal(page.items.length, 3, "the manual gallery now shows its photo plus the 2 imported ones");
  assert.equal((await rows("SELECT * FROM facebook_photos WHERE fb_photo_id = '9903'")).length, 0, "the Skip photo stays out");
  assert.equal((await rows("SELECT * FROM facebook_photos WHERE project_id = ?", projectId)).length, 8, "Ganz Garage untouched");
});

test("album-link refuses unsorted, branding, foreign and already-linked albums and Recent Project Updates", async () => {
  const projectId = await ganzSetup();
  const other = (await (await call(`${ADMIN}/project-create`, { method: "POST", body: { name: "Bisek", category: "projects" } })).json()).project.id;
  stubAlbum("801", "Mobile uploads", ["9811"]);
  stubAlbum("802", "Profile pictures", ["9812"]);
  stubAlbum("803", "Someone Else", ["9813"]);
  graph.set("803", { id: "803", name: "Someone Else", from: { id: "999" } });
  stubAlbum("804", "Bisek", ["9814"]);
  await baseEnv.DB.prepare("INSERT INTO facebook_projects (slug, name, kind) VALUES ('recent', 'Recent Project Updates', 'recent')").run();
  const recent = (await rows("SELECT id FROM facebook_projects WHERE kind = 'recent'"))[0].id;
  const before = await snapshotAll();

  const expect = async (body, status, opts) => { const r = await link(body, opts); assert.equal(r.status, status, JSON.stringify(body)); };
  await expect({ albumId: "801", projectId: other }, 409);
  await expect({ albumId: "802", projectId: other }, 409);
  await expect({ albumId: "803", projectId: other }, 404);
  await expect({ albumId: "805", projectId: other }, 502, undefined); // unknown on Graph
  await expect({ albumId: GANZ, projectId: other }, 409); // Ganz Garage's album belongs to project 1
  await expect({ albumId: "804", projectId: 999 }, 404);
  await expect({ albumId: "804", projectId: recent }, 409);
  for (const body of [{}, { albumId: "x", projectId: other }, { albumId: "804", projectId: "1" }, { albumId: "804", projectId: 0 }]) await expect(body, 400);
  await expect({ albumId: "804", projectId: other }, 401, { admin: false });
  assert.deepEqual(await snapshotAll(), before, "every refusal wrote nothing");

  await expect({ albumId: "804", projectId: other }, 200);
  await expect({ albumId: "804", projectId: projectId }, 409, undefined); // now linked to Bisek
  assert.equal((await (await link({ albumId: GANZ, projectId })).json()).changed, false, "an album that owns its project is already linked");
});

// --- branding albums: never imported by any path ------------------------------

test("a new profile picture or cover photo post never imports or creates a gallery (live webhook)", async () => {
  stubPhoto("9951", { created: NEW, album: { id: "880", name: "Profile pictures" } });
  stubPhoto("9952", { created: NEW, album: { id: "881", name: "Cover photos" } });
  stubPost(`${PAGE_ID}_98`, ["9951"], NEW);
  stubPost(`${PAGE_ID}_99`, ["9952"], NEW);
  await webhook([{ item: "status", verb: "add", post_id: `${PAGE_ID}_98`, published: 1, from: { id: PAGE_ID } },
    { item: "photo", verb: "add", photo_id: "9952", post_id: `${PAGE_ID}_99`, published: 1, from: { id: PAGE_ID } }]);
  for (const t of ["facebook_photos", "facebook_projects"]) assert.equal((await rows(`SELECT * FROM ${t}`)).length, 0, t);
  assert.deepEqual(await keys(baseEnv.PRIVATE_BUCKET), []);
  assert.ok(!fetchCalls.some((c) => c.url.hostname.endsWith("fbcdn.net")), "nothing downloaded");
  // Ordinary new posts still import automatically.
  stubPhoto("9953", { created: NEW, album: { id: "882", name: "Harper Barn" } });
  stubPost(`${PAGE_ID}_100`, ["9953"], NEW);
  await webhook([{ item: "status", verb: "add", post_id: `${PAGE_ID}_100`, published: 1, from: { id: PAGE_ID } }]);
  assert.deepEqual((await rows("SELECT fb_photo_id, status FROM facebook_photos")).map((r) => [r.fb_photo_id, r.status]), [["9953", "imported"]]);
});

test("scheduled discovery (reconcile) is future-only and never imports branding albums", async () => {
  stubPageAlbums([["500", "Harper Barn", 2], ["880", "Profile pictures", 1], ["881", "Mobile uploads", 1]]);
  stubAlbum("500", "Harper Barn", ["9961"], { created: OLD });
  stubAlbum("500", "Harper Barn", ["9961", "9962"], { created: OLD });
  stubPhoto("9962", { created: NEW, album: { id: "500", name: "Harper Barn" } });
  stubAlbum("880", "Profile pictures", ["9963"], { created: NEW });
  stubAlbum("881", "Mobile uploads", ["9964"], { created: OLD });
  const env = makeEnv({ FB_DISCOVERY_ENABLED: "true" });
  const now = new Date("2026-11-01T00:00:00Z"); // cutoff: OLD (2025) is before it, NEW (2026-11-20) after
  let report;
  for (let n = 0; n < 30; n++) {
    report = (await runFacebookDiscovery(env, { dryRun: false }, { mode: "reconcile", now })).body;
    if (report.complete || report.errors?.length || report.busy) break;
  }
  assert.equal(report.errors?.length || 0, 0);
  const job = (await rows("SELECT mode, state FROM facebook_discovery_jobs"))[0];
  assert.equal(job.mode, "reconcile");
  assert.equal(JSON.parse(job.state).cutoff, now.toISOString(), "the cutoff is the first run's time");
  assert.deepEqual((await rows("SELECT fb_photo_id, status FROM facebook_photos ORDER BY fb_photo_id")).map((r) => [r.fb_photo_id, r.status]), [["9962", "imported"]],
    "only the photo added after the cutoff; older photos and the profile picture stay out");
  assert.equal((await rows("SELECT * FROM facebook_photo_reviews")).length, 0, "no review decisions are written");
});

// --- mixed albums: approved photos go to different galleries, per batch -------

test("mixed albums: approved photos are imported into different galleries, with no album mapping", async () => {
  const ganzId = await ganzSetup();
  const autobody = (await (await call(`${ADMIN}/project-create`, { method: "POST", body: { name: "3D Autobody", category: "remodels" } })).json()).project.id;
  stubAlbum("890", "Mobile uploads", ["9891", "9892", "9893"], { created: OLD });
  await decide([{ photoId: "9891", albumId: "890", decision: "import" }, { photoId: "9892", albumId: "890", decision: "import" }]);
  const base = { targeted: true, albumId: "890" };

  assert.equal((await call(BACKFILL, { method: "POST", body: { ...base, projectId: autobody, photoIds: ["9891"], dryRun: true } })).status, 409, "an unlinked album needs mixedAlbum");
  assert.equal((await call(BACKFILL, { method: "POST", body: { ...base, albumId: GANZ, projectId: autobody, photoIds: [seven[0]], dryRun: true, mixedAlbum: true } })).status, 409,
    "a linked album can't be imported elsewhere as mixed");

  const dry = await (await call(BACKFILL, { method: "POST", body: { ...base, mixedAlbum: true, projectId: autobody, photoIds: ["9891", "9893"], dryRun: true } })).json();
  assert.deepEqual(dry.photos.map((p) => [p.id, p.outcome, p.reason]), [["9891", "new", null], ["9893", "refused", "review-unreviewed"]], "unreviewed photos are refused in mixed albums too");

  const a = await (await call(BACKFILL, { method: "POST", body: { ...base, mixedAlbum: true, projectId: autobody, photoIds: ["9891"], dryRun: false, expectedCount: 1 } })).json();
  const b = await (await call(BACKFILL, { method: "POST", body: { ...base, mixedAlbum: true, projectId: ganzId, photoIds: ["9892"], dryRun: false, expectedCount: 1 } })).json();
  assert.deepEqual([a.imported, a.mixedAlbum, b.imported], [1, true, 1]);
  assert.deepEqual(await rows("SELECT fb_photo_id, project_id, project_locked, album_id FROM facebook_photos WHERE fb_photo_id IN ('9891','9892') ORDER BY fb_photo_id"),
    [{ fb_photo_id: "9891", project_id: autobody, project_locked: 1, album_id: "890" }, { fb_photo_id: "9892", project_id: ganzId, project_locked: 1, album_id: "890" }]);
  assert.deepEqual(await rows("SELECT * FROM facebook_album_mappings"), [], "no mapping: the album stays unsorted");
  assert.equal((await rows("SELECT * FROM facebook_photos WHERE fb_photo_id = '9893'")).length, 0);
});

test("targeted import refuses branding-album photos", async () => {
  await ganzSetup();
  const p = (await (await call(`${ADMIN}/project-create`, { method: "POST", body: { name: "Logo", category: "projects" } })).json()).project.id;
  stubAlbum("891", "Profile pictures", ["9894"], { created: OLD });
  await decide([{ photoId: "9894", albumId: "891", decision: "import" }]);
  const r = await (await call(BACKFILL, { method: "POST", body: { targeted: true, albumId: "891", mixedAlbum: true, projectId: p, photoIds: ["9894"], dryRun: true } })).json();
  assert.deepEqual(r.photos.map((x) => [x.outcome, x.reason]), [["refused", "branding-album"]]);
});

// --- Import Approved Photos (import-plan / import-run) -------------------------
// The review page's own import: scoped switch, explicit IDs only, no scans.

const PLAN = (albumId) => `${ADMIN}/import-plan?albumId=${albumId}`;
const RUN = `${ADMIN}/import-run`;
// Global historical import OFF; only the scoped switch is on.
const reviewEnv = (o = {}) => makeEnv({ FB_HISTORICAL_IMPORT_ENABLED: "false", FB_REVIEWED_IMPORT_ENABLED: "true", ...o });
const runImport = (body, opts = {}) => call(RUN, { method: "POST", env: reviewEnv(), ...opts, body: { albumId: GANZ, photoIds: seven, ...body } });
const scanCalls = () => fetchCalls.filter((c) => c.url.hostname === "graph.facebook.com" && /\/(albums|posts|photos|attachments)$/.test(c.url.pathname));

test("import-plan lists the album's approved photos, its gallery and the switch, from D1 only", async () => {
  const projectId = await ganzSetup();
  await decide([{ photoId: "9799", albumId: GANZ, decision: "later" }]);
  const calls = fetchCalls.length;
  const res = await call(PLAN(GANZ), { env: reviewEnv() });
  assert.equal(res.status, 200);
  const plan = await res.json();
  assert.deepEqual([plan.pending, plan.imported, plan.enabled, plan.batchSize, plan.confirmation], [seven, [], true, 10, "IMPORT APPROVED"]);
  assert.deepEqual(plan.linked, { id: projectId, name: "Ganz Garage", slug: "ganz-garage", usable: true });
  assert.ok(plan.galleries.some((g) => g.id === projectId));
  assert.equal(fetchCalls.length, calls, "no Graph calls");
  assert.equal((await call(PLAN(GANZ), { env: reviewEnv({ FB_REVIEWED_IMPORT_ENABLED: "false" }) }).then((r) => r.json())).enabled, false);
  assert.equal((await call(PLAN(GANZ), { admin: false, env: reviewEnv() })).status, 401);
  assert.equal((await call(PLAN("x"), { env: reviewEnv() })).status, 400);
});

test("import-run imports approved photos with global historical import off, then the plan shows them imported", async () => {
  const projectId = await ganzSetup();
  const before = await snapshotAll();
  const dry = await (await runImport({ projectId, dryRun: true })).json();
  assert.deepEqual([dry.new, dry.existing, dry.refused], [7, 0, 0]);
  assert.deepEqual(await snapshotAll(), before, "the dry run writes nothing");
  const res = await runImport({ projectId, dryRun: false, expectedCount: 7, confirm: "IMPORT APPROVED" });
  assert.equal(res.status, 200);
  assert.equal((await res.json()).imported, 7);
  const plan = await (await call(PLAN(GANZ), { env: reviewEnv() })).json();
  assert.deepEqual([plan.pending, plan.imported], [[], seven]);
  assert.equal(scanCalls().length, 0, "never lists albums, posts or album photos");
  const after = await snapshotAll();
  for (const k of ["projects", "mappings", "posts", "reviews", "jobs", "albums", "cursor"]) assert.deepEqual(after[k], before[k], k);
  assert.equal((await rows("SELECT * FROM facebook_photos WHERE project_id = ?", projectId)).length, 15);
});

test("import-run authentication, switch, confirmation, JSON-only body and rate limit", async () => {
  const projectId = await ganzSetup();
  const before = await snapshotAll();
  const real = { projectId, dryRun: false, expectedCount: 7, confirm: "IMPORT APPROVED" };
  assert.equal((await runImport(real, { admin: false })).status, 401, "signed out");
  assert.equal((await runImport(real, { env: reviewEnv({ FB_REVIEWED_IMPORT_ENABLED: "false" }) })).status, 403, "scoped switch off");
  assert.equal((await runImport(real, { env: reviewEnv({ FB_REVIEWED_IMPORT_ENABLED: undefined }) })).status, 403, "switch missing fails closed");
  assert.equal((await runImport({ ...real, confirm: undefined })).status, 400, "no confirmation");
  assert.equal((await runImport({ ...real, confirm: "import approved" })).status, 400, "wrong confirmation");
  const form = await call(RUN, { method: "POST", env: reviewEnv(), headers: { "Content-Type": "application/x-www-form-urlencoded" }, raw: "dryRun=false" });
  assert.equal(form.status, 415, "form posts (CSRF shape) are refused");
  const throttled = reviewEnv({ REVIEW_LIMITER: { limit: async () => ({ success: false }) } });
  assert.equal((await runImport(real, { env: throttled })).status, 429);
  assert.equal((await runImport(real, { env: reviewEnv({ REVIEW_LIMITER: undefined }) })).status, 503, "real runs need the limiter");
  assert.equal((await runImport(real, { env: reviewEnv({ FB_INTEGRATION_ENABLED: "false" }) })).status, 404, "integration kill switch");
  assert.deepEqual(await snapshotAll(), before, "every refusal wrote nothing");
});

test("import-run batch limits and unintended imports are refused before anything is written", async () => {
  const projectId = await ganzSetup();
  const before = await snapshotAll();
  const real = { projectId, dryRun: false, confirm: "IMPORT APPROVED" };
  const eleven = Array.from({ length: 11 }, (_, i) => String(9600 + i));
  assert.equal((await runImport({ ...real, photoIds: eleven, expectedCount: 11 })).status, 400, "more than 10 photos");
  assert.equal((await runImport({ ...real, photoIds: [], expectedCount: 1 })).status, 400);
  assert.equal((await runImport({ ...real, photoIds: [...seven.slice(0, 6), "9799"], expectedCount: 7 })).status, 409, "an unreviewed photo refuses the batch");
  assert.equal((await runImport({ ...real, photoIds: [...seven.slice(0, 6), "9601"], expectedCount: 7 })).status, 409, "approved in another album");
  assert.equal((await runImport({ ...real, expectedCount: 8 })).status, 409, "count changed since the check");
  assert.equal((await runImport({ ...real, expectedCount: 7, mixedAlbum: true })).status, 409, "a linked album can't be sent elsewhere");
  assert.equal((await runImport({ ...real, albumId: "600", photoIds: ["9601"], expectedCount: 1 })).status, 409, "an unlinked album without mixedAlbum");
  assert.deepEqual(await snapshotAll(), before);
  assert.equal(scanCalls().length, 0);
});

test("import-run never imports a photo twice, even when two runs overlap", async () => {
  const projectId = await ganzSetup();
  const real = { projectId, dryRun: false, expectedCount: 7, confirm: "IMPORT APPROVED" };
  const [a, b] = await Promise.all([runImport(real), runImport(real)]);
  const imported = (await a.json()).imported + (await b.json()).imported;
  assert.equal(imported, 7, "together the two runs import each photo once");
  assert.equal((await rows("SELECT * FROM facebook_photos WHERE project_id = ?", projectId)).length, 15);
  assert.equal((await keys(baseEnv.PRIVATE_BUCKET)).filter((k) => seven.some((id) => k.includes(id))).length, 7);
  const again = await (await runImport({ projectId, dryRun: true })).json();
  assert.deepEqual([again.new, again.existing], [0, 7], "already imported photos are reported, not re-fetched");
});

test("import-run partial failure: the rest import, failures are reported and can be retried", async () => {
  const projectId = await ganzSetup();
  const broken = `https://scontent.xx.fbcdn.net/big/${seven[2]}.jpg`;
  const good = cdn.get(broken);
  cdn.delete(broken);
  const res = await runImport({ projectId, dryRun: false, expectedCount: 7, confirm: "IMPORT APPROVED" });
  assert.equal(res.status, 207);
  const r = await res.json();
  assert.equal(r.imported, 6);
  assert.deepEqual(r.failed.map((f) => f.id), [seven[2]]);
  assert.equal(r.photos.find((p) => p.id === seven[2]).outcome, "failed");
  const plan = await (await call(PLAN(GANZ), { env: reviewEnv() })).json();
  assert.deepEqual(plan.pending, [seven[2]], "the failed photo is offered again");
  cdn.set(broken, good);
  const retry = await (await runImport({ projectId, photoIds: [seven[2]], dryRun: false, expectedCount: 1, confirm: "IMPORT APPROVED" })).json();
  assert.equal(retry.imported, 1);
  assert.equal((await rows("SELECT * FROM facebook_photos WHERE project_id = ? AND status = 'imported'", projectId)).length, 15);
});

test("import-run into a chosen gallery for a mixed album, and webhook auto-import is unaffected", async () => {
  const ganzId = await ganzSetup();
  const autobody = (await (await call(`${ADMIN}/project-create`, { method: "POST", body: { name: "3D Autobody", category: "remodels" } })).json()).project.id;
  stubAlbum("890", "Mobile uploads", ["9891", "9892"], { created: OLD });
  await decide([{ photoId: "9891", albumId: "890", decision: "import" }]);
  const r = await (await runImport({ albumId: "890", photoIds: ["9891", "9892"], projectId: autobody, mixedAlbum: true, dryRun: true })).json();
  assert.deepEqual(r.photos.map((p) => [p.id, p.outcome]), [["9891", "new"], ["9892", "refused"]]);
  const done = await (await runImport({ albumId: "890", photoIds: ["9891"], projectId: autobody, mixedAlbum: true, dryRun: false, expectedCount: 1, confirm: "IMPORT APPROVED" })).json();
  assert.equal(done.imported, 1);
  assert.deepEqual(await rows("SELECT * FROM facebook_album_mappings"), []);
  stubPhoto("9895", { created: NEW, album: { id: GANZ, name: "Ganz Garage" } });
  stubPost(`${PAGE_ID}_105`, ["9895"], NEW);
  await webhook([{ item: "status", verb: "add", post_id: `${PAGE_ID}_105`, published: 1, from: { id: PAGE_ID } }], reviewEnv());
  assert.equal((await rows("SELECT project_id FROM facebook_photos WHERE fb_photo_id = '9895'"))[0].project_id, ganzId, "new posts still import automatically");
});

// --- Import Approved Photos into existing manual website galleries -------------

const putManual = (key) => baseEnv.GALLERY_BUCKET.put(key, JPEG, { httpMetadata: { contentType: "image/jpeg" } });
async function manualSetup() {
  const ganzId = await ganzSetup();
  for (const k of ["Furniture/Cutting Boards/Davis_Cutting_Board.jpg", "Furniture/Cabinets/Sandberg_1.jpg", "Furniture/Epoxy/Table_1.jpg",
    "Remodels/3D_Autobody/Exterior_1.jpg", "New Construction/Kitelinger Shell/1.jpg", "Projects/Schwennson House/1.jpg",
    "Highlights/home.jpg", "Apparel/Coats/coat.jpg"]) await putManual(k);
  stubPageAlbums([[GANZ, "Ganz Garage", 16], ["760", "Cutting boards", 3], ["890", "Mobile uploads", 2]]);
  stubAlbum("760", "Cutting boards", ["9761", "9762", "9763"], { created: OLD });
  stubAlbum("890", "Mobile uploads", ["9891", "9892"], { created: OLD });
  await decide([{ photoId: "9761", albumId: "760", decision: "import" }, { photoId: "9762", albumId: "760", decision: "import" },
    { photoId: "9763", albumId: "760", decision: "skip", duplicateOf: "Furniture/Cutting Boards/Davis_Cutting_Board.jpg" },
    { photoId: "9891", albumId: "890", decision: "import" }]);
  return ganzId;
}

test("import-plan lists every website gallery by category, once, without Highlights, Apparel or hidden galleries", async () => {
  const ganzId = await manualSetup();
  // Schwennson House is already linked; a hidden Facebook gallery must not be offered.
  const linked = (await (await call(`${ADMIN}/project-create`, { method: "POST", body: { name: "Schwennson House", linkedPrefix: "Projects/Schwennson House/" } })).json()).project.id;
  const hidden = (await (await call(`${ADMIN}/project-create`, { method: "POST", body: { name: "Old Hidden", category: "projects" } })).json()).project.id;
  await baseEnv.DB.prepare("UPDATE facebook_projects SET hidden = 1 WHERE id = ?").bind(hidden).run();
  const plan = await (await call(PLAN("760"), { env: reviewEnv() })).json();
  const rowsOut = plan.galleries.map((g) => [g.category, g.name, g.source, g.id === null ? null : "id"]);
  assert.deepEqual(rowsOut, [
    ["projects", "Ganz Garage", "facebook", "id"],
    ["projects", "Schwennson House", "website", "id"],
    ["new-construction", "Kitelinger Shell", "website", null],
    ["remodels", "3D Autobody", "website", null],
    ["furniture", "Cabinets", "website", null],
    ["furniture", "Cutting Boards", "website", null],
    ["furniture", "Epoxy", "website", null],
  ]);
  assert.equal(plan.galleries.find((g) => g.name === "Schwennson House").value, `project:${linked}`, "a linked website gallery appears once, by its record");
  assert.equal(plan.galleries.find((g) => g.name === "Cutting Boards").value, "manual:Furniture/Cutting Boards/");
  assert.ok(plan.galleries.some((g) => g.id === ganzId));
  assert.ok(!plan.galleries.some((g) => /Highlights|Apparel|Old Hidden/.test(g.name + g.linkedPrefix)));
});

test("approved photos import straight into an existing manual gallery: no duplicate images, no new public gallery", async () => {
  await manualSetup();
  const prefix = "Furniture/Cutting Boards/";
  const base = { albumId: "760", photoIds: ["9761", "9762"] };
  const before = await snapshotAll();

  // Check: names the website gallery by folder, writes nothing.
  const dry = await (await runImport({ ...base, linkedPrefix: prefix, mixedAlbum: true, dryRun: true })).json();
  assert.deepEqual([dry.new, dry.refused, dry.destination], [2, 0, { id: null, slug: null, name: "Cutting Boards", linkedPrefix: prefix }]);
  assert.deepEqual(await snapshotAll(), before, "the check created no link and no mapping");
  assert.equal((await runImport({ ...base, linkedPrefix: prefix, dryRun: false, expectedCount: 2, confirm: "IMPORT APPROVED" })).status, 409,
    "a real run needs the link record first");

  // Confirm, as the page does: create or reuse the link, link the album, import.
  const first = await (await call(`${ADMIN}/project-create`, { method: "POST", body: { name: "Cutting Boards", linkedPrefix: prefix } })).json();
  const again = await (await call(`${ADMIN}/project-create`, { method: "POST", body: { name: "Cutting Boards", linkedPrefix: prefix } })).json();
  assert.equal(again.project.id, first.project.id, "the existing link is reused, never duplicated");
  const pid = first.project.id;
  assert.equal((await call(`${ADMIN}/album-link`, { method: "POST", body: { albumId: "760", projectId: pid } })).status, 200);
  const run = await (await runImport({ ...base, projectId: pid, dryRun: false, expectedCount: 2, confirm: "IMPORT APPROVED" })).json();
  assert.equal(run.imported, 2);

  // The photos appear inside the existing gallery; no extra gallery card anywhere.
  const page = await (await call(`${SITE}/api/gallery-api?project=furniture/cutting-boards`, { admin: false })).json();
  assert.equal(page.items.length, 3, "1 manual photo + 2 imported");
  const furniture = await (await call(`${SITE}/api/gallery-api?list=furniture`, { admin: false })).json();
  assert.equal(furniture.furniture.filter((p) => /cutting/i.test(p.name)).length, 1, "still one Cutting Boards gallery"); // category lists are keyed by category
  assert.deepEqual(await rows("SELECT category, linked_prefix FROM facebook_projects WHERE id = ?", pid), [{ category: "furniture", linked_prefix: prefix }]);
  assert.deepEqual(await keys(baseEnv.GALLERY_BUCKET).then((k) => k.filter((x) => x.startsWith("Furniture/Cutting Boards/"))), ["Furniture/Cutting Boards/Davis_Cutting_Board.jpg"], "manual files untouched");
  assert.equal((await rows("SELECT * FROM facebook_photos WHERE fb_photo_id = '9763'")).length, 0, "the Duplicate / Skip photo stays out");
  // The plan now offers the same gallery by its record, still once.
  const plan = await (await call(PLAN("760"), { env: reviewEnv() })).json();
  assert.deepEqual(plan.linked, { id: pid, name: "Cutting Boards", slug: first.project.slug, usable: true });
});

test("a mixed album can send approved photos to a manual gallery without linking the album", async () => {
  await manualSetup();
  const prefix = "Remodels/3D_Autobody/";
  const dry = await (await runImport({ albumId: "890", photoIds: ["9891"], linkedPrefix: prefix, mixedAlbum: true, dryRun: true })).json();
  assert.deepEqual([dry.new, dry.destination.name], [1, "3D Autobody"]);
  const pid = (await (await call(`${ADMIN}/project-create`, { method: "POST", body: { name: "3D Autobody", linkedPrefix: prefix } })).json()).project.id;
  const run = await (await runImport({ albumId: "890", photoIds: ["9891"], projectId: pid, mixedAlbum: true, dryRun: false, expectedCount: 1, confirm: "IMPORT APPROVED" })).json();
  assert.equal(run.imported, 1);
  assert.deepEqual(await rows("SELECT album_id FROM facebook_album_mappings WHERE album_id = '890'"), [], "Mobile uploads stays unmapped");
  assert.equal((await rows("SELECT category FROM facebook_projects WHERE id = ?", pid))[0].category, "remodels");
});

test("website gallery destinations are validated; the preview path can't be reached from a request body", async () => {
  await manualSetup();
  const before = await snapshotAll();
  for (const bad of ["Highlights/", "Apparel/Coats/", "Furniture/Nope/", "../Furniture/Epoxy/", "Furniture/Epoxy", 5, null]) {
    const r = await runImport({ albumId: "760", photoIds: ["9761"], linkedPrefix: bad, mixedAlbum: true, dryRun: true });
    assert.equal(r.status, 400, String(bad));
  }
  // An album already linked to a gallery can't be checked against another website gallery.
  assert.equal((await runImport({ albumId: GANZ, photoIds: [seven[0]], linkedPrefix: "Furniture/Epoxy/", dryRun: true })).status, 409);
  // The historical route ignores any previewProject in the body.
  const injected = await call(BACKFILL, { method: "POST", body: { targeted: true, dryRun: true, albumId: "760", photoIds: ["9761"], projectId: 999,
    previewProject: { id: null, name: "x", kind: "project", hidden: 0 } } });
  assert.equal(injected.status, 404);
  assert.deepEqual(await snapshotAll(), before);
});
