package service

import (
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"pakpos/internal/core/model"
	"pakpos/internal/core/postman"
	"pakpos/internal/core/vars"
	"pakpos/internal/pipeline"
)

// TestEndToEndExportPostman exports a collection, an environment and the
// globals to Postman files, checks that no secret value is written, and
// imports the collection again.
func TestEndToEndExportPostman(t *testing.T) {
	h := newHarness(t)
	h.openWorkspace(t)
	exp := NewExportService(h.core)
	imp := NewImportService(h.core)

	col, err := h.ws.CreateCollection("Shop")
	if err != nil {
		t.Fatal(err)
	}
	colScope := pipeline.ScopeRef{Kind: vars.ScopeCollection, ID: col.ID}
	if _, err := h.env.SaveVariables(colScope, []model.Variable{
		{Key: "baseUrl", Value: "https://shop.example", Enabled: true},
		{Key: "apiKey", Enabled: true, Secret: true},
	}, nil); err != nil {
		t.Fatal(err)
	}
	if err := h.env.SetSecret(colScope, "apiKey", "col-secret-1"); err != nil {
		t.Fatal(err)
	}
	if _, err := h.req.SaveAs(col.ID, "List orders", model.Request{
		Method: "GET", URL: "{{baseUrl}}/orders", Body: model.Body{Type: model.BodyNone},
		Auth: model.Auth{Type: model.AuthAPIKey, APIKey: "X-Key", APIValue: "{{apiKey}}", APIIn: model.APIKeyInHeader},
	}); err != nil {
		t.Fatal(err)
	}
	env, err := h.env.Create("Dev")
	if err != nil {
		t.Fatal(err)
	}
	envScope := pipeline.ScopeRef{Kind: vars.ScopeEnvironment, ID: env.ID}
	if _, err := h.env.SaveVariables(envScope, []model.Variable{
		{Key: "user", Value: "ana", Enabled: true},
		{Key: "password", Enabled: true, Secret: true},
	}, nil); err != nil {
		t.Fatal(err)
	}
	if err := h.env.SetSecret(envScope, "password", "env-secret-2"); err != nil {
		t.Fatal(err)
	}
	if _, err := h.env.SaveGlobals([]model.Variable{{Key: "region", Value: "eu", Enabled: true}}, nil); err != nil {
		t.Fatal(err)
	}

	dir := t.TempDir()
	cases := []struct {
		name, file, defaultName string
		run                     func() (ExportResult, error)
	}{
		{"collection", "shop.json", "Shop.postman_collection.json", func() (ExportResult, error) { return exp.ExportCollection(col.ID) }},
		{"environment", "dev.json", "Dev.postman_environment.json", func() (ExportResult, error) { return exp.ExportEnvironment(env.ID) }},
		{"globals", "globals.json", "workspace.postman_globals.json", exp.ExportGlobals},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			h.dialogs.save = filepath.Join(dir, c.file)
			res, err := c.run()
			if err != nil {
				t.Fatal(err)
			}
			if res.Path != h.dialogs.save || h.dialogs.lastDefaultName != c.defaultName || res.Warnings == nil {
				t.Errorf("result = %+v, default name %q", res, h.dialogs.lastDefaultName)
			}
			b, err := os.ReadFile(res.Path)
			if err != nil {
				t.Fatal(err)
			}
			for _, secret := range []string{"col-secret-1", "env-secret-2"} {
				if strings.Contains(string(b), secret) {
					t.Errorf("%s holds the secret value %q", c.file, secret)
				}
			}
		})
	}

	// The exported collection imports again as a copy.
	res, err := imp.ImportPostman(filepath.Join(dir, "shop.json"), ImportOptions{})
	if err != nil || res.Kind != postman.KindCollection || res.Name != "Shop" || res.Requests != 1 || res.Secrets != 0 {
		t.Fatalf("re-import = %+v, %v", res, err)
	}
	env2, err := imp.ImportPostman(filepath.Join(dir, "dev.json"), ImportOptions{})
	if err != nil || env2.Kind != postman.KindEnvironment || env2.Secrets != 1 || env2.SecretValues {
		t.Fatalf("env re-import = %+v, %v", env2, err)
	}
}

func TestExportPostmanErrors(t *testing.T) {
	h := newHarness(t)
	exp := NewExportService(h.core)
	if _, err := exp.ExportGlobals(); err == nil {
		t.Error("export without a workspace: no error")
	}
	if _, err := exp.ExportCollection("x"); err == nil {
		t.Error("collection export without a workspace: no error")
	}
	if _, err := exp.ExportEnvironment("x"); err == nil {
		t.Error("environment export without a workspace: no error")
	}
	h.openWorkspace(t)

	for name, run := range map[string]func() (ExportResult, error){
		"collection":  func() (ExportResult, error) { return exp.ExportCollection("gone") },
		"environment": func() (ExportResult, error) { return exp.ExportEnvironment("gone") },
	} {
		if _, err := run(); err == nil || err.Error() != "This "+name+" no longer exists. It may have been deleted outside Pakpos." {
			t.Errorf("%s err = %v", name, err)
		}
	}

	// Cancelling the dialog writes nothing.
	h.dialogs.save = ""
	if res, err := exp.ExportGlobals(); err != nil || res.Path != "" {
		t.Errorf("cancel = %+v, %v", res, err)
	}
	h.dialogs.err = errDialog
	if _, err := exp.ExportGlobals(); !errors.Is(err, errDialog) {
		t.Errorf("dialog err = %v", err)
	}
	h.dialogs.err = nil

	// A destination that can't be written is explained.
	h.dialogs.save = t.TempDir()
	if _, err := exp.ExportGlobals(); err == nil || !strings.HasPrefix(err.Error(), "Couldn't write ") {
		t.Errorf("write err = %v", err)
	}
}
