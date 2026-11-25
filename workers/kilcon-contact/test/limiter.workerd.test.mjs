// The Contact Worker's Durable Object rate limiter in the real runtime: Wrangler's
// unstable_startWorker runs workers/kilcon-contact/wrangler.toml (DO binding and
// SQLite migration included) in workerd. Requests carry no Turnstile token, so an
// accepted request ends at "captcha" (403) and nothing is ever sent.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { unstable_startWorker } from "wrangler";

const CONFIG = fileURLToPath(new URL("../wrangler.toml", import.meta.url));
const dirs = [];
after(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); });
const tempDir = () => { const d = mkdtempSync(join(tmpdir(), "kil-limiter-")); dirs.push(d); return d; };

async function start({ windowMs, persist = tempDir() } = {}) {
  const bindings = windowMs ? { RATE_LIMIT_WINDOW_MS: { type: "plain_text", value: String(windowMs) } } : {};
  const worker = await unstable_startWorker({
    config: CONFIG,
    bindings,
    dev: { server: { port: 0 }, inspector: false, persist, logLevel: "none" },
  });
  await worker.ready;
  return Object.assign(worker, { persist });
}

// Wrangler dev rewrites a kilcon.work Origin to its own host, so the request
// targets that host directly; the Origin check itself is covered in contact.test.mjs.
const post = (worker, ip) => worker.fetch("http://127.0.0.1/api/contact", {
  method: "POST",
  headers: { "content-type": "application/x-www-form-urlencoded", Accept: "application/json",
    Origin: "https://kilcon.work", "CF-Connecting-IP": ip },
  body: new URLSearchParams({ name: "Rate Check", email: "check@example.com", message: "rate limiter test, ignore" }),
});
const status = async (r) => { await r.arrayBuffer(); return r.status; };
const burst = async (worker, ip, n) => { const out = []; for (let i = 0; i < n; i++) out.push(await status(await post(worker, ip))); return out; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Limiter rows left on disk, across every Durable Object SQLite file. */
function storedRows(persist) {
  const files = [];
  const walk = (d) => { for (const e of readdirSync(d, { withFileTypes: true })) {
    const p = join(d, e.name);
    if (e.isDirectory()) walk(p); else if (/ContactRateLimiter/.test(p) && p.endsWith(".sqlite")) files.push(p);
  } };
  walk(persist);
  let rows = 0;
  for (const f of files) {
    const db = new DatabaseSync(f, { readOnly: true });
    try {
      const t = db.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE type = 'table' AND name = 'hits'").get().n;
      if (t) rows += db.prepare("SELECT COUNT(*) AS n FROM hits").get().n;
    } finally { db.close(); }
  }
  return { files: files.length, rows };
}

test("sequential: requests 1-3 pass the limiter, 4-8 are 429 with Retry-After", async () => {
  const w = await start();
  try {
    assert.deepEqual(await burst(w, "198.51.100.1", 8), [403, 403, 403, 429, 429, 429, 429, 429]);
    const r = await post(w, "198.51.100.1");
    assert.equal(r.status, 429);
    const retry = Number(r.headers.get("retry-after"));
    assert.ok(retry >= 1 && retry <= 60, `retry-after ${retry}`);
    assert.deepEqual(await r.json(), { ok: false, error: "rate" });
  } finally { await w.dispose(); }
});

test("concurrent: 12 simultaneous requests from one IP admit exactly 3", async () => {
  const w = await start();
  try {
    const codes = await Promise.all(Array.from({ length: 12 }, async () => status(await post(w, "198.51.100.2"))));
    assert.equal(codes.filter((c) => c === 403).length, 3, codes.join(","));
    assert.equal(codes.filter((c) => c === 429).length, 9, codes.join(","));
  } finally { await w.dispose(); }
});

test("independent clients: one exhausted IP does not affect another; one IPv6 /64 is one client", async () => {
  const w = await start();
  try {
    assert.deepEqual(await burst(w, "198.51.100.3", 4), [403, 403, 403, 429]);
    assert.deepEqual(await burst(w, "198.51.100.4", 4), [403, 403, 403, 429]);
    assert.deepEqual(await burst(w, "2001:db8:1:2::a", 2), [403, 403]);
    assert.deepEqual(await burst(w, "2001:db8:1:2::b", 2), [403, 429], "same /64 shares the budget");
    assert.deepEqual(await burst(w, "2001:db8:1:3::a", 1), [403], "another /64 is another client");
  } finally { await w.dispose(); }
});

test("rolling window: capacity returns as each accepted request ages out", async () => {
  const w = await start({ windowMs: 2000 });
  try {
    const ip = "198.51.100.5";
    assert.deepEqual(await burst(w, ip, 2), [403, 403]);
    await sleep(1000);
    assert.deepEqual(await burst(w, ip, 2), [403, 429], "3 in the window, the 4th refused");
    await sleep(1200); // the first two have aged out, the third has not
    assert.deepEqual(await burst(w, ip, 3), [403, 403, 429]);
  } finally { await w.dispose(); }
});

test("expiration: once the window passes, the alarm leaves no stored rows", async () => {
  const w = await start({ windowMs: 800 });
  try {
    const ip = "198.51.100.6";
    assert.deepEqual(await burst(w, ip, 4), [403, 403, 403, 429]);
    assert.equal(storedRows(w.persist).rows, 3, "only the 3 accepted timestamps are stored");
    await sleep(2500);
    assert.equal(storedRows(w.persist).rows, 0, "the alarm wiped the object");
    assert.deepEqual(await burst(w, ip, 1), [403], "a fresh window afterwards");
  } finally { await w.dispose(); }
});

test("restart persistence: the count survives a runtime restart", async () => {
  const persist = tempDir();
  let w = await start({ persist });
  try { assert.deepEqual(await burst(w, "198.51.100.7", 3), [403, 403, 403]); }
  finally { await w.dispose(); }
  w = await start({ persist });
  try { assert.deepEqual(await burst(w, "198.51.100.7", 2), [429, 429], "still limited after restart"); }
  finally { await w.dispose(); }
});
