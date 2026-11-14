package service

import (
	"context"
	"errors"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"pakpos/internal/core/model"
	"pakpos/internal/core/settings"
	"pakpos/internal/store/sqlite"
)

func TestHistoryService(t *testing.T) {
	h := newHarness(t)
	srv := httptest.NewServer(http.HandlerFunc(func(http.ResponseWriter, *http.Request) {}))
	defer srv.Close()
	var ids []int64
	for _, id := range []string{"a", "b", "c"} {
		res, _ := h.req.Send(context.Background(), id, model.Request{URL: srv.URL + "/" + id}, "")
		ids = append(ids, res.HistoryID)
	}
	page, err := h.hist.List(sqlite.HistoryFilter{Text: "/b"})
	if err != nil || page.Total != 1 {
		t.Fatalf("list = %+v %v", page, err)
	}
	if e, err := h.hist.Get(ids[0]); err != nil || e.URL != srv.URL+"/a" {
		t.Fatalf("get = %+v %v", e, err)
	}
	if err := h.hist.Delete(ids[0]); err != nil {
		t.Fatal(err)
	}
	if _, err := h.hist.Get(ids[0]); !errors.Is(err, sqlite.ErrNotFound) {
		t.Fatal("not deleted")
	}
	if err := h.hist.Clear(); err != nil {
		t.Fatal(err)
	}
	if p, _ := h.hist.List(sqlite.HistoryFilter{}); p.Total != 0 {
		t.Fatal("not cleared")
	}
}

func TestSettingsService(t *testing.T) {
	h := newHarness(t)
	if h.set.Get() != settings.Defaults() || h.set.Defaults() != settings.Defaults() {
		t.Fatal("defaults")
	}
	bad := settings.Defaults()
	bad.MaxRedirects = 0
	if _, err := h.set.Set(bad); err == nil {
		t.Fatal("invalid settings accepted")
	}

	next := settings.Defaults()
	next.TimeoutMs, next.VerifyTLS, next.FollowRedirects, next.Theme = 2500, false, false, settings.ThemeDark
	got, err := h.set.Set(next)
	if err != nil || got != next || h.set.Get() != next {
		t.Fatalf("set = %+v %v", got, err)
	}
	es := h.core.executor().Settings()
	if es.Timeout != 2500*time.Millisecond || !es.InsecureSkipVerify || es.FollowRedirects {
		t.Fatalf("executor not reconfigured: %+v", es)
	}

	// Persisted across restarts.
	_ = h.core.Close()
	c2, err := NewCore(Config{DataDir: h.dataDir, Dialogs: &fakeDialogs{}, Events: &fakeEvents{}})
	if err != nil {
		t.Fatal(err)
	}
	defer c2.Close()
	if NewSettingsService(c2).Get() != next {
		t.Fatal("settings not persisted")
	}
	_ = c2.db.Close()
	if _, err := NewSettingsService(c2).Set(next); err == nil {
		t.Fatal("expected db error")
	}
}

func TestSettingsLowerRetentionPrunes(t *testing.T) {
	h := newHarness(t)
	srv := httptest.NewServer(http.HandlerFunc(func(http.ResponseWriter, *http.Request) {}))
	defer srv.Close()
	for _, id := range []string{"a", "b", "c"} {
		_, _ = h.req.Send(context.Background(), id, model.Request{URL: srv.URL}, "")
	}
	s := h.set.Get()
	s.HistoryRetention = 1
	if _, err := h.set.Set(s); err != nil {
		t.Fatal(err)
	}
	if p, _ := h.hist.List(sqlite.HistoryFilter{}); p.Total != 1 {
		t.Fatalf("total = %d", p.Total)
	}
	s.HistoryRetention = 0 // keep all: no pruning
	if _, err := h.set.Set(s); err != nil {
		t.Fatal(err)
	}
}

// Retention is per workspace: a send trims only its own workspace's history.
func TestRetentionIsPerWorkspace(t *testing.T) {
	h := newHarness(t)
	srv := httptest.NewServer(http.HandlerFunc(func(http.ResponseWriter, *http.Request) {}))
	defer srv.Close()
	s := h.set.Get()
	s.HistoryRetention = 2
	if _, err := h.set.Set(s); err != nil {
		t.Fatal(err)
	}
	send := func(id string) {
		t.Helper()
		if _, err := h.req.Send(context.Background(), id, model.Request{URL: srv.URL}, ""); err != nil {
			t.Fatal(err)
		}
	}
	a := h.openWorkspace(t)
	send("a1")
	send("a2")
	h.openWorkspace(t)
	for _, id := range []string{"b1", "b2", "b3"} {
		send(id)
	}
	if p, _ := h.hist.List(sqlite.HistoryFilter{}); p.Total != 2 {
		t.Fatalf("workspace B kept %d", p.Total)
	}
	if _, err := h.ws.Open(a.Path); err != nil {
		t.Fatal(err)
	}
	if p, _ := h.hist.List(sqlite.HistoryFilter{}); p.Total != 2 {
		t.Fatalf("workspace A was trimmed by B's sends: %d", p.Total)
	}
	// Lowering the limit trims every workspace.
	s.HistoryRetention = 1
	if _, err := h.set.Set(s); err != nil {
		t.Fatal(err)
	}
	if p, _ := h.hist.List(sqlite.HistoryFilter{}); p.Total != 1 {
		t.Fatalf("workspace A after lowering = %d", p.Total)
	}
}
