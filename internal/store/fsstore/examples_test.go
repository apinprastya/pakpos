package fsstore

import (
	"encoding/base64"
	"errors"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
	"time"

	"pakpos/internal/core/model"
)

func sampleExample(name string) Example {
	return Example{
		Name:    name,
		Request: model.Request{Name: "Get user", Method: "GET", URL: "{{baseUrl}}/users/1"},
		Response: ExampleResponseFrom(model.Response{
			StatusCode: 200, StatusText: "200 OK", URL: "https://api.example.com/users/1?key=secret",
			Headers:     []model.KeyValue{{Key: "Content-Type", Value: "application/json", Enabled: true}},
			ContentType: "application/json", Kind: model.KindJSON,
			Body: `{"id":1}`, Encoding: model.EncodingUTF8, Size: 8,
		}),
	}
}

func mustExample(t *testing.T, ws *Workspace, reqID, name string) ExampleSummary {
	t.Helper()
	s, err := ws.AddExample(reqID, sampleExample(name))
	if err != nil {
		t.Fatal(err)
	}
	return s
}

func exampleNames(t *testing.T, ws *Workspace, reqID string) []string {
	t.Helper()
	list, err := ws.ListExamples(reqID)
	if err != nil {
		t.Fatal(err)
	}
	out := make([]string, 0, len(list))
	for _, e := range list {
		out = append(out, e.Name)
	}
	return out
}

func TestExamplesCRUD(t *testing.T) {
	ws := newWS(t)
	col := mustCol(t, ws, "Users")
	r := mustReq(t, ws, col.ID, model.Request{Name: "Get user"})
	sidecar := filepath.Join(ws.Root(), CollectionsDir, "users", "get-user.examples.yaml")

	if got := exampleNames(t, ws, r.ID); len(got) != 0 {
		t.Fatalf("new request examples = %v", got)
	}
	ok := mustExample(t, ws, r.ID, "  200   OK ")
	if ok.Name != "200 OK" || ok.ID == "" || ok.RequestID != r.ID || ok.StatusCode != 200 || ok.StatusText != "200 OK" || ok.SavedAt.IsZero() {
		t.Fatalf("summary = %+v", ok)
	}
	unnamed := mustExample(t, ws, r.ID, " ")
	if unnamed.Name != "Example" {
		t.Fatalf("empty name = %q", unnamed.Name)
	}
	if !exists(sidecar) {
		t.Fatal("sidecar not written")
	}
	raw, _ := os.ReadFile(sidecar)
	for _, want := range []string{"requestId: " + r.ID, "statusCode: 200", "{{baseUrl}}/users/1"} {
		if !strings.Contains(string(raw), want) {
			t.Errorf("sidecar lacks %q:\n%s", want, raw)
		}
	}
	if strings.Contains(string(raw), "key=secret") {
		t.Errorf("the resolved response URL must not be saved:\n%s", raw)
	}

	full, err := ws.GetExample(r.ID, ok.ID)
	if err != nil || full.Response.Body != `{"id":1}` || full.Request.URL != "{{baseUrl}}/users/1" || len(full.Response.Headers) != 1 {
		t.Fatalf("GetExample = %+v %v", full, err)
	}
	if _, err := ws.GetExample(r.ID, "nope"); !errors.Is(err, ErrNotFound) {
		t.Fatalf("missing example err = %v", err)
	}

	renamed, err := ws.RenameExample(r.ID, unnamed.ID, "Not found")
	if err != nil || renamed.Name != "Not found" || renamed.ID != unnamed.ID {
		t.Fatalf("rename = %+v %v", renamed, err)
	}
	if _, err := ws.RenameExample(r.ID, "nope", "x"); !errors.Is(err, ErrNotFound) {
		t.Fatalf("rename missing err = %v", err)
	}
	if got := strings.Join(exampleNames(t, ws, r.ID), ","); got != "200 OK,Not found" {
		t.Fatalf("names = %s", got)
	}

	// Reloading reads the summaries back from disk.
	ws.Reload()
	if got := strings.Join(exampleNames(t, ws, r.ID), ","); got != "200 OK,Not found" {
		t.Fatalf("names after reload = %s", got)
	}
	if all := ws.AllExamples(); len(all) != 2 || all[0].RequestID != r.ID {
		t.Fatalf("AllExamples = %+v", all)
	}

	if err := ws.DeleteExample(r.ID, ok.ID); err != nil {
		t.Fatal(err)
	}
	if err := ws.DeleteExample(r.ID, ok.ID); !errors.Is(err, ErrNotFound) {
		t.Fatalf("delete twice err = %v", err)
	}
	if err := ws.DeleteExample(r.ID, unnamed.ID); err != nil {
		t.Fatal(err)
	}
	if exists(sidecar) {
		t.Fatal("the sidecar goes with the last example")
	}
	if all := ws.AllExamples(); len(all) != 0 {
		t.Fatalf("AllExamples after delete = %+v", all)
	}

	for name, err := range map[string]error{
		"list":   func() error { _, err := ws.ListExamples("nope"); return err }(),
		"get":    func() error { _, err := ws.GetExample("nope", "x"); return err }(),
		"add":    func() error { _, err := ws.AddExample("nope", sampleExample("x")); return err }(),
		"rename": func() error { _, err := ws.RenameExample("nope", "x", "y"); return err }(),
		"delete": ws.DeleteExample("nope", "x"),
	} {
		if !errors.Is(err, ErrNotFound) {
			t.Errorf("%s on unknown request err = %v", name, err)
		}
	}
}

func TestExampleBodies(t *testing.T) {
	ws := newWS(t)
	col := mustCol(t, ws, "Files")
	r := mustReq(t, ws, col.ID, model.Request{Name: "logo"})

	png := []byte{0x89, 'P', 'N', 'G', 0, 1, 2, 0xff}
	img := sampleExample("Logo")
	img.Response.Kind, img.Response.Encoding = model.KindImage, model.EncodingBase64
	img.Response.Body, img.Response.Size = base64.StdEncoding.EncodeToString(png), int64(len(png))
	img.Response.Headers = nil
	img.SavedAt = time.Date(2026, 11, 14, 10, 0, 0, 123, time.FixedZone("x", 3600))
	s, err := ws.AddExample(r.ID, img)
	if err != nil {
		t.Fatal(err)
	}
	if !s.SavedAt.Equal(time.Date(2026, 11, 14, 9, 0, 0, 0, time.UTC)) {
		t.Fatalf("savedAt = %v", s.SavedAt)
	}
	got, err := ws.GetExample(r.ID, s.ID)
	if err != nil || got.Response.Encoding != model.EncodingBase64 || got.Response.Body != img.Response.Body || got.Response.Headers == nil {
		t.Fatalf("base64 body = %+v %v", got.Response, err)
	}

	big := strings.Repeat("x", MaxExampleBody)
	for name, resp := range map[string]ExampleResponse{
		"utf8 body":   {Body: big + "x", Encoding: model.EncodingUTF8},
		"base64 body": {Body: base64.StdEncoding.EncodeToString([]byte(big + "xyz")), Encoding: model.EncodingBase64},
		"size":        {Body: "short", Size: MaxExampleBody + 1},
	} {
		ex := sampleExample(name)
		ex.Response = resp
		if _, err := ws.AddExample(r.ID, ex); !errors.Is(err, ErrExampleTooLarge) {
			t.Errorf("%s: err = %v", name, err)
		}
	}
	ex := sampleExample("exactly 1 MB")
	ex.Response.Body, ex.Response.Size = big, MaxExampleBody
	if _, err := ws.AddExample(r.ID, ex); err != nil {
		t.Fatalf("1 MB body: %v", err)
	}
}

// The sidecar follows its request through renames, moves, duplicates and deletes.
func TestExamplesFollowTheirRequest(t *testing.T) {
	ws := newWS(t)
	users := mustCol(t, ws, "Users")
	other := mustCol(t, ws, "Other")
	auth := mustFolder(t, ws, users.ID, "Auth")
	r := mustReq(t, ws, users.ID, model.Request{Name: "login"})
	ex := mustExample(t, ws, r.ID, "OK")
	root := filepath.Join(ws.Root(), CollectionsDir)
	at := func(rel string) string { return filepath.Join(root, filepath.FromSlash(rel)) }
	check := func(step, wantFile string, gone ...string) {
		t.Helper()
		if !exists(at(wantFile)) {
			t.Fatalf("%s: %s missing", step, wantFile)
		}
		for _, g := range gone {
			if exists(at(g)) {
				t.Fatalf("%s: %s left behind", step, g)
			}
		}
		if got, err := ws.GetExample(r.ID, ex.ID); err != nil || got.Name != "OK" {
			t.Fatalf("%s: example = %+v %v", step, got, err)
		}
	}

	if _, err := ws.RenameRequest(r.ID, "Sign in"); err != nil {
		t.Fatal(err)
	}
	check("rename", "users/sign-in.examples.yaml", "users/login.examples.yaml")

	r.Name = "Log in"
	if _, err := ws.SaveRequest(r); err != nil {
		t.Fatal(err)
	}
	check("save with a new name", "users/log-in.examples.yaml", "users/sign-in.examples.yaml")

	if _, err := ws.MoveRequest(r.ID, auth.ID, -1); err != nil {
		t.Fatal(err)
	}
	check("move into folder", "users/auth/log-in.examples.yaml", "users/log-in.examples.yaml")

	if _, err := ws.MoveFolder(auth.ID, other.ID, -1); err != nil {
		t.Fatal(err)
	}
	check("move folder across collections", "other/auth/log-in.examples.yaml", "users/auth/log-in.examples.yaml")

	if _, err := ws.RenameFolder(auth.ID, "Access"); err != nil {
		t.Fatal(err)
	}
	check("rename folder", "other/access/log-in.examples.yaml")

	if _, err := ws.MoveRequest(r.ID, users.ID, 0); err != nil {
		t.Fatal(err)
	}
	check("move across collections", "users/log-in.examples.yaml", "other/access/log-in.examples.yaml")

	// A same-parent move only reorders; the files stay.
	if _, err := ws.MoveRequest(r.ID, users.ID, 5); err != nil {
		t.Fatal(err)
	}
	check("reorder", "users/log-in.examples.yaml")

	reopened, err := Open(ws.Root())
	if err != nil {
		t.Fatal(err)
	}
	if got := exampleNames(t, reopened, r.ID); len(got) != 1 || got[0] != "OK" {
		t.Fatalf("reopened examples = %v", got)
	}

	dup, err := ws.DuplicateRequest(r.ID)
	if err != nil {
		t.Fatal(err)
	}
	copies, _ := ws.ListExamples(dup.ID)
	if len(copies) != 1 || copies[0].ID == ex.ID || copies[0].Name != "OK" || copies[0].RequestID != dup.ID {
		t.Fatalf("duplicate examples = %+v", copies)
	}
	if !exists(at("users/log-in-copy.examples.yaml")) {
		t.Fatal("duplicate sidecar missing")
	}

	if err := ws.DeleteRequest(r.ID); err != nil {
		t.Fatal(err)
	}
	if exists(at("users/log-in.examples.yaml")) {
		t.Fatal("delete left the sidecar behind")
	}
	for _, e := range ws.AllExamples() {
		if e.RequestID == r.ID {
			t.Fatalf("deleted request still listed: %+v", e)
		}
	}

	// Deleting the collection drops the copy's examples from the index too.
	if err := ws.DeleteCollection(users.ID); err != nil {
		t.Fatal(err)
	}
	if all := ws.AllExamples(); len(all) != 0 {
		t.Fatalf("examples after collection delete = %+v", all)
	}
}

func TestDuplicateWithoutExamples(t *testing.T) {
	ws := newWS(t)
	col := mustCol(t, ws, "API")
	r := mustReq(t, ws, col.ID, model.Request{Name: "plain"})
	dup, err := ws.DuplicateRequest(r.ID)
	if err != nil {
		t.Fatal(err)
	}
	if exists(filepath.Join(ws.Root(), CollectionsDir, "api", "plain-copy.examples.yaml")) {
		t.Fatal("no sidecar expected")
	}
	if got := exampleNames(t, ws, dup.ID); len(got) != 0 {
		t.Fatalf("examples = %v", got)
	}

	// A broken source sidecar is skipped (it's reported in Problems).
	writeFile(t, filepath.Join(ws.Root(), CollectionsDir, "api", "plain.examples.yaml"), "examples: [")
	if _, err := ws.DuplicateRequest(r.ID); err != nil {
		t.Fatalf("duplicate with a broken sidecar: %v", err)
	}
}

func TestNewRequestsSkipLeftoverSidecars(t *testing.T) {
	ws := newWS(t)
	col := mustCol(t, ws, "API")
	dir := filepath.Join(ws.Root(), CollectionsDir, "api")
	writeFile(t, filepath.Join(dir, "login.examples.yaml"), "requestId: GONE\nexamples: []\n")
	r := mustReq(t, ws, col.ID, model.Request{Name: "login"})
	if !exists(filepath.Join(dir, "login-2.yaml")) {
		t.Fatal("a new request must not take the name of a leftover sidecar")
	}
	if got := exampleNames(t, ws, r.ID); len(got) != 0 {
		t.Fatalf("examples = %v", got)
	}
	if got := uniqueRequestFile(filepath.Join(dir, "missing"), "x"); got != "x.yaml" {
		t.Fatalf("unreadable dir = %s", got)
	}
}

func TestExampleSidecarProblems(t *testing.T) {
	ws := newWS(t)
	col := mustCol(t, ws, "API")
	a := mustReq(t, ws, col.ID, model.Request{Name: "a"})
	b := mustReq(t, ws, col.ID, model.Request{Name: "b"})
	c := mustReq(t, ws, col.ID, model.Request{Name: "c"})
	mustExample(t, ws, c.ID, "kept")
	dir := filepath.Join(ws.Root(), CollectionsDir, "api")
	writeFile(t, filepath.Join(dir, "a.examples.yaml"), "examples: [")
	writeFile(t, filepath.Join(dir, "b.examples.yaml"), "requestId: SOMEONE\nexamples:\n  - id: X\n    name: theirs\n")
	writeFile(t, filepath.Join(dir, "orphan.examples.yaml"), "requestId: GONE\n")

	problems := ws.Reload()
	got := map[string]string{}
	for _, p := range problems {
		got[p.Path] = p.Message
	}
	for file, msg := range map[string]string{
		"a.examples.yaml":      "invalid YAML",
		"b.examples.yaml":      "belongs to request SOMEONE",
		"orphan.examples.yaml": "no request file next to it",
	} {
		if !strings.Contains(got["collections/api/"+file], msg) {
			t.Errorf("problem for %s = %q, want %q", file, got["collections/api/"+file], msg)
		}
	}
	if len(problems) != 3 {
		t.Fatalf("problems = %+v", problems)
	}
	// The rest of the workspace still loads, including good sidecars.
	if got := exampleNames(t, ws, c.ID); len(got) != 1 {
		t.Fatalf("good sidecar = %v", got)
	}

	// Writes refuse to replace a sidecar the app couldn't read.
	for _, id := range []string{a.ID, b.ID} {
		if _, err := ws.AddExample(id, sampleExample("new")); err == nil || !strings.Contains(err.Error(), "fix or remove it first") {
			t.Errorf("add to %s: err = %v", id, err)
		}
		if _, err := ws.GetExample(id, "X"); err == nil {
			t.Errorf("get from %s should fail", id)
		}
	}
	raw, _ := os.ReadFile(filepath.Join(dir, "b.examples.yaml"))
	if !strings.Contains(string(raw), "theirs") {
		t.Fatal("a foreign sidecar must be left alone")
	}
}

func TestExamplesUpgradeV1Manifest(t *testing.T) {
	dir := t.TempDir()
	v1 := "id: WS1\nname: Old\nversion: 1\n"
	writeFile(t, filepath.Join(dir, ManifestFile), v1)
	_ = os.MkdirAll(filepath.Join(dir, CollectionsDir, "api"), 0o755)
	writeFile(t, filepath.Join(dir, CollectionsDir, "api", CollectionFile), "id: C1\nname: API\n")
	writeFile(t, filepath.Join(dir, CollectionsDir, "api", "get.yaml"), "id: R1\nname: get\nmethod: GET\n")
	ws, err := Open(dir)
	if err != nil {
		t.Fatal(err)
	}
	// Tier 1 operations, including moves and renames without examples, keep v1.
	if _, err := ws.RenameRequest("R1", "fetch"); err != nil {
		t.Fatal(err)
	}
	if _, err := ws.DuplicateRequest("R1"); err != nil {
		t.Fatal(err)
	}
	if raw, _ := os.ReadFile(filepath.Join(dir, ManifestFile)); string(raw) != v1 {
		t.Fatalf("manifest rewritten:\n%s", raw)
	}
	if _, err := ws.AddExample("R1", sampleExample("OK")); err != nil {
		t.Fatal(err)
	}
	if ws.Manifest().Version != FormatVersion {
		t.Fatalf("version = %d", ws.Manifest().Version)
	}
	reopened, err := Open(dir)
	if err != nil || reopened.Manifest().Version != FormatVersion {
		t.Fatalf("reopened = %+v %v", reopened.Manifest(), err)
	}

	// A failed upgrade writes no sidecar.
	dir2 := t.TempDir()
	writeFile(t, filepath.Join(dir2, ManifestFile), v1)
	_ = os.MkdirAll(filepath.Join(dir2, CollectionsDir, "api"), 0o755)
	writeFile(t, filepath.Join(dir2, CollectionsDir, "api", CollectionFile), "id: C1\nname: API\n")
	writeFile(t, filepath.Join(dir2, CollectionsDir, "api", "get.yaml"), "id: R1\nname: get\n")
	ws2, err := Open(dir2)
	if err != nil {
		t.Fatal(err)
	}
	_ = os.Remove(filepath.Join(dir2, ManifestFile))
	_ = os.MkdirAll(filepath.Join(dir2, ManifestFile, "x"), 0o755)
	if _, err := ws2.AddExample("R1", sampleExample("OK")); err == nil || !strings.Contains(err.Error(), "upgrade") {
		t.Fatalf("err = %v", err)
	}
	if exists(filepath.Join(dir2, CollectionsDir, "api", "get.examples.yaml")) {
		t.Fatal("sidecar written despite the failed upgrade")
	}
}

func TestExampleWriteErrors(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("permission bits don't block writes on Windows")
	}
	if os.Geteuid() == 0 {
		t.Skip("root ignores permission bits")
	}
	ws := newWS(t)
	col := mustCol(t, ws, "API")
	r := mustReq(t, ws, col.ID, model.Request{Name: "login"})
	ex := mustExample(t, ws, r.ID, "OK")
	dir := filepath.Join(ws.Root(), CollectionsDir, "api")
	if err := os.Chmod(dir, 0o555); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = os.Chmod(dir, 0o755) })

	if _, err := ws.AddExample(r.ID, sampleExample("more")); err == nil {
		t.Error("add in a read-only folder should fail")
	}
	if err := ws.DeleteExample(r.ID, ex.ID); err == nil {
		t.Error("deleting the last example in a read-only folder should fail")
	}
	if err := ws.DeleteRequest(r.ID); err == nil || !strings.Contains(err.Error(), "examples") {
		t.Errorf("delete request err = %v", err)
	}
	if _, err := ws.RenameRequest(r.ID, "Sign in"); err == nil {
		t.Error("rename in a read-only folder should fail")
	}
	if got, err := ws.GetExample(r.ID, ex.ID); err != nil || got.Name != "OK" {
		t.Fatalf("example after failed writes = %+v %v", got, err)
	}
}

// moveExamples is a no-op without a sidecar and reports a failed rename.
func TestMoveExamples(t *testing.T) {
	ws := newWS(t)
	col := mustCol(t, ws, "API")
	r := mustReq(t, ws, col.ID, model.Request{Name: "login"})
	ex := mustExample(t, ws, r.ID, "OK")
	if err := ws.moveExamples(filepath.Join(ws.Root(), "nope.yaml"), filepath.Join(ws.Root(), "x.yaml")); err != nil {
		t.Fatalf("no sidecar to move: %v", err)
	}
	src := filepath.Join(ws.Root(), CollectionsDir, "api", "login.yaml")
	if err := ws.moveExamples(src, src); err != nil {
		t.Fatalf("same path: %v", err)
	}
	if err := ws.moveExamples(src, filepath.Join(ws.Root(), "missing", "login.yaml")); err == nil {
		t.Fatal("moving into a missing directory should fail")
	}
	if _, err := ws.GetExample(r.ID, ex.ID); err != nil {
		t.Fatalf("example lost: %v", err)
	}
}

func TestWatcherSeesExternalExampleChanges(t *testing.T) {
	ws := newWS(t)
	col := mustCol(t, ws, "API")
	r := mustReq(t, ws, col.ID, model.Request{Name: "login"})
	calls := watchCounting(t, ws)
	path := filepath.Join(ws.Root(), CollectionsDir, "api", "login.examples.yaml")

	writeFile(t, path, "requestId: "+r.ID+"\nexamples:\n  - id: EX1\n    name: From git\n    response:\n      statusCode: 201\n")
	waitFor(t, func() bool { return calls.Load() > 0 && len(ws.AllExamples()) == 1 })
	if got := ws.AllExamples()[0]; got.Name != "From git" || got.StatusCode != 201 {
		t.Fatalf("external example = %+v", got)
	}

	// The app's own example writes don't echo back.
	before := calls.Load()
	mustExample(t, ws, r.ID, "Mine")
	time.Sleep(4 * testDebounce)
	if calls.Load() != before {
		t.Fatal("own example write triggered a reload")
	}
}
