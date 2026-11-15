package appearance

import (
	"testing"

	"pakpos/internal/core/settings"
)

func TestBackground(t *testing.T) {
	dark := func() bool { return true }
	light := func() bool { return false }
	tests := []struct {
		name   string
		theme  settings.Theme
		system func() bool
		want   RGB
	}{
		{"dark ignores the OS", settings.ThemeDark, light, Dark},
		{"light ignores the OS", settings.ThemeLight, dark, Light},
		{"system dark", settings.ThemeSystem, dark, Dark},
		{"system light", settings.ThemeSystem, light, Light},
		{"unknown follows the OS", settings.Theme(""), dark, Dark},
		{"no OS probe", settings.ThemeSystem, nil, Light},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if got := Background(tt.theme, tt.system); got != tt.want {
				t.Errorf("Background = %v, want %v", got, tt.want)
			}
		})
	}
}

func TestSystemOnlyProbedForSystemTheme(t *testing.T) {
	called := false
	probe := func() bool { called = true; return true }
	IsDark(settings.ThemeLight, probe)
	IsDark(settings.ThemeDark, probe)
	if called {
		t.Fatal("OS preference read for an explicit theme")
	}
}
