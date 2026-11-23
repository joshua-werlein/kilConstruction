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
  assert.deepEqual(Object.keys(cfg.vars).sort(), ["PUBLIC_CONTACT_ENDPOINT", "PUBLIC_GALLERY_API", "PUBLIC_TURNSTILE_SITE_KEY", "SESSION_VERSION"]);
  assert.equal(cfg.vars.SESSION_VERSION, "3", "same session version as Pages and the Gallery Worker");
  assert.equal(cfg.kv_namespaces, undefined, "no SESSION KV");
  assert.equal(cfg.triggers, undefined, "no cron on the site Worker");
  assert.deepEqual(cfg.ratelimits, [{ name: "LOGIN_LIMITER", namespace_id: "1004", simple: { limit: 5, period: 60 } }],
    "admin login limiter; its own namespace (1001-1003 are the Gallery and Contact Workers')");
  const raw = await read("wrangler.jsonc");
  assert.doesNotMatch(raw, /sk_live_|sk_test_|whsec_|ADMIN_PASS\s*[:=]\s*"/, "no secret values in config");
  assert.doesNotMatch(stripComments(raw), /STRIPE|PAYMENTS_ENABLED/, "no Stripe configuration: online payments are retired");
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

test("pages use the production public values in production builds", async () => {
  const cfgSrc = await read("src/config/publicConfig.ts");
  assert.match(cfgSrc, /PROD_TURNSTILE_SITE_KEY = "0x4AAAAAAB_kYYCq8dRwlAsE"/);
  assert.match(cfgSrc, /PROD_CONTACT_ENDPOINT = "https:\/\/kilcon\.work\/api\/contact"/);
  assert.match(cfgSrc, /export const TURNSTILE_SITE_KEY: string = import\.meta\.env\.DEV\n/);
  assert.match(cfgSrc, /export const CONTACT_ENDPOINT: string = import\.meta\.env\.DEV\n/);
  assert.match(await read("src/pages/reviews.astro"), /const SITEKEY = TURNSTILE_SITE_KEY;/);
});

test("the deploy script refuses builds that carry a local .env", async () => {
  const { mkdtemp, mkdir, writeFile, rm } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { pathToFileURL } = await import("node:url");
  const { checkSiteBuild } = await import("../scripts/check-site-build.mjs");
  const dir = await mkdtemp(join(tmpdir(), "kil-build-check-"));
  try {
    const url = pathToFileURL(dir + "/");
    await mkdir(join(dir, "server", "chunks"), { recursive: true });
    await mkdir(join(dir, "client"), { recursive: true });
    await writeFile(join(dir, "server", "wrangler.json"), "{}");
    await writeFile(join(dir, "server", "chunks", "contact.mjs"), 'action="https://kilcon.work/api/contact" data-sitekey="0x4AAAAAAB_kYYCq8dRwlAsE"');
    assert.deepEqual(await checkSiteBuild(url), [], "a clean production build passes");

    await writeFile(join(dir, "server", "entry.mjs"), '"PUBLIC_TURNSTILE_SITE_KEY": "1x00000000000000000000AA", "PUBLIC_CONTACT_ENDPOINT": "http://127.0.0.1:8787/api/contact"');
    await writeFile(join(dir, "server", ".dev.vars"), "X=1");
    const problems = await checkSiteBuild(url);
    assert.ok(problems.some((p) => /\.dev\.vars exists/.test(p)));
    assert.ok(problems.some((p) => /dist\/server\/entry\.mjs contains a local development value/.test(p)));
    assert.ok(problems.every((p) => !/1x0|127\.0\.0\.1|X=1/.test(p)), "never prints values");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
  const pkg = JSON.parse(await read("package.json"));
  for (const s of ["site:deploy", "site:dry-run"]) {
    assert.match(pkg.scripts[s], /^astro build && node scripts\/check-site-build\.mjs && wrangler deploy/, s);
  }
});

test("admin login: durable rate limit before credentials are read; no text echoed from the URL", async () => {
  const page = await read("src/pages/admin.astro");
  const limitAt = page.indexOf("limiter.limit({ key: `admin-login:${ip}` })");
  assert.ok(limitAt > 0, "uses the LOGIN_LIMITER binding");
  assert.ok(limitAt < page.indexOf("Astro.request.formData()"), "limits before reading credentials");
  assert.match(page, /status: 429/);
  assert.doesNotMatch(page, /searchParams\.get\("error"\)/, "login errors are fixed messages only");
});
