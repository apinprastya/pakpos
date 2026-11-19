package runner

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"sync"
	"testing"
	"time"

	"pakpos/internal/core/httpexec"
	"pakpos/internal/core/model"
	"pakpos/internal/pipeline"
	"pakpos/internal/secrets"
	"pakpos/internal/store/fsstore"
)

func must[T any](v T, err error) T {
	if err != nil {
		panic(err)
	}
	return v
}

const apiKey = "key-0123456789"

type fixture struct {
	ws      *fsstore.Workspace
	sec     *secrets.Fake
	overlay *pipeline.Overlay
	srv     *httptest.Server
	col     fsstore.Collection
	folder  fsstore.Folder
	env     fsstore.Environment
	login   model.Request
	list    model.Request
	get     model.Request
	logout  model.Request

	mu   sync.Mutex
	hits []string
}

// newFixture: collection "API" with Login, folder Users (List, Get), Logout.
func newFixture(t *testing.T) *fixture {
	t.Helper()
	f := &fixture{sec: secrets.NewFake(), overlay: pipeline.NewOverlay()}
	f.srv = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		f.mu.Lock()
		f.hits = append(f.hits, r.URL.Path+"?"+r.URL.RawQuery)
		f.mu.Unlock()
		switch r.URL.Path {
		case "/slow":
			select {
			case <-r.Context().Done():
			case <-time.After(5 * time.Second):
			}
			return
		case "/binary":
			w.Header().Set("Content-Type", "image/png")
			_, _ = w.Write([]byte{0x89, 'P', 'N', 'G', 0, 1, 2, 0xff})
			return
		case "/big":
			w.Header().Set("Content-Type", "text/plain")
			_, _ = w.Write([]byte(strings.Repeat("é", MaxSavedBody)))
			return
		}
		w.Header().Set("Content-Type", "application/json")
		w.Header().Set("X-Echo", r.Header.Get("X-Api-Key"))
		_ = json.NewEncoder(w).Encode(map[string]string{"path": r.URL.Path, "user": r.URL.Query().Get("user"), "key": r.Header.Get("X-Api-Key")})
	}))
	t.Cleanup(f.srv.Close)
	ws := must(fsstore.Create(t.TempDir(), "WS"))
	f.ws = ws
	f.col = must(ws.CreateCollection("API"))
	f.col = must(ws.SaveCollection(f.col.ID, fsstore.CollectionSettings{
		Headers:   []model.KeyValue{{Key: "X-Api-Key", Value: "{{apiKey}}", Enabled: true}},
		Variables: []model.Variable{{Key: "base", Value: f.srv.URL, Enabled: true}},
	}))
	f.login = must(ws.CreateRequest(f.col.ID, model.Request{Name: "Login", Method: "post", URL: "{{base}}/login/{{user}}"}))
	f.folder = must(ws.CreateFolder(f.col.ID, "Users"))
	f.list = must(ws.CreateRequest(f.folder.ID, model.Request{Name: "List", Method: "GET", URL: "{{base}}/users"}))
	f.get = must(ws.CreateRequest(f.folder.ID, model.Request{Name: "Get", URL: "{{base}}/users/1"}))
	f.logout = must(ws.CreateRequest(f.col.ID, model.Request{Name: "Logout", Method: "DELETE", URL: "{{base}}/logout"}))
	f.env = must(ws.CreateEnvironment("Dev"))
	f.env = must(ws.SaveEnvironmentVariables(f.env.ID, []model.Variable{
		{Key: "apiKey", Enabled: true, Secret: true}, {Key: "mode", Value: "file", Enabled: true},
	}))
	_ = f.sec.Set(secrets.Key(ws.Manifest().ID, f.env.ID, "apiKey"), apiKey)
	return f
}

func (f *fixture) session() *pipeline.Session {
	return pipeline.New(f.ws, f.sec, nil).WithOverlay(f.overlay)
}

func (f *fixture) script(req *model.Request, s model.Scripts) {
	req.Scripts = s
	*req = must(f.ws.SaveRequest(*req))
}

func (f *fixture) config() Config {
	return Config{
		Session: f.session(), Executor: httpexec.New(httpexec.DefaultSettings()),
		TargetID: f.col.ID, EnvironmentID: f.env.ID,
		Options: Options{KeepVariables: true},
		Sleep:   func(context.Context, time.Duration) error { return nil },
	}
}

type recorder struct {
	mu     sync.Mutex
	events []Event
}

func (r *recorder) Event(e Event) {
	r.mu.Lock()
	r.events = append(r.events, e)
	r.mu.Unlock()
}

func (r *recorder) kinds() []EventKind {
	out := []EventKind{}
	for _, e := range r.events {
		out = append(out, e.Kind)
	}
	return out
}

func names(rep Report) []string {
	out := []string{}
	for _, r := range rep.Results {
		out = append(out, fmt.Sprintf("%d:%s", r.Iteration, r.Name))
	}
	return out
}

func TestRunScenarios(t *testing.T) {
	cases := []struct {
		name    string
		setup   func(f *fixture, c *Config)
		want    []string
		outcome Outcome
		check   func(t *testing.T, f *fixture, rep Report)
	}{
		{
			name:    "tree order",
			want:    []string{"0:Login", "0:List", "0:Get", "0:Logout"},
			outcome: OutcomePassed,
			check: func(t *testing.T, f *fixture, rep Report) {
				if rep.Target.Kind != "collection" || !reflect.DeepEqual(rep.Target.Path, []string{"API"}) {
					t.Errorf("target = %+v", rep.Target)
				}
				if rep.Requests[0].Method != "POST" || rep.Requests[2].Method != "GET" {
					t.Errorf("methods = %+v", rep.Requests)
				}
				if rep.Results[0].Status != 200 || rep.Results[0].Size == 0 || rep.EnvironmentName != "Dev" {
					t.Errorf("result = %+v", rep.Results[0])
				}
				if rep.Summary.Requests != 4 || rep.Summary.Iterations != 1 {
					t.Errorf("summary = %+v", rep.Summary)
				}
			},
		},
		{
			name:    "folder target and subset",
			setup:   func(f *fixture, c *Config) { c.TargetID, c.RequestIDs = f.folder.ID, []string{f.get.ID, "gone"} },
			want:    []string{"0:Get"},
			outcome: OutcomePassed,
			check: func(t *testing.T, f *fixture, rep Report) {
				if !reflect.DeepEqual(rep.Target.Path, []string{"API", "Users"}) || rep.Target.Kind != "folder" {
					t.Errorf("target = %+v", rep.Target)
				}
			},
		},
		{
			name:    "iterations",
			setup:   func(f *fixture, c *Config) { c.TargetID, c.Iterations = f.folder.ID, 2 },
			want:    []string{"0:List", "0:Get", "1:List", "1:Get"},
			outcome: OutcomePassed,
		},
		{
			name: "data rows",
			setup: func(f *fixture, c *Config) {
				c.RequestIDs = []string{f.login.ID, f.list.ID}
				c.Data = &Data{Name: "users.csv", Columns: []string{"user", "mode"}, Rows: []map[string]string{
					{"user": "ana", "mode": "data"}, {"user": "bo", "mode": "data"},
				}}
				f.script(&f.login, model.Scripts{PreRequest: `console.log(pm.iterationData.get("user"), pm.info.iteration, pm.info.iterationCount, pm.variables.get("mode")); pm.variables.set("seen", pm.iterationData.get("user"))`})
				f.script(&f.list, model.Scripts{PreRequest: `console.log("list sees", pm.variables.get("seen"))`})
			},
			want:    []string{"0:Login", "0:List", "1:Login", "1:List"},
			outcome: OutcomePassed,
			check: func(t *testing.T, f *fixture, rep Report) {
				if rep.DataFile != "users.csv" || rep.Iterations != 2 {
					t.Errorf("run = %+v", rep)
				}
				got := []string{rep.Results[0].Console[0].Text, rep.Results[1].Console[0].Text, rep.Results[2].Console[0].Text}
				want := []string{"ana 0 2 data", "list sees ana", "bo 1 2 data"}
				if !reflect.DeepEqual(got, want) {
					t.Errorf("console = %q", got)
				}
				if !strings.Contains(f.hits[0], "/login/ana") || !strings.Contains(f.hits[2], "/login/bo") {
					t.Errorf("hits = %v", f.hits)
				}
			},
		},
		{
			name: "local scope is fresh per iteration",
			setup: func(f *fixture, c *Config) {
				c.Iterations, c.RequestIDs = 2, []string{f.login.ID, f.list.ID}
				f.script(&f.login, model.Scripts{PreRequest: `console.log("before", pm.variables.has("x")); pm.variables.set("x", "1")`})
			},
			want:    []string{"0:Login", "0:List", "1:Login", "1:List"},
			outcome: OutcomePassed,
			check: func(t *testing.T, f *fixture, rep Report) {
				if rep.Results[2].Console[0].Text != "before false" {
					t.Errorf("console = %+v", rep.Results[2].Console)
				}
			},
		},
		{
			name: "setNextRequest jumps by name and id",
			setup: func(f *fixture, c *Config) {
				f.script(&f.login, model.Scripts{Test: `pm.execution.setNextRequest("Logout")`})
				f.script(&f.logout, model.Scripts{PreRequest: fmt.Sprintf(`if (pm.info.iteration === 0 && !pm.variables.get("back")) { pm.variables.set("back", "1"); pm.execution.setNextRequest(%q) }`, f.get.ID)})
			},
			want:    []string{"0:Login", "0:Logout", "0:Get", "0:Logout"},
			outcome: OutcomePassed,
		},
		{
			name: "setNextRequest null ends the iteration",
			setup: func(f *fixture, c *Config) {
				c.Iterations = 2
				f.script(&f.login, model.Scripts{PreRequest: `postman.setNextRequest(null)`})
			},
			want:    []string{"0:Login", "1:Login"},
			outcome: OutcomePassed,
			check: func(t *testing.T, f *fixture, rep Report) {
				if rep.Summary.Iterations != 2 {
					t.Errorf("iterations = %d", rep.Summary.Iterations)
				}
			},
		},
		{
			name: "loop guard",
			setup: func(f *fixture, c *Config) {
				c.RequestIDs = []string{f.list.ID}
				f.script(&f.list, model.Scripts{PreRequest: `pm.execution.skipRequest(); pm.execution.setNextRequest("List")`})
			},
			outcome: OutcomeError,
			check: func(t *testing.T, f *fixture, rep Report) {
				if len(rep.Results) != MaxJumps+1 || !strings.Contains(rep.Error, "more than 1000 times") {
					t.Errorf("results %d, error %q", len(rep.Results), rep.Error)
				}
				if rep.Summary.Skipped != MaxJumps+1 || len(f.hits) != 0 {
					t.Errorf("summary = %+v hits %d", rep.Summary, len(f.hits))
				}
			},
		},
		{
			name: "unknown setNextRequest target",
			setup: func(f *fixture, c *Config) {
				f.script(&f.login, model.Scripts{Test: `pm.execution.setNextRequest("Nope")`})
			},
			want:    []string{"0:Login"},
			outcome: OutcomeError,
			check: func(t *testing.T, f *fixture, rep Report) {
				if !strings.Contains(rep.Error, `setNextRequest("Nope")`) {
					t.Errorf("error = %q", rep.Error)
				}
			},
		},
		{
			name: "skipRequest",
			setup: func(f *fixture, c *Config) {
				f.script(&f.list, model.Scripts{PreRequest: `pm.execution.skipRequest()`})
			},
			want:    []string{"0:Login", "0:List", "0:Get", "0:Logout"},
			outcome: OutcomePassed,
			check: func(t *testing.T, f *fixture, rep Report) {
				if !rep.Results[1].Skipped || rep.Summary.Skipped != 1 || rep.Summary.PerRequest[1].Skipped != 1 {
					t.Errorf("skip = %+v", rep.Summary)
				}
				for _, h := range f.hits {
					if strings.HasPrefix(h, "/users?") {
						t.Errorf("skipped request was sent: %v", f.hits)
					}
				}
			},
		},
		{
			name: "stop on first failed test",
			setup: func(f *fixture, c *Config) {
				c.Options.StopOnFailure, c.Iterations = true, 3
				f.script(&f.list, model.Scripts{Test: `pm.test("is 201", () => pm.response.to.have.status(201))`})
			},
			want:    []string{"0:Login", "0:List"},
			outcome: OutcomeStopped,
			check: func(t *testing.T, f *fixture, rep Report) {
				s := rep.Summary
				if s.TestsFailed != 1 || len(s.Failures) != 1 || s.Failures[0].Test != "is 201" || !strings.Contains(s.Failures[0].Message, "status code 201") {
					t.Errorf("summary = %+v", s)
				}
			},
		},
		{
			name: "failures without stopping",
			setup: func(f *fixture, c *Config) {
				c.RequestIDs = []string{f.list.ID, f.get.ID}
				f.script(&f.list, model.Scripts{Test: `pm.test("is 201", () => pm.response.to.have.status(201)); pm.test("ok", () => {}); pm.test("later")`})
				f.get.URL = "http://127.0.0.1:1/unreachable"
				f.get = must(f.ws.SaveRequest(f.get))
			},
			want:    []string{"0:List", "0:Get"},
			outcome: OutcomeFailed,
			check: func(t *testing.T, f *fixture, rep Report) {
				s := rep.Summary
				if s.TestsFailed != 1 || s.TestsPassed != 1 || s.TestsSkipped != 1 || s.Errors != 1 || s.FailuresTotal != 2 {
					t.Errorf("summary = %+v", s)
				}
				if rep.Results[1].Error == nil || rep.Results[1].Error.Kind != httpexec.KindConnectionRefused {
					t.Errorf("error = %+v", rep.Results[1].Error)
				}
			},
		},
		{
			name: "stop on request error",
			setup: func(f *fixture, c *Config) {
				c.Options.StopOnFailure = true
				f.script(&f.login, model.Scripts{PreRequest: `throw new Error("no " + pm.environment.get("apiKey"))`})
			},
			want:    []string{"0:Login"},
			outcome: OutcomeStopped,
			check: func(t *testing.T, f *fixture, rep Report) {
				e := rep.Results[0].Error
				if e == nil || e.Kind != httpexec.KindScript || strings.Contains(e.Message, apiKey) || !strings.Contains(e.Message, "[secret:apiKey]") {
					t.Errorf("error = %+v", e)
				}
			},
		},
		{
			name: "variable error",
			setup: func(f *fixture, c *Config) {
				c.RequestIDs = []string{f.list.ID}
				f.script(&f.list, model.Scripts{PreRequest: `pm.variables.set("a", "{{b}}"); pm.variables.set("b", "{{a}}"); pm.request.url = "{{a}}"`})
			},
			want:    []string{"0:List"},
			outcome: OutcomeFailed,
			check: func(t *testing.T, f *fixture, rep Report) {
				if e := rep.Results[0].Error; e == nil || e.Kind != httpexec.KindVariables {
					t.Errorf("error = %+v", e)
				}
			},
		},
		{
			name: "secrets are masked",
			setup: func(f *fixture, c *Config) {
				c.RequestIDs = []string{f.list.ID}
				c.Options.SaveResponses = true
				f.script(&f.list, model.Scripts{Test: `console.log("key", pm.environment.get("apiKey")); pm.test("has " + pm.response.json().key, () => { throw new Error(pm.response.json().key) })`})
			},
			want:    []string{"0:List"},
			outcome: OutcomeFailed,
			check: func(t *testing.T, f *fixture, rep Report) {
				b := must(json.Marshal(rep))
				if strings.Contains(string(b), apiKey) {
					t.Errorf("secret leaked: %s", b)
				}
				res := rep.Results[0]
				if res.Console[0].Text != "key [secret:apiKey]" || res.Response == nil || !strings.Contains(res.Response.Body, "[secret:apiKey]") {
					t.Errorf("result = %+v", res)
				}
				if !reflect.DeepEqual(headerValue(res.Response.Headers, "X-Echo"), "[secret:apiKey]") {
					t.Errorf("headers = %+v", res.Response.Headers)
				}
			},
		},
		{
			name: "keep variable values",
			setup: func(f *fixture, c *Config) {
				c.RequestIDs = []string{f.login.ID}
				f.script(&f.login, model.Scripts{Test: `pm.environment.set("mode", "script")`})
			},
			want:    []string{"0:Login"},
			outcome: OutcomePassed,
			check: func(t *testing.T, f *fixture, rep Report) {
				vals := must(f.session().OverlayValues(pipeline.ScopeRef{Kind: "environment", ID: f.env.ID}))
				if len(vals) != 1 || vals[0].Value != "script" {
					t.Errorf("overlay = %+v", vals)
				}
			},
		},
		{
			name: "private variable values",
			setup: func(f *fixture, c *Config) {
				c.Options.KeepVariables = false
				c.RequestIDs = []string{f.login.ID, f.list.ID}
				f.script(&f.login, model.Scripts{Test: `pm.environment.set("mode", "script")`})
				f.script(&f.list, model.Scripts{PreRequest: `console.log(pm.environment.get("mode"))`})
			},
			want:    []string{"0:Login", "0:List"},
			outcome: OutcomePassed,
			check: func(t *testing.T, f *fixture, rep Report) {
				if rep.Results[1].Console[0].Text != "script" {
					t.Errorf("console = %+v", rep.Results[1].Console)
				}
				if vals := must(f.session().OverlayValues(pipeline.ScopeRef{Kind: "environment", ID: f.env.ID})); len(vals) != 0 {
					t.Errorf("overlay = %+v", vals)
				}
			},
		},
		{
			name: "saved responses: binary, cut, limit",
			setup: func(f *fixture, c *Config) {
				c.Options.SaveResponses = true
				c.RequestIDs = []string{f.list.ID, f.get.ID}
				c.Iterations = 40
				f.list.URL = "{{base}}/binary"
				f.list = must(f.ws.SaveRequest(f.list))
				f.get.URL = "{{base}}/big"
				f.get = must(f.ws.SaveRequest(f.get))
			},
			outcome: OutcomePassed,
			check: func(t *testing.T, f *fixture, rep Report) {
				if r := rep.Results[0].Response; r.Omitted != OmittedBinary || r.Body != "" {
					t.Errorf("binary = %+v", r)
				}
				big := rep.Results[1].Response
				if !big.Truncated || len(big.Body) > MaxSavedBody || !strings.HasSuffix(big.Body, "é") {
					t.Errorf("big = %d bytes, truncated %v", len(big.Body), big.Truncated)
				}
				if last := rep.Results[len(rep.Results)-1].Response; last.Omitted != OmittedLimit {
					t.Errorf("last = %+v", last.Omitted)
				}
			},
		},
		{
			name:  "deleted environment means none",
			setup: func(f *fixture, c *Config) { c.EnvironmentID, c.RequestIDs = "gone", []string{f.list.ID} },
			want:  []string{"0:List"},
			check: func(t *testing.T, f *fixture, rep Report) {
				if rep.EnvironmentID != "" || rep.EnvironmentName != "" {
					t.Errorf("env = %q %q", rep.EnvironmentID, rep.EnvironmentName)
				}
			},
			outcome: OutcomePassed,
		},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			f := newFixture(t)
			cfg := f.config()
			if tc.setup != nil {
				tc.setup(f, &cfg)
			}
			rec := &recorder{}
			rep, err := Run(context.Background(), cfg, rec)
			if err != nil {
				t.Fatal(err)
			}
			if tc.want != nil && !reflect.DeepEqual(names(rep), tc.want) {
				t.Errorf("results = %v, want %v", names(rep), tc.want)
			}
			if rep.Outcome != tc.outcome {
				t.Errorf("outcome = %q (%s), want %q", rep.Outcome, rep.Error, tc.outcome)
			}
			if k := rec.kinds(); k[0] != EventStarted || k[len(k)-1] != EventFinished {
				t.Errorf("events = %v", k)
			}
			if tc.check != nil {
				tc.check(t, f, rep)
			}
		})
	}
}

func headerValue(h []model.KeyValue, key string) string {
	for _, kv := range h {
		if strings.EqualFold(kv.Key, key) {
			return kv.Value
		}
	}
	return ""
}

func TestEvents(t *testing.T) {
	f := newFixture(t)
	cfg := f.config()
	cfg.TargetID, cfg.Iterations = f.folder.ID, 2
	rec := &recorder{}
	rep := must(Run(context.Background(), cfg, rec))
	want := []EventKind{EventStarted,
		EventRequestStarted, EventRequestFinished, EventRequestStarted, EventRequestFinished, EventIterationFinished,
		EventRequestStarted, EventRequestFinished, EventRequestStarted, EventRequestFinished, EventIterationFinished,
		EventFinished}
	if !reflect.DeepEqual(rec.kinds(), want) {
		t.Fatalf("events = %v", rec.kinds())
	}
	start := rec.events[0].Run
	if start == nil || len(start.Requests) != 2 || len(start.Results) != 0 || start.Outcome != OutcomeRunning {
		t.Errorf("started = %+v", start)
	}
	if e := rec.events[9]; e.Iteration != 1 || e.Index != 1 || e.Result == nil || e.Result.Name != "Get" {
		t.Errorf("request finished = %+v", e)
	}
	last := rec.events[len(rec.events)-1]
	if last.Outcome != OutcomePassed || last.Summary == nil || last.Summary.Requests != 4 || !reflect.DeepEqual(*last.Summary, rep.Summary) {
		t.Errorf("finished = %+v", last)
	}
	// A nil sink is fine.
	if _, err := Run(context.Background(), cfg, nil); err != nil {
		t.Fatal(err)
	}
}

func TestDelay(t *testing.T) {
	f := newFixture(t)
	cfg := f.config()
	cfg.DelayMs, cfg.Iterations, cfg.TargetID = 250, 2, f.folder.ID
	var waits []time.Duration
	cfg.Sleep = func(_ context.Context, d time.Duration) error {
		waits = append(waits, d)
		return nil
	}
	must(Run(context.Background(), cfg, nil))
	if len(waits) != 3 || waits[0] != 250*time.Millisecond {
		t.Errorf("waits = %v", waits)
	}
	// The real sleeper waits, and stops early on cancel.
	ctx, cancel := context.WithCancel(context.Background())
	if err := sleep(ctx, time.Millisecond); err != nil {
		t.Fatal(err)
	}
	cancel()
	if err := sleep(ctx, time.Hour); !errors.Is(err, context.Canceled) {
		t.Errorf("err = %v", err)
	}
}

func TestCancel(t *testing.T) {
	t.Run("between requests", func(t *testing.T) {
		f := newFixture(t)
		cfg := f.config()
		ctx, cancel := context.WithCancel(context.Background())
		defer cancel()
		n := 0
		rep := must(Run(ctx, cfg, SinkFunc(func(e Event) {
			if e.Kind == EventRequestFinished {
				if n++; n == 2 {
					cancel()
				}
			}
		})))
		if rep.Outcome != OutcomeCanceled || len(rep.Results) != 2 || rep.Summary.Requests != 2 {
			t.Errorf("outcome %q results %v", rep.Outcome, names(rep))
		}
	})
	t.Run("during the delay", func(t *testing.T) {
		f := newFixture(t)
		cfg := f.config()
		cfg.DelayMs = 10
		ctx, cancel := context.WithCancel(context.Background())
		cfg.Sleep = func(context.Context, time.Duration) error { cancel(); return context.Canceled }
		rep := must(Run(ctx, cfg, nil))
		if rep.Outcome != OutcomeCanceled || len(rep.Results) != 1 {
			t.Errorf("outcome %q results %v", rep.Outcome, names(rep))
		}
	})
	t.Run("within a request", func(t *testing.T) {
		f := newFixture(t)
		f.list.URL = "{{base}}/slow"
		f.list = must(f.ws.SaveRequest(f.list))
		cfg := f.config()
		ctx, cancel := context.WithCancel(context.Background())
		rep := must(Run(ctx, cfg, SinkFunc(func(e Event) {
			if e.Kind == EventRequestStarted && e.Index == 1 {
				go func() { time.Sleep(50 * time.Millisecond); cancel() }()
			}
		})))
		if rep.Outcome != OutcomeCanceled || !reflect.DeepEqual(names(rep), []string{"0:Login"}) {
			t.Errorf("outcome %q results %v", rep.Outcome, names(rep))
		}
	})
	t.Run("within a script", func(t *testing.T) {
		f := newFixture(t)
		f.script(&f.list, model.Scripts{PreRequest: `while (true) {}`})
		cfg := f.config()
		ctx, cancel := context.WithCancel(context.Background())
		rep := must(Run(ctx, cfg, SinkFunc(func(e Event) {
			if e.Kind == EventRequestStarted && e.Index == 1 {
				go func() { time.Sleep(50 * time.Millisecond); cancel() }()
			}
		})))
		if rep.Outcome != OutcomeCanceled || len(rep.Results) != 1 {
			t.Errorf("outcome %q results %v", rep.Outcome, names(rep))
		}
	})
	t.Run("within a test script", func(t *testing.T) {
		f := newFixture(t)
		f.script(&f.list, model.Scripts{Test: `while (true) {}`})
		cfg := f.config()
		ctx, cancel := context.WithCancel(context.Background())
		rep := must(Run(ctx, cfg, SinkFunc(func(e Event) {
			if e.Kind == EventRequestStarted && e.Index == 1 {
				go func() { time.Sleep(100 * time.Millisecond); cancel() }()
			}
		})))
		if rep.Outcome != OutcomeCanceled || len(rep.Results) != 1 {
			t.Errorf("outcome %q results %v", rep.Outcome, names(rep))
		}
	})
}

func TestHistory(t *testing.T) {
	for _, on := range []bool{false, true} {
		t.Run(fmt.Sprint(on), func(t *testing.T) {
			f := newFixture(t)
			cfg := f.config()
			cfg.Options.RecordHistory = on
			f.script(&f.get, model.Scripts{PreRequest: `pm.execution.skipRequest()`})
			f.script(&f.logout, model.Scripts{PreRequest: `throw new Error("x")`})
			var got []HistoryRecord
			cfg.Record = func(r HistoryRecord) { got = append(got, r) }
			must(Run(context.Background(), cfg, nil))
			if !on {
				if len(got) != 0 {
					t.Errorf("recorded %d", len(got))
				}
				return
			}
			// Skipped requests aren't recorded; a script error is.
			if len(got) != 3 || got[0].Request.URL != "{{base}}/login/{{user}}" || got[0].Response == nil || got[0].EnvironmentName != "Dev" {
				t.Fatalf("records = %+v", got)
			}
			if got[2].Error == nil || got[2].Error.Kind != httpexec.KindScript || got[2].Response != nil {
				t.Errorf("error record = %+v", got[2])
			}
		})
	}
}

func TestSpilledBodies(t *testing.T) {
	f := newFixture(t)
	dir := t.TempDir()
	set := httpexec.DefaultSettings()
	set.TempDir, set.MaxBodyInMemory = dir, 16
	cfg := f.config()
	cfg.Executor = httpexec.New(set)
	cfg.RequestIDs = []string{f.list.ID}
	f.script(&f.list, model.Scripts{Test: `pm.test("full body", () => pm.expect(pm.response.json().path).to.equal("/users"))`})
	rep := must(Run(context.Background(), cfg, nil))
	if rep.Summary.TestsPassed != 1 {
		t.Errorf("summary = %+v", rep.Summary)
	}
	if left, _ := os.ReadDir(dir); len(left) != 0 {
		t.Errorf("spilled bodies left: %v", left)
	}
	// With history on, the recorder gets the file.
	cfg.Options.RecordHistory = true
	var paths []string
	cfg.Record = func(r HistoryRecord) { paths = append(paths, r.Response.BodyPath) }
	must(Run(context.Background(), cfg, nil))
	if len(paths) != 1 || filepath.Dir(paths[0]) != dir {
		t.Errorf("paths = %v", paths)
	}
}

func TestConfigErrors(t *testing.T) {
	cases := []struct {
		name  string
		setup func(f *fixture, c *Config)
		want  string
	}{
		{"delay", func(f *fixture, c *Config) { c.DelayMs = MaxDelayMs + 1 }, "delay must be between 0 and 60000"},
		{"negative delay", func(f *fixture, c *Config) { c.DelayMs = -1 }, "delay"},
		{"iterations", func(f *fixture, c *Config) { c.Iterations = MaxIterations + 1 }, "Iterations must be between 1 and 10000"},
		{"no rows", func(f *fixture, c *Config) { c.Data = &Data{Name: "d.csv"} }, `"d.csv" has no rows`},
		{"mismatch", func(f *fixture, c *Config) {
			c.Iterations, c.Data = 3, &Data{Name: "d.csv", Rows: []map[string]string{{}, {}}}
		}, `has 2 rows, but iterations is 3`},
		{"target gone", func(f *fixture, c *Config) { c.TargetID = "gone" }, "no longer exists"},
		{"no target", func(f *fixture, c *Config) { c.TargetID = "" }, "no longer exists"},
		{"no requests", func(f *fixture, c *Config) { c.RequestIDs = []string{"gone"} }, `no requests to run in collection "API"`},
		{"empty folder", func(f *fixture, c *Config) {
			c.TargetID = must(f.ws.CreateFolder(f.col.ID, "Empty")).ID
		}, `folder "Empty"`},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			f := newFixture(t)
			cfg := f.config()
			tc.setup(f, &cfg)
			_, err := Run(context.Background(), cfg, nil)
			var ce *ConfigError
			if !errors.As(err, &ce) || !strings.Contains(err.Error(), tc.want) {
				t.Errorf("err = %v, want %q", err, tc.want)
			}
		})
	}
	if _, err := New(Config{}); err == nil {
		t.Error("missing session accepted")
	}
}

func TestBrokenRequestFile(t *testing.T) {
	f := newFixture(t)
	cfg := f.config()
	// A request whose file disappears after the tree loaded can't be read.
	path := filepath.Join(f.ws.Root(), "collections", "api", "logout.yaml")
	if err := os.Remove(path); err != nil {
		t.Skip("layout differs:", err)
	}
	if _, err := New(cfg); err == nil || !strings.Contains(err.Error(), `Couldn't read the request "Logout"`) {
		t.Errorf("err = %v", err)
	}
}

func TestInfo(t *testing.T) {
	f := newFixture(t)
	r := must(New(f.config()))
	if info := r.Info(); info.WorkspaceID != f.ws.Manifest().ID || len(info.Requests) != 4 || info.Iterations != 1 {
		t.Errorf("info = %+v", info)
	}
	_ = io.Discard
}
