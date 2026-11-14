package sqlite

import "testing"

func TestUIState(t *testing.T) {
	s := openTest(t)
	if m, err := s.UIState(); err != nil || len(m) != 0 {
		t.Fatalf("empty = %v %v", m, err)
	}
	steps := []struct{ key, value string }{
		{"panels.main", `{"sidebar":20}`},
		{"panels.main", `{"sidebar":25}`}, // replaces
		{"columns.kv", `0.4`},
	}
	for _, st := range steps {
		if err := s.SetUIState(st.key, st.value); err != nil {
			t.Fatal(err)
		}
	}
	m, err := s.UIState()
	if err != nil {
		t.Fatal(err)
	}
	want := map[string]string{"panels.main": `{"sidebar":25}`, "columns.kv": `0.4`}
	if len(m) != len(want) {
		t.Fatalf("got %v, want %v", m, want)
	}
	for k, v := range want {
		if m[k] != v {
			t.Fatalf("%s = %q, want %q", k, m[k], v)
		}
	}
	if err := s.SetUIState("columns.kv", ""); err != nil {
		t.Fatal(err)
	}
	if m, _ := s.UIState(); len(m) != 1 {
		t.Fatalf("after delete = %v", m)
	}
	if err := s.SetUIState("", "1"); err == nil {
		t.Fatal("expected error without key")
	}
}

func TestUIStateClosedDB(t *testing.T) {
	s := openTest(t)
	_ = s.Close()
	if _, err := s.UIState(); err == nil {
		t.Fatal("read on closed db should fail")
	}
	if err := s.SetUIState("k", "1"); err == nil {
		t.Fatal("write on closed db should fail")
	}
}
