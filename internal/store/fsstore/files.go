package fsstore

import (
	"bytes"
	"fmt"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"time"
	"unicode"

	"gopkg.in/yaml.v3"
)

const tempPrefix = ".tmp-"

// marshalYAML encodes v with 2-space indentation. yaml.v3 panics on values it
// cannot encode; that is turned into an error.
func marshalYAML(v any) (out []byte, err error) {
	defer func() {
		if r := recover(); r != nil {
			out, err = nil, fmt.Errorf("encode YAML: %v", r)
		}
	}()
	var buf bytes.Buffer
	enc := yaml.NewEncoder(&buf)
	enc.SetIndent(2)
	if err := enc.Encode(v); err != nil {
		return nil, fmt.Errorf("encode YAML: %w", err)
	}
	if err := enc.Close(); err != nil {
		return nil, fmt.Errorf("encode YAML: %w", err)
	}
	return buf.Bytes(), nil
}

// writeFileAtomic writes data to a temp file in the same directory, syncs it
// and renames it over path, so readers never see a half-written file.
func writeFileAtomic(path string, data []byte) (err error) {
	dir := filepath.Dir(path)
	f, err := os.CreateTemp(dir, tempPrefix+"*")
	if err != nil {
		return fmt.Errorf("write %s: %w", filepath.Base(path), err)
	}
	tmp := f.Name()
	defer func() {
		if err != nil {
			_ = f.Close()
			_ = os.Remove(tmp)
		}
	}()
	if _, err = f.Write(data); err != nil {
		return fmt.Errorf("write %s: %w", filepath.Base(path), err)
	}
	if err = f.Sync(); err != nil {
		return fmt.Errorf("sync %s: %w", filepath.Base(path), err)
	}
	if err = f.Close(); err != nil {
		return fmt.Errorf("close %s: %w", filepath.Base(path), err)
	}
	// Workspace files are meant to be shared via git, so they're world-readable like any source file.
	if err = os.Chmod(tmp, 0o644); err != nil { //nolint:gosec // see above
		return fmt.Errorf("chmod %s: %w", filepath.Base(path), err)
	}
	if err = os.Rename(tmp, path); err != nil {
		return fmt.Errorf("save %s: %w", filepath.Base(path), err)
	}
	return nil
}

const maxSlugLen = 60

// slugify turns a display name into a portable file name stem:
// lower-case letters/digits separated by single dashes.
func slugify(name, fallback string) string {
	var b strings.Builder
	dash := false
	for _, r := range strings.ToLower(name) {
		if r < unicode.MaxASCII && (unicode.IsLetter(r) || unicode.IsDigit(r)) {
			b.WriteRune(r)
			dash = false
			continue
		}
		if !dash && b.Len() > 0 {
			b.WriteByte('-')
			dash = true
		}
	}
	s := strings.Trim(b.String(), "-")
	if len(s) > maxSlugLen {
		s = strings.Trim(s[:maxSlugLen], "-")
	}
	if s == "" {
		return fallback
	}
	return s
}

// uniqueName returns stem+ext, or stem-2+ext, stem-3+ext… so that no entry in
// dir has that name, compared case-insensitively (macOS/Windows file systems).
func uniqueName(dir, stem, ext string) string {
	taken := map[string]bool{}
	if entries, err := os.ReadDir(dir); err == nil {
		for _, e := range entries {
			taken[strings.ToLower(e.Name())] = true
		}
	}
	name := stem + ext
	for i := 2; taken[strings.ToLower(name)]; i++ {
		name = stem + "-" + strconv.Itoa(i) + ext
	}
	return name
}

// selfWriteWindow is how long after our own write a watcher event for the
// same path is ignored.
const selfWriteWindow = 2 * time.Second

func (w *Workspace) markWrite(path string) {
	w.writesMu.Lock()
	defer w.writesMu.Unlock()
	now := time.Now()
	w.writes[path] = now
	for p, t := range w.writes {
		if now.Sub(t) > selfWriteWindow {
			delete(w.writes, p)
		}
	}
}

// isOwnWrite reports whether path was written by this process within the
// self-write window.
func (w *Workspace) isOwnWrite(path string) bool {
	w.writesMu.Lock()
	defer w.writesMu.Unlock()
	t, ok := w.writes[path]
	return ok && time.Since(t) <= selfWriteWindow
}
