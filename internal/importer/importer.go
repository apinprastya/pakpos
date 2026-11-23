// Package importer writes files converted from other tools (Postman) into
// an open workspace. Workspace writes go through fsstore and secrets
// through the pipeline session, so secret values reach the secret store
// (and its index), never a workspace file. It has no Wails code.
package importer

import (
	"fmt"
	"strings"

	"pakpos/internal/core/model"
	"pakpos/internal/core/postman"
	"pakpos/internal/core/vars"
	"pakpos/internal/pipeline"
	"pakpos/internal/store/fsstore"
)

// Summary says what an import adds. Slices are never nil.
type Summary struct {
	Kind postman.Kind `json:"kind"`
	Name string       `json:"name"`
	// Folders, Requests and Examples are counted for a collection.
	Folders  int `json:"folders"`
	Requests int `json:"requests"`
	Examples int `json:"examples"`
	// Variables counts the collection's, environment's or globals'
	// variables; Secrets those of them kept in the secret store.
	Variables int `json:"variables"`
	Secrets   int `json:"secrets"`
	// SecretValues is true when a secret has a value to store, so the
	// secret store must be unlocked to import.
	SecretValues bool `json:"secretValues"`
	// Replaced lists existing globals the import replaces (globals only).
	Replaced []string          `json:"replaced"`
	Warnings []postman.Warning `json:"warnings"`
}

// Result is a finished import: the summary and the new collection's or
// environment's id ("" for globals).
type Result struct {
	Summary
	ID string `json:"id"`
}

// Summarize counts what f adds to ws.
func Summarize(f postman.File, ws *fsstore.Workspace) Summary {
	s := Summary{Kind: f.Kind, Name: f.Name, Replaced: []string{}, Warnings: f.Warnings}
	if s.Warnings == nil {
		s.Warnings = []postman.Warning{}
	}
	vs := f.Variables
	if f.Collection != nil {
		vs = f.Collection.Variables
		count(&s, f.Collection.Items)
	}
	s.Variables = len(vs)
	for _, v := range vs {
		if v.Secret {
			s.Secrets++
			s.SecretValues = s.SecretValues || v.Value != ""
		}
	}
	if f.Kind == postman.KindGlobals && ws != nil {
		have := map[string]bool{}
		for _, v := range ws.GetGlobals().Variables {
			have[v.Key] = true
		}
		for _, v := range f.Variables {
			if have[v.Key] {
				s.Replaced = append(s.Replaced, v.Key)
			}
		}
	}
	return s
}

func count(s *Summary, items []postman.Item) {
	for _, it := range items {
		if it.Folder != nil {
			s.Folders++
			count(s, it.Folder.Items)
			continue
		}
		s.Requests++
		s.Examples += len(it.Request.Examples)
	}
}

// Write adds f to the session's workspace: a new collection, a new
// environment, or variables merged into the globals (imported values win).
// A failed collection or environment import is removed again, so nothing
// half-imported is left behind.
func Write(sess *pipeline.Session, f postman.File) (Result, error) {
	res := Result{Summary: Summarize(f, sess.Workspace())}
	var err error
	switch f.Kind {
	case postman.KindCollection:
		res.ID, err = writeCollection(sess, f)
	case postman.KindEnvironment:
		res.ID, err = writeEnvironment(sess, f)
	case postman.KindGlobals:
		err = writeGlobals(sess, f.Variables)
	default:
		err = fmt.Errorf("import: unknown kind %q", f.Kind)
	}
	if err != nil {
		return Result{}, err
	}
	return res, nil
}

func writeCollection(sess *pipeline.Session, f postman.File) (string, error) {
	ws := sess.Workspace()
	pc := f.Collection
	if pc == nil {
		return "", fmt.Errorf("import collection %q: no content", f.Name)
	}
	col, err := ws.CreateCollection(f.Name)
	if err != nil {
		return "", fmt.Errorf("create collection %q: %w", f.Name, err)
	}
	err = func() error {
		scripts := pc.Scripts
		if _, err := sess.SaveCollection(col.ID, fsstore.CollectionSettings{
			Auth: pc.Auth, Headers: []model.KeyValue{}, Variables: pc.Variables, Scripts: &scripts,
		}); err != nil {
			return fmt.Errorf("save collection %q: %w", f.Name, err)
		}
		if err := storeSecrets(sess, pipeline.ScopeRef{Kind: vars.ScopeCollection, ID: col.ID}, pc.Variables); err != nil {
			return err
		}
		return writeItems(ws, col.ID, pc.Items)
	}()
	if err != nil {
		if derr := sess.DeleteCollection(col.ID); derr != nil {
			return "", fmt.Errorf("%w (and removing the partial import failed: %v)", err, derr)
		}
		return "", err
	}
	return col.ID, nil
}

func writeItems(ws *fsstore.Workspace, parentID string, items []postman.Item) error {
	for _, it := range items {
		if f := it.Folder; f != nil {
			folder, err := ws.CreateFolder(parentID, f.Name)
			if err != nil {
				return fmt.Errorf("create folder %q: %w", f.Name, err)
			}
			if f.Auth.Type != model.AuthInherit || !f.Scripts.IsZero() {
				scripts := f.Scripts
				if _, err := ws.SaveFolder(folder.ID, fsstore.FolderSettings{Auth: f.Auth, Scripts: &scripts}); err != nil {
					return fmt.Errorf("save folder %q: %w", f.Name, err)
				}
			}
			if err := writeItems(ws, folder.ID, f.Items); err != nil {
				return err
			}
			continue
		}
		r := it.Request
		saved, err := ws.CreateRequest(parentID, r.Request)
		if err != nil {
			return fmt.Errorf("create request %q: %w", r.Request.Name, err)
		}
		for _, ex := range r.Examples {
			if _, err := ws.AddExample(saved.ID, example(ex)); err != nil {
				return fmt.Errorf("save example %q of %q: %w", ex.Name, saved.Name, err)
			}
		}
	}
	return nil
}

func example(ex postman.Example) fsstore.Example {
	return fsstore.Example{
		Name:    ex.Name,
		Request: ex.Request,
		Response: fsstore.ExampleResponse{
			StatusCode:  ex.StatusCode,
			StatusText:  ex.StatusText,
			Headers:     ex.Headers,
			ContentType: ex.ContentType,
			Kind:        ex.Kind,
			Body:        ex.Body,
			Encoding:    model.EncodingUTF8,
			Size:        int64(len(ex.Body)),
		},
	}
}

func writeEnvironment(sess *pipeline.Session, f postman.File) (string, error) {
	env, err := sess.Workspace().CreateEnvironment(f.Name)
	if err != nil {
		return "", fmt.Errorf("create environment %q: %w", f.Name, err)
	}
	ref := pipeline.ScopeRef{Kind: vars.ScopeEnvironment, ID: env.ID}
	err = func() error {
		if _, err := sess.SaveVariables(ref, f.Variables); err != nil {
			return fmt.Errorf("save environment %q: %w", f.Name, err)
		}
		return storeSecrets(sess, ref, f.Variables)
	}()
	if err != nil {
		if derr := sess.DeleteEnvironment(env.ID); derr != nil {
			return "", fmt.Errorf("%w (and removing the partial import failed: %v)", err, derr)
		}
		return "", err
	}
	return env.ID, nil
}

// writeGlobals merges vs into the globals: a variable with the same key is
// replaced in place, new ones are added at the end. Secret values are
// stored first, so a locked store changes nothing.
func writeGlobals(sess *pipeline.Session, vs []model.Variable) error {
	ref := pipeline.ScopeRef{Kind: vars.ScopeGlobal}
	if err := storeSecrets(sess, ref, vs); err != nil {
		return err
	}
	merged := append([]model.Variable{}, sess.Workspace().GetGlobals().Variables...)
	index := map[string]int{}
	for i, v := range merged {
		index[v.Key] = i
	}
	for _, v := range vs {
		if i, ok := index[v.Key]; ok {
			merged[i] = v
			continue
		}
		index[v.Key] = len(merged)
		merged = append(merged, v)
	}
	if _, err := sess.SaveVariables(ref, merged); err != nil {
		return fmt.Errorf("save globals: %w", err)
	}
	return nil
}

// storeSecrets writes the values of secret variables to the secret store.
func storeSecrets(sess *pipeline.Session, ref pipeline.ScopeRef, vs []model.Variable) error {
	for _, v := range vs {
		if !v.Secret || strings.TrimSpace(v.Value) == "" {
			continue
		}
		if err := sess.SetSecret(ref, v.Key, v.Value); err != nil {
			return fmt.Errorf("store secret %s: %w", v.Key, err)
		}
	}
	return nil
}
