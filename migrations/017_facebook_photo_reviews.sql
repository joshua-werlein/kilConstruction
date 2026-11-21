-- Owner review decisions for historical Facebook photos (admin review page).
-- A row is a decision only; it never imports anything by itself.
--   import  photo may be imported by the historical import
--   skip    duplicate or unwanted; never imported by any path
--   later   undecided; excluded like an unreviewed photo
-- Photos without a row are unreviewed and excluded from the historical import.
CREATE TABLE IF NOT EXISTS facebook_photo_reviews (
    fb_photo_id  TEXT PRIMARY KEY,
    album_id     TEXT,
    decision     TEXT NOT NULL,
    duplicate_of TEXT,
    note         TEXT,
    decided_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
    updated_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
    CHECK (decision IN ('import','skip','later'))
);

CREATE INDEX IF NOT EXISTS idx_facebook_photo_reviews_album
    ON facebook_photo_reviews (album_id, decision);
