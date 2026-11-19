package report

import (
	"bytes"
	"encoding/json"
	"flag"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"pakpos/internal/core/httpexec"
	"pakpos/internal/core/model"
	"pakpos/internal/core/script"
	"pakpos/internal/runner"
)

var update = flag.Bool("update", false, "rewrite the golden files in testdata")

// sample is a finished run with every kind of result.
func sample() runner.Report {
	start := time.Date(2026, 11, 19, 9, 30, 0, 0, time.UTC)
	info := func(id, name, method, url string) runner.RequestInfo {
		return runner.RequestInfo{ID: id, Name: name, Method: method, URL: url,
			Request: model.Request{ID: id, Name: name, Method: method, URL: url}}
	}
	reqs := []runner.RequestInfo{
		info("r1", "Login", "POST", "{{base}}/login"),
		info("r2", "Profile <me>", "GET", "{{base}}/me"),
		info("r3", "Purge", "PURGE", "{{base}}/cache"),
	}
	src := func(id, name string) script.Source {
		return script.Source{Kind: script.LevelRequest, ID: id, Name: name, Event: script.Test}
	}
	at := func(ms int) time.Time { return start.Add(time.Duration(ms) * time.Millisecond) }
	results := []runner.Result{
		{Iteration: 0, Index: 0, RequestID: "r1", Name: "Login", Method: "POST", StartedAt: at(0), Status: 200, StatusText: "OK", DurationMs: 12.4, Size: 512,
			Tests:   []script.TestResult{{Name: "status is 200", Passed: true, Source: src("r1", "Login")}},
			Console: []script.ConsoleEntry{{Level: script.LevelLog, Text: "token [secret:token]", Source: src("r1", "Login")}},
			Response: &runner.SavedResponse{ContentType: "application/json", Headers: []model.KeyValue{{Key: "Content-Type", Value: "application/json", Enabled: true}},
				Body: `{"token":"[secret:token]"}`}},
		{Iteration: 0, Index: 1, RequestID: "r2", Name: "Profile <me>", Method: "GET", StartedAt: at(20), Status: 404, StatusText: "Not Found", DurationMs: 8, Size: 20,
			Tests: []script.TestResult{
				{Name: "is 200", Error: "AssertionError: expected response to have status code 200 but got 404", Source: src("r2", "Profile <me>")},
				{Name: "later", Skipped: true, Source: src("r2", "Profile <me>")},
			},
			Console:  []script.ConsoleEntry{},
			Response: &runner.SavedResponse{ContentType: "image/png", Omitted: runner.OmittedBinary}},
		{Iteration: 0, Index: 2, RequestID: "r3", Name: "Purge", Method: "PURGE", StartedAt: at(40), Skipped: true,
			Tests: []script.TestResult{}, Console: []script.ConsoleEntry{}},
		{Iteration: 1, Index: 0, RequestID: "r1", Name: "Login", Method: "POST", StartedAt: at(1000), Status: 301, StatusText: "Moved Permanently", DurationMs: 1500, Size: 3 << 20,
			Tests: []script.TestResult{}, Console: []script.ConsoleEntry{}, SecretsLocked: true,
			Response: &runner.SavedResponse{Body: strings.Repeat("a", 10), Truncated: true}},
		{Iteration: 1, Index: 1, RequestID: "r2", Name: "Profile <me>", Method: "GET", StartedAt: at(2600),
			Error: &httpexec.Error{Kind: httpexec.KindConnectionRefused, Message: "Couldn't connect to [secret:host]"},
			Tests: []script.TestResult{}, Console: []script.ConsoleEntry{},
			Response: &runner.SavedResponse{Omitted: runner.OmittedLimit}},
	}
	rep := runner.Report{
		ID: "01RUN", WorkspaceID: "ws1",
		Target:        runner.Target{ID: "c1", Kind: "collection", Name: "Users API", Path: []string{"Users API"}},
		EnvironmentID: "e1", EnvironmentName: "Dev", Iterations: 2, DelayMs: 100, DataFile: "users.csv",
		Options:  runner.Options{KeepVariables: true, SaveResponses: true},
		Requests: reqs, StartedAt: start, FinishedAt: at(3000),
		Outcome: runner.OutcomeFailed, Results: results,
	}
	rep.Summary = runner.Summarize(rep)
	return rep
}

func golden(t *testing.T, name string, got []byte) {
	t.Helper()
	path := filepath.Join("testdata", name)
	if *update {
		if err := os.WriteFile(path, got, 0o644); err != nil { //nolint:gosec // test fixture
			t.Fatal(err)
		}
		return
	}
	want, err := os.ReadFile(path) //nolint:gosec // test fixture
	if err != nil {
		t.Fatalf("%v (run go test ./internal/runner/report -update)", err)
	}
	if !bytes.Equal(got, want) {
		t.Errorf("%s differs from the golden file (run with -update after checking):\n%s", name, got)
	}
}

func TestJSON(t *testing.T) {
	got, err := JSON(sample(), "Pakpos test")
	if err != nil {
		t.Fatal(err)
	}
	golden(t, "run.json", got)
	var doc struct {
		Version int `json:"version"`
		Run     struct {
			Outcome string `json:"outcome"`
		} `json:"run"`
	}
	if err := json.Unmarshal(got, &doc); err != nil || doc.Version != Version || doc.Run.Outcome != "failed" {
		t.Errorf("doc = %+v, %v", doc, err)
	}
}

func TestHTML(t *testing.T) {
	got, err := HTML(sample(), "Pakpos test")
	if err != nil {
		t.Fatal(err)
	}
	golden(t, "run.html", got)
	page := string(got)
	for _, want := range []string{"Profile &lt;me&gt;", "Iteration 2", "prefers-color-scheme: dark", "Failures (2)"} {
		if !strings.Contains(page, want) {
			t.Errorf("page lacks %q", want)
		}
	}
	for _, banned := range []string{"<script", "http://", "https://"} {
		if strings.Contains(page, banned) {
			t.Errorf("page has %q", banned)
		}
	}
}

func TestHTMLStates(t *testing.T) {
	for _, tc := range []struct {
		outcome runner.Outcome
		want    string
	}{
		{runner.OutcomePassed, "Passed"},
		{runner.OutcomeStopped, "Stopped at the first failure"},
		{runner.OutcomeCanceled, "Cancelled"},
		{runner.OutcomeError, "Stopped with an error</strong>: loop"},
		{runner.OutcomeRunning, "Running"},
		{"odd", "odd"},
	} {
		rep := runner.Report{Target: runner.Target{Name: "T", Path: []string{"T"}}, Iterations: 1, Outcome: tc.outcome}
		if tc.outcome == runner.OutcomeError {
			rep.Error = "loop"
		}
		rep.Summary = runner.Summarize(rep)
		got, err := HTML(rep, "g")
		if err != nil {
			t.Fatal(err)
		}
		if !strings.Contains(string(got), tc.want) || !strings.Contains(string(got), "No requests ran.") || !strings.Contains(string(got), "No environment") {
			t.Errorf("%s: missing %q", tc.outcome, tc.want)
		}
	}
	// Failures past the cap are counted, not all listed.
	rep := sample()
	rep.Summary.FailuresTotal = 900
	got, _ := HTML(rep, "g")
	if !strings.Contains(string(got), "Showing the first 2 failures.") {
		t.Error("cap note missing")
	}
}

func TestFormatters(t *testing.T) {
	if formatMs(5.25) != "5.2 ms" || formatMs(25) != "25 ms" || formatMs(2500) != "2.50 s" {
		t.Error("ms")
	}
	if formatSize(10) != "10 B" || formatSize(2048) != "2.0 KB" || formatSize(5<<20) != "5.0 MB" {
		t.Error("size")
	}
	if methodClass("PATCH") != "m-patch" || methodClass("HEAD") != "m-other" {
		t.Error("method")
	}
	if statusClass(runner.Result{Status: 503}) != "s-server" || statusClass(runner.Result{Status: 200}) != "s-ok" {
		t.Error("status")
	}
	if testCounts(runner.Result{}) != "–" {
		t.Error("tests")
	}
}
