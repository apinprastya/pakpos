package sqlite

import (
	"errors"
	"fmt"
	"time"
)

// SecretKeyRef names one value in the secret store: the variable key in a
// scope of a workspace. It never holds the value.
type SecretKeyRef struct {
	WorkspaceID string
	ScopeID     string
	Key         string
	// WrittenAt is when the key was last recorded (second precision).
	WrittenAt time.Time
}

// RecordSecretKey notes that a value was stored under (workspace, scope,
// key), or refreshes the time it was written.
func (s *Store) RecordSecretKey(workspaceID, scopeID, key string) error {
	if workspaceID == "" || scopeID == "" || key == "" {
		return errors.New("a secret key needs a workspace, a scope and a name")
	}
	_, err := s.db.Exec(`INSERT INTO secret_index (workspace_id, scope_id, key, written_at) VALUES (?, ?, ?, ?)
		ON CONFLICT(workspace_id, scope_id, key) DO UPDATE SET written_at = excluded.written_at`,
		workspaceID, scopeID, key, s.now().Unix())
	if err != nil {
		return fmt.Errorf("record secret key %s: %w", key, err)
	}
	return nil
}

// AdoptSecretKey records a key that may hold a value written before the
// index existed. Unlike RecordSecretKey it keeps the time of a known key,
// and dates a new one at the Unix epoch so the next prune may check it.
func (s *Store) AdoptSecretKey(workspaceID, scopeID, key string) error {
	if workspaceID == "" || scopeID == "" || key == "" {
		return errors.New("a secret key needs a workspace, a scope and a name")
	}
	_, err := s.db.Exec(`INSERT INTO secret_index (workspace_id, scope_id, key, written_at) VALUES (?, ?, ?, 0)
		ON CONFLICT(workspace_id, scope_id, key) DO NOTHING`, workspaceID, scopeID, key)
	if err != nil {
		return fmt.Errorf("adopt secret key %s: %w", key, err)
	}
	return nil
}

// ForgetSecretKey drops a key from the index (its value was deleted).
func (s *Store) ForgetSecretKey(workspaceID, scopeID, key string) error {
	_, err := s.db.Exec(`DELETE FROM secret_index WHERE workspace_id = ? AND scope_id = ? AND key = ?`,
		workspaceID, scopeID, key)
	if err != nil {
		return fmt.Errorf("forget secret key %s: %w", key, err)
	}
	return nil
}

// SecretKeys lists the indexed keys of a workspace, by scope and key.
func (s *Store) SecretKeys(workspaceID string) ([]SecretKeyRef, error) {
	rows, err := s.db.Query(`SELECT scope_id, key, written_at FROM secret_index
		WHERE workspace_id = ? ORDER BY scope_id, key`, workspaceID)
	if err != nil {
		return nil, fmt.Errorf("list secret keys: %w", err)
	}
	defer rows.Close()
	out := []SecretKeyRef{}
	for rows.Next() {
		r := SecretKeyRef{WorkspaceID: workspaceID}
		var at int64
		if err := rows.Scan(&r.ScopeID, &r.Key, &at); err != nil {
			return nil, fmt.Errorf("list secret keys: %w", err)
		}
		r.WrittenAt = time.Unix(at, 0)
		out = append(out, r)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("list secret keys: %w", err)
	}
	return out, nil
}
