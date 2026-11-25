-- 012_order_items_snapshot.sql
-- Snapshot support for order items.
-- NOTE: Columns may already exist if previously applied manually.
--
-- 2026-11-25: production (kilcon-db) received these three columns by a manual
-- ALTER long ago and records 012 as applied in d1_migrations, so it never runs
-- this file again. Wrangler tracks migrations by file name only. The ALTERs
-- below give a fresh database the same table (same column order as
-- production); without them the backfill failed with "no such column: item_id".
-- A local database whose columns were added by hand without recording 012
-- should be recreated rather than migrated.
ALTER TABLE apparel_order_items ADD COLUMN item_id INTEGER;
ALTER TABLE apparel_order_items ADD COLUMN size TEXT;
ALTER TABLE apparel_order_items ADD COLUMN price_cents INTEGER;

-- Keep indexes safe
CREATE INDEX IF NOT EXISTS idx_apparel_order_items_order_id ON apparel_order_items(order_id);
CREATE INDEX IF NOT EXISTS idx_apparel_order_items_item_size ON apparel_order_items(item_id, size);

-- Backfill snapshot fields if they exist and are NULL.
UPDATE apparel_order_items
SET
    item_id = (SELECT v.item_id FROM apparel_variants v WHERE v.stripe_price_id = apparel_order_items.stripe_price_id LIMIT 1),
    size    = (SELECT v.size    FROM apparel_variants v WHERE v.stripe_price_id = apparel_order_items.stripe_price_id LIMIT 1),
    price_cents = (SELECT v.price_cents FROM apparel_variants v WHERE v.stripe_price_id = apparel_order_items.stripe_price_id LIMIT 1)
WHERE
    (item_id IS NULL OR size IS NULL OR price_cents IS NULL);
