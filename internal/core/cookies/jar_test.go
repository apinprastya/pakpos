package cookies

import (
	"errors"
	"net/http"
	"net/url"
	"strings"
	"testing"
	"time"
)

// memStore is a Store in memory that can fail on demand.
type memStore struct {
	m       map[Ref]Cookie
	fail    error
	loadErr error
	ops     []string
}

func newMem() *memStore { return &memStore{m: map[Ref]Cookie{}} }

func (s *memStore) LoadCookies(now time.Time) ([]Cookie, error) {
	if s.loadErr != nil {
		return nil, s.loadErr
	}
	out := []Cookie{}
	for r, c := range s.m {
		if c.ExpiresAt <= now.UnixMilli() {
			delete(s.m, r)
			continue
		}
		out = append(out, c)
	}
	return out, nil
}

func (s *memStore) SaveCookie(c Cookie) error {
	s.ops = append(s.ops, "save "+c.Name)
	if s.fail != nil {
		return s.fail
	}
	s.m[c.Ref()] = c
	return nil
}

func (s *memStore) DeleteCookie(r Ref) error {
	s.ops = append(s.ops, "delete "+r.Name)
	delete(s.m, r)
	return s.fail
}

func (s *memStore) ClearCookies(domain string) error {
	s.ops = append(s.ops, "clear "+domain)
	for r := range s.m {
		if domain == "" || r.Domain == domain {
			delete(s.m, r)
		}
	}
	return s.fail
}

type clock struct{ t time.Time }

func (c *clock) now() time.Time { return c.t }

func newJar(t *testing.T, s Store, c *clock) *Jar {
	t.Helper()
	j, err := New(Options{Store: s, Now: c.now})
	if err != nil {
		t.Fatal(err)
	}
	return j
}

func mustURL(s string) *url.URL {
	u, err := url.Parse(s)
	if err != nil {
		panic(err)
	}
	return u
}

func names(cs []*http.Cookie) string {
	var out []string
	for _, c := range cs {
		out = append(out, c.Name+"="+c.Value)
	}
	return strings.Join(out, "; ")
}

func TestSetCookiesAndMatching(t *testing.T) {
	c := &clock{t: time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC)}
	j := newJar(t, nil, c)
	j.SetCookies(mustURL("https://www.example.com/app/page"), []*http.Cookie{
		{Name: "host", Value: "1"},                                      // host-only, path /app
		{Name: "dom", Value: "2", Domain: ".example.com", Path: "/"},    // domain cookie
		{Name: "sec", Value: "3", Secure: true, Path: "/"},              // https only
		{Name: "deep", Value: "4", Path: "/app/page/x"},                 // deeper path
		{Name: "psl", Value: "5", Domain: "com"},                        // public suffix: refused
		{Name: "other", Value: "6", Domain: "other.org"},                // foreign domain: refused
		{Name: "", Value: "7"},                                          // no name: refused
		{Name: "dom2", Value: "8", Domain: "example.com", Path: "/app"}, // longer path sorts first
	})
	tests := []struct {
		url, want string
	}{
		{"https://www.example.com/app/page", "host=1; dom2=8; dom=2; sec=3"},
		{"http://www.example.com/app", "host=1; dom2=8; dom=2"},
		{"https://api.example.com/", "dom=2"},
		{"https://example.com/app/", "dom2=8; dom=2"},
		{"https://www.example.com/application", "dom=2; sec=3"},
		{"https://www.example.com/app/page/x/y", "deep=4; host=1; dom2=8; dom=2; sec=3"},
		{"ftp://www.example.com/", ""},
		{"https://other.org/", ""},
	}
	for _, tt := range tests {
		if got := names(j.Cookies(mustURL(tt.url))); got != tt.want {
			t.Errorf("Cookies(%s) = %q, want %q", tt.url, got, tt.want)
		}
	}
	j.SetCookies(mustURL("ftp://www.example.com/"), []*http.Cookie{{Name: "ftp", Value: "x"}})
	j.SetCookies(&url.URL{Scheme: "http"}, []*http.Cookie{{Name: "nohost", Value: "x"}})
	if len(j.All()) != 5 {
		t.Fatalf("all = %+v", j.All())
	}
	if j.Cookies(&url.URL{Scheme: "https"}) != nil {
		t.Fatal("cookies for an empty host")
	}
}

func TestIPAndPublicSuffixHosts(t *testing.T) {
	j := newJar(t, nil, &clock{t: time.Now()})
	j.SetCookies(mustURL("http://127.0.0.1:8080/"), []*http.Cookie{
		{Name: "a", Value: "1"},
		{Name: "b", Value: "2", Domain: "127.0.0.1"},
		{Name: "c", Value: "3", Domain: "10.0.0.1"},
	})
	if got := names(j.Cookies(mustURL("http://127.0.0.1:9090/x"))); got != "a=1; b=2" {
		t.Fatalf("got %q", got)
	}
	// A host that is itself a public suffix may set a host-only cookie.
	j.SetCookies(mustURL("https://co.uk/"), []*http.Cookie{{Name: "ps", Value: "1", Domain: "co.uk"}})
	if got := names(j.Cookies(mustURL("https://co.uk/"))); got != "ps=1" {
		t.Fatalf("got %q", got)
	}
	if got := names(j.Cookies(mustURL("https://x.co.uk/"))); got != "" {
		t.Fatalf("leaked to a sibling: %q", got)
	}
	j.SetCookies(mustURL("https://a.example.com/"), []*http.Cookie{{Name: "dot", Value: "1", Domain: "example.com."}, {Name: "dot2", Value: "1", Domain: "."}})
	if len(j.Cookies(mustURL("https://a.example.com/"))) != 0 {
		t.Fatal("bad domains accepted")
	}
}

func TestExpiryAndPersistence(t *testing.T) {
	c := &clock{t: time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC)}
	s := newMem()
	j := newJar(t, s, c)
	u := mustURL("https://example.com/")
	j.SetCookies(u, []*http.Cookie{
		{Name: "session", Value: "1"},
		{Name: "maxage", Value: "2", MaxAge: 60},
		{Name: "expires", Value: "3", Expires: c.t.Add(time.Hour)},
		{Name: "past", Value: "4", Expires: c.t.Add(-time.Hour)},
	})
	if len(s.m) != 2 {
		t.Fatalf("stored %v, want maxage and expires", s.m)
	}
	// A restart keeps the persistent ones only.
	j2 := newJar(t, s, c)
	if got := names(j2.Cookies(u)); got != "maxage=2; expires=3" {
		t.Fatalf("after restart %q", got)
	}
	// Max-Age 0 (MaxAge < 0 in net/http) deletes; a past Expires too.
	j2.SetCookies(u, []*http.Cookie{{Name: "maxage", MaxAge: -1}, {Name: "expires", Expires: c.t.Add(-time.Second)}})
	if len(s.m) != 0 || len(j2.All()) != 0 {
		t.Fatalf("not deleted: %v %v", s.m, j2.All())
	}
	// Expired cookies disappear from reads and from the store.
	j2.SetCookies(u, []*http.Cookie{{Name: "short", Value: "x", MaxAge: 1}, {Name: "short2", Value: "y", MaxAge: 1}})
	c.t = c.t.Add(2 * time.Second)
	if len(j2.Cookies(u)) != 0 || len(s.m) != 0 {
		t.Fatalf("expired cookie served: %v", s.m)
	}
	j2.SetCookies(u, []*http.Cookie{{Name: "short", Value: "x", MaxAge: 1}})
	c.t = c.t.Add(2 * time.Second)
	if len(j2.All()) != 0 || len(s.m) != 0 {
		t.Fatal("All listed an expired cookie")
	}
	// A persistent cookie replaced by a session one leaves the store.
	j2.SetCookies(u, []*http.Cookie{{Name: "flip", Value: "1", MaxAge: 60}})
	j2.SetCookies(u, []*http.Cookie{{Name: "flip", Value: "2"}})
	if len(s.m) != 0 || names(j2.Cookies(u)) != "flip=2" {
		t.Fatalf("store %v", s.m)
	}
	// Prune on load.
	s.m[Ref{"example.com", "/", "old"}] = Cookie{Name: "old", Domain: "example.com", Path: "/", ExpiresAt: 1}
	if _, err := New(Options{Store: s, Now: c.now}); err != nil || len(s.m) != 0 {
		t.Fatalf("expired cookie kept on load: %v", s.m)
	}
}

func TestStoreFailures(t *testing.T) {
	s := newMem()
	s.loadErr = errors.New("disk")
	j, err := New(Options{Store: s})
	if err == nil || j == nil {
		t.Fatal("load error not returned with an empty jar")
	}
	s.loadErr = nil
	var reported []error
	s.fail = errors.New("write")
	j, _ = New(Options{Store: s, OnError: func(err error) { reported = append(reported, err) }})
	j.SetCookies(mustURL("https://example.com/"), []*http.Cookie{{Name: "a", Value: "1", MaxAge: 60}})
	if len(reported) != 1 || len(j.All()) != 1 {
		t.Fatalf("reported %v, cookies %v", reported, j.All())
	}
	j2, _ := New(Options{Store: s}) // no OnError: failures are dropped
	j2.SetCookies(mustURL("https://example.com/"), []*http.Cookie{{Name: "a", Value: "1", MaxAge: 60}})
}

func TestManagerEdits(t *testing.T) {
	c := &clock{t: time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC)}
	s := newMem()
	j := newJar(t, s, c)
	future := c.t.Add(time.Hour).UnixMilli()

	added, err := j.Add(Cookie{Name: "tok", Value: "v 1", Domain: " .Example.com ", ExpiresAt: future, SameSite: "Lax", CreatedAt: 5})
	if err != nil {
		t.Fatal(err)
	}
	if added.Domain != "example.com" || added.HostOnly || added.Path != "/" || added.SameSite != "lax" || added.CreatedAt == 5 {
		t.Fatalf("added %+v", added)
	}
	if names(j.Cookies(mustURL("https://api.example.com/x"))) != "tok=v 1" || len(s.m) != 1 {
		t.Fatal("added cookie not sent or not stored")
	}

	// Edit in place keeps the creation time.
	upd, err := j.Update(added.Ref(), Cookie{Name: "tok", Value: "v2", Domain: "example.com", Path: "/", ExpiresAt: future})
	if err != nil || upd.CreatedAt != added.CreatedAt || upd.Value != "v2" {
		t.Fatalf("update %+v %v", upd, err)
	}
	// Renaming moves it; making it a session cookie takes it off disk.
	moved, err := j.Update(upd.Ref(), Cookie{Name: "tok2", Value: "v3", Domain: "example.com", HostOnly: true})
	if err != nil || moved.Name != "tok2" || len(s.m) != 0 || len(j.All()) != 1 {
		t.Fatalf("moved %+v %v store %v", moved, err, s.m)
	}
	if _, err := j.Update(Ref{"example.com", "/", "gone"}, moved); !errors.Is(err, ErrNotFound) {
		t.Fatalf("update of a missing cookie: %v", err)
	}
	// Renaming onto an existing cookie replaces it.
	other, _ := j.Add(Cookie{Name: "other", Value: "o", Domain: "example.com", ExpiresAt: future})
	if _, err := j.Update(other.Ref(), Cookie{Name: "tok2", Value: "o", Domain: "example.com", ExpiresAt: future}); err != nil {
		t.Fatal(err)
	}
	if len(j.All()) != 1 {
		t.Fatalf("all %+v", j.All())
	}

	bad := []Cookie{
		{Name: "", Domain: "example.com"},
		{Name: "a b", Domain: "example.com"},
		{Name: "a", Value: "x;y", Domain: "example.com"},
		{Name: "a", Domain: ""},
		{Name: "a", Domain: "exa mple.com"},
		{Name: "a", Domain: "example.com", Path: "rel"},
		{Name: "a", Domain: "example.com", ExpiresAt: c.t.Add(-time.Hour).UnixMilli()},
		{Name: "a", Domain: "example.com", ExpiresAt: -1},
		{Name: "a", Domain: "example.com", SameSite: "sometimes"},
	}
	for _, b := range bad {
		if _, err := j.Add(b); !errors.Is(err, ErrInvalid) {
			t.Errorf("Add(%+v) = %v", b, err)
		}
		if _, err := j.Update(other.Ref(), b); !errors.Is(err, ErrInvalid) {
			t.Errorf("Update(%+v) = %v", b, err)
		}
	}
	if _, err := j.Add(Cookie{Name: "ip", Value: "1", Domain: "::1"}); err != nil {
		t.Fatal(err)
	}
}

func TestDeleteAndClear(t *testing.T) {
	c := &clock{t: time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC)}
	s := newMem()
	j := newJar(t, s, c)
	future := c.t.Add(time.Hour).UnixMilli()
	for _, ck := range []Cookie{
		{Name: "a", Domain: "a.example", ExpiresAt: future},
		{Name: "b", Domain: "a.example"},
		{Name: "c", Domain: "b.example", ExpiresAt: future},
		{Name: "d", Domain: "sub.a.example", ExpiresAt: future},
	} {
		if _, err := j.Add(ck); err != nil {
			t.Fatal(err)
		}
	}
	if !j.Delete(Ref{"b.example", "/", "c"}) || j.Delete(Ref{"b.example", "/", "c"}) {
		t.Fatal("delete")
	}
	if !j.Delete(Ref{"a.example", "/", "b"}) { // a session cookie: no store call
		t.Fatal("delete session")
	}
	if n := j.ClearDomain(".A.example"); n != 1 {
		t.Fatalf("cleared %d", n)
	}
	if len(j.All()) != 1 || len(s.m) != 1 {
		t.Fatalf("left %v / %v", j.All(), s.m)
	}
	j.Clear()
	if len(j.All()) != 0 || len(s.m) != 0 {
		t.Fatal("clear")
	}
	mem := newJar(t, nil, c)
	mem.SetCookies(mustURL("https://x.example/"), []*http.Cookie{{Name: "a", Value: "1", MaxAge: 9}})
	mem.ClearDomain("x.example")
	mem.Clear()
	if len(mem.All()) != 0 {
		t.Fatal("memory jar not cleared")
	}
}

func TestHelpers(t *testing.T) {
	for in, want := range map[string]string{"": "/", "x": "/", "/": "/", "/a": "/", "/a/b": "/a", "/a/b/": "/a/b"} {
		if got := defaultPath(in); got != want {
			t.Errorf("defaultPath(%q) = %q", in, got)
		}
	}
	if pathMatch("/a", "/b") || !pathMatch("/a/", "/a/b") || !pathMatch("/a", "/a/b") || pathMatch("/a", "/ab") {
		t.Fatal("pathMatch")
	}
	for in, want := range map[http.SameSite]string{http.SameSiteLaxMode: "lax", http.SameSiteStrictMode: "strict", http.SameSiteNoneMode: "none", http.SameSiteDefaultMode: ""} {
		if sameSite(in) != want {
			t.Errorf("sameSite(%v)", in)
		}
	}
	if (Cookie{}).Persistent() {
		t.Fatal("zero cookie persistent")
	}
	if _, err := canonicalHost("[::1]:80"); err != nil {
		t.Fatal(err)
	}
}

func TestNewDefaultsClock(t *testing.T) {
	j, err := New(Options{})
	if err != nil || j.now == nil {
		t.Fatal("no clock")
	}
}
