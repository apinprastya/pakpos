package fsstore

import (
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"

	"github.com/fsnotify/fsnotify"
)

// Watcher reloads the workspace when files change outside the app (git pull,
// editor) and notifies a callback, debounced. Changes made through the
// Workspace itself are ignored.
type Watcher struct {
	ws       *Workspace
	fsw      *fsnotify.Watcher
	debounce time.Duration
	onChange func([]Problem)

	mu     sync.Mutex
	timer  *time.Timer
	closed bool
	done   chan struct{}
}

// Watch starts watching the workspace. onChange runs after the workspace has
// been reloaded, on the watcher's goroutine, with any load problems.
func (w *Workspace) Watch(debounce time.Duration, onChange func([]Problem)) (*Watcher, error) {
	fsw, err := fsnotify.NewWatcher()
	if err != nil {
		return nil, err
	}
	wt := &Watcher{ws: w, fsw: fsw, debounce: debounce, onChange: onChange, done: make(chan struct{})}
	wt.add(w.root)
	wt.resync()
	w.watchersMu.Lock()
	w.watchers[wt] = struct{}{}
	w.watchersMu.Unlock()
	go wt.loop()
	return wt, nil
}

// watchDir starts watching a collection folder the app just created, without
// waiting for the asynchronous create event, so files written into it right
// away are not missed.
func (w *Workspace) watchDir(dir string) {
	w.watchersMu.Lock()
	defer w.watchersMu.Unlock()
	for wt := range w.watchers {
		wt.add(dir)
	}
}

func (wt *Watcher) add(dir string) {
	_ = wt.fsw.Add(dir) // directories that vanish or can't be watched are skipped
}

// resync (re-)adds watches for the collections dir and every collection
// folder. fsnotify drops a folder's watch when the folder is renamed, so this
// runs after renames/removals. Adding an already-watched path is a no-op.
func (wt *Watcher) resync() {
	colRoot := filepath.Join(wt.ws.root, CollectionsDir)
	wt.add(colRoot)
	entries, err := os.ReadDir(colRoot)
	if err != nil {
		return
	}
	for _, e := range entries {
		if e.IsDir() {
			wt.add(filepath.Join(colRoot, e.Name()))
		}
	}
}

func (wt *Watcher) loop() {
	defer close(wt.done)
	for {
		select {
		case ev, ok := <-wt.fsw.Events:
			if !ok {
				return
			}
			wt.handle(ev)
		case _, ok := <-wt.fsw.Errors:
			if !ok {
				return
			}
		}
	}
}

func (wt *Watcher) handle(ev fsnotify.Event) {
	colRoot := filepath.Join(wt.ws.root, CollectionsDir)
	switch {
	case ev.Name == colRoot && (ev.Has(fsnotify.Create) || ev.Has(fsnotify.Rename) || ev.Has(fsnotify.Remove)):
		wt.resync()
	case wt.watchable(ev.Name) && (ev.Has(fsnotify.Rename) || ev.Has(fsnotify.Remove)):
		wt.resync()
	case wt.watchable(ev.Name) && ev.Has(fsnotify.Create):
		if info, err := os.Stat(ev.Name); err == nil && info.IsDir() {
			wt.add(ev.Name)
		}
	}
	if !wt.relevant(ev.Name) || wt.ws.isOwnWrite(ev.Name) {
		return
	}
	wt.schedule()
}

// watchable: only the collections dir and its direct children are watched.
func (wt *Watcher) watchable(dir string) bool {
	return filepath.Dir(dir) == filepath.Join(wt.ws.root, CollectionsDir)
}

func (wt *Watcher) relevant(path string) bool {
	rel, err := filepath.Rel(wt.ws.root, path)
	if err != nil {
		return false
	}
	base := filepath.Base(path)
	if strings.HasPrefix(base, tempPrefix) {
		return false
	}
	first := strings.Split(filepath.ToSlash(rel), "/")[0]
	return first == CollectionsDir || rel == ManifestFile
}

func (wt *Watcher) schedule() {
	wt.mu.Lock()
	defer wt.mu.Unlock()
	if wt.closed {
		return
	}
	if wt.timer != nil {
		wt.timer.Stop()
	}
	wt.timer = time.AfterFunc(wt.debounce, wt.fire)
}

func (wt *Watcher) fire() {
	wt.mu.Lock()
	closed := wt.closed
	wt.mu.Unlock()
	if closed {
		return
	}
	problems := wt.ws.Reload()
	if wt.onChange != nil {
		wt.onChange(problems)
	}
}

// Close stops watching. No new callbacks start after Close returns.
func (wt *Watcher) Close() error {
	wt.mu.Lock()
	if wt.closed {
		wt.mu.Unlock()
		return nil
	}
	wt.closed = true
	if wt.timer != nil {
		wt.timer.Stop()
	}
	wt.mu.Unlock()
	wt.ws.watchersMu.Lock()
	delete(wt.ws.watchers, wt)
	wt.ws.watchersMu.Unlock()
	err := wt.fsw.Close()
	<-wt.done
	return err
}
