package sqlite

import "testing"

func TestWorkspaceState(t *testing.T) {
	s := openTest(t)
	if v, err := s.GetWorkspaceState("W1", StateSelectedEnvironment); err != nil || v != "" {
		t.Fatalf("unset = %q %v", v, err)
	}
	steps := []struct {
		ws, value string
	}{
		{"W1", "E1"},
		{"W1", "E2"}, // replaces
		{"W2", "E9"}, // other workspace is separate
	}
	for _, st := range steps {
		if err := s.SetWorkspaceState(st.ws, StateSelectedEnvironment, st.value); err != nil {
			t.Fatal(err)
		}
	}
	for ws, want := range map[string]string{"W1": "E2", "W2": "E9"} {
		if v, err := s.GetWorkspaceState(ws, StateSelectedEnvironment); err != nil || v != want {
			t.Fatalf("%s = %q %v, want %q", ws, v, err, want)
		}
	}
	if err := s.SetWorkspaceState("W1", StateSelectedEnvironment, ""); err != nil {
		t.Fatal(err)
	}
	if v, _ := s.GetWorkspaceState("W1", StateSelectedEnvironment); v != "" {
		t.Fatalf("cleared = %q", v)
	}
	if err := s.SetWorkspaceState("", "k", "v"); err == nil {
		t.Fatal("expected error without workspace id")
	}
}

func TestWorkspaceStateClosedDB(t *testing.T) {
	s := openTest(t)
	_ = s.Close()
	if _, err := s.GetWorkspaceState("W", "k"); err == nil {
		t.Fatal("expected read error")
	}
	if err := s.SetWorkspaceState("W", "k", "v"); err == nil {
		t.Fatal("expected write error")
	}
}

func TestHistoryEnvironmentAndNoWorkspace(t *testing.T) {
	s := openTest(t)
	add := func(ws, env string) int64 {
		t.Helper()
		e := entry("GET", "http://x/"+ws, 200)
		e.WorkspaceID, e.EnvironmentName = ws, env
		id, err := s.AddHistory(e)
		if err != nil {
			t.Fatal(err)
		}
		return id
	}
	id := add("W1", "Staging")
	add("W2", "")
	add("", "")
	add("", "")

	got, err := s.GetHistory(id)
	if err != nil || got.EnvironmentName != "Staging" {
		t.Fatalf("entry = %+v %v", got.HistorySummary, err)
	}
	page, err := s.ListHistory(HistoryFilter{NoWorkspace: true, WorkspaceID: "W1"})
	if err != nil || page.Total != 2 || page.Items[0].WorkspaceID != "" {
		t.Fatalf("no-workspace page = %+v %v", page, err)
	}
	if page, _ := s.ListHistory(HistoryFilter{WorkspaceID: "W1"}); page.Total != 1 || page.Items[0].EnvironmentName != "Staging" {
		t.Fatalf("W1 page = %+v", page)
	}
	if err := s.ClearHistoryWithoutWorkspace(); err != nil {
		t.Fatal(err)
	}
	if page, _ := s.ListHistory(HistoryFilter{}); page.Total != 2 {
		t.Fatalf("after clearing no-workspace entries: %d left", page.Total)
	}
}

func TestPruneIsPerWorkspace(t *testing.T) {
	s := openTest(t)
	counts := map[string]int{"W1": 4, "W2": 2, "": 3}
	for ws, n := range counts {
		for i := 0; i < n; i++ {
			e := entry("GET", "http://x/"+ws, 200)
			e.WorkspaceID = ws
			if _, err := s.AddHistory(e); err != nil {
				t.Fatal(err)
			}
		}
	}
	total := func(f HistoryFilter) int {
		t.Helper()
		p, err := s.ListHistory(f)
		if err != nil {
			t.Fatal(err)
		}
		return p.Total
	}
	// One group: only W1 is trimmed.
	if n, err := s.PruneWorkspaceHistory("W1", 2); err != nil || n != 2 {
		t.Fatalf("prune W1 = %d %v", n, err)
	}
	if total(HistoryFilter{WorkspaceID: "W1"}) != 2 || total(HistoryFilter{WorkspaceID: "W2"}) != 2 || total(HistoryFilter{NoWorkspace: true}) != 3 {
		t.Fatal("pruning W1 touched other groups")
	}
	// The no-workspace group on its own.
	if n, err := s.PruneWorkspaceHistory("", 1); err != nil || n != 2 || total(HistoryFilter{NoWorkspace: true}) != 1 {
		t.Fatalf("prune no-workspace = %d %v", n, err)
	}
	if n, err := s.PruneWorkspaceHistory("W2", 0); err != nil || n != 0 {
		t.Fatalf("keep 0 = %d %v", n, err)
	}
	if n, err := s.PruneWorkspaceHistory("W9", 1); err != nil || n != 0 {
		t.Fatalf("unknown workspace = %d %v", n, err)
	}
	// Every group: each keeps its newest entry.
	if n, err := s.PruneHistory(1); err != nil || n != 2 {
		t.Fatalf("prune all = %d %v", n, err)
	}
	if total(HistoryFilter{}) != 3 {
		t.Fatalf("each group should keep one, total = %d", total(HistoryFilter{}))
	}
	_ = s.Close()
	if _, err := s.PruneWorkspaceHistory("W1", 1); err == nil {
		t.Fatal("expected error on closed db")
	}
}
