package tunnel

import (
	"archive/tar"
	"compress/gzip"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"path"
	"path/filepath"
	"strings"
)

// ReleaseAPI is the GitHub API URL of cloudflared's latest release.
const ReleaseAPI = "https://api.github.com/repos/cloudflare/cloudflared/releases/latest"

// MaxDownload bounds the download (cloudflared is about 40–60 MB).
const MaxDownload = 200 << 20

// AssetName is the release asset for an OS and architecture, or "" when
// cloudflared has none. Windows on ARM runs the amd64 build.
func AssetName(goos, goarch string) string {
	switch goos {
	case "linux":
		switch goarch {
		case "amd64", "arm64", "arm", "386":
			return "cloudflared-linux-" + goarch
		}
	case "windows":
		switch goarch {
		case "amd64", "arm64":
			return "cloudflared-windows-amd64.exe"
		case "386":
			return "cloudflared-windows-386.exe"
		}
	case "darwin":
		switch goarch {
		case "amd64", "arm64":
			return "cloudflared-darwin-" + goarch + ".tgz"
		}
	}
	return ""
}

// Progress reports a download: bytes done and the total (0 if unknown).
type Progress func(done, total int64)

// Installer downloads cloudflared's latest release.
type Installer struct {
	Client *http.Client
	// API is the release URL (ReleaseAPI when "").
	API string
	// GOOS and GOARCH pick the asset (runtime's when "").
	GOOS, GOARCH string
}

type release struct {
	Tag    string `json:"tag_name"`
	Assets []struct {
		Name   string `json:"name"`
		URL    string `json:"browser_download_url"`
		Size   int64  `json:"size"`
		Digest string `json:"digest"`
	} `json:"assets"`
}

// Install downloads the latest cloudflared for this OS into
// DownloadedPath(dataDir), after checking its SHA-256 against the digest
// GitHub publishes for the asset. It returns the installed path and the
// release tag.
func (in Installer) Install(ctx context.Context, dataDir string, progress Progress) (string, string, error) {
	goos, goarch := in.GOOS, in.GOARCH
	if goos == "" {
		goos = goosDefault
	}
	if goarch == "" {
		goarch = goarchDefault
	}
	name := AssetName(goos, goarch)
	if name == "" {
		return "", "", fmt.Errorf("cloudflared has no download for %s/%s; install it yourself and choose it in Settings", goos, goarch)
	}
	rel, err := in.latest(ctx)
	if err != nil {
		return "", "", err
	}
	var url, digest string
	var size int64
	for _, a := range rel.Assets {
		if a.Name == name {
			url, digest, size = a.URL, a.Digest, a.Size
		}
	}
	if url == "" {
		return "", "", fmt.Errorf("cloudflared %s has no %s download", rel.Tag, name)
	}
	want, ok := strings.CutPrefix(digest, "sha256:")
	if !ok || len(want) != sha256.Size*2 {
		return "", "", fmt.Errorf("cloudflared %s has no SHA-256 checksum for %s, so it wasn't installed", rel.Tag, name)
	}

	dir := filepath.Join(dataDir, BinDir)
	if err := os.MkdirAll(dir, 0o700); err != nil { //nolint:gosec // the app data dir, not from the download
		return "", "", fmt.Errorf("create %s: %w", dir, err)
	}
	tmp, err := in.download(ctx, url, dir, size, want, progress)
	if err != nil {
		return "", "", err
	}
	defer os.Remove(tmp)

	exe := tmp
	if strings.HasSuffix(name, ".tgz") {
		exe, err = extract(tmp, dir)
		if err != nil {
			return "", "", err
		}
		defer os.Remove(exe)
	}
	if err := os.Chmod(exe, 0o755); err != nil { //nolint:gosec // an executable
		return "", "", fmt.Errorf("make cloudflared executable: %w", err)
	}
	target := filepath.Join(dir, exeName(goos))
	if err := os.Rename(exe, target); err != nil { //nolint:gosec // temp file and fixed name in the app data dir
		return "", "", fmt.Errorf("install cloudflared: %w", err)
	}
	return target, rel.Tag, nil
}

func exeName(goos string) string {
	if goos == "windows" {
		return "cloudflared.exe"
	}
	return "cloudflared"
}

func (in Installer) client() *http.Client {
	if in.Client != nil {
		return in.Client
	}
	return http.DefaultClient
}

func (in Installer) latest(ctx context.Context) (release, error) {
	api := in.API
	if api == "" {
		api = ReleaseAPI
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, api, nil)
	if err != nil {
		return release{}, err
	}
	req.Header.Set("Accept", "application/vnd.github+json")
	resp, err := in.client().Do(req)
	if err != nil {
		return release{}, fmt.Errorf("find the latest cloudflared: %w", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return release{}, fmt.Errorf("find the latest cloudflared: GitHub answered %s", resp.Status)
	}
	var rel release
	if err := json.NewDecoder(io.LimitReader(resp.Body, 4<<20)).Decode(&rel); err != nil {
		return release{}, fmt.Errorf("read the latest cloudflared release: %w", err)
	}
	return rel, nil
}

// download saves url into a temp file in dir and checks its SHA-256.
func (in Installer) download(ctx context.Context, url, dir string, size int64, want string, progress Progress) (string, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, url, nil)
	if err != nil {
		return "", err
	}
	resp, err := in.client().Do(req)
	if err != nil {
		return "", fmt.Errorf("download cloudflared: %w", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return "", fmt.Errorf("download cloudflared: the server answered %s", resp.Status)
	}
	if size <= 0 {
		size = resp.ContentLength
	}
	f, err := os.CreateTemp(dir, ".download-*")
	if err != nil {
		return "", fmt.Errorf("download cloudflared: %w", err)
	}
	ok := false
	defer func() {
		_ = f.Close()
		if !ok {
			_ = os.Remove(f.Name()) //nolint:gosec // our own temp file
		}
	}()
	h := sha256.New()
	pw := &progressWriter{total: size, fn: progress}
	n, err := io.Copy(io.MultiWriter(f, h, pw), io.LimitReader(resp.Body, MaxDownload+1))
	if err != nil {
		return "", fmt.Errorf("download cloudflared: %w", err)
	}
	if n > MaxDownload {
		return "", errors.New("download cloudflared: the file is larger than expected")
	}
	if got := hex.EncodeToString(h.Sum(nil)); !strings.EqualFold(got, want) {
		return "", errors.New("the downloaded cloudflared doesn't match its published SHA-256 checksum, so it wasn't installed")
	}
	if err := f.Close(); err != nil {
		return "", fmt.Errorf("download cloudflared: %w", err)
	}
	ok = true
	return f.Name(), nil
}

type progressWriter struct {
	done, total int64
	fn          Progress
}

func (p *progressWriter) Write(b []byte) (int, error) {
	p.done += int64(len(b))
	if p.fn != nil {
		p.fn(p.done, p.total)
	}
	return len(b), nil
}

// extract takes the cloudflared binary out of a macOS .tgz into a temp file
// in dir.
func extract(archive, dir string) (string, error) {
	f, err := os.Open(archive) //nolint:gosec // our own temp file
	if err != nil {
		return "", err
	}
	defer f.Close()
	gz, err := gzip.NewReader(f)
	if err != nil {
		return "", fmt.Errorf("unpack cloudflared: %w", err)
	}
	tr := tar.NewReader(gz)
	for {
		hdr, err := tr.Next()
		if errors.Is(err, io.EOF) {
			return "", errors.New("unpack cloudflared: the archive has no cloudflared")
		}
		if err != nil {
			return "", fmt.Errorf("unpack cloudflared: %w", err)
		}
		if hdr.Typeflag != tar.TypeReg || path.Base(hdr.Name) != "cloudflared" {
			continue
		}
		out, err := os.CreateTemp(dir, ".extract-*")
		if err != nil {
			return "", fmt.Errorf("unpack cloudflared: %w", err)
		}
		if _, err := io.Copy(out, io.LimitReader(tr, MaxDownload)); err != nil {
			_ = out.Close()
			_ = os.Remove(out.Name()) //nolint:gosec // our own temp file
			return "", fmt.Errorf("unpack cloudflared: %w", err)
		}
		if err := out.Close(); err != nil {
			_ = os.Remove(out.Name()) //nolint:gosec // our own temp file
			return "", fmt.Errorf("unpack cloudflared: %w", err)
		}
		return out.Name(), nil
	}
}
