// Run: npm run test:site
// Source-level checks that the legal pages Meta's App Settings point at exist,
// are linked site-wide, are in the sitemap, and match what the code does.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const read = (p) => readFile(new URL(`../${p}`, import.meta.url), "utf8");
// Visible text only (drop the frontmatter and HTML comments that hold review notes).
const visible = (src) =>
  src.replace(/^---[\s\S]*?---/, "").replace(/<!--[\s\S]*?-->/g, "").replace(/\s+/g, " ");
const workerToml = () => read("workers/kilcon-gallery-worker/wrangler.toml");
const tomlVar = (toml, name) => new RegExp(`^${name}\\s*=\\s*"([^"]*)"`, "m").exec(toml)?.[1];

test("privacy policy covers Facebook content, reviews, orders, and every service provider", async () => {
  const page = visible(await read("src/pages/privacy.astro"));
  for (const phrase of [
    "Facebook Page", "Pages API", "posts published by our", "posts by others are never imported",
    "Facebook confirms that it is no longer available", "temporary error from Facebook is never treated as a removal",
    "Photos we upload to the website ourselves are not affected", "without the 30-day recovery period",
    "until they are no longer needed or you ask us to delete them", "fulfillment, accounting, and applicable legal obligations",
    "does not offer Facebook Login", "Cloudflare", "Resend", "Stripe", "Meta (Facebook)", "Turnstile",
    "Review records and photos are kept in private storage", "do not receive or store your card details",
    "not saved in the website's own database", "first name and last initial",
    'href="/data-deletion"', "kil.con.contact@gmail.com", "We do not sell personal information",
  ]) {
    assert.ok(page.includes(phrase), `privacy policy mentions: ${phrase}`);
  }
  // Claims the code can't back up must not come back.
  // Claims that would only be true after launch, or that the code doesn't support.
  for (const phrase of ["never sold or shared", "provide estimates", "unless we choose to keep", "Our project galleries include"]) {
    assert.ok(!page.includes(phrase), `privacy policy avoids: ${phrase}`);
  }
});

test("the Facebook-removal recovery period never exceeds what the policy states", async () => {
  const page = visible(await read("src/pages/privacy.astro"));
  const promised = Number(/private copy for up to (\d+) days/.exec(page)?.[1]);
  assert.equal(promised, 30);
  assert.ok(page.includes(`no more than ${promised} days`));
  const configured = Number(tomlVar(await workerToml(), "FB_REMOVED_RETENTION_DAYS"));
  const { removedRetentionDays } = await import("../workers/kilcon-gallery-worker/src/facebook.js");
  assert.ok(removedRetentionDays({ FB_REMOVED_RETENTION_DAYS: String(configured) }) <= promised);
  assert.ok(removedRetentionDays({ FB_REMOVED_RETENTION_DAYS: "365" }) <= promised, "code caps it");
});

test("data deletion page gives instructions, covers stored data, and never claims to delete from Facebook", async () => {
  const page = visible(await read("src/pages/data-deletion.astro"));
  for (const phrase of [
    "Data deletion request", "kil.con.contact@gmail.com", "Project photos from our Facebook Page",
    "so the photo is not copied to the website again", "does not apply to deletion requests",
    "Reviews", "Contact messages", "Apparel orders",
    "What We Cannot Delete", "does not remove it from Facebook", "does not use Facebook Login", 'href="/privacy"',
  ]) {
    assert.ok(page.includes(phrase), `data deletion page mentions: ${phrase}`);
  }
  assert.ok(!/delete (it|them|content|posts?) (from|on) (our )?Facebook/i.test(page.replace("does not remove it from Facebook", "")));
});

test("terms of use link to the privacy policy and data deletion page", async () => {
  const page = visible(await read("src/pages/terms.astro"));
  for (const phrase of ['href="/privacy"', 'href="/data-deletion"', "Reviews and Photos You Submit", "Wisconsin"]) {
    assert.ok(page.includes(phrase), `terms mention: ${phrase}`);
  }
});

test("legal pages are linked in the footer and listed in the sitemap", async () => {
  const layout = await read("src/layout/MainLayout.astro");
  const sitemap = await read("src/pages/sitemap.xml.ts");
  for (const path of ["/privacy", "/terms", "/data-deletion"]) {
    assert.ok(layout.includes(`href="${path}"`), `footer links ${path}`);
    assert.ok(sitemap.includes(`"${path}"`), `sitemap lists ${path}`);
  }
});

test("no review placeholders or owner notes leak into visible legal text", async () => {
  for (const p of ["src/pages/privacy.astro", "src/pages/data-deletion.astro", "src/pages/terms.astro"]) {
    const page = visible(await read(p));
    assert.ok(!/OWNER|TODO|TBD|\[[A-Z ]+\]|lorem/i.test(page), `${p} has no placeholders`);
  }
});

test("Worker is configured with the confirmed Meta App ID and Page ID, imports off", async () => {
  const toml = await workerToml();
  assert.equal(tomlVar(toml, "FB_APP_ID"), "1427044999395408");
  assert.equal(tomlVar(toml, "FB_PAGE_ID"), "305397115992497");
  assert.equal(tomlVar(toml, "FB_INTEGRATION_ENABLED"), "true");
  assert.equal(tomlVar(toml, "FB_AUTO_IMPORT"), "false");
  for (const secret of ["FB_APP_SECRET", "FB_VERIFY_TOKEN", "FB_PAGE_ACCESS_TOKEN"]) {
    assert.ok(!new RegExp(`^${secret}\\s*=`, "m").test(toml), `${secret} is not a plaintext var`);
  }
});

test("all three legal pages carry the same, valid, non-future Last updated date", async () => {
  const dates = [];
  for (const p of ["src/pages/privacy.astro", "src/pages/data-deletion.astro", "src/pages/terms.astro"]) {
    const src = await read(p);
    const d = /const LAST_UPDATED = "([^"]+)"/.exec(src)?.[1];
    assert.ok(d, `${p} defines LAST_UPDATED`);
    assert.ok(src.includes("Last updated: {LAST_UPDATED}"), `${p} renders it`);
    const t = Date.parse(d);
    assert.ok(Number.isFinite(t) && t <= Date.now(), `${p}: ${d} is a real, non-future date`);
    dates.push(d);
  }
  assert.equal(new Set(dates).size, 1, `dates match: ${dates.join(", ")}`);
});

test("privacy policy does not imply Meta receives website data, and deletion follows verification", async () => {
  const page = visible(await read("src/pages/privacy.astro"));
  assert.ok(page.includes("Meta is the source of the Facebook Page content we import"));
  assert.ok(page.includes("does not send visitors' information to Meta"));
  assert.ok(!page.includes("We share information only with the service providers"));
  assert.ok(page.includes("once we have verified your request"));
  const del = visible(await read("src/pages/data-deletion.astro"));
  assert.ok(del.includes("once your request is verified"));
  assert.ok(!/within \d+ days|immediately upon receipt/i.test(page + del), "no response-time promise");
});
