package service

import (
	"errors"
	"io"
	"log/slog"
	"sync"
	"testing"
	"time"

	"pakpos/internal/secrets"
)

type fakeDialogs struct {
	folder, file, save string
	err                error
	lastDefaultName    string
}

func (f *fakeDialogs) PickFolder(string) (string, error) { return f.folder, f.err }
func (f *fakeDialogs) PickFile(string) (string, error)   { return f.file, f.err }
func (f *fakeDialogs) SaveFile(_, def string) (string, error) {
	f.lastDefaultName = def
	return f.save, f.err
}

type emitted struct {
	name string
	data any
}

type fakeEvents struct {
	mu     sync.Mutex
	events []emitted
}

func (f *fakeEvents) Emit(name string, data any) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.events = append(f.events, emitted{name, data})
}

func (f *fakeEvents) all() []emitted {
	f.mu.Lock()
	defer f.mu.Unlock()
	return append([]emitted{}, f.events...)
}

var errDialog = errors.New("dialog failed")

type harness struct {
	core    *Core
	dialogs *fakeDialogs
	events  *fakeEvents
	ws      *WorkspaceService
	req     *RequestService
	hist    *HistoryService
	set     *SettingsService
	env     *EnvService
	secrets *secrets.Fake
	dataDir string
}

func newHarness(t *testing.T) *harness {
	t.Helper()
	h := &harness{dialogs: &fakeDialogs{}, events: &fakeEvents{}, dataDir: t.TempDir(), secrets: secrets.NewFake()}
	return h.start(t, h.secrets)
}

// newHarnessWith uses store as the secret store (e.g. a real FileStore in a temp dir).
func newHarnessWith(t *testing.T, store secrets.Store) *harness {
	t.Helper()
	h := &harness{dialogs: &fakeDialogs{}, events: &fakeEvents{}, dataDir: t.TempDir()}
	return h.start(t, store)
}

func (h *harness) start(t *testing.T, store secrets.Store) *harness {
	t.Helper()
	c, err := NewCore(Config{DataDir: h.dataDir, Dialogs: h.dialogs, Events: h.events, WatchDebounce: 20 * time.Millisecond,
		Secrets: store, Logger: slog.New(slog.NewTextHandler(io.Discard, nil))})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = c.Close() })
	h.core = c
	h.ws, h.req, h.hist, h.set = NewWorkspaceService(c), NewRequestService(c), NewHistoryService(c), NewSettingsService(c)
	h.env = NewEnvService(c)
	return h
}

func (h *harness) openWorkspace(t *testing.T) WorkspaceInfo {
	t.Helper()
	info, err := h.ws.Create(t.TempDir(), "Test WS")
	if err != nil {
		t.Fatal(err)
	}
	return info
}

func waitUntil(t *testing.T, cond func() bool) {
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
