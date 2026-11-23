package sqlite

import (
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"time"
)

// Webhook log limits.
const (
	// MaxWebhookRequests is how many requests each webhook keeps; older
	// ones are pruned when a request is added.
	MaxWebhookRequests = 500
	// MaxWebhookBody is how much of a request or response body is stored.
	MaxWebhookBody = 1 << 20
)

// WebhookHeader is one header line (repeated names are separate entries).
type WebhookHeader struct {
	Name  string `json:"name"`
	Value string `json:"value"`
}

// WebhookRequestSummary is one row of a webhook's log.
type WebhookRequestSummary struct {
	ID          string    `json:"id"`
	WorkspaceID string    `json:"workspaceId"`
	WebhookID   string    `json:"webhookId"`
	ReceivedAt  time.Time `json:"receivedAt"`
	Method      string    `json:"method"`
	Path        string    `json:"path"`
	// Query is the raw query string, without "?".
	Query     string `json:"query"`
	BodySize  int64  `json:"bodySize"`
	Truncated bool   `json:"truncated"`
	// RemoteAddr is the sender's address (CF-Connecting-IP when the request
	// came through the tunnel).
	RemoteAddr string `json:"remoteAddr"`
	// RuleID and RuleName are "" when the default response answered.
	RuleID     string  `json:"ruleId"`
	RuleName   string  `json:"ruleName"`
	Status     int     `json:"status"`
	DurationMs float64 `json:"durationMs"`
	// Error is set when the request couldn't be answered normally
	// ("Body too large").
	Error string `json:"error"`
}

// WebhookRequest is a stored request with its headers and bodies.
type WebhookRequest struct {
	WebhookRequestSummary
	Headers           []WebhookHeader `json:"headers"`
	Body              []byte          `json:"body"`
	ResponseHeaders   []WebhookHeader `json:"responseHeaders"`
	ResponseBody      []byte          `json:"responseBody"`
	ResponseTruncated bool            `json:"responseTruncated"`
}

// AddWebhookRequest stores a request and keeps only the newest keep of its
// webhook (keep <= 0 keeps all). Bodies over MaxWebhookBody are cut and
// marked truncated.
func (s *Store) AddWebhookRequest(r WebhookRequest, keep int) error {
	if r.ID == "" || r.WebhookID == "" {
		return errors.New("a webhook request needs an id and a webhook id")
	}
	if r.ReceivedAt.IsZero() {
		r.ReceivedAt = s.now()
	}
	if len(r.Body) > MaxWebhookBody {
		r.Body, r.Truncated = r.Body[:MaxWebhookBody], true
	}
	if len(r.ResponseBody) > MaxWebhookBody {
		r.ResponseBody, r.ResponseTruncated = r.ResponseBody[:MaxWebhookBody], true
	}
	headers, err := headersJSON(r.Headers)
	if err != nil {
		return err
	}
	respHeaders, err := headersJSON(r.ResponseHeaders)
	if err != nil {
		return err
	}
	tx, err := s.db.Begin()
	if err != nil {
		return fmt.Errorf("add webhook request: %w", err)
	}
	defer func() { _ = tx.Rollback() }()
	if _, err := tx.Exec(`INSERT INTO webhook_requests (id, workspace_id, webhook_id, received_at, method, path,
		query, headers_json, body, body_size, truncated, remote_addr, rule_id, rule_name, status, duration_ms,
		error, response_headers_json, response_body, response_truncated)
		VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		r.ID, r.WorkspaceID, r.WebhookID, r.ReceivedAt.UnixMilli(), r.Method, r.Path,
		r.Query, headers, r.Body, r.BodySize, r.Truncated, r.RemoteAddr, r.RuleID, r.RuleName, r.Status, r.DurationMs,
		r.Error, respHeaders, r.ResponseBody, r.ResponseTruncated); err != nil {
		return fmt.Errorf("add webhook request: %w", err)
	}
	if keep > 0 {
		if _, err := tx.Exec(`DELETE FROM webhook_requests WHERE webhook_id = ? AND seq NOT IN
			(SELECT seq FROM webhook_requests WHERE webhook_id = ? ORDER BY seq DESC LIMIT ?)`,
			r.WebhookID, r.WebhookID, keep); err != nil {
			return fmt.Errorf("prune webhook requests: %w", err)
		}
	}
	if err := tx.Commit(); err != nil {
		return fmt.Errorf("add webhook request: %w", err)
	}
	return nil
}

func headersJSON(h []WebhookHeader) (string, error) {
	if h == nil {
		h = []WebhookHeader{}
	}
	b, err := json.Marshal(h)
	if err != nil {
		return "", fmt.Errorf("encode headers: %w", err)
	}
	return string(b), nil
}

const hookReqCols = `id, workspace_id, webhook_id, received_at, method, path, query, body_size, truncated,
	remote_addr, rule_id, rule_name, status, duration_ms, error`

type hookReqScan struct {
	WebhookRequestSummary
	receivedMs int64
}

func (r *hookReqScan) dest() []any {
	return []any{&r.ID, &r.WorkspaceID, &r.WebhookID, &r.receivedMs, &r.Method, &r.Path, &r.Query, &r.BodySize,
		&r.Truncated, &r.RemoteAddr, &r.RuleID, &r.RuleName, &r.Status, &r.DurationMs, &r.Error}
}

func (r *hookReqScan) row() WebhookRequestSummary {
	out := r.WebhookRequestSummary
	out.ReceivedAt = time.UnixMilli(r.receivedMs).UTC()
	return out
}

// ListWebhookRequests returns up to limit requests of a webhook, newest
// first, older than the request beforeID ("" starts at the newest).
func (s *Store) ListWebhookRequests(webhookID, beforeID string, limit int) ([]WebhookRequestSummary, error) {
	if limit <= 0 {
		limit = MaxWebhookRequests
	}
	q := `SELECT ` + hookReqCols + ` FROM webhook_requests WHERE webhook_id = ?`
	args := []any{webhookID}
	if beforeID != "" {
		q += ` AND seq < (SELECT seq FROM webhook_requests WHERE id = ?)`
		args = append(args, beforeID)
	}
	q += ` ORDER BY seq DESC LIMIT ?`
	args = append(args, limit)
	rows, err := s.db.Query(q, args...)
	if err != nil {
		return nil, fmt.Errorf("list webhook requests: %w", err)
	}
	defer rows.Close()
	out := []WebhookRequestSummary{}
	for rows.Next() {
		var r hookReqScan
		if err := rows.Scan(r.dest()...); err != nil {
			return nil, fmt.Errorf("list webhook requests: %w", err)
		}
		out = append(out, r.row())
	}
	return out, rows.Err()
}

// GetWebhookRequest returns a stored request, or ErrNotFound.
func (s *Store) GetWebhookRequest(id string) (WebhookRequest, error) {
	var r hookReqScan
	var headers, respHeaders string
	var out WebhookRequest
	err := s.db.QueryRow(`SELECT `+hookReqCols+`, headers_json, body, response_headers_json, response_body,
		response_truncated FROM webhook_requests WHERE id = ?`, id).
		Scan(append(r.dest(), &headers, &out.Body, &respHeaders, &out.ResponseBody, &out.ResponseTruncated)...)
	if errors.Is(err, sql.ErrNoRows) {
		return WebhookRequest{}, fmt.Errorf("webhook request %s: %w", id, ErrNotFound)
	}
	if err != nil {
		return WebhookRequest{}, fmt.Errorf("read webhook request %s: %w", id, err)
	}
	out.WebhookRequestSummary = r.row()
	if err := json.Unmarshal([]byte(headers), &out.Headers); err != nil {
		return WebhookRequest{}, fmt.Errorf("read webhook request %s headers: %w", id, err)
	}
	if err := json.Unmarshal([]byte(respHeaders), &out.ResponseHeaders); err != nil {
		return WebhookRequest{}, fmt.Errorf("read webhook request %s headers: %w", id, err)
	}
	if out.Body == nil {
		out.Body = []byte{}
	}
	if out.ResponseBody == nil {
		out.ResponseBody = []byte{}
	}
	return out, nil
}

// DeleteWebhookRequest removes one stored request (no error when it doesn't
// exist).
func (s *Store) DeleteWebhookRequest(id string) error {
	if _, err := s.db.Exec(`DELETE FROM webhook_requests WHERE id = ?`, id); err != nil {
		return fmt.Errorf("delete webhook request: %w", err)
	}
	return nil
}

// ClearWebhookRequests removes a webhook's whole log.
func (s *Store) ClearWebhookRequests(webhookID string) error {
	if _, err := s.db.Exec(`DELETE FROM webhook_requests WHERE webhook_id = ?`, webhookID); err != nil {
		return fmt.Errorf("clear webhook requests: %w", err)
	}
	return nil
}
