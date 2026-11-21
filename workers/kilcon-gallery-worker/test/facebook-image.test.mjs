// Run: npm run test:gallery-worker   (from repo root)
// Gated Facebook image delivery (src/facebook-image.js) on real local D1 + R2
// (Miniflare via getPlatformProxy). The Images binding and the edge cache are
// fakes so transformations and cache hits can be counted.

import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { getPlatformProxy } from "wrangler";

import worker from "../src/index.js";
import { reconcilePhoto } from "../src/facebook.js";
import {
  serveFacebookImage,
  parseFacebookImagePath,
  facebookThumbUrl,
  FB_IMAGE_BROWSER_CACHE,
} from "../src/facebook-image.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "../../..");
const IMG = "https://images.kilcon.work";

let proxy;
let baseEnv;
let images;
let nextId = 9000;
const realConsole = { log: console.log, warn: console.warn, error: console.error };
const realCaches = globalThis.caches;

function fakeImages() {
  const state = {
    calls: [],
    fail: null,
    input(stream) {
      return {
        transform(opts) {
          state.calls.push(opts);
          return {
            async output(o) {
              const src = new Uint8Array(await new Response(stream).arrayBuffer());
              if (state.fail) throw state.fail;
              const prefix = new TextEncoder().encode(`RESIZED-${opts.width}:`);
              const out = new Uint8Array(prefix.length + src.length);
              out.set(prefix);
              out.set(src, prefix.length);
              return { response: () => new Response(out, { headers: { "Content-Type": o.format } }) };
            },
          };
        },
      };
    },
  };
  return state;
}

function fakeCache() {
  const store = new Map();
  return {
    store,
    hits: 0,
    async match(req) {
      const e = store.get(typeof req === "string" ? req : req.url);
      if (!e) return undefined;
      this.hits++;
      return new Response(e.body.slice(0), { headers: e.headers });
    },
    async put(req, res) {
      store.set(typeof req === "string" ? req : req.url, { body: await res.arrayBuffer(), headers: [...res.headers] });
    },
  };
}

function makeEnv(overrides = {}) {
  return { ...baseEnv, FB_INTEGRATION_ENABLED: "true", IMAGES: images, ...overrides };
}
const ctx = () => {
  const pending = [];
  return { pending, waitUntil: (p) => pending.push(p), passThroughOnException() {} };
};

async function seedPhoto({ ext = "jpg", hidden = 0, projectHidden = 0, status = "imported", publicCopy = true } = {}) {
  const id = String(nextId++);
  const key = `Facebook/${id}.${ext}`;
  const env = makeEnv();
  await env.DB.prepare(`INSERT INTO facebook_projects (slug, name, hidden) VALUES (?, ?, ?)`)
    .bind(`proj-${id}`, `Project ${id}`, projectHidden).run();
  const { id: projectId } = await env.DB.prepare(`SELECT id FROM facebook_projects WHERE slug = ?`).bind(`proj-${id}`).first();
  await env.DB.prepare(
    `INSERT INTO facebook_photos (fb_photo_id, page_id, source, status, project_id, hidden, master_key, public_key, content_type)
     VALUES (?, '1111111111', 'webhook', ?, ?, ?, ?, ?, ?)`
  ).bind(id, status, projectId, hidden, key, hidden ? null : key, `image/${ext === "jpg" ? "jpeg" : ext}`).run();
  const bytes = new TextEncoder().encode(`MASTER-${id}`);
  await env.PRIVATE_BUCKET.put(key, bytes, { httpMetadata: { contentType: "image/jpeg" } });
  if (publicCopy) {
    await env.GALLERY_BUCKET.put(key, new TextEncoder().encode(`PUBLIC-${id}`), {
      httpMetadata: { contentType: "image/jpeg" },
      customMetadata: { source: "facebook", fbPhotoId: id },
    });
  }
  return { id, key, projectId, bytes: `MASTER-${id}` };
}

const setHidden = (id, hidden) =>
  makeEnv().DB.prepare(`UPDATE facebook_photos SET hidden = ? WHERE fb_photo_id = ?`).bind(hidden, id).run();

async function get(pathOrUrl, { env = makeEnv(), headers = {}, method = "GET", cache } = {}) {
  const url = pathOrUrl.startsWith("http") ? pathOrUrl : `${IMG}${pathOrUrl}`;
  const req = new Request(url, { method, headers });
  const c = ctx();
  const res = cache === undefined
    ? await worker.fetch(req, env, c)
    : await serveFacebookImage(req, env, c, { cache });
  await Promise.all(c.pending);
  return res;
}

function assertNoStore(res, status = 404) {
  assert.equal(res.status, status);
  assert.equal(res.headers.get("Cache-Control"), "no-store");
  assert.equal(res.headers.get("X-Content-Type-Options"), "nosniff");
}

before(async () => {
  proxy = await getPlatformProxy({
    configPath: path.join(repoRoot, "workers/kilcon-gallery-worker/wrangler.toml"),
    persist: false,
  });
  baseEnv = proxy.env;
  for (const file of ["013_facebook_sync.sql", "014_facebook_removal_retention.sql", "015_facebook_discovery.sql", "016_facebook_project_descriptions.sql"]) {
    const sql = await readFile(path.join(repoRoot, "migrations", file), "utf8");
    const statements = sql
      .split("\n").filter((l) => !l.trim().startsWith("--")).join("\n")
      .split(";").map((s) => s.trim()).filter(Boolean);
    await baseEnv.DB.batch(statements.map((s) => baseEnv.DB.prepare(s)));
  }
});

after(async () => {
  Object.assign(console, realConsole);
  globalThis.caches = realCaches;
  await proxy?.dispose();
});

beforeEach(() => {
  images = fakeImages();
  globalThis.caches = realCaches;
  for (const k of ["log", "warn", "error"]) {
    console[k] = (...args) => { if (process.env.DEBUG_LOGS) realConsole[k](...args); };
  }
});

// --- visible photos ------------------------------------------------------

test("visible full image: served from the PRIVATE master with a 300 s browser cache", async () => {
  const p = await seedPhoto();
  const res = await get(`/Facebook/${p.id}.jpg`);
  assert.equal(res.status, 200);
  assert.equal(await res.text(), p.bytes, "bytes come from the private master, not the public copy");
  assert.equal(res.headers.get("Cache-Control"), FB_IMAGE_BROWSER_CACHE);
  assert.equal(FB_IMAGE_BROWSER_CACHE, "public, max-age=300");
  assert.equal(res.headers.get("Content-Type"), "image/jpeg");
  assert.equal(res.headers.get("X-Content-Type-Options"), "nosniff");
  assert.ok(res.headers.get("ETag"));
});

test("full image works with no public copy at all (private-only storage)", async () => {
  const p = await seedPhoto({ publicCopy: false });
  const res = await get(`/Facebook/${p.id}.jpg`);
  assert.equal(res.status, 200);
  assert.equal(await res.text(), p.bytes);
});

test("If-None-Match revalidates to 304 with the same cache headers; HEAD has no body", async () => {
  const p = await seedPhoto();
  const first = await get(`/Facebook/${p.id}.jpg`);
  await first.arrayBuffer();
  const etag = first.headers.get("ETag");
  const again = await get(`/Facebook/${p.id}.jpg`, { headers: { "If-None-Match": etag } });
  assert.equal(again.status, 304);
  assert.equal(again.headers.get("Cache-Control"), FB_IMAGE_BROWSER_CACHE);
  assert.equal(again.headers.get("ETag"), etag);
  const head = await get(`/Facebook/${p.id}.jpg`, { method: "HEAD" });
  assert.equal(head.status, 200);
  assert.equal((await head.arrayBuffer()).byteLength, 0);
});

test("480 px thumbnail is resized from the master, edge-cached, then served from cache", async () => {
  const p = await seedPhoto();
  const cache = fakeCache();
  const res = await get(`/Facebook/w/480/${p.id}.jpg`, { cache });
  assert.equal(res.status, 200);
  assert.equal(await res.text(), `RESIZED-480:${p.bytes}`);
  assert.equal(res.headers.get("Content-Type"), "image/jpeg");
  assert.equal(res.headers.get("Cache-Control"), FB_IMAGE_BROWSER_CACHE, "browser sees 300 s, not the edge lifetime");
  assert.deepEqual(images.calls, [{ width: 480, fit: "scale-down" }]);
  assert.equal(cache.store.size, 1);

  const again = await get(`/Facebook/w/480/${p.id}.jpg`, { cache });
  assert.equal(await again.text(), `RESIZED-480:${p.bytes}`);
  assert.equal(images.calls.length, 1, "second request is a cache hit, no new transformation");
  assert.equal(cache.hits, 1);

  const etag = again.headers.get("ETag");
  const nm = await get(`/Facebook/w/480/${p.id}.jpg`, { cache, headers: { "If-None-Match": etag } });
  assert.equal(nm.status, 304);
  assert.equal(nm.headers.get("Cache-Control"), FB_IMAGE_BROWSER_CACHE);
});

test("query strings never change the transformation or the cache key", async () => {
  const p = await seedPhoto();
  const cache = fakeCache();
  const res = await get(`/Facebook/w/480/${p.id}.jpg?width=2000&fit=contain`, { cache });
  assert.equal(res.status, 200);
  await res.arrayBuffer();
  assert.deepEqual(images.calls, [{ width: 480, fit: "scale-down" }]);
  assert.deepEqual([...cache.store.keys()], [`${IMG}/Facebook/w/480/${p.id}.jpg`]);
});

// --- hide / delete / restore --------------------------------------------

test("hiding takes effect immediately, even for an edge-cached thumbnail", async () => {
  const p = await seedPhoto();
  const cache = fakeCache();
  await (await get(`/Facebook/w/480/${p.id}.jpg`, { cache })).arrayBuffer();
  assert.equal(cache.store.size, 1, "precondition: thumbnail is cached");

  await setHidden(p.id, 1); // D1 first, exactly as handleRemoval / admin hide do
  assertNoStore(await get(`/Facebook/w/480/${p.id}.jpg`, { cache }));
  assertNoStore(await get(`/Facebook/${p.id}.jpg`));
  assert.equal(cache.hits, 0, "the cached copy was never read: the gate runs before the cache");
});

test("hidden photo stays 404 even though its public copy still exists in R2", async () => {
  const p = await seedPhoto();
  await setHidden(p.id, 1);
  assert.ok(await makeEnv().GALLERY_BUCKET.head(p.key), "precondition: stale public copy present");
  assertNoStore(await get(`/Facebook/${p.id}.jpg`));
});

test("real hide → restore cycle through reconcilePhoto: 404 no-store, then 200 at once", async () => {
  const p = await seedPhoto();
  const env = makeEnv();
  await setHidden(p.id, 1);
  await reconcilePhoto(env, p.id);
  assert.equal(await env.GALLERY_BUCKET.head(p.key), null, "reconcile deleted the public copy");
  const hidden = await get(`/Facebook/${p.id}.jpg`);
  assertNoStore(hidden);

  await setHidden(p.id, 0);
  await reconcilePhoto(env, p.id);
  const restored = await get(`/Facebook/${p.id}.jpg`);
  assert.equal(restored.status, 200, "no cached 404: 404s are no-store and never cached by the Worker");
  assert.equal(await restored.text(), p.bytes);
  const thumb = await get(`/Facebook/w/480/${p.id}.jpg`, { cache: fakeCache() });
  assert.equal(thumb.status, 200);
});

test("deleted photo (purged: no master, no public key) → 404 no-store", async () => {
  const p = await seedPhoto();
  const env = makeEnv();
  await env.DB.prepare(
    `UPDATE facebook_photos SET hidden = 1, hidden_reason = 'deleted', master_key = NULL, public_key = NULL WHERE fb_photo_id = ?`
  ).bind(p.id).run();
  await env.PRIVATE_BUCKET.delete(p.key);
  assertNoStore(await get(`/Facebook/${p.id}.jpg`));
  assertNoStore(await get(`/Facebook/w/480/${p.id}.jpg`, { cache: fakeCache() }));
});

test("hidden project, unknown id, failed/importing status, and integration switched off → 404", async () => {
  const hiddenProject = await seedPhoto({ projectHidden: 1 });
  assertNoStore(await get(`/Facebook/${hiddenProject.id}.jpg`));
  assertNoStore(await get(`/Facebook/123456789.jpg`));
  const importing = await seedPhoto({ status: "importing" });
  assertNoStore(await get(`/Facebook/${importing.id}.jpg`));
  const visible = await seedPhoto();
  assertNoStore(await get(`/Facebook/${visible.id}.jpg`, { env: makeEnv({ FB_INTEGRATION_ENABLED: "false" }) }));
});

// --- bypass attempts -----------------------------------------------------

test("arbitrary widths, encodings, case, extensions and extra segments are refused", async () => {
  const p = await seedPhoto();
  const cache = fakeCache();
  for (const pth of [
    `/Facebook/w/600/${p.id}.jpg`, `/Facebook/w/2000/${p.id}.jpg`, `/Facebook/w/1/${p.id}.jpg`,
    `/Facebook/w/0480/${p.id}.jpg`, `/Facebook/w/480/${p.id}.png`, `/Facebook/${p.id}.png`,
    `/Facebook/${p.id}.JPG`, `/Facebook/${p.id}.jpg/x`, `/Facebook/x/${p.id}.jpg`,
    `/Facebook/%3${p.id[0]}${p.id.slice(1)}.jpg`, `/Facebook/${p.id}%2Ejpg`,
    `/Facebook/cdn-cgi/image/width=9/${p.id}.jpg`, `/Facebook/w/480/../${p.id}.jpgx`,
  ]) {
    const res = await get(pth, { cache });
    assertNoStore(res);
  }
  assert.equal(images.calls.length, 0, "no transformation was ever attempted");
});

test("encoded/lower-case prefixes never reach the gate or R2 on the image host", async () => {
  const p = await seedPhoto();
  for (const pth of [`/Facebook%2F${p.id}.jpg`, `/%46acebook/${p.id}.jpg`, `/facebook/${p.id}.jpg`]) {
    const res = await get(pth);
    assert.equal(res.status, 404, pth);
    assert.equal(res.headers.get("Cache-Control"), "no-store", pth);
  }
});

test("non-GET methods → 405 no-store", async () => {
  const p = await seedPhoto();
  for (const method of ["POST", "PUT", "DELETE"]) assertNoStore(await get(`/Facebook/${p.id}.jpg`, { method }), 405);
});

test("other hosts and other image-host paths keep their existing behaviour", async () => {
  const p = await seedPhoto();
  const dev = await get(`https://kilcon-gallery-worker.example.workers.dev/Facebook/${p.id}.jpg`);
  assert.equal(dev.status, 404, "workers.dev host does not serve images");
  const review = await get(`/Reviews/photos/x.jpg`);
  assert.equal(review.status, 404);
  assert.equal(review.headers.get("Cache-Control"), "no-store");
});

// --- failures are closed -------------------------------------------------

test("D1 failure → 503 no-store, nothing served", async () => {
  const p = await seedPhoto();
  const brokenDb = { prepare() { throw new Error("D1 unavailable"); } };
  const res = await get(`/Facebook/${p.id}.jpg`, { env: makeEnv({ DB: brokenDb }) });
  assertNoStore(res, 503);
  assert.equal(await res.text(), "Temporarily unavailable");
});

test("private R2 failure → 503 no-store (never falls back to the public bucket)", async () => {
  const p = await seedPhoto();
  const brokenPrivate = { get: async () => { throw new Error("R2 unavailable"); } };
  const full = await get(`/Facebook/${p.id}.jpg`, { env: makeEnv({ PRIVATE_BUCKET: brokenPrivate }) });
  assertNoStore(full, 503);
  const thumb = await get(`/Facebook/w/480/${p.id}.jpg`, { env: makeEnv({ PRIVATE_BUCKET: brokenPrivate }), cache: fakeCache() });
  assertNoStore(thumb, 503);
});

test("Cache API failure → 503 no-store", async () => {
  const p = await seedPhoto();
  const brokenCache = { match: async () => { throw new Error("cache down"); }, put: async () => {} };
  assertNoStore(await get(`/Facebook/w/480/${p.id}.jpg`, { cache: brokenCache }), 503);
});

test("transformation failure (quota 9422 / binding missing) serves the visible original, uncached", async () => {
  const p = await seedPhoto();
  const cache = fakeCache();
  images.fail = new Error("ERROR 9422: transformation limit reached");
  const res = await get(`/Facebook/w/480/${p.id}.jpg`, { cache });
  assert.equal(res.status, 200);
  assert.equal(await res.text(), p.bytes);
  assert.equal(res.headers.get("Cache-Control"), FB_IMAGE_BROWSER_CACHE);
  assert.equal(cache.store.size, 0, "fallback is not cached, so the next request retries");

  const noBinding = await get(`/Facebook/w/480/${p.id}.jpg`, { env: makeEnv({ IMAGES: undefined }), cache });
  assert.equal(noBinding.status, 200);
  assert.equal(await noBinding.text(), p.bytes);

  await setHidden(p.id, 1);
  assertNoStore(await get(`/Facebook/w/480/${p.id}.jpg`, { cache }), 404);
});

test("the Worker's default path (no injected cache) uses the Cache API when present", async () => {
  const p = await seedPhoto();
  const cache = fakeCache();
  globalThis.caches = { default: cache };
  const res = await get(`/Facebook/w/480/${p.id}.jpg`);
  assert.equal(res.status, 200);
  await res.arrayBuffer();
  assert.equal(cache.store.size, 1);
});

// --- URL helpers ---------------------------------------------------------

test("path parser and thumbnail URLs", () => {
  assert.deepEqual(parseFacebookImagePath("/Facebook/123.jpg"), { id: "123", ext: "jpg", width: null });
  assert.deepEqual(parseFacebookImagePath("/Facebook/w/480/123.webp"), { id: "123", ext: "webp", width: 480 });
  assert.equal(parseFacebookImagePath("/Facebook/w/600/123.jpg"), null);
  assert.equal(parseFacebookImagePath("/Facebook/abc.jpg"), null);
  assert.equal(facebookThumbUrl("https://images.kilcon.work/", "Facebook/123.jpg"), "https://images.kilcon.work/Facebook/w/480/123.jpg");
  assert.equal(facebookThumbUrl("https://images.kilcon.work", "Projects/Deck/a.jpg"), null, "manual images keep /cdn-cgi/image");
});
