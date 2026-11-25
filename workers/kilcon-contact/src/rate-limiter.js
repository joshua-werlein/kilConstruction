// Authoritative contact rate limiter: a SQLite-backed Durable Object (Workers Free).
//
// One object per client key (see limiterKey). Every request for that key, from any
// Cloudflare location, reaches the same single object, so the count is exact.
// hit() runs synchronous SQLite statements with no await between reading and
// writing, so concurrent requests cannot interleave: at most LIMIT are accepted
// per rolling WINDOW_MS.
//
// Stored data: only the timestamps of accepted requests from the last window (at
// most LIMIT rows). The client IP is never stored: it only selects the object
// (idFromName hashes it). An alarm wipes the object once its window has passed,
// so an idle client leaves nothing behind.

import { DurableObject } from "cloudflare:workers";

export const LIMIT = 3;
export const WINDOW_MS = 60_000;

/**
 * Window length. Production always uses 60 s; tests may shorten it with the
 * RATE_LIMIT_WINDOW_MS variable (wrangler.toml must never set it).
 */
export function windowMs(env) {
  const n = Number(env?.RATE_LIMIT_WINDOW_MS);
  return Number.isInteger(n) && n >= 200 && n <= WINDOW_MS ? n : WINDOW_MS;
}

export class ContactRateLimiter extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.window = windowMs(env);
  }

  /** The table, recreated after an alarm's deleteAll() in a still-running instance. */
  table() {
    const sql = this.ctx.storage.sql;
    sql.exec("CREATE TABLE IF NOT EXISTS hits (ts INTEGER NOT NULL)");
    return sql;
  }

  /** Records one request. {ok:true, remaining} or {ok:false, retryAfter} (seconds). */
  async hit() {
    const sql = this.table();
    const now = Date.now();
    sql.exec("DELETE FROM hits WHERE ts <= ?", now - this.window);
    const { n, oldest } = sql.exec("SELECT COUNT(*) AS n, MIN(ts) AS oldest FROM hits").one();
    if (n >= LIMIT) {
      return { ok: false, retryAfter: Math.max(1, Math.ceil((oldest + this.window - now) / 1000)) };
    }
    sql.exec("INSERT INTO hits (ts) VALUES (?)", now);
    // Expire everything one window after the newest accepted request.
    await this.ctx.storage.setAlarm(now + this.window);
    return { ok: true, remaining: LIMIT - n - 1 };
  }

  async alarm() {
    const sql = this.table();
    const now = Date.now();
    sql.exec("DELETE FROM hits WHERE ts <= ?", now - this.window);
    const { n, newest } = sql.exec("SELECT COUNT(*) AS n, MAX(ts) AS newest FROM hits").one();
    if (n > 0) {
      await this.ctx.storage.setAlarm(newest + this.window);
      return;
    }
    // Compatibility date < 2026-02-24: deleteAll() does not remove alarms by itself.
    await this.ctx.storage.deleteAlarm();
    await this.ctx.storage.deleteAll();
  }

  /** Rows currently stored (tests and diagnostics only; not reachable from the internet). */
  async size() {
    const sql = this.ctx.storage.sql;
    const table = sql.exec("SELECT COUNT(*) AS n FROM sqlite_master WHERE type = 'table' AND name = 'hits'").one().n;
    const rows = table ? sql.exec("SELECT COUNT(*) AS n FROM hits").one().n : 0;
    return { table: table === 1, rows, alarm: await this.ctx.storage.getAlarm() };
  }
}

/**
 * The client key. IPv4: the address. IPv6: its /64 prefix, because one client
 * usually holds a whole /64 and could otherwise rotate addresses freely.
 */
export function limiterKey(ip) {
  const raw = String(ip || "").trim().toLowerCase();
  if (!raw.includes(":")) return `v4:${raw || "unknown"}`;
  const [head, tail = ""] = raw.split("::");
  const h = head ? head.split(":") : [];
  const t = raw.includes("::") ? (tail ? tail.split(":") : []) : [];
  const groups = raw.includes("::") ? [...h, ...Array(Math.max(0, 8 - h.length - t.length)).fill("0"), ...t] : h;
  const prefix = groups.slice(0, 4).map((g) => (parseInt(g, 16) || 0).toString(16));
  return `v6:${prefix.join(":")}::/64`;
}
