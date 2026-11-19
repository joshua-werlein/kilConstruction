// Run: npm run test:site
// The Astro /_image endpoint must not proxy or transform anything (see
// src/image-endpoint-disabled.js), and the admin upload page must batch within
// the Gallery Worker's limits.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile, readdir, access } from "node:fs/promises";

const root = new URL("../", import.meta.url);
const read = (p) => readFile(new URL(p, root), "utf8");

async function walk(dir, out = []) {
  for (const e of await readdir(new URL(dir, root), { withFileTypes: true })) {
    const p = `${dir}/${e.name}`;
    if (e.isDirectory()) await walk(p, out);
    else out.push(p);
  }
  return out;
}

test("astro.config keeps the adapter from installing its /_image proxy", async () => {
  const cfg = await read("astro.config.mjs");
  assert.match(cfg, /cloudflare\(\{\s*imageService:\s*'custom'\s*\}\)/);
  assert.match(cfg, /service:\s*passthroughImageService\(\)/);
  assert.match(cfg, /endpoint:\s*\{\s*route:\s*'\/_image',\s*entrypoint:\s*'\.\/src\/image-endpoint-disabled\.js'\s*\}/);
});

test("the /_image replacement answers 404 for every request and never fetches", async () => {
  const realFetch = globalThis.fetch;
  let fetched = 0;
  globalThis.fetch = async () => { fetched++; throw new Error("must not fetch"); };
  try {
    const mod = await import(new URL("src/image-endpoint-disabled.js", root));
    assert.equal(mod.prerender, false);
    assert.deepEqual(Object.keys(mod).sort(), ["ALL", "prerender"], "one handler for every method");
    for (const href of ["/robots.txt", "/api/reviews/photo?id=r_x", "https://images.kilcon.work/Reviews/photos/a.jpg", "//evil.example/a", ""]) {
      for (const method of ["GET", "HEAD", "POST"]) {
        const request = new Request(`https://kilcon.work/_image?href=${encodeURIComponent(href)}&w=100&f=svg`, { method, headers: { Cookie: "admin_auth=x" } });
        const res = await mod.ALL({ request, url: new URL(request.url) });
        assert.equal(res.status, 404, `${method} ${href}`);
        assert.equal(res.headers.get("Cache-Control"), "no-store");
        assert.equal(res.headers.get("Content-Type"), "text/plain; charset=utf-8");
      }
    }
    assert.equal(fetched, 0);
  } finally {
    globalThis.fetch = realFetch;
  }
});

test("no page uses astro:assets, so nothing depends on Astro image transforms", async () => {
  // If this fails, someone started using <Image>/<Picture>/getImage(): those
  // need a real image endpoint, so revisit astro.config.mjs first.
  const files = (await walk("src")).filter((p) => /\.(astro|ts|tsx|js|mjs|md|mdx)$/.test(p));
  for (const p of files) {
    const src = await read(p);
    assert.ok(!/from\s+["']astro:assets["']/.test(src), `${p} imports astro:assets`);
  }
});

test("the built /_image module (if a build exists) contains no proxy code", async (t) => {
  const built = "dist/_worker.js/pages/_image.astro.mjs";
  try {
    await access(new URL(built, root));
  } catch {
    t.skip("no build output; run npm run build first");
    return;
  }
  const src = await read(built);
  assert.ok(src.includes('new Response("Not found", { status: 404'), "disabled endpoint is bundled");
  assert.ok(!/\bfetch\(/.test(src), "no fetch");
  assert.ok(!/searchParams\.get\(["']href/.test(src), "never reads href");
  const chunks = await readdir(new URL("dist/_worker.js/chunks/", root));
  assert.ok(!chunks.some((c) => /^(image-endpoint|sharp)_/.test(c)), "stock image endpoint / sharp not bundled");
});

test("admin upload batching stays within the Gallery Worker limits", async () => {
  const worker = await read("workers/kilcon-gallery-worker/src/index.js");
  const client = await read("src/pages/admin/upload-script.ts");
  const plan = await import(new URL("src/lib/upload-batching.js", root));
  const mb = (src, name) => {
    const m = new RegExp(`const ${name}\\s*=\\s*(\\d+)\\s*\\*\\s*1024\\s*\\*\\s*1024`).exec(src);
    assert.ok(m, `${name} defined`);
    return Number(m[1]) * 1024 * 1024;
  };
  const num = (src, name) => Number(new RegExp(`const ${name}\\s*=\\s*(\\d+);`).exec(src)?.[1]);

  assert.equal(plan.MAX_FILE_BYTES, mb(worker, "MAX_GALLERY_UPLOAD_FILE_BYTES"), "same per-file limit");
  // Worst case request: a full target batch, or one maximum file alone.
  assert.ok(Math.max(plan.BATCH_TARGET_BYTES, plan.MAX_FILE_BYTES) < mb(worker, "MAX_GALLERY_UPLOAD_REQUEST_BYTES"));
  assert.ok(plan.BATCH_MAX_FILES <= num(worker, "MAX_GALLERY_UPLOAD_FILES"));
  assert.match(client, /planUploadBatches\(/, "the page uses the tested planner");
  // Results are rendered with escaping, not raw server strings.
  assert.match(client, /escapeHtml\(u\)/);
  assert.match(client, /escapeHtml\(r\.name\)/);
});
