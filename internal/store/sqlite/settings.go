package sqlite

import (
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
)

// GetSetting decodes the JSON value stored under key into out. It reports
// false (and leaves out untouched) when the key is not set.
func (s *Store) GetSetting(key string, out any) (bool, error) {
	var raw string
	err := s.db.QueryRow(`SELECT value FROM settings WHERE key = ?`, key).Scan(&raw)
	if errors.Is(err, sql.ErrNoRows) {
		return false, nil
	}
	if err != nil {
		return false, fmt.Errorf("read setting %s: %w", key, err)
	}
	if err := json.Unmarshal([]byte(raw), out); err != nil {
		return false, fmt.Errorf("decode setting %s: %w", key, err)
	}
	return true, nil
}

// SetSetting stores v as JSON under key.
func (s *Store) SetSetting(key string, v any) error {
	raw, err := json.Marshal(v)
	if err != nil {
		return fmt.Errorf("encode setting %s: %w", key, err)
	}
	_, err = s.db.Exec(`INSERT INTO settings (key, value) VALUES (?, ?)
		ON CONFLICT(key) DO UPDATE SET value = excluded.value`, key, string(raw))
	if err != nil {
		return fmt.Errorf("write setting %s: %w", key, err)
	}
	return nil
}
