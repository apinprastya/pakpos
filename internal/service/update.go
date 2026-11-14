package service

import (
	"context"
	"errors"
	"os"
	"strings"
	"sync"
	"time"

	"pakpos/internal/buildinfo"
	"pakpos/internal/update"
)

// EventUpdateProgress reports the download progress of an update.
const EventUpdateProgress = "update:progress"

// UpdateProgress is the payload of EventUpdateProgress.
type UpdateProgress struct {
	Done  int64 `json:"done"`
	Total int64 `json:"total"`
}

// UpdateInfo is the result of a check for updates.
type UpdateInfo struct {
	Current     string `json:"current"`
	Latest      string `json:"latest"`
	Available   bool   `json:"available"`
	Name        string `json:"name"`
	Notes       string `json:"notes"`
	URL         string `json:"url"`
	PublishedAt string `json:"publishedAt"`
	// CanInstall says whether Install can replace this installation; Reason
	// explains why not (the UI then offers the release page).
	CanInstall bool   `json:"canInstall"`
	Reason     string `json:"reason"`
}

// ReleasesPage is where every release is listed.
const ReleasesPage = "https://github.com/" + update.Repo + "/releases"

// UpdateConfig configures an UpdateService.
type UpdateConfig struct {
	Updater *update.Updater
	Events  Events
	// App opens the browser and quits; nil disables both (tests, headless).
	App AppControl
	// Version is the running version (default buildinfo.Version).
	Version string
	// Start launches the installed version (default update.StartDetached).
	Start func(name string, args []string) error
}

// UpdateService checks GitHub Releases for a newer Pakpos, installs it after
// verifying its signed checksums, and restarts into it. When to check is the
// frontend's decision (the "check for updates" setting); installing always
// needs the user to ask.
type UpdateService struct {
	updater *update.Updater
	events  Events
	app     AppControl
	version string
	start   func(name string, args []string) error

	mu        sync.Mutex
	release   *update.Release
	cancel    context.CancelFunc
	installed bool
}

// NewUpdateService creates the service.
func NewUpdateService(cfg UpdateConfig) *UpdateService {
	s := &UpdateService{updater: cfg.Updater, events: cfg.Events, app: cfg.App, version: cfg.Version, start: cfg.Start}
	if s.version == "" {
		s.version = buildinfo.Version
	}
	if s.start == nil {
		s.start = update.StartDetached
	}
	return s
}

// installBlocker returns why this installation cannot install updates ("" if it can).
func (s *UpdateService) installBlocker() string {
	switch {
	case update.IsDev(s.version):
		return "This is a development build; it doesn't update itself."
	case s.updater.Install.Kind == update.KindManual:
		return s.updater.Install.Reason
	case strings.TrimSpace(s.updater.PublicKey) == "":
		return userText(update.ErrNoKey)
	}
	return ""
}

// userText capitalises an error message for the UI.
func userText(err error) string {
	m := err.Error()
	if m == "" {
		return m
	}
	return strings.ToUpper(m[:1]) + m[1:]
}

// Check asks GitHub for the latest stable release.
func (s *UpdateService) Check(ctx context.Context) (*UpdateInfo, error) {
	r, err := s.updater.Latest(ctx)
	if err != nil {
		return nil, err
	}
	s.mu.Lock()
	s.release = &r
	s.mu.Unlock()
	info := &UpdateInfo{
		Current:   s.version,
		Latest:    r.Version(),
		Available: update.Newer(r.Version(), s.version),
		Name:      r.Name,
		Notes:     r.Notes,
		URL:       r.URL,
	}
	if !r.PublishedAt.IsZero() {
		info.PublishedAt = r.PublishedAt.Format(time.RFC3339)
	}
	info.Reason = s.installBlocker()
	info.CanInstall = info.Available && info.Reason == ""
	return info, nil
}

// Install downloads, verifies and installs the release found by the last
// Check. Progress is sent as EventUpdateProgress; Cancel stops it. The
// running app keeps working; Restart switches to the new version.
func (s *UpdateService) Install(ctx context.Context) error {
	s.mu.Lock()
	r := s.release
	if r == nil {
		s.mu.Unlock()
		return update.ErrNoRelease
	}
	if !update.Newer(r.Version(), s.version) {
		s.mu.Unlock()
		return update.ErrNotNewer
	}
	if reason := s.installBlocker(); reason != "" {
		s.mu.Unlock()
		return errors.New(reason)
	}
	if s.cancel != nil {
		s.mu.Unlock()
		return errors.New("an update is already being installed")
	}
	ctx, cancel := context.WithCancel(ctx)
	s.cancel = cancel
	s.mu.Unlock()
	defer func() {
		cancel()
		s.mu.Lock()
		s.cancel = nil
		s.mu.Unlock()
	}()

	var last time.Time
	file, err := s.updater.Download(ctx, *r, func(done, total int64) {
		if s.events != nil && (time.Since(last) >= 100*time.Millisecond || done == total) {
			last = time.Now()
			s.events.Emit(EventUpdateProgress, UpdateProgress{Done: done, Total: total})
		}
	})
	if err != nil {
		return err
	}
	defer func() { _ = os.Remove(file) }()
	if err := s.updater.Apply(ctx, file); err != nil {
		return err
	}
	s.mu.Lock()
	s.installed = true
	s.mu.Unlock()
	return nil
}

// Cancel stops a running Install; false when none runs.
func (s *UpdateService) Cancel() bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.cancel == nil {
		return false
	}
	s.cancel()
	return true
}

// Restart starts the installed update and quits this instance.
func (s *UpdateService) Restart() error {
	s.mu.Lock()
	installed := s.installed
	s.mu.Unlock()
	if !installed {
		return errors.New("no update has been installed")
	}
	if s.app == nil {
		return errors.New("restart isn't available here; start Pakpos again")
	}
	name, args := s.updater.Install.RestartCommand()
	if err := s.start(name, args); err != nil {
		return err
	}
	s.app.Quit()
	return nil
}

// OpenReleasePage opens the checked release (or the release list) in the browser.
func (s *UpdateService) OpenReleasePage() error {
	if s.app == nil {
		return errors.New("can't open a browser here; visit " + ReleasesPage)
	}
	url := ReleasesPage
	s.mu.Lock()
	if s.release != nil && strings.HasPrefix(s.release.URL, ReleasesPage+"/") {
		url = s.release.URL
	}
	s.mu.Unlock()
	return s.app.OpenURL(url)
}
