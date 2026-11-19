package service

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"sync"
	"testing"

	"pakpos/internal/core/httpexec"
	"pakpos/internal/core/model"
	"pakpos/internal/core/script"
	"pakpos/internal/core/vars"
	"pakpos/internal/pipeline"
	"pakpos/internal/secrets"
	"pakpos/internal/store/fsstore"
)

// scriptServer answers /login with a token and echoes what /me received.
func scriptServer(t *testing.T) (*httptest.Server, func() http.Header) {
	t.Helper()
	var mu sync.Mutex
	var last http.Header
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		mu.Lock()
		last = r.Header.Clone()
		mu.Unlock()
		w.Header().Set("Content-Type", "application/json")
		switch r.URL.Path {
		case "/login":
			fmt.Fprint(w, `{"token":"tok-from-login-123","refresh":"refresh-secret-456"}`)
		default:
			_ = json.NewEncoder(w).Encode(map[string]string{"auth": r.Header.Get("Authorization"), "query": r.URL.RawQuery})
		}
	}))
	t.Cleanup(srv.Close)
	return srv, func() http.Header {
		mu.Lock()
		defer mu.Unlock()
		return last
	}
}

func consoleOf(entries []script.ConsoleEntry) []string {
	out := make([]string, len(entries))
	for i, e := range entries {
		out[i] = string(e.Source.Kind) + ": " + e.Text
	}
	return out
}

// TestEndToEndScripts: a login request's test script stores the token in
// the environment (overlay, the file is unchanged), the next request sends
// it, PersistOverlay writes it to the file; a secret target goes to the
// secret store and never appears in SQLite, files or the console; scripts
// inherited from the collection and folder run in order.
func TestEndToEndScripts(t *testing.T) {
	const derived = "rot-654-terces-hserfer"
	srv, lastHeaders := scriptServer(t)
	h := newHarness(t)
	info := h.openWorkspace(t)
	ctx := context.Background()

	col, err := h.ws.CreateCollection("API")
	if err != nil {
		t.Fatal(err)
	}
	colScripts := model.Scripts{
		PreRequest: `console.log("collection pre")`,
		Test:       `console.log("collection test"); pm.test("collection sees the status", () => pm.response.to.be.ok)`,
	}
	if _, err := h.ws.SaveCollection(col.ID, fsstore.CollectionSettings{
		Variables: []model.Variable{{Key: "refresh", Enabled: true, Secret: true}},
		Scripts:   &colScripts,
	}, nil); err != nil {
		t.Fatal(err)
	}
	folder, err := h.ws.CreateFolder(col.ID, "Auth")
	if err != nil {
		t.Fatal(err)
	}
	folderScripts := model.Scripts{PreRequest: `console.log("folder pre")`, Test: `console.log("folder test")`}
	if _, err := h.ws.SaveFolder(folder.ID, fsstore.FolderSettings{Scripts: &folderScripts}); err != nil {
		t.Fatal(err)
	}
	dev, err := h.env.Create("Dev")
	if err != nil {
		t.Fatal(err)
	}
	devRef := pipeline.ScopeRef{Kind: vars.ScopeEnvironment, ID: dev.ID}
	if _, err := h.env.SaveVariables(devRef, []model.Variable{
		{Key: "base", Value: srv.URL, Enabled: true},
		{Key: "token", Value: "", Enabled: true},
	}, nil); err != nil {
		t.Fatal(err)
	}
	if err := h.env.Select(dev.ID); err != nil {
		t.Fatal(err)
	}
	envFile := filepath.Join(info.Path, fsstore.EnvironmentsDir, "dev.yaml")
	envBefore, err := os.ReadFile(envFile)
	if err != nil {
		t.Fatal(err)
	}

	login, err := h.req.SaveAs(folder.ID, "Login", model.Request{Method: "POST", URL: "{{base}}/login", Scripts: model.Scripts{
		PreRequest: `console.log("request pre")`,
		Test: `
const json = pm.response.json();
pm.test("has a token", () => pm.expect(json.token).to.be.a("string"));
pm.environment.set("token", json.token);
// A value derived in the script, so the response body stored in history
// doesn't hold it.
pm.collectionVariables.set("refresh", "rot-" + json.refresh.split("").reverse().join(""));
console.log("request test", pm.collectionVariables.get("refresh"));
`,
	}})
	if err != nil {
		t.Fatal(err)
	}
	res, err := h.req.Send(ctx, "login", login, "")
	if err != nil || res.Error != nil {
		t.Fatalf("login: %+v %v", res.Error, err)
	}
	wantConsole := []string{
		"collection: collection pre", "folder: folder pre", "request: request pre",
		"collection: collection test", "folder: folder test", "request: request test [secret:refresh]",
	}
	if got := consoleOf(res.Console); !reflect.DeepEqual(got, wantConsole) {
		t.Errorf("console = %v", got)
	}
	if len(res.Tests) != 2 || !res.Tests[0].Passed || !res.Tests[1].Passed || res.Tests[0].Source.Kind != script.LevelCollection {
		t.Errorf("tests = %+v", res.Tests)
	}
	// Console output was also streamed, masked, per script run.
	var streamed []string
	for _, e := range h.events.all() {
		if ev, ok := e.data.(ScriptConsoleEvent); ok && e.name == EventScriptConsole && ev.SendID == "login" {
			streamed = append(streamed, consoleOf(ev.Entries)...)
		}
	}
	if !reflect.DeepEqual(streamed, wantConsole) {
		t.Errorf("streamed = %v", streamed)
	}

	// The token is in the overlay: the next send uses it, the file is unchanged.
	me, err := h.req.SaveAs(col.ID, "Me", model.Request{Method: "GET", URL: "{{base}}/me", Headers: []model.KeyValue{
		{Key: "Authorization", Value: "Bearer {{token}}", Enabled: true},
	}})
	if err != nil {
		t.Fatal(err)
	}
	res, err = h.req.Send(ctx, "me", me, "")
	if err != nil || res.Error != nil {
		t.Fatalf("me: %+v %v", res.Error, err)
	}
	if got := lastHeaders().Get("Authorization"); got != "Bearer tok-from-login-123" {
		t.Errorf("sent Authorization = %q", got)
	}
	if after, _ := os.ReadFile(envFile); string(after) != string(envBefore) {
		t.Errorf("environment file changed:\n%s", after)
	}
	overlay, err := h.env.OverlayValues(devRef)
	if err != nil || !reflect.DeepEqual(overlay, []pipeline.OverlayValue{{Key: "token", Value: "tok-from-login-123", State: pipeline.OverlaySet}}) {
		t.Errorf("overlay = %+v %v", overlay, err)
	}
	visible, err := h.env.VisibleVariables(col.ID, "")
	if err != nil {
		t.Fatal(err)
	}
	for _, v := range visible.Variables {
		if v.Key == "token" && v.Overlay != pipeline.OverlaySet {
			t.Errorf("visible token = %+v", v)
		}
	}

	// The secret target went to the secret store, not the overlay.
	if got, _ := h.secrets.Get(secrets.Key(info.ID, col.ID, "refresh")); got != derived {
		t.Errorf("stored refresh = %q", got)
	}
	if vals, _ := h.env.OverlayValues(pipeline.ScopeRef{Kind: vars.ScopeCollection, ID: col.ID}); len(vals) != 0 {
		t.Errorf("collection overlay = %+v", vals)
	}

	// Persist writes the file and empties the overlay.
	saved, err := h.env.PersistOverlay(devRef, "token")
	if err != nil {
		t.Fatal(err)
	}
	if saved[1].Value != "tok-from-login-123" {
		t.Errorf("saved = %+v", saved)
	}
	if text, _ := os.ReadFile(envFile); !strings.Contains(string(text), "tok-from-login-123") {
		t.Errorf("file = %s", text)
	}
	if vals, _ := h.env.OverlayValues(devRef); len(vals) != 0 {
		t.Errorf("overlay after persist = %+v", vals)
	}

	// Reset drops a script value; the overlay is gone after a reopen.
	if _, err := h.req.Send(ctx, "login2", login, ""); err != nil {
		t.Fatal(err)
	}
	if err := h.env.ResetOverlay(devRef, ""); err != nil {
		t.Fatal(err)
	}
	if vals, _ := h.env.OverlayValues(devRef); len(vals) != 0 {
		t.Errorf("overlay after reset = %+v", vals)
	}
	if _, err := h.req.Send(ctx, "login3", login, ""); err != nil {
		t.Fatal(err)
	}
	if vals, _ := h.env.OverlayValues(devRef); len(vals) != 1 {
		t.Errorf("overlay before reopen = %+v", vals)
	}
	if _, err := h.ws.Open(info.Path); err != nil {
		t.Fatal(err)
	}
	if vals, _ := h.env.OverlayValues(devRef); len(vals) != 0 {
		t.Errorf("overlay after reopen = %+v", vals)
	}

	// The secret never reaches SQLite, workspace files or the result.
	if dbHolds(t, h.dataDir, derived) {
		t.Error("secret in SQLite")
	}
	assertNoSecret(t, derived, info.Path, h.dataDir)
	data, _ := json.Marshal(res)
	if strings.Contains(string(data), derived) {
		t.Error("secret in the send result")
	}
	// History has the request as written.
	entry, err := h.hist.Get(res.HistoryID)
	if err != nil || entry.Request.URL != "{{base}}/me" {
		t.Errorf("history = %+v %v", entry.Request, err)
	}
}

// TestEndToEndPreRequestScripts: a pre-request script adds a header and a
// local variable the request uses (Debug hops show it, history doesn't); a
// script error stops the send; a timeout is reported; skipRequest skips it.
func TestEndToEndPreRequestScripts(t *testing.T) {
	srv, lastHeaders := scriptServer(t)
	h := newHarness(t)
	h.openWorkspace(t)
	ctx := context.Background()
	col, err := h.ws.CreateCollection("API")
	if err != nil {
		t.Fatal(err)
	}
	draft := model.Request{Method: "GET", URL: srv.URL + "/echo?q={{q}}", Query: []model.KeyValue{{Key: "q", Value: "{{q}}", Enabled: true}}, Scripts: model.Scripts{PreRequest: `
pm.variables.set("q", "from-script");
pm.request.headers.add({key: "X-Signed", value: "sig-" + pm.variables.get("q")});
`}}
	res, err := h.req.Send(ctx, "pre", draft, col.ID)
	if err != nil || res.Error != nil {
		t.Fatalf("send: %+v %v", res.Error, err)
	}
	if got := lastHeaders().Get("X-Signed"); got != "sig-from-script" {
		t.Errorf("X-Signed = %q", got)
	}
	if !strings.Contains(res.Response.Body, `"query":"q=from-script"`) {
		t.Errorf("body = %s", res.Response.Body)
	}
	found := false
	for _, kv := range res.Hops[0].RequestHeaders {
		found = found || kv.Key == "X-Signed"
	}
	if !found {
		t.Errorf("hop headers = %+v", res.Hops[0].RequestHeaders)
	}
	entry, err := h.hist.Get(res.HistoryID)
	if err != nil || len(entry.Request.Headers) != 0 || entry.Request.URL != srv.URL+"/echo?q={{q}}" {
		t.Errorf("history = %+v %v", entry.Request, err)
	}

	// A script error stops the send and is recorded.
	draft.Scripts.PreRequest = "const a = 1;\nnotDefined();"
	res, err = h.req.Send(ctx, "err", draft, col.ID)
	if err != nil || res.Error == nil || res.Error.Kind != httpexec.KindScript || res.Response != nil {
		t.Fatalf("script error: %+v %v", res, err)
	}
	if res.Error.Message != `Error in the pre-request script of request "Untitled request" at line 2:11: ReferenceError: notDefined is not defined` {
		t.Errorf("message = %q", res.Error.Message)
	}
	if res.HistoryID == 0 {
		t.Error("script error not recorded")
	}

	// A timeout.
	st := h.set.Get()
	st.ScriptTimeoutMs = 1000
	if _, err := h.set.Set(st); err != nil {
		t.Fatal(err)
	}
	draft.Scripts.PreRequest = "while (true) {}"
	res, err = h.req.Send(ctx, "loop", draft, col.ID)
	if err != nil || res.Error == nil || res.Error.Kind != httpexec.KindScript || !strings.HasSuffix(res.Error.Message, "Script took longer than 1 s") {
		t.Fatalf("timeout: %+v %v", res.Error, err)
	}

	// skipRequest: nothing is sent or recorded.
	draft.Scripts.PreRequest = "pm.execution.skipRequest()"
	res, err = h.req.Send(ctx, "skip", draft, col.ID)
	if err != nil || !res.Skipped || res.Error != nil || res.Response != nil || res.HistoryID != 0 {
		t.Fatalf("skip: %+v %v", res, err)
	}

	// A test script error is a failed test, never a failed send.
	draft.Scripts = model.Scripts{Test: "pm.response.json().missing.deep"}
	res, err = h.req.Send(ctx, "test-err", draft, col.ID)
	if err != nil || res.Error != nil || len(res.Tests) != 1 || res.Tests[0].Name != pipeline.ScriptErrorTest || res.Tests[0].Passed {
		t.Fatalf("test error: %+v %v", res, err)
	}

	// Scripts run without a workspace too.
	h.ws.Close()
	res, err = h.req.Send(ctx, "nows", model.Request{URL: srv.URL + "/echo", Scripts: model.Scripts{
		PreRequest: `pm.request.headers.add({key: "X-NoWs", value: "1"})`,
		Test:       `pm.test("ok", () => pm.response.to.have.status(200))`,
	}}, "")
	if err != nil || res.Error != nil || len(res.Tests) != 1 || !res.Tests[0].Passed || lastHeaders().Get("X-NoWs") != "1" {
		t.Fatalf("no workspace: %+v %v", res, err)
	}
}

// TestEndToEndScriptSecretLocked: a script writing a secret while the file
// store is locked fails the send and reports SecretsLocked.
func TestEndToEndScriptSecretLocked(t *testing.T) {
	srv, _ := scriptServer(t)
	store := secrets.NewFileStore(t.TempDir())
	h := newHarnessWith(t, store)
	h.openWorkspace(t)
	if err := h.env.SetMasterPassword("correct horse"); err != nil {
		t.Fatal(err)
	}
	col, err := h.ws.CreateCollection("API")
	if err != nil {
		t.Fatal(err)
	}
	if _, err := h.ws.SaveCollection(col.ID, fsstore.CollectionSettings{
		Variables: []model.Variable{{Key: "refresh", Enabled: true, Secret: true}},
	}, nil); err != nil {
		t.Fatal(err)
	}
	if err := h.env.Lock(); err != nil {
		t.Fatal(err)
	}
	draft := model.Request{URL: srv.URL + "/login", Scripts: model.Scripts{Test: `pm.collectionVariables.set("refresh", pm.response.json().refresh)`}}
	res, err := h.req.Send(context.Background(), "locked", draft, col.ID)
	if err != nil || res.Error != nil || !res.SecretsLocked || len(res.Tests) != 1 || !strings.Contains(res.Tests[0].Error, "The secret store is locked") {
		t.Fatalf("locked: %+v %v", res, err)
	}
}

// TestEndToEndCancelDuringScript: cancelling a send stops its script.
func TestEndToEndCancelDuringScript(t *testing.T) {
	h := newHarness(t)
	done := make(chan SendResult)
	go func() {
		res, _ := h.req.Send(context.Background(), "spin", model.Request{URL: "http://127.0.0.1:1", Scripts: model.Scripts{PreRequest: "while (true) {}"}}, "")
		done <- res
	}()
	waitUntil(t, func() bool { return h.req.Cancel("spin") })
	res := <-done
	if res.Error == nil || res.Error.Kind != httpexec.KindCanceled || res.HistoryID != 0 {
		t.Fatalf("cancel: %+v", res.Error)
	}
}
