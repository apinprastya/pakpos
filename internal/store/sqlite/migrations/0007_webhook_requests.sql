-- Requests received by the webhook test server, per webhook: only the
-- newest are kept (sqlite.MaxWebhookRequests, pruned on insert). They hold
-- exactly what the sender sent (which may include the sender's own
-- credentials) and the reply Pakpos sent; never workspace secrets. Bodies
-- are capped (sqlite.MaxWebhookBody) and `truncated` says when one was cut.
-- seq orders the log (ids are not monotonic within a millisecond).
-- received_at is Unix milliseconds.
CREATE TABLE webhook_requests (
    seq                   INTEGER PRIMARY KEY AUTOINCREMENT,
    id                    TEXT    NOT NULL UNIQUE,
    workspace_id          TEXT    NOT NULL,
    webhook_id            TEXT    NOT NULL,
    received_at           INTEGER NOT NULL,
    method                TEXT    NOT NULL,
    path                  TEXT    NOT NULL,
    query                 TEXT    NOT NULL DEFAULT '',
    headers_json          TEXT    NOT NULL DEFAULT '[]',
    body                  BLOB,
    body_size             INTEGER NOT NULL DEFAULT 0,
    truncated             INTEGER NOT NULL DEFAULT 0,
    remote_addr           TEXT    NOT NULL DEFAULT '',
    rule_id               TEXT    NOT NULL DEFAULT '',
    rule_name             TEXT    NOT NULL DEFAULT '',
    status                INTEGER NOT NULL,
    duration_ms           REAL    NOT NULL DEFAULT 0,
    error                 TEXT    NOT NULL DEFAULT '',
    response_headers_json TEXT    NOT NULL DEFAULT '[]',
    response_body         BLOB,
    response_truncated    INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX webhook_requests_hook ON webhook_requests (webhook_id, seq DESC);
