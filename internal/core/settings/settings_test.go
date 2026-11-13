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
