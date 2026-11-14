package service

import (
	"context"
	"errors"
	"net/http"
	"net/http/httptest"
	"reflect"
	"testing"

	"pakpos/internal/core/httpexec"
	"pakpos/internal/core/model"
	"pakpos/internal/core/vars"
	"pakpos/internal/pipeline"
	"pakpos/internal/secrets"
	"pakpos/internal/store/fsstore"
	"pakpos/internal/store/sqlite"
)

func TestEnvServiceNeedsWorkspace(t *testing.T) {
	h := newHarness(t)
	ref := pipeline.ScopeRef{Kind: vars.ScopeGlobal}
	calls := map[string]func() error{
		"List":           func() error { _, err := h.env.List(); return err },
		"Get":            func() error { _, err := h.env.Get("x"); return err },
		"Create":         func() error { _, err := h.env.Create("x"); return err },
		"Rename":         func() error { _, err := h.env.Rename("x", "y"); return err },
		"Duplicate":      func() error { _, err := h.env.Duplicate("x"); return err },
		"Delete":         func() error { return h.env.Delete("x") },
		"Reorder":        func() error { return h.env.Reorder(nil) },
		"Globals":        func() error { _, err := h.env.Globals(); return err },
		"SaveGlobals":    func() error { _, err := h.env.SaveGlobals(nil, nil); return err },
		"SaveVariables":  func() error { _, err := h.env.SaveVariables(ref, nil, nil); return err },
		"SetSecret":      func() error { return h.env.SetSecret(ref, "k", "v") },
		"ClearSecret":    func() error { return h.env.ClearSecret(ref, "k") },
		"SecretStatus":   func() error { _, err := h.env.SecretStatus(ref); return err },
		"RevealSecret":   func() error { _, err := h.env.RevealSecret(ref, "k"); return err },
		"MakePlain":      func() error { _, err := h.env.MakeVariablePlain(ref, "k"); return err },
		"Select":         func() error { return h.env.Select("") },
		"Selected":       func() error { _, err := h.env.Selected(); return err },
		"ResolvePreview": func() error { _, err := h.env.ResolvePreview(model.Request{}, ""); return err },
		"Visible":        func() error { _, err := h.env.VisibleVariables("", ""); return err },
		"DeleteCol":      func() error { return h.ws.DeleteCollection("x") },
		"SaveCol":        func() error { _, err := h.ws.SaveCollection("x", fsstore.CollectionSettings{}, nil); return err },
	}
	for name, call := range calls {
		if err := call(); !errors.Is(err, ErrNoWorkspace) {
			t.Errorf("%s: %v", name, err)
		}
	}
}

func TestEnvServiceEnvironments(t *testing.T) {
	h := newHarness(t)
	h.openWorkspace(t)
	dev, err := h.env.Create("Dev")
	if err != nil {
		t.Fatal(err)
	}
	prod, _ := h.env.Create("Prod")
	if dev, err = h.env.Rename(dev.ID, "Development"); err != nil || dev.Name != "Development" {
		t.Fatalf("rename = %+v %v", dev, err)
	}
	if got, err := h.env.Get(dev.ID); err != nil || got.Name != "Development" {
		t.Fatalf("get = %+v %v", got, err)
	}
	ref := pipeline.ScopeRef{Kind: vars.ScopeEnvironment, ID: dev.ID}
	if _, err := h.env.SaveVariables(ref, []model.Variable{{Key: "pw", Enabled: true, Secret: true}}, nil); err != nil {
		t.Fatal(err)
	}
	if err := h.env.SetSecret(ref, "pw", "dev-pw"); err != nil {
		t.Fatal(err)
	}
	if st, err := h.env.SecretStatus(ref); err != nil || !reflect.DeepEqual(st.Set, []string{"pw"}) {
		t.Fatalf("status = %+v %v", st, err)
	}
	dup, err := h.env.Duplicate(dev.ID)
	if err != nil {
		t.Fatal(err)
	}
	if st, _ := h.env.SecretStatus(pipeline.ScopeRef{Kind: vars.ScopeEnvironment, ID: dup.ID}); len(st.Set) != 1 {
		t.Fatalf("duplicate has no secret: %+v", st)
	}
	if err := h.env.Reorder([]string{prod.ID}); err != nil {
		t.Fatal(err)
	}
	list, err := h.env.List()
	if err != nil || len(list) != 3 || list[0].ID != prod.ID {
		t.Fatalf("list = %+v %v", list, err)
	}
	if err := h.env.ClearSecret(ref, "pw"); err != nil {
		t.Fatal(err)
	}
	if err := h.env.Delete(dup.ID); err != nil {
		t.Fatal(err)
	}
	if keys := h.secrets.Keys(); len(keys) != 0 {
		t.Fatalf("secrets left: %v", keys)
	}

	// Selection: per workspace, validated, a deleted one reads as none.
	if sel, err := h.env.Selected(); err != nil || sel != nil {
		t.Fatalf("initial selection = %+v %v", sel, err)
	}
	if err := h.env.Select("nope"); !errors.Is(err, fsstore.ErrNotFound) {
		t.Fatalf("select unknown: %v", err)
	}
	if err := h.env.Select(prod.ID); err != nil {
		t.Fatal(err)
	}
	if sel, _ := h.env.Selected(); sel == nil || sel.Name != "Prod" {
		t.Fatalf("selected = %+v", sel)
	}
	h.openWorkspace(t) // another workspace has its own selection
	if sel, _ := h.env.Selected(); sel != nil {
		t.Fatalf("selection leaked across workspaces: %+v", sel)
	}

	// Globals.
	g, err := h.env.SaveGlobals([]model.Variable{{Key: "a", Value: "1", Enabled: true}}, nil)
	if err != nil || len(g.Variables) != 1 {
		t.Fatalf("globals = %+v %v", g, err)
	}
	if g2, _ := h.env.Globals(); g2.ID != g.ID {
		t.Fatal("globals id changed")
	}
	if _, err := h.env.SaveGlobals([]model.Variable{{Key: "a", Value: "{{x", Enabled: true}}, nil); err != nil {
		t.Fatal(err)
	}
}

func TestEnvServiceSelectedDeleted(t *testing.T) {
	h := newHarness(t)
	h.openWorkspace(t)
	e, _ := h.env.Create("Gone")
	_ = h.env.Select(e.ID)
	_ = h.env.Delete(e.ID)
	if sel, err := h.env.Selected(); err != nil || sel != nil {
		t.Fatalf("deleted selection = %+v %v", sel, err)
	}
	if err := h.env.Select(""); err != nil {
		t.Fatal(err)
	}
}

func TestEnvServiceResolvePreview(t *testing.T) {
	h := newHarness(t)
	h.openWorkspace(t)
	col, _ := h.ws.CreateCollection("API")
	_, err := h.ws.SaveCollection(col.ID, fsstore.CollectionSettings{
		Auth:      model.Auth{Type: model.AuthBearer, Token: "{{token}}"},
		Headers:   []model.KeyValue{{Key: "X-Col", Value: "1", Enabled: true}},
		Variables: []model.Variable{{Key: "token", Enabled: true, Secret: true}},
	}, nil)
	if err != nil {
		t.Fatal(err)
	}
	_ = h.env.SetSecret(pipeline.ScopeRef{Kind: vars.ScopeCollection, ID: col.ID}, "token", "s3cret")
	pv, err := h.env.ResolvePreview(model.Request{URL: "{{nope}}", Auth: model.Auth{Type: model.AuthInherit}}, col.ID)
	if err != nil {
		t.Fatal(err)
	}
	if len(pv.Headers) != 1 || pv.AuthSource == nil || pv.AuthSource.ID != col.ID || !reflect.DeepEqual(pv.Unresolved, []string{"nope"}) {
		t.Fatalf("preview = %+v", pv)
	}
	if len(pv.Variables) != 1 || pv.Variables[0].Value != "" || !pv.Variables[0].Set {
		t.Fatalf("secret must be masked: %+v", pv.Variables)
	}
}

func TestEnvServiceVisibleVariables(t *testing.T) {
	h := newHarness(t)
	h.openWorkspace(t)
	col, _ := h.ws.CreateCollection("API")
	if _, err := h.ws.SaveCollection(col.ID, fsstore.CollectionSettings{
		Variables: []model.Variable{{Key: "host", Value: "col", Enabled: true}, {Key: "token", Enabled: true, Secret: true}},
	}, nil); err != nil {
		t.Fatal(err)
	}
	_ = h.env.SetSecret(pipeline.ScopeRef{Kind: vars.ScopeCollection, ID: col.ID}, "token", "s3cret")
	dev, _ := h.env.Create("Dev")
	prod, _ := h.env.Create("Prod")
	_, _ = h.env.SaveVariables(pipeline.ScopeRef{Kind: vars.ScopeEnvironment, ID: dev.ID}, []model.Variable{{Key: "host", Value: "dev", Enabled: true}}, nil)
	_, _ = h.env.SaveVariables(pipeline.ScopeRef{Kind: vars.ScopeEnvironment, ID: prod.ID}, []model.Variable{{Key: "host", Value: "prod", Enabled: true}}, nil)
	if err := h.env.Select(dev.ID); err != nil {
		t.Fatal(err)
	}
	value := func(vs []pipeline.PreviewVariable, key string) pipeline.PreviewVariable {
		for _, x := range vs {
			if x.Key == key {
				return x
			}
		}
		t.Fatalf("%s missing from %+v", key, vs)
		return pipeline.PreviewVariable{}
	}
	// "" uses the selected environment.
	got, err := h.env.VisibleVariables(col.ID, "")
	if err != nil || got.Environment == nil || got.Environment.ID != dev.ID || value(got.Variables, "host").Value != "dev" {
		t.Fatalf("selected = %+v %v", got, err)
	}
	if tok := value(got.Variables, "token"); tok.Value != "" || !tok.Set {
		t.Fatalf("token = %+v", tok)
	}
	// An environment's own editor sees that environment, selected or not.
	got, _ = h.env.VisibleVariables("", prod.ID)
	if got.Environment == nil || got.Environment.ID != prod.ID || value(got.Variables, "host").Value != "prod" {
		t.Fatalf("prod = %+v", got)
	}
}

func TestEnvServiceSecretStoreControlKeychain(t *testing.T) {
	h := newHarness(t)
	if st := h.env.SecretsStatus(); st.Backend != secrets.BackendKeychain {
		t.Fatalf("status = %+v", st)
	}
	for name, call := range map[string]func() error{
		"set":    func() error { return h.env.SetMasterPassword("long-enough") },
		"change": func() error { return h.env.ChangeMasterPassword("x", "long-enough") },
		"unlock": func() error { return h.env.Unlock("x") },
		"lock":   h.env.Lock,
		"reset":  h.env.ResetSecretStore,
	} {
		if err := call(); err == nil || err.Error() != secrets.MsgNotFileStore {
			t.Errorf("%s: %v", name, err)
		}
	}
}

// The real file store in a temp dir: set, lock, wrong password, unlock,
// change, reset, and sending while locked.
func TestEnvServiceSecretStoreControlFile(t *testing.T) {
	store := secrets.NewFileStore(t.TempDir(), secrets.WithKDFParams(secrets.KDFParams{Time: 1, Memory: 64, Threads: 1}))
	h := newHarnessWith(t, store)
	if st := h.env.SecretsStatus(); st != (secrets.Status{Backend: secrets.BackendFile, Locked: true}) {
		t.Fatalf("fresh = %+v", st)
	}
	if err := h.env.Unlock("x"); err == nil || err.Error() != secrets.MsgNoPassword {
		t.Fatalf("unlock without password: %v", err)
	}
	if err := h.env.SetMasterPassword(""); err == nil || err.Error() != secrets.MsgEmptyPassword {
		t.Fatalf("empty password: %v", err)
	}
	if err := h.env.SetMasterPassword("seven77"); err == nil || err.Error() != secrets.MsgShortPassword {
		t.Fatalf("short password: %v", err)
	}
	if err := h.env.SetMasterPassword("one-password"); err != nil {
		t.Fatal(err)
	}

	var gotAuth string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotAuth = r.Header.Get("Authorization")
	}))
	t.Cleanup(srv.Close)
	h.openWorkspace(t)
	g := pipeline.ScopeRef{Kind: vars.ScopeGlobal}
	if _, err := h.env.SaveGlobals([]model.Variable{{Key: "token", Enabled: true, Secret: true}}, nil); err != nil {
		t.Fatal(err)
	}
	if err := h.env.SetSecret(g, "token", "file-secret"); err != nil {
		t.Fatal(err)
	}
	req := model.Request{URL: srv.URL, Auth: model.Auth{Type: model.AuthBearer, Token: "{{token}}"}}
	if res, _ := h.req.Send(context.Background(), "a", req, ""); res.Error != nil || gotAuth != "Bearer file-secret" || res.SecretsLocked {
		t.Fatalf("unlocked send: %+v auth=%q", res, gotAuth)
	}

	if err := h.env.Lock(); err != nil {
		t.Fatal(err)
	}
	if st := h.env.SecretsStatus(); !st.Locked || !st.HasPassword {
		t.Fatalf("locked = %+v", st)
	}
	res, _ := h.req.Send(context.Background(), "b", req, "")
	if res.Error != nil || !res.SecretsLocked || !reflect.DeepEqual(res.Unresolved, []string{"token"}) || gotAuth != "Bearer {{token}}" {
		t.Fatalf("locked send: %+v auth=%q", res, gotAuth)
	}
	if st, err := h.env.SecretStatus(g); err != nil || !st.Locked {
		t.Fatalf("scope status while locked = %+v %v", st, err)
	}
	if err := h.env.SetSecret(g, "token", "x"); err == nil || err.Error() != secrets.MsgLocked {
		t.Fatalf("set while locked: %v", err)
	}
	if err := h.env.Unlock("wrong"); err == nil || err.Error() != "Wrong password, or the secrets file is damaged." {
		t.Fatalf("wrong password: %v", err)
	}
	if err := h.env.Unlock("one-password"); err != nil {
		t.Fatal(err)
	}
	if err := h.env.ChangeMasterPassword("one-password", "two"); err == nil || err.Error() != secrets.MsgShortPassword {
		t.Fatalf("change to a short password: %v", err)
	}
	if err := h.env.ChangeMasterPassword("nope", "two-password"); err == nil || err.Error() != secrets.MsgWrongPassword {
		t.Fatalf("change with wrong password: %v", err)
	}
	if err := h.env.ChangeMasterPassword("one-password", "two-password"); err != nil {
		t.Fatal(err)
	}
	_ = h.env.Lock()
	if err := h.env.Unlock("two-password"); err != nil {
		t.Fatal(err)
	}
	if err := h.env.ResetSecretStore(); err != nil {
		t.Fatal(err)
	}
	if st := h.env.SecretsStatus(); st.HasPassword || !st.Locked {
		t.Fatalf("after reset = %+v", st)
	}
}

func TestSendVariableCycleIsSendError(t *testing.T) {
	h := newHarness(t)
	h.openWorkspace(t)
	if _, err := h.env.SaveGlobals([]model.Variable{{Key: "a", Value: "{{b}}", Enabled: true}, {Key: "b", Value: "{{a}}", Enabled: true}}, nil); err != nil {
		t.Fatal(err)
	}
	res, err := h.req.Send(context.Background(), "c", model.Request{URL: "http://x/{{a}}"}, "")
	if err != nil || res.Error == nil || res.Error.Kind != httpexec.KindVariables || res.Response != nil || res.HistoryID == 0 {
		t.Fatalf("result = %+v %v", res, err)
	}
	e, _ := h.hist.Get(res.HistoryID)
	if e.ErrorKind != string(httpexec.KindVariables) || e.URL != "http://x/{{a}}" {
		t.Fatalf("history = %+v", e.HistorySummary)
	}
}

func TestSendWithoutWorkspaceResolvesDynamic(t *testing.T) {
	var path string
	srv := httptest.NewServer(http.HandlerFunc(func(_ http.ResponseWriter, r *http.Request) { path = r.URL.Path }))
	t.Cleanup(srv.Close)
	h := newHarness(t)
	res, err := h.req.Send(context.Background(), "d", model.Request{URL: srv.URL + "/{{$randomInt}}/{{x}}"}, "")
	if err != nil || res.Error != nil || !reflect.DeepEqual(res.Unresolved, []string{"x"}) || res.Environment != nil {
		t.Fatalf("result = %+v %v", res, err)
	}
	if path == "" || path == "/{{$randomInt}}/{{x}}" {
		t.Fatalf("path = %q", path)
	}
	if res, _ := h.req.Send(context.Background(), "e", model.Request{URL: "{{$guid"}, ""); res.Unresolved == nil {
		t.Fatal("unresolved must never be nil")
	}
}

func TestHistoryIsPerWorkspace(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(http.ResponseWriter, *http.Request) {}))
	t.Cleanup(srv.Close)
	h := newHarness(t)
	send := func(id string) {
		t.Helper()
		if _, err := h.req.Send(context.Background(), id, model.Request{URL: srv.URL + "/" + id}, ""); err != nil {
			t.Fatal(err)
		}
	}
	send("none")
	a := h.openWorkspace(t)
	send("a1")
	send("a2")
	h.openWorkspace(t)
	send("b1")

	list := func() []string {
		t.Helper()
		page, err := h.hist.List(sqlite.HistoryFilter{WorkspaceID: a.ID}) // ignored: the open workspace decides
		if err != nil {
			t.Fatal(err)
		}
		var out []string
		for _, it := range page.Items {
			out = append(out, it.URL[len(srv.URL)+1:])
		}
		return out
	}
	if got := list(); !reflect.DeepEqual(got, []string{"b1"}) {
		t.Fatalf("workspace B = %v", got)
	}
	if err := h.hist.Clear(); err != nil {
		t.Fatal(err)
	}
	h.ws.Close()
	if got := list(); !reflect.DeepEqual(got, []string{"none"}) {
		t.Fatalf("no workspace = %v", got)
	}
	if _, err := h.ws.Open(a.Path); err != nil {
		t.Fatal(err)
	}
	if got := list(); !reflect.DeepEqual(got, []string{"a2", "a1"}) {
		t.Fatalf("workspace A = %v", got)
	}
	h.ws.Close()
	if err := h.hist.Clear(); err != nil {
		t.Fatal(err)
	}
	if got := list(); len(got) != 0 {
		t.Fatalf("no-workspace entries not cleared: %v", got)
	}
	if _, err := h.ws.Open(a.Path); err != nil {
		t.Fatal(err)
	}
	if got := list(); len(got) != 2 {
		t.Fatalf("clearing without a workspace touched workspace A: %v", got)
	}
}

func TestNewCoreDefaultsToFileStore(t *testing.T) {
	c, err := NewCore(Config{DataDir: t.TempDir(), Dialogs: &fakeDialogs{}, Events: &fakeEvents{}})
	if err != nil {
		t.Fatal(err)
	}
	defer c.Close()
	if st := NewEnvService(c).SecretsStatus(); st.Backend != secrets.BackendFile {
		t.Fatalf("default store = %+v", st)
	}
}

func TestEnvServiceRevealAndMakePlain(t *testing.T) {
	h := newHarness(t)
	h.openWorkspace(t)
	g := pipeline.ScopeRef{Kind: vars.ScopeGlobal}
	if _, err := h.env.SaveGlobals([]model.Variable{{Key: "pw", Enabled: true, Secret: true}}, nil); err != nil {
		t.Fatal(err)
	}
	if _, err := h.env.RevealSecret(g, "pw"); err == nil || err.Error() != "No value is stored for pw on this machine. Set one first." {
		t.Fatalf("unset: %v", err)
	}
	if err := h.env.SetSecret(g, "pw", "hunter2"); err != nil {
		t.Fatal(err)
	}
	if v, err := h.env.RevealSecret(g, "pw"); err != nil || v != "hunter2" {
		t.Fatalf("reveal = %q %v", v, err)
	}
	h.secrets.Err = secrets.ErrLocked
	if _, err := h.env.RevealSecret(g, "pw"); err == nil || err.Error() != secrets.MsgLocked {
		t.Fatalf("locked reveal: %v", err)
	}
	if _, err := h.env.MakeVariablePlain(g, "pw"); err == nil || err.Error() != secrets.MsgLocked {
		t.Fatalf("locked make plain: %v", err)
	}
	h.secrets.Err = nil
	vs, err := h.env.MakeVariablePlain(g, "pw")
	if err != nil || len(vs) != 1 || vs[0].Secret || vs[0].Value != "hunter2" {
		t.Fatalf("make plain = %+v %v", vs, err)
	}
	if keys := h.secrets.Keys(); len(keys) != 0 {
		t.Fatalf("stored value left: %v", keys)
	}
}

func TestEnvServiceSaveMovesRenamedSecrets(t *testing.T) {
	h := newHarness(t)
	h.openWorkspace(t)
	g := pipeline.ScopeRef{Kind: vars.ScopeGlobal}
	if _, err := h.env.SaveGlobals([]model.Variable{{Key: "pw", Enabled: true, Secret: true}}, nil); err != nil {
		t.Fatal(err)
	}
	_ = h.env.SetSecret(g, "pw", "hunter2")
	h.secrets.Err = secrets.ErrLocked
	if _, err := h.env.SaveGlobals([]model.Variable{{Key: "password", Enabled: true, Secret: true}}, []pipeline.SecretRename{{From: "pw", To: "password"}}); err == nil || err.Error() != secrets.MsgLocked {
		t.Fatalf("locked globals save: %v", err)
	}
	if _, err := h.env.SaveVariables(g, []model.Variable{{Key: "password", Enabled: true, Secret: true}}, []pipeline.SecretRename{{From: "pw", To: "password"}}); err == nil || err.Error() != secrets.MsgLocked {
		t.Fatalf("locked save: %v", err)
	}
	h.secrets.Err = nil
	if _, err := h.env.SaveGlobals([]model.Variable{{Key: "password", Enabled: true, Secret: true}}, []pipeline.SecretRename{{From: "pw", To: "password"}}); err != nil {
		t.Fatal(err)
	}
	if v, err := h.env.RevealSecret(g, "password"); err != nil || v != "hunter2" {
		t.Fatalf("moved = %q %v", v, err)
	}

	col, _ := h.ws.CreateCollection("Users")
	c := pipeline.ScopeRef{Kind: vars.ScopeCollection, ID: col.ID}
	if _, err := h.ws.SaveCollection(col.ID, fsstore.CollectionSettings{Variables: []model.Variable{{Key: "a", Enabled: true, Secret: true}}}, nil); err != nil {
		t.Fatal(err)
	}
	_ = h.env.SetSecret(c, "a", "va")
	h.secrets.Err = secrets.ErrLocked
	if _, err := h.ws.SaveCollection(col.ID, fsstore.CollectionSettings{Variables: []model.Variable{{Key: "b", Enabled: true, Secret: true}}}, []pipeline.SecretRename{{From: "a", To: "b"}}); err == nil || err.Error() != secrets.MsgLocked {
		t.Fatalf("locked collection save: %v", err)
	}
	h.secrets.Err = nil
	if _, err := h.ws.SaveCollection(col.ID, fsstore.CollectionSettings{Variables: []model.Variable{{Key: "b", Enabled: true, Secret: true}}}, []pipeline.SecretRename{{From: "a", To: "b"}}); err != nil {
		t.Fatal(err)
	}
	if v, _ := h.env.RevealSecret(c, "b"); v != "va" {
		t.Fatalf("collection moved = %q", v)
	}
}
