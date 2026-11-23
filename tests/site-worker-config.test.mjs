// Run: npm run test:site
// Astro 7 site Worker (Workers Static Assets) configuration guardrails.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const read = (p) => readFile(new URL(p, new URL("../", import.meta.url)), "utf8");
const stripComments = (s) => s.replace(/^\s*\/\/.*$/gm, "");
const cfg = JSON.parse(stripComments(await read("wrangler.jsonc")));
const pkg = JSON.parse(await read("package.json"));
const astro = await read("astro.config.mjs");

test("the site Worker can't take traffic by itself: no routes, custom domains, workers.dev or previews", () => {
  for (const k of ["routes", "route", "custom_domain"]) assert.equal(cfg[k], undefined, k);
  assert.equal(cfg.workers_dev, false);
  assert.equal(cfg.preview_urls, false);
  assert.equal(cfg.name, "kilcon-site", "distinct from the Pages project and the other Workers");
  assert.notEqual(cfg.name, "kilcon-gallery-worker");
});

test("bindings and variables mirror the Pages production project", async () => {
  assert.equal(cfg.main, "@astrojs/cloudflare/entrypoints/server");
  assert.deepEqual(cfg.assets, { directory: "./dist", binding: "ASSETS" });
  assert.deepEqual(cfg.d1_databases.map((d) => [d.binding, d.database_name, d.database_id]), [["DB", "kilcon-db", "095cfe7f-d0af-49e8-b92a-942fa093bfe6"]]);
  assert.deepEqual(cfg.r2_buckets.map((b) => [b.binding, b.bucket_name]), [["GALLERY_BUCKET", "kilcon-gallery"]]);
  assert.deepEqual(cfg.services.map((s) => [s.binding, s.service]), [["GALLERY_WORKER", "kilcon-gallery-worker"]]);
  assert.deepEqual(Object.keys(cfg.vars).sort(), ["PAYMENTS_ENABLED", "PUBLIC_CONTACT_ENDPOINT", "PUBLIC_GALLERY_API", "PUBLIC_TURNSTILE_SITE_KEY", "SESSION_VERSION"]);
  assert.equal(cfg.vars.PAYMENTS_ENABLED, "false");
  assert.equal(cfg.kv_namespaces, undefined, "no SESSION KV");
  assert.equal(cfg.triggers, undefined, "no cron on the site Worker");
  assert.doesNotMatch(await read("wrangler.jsonc"), /sk_live_|whsec_|ADMIN_PASS\s*[:=]\s*"/, "no secret values in config");
});

test("Astro config keeps sessions off, the Astro 5 HTML output and the disabled image endpoint", () => {
  assert.match(astro, /session: false,/);
  assert.match(astro, /compressHTML: true,/);
  assert.match(astro, /adapter: cloudflare\(\{ imageService: 'custom' \}\)/);
  assert.match(astro, /entrypoint: '\.\/src\/image-endpoint-disabled\.js'/);
});

test("every Gallery / Contact Worker script passes an explicit --config (the site build's redirect file would otherwise win)", () => {
  for (const [name, cmd] of Object.entries(pkg.scripts)) {
    if (!/wrangler /.test(cmd)) continue;
    assert.match(cmd, /--config (workers\/kilcon-gallery-worker\/wrangler\.toml|workers\/kilcon-contact\/wrangler\.toml|dist\/server\/wrangler\.json)/, name);
  }
  assert.ok(pkg.scripts["gallery-worker:upload"].startsWith("wrangler versions upload"), "Gallery Worker uses versions upload, never wrangler deploy");
  assert.match(pkg.engines.node, />=22\.23\.4/);
});

test("no page reads the removed Astro.locals.runtime API", async () => {
  const { readdir } = await import("node:fs/promises");
  const walk = async (dir, out = []) => {
    for (const e of await readdir(new URL(dir, new URL("../", import.meta.url)), { withFileTypes: true })) {
      const p = `${dir}/${e.name}`;
      if (e.isDirectory()) await walk(p, out);
      else if (/\.(astro|ts)$/.test(e.name)) out.push(p);
    }
    return out;
  };
  for (const f of await walk("src")) {
    const s = (await read(f)).replace(/^\s*\/\/.*$/gm, "");
    assert.doesNotMatch(s, /locals(\s+as\s+any\))?\??\.runtime/, f);
  }
});
