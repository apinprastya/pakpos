package sqlite

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
	"testing/fstest"
	"time"
)

func openTest(t *testing.T) *Store {
	t.Helper()
	s, err := Open(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = s.Close() })
	return s
}

func TestOpenMigratesOnceAndReopens(t *testing.T) {
	dir := t.TempDir()
	s, err := Open(dir)
	if err != nil {
		t.Fatal(err)
	}
	if v, err := s.SchemaVersion(); err != nil || v != 2 {
		t.Fatalf("version = %d, %v", v, err)
	}
	if s.DataDir() != dir {
		t.Fatal("DataDir")
	}
	if err := s.SetSetting("k", 1); err != nil {
		t.Fatal(err)
	}
	_ = s.Close()

	s2, err := Open(dir)
	if err != nil {
		t.Fatal(err)
	}
	defer s2.Close()
	var v int
	if ok, err := s2.GetSetting("k", &v); !ok || err != nil || v != 1 {
		t.Fatalf("setting after reopen = %d %v %v", v, ok, err)
	}
	if _, err := os.Stat(filepath.Join(dir, BodiesDir)); err != nil {
		t.Fatal("bodies dir missing")
	}
}

func TestOpenErrors(t *testing.T) {
	file := filepath.Join(t.TempDir(), "file")
	_ = os.WriteFile(file, nil, 0o644)
	if _, err := Open(filepath.Join(file, "sub")); err == nil {
		t.Fatal("expected error when data dir is under a file")
	}
	dir := t.TempDir()
	_ = os.WriteFile(filepath.Join(dir, DBFile), []byte("not a database, definitely not sqlite"), 0o644)
	if _, err := Open(dir); err == nil {
		t.Fatal("expected error for corrupt database")
	}
}

func TestMigrations(t *testing.T) {
	s := openTest(t)
	good := fstest.MapFS{
		"migrations/0001_init.sql":  {Data: []byte("SELECT 1")},
		"migrations/0002_state.sql": {Data: []byte("SELECT 1")},
		"migrations/0003_more.sql":  {Data: []byte("CREATE TABLE extra (x INTEGER)")},
		"migrations/README.md":      {Data: []byte("ignored")},
	}
	if err := s.migrate(good); err != nil {
		t.Fatal(err)
	}
	if v, _ := s.SchemaVersion(); v != 3 {
		t.Fatalf("version = %d", v)
	}
	if err := s.migrate(good); err != nil { // idempotent
		t.Fatal(err)
	}

	cases := map[string]fstest.MapFS{
		"bad name": {"migrations/abc.sql": {Data: []byte("SELECT 1")}},
		"zero":     {"migrations/0000_x.sql": {Data: []byte("SELECT 1")}},
		"bad sql":  {"migrations/0004_bad.sql": {Data: []byte("CREATE TABLE")}},
		"no dir":   {},
	}
	for name, fsys := range cases {
		t.Run(name, func(t *testing.T) {
			if err := s.migrate(fsys); err == nil {
				t.Fatal("expected error")
			}
		})
	}
	if v, _ := s.SchemaVersion(); v != 3 {
		t.Fatalf("failed migration must not bump version, got %d", v)
	}
}

func TestMigrateOnClosedDB(t *testing.T) {
	s, err := Open(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	_ = s.Close()
	if err := s.migrate(migrationFS); err == nil {
		t.Fatal("expected error on closed db")
	}
	if err := s.applyMigration(migration{version: 9, name: "x"}, "SELECT 1"); err == nil {
		t.Fatal("expected error on closed db")
	}
}

func TestSettings(t *testing.T) {
	s := openTest(t)
	type cfg struct {
		A int    `json:"a"`
		B string `json:"b"`
	}
	var out cfg
	if ok, err := s.GetSetting("missing", &out); ok || err != nil {
		t.Fatalf("missing: %v %v", ok, err)
	}
	if err := s.SetSetting("cfg", cfg{1, "x"}); err != nil {
		t.Fatal(err)
	}
	if err := s.SetSetting("cfg", cfg{2, "y"}); err != nil {
		t.Fatal(err)
	}
	if ok, err := s.GetSetting("cfg", &out); !ok || err != nil || out != (cfg{2, "y"}) {
		t.Fatalf("got %+v %v %v", out, ok, err)
	}
	if err := s.SetSetting("bad", make(chan int)); err == nil {
		t.Fatal("expected encode error")
	}
	var n int
	if _, err := s.GetSetting("cfg", &n); err == nil {
		t.Fatal("expected decode error")
	}
	_ = s.Close()
	if _, err := s.GetSetting("cfg", &out); err == nil {
		t.Fatal("expected error on closed db")
	}
	if err := s.SetSetting("cfg", 1); err == nil {
		t.Fatal("expected error on closed db")
	}
}

func TestRecentWorkspaces(t *testing.T) {
	s := openTest(t)
	clock := time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC)
	s.now = func() time.Time { clock = clock.Add(time.Minute); return clock }

	for _, p := range []string{"/a", "/b", "/c"} {
		if err := s.TouchRecent(p, strings.TrimPrefix(p, "/")); err != nil {
			t.Fatal(err)
		}
	}
	if err := s.TouchRecent("/a", "A renamed"); err != nil {
		t.Fatal(err)
	}
	all, err := s.ListRecent(0)
	if err != nil || len(all) != 3 || all[0].Path != "/a" || all[0].Name != "A renamed" || all[1].Path != "/c" {
		t.Fatalf("recent = %+v %v", all, err)
	}
	if all[0].LastOpened.Location() != time.UTC || !all[0].LastOpened.After(all[1].LastOpened) {
		t.Fatal("LastOpened ordering/zone wrong")
	}
	two, _ := s.ListRecent(2)
	if len(two) != 2 {
		t.Fatalf("limit: %d", len(two))
	}
	if err := s.RemoveRecent("/c"); err != nil {
		t.Fatal(err)
	}
	if left, _ := s.ListRecent(0); len(left) != 2 {
		t.Fatalf("after remove: %+v", left)
	}

	_ = s.Close()
	if err := s.TouchRecent("/x", "x"); err == nil {
		t.Fatal("expected error")
	}
	if _, err := s.ListRecent(0); err == nil {
		t.Fatal("expected error")
	}
	if err := s.RemoveRecent("/x"); err == nil {
		t.Fatal("expected error")
	}
}
