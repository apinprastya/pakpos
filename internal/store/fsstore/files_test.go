package fsstore

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func TestSlugify(t *testing.T) {
	cases := []struct{ in, want string }{
		{"Get user", "get-user"},
		{"  POST /users/:id  ", "post-users-id"},
		{"Héllo wörld", "h-llo-w-rld"},
		{"---", "fb"},
		{"", "fb"},
		{"_collection", "collection"},
		{strings.Repeat("ab ", 40), strings.TrimRight(strings.Repeat("ab-", 20), "-")},
		{"日本語", "fb"},
	}
	for _, c := range cases {
		if got := slugify(c.in, "fb"); got != c.want {
			t.Errorf("slugify(%q) = %q, want %q", c.in, got, c.want)
		}
	}
}

func TestUniqueName(t *testing.T) {
	dir := t.TempDir()
	if got := uniqueName(dir, "a", ".yaml"); got != "a.yaml" {
		t.Fatal(got)
	}
	_ = os.WriteFile(filepath.Join(dir, "A.yaml"), nil, 0o644)
	_ = os.WriteFile(filepath.Join(dir, "a-2.yaml"), nil, 0o644)
	if got := uniqueName(dir, "a", ".yaml"); got != "a-3.yaml" {
		t.Fatalf("got %s", got)
	}
	if got := uniqueName(filepath.Join(dir, "missing"), "a", ""); got != "a" {
		t.Fatal(got)
	}
}

func TestWriteFileAtomic(t *testing.T) {
	dir := t.TempDir()
	p := filepath.Join(dir, "f.yaml")
	if err := writeFileAtomic(p, []byte("one")); err != nil {
		t.Fatal(err)
	}
	if err := writeFileAtomic(p, []byte("two")); err != nil {
		t.Fatal(err)
	}
	got, _ := os.ReadFile(p)
	entries, _ := os.ReadDir(dir)
	if string(got) != "two" || len(entries) != 1 {
		t.Fatalf("content=%q entries=%d", got, len(entries))
	}
	if err := writeFileAtomic(filepath.Join(dir, "missing", "f"), nil); err == nil {
		t.Fatal("expected error for missing dir")
	}
	// Rename onto a directory fails and the temp file is cleaned up.
	_ = os.Mkdir(filepath.Join(dir, "d"), 0o755)
	_ = os.WriteFile(filepath.Join(dir, "d", "x"), nil, 0o644)
	if err := writeFileAtomic(filepath.Join(dir, "d"), []byte("x")); err == nil {
		t.Fatal("expected rename error")
	}
	entries, _ = os.ReadDir(dir)
	for _, e := range entries {
		if strings.HasPrefix(e.Name(), tempPrefix) {
			t.Fatal("temp file left behind")
		}
	}
}

func TestMarshalYAMLError(t *testing.T) {
	if _, err := marshalYAML(make(chan int)); err == nil {
		t.Fatal("expected error")
	}
	ws := newWS(t)
	if err := ws.writeYAML(filepath.Join(ws.Root(), "x"), func() {}); err == nil {
		t.Fatal("expected error")
	}
}

func TestOwnWriteWindow(t *testing.T) {
	ws := newWS(t)
	ws.markWrite("/a")
	if !ws.isOwnWrite("/a") || ws.isOwnWrite("/b") {
		t.Fatal("own write tracking wrong")
	}
	ws.writes["/old"] = time.Now().Add(-time.Hour)
	if ws.isOwnWrite("/old") {
		t.Fatal("expired write still counted")
	}
	ws.markWrite("/c") // prunes expired entries
	if _, ok := ws.writes["/old"]; ok {
		t.Fatal("expired entry not pruned")
	}
}
