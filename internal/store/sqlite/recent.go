package sqlite

import (
	"fmt"
	"time"
)

// RecentWorkspace is a workspace the user opened before.
type RecentWorkspace struct {
	Path       string    `json:"path"`
	Name       string    `json:"name"`
	LastOpened time.Time `json:"lastOpened"`
}

// TouchRecent records that a workspace was just opened.
func (s *Store) TouchRecent(path, name string) error {
	_, err := s.db.Exec(`INSERT INTO recent_workspaces (path, name, last_opened) VALUES (?, ?, ?)
		ON CONFLICT(path) DO UPDATE SET name = excluded.name, last_opened = excluded.last_opened`,
		path, name, s.now().UnixMilli())
	if err != nil {
		return fmt.Errorf("record recent workspace: %w", err)
	}
	return nil
}

// ListRecent returns recently opened workspaces, newest first. limit <= 0 means all.
func (s *Store) ListRecent(limit int) ([]RecentWorkspace, error) {
	if limit <= 0 {
		limit = -1
	}
	rows, err := s.db.Query(`SELECT path, name, last_opened FROM recent_workspaces
		ORDER BY last_opened DESC, path LIMIT ?`, limit)
	if err != nil {
		return nil, fmt.Errorf("list recent workspaces: %w", err)
	}
	defer rows.Close()
	out := []RecentWorkspace{}
	for rows.Next() {
		var r RecentWorkspace
		var ms int64
		if err := rows.Scan(&r.Path, &r.Name, &ms); err != nil {
			return nil, err
		}
		r.LastOpened = time.UnixMilli(ms).UTC()
		out = append(out, r)
	}
	return out, rows.Err()
}

// RemoveRecent forgets a workspace (the folder itself is untouched).
func (s *Store) RemoveRecent(path string) error {
	_, err := s.db.Exec(`DELETE FROM recent_workspaces WHERE path = ?`, path)
	if err != nil {
		return fmt.Errorf("remove recent workspace: %w", err)
	}
	return nil
}
