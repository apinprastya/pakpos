package service

import (
	"encoding/json"
	"fmt"

	"pakpos/internal/windowstate"
)

// Limits on UI state entries, so a bug in the frontend can't bloat the database.
const (
	maxUIStateKey   = 128
	maxUIStateValue = 64 << 10
	// UIStateTabsKey holds the open tabs and their drafts (stores/tabs.ts).
	// Drafts can carry request bodies, so it gets a larger limit. They live
	// here rather than only in the webview's localStorage, which WebKitGTK
	// doesn't reliably keep across app restarts.
	UIStateTabsKey = "tabs"
	maxUITabsValue = 16 << 20
)

// UIStateService stores app-wide UI state (panel sizes, table column widths)
// that the frontend restores at startup. Values are JSON chosen by the
// frontend; Go only checks that they are well formed.
type UIStateService struct{ c *Core }

// NewUIStateService creates the service.
func NewUIStateService(c *Core) *UIStateService { return &UIStateService{c: c} }

// Get returns every stored value (JSON) by key.
func (s *UIStateService) Get() (map[string]string, error) {
	return s.c.db.UIState()
}

// Set stores value (JSON) under key. An empty value removes the key.
func (s *UIStateService) Set(key, value string) error {
	if key == "" || len(key) > maxUIStateKey {
		return fmt.Errorf("ui state key must be 1-%d characters", maxUIStateKey)
	}
	limit := maxUIStateValue
	if key == UIStateTabsKey {
		limit = maxUITabsValue
	}
	if len(value) > limit {
		return fmt.Errorf("ui state %s is too large (%d bytes)", key, len(value))
	}
	if value != "" && !json.Valid([]byte(value)) {
		return fmt.Errorf("ui state %s is not valid JSON", key)
	}
	return s.c.db.SetUIState(key, value)
}

// WindowStateStore is where main.go keeps the window's size and position.
func (c *Core) WindowStateStore() windowstate.Store { return c.db }
