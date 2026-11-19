// Run: npm run test:gallery-worker   (from repo root)
// Upload validation, bounded request bodies, and review-photo revocation.
// Uses wrangler's getPlatformProxy for local in-memory R2/D1 (Miniflare);
// nothing leaves the machine.

import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { getPlatformProxy } from "wrangler";

import worker from "../src/index.js";
import {
  inspectImageHeader,
  validateImageFile,
  readBoundedFormData,
  isSafeUploadKey,
} from "../src/imageValidation.js";
import { JPEG, JPEG_EXIF, PNG, WEBP, AVIF, HEIC_HEADER, SVG } from "./imageFixtures.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "../../..");
const SITE = "https://kilcon.work";
const ADMIN_SECRET = "test-admin-secret";
const MB = 1024 * 1024;

let proxy;
let baseEnv;

const makeEnv = (overrides = {}) => ({
  ...baseEnv,
  // The upload and review paths never touch Facebook/D1; keep the switch off so
  // these tests can't depend on it.
  FB_INTEGRATION_ENABLED: "false",
  READ_LIMITER: { limit: async () => ({ success: true }) },
  WRITE_LIMITER: { limit: async () => ({ success: true }) },
  ADMIN_SECRET,
  SESSION_VERSION: "3",
  TURNSTILE_SECRET: undefined,
  ...overrides,
});
const ctx = () => ({ waitUntil() {}, passThroughOnException() {} });

async function adminCookie() {
  const now = Math.floor(Date.now() / 1000);
  const b64u = (bytes) => btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
  const payloadB64 = b64u(new TextEncoder().encode(JSON.stringify({ iat: now, exp: now + 600, ver: "3" })));
  const key = await crypto.subtle.importKey(
    "raw", new TextEncoder().encode(ADMIN_SECRET), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]
  );
  const sig = new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(payloadB64)));
  return `admin_auth=${payloadB64}.${b64u(sig)}`;
}

async function call(url, { method = "GET", body, admin = false, headers = {}, env = makeEnv() } = {}) {
  const h = { ...headers };
  if (admin) h.Cookie = await adminCookie();
  let payload = body;
  if (body !== undefined && !(body instanceof FormData) && !(body instanceof ReadableStream)) {
    h["Content-Type"] = "application/json";
    payload = JSON.stringify(body);
  }
  const init = { method, headers: h, body: payload };
  if (payload instanceof ReadableStream) init.duplex = "half";
  return worker.fetch(new Request(url.startsWith("http") ? url : `${SITE}${url}`, init), env, ctx());
}

async function keys(bucket, prefix = "") {
  return (await bucket.list({ prefix })).objects.map((o) => o.key).sort();
}

async function upload(files, opts = {}) {
  const form = new FormData();
  for (const [field, file] of files) form.append(field, file);
  return call("/api/gallery-api/upload", { method: "POST", body: form, admin: true, ...opts });
}

before(async () => {
  proxy = await getPlatformProxy({
    configPath: path.join(repoRoot, "workers/kilcon-gallery-worker/wrangler.toml"),
    persist: false,
  });
  baseEnv = proxy.env;
});

after(async () => {
  await proxy?.dispose();
});

beforeEach(async () => {
  for (const b of [baseEnv.GALLERY_BUCKET, baseEnv.PRIVATE_BUCKET]) {
    const k = await keys(b);
    if (k.length) await b.delete(k);
  }
});

// =====================================================================
// Header inspection (unit)
// =====================================================================

test("real JPEG, EXIF JPEG, PNG, WebP and AVIF headers are recognized", () => {
  for (const [bytes, type] of [[JPEG, "image/jpeg"], [JPEG_EXIF, "image/jpeg"], [PNG, "image/png"], [WEBP, "image/webp"], [AVIF, "image/avif"]]) {
    assert.deepEqual(inspectImageHeader(bytes.subarray(0, 256), bytes.length), { type }, type);
  }
});

test("truncated, empty and non-image headers are refused", () => {
  for (const bytes of [JPEG, JPEG_EXIF, PNG, WEBP, AVIF]) {
    for (const n of [0, 2, 5, 11, 15]) {
      const cut = bytes.subarray(0, n);
      assert.ok(inspectImageHeader(cut, cut.length).error, `${n}-byte prefix`);
    }
  }
  // Correct prefix but a declared structure that doesn't fit in the file.
  const jpegStub = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 16, 74, 70, 73, 70, 0, 1]);
  assert.equal(inspectImageHeader(jpegStub, jpegStub.length).error, "truncated");
  const pngStub = PNG.subarray(0, 12);
  assert.equal(inspectImageHeader(pngStub, pngStub.length).error, "truncated");
  assert.equal(inspectImageHeader(WEBP.subarray(0, 40), 40).error, "truncated", "RIFF size exceeds file");

  // JPEG SOI followed by a byte that isn't a real first marker
  assert.equal(inspectImageHeader(new Uint8Array([0xff, 0xd8, 0xff, 0x00, 0, 16]), 64).error, "unrecognized");
  // PNG with zero width
  const zeroWidth = PNG.slice();
  zeroWidth.set([0, 0, 0, 0], 16);
  assert.equal(inspectImageHeader(zeroWidth, zeroWidth.length).error, "unrecognized");

  for (const bytes of [SVG, new TextEncoder().encode("<!doctype html><script>x</script>"), HEIC_HEADER, new Uint8Array(64)]) {
    assert.equal(inspectImageHeader(bytes.subarray(0, 256), bytes.length).error, "unrecognized");
  }
});

test("validateImageFile: types come from bytes, and extension and client MIME must agree", async () => {
  const v = (bytes, name, type, maxBytes = 25 * MB) =>
    validateImageFile(new File([bytes], name, { type }), { name, maxBytes });

  assert.deepEqual(await v(JPEG, "a.jpg", "image/jpeg"), { ok: true, contentType: "image/jpeg" });
  assert.deepEqual(await v(JPEG_EXIF, "IMG_0001.JPG", "image/jpeg"), { ok: true, contentType: "image/jpeg" }, "uppercase phone name");
  assert.deepEqual(await v(JPEG, "a.jpeg", "image/jpg"), { ok: true, contentType: "image/jpeg" }, "MIME alias");
  assert.deepEqual(await v(PNG, "a.png", ""), { ok: true, contentType: "image/png" }, "missing MIME is not trusted, bytes decide");
  assert.deepEqual(await v(WEBP, "a.webp", "application/octet-stream"), { ok: true, contentType: "image/webp" });
  assert.deepEqual(await v(AVIF, "a.avif", "image/avif"), { ok: true, contentType: "image/avif" });

  assert.equal((await v(new Uint8Array(0), "a.jpg", "image/jpeg")).reason, "empty");
  assert.equal((await v(JPEG, "a.jpg", "image/jpeg", JPEG.length - 1)).reason, "too-large");
  assert.equal((await v(PNG, "a.jpg", "image/jpeg")).reason, "extension-mismatch", "PNG bytes named .jpg");
  assert.equal((await v(JPEG, "a.png", "image/png")).reason, "extension-mismatch");
  assert.equal((await v(PNG, "a.png", "image/jpeg")).reason, "mime-mismatch", "forged MIME");
  assert.equal((await v(JPEG, "a.jpg", "text/html")).reason, "mime-mismatch");
  assert.equal((await v(JPEG, "a.jpg", "image/svg+xml")).reason, "mime-mismatch");
  assert.equal((await v(SVG, "a.jpg", "image/jpeg")).reason, "not-an-image", "SVG disguised as JPEG");
  assert.equal((await v(SVG, "a.svg", "image/svg+xml")).reason, "unsupported-extension");
  assert.equal((await v(HEIC_HEADER, "a.heic", "image/heic")).reason, "unsupported-extension");
  assert.equal((await v(HEIC_HEADER, "a.avif", "image/avif")).reason, "not-an-image", "HEIC renamed .avif");
  assert.equal((await v(JPEG.subarray(0, 5), "a.jpg", "image/jpeg")).reason, "truncated");
});

test("upload keys: control, bidi and whitespace tricks are refused", () => {
  for (const ok of ["Projects/Deck 2026/IMG_0001.jpg", "Highlights/a (1).jpg", "Remodels/Kitchen/photo-é.webp"]) {
    assert.equal(isSafeUploadKey(ok), true, ok);
  }
  for (const bad of [
    "", "Projects//a.jpg", "Projects/./a.jpg", "Projects/../a.jpg", "Projects/a\u0000.jpg", "Projects/a\n.jpg",
    "Projects/‮gpj.jpg", "Projects/a​.jpg", "Projects/ x/a.jpg", "Projects/x /a.jpg",
    `Projects/${"a".repeat(201)}.jpg`, `Projects/${"b/".repeat(300)}a.jpg`,
  ]) {
    assert.equal(isSafeUploadKey(bad), false, JSON.stringify(bad));
  }
});

test("readBoundedFormData refuses oversized bodies before parsing them", async () => {
  const form = new FormData();
  form.set("a", "b");
  const req = (headers, body = form) => new Request(SITE, { method: "POST", body, headers, duplex: "half" });

  // A multipart request we can measure, then re-send with explicit headers.
  const probe = req({});
  const ct = probe.headers.get("Content-Type");
  const bytes = new Uint8Array(await probe.arrayBuffer());

  assert.ok((await readBoundedFormData(req({ "Content-Type": ct }, bytes), 1024)).form, "small body parses");
  assert.equal((await readBoundedFormData(req({ "Content-Type": ct }, bytes), 10)).status, 413, "stream over limit");
  assert.equal((await readBoundedFormData(req({ "Content-Type": "application/json" }, "{}"), 1024)).status, 400);

  // Declared length over the limit: refused without reading the body.
  let pulled = 0;
  const endless = new ReadableStream({ pull(c) { pulled++; c.enqueue(new Uint8Array(1024)); } });
  const big = new Request(SITE, {
    method: "POST", body: endless, duplex: "half",
    headers: { "Content-Type": ct, "Content-Length": String(100 * MB) },
  });
  assert.equal((await readBoundedFormData(big, 50 * MB)).status, 413);
  assert.ok(pulled <= 1, "body not consumed");

  // No declared length: a stream that keeps going is cut off at the limit.
  const endless2 = new ReadableStream({ pull(c) { c.enqueue(new Uint8Array(64 * 1024)); } });
  const chunked = new Request(SITE, { method: "POST", body: endless2, duplex: "half", headers: { "Content-Type": ct } });
  assert.equal((await readBoundedFormData(chunked, 1 * MB)).status, 413);

  const badLen = new Request(SITE, { method: "POST", body: bytes, headers: { "Content-Type": ct, "Content-Length": "12abc" } });
  assert.equal((await readBoundedFormData(badLen, 1024)).status, 400);
});

// =====================================================================
// POST /api/gallery-api/upload (integration)
// =====================================================================

test("UPLOAD: requires admin and stores nothing without it", async () => {
  const form = new FormData();
  form.append("Projects/Deck/a.jpg", new File([JPEG], "a.jpg", { type: "image/jpeg" }));
  const res = await call("/api/gallery-api/upload", { method: "POST", body: form });
  assert.equal(res.status, 401);
  assert.deepEqual(await keys(baseEnv.GALLERY_BUCKET), []);
});

test("UPLOAD: valid phone-style images are stored with server-derived types", async () => {
  const res = await upload([
    ["Projects/Deck 2026/IMG_0001.JPG", new File([JPEG_EXIF], "IMG_0001.JPG", { type: "image/jpeg" })],
    ["Projects/Deck 2026/b.png", new File([PNG], "b.png", { type: "" })],
    ["Remodels/Kitchen/c.webp", new File([WEBP], "c.webp", { type: "application/octet-stream" })],
    ["Highlights/d.avif", new File([AVIF], "d.avif", { type: "image/avif" })],
  ]);
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.ok, true);
  assert.equal(body.uploaded, 4);
  assert.deepEqual(body.rejected, []);
  assert.ok(body.urls.every((u) => u.startsWith("https://images.kilcon.work/")));

  const types = {};
  for (const k of await keys(baseEnv.GALLERY_BUCKET)) types[k] = (await baseEnv.GALLERY_BUCKET.head(k)).httpMetadata.contentType;
  assert.deepEqual(types, {
    "Highlights/d.avif": "image/avif",
    "Projects/Deck 2026/IMG_0001.JPG": "image/jpeg",
    "Projects/Deck 2026/b.png": "image/png",
    "Remodels/Kitchen/c.webp": "image/webp",
  });
  const stored = new Uint8Array(await (await baseEnv.GALLERY_BUCKET.get("Projects/Deck 2026/IMG_0001.JPG")).arrayBuffer());
  assert.deepEqual(stored, JPEG_EXIF, "bytes stored unchanged");

  // The stored images are listed by the public gallery as before.
  const gallery = await (await call("/api/gallery-api?project=deck-2026")).json();
  assert.deepEqual(gallery.items.map((i) => i.name).sort(), ["IMG_0001.JPG", "b.png"]);
});

test("UPLOAD: forged, disguised, empty, truncated and oversized files are rejected and never stored", async () => {
  const big = new Uint8Array(25 * MB + 1);
  big.set(JPEG);
  const res = await upload([
    ["Projects/X/empty.jpg", new File([], "empty.jpg", { type: "image/jpeg" })],
    ["Projects/X/svg.jpg", new File([SVG], "svg.jpg", { type: "image/jpeg" })],
    ["Projects/X/svg.png", new File([SVG], "svg.png", { type: "image/svg+xml" })],
    ["Projects/X/html.webp", new File(["<html><script>1</script>"], "html.webp", { type: "image/webp" })],
    ["Projects/X/png-as.jpg", new File([PNG], "png-as.jpg", { type: "image/jpeg" })],
    ["Projects/X/forged.png", new File([PNG], "forged.png", { type: "image/gif" })],
    ["Projects/X/trunc.jpg", new File([JPEG.subarray(0, 8)], "trunc.jpg", { type: "image/jpeg" })],
    ["Projects/X/heic-as.avif", new File([HEIC_HEADER], "heic-as.avif", { type: "image/avif" })],
    ["Projects/X/big.jpg", new File([big], "big.jpg", { type: "image/jpeg" })],
  ]);
  assert.equal(res.status, 400);
  const body = await res.json();
  assert.equal(body.uploaded, 0);
  assert.deepEqual(
    Object.fromEntries(body.rejected.map((r) => [r.name.split("/").pop(), r.reason])),
    {
      "empty.jpg": "empty", "svg.jpg": "not-an-image", "svg.png": "not-an-image", "html.webp": "not-an-image",
      "png-as.jpg": "extension-mismatch", "forged.png": "mime-mismatch", "trunc.jpg": "truncated",
      "heic-as.avif": "not-an-image", "big.jpg": "too-large",
    }
  );
  assert.deepEqual(await keys(baseEnv.GALLERY_BUCKET), []);
});

test("UPLOAD: unsafe paths cannot write review, Facebook or out-of-root objects", async () => {
  const f = () => new File([JPEG], "a.jpg", { type: "image/jpeg" });
  const res = await upload([
    ["Reviews/photos/r_x/a.jpg", f()],
    ["Reviews/data/r_x.json", f()],
    ["Facebook/123.jpg", f()],
    ["Migrations/reviews/a.jpg", f()],
    ["../Projects/a.jpg", f()],
    ["/Reviews/photos/a.jpg", f()],
    ["Projects/../Reviews/photos/a.jpg", f()],
    ["Projects\\..\\Reviews\\a.jpg", f()],
    ["projects/lowercase/a.jpg", f()],
    ["Highlights/nested/a.jpg", f()],
    ["Projects/a.svg", f()],
    ["Projects/x/a.jpg\u0000.png", f()],
    ["Projects/x/‮gpj.jpg", f()],
    ["constructor/a.jpg", f()],
  ]);
  assert.equal(res.status, 400);
  const body = await res.json();
  assert.equal(body.uploaded, 0);
  assert.ok(body.rejected.every((r) => r.reason === "invalid-path"), JSON.stringify(body.rejected));
  assert.deepEqual(await keys(baseEnv.GALLERY_BUCKET), []);
  assert.deepEqual(await keys(baseEnv.PRIVATE_BUCKET), []);
});

test("UPLOAD: a mixed batch stores only the valid files and reports the rest", async () => {
  const res = await upload([
    ["Projects/Mixed/good.jpg", new File([JPEG], "good.jpg", { type: "image/jpeg" })],
    ["Projects/Mixed/bad.jpg", new File([SVG], "bad.jpg", { type: "image/jpeg" })],
  ]);
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.ok, false);
  assert.equal(body.uploaded, 1);
  assert.deepEqual(body.rejected, [{ name: "Projects/Mixed/bad.jpg", reason: "not-an-image" }]);
  assert.deepEqual(await keys(baseEnv.GALLERY_BUCKET), ["Projects/Mixed/good.jpg"]);
});

test("UPLOAD: request size and file count are bounded", async () => {
  // Declared body over the 50 MB request limit is refused before parsing.
  const endless = new ReadableStream({ pull(c) { c.enqueue(new Uint8Array(1024)); } });
  const res = await call("/api/gallery-api/upload", {
    method: "POST", admin: true, body: endless,
    headers: { "Content-Type": "multipart/form-data; boundary=x", "Content-Length": String(60 * MB) },
  });
  assert.equal(res.status, 413);
  assert.equal((await res.json()).maxRequestBytes, 50 * MB);

  const files = Array.from({ length: 51 }, (_, i) => [`Projects/Many/${i}.jpg`, new File([JPEG], `${i}.jpg`, { type: "image/jpeg" })]);
  const many = await (await upload(files)).json();
  assert.equal(many.uploaded, 50);
  assert.deepEqual(many.rejected, [{ name: "Projects/Many/50.jpg", reason: "too-many-files" }]);

  const notMultipart = await call("/api/gallery-api/upload", { method: "POST", admin: true, body: { a: 1 } });
  assert.equal(notMultipart.status, 400);
  assert.deepEqual(await keys(baseEnv.GALLERY_BUCKET, "Reviews/"), []);
});

// =====================================================================
// Review submissions: bounded body, validated photo, private storage
// =====================================================================

async function submitReview(file, { headers = {} } = {}) {
  const form = new FormData();
  form.set("name", "Pat Client");
  form.set("rating", "5");
  form.set("text", "Great work on our deck, the crew was on time and very professional.");
  if (file) form.set("photo", file);
  return call("/api/reviews/submit", { method: "POST", body: form, headers });
}

test("REVIEW SUBMIT: oversized bodies and photos are refused; valid photos stay private", async () => {
  const endless = new ReadableStream({ pull(c) { c.enqueue(new Uint8Array(1024)); } });
  const tooBig = await call("/api/reviews/submit", {
    method: "POST", body: endless,
    headers: { "Content-Type": "multipart/form-data; boundary=x", "Content-Length": String(17 * MB) },
  });
  assert.equal(tooBig.status, 413);

  const htmlTooBig = await call("/api/reviews/submit", {
    method: "POST", body: new ReadableStream({ pull(c) { c.enqueue(new Uint8Array(1024)); } }),
    headers: { "Content-Type": "multipart/form-data; boundary=x", "Content-Length": String(17 * MB), Accept: "text/html" },
  });
  assert.equal(htmlTooBig.status, 303);
  assert.match(htmlTooBig.headers.get("Location"), /\?err=photo#leave-review$/);

  const photo = new Uint8Array(15 * MB + 1);
  photo.set(JPEG);
  assert.equal((await submitReview(new File([photo], "deck.jpg", { type: "image/jpeg" }))).status, 400, "photo over 15 MB");
  assert.equal((await submitReview(new File([JPEG.subarray(0, 8)], "deck.jpg", { type: "image/jpeg" }))).status, 400, "truncated");
  assert.equal((await submitReview(new File([PNG], "deck.png", { type: "image/jpeg" }))).status, 400, "forged MIME");
  assert.deepEqual(await keys(baseEnv.PRIVATE_BUCKET), []);

  assert.equal((await submitReview(new File([JPEG_EXIF], "IMG_1234.JPG", { type: "image/jpeg" }))).status, 200);
  const priv = await keys(baseEnv.PRIVATE_BUCKET);
  assert.equal(priv.length, 2);
  const photoKey = priv.find((k) => k.startsWith("Reviews/photos/"));
  assert.equal((await baseEnv.PRIVATE_BUCKET.head(photoKey)).httpMetadata.contentType, "image/jpeg");
  assert.deepEqual(await keys(baseEnv.GALLERY_BUCKET), [], "nothing public");
});

// =====================================================================
// Review-photo revocation
// =====================================================================

async function seedReview(id, status) {
  const photoKey = `Reviews/photos/${id}/photo.jpg`;
  await baseEnv.PRIVATE_BUCKET.put(photoKey, JPEG, { httpMetadata: { contentType: "image/jpeg" } });
  await baseEnv.PRIVATE_BUCKET.put(`Reviews/data/${id}.json`, JSON.stringify({
    id, status, createdAt: new Date().toISOString(), rating: 5, text: "x".repeat(50),
    clientNameFull: "Pat Client", clientNamePublic: "Pat C.", projectType: "deck", photoKey, photoUrl: null,
  }));
}
const photo = (id, opts) => call(`/api/reviews/photo?id=${id}`, opts);
const setStatus = (id, status) => call("/api/reviews/admin/status", { method: "POST", admin: true, body: { id, status } });

test("REVOCATION: approved photos revalidate on every use; withdrawal takes effect immediately", async () => {
  await seedReview("r_rev_1", "approved");

  const first = await photo("r_rev_1");
  assert.equal(first.status, 200);
  assert.equal(first.headers.get("Cache-Control"), "private, no-cache");
  assert.doesNotMatch(first.headers.get("Cache-Control"), /public|max-age|s-maxage/);
  const etag = first.headers.get("ETag");
  assert.ok(etag, "ETag allows cheap revalidation");
  assert.deepEqual(new Uint8Array(await first.arrayBuffer()), JPEG);

  // Still approved: a revalidation is a body-less 304 with the same protections.
  const again = await photo("r_rev_1", { headers: { "If-None-Match": etag } });
  assert.equal(again.status, 304);
  assert.equal(again.headers.get("Cache-Control"), "private, no-cache");
  assert.equal(again.headers.get("Content-Security-Policy"), "default-src 'none'; sandbox");
  assert.equal((await again.arrayBuffer()).byteLength, 0);

  // Withdrawn: the same conditional request now gets a 404, never a 304.
  assert.equal((await setStatus("r_rev_1", "hidden")).status, 200);
  for (const headers of [{ "If-None-Match": etag }, { "If-None-Match": "*" }, {}]) {
    const gone = await photo("r_rev_1", { headers });
    assert.equal(gone.status, 404, JSON.stringify(headers));
    assert.equal(gone.headers.get("Cache-Control"), "no-store");
  }
  assert.equal((await setStatus("r_rev_1", "pending")).status, 200);
  assert.equal((await photo("r_rev_1", { headers: { "If-None-Match": etag } })).status, 404);

  // The admin can still see it, but it's never stored or revalidated.
  const adminView = await photo("r_rev_1", { admin: true, headers: { "If-None-Match": etag } });
  assert.equal(adminView.status, 200);
  assert.equal(adminView.headers.get("Cache-Control"), "private, no-store");
  assert.equal(adminView.headers.get("ETag"), null);

  // Re-approved: public again.
  await setStatus("r_rev_1", "approved");
  assert.equal((await photo("r_rev_1")).status, 200);
  const list = await (await call("/api/reviews")).json();
  assert.equal(list.reviews[0].photoUrl, "https://kilcon.work/api/reviews/photo?id=r_rev_1");
});

test("REVOCATION: deleting a review removes the photo everywhere and later requests 404", async () => {
  await seedReview("r_rev_2", "approved");
  // A legacy public copy too (pre-migration data).
  await baseEnv.GALLERY_BUCKET.put("Reviews/photos/r_rev_2/photo.jpg", JPEG);
  await baseEnv.GALLERY_BUCKET.put("Reviews/data/r_rev_2.json", "{}");
  const etag = (await photo("r_rev_2")).headers.get("ETag");

  const del = await call("/api/reviews/admin/delete", { method: "POST", admin: true, body: { id: "r_rev_2" } });
  assert.equal(del.status, 200);
  assert.deepEqual(await keys(baseEnv.PRIVATE_BUCKET, "Reviews/"), []);
  assert.deepEqual(await keys(baseEnv.GALLERY_BUCKET, "Reviews/"), []);
  for (const opts of [{}, { headers: { "If-None-Match": etag } }, { admin: true }]) {
    assert.equal((await photo("r_rev_2", opts)).status, 404);
  }
  assert.equal((await (await call("/api/reviews")).json()).total, 0);
});

test("REVOCATION: Image Transformations can't fetch (and cache) review photos", async () => {
  await seedReview("r_rev_3", "approved");
  for (const via of ["1.1 image-resizing", "1.1 Cloudflare-Image-Resizing", "HTTP/1.1 foo, 1.1 image-resizing"]) {
    assert.equal((await photo("r_rev_3", { headers: { Via: via } })).status, 404, via);
    assert.equal((await photo("r_rev_3", { admin: true, headers: { Via: via } })).status, 404, `admin ${via}`);
  }
  assert.equal((await photo("r_rev_3", { headers: { Via: "1.1 some-proxy" } })).status, 200);
});

test("REVOCATION: other gallery responses keep their existing caching", async () => {
  // Public JSON was already no-store; it must not change.
  await baseEnv.GALLERY_BUCKET.put("Projects/Deck/a.jpg", JPEG, { httpMetadata: { contentType: "image/jpeg" } });
  const res = await call("/api/gallery-api?project=deck");
  assert.equal(res.status, 200);
  assert.equal(res.headers.get("Cache-Control"), "no-store");
  const { items } = await res.json();
  assert.equal(items[0].thumb, "https://images.kilcon.work/cdn-cgi/image/width=480,fit=cover,quality=80/Projects/Deck/a.jpg");
});
