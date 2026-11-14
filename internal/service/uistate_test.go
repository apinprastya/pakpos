package service

import (
	"strings"
	"testing"

	"pakpos/internal/windowstate"
)

func TestUIStateService(t *testing.T) {
	h := newHarness(t)
	s := NewUIStateService(h.core)
	if m, err := s.Get(); err != nil || len(m) != 0 {
		t.Fatalf("empty = %v %v", m, err)
	}
	if err := s.Set("panels.main", `{"sidebar":22.5,"workspace":77.5}`); err != nil {
		t.Fatal(err)
	}
	if err := s.Set("columns.kv", `0.35`); err != nil {
		t.Fatal(err)
	}
	m, err := s.Get()
	if err != nil || m["panels.main"] != `{"sidebar":22.5,"workspace":77.5}` || m["columns.kv"] != "0.35" {
		t.Fatalf("got %v %v", m, err)
	}
	if err := s.Set("columns.kv", ""); err != nil {
		t.Fatal(err)
	}
	if m, _ := s.Get(); len(m) != 1 {
		t.Fatalf("after clear = %v", m)
	}

	bad := []struct{ name, key, value string }{
		{"empty key", "", "1"},
		{"long key", strings.Repeat("k", maxUIStateKey+1), "1"},
		{"invalid json", "k", "{"},
		{"too large", "k", `"` + strings.Repeat("x", maxUIStateValue) + `"`},
	}
	for _, b := range bad {
		if err := s.Set(b.key, b.value); err == nil {
			t.Errorf("%s: expected error", b.name)
		}
	}
}

func TestWindowStateStoreRoundTrip(t *testing.T) {
	h := newHarness(t)
	store := h.core.WindowStateStore()
	want := windowstate.State{X: 5, Y: 6, Width: 1000, Height: 700, Positioned: true}
	if err := store.SetSetting(windowstate.Key, want); err != nil {
		t.Fatal(err)
	}
	got := windowstate.Load(store, windowstate.Limits{MinWidth: 900, MinHeight: 560, DefaultWidth: 1280, DefaultHeight: 800})
	if got != want {
		t.Fatalf("got %+v, want %+v", got, want)
	}
}
