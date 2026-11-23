package service

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"pakpos/internal/core/model"
	"pakpos/internal/core/postman"
	"pakpos/internal/secrets"
	"pakpos/internal/store/fsstore"
)

func mustTree(t *testing.T, h *harness) fsstore.Tree {
	t.Helper()
	tree, err := h.ws.Tree()
	if err != nil {
		t.Fatal(err)
	}
	return tree
}

func writeFile(t *testing.T, name, content string) string {
	t.Helper()
	path := filepath.Join(t.TempDir(), name)
	if err := os.WriteFile(path, []byte(content), 0o600); err != nil {
		t.Fatal(err)
	}
	return path
}

// TestEndToEndImportPostman imports a collection and an environment exported
// from Postman and sends an imported request: the collection's bearer auth
// is inherited, {{vars}} resolve from the imported environment (a secret
// from the secret store) and the test script runs.
func TestEndToEndImportPostman(t *testing.T) {
	var gotAuth, gotPath, gotKey string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotAuth, gotPath, gotKey = r.Header.Get("Authorization"), r.URL.Path, r.URL.Query().Get("key")
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"id": 42}`))
	}))
	defer srv.Close()

	h := newHarness(t)
	h.openWorkspace(t)
	imp := NewImportService(h.core)

	col := writeFile(t, "shop.postman_collection.json", `{
		"info": {"name": "Shop", "schema": "https://schema.getpostman.com/json/collection/v2.1.0/collection.json"},
		"auth": {"type": "bearer", "bearer": [{"key": "token", "value": "{{token}}"}]},
		"variable": [{"key": "apiKey", "value": "k-123"}],
		"item": [{"name": "Orders", "item": [{
			"name": "Get order",
			"event": [{"listen": "test", "script": {"exec": ["pm.test('has id', () => pm.expect(pm.response.json().id).to.eql(42));"]}}],
			"request": {"method": "GET", "url": {"raw": "{{baseUrl}}/orders/:id?key={{apiKey}}", "query": [{"key": "key", "value": "{{apiKey}}"}], "variable": [{"key": "id", "value": "42"}]}}
		}]}]
	}`)
	env := writeFile(t, "dev.postman_environment.json", `{
		"name": "Dev", "_postman_variable_scope": "environment",
		"values": [{"key": "baseUrl", "value": "`+srv.URL+`", "enabled": true}, {"key": "token", "value": "tok-1", "type": "secret", "enabled": true}]
	}`)

	h.dialogs.file = col
	if p, err := imp.PickPostmanFile(); err != nil || p != col {
		t.Fatalf("PickPostmanFile = %q, %v", p, err)
	}
	opts := ImportOptions{GuessSecrets: true}
	prev, err := imp.PreviewPostman(col, opts)
	if err != nil || prev.Kind != postman.KindCollection || prev.Folders != 1 || prev.Requests != 1 || prev.Secrets != 1 || !prev.SecretValues {
		t.Fatalf("preview = %+v, %v", prev, err)
	}
	if len(mustTree(t, h).Collections) != 0 {
		t.Fatal("preview wrote to the workspace")
	}
	colRes, err := imp.ImportPostman(col, opts)
	if err != nil {
		t.Fatal(err)
	}
	envRes, err := imp.ImportPostman(env, opts)
	if err != nil || envRes.Kind != postman.KindEnvironment {
		t.Fatalf("env import = %+v, %v", envRes, err)
	}
	if err := h.env.Select(envRes.ID); err != nil {
		t.Fatal(err)
	}

	tree := mustTree(t, h)
	if len(tree.Collections) != 1 || tree.Collections[0].ID != colRes.ID {
		t.Fatalf("tree = %+v", tree)
	}
	folder := tree.Collections[0].Children[0]
	reqID := folder.Children[0].ID
	req, err := h.req.Get(reqID)
	if err != nil {
		t.Fatal(err)
	}
	res, err := h.req.Send(context.Background(), "imp", req, folder.ID)
	if err != nil {
		t.Fatal(err)
	}
	if res.Error != nil {
		t.Fatalf("send error: %+v", res.Error)
	}
	if gotAuth != "Bearer tok-1" || gotPath != "/orders/42" || gotKey != "k-123" {
		t.Errorf("server saw auth %q path %q key %q", gotAuth, gotPath, gotKey)
	}
	if len(res.Tests) != 1 || !res.Tests[0].Passed {
		t.Errorf("tests = %+v", res.Tests)
	}

	// Secret values never reach the workspace files.
	root := h.ws.Current().Path
	_ = filepath.WalkDir(root, func(path string, d os.DirEntry, err error) error {
		if err == nil && !d.IsDir() {
			b, _ := os.ReadFile(path)
			if strings.Contains(string(b), "tok-1") || strings.Contains(string(b), "k-123") {
				t.Errorf("%s holds a secret value", path)
			}
		}
		return nil
	})
}

func TestImportPostmanErrors(t *testing.T) {
	h := newHarness(t)
	imp := NewImportService(h.core)
	good := writeFile(t, "g.json", `{"values": [{"key": "a", "value": "1"}], "_postman_variable_scope": "globals"}`)

	if _, err := imp.PreviewPostman(good, ImportOptions{}); err == nil {
		t.Error("preview without a workspace: no error")
	}
	if _, err := imp.ImportPostman(good, ImportOptions{}); err == nil {
		t.Error("import without a workspace: no error")
	}
	h.openWorkspace(t)

	h.dialogs.err = errDialog
	if _, err := imp.PickPostmanFile(); !errors.Is(err, errDialog) {
		t.Errorf("pick err = %v", err)
	}

	tests := []struct {
		name, path, want string
	}{
		{"missing", filepath.Join(t.TempDir(), "gone.json"), "Couldn't open gone.json"},
		{"directory", t.TempDir(), "Couldn't read"},
		{"not json", writeFile(t, "x.json", "nope"), "isn't valid JSON"},
		{"v1", writeFile(t, "v1.json", `{"requests": [], "order": []}`), "v1 format"},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if _, err := imp.PreviewPostman(tt.path, ImportOptions{}); err == nil || !strings.Contains(err.Error(), tt.want) {
				t.Errorf("preview err = %v, want %q", err, tt.want)
			}
			if _, err := imp.ImportPostman(tt.path, ImportOptions{}); err == nil || !strings.Contains(err.Error(), tt.want) {
				t.Errorf("import err = %v, want %q", err, tt.want)
			}
		})
	}

	// A locked store refuses an import with secret values, explained.
	h.secrets.SetErr = secrets.ErrLocked
	secret := writeFile(t, "s.json", `{"name": "E", "values": [{"key": "password", "value": "p", "type": "secret"}]}`)
	if _, err := imp.ImportPostman(secret, ImportOptions{}); err == nil || err.Error() != secrets.MsgLocked {
		t.Errorf("locked err = %v", err)
	}
	h.secrets.SetErr = nil

	res, err := imp.ImportPostman(good, ImportOptions{})
	if err != nil || res.Kind != postman.KindGlobals || res.Variables != 1 {
		t.Errorf("globals import = %+v, %v", res, err)
	}
	g, _ := h.env.Globals()
	if len(g.Variables) != 1 || g.Variables[0] != (model.Variable{Key: "a", Value: "1", Enabled: true}) {
		t.Errorf("globals = %+v", g.Variables)
	}
	// The summary is plain JSON for the frontend.
	if b, _ := json.Marshal(res); !strings.Contains(string(b), `"replaced":[]`) || !strings.Contains(string(b), `"id":""`) {
		t.Errorf("json = %s", b)
	}
}
