package service

import (
	"errors"
	"fmt"
	"os"
	"path/filepath"

	"pakpos/internal/core/postman"
	"pakpos/internal/exporter"
	"pakpos/internal/store/fsstore"
)

// ExportResult is a finished export. Path is "" when the user cancelled
// the save dialog (nothing was written).
type ExportResult struct {
	Path     string            `json:"path"`
	Name     string            `json:"name"`
	Warnings []postman.Warning `json:"warnings"`
}

// ExportService exports collections, environments and the globals of the
// open workspace as Postman files. Secret values are never exported.
type ExportService struct{ c *Core }

// NewExportService creates the service.
func NewExportService(c *Core) *ExportService { return &ExportService{c: c} }

// ExportCollection asks where to save and writes the collection as a
// Postman collection (v2.1).
func (s *ExportService) ExportCollection(id string) (ExportResult, error) {
	return s.export("Export collection to Postman", "collection", func() (exporter.Export, error) {
		ws, err := s.c.workspace()
		if err != nil {
			return exporter.Export{}, err
		}
		return exporter.Collection(ws, id)
	})
}

// ExportEnvironment asks where to save and writes the environment as a
// Postman environment.
func (s *ExportService) ExportEnvironment(id string) (ExportResult, error) {
	return s.export("Export environment to Postman", "environment", func() (exporter.Export, error) {
		ws, err := s.c.workspace()
		if err != nil {
			return exporter.Export{}, err
		}
		return exporter.Environment(ws, id)
	})
}

// ExportGlobals asks where to save and writes the globals as a Postman
// globals file.
func (s *ExportService) ExportGlobals() (ExportResult, error) {
	return s.export("Export globals to Postman", "globals", func() (exporter.Export, error) {
		ws, err := s.c.workspace()
		if err != nil {
			return exporter.Export{}, err
		}
		return exporter.Globals(ws)
	})
}

// export builds the file first, so a failure never leaves the user with a
// save dialog for nothing, then asks where to write it.
func (s *ExportService) export(title, noun string, build func() (exporter.Export, error)) (ExportResult, error) {
	exp, err := build()
	if errors.Is(err, fsstore.ErrNotFound) {
		return ExportResult{}, &userError{msg: fmt.Sprintf("This %s no longer exists. It may have been deleted outside Pakpos.", noun), err: err}
	}
	if err != nil {
		return ExportResult{}, err
	}
	dest, err := s.c.dialogs.SaveFile(title, exp.FileName)
	if err != nil || dest == "" {
		return ExportResult{}, err
	}
	if err := os.WriteFile(dest, exp.Data, 0o644); err != nil { //nolint:gosec // a file the user chose to save, readable like any document
		return ExportResult{}, &userError{msg: fmt.Sprintf("Couldn't write %s: %v", filepath.Base(dest), err), err: err}
	}
	return ExportResult{Path: dest, Name: exp.Name, Warnings: exp.Warnings}, nil
}
