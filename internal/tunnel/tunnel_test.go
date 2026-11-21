package tunnel

import (
	"archive/tar"
	"bytes"
	"compress/gzip"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
	"time"
)

// The test binary doubles as a fake cloudflared: with FAKE_CLOUDFLARED set
// it behaves as the mode says instead of running tests.
func TestMain(m *testing.M) {
	if mode := os.Getenv("FAKE_CLOUDFLARED"); mode != "" {
		fakeCloudflared(mode)
		return
	}
	os.Exit(m.Run())
}

func fakeCloudflared(mode string) {
	args := os.Args[1:]
	if len(args) > 0 && args[0] == "--version" {
		if mode == "badversion" {
			os.Exit(3)
		}
		fmt.Println("cloudflared version 2026.11.1 (built 2026-11-01)")
		os.Exit(0)
	}
	if os.Getenv("FAKE_ARGS_FILE") != "" {
		_ = os.WriteFile(os.Getenv("FAKE_ARGS_FILE"), []byte(strings.Join(args, " ")), 0o600)
	}
	log := func(s string) { fmt.Fprintln(os.Stderr, "2026-11-21T10:00:00Z INF "+s) }
	switch mode {
	case "ok", "ok-noreg":
		log("Requesting new quick Tunnel on trycloudflare.com...")
		log("+--------------------------------------------------------------------------------------------+")
		log("|  Your quick Tunnel has been created! Visit it at (it may take some time to be reachable):  |")
		log("|  https://fancy-words-here.trycloudflare.com                                                |")
		log("+--------------------------------------------------------------------------------------------+")
		if mode == "ok" {
			log("Registered tunnel connection connIndex=0 location=ams01 protocol=quic")
		}
		if os.Getenv("FAKE_EXIT_AFTER") != "" {
			time.Sleep(100 * time.Millisecond)
			log("Lost connection with the edge")
			os.Exit(1)
		}
		time.Sleep(time.Minute)
	case "fail":
		log("failed to request quick Tunnel: 429 Too Many Requests")
		os.Exit(1)
	case "silent":
		time.Sleep(time.Minute)
	case "dies-after-url":
		log("https://x.trycloudflare.com")
		log("error: something broke")
		os.Exit(2)
	case "longline":
		fmt.Fprintln(os.Stderr, strings.Repeat("x", 2<<20))
		log("https://long.trycloudflare.com")
		log("Registered tunnel connection")
		time.Sleep(time.Minute)
	}
	os.Exit(0)
}

func self(t *testing.T) string {
	t.Helper()
	exe, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	return exe
}

func TestStart(t *testing.T) {
	t.Setenv("FAKE_CLOUDFLARED", "ok")
	argsFile := filepath.Join(t.TempDir(), "args")
	t.Setenv("FAKE_ARGS_FILE", argsFile)
	tun, err := Start(context.Background(), self(t), "http://127.0.0.1:1234", Options{ConfigFile: "/x/empty.yml"})
	if err != nil {
		t.Fatal(err)
	}
	if tun.URL() != "https://fancy-words-here.trycloudflare.com" {
		t.Fatalf("URL = %q", tun.URL())
	}
	args, _ := os.ReadFile(argsFile)
	if string(args) != "tunnel --no-autoupdate --config /x/empty.yml --url http://127.0.0.1:1234" {
		t.Errorf("args = %q", args)
	}
	select {
	case <-tun.Done():
		t.Fatal("done too early")
	default:
	}
	if err := tun.Stop(); err != nil {
		t.Fatal(err)
	}
	_ = tun.Stop()
	<-tun.Done()
	if tun.Err() == nil {
		t.Error("killed process has no error")
	}
}

func TestStartSettlesWithoutRegistration(t *testing.T) {
	t.Setenv("FAKE_CLOUDFLARED", "ok-noreg")
	tun, err := Start(context.Background(), self(t), "http://127.0.0.1:1", Options{Settle: 50 * time.Millisecond})
	if err != nil {
		t.Fatal(err)
	}
	defer tun.Stop()
	if tun.URL() == "" {
		t.Fatal("no URL")
	}
}

func TestStartLongLine(t *testing.T) {
	t.Setenv("FAKE_CLOUDFLARED", "longline")
	tun, err := Start(context.Background(), self(t), "http://127.0.0.1:1", Options{Timeout: 2 * time.Second, Settle: 100 * time.Millisecond})
	// The scanner gives up on the huge line; the URL after it is missed and
	// the start times out, but nothing hangs.
	if err == nil {
		tun.Stop()
		t.Fatal("expected a timeout")
	}
}

func TestTunnelExits(t *testing.T) {
	t.Setenv("FAKE_CLOUDFLARED", "ok")
	t.Setenv("FAKE_EXIT_AFTER", "1")
	tun, err := Start(context.Background(), self(t), "http://127.0.0.1:1", Options{})
	if err != nil {
		t.Fatal(err)
	}
	select {
	case <-tun.Done():
	case <-time.After(5 * time.Second):
		t.Fatal("not done")
	}
	if err := tun.Err(); err == nil || !strings.Contains(err.Error(), "Lost connection with the edge") {
		t.Errorf("Err = %v", err)
	}
}

func TestStartFailures(t *testing.T) {
	tests := []struct {
		mode string
		opts Options
		want string
	}{
		{"fail", Options{}, "cloudflared stopped before opening the tunnel. cloudflared said: 2026-11-21T10:00:00Z INF failed to request quick Tunnel: 429 Too Many Requests"},
		{"silent", Options{Timeout: 100 * time.Millisecond}, "didn't report a tunnel URL within 100ms"},
		{"dies-after-url", Options{}, "stopped right after opening the tunnel"},
	}
	for _, tt := range tests {
		t.Run(tt.mode, func(t *testing.T) {
			t.Setenv("FAKE_CLOUDFLARED", tt.mode)
			_, err := Start(context.Background(), self(t), "http://127.0.0.1:1", tt.opts)
			if err == nil || !strings.Contains(err.Error(), tt.want) {
				t.Fatalf("err = %v, want %q", err, tt.want)
			}
		})
	}
	if _, err := Start(context.Background(), filepath.Join(t.TempDir(), "missing"), "http://x", Options{}); err == nil {
		t.Error("missing binary")
	}
}

func TestStartCancelled(t *testing.T) {
	t.Setenv("FAKE_CLOUDFLARED", "silent")
	ctx, cancel := context.WithCancel(context.Background())
	go func() { time.Sleep(50 * time.Millisecond); cancel() }()
	if _, err := Start(ctx, self(t), "http://x", Options{}); !errors.Is(err, context.Canceled) {
		t.Fatalf("err = %v", err)
	}
	t.Setenv("FAKE_CLOUDFLARED", "ok-noreg")
	ctx, cancel = context.WithCancel(context.Background())
	go func() { time.Sleep(300 * time.Millisecond); cancel() }()
	if _, err := Start(ctx, self(t), "http://x", Options{Settle: time.Minute}); !errors.Is(err, context.Canceled) {
		t.Fatalf("err while settling = %v", err)
	}
}

func TestTunnelErrWithoutLog(t *testing.T) {
	tun := &Tunnel{err: errors.New("exit 1")}
	if tun.Err().Error() != "exit 1" {
		t.Error(tun.Err())
	}
	tun = &Tunnel{}
	if tun.Err() != nil {
		t.Error("no error expected")
	}
}

func TestLocate(t *testing.T) {
	t.Setenv("FAKE_CLOUDFLARED", "ok")
	dataDir := t.TempDir()
	noPath := func(string) (string, error) { return "", exec.ErrNotFound }
	l := Locator{LookPath: noPath}

	if _, err := l.Locate(context.Background(), "", dataDir); !errors.Is(err, ErrNotFound) {
		t.Fatalf("empty: %v", err)
	}
	b, err := l.Locate(context.Background(), self(t), dataDir)
	if err != nil || b.Source != SourceSettings || b.Version != "2026.11.1" || b.Path != self(t) {
		t.Fatalf("custom = %+v, %v", b, err)
	}
	if _, err := l.Locate(context.Background(), filepath.Join(dataDir, "nope"), dataDir); err == nil || !strings.Contains(err.Error(), "doesn't run") {
		t.Fatalf("bad custom: %v", err)
	}

	onPath := Locator{LookPath: func(string) (string, error) { return self(t), nil }}
	if b, err := onPath.Locate(context.Background(), "", dataDir); err != nil || b.Source != SourcePath {
		t.Fatalf("path = %+v, %v", b, err)
	}

	// The downloaded copy wins over PATH.
	if err := os.MkdirAll(filepath.Join(dataDir, BinDir), 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(self(t), DownloadedPath(dataDir)); err != nil {
		t.Skip("no symlinks:", err)
	}
	if b, err := onPath.Locate(context.Background(), "", dataDir); err != nil || b.Source != SourceDownloaded {
		t.Fatalf("downloaded = %+v, %v", b, err)
	}

	// A binary whose --version fails is skipped.
	t.Setenv("FAKE_CLOUDFLARED", "badversion")
	if _, err := onPath.Locate(context.Background(), "", dataDir); !errors.Is(err, ErrNotFound) {
		t.Fatalf("bad version: %v", err)
	}
}

func TestVersionUnparsed(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("uses a shell script")
	}
	script := filepath.Join(t.TempDir(), "cf")
	if err := os.WriteFile(script, []byte("#!/bin/sh\necho custom build\n"), 0o755); err != nil { //nolint:gosec // test script
		t.Fatal(err)
	}
	if v, err := (Locator{}).version(context.Background(), script); err != nil || v != "custom build" {
		t.Fatalf("version = %q, %v", v, err)
	}
}

func TestAssetName(t *testing.T) {
	tests := map[[2]string]string{
		{"linux", "amd64"}:   "cloudflared-linux-amd64",
		{"linux", "arm64"}:   "cloudflared-linux-arm64",
		{"linux", "riscv64"}: "",
		{"windows", "amd64"}: "cloudflared-windows-amd64.exe",
		{"windows", "arm64"}: "cloudflared-windows-amd64.exe",
		{"windows", "386"}:   "cloudflared-windows-386.exe",
		{"darwin", "arm64"}:  "cloudflared-darwin-arm64.tgz",
		{"darwin", "386"}:    "",
		{"plan9", "amd64"}:   "",
	}
	for in, want := range tests {
		if got := AssetName(in[0], in[1]); got != want {
			t.Errorf("AssetName(%v) = %q, want %q", in, got, want)
		}
	}
	if ExeName() == "" {
		t.Error("ExeName")
	}
}

// releaseServer serves a fake GitHub release with one asset.
func releaseServer(t *testing.T, asset string, data []byte, digest string, status int) *httptest.Server {
	t.Helper()
	mux := http.NewServeMux()
	var srv *httptest.Server
	mux.HandleFunc("/release", func(w http.ResponseWriter, _ *http.Request) {
		if status != 0 {
			w.WriteHeader(status)
			return
		}
		_ = json.NewEncoder(w).Encode(map[string]any{
			"tag_name": "2026.11.1",
			"assets": []map[string]any{
				{"name": "other", "browser_download_url": srv.URL + "/other", "size": 1, "digest": "sha256:00"},
				{"name": asset, "browser_download_url": srv.URL + "/asset", "size": len(data), "digest": digest},
			},
		})
	})
	mux.HandleFunc("/asset", func(w http.ResponseWriter, _ *http.Request) { _, _ = w.Write(data) })
	srv = httptest.NewServer(mux)
	t.Cleanup(srv.Close)
	return srv
}

func sum(b []byte) string {
	h := sha256.Sum256(b)
	return "sha256:" + hex.EncodeToString(h[:])
}

func tgz(t *testing.T, name string, data []byte) []byte {
	t.Helper()
	var buf bytes.Buffer
	gz := gzip.NewWriter(&buf)
	tw := tar.NewWriter(gz)
	_ = tw.WriteHeader(&tar.Header{Name: "README", Mode: 0o644, Size: 2, Typeflag: tar.TypeReg})
	_, _ = tw.Write([]byte("hi"))
	if name != "" {
		_ = tw.WriteHeader(&tar.Header{Name: name, Mode: 0o755, Size: int64(len(data)), Typeflag: tar.TypeReg})
		_, _ = tw.Write(data)
	}
	_ = tw.Close()
	_ = gz.Close()
	return buf.Bytes()
}

func TestInstall(t *testing.T) {
	bin := []byte("#!/bin/sh\necho cloudflared version 1\n")
	tests := []struct {
		name, goos, goarch, asset string
		data                      []byte
		digest                    string
		status                    int
		want                      string // error substring; "" = success
	}{
		{"linux", "linux", "amd64", "cloudflared-linux-amd64", bin, sum(bin), 0, ""},
		{"windows", "windows", "amd64", "cloudflared-windows-amd64.exe", bin, sum(bin), 0, ""},
		{"darwin tgz", "darwin", "arm64", "cloudflared-darwin-arm64.tgz", tgz(t, "./cloudflared", bin), sum(tgz(t, "./cloudflared", bin)), 0, ""},
		{"tgz without binary", "darwin", "arm64", "cloudflared-darwin-arm64.tgz", tgz(t, "", nil), sum(tgz(t, "", nil)), 0, "has no cloudflared"},
		{"tgz not gzip", "darwin", "arm64", "cloudflared-darwin-arm64.tgz", bin, sum(bin), 0, "unpack cloudflared"},
		{"wrong digest", "linux", "amd64", "cloudflared-linux-amd64", bin, sum([]byte("other")), 0, "doesn't match"},
		{"no digest", "linux", "amd64", "cloudflared-linux-amd64", bin, "", 0, "no SHA-256 checksum"},
		{"md5 digest", "linux", "amd64", "cloudflared-linux-amd64", bin, "md5:abc", 0, "no SHA-256 checksum"},
		{"missing asset", "linux", "arm64", "cloudflared-linux-amd64", bin, sum(bin), 0, "has no cloudflared-linux-arm64 download"},
		{"unsupported", "plan9", "amd64", "x", bin, sum(bin), 0, "has no download for plan9/amd64"},
		{"api error", "linux", "amd64", "cloudflared-linux-amd64", bin, sum(bin), http.StatusForbidden, "GitHub answered 403"},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			srv := releaseServer(t, tt.asset, tt.data, tt.digest, tt.status)
			dataDir := t.TempDir()
			var last int64
			in := Installer{API: srv.URL + "/release", GOOS: tt.goos, GOARCH: tt.goarch}
			p, tag, err := in.Install(context.Background(), dataDir, func(done, total int64) { last = done })
			if tt.want != "" {
				if err == nil || !strings.Contains(err.Error(), tt.want) {
					t.Fatalf("err = %v, want %q", err, tt.want)
				}
				// Nothing is left behind.
				entries, _ := os.ReadDir(filepath.Join(dataDir, BinDir))
				if len(entries) != 0 {
					t.Errorf("left %d files", len(entries))
				}
				return
			}
			if err != nil {
				t.Fatal(err)
			}
			if tag != "2026.11.1" || filepath.Base(p) != exeName(tt.goos) || last != int64(len(tt.data)) {
				t.Errorf("path %s, tag %s, progress %d", p, tag, last)
			}
			got, _ := os.ReadFile(p)
			if !bytes.Equal(got, bin) {
				t.Error("installed content differs")
			}
			if runtime.GOOS != "windows" {
				if info, _ := os.Stat(p); info.Mode()&0o100 == 0 {
					t.Error("not executable")
				}
			}
			entries, _ := os.ReadDir(filepath.Join(dataDir, BinDir))
			if len(entries) != 1 {
				t.Errorf("bin dir holds %d files", len(entries))
			}
		})
	}
}

func TestInstallNetworkErrors(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/bad-json":
			_, _ = w.Write([]byte("{"))
		case "/release-404":
			_ = json.NewEncoder(w).Encode(map[string]any{"tag_name": "1", "assets": []map[string]any{
				{"name": "cloudflared-linux-amd64", "browser_download_url": "http://" + r.Host + "/gone", "digest": sum(nil)},
			}})
		default:
			w.WriteHeader(http.StatusNotFound)
		}
	}))
	defer srv.Close()
	in := Installer{GOOS: "linux", GOARCH: "amd64", Client: srv.Client()}
	for path, want := range map[string]string{
		"/bad-json":    "read the latest cloudflared release",
		"/release-404": "the server answered 404",
	} {
		in.API = srv.URL + path
		if _, _, err := in.Install(context.Background(), t.TempDir(), nil); err == nil || !strings.Contains(err.Error(), want) {
			t.Errorf("%s: %v", path, err)
		}
	}
	in.API = "http://127.0.0.1:1/unreachable"
	if _, _, err := in.Install(context.Background(), t.TempDir(), nil); err == nil || !strings.Contains(err.Error(), "find the latest cloudflared") {
		t.Errorf("unreachable: %v", err)
	}
	in.API = "::bad url"
	if _, _, err := in.Install(context.Background(), t.TempDir(), nil); err == nil {
		t.Error("bad url")
	}
	// A data dir that can't hold bin/.
	file := filepath.Join(t.TempDir(), "file")
	_ = os.WriteFile(file, []byte("x"), 0o600)
	bin := []byte("x")
	in = Installer{API: releaseServer(t, "cloudflared-linux-amd64", bin, sum(bin), 0).URL + "/release", GOOS: "linux", GOARCH: "amd64"}
	if _, _, err := in.Install(context.Background(), file, nil); err == nil {
		t.Error("data dir is a file")
	}
}
