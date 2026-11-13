CREATE TABLE history (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    created_at      INTEGER NOT NULL,           -- unix milliseconds
    workspace_id    TEXT,                       -- NULL for sends outside a workspace
    request_id      TEXT,                       -- saved request id, if any
    request_name    TEXT NOT NULL DEFAULT '',
    method          TEXT NOT NULL,
    url             TEXT NOT NULL,
    status          INTEGER NOT NULL DEFAULT 0, -- 0 when the send failed
    duration_ms     REAL NOT NULL DEFAULT 0,
    size            INTEGER NOT NULL DEFAULT 0,
    error_kind      TEXT NOT NULL DEFAULT '',
    error_message   TEXT NOT NULL DEFAULT '',
    request_json    TEXT NOT NULL,              -- model.Request snapshot
    response_json   TEXT,                       -- model.Response without body
    body            BLOB,                       -- inline body (<= InlineBodyLimit)
    body_path       TEXT NOT NULL DEFAULT '',   -- body stored in a file instead
    full_body_path  TEXT NOT NULL DEFAULT ''    -- full body of a truncated response
);
CREATE INDEX history_created ON history (created_at DESC, id DESC);
CREATE INDEX history_workspace ON history (workspace_id, created_at DESC);

CREATE TABLE settings (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
);

CREATE TABLE recent_workspaces (
    path        TEXT PRIMARY KEY,
    name        TEXT NOT NULL,
    last_opened INTEGER NOT NULL
);
