package service

import (
	"errors"
	"os"
	"path/filepath"
	"testing"

	"pakpos/internal/store/fsstore"
)

func TestWorkspaceServiceWithoutWorkspace(t *testing.T) {
	h := newHarness(t)
	if h.ws.Current() != nil {
		t.Fatal("Current should be nil")
	}
	checks := map[string]error{
		"tree":    func() error { _, e := h.ws.Tree(); return e }(),
		"create":  func() error { _, e := h.ws.CreateCollection("x"); return e }(),
		"rename":  func() error { _, e := h.ws.RenameCollection("x", "y"); return e }(),
		"delete":  h.ws.DeleteCollection("x"),
		"reorder": h.ws.ReorderCollections(nil),
		"get col": func() error { _, e := h.ws.GetCollection("x"); return e }(),
		"save col": func() error {
			_, e := h.ws.SaveCollection("x", fsstore.CollectionSettings{}, nil)
			return e
		}(),
		"create folder": func() error { _, e := h.ws.CreateFolder("x", "y"); return e }(),
		"get folder":    func() error { _, e := h.ws.GetFolder("x"); return e }(),
		"rename folder": func() error { _, e := h.ws.RenameFolder("x", "y"); return e }(),
		"save folder":   func() error { _, e := h.ws.SaveFolder("x", fsstore.FolderSettings{}); return e }(),
		"delete folder": h.ws.DeleteFolder("x"),
		"move request":  func() error { _, e := h.ws.MoveRequest("x", "y", 0); return e }(),
		"move folder":   func() error { _, e := h.ws.MoveFolder("x", "y", 0); return e }(),
		"reorder items": h.ws.Reorder("x", nil),
	}
	for name, err := range checks {
		if !errors.Is(err, ErrNoWorkspace) {
			t.Errorf("%s err = %v", name, err)
		}
	}
	h.ws.Close() // no-op
}

func TestWorkspaceServiceLifecycle(t *testing.T) {
	h := newHarness(t)
	dir := t.TempDir()
	info, err := h.ws.Create(dir, "Demo")
	if err != nil {
		t.Fatal(err)
	}
	if cur := h.ws.Current(); cur == nil || *cur != info || info.Name != "Demo" || info.Path != dir {
		t.Fatalf("current = %+v info=%+v", cur, info)
	}
	if _, err := h.ws.Create(dir, "again"); !errors.Is(err, fsstore.ErrAlreadyExists) {
		t.Fatalf("create twice: %v", err)
	}

	a, err := h.ws.CreateCollection("  Users ")
	if err != nil || a.Name != "Users" {
		t.Fatalf("create col = %+v %v", a, err)
	}
	b, _ := h.ws.CreateCollection("Orders")
	if _, err := h.ws.RenameCollection(a.ID, "Accounts"); err != nil {
		t.Fatal(err)
	}
	if err := h.ws.ReorderCollections([]string{b.ID, a.ID}); err != nil {
		t.Fatal(err)
	}
	tree, err := h.ws.Tree()
	if err != nil || len(tree.Collections) != 2 || tree.Collections[0].ID != b.ID || tree.Problems == nil {
		t.Fatalf("tree = %+v %v", tree, err)
	}
	if err := h.ws.DeleteCollection(b.ID); err != nil {
		t.Fatal(err)
	}

	h.ws.Close()
	if h.ws.Current() != nil {
		t.Fatal("still open after Close")
	}
	reopened, err := h.ws.Open(dir)
	if err != nil || reopened.ID != info.ID {
		t.Fatalf("reopen = %+v %v", reopened, err)
	}
	if _, err := h.ws.Open(t.TempDir()); !errors.Is(err, fsstore.ErrNotWorkspace) {
		t.Fatalf("open non-workspace: %v", err)
	}

	recent, err := h.ws.Recent()
	if err != nil || len(recent) != 1 || recent[0].Path != dir || recent[0].Name != "Demo" {
		t.Fatalf("recent = %+v %v", recent, err)
	}
	if err := h.ws.RemoveRecent(dir); err != nil {
		t.Fatal(err)
	}
	if recent, _ := h.ws.Recent(); len(recent) != 0 {
		t.Fatal("recent not removed")
	}
}

func TestWorkspaceServicePickFolder(t *testing.T) {
	h := newHarness(t)
	h.dialogs.folder = "/chosen"
	if p, err := h.ws.PickFolder(); p != "/chosen" || err != nil {
		t.Fatalf("got %s %v", p, err)
	}
	h.dialogs.err = errDialog
	if _, err := h.ws.PickFolder(); !errors.Is(err, errDialog) {
		t.Fatal("dialog error not passed through")
	}
}

func TestWorkspaceServiceEmitsExternalChanges(t *testing.T) {
	h := newHarness(t)
	info := h.openWorkspace(t)
	col, _ := h.ws.CreateCollection("API")
	_ = col
	p := filepath.Join(info.Path, fsstore.CollectionsDir, "api", "ext.yaml")
	if err := os.WriteFile(p, []byte("id: [broken"), 0o644); err != nil {
		t.Fatal(err)
	}
	waitUntil(t, func() bool { return len(h.events.all()) > 0 })
	ev := h.events.all()[0]
	payload, ok := ev.data.(WorkspaceChangedEvent)
	if ev.name != EventWorkspaceChanged || !ok || payload.WorkspaceID != info.ID || len(payload.Problems) != 1 {
		t.Fatalf("event = %+v", ev)
	}

	// No problems -> empty (not nil) slice for clean JSON.
	_ = os.Remove(p)
	waitUntil(t, func() bool { return len(h.events.all()) > 1 })
	last := h.events.all()[len(h.events.all())-1].data.(WorkspaceChangedEvent)
	if last.Problems == nil || len(last.Problems) != 0 {
		t.Fatalf("problems = %#v", last.Problems)
	}
}

func TestRecordRecentFailureDoesNotBlockOpen(t *testing.T) {
	h := newHarness(t)
	dir := t.TempDir()
	if _, err := fsstore.Create(dir, "x"); err != nil {
		t.Fatal(err)
	}
	_ = h.core.db.Close() // recent list can't be written
	if _, err := h.ws.Open(dir); err != nil {
		t.Fatalf("open should still succeed: %v", err)
	}
}
