package service

import "pakpos/internal/store/sqlite"

// HistoryService lists and manages sent requests.
//
// History is per workspace: List and Clear only see the entries sent while
// the open workspace was open. With no workspace open they see the entries
// sent without one. Get and Delete work on any entry by id.
type HistoryService struct{ c *Core }

// NewHistoryService creates the service.
func NewHistoryService(c *Core) *HistoryService { return &HistoryService{c: c} }

// scope limits f to the open workspace, or to entries without one.
func (s *HistoryService) scope(f sqlite.HistoryFilter) sqlite.HistoryFilter {
	if ws, err := s.c.workspace(); err == nil {
		f.WorkspaceID, f.NoWorkspace = ws.Manifest().ID, false
	} else {
		f.WorkspaceID, f.NoWorkspace = "", true
	}
	return f
}

// List returns a page of the current workspace's history, newest first.
// filter.Text searches URL, method and name; its workspace fields are
// ignored (the open workspace decides).
func (s *HistoryService) List(filter sqlite.HistoryFilter) (sqlite.HistoryPage, error) {
	return s.c.db.ListHistory(s.scope(filter))
}

// Get returns one entry with its request and response.
func (s *HistoryService) Get(id int64) (sqlite.HistoryEntry, error) {
	return s.c.db.GetHistory(id)
}

// Delete removes one entry.
func (s *HistoryService) Delete(id int64) error {
	return s.c.db.DeleteHistory(id)
}

// Clear removes the current workspace's history (or, with no workspace
// open, the entries sent without one).
func (s *HistoryService) Clear() error {
	if ws, err := s.c.workspace(); err == nil {
		return s.c.db.ClearHistory(ws.Manifest().ID)
	}
	return s.c.db.ClearHistoryWithoutWorkspace()
}
