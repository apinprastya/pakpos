package service

import (
	"fmt"
	"io"
	"os"
	"path/filepath"

	"pakpos/internal/core/postman"
	"pakpos/internal/importer"
	"pakpos/internal/secrets"
)

// ImportOptions control an import from Postman.
type ImportOptions struct {
	// GuessSecrets keeps the values of variables whose names look like
	// credentials (token, password, apiKey...) in the secret store.
	GuessSecrets bool `json:"guessSecrets"`
}

// ImportService imports Postman exports (collections, environments and
// globals) into the open workspace.
type ImportService struct{ c *Core }

// NewImportService creates the service.
func NewImportService(c *Core) *ImportService { return &ImportService{c: c} }

// PickPostmanFile asks for an exported Postman file. It returns "" when
// the user cancels.
func (s *ImportService) PickPostmanFile() (string, error) {
	return s.c.dialogs.PickFile("Choose a Postman export (.json)")
}

// PreviewPostman reads a Postman export and says what importing it adds,
// with what won't work as it did in Postman. Nothing is written.
func (s *ImportService) PreviewPostman(path string, opts ImportOptions) (importer.Summary, error) {
	ws, err := s.c.workspace()
	if err != nil {
		return importer.Summary{}, err
	}
	f, err := readPostman(path, opts)
	if err != nil {
		return importer.Summary{}, err
	}
	return importer.Summarize(f, ws), nil
}

// ImportPostman imports a Postman export into the open workspace: a
// collection or an environment is added, globals are merged (imported
// values win). Secret values go to the secret store; a locked store
// refuses the import before anything is left behind.
func (s *ImportService) ImportPostman(path string, opts ImportOptions) (importer.Result, error) {
	_, sess, err := s.c.openSession()
	if err != nil {
		return importer.Result{}, err
	}
	f, err := readPostman(path, opts)
	if err != nil {
		return importer.Result{}, err
	}
	res, err := importer.Write(sess, f)
	if err != nil {
		return importer.Result{}, secrets.Explain(err)
	}
	return res, nil
}

func readPostman(path string, opts ImportOptions) (postman.File, error) {
	name := filepath.Base(path)
	fh, err := os.Open(path) //nolint:gosec // a file the user picked to import
	if err != nil {
		return postman.File{}, &userError{msg: fmt.Sprintf("Couldn't open %s. Check that the file still exists.", name), err: err}
	}
	defer func() { _ = fh.Close() }()
	data, err := io.ReadAll(io.LimitReader(fh, postman.MaxFileSize+1))
	if err != nil {
		return postman.File{}, &userError{msg: fmt.Sprintf("Couldn't read %s: %v", name, err), err: err}
	}
	f, err := postman.Parse(data, postman.Options{GuessSecrets: opts.GuessSecrets})
	if err != nil {
		return postman.File{}, &userError{msg: postman.Message(err), err: err}
	}
	return f, nil
}
