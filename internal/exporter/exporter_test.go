package exporter

import (
	"errors"
	"strings"
	"testing"

	"pakpos/internal/core/model"
	"pakpos/internal/core/postman"
	"pakpos/internal/store/fsstore"
)

func newWorkspace(t *testing.T) *fsstore.Workspace {
	t.Helper()
	ws, err := fsstore.Create(t.TempDir(), "Test")
	if err != nil {
		t.Fatal(err)
	}
	return ws
}

func TestCollection(t *testing.T) {
	ws := newWorkspace(t)
	col, err := ws.CreateCollection("Shop / API")
	if err != nil {
		t.Fatal(err)
	}
	if _, err := ws.SaveCollection(col.ID, fsstore.CollectionSettings{
		Auth:    model.Auth{Type: model.AuthBearer, Token: "{{token}}"},
		Headers: []model.KeyValue{{Key: "X-Client", Value: "pakpos", Enabled: true}},
		Variables: []model.Variable{
			{Key: "baseUrl", Value: "https://api.example.com", Enabled: true},
			{Key: "token", Enabled: true, Secret: true},
		},
	}); err != nil {
		t.Fatal(err)
	}
	folder, err := ws.CreateFolder(col.ID, "Orders")
	if err != nil {
		t.Fatal(err)
	}
	scripts := model.Scripts{PreRequest: "pm.variables.set('a', 1);"}
	if _, err := ws.SaveFolder(folder.ID, fsstore.FolderSettings{Auth: model.Auth{Type: model.AuthInherit}, Scripts: &scripts}); err != nil {
		t.Fatal(err)
	}
	first, err := ws.CreateRequest(folder.ID, model.Request{Name: "List orders", Method: "GET", URL: "{{baseUrl}}/orders",
		Body: model.Body{Type: model.BodyNone}, Auth: model.Auth{Type: model.AuthInherit}})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := ws.CreateRequest(folder.ID, model.Request{Name: "Create order", Method: "POST", URL: "{{baseUrl}}/orders",
		Body: model.Body{Type: model.BodyRaw, Raw: `{"n":1}`, Language: model.LangJSON}, Auth: model.Auth{Type: model.AuthInherit}}); err != nil {
		t.Fatal(err)
	}
	if _, err := ws.CreateRequest(col.ID, model.Request{Name: "Health", Method: "GET", URL: "{{baseUrl}}/health",
		Body: model.Body{Type: model.BodyNone}, Auth: model.Auth{Type: model.AuthNone}}); err != nil {
		t.Fatal(err)
	}
	if _, err := ws.AddExample(first.ID, fsstore.Example{Name: "Two orders", Request: first, Response: fsstore.ExampleResponse{
		StatusCode: 200, StatusText: "OK", Kind: model.KindJSON, Body: `[1,2]`, Encoding: model.EncodingUTF8,
		Headers: []model.KeyValue{{Key: "Content-Type", Value: "application/json", Enabled: true}},
	}}); err != nil {
		t.Fatal(err)
	}

	exp, err := Collection(ws, col.ID)
	if err != nil {
		t.Fatal(err)
	}
	if exp.Name != "Shop / API" || exp.FileName != "Shop-API.postman_collection.json" {
		t.Errorf("name %q, file %q", exp.Name, exp.FileName)
	}
	back, err := postman.Parse(exp.Data, postman.Options{})
	if err != nil {
		t.Fatal(err)
	}
	c := back.Collection
	if c.Auth.Token != "{{token}}" || len(c.Variables) != 2 || c.Variables[1].Value != "" {
		t.Errorf("collection = %+v", c)
	}
	if len(c.Items) != 2 || c.Items[0].Folder == nil || c.Items[1].Request == nil || c.Items[1].Request.Request.Name != "Health" {
		t.Fatalf("items = %+v", c.Items)
	}
	orders := c.Items[0].Folder
	if orders.Name != "Orders" || orders.Scripts.PreRequest != scripts.PreRequest || len(orders.Items) != 2 {
		t.Fatalf("folder = %+v", orders)
	}
	list := orders.Items[0].Request
	if list.Request.Name != "List orders" || len(list.Examples) != 1 || list.Examples[0].Body != "[1,2]" {
		t.Errorf("list orders = %+v", list)
	}
	if h := list.Request.Headers; len(h) != 1 || h[0].Key != "X-Client" {
		t.Errorf("inherited headers = %+v", h)
	}
	for _, want := range []string{"copied into each request", "Secret values aren't exported: token."} {
		found := false
		for _, w := range exp.Warnings {
			found = found || strings.Contains(w.Message, want)
		}
		if !found {
			t.Errorf("missing warning %q in %+v", want, exp.Warnings)
		}
	}
}

func TestEnvironmentAndGlobals(t *testing.T) {
	ws := newWorkspace(t)
	env, err := ws.CreateEnvironment("Dev")
	if err != nil {
		t.Fatal(err)
	}
	if _, err := ws.SaveEnvironmentVariables(env.ID, []model.Variable{
		{Key: "host", Value: "dev.example.com", Enabled: true},
		{Key: "password", Value: "ignored", Enabled: true, Secret: true},
	}); err != nil {
		t.Fatal(err)
	}
	if _, err := ws.SaveGlobals([]model.Variable{{Key: "g", Value: "1", Enabled: true}}); err != nil {
		t.Fatal(err)
	}

	exp, err := Environment(ws, env.ID)
	if err != nil {
		t.Fatal(err)
	}
	if exp.FileName != "Dev.postman_environment.json" {
		t.Errorf("file = %q", exp.FileName)
	}
	back, err := postman.Parse(exp.Data, postman.Options{})
	if err != nil || back.Kind != postman.KindEnvironment || back.Name != "Dev" || len(back.Variables) != 2 ||
		!back.Variables[1].Secret || back.Variables[1].Value != "" {
		t.Errorf("environment = %+v, %v", back, err)
	}

	exp, err = Globals(ws)
	if err != nil {
		t.Fatal(err)
	}
	back, err = postman.Parse(exp.Data, postman.Options{})
	if err != nil || back.Kind != postman.KindGlobals || len(back.Variables) != 1 || exp.FileName != "workspace.postman_globals.json" {
		t.Errorf("globals = %+v, %q, %v", back, exp.FileName, err)
	}
}

func TestNotFound(t *testing.T) {
	ws := newWorkspace(t)
	if _, err := Collection(ws, "nope"); !errors.Is(err, fsstore.ErrNotFound) {
		t.Errorf("collection err = %v", err)
	}
	if _, err := Environment(ws, "nope"); !errors.Is(err, fsstore.ErrNotFound) {
		t.Errorf("environment err = %v", err)
	}
}

func TestFileName(t *testing.T) {
	for in, want := range map[string]string{
		"My API":         "My-API",
		` a/b\c:d*?"<>|`: "abcd",
		"...":            "collection",
		"":               "collection",
		"v1.2":           "v1.2",
		"tab\there":      "tabhere",
	} {
		if got := fileName(in, "collection"); got != want {
			t.Errorf("fileName(%q) = %q, want %q", in, got, want)
		}
	}
}
