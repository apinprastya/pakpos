// Package runner runs the requests of a collection or folder in tree order,
// with iterations, a delay, a data file, stop-on-failure and the scripts'
// setNextRequest/skipRequest. It drives pipeline (scopes, scripts, masking)
// and an Executor (httpexec), reports progress to a Sink and returns the
// finished Run. It has no Wails dependency, so the headless CLI can reuse it.
package runner

import (
	"context"
	"errors"
	"fmt"
	"os"
	"strings"
	"time"

	"pakpos/internal/core/httpexec"
	"pakpos/internal/core/model"
	"pakpos/internal/core/script"
	"pakpos/internal/pipeline"
	"pakpos/internal/store/fsstore"
)

// Limits of a run's configuration.
const (
	MaxIterations = 10000
	MaxDelayMs    = 60000
	// MaxJumps is the most setNextRequest jumps in one iteration; more
	// ends the run with an error (a likely endless loop).
	MaxJumps = 1000
	// MaxSavedBody is the most of one response body kept when responses
	// are saved (history's inline limit); MaxSavedBodies caps them per run.
	MaxSavedBody   = 1 << 20
	MaxSavedBodies = 32 << 20
	// MaxFailures is the most failures a summary lists (the totals still
	// count every one).
	MaxFailures = 500
)

// Executor sends a resolved request (httpexec.Executor).
type Executor interface {
	Execute(ctx context.Context, id string, req model.Request) (*model.Response, error)
}

// HistoryRecord is a runner send for history: the request as written
// (never resolved), with the response or the error. When the response has
// a BodyPath (a spilled body), the recorder takes the file over.
type HistoryRecord struct {
	Request         model.Request
	Response        *model.Response
	Error           *httpexec.Error
	Started         time.Time
	EnvironmentName string
}

// Options are the run's switches.
type Options struct {
	// StopOnFailure ends the run at the first request error or failed test.
	StopOnFailure bool `json:"stopOnFailure"`
	// KeepVariables lets scripts' environment/collection/globals values
	// outlive the run (the workspace overlay, as a single send does).
	// Off, the run writes to a private copy of the overlay.
	KeepVariables bool `json:"keepVariables"`
	// SaveResponses keeps the response bodies (masked, capped) in the run.
	SaveResponses bool `json:"saveResponses"`
	// RecordHistory adds every send to history.
	RecordHistory bool `json:"recordHistory"`
}

// Config is what to run and how.
type Config struct {
	// Session is the workspace's send pipeline (with its overlay).
	Session *pipeline.Session
	// Executor sends the requests.
	Executor Executor
	// TargetID is the collection or folder to run.
	TargetID string
	// RequestIDs limits the run to these requests (tree order is kept);
	// empty means all of them.
	RequestIDs []string
	// EnvironmentID is the environment to use ("" for none).
	EnvironmentID string
	// Iterations is 1–MaxIterations; 0 means 1, or one per data row.
	Iterations int
	// DelayMs waits between requests (0–MaxDelayMs).
	DelayMs int
	// Data is the parsed data file (nil for none).
	Data    *Data
	Options Options
	// ScriptTimeout per script run (script.DefaultTimeout when zero).
	ScriptTimeout time.Duration
	// ScriptRequestsOff turns pm.sendRequest off (Executor sends them
	// otherwise); Jar backs pm.cookies (nil: an empty jar).
	ScriptRequestsOff bool
	Jar               pipeline.CookieJar
	// Record adds a send to history when Options.RecordHistory is on.
	Record func(HistoryRecord)
	// Sleep waits d or until ctx is done (tests inject one).
	Sleep func(ctx context.Context, d time.Duration) error
	// Now is the clock (time.Now when nil).
	Now func() time.Time
}

// ConfigError is a configuration the runner can't run, written for the user.
type ConfigError struct{ Message string }

func (e *ConfigError) Error() string { return e.Message }

func configErr(format string, args ...any) error {
	return &ConfigError{Message: fmt.Sprintf(format, args...)}
}

// Target is the collection or folder a run covers.
type Target struct {
	ID   string `json:"id"`
	Kind string `json:"kind"` // "collection" or "folder"
	Name string `json:"name"`
	// Path is the names from the collection down to the target.
	Path []string `json:"path"`
}

// RequestInfo is one request of the run order, as written when the run
// started.
type RequestInfo struct {
	ID      string        `json:"id"`
	Name    string        `json:"name"`
	Method  string        `json:"method"`
	URL     string        `json:"url"`
	Request model.Request `json:"request"`
}

// SavedResponse is a response kept when Options.SaveResponses is on: the
// text body with secret values masked, cut at MaxSavedBody. Binary bodies
// and bodies past MaxSavedBodies aren't kept (Omitted says why).
type SavedResponse struct {
	ContentType string           `json:"contentType"`
	Headers     []model.KeyValue `json:"headers"`
	Body        string           `json:"body"`
	Truncated   bool             `json:"truncated"`
	Omitted     string           `json:"omitted,omitempty"`
}

// Why a saved body was left out.
const (
	OmittedBinary = "binary"
	OmittedLimit  = "limit"
)

// Result is one send of the run. Text is masked ([secret:name]).
type Result struct {
	Iteration int `json:"iteration"` // 0-based
	// Index is the request's position in Report.Requests.
	Index      int       `json:"index"`
	RequestID  string    `json:"requestId"`
	Name       string    `json:"name"`
	Method     string    `json:"method"`
	StartedAt  time.Time `json:"startedAt"`
	Status     int       `json:"status"`
	StatusText string    `json:"statusText"`
	// DurationMs is the response time (0 without a response).
	DurationMs    float64               `json:"durationMs"`
	Size          int64                 `json:"size"`
	Tests         []script.TestResult   `json:"tests"`
	Console       []script.ConsoleEntry `json:"console"`
	Error         *httpexec.Error       `json:"error"`
	Skipped       bool                  `json:"skipped"`
	SecretsLocked bool                  `json:"secretsLocked"`
	Response      *SavedResponse        `json:"response,omitempty"`
}

// TestCounts returns the passed, failed and skipped tests.
func (r Result) TestCounts() (passed, failed, skipped int) {
	for _, t := range r.Tests {
		switch {
		case t.Skipped:
			skipped++
		case t.Passed:
			passed++
		default:
			failed++
		}
	}
	return
}

// Failed is true for a request error or a failed test.
func (r Result) Failed() bool {
	_, failed, _ := r.TestCounts()
	return r.Error != nil || failed > 0
}

// Outcome is how a run ended.
type Outcome string

// Outcomes.
const (
	OutcomeRunning  Outcome = "running"
	OutcomePassed   Outcome = "passed"   // every iteration ran, nothing failed
	OutcomeFailed   Outcome = "failed"   // every iteration ran, something failed
	OutcomeStopped  Outcome = "stopped"  // stopped at the first failure
	OutcomeCanceled Outcome = "canceled" // cancelled by the user
	OutcomeError    Outcome = "error"    // ended by the runner (Run.Error)
)

// Report is a run's configuration, results and summary.
type Report struct {
	ID              string        `json:"id"`
	WorkspaceID     string        `json:"workspaceId"`
	Target          Target        `json:"target"`
	EnvironmentID   string        `json:"environmentId"`
	EnvironmentName string        `json:"environmentName"`
	Iterations      int           `json:"iterations"`
	DelayMs         int           `json:"delayMs"`
	DataFile        string        `json:"dataFile"`
	Options         Options       `json:"options"`
	Requests        []RequestInfo `json:"requests"`
	StartedAt       time.Time     `json:"startedAt"`
	FinishedAt      time.Time     `json:"finishedAt"`
	Outcome         Outcome       `json:"outcome"`
	// Error says why the runner ended the run (OutcomeError).
	Error   string   `json:"error"`
	Results []Result `json:"results"`
	Summary Summary  `json:"summary"`
}

// EventKind names a progress event.
type EventKind string

// Progress events, in the order a run emits them.
const (
	EventStarted           EventKind = "started"
	EventRequestStarted    EventKind = "requestStarted"
	EventRequestFinished   EventKind = "requestFinished"
	EventIterationFinished EventKind = "iterationFinished"
	EventFinished          EventKind = "finished"
)

// Event is a progress event. Started carries the Report (without results);
// request events carry Iteration and Index, RequestFinished the Result;
// Finished carries the Run's outcome, error and Summary.
type Event struct {
	Kind      EventKind `json:"kind"`
	Iteration int       `json:"iteration"`
	Index     int       `json:"index"`
	Run       *Report   `json:"run,omitempty"`
	Result    *Result   `json:"result,omitempty"`
	Outcome   Outcome   `json:"outcome,omitempty"`
	Error     string    `json:"error,omitempty"`
	Summary   *Summary  `json:"summary,omitempty"`
}

// Sink receives progress events, in order, from the run's goroutine.
type Sink interface{ Event(Event) }

// SinkFunc adapts a function to Sink.
type SinkFunc func(Event)

// Event calls f.
func (f SinkFunc) Event(e Event) { f(e) }

// Runner is a checked configuration, ready to run once.
type Runner struct {
	cfg   Config
	sess  *pipeline.Session
	run   Report
	saved int // bytes of saved bodies
}

// New checks cfg and resolves the run order. Errors are *ConfigError.
func New(cfg Config) (*Runner, error) {
	if cfg.Session == nil || cfg.Executor == nil {
		return nil, errors.New("runner: session and executor are required")
	}
	if cfg.DelayMs < 0 || cfg.DelayMs > MaxDelayMs {
		return nil, configErr("The delay must be between 0 and %d ms.", MaxDelayMs)
	}
	if cfg.Iterations < 0 || cfg.Iterations > MaxIterations {
		return nil, configErr("Iterations must be between 1 and %d.", MaxIterations)
	}
	iterations := max(cfg.Iterations, 1)
	dataFile := ""
	if cfg.Data != nil {
		n := len(cfg.Data.Rows)
		switch {
		case n == 0:
			return nil, configErr("The data file %q has no rows.", cfg.Data.Name)
		case cfg.Iterations != 0 && cfg.Iterations != n:
			return nil, configErr("The data file %q has %d rows, but iterations is %d. Set iterations to %d, or leave it empty to run once per row.", cfg.Data.Name, n, cfg.Iterations, n)
		}
		iterations, dataFile = n, cfg.Data.Name
	}
	ws := cfg.Session.Workspace()
	target, requests, err := order(ws, cfg.TargetID)
	if err != nil {
		return nil, err
	}
	if len(cfg.RequestIDs) > 0 {
		keep := map[string]bool{}
		for _, id := range cfg.RequestIDs {
			keep[id] = true
		}
		var picked []RequestInfo
		for _, r := range requests {
			if keep[r.ID] {
				picked = append(picked, r)
			}
		}
		requests = picked
	}
	if len(requests) == 0 {
		return nil, configErr("There are no requests to run in %s %q. Add a request or select one.", target.Kind, target.Name)
	}
	if cfg.Now == nil {
		cfg.Now = time.Now
	}
	if cfg.Sleep == nil {
		cfg.Sleep = sleep
	}
	sess := cfg.Session
	if !cfg.Options.KeepVariables {
		sess = sess.Isolated()
	}
	envName := ""
	if env := sess.Environment(cfg.EnvironmentID); env != nil {
		envName = env.Name
	} else {
		cfg.EnvironmentID = ""
	}
	return &Runner{cfg: cfg, sess: sess, run: Report{
		WorkspaceID: ws.Manifest().ID, Target: target,
		EnvironmentID: cfg.EnvironmentID, EnvironmentName: envName,
		Iterations: iterations, DelayMs: cfg.DelayMs, DataFile: dataFile,
		Options: cfg.Options, Requests: requests, Results: []Result{},
		Outcome: OutcomeRunning,
	}}, nil
}

// Run checks cfg and runs it (New, then Runner.Run).
func Run(ctx context.Context, cfg Config, sink Sink) (Report, error) {
	r, err := New(cfg)
	if err != nil {
		return Report{}, err
	}
	return r.Run(ctx, sink), nil
}

// Info returns the report as the run starts: configuration and order, no results.
func (r *Runner) Info() Report { return r.run }

func sleep(ctx context.Context, d time.Duration) error {
	t := time.NewTimer(d)
	defer t.Stop()
	select {
	case <-ctx.Done():
		return ctx.Err()
	case <-t.C:
		return nil
	}
}

// order finds the target in the tree and lists its requests depth-first,
// folders and requests in their seq order.
func order(ws *fsstore.Workspace, targetID string) (Target, []RequestInfo, error) {
	var found *fsstore.Node
	var path []string
	var find func(nodes []fsstore.Node, trail []string) bool
	find = func(nodes []fsstore.Node, trail []string) bool {
		for i := range nodes {
			n := &nodes[i]
			if n.Kind == fsstore.NodeRequest {
				continue
			}
			here := append(append([]string{}, trail...), n.Name)
			if n.ID == targetID {
				found, path = n, here
				return true
			}
			if find(n.Children, here) {
				return true
			}
		}
		return false
	}
	if targetID == "" || !find(ws.Tree().Collections, nil) {
		return Target{}, nil, configErr("The collection or folder to run no longer exists.")
	}
	target := Target{ID: found.ID, Kind: string(found.Kind), Name: found.Name, Path: path}
	var out []RequestInfo
	var walk func(nodes []fsstore.Node) error
	walk = func(nodes []fsstore.Node) error {
		for _, n := range nodes {
			if n.Kind != fsstore.NodeRequest {
				if err := walk(n.Children); err != nil {
					return err
				}
				continue
			}
			req, err := ws.GetRequest(n.ID)
			if err != nil {
				return configErr("Couldn't read the request %q: %v", n.Name, err)
			}
			method := strings.ToUpper(strings.TrimSpace(req.Method))
			if method == "" {
				method = "GET"
			}
			out = append(out, RequestInfo{ID: req.ID, Name: req.Name, Method: method, URL: req.URL, Request: req})
		}
		return nil
	}
	if err := walk(found.Children); err != nil {
		return Target{}, nil, err
	}
	return target, out, nil
}

// Run runs every iteration and returns the finished run. Cancelling ctx
// stops it between or within requests; the results so far are kept.
func (r *Runner) Run(ctx context.Context, sink Sink) Report {
	if sink == nil {
		sink = SinkFunc(func(Event) {})
	}
	run := &r.run
	run.StartedAt = r.cfg.Now()
	info := *run
	sink.Event(Event{Kind: EventStarted, Run: &info})
	outcome, msg := r.iterations(ctx, sink)
	run.FinishedAt = r.cfg.Now()
	if outcome == OutcomeRunning {
		outcome = OutcomePassed
		if failed(run.Results) {
			outcome = OutcomeFailed
		}
	}
	run.Outcome, run.Error = outcome, msg
	run.Summary = Summarize(*run)
	summary := run.Summary
	sink.Event(Event{Kind: EventFinished, Outcome: outcome, Error: msg, Summary: &summary})
	return *run
}

func failed(results []Result) bool {
	for _, res := range results {
		if res.Failed() {
			return true
		}
	}
	return false
}

// iterations runs the loop; it returns OutcomeRunning when every
// iteration ran.
func (r *Runner) iterations(ctx context.Context, sink Sink) (Outcome, string) {
	run := &r.run
	reqs := run.Requests
	first := true
	for it := range run.Iterations {
		var row map[string]string
		if r.cfg.Data != nil {
			row = r.cfg.Data.Rows[it]
		}
		var local map[string]string
		jumps := 0
		for i := 0; i < len(reqs); {
			if !first && run.DelayMs > 0 {
				if err := r.cfg.Sleep(ctx, time.Duration(run.DelayMs)*time.Millisecond); err != nil {
					return OutcomeCanceled, ""
				}
			}
			if ctx.Err() != nil {
				return OutcomeCanceled, ""
			}
			first = false
			sink.Event(Event{Kind: EventRequestStarted, Iteration: it, Index: i})
			res, next, canceled := r.send(ctx, it, i, row, &local)
			if canceled {
				return OutcomeCanceled, ""
			}
			run.Results = append(run.Results, res)
			out := res
			sink.Event(Event{Kind: EventRequestFinished, Iteration: it, Index: i, Result: &out})
			if r.cfg.Options.StopOnFailure && res.Failed() {
				return OutcomeStopped, ""
			}
			if next == nil {
				i++
				continue
			}
			if next.stop {
				break
			}
			to := find(reqs, next.name)
			if to < 0 {
				return OutcomeError, fmt.Sprintf("setNextRequest(%q) in %q (iteration %d): no request with that name or id is in this run.", next.name, reqs[i].Name, it+1)
			}
			if jumps++; jumps > MaxJumps {
				return OutcomeError, fmt.Sprintf("setNextRequest jumped more than %d times in iteration %d, so the run was stopped. Check the scripts for an endless loop.", MaxJumps, it+1)
			}
			i = to
		}
		sink.Event(Event{Kind: EventIterationFinished, Iteration: it})
	}
	return OutcomeRunning, ""
}

// find returns the first request named name, else the one with that id.
func find(reqs []RequestInfo, name string) int {
	for i, r := range reqs {
		if r.Name == name {
			return i
		}
	}
	for i, r := range reqs {
		if r.ID == name {
			return i
		}
	}
	return -1
}

type jump struct {
	name string
	stop bool
}

func nextOf(rep pipeline.ScriptReport) *jump {
	if rep.NextRequest == nil {
		return nil
	}
	return &jump{name: *rep.NextRequest, stop: rep.NextStop}
}

// send runs one request with its scripts. local carries the iteration's
// local scope from send to send.
func (r *Runner) send(ctx context.Context, it, idx int, row map[string]string, local *map[string]string) (Result, *jump, bool) {
	info := r.run.Requests[idx]
	sd := r.sess.NewSend(info.Request, "", r.run.EnvironmentID, pipeline.ScriptOptions{
		Timeout: r.cfg.ScriptTimeout, Iteration: it, IterationCount: r.run.Iterations,
		IterationData: row, Local: *local,
		Executor: r.cfg.Executor, RequestsOff: r.cfg.ScriptRequestsOff, Jar: r.cfg.Jar,
	})
	started := r.cfg.Now()
	res := Result{
		Iteration: it, Index: idx, RequestID: info.ID, Name: info.Name, Method: info.Method,
		StartedAt: started, Tests: []script.TestResult{}, Console: []script.ConsoleEntry{},
	}
	add := func(rep pipeline.ScriptReport) {
		res.Tests = append(res.Tests, rep.Tests...)
		res.Console = append(res.Console, rep.Console...)
	}
	pre := sd.PreRequest(ctx)
	add(pre)
	*local = sd.Local()
	next := nextOf(pre)
	prepared, perr := sd.Prepare()
	res.SecretsLocked = sd.SecretsLocked() || prepared.SecretsLocked
	switch {
	case pre.Err != nil && pre.Err.Canceled:
		return res, nil, true
	case pre.Err != nil:
		res.Error = &httpexec.Error{Kind: httpexec.KindScript, Message: pre.Err.Error()}
		r.record(info, nil, res.Error, started)
		return res, next, false
	case pre.Skip:
		res.Skipped = true
		return res, next, false
	case perr != nil:
		res.Error = &httpexec.Error{Kind: httpexec.KindVariables, Message: sd.Mask(pipeline.VariableMessage(perr))}
		r.record(info, nil, res.Error, started)
		return res, next, false
	}
	if aerr := sd.Authorize(ctx, &prepared); aerr != nil {
		if ctx.Err() != nil {
			return res, nil, true
		}
		res.SecretsLocked = res.SecretsLocked || sd.SecretsLocked()
		res.Error = &httpexec.Error{Kind: httpexec.KindAuth, Message: aerr.Error()}
		r.record(info, nil, res.Error, started)
		return res, next, false
	}

	resp, err := r.cfg.Executor.Execute(ctx, "", prepared.Request)
	if sendErr := httpexec.Classify(err); sendErr != nil {
		if sendErr.Kind == httpexec.KindCanceled || ctx.Err() != nil {
			dropSpill(resp)
			return res, nil, true
		}
		res.Error = &httpexec.Error{Kind: sendErr.Kind, Message: sd.Mask(sendErr.Message)}
	}
	if resp != nil {
		test := sd.Test(ctx, resp)
		if test.Err != nil && test.Err.Canceled {
			dropSpill(resp)
			return res, nil, true
		}
		add(test)
		*local = sd.Local()
		next = nextOf(test)
		res.SecretsLocked = res.SecretsLocked || sd.SecretsLocked()
		res.Status, res.StatusText = resp.StatusCode, resp.StatusText
		res.DurationMs, res.Size = resp.Timings.Total, resp.Size
		if r.run.Options.SaveResponses {
			res.Response = r.saveResponse(resp, sd)
		}
	}
	r.record(info, resp, res.Error, started)
	return res, next, false
}

// record adds a send to history (the recorder takes a spilled body over),
// or drops the spilled body when history is off.
func (r *Runner) record(info RequestInfo, resp *model.Response, sendErr *httpexec.Error, started time.Time) {
	if !r.run.Options.RecordHistory || r.cfg.Record == nil {
		dropSpill(resp)
		return
	}
	r.cfg.Record(HistoryRecord{
		Request: info.Request, Response: resp, Error: sendErr,
		Started: started, EnvironmentName: r.run.EnvironmentName,
	})
}

func dropSpill(resp *model.Response) {
	if resp != nil && resp.BodyPath != "" {
		_ = os.Remove(resp.BodyPath)
	}
}

func (r *Runner) saveResponse(resp *model.Response, sd *pipeline.Send) *SavedResponse {
	out := &SavedResponse{ContentType: resp.ContentType, Headers: make([]model.KeyValue, len(resp.Headers))}
	for i, h := range resp.Headers {
		h.Value = sd.Mask(h.Value)
		out.Headers[i] = h
	}
	switch {
	case resp.Encoding == model.EncodingBase64:
		out.Omitted = OmittedBinary
		return out
	case r.saved >= MaxSavedBodies:
		out.Omitted = OmittedLimit
		return out
	}
	body := sd.Mask(string(pipeline.ResponseBody(resp)))
	limit := min(MaxSavedBody, MaxSavedBodies-r.saved)
	if len(body) > limit {
		body, out.Truncated = cutUTF8(body, limit), true
	}
	out.Body = body
	r.saved += len(body)
	return out
}

// cutUTF8 cuts s to at most n bytes without splitting a character.
func cutUTF8(s string, n int) string {
	for n > 0 && n < len(s) && s[n]&0xC0 == 0x80 {
		n--
	}
	return s[:n]
}
