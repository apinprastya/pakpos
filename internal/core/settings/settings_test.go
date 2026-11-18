package settings

import (
	"testing"
	"time"

	"pakpos/internal/core/httpexec"
)

func TestDefaultsAreValid(t *testing.T) {
	if err := Defaults().Validate(); err != nil {
		t.Fatal(err)
	}
}

func TestValidate(t *testing.T) {
	cases := map[string]func(*Settings){
		"theme":         func(s *Settings) { s.Theme = "blue" },
		"layout":        func(s *Settings) { s.Layout = "diagonal" },
		"neg timeout":   func(s *Settings) { s.TimeoutMs = -1 },
		"big timeout":   func(s *Settings) { s.TimeoutMs = MaxTimeoutMs + 1 },
		"redirects 0":   func(s *Settings) { s.MaxRedirects = 0 },
		"redirects big": func(s *Settings) { s.MaxRedirects = MaxRedirectsCap + 1 },
		"retention neg": func(s *Settings) { s.HistoryRetention = -1 },
		"retention big": func(s *Settings) { s.HistoryRetention = MaxHistoryRetain + 1 },
	}
	for name, mod := range cases {
		t.Run(name, func(t *testing.T) {
			s := Defaults()
			mod(&s)
			if err := s.Validate(); err == nil {
				t.Fatal("expected error")
			}
		})
	}
	ok := Defaults()
	ok.Theme, ok.Layout, ok.TimeoutMs, ok.HistoryRetention = ThemeDark, LayoutHorizontal, 0, 0
	if err := ok.Validate(); err != nil {
		t.Fatal(err)
	}
	ok.Theme = ThemeLight
	if err := ok.Validate(); err != nil {
		t.Fatal(err)
	}
}

func TestExecutorMapping(t *testing.T) {
	s := Defaults()
	s.TimeoutMs, s.FollowRedirects, s.MaxRedirects, s.VerifyTLS = 1500, false, 3, false
	base := httpexec.DefaultSettings()
	base.TempDir = "/tmp/x"
	got := s.Executor(base)
	if got.Timeout != 1500*time.Millisecond || got.FollowRedirects || got.MaxRedirects != 3 || !got.InsecureSkipVerify || got.TempDir != "/tmp/x" {
		t.Fatalf("got %+v", got)
	}
}

func TestNetworkValidation(t *testing.T) {
	pem := func(host string) ClientCert {
		return ClientCert{ID: "a", Host: host, CertFile: "c.pem", KeyFile: "k.pem"}
	}
	bad := map[string]func(*Settings){
		"proxy mode":       func(s *Settings) { s.Proxy.Mode = "auto" },
		"custom no url":    func(s *Settings) { s.Proxy = Proxy{Mode: ProxyCustom} },
		"custom ftp":       func(s *Settings) { s.Proxy = Proxy{Mode: ProxyCustom, URL: "ftp://p"} },
		"bypass":           func(s *Settings) { s.Proxy.Bypass = "ok.example, 10.0.0.0/99" },
		"cert host":        func(s *Settings) { s.ClientCerts = []ClientCert{pem("")} },
		"cert host bad":    func(s *Settings) { s.ClientCerts = []ClientCert{pem("a.*.com")} },
		"cert no files":    func(s *Settings) { s.ClientCerts = []ClientCert{{ID: "a", Host: "x"}} },
		"cert key missing": func(s *Settings) { s.ClientCerts = []ClientCert{{ID: "a", Host: "x", CertFile: "c"}} },
		"cert both": func(s *Settings) {
			s.ClientCerts = []ClientCert{{ID: "a", Host: "x", CertFile: "c", KeyFile: "k", PFXFile: "p"}}
		},
		"cert no id":  func(s *Settings) { c := pem("x"); c.ID = ""; s.ClientCerts = []ClientCert{c} },
		"cert dup id": func(s *Settings) { s.ClientCerts = []ClientCert{pem("x"), pem("y")} },
		"too many": func(s *Settings) {
			for i := 0; i <= MaxClientCerts; i++ {
				c := pem("x")
				c.ID = time.Duration(i).String()
				s.ClientCerts = append(s.ClientCerts, c)
			}
		},
	}
	for name, mod := range bad {
		t.Run(name, func(t *testing.T) {
			s := Defaults()
			mod(&s)
			if err := s.Validate(); err == nil {
				t.Fatal("expected error")
			}
		})
	}
	ok := Defaults()
	ok.Proxy = Proxy{Mode: ProxyCustom, URL: "socks5://p:1080", Username: "me", Bypass: "localhost\n*.local, 10.0.0.0/8"}
	ok.ClientCerts = []ClientCert{pem("*.example.com"), {ID: "b", Host: "api.example.com", PFXFile: "me.p12"}}
	if err := ok.Validate(); err != nil {
		t.Fatal(err)
	}
	ok.Proxy.Mode = ProxyNone
	if err := ok.Validate(); err != nil {
		t.Fatal(err)
	}
}

func TestNormalize(t *testing.T) {
	s := Defaults()
	s.Proxy.URL, s.Proxy.Username, s.CAFile = " http://p:1 ", " me ", " /ca.pem "
	s.ClientCerts = []ClientCert{{Host: " API.example.com ", CertFile: " c ", KeyFile: " k "}, {ID: "keep", Host: "x", PFXFile: "p"}}
	n := s.Normalize()
	if n.Proxy.URL != "http://p:1" || n.Proxy.Username != "me" || n.CAFile != "/ca.pem" {
		t.Fatalf("got %+v", n)
	}
	if n.ClientCerts[0].ID == "" || n.ClientCerts[0].Host != "api.example.com" || n.ClientCerts[0].CertFile != "c" || n.ClientCerts[1].ID != "keep" {
		t.Fatalf("certs %+v", n.ClientCerts)
	}
	if got := (Settings{}).Normalize().ClientCerts; got == nil {
		t.Fatal("nil certs")
	}
}

func TestNetworkMapping(t *testing.T) {
	s := Defaults()
	s.Proxy = Proxy{Mode: ProxyCustom, URL: "http://p:1", Username: "me", Bypass: "a, b"}
	s.CAFile = "/ca.pem"
	s.ClientCerts = []ClientCert{{ID: "x", Host: "h", PFXFile: "p"}}
	base := httpexec.DefaultSettings()
	base.Network.Secret = func(string) (string, error) { return "pw", nil }
	got := s.Executor(base).Network
	if got.Proxy.Mode != httpexec.ProxyCustom || got.Proxy.URL != "http://p:1" || len(got.Proxy.Bypass) != 2 ||
		got.CAFile != "/ca.pem" || got.ClientCerts[0].PFXFile != "p" || got.Secret == nil {
		t.Fatalf("got %+v", got)
	}
}
