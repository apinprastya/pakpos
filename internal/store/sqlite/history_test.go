package sqlite

import (
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"pakpos/internal/core/model"
)

func entry(method, url string, status int) HistoryEntry {
	return HistoryEntry{
		HistorySummary: HistorySummary{Method: method, URL: url, Status: status, DurationMs: 12.5, Size: 2},
		Request:        model.Request{Method: method, URL: url, Name: "req"},
		Response:       &model.Response{StatusCode: status, Body: "ok", Encoding: model.EncodingUTF8, Kind: model.KindText},
	}
}

func TestHistoryAddGetInline(t *testing.T) {
	s := openTest(t)
	at := time.Date(2026, 3, 4, 5, 6, 7, 0, time.UTC)
	e := entry("GET", "http://x/a", 200)
	e.CreatedAt = at
	e.WorkspaceID, e.RequestID, e.RequestName = "W1", "R1", "Get a"
	id, err := s.AddHistory(e)
	if err != nil {
		t.Fatal(err)
	}
	got, err := s.GetHistory(id)
	if err != nil {
		t.Fatal(err)
	}
	if !got.CreatedAt.Equal(at) || got.WorkspaceID != "W1" || got.RequestID != "R1" || got.RequestName != "Get a" ||
		got.Method != "GET" || got.Status != 200 || got.DurationMs != 12.5 || got.Size != 2 {
		t.Fatalf("summary = %+v", got.HistorySummary)
	}
	if got.Request.URL != "http://x/a" || got.Response == nil || got.Response.Body != "ok" || got.Response.Kind != model.KindText {
		t.Fatalf("entry = %+v resp=%+v", got.Request, got.Response)
	}
	if _, err := s.GetHistory(999); !errors.Is(err, ErrNotFound) {
		t.Fatalf("missing err = %v", err)
	}
}

func TestHistoryFailedSendAndDefaultTime(t *testing.T) {
	s := openTest(t)
	fixed := time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC)
	s.now = func() time.Time { return fixed }
	id, err := s.AddHistory(HistoryEntry{
		HistorySummary: HistorySummary{Method: "GET", URL: "http://nope", ErrorKind: "dns", ErrorMessage: "not found"},
		Request:        model.Request{Method: "GET", URL: "http://nope"},
	})
	if err != nil {
		t.Fatal(err)
	}
	got, err := s.GetHistory(id)
	if err != nil || got.Response != nil || got.ErrorKind != "dns" || !got.CreatedAt.Equal(fixed) || got.WorkspaceID != "" {
		t.Fatalf("got %+v %v", got, err)
	}
}

func TestHistoryLargeAndTruncatedBodies(t *testing.T) {
	s := openTest(t)
	big := strings.Repeat("x", InlineBodyLimit+1)
	spill := filepath.Join(t.TempDir(), "pakpos-response-1")
	_ = os.WriteFile(spill, []byte(big+"rest"), 0o600)

	e := entry("GET", "http://x/big", 200)
	e.Response.Body = big
	e.Response.Truncated = true
	e.Response.BodyPath = spill
	id, err := s.AddHistory(e)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(spill); !os.IsNotExist(err) {
		t.Fatal("spill file should have been moved")
	}
	if e.Response.BodyPath == spill || filepath.Dir(e.Response.BodyPath) != filepath.Join(s.DataDir(), BodiesDir) {
		t.Fatalf("BodyPath not rewritten in place: %s", e.Response.BodyPath)
	}
	got, err := s.GetHistory(id)
	if err != nil {
		t.Fatal(err)
	}
	if got.Response.Body != big || !got.Response.Truncated {
		t.Fatal("large body not restored")
	}
	full, err := os.ReadFile(got.Response.BodyPath)
	if err != nil || string(full) != big+"rest" || filepath.Dir(got.Response.BodyPath) != filepath.Join(s.DataDir(), BodiesDir) {
		t.Fatalf("full body at %s: %v", got.Response.BodyPath, err)
	}
	bodyFile := filepath.Join(s.DataDir(), BodiesDir, fmt.Sprintf("%d.body", id))
	if _, err := os.Stat(bodyFile); err != nil {
		t.Fatal("body file missing")
	}

	// Missing body file -> read error.
	_ = os.Rename(bodyFile, bodyFile+".bak")
	if _, err := s.GetHistory(id); err == nil {
		t.Fatal("expected error for missing body file")
	}
	_ = os.Rename(bodyFile+".bak", bodyFile)

	if err := s.DeleteHistory(id); err != nil {
		t.Fatal(err)
	}
	for _, p := range []string{bodyFile, got.Response.BodyPath} {
		if _, err := os.Stat(p); !os.IsNotExist(err) {
			t.Fatalf("%s not removed", p)
		}
	}
}

func TestHistoryAddFailsWhenSpillMissing(t *testing.T) {
	s := openTest(t)
	e := entry("GET", "http://x", 200)
	e.Response.BodyPath = filepath.Join(t.TempDir(), "gone")
	if _, err := s.AddHistory(e); err == nil {
		t.Fatal("expected error")
	}
	if p, _ := s.ListHistory(HistoryFilter{}); p.Total != 0 {
		t.Fatal("failed add must not leave a row")
	}
}

func TestHistoryAddBodyWriteError(t *testing.T) {
	s := openTest(t)
	_ = os.RemoveAll(s.bodiesDir)
	_ = os.WriteFile(s.bodiesDir, nil, 0o600) // bodies dir is now a file
	e := entry("GET", "http://x", 200)
	e.Response.Body = strings.Repeat("y", InlineBodyLimit+1)
	if _, err := s.AddHistory(e); err == nil {
		t.Fatal("expected error")
	}
}

func TestHistoryListFilterPage(t *testing.T) {
	s := openTest(t)
	base := time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC)
	add := func(i int, method, url, ws, name string) {
		e := entry(method, url, 200)
		e.CreatedAt = base.Add(time.Duration(i) * time.Minute)
		e.WorkspaceID, e.RequestName = ws, name
		if _, err := s.AddHistory(e); err != nil {
			t.Fatal(err)
		}
	}
	add(1, "GET", "http://api/users", "W1", "List users")
	add(2, "POST", "http://api/users", "W1", "")
	add(3, "DELETE", "http://api/orders/1", "W2", "")
	add(4, "GET", "http://api/100%_done", "", "")

	all, err := s.ListHistory(HistoryFilter{})
	if err != nil || all.Total != 4 || len(all.Items) != 4 || all.Items[0].URL != "http://api/100%_done" {
		t.Fatalf("all = %+v %v", all, err)
	}
	cases := []struct {
		f    HistoryFilter
		want int
	}{
		{HistoryFilter{WorkspaceID: "W1"}, 2},
		{HistoryFilter{Text: "USERS"}, 2},
		{HistoryFilter{Text: "delete"}, 1},
		{HistoryFilter{Text: "list"}, 1},
		{HistoryFilter{Text: "%"}, 1},
		{HistoryFilter{Text: "_"}, 1},
		{HistoryFilter{Text: "users", WorkspaceID: "W2"}, 0},
	}
	for _, c := range cases {
		p, err := s.ListHistory(c.f)
		if err != nil || p.Total != c.want || len(p.Items) != c.want {
			t.Errorf("filter %+v: total=%d items=%d err=%v, want %d", c.f, p.Total, len(p.Items), err, c.want)
		}
	}
	page, _ := s.ListHistory(HistoryFilter{Offset: 1, Limit: 2})
	if page.Total != 4 || len(page.Items) != 2 || page.Items[0].Method != "DELETE" {
		t.Fatalf("page = %+v", page)
	}
}

func TestHistoryPruneClearAndOrphans(t *testing.T) {
	s := openTest(t)
	base := time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC)
	var ids []int64
	for i := 0; i < 5; i++ {
		e := entry("GET", fmt.Sprintf("http://x/%d", i), 200)
		e.CreatedAt = base // identical timestamps: id breaks ties
		e.WorkspaceID = "W1"
		if i == 0 {
			e.Response.Body = strings.Repeat("z", InlineBodyLimit+1)
		}
		id, err := s.AddHistory(e)
		if err != nil {
			t.Fatal(err)
		}
		ids = append(ids, id)
	}
	if n, err := s.PruneHistory(0); n != 0 || err != nil {
		t.Fatalf("prune 0 = %d %v", n, err)
	}
	if n, err := s.PruneHistory(10); n != 0 || err != nil {
		t.Fatalf("prune 10 = %d %v", n, err)
	}
	if n, err := s.PruneHistory(5); n != 0 || err != nil {
		t.Fatalf("prune 5 = %d %v", n, err)
	}
	n, err := s.PruneHistory(3)
	if err != nil || n != 2 {
		t.Fatalf("prune 3 = %d %v", n, err)
	}
	if _, err := s.GetHistory(ids[0]); !errors.Is(err, ErrNotFound) {
		t.Fatal("oldest should be pruned")
	}
	if _, err := os.Stat(filepath.Join(s.bodiesDir, fmt.Sprintf("%d.body", ids[0]))); !os.IsNotExist(err) {
		t.Fatal("pruned body file not removed")
	}
	if _, err := s.GetHistory(ids[2]); err != nil {
		t.Fatal("newer entries must remain")
	}

	// Orphans: stray file is removed, referenced file is kept.
	keep := entry("GET", "http://x/keep", 200)
	keep.Response.Body = strings.Repeat("k", InlineBodyLimit+1)
	keepID, _ := s.AddHistory(keep)
	_ = os.WriteFile(filepath.Join(s.bodiesDir, "999.full"), nil, 0o600)
	_ = os.Mkdir(filepath.Join(s.bodiesDir, "subdir"), 0o700)
	if n, err := s.CleanupOrphanBodies(); n != 1 || err != nil {
		t.Fatalf("orphans = %d %v", n, err)
	}
	if _, err := s.GetHistory(keepID); err != nil {
		t.Fatal("referenced body removed")
	}

	if err := s.ClearHistory("W1"); err != nil {
		t.Fatal(err)
	}
	if p, _ := s.ListHistory(HistoryFilter{}); p.Total != 1 {
		t.Fatalf("after workspace clear total = %d", p.Total)
	}
	if err := s.ClearHistory(""); err != nil {
		t.Fatal(err)
	}
	if p, _ := s.ListHistory(HistoryFilter{}); p.Total != 0 {
		t.Fatal("clear all failed")
	}
}

func TestHistoryCorruptRows(t *testing.T) {
	s := openTest(t)
	id, _ := s.AddHistory(entry("GET", "http://x", 200))
	if _, err := s.db.Exec(`UPDATE history SET response_json = '{' WHERE id = ?`, id); err != nil {
		t.Fatal(err)
	}
	if _, err := s.GetHistory(id); err == nil {
		t.Fatal("expected response decode error")
	}
	_, _ = s.db.Exec(`UPDATE history SET request_json = '{' WHERE id = ?`, id)
	if _, err := s.GetHistory(id); err == nil {
		t.Fatal("expected request decode error")
	}
}

func TestHistoryClosedDB(t *testing.T) {
	s := openTest(t)
	_ = s.Close()
	if _, err := s.AddHistory(entry("GET", "http://x", 200)); err == nil {
		t.Error("add")
	}
	if _, err := s.GetHistory(1); err == nil || errors.Is(err, ErrNotFound) {
		t.Error("get")
	}
	if _, err := s.ListHistory(HistoryFilter{}); err == nil {
		t.Error("list")
	}
	if err := s.DeleteHistory(1); err == nil {
		t.Error("delete")
	}
	if _, err := s.PruneHistory(1); err == nil {
		t.Error("prune")
	}
	if _, err := s.CleanupOrphanBodies(); err == nil {
		t.Error("cleanup")
	}
}

func TestHelpers(t *testing.T) {
	if escapeLike(`a%b_c\d`) != `a\%b\_c\\d` {
		t.Fatal(escapeLike(`a%b_c\d`))
	}
	if nullable("") != nil || nullable("x") != "x" {
		t.Fatal("nullable")
	}
	if removeIfSet("") != nil || removeIfSet(filepath.Join(t.TempDir(), "missing")) != nil {
		t.Fatal("removeIfSet")
	}
	dir := t.TempDir()
	_ = os.Mkdir(filepath.Join(dir, "d"), 0o700)
	_ = os.WriteFile(filepath.Join(dir, "d", "f"), nil, 0o600)
	if removeIfSet(filepath.Join(dir, "d")) == nil {
		t.Fatal("removing non-empty dir should fail")
	}

	// moveFile copy fallback: destination is an existing directory -> rename fails,
	// then create fails.
	src := filepath.Join(dir, "src")
	_ = os.WriteFile(src, []byte("data"), 0o600)
	if err := moveFile(src, filepath.Join(dir, "d")); err == nil {
		t.Fatal("expected error moving onto a dir")
	}
	if err := moveFile(filepath.Join(dir, "missing"), filepath.Join(dir, "x")); err == nil {
		t.Fatal("expected error for missing src")
	}
	dst := filepath.Join(dir, "dst")
	if err := moveFile(src, dst); err != nil {
		t.Fatal(err)
	}
	if b, _ := os.ReadFile(dst); string(b) != "data" {
		t.Fatal("move content")
	}
}
