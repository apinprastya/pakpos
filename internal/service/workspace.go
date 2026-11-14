package service

import (
	"strings"

	"pakpos/internal/core/model"
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

// WorkspaceService opens workspaces and manages collections, folders and
// where requests live in the tree.
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

// Tree returns collections, folders and requests for the sidebar.
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

// GetCollection returns a collection with its auth, headers and variables.
func (s *WorkspaceService) GetCollection(id string) (fsstore.Collection, error) {
	ws, err := s.c.workspace()
	if err != nil {
		return fsstore.Collection{}, err
	}
	return ws.GetCollection(id)
}

// SaveCollection replaces a collection's auth, headers and variables.
// Secret variable values are never written to the workspace.
func (s *WorkspaceService) SaveCollection(id string, settings fsstore.CollectionSettings) (fsstore.Collection, error) {
	ws, err := s.c.workspace()
	if err != nil {
		return fsstore.Collection{}, err
	}
	return ws.SaveCollection(id, settings)
}

// CreateFolder adds a folder at the end of a collection or folder.
func (s *WorkspaceService) CreateFolder(parentID, name string) (fsstore.Folder, error) {
	ws, err := s.c.workspace()
	if err != nil {
		return fsstore.Folder{}, err
	}
	return ws.CreateFolder(parentID, strings.TrimSpace(name))
}

// GetFolder returns a folder with its auth and headers.
func (s *WorkspaceService) GetFolder(id string) (fsstore.Folder, error) {
	ws, err := s.c.workspace()
	if err != nil {
		return fsstore.Folder{}, err
	}
	return ws.GetFolder(id)
}

// RenameFolder renames a folder (and its directory).
func (s *WorkspaceService) RenameFolder(id, name string) (fsstore.Folder, error) {
	ws, err := s.c.workspace()
	if err != nil {
		return fsstore.Folder{}, err
	}
	return ws.RenameFolder(id, name)
}

// SaveFolder replaces a folder's auth and headers.
func (s *WorkspaceService) SaveFolder(id string, settings fsstore.FolderSettings) (fsstore.Folder, error) {
	ws, err := s.c.workspace()
	if err != nil {
		return fsstore.Folder{}, err
	}
	return ws.SaveFolder(id, settings)
}

// DeleteFolder deletes a folder with everything in it.
func (s *WorkspaceService) DeleteFolder(id string) error {
	ws, err := s.c.workspace()
	if err != nil {
		return err
	}
	return ws.DeleteFolder(id)
}

// MoveRequest moves a request into a collection or folder at index among
// its children (-1 appends). Within the same parent it reorders.
func (s *WorkspaceService) MoveRequest(id, toParentID string, index int) (model.Request, error) {
	ws, err := s.c.workspace()
	if err != nil {
		return model.Request{}, err
	}
	return ws.MoveRequest(id, toParentID, index)
}

// MoveFolder moves a folder into a collection or another folder at index
// among its children (-1 appends). A folder can't go into its own subtree.
func (s *WorkspaceService) MoveFolder(id, toParentID string, index int) (fsstore.Folder, error) {
	ws, err := s.c.workspace()
	if err != nil {
		return fsstore.Folder{}, err
	}
	return ws.MoveFolder(id, toParentID, index)
}

// Reorder sets the order of the folders and requests inside a collection or folder.
func (s *WorkspaceService) Reorder(parentID string, ids []string) error {
	ws, err := s.c.workspace()
	if err != nil {
		return err
	}
	return ws.Reorder(parentID, ids)
}
