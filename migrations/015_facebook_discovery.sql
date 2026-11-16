-- Local implementation only: apply to production only after owner approval.
-- Preview never uses this table. Each writer holds a renewable fenced lease.
CREATE TABLE IF NOT EXISTS facebook_discovery_jobs (
    mode TEXT PRIMARY KEY CHECK (mode IN ('history', 'reconcile')),
    state TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending',
    attempts INTEGER NOT NULL DEFAULT 0,
    next_attempt_at INTEGER NOT NULL DEFAULT 0,
    lease_token TEXT,
    lease_until INTEGER NOT NULL DEFAULT 0,
    last_error TEXT,
    updated_at TEXT NOT NULL
);
-- Several albums may intentionally map to one existing project.
CREATE TABLE IF NOT EXISTS facebook_album_mappings (
    album_id TEXT PRIMARY KEY,
    project_id INTEGER NOT NULL REFERENCES facebook_projects(id),
    locked INTEGER NOT NULL DEFAULT 0 CHECK (locked IN (0,1))
);
ALTER TABLE facebook_webhook_events ADD COLUMN discovery_state TEXT;
CREATE TABLE IF NOT EXISTS facebook_albums (
    album_id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    description TEXT,
    created_time TEXT,
    updated_time TEXT
);
