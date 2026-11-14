-- App-wide UI state the frontend restores at startup (panel sizes, table
-- column widths, ...). Values are JSON written by the frontend.
CREATE TABLE ui_state (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
);
