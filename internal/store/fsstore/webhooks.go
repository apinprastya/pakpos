package fsstore

import (
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strings"

	"pakpos/internal/core/model"
	"pakpos/internal/core/webhook"
)

type hookEntry struct {
	meta webhook.Webhook
	file string // file name inside webhooks/
}

// loadWebhooks reads webhooks/. Called from Reload with w.mu held. A file
// that doesn't validate is listed in Problems and not loaded.
func (w *Workspace) loadWebhooks(addProblem func(string, string)) map[string]*hookEntry {
	hooks := map[string]*hookEntry{}
	dir := filepath.Join(w.root, WebhooksDir)
	files, err := os.ReadDir(dir)
	if err != nil {
		if _, statErr := os.Stat(dir); !errors.Is(statErr, os.ErrNotExist) {
			addProblem(dir, err.Error())
		}
		return hooks
	}
	for _, f := range files {
		name := f.Name()
		if f.IsDir() || !isYAML(name) || strings.HasPrefix(name, ".") || strings.HasPrefix(name, "_") {
			continue
		}
		p := filepath.Join(dir, name)
		var h webhook.Webhook
		if err := readYAML(p, &h); err != nil {
			addProblem(p, err.Error())
			continue
		}
		if h.ID == "" {
			addProblem(p, "missing id")
			continue
		}
		if _, dup := hooks[h.ID]; dup {
			addProblem(p, "duplicate webhook id "+h.ID)
			continue
		}
		if h.Name == "" {
			h.Name = strings.TrimSuffix(name, filepath.Ext(name))
		}
		h = h.Normalize()
		if err := h.Validate(); err != nil {
			addProblem(p, err.Error())
			continue
		}
		hooks[h.ID] = &hookEntry{meta: h, file: name}
	}
	return hooks
}

// ListWebhooks returns the webhooks ordered by Seq, then name.
func (w *Workspace) ListWebhooks() []webhook.Webhook {
	w.mu.Lock()
	defer w.mu.Unlock()
	out := make([]webhook.Webhook, 0, len(w.hooks))
	for _, h := range w.hooks {
		out = append(out, h.meta.Normalize())
	}
	sort.Slice(out, func(i, j int) bool { return lessSeq(out[i].Seq, out[j].Seq, out[i].Name, out[j].Name) })
	return out
}

// GetWebhook returns one webhook.
func (w *Workspace) GetWebhook(id string) (webhook.Webhook, error) {
	w.mu.Lock()
	defer w.mu.Unlock()
	h, ok := w.hooks[id]
	if !ok {
		return webhook.Webhook{}, fmt.Errorf("webhook %s: %w", id, ErrNotFound)
	}
	return h.meta.Normalize(), nil
}

// CreateWebhook adds a webhook with the default response and no rules.
func (w *Workspace) CreateWebhook(name string) (webhook.Webhook, error) {
	w.mu.Lock()
	defer w.mu.Unlock()
	h := webhook.New(cleanName(name, "New webhook"))
	h.Seq = w.nextHookSeq()
	return w.createHookLocked(h)
}

// DuplicateWebhook copies a webhook as "<name> copy" with new ids (its
// rules too), at the end of the list.
func (w *Workspace) DuplicateWebhook(id string) (webhook.Webhook, error) {
	w.mu.Lock()
	defer w.mu.Unlock()
	src, ok := w.hooks[id]
	if !ok {
		return webhook.Webhook{}, fmt.Errorf("webhook %s: %w", id, ErrNotFound)
	}
	h := src.meta.Normalize()
	h.ID = model.NewID()
	h.Name += " copy"
	h.Seq = w.nextHookSeq()
	for i := range h.Rules {
		h.Rules[i].ID = model.NewID()
	}
	return w.createHookLocked(h)
}

func (w *Workspace) createHookLocked(h webhook.Webhook) (webhook.Webhook, error) {
	h = h.Normalize()
	if err := h.Validate(); err != nil {
		return webhook.Webhook{}, err
	}
	dir, err := w.ensureHookDirLocked()
	if err != nil {
		return webhook.Webhook{}, err
	}
	file := uniqueName(dir, slugify(h.Name, "webhook"), ".yaml")
	if err := w.writeYAML(filepath.Join(dir, file), h); err != nil {
		return webhook.Webhook{}, err
	}
	w.hooks[h.ID] = &hookEntry{meta: h, file: file}
	return h.Normalize(), nil
}

// SaveWebhook replaces a webhook's name, rules and default response. Its Seq
// is kept; the file is renamed when the name's slug changes. It returns a
// *webhook.ValidationError for a webhook that doesn't validate.
func (w *Workspace) SaveWebhook(h webhook.Webhook) (webhook.Webhook, error) {
	w.mu.Lock()
	defer w.mu.Unlock()
	e, ok := w.hooks[h.ID]
	if !ok {
		return webhook.Webhook{}, fmt.Errorf("webhook %s: %w", h.ID, ErrNotFound)
	}
	h = h.Normalize()
	h.Seq = e.meta.Seq
	if err := h.Validate(); err != nil {
		return webhook.Webhook{}, err
	}
	if err := w.writeHookLocked(e, h); err != nil {
		return webhook.Webhook{}, err
	}
	return h.Normalize(), nil
}

// RenameWebhook changes a webhook's name and renames its file to match.
func (w *Workspace) RenameWebhook(id, name string) (webhook.Webhook, error) {
	w.mu.Lock()
	defer w.mu.Unlock()
	e, ok := w.hooks[id]
	if !ok {
		return webhook.Webhook{}, fmt.Errorf("webhook %s: %w", id, ErrNotFound)
	}
	h := e.meta.Normalize()
	h.Name = cleanName(name, "New webhook")
	if err := w.writeHookLocked(e, h); err != nil {
		return webhook.Webhook{}, err
	}
	return h.Normalize(), nil
}

// writeHookLocked writes h to e's file, renaming the file if the name's
// slug changed.
func (w *Workspace) writeHookLocked(e *hookEntry, h webhook.Webhook) error {
	dir, err := w.ensureHookDirLocked()
	if err != nil {
		return err
	}
	file := e.file
	if slug := slugify(h.Name, "webhook"); slug+".yaml" != file {
		file = uniqueName(dir, slug, ".yaml")
	}
	if err := w.writeYAML(filepath.Join(dir, file), h); err != nil {
		return err
	}
	if file != e.file {
		old := filepath.Join(dir, e.file)
		w.markWrite(old)
		if err := os.Remove(old); err != nil && !errors.Is(err, os.ErrNotExist) {
			return fmt.Errorf("remove old webhook file: %w", err)
		}
	}
	e.meta, e.file = h, file
	return nil
}

// DeleteWebhook removes a webhook file.
func (w *Workspace) DeleteWebhook(id string) error {
	w.mu.Lock()
	defer w.mu.Unlock()
	e, ok := w.hooks[id]
	if !ok {
		return fmt.Errorf("webhook %s: %w", id, ErrNotFound)
	}
	path := filepath.Join(w.root, WebhooksDir, e.file)
	w.markWrite(path)
	if err := os.Remove(path); err != nil && !errors.Is(err, os.ErrNotExist) {
		return fmt.Errorf("delete webhook: %w", err)
	}
	delete(w.hooks, id)
	return nil
}

// ensureHookDirLocked upgrades the manifest to FormatVersion (webhooks are
// a Tier 3 feature) and creates webhooks/, watched right away.
func (w *Workspace) ensureHookDirLocked() (string, error) {
	if err := w.upgradeManifestLocked(FormatVersion); err != nil {
		return "", err
	}
	dir := filepath.Join(w.root, WebhooksDir)
	if info, err := os.Stat(dir); err == nil && info.IsDir() {
		return dir, nil
	}
	w.markWrite(dir)
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return "", fmt.Errorf("create webhooks folder: %w", err)
	}
	w.watchDir(dir)
	return dir, nil
}

func (w *Workspace) nextHookSeq() int {
	maxSeq := 0
	for _, h := range w.hooks {
		maxSeq = max(maxSeq, h.meta.Seq)
	}
	return maxSeq + 1
}
