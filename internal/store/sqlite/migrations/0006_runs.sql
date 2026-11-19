-- Collection runner results, per workspace: only the newest runs are kept
-- (sqlite.MaxRuns, pruned on insert). run_json is the whole runner report
-- (configuration, requests as written, per-request results with masked
-- tests and console, no response bodies unless the run saved them, capped);
-- summary_json is its summary, for the list. Never secret values, never a
-- data file's contents (only its name). created_at is Unix milliseconds.
CREATE TABLE runs (
    id               TEXT    PRIMARY KEY,
    workspace_id     TEXT    NOT NULL,
    created_at       INTEGER NOT NULL,
    target_id        TEXT    NOT NULL,
    target_kind      TEXT    NOT NULL,
    target_name      TEXT    NOT NULL,
    environment_name TEXT    NOT NULL DEFAULT '',
    iterations       INTEGER NOT NULL,
    data_file        TEXT    NOT NULL DEFAULT '',
    outcome          TEXT    NOT NULL,
    duration_ms      REAL    NOT NULL DEFAULT 0,
    summary_json     TEXT    NOT NULL,
    run_json         TEXT    NOT NULL
);
CREATE INDEX runs_workspace ON runs (workspace_id, created_at DESC);
