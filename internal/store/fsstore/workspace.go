// Package fsstore keeps a workspace as plain files: a pakpos.yaml manifest,
// one directory per collection and one YAML file per request. The layout is
// designed to be committed to git. It has no Wails dependency.
package fsstore

import (
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"sort"
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
	// LocalDir holds machine-local state and is git-ignored.
	LocalDir = ".pakpos"
	// FormatVersion is the newest workspace format this build understands.
	FormatVersion = 1
)

// Errors returned by the store. Wrap-checked with errors.Is.
var (
	ErrNotWorkspace  = errors.New("not a pakpos workspace")
	ErrAlreadyExists = errors.New("a workspace already exists here")
	ErrNotFound      = errors.New("not found")
	ErrUnsupported   = errors.New("workspace format is newer than this app")
)

// Manifest is the content of pakpos.yaml.
type Manifest struct {
	ID      string `json:"id" yaml:"id"`
	Name    string `json:"name" yaml:"name"`
	Version int    `json:"version" yaml:"version"`
}

// Collection is the content of a collection's _collection.yaml. Auth,
// Headers and Variables are inherited by its requests (resolved in Tier 2).
type Collection struct {
	ID        string           `json:"id" yaml:"id"`
	Name      string           `json:"name" yaml:"name"`
	Seq       int              `json:"seq" yaml:"seq"`
	Auth      model.Auth       `json:"auth" yaml:"auth,omitempty"`
	Headers   []model.KeyValue `json:"headers" yaml:"headers,omitempty"`
	Variables []model.KeyValue `json:"variables" yaml:"variables,omitempty"`
}

// RequestSummary is what the sidebar tree needs for one request.
type RequestSummary struct {
	ID     string `json:"id"`
	Name   string `json:"name"`
	Method string `json:"method"`
	// URL lets the sidebar filter match on the request URL.
	URL string `json:"url"`
	Seq int    `json:"seq"`
}

// CollectionNode is one collection with its requests, ordered by Seq.
type CollectionNode struct {
	ID       string           `json:"id"`
	Name     string           `json:"name"`
	Seq      int              `json:"seq"`
	Requests []RequestSummary `json:"requests"`
}

// Problem is a file that could not be loaded (e.g. hand-edited invalid YAML).
// The rest of the workspace still loads.
type Problem struct {
	Path    string `json:"path"` // relative to the workspace root
	Message string `json:"message"`
}

// Tree is the whole workspace as shown in the sidebar.
type Tree struct {
	Collections []CollectionNode `json:"collections"`
	Problems    []Problem        `json:"problems"`
}

type reqEntry struct {
	collectionID string
	file         string // file name inside the collection dir
	summary      RequestSummary
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
	requests    map[string]*reqEntry
	problems    []Problem

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
		requests:    map[string]*reqEntry{},
		writes:      map[string]time.Time{},
		watchers:    map[*Watcher]struct{}{},
	}
}

// Root is the absolute path of the workspace folder.
func (w *Workspace) Root() string { return w.root }

// Manifest returns the workspace manifest.
func (w *Workspace) Manifest() Manifest { return w.manifest }

// Reload rescans the workspace from disk and returns files that could not be loaded.
func (w *Workspace) Reload() []Problem {
	cols := map[string]*colEntry{}
	reqs := map[string]*reqEntry{}
	var problems []Problem
	addProblem := func(abs, msg string) {
		problems = append(problems, Problem{Path: w.rel(abs), Message: msg})
	}

	colRoot := filepath.Join(w.root, CollectionsDir)
	dirs, err := os.ReadDir(colRoot)
	if err != nil && !errors.Is(err, os.ErrNotExist) {
		addProblem(colRoot, err.Error())
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
			addProblem(metaPath, msg)
			continue
		}
		if meta.ID == "" {
			addProblem(metaPath, "missing id")
			continue
		}
		if _, dup := cols[meta.ID]; dup {
			addProblem(metaPath, "duplicate collection id "+meta.ID)
			continue
		}
		if meta.Name == "" {
			meta.Name = d.Name()
		}
		cols[meta.ID] = &colEntry{meta: meta, dir: d.Name()}
		w.loadRequests(meta.ID, dirPath, reqs, addProblem)
	}

	w.mu.Lock()
	w.collections, w.requests, w.problems = cols, reqs, problems
	w.mu.Unlock()
	return problems
}

func (w *Workspace) loadRequests(colID, dirPath string, reqs map[string]*reqEntry, addProblem func(string, string)) {
	files, err := os.ReadDir(dirPath)
	if err != nil {
		addProblem(dirPath, err.Error())
		return
	}
	for _, f := range files {
		name := f.Name()
		if f.IsDir() || name == CollectionFile || !isYAML(name) || strings.HasPrefix(name, ".") {
			continue
		}
		p := filepath.Join(dirPath, name)
		var r model.Request
		if err := readYAML(p, &r); err != nil {
			addProblem(p, err.Error())
			continue
		}
		if r.ID == "" {
			addProblem(p, "missing id")
			continue
		}
		if _, dup := reqs[r.ID]; dup {
			addProblem(p, "duplicate request id "+r.ID)
			continue
		}
		reqs[r.ID] = &reqEntry{collectionID: colID, file: name, summary: summarize(r)}
	}
}

// Tree returns the collections and request summaries ordered by Seq (then name).
func (w *Workspace) Tree() Tree {
	w.mu.Lock()
	defer w.mu.Unlock()
	nodes := make([]CollectionNode, 0, len(w.collections))
	byCol := map[string][]RequestSummary{}
	for _, r := range w.requests {
		byCol[r.collectionID] = append(byCol[r.collectionID], r.summary)
	}
	for id, c := range w.collections {
		reqs := byCol[id]
		if reqs == nil {
			reqs = []RequestSummary{}
		}
		sort.Slice(reqs, func(i, j int) bool { return lessSeq(reqs[i].Seq, reqs[j].Seq, reqs[i].Name, reqs[j].Name) })
		nodes = append(nodes, CollectionNode{ID: id, Name: c.meta.Name, Seq: c.meta.Seq, Requests: reqs})
	}
	sort.Slice(nodes, func(i, j int) bool { return lessSeq(nodes[i].Seq, nodes[j].Seq, nodes[i].Name, nodes[j].Name) })
	problems := append([]Problem{}, w.problems...)
	return Tree{Collections: nodes, Problems: problems}
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
	return c.meta, nil
}

// CreateCollection adds a collection at the end of the list.
func (w *Workspace) CreateCollection(name string) (Collection, error) {
	name = cleanName(name, "New collection")
	w.mu.Lock()
	defer w.mu.Unlock()

	colRoot := filepath.Join(w.root, CollectionsDir)
	if err := os.MkdirAll(colRoot, 0o755); err != nil {
		return Collection{}, err
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
		if err := os.Rename(oldPath, newPath); err != nil {
			return Collection{}, fmt.Errorf("rename collection folder: %w", err)
		}
		w.watchDir(newPath)
	}
	meta := c.meta
	meta.Name = name
	if err := w.writeYAML(filepath.Join(colRoot, newDir, CollectionFile), meta); err != nil {
		return Collection{}, err
	}
	c.meta, c.dir = meta, newDir
	return meta, nil
}

// DeleteCollection removes a collection folder and all its requests.
func (w *Workspace) DeleteCollection(id string) error {
	w.mu.Lock()
	defer w.mu.Unlock()
	c, ok := w.collections[id]
	if !ok {
		return fmt.Errorf("collection %s: %w", id, ErrNotFound)
	}
	dirPath := filepath.Join(w.root, CollectionsDir, c.dir)
	w.markWrite(dirPath)
	if err := os.RemoveAll(dirPath); err != nil {
		return fmt.Errorf("delete collection: %w", err)
	}
	delete(w.collections, id)
	for rid, r := range w.requests {
		if r.collectionID == id {
			delete(w.requests, rid)
		}
	}
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

// RequestCollection returns the id of the collection holding a request.
func (w *Workspace) RequestCollection(id string) (string, error) {
	w.mu.Lock()
	defer w.mu.Unlock()
	r, ok := w.requests[id]
	if !ok {
		return "", fmt.Errorf("request %s: %w", id, ErrNotFound)
	}
	return r.collectionID, nil
}

// CreateRequest saves a new request at the end of a collection. A new ID is
// assigned when req.ID is empty or already used.
func (w *Workspace) CreateRequest(collectionID string, req model.Request) (model.Request, error) {
	w.mu.Lock()
	defer w.mu.Unlock()
	return w.createLocked(collectionID, req)
}

func (w *Workspace) createLocked(collectionID string, req model.Request) (model.Request, error) {
	c, ok := w.collections[collectionID]
	if !ok {
		return model.Request{}, fmt.Errorf("collection %s: %w", collectionID, ErrNotFound)
	}
	if _, used := w.requests[req.ID]; req.ID == "" || used {
		req.ID = model.NewID()
	}
	req.Name = cleanName(req.Name, "Untitled request")
	normalizeRequest(&req)
	req.Seq = w.nextRequestSeq(collectionID)

	dirPath := filepath.Join(w.root, CollectionsDir, c.dir)
	file := uniqueName(dirPath, slugify(req.Name, "request"), ".yaml")
	if err := w.writeYAML(filepath.Join(dirPath, file), req); err != nil {
		return model.Request{}, err
	}
	w.requests[req.ID] = &reqEntry{collectionID: collectionID, file: file, summary: summarize(req)}
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
	dirPath := filepath.Join(w.root, CollectionsDir, w.collections[e.collectionID].dir)
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
	e.summary = summarize(req)
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

// DuplicateRequest copies a request into the same collection as "<name> copy".
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
	return w.createLocked(e.collectionID, r)
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

// MoveRequest moves a request to the end of another collection, keeping its ID.
func (w *Workspace) MoveRequest(id, toCollectionID string) (model.Request, error) {
	w.mu.Lock()
	defer w.mu.Unlock()
	path, e, err := w.requestPath(id)
	if err != nil {
		return model.Request{}, err
	}
	if _, ok := w.collections[toCollectionID]; !ok {
		return model.Request{}, fmt.Errorf("collection %s: %w", toCollectionID, ErrNotFound)
	}
	var r model.Request
	if err := readYAML(path, &r); err != nil {
		return model.Request{}, fmt.Errorf("read request %s: %w", id, err)
	}
	if e.collectionID == toCollectionID {
		return r, nil
	}
	delete(w.requests, id)
	moved, err := w.createLocked(toCollectionID, r)
	if err != nil {
		w.requests[id] = e
		return model.Request{}, err
	}
	w.markWrite(path)
	if err := os.Remove(path); err != nil && !errors.Is(err, os.ErrNotExist) {
		return model.Request{}, fmt.Errorf("remove moved request: %w", err)
	}
	return moved, nil
}

// ReorderRequests sets Seq within a collection from the given order.
func (w *Workspace) ReorderRequests(collectionID string, ids []string) error {
	w.mu.Lock()
	defer w.mu.Unlock()
	if _, ok := w.collections[collectionID]; !ok {
		return fmt.Errorf("collection %s: %w", collectionID, ErrNotFound)
	}
	for _, id := range ids {
		if e, ok := w.requests[id]; !ok || e.collectionID != collectionID {
			return fmt.Errorf("request %s in collection %s: %w", id, collectionID, ErrNotFound)
		}
	}
	for i, id := range ids {
		e := w.requests[id]
		if e.summary.Seq == i+1 {
			continue
		}
		path := filepath.Join(w.root, CollectionsDir, w.collections[collectionID].dir, e.file)
		var r model.Request
		if err := readYAML(path, &r); err != nil {
			return fmt.Errorf("read request %s: %w", id, err)
		}
		r.Seq = i + 1
		if err := w.writeYAML(path, r); err != nil {
			return err
		}
		e.summary.Seq = r.Seq
	}
	return nil
}

func (w *Workspace) requestPath(id string) (string, *reqEntry, error) {
	e, ok := w.requests[id]
	if !ok {
		return "", nil, fmt.Errorf("request %s: %w", id, ErrNotFound)
	}
	return filepath.Join(w.root, CollectionsDir, w.collections[e.collectionID].dir, e.file), e, nil
}

func (w *Workspace) nextRequestSeq(collectionID string) int {
	maxSeq := 0
	for _, r := range w.requests {
		if r.collectionID == collectionID {
			maxSeq = max(maxSeq, r.summary.Seq)
		}
	}
	return maxSeq + 1
}

// ---- helpers ----

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
