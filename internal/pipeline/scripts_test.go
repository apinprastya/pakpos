package pipeline

import (
	"context"
	"encoding/base64"
	"errors"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
	"time"

	"pakpos/internal/core/model"
	"pakpos/internal/core/script"
	"pakpos/internal/core/vars"
	"pakpos/internal/secrets"
	"pakpos/internal/store/fsstore"
)

// withScripts sets scripts on the fixture's collection, folder and request.
func (f *fixture) withScripts(col, folder, req model.Scripts) {
	must(f.ws.SaveCollection(f.col.ID, fsstore.CollectionSettings{
		Auth: f.col.Auth, Headers: f.col.Headers, Variables: f.col.Variables, Scripts: &col,
	}))
	must(f.ws.SaveFolder(f.folder.ID, fsstore.FolderSettings{Headers: f.folder.Headers, Scripts: &folder}))
	f.req.Scripts = req
	f.req = must(f.ws.SaveRequest(f.req))
}

func consoleTexts(entries []script.ConsoleEntry) []string {
	out := make([]string, len(entries))
	for i, e := range entries {
		out[i] = e.Text
	}
	return out
}

func TestSendRunsScriptsInOrder(t *testing.T) {
	f := newFixture(t)
	f.sess.WithOverlay(NewOverlay())
	f.withScripts(
		model.Scripts{PreRequest: `console.log("collection pre", pm.info.eventName)`, Test: `console.log("collection test")`},
		model.Scripts{PreRequest: `console.log("folder pre"); pm.variables.set("fromFolder", "f1")`, Test: `console.log("folder test")`},
		model.Scripts{PreRequest: `console.log("request pre", pm.variables.get("fromFolder"))`, Test: `pm.test("ok", () => pm.response.to.have.status(200)); console.log("request test")`},
	)
	var streamed [][]string
	sd := f.sess.NewSend(f.req, "", f.dev.ID, ScriptOptions{OnConsole: func(e []script.ConsoleEntry) {
		streamed = append(streamed, consoleTexts(e))
	}})
	pre := sd.PreRequest(context.Background())
	if pre.Err != nil || pre.Skip {
		t.Fatalf("pre = %+v", pre)
	}
	if got := consoleTexts(pre.Console); !reflect.DeepEqual(got, []string{"collection pre prerequest", "folder pre", "request pre f1"}) {
		t.Errorf("pre console = %v", got)
	}
	kinds := []script.LevelKind{pre.Console[0].Source.Kind, pre.Console[1].Source.Kind, pre.Console[2].Source.Kind}
	if !reflect.DeepEqual(kinds, []script.LevelKind{script.LevelCollection, script.LevelFolder, script.LevelRequest}) {
		t.Errorf("sources = %v", kinds)
	}
	test := sd.Test(context.Background(), &model.Response{StatusCode: 200, StatusText: "200 OK", Body: "{}"})
	if got := consoleTexts(test.Console); !reflect.DeepEqual(got, []string{"collection test", "folder test", "request test"}) {
		t.Errorf("test console = %v", got)
	}
	if len(test.Tests) != 1 || !test.Tests[0].Passed {
		t.Errorf("tests = %+v", test.Tests)
	}
	if len(streamed) != 6 || streamed[5][0] != "request test" {
		t.Errorf("streamed = %v", streamed)
	}
}

func TestPreRequestChangesTheSentRequest(t *testing.T) {
	f := newFixture(t)
	ov := NewOverlay()
	f.sess.WithOverlay(ov)
	f.withScripts(model.Scripts{}, model.Scripts{}, model.Scripts{PreRequest: `
pm.variables.set("trace", "t-1");
pm.environment.set("host", "script.example");
pm.request.headers.upsert({key: "X-Trace", value: "{{trace}}"});
pm.request.headers.remove("X-Keep");
pm.request.url.addQueryParams("page={{trace}}");
`})
	sd := f.sess.NewSend(f.req, "", f.dev.ID, ScriptOptions{})
	if pre := sd.PreRequest(context.Background()); pre.Err != nil {
		t.Fatal(pre.Err)
	}
	p, err := sd.Prepare()
	if err != nil {
		t.Fatal(err)
	}
	if p.Request.URL != "https://script.example/users?page=t-1" || p.Request.Query[0].Value != "t-1" {
		t.Errorf("url = %q query %v", p.Request.URL, p.Request.Query)
	}
	headers := map[string]string{}
	for _, h := range p.Request.Headers {
		headers[h.Key] = h.Value
	}
	if headers["X-Trace"] != "t-1" || headers["X-Keep"] != "" || headers["X-Folder"] != "f" {
		t.Errorf("headers = %v", headers)
	}
	if p.Environment == nil || p.Environment.ID != f.dev.ID {
		t.Errorf("environment = %+v", p.Environment)
	}
	// The overlay outlives the send; the file doesn't change.
	if e := must(f.ws.GetEnvironment(f.dev.ID)); e.Variables[0].Value != "dev.example" {
		t.Errorf("file = %+v", e.Variables)
	}
	next := must(f.sess.Prepare(model.Request{URL: "https://{{host}}/{{trace}}"}, f.col.ID, f.dev.ID))
	if next.Request.URL != "https://script.example/{{trace}}" {
		t.Errorf("next send url = %q", next.Request.URL)
	}
}

func TestPreRequestErrorAndSkip(t *testing.T) {
	f := newFixture(t)
	f.withScripts(model.Scripts{PreRequest: `console.log("ran")`}, model.Scripts{PreRequest: "\nboom()"}, model.Scripts{PreRequest: `console.log("never")`})
	pre := f.sess.NewSend(f.req, "", "", ScriptOptions{}).PreRequest(context.Background())
	if pre.Err == nil || pre.Err.Line != 2 || pre.Err.Source.Kind != script.LevelFolder || pre.Err.Source.Name != "Admin" {
		t.Fatalf("err = %+v", pre.Err)
	}
	if !reflect.DeepEqual(consoleTexts(pre.Console), []string{"ran"}) {
		t.Errorf("console = %v", consoleTexts(pre.Console))
	}

	f.withScripts(model.Scripts{PreRequest: `pm.execution.skipRequest(); pm.execution.setNextRequest("Other")`}, model.Scripts{}, model.Scripts{PreRequest: `console.log("never")`})
	pre = f.sess.NewSend(f.req, "", "", ScriptOptions{}).PreRequest(context.Background())
	if !pre.Skip || len(pre.Console) != 0 || pre.NextRequest == nil || *pre.NextRequest != "Other" || pre.NextStop {
		t.Errorf("skip = %+v", pre)
	}
}

func TestTestScriptErrorsBecomeFailedTests(t *testing.T) {
	f := newFixture(t)
	f.withScripts(
		model.Scripts{Test: "pm.response.json()"},
		model.Scripts{Test: "while (true) {}"},
		model.Scripts{Test: `pm.test("still runs", () => {})`},
	)
	rep := f.sess.NewSend(f.req, "", "", ScriptOptions{Timeout: 100 * time.Millisecond}).Test(context.Background(), &model.Response{StatusCode: 200, Body: "nope"})
	if rep.Err != nil || len(rep.Tests) != 3 {
		t.Fatalf("report = %+v", rep)
	}
	if rep.Tests[0].Name != ScriptErrorTest || !strings.HasPrefix(rep.Tests[0].Error, `Error in the test script of collection "Users" at line 1:`) {
		t.Errorf("first = %+v", rep.Tests[0])
	}
	if rep.Tests[1].Error != `Error in the test script of folder "Admin": Script took longer than 0.1 s` {
		t.Errorf("second = %+v", rep.Tests[1])
	}
	if !rep.Tests[2].Passed {
		t.Errorf("third = %+v", rep.Tests[2])
	}

	// A cancelled send stops at once.
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	rep = f.sess.NewSend(f.req, "", "", ScriptOptions{}).Test(ctx, &model.Response{StatusCode: 200})
	if rep.Err == nil || !rep.Err.Canceled || len(rep.Tests) != 0 {
		t.Errorf("cancelled = %+v", rep)
	}
}

func TestScriptOutputIsMasked(t *testing.T) {
	f := newFixture(t)
	f.sess.WithOverlay(NewOverlay())
	wsID := f.ws.Manifest().ID
	_ = f.sec.Set(secrets.Key(wsID, f.dev.ID, "apiKey"), "dev-api-key")
	f.withScripts(model.Scripts{}, model.Scripts{}, model.Scripts{
		PreRequest: `
console.log("token", pm.collectionVariables.get("token"), btoa(pm.collectionVariables.get("token")));
pm.environment.set("apiKey", "new-key-value");
console.log("set", pm.environment.get("apiKey"));
pm.test("named " + pm.environment.get("apiKey"), () => { throw new Error("has s3cret") });
`,
		Test: `throw new Error("leak " + pm.environment.get("apiKey"))`,
	})
	sd := f.sess.NewSend(f.req, "", f.dev.ID, ScriptOptions{})
	pre := sd.PreRequest(context.Background())
	if pre.Err != nil {
		t.Fatal(pre.Err)
	}
	want := []string{"token [secret:token] " + SecretMark("token"), "set [secret:apiKey]"}
	if got := consoleTexts(pre.Console); !reflect.DeepEqual(got, want) {
		t.Errorf("console = %v", got)
	}
	if tr := pre.Tests[0]; tr.Name != "named [secret:apiKey]" || tr.Error != "Error: has [secret:token]" {
		t.Errorf("test = %+v", tr)
	}
	// The secret went to the store, not the overlay or the file.
	if got, _ := f.sec.Get(secrets.Key(wsID, f.dev.ID, "apiKey")); got != "new-key-value" {
		t.Errorf("store = %q", got)
	}
	if vals := must(f.sess.OverlayValues(ScopeRef{Kind: vars.ScopeEnvironment, ID: f.dev.ID})); len(vals) != 0 {
		t.Errorf("overlay = %+v", vals)
	}
	test := sd.Test(context.Background(), &model.Response{StatusCode: 200})
	if test.Tests[0].Error != `Error in the test script of request "Get" at line 1:7: Error: leak [secret:apiKey]` {
		t.Errorf("test error = %q", test.Tests[0].Error)
	}
	if sd.Mask("x new-key-value "+base64.StdEncoding.EncodeToString([]byte("new-key-value"))) != "x [secret:apiKey] [secret:apiKey]" {
		t.Errorf("mask = %q", sd.Mask("new-key-value"))
	}
	// A short value isn't added to the masks.
	before := len(sd.Secrets())
	sd.addSecret("x", "abc")
	if len(sd.Secrets()) != before {
		t.Error("short value added")
	}
}

func TestScriptSecretWriteLocked(t *testing.T) {
	f := newFixture(t)
	f.withScripts(model.Scripts{}, model.Scripts{}, model.Scripts{PreRequest: `pm.collectionVariables.set("token", "next")`})
	f.sec.Err = secrets.ErrLocked
	sd := f.sess.NewSend(f.req, "", "", ScriptOptions{})
	pre := sd.PreRequest(context.Background())
	if pre.Err == nil || !strings.Contains(pre.Err.Message, `The secret store is locked, so the secret "token" wasn't set. Unlock it and send again.`) {
		t.Fatalf("err = %+v", pre.Err)
	}
	if !sd.SecretsLocked() {
		t.Error("not locked")
	}
	if p, _ := sd.Prepare(); !p.SecretsLocked {
		t.Error("prepared not locked")
	}

	f.sec.Err = errors.New("dbus gone")
	pre = f.sess.NewSend(f.req, "", "", ScriptOptions{}).PreRequest(context.Background())
	if pre.Err == nil || !strings.Contains(pre.Err.Message, `Couldn't store the secret "token": `) {
		t.Fatalf("err = %+v", pre.Err)
	}
}

func TestScriptVarsScopes(t *testing.T) {
	f := newFixture(t)
	ov := NewOverlay()
	f.sess.WithOverlay(ov)
	draft := model.Request{Name: "", URL: "http://x", Scripts: model.Scripts{PreRequest: `
console.log(pm.environment.get("host"), pm.collectionVariables.get("host"), pm.globals.get("host"), pm.variables.get("host"));
console.log(pm.collectionVariables.has("token"), pm.variables.get("data"));
pm.globals.set("gOnly", "changed");
pm.globals.set("brandNew", "n");
pm.globals.unset("brandNew");
pm.globals.set("again", "a");
pm.globals.unset("host");
pm.globals.set("host", "back");
pm.collectionVariables.unset("colOnly");
pm.collectionVariables.unset("nothing");
pm.variables.set("tmp", "1");
pm.variables.unset("tmp");
console.log(pm.variables.replaceIn("{{gOnly}} {{again}} {{tmp}} {{data}}"), pm.info.requestName, pm.info.iteration, pm.info.iterationCount);
`}}
	sd := f.sess.NewSend(draft, f.col.ID, f.dev.ID, ScriptOptions{Iteration: 1, IterationCount: 3, IterationData: map[string]string{"data": "row"}})
	pre := sd.PreRequest(context.Background())
	if pre.Err != nil {
		t.Fatal(pre.Err)
	}
	want := []string{
		"dev.example col.example global.example dev.example",
		"true row",
		"changed a {{tmp}} row  1 3",
	}
	if got := consoleTexts(pre.Console); !reflect.DeepEqual(got, want) {
		t.Errorf("console = %v", got)
	}
	globals := must(f.sess.OverlayValues(ScopeRef{Kind: vars.ScopeGlobal}))
	wantG := []OverlayValue{
		{Key: "again", Value: "a", State: OverlayNew},
		{Key: "gOnly", Value: "changed", State: OverlaySet},
		{Key: "host", Value: "back", State: OverlaySet},
	}
	if !reflect.DeepEqual(globals, wantG) {
		t.Errorf("globals overlay = %+v", globals)
	}
	col := must(f.sess.OverlayValues(ScopeRef{Kind: vars.ScopeCollection, ID: f.col.ID}))
	if !reflect.DeepEqual(col, []OverlayValue{{Key: "colOnly", State: OverlayUnset}}) {
		t.Errorf("collection overlay = %+v", col)
	}
	// Preview and VisibleVariables show the overlay.
	vis := f.sess.VisibleVariables(f.col.ID, f.dev.ID)
	states := map[string]OverlayState{}
	for _, pv := range vis.Variables {
		states[pv.Key] = pv.Overlay
	}
	if states["gOnly"] != OverlaySet || states["again"] != OverlayNew || states["host"] != OverlayNone {
		t.Errorf("visible states = %v", states)
	}
	if _, ok := states["colOnly"]; ok {
		t.Error("unset variable still visible")
	}
}

func TestScriptVarsWithoutScopes(t *testing.T) {
	f := newFixture(t)
	draft := model.Request{URL: "http://x", Scripts: model.Scripts{PreRequest: `pm.environment.set("a", 1)`}}
	pre := f.sess.NewSend(draft, "", "", ScriptOptions{}).PreRequest(context.Background())
	if pre.Err == nil || !strings.Contains(pre.Err.Message, "No environment is selected, so pm.environment can't set \"a\". Select an environment and send again.") {
		t.Errorf("env err = %+v", pre.Err)
	}
	draft.Scripts.PreRequest = `pm.collectionVariables.unset("a")`
	pre = f.sess.NewSend(draft, "", "", ScriptOptions{}).PreRequest(context.Background())
	if pre.Err == nil || !strings.Contains(pre.Err.Message, `This request isn't in a collection, so pm.collectionVariables can't unset "a".`) {
		t.Errorf("collection err = %+v", pre.Err)
	}
	// No overlay: values still apply to this send.
	draft.Scripts.PreRequest = `pm.globals.set("g", "1"); pm.globals.unset("gOnly"); pm.request.url = "http://{{g}}"`
	sd := f.sess.NewSend(draft, "", "", ScriptOptions{})
	if pre := sd.PreRequest(context.Background()); pre.Err != nil {
		t.Fatal(pre.Err)
	}
	if p := must(sd.Prepare()); p.Request.URL != "http://1" {
		t.Errorf("url = %q", p.Request.URL)
	}
	if err := f.sess.ResetOverlay(ScopeRef{Kind: vars.ScopeGlobal}, ""); !errors.Is(err, ErrNoOverlay) {
		t.Errorf("reset err = %v", err)
	}
	if _, err := f.sess.PersistOverlay(ScopeRef{Kind: vars.ScopeGlobal}, ""); !errors.Is(err, ErrNoOverlay) {
		t.Errorf("persist err = %v", err)
	}
}

func TestSendWithoutWorkspace(t *testing.T) {
	req := model.Request{Name: "Draft", URL: "http://x/{{a}}", Scripts: model.Scripts{
		PreRequest: `pm.variables.set("a", "b"); console.log(pm.variables.get("seed"))`,
		Test:       `pm.test("code", () => pm.expect(pm.response.code).to.equal(201))`,
	}}
	sd := NewSendWithoutWorkspace(req, ScriptOptions{IterationData: map[string]string{"seed": "s"}})
	pre := sd.PreRequest(context.Background())
	if pre.Err != nil || consoleTexts(pre.Console)[0] != "s" {
		t.Fatalf("pre = %+v", pre)
	}
	p := must(sd.Prepare())
	if p.Request.URL != "http://x/b" || p.Environment != nil {
		t.Errorf("prepared = %+v", p)
	}
	rep := sd.Test(context.Background(), &model.Response{StatusCode: 404})
	if rep.Tests[0].Passed || rep.Tests[0].Error != "AssertionError: expected 404 to equal 201" {
		t.Errorf("tests = %+v", rep.Tests)
	}
	if len(sd.Secrets()) != 0 || sd.Mask("x") != "x" {
		t.Error("unexpected masks")
	}
	draft := model.Request{Scripts: model.Scripts{PreRequest: `pm.globals.set("a", 1)`}}
	pre = NewSendWithoutWorkspace(draft, ScriptOptions{}).PreRequest(context.Background())
	if pre.Err == nil || !strings.Contains(pre.Err.Message, `No workspace is open, so pm.globals can't set "a".`) {
		t.Errorf("err = %+v", pre.Err)
	}
	draft.Scripts.PreRequest = `pm.variables.replaceIn("{{$nope}}"); pm.request.url = "{{x}}"`
	sd = NewSendWithoutWorkspace(draft, ScriptOptions{})
	if pre := sd.PreRequest(context.Background()); pre.Err != nil {
		t.Fatal(pre.Err)
	}
}

func TestReplaceInCycle(t *testing.T) {
	f := newFixture(t)
	must(f.ws.SaveGlobals([]model.Variable{v("a", "{{b}}"), v("b", "{{a}}")}))
	draft := model.Request{URL: "http://x", Scripts: model.Scripts{PreRequest: `pm.variables.replaceIn("{{a}}")`}}
	pre := f.sess.NewSend(draft, "", "", ScriptOptions{}).PreRequest(context.Background())
	if pre.Err == nil || !strings.Contains(pre.Err.Message, "Variables refer to each other in a loop") {
		t.Errorf("err = %+v", pre.Err)
	}
}

func TestResponseBody(t *testing.T) {
	path := filepath.Join(t.TempDir(), "body")
	if err := os.WriteFile(path, []byte("full body"), 0o600); err != nil {
		t.Fatal(err)
	}
	cases := []struct {
		name string
		resp model.Response
		want string
	}{
		{"inline", model.Response{Body: "text"}, "text"},
		{"base64", model.Response{Body: base64.StdEncoding.EncodeToString([]byte{0xff, 'a'}), Encoding: model.EncodingBase64}, "\xffa"},
		{"bad base64", model.Response{Body: "%%", Encoding: model.EncodingBase64}, "%%"},
		{"spilled", model.Response{Body: "full", Truncated: true, BodyPath: path}, "full body"},
		{"spill gone", model.Response{Body: "full", Truncated: true, BodyPath: path + "-gone"}, "full"},
	}
	for _, c := range cases {
		if got := string(ResponseBody(&c.resp)); got != c.want {
			t.Errorf("%s: %q", c.name, got)
		}
	}
}

func TestVarErrorUnwraps(t *testing.T) {
	e := &VarError{Message: "m", Err: secrets.ErrLocked}
	if e.Error() != "m" || !errors.Is(e, secrets.ErrLocked) {
		t.Errorf("e = %v", e)
	}
}

func TestLocalCarriesAcrossSends(t *testing.T) {
	f := newFixture(t)
	f.withScripts(model.Scripts{}, model.Scripts{}, model.Scripts{PreRequest: `
pm.variables.set("step", String(Number(pm.variables.get("step") || "0") + 1));
pm.variables.unset("drop");
console.log(pm.iterationData.get("user"));
`})
	opts := ScriptOptions{IterationData: map[string]string{"user": "ana", "drop": "x"}}
	sd := f.sess.NewSend(f.req, "", "", opts)
	if pre := sd.PreRequest(context.Background()); pre.Err != nil {
		t.Fatal(pre.Err)
	}
	local := sd.Local()
	if !reflect.DeepEqual(local, map[string]string{"user": "ana", "step": "1"}) {
		t.Fatalf("local = %v", local)
	}
	opts.Local = local
	sd = f.sess.NewSend(f.req, "", "", opts)
	pre := sd.PreRequest(context.Background())
	if got := sd.Local(); got["step"] != "2" || got["drop"] != "" {
		t.Errorf("second local = %v", got)
	}
	// pm.iterationData stays the data row.
	if len(pre.Console) != 1 || pre.Console[0].Text != "ana" {
		t.Errorf("console = %+v", pre.Console)
	}
}

func TestIsolatedSession(t *testing.T) {
	f := newFixture(t)
	ov := NewOverlay()
	ov.put(f.dev.ID, "seen", overlayEntry{value: "before"})
	f.sess.WithOverlay(ov)
	iso := f.sess.Isolated()
	f.withScripts(model.Scripts{}, model.Scripts{}, model.Scripts{PreRequest: `
console.log(pm.environment.get("seen"));
pm.environment.set("host", "isolated.example");
`})
	sd := iso.NewSend(f.req, "", f.dev.ID, ScriptOptions{})
	pre := sd.PreRequest(context.Background())
	if pre.Err != nil || pre.Console[0].Text != "before" {
		t.Fatalf("pre = %+v", pre)
	}
	if p := must(sd.Prepare()); !strings.HasPrefix(p.Request.URL, "https://isolated.example") {
		t.Errorf("isolated url = %q", p.Request.URL)
	}
	if _, ok := ov.scope(f.dev.ID)["host"]; ok {
		t.Error("isolated write reached the shared overlay")
	}
	if iso.Workspace() != f.ws {
		t.Error("workspace not kept")
	}
	if c := (*Overlay)(nil).Clone(); c == nil || len(c.entries) != 0 {
		t.Errorf("nil clone = %+v", c)
	}
}
