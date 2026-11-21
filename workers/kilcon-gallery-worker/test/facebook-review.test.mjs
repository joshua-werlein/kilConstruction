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
import { reviewGate } from "../src/facebook-review.js";
import { JPEG } from "./imageFixtures.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "../../..");
const APP_SECRET = "test-app-secret";
const PAGE_TOKEN = "EAAtestPageAccessTokenValue1234567890";
const PAGE_ID = "1111111111";
const ADMIN_SECRET = "test-admin-secret";
const SITE = "https://kilcon.work";
const ADMIN = `${SITE}/api/gallery-api/facebook/admin`;
const CUTOFF = "2026-11-15T00:00:00Z";
const OLD = "2025-06-01T12:00:00+0000";
const NEW = "2026-11-20T12:00:00+0000";

let proxy, baseEnv, graph, cdn, fetchCalls;
const realFetch = globalThis.fetch;
const realConsole = { log: console.log, warn: console.warn, error: console.error };

const makeEnv = (o = {}) => ({
  ...baseEnv,
  FB_APP_SECRET: APP_SECRET, FB_VERIFY_TOKEN: "vt", FB_PAGE_ACCESS_TOKEN: PAGE_TOKEN, FB_PAGE_ID: PAGE_ID,
  FB_GRAPH_VERSION: "v26.0", FB_INTEGRATION_ENABLED: "true", FB_AUTO_IMPORT: "true",
  FB_HISTORICAL_IMPORT_ENABLED: "true", FB_HISTORY_REVIEW_CUTOFF: CUTOFF,
  READ_LIMITER: { limit: async () => ({ success: true }) }, WRITE_LIMITER: { limit: async () => ({ success: true }) },
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

test("webhook edit of an old post does not import unreviewed historical photos", async () => {
  stubAlbum("600", "Old Job", ["9201", "9202"], { created: OLD });
  stubPost(`${PAGE_ID}_77`, ["9201", "9202"], OLD);
  assert.equal((await webhook([{ item: "status", verb: "edited", post_id: `${PAGE_ID}_77`, published: 1, from: { id: PAGE_ID } }])).status, 200);
  assert.equal((await rows("SELECT * FROM facebook_photos")).length, 0);
  assert.equal((await rows("SELECT * FROM facebook_projects")).length, 0, "no empty gallery created");
  assert.deepEqual(await keys(baseEnv.PRIVATE_BUCKET), []);

  await decide([{ photoId: "9202", decision: "import" }]);
  await webhook([{ item: "status", verb: "edited", post_id: `${PAGE_ID}_77`, published: 1, from: { id: PAGE_ID }, message: "edit 2" }]);
  assert.deepEqual((await rows("SELECT fb_photo_id FROM facebook_photos")).map((r) => r.fb_photo_id), ["9202"]);
});

test("new posts after the cutoff still import automatically; a skip decision still wins", async () => {
  stubAlbum("700", "New Job", ["9301", "9302"], { created: NEW });
  stubPost(`${PAGE_ID}_88`, ["9301", "9302"], NEW);
  await decide([{ photoId: "9302", decision: "skip" }]);
  await webhook([{ item: "status", verb: "add", post_id: `${PAGE_ID}_88`, published: 1, from: { id: PAGE_ID } }]);
  assert.deepEqual((await rows("SELECT fb_photo_id, status FROM facebook_photos")).map((r) => [r.fb_photo_id, r.status]), [["9301", "imported"]]);
});

test("gate rules, including a database without migration 017", async () => {
  const env = makeEnv();
  assert.equal(await reviewGate(env, "1", { mode: "historical", createdTime: NEW }), "review-unreviewed");
  assert.equal(await reviewGate(env, "1", { mode: "live", createdTime: NEW }), null);
  assert.equal(await reviewGate(env, "1", { mode: "live", createdTime: OLD }), "review-unreviewed");
  assert.equal(await reviewGate(env, "1", { mode: "live", createdTime: null }), null, "unknown date: importPhoto re-checks");
  assert.equal(await reviewGate(makeEnv({ FB_HISTORY_REVIEW_CUTOFF: "" }), "1", { mode: "live", createdTime: OLD }), null);
  await decide([{ photoId: "1", decision: "later" }]);
  assert.equal(await reviewGate(env, "1", { mode: "historical" }), "review-later");
  await decide([{ photoId: "1", decision: "skip" }]);
  assert.equal(await reviewGate(env, "1", { mode: "live", createdTime: NEW }), "review-skip");
  await decide([{ photoId: "1", decision: "import" }]);
  assert.equal(await reviewGate(env, "1", { mode: "historical" }), null);

  const noTable = { prepare(sql) {
    if (sql.includes("facebook_photo_reviews")) throw new Error("D1_ERROR: no such table: facebook_photo_reviews: SQLITE_ERROR");
    return baseEnv.DB.prepare(sql);
  } };
  assert.equal(await reviewGate(makeEnv({ DB: noTable }), "1", { mode: "historical" }), "review-unreviewed", "fails closed for history");
  assert.equal(await reviewGate(makeEnv({ DB: noTable }), "1", { mode: "live", createdTime: NEW }), null, "live imports unaffected");
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
  assert.equal(j.cutoff, CUTOFF);
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
