package pipeline

import (
	"bytes"
	"errors"
	"log/slog"
	"reflect"
	"strings"
	"testing"
	"time"

	"pakpos/internal/core/inherit"
	"pakpos/internal/core/model"
	"pakpos/internal/core/vars"
	"pakpos/internal/secrets"
	"pakpos/internal/store/fsstore"
)

// fixture is a workspace with:
//
//	Users (collection: bearer {{token}}, X-Col header, vars host=col, colOnly)
//	└── Admin (folder: X-Col overridden, X-Folder)
//	    └── Get (request, auth inherit)
//	Dev / Prod environments, globals host=global, gOnly
type fixture struct {
	ws       *fsstore.Workspace
	sec      *secrets.Fake
	sess     *Session
	logs     *bytes.Buffer
	col      fsstore.Collection
	folder   fsstore.Folder
	req      model.Request
	dev      fsstore.Environment
	prod     fsstore.Environment
	globalID string
}

func v(k, val string) model.Variable { return model.Variable{Key: k, Value: val, Enabled: true} }
func secret(k string) model.Variable { return model.Variable{Key: k, Enabled: true, Secret: true} }
func hdr(k, val string) model.KeyValue {
	return model.KeyValue{Key: k, Value: val, Enabled: true}
}

// must panics on error (Go can't pass t alongside a multi-value call);
// the panic fails the test with the error.
func must[T any](val T, err error) T {
	if err != nil {
		panic(err)
	}
	return val
}

func newFixture(t *testing.T) *fixture {
	t.Helper()
	ws := must(fsstore.Create(t.TempDir(), "WS"))
	f := &fixture{ws: ws, sec: secrets.NewFake(), logs: &bytes.Buffer{}}
	f.sess = New(ws, f.sec, slog.New(slog.NewTextHandler(f.logs, nil)),
		vars.WithClock(func() time.Time { return time.Unix(1700000000, 0) }))
	f.col = must(ws.CreateCollection("Users"))
	f.col = must(ws.SaveCollection(f.col.ID, fsstore.CollectionSettings{
		Auth:      model.Auth{Type: model.AuthBearer, Token: "{{token}}"},
		Headers:   []model.KeyValue{hdr("X-Col", "c"), hdr("X-Keep", "k")},
		Variables: []model.Variable{v("host", "col.example"), v("colOnly", "c1"), secret("token")},
	}))
	f.folder = must(ws.CreateFolder(f.col.ID, "Admin"))
	f.folder = must(ws.SaveFolder(f.folder.ID, fsstore.FolderSettings{
		Headers: []model.KeyValue{hdr("X-Col", "folder"), hdr("X-Folder", "f")},
	}))
	f.req = must(ws.CreateRequest(f.folder.ID, model.Request{
		Name: "Get", Method: "GET", URL: "https://{{host}}/users",
		Auth: model.Auth{Type: model.AuthInherit},
	}))
	f.dev = must(ws.CreateEnvironment("Dev"))
	f.dev = must(ws.SaveEnvironmentVariables(f.dev.ID, []model.Variable{v("host", "dev.example"), secret("apiKey")}))
	f.prod = must(ws.CreateEnvironment("Prod"))
	g := must(ws.SaveGlobals([]model.Variable{v("host", "global.example"), v("gOnly", "g1")}))
	f.globalID = g.ID
	wsID := ws.Manifest().ID
	_ = f.sec.Set(secrets.Key(wsID, f.col.ID, "token"), "s3cret")
	return f
}

func (f *fixture) key(scopeID, k string) string { return secrets.Key(f.ws.Manifest().ID, scopeID, k) }

func TestChain(t *testing.T) {
	f := newFixture(t)
	ids := func(chain []inherit.Level) []string {
		out := []string{}
		for _, l := range chain {
			out = append(out, l.ID)
		}
		return out
	}
	tests := []struct {
		name     string
		req      model.Request
		parentID string
		want     []string
	}{
		{"saved request uses its parent on disk", model.Request{ID: f.req.ID}, "", []string{f.col.ID, f.folder.ID}},
		{"saved request ignores a stale parent", model.Request{ID: f.req.ID}, f.col.ID, []string{f.col.ID, f.folder.ID}},
		{"draft uses parentId", model.Request{}, f.folder.ID, []string{f.col.ID, f.folder.ID}},
		{"draft in a collection", model.Request{ID: "unknown"}, f.col.ID, []string{f.col.ID}},
		{"unknown parent", model.Request{}, "nope", []string{}},
		{"no parent", model.Request{}, "", []string{}},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if got := ids(f.sess.Chain(tt.req, tt.parentID)); !reflect.DeepEqual(got, tt.want) {
				t.Fatalf("chain = %v, want %v", got, tt.want)
			}
		})
	}
}

func TestPrepare(t *testing.T) {
	f := newFixture(t)
	tests := []struct {
		name       string
		req        model.Request
		parentID   string
		envID      string
		wantURL    string
		wantAuth   string
		wantUnres  []string
		wantEnv    *EnvRef
		wantHeader map[string]string
	}{
		{
			name: "collection beats globals, inherited bearer secret", req: f.req,
			wantURL: "https://col.example/users", wantAuth: "s3cret", wantUnres: []string{},
			wantHeader: map[string]string{"X-Col": "folder", "X-Folder": "f", "X-Keep": "k"},
		},
		{
			name: "environment beats collection", req: f.req, envID: f.dev.ID,
			wantURL: "https://dev.example/users", wantAuth: "s3cret", wantUnres: []string{},
			wantEnv: &EnvRef{ID: f.dev.ID, Name: "Dev"},
		},
		{
			name: "deleted selection is none", req: f.req, envID: "gone",
			wantURL: "https://col.example/users", wantAuth: "s3cret", wantUnres: []string{},
		},
		{
			name: "draft without parent: globals only", req: model.Request{URL: "https://{{host}}/{{gOnly}}/{{colOnly}}/{{$timestamp}}"},
			wantURL: "https://global.example/g1/{{colOnly}}/1700000000", wantUnres: []string{"colOnly"},
		},
		{
			name: "draft in folder inherits", req: model.Request{URL: "https://{{host}}/x", Auth: model.Auth{Type: model.AuthInherit}},
			parentID: f.folder.ID, wantURL: "https://col.example/x", wantAuth: "s3cret", wantUnres: []string{},
		},
		{
			name: "unset secret is unresolved", req: model.Request{URL: "https://{{host}}/?k={{apiKey}}"}, envID: f.dev.ID,
			wantURL: "https://dev.example/?k={{apiKey}}", wantUnres: []string{"apiKey"},
			wantEnv: &EnvRef{ID: f.dev.ID, Name: "Dev"},
		},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			p, err := f.sess.Prepare(tt.req, tt.parentID, tt.envID)
			if err != nil {
				t.Fatal(err)
			}
			if p.Request.URL != tt.wantURL || p.Request.Auth.Token != tt.wantAuth {
				t.Fatalf("url=%q token=%q", p.Request.URL, p.Request.Auth.Token)
			}
			if !reflect.DeepEqual(p.Unresolved, tt.wantUnres) || !reflect.DeepEqual(p.Environment, tt.wantEnv) || p.SecretsLocked {
				t.Fatalf("unresolved=%v env=%+v locked=%v", p.Unresolved, p.Environment, p.SecretsLocked)
			}
			for k, want := range tt.wantHeader {
				found := false
				for _, h := range p.Request.Headers {
					if h.Key == k && h.Enabled {
						found = found || h.Value == want
						if h.Value != want {
							t.Fatalf("header %s = %q, want %q", k, h.Value, want)
						}
					}
				}
				if !found {
					t.Fatalf("header %s missing: %+v", k, p.Request.Headers)
				}
			}
			if p.Effective.Request.Auth.Token != "{{token}}" && tt.wantAuth != "" {
				t.Fatalf("effective request must stay unresolved: %+v", p.Effective.Request.Auth)
			}
		})
	}
}

func TestPrepareSecretsLocked(t *testing.T) {
	f := newFixture(t)
	f.sec.Err = secrets.ErrLocked
	p, err := f.sess.Prepare(f.req, "", "")
	if err != nil {
		t.Fatal(err)
	}
	if !p.SecretsLocked || !reflect.DeepEqual(p.Unresolved, []string{"token"}) || p.Request.Auth.Token != "{{token}}" {
		t.Fatalf("prepared = %+v", p)
	}
	// A locked secret the request doesn't use doesn't count.
	p, _ = f.sess.Prepare(model.Request{URL: "http://x"}, f.col.ID, "")
	if p.SecretsLocked {
		t.Fatal("unused locked secret reported")
	}
	// Other store failures are logged; the secret still shadows, unresolved.
	f.sec.Err = errors.New("dbus gone")
	p, _ = f.sess.Prepare(f.req, "", "")
	if p.SecretsLocked || !reflect.DeepEqual(p.Unresolved, []string{"token"}) || !strings.Contains(f.logs.String(), "dbus gone") {
		t.Fatalf("prepared = %+v logs=%s", p, f.logs)
	}
}

func TestPrepareVariableErrors(t *testing.T) {
	f := newFixture(t)
	_ = must(f.ws.SaveEnvironmentVariables(f.prod.ID, []model.Variable{v("a", "{{b}}"), v("b", "{{a}}")}))
	p, err := f.sess.Prepare(model.Request{URL: "http://{{a}}"}, "", f.prod.ID)
	var ve *VariableError
	if !errors.As(err, &ve) || !errors.Is(err, vars.ErrCycle) || p.Environment == nil || p.Environment.Name != "Prod" {
		t.Fatalf("err = %v, env = %+v", err, p.Environment)
	}
	if msg := VariableMessage(err); !strings.Contains(msg, "loop") || !strings.Contains(msg, "a -> b -> a") || strings.Contains(msg, "variable cycle") {
		t.Fatalf("message = %q", msg)
	}
	if ve.Error() != err.Error() {
		t.Fatal("Error() should pass through")
	}

	chain := make([]model.Variable, vars.MaxDepth+2)
	for i := range chain {
		chain[i] = v("v"+string(rune('a'+i)), "{{v"+string(rune('a'+i+1))+"}}")
	}
	_ = must(f.ws.SaveEnvironmentVariables(f.prod.ID, chain))
	_, err = f.sess.Prepare(model.Request{URL: "{{va}}"}, "", f.prod.ID)
	if !errors.Is(err, vars.ErrTooDeep) || !strings.Contains(VariableMessage(err), "nested more than 10") {
		t.Fatalf("too deep: %v %q", err, VariableMessage(err))
	}
	if msg := VariableMessage(errors.New("boom")); msg != "Couldn't resolve variables: boom" {
		t.Fatalf("other = %q", msg)
	}
}

func TestPrepareWithoutWorkspace(t *testing.T) {
	p, err := PrepareWithoutWorkspace(model.Request{URL: "http://x/{{$randomInt}}/{{nope}}", Auth: model.Auth{Type: model.AuthInherit}},
		vars.WithRand(bytes.NewReader(make([]byte, 64))))
	if err != nil {
		t.Fatal(err)
	}
	if p.Request.URL != "http://x/0/{{nope}}" || !reflect.DeepEqual(p.Unresolved, []string{"nope"}) || p.Request.Auth.Type != model.AuthNone {
		t.Fatalf("prepared = %+v", p)
	}
	_, err = PrepareWithoutWorkspace(model.Request{URL: "{{$guid}}"}, vars.WithRand(strings.NewReader("")))
	if err == nil {
		t.Fatal("expected random source error")
	}
}

func TestPreview(t *testing.T) {
	f := newFixture(t)
	pv := f.sess.Preview(model.Request{URL: "https://{{host}}/{{missing}}/{{apiKey}}", Auth: model.Auth{Type: model.AuthInherit}}, f.folder.ID, f.dev.ID)

	if pv.Auth.Type != model.AuthBearer || pv.Auth.Token != "{{token}}" || pv.AuthSource == nil || pv.AuthSource.ID != f.col.ID {
		t.Fatalf("auth = %+v from %+v", pv.Auth, pv.AuthSource)
	}
	var hs []string
	for _, h := range pv.Headers {
		hs = append(hs, h.Key+"="+h.Value+"@"+string(h.Source.Kind))
	}
	if got := strings.Join(hs, ","); got != "X-Keep=k@collection,X-Col=folder@folder,X-Folder=f@folder" {
		t.Fatalf("headers = %s", got)
	}
	if !reflect.DeepEqual(pv.Unresolved, []string{"apiKey", "missing"}) || pv.SecretsLocked || pv.Error != "" {
		t.Fatalf("unresolved = %v locked=%v err=%q", pv.Unresolved, pv.SecretsLocked, pv.Error)
	}
	if pv.Environment == nil || pv.Environment.Name != "Dev" {
		t.Fatalf("env = %+v", pv.Environment)
	}
	got := map[string]PreviewVariable{}
	var keys []string
	for _, pvv := range pv.Variables {
		got[pvv.Key] = pvv
		keys = append(keys, pvv.Key)
	}
	if strings.Join(keys, ",") != "apiKey,colOnly,gOnly,host,token" {
		t.Fatalf("keys = %v", keys)
	}
	if h := got["host"]; h.Value != "dev.example" || h.Scope != vars.ScopeEnvironment || h.ScopeName != "Dev" || !h.Set {
		t.Fatalf("host = %+v", h)
	}
	if tok := got["token"]; tok.Value != "" || !tok.Secret || !tok.Set || tok.Scope != vars.ScopeCollection {
		t.Fatalf("token must be masked: %+v", tok)
	}
	if k := got["apiKey"]; k.Set || !k.Secret || k.ScopeID != f.dev.ID {
		t.Fatalf("apiKey = %+v", k)
	}
	if g := got["gOnly"]; g.Scope != vars.ScopeGlobal || g.ScopeName != GlobalsName || g.ScopeID != f.globalID {
		t.Fatalf("gOnly = %+v", g)
	}

	// Locked store: the secret shows as not set and the preview says locked.
	f.sec.Err = secrets.ErrLocked
	pv = f.sess.Preview(f.req, "", "")
	if !pv.SecretsLocked || pv.Environment != nil {
		t.Fatalf("locked preview = %+v", pv)
	}

	// A cycle is reported as a message.
	f.sec.Err = nil
	_ = must(f.ws.SaveGlobals([]model.Variable{v("a", "{{a}}")}))
	pv = f.sess.Preview(model.Request{URL: "{{a}}"}, "", "")
	if !strings.Contains(pv.Error, "loop") {
		t.Fatalf("error = %q", pv.Error)
	}
}

func TestNewDefaultsLogger(t *testing.T) {
	ws := must(fsstore.Create(t.TempDir(), "WS"))
	if s := New(ws, secrets.NewFake(), nil); s.log == nil {
		t.Fatal("logger not defaulted")
	}
}

// An unset (or locked) secret shadows the same name in lower scopes: the
// name is unresolved and the lower value is never sent.
func TestUnsetSecretShadowsLowerScopes(t *testing.T) {
	f := newFixture(t)
	_ = must(f.ws.SaveGlobals([]model.Variable{v("host", "global.example"), v("apiKey", "global-key")}))
	req := model.Request{URL: "https://x/?k={{apiKey}}"}

	p, err := f.sess.Prepare(req, "", f.dev.ID) // Dev has secret apiKey, not set
	if err != nil {
		t.Fatal(err)
	}
	if p.Request.URL != "https://x/?k={{apiKey}}" || !reflect.DeepEqual(p.Unresolved, []string{"apiKey"}) || p.SecretsLocked {
		t.Fatalf("unset: %+v", p)
	}
	pv := f.sess.Preview(req, "", f.dev.ID)
	var row PreviewVariable
	for _, pvv := range pv.Variables {
		if pvv.Key == "apiKey" {
			row = pvv
		}
	}
	if row.Scope != vars.ScopeEnvironment || row.Set || !row.Secret || row.Value != "" {
		t.Fatalf("preview winner = %+v", row)
	}

	// Without the environment the globals value is used.
	if p, _ = f.sess.Prepare(req, "", ""); p.Request.URL != "https://x/?k=global-key" {
		t.Fatalf("no env: %q", p.Request.URL)
	}

	// Locked: still shadows, and the result says the store is locked.
	f.sec.Err = secrets.ErrLocked
	p, _ = f.sess.Prepare(req, "", f.dev.ID)
	if p.Request.URL != "https://x/?k={{apiKey}}" || !p.SecretsLocked {
		t.Fatalf("locked: %+v", p)
	}
	if pv = f.sess.Preview(req, "", f.dev.ID); !pv.SecretsLocked {
		t.Fatal("preview should say locked")
	}
	// A locked secret shadowed by a higher plain value doesn't count as locked.
	_ = must(f.ws.SaveEnvironmentVariables(f.prod.ID, []model.Variable{v("token", "prod-token")}))
	p, _ = f.sess.Prepare(f.req, "", f.prod.ID)
	if p.SecretsLocked || p.Request.Auth.Token != "prod-token" {
		t.Fatalf("shadowed locked secret: %+v", p)
	}
}
