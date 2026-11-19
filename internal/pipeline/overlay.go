package pipeline

import (
	"errors"
	"fmt"
	"slices"
	"sort"
	"strings"
	"sync"

	"pakpos/internal/core/model"
	"pakpos/internal/core/vars"
	"pakpos/internal/secrets"
)

// OverlayState says how the overlay changes a variable.
type OverlayState string

// Overlay states. OverlayNone is a value from the file.
const (
	OverlayNone OverlayState = ""
	// OverlaySet replaces the value of a variable the file defines.
	OverlaySet OverlayState = "set"
	// OverlayNew is a variable only a script defined.
	OverlayNew OverlayState = "new"
	// OverlayUnset hides a variable the file defines (pm.*.unset).
	OverlayUnset OverlayState = "unset"
)

type overlayEntry struct {
	value string
	unset bool
}

// Overlay holds the values scripts set on the globals, collections and
// environments of one open workspace, keyed by scope ID and variable
// name. It lives in memory only: it is never written to SQLite or the
// workspace (PersistOverlay writes a value through SaveVariables on
// request) and is dropped with the workspace. Secret targets never land
// here; scripts write those through the secret store. It is safe for
// concurrent use.
type Overlay struct {
	mu      sync.Mutex
	entries map[string]map[string]overlayEntry
}

// NewOverlay returns an empty overlay.
func NewOverlay() *Overlay {
	return &Overlay{entries: map[string]map[string]overlayEntry{}}
}

func (o *Overlay) put(scopeID, key string, e overlayEntry) {
	o.mu.Lock()
	defer o.mu.Unlock()
	if o.entries[scopeID] == nil {
		o.entries[scopeID] = map[string]overlayEntry{}
	}
	o.entries[scopeID][key] = e
}

// drop removes one key ("" for every key) of a scope.
func (o *Overlay) drop(scopeID, key string) {
	o.mu.Lock()
	defer o.mu.Unlock()
	if key == "" {
		delete(o.entries, scopeID)
		return
	}
	delete(o.entries[scopeID], key)
	if len(o.entries[scopeID]) == 0 {
		delete(o.entries, scopeID)
	}
}

// putIfSet is put on an overlay that may be nil (a session without one).
func (o *Overlay) putIfSet(scopeID, key string, e overlayEntry) {
	if o != nil {
		o.put(scopeID, key, e)
	}
}

// dropIfSet is drop on an overlay that may be nil.
func (o *Overlay) dropIfSet(scopeID, key string) {
	if o != nil {
		o.drop(scopeID, key)
	}
}

// scope returns a copy of a scope's entries.
func (o *Overlay) scope(scopeID string) map[string]overlayEntry {
	if o == nil {
		return nil
	}
	o.mu.Lock()
	defer o.mu.Unlock()
	if len(o.entries[scopeID]) == 0 {
		return nil
	}
	out := make(map[string]overlayEntry, len(o.entries[scopeID]))
	for k, e := range o.entries[scopeID] {
		out[k] = e
	}
	return out
}

func sortedKeys[V any](m map[string]V) []string {
	keys := make([]string, 0, len(m))
	for k := range m {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	return keys
}

// WithOverlay makes the session lay ov over file values (BuildScopes) and
// lets its sends' scripts write to it. nil means none.
func (s *Session) WithOverlay(ov *Overlay) *Session {
	s.overlay = ov
	return s
}

// hasRow reports whether a scope defines key (a row, enabled or not, or an
// unset secret).
func hasRow(sc vars.Scope, key string) bool {
	return slices.ContainsFunc(sc.Variables, func(v model.Variable) bool { return v.Key == key }) || slices.Contains(sc.Unset, key)
}

// isSecret reports whether a scope's definition of key is a secret.
func isSecret(sc vars.Scope, key string) bool {
	return slices.ContainsFunc(sc.Variables, func(v model.Variable) bool { return v.Key == key && v.Secret }) || slices.Contains(sc.Unset, key)
}

// withoutKey drops every enabled row and unset secret named key.
func withoutKey(sc *vars.Scope, key string) {
	sc.Variables = slices.DeleteFunc(sc.Variables, func(v model.Variable) bool { return v.Enabled && v.Key == key })
	sc.Unset = slices.DeleteFunc(sc.Unset, func(n string) bool { return n == key })
}

// setRow makes key resolve to value in sc (the last row wins).
func setRow(sc *vars.Scope, key, value string, secret bool) {
	withoutKey(sc, key)
	sc.Variables = append(sc.Variables, model.Variable{Key: key, Value: value, Enabled: true, Secret: secret})
}

// applyOverlay lays a scope's overlay entries over its (filled) variables
// and records each key's state in states.
func applyOverlay(sc vars.Scope, entries map[string]overlayEntry, states map[string]OverlayState) vars.Scope {
	for _, key := range sortedKeys(entries) {
		e := entries[key]
		existed := hasRow(sc, key)
		switch {
		case e.unset:
			withoutKey(&sc, key)
			states[lockKey(sc.ID, key)] = OverlayUnset
		default:
			secret := isSecret(sc, key)
			setRow(&sc, key, e.value, secret)
			state := OverlaySet
			if !existed {
				state = OverlayNew
			}
			states[lockKey(sc.ID, key)] = state
		}
	}
	return sc
}

// OverlayValue is a value scripts set on a scope. Value is "" for an
// unset variable and for a secret.
type OverlayValue struct {
	Key    string       `json:"key"`
	Value  string       `json:"value"`
	State  OverlayState `json:"state"`
	Secret bool         `json:"secret"`
}

// OverlayValues lists the overlay of a scope, sorted by key.
func (s *Session) OverlayValues(ref ScopeRef) ([]OverlayValue, error) {
	scopeID, vs, err := s.scope(ref)
	if err != nil {
		return nil, err
	}
	file := vars.Scope{ID: scopeID, Variables: vs}
	entries := s.overlay.scope(scopeID)
	out := []OverlayValue{}
	for _, key := range sortedKeys(entries) {
		e := entries[key]
		v := OverlayValue{Key: key, Value: e.value, State: OverlaySet, Secret: isSecret(file, key)}
		switch {
		case e.unset:
			v.State, v.Value = OverlayUnset, ""
		case !hasRow(file, key):
			v.State = OverlayNew
		}
		if v.Secret {
			v.Value = ""
		}
		out = append(out, v)
	}
	return out, nil
}

// ErrNoOverlay is returned when the session has no overlay to change.
var ErrNoOverlay = errors.New("no script values are kept for this workspace")

// ResetOverlay drops the script value of key in a scope ("" drops all of
// the scope's), so the file value applies again.
func (s *Session) ResetOverlay(ref ScopeRef, key string) error {
	scopeID, _, err := s.scope(ref)
	if err != nil {
		return err
	}
	if s.overlay == nil {
		return ErrNoOverlay
	}
	s.overlay.drop(scopeID, strings.TrimSpace(key))
	return nil
}

// PersistOverlay writes the script value of key in a scope ("" for all of
// the scope's) to the workspace file through SaveVariables, then drops it
// from the overlay. A set value updates the variable's rows (or adds a
// row); an unset one removes the variable. A secret's value goes to the
// secret store, never the file. It returns the scope's variables as saved.
func (s *Session) PersistOverlay(ref ScopeRef, key string) ([]model.Variable, error) {
	scopeID, vs, err := s.scope(ref)
	if err != nil {
		return nil, err
	}
	if s.overlay == nil {
		return nil, ErrNoOverlay
	}
	entries := s.overlay.scope(scopeID)
	keys := sortedKeys(entries)
	if key = strings.TrimSpace(key); key != "" {
		if _, ok := entries[key]; !ok {
			return nil, fmt.Errorf("%q has no value set by a script", key)
		}
		keys = []string{key}
	}
	next := slices.Clone(vs)
	for _, k := range keys {
		e := entries[k]
		if e.unset {
			next = slices.DeleteFunc(next, func(v model.Variable) bool { return v.Key == k })
			continue
		}
		if isSecret(vars.Scope{Variables: next}, k) {
			if err := s.sec.Set(secrets.Key(s.workspaceID(), scopeID, k), e.value); err != nil {
				return nil, err
			}
			continue
		}
		next = persistRow(next, k, e.value)
	}
	saved, err := s.SaveVariables(ref, next)
	if err != nil {
		return nil, err
	}
	for _, k := range keys {
		s.overlay.drop(scopeID, k)
	}
	return saved, nil
}

// persistRow sets key's value on every row named key, enabling the last
// one when none is enabled, or appends an enabled row.
func persistRow(rows []model.Variable, key, value string) []model.Variable {
	last, enabled := -1, false
	for i := range rows {
		if rows[i].Key == key {
			rows[i].Value = value
			last = i
			enabled = enabled || rows[i].Enabled
		}
	}
	switch {
	case last < 0:
		return append(rows, model.Variable{Key: key, Value: value, Enabled: true})
	case !enabled:
		rows[last].Enabled = true
	}
	return rows
}
