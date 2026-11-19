package service

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"strings"
	"sync"
	"time"

	"pakpos/internal/buildinfo"
	"pakpos/internal/core/model"
	"pakpos/internal/runner"
	"pakpos/internal/runner/report"
	"pakpos/internal/store/sqlite"
)

// EventRunnerProgress carries a collection run's progress (see runner.Event).
// The finished event is emitted after the run is stored.
const EventRunnerProgress = "runner:progress"

// RunnerProgressEvent is the payload of EventRunnerProgress.
type RunnerProgressEvent struct {
	RunID       string       `json:"runId"`
	WorkspaceID string       `json:"workspaceId"`
	Event       runner.Event `json:"event"`
}

// RunConfig is what the runner tab asks to run.
type RunConfig struct {
	// TargetID is the collection or folder to run.
	TargetID string `json:"targetId"`
	// RequestIDs limits the run to these requests (tree order is kept);
	// empty runs all of them.
	RequestIDs    []string `json:"requestIds"`
	EnvironmentID string   `json:"environmentId"`
	// Iterations is 1–10000; 0 means one per data row (or 1).
	Iterations int `json:"iterations"`
	DelayMs    int `json:"delayMs"`
	// DataFile is the path of a CSV or JSON data file ("" for none). Only
	// its name is stored with the run.
	DataFile      string `json:"dataFile"`
	StopOnFailure bool   `json:"stopOnFailure"`
	KeepVariables bool   `json:"keepVariables"`
	SaveResponses bool   `json:"saveResponses"`
	RecordHistory bool   `json:"recordHistory"`
}

// RunTotals are the counts shown in the run list.
type RunTotals struct {
	Requests    int `json:"requests"`
	Errors      int `json:"errors"`
	Skipped     int `json:"skipped"`
	TestsPassed int `json:"testsPassed"`
	TestsFailed int `json:"testsFailed"`
}

// RunListItem is a stored run in the list.
type RunListItem struct {
	ID              string         `json:"id"`
	CreatedAt       time.Time      `json:"createdAt"`
	Target          runner.Target  `json:"target"`
	EnvironmentName string         `json:"environmentName"`
	Iterations      int            `json:"iterations"`
	DataFile        string         `json:"dataFile"`
	Outcome         runner.Outcome `json:"outcome"`
	DurationMs      float64        `json:"durationMs"`
	Totals          RunTotals      `json:"totals"`
}

// ActiveRun is a run still going.
type ActiveRun struct {
	RunID       string `json:"runId"`
	WorkspaceID string `json:"workspaceId"`
	TargetID    string `json:"targetId"`
}

// Export formats.
const (
	ExportJSON = "json"
	ExportHTML = "html"
)

// RunnerService runs collections and folders and keeps their results (the
// newest sqlite.MaxRuns per workspace).
type RunnerService struct {
	c *Core

	mu     sync.Mutex
	active map[string]*activeRun // by run id
	wg     sync.WaitGroup
	// sleep is the runner's delay (tests replace it); nil means real time.
	sleep func(ctx context.Context, d time.Duration) error
}

type activeRun struct {
	ActiveRun
	cancel context.CancelFunc
}

// NewRunnerService creates the service.
func NewRunnerService(c *Core) *RunnerService {
	return &RunnerService{c: c, active: map[string]*activeRun{}}
}

// MsgRunActive is returned by Start while the workspace already has a run.
const MsgRunActive = "A run is already going in this workspace. Wait for it to finish or cancel it, then run again."

// Start checks config and starts the run in the background in the open
// workspace. It returns the run id; progress arrives as EventRunnerProgress
// events. The run keeps the workspace it started in (history and the
// stored run go there) even if the user switches workspace.
func (s *RunnerService) Start(config RunConfig) (string, error) {
	ws, err := s.c.workspace()
	if err != nil {
		return "", err
	}
	wsID := ws.Manifest().ID
	var data *runner.Data
	if strings.TrimSpace(config.DataFile) != "" {
		if data, err = runner.LoadData(config.DataFile); err != nil {
			return "", userErr(err)
		}
	}
	r, err := runner.New(runner.Config{
		Session: s.c.session(ws), Executor: s.c.executor(),
		TargetID: config.TargetID, RequestIDs: config.RequestIDs, EnvironmentID: config.EnvironmentID,
		Iterations: config.Iterations, DelayMs: config.DelayMs, Data: data,
		Options: runner.Options{
			StopOnFailure: config.StopOnFailure, KeepVariables: config.KeepVariables,
			SaveResponses: config.SaveResponses, RecordHistory: config.RecordHistory,
		},
		ScriptTimeout: s.c.currentSettings().ScriptTimeout(),
		Record: func(h runner.HistoryRecord) {
			s.c.recordHistory(wsID, h.EnvironmentName, h.Request, h.Response, h.Error, h.Started)
		},
		Sleep: s.sleep,
	})
	if err != nil {
		return "", userErr(err)
	}

	s.mu.Lock()
	for _, a := range s.active {
		if a.WorkspaceID == wsID {
			s.mu.Unlock()
			return "", &userError{msg: MsgRunActive}
		}
	}
	id := model.NewID()
	ctx, cancel := context.WithCancel(context.Background())
	s.active[id] = &activeRun{ActiveRun: ActiveRun{RunID: id, WorkspaceID: wsID, TargetID: r.Info().Target.ID}, cancel: cancel}
	s.wg.Add(1)
	s.mu.Unlock()

	go func() {
		defer s.wg.Done()
		defer cancel()
		emit := func(e runner.Event) {
			s.c.events.Emit(EventRunnerProgress, RunnerProgressEvent{RunID: id, WorkspaceID: wsID, Event: e})
		}
		var finished *runner.Event
		rep := r.Run(ctx, runner.SinkFunc(func(e runner.Event) {
			if e.Kind == runner.EventStarted {
				e.Run.ID = id
			}
			if e.Kind == runner.EventFinished {
				finished = &e
				return
			}
			emit(e)
		}))
		rep.ID = id
		s.store(rep)
		s.mu.Lock()
		delete(s.active, id)
		s.mu.Unlock()
		emit(*finished)
	}()
	return id, nil
}

// userErr turns the runner's user-facing errors into userError.
func userErr(err error) error {
	var ce *runner.ConfigError
	var de *runner.DataError
	switch {
	case errors.As(err, &ce):
		return &userError{msg: ce.Message, err: err}
	case errors.As(err, &de):
		return &userError{msg: de.Message, err: err}
	}
	return err
}

func (s *RunnerService) store(rep runner.Report) {
	run, err := json.Marshal(rep)
	if err == nil {
		var summary []byte
		summary, err = json.Marshal(rep.Summary)
		if err == nil {
			err = s.c.db.AddRun(sqlite.RunRecord{
				RunSummary: sqlite.RunSummary{
					ID: rep.ID, WorkspaceID: rep.WorkspaceID, CreatedAt: rep.StartedAt,
					TargetID: rep.Target.ID, TargetKind: rep.Target.Kind, TargetName: rep.Target.Name,
					EnvironmentName: rep.EnvironmentName, Iterations: rep.Iterations, DataFile: rep.DataFile,
					Outcome: string(rep.Outcome), DurationMs: rep.Summary.DurationMs, Summary: summary,
				},
				Run: run,
			}, sqlite.MaxRuns)
		}
	}
	if err != nil {
		s.c.log.Warn("store run", "err", err)
	}
}

// Cancel stops a running run (its results so far are kept). It reports
// whether the run was found.
func (s *RunnerService) Cancel(runID string) bool {
	s.mu.Lock()
	a, ok := s.active[runID]
	s.mu.Unlock()
	if ok {
		a.cancel()
	}
	return ok
}

// Active lists the runs still going (in any workspace).
func (s *RunnerService) Active() []ActiveRun {
	s.mu.Lock()
	defer s.mu.Unlock()
	out := []ActiveRun{}
	for _, a := range s.active {
		out = append(out, a.ActiveRun)
	}
	return out
}

// wait blocks until every run has finished (tests).
func (s *RunnerService) wait() { s.wg.Wait() }

// List returns the open workspace's stored runs, newest first.
func (s *RunnerService) List() ([]RunListItem, error) {
	ws, err := s.c.workspace()
	if err != nil {
		return nil, err
	}
	rows, err := s.c.db.ListRuns(ws.Manifest().ID)
	if err != nil {
		return nil, err
	}
	out := make([]RunListItem, 0, len(rows))
	for _, r := range rows {
		var sum runner.Summary
		if err := json.Unmarshal(r.Summary, &sum); err != nil {
			s.c.log.Warn("read run summary", "run", r.ID, "err", err)
		}
		out = append(out, RunListItem{
			ID: r.ID, CreatedAt: r.CreatedAt,
			Target:          runner.Target{ID: r.TargetID, Kind: r.TargetKind, Name: r.TargetName},
			EnvironmentName: r.EnvironmentName, Iterations: r.Iterations, DataFile: r.DataFile,
			Outcome: runner.Outcome(r.Outcome), DurationMs: r.DurationMs,
			Totals: RunTotals{
				Requests: sum.Requests, Errors: sum.Errors, Skipped: sum.Skipped,
				TestsPassed: sum.TestsPassed, TestsFailed: sum.TestsFailed,
			},
		})
	}
	return out, nil
}

// Get returns a stored run.
func (s *RunnerService) Get(runID string) (runner.Report, error) {
	rec, err := s.c.db.GetRun(runID)
	if errors.Is(err, sqlite.ErrNotFound) {
		return runner.Report{}, &userError{msg: "This run is no longer stored. Only the last 20 runs of a workspace are kept.", err: err}
	}
	if err != nil {
		return runner.Report{}, err
	}
	var rep runner.Report
	if err := json.Unmarshal(rec.Run, &rep); err != nil {
		return runner.Report{}, fmt.Errorf("read run %s: %w", runID, err)
	}
	return rep, nil
}

// Delete removes a stored run.
func (s *RunnerService) Delete(runID string) error {
	return s.c.db.DeleteRun(runID)
}

// Export asks where to save a stored run's report and writes it as JSON or
// HTML. It returns the path, or "" when the user cancelled.
func (s *RunnerService) Export(runID, format string) (string, error) {
	if format != ExportJSON && format != ExportHTML {
		return "", fmt.Errorf("unknown export format %q", format)
	}
	rep, err := s.Get(runID)
	if err != nil {
		return "", err
	}
	generator := "Pakpos " + buildinfo.Version
	var data []byte
	if format == ExportJSON {
		data, err = report.JSON(rep, generator)
	} else {
		data, err = report.HTML(rep, generator)
	}
	if err != nil {
		return "", err
	}
	dest, err := s.c.dialogs.SaveFile("Export run report", exportName(rep, format))
	if err != nil || dest == "" {
		return "", err
	}
	if err := os.WriteFile(dest, data, 0o644); err != nil { //nolint:gosec // a report the user chose to save, readable like any document
		return "", &userError{msg: fmt.Sprintf("Couldn't save the report: %v", err), err: err}
	}
	return dest, nil
}

// exportName suggests "<target>-run-YYYYMMDD-HHMMSS.<format>".
func exportName(rep runner.Report, format string) string {
	name := strings.Map(func(r rune) rune {
		switch {
		case r == ' ':
			return '-'
		case strings.ContainsRune(`/\:*?"<>|`, r) || r < 32:
			return -1
		}
		return r
	}, strings.TrimSpace(rep.Target.Name))
	if name == "" {
		name = "collection"
	}
	return fmt.Sprintf("%s-run-%s.%s", name, rep.StartedAt.Local().Format("20060102-150405"), format)
}

// PickDataFile asks for a CSV or JSON data file. It returns "" when cancelled.
func (s *RunnerService) PickDataFile() (string, error) {
	return s.c.dialogs.PickFile("Choose a data file (CSV or JSON)")
}

// PreviewData reads a data file and returns its name, row count, columns
// and first rows.
func (s *RunnerService) PreviewData(path string) (runner.DataPreview, error) {
	d, err := runner.LoadData(path)
	if err != nil {
		return runner.DataPreview{}, userErr(err)
	}
	return d.Preview(), nil
}
