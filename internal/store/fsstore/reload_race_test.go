package fsstore

import (
	"fmt"
	"path/filepath"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/fsnotify/fsnotify"

	"pakpos/internal/core/model"
)

// A reload racing with saves must never drop a request that is on disk from
// the index (regression: Reload scanned unlocked and then swapped in its
// stale snapshot, so the request read as "not found" — seen on Windows CI,
// where folder events make reloads frequent).
func TestReloadDoesNotDropConcurrentSaves(t *testing.T) {
	ws := newWS(t)
	col := mustCol(t, ws, "API")

	stop := make(chan struct{})
	var wg sync.WaitGroup
	wg.Add(1)
	go func() {
		defer wg.Done()
		for {
			select {
			case <-stop:
				return
			default:
				ws.Reload()
			}
		}
	}()

	for i := range 200 {
		r, err := ws.CreateRequest(col.ID, model.Request{Name: fmt.Sprintf("Req %d", i), Method: "GET", URL: "http://x"})
		if err != nil {
			close(stop)
			wg.Wait()
			t.Fatal(err)
		}
		if _, err := ws.RenameRequest(r.ID, fmt.Sprintf("Renamed %d", i)); err != nil {
			close(stop)
			wg.Wait()
			t.Fatalf("rename right after create: %v", err)
		}
	}
	close(stop)
	wg.Wait()

	if n := len(ws.Tree().Collections[0].Requests); n != 200 {
		t.Fatalf("requests in index = %d, want 200", n)
	}
}

// Windows reports a Write on a folder whenever a file inside it changes. That
// must not trigger a reload; the file's own event decides.
func TestWatcherIgnoresDirectoryWriteEvents(t *testing.T) {
	ws := newWS(t)
	col := mustCol(t, ws, "API")
	var calls atomic.Int32
	w, err := ws.Watch(testDebounce, func([]Problem) { calls.Add(1) })
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = w.Close() })

	dir := filepath.Join(ws.Root(), CollectionsDir, ws.collections[col.ID].dir)
	w.handle(fsnotify.Event{Name: dir, Op: fsnotify.Write})
	time.Sleep(4 * testDebounce)
	if n := calls.Load(); n != 0 {
		t.Fatalf("directory Write triggered %d reloads, want 0", n)
	}

	// A Write on a file that the app did not write still reloads.
	w.handle(fsnotify.Event{Name: filepath.Join(dir, "external.yaml"), Op: fsnotify.Write})
	waitFor(t, func() bool { return calls.Load() == 1 })
}

func TestIsDirWrite(t *testing.T) {
	dir := t.TempDir()
	tests := []struct {
		ev   fsnotify.Event
		want bool
	}{
		{fsnotify.Event{Name: dir, Op: fsnotify.Write}, true},
		{fsnotify.Event{Name: dir, Op: fsnotify.Create}, false},
		{fsnotify.Event{Name: dir, Op: fsnotify.Write | fsnotify.Chmod}, false},
		{fsnotify.Event{Name: filepath.Join(dir, "missing"), Op: fsnotify.Write}, false},
	}
	for _, tc := range tests {
		if got := isDirWrite(tc.ev); got != tc.want {
			t.Errorf("isDirWrite(%v) = %v, want %v", tc.ev, got, tc.want)
		}
	}
}
