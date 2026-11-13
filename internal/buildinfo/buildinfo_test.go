package buildinfo

import (
	"runtime"
	"testing"
)

func TestGet(t *testing.T) {
	oldV, oldC := Version, Commit
	t.Cleanup(func() { Version, Commit = oldV, oldC })

	Version, Commit = "1.2.3", "abc123"
	got := Get()
	want := Info{Version: "1.2.3", Commit: "abc123", OS: runtime.GOOS, Arch: runtime.GOARCH}
	if got != want {
		t.Fatalf("Get() = %+v, want %+v", got, want)
	}
}

func TestDefaults(t *testing.T) {
	if Version != "dev" {
		t.Fatalf("default Version = %q, want dev", Version)
	}
}
