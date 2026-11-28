// Offline check of docs/waf-private-file-rule.txt (the proposed Cloudflare custom rule).
//
// It parses the expression's host set, path set and wildcard patterns and evaluates them with
// Cloudflare's semantics: `in {}` is an exact match on the lower-cased path, and `wildcard` is
// case-insensitive, with `*` matching any run of characters, including `/`. Cloudflare's own
// editor is the authority; this only catches false positives and missed probes before the
// draft is pasted into the dashboard.
//
// Usage: node scripts/check-waf-rule.mjs [r2-keys.txt]
//   Fails when a probe isn't blocked, a control is blocked, or any built asset in dist/,
//   page route in src/pages/, or listed R2 key (served on images.kilcon.work) would be blocked.
import { readFileSync, readdirSync, statSync, existsSync } from "node:fs";
import { join, relative, sep } from "node:path";

const root = new URL("..", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1");
const expr = readFileSync(join(root, "docs/waf-private-file-rule.txt"), "utf8");

const sets = [...expr.matchAll(/\{([^}]*)\}/g)].map((m) => [...m[1].matchAll(/"([^"]*)"/g)].map((x) => x[1]));
const [hosts, paths] = sets;
const wildcards = [...expr.matchAll(/wildcard "([^"]*)"/g)].map((m) => m[1]);
const exclusion = expr.match(/not starts_with\(lower\(http\.request\.uri\.path\), "([^"]*)"\)/)[1];

const wildcardRe = (p) =>
  new RegExp("^" + p.split("*").map((s) => s.replace(/[.+?^${}()|[\]\\]/g, "\\$&")).join(".*") + "$", "is");
const wildcardRes = wildcards.map((w) => [w, wildcardRe(w)]);

export function blocked(host, path) {
  if (!hosts.includes(host.toLowerCase())) return null;
  const lp = path.toLowerCase();
  if (lp.startsWith(exclusion)) return null;
  if (paths.includes(lp)) return `in {${lp}}`;
  for (const [w, re] of wildcardRes) if (re.test(path)) return `wildcard ${w}`;
  return null;
}

const H = ["kilcon.work", "www.kilcon.work", "images.kilcon.work"];
const probes = [
  "/.env", "/.ENV", "/.env.production", "/.env.local", "/admin/.env", "/api/.env", "/Facebook/.env",
  "/.dev.vars", "/.dev.vars.production", "/.git", "/.git/config", "/.git/HEAD", "/x/.git/index",
  "/.svn/entries", "/.gitignore", "/wrangler.toml", "/wrangler.jsonc", "/wrangler.json", "/WRANGLER.TOML",
  "/.wrangler/state/v3/d1/x.sqlite", "/astro.config.mjs", "/package.json", "/package-lock.json",
  "/tsconfig.json", "/vite.config.ts", "/migration-014-baseline.json", "/fbvt.tmp", "/nul", "/CNAME",
  "/backup.sql", "/dump.sql", "/database.sqlite", "/x/db.sqlite3", "/backups/kilcon.sql.gz",
  "/Projects/old.bak", "/.DS_Store", "/.npmrc", "/.htaccess", "/.vscode/settings.json",
  "/node_modules/.package-lock.json", "/dist/server/wrangler.json", "/migrations/012_order_items_snapshot.sql",
  "/_astro/index.abc123.js.map", "/error.log", "/.assetsignore", "/.astro/types.d.ts",
];
const controls = [
  ["kilcon.work", "/"], ["kilcon.work", "/.well-known/security.txt"], ["kilcon.work", "/.well-known/.env"],
  ["kilcon.work", "/contact"], ["kilcon.work", "/reviews"], ["kilcon.work", "/projects"], ["kilcon.work", "/admin"],
  ["kilcon.work", "/admin/dashboard"], ["kilcon.work", "/admin/logout"], ["kilcon.work", "/apparel"],
  ["kilcon.work", "/sitemap.xml"], ["kilcon.work", "/robots.txt"], ["kilcon.work", "/manifest.webmanifest"],
  ["kilcon.work", "/KIL-Construction.vcf"], ["kilcon.work", "/llms.txt"], ["kilcon.work", "/favicon.svg"],
  ["kilcon.work", "/api/contact"], ["www.kilcon.work", "/api/contact"], ["kilcon.work", "/api/reviews"],
  ["kilcon.work", "/api/reviews/summary"], ["kilcon.work", "/api/reviews/submit"], ["kilcon.work", "/api/reviews/photo"],
  ["kilcon.work", "/api/reviews/admin/list"], ["kilcon.work", "/api/gallery-api"],
  ["kilcon.work", "/api/gallery-api/upload"], ["kilcon.work", "/api/gallery-api/facebook/webhook"],
  ["kilcon.work", "/api/stripe/checkout"], ["kilcon.work", "/api/stripe/webhook"], ["kilcon.work", "/api/csp-report"],
  ["kilcon.work", "/api/item"], ["kilcon.work", "/api/admin/apparel/variants.save"],
  ["kilcon.work", "/cdn-cgi/challenge-platform/scripts/jsd/main.js"],
  ["kilcon.work", "/cdn-cgi/image/width=480/https://images.kilcon.work/Projects/a.jpg"],
  ["images.kilcon.work", "/Facebook/122238483596318503.jpg"], ["images.kilcon.work", "/Facebook/w/480/1.jpg"],
  ["images.kilcon.work", "/Projects/D. Dahl Porch/1_LP_Siding_1.jpg"], ["images.kilcon.work", "/New Construction/a.webp"],
  ["images.kilcon.work", "/cdn-cgi/image/width=480,fit=cover,quality=80/Projects/D.%20Dahl%20Porch/1.jpg"],
  ["images.kilcon.work", "/Reviews/r_x/photo.jpg"], ["www.kilcon.work", "/"],
  ["other.example", "/.env"],
];

const fail = [];
for (const h of H) for (const p of probes) if (!blocked(h, p)) fail.push(`probe not blocked: ${h}${p}`);
for (const [h, p] of controls) {
  const why = blocked(h, p);
  if (why) fail.push(`control blocked: ${h}${p} (${why})`);
}

const walk = (d) => readdirSync(d).flatMap((n) => (statSync(join(d, n)).isDirectory() ? walk(join(d, n)) : [join(d, n)]));
let assets = 0, routes = 0, keys = 0;
const dist = join(root, "dist/client");
const assetDir = existsSync(dist) ? dist : join(root, "dist");
if (existsSync(assetDir)) {
  for (const f of walk(assetDir)) {
    const p = "/" + relative(assetDir, f).split(sep).join("/");
    if (p.startsWith("/server/")) continue; // not served: dist/server is the Worker bundle
    if (p === "/.assetsignore") continue; // read by Wrangler at upload, never served (live: 404)
    assets++;
    for (const h of H) { const why = blocked(h, p); if (why) fail.push(`built asset blocked: ${h}${p} (${why})`); }
  }
}
for (const f of walk(join(root, "src/pages"))) {
  const r = "/" + relative(join(root, "src/pages"), f).split(sep).join("/").replace(/\.(astro|ts|js|md)$/, "").replace(/\/index$/, "");
  routes++;
  const why = blocked("kilcon.work", r);
  if (why) fail.push(`page route blocked: ${r} (${why})`);
}
const keyFile = process.argv[2];
if (keyFile) {
  for (const k of readFileSync(keyFile, "utf8").split(/\r?\n/).filter(Boolean)) {
    keys++;
    const why = blocked("images.kilcon.work", "/" + k);
    if (why) fail.push(`R2 key blocked: /${k} (${why})`);
  }
}

console.log(`hosts ${hosts.length}, exact paths ${paths.length}, wildcards ${wildcards.length}, expression ${expr.trim().length} chars`);
console.log(`probes ${probes.length * H.length}, controls ${controls.length}, built assets ${assets}, page routes ${routes}, R2 keys ${keys}`);
if (fail.length) { console.log(fail.join("\n")); process.exit(1); }
console.log("OK: every probe blocked; no control, asset, route or key blocked");
