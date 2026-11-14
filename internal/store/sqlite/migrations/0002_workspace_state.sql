-- Per-workspace app state that is not committed with the workspace
-- (e.g. the selected environment). One row per workspace and key.
CREATE TABLE workspace_state (
    workspace_id TEXT NOT NULL,
    key          TEXT NOT NULL,
    value        TEXT NOT NULL,
    PRIMARY KEY (workspace_id, key)
);

-- The environment selected when the request was sent (its name at the time).
ALTER TABLE history ADD COLUMN environment_name TEXT NOT NULL DEFAULT '';
