package secrets

import (
	"errors"
	"fmt"

	"pakpos/internal/core/model"
)

// SecretKeys returns the keys of the secret variables in vars (enabled or
// not), in order and without duplicates or empty keys.
func SecretKeys(vars []model.Variable) []string {
	seen := map[string]bool{}
	var out []string
	for _, v := range vars {
		if v.Secret && v.Key != "" && !seen[v.Key] {
			seen[v.Key] = true
			out = append(out, v.Key)
		}
	}
	return out
}

// RemovedSecrets returns the keys that are secret variables in before but
// not in after: removed, renamed (the old key) or no longer secret. Their
// stored values should be deleted.
func RemovedSecrets(before, after []model.Variable) []string {
	keep := map[string]bool{}
	for _, k := range SecretKeys(after) {
		keep[k] = true
	}
	var out []string
	for _, k := range SecretKeys(before) {
		if !keep[k] {
			out = append(out, k)
		}
	}
	return out
}

// DeleteKeys deletes the values of keys in one scope. It tries every key
// and returns the errors joined.
func DeleteKeys(s Store, workspaceID, scopeID string, keys []string) error {
	var errs []error
	for _, k := range keys {
		if err := s.Delete(Key(workspaceID, scopeID, k)); err != nil && !errors.Is(err, ErrNotFound) {
			errs = append(errs, fmt.Errorf("delete secret %s: %w", k, err))
		}
	}
	return errors.Join(errs...)
}

// CopyKeys copies the stored values of keys from one scope to another (used
// when an environment is duplicated). Keys without a stored value are
// skipped. It tries every key and returns the errors joined.
func CopyKeys(s Store, workspaceID, fromScope, toScope string, keys []string) error {
	var errs []error
	for _, k := range keys {
		v, err := s.Get(Key(workspaceID, fromScope, k))
		if errors.Is(err, ErrNotFound) {
			continue
		}
		if err == nil {
			err = s.Set(Key(workspaceID, toScope, k), v)
		}
		if err != nil {
			errs = append(errs, fmt.Errorf("copy secret %s: %w", k, err))
		}
	}
	return errors.Join(errs...)
}

// Fill returns a copy of vars with each enabled secret's value loaded from
// the store. A secret without a usable value is left out of out and its key
// is listed in missing, so the caller can keep it as an unset variable that
// shadows lower scopes. That covers no stored value, no master password yet,
// a locked store (those keys are also listed in locked) and read errors
// (returned joined).
func Fill(s Store, workspaceID, scopeID string, vars []model.Variable) (out []model.Variable, missing, locked []string, err error) {
	out = make([]model.Variable, 0, len(vars))
	var errs []error
	for _, v := range vars {
		if !v.Secret || !v.Enabled || v.Key == "" {
			out = append(out, v)
			continue
		}
		val, gerr := s.Get(Key(workspaceID, scopeID, v.Key))
		if gerr == nil {
			v.Value = val
			out = append(out, v)
			continue
		}
		missing = append(missing, v.Key)
		switch {
		case errors.Is(gerr, ErrNotFound), errors.Is(gerr, ErrNoPassword):
			// Not set on this machine.
		case errors.Is(gerr, ErrLocked):
			locked = append(locked, v.Key)
		default:
			errs = append(errs, fmt.Errorf("read secret %s: %w", v.Key, gerr))
		}
	}
	return out, missing, locked, errors.Join(errs...)
}
