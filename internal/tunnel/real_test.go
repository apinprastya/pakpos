package tunnel

import (
	"context"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"testing"
	"time"
)

// TestRealTunnel downloads the real cloudflared and opens a real quick
// tunnel. It needs the network, so it runs only with PAKPOS_TEST_TUNNEL=1.
// A ~/.cloudflared/config.yml must not take over: --config points at an
// empty file.
func TestRealTunnel(t *testing.T) {
	if os.Getenv("PAKPOS_TEST_TUNNEL") != "1" {
		t.Skip("set PAKPOS_TEST_TUNNEL=1 to open a real Cloudflare tunnel")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Minute)
	defer cancel()
	dataDir := os.Getenv("PAKPOS_TEST_TUNNEL_DIR")
	if dataDir == "" {
		dataDir = t.TempDir()
	}
	bin := DownloadedPath(dataDir)
	if _, err := os.Stat(bin); err != nil {
		p, tag, err := Installer{}.Install(ctx, dataDir, nil)
		if err != nil {
			t.Fatal(err)
		}
		t.Logf("installed cloudflared %s at %s", tag, p)
	}
	b, err := Locator{}.Locate(ctx, "", dataDir)
	if err != nil || b.Source != SourceDownloaded {
		t.Fatalf("locate = %+v, %v", b, err)
	}
	t.Logf("cloudflared %s", b.Version)

	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		_, _ = io.WriteString(w, "pakpos-real-tunnel")
	}))
	defer srv.Close()
	cfg := filepath.Join(dataDir, BinDir, "quick-tunnel.yml")
	if err := os.WriteFile(cfg, []byte("{}\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	tun, err := Start(ctx, b.Path, srv.URL, Options{ConfigFile: cfg})
	if err != nil {
		t.Fatal(err)
	}
	defer tun.Stop()
	t.Logf("tunnel at %s", tun.URL())

	// The hostname can take a few seconds to resolve.
	var body string
	deadline := time.Now().Add(60 * time.Second)
	for time.Now().Before(deadline) {
		resp, err := http.Get(tun.URL() + "/hello")
		if err == nil {
			b, _ := io.ReadAll(resp.Body)
			resp.Body.Close()
			if resp.StatusCode == 200 {
				body = string(b)
				break
			}
		}
		time.Sleep(2 * time.Second)
	}
	if body != "pakpos-real-tunnel" {
		t.Fatalf("no reply through the tunnel (got %q)", body)
	}
}
