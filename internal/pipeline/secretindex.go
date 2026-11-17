package pipeline

import (
	"errors"
	"fmt"
	"log/slog"
	"time"

	"pakpos/internal/secrets"
	"pakpos/internal/store/sqlite"
)

// SecretIndex records the secret keys written per workspace (key names
// only, never values). Keychains can't list their keys, so the index is how
// PruneSecrets finds values whose scope or variable is gone. sqlite.Store
// implements it.
type SecretIndex interface {
	// RecordSecretKey notes a value written now.
	RecordSecretKey(workspaceID, scopeID, key string) error
	// AdoptSecretKey notes a key that may hold an older value, keeping the
	// time of a known key.
	AdoptSecretKey(workspaceID, scopeID, key string) error
	// ForgetSecretKey drops a key whose value was deleted.
	ForgetSecretKey(workspaceID, scopeID, key string) error
	// SecretKeys lists a workspace's indexed keys.
	SecretKeys(workspaceID string) ([]sqlite.SecretKeyRef, error)
}

var _ SecretIndex = (*sqlite.Store)(nil)

// indexedStore records every key Pakpos writes to the secret store in the
// index, and forgets the ones it deletes, so all of the session's secret
// bookkeeping (set, rename, copy, clear, cleanup) keeps the index in step.
// Index failures are logged: the value was stored or deleted all the same,
// and an unindexed value is only a missed prune.
type indexedStore struct {
	secrets.Store
	idx SecretIndex
	log *slog.Logger
}

func (s *indexedStore) Set(key, value string) error {
	if err := s.Store.Set(key, value); err != nil {
		return err
	}
	if ws, scope, name, ok := secrets.SplitKey(key); ok {
		if err := s.idx.RecordSecretKey(ws, scope, name); err != nil {
			s.log.Warn("record secret key", "scope", scope, "err", err)
		}
	}
	return nil
}

func (s *indexedStore) Delete(key string) error {
	err := s.Store.Delete(key)
	if err != nil && !errors.Is(err, secrets.ErrNotFound) {
		return err
	}
	if ws, scope, name, ok := secrets.SplitKey(key); ok {
		if ferr := s.idx.ForgetSecretKey(ws, scope, name); ferr != nil {
			s.log.Warn("forget secret key", "scope", scope, "err", ferr)
		}
	}
	return err
}

// WithSecretIndex makes the session record the secret keys it writes in
// idx, and enables PruneSecrets. It returns s.
func (s *Session) WithSecretIndex(idx SecretIndex) *Session {
	if idx == nil {
		return s
	}
	s.idx = idx
	s.sec = &indexedStore{Store: s.sec, idx: idx, log: s.log}
	return s
}

// liveSecrets returns the secret variable keys of every scope in the
// workspace, by scope id. ok is false when part of the workspace couldn't be
// loaded (its problems list isn't empty): a scope missing because of a typo
// in its file must not lose its values.
func (s *Session) liveSecrets() (live map[string]map[string]bool, ok bool) {
	tree := s.ws.Tree()
	if len(tree.Problems) > 0 {
		return nil, false
	}
	live = map[string]map[string]bool{}
	add := func(scopeID string, keys []string) {
		set := map[string]bool{}
		for _, k := range keys {
			set[k] = true
		}
		live[scopeID] = set
	}
	g := s.ws.GetGlobals()
	add(g.ID, secrets.SecretKeys(g.Variables))
	for _, n := range tree.Collections {
		c, err := s.ws.GetCollection(n.ID)
		if err != nil {
			return nil, false
		}
		add(c.ID, secrets.SecretKeys(c.Variables))
	}
	for _, e := range s.ws.ListEnvironments() {
		add(e.ID, secrets.SecretKeys(e.Variables))
	}
	return live, true
}

// PruneSecrets deletes stored secret values the workspace no longer refers
// to: their scope (environment, collection, globals) or secret variable is
// gone, e.g. removed while the store was locked, by hand-editing a file, or
// a value set on a secret row that was never saved. Only keys in the index
// written before `before` are candidates, so values of unsaved rows in the
// running session survive; callers pass the time the app started.
//
// It first adopts the keys of the workspace's current secret variables
// (values stored before the index existed). It does nothing without an
// index, or while part of the workspace fails to load. A locked or
// passwordless file store stops it (returned as an error wrapping
// secrets.ErrLocked or ErrNoPassword); other delete errors are joined and
// the rest still pruned. It returns how many values were deleted.
func (s *Session) PruneSecrets(before time.Time) (int, error) {
	if s.idx == nil {
		return 0, nil
	}
	live, ok := s.liveSecrets()
	if !ok {
		s.log.Info("skip pruning secrets: part of the workspace couldn't be loaded")
		return 0, nil
	}
	wsID := s.workspaceID()
	for scopeID, keys := range live {
		for k := range keys {
			if err := s.idx.AdoptSecretKey(wsID, scopeID, k); err != nil {
				return 0, fmt.Errorf("prune secrets: %w", err)
			}
		}
	}
	indexed, err := s.idx.SecretKeys(wsID)
	if err != nil {
		return 0, fmt.Errorf("prune secrets: %w", err)
	}
	pruned := 0
	var errs []error
	for _, r := range indexed {
		if live[r.ScopeID][r.Key] || r.WrittenAt.Unix() >= before.Unix() {
			continue
		}
		err := s.sec.Delete(secrets.Key(wsID, r.ScopeID, r.Key)) // forgets the key too
		switch {
		case err == nil, errors.Is(err, secrets.ErrNotFound):
			pruned++
		case errors.Is(err, secrets.ErrLocked), errors.Is(err, secrets.ErrNoPassword):
			return pruned, fmt.Errorf("prune secrets: %w", err)
		default:
			errs = append(errs, fmt.Errorf("prune secret %s: %w", r.Key, err))
		}
	}
	return pruned, errors.Join(errs...)
}
