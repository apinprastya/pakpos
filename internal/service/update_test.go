package service

import (
	"context"
	"crypto/ed25519"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"pakpos/internal/buildinfo"
	"pakpos/internal/update"
)

// updateFixture serves a signed release for an AppImage installation.
type updateFixture struct {
	srv     *httptest.Server
	release update.Release
	target  string
	pub     string
	block   chan struct{} // when set, the asset download waits on it
}

func newUpdateFixture(t *testing.T, version string) *updateFixture {
	t.Helper()
	pub, priv, _ := ed25519.GenerateKey(nil)
	name := update.AssetName(update.KindAppImage, version)
	payload := []byte("new build")
	h := sha256.Sum256(payload)
	sums := fmt.Appendf(nil, "%s  %s\n", hex.EncodeToString(h[:]), name)
	sig := []byte(base64.StdEncoding.EncodeToString(ed25519.Sign(priv, sums)))
	files := map[string][]byte{name: payload, update.SumsName: sums, update.SigName: sig}

	f := &updateFixture{pub: base64.StdEncoding.EncodeToString(pub)}
	f.srv = httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/latest" {
			_ = json.NewEncoder(w).Encode(f.release)
			return
		}
		n := strings.TrimPrefix(r.URL.Path, "/dl/")
		if n == name && f.block != nil {
			select {
			case <-f.block:
			case <-r.Context().Done():
				return
			}
		}
		_, _ = w.Write(files[n])
	}))
	t.Cleanup(f.srv.Close)
	f.release = update.Release{Tag: "v" + version, Name: "Pakpos " + version, Notes: "notes",
		URL: ReleasesPage + "/tag/v" + version, PublishedAt: time.Date(2026, 11, 1, 0, 0, 0, 0, time.UTC)}
	for n, b := range files {
		f.release.Assets = append(f.release.Assets, update.Asset{Name: n, URL: f.srv.URL + "/dl/" + n, Size: int64(len(b))})
	}
	f.target = filepath.Join(t.TempDir(), "Pakpos.AppImage")
	if err := os.WriteFile(f.target, []byte("old"), 0o755); err != nil {
		t.Fatal(err)
	}
	return f
}

func (f *updateFixture) service(version string, events Events, app AppControl) *UpdateService {
	return NewUpdateService(UpdateConfig{
		Updater: &update.Updater{
			Client:    f.srv.Client(),
			APIURL:    f.srv.URL + "/latest",
			PublicKey: f.pub,
			Install:   update.Installation{Kind: update.KindAppImage, Target: f.target},
			TempDir:   filepath.Dir(f.target),
		},
		Events:  events,
		App:     app,
		Version: version,
	})
}

// fakeApp records what the update service asks of the app.
type fakeApp struct {
	opened  string
	openErr error
	quit    bool
}

func (a *fakeApp) OpenURL(u string) error { a.opened = u; return a.openErr }
func (a *fakeApp) Quit()                  { a.quit = true }

// eventFunc adapts a function to Events.
type eventFunc func(name string, data any)

func (f eventFunc) Emit(name string, data any) { f(name, data) }

func TestNewUpdateServiceDefaults(t *testing.T) {
	s := NewUpdateService(UpdateConfig{Updater: &update.Updater{}})
	if s.version != buildinfo.Version || s.start == nil {
		t.Fatalf("defaults: %q %v", s.version, s.start == nil)
	}
	if userText(errors.New("")) != "" || userText(errors.New("abc")) != "Abc" {
		t.Fatal("userText")
	}
}

func TestUpdateServiceCheckInstallRestart(t *testing.T) {
	f := newUpdateFixture(t, "26.11.2")
	var mu sync.Mutex
	var events []UpdateProgress
	s := f.service("26.11.1", nil, nil)
	s.events = eventFunc(func(name string, data any) {
		mu.Lock()
		defer mu.Unlock()
		if name == EventUpdateProgress {
			events = append(events, data.(UpdateProgress))
		}
	})
	ctx := context.Background()

	if err := s.Install(ctx); !errors.Is(err, update.ErrNoRelease) {
		t.Fatalf("Install before Check: %v", err)
	}
	if err := s.Restart(); err == nil {
		t.Fatal("Restart before Install")
	}

	info, err := s.Check(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if !info.Available || !info.CanInstall || info.Reason != "" || info.Latest != "26.11.2" || info.Current != "26.11.1" ||
		info.Notes != "notes" || info.PublishedAt != "2026-11-01T00:00:00Z" {
		t.Fatalf("info = %+v", info)
	}

	if err := s.Install(ctx); err != nil {
		t.Fatal(err)
	}
	if b, _ := os.ReadFile(f.target); string(b) != "new build" {
		t.Fatalf("target = %q", b)
	}
	if len(events) == 0 || events[len(events)-1].Done != events[len(events)-1].Total {
		t.Fatalf("progress = %+v", events)
	}
	if s.Cancel() {
		t.Fatal("Cancel with nothing running")
	}

	// Restart needs the app.
	if err := s.Restart(); err == nil {
		t.Fatal("Restart without an app")
	}
	app := &fakeApp{}
	s.app = app
	var started string
	s.start = func(name string, args []string) error { started = name; return nil }
	if err := s.Restart(); err != nil || started != f.target || !app.quit {
		t.Fatalf("Restart: %v %q %v", err, started, app.quit)
	}
	s.start = func(string, []string) error { return errors.New("boom") }
	app.quit = false
	if err := s.Restart(); err == nil || app.quit {
		t.Fatal("failed start quit anyway")
	}
}

func TestUpdateServiceNotNewerAndBlockers(t *testing.T) {
	f := newUpdateFixture(t, "26.11.2")
	ctx := context.Background()

	s := f.service("26.11.2", nil, nil)
	info, err := s.Check(ctx)
	if err != nil || info.Available || info.CanInstall {
		t.Fatalf("same version: %+v %v", info, err)
	}
	if err := s.Install(ctx); !errors.Is(err, update.ErrNotNewer) {
		t.Fatal(err)
	}

	s.version = "dev"
	info, _ = s.Check(ctx)
	if !info.Available || info.CanInstall || !strings.Contains(info.Reason, "development") {
		t.Fatalf("dev: %+v", info)
	}
	if err := s.Install(ctx); err == nil || !strings.Contains(err.Error(), "development") {
		t.Fatal(err)
	}

	s.version = "26.11.1"
	s.updater.PublicKey = ""
	if info, _ = s.Check(ctx); info.CanInstall || info.Reason != userText(update.ErrNoKey) {
		t.Fatalf("no key: %+v", info)
	}
	s.updater.Install = update.Installation{Kind: update.KindManual, Reason: "use apt"}
	if info, _ = s.Check(ctx); info.CanInstall || info.Reason != "use apt" {
		t.Fatalf("manual: %+v", info)
	}
}

func TestUpdateServiceCheckError(t *testing.T) {
	s := NewUpdateService(UpdateConfig{Updater: &update.Updater{APIURL: "http://insecure"}})
	if _, err := s.Check(context.Background()); err == nil {
		t.Fatal("expected error")
	}
}

func TestUpdateServiceCancel(t *testing.T) {
	f := newUpdateFixture(t, "26.11.2")
	f.block = make(chan struct{})
	defer close(f.block)
	s := f.service("26.11.1", nil, nil)
	if _, err := s.Check(context.Background()); err != nil {
		t.Fatal(err)
	}
	done := make(chan error, 1)
	go func() { done <- s.Install(context.Background()) }()

	deadline := time.Now().Add(5 * time.Second)
	for !s.Cancel() {
		if time.Now().After(deadline) {
			t.Fatal("install never started")
		}
		// A second Install is refused while one runs.
		time.Sleep(5 * time.Millisecond)
	}
	if err := <-done; err == nil {
		t.Fatal("cancelled install succeeded")
	}
	if b, _ := os.ReadFile(f.target); string(b) != "old" {
		t.Fatal("target changed")
	}
}

func TestUpdateServiceConcurrentInstall(t *testing.T) {
	f := newUpdateFixture(t, "26.11.2")
	f.block = make(chan struct{})
	s := f.service("26.11.1", nil, nil)
	if _, err := s.Check(context.Background()); err != nil {
		t.Fatal(err)
	}
	done := make(chan error, 1)
	go func() { done <- s.Install(context.Background()) }()
	deadline := time.Now().Add(5 * time.Second)
	for {
		s.mu.Lock()
		running := s.cancel != nil
		s.mu.Unlock()
		if running {
			break
		}
		if time.Now().After(deadline) {
			t.Fatal("install never started")
		}
		time.Sleep(5 * time.Millisecond)
	}
	if err := s.Install(context.Background()); err == nil || !strings.Contains(err.Error(), "already") {
		t.Fatalf("second install: %v", err)
	}
	close(f.block)
	if err := <-done; err != nil {
		t.Fatal(err)
	}
}

func TestUpdateServiceOpenReleasePage(t *testing.T) {
	s := NewUpdateService(UpdateConfig{Updater: &update.Updater{}})
	if err := s.OpenReleasePage(); err == nil || !strings.Contains(err.Error(), ReleasesPage) {
		t.Fatal(err)
	}
	app := &fakeApp{}
	s.app = app
	if err := s.OpenReleasePage(); err != nil || app.opened != ReleasesPage {
		t.Fatalf("%v %q", err, app.opened)
	}
	s.release = &update.Release{URL: ReleasesPage + "/tag/v26.11.2"}
	_ = s.OpenReleasePage()
	if app.opened != ReleasesPage+"/tag/v26.11.2" {
		t.Fatal(app.opened)
	}
	s.release = &update.Release{URL: "https://evil.example/x"}
	_ = s.OpenReleasePage()
	if app.opened != ReleasesPage {
		t.Fatalf("untrusted URL opened: %q", app.opened)
	}
}
