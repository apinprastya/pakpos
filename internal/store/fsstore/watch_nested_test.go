package fsstore

import (
	"os"
	"path/filepath"
	"runtime"
	"sync/atomic"
	"testing"
	"time"

	"github.com/fsnotify/fsnotify"

	"pakpos/internal/core/model"
)

func watchCounting(t *testing.T, ws *Workspace) *atomic.Int32 {
	t.Helper()
	var calls atomic.Int32
	w, err := ws.Watch(testDebounce, func([]Problem) { calls.Add(1) })
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = w.Close() })
	return &calls
}

func writeFile(t *testing.T, path, content string) {
	t.Helper()
	if err := os.WriteFile(path, []byte(content), 0o644); err != nil {
		t.Fatal(err)
	}
}

func requestLoaded(ws *Workspace, id string) func() bool {
	return func() bool { _, err := ws.GetRequest(id); return err == nil }
}

func requestName(ws *Workspace, id string) string {
	ws.mu.Lock()
	defer ws.mu.Unlock()
	if r, ok := ws.requests[id]; ok {
		return r.summary.Name
	}
	return ""
}

// External tools (git, editors) create, edit, rename and delete nested folders and requests.
func TestWatcherNestedExternalChanges(t *testing.T) {
	ws := newWS(t)
	mustCol(t, ws, "API")
	watchCounting(t, ws)
	colDir := filepath.Join(ws.Root(), CollectionsDir, "api")

	// Create a nested folder chain in one go, then a request at the bottom.
	deep := filepath.Join(colDir, "a", "b")
	if err := os.MkdirAll(deep, 0o755); err != nil {
		t.Fatal(err)
	}
	writeFile(t, filepath.Join(colDir, "a", FolderFile), "id: FA\nname: A\n")
	writeFile(t, filepath.Join(deep, FolderFile), "id: FB\nname: B\n")
	writeFile(t, filepath.Join(deep, "r.yaml"), "id: R1\nname: First\n")
	waitFor(t, requestLoaded(ws, "R1"))
	if p, _ := ws.RequestParent("R1"); p != "FB" {
		t.Fatalf("parent = %s", p)
	}

	// Edits deep inside are picked up (the folder must be watched, not only created).
	writeFile(t, filepath.Join(deep, "r.yaml"), "id: R1\nname: Edited\n")
	waitFor(t, func() bool { return requestName(ws, "R1") == "Edited" })
	writeFile(t, filepath.Join(deep, "r2.yaml"), "id: R2\nname: Second\n")
	waitFor(t, requestLoaded(ws, "R2"))

	// Rename the middle folder: watches follow, so later writes inside are seen.
	if runtime.GOOS == "windows" {
		// Windows refuses to rename a directory tree that is being watched,
		// so release it first (what an editor would not be able to do).
		ws.unwatchDir(filepath.Join(colDir, "a"))
		defer ws.resumeDir(filepath.Join(colDir, "a"))
	}
	if err := os.Rename(filepath.Join(colDir, "a"), filepath.Join(colDir, "renamed")); err != nil {
		t.Fatal(err)
	}
	time.Sleep(5 * testDebounce)
	writeFile(t, filepath.Join(colDir, "renamed", "b", "r3.yaml"), "id: R3\nname: Third\n")
	waitFor(t, requestLoaded(ws, "R3"))

	// Delete a nested request, then the whole subtree.
	if err := os.Remove(filepath.Join(colDir, "renamed", "b", "r2.yaml")); err != nil {
		t.Fatal(err)
	}
	waitFor(t, func() bool { return !requestLoaded(ws, "R2")() })
	if err := os.RemoveAll(filepath.Join(colDir, "renamed")); err != nil {
		t.Fatal(err)
	}
	waitFor(t, func() bool { _, err := ws.GetFolder("FA"); return err != nil })
	if requestLoaded(ws, "R1")() || requestLoaded(ws, "R3")() {
		t.Fatal("requests of a deleted folder still loaded")
	}
}

// Folders the app creates, renames or moves are watched right away, with
// their whole subtree.
func TestWatcherFollowsAppFolderChanges(t *testing.T) {
	for i := 0; i < 3; i++ { // timing-dependent, like TestWatcherSeesFilesInFreshCollection
		ws := newWS(t)
		calls := watchCounting(t, ws)
		a := mustCol(t, ws, "A")
		b := mustCol(t, ws, "B")
		outer := mustFolder(t, ws, a.ID, "Outer")
		inner := mustFolder(t, ws, outer.ID, "Inner")
		mustReq(t, ws, inner.ID, model.Request{Name: "r"})

		// Freshly created nested folder.
		writeFile(t, filepath.Join(ws.Root(), CollectionsDir, "a", "outer", "inner", "e1.yaml"), "id: E1\n")
		waitFor(t, requestLoaded(ws, "E1"))

		// Renamed folder: its subfolders are re-watched under the new path.
		if _, err := ws.RenameFolder(outer.ID, "Renamed"); err != nil {
			t.Fatal(err)
		}
		time.Sleep(5 * testDebounce)
		writeFile(t, filepath.Join(ws.Root(), CollectionsDir, "a", "renamed", "inner", "e2.yaml"), "id: E2\n")
		waitFor(t, requestLoaded(ws, "E2"))

		// Moved to another collection.
		if _, err := ws.MoveFolder(outer.ID, b.ID, 0); err != nil {
			t.Fatal(err)
		}
		time.Sleep(5 * testDebounce)
		writeFile(t, filepath.Join(ws.Root(), CollectionsDir, "b", "renamed", "inner", "e3.yaml"), "id: E3\n")
		waitFor(t, requestLoaded(ws, "E3"))

		// Renamed collection holding nested folders.
		if _, err := ws.RenameCollection(b.ID, "Bee"); err != nil {
			t.Fatal(err)
		}
		time.Sleep(5 * testDebounce)
		before := calls.Load()
		writeFile(t, filepath.Join(ws.Root(), CollectionsDir, "bee", "renamed", "inner", "e4.yaml"), "id: E4\n")
		waitFor(t, func() bool { return calls.Load() > before && requestLoaded(ws, "E4")() })
	}
}

// The app's own folder operations don't echo back as external changes.
func TestWatcherIgnoresOwnFolderWrites(t *testing.T) {
	ws := newWS(t)
	col := mustCol(t, ws, "API")
	other := mustCol(t, ws, "Other")
	calls := watchCounting(t, ws)

	f := mustFolder(t, ws, col.ID, "F")
	g := mustFolder(t, ws, f.ID, "G")
	r := mustReq(t, ws, g.ID, model.Request{Name: "r"})
	if _, err := ws.SaveFolder(g.ID, FolderSettings{Headers: []model.KeyValue{{Key: "A", Value: "b"}}}); err != nil {
		t.Fatal(err)
	}
	if _, err := ws.MoveRequest(r.ID, f.ID, 0); err != nil {
		t.Fatal(err)
	}
	if err := ws.Reorder(f.ID, []string{g.ID}); err != nil {
		t.Fatal(err)
	}
	if err := ws.DeleteFolder(f.ID); err != nil {
		t.Fatal(err)
	}
	_ = other
	time.Sleep(10 * testDebounce)
	if n := calls.Load(); n != 0 {
		t.Fatalf("callbacks = %d, want 0", n)
	}
}

func TestWatcherHandleNestedPaths(t *testing.T) {
	ws := newWS(t)
	col := mustCol(t, ws, "API")
	mustFolder(t, ws, col.ID, "F")
	colRoot := filepath.Join(ws.Root(), CollectionsDir)
	nested := filepath.Join(colRoot, "api", "f", "new")
	if err := os.Mkdir(nested, 0o755); err != nil {
		t.Fatal(err)
	}
	newWatcher := func() *Watcher {
		return &Watcher{ws: ws, debounce: time.Hour, pendingDirs: map[string]struct{}{}, kick: make(chan struct{}, 1), stop: make(chan struct{})}
	}

	wt := newWatcher()
	wt.handle(fsnotify.Event{Name: nested, Op: fsnotify.Create})
	wt.handle(fsnotify.Event{Name: filepath.Join(colRoot, "api", "f", "x.yaml"), Op: fsnotify.Create})
	wt.handle(fsnotify.Event{Name: filepath.Join(colRoot, "api", "f", "x.yaml"), Op: fsnotify.Rename})
	wt.handle(fsnotify.Event{Name: filepath.Join(colRoot, "api", tempPrefix+"1"), Op: fsnotify.Rename})
	if _, ok := wt.pendingDirs[nested]; !ok || len(wt.pendingDirs) != 1 || wt.pendingResync {
		t.Fatalf("pending dirs = %v resync = %v", wt.pendingDirs, wt.pendingResync)
	}
	// A nested directory that goes away re-syncs the watches.
	wt.handle(fsnotify.Event{Name: filepath.Join(colRoot, "api", "f", "gone"), Op: fsnotify.Remove})
	if !wt.pendingResync {
		t.Fatal("resync not queued for a removed nested directory")
	}
	if wt.timer != nil {
		wt.timer.Stop()
	}

	for path, want := range map[string]bool{
		filepath.Join(colRoot, "a"):                           true,
		filepath.Join(colRoot, "a", "b", "c"):                 true,
		colRoot:                                               false,
		filepath.Join(ws.Root(), "x"):                         false,
		filepath.Join(ws.Root(), EnvironmentsDir, "dev.yaml"): false,
	} {
		if got := wt.watchable(path); got != want {
			t.Errorf("watchable(%s) = %v, want %v", path, got, want)
		}
	}
}

// Hidden directories (e.g. .git inside a collection) are not watched.
func TestWatcherSkipsHiddenDirectories(t *testing.T) {
	ws := newWS(t)
	mustCol(t, ws, "API")
	hidden := filepath.Join(ws.Root(), CollectionsDir, "api", ".cache")
	if err := os.Mkdir(hidden, 0o755); err != nil {
		t.Fatal(err)
	}
	w, err := ws.Watch(testDebounce, nil)
	if err != nil {
		t.Fatal(err)
	}
	defer w.Close()
	for _, p := range w.fsw.WatchList() {
		if p == hidden {
			t.Fatal("hidden directory is watched")
		}
	}
	w.addTree(filepath.Join(ws.Root(), "missing")) // no panic for vanished dirs
}
