-- Facebook Page → gallery sync (kilcon-gallery-worker)
-- Apply from workers/kilcon-gallery-worker/: npx wrangler d1 migrations apply kilcon-db --remote
-- (records it in d1_migrations like 00X–012; do not use `d1 execute --file`)
-- Idempotent (IF NOT EXISTS); touches no existing tables.

-- one row per distinct Page `feed` change; dedupe_key = sha256(page|field|value)
CREATE TABLE IF NOT EXISTS facebook_webhook_events (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    dedupe_key  TEXT NOT NULL UNIQUE,
    page_id     TEXT NOT NULL,
    field       TEXT NOT NULL,
    item        TEXT,
    verb        TEXT,
    post_id     TEXT,
    photo_id    TEXT,
    payload     TEXT NOT NULL,
    status      TEXT NOT NULL DEFAULT 'pending',
    attempts    INTEGER NOT NULL DEFAULT 0,
    last_error  TEXT,
    received_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
    updated_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
    CHECK (status IN ('pending','processing','retry','done','ignored','failed'))
);

CREATE INDEX IF NOT EXISTS idx_facebook_webhook_events_status
    ON facebook_webhook_events (status, id);

-- website galleries built from Facebook content
--   kind 'recent'        the single "Recent Project Updates" collection
--   linked_prefix        set → photos merge into an existing manual R2 gallery
--   hidden / name_locked admin decisions; sync never changes them
CREATE TABLE IF NOT EXISTS facebook_projects (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    slug            TEXT NOT NULL UNIQUE,
    name            TEXT NOT NULL,
    kind            TEXT NOT NULL DEFAULT 'project',
    category        TEXT NOT NULL DEFAULT 'projects',
    fb_album_id     TEXT UNIQUE,
    linked_prefix   TEXT UNIQUE,
    hidden          INTEGER NOT NULL DEFAULT 0,
    name_locked     INTEGER NOT NULL DEFAULT 0,
    created_by      TEXT NOT NULL DEFAULT 'auto',
    grouping_reason TEXT,
    created_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
    updated_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
    CHECK (kind IN ('project','recent')),
    CHECK (category IN ('projects','new-construction','remodels','furniture')),
    CHECK (hidden IN (0,1)),
    CHECK (name_locked IN (0,1)),
    CHECK (created_by IN ('auto','admin'))
);

-- one row per Facebook post that contributed photos
CREATE TABLE IF NOT EXISTS facebook_posts (
    fb_post_id             TEXT PRIMARY KEY,
    page_id                TEXT NOT NULL,
    message                TEXT,
    created_time           TEXT,
    permalink              TEXT,
    project_id             INTEGER REFERENCES facebook_projects(id),
    grouping_reason        TEXT,
    source                 TEXT NOT NULL,
    removed_on_facebook_at TEXT,
    created_at             TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
    updated_at             TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
    CHECK (source IN ('webhook','backfill'))
);

-- one row per Facebook photo ever imported
--   master_key  PRIVATE_BUCKET key (never public)
--   public_key  GALLERY_BUCKET key, non-null only while the photo is visible
--   hidden / project_locked  admin decisions; sync never changes them
CREATE TABLE IF NOT EXISTS facebook_photos (
    fb_photo_id            TEXT PRIMARY KEY,
    fb_post_id             TEXT,
    page_id                TEXT NOT NULL,
    source                 TEXT NOT NULL,
    status                 TEXT NOT NULL DEFAULT 'importing',
    project_id             INTEGER REFERENCES facebook_projects(id),
    project_locked         INTEGER NOT NULL DEFAULT 0,
    hidden                 INTEGER NOT NULL DEFAULT 0,
    album_id               TEXT,
    album_name             TEXT,
    master_key             TEXT,
    public_key             TEXT,
    content_type           TEXT,
    bytes                  INTEGER,
    width                  INTEGER,
    height                 INTEGER,
    caption                TEXT,
    fb_created_time        TEXT,
    permalink              TEXT,
    removed_on_facebook_at TEXT,
    last_error             TEXT,
    created_at             TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
    updated_at             TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
    CHECK (source IN ('webhook','backfill')),
    CHECK (status IN ('importing','imported','failed')),
    CHECK (hidden IN (0,1)),
    CHECK (project_locked IN (0,1))
);

CREATE INDEX IF NOT EXISTS idx_facebook_photos_project
    ON facebook_photos (project_id, fb_created_time);

CREATE INDEX IF NOT EXISTS idx_facebook_photos_status
    ON facebook_photos (status);

-- last_event_received_at, last_success_at, last_backfill_at, backfill_cursor
CREATE TABLE IF NOT EXISTS facebook_sync_state (
    key        TEXT PRIMARY KEY,
    value      TEXT,
    updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
