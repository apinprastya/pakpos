package sqlite

import (
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"time"

	"pakpos/internal/core/model"
)

// InlineBodyLimit is the largest body kept inside the database; bigger
// bodies are written to the bodies dir.
const InlineBodyLimit = 1 << 20 // 1 MB

// DefaultHistoryLimit is the default page size for ListHistory.
const DefaultHistoryLimit = 50

// HistorySummary is one row in the history list.
type HistorySummary struct {
	ID           int64     `json:"id"`
	CreatedAt    time.Time `json:"createdAt"`
	WorkspaceID  string    `json:"workspaceId"`
	RequestID    string    `json:"requestId"`
	RequestName  string    `json:"requestName"`
	Method       string    `json:"method"`
	URL          string    `json:"url"`
	Status       int       `json:"status"`
	DurationMs   float64   `json:"durationMs"`
	Size         int64     `json:"size"`
	ErrorKind    string    `json:"errorKind"`
	ErrorMessage string    `json:"errorMessage"`
}

// HistoryEntry is a full history record: the request as sent and the
// response (nil when the send failed).
type HistoryEntry struct {
	HistorySummary
	Request  model.Request   `json:"request"`
	Response *model.Response `json:"response"`
}

// HistoryFilter narrows ListHistory.
type HistoryFilter struct {
	// Text matches URL, method or request name (case-insensitive substring).
	Text string `json:"text"`
	// WorkspaceID limits results to one workspace when non-empty.
	WorkspaceID string `json:"workspaceId"`
	Offset      int    `json:"offset"`
	// Limit defaults to DefaultHistoryLimit when <= 0.
	Limit int `json:"limit"`
}

// HistoryPage is one page of results.
type HistoryPage struct {
	Items []HistorySummary `json:"items"`
	Total int              `json:"total"`
}

// AddHistory records a send. If the response was truncated, the store takes
// ownership of its full-body file (Response.BodyPath): the file is moved into
// the bodies dir and e.Response.BodyPath is rewritten in place to the new
// location. It returns the new entry's id.
func (s *Store) AddHistory(e HistoryEntry) (int64, error) {
	if e.CreatedAt.IsZero() {
		e.CreatedAt = s.now()
	}
	reqJSON, err := json.Marshal(e.Request)
	if err != nil {
		return 0, fmt.Errorf("encode request: %w", err)
	}
	var meta *model.Response
	var body []byte
	if e.Response != nil {
		m := *e.Response
		body = []byte(m.Body)
		m.Body, m.BodyPath = "", ""
		meta = &m
	}
	var respJSON any
	if meta != nil {
		b, _ := json.Marshal(meta) // model.Response always encodes
		respJSON = string(b)
	}

	res, err := s.db.Exec(`INSERT INTO history (created_at, workspace_id, request_id, request_name, method, url,
		status, duration_ms, size, error_kind, error_message, request_json, response_json)
		VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		e.CreatedAt.UnixMilli(), nullable(e.WorkspaceID), e.RequestID, e.RequestName, e.Method, e.URL,
		e.Status, e.DurationMs, e.Size, e.ErrorKind, e.ErrorMessage, string(reqJSON), respJSON)
	if err != nil {
		return 0, fmt.Errorf("add history: %w", err)
	}
	id, _ := res.LastInsertId()

	if err := s.storeBodies(id, e.Response, body); err != nil {
		_ = s.DeleteHistory(id)
		return 0, err
	}
	return id, nil
}

func (s *Store) storeBodies(id int64, resp *model.Response, body []byte) error {
	if resp == nil {
		return nil
	}
	var inline any
	bodyPath := ""
	if len(body) <= InlineBodyLimit {
		inline = body
	} else {
		bodyPath = filepath.Join(s.bodiesDir, strconv.FormatInt(id, 10)+".body")
		if err := os.WriteFile(bodyPath, body, 0o600); err != nil {
			return fmt.Errorf("store response body: %w", err)
		}
	}
	fullPath := ""
	if resp.BodyPath != "" {
		fullPath = filepath.Join(s.bodiesDir, strconv.FormatInt(id, 10)+".full")
		if err := moveFile(resp.BodyPath, fullPath); err != nil {
			_ = removeIfSet(bodyPath)
			return fmt.Errorf("store full response body: %w", err)
		}
	}
	_, err := s.db.Exec(`UPDATE history SET body = ?, body_path = ?, full_body_path = ? WHERE id = ?`,
		inline, bodyPath, fullPath, id)
	if err != nil {
		_ = removeIfSet(bodyPath)
		_ = removeIfSet(fullPath)
		return fmt.Errorf("store response body: %w", err)
	}
	if fullPath != "" {
		resp.BodyPath = fullPath
	}
	return nil
}

// GetHistory returns a full entry including the response body.
func (s *Store) GetHistory(id int64) (HistoryEntry, error) {
	row := s.db.QueryRow(`SELECT `+summaryCols+`, request_json, response_json, body, body_path, full_body_path
		FROM history WHERE id = ?`, id)
	var sc summaryScan
	var reqJSON string
	var respJSON sql.NullString
	var body []byte
	var bodyPath, fullPath string
	dest := append(sc.dest(), &reqJSON, &respJSON, &body, &bodyPath, &fullPath)
	if err := row.Scan(dest...); errors.Is(err, sql.ErrNoRows) {
		return HistoryEntry{}, fmt.Errorf("history %d: %w", id, ErrNotFound)
	} else if err != nil {
		return HistoryEntry{}, fmt.Errorf("read history %d: %w", id, err)
	}
	e := HistoryEntry{HistorySummary: sc.summary()}
	if err := json.Unmarshal([]byte(reqJSON), &e.Request); err != nil {
		return HistoryEntry{}, fmt.Errorf("decode history request %d: %w", id, err)
	}
	if respJSON.Valid {
		var resp model.Response
		if err := json.Unmarshal([]byte(respJSON.String), &resp); err != nil {
			return HistoryEntry{}, fmt.Errorf("decode history response %d: %w", id, err)
		}
		if bodyPath != "" {
			b, err := os.ReadFile(bodyPath)
			if err != nil {
				return HistoryEntry{}, fmt.Errorf("read stored body %d: %w", id, err)
			}
			body = b
		}
		resp.Body = string(body)
		resp.BodyPath = fullPath
		e.Response = &resp
	}
	return e, nil
}

// ListHistory returns summaries, newest first.
func (s *Store) ListHistory(f HistoryFilter) (HistoryPage, error) {
	where, args := []string{"1=1"}, []any{}
	if f.WorkspaceID != "" {
		where = append(where, "workspace_id = ?")
		args = append(args, f.WorkspaceID)
	}
	if t := strings.TrimSpace(f.Text); t != "" {
		like := "%" + escapeLike(t) + "%"
		where = append(where, `(url LIKE ? ESCAPE '\' OR method LIKE ? ESCAPE '\' OR request_name LIKE ? ESCAPE '\')`)
		args = append(args, like, like, like)
	}
	cond := strings.Join(where, " AND ")

	page := HistoryPage{Items: []HistorySummary{}}
	if err := s.db.QueryRow(`SELECT COUNT(*) FROM history WHERE `+cond, args...).Scan(&page.Total); err != nil {
		return HistoryPage{}, fmt.Errorf("count history: %w", err)
	}
	limit := f.Limit
	if limit <= 0 {
		limit = DefaultHistoryLimit
	}
	rows, err := s.db.Query(`SELECT `+summaryCols+` FROM history WHERE `+cond+
		` ORDER BY created_at DESC, id DESC LIMIT ? OFFSET ?`, append(args, limit, max(f.Offset, 0))...)
	if err != nil {
		return HistoryPage{}, fmt.Errorf("list history: %w", err)
	}
	defer rows.Close()
	for rows.Next() {
		var sc summaryScan
		if err := rows.Scan(sc.dest()...); err != nil {
			return HistoryPage{}, err
		}
		page.Items = append(page.Items, sc.summary())
	}
	return page, rows.Err()
}

// DeleteHistory removes one entry and its body files.
func (s *Store) DeleteHistory(id int64) error {
	return s.deleteWhere(`id = ?`, id)
}

// ClearHistory removes all entries (or only those of a workspace when
// workspaceID is non-empty) and their body files.
func (s *Store) ClearHistory(workspaceID string) error {
	if workspaceID != "" {
		return s.deleteWhere(`workspace_id = ?`, workspaceID)
	}
	return s.deleteWhere(`1=1`)
}

// PruneHistory keeps only the newest keep entries. keep <= 0 disables pruning.
// It returns how many entries were removed.
func (s *Store) PruneHistory(keep int) (int, error) {
	if keep <= 0 {
		return 0, nil
	}
	var cutoffID int64
	var cutoffAt int64
	err := s.db.QueryRow(`SELECT id, created_at FROM history ORDER BY created_at DESC, id DESC LIMIT 1 OFFSET ?`,
		keep-1).Scan(&cutoffID, &cutoffAt)
	if errors.Is(err, sql.ErrNoRows) {
		return 0, nil
	}
	if err != nil {
		return 0, fmt.Errorf("prune history: %w", err)
	}
	cond := `(created_at < ? OR (created_at = ? AND id < ?))`
	var n int
	if err := s.db.QueryRow(`SELECT COUNT(*) FROM history WHERE `+cond, cutoffAt, cutoffAt, cutoffID).Scan(&n); err != nil {
		return 0, fmt.Errorf("prune history: %w", err)
	}
	if n == 0 {
		return 0, nil
	}
	return n, s.deleteWhere(cond, cutoffAt, cutoffAt, cutoffID)
}

func (s *Store) deleteWhere(cond string, args ...any) error {
	rows, err := s.db.Query(`SELECT body_path, full_body_path FROM history WHERE `+cond, args...)
	if err != nil {
		return fmt.Errorf("delete history: %w", err)
	}
	var files []string
	for rows.Next() {
		var a, b string
		if err := rows.Scan(&a, &b); err != nil {
			_ = rows.Close()
			return err
		}
		files = append(files, a, b)
	}
	_ = rows.Close()
	if _, err := s.db.Exec(`DELETE FROM history WHERE `+cond, args...); err != nil {
		return fmt.Errorf("delete history: %w", err)
	}
	for _, f := range files {
		_ = removeIfSet(f)
	}
	return nil
}

// CleanupOrphanBodies removes files in the bodies dir that no history entry
// references (e.g. left behind by a crash). It returns how many were removed.
func (s *Store) CleanupOrphanBodies() (int, error) {
	refs := map[string]bool{}
	rows, err := s.db.Query(`SELECT body_path, full_body_path FROM history WHERE body_path != '' OR full_body_path != ''`)
	if err != nil {
		return 0, fmt.Errorf("cleanup bodies: %w", err)
	}
	for rows.Next() {
		var a, b string
		if err := rows.Scan(&a, &b); err != nil {
			_ = rows.Close()
			return 0, err
		}
		refs[filepath.Clean(a)], refs[filepath.Clean(b)] = true, true
	}
	_ = rows.Close()
	entries, err := os.ReadDir(s.bodiesDir)
	if err != nil {
		return 0, fmt.Errorf("cleanup bodies: %w", err)
	}
	removed := 0
	for _, e := range entries {
		p := filepath.Join(s.bodiesDir, e.Name())
		if e.IsDir() || refs[p] {
			continue
		}
		if os.Remove(p) == nil {
			removed++
		}
	}
	return removed, nil
}

const summaryCols = `id, created_at, COALESCE(workspace_id, ''), request_id, request_name, method, url,
	status, duration_ms, size, error_kind, error_message`

// summaryScan scans summaryCols, converting created_at from unix ms.
type summaryScan struct {
	HistorySummary
	createdMs int64
}

func (sc *summaryScan) dest() []any {
	return []any{&sc.ID, &sc.createdMs, &sc.WorkspaceID, &sc.RequestID, &sc.RequestName, &sc.Method, &sc.URL,
		&sc.Status, &sc.DurationMs, &sc.Size, &sc.ErrorKind, &sc.ErrorMessage}
}

func (sc *summaryScan) summary() HistorySummary {
	out := sc.HistorySummary
	out.CreatedAt = time.UnixMilli(sc.createdMs).UTC()
	return out
}

func nullable(s string) any {
	if s == "" {
		return nil
	}
	return s
}

func escapeLike(s string) string {
	return strings.NewReplacer(`\`, `\\`, `%`, `\%`, `_`, `\_`).Replace(s)
}

func removeIfSet(path string) error {
	if path == "" {
		return nil
	}
	if err := os.Remove(path); err != nil && !errors.Is(err, os.ErrNotExist) {
		return err
	}
	return nil
}

// moveFile renames src to dst, falling back to copy+delete across devices.
func moveFile(src, dst string) error {
	if err := os.Rename(src, dst); err == nil {
		return nil
	}
	in, err := os.Open(src)
	if err != nil {
		return err
	}
	defer in.Close()
	out, err := os.OpenFile(dst, os.O_CREATE|os.O_WRONLY|os.O_TRUNC, 0o600)
	if err != nil {
		return err
	}
	if _, err := io.Copy(out, in); err != nil {
		_ = out.Close()
		_ = os.Remove(dst)
		return err
	}
	if err := out.Close(); err != nil {
		_ = os.Remove(dst)
		return err
	}
	_ = in.Close()
	return os.Remove(src)
}
