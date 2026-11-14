package sqlite

import (
	"database/sql"
	"errors"
	"fmt"
)

// StateSelectedEnvironment holds the id of a workspace's selected environment.
const StateSelectedEnvironment = "selected_environment"

// GetWorkspaceState returns the value stored for a workspace under key, or
// "" when none is stored.
func (s *Store) GetWorkspaceState(workspaceID, key string) (string, error) {
	var v string
	err := s.db.QueryRow(`SELECT value FROM workspace_state WHERE workspace_id = ? AND key = ?`,
		workspaceID, key).Scan(&v)
	if errors.Is(err, sql.ErrNoRows) {
		return "", nil
	}
	if err != nil {
		return "", fmt.Errorf("read workspace state %s: %w", key, err)
	}
	return v, nil
}

// SetWorkspaceState stores value for a workspace under key. An empty value
// removes the row.
func (s *Store) SetWorkspaceState(workspaceID, key, value string) error {
	if workspaceID == "" {
		return errors.New("workspace state needs a workspace id")
	}
	var err error
	if value == "" {
		_, err = s.db.Exec(`DELETE FROM workspace_state WHERE workspace_id = ? AND key = ?`, workspaceID, key)
	} else {
		_, err = s.db.Exec(`INSERT INTO workspace_state (workspace_id, key, value) VALUES (?, ?, ?)
			ON CONFLICT(workspace_id, key) DO UPDATE SET value = excluded.value`, workspaceID, key, value)
	}
	if err != nil {
		return fmt.Errorf("write workspace state %s: %w", key, err)
	}
	return nil
}
