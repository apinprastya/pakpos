// Package fsstore keeps a workspace as plain files: a pakpos.yaml manifest,
// one directory per collection and one YAML file per request. The layout is
// designed to be committed to git. It has no Wails dependency.
package fsstore

import (
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"

	"gopkg.in/yaml.v3"

	"pakpos/internal/core/model"
)

// File and directory names inside a workspace.
const (
	ManifestFile   = "pakpos.yaml"
	CollectionsDir = "collections"
	CollectionFile = "_collection.yaml"
	// FolderFile marks a subdirectory of a collection (at any depth) as a
	// folder. A subdirectory without one is reported as a problem.
	FolderFile = "_folder.yaml"
	// ExamplesSuffix marks a request's saved response examples (a sidecar
	// file next to the request, see M7). The request loader skips it.
	ExamplesSuffix = ".examples.yaml"
	// EnvironmentsDir holds one file per environment plus GlobalsFile.
	EnvironmentsDir = "environments"
	GlobalsFile     = "_globals.yaml"
	// LocalDir holds machine-local state and is git-ignored.
	LocalDir = ".pakpos"
	// FormatVersion is the newest workspace format this build understands
	// and the version new workspaces are created with.
	//
	// v2 adds environments/, globals, secret variables and nested folders;
	// every change is additive, so a v1 workspace opens as is. Its manifest
	// is only rewritten to v2 when the app first writes something
	// v2-specific (an environment, the globals, a folder, or collection
	// settings with a secret variable), so merely opening a Tier 1
	// workspace never changes it.
	FormatVersion = 2
)

// Errors returned by the store. Wrap-checked with errors.Is.
var (
	ErrNotWorkspace  = errors.New("not a pakpos workspace")
	ErrAlreadyExists = errors.New("a workspace already exists here")
	ErrNotFound      = errors.New("not found")
	ErrUnsupported   = errors.New("workspace format is newer than this app")
	// ErrInvalidMove is returned when a folder would be moved into itself
	// or one of its own subfolders.
	ErrInvalidMove = errors.New("a folder can't be moved into itself or one of its subfolders")
)

// Manifest is the content of pakpos.yaml.
type Manifest struct {
	ID      string `json:"id" yaml:"id"`
	Name    string `json:"name" yaml:"name"`
	Version int    `json:"version" yaml:"version"`
}

// Collection is the content of a collection's _collection.yaml. Auth,
// Headers are inherited by its requests (see core/inherit) and Variables
// form the collection scope (see core/vars). v1 files, whose variable rows
// have no secret flag, load unchanged.
type Collection struct {
	ID        string           `json:"id" yaml:"id"`
	Name      string           `json:"name" yaml:"name"`
	Seq       int              `json:"seq" yaml:"seq"`
	Auth      model.Auth       `json:"auth" yaml:"auth,omitempty"`
	Headers   []model.KeyValue `json:"headers" yaml:"headers,omitempty"`
	Variables []model.Variable `json:"variables" yaml:"variables,omitempty"`
}

// RequestSummary is what the sidebar tree needs for one request.
type RequestSummary struct {
	ID     string `json:"id"`
	Name   string `json:"name"`
	Method string `json:"method"`
	// URL lets the sidebar filter match on the request URL.
	URL string `json:"url"`
	Seq int    `json:"seq"`
	// ParentID is the collection or folder holding the request.
	ParentID string `json:"parentId"`
}

// Problem is a file that could not be loaded (e.g. hand-edited invalid YAML).
// The rest of the workspace still loads.
type Problem struct {
	Path    string `json:"path"` // relative to the workspace root
	Message string `json:"message"`
}

// Tree is the whole workspace as shown in the sidebar: collection nodes,
// each holding folders and requests (see Node).
type Tree struct {
	Collections []Node    `json:"collections"`
	Problems    []Problem `json:"problems"`
}

type reqEntry struct {
	parentID string // collection or folder id
	file     string // file name inside the parent's directory
	summary  RequestSummary
}

type colEntry struct {
	meta Collection
	dir  string // directory name inside collections/
}

// Workspace is an open workspace folder. It is safe for concurrent use.
type Workspace struct {
	root     string
	manifest Manifest

	mu          sync.Mutex
	collections map[string]*colEntry
	folders     map[string]*folderEntry
	requests    map[string]*reqEntry
	envs        map[string]*envEntry
	globals     *Globals // nil until _globals.yaml exists
	// pendingGlobalsID is handed out by GetGlobals before the globals file
	// exists, so the scope ID (used in secret keys) is stable until saved.
	pendingGlobalsID string
	problems         []Problem

	writesMu sync.Mutex
	writes   map[string]time.Time // absolute path -> time of our own write

	watchersMu sync.Mutex
	watchers   map[*Watcher]struct{}
}

// Create initialises a new workspace in root (created if missing).
func Create(root, name string) (*Workspace, error) {
	root, err := filepath.Abs(root)
	if err != nil {
		return nil, err
	}
	if _, err := os.Stat(filepath.Join(root, ManifestFile)); err == nil {
		return nil, fmt.Errorf("%w: %s", ErrAlreadyExists, root)
	}
	if err := os.MkdirAll(filepath.Join(root, CollectionsDir), 0o755); err != nil {
		return nil, fmt.Errorf("create workspace folder: %w", err)
	}
	name = strings.TrimSpace(name)
	if name == "" {
		name = filepath.Base(root)
	}
	ws := newWorkspace(root, Manifest{ID: model.NewID(), Name: name, Version: FormatVersion})
	if err := ws.writeYAML(filepath.Join(root, ManifestFile), ws.manifest); err != nil {
		return nil, err
	}
	if err := ensureGitignore(root); err != nil {
		return nil, err
	}
	ws.Reload()
	return ws, nil
}

// Open opens an existing workspace folder.
func Open(root string) (*Workspace, error) {
	root, err := filepath.Abs(root)
	if err != nil {
		return nil, err
	}
	data, err := os.ReadFile(filepath.Join(root, ManifestFile))
	if errors.Is(err, os.ErrNotExist) {
		return nil, fmt.Errorf("%w: %s has no %s", ErrNotWorkspace, root, ManifestFile)
	}
	if err != nil {
		return nil, fmt.Errorf("read %s: %w", ManifestFile, err)
	}
	var m Manifest
	if err := yaml.Unmarshal(data, &m); err != nil {
		return nil, fmt.Errorf("%w: %s is not valid YAML: %v", ErrNotWorkspace, ManifestFile, err)
	}
	if m.ID == "" {
		return nil, fmt.Errorf("%w: %s has no id", ErrNotWorkspace, ManifestFile)
	}
	if m.Version > FormatVersion {
		return nil, fmt.Errorf("%w: version %d, supported up to %d", ErrUnsupported, m.Version, FormatVersion)
	}
	if m.Name == "" {
		m.Name = filepath.Base(root)
	}
	ws := newWorkspace(root, m)
	ws.Reload()
	return ws, nil
}

func newWorkspace(root string, m Manifest) *Workspace {
	return &Workspace{
		root:        root,
		manifest:    m,
		collections: map[string]*colEntry{},
		folders:     map[string]*folderEntry{},
		requests:    map[string]*reqEntry{},
		envs:        map[string]*envEntry{},
		writes:      map[string]time.Time{},
		watchers:    map[*Watcher]struct{}{},
	}
}

// Root is the absolute path of the workspace folder.
func (w *Workspace) Root() string { return w.root }

// Manifest returns the workspace manifest.
func (w *Workspace) Manifest() Manifest {
	w.mu.Lock()
	defer w.mu.Unlock()
	return w.manifest
}

// upgradeManifestLocked rewrites a v1 manifest as v2. It runs before the
// first v2-specific write, so a Tier 1 build refuses the workspace instead of
// silently ignoring the new data. Callers hold w.mu.
func (w *Workspace) upgradeManifestLocked() error {
	if w.manifest.Version >= FormatVersion {
		return nil
	}
	m := w.manifest
	m.Version = FormatVersion
	if err := w.writeYAML(filepath.Join(w.root, ManifestFile), m); err != nil {
		return fmt.Errorf("upgrade %s to version %d: %w", ManifestFile, FormatVersion, err)
	}
	w.manifest = m
	return nil
}

// Reload rescans the workspace from disk and returns files that could not be loaded.
//
// The scan and the swap happen under w.mu: a save that ran between an
// unlocked scan and the swap would otherwise be dropped from the index by the
// scan's stale snapshot (the request then reads as "not found").
func (w *Workspace) Reload() []Problem {
	w.mu.Lock()
	defer w.mu.Unlock()
	sc := &scan{
		cols:    map[string]*colEntry{},
		folders: map[string]*folderEntry{},
		reqs:    map[string]*reqEntry{},
	}
	sc.addProblem = func(abs, msg string) {
		sc.problems = append(sc.problems, Problem{Path: w.rel(abs), Message: msg})
	}

	colRoot := filepath.Join(w.root, CollectionsDir)
	dirs, err := os.ReadDir(colRoot)
	if err != nil && !errors.Is(err, os.ErrNotExist) {
		sc.addProblem(colRoot, err.Error())
	}
	for _, d := range dirs {
		if !d.IsDir() || strings.HasPrefix(d.Name(), ".") {
			continue
		}
		dirPath := filepath.Join(colRoot, d.Name())
		metaPath := filepath.Join(dirPath, CollectionFile)
		var meta Collection
		if err := readYAML(metaPath, &meta); err != nil {
			msg := err.Error()
			if errors.Is(err, os.ErrNotExist) {
				msg = "folder has no " + CollectionFile + "; it is not loaded as a collection"
			}
			sc.addProblem(metaPath, msg)
			continue
		}
		if meta.ID == "" {
			sc.addProblem(metaPath, "missing id")
			continue
		}
		if sc.containerExists(meta.ID) {
			sc.addProblem(metaPath, "duplicate collection id "+meta.ID)
			continue
		}
		if meta.Name == "" {
			meta.Name = d.Name()
		}
		sc.cols[meta.ID] = &colEntry{meta: meta, dir: d.Name()}
		w.loadDir(sc, meta.ID, dirPath)
	}

	envs, globals := w.loadEnvironments(sc.addProblem)

	w.collections, w.folders, w.requests, w.problems = sc.cols, sc.folders, sc.reqs, sc.problems
	if globals == nil && w.globals != nil {
		// _globals.yaml vanished (e.g. git checkout): keep its ID, so a later
		// save reuses it and secret keys stay valid.
		w.pendingGlobalsID = w.globals.ID
	}
	w.envs, w.globals = envs, globals
	return sc.problems
}

// scan collects the index while Reload walks the workspace.
type scan struct {
	cols       map[string]*colEntry
	folders    map[string]*folderEntry
	reqs       map[string]*reqEntry
	problems   []Problem
	addProblem func(abs, msg string)
}

// containerExists reports whether a collection or folder already uses id;
// both share one namespace because either can be a request's parent.
func (sc *scan) containerExists(id string) bool {
	_, col := sc.cols[id]
	_, folder := sc.folders[id]
	return col || folder
}

// loadDir loads the requests and folders directly inside dirPath, which is
// the directory of the collection or folder parentID, and recurses into
// the folders.
func (w *Workspace) loadDir(sc *scan, parentID, dirPath string) {
	entries, err := os.ReadDir(dirPath)
	if err != nil {
		sc.addProblem(dirPath, err.Error())
		return
	}
	for _, f := range entries {
		name := f.Name()
		if strings.HasPrefix(name, ".") {
			continue
		}
		p := filepath.Join(dirPath, name)
		if f.IsDir() {
			w.loadFolder(sc, parentID, p)
			continue
		}
		if !isRequestFile(name) {
			continue
		}
		var r model.Request
		if err := readYAML(p, &r); err != nil {
			sc.addProblem(p, err.Error())
			continue
		}
		if r.ID == "" {
			sc.addProblem(p, "missing id")
			continue
		}
		if _, dup := sc.reqs[r.ID]; dup {
			sc.addProblem(p, "duplicate request id "+r.ID)
			continue
		}
		s := summarize(r)
		s.ParentID = parentID
		sc.reqs[r.ID] = &reqEntry{parentID: parentID, file: name, summary: s}
	}
}

// loadFolder loads the folder in dirPath (a subdirectory of parentID's
// directory). A subdirectory without a valid _folder.yaml is reported and
// skipped together with everything inside it.
func (w *Workspace) loadFolder(sc *scan, parentID, dirPath string) {
	metaPath := filepath.Join(dirPath, FolderFile)
	var meta Folder
	if err := readYAML(metaPath, &meta); err != nil {
		msg := err.Error()
		if errors.Is(err, os.ErrNotExist) {
			msg = "folder has no " + FolderFile + "; it and its contents are not loaded"
		}
		sc.addProblem(metaPath, msg)
		return
	}
	if meta.ID == "" {
		sc.addProblem(metaPath, "missing id")
		return
	}
	if sc.containerExists(meta.ID) {
		sc.addProblem(metaPath, "duplicate folder id "+meta.ID)
		return
	}
	if meta.Name == "" {
		meta.Name = filepath.Base(dirPath)
	}
	sc.folders[meta.ID] = &folderEntry{meta: meta, parentID: parentID, dir: filepath.Base(dirPath)}
	w.loadDir(sc, meta.ID, dirPath)
}

// isRequestFile reports whether a file in a collection or folder directory
// holds a request: YAML, and not one of the reserved files.
func isRequestFile(name string) bool {
	if !isYAML(name) || name == CollectionFile || name == FolderFile {
		return false
	}
	return !strings.HasSuffix(strings.ToLower(name), ExamplesSuffix)
}

func lessSeq(a, b int, an, bn string) bool {
	if a != b {
		return a < b
	}
	return strings.ToLower(an) < strings.ToLower(bn)
}

// ---- collections ----

// GetCollection returns a collection's metadata.
func (w *Workspace) GetCollection(id string) (Collection, error) {
	w.mu.Lock()
	defer w.mu.Unlock()
	c, ok := w.collections[id]
	if !ok {
		return Collection{}, fmt.Errorf("collection %s: %w", id, ErrNotFound)
	}
	return copyCollection(c.meta), nil
}

// CreateCollection adds a collection at the end of the list.
func (w *Workspace) CreateCollection(name string) (Collection, error) {
	name = cleanName(name, "New collection")
	w.mu.Lock()
	defer w.mu.Unlock()

	colRoot := filepath.Join(w.root, CollectionsDir)
	if err := os.MkdirAll(colRoot, 0o755); err != nil {
		return Collection{}, fmt.Errorf("create collections folder: %w", err)
	}
	dir := uniqueName(colRoot, slugify(name, "collection"), "")
	meta := Collection{ID: model.NewID(), Name: name, Seq: w.nextCollectionSeq()}
	dirPath := filepath.Join(colRoot, dir)
	w.markWrite(dirPath)
	if err := os.Mkdir(dirPath, 0o755); err != nil {
		return Collection{}, fmt.Errorf("create collection folder: %w", err)
	}
	w.watchDir(dirPath)
	if err := w.writeYAML(filepath.Join(dirPath, CollectionFile), meta); err != nil {
		_ = os.RemoveAll(dirPath)
		return Collection{}, err
	}
	w.collections[meta.ID] = &colEntry{meta: meta, dir: dir}
	return meta, nil
}

// RenameCollection changes a collection's name and renames its folder to match.
func (w *Workspace) RenameCollection(id, name string) (Collection, error) {
	name = cleanName(name, "New collection")
	w.mu.Lock()
	defer w.mu.Unlock()
	c, ok := w.collections[id]
	if !ok {
		return Collection{}, fmt.Errorf("collection %s: %w", id, ErrNotFound)
	}
	colRoot := filepath.Join(w.root, CollectionsDir)
	newDir := c.dir
	if slug := slugify(name, "collection"); slug != c.dir {
		newDir = uniqueName(colRoot, slug, "")
		oldPath, newPath := filepath.Join(colRoot, c.dir), filepath.Join(colRoot, newDir)
		w.markWrite(oldPath)
		w.markWrite(newPath)
		w.unwatchDir(oldPath)
		if err := os.Rename(oldPath, newPath); err != nil {
			w.watchDir(oldPath)
			return Collection{}, fmt.Errorf("rename collection folder: %w", err)
		}
		c.dir = newDir
		w.watchDir(newPath)
	}
	meta := copyCollection(c.meta)
	meta.Name = name
	if err := w.writeYAML(filepath.Join(colRoot, newDir, CollectionFile), meta); err != nil {
		return Collection{}, err
	}
	c.meta = meta
	return copyCollection(meta), nil
}

// CollectionSettings are the parts of a collection its requests inherit
// (auth, headers) or resolve variables from.
type CollectionSettings struct {
	Auth      model.Auth       `json:"auth"`
	Headers   []model.KeyValue `json:"headers"`
	Variables []model.Variable `json:"variables"`
}

// SaveCollection replaces a collection's auth, headers and variables.
// Secret variable values are never written (only the key and flag are);
// the returned collection has them cleared too. Saving a secret variable
// upgrades a v1 manifest, since a Tier 1 build would drop the flag.
func (w *Workspace) SaveCollection(id string, s CollectionSettings) (Collection, error) {
	w.mu.Lock()
	defer w.mu.Unlock()
	c, ok := w.collections[id]
	if !ok {
		return Collection{}, fmt.Errorf("collection %s: %w", id, ErrNotFound)
	}
	meta := c.meta
	meta.Auth = s.Auth
	meta.Headers = append([]model.KeyValue(nil), s.Headers...)
	meta.Variables = normalizeVars(s.Variables)
	for _, v := range meta.Variables {
		if v.Secret {
			if err := w.upgradeManifestLocked(); err != nil {
				return Collection{}, err
			}
			break
		}
	}
	path := filepath.Join(w.root, CollectionsDir, c.dir, CollectionFile)
	if err := w.writeYAML(path, meta); err != nil {
		return Collection{}, fmt.Errorf("save collection %q: %w", meta.Name, err)
	}
	c.meta = meta
	return copyCollection(meta), nil
}

// DeleteCollection removes a collection folder with all its folders and requests.
func (w *Workspace) DeleteCollection(id string) error {
	w.mu.Lock()
	defer w.mu.Unlock()
	c, ok := w.collections[id]
	if !ok {
		return fmt.Errorf("collection %s: %w", id, ErrNotFound)
	}
	dirPath := filepath.Join(w.root, CollectionsDir, c.dir)
	w.markTree(dirPath)
	w.unwatchDir(dirPath)
	if err := os.RemoveAll(dirPath); err != nil {
		w.watchDir(dirPath)
		return fmt.Errorf("delete collection: %w", err)
	}
	w.dropSubtreeLocked(id)
	delete(w.collections, id)
	return nil
}

// ReorderCollections sets Seq from the given order. Unknown ids are an error;
// collections not listed keep their relative order after the listed ones.
func (w *Workspace) ReorderCollections(ids []string) error {
	w.mu.Lock()
	defer w.mu.Unlock()
	for _, id := range ids {
		if _, ok := w.collections[id]; !ok {
			return fmt.Errorf("collection %s: %w", id, ErrNotFound)
		}
	}
	for i, id := range ids {
		c := w.collections[id]
		if c.meta.Seq == i+1 {
			continue
		}
		meta := c.meta
		meta.Seq = i + 1
		if err := w.writeYAML(filepath.Join(w.root, CollectionsDir, c.dir, CollectionFile), meta); err != nil {
			return err
		}
		c.meta = meta
	}
	return nil
}

func (w *Workspace) nextCollectionSeq() int {
	maxSeq := 0
	for _, c := range w.collections {
		maxSeq = max(maxSeq, c.meta.Seq)
	}
	return maxSeq + 1
}

func copyCollection(c Collection) Collection {
	c.Headers = append([]model.KeyValue{}, c.Headers...)
	c.Variables = append([]model.Variable{}, c.Variables...)
	return c
}

// ---- requests ----

// GetRequest reads a request from disk.
func (w *Workspace) GetRequest(id string) (model.Request, error) {
	w.mu.Lock()
	defer w.mu.Unlock()
	path, _, err := w.requestPath(id)
	if err != nil {
		return model.Request{}, err
	}
	var r model.Request
	if err := readYAML(path, &r); err != nil {
		return model.Request{}, fmt.Errorf("read request %s: %w", id, err)
	}
	return r, nil
}

// RequestCollection returns the id of the collection holding a request,
// directly or through folders.
func (w *Workspace) RequestCollection(id string) (string, error) {
	w.mu.Lock()
	defer w.mu.Unlock()
	r, ok := w.requests[id]
	if !ok {
		return "", fmt.Errorf("request %s: %w", id, ErrNotFound)
	}
	return w.collectionOfLocked(r.parentID)
}

// RequestParent returns the id of the collection or folder directly holding a request.
func (w *Workspace) RequestParent(id string) (string, error) {
	w.mu.Lock()
	defer w.mu.Unlock()
	r, ok := w.requests[id]
	if !ok {
		return "", fmt.Errorf("request %s: %w", id, ErrNotFound)
	}
	return r.parentID, nil
}

// CreateRequest saves a new request at the end of a collection or folder.
// A new ID is assigned when req.ID is empty or already used.
func (w *Workspace) CreateRequest(parentID string, req model.Request) (model.Request, error) {
	w.mu.Lock()
	defer w.mu.Unlock()
	return w.createLocked(parentID, req)
}

func (w *Workspace) createLocked(parentID string, req model.Request) (model.Request, error) {
	dirPath, err := w.dirLocked(parentID)
	if err != nil {
		return model.Request{}, err
	}
	if _, used := w.requests[req.ID]; req.ID == "" || used {
		req.ID = model.NewID()
	}
	req.Name = cleanName(req.Name, "Untitled request")
	normalizeRequest(&req)
	req.Seq = w.nextSeqLocked(parentID)

	file := uniqueName(dirPath, slugify(req.Name, "request"), ".yaml")
	if err := w.writeYAML(filepath.Join(dirPath, file), req); err != nil {
		return model.Request{}, err
	}
	w.requests[req.ID] = &reqEntry{parentID: parentID, file: file, summary: summaryIn(req, parentID)}
	return req, nil
}

// SaveRequest overwrites an existing request. If its name changed, the file
// is renamed to match.
func (w *Workspace) SaveRequest(req model.Request) (model.Request, error) {
	w.mu.Lock()
	defer w.mu.Unlock()
	e, ok := w.requests[req.ID]
	if !ok {
		return model.Request{}, fmt.Errorf("request %s: %w", req.ID, ErrNotFound)
	}
	req.Name = cleanName(req.Name, "Untitled request")
	normalizeRequest(&req)
	if err := w.writeRequest(e, req); err != nil {
		return model.Request{}, err
	}
	return req, nil
}

// writeRequest writes req to e's file, renaming the file if the name's slug changed.
func (w *Workspace) writeRequest(e *reqEntry, req model.Request) error {
	dirPath, err := w.dirLocked(e.parentID)
	if err != nil {
		return err
	}
	file := e.file
	if slug := slugify(req.Name, "request"); slug+".yaml" != file {
		file = uniqueName(dirPath, slug, ".yaml")
	}
	if err := w.writeYAML(filepath.Join(dirPath, file), req); err != nil {
		return err
	}
	if file != e.file {
		old := filepath.Join(dirPath, e.file)
		w.markWrite(old)
		if err := os.Remove(old); err != nil && !errors.Is(err, os.ErrNotExist) {
			return fmt.Errorf("remove old request file: %w", err)
		}
	}
	e.file = file
	e.summary = summaryIn(req, e.parentID)
	return nil
}

// RenameRequest changes a request's name (and file name).
func (w *Workspace) RenameRequest(id, name string) (model.Request, error) {
	w.mu.Lock()
	defer w.mu.Unlock()
	path, e, err := w.requestPath(id)
	if err != nil {
		return model.Request{}, err
	}
	var r model.Request
	if err := readYAML(path, &r); err != nil {
		return model.Request{}, fmt.Errorf("read request %s: %w", id, err)
	}
	r.Name = cleanName(name, "Untitled request")
	if err := w.writeRequest(e, r); err != nil {
		return model.Request{}, err
	}
	return r, nil
}

// DuplicateRequest copies a request into the same parent as "<name> copy".
func (w *Workspace) DuplicateRequest(id string) (model.Request, error) {
	w.mu.Lock()
	defer w.mu.Unlock()
	path, e, err := w.requestPath(id)
	if err != nil {
		return model.Request{}, err
	}
	var r model.Request
	if err := readYAML(path, &r); err != nil {
		return model.Request{}, fmt.Errorf("read request %s: %w", id, err)
	}
	r.ID = ""
	r.Name += " copy"
	return w.createLocked(e.parentID, r)
}

// DeleteRequest removes a request file.
func (w *Workspace) DeleteRequest(id string) error {
	w.mu.Lock()
	defer w.mu.Unlock()
	path, _, err := w.requestPath(id)
	if err != nil {
		return err
	}
	w.markWrite(path)
	if err := os.Remove(path); err != nil && !errors.Is(err, os.ErrNotExist) {
		return fmt.Errorf("delete request: %w", err)
	}
	delete(w.requests, id)
	return nil
}

func (w *Workspace) requestPath(id string) (string, *reqEntry, error) {
	e, ok := w.requests[id]
	if !ok {
		return "", nil, fmt.Errorf("request %s: %w", id, ErrNotFound)
	}
	dir, err := w.dirLocked(e.parentID)
	if err != nil {
		return "", nil, err
	}
	return filepath.Join(dir, e.file), e, nil
}

// ---- helpers ----

// summaryIn summarizes r as a child of parentID.
func summaryIn(r model.Request, parentID string) RequestSummary {
	s := summarize(r)
	s.ParentID = parentID
	return s
}

func summarize(r model.Request) RequestSummary {
	method := strings.ToUpper(r.Method)
	if method == "" {
		method = "GET"
	}
	return RequestSummary{ID: r.ID, Name: r.Name, Method: method, URL: r.URL, Seq: r.Seq}
}

func normalizeRequest(r *model.Request) {
	r.Method = strings.ToUpper(strings.TrimSpace(r.Method))
	if r.Method == "" {
		r.Method = "GET"
	}
	if r.Body.Type == "" {
		r.Body.Type = model.BodyNone
	}
	if r.Auth.Type == "" {
		r.Auth.Type = model.AuthNone
	}
}

func cleanName(name, fallback string) string {
	name = strings.Join(strings.Fields(name), " ")
	if name == "" {
		return fallback
	}
	return name
}

func isYAML(name string) bool {
	ext := strings.ToLower(filepath.Ext(name))
	return ext == ".yaml" || ext == ".yml"
}

func (w *Workspace) rel(abs string) string {
	if r, err := filepath.Rel(w.root, abs); err == nil {
		return filepath.ToSlash(r)
	}
	return abs
}

func readYAML(path string, out any) error {
	data, err := os.ReadFile(path)
	if err != nil {
		return err
	}
	if err := yaml.Unmarshal(data, out); err != nil {
		return fmt.Errorf("invalid YAML: %w", err)
	}
	return nil
}

// writeYAML encodes v and writes it atomically, recording the write so the
// watcher ignores it.
func (w *Workspace) writeYAML(path string, v any) error {
	data, err := marshalYAML(v)
	if err != nil {
		return err
	}
	w.markWrite(path)
	return writeFileAtomic(path, data)
}

func ensureGitignore(root string) error {
	path := filepath.Join(root, ".gitignore")
	data, err := os.ReadFile(path)
	if err != nil && !errors.Is(err, os.ErrNotExist) {
		return err
	}
	for _, line := range strings.Split(string(data), "\n") {
		if l := strings.TrimSpace(line); l == LocalDir+"/" || l == LocalDir || l == "/"+LocalDir+"/" {
			return nil
		}
	}
	content := string(data)
	if content != "" && !strings.HasSuffix(content, "\n") {
		content += "\n"
	}
	content += LocalDir + "/\n"
	return writeFileAtomic(path, []byte(content))
}
