package httpexec

import (
	"context"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
	"time"

	"pakpos/internal/core/model"
	"pakpos/internal/testnet"
)

func ptr[T any](v T) *T { return &v }

func TestMatchHost(t *testing.T) {
	tests := []struct {
		pattern, host string
		want          bool
	}{
		{"*", "anything.example", true},
		{"example.com", "example.com", true},
		{"Example.COM.", "example.com", true},
		{"example.com", "api.example.com", false},
		{"*.example.com", "api.example.com", true},
		{"*.example.com", "example.com", false},
		{".example.com", "example.com", true},
		{".example.com", "a.b.example.com", true},
		{".example.com", "badexample.com", false},
		{"10.0.0.0/8", "10.1.2.3", true},
		{"10.0.0.0/8", "11.1.2.3", false},
		{"10.0.0.0/8", "ten.example", false},
		{"bad/cidr", "10.0.0.1", false},
		{"", "example.com", false},
		{"example.com", "", false},
		{"::1", "::1", true},
	}
	for _, tt := range tests {
		if got := MatchHost(tt.pattern, tt.host); got != tt.want {
			t.Errorf("MatchHost(%q, %q) = %v, want %v", tt.pattern, tt.host, got, tt.want)
		}
	}
}

func TestCheckHostPattern(t *testing.T) {
	for _, ok := range []string{"*", "example.com", "*.local", ".corp", "10.0.0.0/8", "::1", "192.168.1.1"} {
		if err := CheckHostPattern(ok); err != nil {
			t.Errorf("CheckHostPattern(%q) = %v", ok, err)
		}
	}
	for _, bad := range []string{"", "10.0.0.0/99", "a b", "host:80", "a.*.com", "**", "foo*"} {
		if err := CheckHostPattern(bad); err == nil {
			t.Errorf("CheckHostPattern(%q) accepted", bad)
		}
	}
}

func TestParseHostList(t *testing.T) {
	got := ParseHostList(" localhost, *.Local.\n10.0.0.0/8;;  example.com\r\n")
	want := []string{"localhost", "*.local", "10.0.0.0/8", "example.com"}
	if strings.Join(got, "|") != strings.Join(want, "|") {
		t.Fatalf("got %q", got)
	}
	if got := ParseHostList(""); got == nil || len(got) != 0 {
		t.Fatalf("empty list = %#v", got)
	}
}

func TestParseProxyURL(t *testing.T) {
	tests := []struct {
		in, want, err string
	}{
		{"http://proxy:8080", "http://proxy:8080", ""},
		{" SOCKS5://proxy:1080/ ", "socks5://proxy:1080", ""},
		{"https://p.example", "https://p.example", ""},
		{"", "", "enter the proxy URL"},
		{"ftp://proxy", "", "must start with"},
		{"http://", "", "has no host"},
		{"http://user:pw@proxy", "", "own fields"},
		{"http://[::1", "", "isn't valid"},
	}
	for _, tt := range tests {
		u, err := ParseProxyURL(tt.in)
		if tt.err != "" {
			if err == nil || !strings.Contains(err.Error(), tt.err) {
				t.Errorf("ParseProxyURL(%q) error = %v, want %q", tt.in, err, tt.err)
			}
			continue
		}
		if err != nil || u.String() != tt.want {
			t.Errorf("ParseProxyURL(%q) = %v, %v", tt.in, u, err)
		}
	}
}

func TestRequestSettingsOverrideApp(t *testing.T) {
	var hits int
	mux := http.NewServeMux()
	mux.HandleFunc("/slow", func(w http.ResponseWriter, r *http.Request) {
		select {
		case <-time.After(2 * time.Second):
		case <-r.Context().Done():
		}
	})
	mux.HandleFunc("/hop/", func(w http.ResponseWriter, r *http.Request) {
		hits++
		http.Redirect(w, r, "/hop/again", http.StatusFound)
	})
	mux.HandleFunc("/redirect", func(w http.ResponseWriter, r *http.Request) {
		http.Redirect(w, r, "/done", http.StatusFound)
	})
	mux.HandleFunc("/done", func(w http.ResponseWriter, _ *http.Request) { _, _ = io.WriteString(w, "done") })
	srv := httptest.NewServer(mux)
	defer srv.Close()

	e := newExec(t, func(s *Settings) { s.Timeout = 0; s.FollowRedirects = true; s.MaxRedirects = 10 })

	t.Run("timeout", func(t *testing.T) {
		_, err := e.Execute(context.Background(), "", model.Request{URL: srv.URL + "/slow", Settings: model.RequestSettings{TimeoutMs: ptr(50)}})
		wantKind(t, err, KindTimeout)
	})
	t.Run("no follow", func(t *testing.T) {
		resp, _ := send(t, e, model.Request{URL: srv.URL + "/redirect", Settings: model.RequestSettings{FollowRedirects: ptr(false)}})
		if resp.StatusCode != http.StatusFound {
			t.Fatalf("status %d", resp.StatusCode)
		}
	})
	t.Run("app follows", func(t *testing.T) {
		resp, _ := send(t, e, model.Request{URL: srv.URL + "/redirect"})
		if resp.StatusCode != http.StatusOK {
			t.Fatalf("status %d", resp.StatusCode)
		}
	})
	t.Run("max redirects", func(t *testing.T) {
		hits = 0
		_, err := e.Execute(context.Background(), "", model.Request{URL: srv.URL + "/hop/", Settings: model.RequestSettings{MaxRedirects: ptr(2)}})
		wantKind(t, err, KindTooManyRedirects)
		if hits != 3 {
			t.Fatalf("hits = %d, want 3", hits)
		}
	})
	t.Run("follow when the app doesn't", func(t *testing.T) {
		off := newExec(t, func(s *Settings) { s.FollowRedirects = false })
		resp, _ := send(t, off, model.Request{URL: srv.URL + "/redirect", Settings: model.RequestSettings{FollowRedirects: ptr(true)}})
		if resp.StatusCode != http.StatusOK {
			t.Fatalf("status %d", resp.StatusCode)
		}
	})
	t.Run("invalid", func(t *testing.T) {
		for _, rs := range []model.RequestSettings{{TimeoutMs: ptr(-1)}, {TimeoutMs: ptr(MaxTimeoutMs + 1)}, {MaxRedirects: ptr(0)}, {MaxRedirects: ptr(51)}} {
			_, err := e.Execute(context.Background(), "", model.Request{URL: srv.URL + "/done", Settings: rs})
			wantKind(t, err, KindInvalidRequest)
		}
	})
}

func TestVerifyTLSOverrideKeepsPools(t *testing.T) {
	ca := testnet.NewCA(t, "CA")
	srv := testnet.TLSServer(t, ca, nil, http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) { _, _ = io.WriteString(w, "ok") }))
	cache := NewTransports()
	e := newExec(t, func(s *Settings) { s.Transports = cache })

	_, err := e.Execute(context.Background(), "", model.Request{URL: srv.URL})
	wantKind(t, err, KindTLS)
	resp, err := e.Execute(context.Background(), "", model.Request{URL: srv.URL, Settings: model.RequestSettings{VerifyTLS: ptr(false)}})
	if err != nil || resp.StatusCode != 200 {
		t.Fatalf("insecure send: %v", err)
	}
	if cache.Len() != 2 {
		t.Fatalf("cached transports = %d, want 2 (verified and not)", cache.Len())
	}
	// The app turns verification off; a request turns it back on.
	insecure := newExec(t, func(s *Settings) { s.Transports = cache; s.InsecureSkipVerify = true })
	_, err = insecure.Execute(context.Background(), "", model.Request{URL: srv.URL, Settings: model.RequestSettings{VerifyTLS: ptr(true)}})
	wantKind(t, err, KindTLS)
	if cache.Len() != 2 {
		t.Fatalf("cached transports = %d", cache.Len())
	}
	cache.Reset()
	if cache.Len() != 0 {
		t.Fatal("Reset kept transports")
	}
}

func TestCustomCA(t *testing.T) {
	ca := testnet.NewCA(t, "CA")
	srv := testnet.TLSServer(t, ca, nil, http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) { _, _ = io.WriteString(w, "ok") }))
	dir := t.TempDir()
	caFile := testnet.WriteFile(t, dir, "ca.pem", ca.PEM)

	e := newExec(t, func(s *Settings) { s.Network.CAFile = caFile })
	resp, _ := send(t, e, model.Request{URL: srv.URL})
	if resp.Body != "ok" {
		t.Fatalf("body %q", resp.Body)
	}

	for name, path := range map[string]string{
		"missing": filepath.Join(dir, "nope.pem"),
		"not pem": testnet.WriteFile(t, dir, "junk.pem", []byte("junk")),
	} {
		t.Run(name, func(t *testing.T) {
			bad := newExec(t, func(s *Settings) { s.Network.CAFile = path })
			_, err := bad.Execute(context.Background(), "", model.Request{URL: srv.URL})
			wantKind(t, err, KindTLS)
			if !strings.Contains(err.(*Error).Message, path) {
				t.Fatalf("message %q doesn't name the file", err.(*Error).Message)
			}
			if err := (Network{CAFile: path}).Check(); err == nil {
				t.Fatal("Check accepted a bad CA file")
			}
			// Without verification the CA isn't needed.
			if _, err := bad.Execute(context.Background(), "", model.Request{URL: srv.URL, Settings: model.RequestSettings{VerifyTLS: ptr(false)}}); err != nil {
				t.Fatal(err)
			}
		})
	}
}

func TestClientCertificates(t *testing.T) {
	ca := testnet.NewCA(t, "Server CA")
	clients := testnet.NewCA(t, "Client CA")
	srv := testnet.TLSServer(t, ca, clients, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_, _ = io.WriteString(w, r.TLS.PeerCertificates[0].Subject.CommonName)
	}))
	dir := t.TempDir()
	caFile := testnet.WriteFile(t, dir, "ca.pem", ca.PEM)
	me := clients.Client(t, "me")
	certFile := testnet.WriteFile(t, dir, "me.crt", me.CertPEM)
	keyFile := testnet.WriteFile(t, dir, "me.key", me.KeyPEM)
	pfx := testnet.WriteFile(t, dir, "me.p12", me.PKCS12(t, clients, "s3cret"))
	secrets := map[string]string{CertSecret("p12"): "s3cret", CertSecret("wrong"): "nope"}
	lookup := func(name string) (string, error) { return secrets[name], nil }

	tests := []struct {
		name  string
		certs []ClientCert
		kind  ErrorKind // "" means success
	}{
		{"pem", []ClientCert{{ID: "pem", Host: "127.0.0.1", CertFile: certFile, KeyFile: keyFile}}, ""},
		{"pkcs12", []ClientCert{{ID: "p12", Host: "*", PFXFile: pfx}}, ""},
		{"first match wins", []ClientCert{{ID: "other", Host: "example.com", CertFile: "x", KeyFile: "y"}, {ID: "p12", Host: "10.0.0.0/8"}, {ID: "pem", Host: "127.0.0.0/8", CertFile: certFile, KeyFile: keyFile}}, ""},
		{"none matches", []ClientCert{{ID: "pem", Host: "example.com", CertFile: certFile, KeyFile: keyFile}}, KindTLS},
		{"wrong passphrase", []ClientCert{{ID: "wrong", Host: "*", PFXFile: pfx}}, KindTLS},
		{"missing pfx", []ClientCert{{ID: "p12", Host: "*", PFXFile: filepath.Join(dir, "nope.p12")}}, KindTLS},
		{"not pkcs12", []ClientCert{{ID: "p12", Host: "*", PFXFile: certFile}}, KindTLS},
		{"missing pem", []ClientCert{{ID: "pem", Host: "*", CertFile: filepath.Join(dir, "nope"), KeyFile: keyFile}}, KindTLS},
		{"mismatched key", []ClientCert{{ID: "pem", Host: "*", CertFile: certFile, KeyFile: caFile}}, KindTLS},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			e := newExec(t, func(s *Settings) {
				s.Network = Network{CAFile: caFile, ClientCerts: tt.certs, Secret: lookup}
			})
			resp, err := e.Execute(context.Background(), "", model.Request{URL: srv.URL})
			if tt.kind != "" {
				wantKind(t, err, tt.kind)
				return
			}
			if err != nil || resp.Body != "me" {
				t.Fatalf("resp %+v err %v", resp, err)
			}
		})
	}

	t.Run("locked store", func(t *testing.T) {
		e := newExec(t, func(s *Settings) {
			s.Network = Network{CAFile: caFile, ClientCerts: []ClientCert{{ID: "p12", Host: "*", PFXFile: pfx}},
				Secret: func(string) (string, error) { return "", errors.New("locked") }}
		})
		_, err := e.Execute(context.Background(), "", model.Request{URL: srv.URL})
		wantKind(t, err, KindTLS)
	})

	t.Run("check", func(t *testing.T) {
		good := Network{CAFile: caFile, ClientCerts: []ClientCert{{ID: "pem", Host: "*", CertFile: certFile, KeyFile: keyFile}, {ID: "p12", Host: "*", PFXFile: pfx}}}
		if err := good.Check(); err != nil {
			t.Fatal(err)
		}
		for _, bad := range []ClientCert{{ID: "a", Host: "*", PFXFile: filepath.Join(dir, "nope")}, {ID: "b", Host: "*", CertFile: certFile, KeyFile: caFile}} {
			if err := (Network{ClientCerts: []ClientCert{bad}}).Check(); err == nil {
				t.Fatalf("Check accepted %+v", bad)
			}
		}
		if err := (Network{Proxy: Proxy{Mode: ProxyCustom, URL: "ftp://x"}}).Check(); err == nil {
			t.Fatal("Check accepted an ftp proxy")
		}
	})
}

func TestFileProblem(t *testing.T) {
	dir := t.TempDir()
	_, err := os.ReadFile(filepath.Join(dir, "nope"))
	if got := fileProblem(err); got != "it doesn't exist" {
		t.Fatalf("got %q", got)
	}
	if got := fileProblem(errors.New("boom")); got != "boom" {
		t.Fatalf("got %q", got)
	}
	_, err = os.ReadFile(dir) // a directory
	if got := fileProblem(err); got == "" {
		t.Fatal("empty")
	}
	if runtime.GOOS != "windows" {
		p := filepath.Join(dir, "locked")
		_ = os.WriteFile(p, []byte("x"), 0o000)
		if _, err := os.ReadFile(p); err != nil && os.Getuid() != 0 {
			if got := fileProblem(err); got != "permission denied" {
				t.Fatalf("got %q", got)
			}
		}
	}
}

func TestCustomProxy(t *testing.T) {
	target := newEchoServer(t)
	proxy := testnet.NewProxy(t)
	ca := testnet.NewCA(t, "CA")
	tlsTarget := testnet.TLSServer(t, ca, nil, http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) { _, _ = io.WriteString(w, "tunnel") }))
	caFile := testnet.WriteFile(t, t.TempDir(), "ca.pem", ca.PEM)
	lookup := func(name string) (string, error) {
		if name == SecretProxy {
			return "pw", nil
		}
		return "", nil
	}
	e := newExec(t, func(s *Settings) {
		s.Network = Network{Proxy: Proxy{Mode: ProxyCustom, URL: proxy.URL, Username: "me"}, CAFile: caFile, Secret: lookup}
	})

	resp, _ := send(t, e, model.Request{URL: target.URL + "/via"})
	if resp.StatusCode != 200 {
		t.Fatalf("status %d", resp.StatusCode)
	}
	resp, _ = send(t, e, model.Request{URL: tlsTarget.URL})
	if resp.Body != "tunnel" {
		t.Fatalf("body %q", resp.Body)
	}
	seen, auth := proxy.Seen(), proxy.Auth()
	if len(seen) != 2 || !strings.HasPrefix(seen[0], "GET http://") || !strings.HasPrefix(seen[1], "CONNECT ") {
		t.Fatalf("seen %v", seen)
	}
	for _, a := range auth {
		if a != "Basic bWU6cHc=" { // me:pw
			t.Fatalf("Proxy-Authorization %q", a)
		}
	}

	t.Run("bypass", func(t *testing.T) {
		u, _ := url.Parse(target.URL)
		direct := newExec(t, func(s *Settings) {
			s.Network = Network{Proxy: Proxy{Mode: ProxyCustom, URL: proxy.URL, Bypass: []string{u.Hostname()}}}
		})
		before := len(proxy.Seen())
		send(t, direct, model.Request{URL: target.URL})
		if len(proxy.Seen()) != before {
			t.Fatal("a bypassed host went through the proxy")
		}
	})

	t.Run("none and system", func(t *testing.T) {
		for _, mode := range []ProxyMode{ProxyNone, ProxySystem} {
			e := newExec(t, func(s *Settings) { s.Network.Proxy = Proxy{Mode: mode, Bypass: []string{"*"}} })
			resp, _ := send(t, e, model.Request{URL: target.URL})
			if resp.StatusCode != 200 {
				t.Fatalf("%s: status %d", mode, resp.StatusCode)
			}
		}
		e := newExec(t, func(s *Settings) { s.Network.Proxy = Proxy{Mode: ProxySystem} })
		if resp, _ := send(t, e, model.Request{URL: target.URL}); resp.StatusCode != 200 {
			t.Fatal("system proxy without bypass")
		}
	})

	t.Run("unreachable proxy", func(t *testing.T) {
		dead := httptest.NewServer(http.NotFoundHandler())
		addr := dead.URL
		dead.Close()
		e := newExec(t, func(s *Settings) { s.Network.Proxy = Proxy{Mode: ProxyCustom, URL: addr} })
		_, err := e.Execute(context.Background(), "", model.Request{URL: tlsTarget.URL})
		wantKind(t, err, KindProxy)
	})

	t.Run("refused credentials", func(t *testing.T) {
		strict := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
			w.WriteHeader(http.StatusProxyAuthRequired)
		}))
		defer strict.Close()
		e := newExec(t, func(s *Settings) {
			s.Network = Network{Proxy: Proxy{Mode: ProxyCustom, URL: strict.URL}, CAFile: caFile}
		})
		_, err := e.Execute(context.Background(), "", model.Request{URL: tlsTarget.URL})
		wantKind(t, err, KindProxy)
	})

	t.Run("bad settings", func(t *testing.T) {
		e := newExec(t, func(s *Settings) { s.Network.Proxy = Proxy{Mode: ProxyCustom, URL: "ftp://nope"} })
		_, err := e.Execute(context.Background(), "", model.Request{URL: target.URL})
		wantKind(t, err, KindProxy)
		locked := newExec(t, func(s *Settings) {
			s.Network = Network{Proxy: Proxy{Mode: ProxyCustom, URL: proxy.URL, Username: "me"},
				Secret: func(string) (string, error) { return "", errors.New("locked") }}
		})
		_, err = locked.Execute(context.Background(), "", model.Request{
			Method: "POST", URL: target.URL, Body: model.Body{Type: model.BodyRaw, Raw: "x"},
		})
		wantKind(t, err, KindProxy)
	})
}

func TestTransportsDropStaleNetworks(t *testing.T) {
	srv := newEchoServer(t)
	cache := NewTransports()
	a := newExec(t, func(s *Settings) { s.Transports = cache; s.Network.Proxy.Mode = ProxyNone })
	b := newExec(t, func(s *Settings) { s.Transports = cache; s.Network.Proxy.Mode = ProxySystem })
	send(t, a, model.Request{URL: srv.URL})
	send(t, a, model.Request{URL: srv.URL})
	if cache.Len() != 1 {
		t.Fatalf("len %d", cache.Len())
	}
	send(t, b, model.Request{URL: srv.URL})
	if cache.Len() != 1 {
		t.Fatalf("stale transport kept: len %d", cache.Len())
	}
}
