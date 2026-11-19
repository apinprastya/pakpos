package fsstore

import (
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"pakpos/internal/core/model"
)

func newWS(t *testing.T) *Workspace {
	t.Helper()
	ws, err := Create(t.TempDir(), "Demo")
	if err != nil {
		t.Fatal(err)
	}
	return ws
}

func mustCol(t *testing.T, ws *Workspace, name string) Collection {
	t.Helper()
	c, err := ws.CreateCollection(name)
	if err != nil {
		t.Fatal(err)
	}
	return c
}

func mustReq(t *testing.T, ws *Workspace, colID string, r model.Request) model.Request {
	t.Helper()
	out, err := ws.CreateRequest(colID, r)
	if err != nil {
		t.Fatal(err)
	}
	return out
}

func exists(p string) bool { _, err := os.Stat(p); return err == nil }

func TestCreateAndOpen(t *testing.T) {
	dir := filepath.Join(t.TempDir(), "new", "ws")
	ws, err := Create(dir, "  ")
	if err != nil {
		t.Fatal(err)
	}
	m := ws.Manifest()
	if m.Name != "ws" || m.ID == "" || m.Version != FormatVersion || ws.Root() != dir {
		t.Fatalf("manifest = %+v root=%s", m, ws.Root())
	}
	gi, _ := os.ReadFile(filepath.Join(dir, ".gitignore"))
	if string(gi) != ".pakpos/\n" {
		t.Fatalf(".gitignore = %q", gi)
	}
	if _, err := Create(dir, "again"); !errors.Is(err, ErrAlreadyExists) {
		t.Fatalf("Create twice err = %v", err)
	}

	opened, err := Open(dir)
	if err != nil {
		t.Fatal(err)
	}
	if opened.Manifest() != m {
		t.Fatalf("Open manifest = %+v want %+v", opened.Manifest(), m)
	}
}

func TestCreateKeepsExistingGitignore(t *testing.T) {
	for name, tc := range map[string]struct{ in, want string }{
		"appends with newline": {"node_modules", "node_modules\n.pakpos/\n"},
		"already present":      {"/.pakpos/\n", "/.pakpos/\n"},
	} {
		t.Run(name, func(t *testing.T) {
			dir := t.TempDir()
			_ = os.WriteFile(filepath.Join(dir, ".gitignore"), []byte(tc.in), 0o644)
			if _, err := Create(dir, "x"); err != nil {
				t.Fatal(err)
			}
			got, _ := os.ReadFile(filepath.Join(dir, ".gitignore"))
			if string(got) != tc.want {
				t.Fatalf("got %q want %q", got, tc.want)
			}
		})
	}
}

func TestOpenErrors(t *testing.T) {
	cases := map[string]struct {
		manifest string
		want     error
	}{
		"missing":   {"", ErrNotWorkspace},
		"invalid":   {"id: [", ErrNotWorkspace},
		"no id":     {"name: x\n", ErrNotWorkspace},
		"too new":   {"id: A\nversion: 99\n", ErrUnsupported},
		"one newer": {fmt.Sprintf("id: A\nversion: %d\n", FormatVersion+1), ErrUnsupported},
	}
	for name, tc := range cases {
		t.Run(name, func(t *testing.T) {
			dir := t.TempDir()
			if tc.manifest != "" {
				_ = os.WriteFile(filepath.Join(dir, ManifestFile), []byte(tc.manifest), 0o644)
			}
			if _, err := Open(dir); !errors.Is(err, tc.want) {
				t.Fatalf("err = %v, want %v", err, tc.want)
			}
		})
	}

	t.Run("newer version message", func(t *testing.T) {
		dir := t.TempDir()
		_ = os.WriteFile(filepath.Join(dir, ManifestFile), []byte("id: A\nversion: 99\n"), 0o644)
		_, err := Open(dir)
		// The frontend offers "Create workspace here" for ErrNotWorkspace, so
		// a newer workspace must never read like one.
		if err == nil || errors.Is(err, ErrNotWorkspace) || strings.Contains(err.Error(), ErrNotWorkspace.Error()) ||
			!strings.Contains(err.Error(), "newer version") {
			t.Fatalf("err = %v", err)
		}
	})

	t.Run("name defaults to folder", func(t *testing.T) {
		dir := filepath.Join(t.TempDir(), "folder")
		_ = os.Mkdir(dir, 0o755)
		_ = os.WriteFile(filepath.Join(dir, ManifestFile), []byte("id: A\nversion: 1\n"), 0o644)
		ws, err := Open(dir)
		if err != nil || ws.Manifest().Name != "folder" {
			t.Fatalf("ws=%v err=%v", ws, err)
		}
	})

	t.Run("unreadable manifest", func(t *testing.T) {
		dir := t.TempDir()
		_ = os.Mkdir(filepath.Join(dir, ManifestFile), 0o755) // a dir, not a file
		if _, err := Open(dir); err == nil || errors.Is(err, ErrNotWorkspace) {
			t.Fatalf("err = %v", err)
		}
	})
}

func TestManifestVersions(t *testing.T) {
	read := func(dir string) string {
		data, err := os.ReadFile(filepath.Join(dir, ManifestFile))
		if err != nil {
			t.Fatal(err)
		}
		return string(data)
	}
	open := func(t *testing.T, version int) (*Workspace, string) {
		t.Helper()
		dir := t.TempDir()
		manifest := fmt.Sprintf("id: WS\nname: W\nversion: %d\n", version)
		if err := os.WriteFile(filepath.Join(dir, ManifestFile), []byte(manifest), 0o644); err != nil {
			t.Fatal(err)
		}
		ws, err := Open(dir)
		if err != nil {
			t.Fatal(err)
		}
		return ws, dir
	}

	for _, v := range []int{1, VersionV2, FormatVersion} {
		t.Run(fmt.Sprintf("v%d opens unchanged", v), func(t *testing.T) {
			ws, dir := open(t, v)
			before := read(dir)
			ws.Reload()
			if ws.Manifest().Version != v || read(dir) != before {
				t.Fatalf("version = %d, manifest %q", ws.Manifest().Version, read(dir))
			}
		})
	}

	t.Run("a v2 write leaves v2 alone", func(t *testing.T) {
		ws, dir := open(t, VersionV2)
		if _, err := ws.CreateEnvironment("Dev"); err != nil {
			t.Fatal(err)
		}
		if ws.Manifest().Version != VersionV2 || !strings.Contains(read(dir), "version: 2") {
			t.Fatalf("manifest %q", read(dir))
		}
	})

	t.Run("a v2 write never downgrades v3", func(t *testing.T) {
		ws, dir := open(t, FormatVersion)
		if _, err := ws.CreateEnvironment("Dev"); err != nil {
			t.Fatal(err)
		}
		if ws.Manifest().Version != FormatVersion || !strings.Contains(read(dir), fmt.Sprintf("version: %d", FormatVersion)) {
			t.Fatalf("manifest %q", read(dir))
		}
	})

	for _, v := range []int{1, VersionV2} {
		t.Run(fmt.Sprintf("a v3 write upgrades v%d", v), func(t *testing.T) {
			ws, dir := open(t, v)
			ws.mu.Lock()
			err := ws.upgradeManifestLocked(FormatVersion)
			ws.mu.Unlock()
			if err != nil {
				t.Fatal(err)
			}
			reopened, err := Open(dir)
			if err != nil || reopened.Manifest() != (Manifest{ID: "WS", Name: "W", Version: FormatVersion}) {
				t.Fatalf("reopened %+v, err %v", reopened, err)
			}
		})
	}

	t.Run("a request without settings keeps v2", func(t *testing.T) {
		ws, dir := open(t, VersionV2)
		col := mustCol(t, ws, "API")
		r, err := ws.CreateRequest(col.ID, model.Request{Name: "Plain", Method: "GET"})
		if err != nil {
			t.Fatal(err)
		}
		if _, err := ws.SaveRequest(r); err != nil {
			t.Fatal(err)
		}
		if ws.Manifest().Version != VersionV2 || !strings.Contains(read(dir), "version: 2") {
			t.Fatalf("manifest %q", read(dir))
		}
	})

	verify := false
	for _, tc := range []struct {
		name  string
		write func(ws *Workspace, colID string) error
	}{
		{"create", func(ws *Workspace, colID string) error {
			_, err := ws.CreateRequest(colID, model.Request{Name: "R", Settings: model.RequestSettings{VerifyTLS: &verify}})
			return err
		}},
		{"save", func(ws *Workspace, colID string) error {
			r, err := ws.CreateRequest(colID, model.Request{Name: "R"})
			if err != nil {
				return err
			}
			r.Settings.VerifyTLS = &verify
			_, err = ws.SaveRequest(r)
			return err
		}},
		{"oauth2 request", func(ws *Workspace, colID string) error {
			_, err := ws.CreateRequest(colID, model.Request{Name: "R", Auth: model.Auth{Type: model.AuthOAuth2}})
			return err
		}},
		{"oauth2 collection", func(ws *Workspace, colID string) error {
			_, err := ws.SaveCollection(colID, CollectionSettings{Auth: model.Auth{Type: model.AuthOAuth2, OAuth2: &model.OAuth2{}}})
			return err
		}},
		{"oauth2 folder", func(ws *Workspace, colID string) error {
			f, err := ws.CreateFolder(colID, "F")
			if err != nil {
				return err
			}
			_, err = ws.SaveFolder(f.ID, FolderSettings{Auth: model.Auth{Type: model.AuthOAuth2}})
			return err
		}},
	} {
		t.Run("request settings upgrade v1 on "+tc.name, func(t *testing.T) {
			ws, dir := open(t, 1)
			col := mustCol(t, ws, "API")
			if err := tc.write(ws, col.ID); err != nil {
				t.Fatal(err)
			}
			if ws.Manifest().Version != FormatVersion || !strings.Contains(read(dir), fmt.Sprintf("version: %d", FormatVersion)) {
				t.Fatalf("manifest %q", read(dir))
			}
		})
	}
}

func TestCollectionsCRUD(t *testing.T) {
	ws := newWS(t)
	a := mustCol(t, ws, "Users API")
	b := mustCol(t, ws, "")
	c := mustCol(t, ws, "Users API") // same slug -> suffixed folder

	if a.Seq != 1 || b.Seq != 2 || c.Seq != 3 || b.Name != "New collection" {
		t.Fatalf("seqs/names: %+v %+v %+v", a, b, c)
	}
	colDir := filepath.Join(ws.Root(), CollectionsDir)
	for _, d := range []string{"users-api", "new-collection", "users-api-2"} {
		if !exists(filepath.Join(colDir, d, CollectionFile)) {
			t.Fatalf("missing %s", d)
		}
	}

	got, err := ws.GetCollection(a.ID)
	if err != nil || got.Name != "Users API" {
		t.Fatalf("GetCollection = %+v, %v", got, err)
	}

	renamed, err := ws.RenameCollection(a.ID, "Accounts")
	if err != nil || renamed.Name != "Accounts" {
		t.Fatalf("rename = %+v %v", renamed, err)
	}
	if exists(filepath.Join(colDir, "users-api")) || !exists(filepath.Join(colDir, "accounts", CollectionFile)) {
		t.Fatal("folder not renamed")
	}
	// Renaming to a name with the same slug keeps the folder.
	if _, err := ws.RenameCollection(a.ID, "ACCOUNTS"); err != nil || !exists(filepath.Join(colDir, "accounts")) {
		t.Fatalf("same-slug rename: %v", err)
	}

	if err := ws.ReorderCollections([]string{c.ID, a.ID}); err != nil {
		t.Fatal(err)
	}
	tree := ws.Tree()
	var order []string
	for _, n := range tree.Collections {
		order = append(order, n.ID)
	}
	// c=1, a=2, b keeps seq 2 -> tie broken by name ("ACCOUNTS" < "New collection")
	if strings.Join(order, ",") != strings.Join([]string{c.ID, a.ID, b.ID}, ",") {
		t.Fatalf("order = %v", order)
	}
	if err := ws.ReorderCollections([]string{"nope"}); !errors.Is(err, ErrNotFound) {
		t.Fatalf("reorder unknown err = %v", err)
	}

	if err := ws.DeleteCollection(b.ID); err != nil {
		t.Fatal(err)
	}
	if exists(filepath.Join(colDir, "new-collection")) {
		t.Fatal("folder not deleted")
	}

	for name, err := range map[string]error{
		"get":    func() error { _, e := ws.GetCollection("x"); return e }(),
		"rename": func() error { _, e := ws.RenameCollection("x", "y"); return e }(),
		"delete": ws.DeleteCollection("x"),
	} {
		if !errors.Is(err, ErrNotFound) {
			t.Errorf("%s err = %v", name, err)
		}
	}

	// Survives a reload from disk.
	reopened, err := Open(ws.Root())
	if err != nil {
		t.Fatal(err)
	}
	if n := len(reopened.Tree().Collections); n != 2 {
		t.Fatalf("reopened collections = %d", n)
	}
}

func TestRequestsCRUD(t *testing.T) {
	ws := newWS(t)
	col := mustCol(t, ws, "API")
	other := mustCol(t, ws, "Other")
	colDir := filepath.Join(ws.Root(), CollectionsDir, "api")

	r1 := mustReq(t, ws, col.ID, model.Request{Name: "Get user", Method: "get", URL: "http://x/users/:id",
		Headers: []model.KeyValue{{Key: "Accept", Value: "application/json", Enabled: true}}})
	if r1.ID == "" || r1.Method != "GET" || r1.Seq != 1 || r1.Body.Type != model.BodyNone || r1.Auth.Type != model.AuthNone {
		t.Fatalf("created = %+v", r1)
	}
	if !exists(filepath.Join(colDir, "get-user.yaml")) {
		t.Fatal("request file missing")
	}
	r2 := mustReq(t, ws, col.ID, model.Request{ID: r1.ID, Name: "Get user"}) // duplicate id & name
	if r2.ID == r1.ID || r2.Seq != 2 || !exists(filepath.Join(colDir, "get-user-2.yaml")) {
		t.Fatalf("r2 = %+v", r2)
	}
	r3 := mustReq(t, ws, col.ID, model.Request{})
	if r3.Name != "Untitled request" || r3.Method != "GET" {
		t.Fatalf("r3 = %+v", r3)
	}

	got, err := ws.GetRequest(r1.ID)
	if err != nil || got.URL != "http://x/users/:id" || len(got.Headers) != 1 {
		t.Fatalf("GetRequest = %+v %v", got, err)
	}
	if cid, err := ws.RequestCollection(r1.ID); err != nil || cid != col.ID {
		t.Fatalf("RequestCollection = %s %v", cid, err)
	}

	// Save with a new name renames the file but keeps the ID.
	got.Name = "Fetch user"
	got.Method = "post"
	saved, err := ws.SaveRequest(got)
	if err != nil || saved.ID != r1.ID || saved.Method != "POST" {
		t.Fatalf("save = %+v %v", saved, err)
	}
	if exists(filepath.Join(colDir, "get-user.yaml")) || !exists(filepath.Join(colDir, "fetch-user.yaml")) {
		t.Fatal("file not renamed on save")
	}
	// Save without a name change writes in place.
	saved.URL = "http://y"
	if _, err := ws.SaveRequest(saved); err != nil {
		t.Fatal(err)
	}
	if again, _ := ws.GetRequest(r1.ID); again.URL != "http://y" {
		t.Fatalf("url = %s", again.URL)
	}

	ren, err := ws.RenameRequest(r1.ID, "  Load   user ")
	if err != nil || ren.Name != "Load user" || !exists(filepath.Join(colDir, "load-user.yaml")) {
		t.Fatalf("rename = %+v %v", ren, err)
	}

	dup, err := ws.DuplicateRequest(r1.ID)
	if err != nil || dup.ID == r1.ID || dup.Name != "Load user copy" || dup.URL != "http://y" || dup.Seq != 4 {
		t.Fatalf("dup = %+v %v", dup, err)
	}

	if err := ws.Reorder(col.ID, []string{dup.ID, r1.ID}); err != nil {
		t.Fatal(err)
	}
	tree := ws.Tree()
	if first := tree.Collections[0].Children[0]; first.ID != dup.ID || first.Seq != 1 || first.ParentID != col.ID {
		t.Fatalf("first after reorder = %+v", first)
	}
	if err := ws.Reorder(col.ID, []string{"missing"}); !errors.Is(err, ErrNotFound) {
		t.Fatalf("reorder err = %v", err)
	}
	if err := ws.Reorder("missing", nil); !errors.Is(err, ErrNotFound) {
		t.Fatalf("reorder col err = %v", err)
	}
	if err := ws.Reorder(other.ID, []string{r1.ID}); !errors.Is(err, ErrNotFound) {
		t.Fatalf("reorder foreign err = %v", err)
	}

	moved, err := ws.MoveRequest(r1.ID, other.ID, -1)
	if err != nil || moved.ID != r1.ID || moved.Seq != 1 {
		t.Fatalf("move = %+v %v", moved, err)
	}
	if exists(filepath.Join(colDir, "load-user.yaml")) || !exists(filepath.Join(ws.Root(), CollectionsDir, "other", "load-user.yaml")) {
		t.Fatal("file not moved")
	}
	if same, err := ws.MoveRequest(r1.ID, other.ID, 5); err != nil || same.ID != r1.ID || same.Seq != 1 {
		t.Fatalf("move to same = %+v %v", same, err)
	}
	if _, err := ws.MoveRequest(r1.ID, "nope", 0); !errors.Is(err, ErrNotFound) {
		t.Fatalf("move to unknown err = %v", err)
	}

	if err := ws.DeleteRequest(r2.ID); err != nil {
		t.Fatal(err)
	}
	if exists(filepath.Join(colDir, "get-user-2.yaml")) {
		t.Fatal("request file not deleted")
	}

	for name, err := range map[string]error{
		"get":       func() error { _, e := ws.GetRequest("x"); return e }(),
		"col":       func() error { _, e := ws.RequestCollection("x"); return e }(),
		"save":      func() error { _, e := ws.SaveRequest(model.Request{ID: "x"}); return e }(),
		"rename":    func() error { _, e := ws.RenameRequest("x", "y"); return e }(),
		"duplicate": func() error { _, e := ws.DuplicateRequest("x"); return e }(),
		"delete":    ws.DeleteRequest("x"),
		"move":      func() error { _, e := ws.MoveRequest("x", other.ID, 0); return e }(),
		"parent":    func() error { _, e := ws.RequestParent("x"); return e }(),
		"create":    func() error { _, e := ws.CreateRequest("x", model.Request{}); return e }(),
	} {
		if !errors.Is(err, ErrNotFound) {
			t.Errorf("%s err = %v", name, err)
		}
	}

	// Deleting a collection drops its requests from the index.
	if err := ws.DeleteCollection(other.ID); err != nil {
		t.Fatal(err)
	}
	if _, err := ws.GetRequest(r1.ID); !errors.Is(err, ErrNotFound) {
		t.Fatalf("request of deleted collection: %v", err)
	}

	// Round trip from disk.
	reopened, err := Open(ws.Root())
	if err != nil {
		t.Fatal(err)
	}
	tr := reopened.Tree()
	if len(tr.Collections) != 1 || len(tr.Collections[0].Children) != 2 || len(tr.Problems) != 0 {
		t.Fatalf("reopened tree = %+v", tr)
	}
}

func TestRequestFileVanished(t *testing.T) {
	ws := newWS(t)
	col := mustCol(t, ws, "API")
	r := mustReq(t, ws, col.ID, model.Request{Name: "A"})
	path := filepath.Join(ws.Root(), CollectionsDir, "api", "a.yaml")
	_ = os.Remove(path)

	if _, err := ws.GetRequest(r.ID); err == nil {
		t.Fatal("GetRequest on vanished file should fail")
	}
	if _, err := ws.RenameRequest(r.ID, "B"); err == nil {
		t.Fatal("RenameRequest on vanished file should fail")
	}
	if _, err := ws.DuplicateRequest(r.ID); err == nil {
		t.Fatal("DuplicateRequest on vanished file should fail")
	}
	other := mustCol(t, ws, "Other")
	if _, err := ws.MoveRequest(r.ID, other.ID, 0); err == nil {
		t.Fatal("MoveRequest on vanished file should fail")
	}
	mustReq(t, ws, col.ID, model.Request{Name: "B"})
	// Putting A second needs a read of its (vanished) file to rewrite its seq.
	if err := ws.Reorder(col.ID, []string{r.ID}); err != nil {
		t.Fatalf("A is already first: %v", err)
	}
	tree := ws.Tree()
	if err := ws.Reorder(col.ID, []string{tree.Collections[0].Children[1].ID, r.ID}); err == nil || !strings.Contains(err.Error(), "read request") {
		t.Fatalf("Reorder on vanished file err = %v", err)
	}
	// Deleting a vanished file is fine.
	if err := ws.DeleteRequest(r.ID); err != nil {
		t.Fatal(err)
	}
}

func TestReloadToleratesBadFiles(t *testing.T) {
	ws := newWS(t)
	col := mustCol(t, ws, "API")
	good := mustReq(t, ws, col.ID, model.Request{Name: "Good"})
	colDir := filepath.Join(ws.Root(), CollectionsDir)
	write := func(rel, content string) {
		p := filepath.Join(colDir, rel)
		_ = os.MkdirAll(filepath.Dir(p), 0o755)
		if err := os.WriteFile(p, []byte(content), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	write("api/broken.yaml", "id: [unclosed")
	write("api/noid.yml", "name: x\n")
	write("api/zdupe.yaml", "id: "+good.ID+"\nname: dupe\n")
	write("api/notes.txt", "ignored")
	write("api/.hidden.yaml", "ignored")
	write("api/sub/x.yaml", "id: SUBX\n") // no _folder.yaml: reported, not loaded
	write("api/x.examples.yaml", "ignored")
	write("nometa/a.yaml", "id: Z\n")
	write("badmeta/_collection.yaml", "id: [")
	write("noidmeta/_collection.yaml", "name: n\n")
	write("dupcol/_collection.yaml", "id: "+col.ID+"\n")
	write("unnamed/_collection.yaml", "id: U1\n")
	write(".git/_collection.yaml", "id: G\n")
	write("stray.yaml", "x")

	problems := ws.Reload()
	paths := map[string]bool{}
	for _, p := range problems {
		paths[p.Path] = true
	}
	for _, want := range []string{
		"collections/api/broken.yaml", "collections/api/noid.yml", "collections/api/zdupe.yaml",
		"collections/nometa/_collection.yaml", "collections/badmeta/_collection.yaml",
		"collections/noidmeta/_collection.yaml", "collections/api/sub/_folder.yaml",
	} {
		if !paths[want] {
			t.Errorf("missing problem for %s in %+v", want, problems)
		}
	}
	tree := ws.Tree()
	if len(tree.Problems) != len(problems) {
		t.Fatal("Tree should carry problems")
	}
	names := map[string]int{}
	for _, c := range tree.Collections {
		names[c.Name] = len(c.Children)
	}
	if names["API"] != 1 || names["unnamed"] != 0 || len(names) != 2 {
		t.Fatalf("collections = %v", names)
	}
}

func TestReloadMissingCollectionsDir(t *testing.T) {
	ws := newWS(t)
	_ = os.RemoveAll(filepath.Join(ws.Root(), CollectionsDir))
	if p := ws.Reload(); len(p) != 0 {
		t.Fatalf("problems = %v", p)
	}
	// Creating a collection recreates the folder.
	if _, err := ws.CreateCollection("A"); err != nil {
		t.Fatal(err)
	}
}

func TestSummaryDefaults(t *testing.T) {
	if s := summarize(model.Request{ID: "1", Name: "n", Method: "patch", URL: "https://x.dev/a"}); s.Method != "PATCH" || s.URL != "https://x.dev/a" {
		t.Fatalf("summary = %+v", s)
	}
	if s := summarize(model.Request{}); s.Method != "GET" {
		t.Fatalf("summary = %+v", s)
	}
}

func TestRelOutsideRoot(t *testing.T) {
	ws := &Workspace{root: "relative"}
	if got := ws.rel("/abs/path"); got != "/abs/path" {
		t.Fatalf("rel = %s", got)
	}
}
