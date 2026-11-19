package sqlite

import (
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"time"
)

// MaxRuns is how many runs each workspace keeps; older ones are pruned
// when a run is added.
const MaxRuns = 20

// RunSummary is one row of the run list. Summary is the runner summary as
// JSON (the store doesn't interpret it).
type RunSummary struct {
	ID              string          `json:"id"`
	WorkspaceID     string          `json:"workspaceId"`
	CreatedAt       time.Time       `json:"createdAt"`
	TargetID        string          `json:"targetId"`
	TargetKind      string          `json:"targetKind"`
	TargetName      string          `json:"targetName"`
	EnvironmentName string          `json:"environmentName"`
	Iterations      int             `json:"iterations"`
	DataFile        string          `json:"dataFile"`
	Outcome         string          `json:"outcome"`
	DurationMs      float64         `json:"durationMs"`
	Summary         json.RawMessage `json:"summary"`
}

// RunRecord is a stored run: its summary row and the whole report as JSON.
type RunRecord struct {
	RunSummary
	Run json.RawMessage `json:"run"`
}

// AddRun stores a run and keeps only the newest keep runs of its
// workspace (keep <= 0 keeps all).
func (s *Store) AddRun(r RunRecord, keep int) error {
	if r.ID == "" || r.WorkspaceID == "" {
		return errors.New("a run needs an id and a workspace id")
	}
	if r.CreatedAt.IsZero() {
		r.CreatedAt = s.now()
	}
	summary, run := string(r.Summary), string(r.Run)
	if summary == "" {
		summary = "{}"
	}
	if run == "" {
		run = "{}"
	}
	tx, err := s.db.Begin()
	if err != nil {
		return fmt.Errorf("add run: %w", err)
	}
	defer func() { _ = tx.Rollback() }()
	if _, err := tx.Exec(`INSERT INTO runs (id, workspace_id, created_at, target_id, target_kind, target_name,
		environment_name, iterations, data_file, outcome, duration_ms, summary_json, run_json)
		VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		r.ID, r.WorkspaceID, r.CreatedAt.UnixMilli(), r.TargetID, r.TargetKind, r.TargetName,
		r.EnvironmentName, r.Iterations, r.DataFile, r.Outcome, r.DurationMs, summary, run); err != nil {
		return fmt.Errorf("add run: %w", err)
	}
	if keep > 0 {
		if _, err := tx.Exec(`DELETE FROM runs WHERE workspace_id = ? AND id NOT IN
			(SELECT id FROM runs WHERE workspace_id = ? ORDER BY created_at DESC, id DESC LIMIT ?)`,
			r.WorkspaceID, r.WorkspaceID, keep); err != nil {
			return fmt.Errorf("prune runs: %w", err)
		}
	}
	if err := tx.Commit(); err != nil {
		return fmt.Errorf("add run: %w", err)
	}
	return nil
}

const runCols = `id, workspace_id, created_at, target_id, target_kind, target_name, environment_name,
	iterations, data_file, outcome, duration_ms, summary_json`

type runScan struct {
	RunSummary
	createdMs int64
	summary   string
}

func (r *runScan) dest() []any {
	return []any{&r.ID, &r.WorkspaceID, &r.createdMs, &r.TargetID, &r.TargetKind, &r.TargetName,
		&r.EnvironmentName, &r.Iterations, &r.DataFile, &r.Outcome, &r.DurationMs, &r.summary}
}

func (r *runScan) row() RunSummary {
	out := r.RunSummary
	out.CreatedAt = time.UnixMilli(r.createdMs).UTC()
	out.Summary = json.RawMessage(r.summary)
	return out
}

// ListRuns returns a workspace's runs, newest first.
func (s *Store) ListRuns(workspaceID string) ([]RunSummary, error) {
	rows, err := s.db.Query(`SELECT `+runCols+` FROM runs WHERE workspace_id = ?
		ORDER BY created_at DESC, id DESC`, workspaceID)
	if err != nil {
		return nil, fmt.Errorf("list runs: %w", err)
	}
	defer rows.Close()
	out := []RunSummary{}
	for rows.Next() {
		var r runScan
		if err := rows.Scan(r.dest()...); err != nil {
			return nil, fmt.Errorf("list runs: %w", err)
		}
		out = append(out, r.row())
	}
	return out, rows.Err()
}

// GetRun returns a stored run, or ErrNotFound.
func (s *Store) GetRun(id string) (RunRecord, error) {
	var r runScan
	var run string
	err := s.db.QueryRow(`SELECT `+runCols+`, run_json FROM runs WHERE id = ?`, id).Scan(append(r.dest(), &run)...)
	if errors.Is(err, sql.ErrNoRows) {
		return RunRecord{}, fmt.Errorf("run %s: %w", id, ErrNotFound)
	}
	if err != nil {
		return RunRecord{}, fmt.Errorf("read run %s: %w", id, err)
	}
	return RunRecord{RunSummary: r.row(), Run: json.RawMessage(run)}, nil
}

// DeleteRun removes a stored run (no error when it doesn't exist).
func (s *Store) DeleteRun(id string) error {
	if _, err := s.db.Exec(`DELETE FROM runs WHERE id = ?`, id); err != nil {
		return fmt.Errorf("delete run: %w", err)
	}
	return nil
}
