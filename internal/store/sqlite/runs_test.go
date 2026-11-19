package sqlite

import (
	"encoding/json"
	"errors"
	"fmt"
	"testing"
	"time"
)

func TestRuns(t *testing.T) {
	s := openTest(t)
	base := time.UnixMilli(1_800_000_000_000).UTC()
	add := func(ws string, i int) RunRecord {
		r := RunRecord{
			RunSummary: RunSummary{
				ID: fmt.Sprintf("%s-%02d", ws, i), WorkspaceID: ws, CreatedAt: base.Add(time.Duration(i) * time.Second),
				TargetID: "c1", TargetKind: "collection", TargetName: "API", EnvironmentName: "Dev",
				Iterations: 2, DataFile: "users.csv", Outcome: "passed", DurationMs: 12.5,
				Summary: json.RawMessage(`{"requests":4}`),
			},
			Run: json.RawMessage(fmt.Sprintf(`{"id":%q}`, ws)),
		}
		if err := s.AddRun(r, 3); err != nil {
			t.Fatal(err)
		}
		return r
	}
	for i := range 5 {
		add("W1", i)
	}
	add("W2", 0)

	list, err := s.ListRuns("W1")
	if err != nil {
		t.Fatal(err)
	}
	if len(list) != 3 || list[0].ID != "W1-04" || list[2].ID != "W1-02" {
		t.Fatalf("list = %+v", list)
	}
	if l := list[0]; l.TargetName != "API" || l.Iterations != 2 || l.DataFile != "users.csv" || string(l.Summary) != `{"requests":4}` || !l.CreatedAt.Equal(base.Add(4*time.Second)) {
		t.Errorf("row = %+v", l)
	}
	got, err := s.GetRun("W2-00")
	if err != nil || string(got.Run) != `{"id":"W2"}` || got.WorkspaceID != "W2" || got.DurationMs != 12.5 {
		t.Fatalf("get = %+v, %v", got, err)
	}
	if _, err := s.GetRun("W1-00"); !errors.Is(err, ErrNotFound) {
		t.Errorf("pruned run: %v", err)
	}
	if err := s.DeleteRun("W1-04"); err != nil {
		t.Fatal(err)
	}
	if list, _ := s.ListRuns("W1"); len(list) != 2 {
		t.Errorf("after delete %d", len(list))
	}
	if list, _ := s.ListRuns("none"); list == nil || len(list) != 0 {
		t.Errorf("empty list = %#v", list)
	}
	// Defaults: created now, empty JSON, keep all.
	if err := s.AddRun(RunRecord{RunSummary: RunSummary{ID: "x", WorkspaceID: "W3"}}, 0); err != nil {
		t.Fatal(err)
	}
	if r, _ := s.GetRun("x"); string(r.Run) != "{}" || string(r.Summary) != "{}" || r.CreatedAt.IsZero() {
		t.Errorf("defaults = %+v", r)
	}
	if err := s.AddRun(RunRecord{RunSummary: RunSummary{ID: "x", WorkspaceID: "W3"}}, 0); err == nil {
		t.Error("duplicate id accepted")
	}
	if err := s.AddRun(RunRecord{}, 0); err == nil {
		t.Error("run without ids accepted")
	}
}

func TestRunsClosed(t *testing.T) {
	s := openTest(t)
	_ = s.Close()
	if err := s.AddRun(RunRecord{RunSummary: RunSummary{ID: "a", WorkspaceID: "w"}}, 1); err == nil {
		t.Error("add")
	}
	if _, err := s.ListRuns("w"); err == nil {
		t.Error("list")
	}
	if _, err := s.GetRun("a"); err == nil || errors.Is(err, ErrNotFound) {
		t.Error("get")
	}
	if err := s.DeleteRun("a"); err == nil {
		t.Error("delete")
	}
}
