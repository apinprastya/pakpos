package fsstore

import (
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strings"

	"pakpos/internal/core/model"
)

// Environment is the content of environments/<slug>.yaml: a named set of
// variables the user switches between (Dev, Staging, Prod).
type Environment struct {
	ID        string           `json:"id" yaml:"id"`
	Name      string           `json:"name" yaml:"name"`
	Seq       int              `json:"seq" yaml:"seq"`
	Variables []model.Variable `json:"variables" yaml:"variables"`
}

// Globals is the content of environments/_globals.yaml: variables available
// in every request, below collection and environment variables.
type Globals struct {
	ID        string           `json:"id" yaml:"id"`
	Variables []model.Variable `json:"variables" yaml:"variables"`
}

type envEntry struct {
	meta Environment
	file string // file name inside environments/
}

// loadEnvironments reads environments/. Called from Reload with w.mu held.
func (w *Workspace) loadEnvironments(addProblem func(string, string)) (map[string]*envEntry, *Globals) {
	envs := map[string]*envEntry{}
	var globals *Globals
	dir := filepath.Join(w.root, EnvironmentsDir)
	files, err := os.ReadDir(dir)
	if err != nil {
		// ReadDir on a regular file reports "not found" on Windows, so only
		// treat the directory as absent when Stat agrees.
		if _, statErr := os.Stat(dir); !errors.Is(statErr, os.ErrNotExist) {
			addProblem(dir, err.Error())
		}
		return envs, nil
	}
	for _, f := range files {
		name := f.Name()
		if f.IsDir() || !isYAML(name) || strings.HasPrefix(name, ".") {
			continue
		}
		p := filepath.Join(dir, name)
		if name == GlobalsFile {
			var g Globals
			if err := readYAML(p, &g); err != nil {
				addProblem(p, err.Error())
				continue
			}
			if g.ID == "" {
				addProblem(p, "missing id")
				continue
			}
			g.Variables = nonNilVars(g.Variables)
			globals = &g
			continue
		}
		if strings.HasPrefix(name, "_") {
			continue // reserved for future special files
		}
		var e Environment
		if err := readYAML(p, &e); err != nil {
			addProblem(p, err.Error())
			continue
		}
		if e.ID == "" {
			addProblem(p, "missing id")
			continue
		}
		if _, dup := envs[e.ID]; dup {
			addProblem(p, "duplicate environment id "+e.ID)
			continue
		}
		if e.Name == "" {
			e.Name = strings.TrimSuffix(name, filepath.Ext(name))
		}
		e.Variables = nonNilVars(e.Variables)
		envs[e.ID] = &envEntry{meta: e, file: name}
	}
	return envs, globals
}

// ListEnvironments returns the environments ordered by Seq, then name.
func (w *Workspace) ListEnvironments() []Environment {
	w.mu.Lock()
	defer w.mu.Unlock()
	out := make([]Environment, 0, len(w.envs))
	for _, e := range w.envs {
		out = append(out, copyEnv(e.meta))
	}
	sort.Slice(out, func(i, j int) bool { return lessSeq(out[i].Seq, out[j].Seq, out[i].Name, out[j].Name) })
	return out
}

// GetEnvironment returns one environment.
func (w *Workspace) GetEnvironment(id string) (Environment, error) {
	w.mu.Lock()
	defer w.mu.Unlock()
	e, ok := w.envs[id]
	if !ok {
		return Environment{}, fmt.Errorf("environment %s: %w", id, ErrNotFound)
	}
	return copyEnv(e.meta), nil
}

// CreateEnvironment adds an empty environment at the end of the list.
func (w *Workspace) CreateEnvironment(name string) (Environment, error) {
	w.mu.Lock()
	defer w.mu.Unlock()
	env := Environment{ID: model.NewID(), Name: cleanName(name, "New environment"), Seq: w.nextEnvSeq()}
	return w.createEnvLocked(env)
}

// DuplicateEnvironment copies an environment as "<name> copy", at the end of
// the list. The copy has a new ID, so secret values (keyed by scope ID) are
// not copied here; the caller copies them in the secret store.
func (w *Workspace) DuplicateEnvironment(id string) (Environment, error) {
	w.mu.Lock()
	defer w.mu.Unlock()
	src, ok := w.envs[id]
	if !ok {
		return Environment{}, fmt.Errorf("environment %s: %w", id, ErrNotFound)
	}
	env := copyEnv(src.meta)
	env.ID = model.NewID()
	env.Name += " copy"
	env.Seq = w.nextEnvSeq()
	return w.createEnvLocked(env)
}

func (w *Workspace) createEnvLocked(env Environment) (Environment, error) {
	dir, err := w.ensureEnvDirLocked()
	if err != nil {
		return Environment{}, err
	}
	env.Variables = normalizeVars(env.Variables)
	file := uniqueName(dir, slugify(env.Name, "environment"), ".yaml")
	if err := w.writeYAML(filepath.Join(dir, file), env); err != nil {
		return Environment{}, err
	}
	w.envs[env.ID] = &envEntry{meta: env, file: file}
	return copyEnv(env), nil
}

// RenameEnvironment changes an environment's name and renames its file to match.
func (w *Workspace) RenameEnvironment(id, name string) (Environment, error) {
	w.mu.Lock()
	defer w.mu.Unlock()
	e, ok := w.envs[id]
	if !ok {
		return Environment{}, fmt.Errorf("environment %s: %w", id, ErrNotFound)
	}
	env := copyEnv(e.meta)
	env.Name = cleanName(name, "New environment")
	if err := w.writeEnvLocked(e, env); err != nil {
		return Environment{}, err
	}
	return copyEnv(env), nil
}

// SaveEnvironmentVariables replaces an environment's variables. Secret
// values are never written; the returned environment has them cleared too.
func (w *Workspace) SaveEnvironmentVariables(id string, vars []model.Variable) (Environment, error) {
	w.mu.Lock()
	defer w.mu.Unlock()
	e, ok := w.envs[id]
	if !ok {
		return Environment{}, fmt.Errorf("environment %s: %w", id, ErrNotFound)
	}
	env := copyEnv(e.meta)
	env.Variables = normalizeVars(vars)
	if err := w.writeEnvLocked(e, env); err != nil {
		return Environment{}, err
	}
	return copyEnv(env), nil
}

// writeEnvLocked writes env to e's file, renaming the file if the name's slug changed.
func (w *Workspace) writeEnvLocked(e *envEntry, env Environment) error {
	dir, err := w.ensureEnvDirLocked()
	if err != nil {
		return err
	}
	file := e.file
	if slug := slugify(env.Name, "environment"); slug+".yaml" != file {
		file = uniqueName(dir, slug, ".yaml")
	}
	if err := w.writeYAML(filepath.Join(dir, file), env); err != nil {
		return err
	}
	if file != e.file {
		old := filepath.Join(dir, e.file)
		w.markWrite(old)
		if err := os.Remove(old); err != nil && !errors.Is(err, os.ErrNotExist) {
			return fmt.Errorf("remove old environment file: %w", err)
		}
	}
	e.meta, e.file = env, file
	return nil
}

// DeleteEnvironment removes an environment file.
func (w *Workspace) DeleteEnvironment(id string) error {
	w.mu.Lock()
	defer w.mu.Unlock()
	e, ok := w.envs[id]
	if !ok {
		return fmt.Errorf("environment %s: %w", id, ErrNotFound)
	}
	path := filepath.Join(w.root, EnvironmentsDir, e.file)
	w.markWrite(path)
	if err := os.Remove(path); err != nil && !errors.Is(err, os.ErrNotExist) {
		return fmt.Errorf("delete environment: %w", err)
	}
	delete(w.envs, id)
	return nil
}

// ReorderEnvironments sets Seq from the given order. Unknown ids are an
// error; environments not listed keep their relative order after the listed
// ones. Only files whose Seq changes are rewritten.
func (w *Workspace) ReorderEnvironments(ids []string) error {
	w.mu.Lock()
	defer w.mu.Unlock()
	listed := map[string]bool{}
	for _, id := range ids {
		if _, ok := w.envs[id]; !ok {
			return fmt.Errorf("environment %s: %w", id, ErrNotFound)
		}
		listed[id] = true
	}
	var rest []*envEntry
	for id, e := range w.envs {
		if !listed[id] {
			rest = append(rest, e)
		}
	}
	sort.Slice(rest, func(i, j int) bool {
		return lessSeq(rest[i].meta.Seq, rest[j].meta.Seq, rest[i].meta.Name, rest[j].meta.Name)
	})
	order := make([]*envEntry, 0, len(w.envs))
	for _, id := range ids {
		if listed[id] {
			order = append(order, w.envs[id])
			listed[id] = false // a repeated id keeps its first position
		}
	}
	order = append(order, rest...)
	for i, e := range order {
		if e.meta.Seq == i+1 {
			continue
		}
		env := copyEnv(e.meta)
		env.Seq = i + 1
		if err := w.writeEnvLocked(e, env); err != nil {
			return err
		}
	}
	return nil
}

// GetGlobals returns the global variables. Before _globals.yaml exists it
// returns an empty set with an ID that stays the same until SaveGlobals
// writes the file (nothing is written here).
func (w *Workspace) GetGlobals() Globals {
	w.mu.Lock()
	defer w.mu.Unlock()
	if w.globals != nil {
		return copyGlobals(*w.globals)
	}
	if w.pendingGlobalsID == "" {
		w.pendingGlobalsID = model.NewID()
	}
	return Globals{ID: w.pendingGlobalsID, Variables: []model.Variable{}}
}

// SaveGlobals replaces the global variables, creating _globals.yaml if needed.
func (w *Workspace) SaveGlobals(vars []model.Variable) (Globals, error) {
	w.mu.Lock()
	defer w.mu.Unlock()
	g := Globals{Variables: normalizeVars(vars)}
	switch {
	case w.globals != nil:
		g.ID = w.globals.ID
	case w.pendingGlobalsID != "":
		g.ID = w.pendingGlobalsID
	default:
		g.ID = model.NewID()
	}
	dir, err := w.ensureEnvDirLocked()
	if err != nil {
		return Globals{}, err
	}
	if err := w.writeYAML(filepath.Join(dir, GlobalsFile), g); err != nil {
		return Globals{}, err
	}
	w.globals = &g
	return copyGlobals(g), nil
}

// ensureEnvDirLocked upgrades the manifest to v2 and creates environments/
// (watched right away, like a new collection folder).
func (w *Workspace) ensureEnvDirLocked() (string, error) {
	if err := w.upgradeManifestLocked(); err != nil {
		return "", err
	}
	dir := filepath.Join(w.root, EnvironmentsDir)
	if info, err := os.Stat(dir); err == nil && info.IsDir() {
		return dir, nil
	}
	w.markWrite(dir)
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return "", fmt.Errorf("create environments folder: %w", err)
	}
	w.watchDir(dir)
	return dir, nil
}

func (w *Workspace) nextEnvSeq() int {
	maxSeq := 0
	for _, e := range w.envs {
		maxSeq = max(maxSeq, e.meta.Seq)
	}
	return maxSeq + 1
}

// normalizeVars trims keys and drops secret values, so memory matches disk.
func normalizeVars(in []model.Variable) []model.Variable {
	out := make([]model.Variable, len(in))
	for i, v := range in {
		v.Key = strings.TrimSpace(v.Key)
		if v.Secret {
			v.Value = ""
		}
		out[i] = v
	}
	return out
}

func nonNilVars(in []model.Variable) []model.Variable {
	if in == nil {
		return []model.Variable{}
	}
	return in
}

func copyEnv(e Environment) Environment {
	e.Variables = append([]model.Variable{}, e.Variables...)
	return e
}

func copyGlobals(g Globals) Globals {
	g.Variables = append([]model.Variable{}, g.Variables...)
	return g
}
