-- Facebook removals → hide, then delete after a retention period (kilcon-gallery-worker)
-- Apply from workers/kilcon-gallery-worker/: npx wrangler d1 migrations apply kilcon-db --remote
-- Adds two nullable columns to facebook_photos; touches no other table.
--
--   hidden_reason  why a photo is hidden: 'admin' (an administrator hid it) or
--                  'removed_on_facebook' (the post/photo was confirmed deleted or
--                  unpublished on Facebook). Only the latter is undone
--                  automatically if the content comes back.
--   purge_after    when a photo hidden for 'removed_on_facebook' is permanently
--                  deleted by the hourly job, unless an administrator restores it.

ALTER TABLE facebook_photos ADD COLUMN hidden_reason TEXT;
ALTER TABLE facebook_photos ADD COLUMN purge_after TEXT;

UPDATE facebook_photos SET hidden_reason = 'admin' WHERE hidden = 1 AND master_key IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_facebook_photos_purge_after
    ON facebook_photos (purge_after);
