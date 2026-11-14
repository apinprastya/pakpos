package sqlite

import (
	"errors"
	"fmt"
)

// UIState returns every stored UI state value by key.
func (s *Store) UIState() (map[string]string, error) {
	rows, err := s.db.Query(`SELECT key, value FROM ui_state`)
	if err != nil {
		return nil, fmt.Errorf("read ui state: %w", err)
	}
	defer func() { _ = rows.Close() }()
	out := map[string]string{}
	for rows.Next() {
		var k, v string
		if err := rows.Scan(&k, &v); err != nil {
			return nil, fmt.Errorf("read ui state: %w", err)
		}
		out[k] = v
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("read ui state: %w", err)
	}
	return out, nil
}

// SetUIState stores value under key. An empty value removes the key.
func (s *Store) SetUIState(key, value string) error {
	if key == "" {
		return errors.New("ui state needs a key")
	}
	var err error
	if value == "" {
		_, err = s.db.Exec(`DELETE FROM ui_state WHERE key = ?`, key)
	} else {
		_, err = s.db.Exec(`INSERT INTO ui_state (key, value) VALUES (?, ?)
			ON CONFLICT(key) DO UPDATE SET value = excluded.value`, key, value)
	}
	if err != nil {
		return fmt.Errorf("write ui state %s: %w", key, err)
	}
	return nil
}
