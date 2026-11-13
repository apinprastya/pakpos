package service

import (
	"errors"
	"fmt"
	"log/slog"
	"net/http"
	"net/http/cookiejar"
	"os"
	"path/filepath"
	"sync"
	"time"

	"golang.org/x/net/publicsuffix"

	"pakpos/internal/core/httpexec"
	"pakpos/internal/core/settings"
	"pakpos/internal/store/fsstore"
	"pakpos/internal/store/sqlite"
)

// Dialogs shows native dialogs. Every method returns "" when the user cancels.
// main.go implements it with Wails; tests use a fake.
type Dialogs interface {
	PickFolder(title string) (string, error)
	PickFile(title string) (string, error)
	SaveFile(title, defaultName string) (string, error)
}

// Events sends events to the frontend. main.go implements it with Wails.
type Events interface {
	Emit(name string, data any)
}

// EventWorkspaceChanged fires when workspace files change outside the app.
const EventWorkspaceChanged = "workspace:changed"

// WorkspaceChangedEvent is the payload of EventWorkspaceChanged.
type WorkspaceChangedEvent struct {
	WorkspaceID string            `json:"workspaceId"`
	Problems    []fsstore.Problem `json:"problems"`
}

// ErrNoWorkspace is returned by workspace operations when none is open.
var ErrNoWorkspace = errors.New("no workspace is open; open or create a workspace first")

// settingsKey is where the app settings live in the settings table.
const settingsKey = "app"

// tempDirName holds spilled response bodies until history takes them over.
const tempDirName = "tmp"

// Config configures a Core.
type Config struct {
	DataDir string
	Dialogs Dialogs
	Events  Events
	// WatchDebounce delays reloads after external file changes (default 300ms).
	WatchDebounce time.Duration
	Logger        *slog.Logger
}

// Core is the state shared by all services: the database, the open
// workspace, the HTTP executor and settings. It is safe for concurrent use.
type Core struct {
	db       *sqlite.Store
	dialogs  Dialogs
	events   Events
	log      *slog.Logger
	tempDir  string
	debounce time.Duration

	mu       sync.RWMutex
	ws       *fsstore.Workspace
	watcher  *fsstore.Watcher
	exec     *httpexec.Executor
	jar      http.CookieJar
	settings settings.Settings

	sendsMu sync.Mutex
	sends   map[string]func()
}

// DefaultDataDir is where app data lives: <user config dir>/pakpos.
func DefaultDataDir() (string, error) {
	base, err := os.UserConfigDir()
	if err != nil {
		return "", fmt.Errorf("find config dir: %w", err)
	}
	return filepath.Join(base, "pakpos"), nil
}

// NewCore opens the database in cfg.DataDir, loads settings and cleans up
// leftovers from previous runs.
func NewCore(cfg Config) (*Core, error) {
	if cfg.Dialogs == nil || cfg.Events == nil {
		return nil, errors.New("dialogs and events are required")
	}
	db, err := sqlite.Open(cfg.DataDir)
	if err != nil {
		return nil, err
	}
	c := &Core{
		db:       db,
		dialogs:  cfg.Dialogs,
		events:   cfg.Events,
		log:      cfg.Logger,
		tempDir:  filepath.Join(cfg.DataDir, tempDirName),
		debounce: cfg.WatchDebounce,
		sends:    map[string]func(){},
	}
	if c.log == nil {
		c.log = slog.Default()
	}
	if c.debounce <= 0 {
		c.debounce = 300 * time.Millisecond
	}
	if err := os.MkdirAll(c.tempDir, 0o700); err != nil {
		_ = db.Close()
		return nil, fmt.Errorf("create temp dir: %w", err)
	}
	// Nothing is in flight at startup, so every leftover spill is an orphan.
	if _, err := httpexec.CleanupSpills(c.tempDir, 0, time.Now()); err != nil {
		c.log.Warn("cleanup temp bodies", "err", err)
	}
	if _, err := db.CleanupOrphanBodies(); err != nil {
		c.log.Warn("cleanup stored bodies", "err", err)
	}

	s := settings.Defaults()
	if _, err := db.GetSetting(settingsKey, &s); err != nil || s.Validate() != nil {
		c.log.Warn("stored settings ignored, using defaults", "err", err)
		s = settings.Defaults()
	}
	c.settings = s
	c.resetExecutorLocked(true)
	return c, nil
}

// Close stops the watcher and closes the database.
func (c *Core) Close() error {
	c.mu.Lock()
	c.closeWorkspaceLocked()
	c.mu.Unlock()
	return c.db.Close()
}

// resetExecutorLocked rebuilds the executor from the current settings. With
// newJar, cookies are forgotten (used when switching workspaces). In-flight
// sends keep the executor they started with.
func (c *Core) resetExecutorLocked(newJar bool) {
	if newJar || c.jar == nil {
		jar, _ := cookiejar.New(&cookiejar.Options{PublicSuffixList: publicsuffix.List}) // never fails
		c.jar = jar
	}
	base := httpexec.DefaultSettings()
	base.TempDir = c.tempDir
	base.Jar = c.jar
	c.exec = httpexec.New(c.settings.Executor(base))
}

func (c *Core) executor() *httpexec.Executor {
	c.mu.RLock()
	defer c.mu.RUnlock()
	return c.exec
}

func (c *Core) currentSettings() settings.Settings {
	c.mu.RLock()
	defer c.mu.RUnlock()
	return c.settings
}

// workspace returns the open workspace or ErrNoWorkspace.
func (c *Core) workspace() (*fsstore.Workspace, error) {
	c.mu.RLock()
	defer c.mu.RUnlock()
	if c.ws == nil {
		return nil, ErrNoWorkspace
	}
	return c.ws, nil
}

// setWorkspace replaces the open workspace, restarts the watcher and resets cookies.
func (c *Core) setWorkspace(ws *fsstore.Workspace) {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.closeWorkspaceLocked()
	c.ws = ws
	id := ws.Manifest().ID
	w, err := ws.Watch(c.debounce, func(problems []fsstore.Problem) {
		if problems == nil {
			problems = []fsstore.Problem{}
		}
		c.events.Emit(EventWorkspaceChanged, WorkspaceChangedEvent{WorkspaceID: id, Problems: problems})
	})
	if err != nil {
		c.log.Warn("watch workspace; external changes won't be picked up", "err", err)
	}
	c.watcher = w
	c.resetExecutorLocked(true)
}

func (c *Core) closeWorkspaceLocked() {
	if c.watcher != nil {
		_ = c.watcher.Close()
		c.watcher = nil
	}
	if c.ws != nil {
		c.ws = nil
		c.resetExecutorLocked(true)
	}
}

// registerSend tracks an in-flight send so Cancel can stop it.
func (c *Core) registerSend(id string, cancel func()) error {
	c.sendsMu.Lock()
	defer c.sendsMu.Unlock()
	if _, ok := c.sends[id]; ok {
		return fmt.Errorf("a request with send id %q is already running", id)
	}
	c.sends[id] = cancel
	return nil
}

func (c *Core) unregisterSend(id string) {
	c.sendsMu.Lock()
	delete(c.sends, id)
	c.sendsMu.Unlock()
}

func (c *Core) cancelSend(id string) bool {
	c.sendsMu.Lock()
	cancel, ok := c.sends[id]
	c.sendsMu.Unlock()
	if ok {
		cancel()
	}
	return ok
}
