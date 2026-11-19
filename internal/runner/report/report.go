// Package report renders a runner.Report for export: JSON with a stable,
// versioned schema, and a standalone HTML page (no scripts, no external
// assets). It has no Wails dependency, so the headless CLI can reuse it.
//
// Everything rendered comes from the report, which is already masked
// ([secret:name]) and holds requests as written ({{vars}} unresolved).
package report

import (
	"bytes"
	_ "embed"
	"encoding/json"
	"fmt"
	"html/template"
	"strings"
	"time"

	"pakpos/internal/runner"
)

// Version is the JSON schema version. Bump it on any change that isn't
// purely additive.
//
// Schema (version 1):
//
//	{
//	  "version": 1,
//	  "generator": "Pakpos <version>",
//	  "run": {
//	    "id", "workspaceId",
//	    "target": {"id", "kind": "collection"|"folder", "name", "path": [names]},
//	    "environmentId", "environmentName", "iterations", "delayMs",
//	    "dataFile": base name only,
//	    "options": {"stopOnFailure", "keepVariables", "saveResponses", "recordHistory"},
//	    "requests": [{"id", "name", "method", "url", "request": the request as written}],
//	    "startedAt", "finishedAt" (RFC 3339),
//	    "outcome": "passed"|"failed"|"stopped"|"canceled"|"error", "error",
//	    "results": [{"iteration" (0-based), "index" (into requests), "requestId", "name",
//	      "method", "startedAt", "status", "statusText", "durationMs", "size",
//	      "tests": [{"name", "passed", "skipped", "error", "source"}],
//	      "console": [{"level", "text", "source"}],
//	      "error": {"kind", "message"} | null, "skipped", "secretsLocked",
//	      "response": {"contentType", "headers", "body", "truncated", "omitted"} (only when saved)}],
//	    "summary": {"iterations", "requests", "errors", "skipped", "testsPassed",
//	      "testsFailed", "testsSkipped", "durationMs", "avgResponseMs",
//	      "perRequest": [{"requestId", "name", "method", "runs", "errors", "skipped",
//	        "testsPassed", "testsFailed", "avgMs", "minMs", "maxMs"}],
//	      "failures": [{"iteration", "requestId", "name", "test", "message"}],
//	      "failuresTotal", "secretsLocked"}
//	  }
//	}
const Version = 1

type document struct {
	Version   int           `json:"version"`
	Generator string        `json:"generator"`
	Run       runner.Report `json:"run"`
}

// JSON renders the report as indented JSON. generator names the app
// ("Pakpos 26.11.1").
func JSON(r runner.Report, generator string) ([]byte, error) {
	b, err := json.MarshalIndent(document{Version: Version, Generator: generator, Run: r}, "", "  ")
	if err != nil {
		return nil, fmt.Errorf("encode run report: %w", err)
	}
	return append(b, '\n'), nil
}

//go:embed report.html.tmpl
var pageSource string

var page = template.Must(template.New("report").Funcs(template.FuncMap{
	"ms":        formatMs,
	"size":      formatSize,
	"when":      func(t time.Time) string { return t.Format("2006-01-02 15:04:05 MST") },
	"inc":       func(i int) int { return i + 1 },
	"methodCls": methodClass,
	"statusCls": statusClass,
	"outcome":   outcomeText,
	"tests":     testCounts,
	"failed":    func(r runner.Result) bool { return r.Failed() },
	"join":      strings.Join,
}).Parse(pageSource))

// Iteration groups the results of one iteration for the page.
type iteration struct {
	Number  int
	Results []runner.Result
}

type view struct {
	Run        runner.Report
	Generator  string
	Iterations []iteration
}

// HTML renders the report as a standalone page.
func HTML(r runner.Report, generator string) ([]byte, error) {
	v := view{Run: r, Generator: generator}
	for _, res := range r.Results {
		if n := len(v.Iterations); n == 0 || v.Iterations[n-1].Number != res.Iteration+1 {
			v.Iterations = append(v.Iterations, iteration{Number: res.Iteration + 1})
		}
		last := &v.Iterations[len(v.Iterations)-1]
		last.Results = append(last.Results, res)
	}
	var buf bytes.Buffer
	if err := page.Execute(&buf, v); err != nil {
		return nil, fmt.Errorf("render run report: %w", err)
	}
	return buf.Bytes(), nil
}

func formatMs(ms float64) string {
	switch {
	case ms >= 1000:
		return fmt.Sprintf("%.2f s", ms/1000)
	case ms >= 10:
		return fmt.Sprintf("%.0f ms", ms)
	default:
		return fmt.Sprintf("%.1f ms", ms)
	}
}

func formatSize(n int64) string {
	switch {
	case n >= 1<<20:
		return fmt.Sprintf("%.1f MB", float64(n)/(1<<20))
	case n >= 1<<10:
		return fmt.Sprintf("%.1f KB", float64(n)/(1<<10))
	default:
		return fmt.Sprintf("%d B", n)
	}
}

func methodClass(m string) string {
	switch m {
	case "GET", "POST", "PUT", "PATCH", "DELETE":
		return "m-" + strings.ToLower(m)
	}
	return "m-other"
}

func statusClass(r runner.Result) string {
	switch {
	case r.Skipped:
		return "muted"
	case r.Error != nil || r.Status >= 500:
		return "s-server"
	case r.Status >= 400:
		return "s-client"
	case r.Status >= 300:
		return "s-redirect"
	default:
		return "s-ok"
	}
}

var outcomes = map[runner.Outcome]string{
	runner.OutcomePassed:   "Passed",
	runner.OutcomeFailed:   "Failed",
	runner.OutcomeStopped:  "Stopped at the first failure",
	runner.OutcomeCanceled: "Cancelled",
	runner.OutcomeError:    "Stopped with an error",
	runner.OutcomeRunning:  "Running",
}

func outcomeText(o runner.Outcome) string {
	if t, ok := outcomes[o]; ok {
		return t
	}
	return string(o)
}

func testCounts(r runner.Result) string {
	passed, failed, _ := r.TestCounts()
	if passed+failed == 0 {
		return "–"
	}
	return fmt.Sprintf("%d/%d", passed, passed+failed)
}
