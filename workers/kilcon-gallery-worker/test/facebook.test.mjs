// Run: npm run test:gallery-worker   (from repo root)
// Uses wrangler's getPlatformProxy for real local D1 + R2 (Miniflare, in-memory).
// Graph API / CDN calls are stubbed; nothing leaves the machine.

import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { getPlatformProxy } from "wrangler";

import worker from "../src/index.js";
import { processPendingEvents, handleFacebookScheduled, redact } from "../src/facebook.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "../../..");

const APP_SECRET = "test-app-secret";
const VERIFY_TOKEN = "test-verify-token";
const PAGE_TOKEN = "EAAtestPageAccessTokenValue1234567890";
const PAGE_ID = "1111111111";
const ADMIN_SECRET = "test-admin-secret";
const SITE = "https://kilcon.work";
const BASE = `${SITE}/api/gallery-api/facebook`;

let proxy;
let baseEnv;
let fetchCalls;
let graphFixtures;
let imageFixtures;
let logs;
const realFetch = globalThis.fetch;
const realConsole = { log: console.log, warn: console.warn, error: console.error };

function makeEnv(overrides = {}) {
  return {
    ...baseEnv,
    FB_APP_SECRET: APP_SECRET,
    FB_VERIFY_TOKEN: VERIFY_TOKEN,
    FB_PAGE_ACCESS_TOKEN: PAGE_TOKEN,
    FB_PAGE_ID: PAGE_ID,
    FB_GRAPH_VERSION: "v26.0",
    FB_AUTO_IMPORT: "false",
    FB_INTEGRATION_ENABLED: "true",
    // Real limiters (3 writes/min) would throttle the suite; limits aren't under test.
    READ_LIMITER: { limit: async () => ({ success: true }) },
    WRITE_LIMITER: { limit: async () => ({ success: true }) },
    ADMIN_SECRET,
    SESSION_VERSION: "3",
    ...overrides,
  };
}
const autoEnv = () => makeEnv({ FB_AUTO_IMPORT: "true" });

function makeCtx() {
  const pending = [];
  return { pending, waitUntil: (p) => pending.push(p), passThroughOnException() {} };
}

async function sign(body, secret = APP_SECRET) {
  const key = await crypto.subtle.importKey(
    "raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]
  );
  const sig = new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(body)));
  return "sha256=" + [...sig].map((b) => b.toString(16).padStart(2, "0")).join("");
}

async function postWebhook(env, payload, { signature, ctx = makeCtx() } = {}) {
  const body = typeof payload === "string" ? payload : JSON.stringify(payload);
  const headers = { "Content-Type": "application/json" };
  const sig = signature === undefined ? await sign(body) : signature;
  if (sig !== null) headers["X-Hub-Signature-256"] = sig;
  const res = await worker.fetch(new Request(`${BASE}/webhook`, { method: "POST", headers, body }), env, ctx);
  await Promise.all(ctx.pending);
  return res;
}

function feedPayload(values, pageId = PAGE_ID) {
  return {
    object: "page",
    entry: [{ id: pageId, time: 1760000000, changes: values.map((value) => ({ field: "feed", value })) }],
  };
}

function photoAdd(photoId, extra = {}) {
  return {
    item: "photo", verb: "add", photo_id: photoId, post_id: `${PAGE_ID}_9${photoId}`,
    published: 1, from: { id: PAGE_ID, name: "KIL Construction" },
    link: `https://scontent.xx.fbcdn.net/${photoId}.jpg`, created_time: 1760000000, ...extra,
  };
}

function postAdd(postId, extra = {}) {
  return { item: "status", verb: "add", post_id: postId, published: 1, from: { id: PAGE_ID }, ...extra };
}

function graphPhoto(photoId, { fromId = PAGE_ID, source, album, name, created = "2026-10-01T12:00:00+0000" } = {}) {
  return {
    id: photoId, name: name === undefined ? `Caption ${photoId}` : name, created_time: created,
    link: `https://www.facebook.com/photo/?fbid=${photoId}`, from: { id: fromId },
    ...(album ? { album } : {}),
    images: [
      { width: 320, height: 240, source: `https://scontent.xx.fbcdn.net/small/${photoId}.jpg` },
      { width: 2048, height: 1536, source: source || `https://scontent.xx.fbcdn.net/big/${photoId}.jpg` },
    ],
  };
}

function stubPhoto(photoId, opts = {}) {
  const gp = graphPhoto(photoId, opts);
  graphFixtures.set(photoId, gp);
  imageFixtures.set(gp.images[1].source, { bytes: new TextEncoder().encode(`JPEG-${photoId}`) });
  return gp;
}

// A Page post with N photos; returns the Graph post object.
function stubPost(postId, photoIds, { message = "", album, created = "2026-10-01T12:00:00+0000", fromId = PAGE_ID } = {}) {
  for (const id of photoIds) stubPhoto(id, { album, name: "", created });
  const post = {
    id: postId, message, created_time: created, from: { id: fromId },
    permalink_url: `https://www.facebook.com/${postId}`,
    attachments: { data: [photoIds.length === 1
      ? { type: "photo", target: { id: photoIds[0] } }
      : { type: "album", subattachments: { data: photoIds.map((id) => ({ type: "photo", target: { id } })) } }] },
  };
  graphFixtures.set(postId, post);
  return post;
}

async function adminCookie() {
  const now = Math.floor(Date.now() / 1000);
  const payload = { iat: now, exp: now + 600, ver: "3" };
  const b64u = (bytes) => btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
  const payloadB64 = b64u(new TextEncoder().encode(JSON.stringify(payload)));
  const key = await crypto.subtle.importKey(
    "raw", new TextEncoder().encode(ADMIN_SECRET), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]
  );
  const sig = new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(payloadB64)));
  return `admin_auth=${payloadB64}.${b64u(sig)}`;
}

async function call(url, { method = "GET", body, admin = false, env = makeEnv(), headers = {} } = {}) {
  const h = { ...headers };
  if (admin) h.Cookie = await adminCookie();
  if (body !== undefined) h["Content-Type"] = "application/json";
  return worker.fetch(
    new Request(url.startsWith("http") ? url : `${SITE}${url}`, {
      method, headers: h, body: body === undefined ? undefined : JSON.stringify(body),
    }),
    env,
    makeCtx()
  );
}
const getJson = async (url, opts) => (await call(url, opts)).json();
const adminPost = async (sub, body, env = makeEnv()) =>
  (await call(`/api/gallery-api/facebook/admin/${sub}`, { method: "POST", body, admin: true, env })).json();

async function rows(sql, ...binds) {
  return (await baseEnv.DB.prepare(sql).bind(...binds).all()).results;
}

async function keys(bucket) {
  return (await bucket.list()).objects.map((o) => o.key).sort();
}

function allLogs() {
  return logs.map((args) => args.map((a) => (typeof a === "string" ? a : JSON.stringify(a))).join(" ")).join("\n");
}

async function putReview(id, status, { photo = true, bucket = "public", photoKey } = {}) {
  const key = photoKey || `Reviews/photos/${id}/photo.jpg`;
  if (photo) {
    const b = bucket === "public" ? baseEnv.GALLERY_BUCKET : baseEnv.PRIVATE_BUCKET;
    await b.put(key, `IMG-${id}`, { httpMetadata: { contentType: "image/jpeg" } });
  }
  const rec = {
    id, status, createdAt: new Date().toISOString(), rating: 5, text: "x".repeat(50),
    clientNameFull: "Pat Client", clientNamePublic: "Pat C.", projectType: "deck",
    photoKey: photo ? key : null,
    photoUrl: photo ? `https://images.kilcon.work/${key}` : null, featured: false,
  };
  await baseEnv.GALLERY_BUCKET.put(`Reviews/data/${id}.json`, JSON.stringify(rec));
  return rec;
}

before(async () => {
  proxy = await getPlatformProxy({
    configPath: path.join(repoRoot, "workers/kilcon-gallery-worker/wrangler.toml"),
    persist: false,
  });
  baseEnv = proxy.env;

  const sql = await readFile(path.join(repoRoot, "migrations/013_facebook_sync.sql"), "utf8");
  const statements = sql
    .split("\n").filter((l) => !l.trim().startsWith("--")).join("\n")
    .split(";").map((s) => s.trim()).filter(Boolean);
  await baseEnv.DB.batch(statements.map((s) => baseEnv.DB.prepare(s)));
});

after(async () => {
  globalThis.fetch = realFetch;
  Object.assign(console, realConsole);
  await proxy?.dispose();
});

beforeEach(async () => {
  fetchCalls = [];
  graphFixtures = new Map();
  imageFixtures = new Map();
  logs = [];
  for (const k of ["log", "warn", "error"]) {
    console[k] = (...args) => {
      logs.push(args);
      if (process.env.DEBUG_LOGS) realConsole[k](...args);
    };
  }

  globalThis.fetch = async (input, init = {}) => {
    const url = new URL(typeof input === "string" ? input : input.url);
    fetchCalls.push({ url, init });
    if (url.hostname === "graph.facebook.com") {
      const key = url.pathname.replace(/^\/v26\.0\//, "");
      const fx = graphFixtures.get(key);
      if (!fx) return Response.json({ error: { message: "not found", code: 100 } }, { status: 404 });
      if (fx.status) return Response.json(fx.body, { status: fx.status });
      return Response.json(typeof fx === "function" ? fx(url) : fx);
    }
    const img = imageFixtures.get(url.toString());
    if (img?.status) return new Response("err", { status: img.status });
    if (img) return new Response(img.bytes, { headers: { "Content-Type": img.type || "image/jpeg" } });
    return new Response("nope", { status: 404 });
  };

  await baseEnv.DB.batch(
    ["facebook_webhook_events", "facebook_photos", "facebook_posts", "facebook_projects", "facebook_sync_state"]
      .map((t) => baseEnv.DB.prepare(`DELETE FROM ${t}`))
  );
  for (const b of [baseEnv.GALLERY_BUCKET, baseEnv.PRIVATE_BUCKET]) {
    const k = await keys(b);
    if (k.length) await b.delete(k);
  }
});

const graphCalls = () => fetchCalls.filter((c) => c.url.hostname === "graph.facebook.com");

// =====================================================================
// Task 1 — review attachments are never public
// =====================================================================

test("SECURITY: ?project= cannot reach review storage by slug, category or traversal", async () => {
  await putReview("r_pending_1", "pending");
  await putReview("r_hidden_1", "hidden");
  await putReview("r_approved_1", "approved");
  for (const project of [
    "photos", "data", "reviews", "reviews/photos", "reviews/data", "projects/photos",
    "furniture/photos", "highlights/photos", "facebook", "Reviews/photos",
  ]) {
    const res = await call(`/api/gallery-api?project=${encodeURIComponent(project)}`);
    const body = await res.json();
    assert.equal(res.status, 404, project);
    assert.deepEqual(body.items, [], project);
  }
  for (const project of ["../Reviews/photos", "reviews/../photos", "photos%2F..", "a".repeat(300)]) {
    const res = await call(`/api/gallery-api?project=${encodeURIComponent(project)}`);
    assert.equal(res.status, 400, project);
  }
});

test("SECURITY: review storage is not discoverable through listing endpoints", async () => {
  await putReview("r_pending_2", "pending");
  await baseEnv.GALLERY_BUCKET.put("Projects/Ganz Re-Deck/1.jpg", "y");
  assert.equal((await call("/api/gallery-api?list=reviews")).status, 400);
  assert.equal((await call("/api/gallery-api?list=photos")).status, 400);
  assert.equal((await call("/api/gallery-api?all=1")).status, 401);
  for (const url of ["/api/gallery-api", "/api/gallery-api?list=projects", "/api/gallery-api?all=1"]) {
    const text = await (await call(url, { admin: true })).text();
    assert.ok(!text.includes("Reviews"), url);
  }
});

test("SECURITY: review photo endpoint serves approved photos only (admins see all)", async () => {
  await putReview("r_pend_3", "pending");
  await putReview("r_hide_3", "hidden");
  await putReview("r_appr_3", "approved");
  await putReview("r_priv_3", "approved", { bucket: "private" });
  await putReview("r_tamper_3", "approved", { photoKey: "Projects/Secret/x.jpg" });

  const photo = (id, admin = false) => call(`/api/reviews/photo?id=${encodeURIComponent(id)}`, { admin });

  for (const id of ["r_pend_3", "r_hide_3", "r_missing", "../r_appr_3", "r_tamper_3", ""]) {
    assert.equal((await photo(id)).status, 404, id);
  }
  const ok = await photo("r_appr_3");
  assert.equal(ok.status, 200);
  assert.equal(await ok.text(), "IMG-r_appr_3");
  assert.match(ok.headers.get("Cache-Control"), /public/);

  assert.equal(await (await photo("r_priv_3")).text(), "IMG-r_priv_3", "private-bucket photo served");

  const adminView = await photo("r_pend_3", true);
  assert.equal(adminView.status, 200, "admin can view pending photo");
  assert.match(adminView.headers.get("Cache-Control"), /no-store/);
  assert.equal((await photo("r_tamper_3", true)).status, 404, "key outside review prefix refused");
});

test("SECURITY: review JSON never exposes public-bucket photo URLs", async () => {
  await putReview("r_appr_4", "approved");
  await putReview("r_pend_4", "pending");
  const pub = await getJson("/api/reviews");
  assert.equal(pub.reviews.length, 1);
  assert.equal(pub.reviews[0].photoUrl, "https://kilcon.work/api/reviews/photo?id=r_appr_4");
  assert.ok(!JSON.stringify(pub).includes("images.kilcon.work"));

  const adm = await getJson("/api/reviews/admin/list", { admin: true });
  assert.equal(adm.reviews.length, 2);
  for (const r of adm.reviews) assert.match(r.photoUrl, /^https:\/\/kilcon\.work\/api\/reviews\/photo\?id=/);
  assert.equal((await call("/api/reviews/admin/list")).status, 401);
});

test("SECURITY: images.kilcon.work/Reviews/* is blocked by the worker route", async () => {
  await putReview("r_pend_5", "pending");
  for (const p of ["/Reviews/photos/r_pend_5/photo.jpg", "/Reviews/data/r_pend_5.json"]) {
    const res = await call(`https://images.kilcon.work${p}`);
    assert.equal(res.status, 404, p);
  }
});

// Minimal valid file headers for magic-byte checks
const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 16, 74, 70, 73, 70, 0, 1]);
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13]);
const SVG = new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>');

async function submitReview(file, { env = makeEnv(), accept } = {}) {
  const form = new FormData();
  form.set("name", "Pat Client");
  form.set("rating", "5");
  form.set("location", "Springfield");
  form.set("text", "Great work on our deck, the crew was on time and very professional.");
  if (file) form.set("photo", file);
  const headers = accept ? { Accept: accept } : {};
  return worker.fetch(new Request(`${SITE}/api/reviews/submit`, { method: "POST", body: form, headers }), env, makeCtx());
}

test("SECURITY: new review records and photos are stored only in the private bucket", async () => {
  const res = await submitReview(new File([JPEG], "deck.jpg", { type: "image/jpeg" }));
  assert.equal(res.status, 200);

  assert.ok(!(await keys(baseEnv.GALLERY_BUCKET)).some((k) => k.startsWith("Reviews/")), "nothing public");
  const priv = await keys(baseEnv.PRIVATE_BUCKET);
  assert.equal(priv.length, 2);
  const dataKey = priv.find((k) => k.startsWith("Reviews/data/"));
  assert.match(priv.find((k) => k.startsWith("Reviews/photos/")), /^Reviews\/photos\/r_.+\/deck\.jpg$/);

  const rec = JSON.parse(await (await baseEnv.PRIVATE_BUCKET.get(dataKey)).text());
  assert.equal(rec.status, "pending");
  assert.equal(rec.photoUrl, null);
  assert.equal((await call(`/api/reviews/photo?id=${rec.id}`)).status, 404, "pending → not public");
  assert.equal((await call(`/api/reviews/photo?id=${rec.id}`, { admin: true })).status, 200, "admin sees it");
  assert.equal((await getJson("/api/reviews/admin/list", { admin: true })).reviews.length, 1);
});

test("SECURITY: submissions fail closed when PRIVATE_BUCKET is not bound", async () => {
  const env = makeEnv({ PRIVATE_BUCKET: undefined });
  assert.equal((await submitReview(new File([JPEG], "deck.jpg", { type: "image/jpeg" }), { env })).status, 500);
  assert.equal((await submitReview(null, { env })).status, 500);
  assert.deepEqual(await keys(baseEnv.GALLERY_BUCKET), [], "never falls back to the public bucket");
});

test("SECURITY: disguised uploads (SVG/HTML as .jpg, wrong extension) are rejected", async () => {
  for (const file of [
    new File([SVG], "x.jpg", { type: "image/jpeg" }),
    new File([SVG], "x.png", { type: "image/svg+xml" }),
    new File([SVG], "x.svg", { type: "image/svg+xml" }),
    new File([PNG], "x.jpg", { type: "image/jpeg" }),
    new File([new TextEncoder().encode("<html>")], "x.webp", { type: "image/webp" }),
  ]) {
    const res = await submitReview(file);
    assert.equal(res.status, 400, file.name);
  }
  assert.deepEqual(await keys(baseEnv.PRIVATE_BUCKET), []);
  const ok = await submitReview(new File([PNG], "deck.png", { type: "application/octet-stream" }));
  assert.equal(ok.status, 200, "real PNG accepted regardless of client MIME");
  const photoKey = (await keys(baseEnv.PRIVATE_BUCKET)).find((k) => k.endsWith(".png"));
  assert.equal((await baseEnv.PRIVATE_BUCKET.head(photoKey)).httpMetadata.contentType, "image/png");
});

test("SECURITY: photo responses use extension-derived types and a sandbox CSP", async () => {
  // Legacy object stored with an attacker-chosen type
  await baseEnv.GALLERY_BUCKET.put("Reviews/photos/r_svg_1/p.png", SVG, { httpMetadata: { contentType: "image/svg+xml" } });
  await baseEnv.GALLERY_BUCKET.put("Reviews/data/r_svg_1.json", JSON.stringify({
    id: "r_svg_1", status: "approved", photoKey: "Reviews/photos/r_svg_1/p.png", createdAt: "2026-01-01", rating: 5,
  }));
  const res = await call("/api/reviews/photo?id=r_svg_1");
  assert.equal(res.status, 200);
  assert.equal(res.headers.get("Content-Type"), "image/png");
  assert.equal(res.headers.get("Content-Security-Policy"), "default-src 'none'; sandbox");
  assert.equal(res.headers.get("X-Content-Type-Options"), "nosniff");
  assert.match(res.headers.get("Content-Disposition"), /^inline/);
});

test("legacy public records still work and are re-saved privately on admin edits", async () => {
  // Very old record: photoUrl only, no photoKey
  await baseEnv.GALLERY_BUCKET.put("Reviews/photos/r_old_1/a.jpg", JPEG);
  await baseEnv.GALLERY_BUCKET.put("Reviews/data/r_old_1.json", JSON.stringify({
    id: "r_old_1", status: "pending", createdAt: "2025-01-01", rating: 4, text: "x".repeat(50),
    clientNameFull: "Lee Old", clientNamePublic: "Lee O.", photoUrl: "https://images.kilcon.work/Reviews/photos/r_old_1/a.jpg",
  }));
  assert.equal((await getJson("/api/reviews")).reviews.length, 0);

  const upd = await call("/api/reviews/admin/status", { method: "POST", admin: true, body: { id: "r_old_1", status: "approved" } });
  assert.equal(upd.status, 200);
  const priv = JSON.parse(await (await baseEnv.PRIVATE_BUCKET.get("Reviews/data/r_old_1.json")).text());
  assert.equal(priv.status, "approved");
  const pub = JSON.parse(await (await baseEnv.GALLERY_BUCKET.get("Reviews/data/r_old_1.json")).text());
  assert.equal(pub.status, "pending", "public legacy copy untouched (not deleted)");

  const list = await getJson("/api/reviews");
  assert.equal(list.reviews.length, 1, "private copy wins, no duplicate");
  assert.equal(list.reviews[0].photoUrl, "https://kilcon.work/api/reviews/photo?id=r_old_1");
  assert.ok(!JSON.stringify(list).includes("clientNameFull"));
  assert.equal((await call("/api/reviews/photo?id=r_old_1")).status, 200);

  await call("/api/reviews/admin/reply", { method: "POST", admin: true, body: { id: "r_old_1", replyText: "Thanks!" } });
  assert.equal((await getJson("/api/reviews")).reviews[0].adminReply, "Thanks!");
  for (const id of ["../x", "", "r_old_1/../../x"]) {
    assert.equal((await call("/api/reviews/admin/status", { method: "POST", admin: true, body: { id, status: "approved" } })).status, 400);
  }
});

test("SECURITY: review submit redirect only targets our own origins", async () => {
  const env = makeEnv();
  const mk = (referer) => {
    const form = new FormData();
    form.set("name", "x");
    return worker.fetch(new Request(`${SITE}/api/reviews/submit`, {
      method: "POST", body: form, headers: { Accept: "text/html", Referer: referer },
    }), env, makeCtx());
  };
  assert.match((await mk("https://evil.example/")).headers.get("Location"), /^https:\/\/kilcon\.work\/reviews/);
  assert.match((await mk("http://localhost:4321/reviews")).headers.get("Location"), /^http:\/\/localhost:4321\/reviews/);
});

test("SECURITY: inherited object keys can't be used as categories", async () => {
  for (const p of ["constructor/x", "__proto__/x", "tostring/x", "hasownproperty/x"]) {
    const status = (await call(`/api/gallery-api?project=${p}`)).status;
    assert.ok(status === 404 || status === 400, `${p} → ${status}`);
  }
});

test("migration: inventory → copy → verify → gated delete of public copies", async () => {
  await putReview("r_mig_1", "pending");
  await putReview("r_mig_2", "approved");
  await putReview("r_mig_3", "hidden", { photo: false });
  await baseEnv.GALLERY_BUCKET.put("Projects/Deck/1.jpg", "gallery"); // must never be touched
  const mig = (body, admin = true) => call("/api/reviews/admin/migrate", { method: "POST", body, admin });

  assert.equal((await mig({ action: "inventory" }, false)).status, 401);

  const inv = await (await mig({ action: "inventory" })).json();
  assert.deepEqual(inv.summary, { total: 5, data: 3, photos: 2, other: 0, alreadyPrivate: 0 });
  assert.deepEqual(await keys(baseEnv.PRIVATE_BUCKET), [], "inventory writes nothing");

  // Verify before copying → not verified; delete refused
  const early = await (await mig({ action: "verify" })).json();
  assert.equal(early.allVerified, false);
  assert.equal(early.summary["missing-private"], 5);
  const refused = await mig({ action: "delete-public", manifest: early.manifestKey, confirm: "DELETE PUBLIC REVIEW COPIES" });
  assert.equal(refused.status, 409);

  const copied = await (await mig({ action: "copy" })).json();
  assert.deepEqual(copied.summary, { copied: 5 });
  assert.ok(copied.manifestKey.startsWith("Migrations/reviews/"));
  assert.ok(await baseEnv.PRIVATE_BUCKET.head(copied.manifestKey), "manifest stored privately");
  const again = await (await mig({ action: "copy" })).json();
  assert.deepEqual(again.summary, { "already-private": 5 }, "idempotent, never overwrites");

  // An admin edit after copying makes the private record newer: still verified
  await call("/api/reviews/admin/status", { method: "POST", admin: true, body: { id: "r_mig_1", status: "approved" } });

  const ver = await (await mig({ action: "verify" })).json();
  assert.equal(ver.allVerified, true);
  assert.equal(ver.summary["verified-private-newer"], 1);
  const photoEntry = ver.entries.find((e) => e.key === "Reviews/photos/r_mig_2/photo.jpg");
  assert.equal(photoEntry.resolves, true);
  assert.equal(photoEntry.reviewStatus, "approved");

  // Gates on delete
  assert.equal((await mig({ action: "delete-public", manifest: ver.manifestKey })).status, 400, "needs confirm phrase");
  assert.equal((await mig({ action: "delete-public", manifest: copied.manifestKey, confirm: "DELETE PUBLIC REVIEW COPIES" })).status, 400, "needs verify manifest");

  // A public object that changed after verify is skipped, not deleted
  await baseEnv.GALLERY_BUCKET.put("Reviews/data/r_mig_3.json", JSON.stringify({ id: "r_mig_3", status: "hidden", changed: true }));
  const del = await (await mig({ action: "delete-public", manifest: ver.manifestKey, confirm: "DELETE PUBLIC REVIEW COPIES" })).json();
  assert.deepEqual(del.summary, { deleted: 4, "skipped-public-changed": 1 });
  assert.deepEqual((await keys(baseEnv.GALLERY_BUCKET)).sort(), ["Projects/Deck/1.jpg", "Reviews/data/r_mig_3.json"]);

  // Everything still resolves from the private bucket
  assert.equal((await call("/api/reviews/photo?id=r_mig_2")).status, 200, "approved photo still displays");
  assert.equal((await call("/api/reviews/photo?id=r_mig_1")).status, 200, "now approved (edited) displays");
  assert.equal((await getJson("/api/reviews/admin/list", { admin: true })).reviews.length, 3);
  assert.equal(await (await baseEnv.GALLERY_BUCKET.get("Projects/Deck/1.jpg")).text(), "gallery");
});

test("Facebook integration is fully inert when FB_INTEGRATION_ENABLED is not \"true\" (shipped default)", async () => {
  assert.equal(baseEnv.FB_INTEGRATION_ENABLED, "false", "wrangler.toml default");
  const env = makeEnv({ FB_INTEGRATION_ENABLED: baseEnv.FB_INTEGRATION_ENABLED, FB_AUTO_IMPORT: "true" });

  const verify = await worker.fetch(new Request(`${BASE}/webhook?hub.mode=subscribe&hub.verify_token=${VERIFY_TOKEN}&hub.challenge=1`), env, makeCtx());
  assert.equal(verify.status, 404);
  assert.equal((await postWebhook(env, feedPayload([photoAdd("9001")]))).status, 404);
  assert.equal((await call(`${BASE}/backfill`, { method: "POST", body: {}, admin: true, env })).status, 404);
  assert.equal((await call(`${BASE}/admin/overview`, { admin: true, env })).status, 404);
  assert.equal((await rows("SELECT * FROM facebook_webhook_events")).length, 0);

  // Public galleries never touch D1 when disabled (works with no DB binding at all)
  await baseEnv.GALLERY_BUCKET.put("Projects/Ganz Re-Deck/1.jpg", "y");
  const noDb = makeEnv({ FB_INTEGRATION_ENABLED: "false", DB: undefined });
  assert.equal((await call("/api/gallery-api?list=projects", { env: noDb })).status, 200);
  assert.equal((await call("/api/gallery-api?project=ganz-re-deck", { env: noDb })).status, 200);
  assert.equal((await call("/api/gallery-api?project=recent-project-updates", { env: noDb })).status, 404);

  let scheduled = 0;
  await worker.scheduled({}, env, { waitUntil: () => scheduled++ });
  assert.equal(scheduled, 0, "cron handler is a no-op");
  assert.equal(fetchCalls.length, 0);
});

test("public galleries still work (list, project, category, highlights)", async () => {
  await baseEnv.GALLERY_BUCKET.put("Projects/Ganz Re-Deck/1.jpg", "y");
  await baseEnv.GALLERY_BUCKET.put("Remodels/Smith Kitchen/1.jpg", "z");
  await baseEnv.GALLERY_BUCKET.put("Highlights/h1.jpg", "h");
  await putReview("r_appr_7", "approved");

  const list = await getJson("/api/gallery-api?list=projects");
  assert.deepEqual(list.projects.map((p) => p.slug), ["ganz-re-deck"]);
  assert.equal((await call("/api/gallery-api?project=ganz-re-deck")).status, 200);
  const rem = await getJson("/api/gallery-api?project=remodels/smith-kitchen");
  assert.equal(rem.items.length, 1);
  assert.deepEqual((await getJson("/api/gallery-api?list=remodels")).remodels.map((p) => p.slug), ["smith-kitchen"]);
  assert.equal((await getJson("/api/gallery-api?list=highlights")).items.length, 1);
  assert.equal((await call("/api/reviews/summary")).status, 200);
});

// =====================================================================
// Webhook verification + signature
// =====================================================================

test("GET verification echoes challenge for correct token", async () => {
  const url = `${BASE}/webhook?hub.mode=subscribe&hub.verify_token=${VERIFY_TOKEN}&hub.challenge=1158201444`;
  const res = await worker.fetch(new Request(url), makeEnv(), makeCtx());
  assert.equal(res.status, 200);
  assert.equal(await res.text(), "1158201444");
});

test("GET verification rejects wrong token, wrong mode, bad challenge; fails closed when unset", async () => {
  const env = makeEnv();
  for (const qs of [
    `hub.mode=subscribe&hub.verify_token=wrong&hub.challenge=123`,
    `hub.mode=unsubscribe&hub.verify_token=${VERIFY_TOKEN}&hub.challenge=123`,
    `hub.mode=subscribe&hub.verify_token=${VERIFY_TOKEN}&hub.challenge=<script>`,
    `hub.mode=subscribe&hub.challenge=123`,
  ]) {
    assert.equal((await worker.fetch(new Request(`${BASE}/webhook?${qs}`), env, makeCtx())).status, 403, qs);
  }
  const unset = await worker.fetch(new Request(`${BASE}/webhook?hub.mode=subscribe&hub.challenge=1`),
    makeEnv({ FB_VERIFY_TOKEN: undefined }), makeCtx());
  assert.equal(unset.status, 500);
});

test("invalid webhook signatures are rejected and nothing is stored", async () => {
  const env = autoEnv();
  const payload = feedPayload([photoAdd("2001")]);
  assert.equal((await postWebhook(env, payload, { signature: null })).status, 401);
  assert.equal((await postWebhook(env, payload, { signature: "sha1=abc" })).status, 401);
  assert.equal((await postWebhook(env, payload, { signature: await sign("other body") })).status, 401);
  assert.equal((await postWebhook(env, payload, { signature: await sign(JSON.stringify(payload), "bad") })).status, 401);
  assert.equal((await postWebhook(makeEnv({ FB_APP_SECRET: undefined }), payload)).status, 500);
  assert.equal((await rows("SELECT * FROM facebook_webhook_events")).length, 0);
  assert.equal(fetchCalls.length, 0);
});

test("POST rejects oversized bodies", async () => {
  const big = JSON.stringify({ object: "page", pad: "x".repeat(600 * 1024) });
  assert.equal((await postWebhook(makeEnv(), big)).status, 413);
});

test("non-page objects, non-feed fields, and other Pages are ignored", async () => {
  const env = makeEnv();
  assert.equal((await postWebhook(env, { object: "user", entry: [] })).status, 200);
  const nonFeed = { object: "page", entry: [{ id: PAGE_ID, changes: [{ field: "ratings", value: { verb: "add" } }] }] };
  assert.equal((await postWebhook(env, nonFeed)).status, 200);
  assert.equal((await postWebhook(env, feedPayload([photoAdd("2005")], "9999999999"))).status, 200);
  assert.equal((await rows("SELECT * FROM facebook_webhook_events")).length, 0);
});

// =====================================================================
// Auto import gate
// =====================================================================

test("automatic import is disabled by default (wrangler.toml) and records only", async () => {
  assert.equal(baseEnv.FB_AUTO_IMPORT, "false", "shipped default");
  stubPost("1111111111_100", ["2006"], { message: "x" });
  const ctx = makeCtx();
  const res = await postWebhook(makeEnv({ FB_AUTO_IMPORT: baseEnv.FB_AUTO_IMPORT }), feedPayload([postAdd("1111111111_100")]), { ctx });
  assert.equal(res.status, 200);
  assert.equal(ctx.pending.length, 0);
  assert.equal(await handleFacebookScheduled(makeEnv()), null);
  assert.equal(fetchCalls.length, 0);
  assert.deepEqual(await keys(baseEnv.GALLERY_BUCKET), []);
  assert.deepEqual(await keys(baseEnv.PRIVATE_BUCKET), []);
  assert.equal((await rows("SELECT status FROM facebook_webhook_events"))[0].status, "pending");
});

// =====================================================================
// Task 2 — automatic publishing + grouping
// =====================================================================

test("signed event imports in waitUntil: master private, public copy, visible gallery", async () => {
  stubPost(`${PAGE_ID}_200`, ["3001", "3002", "3003"], {
    message: "Johnson backyard deck",
    album: { id: "555", name: "Johnson Backyard Deck" },
  });
  const ctx = makeCtx();
  const res = await postWebhook(autoEnv(), feedPayload([postAdd(`${PAGE_ID}_200`)]), { ctx });
  assert.equal(res.status, 200);
  assert.equal(ctx.pending.length, 1, "processing deferred to waitUntil");

  assert.deepEqual(await keys(baseEnv.PRIVATE_BUCKET), ["Facebook/3001.jpg", "Facebook/3002.jpg", "Facebook/3003.jpg"]);
  assert.deepEqual(await keys(baseEnv.GALLERY_BUCKET), ["Facebook/3001.jpg", "Facebook/3002.jpg", "Facebook/3003.jpg"]);
  const pubObj = await baseEnv.GALLERY_BUCKET.get("Facebook/3001.jpg");
  assert.equal(await pubObj.text(), "JPEG-3001", "largest image stored");
  assert.equal(pubObj.customMetadata.source, "facebook");

  const list = await getJson("/api/gallery-api?list=projects");
  const card = list.projects.find((p) => p.slug === "johnson-backyard-deck");
  assert.ok(card, "project card listed");
  assert.equal(card.name, "Johnson Backyard Deck");
  assert.equal(card.previews.length, 3);
  assert.match(card.images.thumb, /\/cdn-cgi\/image\/.+\/Facebook\/\d+\.jpg$/);

  const page = await getJson("/api/gallery-api?project=johnson-backyard-deck");
  assert.equal(page.project.name, "Johnson Backyard Deck");
  assert.equal(page.items.length, 3);
  assert.equal(page.items[0].description, "Johnson backyard deck");
  assert.match(page.items[0].name, /^2026-10-01_\d+\.jpg$/);

  const [post] = await rows("SELECT * FROM facebook_posts");
  assert.equal(post.fb_post_id, `${PAGE_ID}_200`);
  assert.equal(post.grouping_reason, "album");
  assert.equal(post.permalink, `https://www.facebook.com/${PAGE_ID}_200`);
  assert.equal(post.created_time, "2026-10-01T12:00:00.000Z");
  const photos = await rows("SELECT * FROM facebook_photos ORDER BY fb_photo_id");
  assert.ok(photos.every((p) => p.fb_post_id === `${PAGE_ID}_200` && p.album_id === "555" && p.status === "imported"));
  assert.equal((await rows("SELECT status FROM facebook_webhook_events"))[0].status, "done");

  // Token goes in the Authorization header with appsecret_proof, never in the URL
  for (const c of graphCalls()) {
    assert.equal(c.init.headers.Authorization, `Bearer ${PAGE_TOKEN}`);
    assert.ok(!c.url.toString().includes(PAGE_TOKEN));
    assert.match(c.url.searchParams.get("appsecret_proof"), /^[0-9a-f]{64}$/);
  }
});

test("new photos from a known project (same album) update the existing gallery", async () => {
  const album = { id: "556", name: "Miller Garage Build" };
  stubPost(`${PAGE_ID}_210`, ["3101"], { message: "Framing is up", album, created: "2026-09-01T12:00:00+0000" });
  await postWebhook(autoEnv(), feedPayload([postAdd(`${PAGE_ID}_210`)]));
  stubPost(`${PAGE_ID}_211`, ["3102", "3103"], { message: "Siding done!", album, created: "2026-10-05T12:00:00+0000" });
  await postWebhook(autoEnv(), feedPayload([postAdd(`${PAGE_ID}_211`)]));

  const projects = await rows("SELECT * FROM facebook_projects");
  assert.equal(projects.length, 1);
  const page = await getJson("/api/gallery-api?project=miller-garage-build");
  assert.deepEqual(page.items.map((i) => i.id), ["3101", "3102", "3103"], "chronological");
});

test("caption naming an existing manual gallery merges photos into it", async () => {
  await baseEnv.GALLERY_BUCKET.put("Projects/Ganz Re-Deck/1.jpg", "manual");
  stubPost(`${PAGE_ID}_220`, ["3201"], { message: "More progress on the Ganz Re-Deck today" });
  await postWebhook(autoEnv(), feedPayload([postAdd(`${PAGE_ID}_220`)]));

  const page = await getJson("/api/gallery-api?project=ganz-re-deck");
  assert.deepEqual(page.items.map((i) => i.source || "r2").sort(), ["facebook", "r2"]);
  assert.equal(await (await baseEnv.GALLERY_BUCKET.get("Projects/Ganz Re-Deck/1.jpg")).text(), "manual");
  const list = await getJson("/api/gallery-api?list=projects");
  assert.deepEqual(list.projects.map((p) => p.slug), ["ganz-re-deck"], "no duplicate card");
  assert.equal((await rows("SELECT grouping_reason FROM facebook_posts"))[0].grouping_reason, "caption");
});

test("single-word or generic names never auto-match captions", async () => {
  await baseEnv.GALLERY_BUCKET.put("Furniture/Cabinets/1.jpg", "m");
  await baseEnv.GALLERY_BUCKET.put("Remodels/Kitchen Remodel/1.jpg", "m");
  stubPost(`${PAGE_ID}_225`, ["3251"], { message: "New cabinets going into this kitchen remodel" });
  await postWebhook(autoEnv(), feedPayload([postAdd(`${PAGE_ID}_225`)]));
  assert.equal((await rows("SELECT grouping_reason FROM facebook_posts"))[0].grouping_reason, "ambiguous");
});

test("ambiguous posts appear in Recent Project Updates", async () => {
  stubPost(`${PAGE_ID}_230`, ["3301"], { message: "Busy week on site!" });
  stubPost(`${PAGE_ID}_231`, ["3302", "3303"], { message: "" });
  await postWebhook(autoEnv(), feedPayload([postAdd(`${PAGE_ID}_230`), postAdd(`${PAGE_ID}_231`)]));

  const projects = await rows("SELECT slug, kind FROM facebook_projects");
  assert.deepEqual(projects, [{ slug: "recent-project-updates", kind: "recent" }]);
  const list = await getJson("/api/gallery-api?list=projects");
  const recent = list.projects.find((p) => p.slug === "recent-project-updates");
  assert.equal(recent.name, "Recent Project Updates");
  const page = await getJson("/api/gallery-api?project=recent-project-updates");
  assert.equal(page.items.length, 3);
  assert.ok(page.items.some((i) => /^Posted October 1, 2026$/.test(i.description)), "fallback caption");
});

test("a completed-build post with several photos creates a new project", async () => {
  stubPost(`${PAGE_ID}_240`, ["3401", "3402", "3403"], {
    message: "Finished up the Henderson sunroom addition! #kilconstruction\nThanks to the whole crew.",
  });
  await postWebhook(autoEnv(), feedPayload([postAdd(`${PAGE_ID}_240`)]));
  const [project] = await rows("SELECT * FROM facebook_projects");
  assert.equal(project.name, "Finished up the Henderson sunroom addition");
  assert.equal(project.grouping_reason, "completed-build");
  assert.equal((await getJson(`/api/gallery-api?project=${project.slug}`)).items.length, 3);
});

test("project slugs never collide with existing manual galleries", async () => {
  await baseEnv.GALLERY_BUCKET.put("Projects/Lake House/1.jpg", "manual");
  stubPost(`${PAGE_ID}_245`, ["3451"], { message: "x", album: { id: "777", name: "Lake House" } });
  await postWebhook(autoEnv(), feedPayload([postAdd(`${PAGE_ID}_245`)]));
  const [project] = await rows("SELECT slug FROM facebook_projects");
  assert.equal(project.slug, "lake-house-2");
  assert.equal((await getJson("/api/gallery-api?project=lake-house")).items.length, 1, "manual one untouched");
});

test("duplicate deliveries and overlapping workers never duplicate content", async () => {
  stubPost(`${PAGE_ID}_250`, ["3501", "3502"], { message: "Deck stain day", album: { id: "888", name: "Ortiz Deck" } });
  const env = makeEnv(); // record only, then process concurrently
  const payload = feedPayload([postAdd(`${PAGE_ID}_250`), photoAdd("3501", { post_id: `${PAGE_ID}_250` })]);
  await postWebhook(env, payload);
  await postWebhook(env, payload);
  const reordered = feedPayload([Object.fromEntries(Object.entries(postAdd(`${PAGE_ID}_250`)).reverse())]);
  reordered.entry[0].time = 1769999999;
  await postWebhook(env, reordered);
  assert.equal((await rows("SELECT * FROM facebook_webhook_events")).length, 2, "redeliveries deduped");

  await Promise.all([processPendingEvents(autoEnv()), processPendingEvents(autoEnv()), handleFacebookScheduled(autoEnv())]);
  await processPendingEvents(autoEnv());

  assert.equal((await rows("SELECT * FROM facebook_photos")).length, 2);
  assert.equal((await rows("SELECT * FROM facebook_projects")).length, 1);
  assert.equal((await rows("SELECT * FROM facebook_posts")).length, 1);
  assert.deepEqual(await keys(baseEnv.GALLERY_BUCKET), ["Facebook/3501.jpg", "Facebook/3502.jpg"]);
  const imageDownloads = fetchCalls.filter((c) => c.url.hostname.endsWith("fbcdn.net"));
  assert.equal(imageDownloads.length, 2, "each image downloaded once");
  const page = await getJson("/api/gallery-api?project=ortiz-deck");
  assert.equal(page.items.length, 2);
});

test("an already-imported photo event makes no Graph calls", async () => {
  stubPost(`${PAGE_ID}_255`, ["3551"], { message: "x" });
  await postWebhook(autoEnv(), feedPayload([photoAdd("3551", { post_id: `${PAGE_ID}_255` })]));
  const before = fetchCalls.length;
  await postWebhook(autoEnv(), feedPayload([photoAdd("3551", { post_id: `${PAGE_ID}_255`, message: "edit" })]));
  assert.equal(fetchCalls.length, before);
});

test("an existing public object is never overwritten", async () => {
  await baseEnv.GALLERY_BUCKET.put("Facebook/3601.jpg", "ORIGINAL", { customMetadata: { source: "facebook" } });
  stubPost(`${PAGE_ID}_260`, ["3601"], { message: "x" });
  await postWebhook(autoEnv(), feedPayload([postAdd(`${PAGE_ID}_260`)]));
  assert.equal(await (await baseEnv.GALLERY_BUCKET.get("Facebook/3601.jpg")).text(), "ORIGINAL");
});

test("Facebook remove/hide events never remove photos from the website", async () => {
  await baseEnv.GALLERY_BUCKET.put("Projects/Deck/a.jpg", "KEEP");
  stubPost(`${PAGE_ID}_270`, ["3701"], { message: "x" });
  await postWebhook(autoEnv(), feedPayload([postAdd(`${PAGE_ID}_270`)]));
  await postWebhook(autoEnv(), feedPayload([
    { item: "status", verb: "remove", post_id: `${PAGE_ID}_270`, from: { id: PAGE_ID } },
    photoAdd("3701", { verb: "remove", post_id: `${PAGE_ID}_270` }),
    photoAdd("3701", { verb: "hide", post_id: `${PAGE_ID}_270` }),
  ]));
  assert.equal(await (await baseEnv.GALLERY_BUCKET.get("Projects/Deck/a.jpg")).text(), "KEEP");
  assert.ok(await baseEnv.GALLERY_BUCKET.head("Facebook/3701.jpg"));
  assert.equal((await getJson("/api/gallery-api?project=recent-project-updates")).items.length, 1);
  const [photo] = await rows("SELECT * FROM facebook_photos");
  assert.ok(photo.removed_on_facebook_at);
  assert.ok((await rows("SELECT removed_on_facebook_at FROM facebook_posts"))[0].removed_on_facebook_at);
});

test("visitor posts and unpublished posts are ignored", async () => {
  stubPost(`${PAGE_ID}_280`, ["3801"], { message: "x", fromId: "5555555555" });
  await postWebhook(autoEnv(), feedPayload([
    postAdd(`${PAGE_ID}_280`, { from: { id: "5555555555" } }),
    postAdd(`${PAGE_ID}_281`, { published: 0 }),
  ]));
  assert.equal(fetchCalls.length, 0);
  // Visitor post whose payload omits `from`: rejected after the Graph lookup
  await postWebhook(autoEnv(), feedPayload([{ item: "status", verb: "add", post_id: `${PAGE_ID}_280` }]));
  assert.deepEqual(await keys(baseEnv.GALLERY_BUCKET), []);
});

test("SSRF: non-Facebook image hosts are refused and the event retries", async () => {
  stubPhoto("3901", { source: "https://evil.example.com/x.jpg" });
  graphFixtures.set(`${PAGE_ID}_290`, { id: `${PAGE_ID}_290`, from: { id: PAGE_ID }, message: "x",
    attachments: { data: [{ type: "photo", target: { id: "3901" } }] } });
  await postWebhook(autoEnv(), feedPayload([postAdd(`${PAGE_ID}_290`)]));
  assert.ok(!fetchCalls.some((c) => c.url.hostname === "evil.example.com"));
  const [ev] = await rows("SELECT status, attempts, last_error FROM facebook_webhook_events");
  assert.equal(ev.status, "retry");
  assert.match(ev.last_error, /not a Facebook CDN URL/);
});

test("failed downloads are retried and succeed once the source recovers", async () => {
  const post = stubPost(`${PAGE_ID}_300`, ["4001"], { message: "x" });
  imageFixtures.set(graphPhoto("4001").images[1].source, { status: 500 });
  await postWebhook(autoEnv(), feedPayload([postAdd(`${PAGE_ID}_300`)]));
  assert.equal((await rows("SELECT status FROM facebook_photos"))[0].status, "failed");
  assert.equal((await rows("SELECT status FROM facebook_webhook_events"))[0].status, "retry");
  assert.deepEqual(await keys(baseEnv.GALLERY_BUCKET), []);

  imageFixtures.set(graphPhoto("4001").images[1].source, { bytes: new TextEncoder().encode("OK") });
  await processPendingEvents(autoEnv());
  assert.equal((await rows("SELECT status FROM facebook_photos"))[0].status, "imported");
  assert.deepEqual(await keys(baseEnv.GALLERY_BUCKET), ["Facebook/4001.jpg"]);
  assert.ok(post);
});

test("events give up after 5 attempts and the admin retry re-queues them", async () => {
  await postWebhook(autoEnv(), feedPayload([photoAdd("4101")])); // no Graph fixtures → 404
  for (let i = 0; i < 6; i++) await processPendingEvents(autoEnv());
  let [ev] = await rows("SELECT status, attempts FROM facebook_webhook_events");
  assert.equal(ev.status, "failed");
  assert.equal(ev.attempts, 5);

  const overview = await getJson("/api/gallery-api/facebook/admin/overview", { admin: true });
  assert.equal(overview.sync.events.failed, 1);
  assert.ok(overview.sync.recentFailures.some((f) => f.kind === "event"));

  stubPhoto("4101");
  const retried = await adminPost("retry", {}, autoEnv());
  assert.equal(retried.requeuedEvents, 1);
  await processPendingEvents(autoEnv());
  [ev] = await rows("SELECT status FROM facebook_webhook_events");
  assert.equal(ev.status, "done");
  assert.deepEqual(await keys(baseEnv.GALLERY_BUCKET), ["Facebook/4101.jpg"]);
});

test("admin retry re-imports a failed photo directly", async () => {
  stubPost(`${PAGE_ID}_310`, ["4201"], { message: "x" });
  imageFixtures.set(graphPhoto("4201").images[1].source, { status: 503 });
  await postWebhook(autoEnv(), feedPayload([postAdd(`${PAGE_ID}_310`)]));
  imageFixtures.set(graphPhoto("4201").images[1].source, { bytes: new TextEncoder().encode("OK") });
  const r = await adminPost("retry", {}, autoEnv());
  assert.equal(r.requeuedPhotos, 1);
  assert.equal((await rows("SELECT status FROM facebook_photos"))[0].status, "imported");
  assert.ok(await baseEnv.GALLERY_BUCKET.head("Facebook/4201.jpg"));
});

test("access tokens never appear in logs, D1 errors, or responses", async () => {
  graphFixtures.set("4301", { status: 400, body: { error: {
    message: `Invalid OAuth access_token=${PAGE_TOKEN} for EAAotherLeakedToken123456`, code: 190 } } });
  await postWebhook(autoEnv(), feedPayload([photoAdd("4301")]));
  const [ev] = await rows("SELECT last_error FROM facebook_webhook_events");
  assert.ok(!ev.last_error.includes(PAGE_TOKEN));
  assert.ok(!ev.last_error.includes("EAAotherLeakedToken"));
  const overview = JSON.stringify(await getJson("/api/gallery-api/facebook/admin/overview", { admin: true }));
  assert.ok(!overview.includes(PAGE_TOKEN));
  assert.ok(!allLogs().includes(PAGE_TOKEN));
  assert.ok(!allLogs().includes(APP_SECRET));
  assert.equal(redact(`x ${PAGE_TOKEN} y`, makeEnv()), "x [redacted] y");
});

// =====================================================================
// Task 3 — admin controls take precedence over sync
// =====================================================================

async function seedAlbumProject() {
  stubPost(`${PAGE_ID}_400`, ["5001", "5002"], { message: "x", album: { id: "999", name: "Baker Porch" } });
  await postWebhook(autoEnv(), feedPayload([postAdd(`${PAGE_ID}_400`)]));
  return (await rows("SELECT id FROM facebook_projects WHERE slug = 'baker-porch'"))[0].id;
}

test("admin endpoints require the admin cookie", async () => {
  for (const [method, sub] of [["GET", "overview"], ["GET", "photos?projectId=1"], ["GET", "photo-file?id=1"],
    ["POST", "project-update"], ["POST", "photo-update"], ["POST", "project-create"], ["POST", "retry"]]) {
    const res = await call(`/api/gallery-api/facebook/admin/${sub}`, { method, body: method === "POST" ? {} : undefined });
    assert.equal(res.status, 401, sub);
  }
  assert.equal((await call(`${BASE}/backfill`, { method: "POST", body: {} })).status, 401);
  assert.equal(fetchCalls.length, 0);
});

test("hidden photos are removed from public storage and stay hidden after resync", async () => {
  const projectId = await seedAlbumProject();
  const r = await adminPost("photo-update", { photoIds: ["5001"], hidden: true });
  assert.equal(r.updated, 1);

  assert.equal(await baseEnv.GALLERY_BUCKET.head("Facebook/5001.jpg"), null, "public copy removed");
  assert.ok(await baseEnv.PRIVATE_BUCKET.head("Facebook/5001.jpg"), "master kept");
  assert.deepEqual((await getJson("/api/gallery-api?project=baker-porch")).items.map((i) => i.id), ["5002"]);

  // Resync paths: webhook redelivery with different payload, edit event, backfill
  await postWebhook(autoEnv(), feedPayload([postAdd(`${PAGE_ID}_400`, { verb: "edited", message: "edit" })]));
  graphFixtures.set(`${PAGE_ID}/posts`, { data: [graphFixtures.get(`${PAGE_ID}_400`)], paging: {} });
  await call(`${BASE}/backfill`, { method: "POST", body: { dryRun: false }, admin: true });

  assert.equal(await baseEnv.GALLERY_BUCKET.head("Facebook/5001.jpg"), null);
  assert.equal((await rows("SELECT hidden FROM facebook_photos WHERE fb_photo_id = '5001'"))[0].hidden, 1);
  assert.deepEqual((await getJson("/api/gallery-api?project=baker-porch")).items.map((i) => i.id), ["5002"]);

  const hiddenList = await getJson("/api/gallery-api/facebook/admin/photos?hidden=1", { admin: true });
  assert.deepEqual(hiddenList.photos.map((p) => p.photoId), ["5001"]);
  const file = await call(hiddenList.photos[0].previewUrl, { admin: true });
  assert.equal(file.status, 200, "admin preview of hidden photo");
  assert.equal((await call(hiddenList.photos[0].previewUrl)).status, 401);

  await adminPost("photo-update", { photoIds: ["5001"], hidden: false });
  assert.ok(await baseEnv.GALLERY_BUCKET.head("Facebook/5001.jpg"), "restored");
  assert.equal((await getJson("/api/gallery-api?project=baker-porch")).items.length, 2);
  assert.ok(projectId);
});

test("hiding a project removes it everywhere; new photos stay hidden; restore brings it back", async () => {
  const projectId = await seedAlbumProject();
  await adminPost("project-update", { projectId, hidden: true });
  assert.equal((await call("/api/gallery-api?project=baker-porch")).status, 404);
  assert.ok(!(await getJson("/api/gallery-api?list=projects")).projects.some((p) => p.slug === "baker-porch"));
  assert.deepEqual(await keys(baseEnv.GALLERY_BUCKET), []);

  // A later post into the same album must not resurface the hidden project
  stubPost(`${PAGE_ID}_401`, ["5003"], { message: "x", album: { id: "999", name: "Baker Porch" } });
  await postWebhook(autoEnv(), feedPayload([postAdd(`${PAGE_ID}_401`)]));
  assert.deepEqual(await keys(baseEnv.GALLERY_BUCKET), []);
  assert.equal((await rows("SELECT project_id FROM facebook_photos WHERE fb_photo_id='5003'"))[0].project_id, projectId);

  await adminPost("project-update", { projectId, hidden: false });
  assert.equal((await getJson("/api/gallery-api?project=baker-porch")).items.length, 3);
});

test("rename keeps the URL; move between projects sticks across resync", async () => {
  const projectId = await seedAlbumProject();
  const renamed = await adminPost("project-update", { projectId, name: "Baker Family Porch" });
  assert.equal(renamed.project.slug, "baker-porch");
  assert.equal(renamed.project.nameLocked, true);
  assert.equal((await getJson("/api/gallery-api?project=baker-porch")).project.name, "Baker Family Porch");

  const created = await adminPost("project-create", { name: "Porch Details" });
  assert.equal(created.project.slug, "porch-details");
  await adminPost("photo-update", { photoIds: ["5002"], projectId: created.project.id });
  assert.deepEqual((await getJson("/api/gallery-api?project=porch-details")).items.map((i) => i.id), ["5002"]);

  // Resync: same post edited + a new photo in the album
  stubPost(`${PAGE_ID}_402`, ["5004"], { message: "x", album: { id: "999", name: "Baker Porch" } });
  await postWebhook(autoEnv(), feedPayload([postAdd(`${PAGE_ID}_400`, { verb: "edited" }), postAdd(`${PAGE_ID}_402`)]));
  assert.deepEqual((await getJson("/api/gallery-api?project=porch-details")).items.map((i) => i.id), ["5002"]);
  assert.deepEqual((await getJson("/api/gallery-api?project=baker-porch")).items.map((i) => i.id).sort(), ["5001", "5004"]);
  assert.equal((await rows("SELECT name FROM facebook_projects WHERE id = ?", projectId))[0].name, "Baker Family Porch");
});

test("photos can be moved into an existing manual gallery", async () => {
  await baseEnv.GALLERY_BUCKET.put("Remodels/Smith Kitchen/1.jpg", "manual");
  await seedAlbumProject();
  const ov = await getJson("/api/gallery-api/facebook/admin/overview", { admin: true });
  assert.deepEqual(ov.manualProjects.map((m) => m.prefix), ["Remodels/Smith Kitchen/"]);
  const link = await adminPost("project-create", { name: "Smith Kitchen", linkedPrefix: "Remodels/Smith Kitchen/" });
  assert.equal(link.project.linkedPrefix, "Remodels/Smith Kitchen/");
  assert.equal((await adminPost("project-create", { name: "x", linkedPrefix: "Reviews/photos/" })).error, "Unknown gallery");

  await adminPost("photo-update", { photoIds: ["5001"], projectId: link.project.id });
  const page = await getJson("/api/gallery-api?project=remodels/smith-kitchen");
  assert.equal(page.items.length, 2);
  assert.ok(!(await getJson("/api/gallery-api?list=projects")).projects.some((p) => p.slug === link.project.slug));
});

test("admin overview reports sync status, Facebook-imported projects and photos", async () => {
  const projectId = await seedAlbumProject();
  const ov = await getJson("/api/gallery-api/facebook/admin/overview", { admin: true });
  assert.equal(ov.autoImport, false);
  assert.ok(ov.sync.lastEventReceivedAt);
  assert.ok(ov.sync.lastSuccessAt);
  assert.equal(ov.sync.events.done, 1);
  assert.equal(ov.sync.photos.imported, 2);
  const p = ov.projects.find((x) => x.id === projectId);
  assert.equal(p.publicPath, "/projects/baker-porch");
  assert.equal(p.visibleCount, 2);

  const photos = await getJson(`/api/gallery-api/facebook/admin/photos?projectId=${projectId}`, { admin: true });
  assert.equal(photos.photos.length, 2);
  assert.ok(photos.photos.every((x) => x.permalink && x.previewUrl.startsWith("/api/gallery-api/facebook/admin/photo-file?id=")));
});

// =====================================================================
// Historical backfill
// =====================================================================

test("backfill dry run plans grouping and writes nothing", async () => {
  const a = stubPost(`${PAGE_ID}_500`, ["6001", "6002"], { message: "x", album: { id: "321", name: "Reed Deck" } });
  const b = stubPost(`${PAGE_ID}_501`, ["6003"], { message: "Quick update" });
  graphFixtures.set(`${PAGE_ID}/posts`, {
    data: [a, b, { id: `${PAGE_ID}_502`, message: "text only", from: { id: PAGE_ID } }],
    paging: { cursors: { after: "QVFIUnext" }, next: "https://graph.facebook.com/next" },
  });
  const dry = await getJson(`${BASE}/backfill`, { method: "POST", body: {}, admin: true });
  assert.equal(dry.dryRun, true);
  assert.equal(dry.posts.length, 2);
  assert.deepEqual(dry.posts.map((p) => p.project.action), ["create", "recent"]);
  assert.equal(dry.posts[0].project.name, "Reed Deck");
  assert.equal(dry.next, "QVFIUnext");
  for (const t of ["facebook_photos", "facebook_projects", "facebook_posts", "facebook_sync_state"]) {
    assert.equal((await rows(`SELECT * FROM ${t}`)).length, 0, t);
  }
  assert.deepEqual(await keys(baseEnv.GALLERY_BUCKET), []);
  assert.ok(!fetchCalls.some((c) => c.url.hostname.endsWith("fbcdn.net")), "no downloads");
});

test("backfill publishes history, preserves existing projects, and resumes", async () => {
  // Pre-existing: manual gallery + an admin-renamed Facebook project
  await baseEnv.GALLERY_BUCKET.put("Projects/Ganz Re-Deck/1.jpg", "manual");
  const projectId = await seedAlbumProject();
  await adminPost("project-update", { projectId, name: "Baker Porch (2025)" });

  const p1 = stubPost(`${PAGE_ID}_510`, ["6101"], { message: "Ganz Re-Deck before shots", created: "2025-05-01T12:00:00+0000" });
  const p2 = stubPost(`${PAGE_ID}_511`, ["6102"], { message: "x", album: { id: "999", name: "Baker Porch" }, created: "2025-04-01T12:00:00+0000" });
  const p3 = stubPost(`${PAGE_ID}_512`, ["6103"], { message: "Old job", created: "2024-01-01T12:00:00+0000" });
  graphFixtures.set(`${PAGE_ID}/posts`, (url) => url.searchParams.get("after") === "CUR2"
    ? { data: [p3], paging: {} }
    : { data: [p1, p2], paging: { cursors: { after: "CUR2" }, next: "https://graph.facebook.com/next" } });

  const first = await getJson(`${BASE}/backfill`, { method: "POST", body: { dryRun: false }, admin: true });
  assert.equal(first.imported, 2);
  assert.equal(first.next, "CUR2");
  assert.equal((await rows("SELECT value FROM facebook_sync_state WHERE key='backfill_cursor'"))[0].value, "CUR2");

  const second = await getJson(`${BASE}/backfill`, { method: "POST", body: { dryRun: false, resume: true }, admin: true });
  assert.equal(second.imported, 1);
  assert.equal(second.next, null);

  const again = await getJson(`${BASE}/backfill`, { method: "POST", body: { dryRun: false }, admin: true });
  assert.equal(again.imported, 0, "idempotent");

  assert.equal(await (await baseEnv.GALLERY_BUCKET.get("Projects/Ganz Re-Deck/1.jpg")).text(), "manual");
  assert.equal((await rows("SELECT name FROM facebook_projects WHERE id = ?", projectId))[0].name, "Baker Porch (2025)");
  assert.equal((await getJson("/api/gallery-api?project=ganz-re-deck")).items.length, 2);
  assert.equal((await getJson("/api/gallery-api?project=baker-porch")).items.length, 3);
  const [old] = await rows("SELECT * FROM facebook_photos WHERE fb_photo_id = '6103'");
  assert.equal(old.source, "backfill");
  assert.equal(old.fb_created_time, "2024-01-01T12:00:00.000Z");
  assert.equal(old.fb_post_id, `${PAGE_ID}_512`);
  assert.equal(old.caption, "Old job");
  assert.equal((await rows("SELECT permalink FROM facebook_posts WHERE fb_post_id = ?", `${PAGE_ID}_512`))[0].permalink,
    `https://www.facebook.com/${PAGE_ID}_512`);
  assert.equal((await call(`${BASE}/backfill`, { method: "POST", body: { after: "../../etc" }, admin: true })).status, 400);
});

test("backfill that hits the fetch budget returns the same cursor and finishes later", async () => {
  const ids = Array.from({ length: 30 }, (_, i) => String(7000 + i));
  const post = stubPost(`${PAGE_ID}_520`, ids, { message: "Huge album", album: { id: "4444", name: "Big Barn" } });
  graphFixtures.set(`${PAGE_ID}/posts`, { data: [post], paging: {} });

  const first = await getJson(`${BASE}/backfill`, { method: "POST", body: { dryRun: false, after: "START" }, admin: true });
  assert.equal(first.complete, false);
  assert.equal(first.next, "START");
  const firstCount = (await rows("SELECT * FROM facebook_photos WHERE status='imported'")).length;
  assert.ok(firstCount > 0 && firstCount < 30);

  const second = await getJson(`${BASE}/backfill`, { method: "POST", body: { dryRun: false, after: "START" }, admin: true });
  assert.equal(second.complete, true);
  assert.equal((await rows("SELECT * FROM facebook_photos WHERE status='imported'")).length, 30);
  assert.equal((await getJson("/api/gallery-api?project=big-barn")).items.length, 30);
});
