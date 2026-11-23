package importer

import (
	"errors"
	"io/fs"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"pakpos/internal/core/model"
	"pakpos/internal/core/postman"
	"pakpos/internal/pipeline"
	"pakpos/internal/secrets"
	"pakpos/internal/store/fsstore"
)

func setup(t *testing.T) (*fsstore.Workspace, *secrets.Fake, *pipeline.Session) {
	t.Helper()
	ws, err := fsstore.Create(t.TempDir(), "Test")
	if err != nil {
		t.Fatal(err)
	}
	sec := secrets.NewFake()
	return ws, sec, pipeline.New(ws, sec, nil)
}

func parse(t *testing.T, name string, opts postman.Options) postman.File {
	t.Helper()
	b, err := os.ReadFile(filepath.Join("..", "core", "postman", "testdata", name))
	if err != nil {
		t.Fatal(err)
	}
	f, err := postman.Parse(b, opts)
	if err != nil {
		t.Fatal(err)
	}
	return f
}

// assertNotOnDisk fails when any workspace file contains value.
func assertNotOnDisk(t *testing.T, root, value string) {
	t.Helper()
	_ = filepath.WalkDir(root, func(path string, d fs.DirEntry, err error) error {
		if err != nil || d.IsDir() {
			return err
		}
		b, _ := os.ReadFile(path)
		if strings.Contains(string(b), value) {
			t.Errorf("%s contains %q", path, value)
		}
		return nil
	})
}

func TestWriteCollection(t *testing.T) {
	ws, sec, sess := setup(t)
	f := parse(t, "collection-v21.json", postman.Options{GuessSecrets: true})
	res, err := Write(sess, f)
	if err != nil {
		t.Fatal(err)
	}
	if res.ID == "" || res.Kind != postman.KindCollection || res.Name != "Shop API" {
		t.Fatalf("result = %+v", res)
	}
	if res.Folders != 2 || res.Requests != 10 || res.Examples != 2 || res.Variables != 5 || res.Secrets != 2 || !res.SecretValues {
		t.Errorf("summary = %+v", res.Summary)
	}

	col, err := ws.GetCollection(res.ID)
	if err != nil {
		t.Fatal(err)
	}
	if col.Auth.Type != model.AuthBearer || col.Scripts.PreRequest == "" || len(col.Variables) != 5 {
		t.Errorf("collection = %+v", col)
	}
	for _, key := range []string{"apiKey", "vaulted"} {
		v, err := sec.Get(secrets.Key(ws.Manifest().ID, res.ID, key))
		if err != nil || v == "" {
			t.Errorf("secret %s = %q, %v", key, v, err)
		}
	}
	assertNotOnDisk(t, ws.Root(), "s3cret")
	assertNotOnDisk(t, ws.Root(), "abc123")

	tree := ws.Tree()
	if len(tree.Problems) != 0 {
		t.Errorf("problems = %+v", tree.Problems)
	}
	root := tree.Collections[0]
	names := []string{}
	for _, n := range root.Children {
		names = append(names, n.Name)
	}
	want := "Orders,Create order,Upload,Login,Form,Binary,Graph,Disabled body,Just a URL,Empty folder"
	if strings.Join(names, ",") != want {
		t.Errorf("order = %v", names)
	}
	orders := root.Children[0]
	folder, err := ws.GetFolder(orders.ID)
	if err != nil || folder.Auth.Type != model.AuthNone || !strings.Contains(folder.Scripts.PreRequest, "CryptoJS") {
		t.Errorf("folder = %+v %v", folder, err)
	}
	empty, err := ws.GetFolder(root.Children[len(root.Children)-1].ID)
	if err != nil || (empty.Auth.Type != "" && empty.Auth.Type != model.AuthInherit) {
		t.Errorf("empty folder = %+v %v", empty, err)
	}

	list := orders.Children[0]
	req, err := ws.GetRequest(list.ID)
	if err != nil {
		t.Fatal(err)
	}
	if req.URL != "{{baseUrl}}/orders?page=1&q=a%20b" || len(req.Query) != 3 || req.Settings.MaxRedirects == nil {
		t.Errorf("request = %+v", req)
	}
	exs, err := ws.ListExamples(list.ID)
	if err != nil || len(exs) != 2 || exs[0].Name != "Two orders" || exs[1].StatusCode != 404 {
		t.Errorf("examples = %+v %v", exs, err)
	}
	ex, err := ws.GetExample(list.ID, exs[0].ID)
	if err != nil || ex.Response.Body != `[{"id":1},{"id":2}]` || ex.Response.Encoding != model.EncodingUTF8 || ex.Response.Size != 19 {
		t.Errorf("example = %+v %v", ex, err)
	}
	if ws.Manifest().Version != fsstore.FormatVersion {
		t.Errorf("manifest version = %d", ws.Manifest().Version)
	}
}

func TestWriteCollectionRollsBack(t *testing.T) {
	ws, sec, sess := setup(t)
	sec.SetErr = secrets.ErrLocked
	f := parse(t, "collection-v21.json", postman.Options{})
	_, err := Write(sess, f)
	if !errors.Is(err, secrets.ErrLocked) {
		t.Fatalf("err = %v", err)
	}
	if n := len(ws.Tree().Collections); n != 0 {
		t.Errorf("collections left = %d", n)
	}
	entries, _ := os.ReadDir(filepath.Join(ws.Root(), fsstore.CollectionsDir))
	if len(entries) != 0 {
		t.Errorf("files left: %v", entries)
	}
}

func TestWriteCollectionSecretFailure(t *testing.T) {
	ws, sec, sess := setup(t)
	f := postman.File{Kind: postman.KindCollection, Name: "C", Collection: &postman.Collection{
		Auth:      model.Auth{Type: model.AuthNone},
		Variables: []model.Variable{{Key: "k", Value: "v", Enabled: true, Secret: true}},
	}}
	sec.SetErr = errors.New("disk full")
	_, err := Write(sess, f)
	if err == nil || !strings.Contains(err.Error(), "disk full") {
		t.Fatalf("err = %v", err)
	}
	if len(ws.Tree().Collections) != 0 {
		t.Errorf("collection left behind")
	}
}

func TestWriteItemsErrors(t *testing.T) {
	ws, _, _ := setup(t)
	items := []postman.Item{{Folder: &postman.Folder{Name: "F", Auth: model.Auth{Type: model.AuthInherit}}}}
	if err := writeItems(ws, "missing", items); err == nil || !strings.Contains(err.Error(), `create folder "F"`) {
		t.Errorf("folder err = %v", err)
	}
	items = []postman.Item{{Request: &postman.Request{Request: model.Request{Name: "R"}}}}
	if err := writeItems(ws, "missing", items); err == nil || !strings.Contains(err.Error(), `create request "R"`) {
		t.Errorf("request err = %v", err)
	}
	col, _ := ws.CreateCollection("C")
	big := strings.Repeat("a", fsstore.MaxExampleBody+1)
	items = []postman.Item{{Request: &postman.Request{Request: model.Request{Name: "R"}, Examples: []postman.Example{{Name: "E", Body: big}}}}}
	if err := writeItems(ws, col.ID, items); !errors.Is(err, fsstore.ErrExampleTooLarge) {
		t.Errorf("example err = %v", err)
	}
	items = []postman.Item{{Folder: &postman.Folder{Name: "F", Auth: model.Auth{Type: model.AuthInherit}, Items: []postman.Item{
		{Request: &postman.Request{Request: model.Request{Name: "Inner"}}},
	}}}}
	if err := writeItems(ws, col.ID, items); err != nil {
		t.Errorf("nested err = %v", err)
	}
}

func TestWriteEnvironment(t *testing.T) {
	ws, sec, sess := setup(t)
	f := parse(t, "environment.json", postman.Options{})
	res, err := Write(sess, f)
	if err != nil {
		t.Fatal(err)
	}
	env, err := ws.GetEnvironment(res.ID)
	if err != nil || env.Name != "Staging" || len(env.Variables) != 4 || !env.Variables[1].Secret || env.Variables[1].Value != "" {
		t.Fatalf("env = %+v %v", env, err)
	}
	if v, _ := sec.Get(secrets.Key(ws.Manifest().ID, env.ID, "password")); v != "pa55" {
		t.Errorf("stored secret = %q", v)
	}
	assertNotOnDisk(t, ws.Root(), "pa55")
	if res.Variables != 4 || res.Secrets != 1 {
		t.Errorf("summary = %+v", res.Summary)
	}

	sec.SetErr = secrets.ErrLocked
	if _, err := Write(sess, f); !errors.Is(err, secrets.ErrLocked) {
		t.Fatalf("locked err = %v", err)
	}
	if n := len(ws.ListEnvironments()); n != 1 {
		t.Errorf("environments after failed import = %d", n)
	}
}

func TestWriteGlobals(t *testing.T) {
	ws, sec, sess := setup(t)
	if _, err := ws.SaveGlobals([]model.Variable{{Key: "keep", Value: "1", Enabled: true}, {Key: "host", Value: "old", Enabled: true}}); err != nil {
		t.Fatal(err)
	}
	f := parse(t, "globals.json", postman.Options{})
	if s := Summarize(f, ws); len(s.Replaced) != 1 || s.Replaced[0] != "host" || !s.SecretValues {
		t.Errorf("summary = %+v", s)
	}

	sec.SetErr = secrets.ErrLocked
	if _, err := Write(sess, f); !errors.Is(err, secrets.ErrLocked) {
		t.Fatalf("locked err = %v", err)
	}
	if g := ws.GetGlobals(); len(g.Variables) != 2 || g.Variables[1].Value != "old" {
		t.Errorf("globals changed by a failed import: %+v", g.Variables)
	}

	sec.SetErr = nil
	res, err := Write(sess, f)
	if err != nil || res.ID != "" {
		t.Fatalf("res = %+v, err = %v", res, err)
	}
	g := ws.GetGlobals()
	got := []string{}
	for _, v := range g.Variables {
		got = append(got, v.Key+"="+v.Value)
	}
	if strings.Join(got, ",") != "keep=1,host=example.com,secretThing=" {
		t.Errorf("globals = %v", got)
	}
	if v, _ := sec.Get(secrets.Key(ws.Manifest().ID, g.ID, "secretThing")); v != "v" {
		t.Errorf("secret global = %q", v)
	}
}

func TestWriteErrors(t *testing.T) {
	_, _, sess := setup(t)
	if _, err := Write(sess, postman.File{Kind: "other"}); err == nil {
		t.Error("unknown kind: no error")
	}
	if _, err := Write(sess, postman.File{Kind: postman.KindCollection, Name: "X"}); err == nil {
		t.Error("collection without content: no error")
	}
	s := Summarize(postman.File{Kind: postman.KindEnvironment}, nil)
	if s.Warnings == nil || s.Replaced == nil {
		t.Errorf("nil slices: %+v", s)
	}
}
