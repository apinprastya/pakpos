// Package vars resolves {{name}} references against ordered variable scopes
// and generates dynamic values ({{$guid}}, {{$timestamp}}, ...).
//
// Rules:
//   - Scopes are passed lowest precedence first (global, collection,
//     environment, local); a later scope overrides an earlier one.
//   - Only enabled rows with a non-empty key take part. Secret rows resolve
//     like any other row: the caller fills their Value from the secret store
//     before resolving. A secret with no value it can use goes in the
//     scope's Unset list instead: it still shadows the same name in lower
//     scopes, but references to it stay unresolved.
//   - An unresolved reference stays in the text as written and its name is
//     reported. Names are matched exactly (case-sensitive); whitespace inside
//     the braces is ignored ({{ name }}).
//   - A value may reference other variables, up to MaxDepth levels. A cycle
//     is an error (ErrCycle), as is nesting deeper than MaxDepth (ErrTooDeep).
//   - Dynamic variables get a fresh value at every occurrence and are never
//     resolved further. An unknown $name is looked up in the scopes like any
//     other name.
//
// The package has no Wails dependency.
package vars

import (
	"crypto/rand"
	"encoding/binary"
	"errors"
	"fmt"
	"io"
	"sort"
	"strconv"
	"strings"
	"time"

	"pakpos/internal/core/model"
)

// MaxDepth is how many levels of nested references are followed.
const MaxDepth = 10

// Errors returned by Resolve. Check with errors.Is.
var (
	ErrCycle   = errors.New("variable cycle")
	ErrTooDeep = errors.New("variables nested too deeply")
)

// ScopeKind names where a variable comes from.
type ScopeKind string

// Scope kinds, lowest precedence first.
const (
	ScopeGlobal      ScopeKind = "global"
	ScopeCollection  ScopeKind = "collection"
	ScopeEnvironment ScopeKind = "environment"
	ScopeLocal       ScopeKind = "local"
)

// Scope is one level of variables. ID and Name identify it for the UI (and,
// with the workspace ID, for secret keys).
type Scope struct {
	Kind      ScopeKind        `json:"kind"`
	ID        string           `json:"id"`
	Name      string           `json:"name"`
	Variables []model.Variable `json:"variables"`
	// Unset names secret variables of this scope that have no usable value
	// (not stored on this machine, or the store is locked). They win over
	// lower scopes like any variable, but resolve to nothing.
	Unset []string `json:"unset"`
}

// Match is the winning definition of a name.
type Match struct {
	Name   string    `json:"name"`
	Value  string    `json:"value"`
	Secret bool      `json:"secret"`
	Scope  ScopeKind `json:"scope"`
	// ScopeID and ScopeName identify the scope the value came from.
	ScopeID   string `json:"scopeId"`
	ScopeName string `json:"scopeName"`
	// Unset is true for a secret without a usable value (see Scope.Unset).
	Unset bool `json:"unset"`
}

// Dynamic variable names (written as {{$guid}} etc.).
const (
	DynGUID         = "$guid"
	DynRandomUUID   = "$randomUUID"
	DynTimestamp    = "$timestamp"
	DynISOTimestamp = "$isoTimestamp"
	DynRandomInt    = "$randomInt"
)

// DynamicNames lists the supported dynamic variables, sorted.
func DynamicNames() []string {
	return []string{DynGUID, DynISOTimestamp, DynRandomInt, DynRandomUUID, DynTimestamp}
}

// IsDynamic reports whether name is a supported dynamic variable.
func IsDynamic(name string) bool {
	switch name {
	case DynGUID, DynRandomUUID, DynTimestamp, DynISOTimestamp, DynRandomInt:
		return true
	}
	return false
}

// Option configures a Resolver.
type Option func(*Resolver)

// WithClock sets the time source for $timestamp and $isoTimestamp.
func WithClock(now func() time.Time) Option {
	return func(r *Resolver) { r.now = now }
}

// WithRand sets the random source for $guid, $randomUUID and $randomInt.
func WithRand(src io.Reader) Option {
	return func(r *Resolver) { r.rand = src }
}

// Resolver resolves references against a fixed set of scopes. It is safe
// for concurrent use if its random source is.
type Resolver struct {
	vars map[string]Match
	now  func() time.Time
	rand io.Reader
}

// New builds a Resolver. scopes are ordered lowest precedence first.
func New(scopes []Scope, opts ...Option) *Resolver {
	r := &Resolver{vars: map[string]Match{}, now: time.Now, rand: rand.Reader}
	for _, s := range scopes {
		for _, v := range s.Variables {
			if !v.Enabled || v.Key == "" {
				continue
			}
			r.vars[v.Key] = Match{
				Name: v.Key, Value: v.Value, Secret: v.Secret,
				Scope: s.Kind, ScopeID: s.ID, ScopeName: s.Name,
			}
		}
		for _, name := range s.Unset {
			if name != "" {
				r.vars[name] = Match{Name: name, Secret: true, Scope: s.Kind, ScopeID: s.ID, ScopeName: s.Name, Unset: true}
			}
		}
	}
	for _, o := range opts {
		o(r)
	}
	return r
}

// Lookup returns the winning definition of name (not resolved further).
func (r *Resolver) Lookup(name string) (Match, bool) {
	m, ok := r.vars[name]
	return m, ok
}

// Resolve replaces every {{name}} in s. It returns the result and the
// sorted, deduplicated names that could not be resolved.
func (r *Resolver) Resolve(s string) (string, []string, error) {
	unresolved := map[string]struct{}{}
	out, err := r.expand(s, nil, unresolved)
	if err != nil {
		return "", nil, err
	}
	return out, sortedNames(unresolved), nil
}

// expand resolves the references in s. stack holds the names being expanded
// (outermost first) for cycle detection and depth limiting.
func (r *Resolver) expand(s string, stack []string, unresolved map[string]struct{}) (string, error) {
	if !strings.Contains(s, "{{") {
		return s, nil
	}
	var b strings.Builder
	rest := s
	for {
		start := strings.Index(rest, "{{")
		if start < 0 {
			b.WriteString(rest)
			break
		}
		end := strings.Index(rest[start+2:], "}}")
		if end < 0 {
			b.WriteString(rest)
			break
		}
		inner := rest[start+2 : start+2+end]
		// "{{{{a}}" : the reference starts at the last "{{" before "}}".
		if i := strings.LastIndex(inner, "{{"); i >= 0 {
			b.WriteString(rest[:start+2+i])
			rest = rest[start+2+i:]
			continue
		}
		b.WriteString(rest[:start])
		ref := rest[start : start+4+end]
		rest = rest[start+4+end:]

		name, ok := refName(inner)
		if !ok {
			b.WriteString(ref)
			continue
		}
		val, found, err := r.value(name, stack, unresolved)
		if err != nil {
			return "", err
		}
		if !found {
			unresolved[name] = struct{}{}
			b.WriteString(ref)
			continue
		}
		b.WriteString(val)
	}
	return b.String(), nil
}

// value returns the fully resolved value of name.
func (r *Resolver) value(name string, stack []string, unresolved map[string]struct{}) (string, bool, error) {
	if IsDynamic(name) {
		v, err := r.dynamic(name)
		return v, err == nil, err
	}
	m, ok := r.vars[name]
	if !ok || m.Unset {
		return "", false, nil
	}
	for i, n := range stack {
		if n == name {
			chain := append(append([]string{}, stack[i:]...), name)
			return "", false, fmt.Errorf("%w: %s", ErrCycle, strings.Join(chain, " -> "))
		}
	}
	if len(stack) >= MaxDepth {
		return "", false, fmt.Errorf("%w: more than %d levels at %s", ErrTooDeep, MaxDepth, strings.Join(append(append([]string{}, stack...), name), " -> "))
	}
	v, err := r.expand(m.Value, append(stack, name), unresolved)
	return v, err == nil, err
}

// refName validates the text between the braces. Names cannot be empty or
// contain braces or line breaks.
func refName(inner string) (string, bool) {
	name := strings.TrimSpace(inner)
	if name == "" || strings.ContainsAny(name, "{}\r\n") {
		return "", false
	}
	return name, true
}

func (r *Resolver) dynamic(name string) (string, error) {
	switch name {
	case DynTimestamp:
		return strconv.FormatInt(r.now().Unix(), 10), nil
	case DynISOTimestamp:
		return r.now().UTC().Format("2006-01-02T15:04:05.000Z07:00"), nil
	case DynRandomInt:
		n, err := r.randomInt(1001)
		if err != nil {
			return "", err
		}
		return strconv.Itoa(n), nil
	default: // DynGUID, DynRandomUUID
		return r.uuid()
	}
}

// uuid returns a random (version 4) UUID.
func (r *Resolver) uuid() (string, error) {
	var b [16]byte
	if _, err := io.ReadFull(r.rand, b[:]); err != nil {
		return "", fmt.Errorf("generate uuid: %w", err)
	}
	b[6] = b[6]&0x0f | 0x40
	b[8] = b[8]&0x3f | 0x80
	return fmt.Sprintf("%x-%x-%x-%x-%x", b[0:4], b[4:6], b[6:8], b[8:10], b[10:16]), nil
}

// randomInt returns a uniform integer in [0, n) using rejection sampling.
func (r *Resolver) randomInt(n uint32) (int, error) {
	limit := ^uint32(0) - ^uint32(0)%n
	var b [4]byte
	for range 64 {
		if _, err := io.ReadFull(r.rand, b[:]); err != nil {
			return 0, fmt.Errorf("generate random int: %w", err)
		}
		if v := binary.BigEndian.Uint32(b[:]); v < limit {
			return int(v % n), nil
		}
	}
	return 0, errors.New("generate random int: random source is not uniform")
}

func sortedNames(set map[string]struct{}) []string {
	out := make([]string, 0, len(set))
	for n := range set {
		out = append(out, n)
	}
	sort.Strings(out)
	return out
}

// Resolve is a shortcut for New(scopes, opts...).Resolve(s).
func Resolve(s string, scopes []Scope, opts ...Option) (string, []string, error) {
	return New(scopes, opts...).Resolve(s)
}
