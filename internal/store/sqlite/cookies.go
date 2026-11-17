package sqlite

import (
	"fmt"
	"time"

	"pakpos/internal/core/cookies"
)

// CookieStore keeps the persistent cookies of one workspace ("" for sends
// made without one). It implements cookies.Store.
type CookieStore struct {
	s           *Store
	workspaceID string
}

// Cookies returns the cookie store of a workspace.
func (s *Store) Cookies(workspaceID string) *CookieStore {
	return &CookieStore{s: s, workspaceID: workspaceID}
}

// LoadCookies deletes the workspace's expired cookies and returns the rest.
func (c *CookieStore) LoadCookies(now time.Time) ([]cookies.Cookie, error) {
	if _, err := c.s.db.Exec(`DELETE FROM cookies WHERE workspace_id = ? AND expires_at <= ?`,
		c.workspaceID, now.UnixMilli()); err != nil {
		return nil, fmt.Errorf("prune cookies: %w", err)
	}
	rows, err := c.s.db.Query(`SELECT domain, path, name, value, host_only, secure, http_only, same_site, expires_at, created_at
		FROM cookies WHERE workspace_id = ? ORDER BY domain, path, name`, c.workspaceID)
	if err != nil {
		return nil, fmt.Errorf("list cookies: %w", err)
	}
	defer rows.Close()
	out := []cookies.Cookie{}
	for rows.Next() {
		var k cookies.Cookie
		if err := rows.Scan(&k.Domain, &k.Path, &k.Name, &k.Value, &k.HostOnly, &k.Secure, &k.HTTPOnly,
			&k.SameSite, &k.ExpiresAt, &k.CreatedAt); err != nil {
			return nil, fmt.Errorf("list cookies: %w", err)
		}
		out = append(out, k)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("list cookies: %w", err)
	}
	return out, nil
}

// SaveCookie inserts or replaces a persistent cookie.
func (c *CookieStore) SaveCookie(k cookies.Cookie) error {
	_, err := c.s.db.Exec(`INSERT INTO cookies (workspace_id, domain, path, name, value, host_only, secure, http_only, same_site, expires_at, created_at)
		VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
		ON CONFLICT(workspace_id, domain, path, name) DO UPDATE SET value = excluded.value, host_only = excluded.host_only,
		secure = excluded.secure, http_only = excluded.http_only, same_site = excluded.same_site,
		expires_at = excluded.expires_at, created_at = excluded.created_at`,
		c.workspaceID, k.Domain, k.Path, k.Name, k.Value, k.HostOnly, k.Secure, k.HTTPOnly, k.SameSite, k.ExpiresAt, k.CreatedAt)
	if err != nil {
		return fmt.Errorf("save cookie %s: %w", k.Name, err)
	}
	return nil
}

// DeleteCookie removes one cookie.
func (c *CookieStore) DeleteCookie(r cookies.Ref) error {
	_, err := c.s.db.Exec(`DELETE FROM cookies WHERE workspace_id = ? AND domain = ? AND path = ? AND name = ?`,
		c.workspaceID, r.Domain, r.Path, r.Name)
	if err != nil {
		return fmt.Errorf("delete cookie %s: %w", r.Name, err)
	}
	return nil
}

// ClearCookies removes the cookies of one domain, or all with "".
func (c *CookieStore) ClearCookies(domain string) error {
	q, args := `DELETE FROM cookies WHERE workspace_id = ?`, []any{c.workspaceID}
	if domain != "" {
		q += ` AND domain = ?`
		args = append(args, domain)
	}
	if _, err := c.s.db.Exec(q, args...); err != nil {
		return fmt.Errorf("clear cookies: %w", err)
	}
	return nil
}
