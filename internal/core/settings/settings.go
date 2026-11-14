// Package settings defines the user-editable app settings, their defaults and
// validation, and how they map onto the HTTP executor.
package settings

import (
	"fmt"
	"time"

	"pakpos/internal/core/httpexec"
)

// Theme is the UI colour scheme.
type Theme string

const (
	ThemeLight  Theme = "light"
	ThemeDark   Theme = "dark"
	ThemeSystem Theme = "system"
)

// Layout places the response below ("vertical") or beside ("horizontal") the request.
type Layout string

const (
	LayoutVertical   Layout = "vertical"
	LayoutHorizontal Layout = "horizontal"
)

// Limits for numeric settings.
const (
	MaxTimeoutMs     = 10 * 60 * 1000 // 10 minutes
	MaxRedirectsCap  = 50
	MaxHistoryRetain = 100_000
)

// Settings are persisted as one JSON document.
type Settings struct {
	Theme Theme `json:"theme"`
	// TimeoutMs for a whole request; 0 means no timeout.
	TimeoutMs       int  `json:"timeoutMs"`
	FollowRedirects bool `json:"followRedirects"`
	MaxRedirects    int  `json:"maxRedirects"`
	VerifyTLS       bool `json:"verifyTls"`
	// HistoryRetention is how many history entries to keep per workspace
	// (entries sent without a workspace count as one more); 0 keeps all.
	HistoryRetention int    `json:"historyRetention"`
	Layout           Layout `json:"layout"`
}

// Defaults returns the settings of a fresh install.
func Defaults() Settings {
	return Settings{
		Theme:            ThemeSystem,
		TimeoutMs:        30_000,
		FollowRedirects:  true,
		MaxRedirects:     10,
		VerifyTLS:        true,
		HistoryRetention: 500,
		Layout:           LayoutVertical,
	}
}

// Validate reports the first invalid field with a user-facing message.
func (s Settings) Validate() error {
	switch s.Theme {
	case ThemeLight, ThemeDark, ThemeSystem:
	default:
		return fmt.Errorf("theme must be light, dark or system (got %q)", s.Theme)
	}
	switch s.Layout {
	case LayoutVertical, LayoutHorizontal:
	default:
		return fmt.Errorf("layout must be vertical or horizontal (got %q)", s.Layout)
	}
	if s.TimeoutMs < 0 || s.TimeoutMs > MaxTimeoutMs {
		return fmt.Errorf("timeout must be between 0 and %d ms", MaxTimeoutMs)
	}
	if s.MaxRedirects < 1 || s.MaxRedirects > MaxRedirectsCap {
		return fmt.Errorf("max redirects must be between 1 and %d", MaxRedirectsCap)
	}
	if s.HistoryRetention < 0 || s.HistoryRetention > MaxHistoryRetain {
		return fmt.Errorf("history retention must be between 0 and %d", MaxHistoryRetain)
	}
	return nil
}

// Executor maps the settings onto base executor settings.
func (s Settings) Executor(base httpexec.Settings) httpexec.Settings {
	base.Timeout = time.Duration(s.TimeoutMs) * time.Millisecond
	base.FollowRedirects = s.FollowRedirects
	base.MaxRedirects = s.MaxRedirects
	base.InsecureSkipVerify = !s.VerifyTLS
	return base
}
