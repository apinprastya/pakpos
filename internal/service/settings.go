package service

import "pakpos/internal/core/settings"

// SettingsService reads and changes app settings.
type SettingsService struct{ c *Core }

// NewSettingsService creates the service.
func NewSettingsService(c *Core) *SettingsService { return &SettingsService{c: c} }

// Get returns the current settings.
func (s *SettingsService) Get() settings.Settings {
	return s.c.currentSettings()
}

// Defaults returns the settings of a fresh install.
func (s *SettingsService) Defaults() settings.Settings {
	return settings.Defaults()
}

// Set validates, saves and applies new settings, and returns them.
// Network settings apply to the next send; lowering history retention prunes now.
func (s *SettingsService) Set(next settings.Settings) (settings.Settings, error) {
	if err := next.Validate(); err != nil {
		return settings.Settings{}, err
	}
	if err := s.c.db.SetSetting(settingsKey, next); err != nil {
		return settings.Settings{}, err
	}
	s.c.mu.Lock()
	s.c.settings = next
	s.c.resetExecutorLocked(false)
	s.c.mu.Unlock()

	if next.HistoryRetention > 0 {
		if _, err := s.c.db.PruneHistory(next.HistoryRetention); err != nil {
			s.c.log.Warn("prune history", "err", err)
		}
	}
	return next, nil
}
