// Package tunnel finds, downloads and runs cloudflared to open Cloudflare
// quick tunnels (https://<random>.trycloudflare.com) to a local server. It
// has no Wails dependency.
package tunnel

import (
	"bufio"
	"context"
	"errors"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"runtime"
	"strings"
	"sync"
	"time"
)

// Where a cloudflared binary was found.
const (
	SourceSettings   = "settings"
	SourceDownloaded = "downloaded"
	SourcePath       = "path"
)

// BinDir is the folder inside the app data dir that holds the downloaded
// cloudflared.
const BinDir = "bin"

// ErrNotFound means no usable cloudflared binary was found.
var ErrNotFound = errors.New("cloudflared isn't installed. Download it, or choose the file in Settings → Webhooks")

// Binary is a cloudflared executable.
type Binary struct {
	Path    string `json:"path"`
	Source  string `json:"source"`
	Version string `json:"version"`
}

// ExeName is cloudflared's file name on this OS.
func ExeName() string {
	if runtime.GOOS == "windows" {
		return "cloudflared.exe"
	}
	return "cloudflared"
}

// DownloadedPath is where Install puts cloudflared.
func DownloadedPath(dataDir string) string {
	return filepath.Join(dataDir, BinDir, ExeName())
}

// Locator finds cloudflared.
type Locator struct {
	// LookPath searches PATH (exec.LookPath when nil).
	LookPath func(string) (string, error)
	// VersionTimeout bounds `cloudflared --version` (5 s when zero).
	VersionTimeout time.Duration
}

var versionRE = regexp.MustCompile(`version\s+(\S+)`)

// Locate returns the first cloudflared that runs: custom (from settings)
// when set, else the downloaded copy in dataDir, else one on PATH. A custom
// path that doesn't run is an error, not a fallback.
func (l Locator) Locate(ctx context.Context, custom, dataDir string) (Binary, error) {
	if custom != "" {
		v, err := l.version(ctx, custom)
		if err != nil {
			return Binary{}, fmt.Errorf("the cloudflared chosen in Settings (%s) doesn't run: %w", custom, err)
		}
		return Binary{Path: custom, Source: SourceSettings, Version: v}, nil
	}
	if p := DownloadedPath(dataDir); fileExists(p) {
		if v, err := l.version(ctx, p); err == nil {
			return Binary{Path: p, Source: SourceDownloaded, Version: v}, nil
		}
	}
	look := l.LookPath
	if look == nil {
		look = exec.LookPath
	}
	if p, err := look(ExeName()); err == nil {
		if v, err := l.version(ctx, p); err == nil {
			return Binary{Path: p, Source: SourcePath, Version: v}, nil
		}
	}
	return Binary{}, ErrNotFound
}

func (l Locator) version(ctx context.Context, bin string) (string, error) {
	timeout := l.VersionTimeout
	if timeout <= 0 {
		timeout = 5 * time.Second
	}
	ctx, cancel := context.WithTimeout(ctx, timeout)
	defer cancel()
	out, err := exec.CommandContext(ctx, bin, "--version").CombinedOutput() //nolint:gosec // the user's or our own cloudflared
	if err != nil {
		return "", err
	}
	if m := versionRE.FindSubmatch(out); m != nil {
		return string(m[1]), nil
	}
	return strings.TrimSpace(string(out)), nil
}

func fileExists(p string) bool {
	info, err := os.Stat(p)
	return err == nil && !info.IsDir()
}

var (
	urlRE        = regexp.MustCompile(`https://[a-z0-9-]+\.trycloudflare\.com`)
	registeredRE = regexp.MustCompile(`(?i)registered tunnel connection`)
)

// Options configure Start.
type Options struct {
	// Timeout is how long to wait for the tunnel URL (30 s when zero).
	Timeout time.Duration
	// Settle is how long to wait after the URL for the first registered
	// connection before reporting the tunnel anyway (10 s when zero).
	Settle time.Duration
	// ConfigFile is passed as --config so a user's ~/.cloudflared/config.yml
	// can't take over the quick tunnel ("" leaves cloudflared's default).
	ConfigFile string
}

// Tunnel is a running cloudflared quick tunnel.
type Tunnel struct {
	url  string
	cmd  *exec.Cmd
	done chan struct{}

	mu   sync.Mutex
	err  error
	last string // last non-empty log line
	once sync.Once
}

// maxLine bounds a log line we keep.
const maxLine = 500

// Start runs `cloudflared tunnel --url localURL` and returns once the public
// URL is known and the first connection is registered (or Settle passed).
// Cancelling ctx before then stops it.
func Start(ctx context.Context, bin, localURL string, o Options) (*Tunnel, error) {
	if o.Timeout <= 0 {
		o.Timeout = 30 * time.Second
	}
	if o.Settle <= 0 {
		o.Settle = 10 * time.Second
	}
	args := []string{"tunnel", "--no-autoupdate"}
	if o.ConfigFile != "" {
		args = append(args, "--config", o.ConfigFile)
	}
	args = append(args, "--url", localURL)
	cmd := exec.Command(bin, args...) //nolint:gosec // the user's or our own cloudflared
	pr, pw := io.Pipe()
	cmd.Stdout, cmd.Stderr = pw, pw
	// After a kill, don't wait forever for a child that still holds the
	// log pipe.
	cmd.WaitDelay = 2 * time.Second
	hideWindow(cmd)
	if err := cmd.Start(); err != nil {
		return nil, fmt.Errorf("start cloudflared: %w", err)
	}
	t := &Tunnel{cmd: cmd, done: make(chan struct{})}
	urlc := make(chan string, 1)
	regc := make(chan struct{}, 1)
	go t.read(pr, urlc, regc)
	go func() {
		err := cmd.Wait()
		_ = pw.Close()
		t.mu.Lock()
		t.err = err
		t.mu.Unlock()
		close(t.done)
	}()

	timeout := time.NewTimer(o.Timeout)
	defer timeout.Stop()
	fail := func(msg string) (*Tunnel, error) {
		_ = t.Stop()
		if last := t.lastLine(); last != "" {
			msg += " cloudflared said: " + last
		}
		return nil, errors.New(msg)
	}
	select {
	case t.url = <-urlc:
	case <-t.done:
		return fail("cloudflared stopped before opening the tunnel.")
	case <-timeout.C:
		return fail("cloudflared didn't report a tunnel URL within " + o.Timeout.String() + ".")
	case <-ctx.Done():
		_ = t.Stop()
		return nil, ctx.Err()
	}
	settle := time.NewTimer(o.Settle)
	defer settle.Stop()
	select {
	case <-regc:
	case <-settle.C:
	case <-t.done:
		return fail("cloudflared stopped right after opening the tunnel.")
	case <-ctx.Done():
		_ = t.Stop()
		return nil, ctx.Err()
	}
	return t, nil
}

// read scans cloudflared's log for the URL and the first registered
// connection, remembering the last line.
func (t *Tunnel) read(r io.Reader, urlc chan<- string, regc chan<- struct{}) {
	sc := bufio.NewScanner(r)
	sc.Buffer(make([]byte, 64*1024), 1024*1024)
	sentURL, sentReg := false, false
	for sc.Scan() {
		line := strings.TrimSpace(sc.Text())
		if line == "" || strings.Trim(line, "|+-= ") == "" {
			continue
		}
		if !sentURL {
			if u := urlRE.FindString(line); u != "" && !strings.Contains(u, "api.trycloudflare.com") {
				urlc <- u
				sentURL = true
			}
		}
		if !sentReg && registeredRE.MatchString(line) {
			regc <- struct{}{}
			sentReg = true
		}
		if len(line) > maxLine {
			line = line[:maxLine]
		}
		t.mu.Lock()
		t.last = line
		t.mu.Unlock()
	}
	if sc.Err() != nil {
		// A line over the buffer: keep draining so cloudflared never
		// blocks on a full pipe.
		_, _ = io.Copy(io.Discard, r)
	}
}

func (t *Tunnel) lastLine() string {
	t.mu.Lock()
	defer t.mu.Unlock()
	return t.last
}

// URL is the public base URL.
func (t *Tunnel) URL() string { return t.url }

// Done is closed when cloudflared exits.
func (t *Tunnel) Done() <-chan struct{} { return t.done }

// Err says why cloudflared exited, with its last log line.
func (t *Tunnel) Err() error {
	t.mu.Lock()
	defer t.mu.Unlock()
	switch {
	case t.err != nil && t.last != "":
		return fmt.Errorf("%w (%s)", t.err, t.last)
	case t.last != "":
		return errors.New(t.last)
	}
	return t.err
}

// Stop kills cloudflared and waits for it to exit.
func (t *Tunnel) Stop() error {
	t.once.Do(func() {
		select {
		case <-t.done:
		default:
			_ = t.cmd.Process.Kill()
		}
	})
	<-t.done
	return nil
}
