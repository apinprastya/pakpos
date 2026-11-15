// Package appearance decides how the window looks before the UI has painted,
// so the first frame matches the theme instead of flashing a light window.
package appearance

import "pakpos/internal/core/settings"

// RGB is an opaque colour.
type RGB struct{ R, G, B uint8 }

// The page backgrounds of the two themes (--background in frontend/src/index.css).
var (
	Light = RGB{0xf7, 0xf8, 0xfa}
	Dark  = RGB{0x15, 0x1a, 0x23}
)

// IsDark reports whether the theme resolves to dark. systemDark is only
// called for the system theme.
func IsDark(theme settings.Theme, systemDark func() bool) bool {
	switch theme {
	case settings.ThemeDark:
		return true
	case settings.ThemeLight:
		return false
	default:
		return systemDark != nil && systemDark()
	}
}

// Background is the window colour to start with for the theme.
func Background(theme settings.Theme, systemDark func() bool) RGB {
	if IsDark(theme, systemDark) {
		return Dark
	}
	return Light
}
