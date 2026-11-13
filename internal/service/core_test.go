package service

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"pakpos/internal/core/httpexec"
	"pakpos/internal/core/settings"
	"pakpos/internal/store/sqlite"
)

func TestNewCoreValidation(t *testing.T) {
	if _, err := NewCore(Config{DataDir: t.TempDir()}); err == nil {
		t.Fatal("expected error without dialogs/events")
	}
	file := filepath.Join(t.TempDir(), "file")
	_ = os.WriteFile(file, nil, 0o600)
	if _, err := NewCore(Config{DataDir: filepath.Join(file, "x"), Dialogs: &fakeDialogs{}, Events: &fakeEvents{}}); err == nil {
		t.Fatal("expected db open error")
	}
	dir := t.TempDir()
	_ = os.WriteFile(filepath.Join(dir, tempDirName), nil, 0o600) // tmp is a file
	if _, err := NewCore(Config{DataDir: dir, Dialogs: &fakeDialogs{}, Events: &fakeEvents{}}); err == nil {
		t.Fatal("expected temp dir error")
	}
}

func TestNewCoreCleansUpAndLoadsSettings(t *testing.T) {
	dir := t.TempDir()
	// Previous run: a stray spill, an orphan stored body and custom settings.
	_ = os.MkdirAll(filepath.Join(dir, tempDirName), 0o700)
	spill := filepath.Join(dir, tempDirName, httpexec.SpillPrefix+"old")
	_ = os.WriteFile(spill, nil, 0o600)
	db, err := sqlite.Open(dir)
	if err != nil {
		t.Fatal(err)
	}
	orphan := filepath.Join(dir, sqlite.BodiesDir, "42.body")
	_ = os.WriteFile(orphan, nil, 0o600)
	custom := settings.Defaults()
	custom.TimeoutMs = 1234
	_ = db.SetSetting(settingsKey, custom)
	_ = db.Close()

	c, err := NewCore(Config{DataDir: dir, Dialogs: &fakeDialogs{}, Events: &fakeEvents{}})
	if err != nil {
		t.Fatal(err)
	}
	defer c.Close()
	for _, p := range []string{spill, orphan} {
		if _, err := os.Stat(p); !os.IsNotExist(err) {
			t.Errorf("%s not cleaned up", p)
		}
	}
	if c.currentSettings().TimeoutMs != 1234 || c.executor().Settings().Timeout != 1234*time.Millisecond {
		t.Fatal("stored settings not applied")
	}
	if c.executor().Settings().TempDir != filepath.Join(dir, tempDirName) {
		t.Fatal("executor temp dir not set")
	}
}

func TestNewCoreIgnoresInvalidStoredSettings(t *testing.T) {
	dir := t.TempDir()
	db, _ := sqlite.Open(dir)
	bad := settings.Defaults()
	bad.Theme = "neon"
	_ = db.SetSetting(settingsKey, bad)
	_ = db.Close()
	c, err := NewCore(Config{DataDir: dir, Dialogs: &fakeDialogs{}, Events: &fakeEvents{}})
	if err != nil {
		t.Fatal(err)
	}
	defer c.Close()
	if c.currentSettings() != settings.Defaults() {
		t.Fatal("invalid settings should fall back to defaults")
	}
}

func TestDefaultDataDir(t *testing.T) {
	t.Setenv("XDG_CONFIG_HOME", "/cfg")
	t.Setenv("HOME", "/home/u")
	if runtimeIsLinux() {
		got, err := DefaultDataDir()
		if err != nil || got != filepath.Join("/cfg", "pakpos") {
			t.Fatalf("got %s %v", got, err)
		}
		t.Setenv("XDG_CONFIG_HOME", "")
		t.Setenv("HOME", "")
		if _, err := DefaultDataDir(); err == nil {
			t.Fatal("expected error without HOME")
		}
	} else if got, err := DefaultDataDir(); err != nil || !strings.HasSuffix(got, "pakpos") {
		t.Fatalf("got %s %v", got, err)
	}
}

func TestSendRegistry(t *testing.T) {
	h := newHarness(t)
	called := false
	if err := h.core.registerSend("a", func() { called = true }); err != nil {
		t.Fatal(err)
	}
	if err := h.core.registerSend("a", func() {}); err == nil {
		t.Fatal("duplicate id should fail")
	}
	if !h.core.cancelSend("a") || !called {
		t.Fatal("cancel not called")
	}
	h.core.unregisterSend("a")
	if h.core.cancelSend("a") {
		t.Fatal("unregistered send still cancellable")
	}
}
