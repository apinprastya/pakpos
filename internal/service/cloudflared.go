package service

import (
	"context"
	"errors"
	"fmt"
	"net/http"
	"os"
	"path/filepath"
	"runtime"
	"sync"
	"time"

	"pakpos/internal/hookserver"
	"pakpos/internal/tunnel"
)

// EventWebhookInstall reports a cloudflared download's progress.
const EventWebhookInstall = "webhook:install"

// CloudflaredInstallProgress is the payload of EventWebhookInstall.
type CloudflaredInstallProgress struct {
	Done  int64 `json:"done"`
	Total int64 `json:"total"`
}

// CloudflaredStatus says which cloudflared webhook tunnels would use.
type CloudflaredStatus struct {
	Found   bool   `json:"found"`
	Path    string `json:"path"`
	Source  string `json:"source"`
	Version string `json:"version"`
	// Error explains why none was found (or why the one in Settings
	// doesn't run).
	Error string `json:"error"`
	// CustomPath is the path set in Settings ("" when none).
	CustomPath string `json:"customPath"`
	// CanDownload is false on platforms cloudflared has no download for.
	CanDownload bool `json:"canDownload"`
}

// quickTunnelConfig is an empty cloudflared config passed with --config,
// so a ~/.cloudflared/config.yml can't take over a quick tunnel.
const quickTunnelConfig = "quick-tunnel.yml"

// installTimeout bounds a cloudflared download.
const installTimeout = 10 * time.Minute

// cloudflared state shared by the webhook service: the running download.
type installState struct {
	mu     sync.Mutex
	cancel context.CancelFunc
}

// installer is the cloudflared installer; tests replace its API URL.
var newInstaller = func() tunnel.Installer {
	// Like the app updater: its own client with the system's TLS checks,
	// so turning TLS verification off for requests never weakens it.
	return tunnel.Installer{Client: &http.Client{Timeout: installTimeout}}
}

// startTunnel opens a cloudflared quick tunnel to a webhook's local server.
func (c *Core) startTunnel(ctx context.Context, localURL string) (hookserver.Tunnel, error) {
	b, err := tunnel.Locator{}.Locate(ctx, c.currentSettings().CloudflaredPath, c.dataDir)
	if err != nil {
		return nil, err
	}
	cfg, err := c.quickTunnelConfig()
	if err != nil {
		return nil, err
	}
	t, err := tunnel.Start(ctx, b.Path, localURL, tunnel.Options{ConfigFile: cfg})
	if err != nil {
		return nil, err
	}
	return t, nil
}

func (c *Core) quickTunnelConfig() (string, error) {
	dir := filepath.Join(c.dataDir, tunnel.BinDir)
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return "", fmt.Errorf("prepare the tunnel: %w", err)
	}
	p := filepath.Join(dir, quickTunnelConfig)
	if err := os.WriteFile(p, []byte("{}\n"), 0o600); err != nil {
		return "", fmt.Errorf("prepare the tunnel: %w", err)
	}
	return p, nil
}

// CloudflaredStatus reports the cloudflared tunnels would use.
func (s *WebhookService) CloudflaredStatus(ctx context.Context) CloudflaredStatus {
	custom := s.c.currentSettings().CloudflaredPath
	st := CloudflaredStatus{CustomPath: custom, CanDownload: tunnel.AssetName(goos, goarch) != ""}
	b, err := tunnel.Locator{}.Locate(ctx, custom, s.c.dataDir)
	if err != nil {
		st.Error = err.Error()
		return st
	}
	st.Found, st.Path, st.Source, st.Version = true, b.Path, b.Source, b.Version
	return st
}

// InstallCloudflared downloads the latest cloudflared into the app's data
// dir after checking its SHA-256 against the one GitHub publishes, and
// returns the new status. Progress arrives as EventWebhookInstall events;
// CancelInstall stops it.
func (s *WebhookService) InstallCloudflared(ctx context.Context) (CloudflaredStatus, error) {
	s.install.mu.Lock()
	if s.install.cancel != nil {
		s.install.mu.Unlock()
		return CloudflaredStatus{}, &userError{msg: "cloudflared is already downloading."}
	}
	ctx, cancel := context.WithTimeout(ctx, installTimeout)
	s.install.cancel = cancel
	s.install.mu.Unlock()
	defer func() {
		s.install.mu.Lock()
		s.install.cancel = nil
		s.install.mu.Unlock()
		cancel()
	}()

	var last time.Time
	_, _, err := newInstaller().Install(ctx, s.c.dataDir, func(done, total int64) {
		// About ten events a second is plenty for a progress bar.
		if now := time.Now(); now.Sub(last) >= 100*time.Millisecond || done == total {
			last = now
			s.c.events.Emit(EventWebhookInstall, CloudflaredInstallProgress{Done: done, Total: total})
		}
	})
	if errors.Is(err, context.Canceled) {
		return CloudflaredStatus{}, &userError{msg: "Cancelled.", err: err}
	}
	if err != nil {
		return CloudflaredStatus{}, err
	}
	return s.CloudflaredStatus(ctx), nil
}

// CancelInstall stops a running cloudflared download.
func (s *WebhookService) CancelInstall() {
	s.install.mu.Lock()
	defer s.install.mu.Unlock()
	if s.install.cancel != nil {
		s.install.cancel()
	}
}

// PickCloudflared asks for a cloudflared file and uses it when it runs.
// Cancelling the dialog changes nothing.
func (s *WebhookService) PickCloudflared(ctx context.Context) (CloudflaredStatus, error) {
	p, err := s.c.dialogs.PickFile("Choose cloudflared")
	if err != nil {
		return CloudflaredStatus{}, err
	}
	if p == "" {
		return s.CloudflaredStatus(ctx), nil
	}
	return s.SetCloudflaredPath(ctx, p)
}

// SetCloudflaredPath makes tunnels use the cloudflared at path ("" goes
// back to finding it). A file that doesn't run as cloudflared is refused.
func (s *WebhookService) SetCloudflaredPath(ctx context.Context, path string) (CloudflaredStatus, error) {
	if path != "" {
		if _, err := (tunnel.Locator{}).Locate(ctx, path, s.c.dataDir); err != nil {
			return CloudflaredStatus{}, &userError{msg: "That file doesn't run as cloudflared. Choose the cloudflared program itself.", err: err}
		}
	}
	next := s.c.currentSettings()
	next.CloudflaredPath = path
	if _, err := NewSettingsService(s.c).Set(next); err != nil {
		return CloudflaredStatus{}, err
	}
	return s.CloudflaredStatus(ctx), nil
}

// The platform CloudflaredStatus checks for a download (tests override).
var goos, goarch = runtime.GOOS, runtime.GOARCH
