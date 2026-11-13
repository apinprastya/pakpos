package service

import "pakpos/internal/store/sqlite"

// HistoryService lists and manages sent requests.
type HistoryService struct{ c *Core }

// NewHistoryService creates the service.
func NewHistoryService(c *Core) *HistoryService { return &HistoryService{c: c} }

// List returns a page of history, newest first.
func (s *HistoryService) List(filter sqlite.HistoryFilter) (sqlite.HistoryPage, error) {
	return s.c.db.ListHistory(filter)
}

// Get returns one entry with its request and response.
func (s *HistoryService) Get(id int64) (sqlite.HistoryEntry, error) {
	return s.c.db.GetHistory(id)
}

// Delete removes one entry.
func (s *HistoryService) Delete(id int64) error {
	return s.c.db.DeleteHistory(id)
}

// Clear removes all history.
func (s *HistoryService) Clear() error {
	return s.c.db.ClearHistory("")
}
