package service

import (
	"strings"

	"pakpos/internal/store/fsstore"
	"pakpos/internal/store/sqlite"
)

// RecentLimit caps the recent workspaces list.
const RecentLimit = 10

// WorkspaceInfo describes the open workspace.
type WorkspaceInfo struct {
	ID   string `json:"id"`
	Name string `json:"name"`
	Path string `json:"path"`
}

// WorkspaceService opens workspaces and manages collections.
type WorkspaceService struct{ c *Core }

// NewWorkspaceService creates the service.
func NewWorkspaceService(c *Core) *WorkspaceService { return &WorkspaceService{c: c} }

func info(ws *fsstore.Workspace) WorkspaceInfo {
	m := ws.Manifest()
	return WorkspaceInfo{ID: m.ID, Name: m.Name, Path: ws.Root()}
}

// Current returns the open workspace, or nil when none is open.
func (s *WorkspaceService) Current() *WorkspaceInfo {
	ws, err := s.c.workspace()
	if err != nil {
		return nil
	}
	i := info(ws)
	return &i
}

// Open opens an existing workspace folder and adds it to the recent list.
func (s *WorkspaceService) Open(path string) (WorkspaceInfo, error) {
	ws, err := fsstore.Open(path)
	if err != nil {
		return WorkspaceInfo{}, err
	}
	return s.activate(ws)
}

// Create makes a new workspace in path (an empty name uses the folder name) and opens it.
func (s *WorkspaceService) Create(path, name string) (WorkspaceInfo, error) {
	ws, err := fsstore.Create(path, name)
	if err != nil {
		return WorkspaceInfo{}, err
	}
	return s.activate(ws)
}

func (s *WorkspaceService) activate(ws *fsstore.Workspace) (WorkspaceInfo, error) {
	s.c.setWorkspace(ws)
	i := info(ws)
	if err := s.c.db.TouchRecent(i.Path, i.Name); err != nil {
		s.c.log.Warn("record recent workspace", "err", err)
	}
	return i, nil
}

// Close closes the open workspace (no-op when none is open).
func (s *WorkspaceService) Close() {
	s.c.mu.Lock()
	defer s.c.mu.Unlock()
	s.c.closeWorkspaceLocked()
}

// Recent lists recently opened workspaces, newest first.
func (s *WorkspaceService) Recent() ([]sqlite.RecentWorkspace, error) {
	return s.c.db.ListRecent(RecentLimit)
}

// RemoveRecent removes a workspace from the recent list; the folder is untouched.
func (s *WorkspaceService) RemoveRecent(path string) error {
	return s.c.db.RemoveRecent(path)
}

// PickFolder asks the user for a folder to open or create a workspace in.
// It returns "" when the user cancels.
func (s *WorkspaceService) PickFolder() (string, error) {
	return s.c.dialogs.PickFolder("Choose a workspace folder")
}

// Tree returns collections and requests for the sidebar.
func (s *WorkspaceService) Tree() (fsstore.Tree, error) {
	ws, err := s.c.workspace()
	if err != nil {
		return fsstore.Tree{}, err
	}
	t := ws.Tree()
	if t.Problems == nil {
		t.Problems = []fsstore.Problem{}
	}
	return t, nil
}

// CreateCollection adds a collection at the end.
func (s *WorkspaceService) CreateCollection(name string) (fsstore.Collection, error) {
	ws, err := s.c.workspace()
	if err != nil {
		return fsstore.Collection{}, err
	}
	return ws.CreateCollection(strings.TrimSpace(name))
}

// RenameCollection renames a collection (and its folder).
func (s *WorkspaceService) RenameCollection(id, name string) (fsstore.Collection, error) {
	ws, err := s.c.workspace()
	if err != nil {
		return fsstore.Collection{}, err
	}
	return ws.RenameCollection(id, name)
}

// DeleteCollection deletes a collection and all its requests.
func (s *WorkspaceService) DeleteCollection(id string) error {
	ws, err := s.c.workspace()
	if err != nil {
		return err
	}
	return ws.DeleteCollection(id)
}

// ReorderCollections sets the collection order.
func (s *WorkspaceService) ReorderCollections(ids []string) error {
	ws, err := s.c.workspace()
	if err != nil {
		return err
	}
	return ws.ReorderCollections(ids)
}
