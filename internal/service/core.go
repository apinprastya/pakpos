package service

import (
	"errors"
	"fmt"
	"log/slog"
	"net/http"
	"os"
	"path/filepath"
	"sync"
	"time"

	"pakpos/internal/core/cookies"
	"pakpos/internal/core/httpexec"
	"pakpos/internal/core/script"
	"pakpos/internal/core/settings"
	"pakpos/internal/hookserver"
	"pakpos/internal/pipeline"
	"pakpos/internal/secrets"
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

// AppControl does what needs the running Wails app outside dialogs and
// events: opening a URL in the browser and quitting. main.go implements it.
type AppControl interface {
	OpenURL(url string) error
	Quit()
}

// EventScriptConsole carries a send's script console output while it runs
// (one event per script run that logged something), masked.
const EventScriptConsole = "script:console"

// ScriptConsoleEvent is the payload of EventScriptConsole.
type ScriptConsoleEvent struct {
	SendID  string                `json:"sendId"`
	Entries []script.ConsoleEntry `json:"entries"`
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
	// Secrets stores secret variable values. main.go passes the keychain or
	// the encrypted file (secrets.Select); tests pass secrets.Fake. When nil,
	// the encrypted file store in DataDir is used (never the keychain).
	Secrets secrets.Store
	// WatchDebounce delays reloads after external file changes (default 300ms).
	WatchDebounce time.Duration
	Logger        *slog.Logger
	// Tunnel opens webhook tunnels; nil uses cloudflared (tests pass a fake).
	Tunnel hookserver.TunnelStarter
}

// Core is the state shared by all services: the database, the secret store,
// the open workspace, the HTTP executor and settings. It is safe for
// concurrent use.
type Core struct {
	dataDir  string
	db       *sqlite.Store
	secrets  secrets.Store
	dialogs  Dialogs
	events   Events
	log      *slog.Logger
	tempDir  string
	debounce time.Duration
	// started is when this Core was created: secret keys written since are
	// never pruned (they may belong to an unsaved secret row).
	started time.Time
	// transports is shared by every executor, so pooled connections survive
	// a workspace switch or a settings change that doesn't touch the network.
	transports *httpexec.Transports
	// oauth gets and refreshes OAuth 2.0 tokens through the current
	// executor's transports; one per Core so refreshes are serialised.
	oauth *pipeline.OAuth2
	// hooks runs webhook test servers. It outlives workspace switches: a
	// webhook keeps running with the rules it last loaded.
	hooks *hookserver.Manager

	mu      sync.RWMutex
	ws      *fsstore.Workspace
	watcher *fsstore.Watcher
	exec    *httpexec.Executor
	// jar holds the open workspace's cookies ("" workspace when none is
	// open); persistent ones are stored in SQLite.
	jar      *cookies.Jar
	settings settings.Settings
	// overlay holds the values scripts set in the open workspace; a new
	// one starts with every workspace opened, so it never outlives it.
	overlay   *pipeline.Overlay
	overlayWS string

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
	sec := cfg.Secrets
	if sec == nil {
		sec = secrets.NewFileStore(cfg.DataDir)
	}
	c := &Core{
		dataDir:  cfg.DataDir,
		db:       db,
		secrets:  sec,
		dialogs:  cfg.Dialogs,
		events:   cfg.Events,
		log:      cfg.Logger,
		tempDir:  filepath.Join(cfg.DataDir, tempDirName),
		debounce: cfg.WatchDebounce,
		started:  time.Now(),
		sends:    map[string]func(){},

		transports: httpexec.NewTransports(),
	}
	if c.log == nil {
		c.log = slog.Default()
	}
	c.oauth = pipeline.NewOAuth2(func() *http.Client { return c.executor().HTTPClient() }, nil)
	startTunnel := cfg.Tunnel
	if startTunnel == nil {
		startTunnel = c.startTunnel
	}
	c.hooks = hookserver.NewManager(hookserver.Options{
		OnStatus:  func(s hookserver.Status) { c.events.Emit(EventWebhookStatus, s) },
		OnRequest: c.recordWebhookRequest,
		Tunnel:    startTunnel,
	})
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
	if _, err := db.GetSetting(settingsKey, &s); err != nil || s.Normalize().Validate() != nil {
		c.log.Warn("stored settings ignored, using defaults", "err", err)
		s = settings.Defaults()
	}
	c.settings = s.Normalize()
	c.loadJarLocked("")
	c.resetExecutorLocked()
	return c, nil
}

// Close stops running webhooks and the watcher and closes the database.
func (c *Core) Close() error {
	c.hooks.Close()
	c.mu.Lock()
	c.closeWorkspaceLocked()
	c.mu.Unlock()
	return c.db.Close()
}

// resetExecutorLocked rebuilds the executor from the current settings and
// jar. In-flight sends keep the executor they started with; every executor
// shares the transport cache.
func (c *Core) resetExecutorLocked() {
	base := httpexec.DefaultSettings()
	base.TempDir = c.tempDir
	base.Jar = c.jar
	base.Transports = c.transports
	base.Network.Secret = c.appSecret
	c.exec = httpexec.New(c.settings.Executor(base))
}

// loadJarLocked switches to the cookie jar of a workspace ("" for none):
// its persistent cookies come from SQLite (expired ones are pruned), session
// cookies start empty. A load failure is logged and leaves an empty jar that
// still saves new cookies.
func (c *Core) loadJarLocked(workspaceID string) {
	jar, err := cookies.New(cookies.Options{
		Store: c.db.Cookies(workspaceID),
		OnError: func(err error) {
			c.log.Warn("save cookie", "workspace", workspaceID, "err", err)
		},
	})
	if err != nil {
		c.log.Warn("load cookies", "workspace", workspaceID, "err", err)
	}
	c.jar = jar
}

// scriptJar is the open workspace's jar for pm.cookies (nil when there is
// none, so the interface stays nil).
func (c *Core) scriptJar() pipeline.CookieJar {
	if jar := c.cookieJar(); jar != nil {
		return jar
	}
	return nil
}

// cookieJar returns the open workspace's jar.
func (c *Core) cookieJar() *cookies.Jar {
	c.mu.RLock()
	defer c.mu.RUnlock()
	return c.jar
}

// appSecret reads an app-level password (the proxy password, a client
// certificate passphrase) from the secret store: "" when none is stored
// (also when the file store has no master password yet).
func (c *Core) appSecret(name string) (string, error) {
	v, err := c.secrets.Get(secrets.AppKey(name))
	if errors.Is(err, secrets.ErrNotFound) || errors.Is(err, secrets.ErrNoPassword) {
		return "", nil
	}
	return v, err
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

// session returns the send pipeline for ws. It records the secret keys it
// writes in the database's secret index, uses ws's script overlay and gets
// OAuth 2.0 tokens through the app's network settings.
func (c *Core) session(ws *fsstore.Workspace) *pipeline.Session {
	return pipeline.New(ws, c.secrets, c.log).WithSecretIndex(c.db).
		WithOverlay(c.overlayFor(ws.Manifest().ID)).WithOAuth2(c.oauth)
}

// overlayFor returns the script overlay of the open workspace when it is
// workspaceID, else nil (a send that outlived its workspace writes nowhere).
func (c *Core) overlayFor(workspaceID string) *pipeline.Overlay {
	c.mu.RLock()
	defer c.mu.RUnlock()
	if c.overlayWS != workspaceID {
		return nil
	}
	return c.overlay
}

// pruneSecrets deletes stored secret values the open workspace no longer
// refers to (see pipeline.PruneSecrets). It runs when a workspace opens and
// when the file store is unlocked; failures are logged, never returned.
func (c *Core) pruneSecrets() {
	ws, p, err := c.openSession()
	if err != nil {
		return
	}
	n, err := p.PruneSecrets(c.started)
	switch {
	case errors.Is(err, secrets.ErrLocked), errors.Is(err, secrets.ErrNoPassword):
		// Runs again on unlock.
	case err != nil:
		c.log.Warn("prune secret values", "workspace", ws.Manifest().ID, "err", err)
	}
	if n > 0 {
		c.log.Info("pruned unused secret values", "workspace", ws.Manifest().ID, "count", n)
	}
}

// openSession returns the open workspace and its pipeline, or ErrNoWorkspace.
func (c *Core) openSession() (*fsstore.Workspace, *pipeline.Session, error) {
	ws, err := c.workspace()
	if err != nil {
		return nil, nil, err
	}
	return ws, c.session(ws), nil
}

// selectedEnvironment returns the id of the environment selected in a
// workspace, or "" (also when it can't be read). It may name an environment
// that no longer exists; the pipeline treats that as none.
func (c *Core) selectedEnvironment(workspaceID string) string {
	id, err := c.db.GetWorkspaceState(workspaceID, sqlite.StateSelectedEnvironment)
	if err != nil {
		c.log.Warn("read selected environment", "err", err)
		return ""
	}
	return id
}

// setWorkspace replaces the open workspace, restarts the watcher and loads
// the workspace's cookies.
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
		c.refreshWebhooks(ws)
		c.events.Emit(EventWorkspaceChanged, WorkspaceChangedEvent{WorkspaceID: id, Problems: problems})
	})
	if err != nil {
		c.log.Warn("watch workspace; external changes won't be picked up", "err", err)
	}
	c.watcher = w
	c.overlay, c.overlayWS = pipeline.NewOverlay(), id
	c.loadJarLocked(id)
	c.resetExecutorLocked()
}

func (c *Core) closeWorkspaceLocked() {
	if c.watcher != nil {
		_ = c.watcher.Close()
		c.watcher = nil
	}
	c.overlay, c.overlayWS = nil, ""
	if c.ws != nil {
		c.ws = nil
		c.loadJarLocked("")
		c.resetExecutorLocked()
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
