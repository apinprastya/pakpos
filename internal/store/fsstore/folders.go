package fsstore

import (
	"errors"
	"fmt"
	"io/fs"
	"os"
	"path/filepath"
	"slices"
	"sort"
	"strings"

	"pakpos/internal/core/inherit"
	"pakpos/internal/core/model"
)

// Folder is the content of a folder's _folder.yaml. A folder is a
// subdirectory of a collection or of another folder. Its Auth and Headers
// are inherited by everything inside it (see core/inherit); folders have no
// variables.
type Folder struct {
	ID      string           `json:"id" yaml:"id"`
	Name    string           `json:"name" yaml:"name"`
	Seq     int              `json:"seq" yaml:"seq"`
	Auth    model.Auth       `json:"auth" yaml:"auth,omitempty"`
	Headers []model.KeyValue `json:"headers" yaml:"headers,omitempty"`
}

// FolderSettings are the parts of a folder its requests inherit.
type FolderSettings struct {
	Auth    model.Auth       `json:"auth"`
	Headers []model.KeyValue `json:"headers"`
}

type folderEntry struct {
	meta     Folder
	parentID string // collection or folder id
	dir      string // directory name inside the parent's directory
}

// NodeKind tells collection, folder and request nodes apart.
type NodeKind string

// Node kinds.
const (
	NodeCollection NodeKind = "collection"
	NodeFolder     NodeKind = "folder"
	NodeRequest    NodeKind = "request"
)

// Node is one entry of the sidebar tree. Collections and folders have
// Children (folders and requests sharing one Seq order); requests have
// Method and URL.
type Node struct {
	Kind NodeKind `json:"kind"`
	ID   string   `json:"id"`
	Name string   `json:"name"`
	Seq  int      `json:"seq"`
	// ParentID is the collection or folder holding the node ("" for a collection).
	ParentID string `json:"parentId"`
	Method   string `json:"method,omitempty"`
	URL      string `json:"url,omitempty"`
	Children []Node `json:"children"`
}

// child is a folder or a request inside a collection or folder.
type child struct {
	folder *folderEntry
	req    *reqEntry
}

func (c child) id() string {
	if c.folder != nil {
		return c.folder.meta.ID
	}
	return c.req.summary.ID
}

func (c child) seq() int {
	if c.folder != nil {
		return c.folder.meta.Seq
	}
	return c.req.summary.Seq
}

func (c child) name() string {
	if c.folder != nil {
		return c.folder.meta.Name
	}
	return c.req.summary.Name
}

// sortChildren orders by Seq, then name (case-insensitive), then folders
// before requests, then id, so the order is stable even with hand-edited
// duplicate seqs.
func sortChildren(list []child) {
	sort.Slice(list, func(i, j int) bool {
		a, b := list[i], list[j]
		if a.seq() != b.seq() {
			return a.seq() < b.seq()
		}
		if an, bn := strings.ToLower(a.name()), strings.ToLower(b.name()); an != bn {
			return an < bn
		}
		if (a.folder != nil) != (b.folder != nil) {
			return a.folder != nil
		}
		return a.id() < b.id()
	})
}

// childMapLocked groups every folder and request by parent id.
func (w *Workspace) childMapLocked() map[string][]child {
	m := map[string][]child{}
	for _, f := range w.folders {
		m[f.parentID] = append(m[f.parentID], child{folder: f})
	}
	for _, r := range w.requests {
		m[r.parentID] = append(m[r.parentID], child{req: r})
	}
	return m
}

// childrenLocked returns the sorted children of a collection or folder.
func (w *Workspace) childrenLocked(parentID string) []child {
	var list []child
	for _, f := range w.folders {
		if f.parentID == parentID {
			list = append(list, child{folder: f})
		}
	}
	for _, r := range w.requests {
		if r.parentID == parentID {
			list = append(list, child{req: r})
		}
	}
	sortChildren(list)
	return list
}

func (w *Workspace) nextSeqLocked(parentID string) int {
	maxSeq := 0
	for _, c := range w.childrenLocked(parentID) {
		maxSeq = max(maxSeq, c.seq())
	}
	return maxSeq + 1
}

// Tree returns the collections with their folders and requests, each level
// ordered by Seq (then name).
func (w *Workspace) Tree() Tree {
	w.mu.Lock()
	defer w.mu.Unlock()
	kids := w.childMapLocked()
	var build func(parentID string) []Node
	build = func(parentID string) []Node {
		list := kids[parentID]
		sortChildren(list)
		nodes := make([]Node, 0, len(list))
		for _, c := range list {
			if c.folder != nil {
				f := c.folder.meta
				nodes = append(nodes, Node{
					Kind: NodeFolder, ID: f.ID, Name: f.Name, Seq: f.Seq,
					ParentID: parentID, Children: build(f.ID),
				})
				continue
			}
			s := c.req.summary
			nodes = append(nodes, Node{
				Kind: NodeRequest, ID: s.ID, Name: s.Name, Seq: s.Seq,
				ParentID: parentID, Method: s.Method, URL: s.URL,
			})
		}
		return nodes
	}
	cols := make([]Node, 0, len(w.collections))
	for id, c := range w.collections {
		cols = append(cols, Node{Kind: NodeCollection, ID: id, Name: c.meta.Name, Seq: c.meta.Seq, Children: build(id)})
	}
	sort.Slice(cols, func(i, j int) bool { return lessSeq(cols[i].Seq, cols[j].Seq, cols[i].Name, cols[j].Name) })
	return Tree{Collections: cols, Problems: append([]Problem{}, w.problems...)}
}

// ---- paths and ancestry ----

// dirLocked returns the directory of a collection or folder.
func (w *Workspace) dirLocked(id string) (string, error) {
	var parts []string
	for range len(w.folders) + 1 {
		if c, ok := w.collections[id]; ok {
			parts = append(parts, c.dir, CollectionsDir, w.root)
			slices.Reverse(parts)
			return filepath.Join(parts...), nil
		}
		f, ok := w.folders[id]
		if !ok {
			return "", fmt.Errorf("collection or folder %s: %w", id, ErrNotFound)
		}
		parts = append(parts, f.dir)
		id = f.parentID
	}
	return "", fmt.Errorf("folder %s: parent chain is cyclic", id)
}

// ancestorsLocked returns id and its ancestors, innermost first, ending
// with the collection.
func (w *Workspace) ancestorsLocked(id string) ([]string, error) {
	var out []string
	for range len(w.folders) + 1 {
		out = append(out, id)
		if _, ok := w.collections[id]; ok {
			return out, nil
		}
		f, ok := w.folders[id]
		if !ok {
			return nil, fmt.Errorf("collection or folder %s: %w", id, ErrNotFound)
		}
		id = f.parentID
	}
	return nil, fmt.Errorf("folder %s: parent chain is cyclic", id)
}

func (w *Workspace) collectionOfLocked(parentID string) (string, error) {
	chain, err := w.ancestorsLocked(parentID)
	if err != nil {
		return "", err
	}
	return chain[len(chain)-1], nil
}

// dropSubtreeLocked removes every folder and request below id from the index.
func (w *Workspace) dropSubtreeLocked(id string) {
	gone := map[string]bool{id: true}
	for changed := true; changed; {
		changed = false
		for fid, f := range w.folders {
			if gone[f.parentID] && !gone[fid] {
				gone[fid] = true
				changed = true
			}
		}
	}
	for fid := range gone {
		delete(w.folders, fid)
	}
	for rid, r := range w.requests {
		if gone[r.parentID] {
			delete(w.requests, rid)
		}
	}
}

// markTree records every path under dir as our own write, so deleting or
// moving a whole folder doesn't echo back as external changes.
func (w *Workspace) markTree(dir string) {
	_ = filepath.WalkDir(dir, func(p string, _ fs.DirEntry, err error) error {
		if err == nil {
			w.markWrite(p)
		}
		return nil
	})
}

// InheritChain returns the levels a request inherits auth and headers
// from, in the order core/inherit.Effective takes them: the collection
// first, then its folders outermost first. id is a request id, or the id
// of the collection or folder an unsaved draft belongs to (the chain then
// ends with that level).
func (w *Workspace) InheritChain(id string) ([]inherit.Level, error) {
	w.mu.Lock()
	defer w.mu.Unlock()
	start := id
	if r, ok := w.requests[id]; ok {
		start = r.parentID
	}
	ids, err := w.ancestorsLocked(start)
	if err != nil {
		return nil, err
	}
	levels := make([]inherit.Level, 0, len(ids))
	for i := len(ids) - 1; i >= 0; i-- {
		if c, ok := w.collections[ids[i]]; ok {
			levels = append(levels, inherit.Level{
				Kind: inherit.KindCollection, ID: c.meta.ID, Name: c.meta.Name,
				Auth: c.meta.Auth, Headers: append([]model.KeyValue{}, c.meta.Headers...),
			})
			continue
		}
		f := w.folders[ids[i]].meta
		levels = append(levels, inherit.Level{
			Kind: inherit.KindFolder, ID: f.ID, Name: f.Name,
			Auth: f.Auth, Headers: append([]model.KeyValue{}, f.Headers...),
		})
	}
	return levels, nil
}

// ---- folders ----

// GetFolder returns a folder's metadata.
func (w *Workspace) GetFolder(id string) (Folder, error) {
	w.mu.Lock()
	defer w.mu.Unlock()
	f, ok := w.folders[id]
	if !ok {
		return Folder{}, fmt.Errorf("folder %s: %w", id, ErrNotFound)
	}
	return copyFolder(f.meta), nil
}

// FolderParent returns the id of the collection or folder holding a folder.
func (w *Workspace) FolderParent(id string) (string, error) {
	w.mu.Lock()
	defer w.mu.Unlock()
	f, ok := w.folders[id]
	if !ok {
		return "", fmt.Errorf("folder %s: %w", id, ErrNotFound)
	}
	return f.parentID, nil
}

// CreateFolder adds a folder at the end of a collection or folder. Folders
// are v2 data, so this upgrades a v1 manifest first.
func (w *Workspace) CreateFolder(parentID, name string) (Folder, error) {
	name = cleanName(name, "New folder")
	w.mu.Lock()
	defer w.mu.Unlock()
	parentDir, err := w.dirLocked(parentID)
	if err != nil {
		return Folder{}, err
	}
	if err := w.upgradeManifestLocked(); err != nil {
		return Folder{}, err
	}
	dir := uniqueName(parentDir, slugify(name, "folder"), "")
	meta := Folder{ID: model.NewID(), Name: name, Seq: w.nextSeqLocked(parentID)}
	dirPath := filepath.Join(parentDir, dir)
	w.markWrite(dirPath)
	if err := os.Mkdir(dirPath, 0o755); err != nil {
		return Folder{}, fmt.Errorf("create folder %q: %w", name, err)
	}
	w.watchDir(dirPath)
	if err := w.writeYAML(filepath.Join(dirPath, FolderFile), meta); err != nil {
		_ = os.RemoveAll(dirPath)
		return Folder{}, fmt.Errorf("create folder %q: %w", name, err)
	}
	w.folders[meta.ID] = &folderEntry{meta: meta, parentID: parentID, dir: dir}
	return copyFolder(meta), nil
}

// RenameFolder changes a folder's name and renames its directory to match.
// IDs don't change, so open requests inside it stay valid.
func (w *Workspace) RenameFolder(id, name string) (Folder, error) {
	name = cleanName(name, "New folder")
	w.mu.Lock()
	defer w.mu.Unlock()
	f, ok := w.folders[id]
	if !ok {
		return Folder{}, fmt.Errorf("folder %s: %w", id, ErrNotFound)
	}
	parentDir, err := w.dirLocked(f.parentID)
	if err != nil {
		return Folder{}, err
	}
	if slug := slugify(name, "folder"); slug != f.dir {
		newDir := uniqueName(parentDir, slug, "")
		oldPath, newPath := filepath.Join(parentDir, f.dir), filepath.Join(parentDir, newDir)
		w.markWrite(oldPath)
		w.markWrite(newPath)
		w.unwatchDir(oldPath)
		rerr := os.Rename(oldPath, newPath)
		w.resumeDir(oldPath)
		if rerr != nil {
			w.watchDir(oldPath)
			return Folder{}, fmt.Errorf("rename folder %q: %w", f.meta.Name, rerr)
		}
		f.dir = newDir
		w.watchDir(newPath)
	}
	meta := f.meta
	meta.Name = name
	if err := w.writeYAML(filepath.Join(parentDir, f.dir, FolderFile), meta); err != nil {
		return Folder{}, fmt.Errorf("rename folder %q: %w", f.meta.Name, err)
	}
	f.meta = meta
	return copyFolder(meta), nil
}

// SaveFolder replaces a folder's auth and headers.
func (w *Workspace) SaveFolder(id string, s FolderSettings) (Folder, error) {
	w.mu.Lock()
	defer w.mu.Unlock()
	f, ok := w.folders[id]
	if !ok {
		return Folder{}, fmt.Errorf("folder %s: %w", id, ErrNotFound)
	}
	dir, err := w.dirLocked(id)
	if err != nil {
		return Folder{}, err
	}
	// A hand-made folder in a v1 workspace: its settings are v2 data.
	if err := w.upgradeManifestLocked(); err != nil {
		return Folder{}, err
	}
	meta := f.meta
	meta.Auth = s.Auth
	meta.Headers = append([]model.KeyValue(nil), s.Headers...)
	if err := w.writeYAML(filepath.Join(dir, FolderFile), meta); err != nil {
		return Folder{}, fmt.Errorf("save folder %q: %w", meta.Name, err)
	}
	f.meta = meta
	return copyFolder(meta), nil
}

// DeleteFolder removes a folder with everything inside it.
func (w *Workspace) DeleteFolder(id string) error {
	w.mu.Lock()
	defer w.mu.Unlock()
	f, ok := w.folders[id]
	if !ok {
		return fmt.Errorf("folder %s: %w", id, ErrNotFound)
	}
	dir, err := w.dirLocked(id)
	if err != nil {
		return err
	}
	w.markTree(dir)
	w.unwatchDir(dir)
	rerr := os.RemoveAll(dir)
	w.resumeDir(dir)
	if rerr != nil {
		w.watchDir(dir)
		return fmt.Errorf("delete folder %q: %w", f.meta.Name, rerr)
	}
	w.dropSubtreeLocked(id)
	return nil
}

func copyFolder(f Folder) Folder {
	f.Headers = append([]model.KeyValue{}, f.Headers...)
	return f
}

// ---- moves and order ----

// Reorder sets the order of the folders and requests directly inside a
// collection or folder (they share one Seq order). ids not inside parentID
// are an error; children not listed keep their relative order after the
// listed ones. Only files whose Seq changes are rewritten.
func (w *Workspace) Reorder(parentID string, ids []string) error {
	w.mu.Lock()
	defer w.mu.Unlock()
	if _, err := w.dirLocked(parentID); err != nil {
		return err
	}
	current := w.childrenLocked(parentID)
	byID := map[string]child{}
	for _, c := range current {
		byID[c.id()] = c
	}
	order := make([]child, 0, len(current))
	listed := map[string]bool{}
	for _, id := range ids {
		c, ok := byID[id]
		if !ok {
			return fmt.Errorf("item %s in %s: %w", id, parentID, ErrNotFound)
		}
		if !listed[id] { // a repeated id keeps its first position
			order = append(order, c)
			listed[id] = true
		}
	}
	for _, c := range current {
		if !listed[c.id()] {
			order = append(order, c)
		}
	}
	return w.applySeqLocked(order)
}

// applySeqLocked numbers order 1..n, rewriting only what changed.
func (w *Workspace) applySeqLocked(order []child) error {
	for i, c := range order {
		seq := i + 1
		if c.seq() == seq {
			continue
		}
		if c.folder != nil {
			dir, err := w.dirLocked(c.folder.meta.ID)
			if err != nil {
				return err
			}
			meta := c.folder.meta
			meta.Seq = seq
			if err := w.writeYAML(filepath.Join(dir, FolderFile), meta); err != nil {
				return fmt.Errorf("reorder folder %q: %w", meta.Name, err)
			}
			c.folder.meta = meta
			continue
		}
		path, _, err := w.requestPath(c.req.summary.ID)
		if err != nil {
			return err
		}
		var r model.Request
		if err := readYAML(path, &r); err != nil {
			return fmt.Errorf("read request %s: %w", c.req.summary.ID, err)
		}
		r.Seq = seq
		if err := w.writeYAML(path, r); err != nil {
			return fmt.Errorf("reorder request %q: %w", r.Name, err)
		}
		c.req.summary.Seq = seq
	}
	return nil
}

// insertAt places c at index in list (clamped; a negative index appends).
func insertAt(list []child, index int, c child) []child {
	if index < 0 || index > len(list) {
		index = len(list)
	}
	return slices.Insert(slices.Clone(list), index, c)
}

func without(list []child, id string) []child {
	return slices.DeleteFunc(slices.Clone(list), func(c child) bool { return c.id() == id })
}

// MoveRequest moves a request into a collection or folder (any collection)
// at index among its children, keeping its ID. A negative or too large
// index appends. Within the same parent it just reorders. The file name is
// resolved against the target with the usual slug rules, and Seq is
// renumbered in both the source and the target.
func (w *Workspace) MoveRequest(id, toParentID string, index int) (model.Request, error) {
	w.mu.Lock()
	defer w.mu.Unlock()
	path, e, err := w.requestPath(id)
	if err != nil {
		return model.Request{}, err
	}
	dstDir, err := w.dirLocked(toParentID)
	if err != nil {
		return model.Request{}, err
	}
	var r model.Request
	if err := readYAML(path, &r); err != nil {
		return model.Request{}, fmt.Errorf("read request %s: %w", id, err)
	}
	me := child{req: e}
	target := insertAt(without(w.childrenLocked(toParentID), id), index, me)
	if e.parentID == toParentID {
		if err := w.applySeqLocked(target); err != nil {
			return model.Request{}, err
		}
		r.Seq = e.summary.Seq
		return r, nil
	}

	r.Seq = slices.IndexFunc(target, func(c child) bool { return c.id() == id }) + 1
	file := uniqueName(dstDir, slugify(r.Name, "request"), ".yaml")
	if err := w.writeYAML(filepath.Join(dstDir, file), r); err != nil {
		return model.Request{}, fmt.Errorf("move request %q: %w", r.Name, err)
	}
	w.markWrite(path)
	if err := os.Remove(path); err != nil && !errors.Is(err, os.ErrNotExist) {
		return model.Request{}, fmt.Errorf("remove moved request: %w", err)
	}
	from := e.parentID
	e.parentID, e.file, e.summary = toParentID, file, summaryIn(r, toParentID)
	if err := w.applySeqLocked(target); err != nil {
		return model.Request{}, err
	}
	if err := w.applySeqLocked(w.childrenLocked(from)); err != nil {
		return model.Request{}, err
	}
	return r, nil
}

// MoveFolder moves a folder (with everything in it) into a collection or
// another folder, at index among its children. Moving a folder into itself
// or its own subtree returns ErrInvalidMove. The directory is renamed with
// the usual slug rules; IDs don't change.
func (w *Workspace) MoveFolder(id, toParentID string, index int) (Folder, error) {
	w.mu.Lock()
	defer w.mu.Unlock()
	f, ok := w.folders[id]
	if !ok {
		return Folder{}, fmt.Errorf("folder %s: %w", id, ErrNotFound)
	}
	ancestors, err := w.ancestorsLocked(toParentID)
	if err != nil {
		return Folder{}, err
	}
	if slices.Contains(ancestors, id) {
		return Folder{}, fmt.Errorf("move folder %q: %w", f.meta.Name, ErrInvalidMove)
	}
	me := child{folder: f}
	target := insertAt(without(w.childrenLocked(toParentID), id), index, me)
	if f.parentID != toParentID {
		oldPath, err := w.dirLocked(id)
		if err != nil {
			return Folder{}, err
		}
		dstDir, err := w.dirLocked(toParentID)
		if err != nil {
			return Folder{}, err
		}
		newDir := uniqueName(dstDir, slugify(f.meta.Name, "folder"), "")
		newPath := filepath.Join(dstDir, newDir)
		w.markWrite(oldPath)
		w.markWrite(newPath)
		w.unwatchDir(oldPath)
		rerr := os.Rename(oldPath, newPath)
		w.resumeDir(oldPath)
		if rerr != nil {
			w.watchDir(oldPath)
			return Folder{}, fmt.Errorf("move folder %q: %w", f.meta.Name, rerr)
		}
		from := f.parentID
		f.parentID, f.dir = toParentID, newDir
		w.watchDir(newPath)
		if err := w.applySeqLocked(w.childrenLocked(from)); err != nil {
			return Folder{}, err
		}
	}
	if err := w.applySeqLocked(target); err != nil {
		return Folder{}, err
	}
	return copyFolder(f.meta), nil
}
