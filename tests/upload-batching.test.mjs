// Run: npm run test:site
// The admin uploader's batch plan (src/lib/upload-batching.js), checked on its
// own and end to end against the real Gallery Worker upload handler with
// browser-like requests (serialized multipart body + Content-Length).
// Local Miniflare R2 only (wrangler getPlatformProxy); nothing leaves the machine.
import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { getPlatformProxy } from "wrangler";

import {
  planUploadBatches, MAX_FILE_BYTES, BATCH_TARGET_BYTES, BATCH_MAX_FILES,
} from "../src/lib/upload-batching.js";
import worker from "../workers/kilcon-gallery-worker/src/index.js";
import { JPEG, JPEG_EXIF, PNG, WEBP, AVIF, HEIC_HEADER } from "../workers/kilcon-gallery-worker/test/imageFixtures.mjs";

const MB = 1024 * 1024;
const REQUEST_LIMIT = 50 * MB; // MAX_GALLERY_UPLOAD_REQUEST_BYTES
const ADMIN_SECRET = "test-admin-secret";
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

// A valid image of an exact size: real encoded header, padded after the end
// (phones such as Samsung append trailer data the same way).
function sized(bytes, size, name, type = "image/jpeg") {
  const buf = new Uint8Array(size);
  buf.set(bytes);
  return new File([buf], name, { type });
}
const pathFor = (f) => `Projects/Batch Test/${f.name}`;
const sizes = (plan) => plan.batches.map((b) => b.map((e) => Math.round(e.file.size / MB * 10) / 10));

// ---- planner only -----------------------------------------------------

test("a single 21–25 MB image gets its own batch; nothing is rejected", () => {
  for (const size of [20 * MB + 1, 21 * MB, 24.5 * MB, MAX_FILE_BYTES]) {
    const plan = planUploadBatches([sized(JPEG, size, "big.jpg")], pathFor);
    assert.deepEqual(plan.rejected, [], `${size}`);
    assert.equal(plan.batches.length, 1);
    assert.equal(plan.batches[0].length, 1);
  }
  const over = planUploadBatches([sized(JPEG, MAX_FILE_BYTES + 1, "huge.jpg")], pathFor);
  assert.deepEqual(over.rejected, [{ name: "huge.jpg", reason: "too-large" }]);
  assert.equal(over.batches.length, 0);
});

test("mixed sizes keep order, isolate large files, and respect the target", () => {
  const files = [
    sized(JPEG, 8 * MB, "a.jpg"), sized(JPEG, 8 * MB, "b.jpg"), sized(JPEG, 23 * MB, "c.jpg"),
    sized(PNG, 4 * MB, "d.png", "image/png"), sized(JPEG, 20 * MB, "e.jpg"), sized(WEBP, 3 * MB, "f.webp", "image/webp"),
  ];
  const plan = planUploadBatches(files, pathFor);
  assert.deepEqual(sizes(plan), [[8, 8], [23], [4], [20], [3]]);
  assert.deepEqual(plan.batches.flat().map((e) => e.file.name), ["a.jpg", "b.jpg", "c.jpg", "d.png", "e.jpg", "f.webp"]);
  for (const b of plan.batches) {
    const total = b.reduce((n, e) => n + e.file.size, 0);
    assert.ok(b.length === 1 || total <= BATCH_TARGET_BYTES, "multi-file batches stay at or under the target");
    assert.ok(total <= MAX_FILE_BYTES && b.length <= BATCH_MAX_FILES);
  }
  // Exactly 20 MB fills the target; the next file starts a new batch.
  assert.deepEqual(sizes(planUploadBatches([sized(JPEG, 20 * MB, "x.jpg"), sized(JPEG, 1 * MB, "y.jpg")], pathFor)), [[20], [1]]);
  assert.deepEqual(sizes(planUploadBatches([sized(JPEG, 12 * MB, "x.jpg"), sized(JPEG, 8 * MB, "y.jpg")], pathFor)), [[12, 8]]);
});

test("many small phone photos split at 20 files per request", () => {
  const files = Array.from({ length: 45 }, (_, i) => sized(JPEG_EXIF, 300 * 1024, `IMG_${1000 + i}.JPG`));
  assert.deepEqual(planUploadBatches(files, pathFor).batches.map((b) => b.length), [20, 20, 5]);
});

test("unsupported, empty and oversized files are rejected up front with reasons", () => {
  const plan = planUploadBatches([
    new File([HEIC_HEADER], "IMG_0001.HEIC", { type: "image/heic" }),
    new File([], "empty.jpg", { type: "image/jpeg" }),
    new File(["x"], "notes.pdf"),
    sized(JPEG, MAX_FILE_BYTES + 1, "huge.jpg"),
    sized(JPEG, 2 * MB, "ok.jpg"),
  ], pathFor);
  assert.deepEqual(plan.rejected, [
    { name: "IMG_0001.HEIC", reason: "unsupported-extension" },
    { name: "empty.jpg", reason: "empty" },
    { name: "notes.pdf", reason: "unsupported-extension" },
    { name: "huge.jpg", reason: "too-large" },
  ]);
  assert.deepEqual(sizes(plan), [[2]]);
});

// ---- end to end against the Worker ------------------------------------

let proxy;
let env;

before(async () => {
  proxy = await getPlatformProxy({
    configPath: path.join(repoRoot, "workers/kilcon-gallery-worker/wrangler.toml"),
    persist: false,
  });
  env = {
    ...proxy.env,
    FB_INTEGRATION_ENABLED: "false",
    ADMIN_SECRET,
    SESSION_VERSION: "3",
    READ_LIMITER: { limit: async () => ({ success: true }) },
    WRITE_LIMITER: { limit: async () => ({ success: true }) },
  };
});
after(async () => { await proxy?.dispose(); });
beforeEach(async () => {
  const k = (await env.GALLERY_BUCKET.list()).objects.map((o) => o.key);
  if (k.length) await env.GALLERY_BUCKET.delete(k);
});

async function adminCookie() {
  const now = Math.floor(Date.now() / 1000);
  const b64u = (b) => btoa(String.fromCharCode(...b)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
  const p = b64u(new TextEncoder().encode(JSON.stringify({ iat: now, exp: now + 600, ver: "3" })));
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(ADMIN_SECRET), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return `admin_auth=${p}.${b64u(new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(p))))}`;
}

// Send each planned batch the way the browser does and collect the results.
async function uploadPlan(plan) {
  const cookie = await adminCookie();
  const out = { statuses: [], urls: [], rejected: [], requestBytes: [] };
  for (const batch of plan.batches) {
    const form = new FormData();
    for (const { path: p, file } of batch) form.append(p, file);
    const serialized = new Response(form);
    const contentType = serialized.headers.get("Content-Type");
    const body = new Uint8Array(await serialized.arrayBuffer());
    out.requestBytes.push(body.byteLength);
    const res = await worker.fetch(new Request("https://kilcon.work/api/gallery-api/upload", {
      method: "POST", body,
      headers: { Cookie: cookie, "Content-Type": contentType, "Content-Length": String(body.byteLength) },
    }), env, { waitUntil() {}, passThroughOnException() {} });
    const data = await res.json();
    out.statuses.push(res.status);
    out.urls.push(...(data.urls || []));
    out.rejected.push(...(data.rejected || []));
  }
  return out;
}

test("E2E: a single 21 MB and a single 25 MB JPEG upload successfully", async () => {
  for (const size of [21 * MB, MAX_FILE_BYTES]) {
    const plan = planUploadBatches([sized(JPEG_EXIF, size, "IMG_2001.JPG")], pathFor);
    const r = await uploadPlan(plan);
    assert.deepEqual(r.statuses, [200], `${size}`);
    assert.equal(r.urls.length, 1);
    assert.ok(r.requestBytes[0] < REQUEST_LIMIT, "request well under the Worker limit");
    const head = await env.GALLERY_BUCKET.head("Projects/Batch Test/IMG_2001.JPG");
    assert.equal(head.size, size);
    assert.equal(head.httpMetadata.contentType, "image/jpeg");
  }
});

test("E2E: files around 20 MB and 25 MB, mixed with small phone formats", async () => {
  const files = [
    sized(JPEG, 20 * MB - 1, "under20.jpg"), sized(JPEG, 20 * MB, "at20.jpg"), sized(JPEG, 20 * MB + 1, "over20.jpg"),
    sized(JPEG_EXIF, MAX_FILE_BYTES - 1, "under25.jpg"), sized(JPEG_EXIF, MAX_FILE_BYTES, "at25.jpg"),
    sized(JPEG, MAX_FILE_BYTES + 1, "over25.jpg"),
    sized(JPEG_EXIF, 3 * MB, "IMG_3001.JPG"), sized(PNG, 2 * MB, "screenshot.png", "image/png"),
    sized(WEBP, 1 * MB, "pixel.webp", "image/webp"), sized(AVIF, 1 * MB, "photo.avif", "image/avif"),
    sized(JPEG, 4 * MB, "no-mime.jpeg", ""),
    new File([HEIC_HEADER], "IMG_3002.HEIC", { type: "image/heic" }),
  ];
  const plan = planUploadBatches(files, pathFor);
  assert.deepEqual(plan.rejected.map((r) => r.name), ["over25.jpg", "IMG_3002.HEIC"]);

  const r = await uploadPlan(plan);
  assert.ok(r.statuses.every((s) => s === 200), JSON.stringify(r.statuses));
  assert.deepEqual(r.rejected, [], "the server accepted everything the planner sent");
  assert.ok(Math.max(...r.requestBytes) < REQUEST_LIMIT, `largest request ${Math.max(...r.requestBytes)}`);
  assert.equal(r.urls.length, 10);
  const stored = (await env.GALLERY_BUCKET.list({ prefix: "Projects/Batch Test/" })).objects.map((o) => o.key.split("/").pop()).sort();
  assert.deepEqual(stored, ["IMG_3001.JPG", "at20.jpg", "at25.jpg", "no-mime.jpeg", "over20.jpg", "photo.avif",
    "pixel.webp", "screenshot.png", "under20.jpg", "under25.jpg"]);
});

test("E2E: files the server rejects are reported without blocking the rest", async () => {
  // Pass the client pre-checks (right extension, size) but fail on content.
  const disguised = new File([new TextEncoder().encode("<svg onload=alert(1)>").buffer], "fake.jpg", { type: "image/jpeg" });
  const pngAsJpg = sized(PNG, 1 * MB, "png-named.jpg", "image/jpeg");
  const plan = planUploadBatches([sized(JPEG, 22 * MB, "big.jpg"), disguised, pngAsJpg, sized(JPEG, 1 * MB, "small.jpg")], pathFor);
  assert.deepEqual(plan.rejected, []);
  const r = await uploadPlan(plan);
  assert.deepEqual(r.statuses, [200, 200]);
  assert.deepEqual(r.rejected.map((x) => [x.name.split("/").pop(), x.reason]).sort(),
    [["fake.jpg", "not-an-image"], ["png-named.jpg", "extension-mismatch"]]);
  assert.equal(r.urls.length, 2);
});

test("E2E: a request the old, unbatched page could send over 50 MB is refused before parsing", async () => {
  const plan = { batches: [[25, 24, 2].map((m, i) => ({ path: `Projects/Batch Test/${i}.jpg`, file: sized(JPEG, m * MB, `${i}.jpg`) }))] };
  const r = await uploadPlan(plan);
  assert.deepEqual(r.statuses, [413]);
  assert.equal((await env.GALLERY_BUCKET.list()).objects.length, 0);
});
