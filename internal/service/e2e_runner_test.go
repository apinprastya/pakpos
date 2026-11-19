package service

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"pakpos/internal/core/model"
	"pakpos/internal/core/vars"
	"pakpos/internal/pipeline"
	"pakpos/internal/runner"
	"pakpos/internal/runner/report"
	"pakpos/internal/store/fsstore"
	"pakpos/internal/store/sqlite"
)

const runnerAPIKey = "api-key-5f1e2d3c4b"

// runnerServer: POST /login needs the API key and returns a per-user token;
// /me needs that token; /slow waits until the client gives up.
func runnerServer(t *testing.T) *httptest.Server {
	t.Helper()
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		switch r.URL.Path {
		case "/login":
			var body struct{ User, Password string }
			_ = json.NewDecoder(r.Body).Decode(&body)
			if r.Header.Get("X-Api-Key") != runnerAPIKey || body.Password != "pw-"+body.User {
				w.WriteHeader(http.StatusUnauthorized)
				return
			}
			_ = json.NewEncoder(w).Encode(map[string]string{"token": "tok-" + body.User + "-0123456789"})
		case "/me":
			user := strings.TrimSuffix(strings.TrimPrefix(r.Header.Get("Authorization"), "Bearer tok-"), "-0123456789")
			_ = json.NewEncoder(w).Encode(map[string]string{"user": user})
		case "/slow":
			<-r.Context().Done()
		default:
			w.WriteHeader(http.StatusNoContent)
		}
	}))
	t.Cleanup(srv.Close)
	return srv
}

type runnerFixture struct {
	h      *harness
	run    *RunnerService
	col    fsstore.Collection
	dev    fsstore.Environment
	login  model.Request
	me     model.Request
	logout model.Request
	data   string
	info   WorkspaceInfo
}

func newRunnerFixture(t *testing.T) *runnerFixture {
	t.Helper()
	srv := runnerServer(t)
	h := newHarness(t)
	f := &runnerFixture{h: h, run: NewRunnerService(h.core), info: h.openWorkspace(t)}
	var err error
	if f.col, err = h.ws.CreateCollection("API"); err != nil {
		t.Fatal(err)
	}
	if f.col, err = h.ws.SaveCollection(f.col.ID, fsstore.CollectionSettings{
		Headers: []model.KeyValue{{Key: "X-Api-Key", Value: "{{apiKey}}", Enabled: true}},
	}, nil); err != nil {
		t.Fatal(err)
	}
	if f.dev, err = h.env.Create("Dev"); err != nil {
		t.Fatal(err)
	}
	ref := pipeline.ScopeRef{Kind: vars.ScopeEnvironment, ID: f.dev.ID}
	if _, err := h.env.SaveVariables(ref, []model.Variable{
		{Key: "base", Value: srv.URL, Enabled: true},
		{Key: "apiKey", Enabled: true, Secret: true},
		{Key: "token", Enabled: true, Secret: true},
	}, nil); err != nil {
		t.Fatal(err)
	}
	if err := h.env.SetSecret(ref, "apiKey", runnerAPIKey); err != nil {
		t.Fatal(err)
	}
	save := func(name string, req model.Request) model.Request {
		out, err := h.req.SaveAs(f.col.ID, name, req)
		if err != nil {
			t.Fatal(err)
		}
		return out
	}
	f.login = save("Login", model.Request{Method: "POST", URL: "{{base}}/login",
		Body: model.Body{Type: model.BodyRaw, Language: "json", Raw: `{"user": "{{user}}", "password": "{{password}}"}`},
		Scripts: model.Scripts{Test: `
pm.test("logged in", () => pm.response.to.have.status(200));
pm.environment.set("token", pm.response.json().token);
console.log("token", pm.environment.get("token"), "key", pm.environment.get("apiKey"));
`}})
	f.me = save("Me", model.Request{Method: "GET", URL: "{{base}}/me",
		Auth: model.Auth{Type: model.AuthBearer, Token: "{{token}}"},
		Scripts: model.Scripts{Test: `
pm.test("is " + pm.iterationData.get("user"), () => pm.expect(pm.response.json().user).to.equal(pm.iterationData.get("user")));
console.log("iteration", pm.info.iteration, "Bearer " + pm.environment.get("token"));
`}})
	f.logout = save("Logout", model.Request{Method: "DELETE", URL: "{{base}}/logout",
		Auth: model.Auth{Type: model.AuthBearer, Token: "{{token}}"}})
	f.data = filepath.Join(t.TempDir(), "users.csv")
	if err := os.WriteFile(f.data, []byte("user,password\nana,pw-ana\nbo,pw-bo\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	return f
}

func (f *runnerFixture) config() RunConfig {
	return RunConfig{TargetID: f.col.ID, EnvironmentID: f.dev.ID, DataFile: f.data, KeepVariables: true}
}

// progress returns the runner events emitted for a run, in order.
func (f *runnerFixture) progress(runID string) []runner.Event {
	var out []runner.Event
	for _, e := range f.h.events.all() {
		if e.name != EventRunnerProgress {
			continue
		}
		if p := e.data.(RunnerProgressEvent); p.RunID == runID {
			out = append(out, p.Event)
		}
	}
	return out
}

// TestEndToEndRunner runs a login → token (test script) → authenticated
// chain over two CSV rows, then checks the summary, the stored run and that
// neither the database nor the JSON and HTML exports hold a secret value.
func TestEndToEndRunner(t *testing.T) {
	f := newRunnerFixture(t)
	cfg := f.config()
	cfg.SaveResponses = true
	id, err := f.run.Start(cfg)
	if err != nil {
		t.Fatal(err)
	}
	f.run.wait()

	events := f.progress(id)
	if len(events) == 0 || events[0].Kind != runner.EventStarted || events[0].Run.ID != id || events[len(events)-1].Kind != runner.EventFinished {
		t.Fatalf("events = %+v", events)
	}
	last := events[len(events)-1]
	s := last.Summary
	if last.Outcome != runner.OutcomePassed || s.Requests != 6 || s.TestsPassed != 4 || s.TestsFailed != 0 || s.Errors != 0 || s.Iterations != 2 {
		t.Fatalf("finished = %+v, summary %+v", last, s)
	}
	if len(f.run.Active()) != 0 {
		t.Error("run still active")
	}

	list, err := f.run.List()
	if err != nil || len(list) != 1 {
		t.Fatalf("list = %+v, %v", list, err)
	}
	item := list[0]
	if item.ID != id || item.Target.Name != "API" || item.EnvironmentName != "Dev" || item.DataFile != "users.csv" || item.Iterations != 2 ||
		item.Outcome != runner.OutcomePassed || item.Totals.Requests != 6 || item.Totals.TestsPassed != 4 {
		t.Errorf("item = %+v", item)
	}
	rep, err := f.run.Get(id)
	if err != nil {
		t.Fatal(err)
	}
	if len(rep.Results) != 6 || rep.Results[1].Tests[0].Name != "is ana" || rep.Results[4].Tests[0].Name != "is bo" {
		t.Fatalf("results = %+v", rep.Results)
	}
	if got := rep.Results[1].Console[0].Text; got != "iteration 0 Bearer [secret:token]" {
		t.Errorf("console = %q", got)
	}
	if got := rep.Results[0].Console[0].Text; got != "token [secret:token] key [secret:apiKey]" {
		t.Errorf("login console = %q", got)
	}
	if rep.Requests[0].Request.Body.Raw != `{"user": "{{user}}", "password": "{{password}}"}` {
		t.Errorf("request as written = %+v", rep.Requests[0].Request.Body)
	}
	// The login response body was saved, with the token masked.
	if body := rep.Results[3].Response.Body; !strings.Contains(body, "[secret:token]") {
		t.Errorf("saved body = %q", body)
	}

	out := t.TempDir()
	var exported []string
	for _, format := range []string{ExportJSON, ExportHTML} {
		f.h.dialogs.save = filepath.Join(out, "report."+format)
		path, err := f.run.Export(id, format)
		if err != nil || path != f.h.dialogs.save {
			t.Fatalf("export %s = %q, %v", format, path, err)
		}
		if !strings.HasPrefix(f.h.dialogs.lastDefaultName, "API-run-") || !strings.HasSuffix(f.h.dialogs.lastDefaultName, "."+format) {
			t.Errorf("default name = %q", f.h.dialogs.lastDefaultName)
		}
		exported = append(exported, path)
	}
	data, _ := os.ReadFile(exported[0])
	var doc struct {
		Version int           `json:"version"`
		Run     runner.Report `json:"run"`
	}
	if err := json.Unmarshal(data, &doc); err != nil || doc.Version != report.Version || doc.Run.ID != id {
		t.Errorf("json export = %+v, %v", doc.Version, err)
	}
	html, _ := os.ReadFile(exported[1])
	if !bytes.Contains(html, []byte("Iteration 2")) || !bytes.Contains(html, []byte("is bo")) {
		t.Error("html export lacks the results")
	}
	for _, secret := range []string{runnerAPIKey, "tok-ana-0123456789", "tok-bo-0123456789"} {
		assertNoSecret(t, secret, out, f.info.Path)
		if dbHolds(t, f.h.dataDir, secret) {
			t.Errorf("database holds %q", secret)
		}
	}
	// History was off.
	if page, _ := f.h.hist.List(sqlite.HistoryFilter{}); page.Total != 0 {
		t.Errorf("history = %d", page.Total)
	}

	// A second run with history on, a subset and no data file.
	cfg = f.config()
	cfg.DataFile, cfg.Iterations, cfg.RecordHistory = "", 1, true
	cfg.RequestIDs = []string{f.login.ID, f.logout.ID}
	if _, err := f.run.Start(cfg); err != nil {
		t.Fatal(err)
	}
	f.run.wait()
	if page, _ := f.h.hist.List(sqlite.HistoryFilter{}); page.Total != 2 || page.Items[0].RequestName != "Logout" || page.Items[0].EnvironmentName != "Dev" {
		t.Errorf("history = %+v", page)
	}
	if list, _ := f.run.List(); len(list) != 2 || list[0].Totals.Requests != 2 {
		t.Errorf("list = %+v", list)
	}
	if err := f.run.Delete(id); err != nil {
		t.Fatal(err)
	}
	if _, err := f.run.Get(id); err == nil || !strings.Contains(err.Error(), "no longer stored") {
		t.Errorf("get deleted = %v", err)
	}
}

// TestEndToEndRunnerCancel: one run per workspace; Cancel keeps the
// results so far; the stored run says it was cancelled.
func TestEndToEndRunnerCancel(t *testing.T) {
	f := newRunnerFixture(t)
	f.me.URL = "{{base}}/slow"
	if _, err := f.h.req.Save(f.me); err != nil {
		t.Fatal(err)
	}
	id, err := f.run.Start(f.config())
	if err != nil {
		t.Fatal(err)
	}
	if _, err := f.run.Start(f.config()); err == nil || err.Error() != MsgRunActive {
		t.Errorf("second start = %v", err)
	}
	if a := f.run.Active(); len(a) != 1 || a[0].RunID != id || a[0].TargetID != f.col.ID {
		t.Errorf("active = %+v", a)
	}
	waitUntil(t, func() bool {
		ev := f.progress(id)
		return len(ev) > 0 && ev[len(ev)-1].Kind == runner.EventRequestStarted && ev[len(ev)-1].Index == 1
	})
	if !f.run.Cancel(id) {
		t.Fatal("cancel found no run")
	}
	f.run.wait()
	if f.run.Cancel(id) {
		t.Error("cancel after the end")
	}
	rep, err := f.run.Get(id)
	if err != nil {
		t.Fatal(err)
	}
	if rep.Outcome != runner.OutcomeCanceled || len(rep.Results) != 1 || rep.Results[0].Name != "Login" {
		t.Errorf("run = %s %+v", rep.Outcome, rep.Results)
	}
}

func TestRunnerServiceErrors(t *testing.T) {
	h := newHarness(t)
	run := NewRunnerService(h.core)
	if _, err := run.Start(RunConfig{}); !errors.Is(err, ErrNoWorkspace) {
		t.Errorf("start without workspace = %v", err)
	}
	if _, err := run.List(); !errors.Is(err, ErrNoWorkspace) {
		t.Errorf("list without workspace = %v", err)
	}

	f := newRunnerFixture(t)
	cfg := f.config()
	cfg.DataFile = filepath.Join(t.TempDir(), "missing.csv")
	if _, err := f.run.Start(cfg); err == nil || !strings.Contains(err.Error(), `Couldn't read the data file "missing.csv"`) {
		t.Errorf("missing data = %v", err)
	}
	cfg = f.config()
	cfg.Iterations = 3
	if _, err := f.run.Start(cfg); err == nil || !strings.Contains(err.Error(), "has 2 rows, but iterations is 3") {
		t.Errorf("mismatch = %v", err)
	}
	if _, err := f.run.Export("nope", ExportJSON); err == nil || !strings.Contains(err.Error(), "no longer stored") {
		t.Errorf("export missing = %v", err)
	}
	if _, err := f.run.Export("x", "pdf"); err == nil {
		t.Error("pdf accepted")
	}

	p, err := f.run.PreviewData(f.data)
	if err != nil || p.Name != "users.csv" || p.Rows != 2 || len(p.Sample) != 2 || p.Sample[1][0] != "bo" {
		t.Errorf("preview = %+v, %v", p, err)
	}
	if _, err := f.run.PreviewData(filepath.Join(t.TempDir(), "x.json")); err == nil {
		t.Error("missing preview accepted")
	}
	f.h.dialogs.file = f.data
	if got, _ := f.run.PickDataFile(); got != f.data {
		t.Errorf("pick = %q", got)
	}

	// Export: cancelled dialog, dialog error, write failure.
	cfg = f.config()
	cfg.RequestIDs = []string{f.logout.ID}
	id, err := f.run.Start(cfg)
	if err != nil {
		t.Fatal(err)
	}
	f.run.wait()
	f.h.dialogs.save = ""
	if path, err := f.run.Export(id, ExportHTML); path != "" || err != nil {
		t.Errorf("cancelled export = %q, %v", path, err)
	}
	f.h.dialogs.save = t.TempDir() // a directory can't be written as a file
	if _, err := f.run.Export(id, ExportJSON); err == nil || !strings.Contains(err.Error(), "Couldn't save the report") {
		t.Errorf("write failure = %v", err)
	}
	f.h.dialogs.err = errDialog
	if _, err := f.run.Export(id, ExportJSON); !errors.Is(err, errDialog) {
		t.Errorf("dialog error = %v", err)
	}
	// A run stored with a broken summary or report.
	if err := f.h.core.db.AddRun(sqlite.RunRecord{RunSummary: sqlite.RunSummary{ID: "bad", WorkspaceID: f.info.ID, Summary: json.RawMessage(`[]`)}, Run: json.RawMessage(`[]`)}, 0); err != nil {
		t.Fatal(err)
	}
	if list, err := f.run.List(); err != nil || len(list) != 2 {
		t.Errorf("list with a bad row = %d, %v", len(list), err)
	}
	if _, err := f.run.Get("bad"); err == nil {
		t.Error("bad report decoded")
	}
	// Storing fails quietly (logged) when the database is closed.
	_ = f.h.core.db.Close()
	f.run.store(runner.Report{ID: "x", WorkspaceID: "w"})
	if _, err := f.run.Get("x"); err == nil || errors.Is(err, sqlite.ErrNotFound) {
		t.Errorf("get on a closed db = %v", err)
	}
	if _, err := f.run.List(); err == nil {
		t.Error("list on a closed db")
	}
	if _, err := f.run.Start(f.config()); err != nil {
		t.Logf("start on a closed db: %v", err)
	}
	f.run.wait()
}

func TestRunnerDelayAndExportName(t *testing.T) {
	f := newRunnerFixture(t)
	var mu sync.Mutex
	var waits []time.Duration
	f.run.sleep = func(_ context.Context, d time.Duration) error {
		mu.Lock()
		waits = append(waits, d)
		mu.Unlock()
		return nil
	}
	cfg := f.config()
	cfg.DelayMs = 1500
	if _, err := f.run.Start(cfg); err != nil {
		t.Fatal(err)
	}
	f.run.wait()
	if len(waits) != 5 || waits[0] != 1500*time.Millisecond {
		t.Errorf("waits = %v", waits)
	}
	at := time.Date(2026, 11, 19, 9, 30, 5, 0, time.Local)
	for name, want := range map[string]string{
		"My API: v2/beta": "My-API-v2beta-run-20261119-093005.json",
		"  ":              "collection-run-20261119-093005.json",
	} {
		if got := exportName(runner.Report{Target: runner.Target{Name: name}, StartedAt: at}, "json"); got != want {
			t.Errorf("exportName(%q) = %q", name, got)
		}
	}
}
