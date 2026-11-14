package fsstore

import (
	"errors"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"

	"pakpos/internal/core/inherit"
	"pakpos/internal/core/model"
)

func mustFolder(t *testing.T, ws *Workspace, parentID, name string) Folder {
	t.Helper()
	f, err := ws.CreateFolder(parentID, name)
	if err != nil {
		t.Fatal(err)
	}
	return f
}

// shape renders a tree as "Users[auth[login] get]" for compact assertions.
func shape(nodes []Node) string {
	parts := make([]string, 0, len(nodes))
	for _, n := range nodes {
		s := n.Name
		if n.Kind != NodeRequest {
			s += "[" + shape(n.Children) + "]"
		}
		parts = append(parts, s)
	}
	return strings.Join(parts, " ")
}

func seqs(nodes []Node) []int {
	out := make([]int, len(nodes))
	for i, n := range nodes {
		out[i] = n.Seq
	}
	return out
}

func TestFoldersNestAndShareSeqWithRequests(t *testing.T) {
	ws := newWS(t)
	col := mustCol(t, ws, "Users")
	get := mustReq(t, ws, col.ID, model.Request{Name: "get"})
	auth := mustFolder(t, ws, col.ID, "  Auth  ")
	login := mustReq(t, ws, auth.ID, model.Request{Name: "login"})
	tokens := mustFolder(t, ws, auth.ID, "")
	refresh := mustReq(t, ws, tokens.ID, model.Request{Name: "refresh"})
	last := mustReq(t, ws, col.ID, model.Request{Name: "last"})

	if auth.Name != "Auth" || auth.Seq != 2 || tokens.Name != "New folder" || tokens.Seq != 2 || last.Seq != 3 {
		t.Fatalf("seqs/names: auth=%+v tokens=%+v last=%+v", auth, tokens, last)
	}
	colDir := filepath.Join(ws.Root(), CollectionsDir, "users")
	for _, p := range []string{"auth/_folder.yaml", "auth/login.yaml", "auth/new-folder/_folder.yaml", "auth/new-folder/refresh.yaml"} {
		if !exists(filepath.Join(colDir, p)) {
			t.Fatalf("missing %s", p)
		}
	}

	tree := ws.Tree()
	if got := shape(tree.Collections); got != "Users[get Auth[login New folder[refresh]] last]" {
		t.Fatalf("tree = %s", got)
	}
	n := tree.Collections[0].Children[1]
	if n.Kind != NodeFolder || n.ID != auth.ID || n.ParentID != col.ID || n.Children[1].ParentID != auth.ID {
		t.Fatalf("folder node = %+v", n)
	}
	if r := n.Children[0]; r.Kind != NodeRequest || r.Method != "GET" || r.ParentID != auth.ID {
		t.Fatalf("request node = %+v", r)
	}

	for id, want := range map[string]string{get.ID: col.ID, login.ID: auth.ID, refresh.ID: tokens.ID} {
		if p, err := ws.RequestParent(id); err != nil || p != want {
			t.Errorf("RequestParent(%s) = %s %v, want %s", id, p, err, want)
		}
		if c, err := ws.RequestCollection(id); err != nil || c != col.ID {
			t.Errorf("RequestCollection(%s) = %s %v", id, c, err)
		}
	}
	if p, err := ws.FolderParent(tokens.ID); err != nil || p != auth.ID {
		t.Fatalf("FolderParent = %s %v", p, err)
	}

	// Everything survives a reload from disk, including requests read via nested paths.
	reopened, err := Open(ws.Root())
	if err != nil {
		t.Fatal(err)
	}
	if got := shape(reopened.Tree().Collections); got != "Users[get Auth[login New folder[refresh]] last]" {
		t.Fatalf("reopened tree = %s", got)
	}
	if r, err := reopened.GetRequest(refresh.ID); err != nil || r.Name != "refresh" {
		t.Fatalf("nested request after reopen = %+v %v", r, err)
	}
}

func TestFolderOrderTieBreaks(t *testing.T) {
	ws := newWS(t)
	col := mustCol(t, ws, "C")
	dir := filepath.Join(ws.Root(), CollectionsDir, "c")
	write := func(rel, content string) {
		p := filepath.Join(dir, rel)
		_ = os.MkdirAll(filepath.Dir(p), 0o755)
		if err := os.WriteFile(p, []byte(content), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	// Same seq: name decides, then folders before requests, then id.
	write("x/_folder.yaml", "id: F1\nname: same\nseq: 1\n")
	write("same.yaml", "id: R1\nname: same\nseq: 1\n")
	write("b.yaml", "id: R2\nname: Alpha\nseq: 1\n")
	write("y/_folder.yaml", "id: F3\nname: same\nseq: 1\n")
	write("z/_folder.yaml", "id: F2\nseq: 0\n") // name defaults to the directory
	if p := ws.Reload(); len(p) != 0 {
		t.Fatalf("problems = %v", p)
	}
	var ids []string
	for _, n := range ws.Tree().Collections[0].Children {
		ids = append(ids, n.ID)
	}
	if got := strings.Join(ids, ","); got != "F2,R2,F1,F3,R1" {
		t.Fatalf("order = %s", got)
	}
	if f, _ := ws.GetFolder("F2"); f.Name != "z" {
		t.Fatalf("default name = %q", f.Name)
	}
	_ = col
}

func TestFolderLoadProblems(t *testing.T) {
	ws := newWS(t)
	col := mustCol(t, ws, "API")
	mustFolder(t, ws, col.ID, "Good")
	dir := filepath.Join(ws.Root(), CollectionsDir, "api")
	write := func(rel, content string) {
		p := filepath.Join(dir, rel)
		_ = os.MkdirAll(filepath.Dir(p), 0o755)
		if err := os.WriteFile(p, []byte(content), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	write("plain/inside.yaml", "id: IN\n")
	write("broken/_folder.yaml", "id: [")
	write("noid/_folder.yaml", "name: x\n")
	write("dupcol/_folder.yaml", "id: "+col.ID+"\n")
	write("dupcol/r.yaml", "id: HIDDEN\n")
	write(".hidden/_folder.yaml", "id: H\n")
	write("good/login.examples.yaml", "id: EX\n")
	write("good/deeper/x.yaml", "id: DX\n")

	problems := ws.Reload()
	got := map[string]string{}
	for _, p := range problems {
		got[p.Path] = p.Message
	}
	for path, msg := range map[string]string{
		"collections/api/plain/_folder.yaml":       "folder has no _folder.yaml",
		"collections/api/broken/_folder.yaml":      "invalid YAML",
		"collections/api/noid/_folder.yaml":        "missing id",
		"collections/api/dupcol/_folder.yaml":      "duplicate folder id",
		"collections/api/good/deeper/_folder.yaml": "not loaded",
	} {
		if !strings.Contains(got[path], msg) {
			t.Errorf("problem for %s = %q, want %q", path, got[path], msg)
		}
	}
	if len(problems) != 5 {
		t.Fatalf("problems = %+v", problems)
	}
	for _, id := range []string{"IN", "HIDDEN", "EX", "DX"} {
		if _, err := ws.GetRequest(id); !errors.Is(err, ErrNotFound) {
			t.Errorf("%s should not load: %v", id, err)
		}
	}
	if got := shape(ws.Tree().Collections); got != "API[Good[]]" {
		t.Fatalf("tree = %s", got)
	}
}

func TestFolderCRUDAndSettings(t *testing.T) {
	ws := newWS(t)
	col := mustCol(t, ws, "API")
	f := mustFolder(t, ws, col.ID, "Auth")
	inner := mustFolder(t, ws, f.ID, "Inner")
	r := mustReq(t, ws, inner.ID, model.Request{Name: "Login", URL: "http://x"})

	got, err := ws.GetFolder(f.ID)
	if err != nil || got.Name != "Auth" || got.Headers == nil {
		t.Fatalf("GetFolder = %+v %v", got, err)
	}

	saved, err := ws.SaveFolder(f.ID, FolderSettings{
		Auth:    model.Auth{Type: model.AuthBearer, Token: "{{token}}"},
		Headers: []model.KeyValue{{Key: "X-Team", Value: "core", Enabled: true}},
	})
	if err != nil || saved.Auth.Type != model.AuthBearer || len(saved.Headers) != 1 || saved.Seq != f.Seq {
		t.Fatalf("SaveFolder = %+v %v", saved, err)
	}
	data, _ := os.ReadFile(filepath.Join(ws.Root(), CollectionsDir, "api", "auth", FolderFile))
	if !strings.Contains(string(data), "X-Team") || !strings.Contains(string(data), "bearer") {
		t.Fatalf("folder file = %s", data)
	}

	// Rename moves the directory; requests inside keep working by id.
	ren, err := ws.RenameFolder(f.ID, "Sign in")
	if err != nil || ren.Name != "Sign in" || ren.Auth.Type != model.AuthBearer {
		t.Fatalf("RenameFolder = %+v %v", ren, err)
	}
	colDir := filepath.Join(ws.Root(), CollectionsDir, "api")
	if exists(filepath.Join(colDir, "auth")) || !exists(filepath.Join(colDir, "sign-in", "inner", "login.yaml")) {
		t.Fatal("folder directory not renamed")
	}
	if got, err := ws.GetRequest(r.ID); err != nil || got.URL != "http://x" {
		t.Fatalf("request after folder rename = %+v %v", got, err)
	}
	if _, err := ws.RenameFolder(f.ID, "SIGN IN"); err != nil || !exists(filepath.Join(colDir, "sign-in")) {
		t.Fatalf("same-slug rename: %v", err)
	}
	if _, err := ws.SaveRequest(model.Request{ID: r.ID, Name: "Log in"}); err != nil || !exists(filepath.Join(colDir, "sign-in", "inner", "log-in.yaml")) {
		t.Fatalf("save inside renamed folder: %v", err)
	}

	// Delete is recursive and cleans the index.
	if err := ws.DeleteFolder(f.ID); err != nil {
		t.Fatal(err)
	}
	if exists(filepath.Join(colDir, "sign-in")) {
		t.Fatal("folder not deleted")
	}
	for _, check := range []error{
		func() error { _, e := ws.GetFolder(inner.ID); return e }(),
		func() error { _, e := ws.GetRequest(r.ID); return e }(),
	} {
		if !errors.Is(check, ErrNotFound) {
			t.Fatalf("after delete: %v", check)
		}
	}

	for name, err := range map[string]error{
		"get":          func() error { _, e := ws.GetFolder("x"); return e }(),
		"parent":       func() error { _, e := ws.FolderParent("x"); return e }(),
		"create":       func() error { _, e := ws.CreateFolder("x", "y"); return e }(),
		"rename":       func() error { _, e := ws.RenameFolder("x", "y"); return e }(),
		"save":         func() error { _, e := ws.SaveFolder("x", FolderSettings{}); return e }(),
		"delete":       ws.DeleteFolder("x"),
		"move":         func() error { _, e := ws.MoveFolder("x", col.ID, 0); return e }(),
		"move to":      func() error { _, e := ws.MoveFolder(mustFolder(t, ws, col.ID, "M").ID, "x", 0); return e }(),
		"req to":       func() error { _, e := ws.MoveRequest(mustReq(t, ws, col.ID, model.Request{}).ID, "x", 0); return e }(),
		"chain":        func() error { _, e := ws.InheritChain("x"); return e }(),
		"save col":     func() error { _, e := ws.SaveCollection("x", CollectionSettings{}); return e }(),
		"create in":    func() error { _, e := ws.CreateRequest("x", model.Request{}); return e }(),
		"reorder in":   ws.Reorder("x", nil),
		"reorder item": ws.Reorder(col.ID, []string{"x"}),
	} {
		if !errors.Is(err, ErrNotFound) {
			t.Errorf("%s err = %v", name, err)
		}
	}
}

func TestMoveRequestAcrossLevels(t *testing.T) {
	ws := newWS(t)
	a := mustCol(t, ws, "A")
	b := mustCol(t, ws, "B")
	r1 := mustReq(t, ws, a.ID, model.Request{Name: "one"})
	r2 := mustReq(t, ws, a.ID, model.Request{Name: "two"})
	f := mustFolder(t, ws, a.ID, "F")
	r3 := mustReq(t, ws, a.ID, model.Request{Name: "three"})
	inF := mustReq(t, ws, f.ID, model.Request{Name: "one"}) // name collides with r1

	// Into a folder at index 0: the file name collision is resolved, seqs renumbered.
	moved, err := ws.MoveRequest(r1.ID, f.ID, 0)
	if err != nil || moved.ID != r1.ID || moved.Seq != 1 {
		t.Fatalf("move into folder = %+v %v", moved, err)
	}
	fDir := filepath.Join(ws.Root(), CollectionsDir, "a", "f")
	if !exists(filepath.Join(fDir, "one-2.yaml")) || exists(filepath.Join(ws.Root(), CollectionsDir, "a", "one.yaml")) {
		t.Fatal("file not moved into the folder")
	}
	tree := ws.Tree()
	if got := shape(tree.Collections); got != "A[two F[one one] three] B[]" {
		t.Fatalf("tree = %s", got)
	}
	if s := seqs(tree.Collections[0].Children); s[0] != 1 || s[1] != 2 || s[2] != 3 {
		t.Fatalf("source not renumbered: %v", s)
	}
	if s := seqs(tree.Collections[0].Children[1].Children); s[0] != 1 || s[1] != 2 {
		t.Fatalf("target not renumbered: %v", s)
	}
	if got, _ := ws.GetRequest(inF.ID); got.Seq != 2 {
		t.Fatalf("sibling seq on disk = %d", got.Seq)
	}

	// Out to another collection, appended (negative and too-large index).
	if _, err := ws.MoveRequest(r1.ID, b.ID, -1); err != nil {
		t.Fatal(err)
	}
	if _, err := ws.MoveRequest(r3.ID, b.ID, 99); err != nil {
		t.Fatal(err)
	}
	// Reorder within the same parent by moving.
	if m, err := ws.MoveRequest(r3.ID, b.ID, 0); err != nil || m.Seq != 1 {
		t.Fatalf("reorder by move = %+v %v", m, err)
	}
	if got := shape(ws.Tree().Collections); got != "A[two F[one]] B[three one]" {
		t.Fatalf("tree = %s", got)
	}
	if c, _ := ws.RequestCollection(r1.ID); c != b.ID {
		t.Fatalf("collection after move = %s", c)
	}
	_ = r2

	reopened, _ := Open(ws.Root())
	if got := shape(reopened.Tree().Collections); got != "A[two F[one]] B[three one]" {
		t.Fatalf("reopened = %s", got)
	}
}

func TestMoveFolder(t *testing.T) {
	ws := newWS(t)
	a := mustCol(t, ws, "A")
	b := mustCol(t, ws, "B")
	outer := mustFolder(t, ws, a.ID, "Outer")
	inner := mustFolder(t, ws, outer.ID, "Inner")
	deep := mustReq(t, ws, inner.ID, model.Request{Name: "deep", URL: "http://deep"})
	sib := mustReq(t, ws, a.ID, model.Request{Name: "sib"})
	mustFolder(t, ws, b.ID, "Outer") // directory name collision in B

	for _, to := range []string{outer.ID, inner.ID} {
		if _, err := ws.MoveFolder(outer.ID, to, 0); !errors.Is(err, ErrInvalidMove) {
			t.Fatalf("move into %s err = %v", to, err)
		}
	}

	// Reorder within the same parent.
	if f, err := ws.MoveFolder(outer.ID, a.ID, 1); err != nil || f.Seq != 2 {
		t.Fatalf("reorder = %+v %v", f, err)
	}
	if got := shape(ws.Tree().Collections); got != "A[sib Outer[Inner[deep]]] B[Outer[]]" {
		t.Fatalf("tree = %s", got)
	}

	// Across collections, with the whole subtree.
	moved, err := ws.MoveFolder(outer.ID, b.ID, 0)
	if err != nil || moved.ID != outer.ID || moved.Seq != 1 {
		t.Fatalf("move = %+v %v", moved, err)
	}
	if !exists(filepath.Join(ws.Root(), CollectionsDir, "b", "outer-2", "inner", "deep.yaml")) {
		t.Fatal("folder directory not moved")
	}
	if got := shape(ws.Tree().Collections); got != "A[sib] B[Outer[Inner[deep]] Outer[]]" {
		t.Fatalf("tree = %s", got)
	}
	if r, err := ws.GetRequest(deep.ID); err != nil || r.URL != "http://deep" {
		t.Fatalf("request after folder move = %+v %v", r, err)
	}
	if c, _ := ws.RequestCollection(deep.ID); c != b.ID {
		t.Fatalf("collection = %s", c)
	}
	if s, _ := ws.GetRequest(sib.ID); s.Seq != 1 {
		t.Fatalf("source not renumbered: %d", s.Seq)
	}

	// Up a level: inner out of outer into B.
	if _, err := ws.MoveFolder(inner.ID, b.ID, -1); err != nil {
		t.Fatal(err)
	}
	if got := shape(ws.Tree().Collections); got != "A[sib] B[Outer[] Outer[] Inner[deep]]" {
		t.Fatalf("tree = %s", got)
	}
	reopened, _ := Open(ws.Root())
	if got := shape(reopened.Tree().Collections); got != "A[sib] B[Outer[] Outer[] Inner[deep]]" {
		t.Fatalf("reopened = %s", got)
	}
}

func TestReorderMixedChildren(t *testing.T) {
	ws := newWS(t)
	col := mustCol(t, ws, "C")
	r1 := mustReq(t, ws, col.ID, model.Request{Name: "r1"})
	f1 := mustFolder(t, ws, col.ID, "f1")
	r2 := mustReq(t, ws, col.ID, model.Request{Name: "r2"})
	f2 := mustFolder(t, ws, col.ID, "f2")

	// Unlisted children follow the listed ones in their current order; repeats are ignored.
	if err := ws.Reorder(col.ID, []string{f2.ID, r2.ID, f2.ID}); err != nil {
		t.Fatal(err)
	}
	if got := shape(ws.Tree().Collections); got != "C[f2[] r2 r1 f1[]]" {
		t.Fatalf("tree = %s", got)
	}
	if s := seqs(ws.Tree().Collections[0].Children); s[3] != 4 {
		t.Fatalf("seqs = %v", s)
	}
	reopened, _ := Open(ws.Root())
	if got := shape(reopened.Tree().Collections); got != "C[f2[] r2 r1 f1[]]" {
		t.Fatalf("reopened = %s", got)
	}
	// A folder's children are separate from the collection's.
	if err := ws.Reorder(f1.ID, []string{r1.ID}); !errors.Is(err, ErrNotFound) {
		t.Fatalf("foreign child err = %v", err)
	}
}

func TestInheritChain(t *testing.T) {
	ws := newWS(t)
	col := mustCol(t, ws, "API")
	if _, err := ws.SaveCollection(col.ID, CollectionSettings{
		Auth:    model.Auth{Type: model.AuthBearer, Token: "col"},
		Headers: []model.KeyValue{{Key: "X-A", Value: "col", Enabled: true}},
	}); err != nil {
		t.Fatal(err)
	}
	outer := mustFolder(t, ws, col.ID, "Outer")
	inner := mustFolder(t, ws, outer.ID, "Inner")
	if _, err := ws.SaveFolder(inner.ID, FolderSettings{
		Auth:    model.Auth{Type: model.AuthBasic, Username: "in"},
		Headers: []model.KeyValue{{Key: "X-A", Value: "inner", Enabled: true}},
	}); err != nil {
		t.Fatal(err)
	}
	r := mustReq(t, ws, inner.ID, model.Request{Name: "r", Auth: model.Auth{Type: model.AuthInherit}})

	names := func(levels []inherit.Level) string {
		var s []string
		for _, l := range levels {
			s = append(s, string(l.Kind)+":"+l.Name)
		}
		return strings.Join(s, " ")
	}
	for id, want := range map[string]string{
		r.ID:     "collection:API folder:Outer folder:Inner",
		inner.ID: "collection:API folder:Outer folder:Inner",
		outer.ID: "collection:API folder:Outer",
		col.ID:   "collection:API",
	} {
		chain, err := ws.InheritChain(id)
		if err != nil || names(chain) != want {
			t.Errorf("chain(%s) = %s %v, want %s", id, names(chain), err, want)
		}
	}

	// The chain is in the shape core/inherit takes.
	chain, _ := ws.InheritChain(r.ID)
	req, _ := ws.GetRequest(r.ID)
	res := inherit.Effective(chain, req)
	if res.Request.Auth.Type != model.AuthBasic || res.AuthSource.ID != inner.ID ||
		len(res.Headers) != 1 || res.Headers[0].Value != "inner" {
		t.Fatalf("effective = %+v", res)
	}
	// Returned slices are copies.
	chain[0].Headers[0].Value = "changed"
	if again, _ := ws.InheritChain(r.ID); again[0].Headers[0].Value != "col" {
		t.Fatal("chain shares memory with the index")
	}
}

func TestSaveCollectionSettings(t *testing.T) {
	ws := newWS(t)
	col := mustCol(t, ws, "API")
	saved, err := ws.SaveCollection(col.ID, CollectionSettings{
		Auth:    model.Auth{Type: model.AuthAPIKey, APIKey: "X-Key", APIValue: "{{key}}"},
		Headers: []model.KeyValue{{Key: "Accept", Value: "json", Enabled: true}},
		Variables: []model.Variable{
			{Key: " base ", Value: "http://x", Enabled: true},
			{Key: "token", Value: "s3cret", Enabled: true, Secret: true},
		},
	})
	if err != nil || saved.Name != "API" || saved.Variables[0].Key != "base" || saved.Variables[1].Value != "" {
		t.Fatalf("SaveCollection = %+v %v", saved, err)
	}
	data, _ := os.ReadFile(filepath.Join(ws.Root(), CollectionsDir, "api", CollectionFile))
	if strings.Contains(string(data), "s3cret") || !strings.Contains(string(data), "secret: true") || !strings.Contains(string(data), "X-Key") {
		t.Fatalf("collection file = %s", data)
	}
	got, _ := ws.GetCollection(col.ID)
	if got.Auth.Type != model.AuthAPIKey || len(got.Headers) != 1 || len(got.Variables) != 2 {
		t.Fatalf("GetCollection = %+v", got)
	}
	// The rename keeps the settings.
	if ren, _ := ws.RenameCollection(col.ID, "Renamed"); len(ren.Variables) != 2 {
		t.Fatalf("rename lost settings: %+v", ren)
	}
}

// v1 workspaces stay v1 until something v2-specific is written.
func TestManifestUpgradeOnFoldersAndSecrets(t *testing.T) {
	v1 := func(t *testing.T) (*Workspace, string) {
		t.Helper()
		dir := t.TempDir()
		write := func(rel, content string) {
			p := filepath.Join(dir, rel)
			_ = os.MkdirAll(filepath.Dir(p), 0o755)
			if err := os.WriteFile(p, []byte(content), 0o644); err != nil {
				t.Fatal(err)
			}
		}
		write(ManifestFile, "id: W1\nname: Old\nversion: 1\n")
		write("collections/api/_collection.yaml", "id: C1\nname: API\nseq: 1\nvariables:\n  - key: a\n    value: b\n    enabled: true\n")
		write("collections/api/get.yaml", "id: R1\nname: Get\nseq: 1\nmethod: GET\nurl: http://x\nbody:\n  type: none\nauth:\n  type: none\n")
		ws, err := Open(dir)
		if err != nil {
			t.Fatal(err)
		}
		return ws, dir
	}
	version := func(dir string) string {
		data, _ := os.ReadFile(filepath.Join(dir, ManifestFile))
		return string(data)
	}

	t.Run("opening, request and plain collection writes keep v1", func(t *testing.T) {
		ws, dir := v1(t)
		if got := shape(ws.Tree().Collections); got != "API[Get]" || len(ws.Tree().Problems) != 0 {
			t.Fatalf("tree = %s", got)
		}
		mustReq(t, ws, "C1", model.Request{Name: "New"})
		if err := ws.Reorder("C1", []string{"R1"}); err != nil {
			t.Fatal(err)
		}
		if _, err := ws.MoveRequest("R1", "C1", 1); err != nil {
			t.Fatal(err)
		}
		if _, err := ws.SaveCollection("C1", CollectionSettings{Variables: []model.Variable{{Key: "a", Value: "c", Enabled: true}}}); err != nil {
			t.Fatal(err)
		}
		if !strings.Contains(version(dir), "version: 1") || ws.Manifest().Version != 1 {
			t.Fatalf("manifest = %s", version(dir))
		}
	})
	t.Run("creating a folder upgrades", func(t *testing.T) {
		ws, dir := v1(t)
		mustFolder(t, ws, "C1", "F")
		if !strings.Contains(version(dir), "version: 2") {
			t.Fatalf("manifest = %s", version(dir))
		}
	})
	t.Run("a secret collection variable upgrades", func(t *testing.T) {
		ws, dir := v1(t)
		if _, err := ws.SaveCollection("C1", CollectionSettings{Variables: []model.Variable{{Key: "t", Secret: true}}}); err != nil {
			t.Fatal(err)
		}
		if !strings.Contains(version(dir), "version: 2") {
			t.Fatalf("manifest = %s", version(dir))
		}
	})
	t.Run("saving a hand-made folder upgrades", func(t *testing.T) {
		ws, dir := v1(t)
		_ = os.MkdirAll(filepath.Join(dir, "collections/api/hand"), 0o755)
		_ = os.WriteFile(filepath.Join(dir, "collections/api/hand", FolderFile), []byte("id: F9\n"), 0o644)
		ws.Reload()
		if _, err := ws.SaveFolder("F9", FolderSettings{}); err != nil {
			t.Fatal(err)
		}
		if !strings.Contains(version(dir), "version: 2") {
			t.Fatalf("manifest = %s", version(dir))
		}
	})
}

func TestFolderWriteErrors(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("directory permission bits are not enforced on Windows")
	}
	if os.Getuid() == 0 {
		t.Skip("permissions are not enforced for root")
	}
	ws := newWS(t)
	col := mustCol(t, ws, "API")
	f := mustFolder(t, ws, col.ID, "F")
	r := mustReq(t, ws, col.ID, model.Request{Name: "r"})
	colDir := filepath.Join(ws.Root(), CollectionsDir, "api")
	fDir := filepath.Join(colDir, "f")

	// A read-only collection directory: nothing can be created, renamed or moved in it.
	if err := os.Chmod(colDir, 0o555); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = os.Chmod(colDir, 0o755) })
	if _, err := ws.CreateFolder(col.ID, "G"); err == nil || !strings.Contains(err.Error(), `create folder "G"`) {
		t.Fatalf("create err = %v", err)
	}
	if _, err := ws.RenameFolder(f.ID, "H"); err == nil || !strings.Contains(err.Error(), `rename folder "F"`) {
		t.Fatalf("rename err = %v", err)
	}
	if _, err := ws.MoveRequest(r.ID, f.ID, 0); err == nil {
		t.Fatal("move out of a read-only dir should fail")
	}
	if err := ws.DeleteFolder(f.ID); err == nil || !strings.Contains(err.Error(), `delete folder "F"`) {
		t.Fatalf("delete err = %v", err)
	}
	_ = os.Chmod(colDir, 0o755)

	// A read-only folder: its settings and the requests moved into it can't be written.
	if err := os.Chmod(fDir, 0o555); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = os.Chmod(fDir, 0o755) })
	if _, err := ws.SaveFolder(f.ID, FolderSettings{}); err == nil || !strings.Contains(err.Error(), `save folder "F"`) {
		t.Fatalf("save err = %v", err)
	}
	if _, err := ws.MoveRequest(r.ID, f.ID, 0); err == nil || !strings.Contains(err.Error(), `move request "r"`) {
		t.Fatalf("move err = %v", err)
	}
	other := mustCol(t, ws, "Other")
	if _, err := ws.MoveFolder(f.ID, other.ID, 0); err == nil || !strings.Contains(err.Error(), `move folder "F"`) {
		t.Fatalf("move folder err = %v", err)
	}
	if err := ws.Reorder(col.ID, nil); err != nil {
		t.Fatal(err)
	}
}
