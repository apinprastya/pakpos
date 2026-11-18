-- Persistent cookies per workspace (workspace_id '' holds the cookies of
-- sends made without a workspace). Session cookies are never written: they
-- live in memory until the app quits. Cookies never go into workspace files.
-- expires_at and created_at are Unix milliseconds; expired rows are deleted
-- when a jar loads.
CREATE TABLE cookies (
    workspace_id TEXT    NOT NULL,
    domain       TEXT    NOT NULL,
    path         TEXT    NOT NULL,
    name         TEXT    NOT NULL,
    value        TEXT    NOT NULL,
    host_only    INTEGER NOT NULL,
    secure       INTEGER NOT NULL,
    http_only    INTEGER NOT NULL,
    same_site    TEXT    NOT NULL,
    expires_at   INTEGER NOT NULL,
    created_at   INTEGER NOT NULL,
    PRIMARY KEY (workspace_id, domain, path, name)
);
