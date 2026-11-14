package pipeline

import (
	"errors"
	"fmt"
	"strings"

	"pakpos/internal/core/model"
	"pakpos/internal/core/vars"
	"pakpos/internal/secrets"
	"pakpos/internal/store/fsstore"
)

// ScopeRef names a variable scope that holds secrets: the globals (ID is
// ignored), a collection or an environment.
type ScopeRef struct {
	Kind vars.ScopeKind `json:"kind"`
	ID   string         `json:"id"`
}

// ErrInvalidScope is returned for a scope kind that has no stored variables.
var ErrInvalidScope = errors.New("variables can only be stored for globals, a collection or an environment")

// scope returns the scope's id (used in secret keys) and its variables.
func (s *Session) scope(ref ScopeRef) (string, []model.Variable, error) {
	switch ref.Kind {
	case vars.ScopeGlobal:
		g := s.ws.GetGlobals()
		return g.ID, g.Variables, nil
	case vars.ScopeCollection:
		c, err := s.ws.GetCollection(ref.ID)
		return c.ID, c.Variables, err
	case vars.ScopeEnvironment:
		e, err := s.ws.GetEnvironment(ref.ID)
		return e.ID, e.Variables, err
	default:
		return "", nil, fmt.Errorf("%w (got %q)", ErrInvalidScope, ref.Kind)
	}
}

// cleanup deletes secret values of keys in a scope. Failures (e.g. a locked
// file store) are logged, not returned: the workspace change already happened
// and the leftover values are harmless (nothing refers to them).
func (s *Session) cleanup(scopeID string, keys []string) {
	if len(keys) == 0 {
		return
	}
	if err := secrets.DeleteKeys(s.sec, s.workspaceID(), scopeID, keys); err != nil {
		s.log.Warn("delete secret values", "scope", scopeID, "err", err)
	}
}

// SecretRename says that the secret variable From was renamed to To in a
// save. The UI knows which row's key changed, so it passes these explicitly.
type SecretRename struct {
	From string `json:"from"`
	To   string `json:"to"`
}

// moveRenamed carries the stored values of renamed secrets to their new keys
// before the save that renames them, so the cleanup after the save (which
// deletes the old keys) loses nothing. A pair counts only when From is a
// secret in before and To is a secret in after. Values are all read first,
// so swapping two names works. A locked store refuses (ErrLocked) before
// anything is written; a secret without a stored value is skipped.
func (s *Session) moveRenamed(scopeID string, before, after []model.Variable, renames []SecretRename) error {
	was, now := map[string]bool{}, map[string]bool{}
	for _, k := range secrets.SecretKeys(before) {
		was[k] = true
	}
	for _, k := range secrets.SecretKeys(after) {
		now[k] = true
	}
	moves := map[string]string{} // new key -> value
	for _, r := range renames {
		from, to := strings.TrimSpace(r.From), strings.TrimSpace(r.To)
		if from == to || !was[from] || !now[to] {
			continue
		}
		v, err := s.sec.Get(secrets.Key(s.workspaceID(), scopeID, from))
		switch {
		case err == nil:
			moves[to] = v
		case errors.Is(err, secrets.ErrNotFound), errors.Is(err, secrets.ErrNoPassword):
		default:
			return fmt.Errorf("move secret %s to %s: %w", from, to, err)
		}
	}
	for to, v := range moves {
		if err := s.sec.Set(secrets.Key(s.workspaceID(), scopeID, to), v); err != nil {
			return fmt.Errorf("move secret to %s: %w", to, err)
		}
	}
	return nil
}

// SaveVariables replaces a scope's variables. Secret values are never
// written to the workspace. Renamed secrets (renames) keep their stored
// value under the new key; the stored values of secrets that were removed,
// renamed or made non-secret are deleted.
func (s *Session) SaveVariables(ref ScopeRef, vs []model.Variable, renames ...SecretRename) ([]model.Variable, error) {
	scopeID, before, err := s.scope(ref)
	if err != nil {
		return nil, err
	}
	if err := s.moveRenamed(scopeID, before, vs, renames); err != nil {
		return nil, err
	}
	var saved []model.Variable
	switch ref.Kind {
	case vars.ScopeGlobal:
		g, err := s.ws.SaveGlobals(vs)
		if err != nil {
			return nil, err
		}
		saved = g.Variables
	case vars.ScopeCollection:
		c, err := s.ws.GetCollection(ref.ID)
		if err != nil {
			return nil, err
		}
		saved, err = s.saveCollection(c.ID, fsstore.CollectionSettings{Auth: c.Auth, Headers: c.Headers, Variables: vs}, before)
		if err != nil {
			return nil, err
		}
		return saved, nil
	default: // environment; scope() rejected anything else
		e, err := s.ws.SaveEnvironmentVariables(ref.ID, vs)
		if err != nil {
			return nil, err
		}
		saved = e.Variables
	}
	s.cleanup(scopeID, secrets.RemovedSecrets(before, saved))
	return saved, nil
}

// SaveCollection replaces a collection's auth, headers and variables, moves
// the stored values of renamed secrets, and deletes those of secrets it no
// longer has.
func (s *Session) SaveCollection(id string, settings fsstore.CollectionSettings, renames ...SecretRename) (fsstore.Collection, error) {
	before, err := s.ws.GetCollection(id)
	if err != nil {
		return fsstore.Collection{}, err
	}
	if err := s.moveRenamed(before.ID, before.Variables, settings.Variables, renames); err != nil {
		return fsstore.Collection{}, err
	}
	if _, err := s.saveCollection(id, settings, before.Variables); err != nil {
		return fsstore.Collection{}, err
	}
	return s.ws.GetCollection(id)
}

func (s *Session) saveCollection(id string, settings fsstore.CollectionSettings, before []model.Variable) ([]model.Variable, error) {
	c, err := s.ws.SaveCollection(id, settings)
	if err != nil {
		return nil, err
	}
	s.cleanup(c.ID, secrets.RemovedSecrets(before, c.Variables))
	return c.Variables, nil
}

// DeleteCollection deletes a collection with everything in it, and the
// stored values of its secret variables.
func (s *Session) DeleteCollection(id string) error {
	c, err := s.ws.GetCollection(id)
	if err != nil {
		return err
	}
	if err := s.ws.DeleteCollection(id); err != nil {
		return err
	}
	s.cleanup(c.ID, secrets.SecretKeys(c.Variables))
	return nil
}

// DuplicateEnvironment copies an environment, including the stored values
// of its secrets on this machine.
func (s *Session) DuplicateEnvironment(id string) (fsstore.Environment, error) {
	src, err := s.ws.GetEnvironment(id)
	if err != nil {
		return fsstore.Environment{}, err
	}
	dup, err := s.ws.DuplicateEnvironment(id)
	if err != nil {
		return fsstore.Environment{}, err
	}
	if err := secrets.CopyKeys(s.sec, s.workspaceID(), src.ID, dup.ID, secrets.SecretKeys(src.Variables)); err != nil {
		s.log.Warn("copy secret values", "environment", dup.ID, "err", err)
	}
	return dup, nil
}

// DeleteEnvironment deletes an environment and the stored values of its secrets.
func (s *Session) DeleteEnvironment(id string) error {
	e, err := s.ws.GetEnvironment(id)
	if err != nil {
		return err
	}
	if err := s.ws.DeleteEnvironment(id); err != nil {
		return err
	}
	s.cleanup(e.ID, secrets.SecretKeys(e.Variables))
	return nil
}

func cleanKey(key string) (string, error) {
	key = strings.TrimSpace(key)
	if key == "" {
		return "", errors.New("a secret needs a variable name")
	}
	return key, nil
}

// SetSecret stores the value of a secret variable in a scope.
func (s *Session) SetSecret(ref ScopeRef, key, value string) error {
	scopeID, _, err := s.scope(ref)
	if err != nil {
		return err
	}
	if key, err = cleanKey(key); err != nil {
		return err
	}
	return s.sec.Set(secrets.Key(s.workspaceID(), scopeID, key), value)
}

// ClearSecret deletes the stored value of a secret variable in a scope.
func (s *Session) ClearSecret(ref ScopeRef, key string) error {
	scopeID, _, err := s.scope(ref)
	if err != nil {
		return err
	}
	if key, err = cleanKey(key); err != nil {
		return err
	}
	return secrets.DeleteKeys(s.sec, s.workspaceID(), scopeID, []string{key})
}

// SecretStatus says which secret variables of a scope have a value stored
// on this machine. Values are never returned.
type SecretStatus struct {
	// Set lists the keys with a stored value, in variable order.
	Set []string `json:"set"`
	// Locked is true when the store is locked, so Set can't be known.
	Locked bool `json:"locked"`
}

// SecretStatus reports which secrets of a scope have a stored value.
func (s *Session) SecretStatus(ref ScopeRef) (SecretStatus, error) {
	scopeID, vs, err := s.scope(ref)
	if err != nil {
		return SecretStatus{}, err
	}
	st := SecretStatus{Set: []string{}}
	for _, k := range secrets.SecretKeys(vs) {
		_, err := s.sec.Get(secrets.Key(s.workspaceID(), scopeID, k))
		switch {
		case err == nil:
			st.Set = append(st.Set, k)
		case errors.Is(err, secrets.ErrLocked):
			st.Locked = true
		case errors.Is(err, secrets.ErrNotFound), errors.Is(err, secrets.ErrNoPassword):
		default:
			return SecretStatus{}, err
		}
	}
	return st, nil
}

// ErrNotSecret is returned when a key isn't a secret variable of the scope.
var ErrNotSecret = errors.New("not a secret variable")

// secretIn returns the scope's id and variables, after checking that key is
// a secret variable there.
func (s *Session) secretIn(ref ScopeRef, key string) (string, []model.Variable, string, error) {
	scopeID, vs, err := s.scope(ref)
	if err != nil {
		return "", nil, "", err
	}
	if key, err = cleanKey(key); err != nil {
		return "", nil, "", err
	}
	for _, v := range vs {
		if v.Secret && v.Key == key {
			return scopeID, vs, key, nil
		}
	}
	return "", nil, "", fmt.Errorf("%q: %w", key, ErrNotSecret)
}

// RevealSecret returns the stored value of one secret variable. It is only
// called when the user asks to see the value. A secret with no value on this
// machine returns secrets.ErrNotFound.
func (s *Session) RevealSecret(ref ScopeRef, key string) (string, error) {
	scopeID, _, key, err := s.secretIn(ref, key)
	if err != nil {
		return "", err
	}
	v, err := s.sec.Get(secrets.Key(s.workspaceID(), scopeID, key))
	if errors.Is(err, secrets.ErrNoPassword) {
		err = secrets.ErrNotFound
	}
	return v, err
}

// MakePlain turns a secret variable into a plain one: its stored value (or
// "" when there is none) is written to the workspace file, and the stored
// value is deleted. The value never leaves Go. It returns the scope's
// variables as saved.
func (s *Session) MakePlain(ref ScopeRef, key string) ([]model.Variable, error) {
	scopeID, vs, key, err := s.secretIn(ref, key)
	if err != nil {
		return nil, err
	}
	val, err := s.sec.Get(secrets.Key(s.workspaceID(), scopeID, key))
	switch {
	case err == nil, errors.Is(err, secrets.ErrNotFound), errors.Is(err, secrets.ErrNoPassword):
	default:
		return nil, err
	}
	next := make([]model.Variable, len(vs))
	for i, v := range vs {
		if v.Secret && v.Key == key {
			v.Secret, v.Value = false, val
		}
		next[i] = v
	}
	return s.SaveVariables(ref, next)
}
