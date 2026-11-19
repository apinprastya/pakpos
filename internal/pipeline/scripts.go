package pipeline

import (
	"context"
	"encoding/base64"
	"errors"
	"fmt"
	"io"
	"os"
	"slices"
	"strings"
	"time"

	"pakpos/internal/core/inherit"
	"pakpos/internal/core/model"
	"pakpos/internal/core/script"
	"pakpos/internal/core/vars"
	"pakpos/internal/secrets"
	"pakpos/internal/store/fsstore"
)

// MaxScriptBody is the most of a response body a test script reads (a
// body spilled to a file is read back up to this size).
const MaxScriptBody = 64 << 20

// ScriptOptions configure the scripts of one send.
type ScriptOptions struct {
	// Timeout per script run; script.DefaultTimeout when zero.
	Timeout time.Duration
	// OnConsole receives each script run's console output, masked, as
	// soon as the run ends. It may be nil.
	OnConsole func([]script.ConsoleEntry)
	// Iteration, IterationCount and IterationData describe a runner
	// iteration (a single send is iteration 0 of 1). IterationData also
	// seeds the local scope.
	Iteration      int
	IterationCount int
	IterationData  map[string]string
	// Local, when not nil, seeds the local scope instead of IterationData:
	// the runner passes the previous send's Local() so pm.variables values
	// last for the whole iteration.
	Local map[string]string
}

// ScriptReport is what the scripts of one event (pre-request or test)
// produced, masked: secret values read as [secret:name].
type ScriptReport struct {
	Tests   []script.TestResult
	Console []script.ConsoleEntry
	// Err is the pre-request script error that stops the send. Test
	// script errors become failed tests instead.
	Err *script.Error
	// Skip is true when a pre-request script called skipRequest.
	Skip bool
	// NextRequest is the last setNextRequest call (nil when none):
	// a request name, or "" with NextStop for null.
	NextRequest *string
	NextStop    bool
}

// Send is one send with its scripts: the request's inheritance chain and
// variable scopes, which pre-request scripts change before Prepare
// resolves the request, and the secret values to mask in everything the
// UI gets back. It is not safe for concurrent use.
type Send struct {
	sess     *Session // nil without a workspace
	req      model.Request
	chain    []inherit.Level
	env      *fsstore.Environment
	eff      inherit.Result
	scopes   Scopes
	opts     ScriptOptions
	vopts    []vars.Option
	budget   *script.Budget
	masks    []SecretValue
	locked   bool
	next     *string
	nextStop bool
}

// NewSend starts a send of req (from parentID, with the environment envID)
// in the session's workspace: it loads the chain and builds the scopes
// (with the overlay and secret values).
func (s *Session) NewSend(req model.Request, parentID, envID string, opts ScriptOptions) *Send {
	chain := s.Chain(req, parentID)
	env := s.Environment(envID)
	sd := &Send{
		sess: s, req: req, chain: chain, env: env, opts: opts, vopts: s.opts,
		eff:    inherit.Effective(chain, req),
		scopes: s.BuildScopes(collectionOf(chain), env),
		budget: &script.Budget{},
	}
	sd.masks, _ = s.SendSecrets(req, parentID, envID)
	sd.seedLocal()
	return sd
}

// NewSendWithoutWorkspace starts a send when no workspace is open: only
// the request's own scripts run and only the local scope exists.
func NewSendWithoutWorkspace(req model.Request, opts ScriptOptions, vopts ...vars.Option) *Send {
	sd := &Send{
		req: req, opts: opts, vopts: vopts,
		eff:    inherit.Effective(nil, req),
		scopes: localOnly(),
		budget: &script.Budget{},
	}
	sd.seedLocal()
	return sd
}

func (sd *Send) seedLocal() {
	local := &sd.scopes.List[len(sd.scopes.List)-1]
	seed := sd.opts.IterationData
	if sd.opts.Local != nil {
		seed = sd.opts.Local
	}
	for _, k := range sortedKeys(seed) {
		setRow(local, k, seed[k], false)
	}
}

// Local returns the local scope's values as the scripts left them (the
// data row plus pm.variables writes). Never nil.
func (sd *Send) Local() map[string]string {
	return sendVars{sd}.All(vars.ScopeLocal)
}

// Prepare resolves the request as the pre-request scripts left it.
func (sd *Send) Prepare() (Prepared, error) {
	p, err := prepare(sd.eff, sd.scopes, sd.vopts)
	if sd.env != nil {
		p.Environment = &EnvRef{ID: sd.env.ID, Name: sd.env.Name}
	}
	p.SecretsLocked = p.SecretsLocked || sd.locked
	return p, err
}

// SecretsLocked is true when a script couldn't write a secret because the
// secret store is locked.
func (sd *Send) SecretsLocked() bool { return sd.locked }

// Secrets returns every form of the secret values this send can show:
// SendSecrets plus the values scripts wrote to secret variables. Longest
// first.
func (sd *Send) Secrets() []SecretValue { return sd.masks }

// Mask replaces secret values in text with [secret:name].
func (sd *Send) Mask(text string) string { return maskText(text, sd.masks) }

func (sd *Send) addSecret(name, value string) {
	if len(value) < MinSecretLength {
		return
	}
	plain := []SecretValue{{Name: name, Value: value}}
	sd.masks = dedupe(append(append(sd.masks, plain...), EncodedForms(plain)...))
	slices.SortStableFunc(sd.masks, func(a, b SecretValue) int { return len(b.Value) - len(a.Value) })
}

type level struct {
	src     script.Source
	scripts model.Scripts
}

// levels lists the script levels: collection, folders, then the request.
func (sd *Send) levels(event script.Event) []level {
	out := make([]level, 0, len(sd.chain)+1)
	for _, l := range sd.chain {
		kind := script.LevelFolder
		if l.Kind == inherit.KindCollection {
			kind = script.LevelCollection
		}
		out = append(out, level{src: script.Source{Kind: kind, ID: l.ID, Name: l.Name, Event: event}, scripts: l.Scripts})
	}
	name := sd.req.Name
	if strings.TrimSpace(name) == "" {
		name = "Untitled request"
	}
	return append(out, level{src: script.Source{Kind: script.LevelRequest, ID: sd.req.ID, Name: name, Event: event}, scripts: sd.req.Scripts})
}

// PreRequest runs the pre-request scripts, collection first. Their
// variable writes and request changes apply to this send. The first
// script error stops the rest (Err); skipRequest stops them too (Skip).
func (sd *Send) PreRequest(ctx context.Context) ScriptReport {
	return sd.run(ctx, script.PreRequest, nil)
}

// Test runs the test scripts after a response, collection first. A script
// error becomes a failed test ("Script error") and the next level still
// runs, unless the send was cancelled.
func (sd *Send) Test(ctx context.Context, resp *model.Response) ScriptReport {
	return sd.run(ctx, script.Test, script.ResponseFrom(resp, ResponseBody(resp)))
}

// ScriptErrorTest is the name of the failed test a test script error becomes.
const ScriptErrorTest = "Script error"

func (sd *Send) run(ctx context.Context, event script.Event, resp *script.Response) ScriptReport {
	rep := ScriptReport{Tests: []script.TestResult{}, Console: []script.ConsoleEntry{}}
	envName := ""
	if sd.env != nil {
		envName = sd.env.Name
	}
	for _, l := range sd.levels(event) {
		code := l.scripts.PreRequest
		if event == script.Test {
			code = l.scripts.Test
		}
		if strings.TrimSpace(code) == "" {
			continue
		}
		out, err := script.Run(ctx, script.Input{
			Source: l.src, Script: code, Request: sd.eff.Request, Response: resp,
			Vars: sendVars{sd}, EnvironmentName: envName,
			Iteration: sd.opts.Iteration, IterationCount: sd.opts.IterationCount, IterationData: sd.opts.IterationData,
			Timeout: sd.opts.Timeout, Budget: sd.budget,
		})
		console := sd.maskConsole(out.Console)
		rep.Console = append(rep.Console, console...)
		rep.Tests = append(rep.Tests, sd.maskTests(out.Tests)...)
		if len(console) > 0 && sd.opts.OnConsole != nil {
			sd.opts.OnConsole(console)
		}
		if out.NextRequestSet {
			next := out.NextRequest
			sd.next, sd.nextStop = &next, out.NextRequestStop
		}
		if err != nil {
			var se *script.Error
			if !errors.As(err, &se) {
				se = &script.Error{Source: l.src, Message: err.Error()}
			}
			se.Message = sd.Mask(se.Message)
			if event == script.PreRequest || se.Canceled {
				rep.Err = se
				break
			}
			rep.Tests = append(rep.Tests, script.TestResult{Name: ScriptErrorTest, Error: se.Error(), Source: l.src})
			continue
		}
		if event == script.PreRequest {
			sd.eff.Request = out.Request
			if out.Skip {
				rep.Skip = true
				break
			}
		}
	}
	rep.NextRequest, rep.NextStop = sd.next, sd.nextStop
	return rep
}

func (sd *Send) maskConsole(entries []script.ConsoleEntry) []script.ConsoleEntry {
	out := make([]script.ConsoleEntry, len(entries))
	for i, e := range entries {
		e.Text = sd.Mask(e.Text)
		out[i] = e
	}
	return out
}

func (sd *Send) maskTests(tests []script.TestResult) []script.TestResult {
	out := make([]script.TestResult, len(tests))
	for i, t := range tests {
		t.Name, t.Error = sd.Mask(t.Name), sd.Mask(t.Error)
		out[i] = t
	}
	return out
}

// ResponseBody returns a response's decoded body for scripts: the inline
// body, or the spilled file up to MaxScriptBody when the body was cut.
func ResponseBody(r *model.Response) []byte {
	if r.Truncated && r.BodyPath != "" {
		if f, err := os.Open(r.BodyPath); err == nil {
			defer f.Close()
			if data, err := io.ReadAll(io.LimitReader(f, MaxScriptBody)); err == nil {
				return data
			}
		}
	}
	if r.Encoding == model.EncodingBase64 {
		data, err := base64.StdEncoding.DecodeString(r.Body)
		if err == nil {
			return data
		}
	}
	return []byte(r.Body)
}

// sendVars is script.Vars over a send's scopes.
type sendVars struct{ sd *Send }

func (v sendVars) index(kind vars.ScopeKind) int {
	return slices.IndexFunc(v.sd.scopes.List, func(sc vars.Scope) bool { return sc.Kind == kind })
}

func (v sendVars) Get(kind vars.ScopeKind, key string) (string, bool) {
	val, ok := v.All(kind)[key]
	return val, ok
}

// All returns the resolvable values of a scope (or, for script.AllScopes,
// the winning value of every name).
func (v sendVars) All(kind vars.ScopeKind) map[string]string {
	list := v.sd.scopes.List
	if kind != script.AllScopes {
		i := v.index(kind)
		if i < 0 {
			return map[string]string{}
		}
		list = list[i : i+1]
	}
	out := map[string]string{}
	for _, sc := range list {
		for _, r := range sc.Variables {
			if r.Enabled && r.Key != "" {
				out[r.Key] = r.Value
			}
		}
		for _, n := range sc.Unset {
			delete(out, n)
		}
	}
	return out
}

func (v sendVars) ReplaceIn(text string) (string, error) {
	out, _, err := vars.New(v.sd.scopes.List, v.sd.vopts...).Resolve(text)
	if err != nil {
		return "", errors.New(VariableMessage(err))
	}
	return out, nil
}

// VarError is a variable write a script can't make, with a message for
// the user (scripts throw it as an Error).
type VarError struct {
	Message string
	Err     error
}

func (e *VarError) Error() string { return e.Message }
func (e *VarError) Unwrap() error { return e.Err }

// noScope explains a write to a scope this send doesn't have.
func noScope(kind vars.ScopeKind, verb, key string) error {
	var msg string
	switch kind {
	case vars.ScopeEnvironment:
		msg = fmt.Sprintf("No environment is selected, so pm.environment can't %s %q. Select an environment and send again.", verb, key)
	case vars.ScopeCollection:
		msg = fmt.Sprintf("This request isn't in a collection, so pm.collectionVariables can't %s %q.", verb, key)
	default:
		msg = fmt.Sprintf("No workspace is open, so pm.globals can't %s %q.", verb, key)
	}
	return &VarError{Message: msg}
}

// Set writes a script's value: local values stay in this send; a secret
// variable's value goes to the secret store; any other value goes to the
// overlay. The send's scopes see it at once.
func (v sendVars) Set(kind vars.ScopeKind, key, value string) error {
	key = strings.TrimSpace(key)
	i := v.index(kind)
	if i < 0 {
		return noScope(kind, "set", key)
	}
	sc := &v.sd.scopes.List[i]
	if kind == vars.ScopeLocal {
		setRow(sc, key, value, false)
		return nil
	}
	lk := lockKey(sc.ID, key)
	if isSecret(*sc, key) {
		if err := v.sd.sess.SetSecret(ScopeRef{Kind: kind, ID: sc.ID}, key, value); err != nil {
			if errors.Is(err, secrets.ErrLocked) {
				v.sd.locked = true
				return &VarError{Message: fmt.Sprintf("The secret store is locked, so the secret %q wasn't set. Unlock it and send again.", key), Err: err}
			}
			return &VarError{Message: fmt.Sprintf("Couldn't store the secret %q: %v", key, secrets.Explain(err)), Err: err}
		}
		delete(v.sd.scopes.Locked, lk)
		v.sd.addSecret(key, value)
		v.sd.sess.overlay.dropIfSet(sc.ID, key)
		setRow(sc, key, value, true)
		return nil
	}
	state := v.sd.scopes.Overlay[lk]
	switch {
	case state == OverlayUnset:
		state = OverlaySet
	case state == OverlayNone && hasRow(*sc, key):
		state = OverlaySet
	case state == OverlayNone:
		state = OverlayNew
	}
	v.sd.sess.overlay.putIfSet(sc.ID, key, overlayEntry{value: value})
	v.sd.scopes.Overlay[lk] = state
	setRow(sc, key, value, false)
	return nil
}

// Unset removes a script-visible value: from the local scope, or from a
// stored scope for the rest of the session (the file keeps it).
func (v sendVars) Unset(kind vars.ScopeKind, key string) error {
	key = strings.TrimSpace(key)
	i := v.index(kind)
	if i < 0 {
		return noScope(kind, "unset", key)
	}
	sc := &v.sd.scopes.List[i]
	if kind != vars.ScopeLocal {
		lk := lockKey(sc.ID, key)
		switch state := v.sd.scopes.Overlay[lk]; {
		case state == OverlayNew:
			v.sd.sess.overlay.dropIfSet(sc.ID, key)
			delete(v.sd.scopes.Overlay, lk)
		case state == OverlaySet || hasRow(*sc, key):
			v.sd.sess.overlay.putIfSet(sc.ID, key, overlayEntry{unset: true})
			v.sd.scopes.Overlay[lk] = OverlayUnset
		}
	}
	withoutKey(sc, key)
	return nil
}
