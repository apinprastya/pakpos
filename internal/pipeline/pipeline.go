// Package pipeline prepares a request for sending: it loads the inheritance
// chain from the workspace, applies inherited auth and headers, builds the
// variable scopes (globals, collection, selected environment, local) with
// secret values from the secret store, and resolves {{variables}}. It also
// keeps the secret store in step with workspace changes (saving variables,
// duplicating or deleting environments and collections).
//
// It ties fsstore, secrets, core/inherit and core/vars together so the Wails
// services stay thin. The package has no Wails dependency.
package pipeline

import (
	"errors"
	"fmt"
	"log/slog"
	"sort"
	"strings"

	"pakpos/internal/core/inherit"
	"pakpos/internal/core/model"
	"pakpos/internal/core/vars"
	"pakpos/internal/secrets"
	"pakpos/internal/store/fsstore"
)

// Scope names shown in the UI for the scopes without a user-given name.
const (
	GlobalsName = "Globals"
	LocalName   = "Local"
)

// Session works on one open workspace and the secret store.
type Session struct {
	ws  *fsstore.Workspace
	sec secrets.Store
	log *slog.Logger
	// opts are passed to the resolver (tests inject a clock and random source).
	opts []vars.Option
}

// New returns a Session. log may be nil.
func New(ws *fsstore.Workspace, sec secrets.Store, log *slog.Logger, opts ...vars.Option) *Session {
	if log == nil {
		log = slog.Default()
	}
	return &Session{ws: ws, sec: sec, log: log, opts: opts}
}

func (s *Session) workspaceID() string { return s.ws.Manifest().ID }

// EnvRef identifies an environment by id and name.
type EnvRef struct {
	ID   string `json:"id"`
	Name string `json:"name"`
}

// Environment returns the environment with id, or nil when id is empty or
// no longer exists (a deleted selection counts as no environment).
func (s *Session) Environment(id string) *fsstore.Environment {
	if id == "" {
		return nil
	}
	e, err := s.ws.GetEnvironment(id)
	if err != nil {
		return nil
	}
	return &e
}

// Chain returns the levels a request inherits from. A saved request (its id
// is found in the workspace) uses its parent on disk; otherwise parentID,
// the collection or folder a draft belongs to. An unknown parent gives an
// empty chain, so the request is sent as it is.
func (s *Session) Chain(req model.Request, parentID string) []inherit.Level {
	start := parentID
	if req.ID != "" {
		if p, err := s.ws.RequestParent(req.ID); err == nil {
			start = p
		}
	}
	if start == "" {
		return nil
	}
	chain, err := s.ws.InheritChain(start)
	if err != nil {
		if !errors.Is(err, fsstore.ErrNotFound) {
			s.log.Warn("load inheritance chain", "id", start, "err", err)
		}
		return nil
	}
	return chain
}

// Scopes holds the variable scopes of a send, lowest precedence first, with
// secret values filled in. It must never be written anywhere. A secret
// without a usable value stays in its scope's Unset list, so it still
// shadows the same name in lower scopes and shows up as unresolved.
type Scopes struct {
	List []vars.Scope
	// Locked holds the secrets (by lockKey) without a value because the
	// secret store is locked.
	Locked map[string]bool
}

func lockKey(scopeID, name string) string { return scopeID + "\x00" + name }

// BuildScopes returns globals, the collection (when collectionID is set),
// the environment (when env is not nil) and an empty local scope.
func (s *Session) BuildScopes(collectionID string, env *fsstore.Environment) Scopes {
	g := s.ws.GetGlobals()
	raw := []vars.Scope{{Kind: vars.ScopeGlobal, ID: g.ID, Name: GlobalsName, Variables: g.Variables}}
	if collectionID != "" {
		if c, err := s.ws.GetCollection(collectionID); err == nil {
			raw = append(raw, vars.Scope{Kind: vars.ScopeCollection, ID: c.ID, Name: c.Name, Variables: c.Variables})
		}
	}
	if env != nil {
		raw = append(raw, vars.Scope{Kind: vars.ScopeEnvironment, ID: env.ID, Name: env.Name, Variables: env.Variables})
	}
	raw = append(raw, vars.Scope{Kind: vars.ScopeLocal, Name: LocalName})

	out := Scopes{Locked: map[string]bool{}}
	wsID := s.workspaceID()
	for _, sc := range raw {
		filled, missing, locked, err := secrets.Fill(s.sec, wsID, sc.ID, sc.Variables)
		if err != nil {
			s.log.Warn("read secrets", "scope", sc.Kind, "err", err)
		}
		for _, k := range locked {
			out.Locked[lockKey(sc.ID, k)] = true
		}
		sc.Variables, sc.Unset = filled, missing
		out.List = append(out.List, sc)
	}
	return out
}

func collectionOf(chain []inherit.Level) string {
	if len(chain) > 0 && chain[0].Kind == inherit.KindCollection {
		return chain[0].ID
	}
	return ""
}

// Prepared is a request ready to send.
type Prepared struct {
	// Effective is the request with inherited auth and headers applied,
	// before variables are resolved, plus where they came from.
	Effective inherit.Result
	// Request is Effective.Request with variables resolved. It may hold
	// secret values: send it, never store it.
	Request    model.Request
	Unresolved []string
	// SecretsLocked is true when a secret the request uses could not be
	// read because the secret store is locked.
	SecretsLocked bool
	Environment   *EnvRef
}

// VariableError is returned by Prepare when variables can't be resolved: a
// cycle (vars.ErrCycle) or nesting deeper than vars.MaxDepth (vars.ErrTooDeep).
type VariableError struct{ Err error }

func (e *VariableError) Error() string { return e.Err.Error() }
func (e *VariableError) Unwrap() error { return e.Err }

// Prepare runs the pipeline: chain, inherit, scopes (with secrets), resolve.
// envID is the selected environment ("" or a deleted id means none). The
// returned Prepared has Effective and Environment set even on error.
func (s *Session) Prepare(req model.Request, parentID, envID string) (Prepared, error) {
	chain := s.Chain(req, parentID)
	env := s.Environment(envID)
	scopes := s.BuildScopes(collectionOf(chain), env)
	p, err := prepare(inherit.Effective(chain, req), scopes, s.opts)
	if env != nil {
		p.Environment = &EnvRef{ID: env.ID, Name: env.Name}
	}
	return p, err
}

// PrepareWithoutWorkspace is Prepare for a send with no workspace open:
// nothing is inherited and there are no variables, but dynamic variables
// ({{$guid}}...) still resolve.
func PrepareWithoutWorkspace(req model.Request, opts ...vars.Option) (Prepared, error) {
	return prepare(inherit.Effective(nil, req), Scopes{Locked: map[string]bool{}}, opts)
}

func prepare(eff inherit.Result, scopes Scopes, opts []vars.Option) (Prepared, error) {
	p := Prepared{Effective: eff, Unresolved: []string{}}
	res := vars.New(scopes.List, opts...)
	resolved, unresolved, err := res.ResolveRequest(eff.Request)
	if err != nil {
		return p, &VariableError{Err: err}
	}
	p.Request = resolved
	if unresolved != nil {
		p.Unresolved = unresolved
	}
	p.SecretsLocked = anyLocked(res, p.Unresolved, scopes.Locked)
	return p, nil
}

// anyLocked reports whether an unresolved name's winning definition is a
// secret that couldn't be read because the store is locked.
func anyLocked(res *vars.Resolver, names []string, locked map[string]bool) bool {
	for _, n := range names {
		if m, ok := res.Lookup(n); ok && m.Unset && locked[lockKey(m.ScopeID, n)] {
			return true
		}
	}
	return false
}

// PreviewVariable is a variable visible to a request: the winning
// definition of its name. Value is always empty for secrets.
type PreviewVariable struct {
	Key    string         `json:"key"`
	Value  string         `json:"value"`
	Secret bool           `json:"secret"`
	Scope  vars.ScopeKind `json:"scope"`
	// ScopeID and ScopeName identify the scope the value comes from.
	ScopeID   string `json:"scopeId"`
	ScopeName string `json:"scopeName"`
	// Set is false for a secret with no value on this machine (or one that
	// can't be read while the store is locked); it still wins over lower
	// scopes, so the name stays unresolved. Always true otherwise.
	Set bool `json:"set"`
}

// Preview is what the editor needs to show how a request will be sent,
// without secret values.
type Preview struct {
	// Headers are the inherited headers that are applied, with their source.
	Headers []inherit.Header `json:"headers"`
	// Auth is the effective auth (unresolved) and AuthSource where it comes
	// from when inherited.
	Auth       model.Auth      `json:"auth"`
	AuthSource *inherit.Source `json:"authSource"`
	// Variables are sorted by key.
	Variables     []PreviewVariable `json:"variables"`
	Unresolved    []string          `json:"unresolved"`
	SecretsLocked bool              `json:"secretsLocked"`
	Environment   *EnvRef           `json:"environment"`
	// Error explains why variables can't be resolved (a cycle), or "".
	Error string `json:"error"`
}

// Preview resolves req like Prepare and describes the result for the UI.
func (s *Session) Preview(req model.Request, parentID, envID string) Preview {
	chain := s.Chain(req, parentID)
	eff := inherit.Effective(chain, req)
	pv := Preview{
		Headers: eff.Headers, Auth: eff.Request.Auth, AuthSource: eff.AuthSource,
		Variables: []PreviewVariable{}, Unresolved: []string{},
	}
	env := s.Environment(envID)
	if env != nil {
		pv.Environment = &EnvRef{ID: env.ID, Name: env.Name}
	}
	scopes := s.BuildScopes(collectionOf(chain), env)
	res := vars.New(scopes.List, s.opts...)

	seen := map[string]bool{}
	add := func(name string) {
		if name == "" || seen[name] {
			return
		}
		seen[name] = true
		m, _ := res.Lookup(name) // the winner: an unset secret shadows lower scopes
		pv.Variables = append(pv.Variables, previewVar(m))
	}
	for _, sc := range scopes.List {
		for _, v := range sc.Variables {
			if v.Enabled {
				add(v.Key)
			}
		}
		for _, n := range sc.Unset {
			add(n)
		}
	}
	sort.Slice(pv.Variables, func(i, j int) bool { return pv.Variables[i].Key < pv.Variables[j].Key })

	_, unresolved, err := res.ResolveRequest(eff.Request)
	if err != nil {
		pv.Error = VariableMessage(err)
		return pv
	}
	if unresolved != nil {
		pv.Unresolved = unresolved
	}
	pv.SecretsLocked = anyLocked(res, pv.Unresolved, scopes.Locked)
	return pv
}

func previewVar(m vars.Match) PreviewVariable {
	v := PreviewVariable{Key: m.Name, Value: m.Value, Secret: m.Secret, Scope: m.Scope, ScopeID: m.ScopeID, ScopeName: m.ScopeName, Set: !m.Unset}
	if v.Secret {
		v.Value = ""
	}
	return v
}

// VariableMessage explains a resolution error to the user.
func VariableMessage(err error) string {
	switch {
	case errors.Is(err, vars.ErrCycle):
		return fmt.Sprintf("Variables refer to each other in a loop (%v). Change one of them so the loop ends.", trimSentinel(err, vars.ErrCycle))
	case errors.Is(err, vars.ErrTooDeep):
		return fmt.Sprintf("Variables are nested more than %d levels deep (%v). Simplify the references.", vars.MaxDepth, trimSentinel(err, vars.ErrTooDeep))
	default:
		return "Couldn't resolve variables: " + err.Error()
	}
}

// trimSentinel drops the sentinel's own text from the message, keeping the
// detail (the field and the chain of names).
func trimSentinel(err, sentinel error) string {
	return strings.Replace(err.Error(), sentinel.Error()+": ", "", 1)
}
