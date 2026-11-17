-- The secret keys Pakpos wrote to the secret store, per workspace: key NAMES
-- only, never values (those live in the keychain or the encrypted file).
-- Keychains can't list their keys, so this index is what lets the app find
-- and delete values whose scope or variable no longer exists.
-- written_at is Unix seconds; pruning skips keys written in the running
-- session (they may belong to an unsaved secret row).
CREATE TABLE secret_index (
    workspace_id TEXT    NOT NULL,
    scope_id     TEXT    NOT NULL,
    key          TEXT    NOT NULL,
    written_at   INTEGER NOT NULL,
    PRIMARY KEY (workspace_id, scope_id, key)
);
