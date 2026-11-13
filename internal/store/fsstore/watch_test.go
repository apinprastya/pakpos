package fsstore

import (
	"os"
	"path/filepath"
	"sync/atomic"
	"testing"
	"time"

	"pakpos/internal/core/model"
)

const testDebounce = 30 * time.Millisecond

func waitFor(t *testing.T, cond func() bool) {
	t.Helper()
	deadline := time.Now().Add(3 * time.Second)
	for time.Now().Before(deadline) {
		if cond() {
			return
		}
		time.Sleep(10 * time.Millisecond)
	}
	t.Fatal("condition not met in time")
}

func TestWatcherReloadsOnExternalChanges(t *testing.T) {
	ws := newWS(t)
	col := mustCol(t, ws, "API")
	var calls atomic.Int32
	var lastProblems atomic.Int32
	w, err := ws.Watch(testDebounce, func(p []Problem) {
		lastProblems.Store(int32(len(p)))
		calls.Add(1)
	})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = w.Close() })

	// External new request file in an existing collection.
	ext := "id: EXT1\nname: External\nmethod: DELETE\n"
	if err := os.WriteFile(filepath.Join(ws.Root(), CollectionsDir, "api", "external.yaml"), []byte(ext), 0o644); err != nil {
		t.Fatal(err)
	}
	waitFor(t, func() bool { return calls.Load() >= 1 })
	if _, err := ws.GetRequest("EXT1"); err != nil {
		t.Fatalf("external request not loaded: %v", err)
	}

	// External new collection folder: the watcher starts watching it.
	newCol := filepath.Join(ws.Root(), CollectionsDir, "ext")
	if err := os.Mkdir(newCol, 0o755); err != nil {
		t.Fatal(err)
	}
	_ = os.WriteFile(filepath.Join(newCol, CollectionFile), []byte("id: C2\nname: Ext\n"), 0o644)
	waitFor(t, func() bool { _, err := ws.GetCollection("C2"); return err == nil })
	before := calls.Load()
	_ = os.WriteFile(filepath.Join(newCol, "bad.yaml"), []byte("id: ["), 0o644)
	waitFor(t, func() bool { return calls.Load() > before && lastProblems.Load() == 1 })

	_ = col
}

func TestWatcherIgnoresOwnWritesAndIrrelevantFiles(t *testing.T) {
	ws := newWS(t)
	col := mustCol(t, ws, "API")
	var calls atomic.Int32
	w, err := ws.Watch(testDebounce, func([]Problem) { calls.Add(1) })
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = w.Close() })

	r := mustReq(t, ws, col.ID, model.Request{Name: "Mine"})
	if _, err := ws.RenameRequest(r.ID, "Renamed"); err != nil {
		t.Fatal(err)
	}
	_ = os.WriteFile(filepath.Join(ws.Root(), LocalDir+"-file"), []byte("x"), 0o644)
	_ = os.MkdirAll(filepath.Join(ws.Root(), LocalDir), 0o755)
	_ = os.WriteFile(filepath.Join(ws.Root(), LocalDir, "state"), []byte("x"), 0o644)
	_ = os.WriteFile(filepath.Join(ws.Root(), "README.md"), []byte("x"), 0o644)

	time.Sleep(10 * testDebounce)
	if n := calls.Load(); n != 0 {
		t.Fatalf("callbacks = %d, want 0", n)
	}
}

func TestWatcherCloseIsIdempotentAndStopsCallbacks(t *testing.T) {
	ws := newWS(t)
	var calls atomic.Int32
	w, err := ws.Watch(time.Hour, func([]Problem) { calls.Add(1) })
	if err != nil {
		t.Fatal(err)
	}
	_ = os.WriteFile(filepath.Join(ws.Root(), ManifestFile+".bak"), nil, 0o644)
	w.schedule() // pending timer must be stopped by Close
	if err := w.Close(); err != nil {
		t.Fatal(err)
	}
	if err := w.Close(); err != nil {
		t.Fatal(err)
	}
	w.schedule() // no-op after close
	w.fire()     // no-op after close
	if calls.Load() != 0 {
		t.Fatal("callback ran after close")
	}
}

func TestWatcherNilCallbackAndRelevance(t *testing.T) {
	ws := newWS(t)
	w, err := ws.Watch(time.Millisecond, nil)
	if err != nil {
		t.Fatal(err)
	}
	defer w.Close()
	w.fire() // must not panic with nil callback

	cases := map[string]bool{
		filepath.Join(ws.Root(), ManifestFile):                          true,
		filepath.Join(ws.Root(), CollectionsDir, "a", "b.yaml"):         true,
		filepath.Join(ws.Root(), CollectionsDir, "a", tempPrefix+"123"): false,
		filepath.Join(ws.Root(), "other.txt"):                           false,
		"relative/path":                                                 false,
	}
	for p, want := range cases {
		if got := w.relevant(p); got != want {
			t.Errorf("relevant(%s) = %v, want %v", p, got, want)
		}
	}
	if !w.watchable(filepath.Join(ws.Root(), CollectionsDir, "x")) || w.watchable(filepath.Join(ws.Root(), "x")) {
		t.Fatal("watchable wrong")
	}
}

func TestWatcherSeesFilesInFreshCollection(t *testing.T) {
	for i := 0; i < 5; i++ { // the race this guards against is timing-dependent
		ws := newWS(t)
		var calls atomic.Int32
		w, err := ws.Watch(testDebounce, func([]Problem) { calls.Add(1) })
		if err != nil {
			t.Fatal(err)
		}
		col := mustCol(t, ws, "API")
		_ = os.WriteFile(filepath.Join(ws.Root(), CollectionsDir, "api", "ext.yaml"), []byte("id: E\n"), 0o644)
		waitFor(t, func() bool { return calls.Load() > 0 })
		if _, err := ws.GetRequest("E"); err != nil {
			t.Fatal(err)
		}
		if _, err := ws.RenameCollection(col.ID, "Renamed"); err != nil {
			t.Fatal(err)
		}
		// Give the watcher a moment to process the rename (an external write in
		// the same millisecond as our own rename is not a realistic case).
		time.Sleep(5 * testDebounce)
		before := calls.Load()
		_ = os.WriteFile(filepath.Join(ws.Root(), CollectionsDir, "renamed", "ext2.yaml"), []byte("id: E2\n"), 0o644)
		waitFor(t, func() bool { return calls.Load() > before })
		_ = w.Close()
	}
}

func TestWatcherSurvivesCollectionsDirRecreate(t *testing.T) {
	ws := newWS(t)
	var calls atomic.Int32
	w, err := ws.Watch(testDebounce, func([]Problem) { calls.Add(1) })
	if err != nil {
		t.Fatal(err)
	}
	defer w.Close()
	colRoot := filepath.Join(ws.Root(), CollectionsDir)
	_ = os.RemoveAll(colRoot)
	waitFor(t, func() bool { return calls.Load() > 0 })
	_ = os.MkdirAll(filepath.Join(colRoot, "x"), 0o755)
	_ = os.WriteFile(filepath.Join(colRoot, "x", CollectionFile), []byte("id: X\n"), 0o644)
	waitFor(t, func() bool { _, err := ws.GetCollection("X"); return err == nil })
}
