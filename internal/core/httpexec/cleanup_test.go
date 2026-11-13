package httpexec

import (
	"context"
	"net/http"
	"net/http/cookiejar"
	"net/http/httptest"
	"os"
	"path/filepath"
	"testing"
	"time"

	"pakpos/internal/core/model"
)

func TestCleanupSpills(t *testing.T) {
	dir := t.TempDir()
	now := time.Now()
	write := func(name string, age time.Duration) string {
		p := filepath.Join(dir, name)
		if err := os.WriteFile(p, []byte("x"), 0o600); err != nil {
			t.Fatal(err)
		}
		mt := now.Add(-age)
		if err := os.Chtimes(p, mt, mt); err != nil {
			t.Fatal(err)
		}
		return p
	}
	old := write(SpillPrefix+"old", 2*time.Hour)
	fresh := write(SpillPrefix+"fresh", time.Minute)
	other := write("unrelated", 2*time.Hour)
	if err := os.Mkdir(filepath.Join(dir, SpillPrefix+"dir"), 0o700); err != nil {
		t.Fatal(err)
	}

	n, err := CleanupSpills(dir, time.Hour, now)
	if err != nil || n != 1 {
		t.Fatalf("CleanupSpills = %d, %v; want 1, nil", n, err)
	}
	for p, want := range map[string]bool{old: false, fresh: true, other: true} {
		if _, err := os.Stat(p); (err == nil) != want {
			t.Errorf("%s exists=%v, want %v", filepath.Base(p), err == nil, want)
		}
	}

	if n, err := CleanupSpills(filepath.Join(dir, "missing"), 0, now); n != 0 || err != nil {
		t.Fatalf("missing dir: %d, %v", n, err)
	}
	if _, err := CleanupSpills(old+"\x00", 0, now); err == nil {
		t.Fatal("expected error for invalid dir")
	}
}

func TestCookieJarPersistsCookies(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/set" {
			http.SetCookie(w, &http.Cookie{Name: "sid", Value: "abc", Path: "/"})
			return
		}
		c, err := r.Cookie("sid")
		if err != nil {
			w.WriteHeader(http.StatusUnauthorized)
			return
		}
		_, _ = w.Write([]byte(c.Value))
	}))
	t.Cleanup(srv.Close)

	jar, _ := cookiejar.New(nil)
	e := newExec(t, func(s *Settings) { s.Jar = jar })
	ctx := context.Background()
	if _, err := e.Execute(ctx, "", model.Request{Method: "GET", URL: srv.URL + "/set"}); err != nil {
		t.Fatal(err)
	}
	resp, err := e.Execute(ctx, "", model.Request{Method: "GET", URL: srv.URL + "/get"})
	if err != nil {
		t.Fatal(err)
	}
	if resp.StatusCode != 200 || resp.Body != "abc" {
		t.Fatalf("got %d %q, want cookie echoed", resp.StatusCode, resp.Body)
	}

	noJar := newExec(t, nil)
	resp, err = noJar.Execute(ctx, "", model.Request{Method: "GET", URL: srv.URL + "/get"})
	if err != nil || resp.StatusCode != http.StatusUnauthorized {
		t.Fatalf("without jar: %v %v", resp, err)
	}
}
