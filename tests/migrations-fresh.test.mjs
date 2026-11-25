// Run: npm run test:site
// The full D1 migration chain must apply to a fresh database. Wrangler applies
// migrations/ in file-name order; this replays them on in-memory SQLite.
// (A real local D1 check: `npx wrangler d1 migrations apply kilcon-db --local
// --persist-to <empty dir> --config workers/kilcon-gallery-worker/wrangler.toml`.)
import { test } from "node:test";
import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";

const dir = new URL("../migrations/", import.meta.url);

test("every migration applies to a fresh database, in Wrangler's order", async () => {
  const files = (await readdir(dir)).filter((f) => f.endsWith(".sql")).sort();
  assert.ok(files.length >= 12);
  const db = new DatabaseSync(":memory:");
  db.exec("PRAGMA foreign_keys = ON;");
  for (const f of files) {
    const sql = await readFile(new URL(f, dir), "utf8");
    assert.doesNotThrow(() => db.exec(sql), f);
  }

  // apparel_order_items matches production's columns, in production's order.
  const cols = db.prepare("PRAGMA table_info(apparel_order_items)").all().map((c) => `${c.name} ${c.type}`);
  assert.deepEqual(cols, [
    "id INTEGER", "order_id INTEGER", "stripe_price_id TEXT", "quantity INTEGER",
    "description TEXT", "item_id INTEGER", "size TEXT", "price_cents INTEGER",
  ]);
  const indexes = db.prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'apparel_order_items' AND name NOT LIKE 'sqlite_%' ORDER BY name").all().map((r) => r.name);
  assert.deepEqual(indexes, [
    "idx_apparel_order_items_item_size", "idx_apparel_order_items_order_id",
    "idx_order_items_order", "idx_order_items_price",
  ]);
  db.close();
});
