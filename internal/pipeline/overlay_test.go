package pipeline

import (
	"context"
	"reflect"
	"strings"
	"testing"

	"pakpos/internal/core/model"
	"pakpos/internal/core/vars"
	"pakpos/internal/secrets"
)

// setByScript runs a pre-request script that sets values (through a draft
// in the fixture's collection with the Dev environment).
func setByScript(t *testing.T, f *fixture, code string) {
	t.Helper()
	draft := model.Request{URL: "http://x", Scripts: model.Scripts{PreRequest: code}}
	if pre := f.sess.NewSend(draft, f.col.ID, f.dev.ID, ScriptOptions{}).PreRequest(context.Background()); pre.Err != nil {
		t.Fatal(pre.Err)
	}
}

func TestOverlayBuildScopes(t *testing.T) {
	f := newFixture(t)
	f.sess.WithOverlay(NewOverlay())
	setByScript(t, f, `
pm.environment.set("host", "over.example");
pm.environment.set("extra", "e");
pm.collectionVariables.unset("colOnly");
`)
	scopes := f.sess.BuildScopes(f.col.ID, &f.dev)
	env := scopes.List[2]
	if env.Kind != vars.ScopeEnvironment || !reflect.DeepEqual(env.Variables, []model.Variable{v("extra", "e"), v("host", "over.example")}) || !reflect.DeepEqual(env.Unset, []string{"apiKey"}) {
		t.Errorf("env = %+v", env.Variables)
	}
	if strings.Contains(scopes.List[1].Name, "colOnly") || len(scopes.List[1].Variables) != 2 {
		t.Errorf("collection = %+v", scopes.List[1].Variables)
	}
	want := map[string]OverlayState{
		lockKey(f.dev.ID, "host"): OverlaySet, lockKey(f.dev.ID, "extra"): OverlayNew, lockKey(f.col.ID, "colOnly"): OverlayUnset,
	}
	if !reflect.DeepEqual(scopes.Overlay, want) {
		t.Errorf("states = %v", scopes.Overlay)
	}
	// Another session over the same workspace without the overlay sees the files.
	plain := New(f.ws, f.sec, nil)
	if p := must(plain.Prepare(model.Request{URL: "{{host}}"}, f.col.ID, f.dev.ID)); p.Request.URL != "dev.example" {
		t.Errorf("without overlay = %q", p.Request.URL)
	}
	pv := f.sess.Preview(model.Request{URL: "{{host}}"}, f.col.ID, f.dev.ID)
	for _, x := range pv.Variables {
		if x.Key == "host" && (x.Overlay != OverlaySet || x.Value != "over.example") {
			t.Errorf("preview host = %+v", x)
		}
	}
}

func TestOverlaySetsOverASecretKeepFlag(t *testing.T) {
	// A value in the overlay for a variable that is (now) a secret keeps the
	// secret flag, so previews mask it.
	f := newFixture(t)
	ov := NewOverlay()
	f.sess.WithOverlay(ov)
	ov.put(f.dev.ID, "apiKey", overlayEntry{value: "from-overlay"})
	vis := f.sess.VisibleVariables(f.col.ID, f.dev.ID)
	for _, x := range vis.Variables {
		if x.Key == "apiKey" && (!x.Secret || x.Value != "" || x.Overlay != OverlaySet) {
			t.Errorf("apiKey = %+v", x)
		}
	}
	vals := must(f.sess.OverlayValues(ScopeRef{Kind: vars.ScopeEnvironment, ID: f.dev.ID}))
	if !reflect.DeepEqual(vals, []OverlayValue{{Key: "apiKey", State: OverlaySet, Secret: true}}) {
		t.Errorf("values = %+v", vals)
	}
	// Persisting it writes the secret store, never the file.
	must(f.sess.PersistOverlay(ScopeRef{Kind: vars.ScopeEnvironment, ID: f.dev.ID}, "apiKey"))
	if got, _ := f.sec.Get(f.key(f.dev.ID, "apiKey")); got != "from-overlay" {
		t.Errorf("store = %q", got)
	}
	if e := must(f.ws.GetEnvironment(f.dev.ID)); e.Variables[1].Value != "" || !e.Variables[1].Secret {
		t.Errorf("file = %+v", e.Variables)
	}
}

func TestResetOverlay(t *testing.T) {
	f := newFixture(t)
	f.sess.WithOverlay(NewOverlay())
	setByScript(t, f, `pm.environment.set("host", "a"); pm.environment.set("x", "1"); pm.globals.set("g", "2")`)
	env := ScopeRef{Kind: vars.ScopeEnvironment, ID: f.dev.ID}
	if err := f.sess.ResetOverlay(env, "host"); err != nil {
		t.Fatal(err)
	}
	if vals := must(f.sess.OverlayValues(env)); len(vals) != 1 || vals[0].Key != "x" {
		t.Errorf("after one = %+v", vals)
	}
	if err := f.sess.ResetOverlay(env, ""); err != nil {
		t.Fatal(err)
	}
	if vals := must(f.sess.OverlayValues(env)); len(vals) != 0 {
		t.Errorf("after all = %+v", vals)
	}
	if vals := must(f.sess.OverlayValues(ScopeRef{Kind: vars.ScopeGlobal})); len(vals) != 1 {
		t.Errorf("globals touched: %+v", vals)
	}
	if err := f.sess.ResetOverlay(ScopeRef{Kind: vars.ScopeLocal}, ""); err == nil {
		t.Error("local scope accepted")
	}
	if _, err := f.sess.OverlayValues(ScopeRef{Kind: vars.ScopeEnvironment, ID: "gone"}); err == nil {
		t.Error("unknown environment accepted")
	}
}

func TestPersistOverlay(t *testing.T) {
	f := newFixture(t)
	f.sess.WithOverlay(NewOverlay())
	must(f.ws.SaveEnvironmentVariables(f.dev.ID, []model.Variable{
		v("host", "dev.example"), secret("apiKey"),
		{Key: "off", Value: "old"}, v("drop", "d"), v("dup", "1"), v("dup", "2"),
	}))
	setByScript(t, f, `
pm.environment.set("host", "persisted.example");
pm.environment.set("off", "on");
pm.environment.set("dup", "3");
pm.environment.set("fresh", "f");
pm.environment.unset("drop");
pm.environment.set("keep", "k");
`)
	env := ScopeRef{Kind: vars.ScopeEnvironment, ID: f.dev.ID}

	if _, err := f.sess.PersistOverlay(env, "nope"); err == nil || !strings.Contains(err.Error(), `"nope" has no value set by a script`) {
		t.Errorf("unknown key err = %v", err)
	}
	saved := must(f.sess.PersistOverlay(env, "host"))
	if saved[0].Value != "persisted.example" {
		t.Errorf("saved = %+v", saved)
	}
	if vals := must(f.sess.OverlayValues(env)); len(vals) != 5 {
		t.Errorf("left = %+v", vals)
	}
	// "keep" is reset first, so persisting everything leaves it out.
	if err := f.sess.ResetOverlay(env, "keep"); err != nil {
		t.Fatal(err)
	}
	saved = must(f.sess.PersistOverlay(env, ""))
	want := []model.Variable{
		v("host", "persisted.example"), secret("apiKey"),
		v("off", "on"), v("dup", "3"), v("dup", "3"), v("fresh", "f"),
	}
	if !reflect.DeepEqual(saved, want) {
		t.Errorf("saved = %+v", saved)
	}
	if e := must(f.ws.GetEnvironment(f.dev.ID)); !reflect.DeepEqual(e.Variables, want) {
		t.Errorf("file = %+v", e.Variables)
	}
	if vals := must(f.sess.OverlayValues(env)); len(vals) != 0 {
		t.Errorf("overlay left = %+v", vals)
	}

	// A failing secret store stops the persist and keeps the overlay.
	f.sess.overlay.put(f.dev.ID, "apiKey", overlayEntry{value: "v"})
	f.sec.Err = secrets.ErrLocked
	if _, err := f.sess.PersistOverlay(env, ""); err == nil {
		t.Error("locked store accepted")
	}
	// A failing save (unknown scope) also errors.
	if _, err := f.sess.PersistOverlay(ScopeRef{Kind: vars.ScopeEnvironment, ID: "gone"}, ""); err == nil {
		t.Error("unknown scope accepted")
	}
	f.sec.Err = nil
	if vals := must(f.sess.OverlayValues(env)); len(vals) != 1 {
		t.Errorf("overlay after failure = %+v", vals)
	}
}

func TestPersistOverlaySaveFails(t *testing.T) {
	f := newFixture(t)
	f.sess.WithOverlay(NewOverlay())
	// A secret rename needs the store: a locked store refuses the save.
	f.sess.overlay.put(f.globalID, "gOnly", overlayEntry{value: "x"})
	ws := f.ws
	if err := ws.DeleteEnvironment(f.prod.ID); err != nil {
		t.Fatal(err)
	}
	f.sess.overlay.put(f.prod.ID, "a", overlayEntry{value: "x"})
	if _, err := f.sess.PersistOverlay(ScopeRef{Kind: vars.ScopeEnvironment, ID: f.prod.ID}, ""); err == nil {
		t.Error("deleted environment accepted")
	}
	saved := must(f.sess.PersistOverlay(ScopeRef{Kind: vars.ScopeGlobal}, ""))
	if saved[1].Value != "x" {
		t.Errorf("globals = %+v", saved)
	}
}

func TestOverlayDrop(t *testing.T) {
	o := NewOverlay()
	o.put("s", "a", overlayEntry{value: "1"})
	o.put("s", "b", overlayEntry{value: "2"})
	o.drop("s", "a")
	if got := o.scope("s"); len(got) != 1 {
		t.Errorf("after one = %v", got)
	}
	o.drop("s", "b")
	if got := o.scope("s"); got != nil {
		t.Errorf("after both = %v", got)
	}
	o.dropIfSet("s", "")
	var none *Overlay
	none.putIfSet("s", "a", overlayEntry{})
	none.dropIfSet("s", "a")
	if none.scope("s") != nil {
		t.Error("nil overlay has entries")
	}
}

func TestPersistRow(t *testing.T) {
	rows := persistRow([]model.Variable{{Key: "a", Value: "1"}, {Key: "a", Value: "2"}}, "a", "3")
	if !reflect.DeepEqual(rows, []model.Variable{{Key: "a", Value: "3"}, {Key: "a", Value: "3", Enabled: true}}) {
		t.Errorf("rows = %+v", rows)
	}
}
