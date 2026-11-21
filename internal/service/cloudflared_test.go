package service

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"

	"pakpos/internal/hookserver"
	"pakpos/internal/tunnel"
)

// fakeCloudflared writes a shell script that answers --version and opens a
// pretend quick tunnel.
func fakeCloudflared(t *testing.T, dir string) string {
	t.Helper()
	if runtime.GOOS == "windows" {
		t.Skip("uses a shell script as cloudflared")
	}
	p := filepath.Join(dir, "cloudflared")
	script := `#!/bin/sh
if [ "$1" = "--version" ]; then echo "cloudflared version 2026.11.1"; exit 0; fi
echo "INF https://fake-tunnel.trycloudflare.com" >&2
echo "INF Registered tunnel connection" >&2
exec /bin/sleep 60
`
	if err := os.WriteFile(p, []byte(script), 0o755); err != nil { //nolint:gosec // test script
		t.Fatal(err)
	}
	return p
}

func TestCloudflaredStatusAndPath(t *testing.T) {
	t.Setenv("PATH", t.TempDir())
	h := newHarness(t)
	svc := NewWebhookService(h.core)
	ctx := context.Background()

	st := svc.CloudflaredStatus(ctx)
	if st.Found || st.Error == "" || !st.CanDownload {
		t.Fatalf("status = %+v", st)
	}

	bad := filepath.Join(t.TempDir(), "notes.txt")
	_ = os.WriteFile(bad, []byte("x"), 0o600)
	if _, err := svc.SetCloudflaredPath(ctx, bad); err == nil || !strings.Contains(err.Error(), "doesn't run as cloudflared") {
		t.Fatalf("bad path: %v", err)
	}

	cf := fakeCloudflared(t, t.TempDir())
	h.dialogs.file = cf
	st, err := svc.PickCloudflared(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if !st.Found || st.Source != tunnel.SourceSettings || st.Version != "2026.11.1" || st.CustomPath != cf {
		t.Fatalf("picked = %+v", st)
	}
	if h.core.currentSettings().CloudflaredPath != cf {
		t.Fatal("not saved in settings")
	}

	// Cancelled dialog: nothing changes. Dialog failure: an error.
	h.dialogs.file = ""
	if st, err := svc.PickCloudflared(ctx); err != nil || st.CustomPath != cf {
		t.Fatalf("cancelled = %+v, %v", st, err)
	}
	h.dialogs.err = errDialog
	if _, err := svc.PickCloudflared(ctx); !errors.Is(err, errDialog) {
		t.Fatalf("dialog error: %v", err)
	}
	h.dialogs.err = nil

	// Clearing it goes back to finding one.
	if st, err := svc.SetCloudflaredPath(ctx, ""); err != nil || st.Found || st.CustomPath != "" {
		t.Fatalf("cleared = %+v, %v", st, err)
	}

	// The platform has no download.
	goos, goarch = "plan9", "amd64"
	t.Cleanup(func() { goos, goarch = runtime.GOOS, runtime.GOARCH })
	if svc.CloudflaredStatus(ctx).CanDownload {
		t.Error("CanDownload on plan9")
	}
}

// Starting with a tunnel runs the cloudflared from Settings with an empty
// --config, and the status gets its public URL.
func TestEndToEndWebhookRealTunnelProcess(t *testing.T) {
	t.Setenv("PATH", t.TempDir())
	h := newHarness(t)
	svc := NewWebhookService(h.core)
	ctx := context.Background()
	h.openWorkspace(t)
	hook, err := svc.Create("Hook")
	if err != nil {
		t.Fatal(err)
	}

	// No cloudflared: the local server runs, the tunnel fails.
	st, err := svc.Start(hook.ID, true)
	if err != nil {
		t.Fatal(err)
	}
	waitUntil(t, func() bool { return svc.Statuses()[0].State == hookserver.StateTunnelFailed })
	if msg := svc.Statuses()[0].Message; msg != tunnel.ErrNotFound.Error() {
		t.Errorf("message = %q", msg)
	}
	if err := svc.Stop(st.WorkspaceID, hook.ID); err != nil {
		t.Fatal(err)
	}

	if _, err := svc.SetCloudflaredPath(ctx, fakeCloudflared(t, t.TempDir())); err != nil {
		t.Fatal(err)
	}
	if _, err := svc.Start(hook.ID, true); err != nil {
		t.Fatal(err)
	}
	waitUntil(t, func() bool { return svc.Statuses()[0].State == hookserver.StateRunning })
	if got := svc.Statuses()[0].PublicURL; got != "https://fake-tunnel.trycloudflare.com" {
		t.Errorf("public URL = %q", got)
	}
	cfg, err := os.ReadFile(filepath.Join(h.dataDir, tunnel.BinDir, quickTunnelConfig))
	if err != nil || string(cfg) != "{}\n" {
		t.Errorf("config = %q, %v", cfg, err)
	}
	if err := svc.Stop(st.WorkspaceID, hook.ID); err != nil {
		t.Fatal(err)
	}
}

func TestStartTunnelConfigFails(t *testing.T) {
	h := newHarness(t)
	cf := fakeCloudflared(t, t.TempDir())
	next := h.core.currentSettings()
	next.CloudflaredPath = cf
	if _, err := h.set.Set(next); err != nil {
		t.Fatal(err)
	}
	// bin/ can't be created: the data dir's "bin" is a file.
	if err := os.WriteFile(filepath.Join(h.dataDir, tunnel.BinDir), []byte("x"), 0o600); err != nil {
		t.Fatal(err)
	}
	if _, err := h.core.startTunnel(context.Background(), "http://127.0.0.1:1"); err == nil || !strings.Contains(err.Error(), "prepare the tunnel") {
		t.Fatalf("err = %v", err)
	}
}

func TestInstallCloudflared(t *testing.T) {
	t.Setenv("PATH", t.TempDir())
	if runtime.GOOS == "windows" {
		t.Skip("the installed fake is a shell script")
	}
	script, _ := os.ReadFile(fakeCloudflared(t, t.TempDir()))
	asset := tunnel.AssetName(runtime.GOOS, runtime.GOARCH)
	if asset == "" || strings.HasSuffix(asset, ".tgz") {
		t.Skip("covered by internal/tunnel on this platform")
	}
	sum := sha256.Sum256(script)
	block := make(chan struct{})
	var srv *httptest.Server
	srv = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/release":
			_ = json.NewEncoder(w).Encode(map[string]any{"tag_name": "1", "assets": []map[string]any{
				{"name": asset, "browser_download_url": srv.URL + "/asset", "size": len(script), "digest": "sha256:" + hex.EncodeToString(sum[:])},
			}})
		case "/slow":
			<-block
		default:
			_, _ = w.Write(script)
		}
	}))
	defer srv.Close()
	defer close(block)
	api := srv.URL + "/release"
	prev := newInstaller
	newInstaller = func() tunnel.Installer { return tunnel.Installer{API: api} }
	t.Cleanup(func() { newInstaller = prev })

	h := newHarness(t)
	svc := NewWebhookService(h.core)
	st, err := svc.InstallCloudflared(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if !st.Found || st.Source != tunnel.SourceDownloaded {
		t.Fatalf("after install = %+v", st)
	}
	var progress []CloudflaredInstallProgress
	for _, e := range h.events.all() {
		if p, ok := e.data.(CloudflaredInstallProgress); ok {
			progress = append(progress, p)
		}
	}
	if len(progress) == 0 || progress[len(progress)-1].Done != int64(len(script)) {
		t.Errorf("progress = %+v", progress)
	}

	// Cancelling a download that hangs.
	api = srv.URL + "/slow"
	done := make(chan error, 1)
	go func() { _, err := svc.InstallCloudflared(context.Background()); done <- err }()
	waitUntil(t, func() bool {
		svc.install.mu.Lock()
		defer svc.install.mu.Unlock()
		return svc.install.cancel != nil
	})
	if _, err := svc.InstallCloudflared(context.Background()); err == nil || !strings.Contains(err.Error(), "already downloading") {
		t.Errorf("second install: %v", err)
	}
	svc.CancelInstall()
	if err := <-done; err == nil || err.Error() != "Cancelled." {
		t.Fatalf("cancelled install: %v", err)
	}
	svc.CancelInstall() // nothing running

	// A failing download is reported.
	api = srv.URL + "/missing-release"
	if _, err := svc.InstallCloudflared(context.Background()); err == nil {
		t.Error("expected an error")
	}
}
