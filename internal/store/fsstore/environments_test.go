package fsstore

import (
	"errors"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"pakpos/internal/core/model"
)

func envPath(ws *Workspace, file string) string {
	return filepath.Join(ws.Root(), EnvironmentsDir, file)
}

func mustEnv(t *testing.T, ws *Workspace, name string) Environment {
	t.Helper()
	e, err := ws.CreateEnvironment(name)
	if err != nil {
		t.Fatal(err)
	}
	return e
}

func envNames(envs []Environment) []string {
	out := []string{}
	for _, e := range envs {
		out = append(out, e.Name)
	}
	return out
}

func TestEnvironmentsCRUD(t *testing.T) {
	ws := newWS(t)
	if got := ws.ListEnvironments(); len(got) != 0 {
		t.Fatalf("new workspace has environments: %+v", got)
	}

	dev := mustEnv(t, ws, "  Dev  ")
	if dev.Name != "Dev" || dev.Seq != 1 || dev.ID == "" || dev.Variables == nil {
		t.Fatalf("created %+v", dev)
	}
	if !exists(envPath(ws, "dev.yaml")) {
		t.Fatal("dev.yaml not written")
	}
	prod := mustEnv(t, ws, "Prod")
	unnamed := mustEnv(t, ws, "")
	if unnamed.Name != "New environment" || prod.Seq != 2 || unnamed.Seq != 3 {
		t.Fatalf("prod=%+v unnamed=%+v", prod, unnamed)
	}
	if got := envNames(ws.ListEnvironments()); !reflect.DeepEqual(got, []string{"Dev", "Prod", "New environment"}) {
		t.Fatalf("list = %v", got)
	}

	// Save variables: secret values never reach the file or the result.
	vars := []model.Variable{
		{Key: " baseUrl ", Value: "https://dev.example.com", Enabled: true},
		{Key: "token", Value: "s3cret", Enabled: true, Secret: true},
		{Key: "off", Value: "x"},
	}
	saved, err := ws.SaveEnvironmentVariables(dev.ID, vars)
	if err != nil {
		t.Fatal(err)
	}
	want := []model.Variable{
		{Key: "baseUrl", Value: "https://dev.example.com", Enabled: true},
		{Key: "token", Enabled: true, Secret: true},
		{Key: "off", Value: "x"},
	}
	if !reflect.DeepEqual(saved.Variables, want) {
		t.Fatalf("saved = %+v", saved.Variables)
	}
	if vars[1].Value != "s3cret" {
		t.Fatal("input mutated")
	}
	raw, _ := os.ReadFile(envPath(ws, "dev.yaml"))
	if strings.Contains(string(raw), "s3cret") || !strings.Contains(string(raw), "secret: true") {
		t.Fatalf("dev.yaml:\n%s", raw)
	}
	got, err := ws.GetEnvironment(dev.ID)
	if err != nil || !reflect.DeepEqual(got.Variables, want) {
		t.Fatalf("get = %+v %v", got, err)
	}
	got.Variables[0].Value = "mutated"
	if again, _ := ws.GetEnvironment(dev.ID); again.Variables[0].Value == "mutated" {
		t.Fatal("GetEnvironment returned shared slice")
	}

	// Rename renames the file and keeps the id and variables.
	renamed, err := ws.RenameEnvironment(dev.ID, "Development")
	if err != nil || renamed.ID != dev.ID || len(renamed.Variables) != 3 {
		t.Fatalf("rename = %+v %v", renamed, err)
	}
	if exists(envPath(ws, "dev.yaml")) || !exists(envPath(ws, "development.yaml")) {
		t.Fatal("file not renamed")
	}
	// Same slug: file name kept.
	if _, err := ws.RenameEnvironment(dev.ID, "development"); err != nil || !exists(envPath(ws, "development.yaml")) {
		t.Fatalf("rename same slug: %v", err)
	}
	// Slug taken by another environment: gets a suffix.
	if _, err := ws.RenameEnvironment(unnamed.ID, "Prod"); err != nil || !exists(envPath(ws, "prod-2.yaml")) {
		t.Fatalf("rename to taken slug: %v", err)
	}

	// Duplicate.
	dup, err := ws.DuplicateEnvironment(dev.ID)
	if err != nil {
		t.Fatal(err)
	}
	if dup.ID == dev.ID || dup.Name != "development copy" || dup.Seq != 4 || !reflect.DeepEqual(dup.Variables, want) {
		t.Fatalf("dup = %+v", dup)
	}
	if !exists(envPath(ws, "development-copy.yaml")) {
		t.Fatal("duplicate file missing")
	}

	// Reorder.
	if err := ws.ReorderEnvironments([]string{prod.ID, dup.ID}); err != nil {
		t.Fatal(err)
	}
	if got := envNames(ws.ListEnvironments()); !reflect.DeepEqual(got, []string{"Prod", "development copy", "development", "Prod"}) {
		t.Fatalf("after reorder = %v", got)
	}
	if err := ws.ReorderEnvironments([]string{"nope"}); !errors.Is(err, ErrNotFound) {
		t.Fatalf("reorder unknown = %v", err)
	}

	// Delete.
	if err := ws.DeleteEnvironment(dup.ID); err != nil {
		t.Fatal(err)
	}
	if exists(envPath(ws, "development-copy.yaml")) {
		t.Fatal("file not deleted")
	}

	// Everything survives a reopen.
	before := ws.ListEnvironments()
	reopened, err := Open(ws.Root())
	if err != nil {
		t.Fatal(err)
	}
	if after := reopened.ListEnvironments(); !reflect.DeepEqual(after, before) {
		t.Fatalf("reopen:\n got %+v\nwant %+v", after, before)
	}
	if len(reopened.Tree().Problems) != 0 {
		t.Fatalf("problems: %+v", reopened.Tree().Problems)
	}
}

func TestEnvironmentNotFound(t *testing.T) {
	ws := newWS(t)
	calls := map[string]error{}
	_, calls["get"] = ws.GetEnvironment("x")
	_, calls["rename"] = ws.RenameEnvironment("x", "y")
	_, calls["duplicate"] = ws.DuplicateEnvironment("x")
	_, calls["save"] = ws.SaveEnvironmentVariables("x", nil)
	calls["delete"] = ws.DeleteEnvironment("x")
	for name, err := range calls {
		if !errors.Is(err, ErrNotFound) {
			t.Errorf("%s: err = %v", name, err)
		}
	}
}

func TestEnvironmentFileVanished(t *testing.T) {
	ws := newWS(t)
	e := mustEnv(t, ws, "Dev")
	_ = os.Remove(envPath(ws, "dev.yaml"))
	if err := ws.DeleteEnvironment(e.ID); err != nil {
		t.Fatalf("delete of a vanished file = %v", err)
	}
}

func TestGlobals(t *testing.T) {
	ws := newWS(t)
	g := ws.GetGlobals()
	if g.ID == "" || g.Variables == nil || len(g.Variables) != 0 {
		t.Fatalf("empty globals = %+v", g)
	}
	if exists(envPath(ws, GlobalsFile)) {
		t.Fatal("GetGlobals must not create the file")
	}
	if again := ws.GetGlobals(); again.ID != g.ID {
		t.Fatal("pending globals id must be stable")
	}
	saved, err := ws.SaveGlobals([]model.Variable{{Key: "host", Value: "h", Enabled: true}, {Key: "pw", Value: "p", Secret: true, Enabled: true}})
	if err != nil {
		t.Fatal(err)
	}
	if saved.ID != g.ID || saved.Variables[1].Value != "" {
		t.Fatalf("saved = %+v", saved)
	}
	raw, _ := os.ReadFile(envPath(ws, GlobalsFile))
	if strings.Contains(string(raw), "value: p") {
		t.Fatalf("secret written:\n%s", raw)
	}
	if got := ws.GetGlobals(); !reflect.DeepEqual(got, saved) {
		t.Fatalf("get = %+v", got)
	}
	// _globals.yaml is not listed as an environment.
	if n := len(ws.ListEnvironments()); n != 0 {
		t.Fatalf("environments = %d", n)
	}
	reopened, _ := Open(ws.Root())
	if got := reopened.GetGlobals(); !reflect.DeepEqual(got, saved) {
		t.Fatalf("reopened globals = %+v", got)
	}
	if _, err := reopened.SaveGlobals(nil); err != nil {
		t.Fatal(err)
	}
	if got := reopened.GetGlobals(); got.ID != g.ID || len(got.Variables) != 0 {
		t.Fatalf("cleared globals = %+v", got)
	}

	// The file disappears (git checkout): the id is kept for the next save.
	_ = os.Remove(envPath(reopened, GlobalsFile))
	reopened.Reload()
	if got := reopened.GetGlobals(); got.ID != g.ID {
		t.Fatalf("id after file removal = %s, want %s", got.ID, g.ID)
	}
	if saved, _ := reopened.SaveGlobals(nil); saved.ID != g.ID {
		t.Fatal("save after removal should reuse the id")
	}

	// SaveGlobals without a prior GetGlobals assigns an id.
	fresh := newWS(t)
	if s, err := fresh.SaveGlobals(nil); err != nil || s.ID == "" {
		t.Fatalf("fresh save = %+v %v", s, err)
	}
}

func TestEnvironmentLoadProblems(t *testing.T) {
	ws := newWS(t)
	dir := filepath.Join(ws.Root(), EnvironmentsDir)
	_ = os.MkdirAll(filepath.Join(dir, "subdir"), 0o755)
	files := map[string]string{
		"good.yaml":     "id: E1\nname: Good\nseq: 1\nvariables:\n  - key: a\n    value: b\n    enabled: true\n",
		"noname.yml":    "id: E2\n",
		"dup.yaml":      "id: E1\nname: Dup\n",
		"bad.yaml":      "id: [\n",
		"noid.yaml":     "name: x\n",
		"_future.yaml":  "id: F\n",
		".hidden.yaml":  "id: H\n",
		"notes.txt":     "x",
		GlobalsFile:     "variables: []\n",
		"subdir/x.yaml": "id: S\n",
	}
	for name, content := range files {
		_ = os.WriteFile(filepath.Join(dir, name), []byte(content), 0o644)
	}
	problems := ws.Reload()
	paths := map[string]string{}
	for _, p := range problems {
		paths[p.Path] = p.Message
	}
	wantProblems := []string{"environments/bad.yaml", "environments/noid.yaml", "environments/" + GlobalsFile}
	if len(problems) != len(wantProblems)+1 { // + the duplicate (good or dup, whichever loads second)
		t.Fatalf("problems = %+v", problems)
	}
	for _, p := range wantProblems {
		if _, ok := paths[p]; !ok {
			t.Errorf("missing problem for %s in %+v", p, problems)
		}
	}
	envs := ws.ListEnvironments()
	if len(envs) != 2 {
		t.Fatalf("envs = %+v", envs)
	}
	if e, err := ws.GetEnvironment("E2"); err != nil || e.Name != "noname" || e.Variables == nil {
		t.Fatalf("E2 = %+v %v", e, err)
	}
	if ws.GetGlobals().ID == "" {
		t.Fatal("globals without id should still give a pending id")
	}

	_ = os.WriteFile(filepath.Join(dir, GlobalsFile), []byte("id: [\n"), 0o644)
	if problems := ws.Reload(); len(problems) != 4 {
		t.Fatalf("problems = %+v", problems)
	}
}

func TestEnvironmentsDirUnreadable(t *testing.T) {
	ws := newWS(t)
	// environments is a file: reported as a problem, and writes fail cleanly.
	envDir := filepath.Join(ws.Root(), EnvironmentsDir)
	if err := os.RemoveAll(envDir); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(envDir, []byte("x"), 0o644); err != nil {
		t.Fatal(err)
	}
	problems := ws.Reload()
	if len(problems) != 1 || problems[0].Path != EnvironmentsDir {
		t.Fatalf("problems = %+v", problems)
	}
	if _, err := ws.CreateEnvironment("Dev"); err == nil {
		t.Fatal("create should fail")
	}
	if _, err := ws.SaveGlobals(nil); err == nil {
		t.Fatal("save globals should fail")
	}
}

func TestManifestV1StaysUntilV2Write(t *testing.T) {
	dir := t.TempDir()
	v1 := "id: WS1\nname: Old\nversion: 1\n"
	_ = os.WriteFile(filepath.Join(dir, ManifestFile), []byte(v1), 0o644)
	_ = os.MkdirAll(filepath.Join(dir, CollectionsDir, "api"), 0o755)
	// A Tier 1 collection with key/value variables still loads.
	_ = os.WriteFile(filepath.Join(dir, CollectionsDir, "api", CollectionFile),
		[]byte("id: C1\nname: API\nvariables:\n  - key: host\n    value: example.com\n    enabled: true\n"), 0o644)

	ws, err := Open(dir)
	if err != nil {
		t.Fatal(err)
	}
	if ws.Manifest().Version != 1 {
		t.Fatalf("version = %d", ws.Manifest().Version)
	}
	col, err := ws.GetCollection("C1")
	if err != nil || !reflect.DeepEqual(col.Variables, []model.Variable{{Key: "host", Value: "example.com", Enabled: true}}) {
		t.Fatalf("collection = %+v %v", col, err)
	}
	// Tier 1 operations and reads don't touch the manifest.
	if _, err := ws.CreateRequest("C1", model.Request{Name: "r"}); err != nil {
		t.Fatal(err)
	}
	_ = ws.ListEnvironments()
	_ = ws.GetGlobals()
	if raw, _ := os.ReadFile(filepath.Join(dir, ManifestFile)); string(raw) != v1 {
		t.Fatalf("manifest rewritten:\n%s", raw)
	}

	// The first environment upgrades it.
	if _, err := ws.CreateEnvironment("Dev"); err != nil {
		t.Fatal(err)
	}
	if ws.Manifest().Version != FormatVersion {
		t.Fatalf("version = %d", ws.Manifest().Version)
	}
	reopened, err := Open(dir)
	if err != nil || reopened.Manifest() != (Manifest{ID: "WS1", Name: "Old", Version: FormatVersion}) {
		t.Fatalf("reopened = %+v %v", reopened.Manifest(), err)
	}
}

func TestManifestUpgradeFailure(t *testing.T) {
	dir := t.TempDir()
	_ = os.WriteFile(filepath.Join(dir, ManifestFile), []byte("id: WS1\nversion: 1\n"), 0o644)
	ws, err := Open(dir)
	if err != nil {
		t.Fatal(err)
	}
	// Replace the manifest with a directory so the atomic rename fails.
	_ = os.Remove(filepath.Join(dir, ManifestFile))
	_ = os.MkdirAll(filepath.Join(dir, ManifestFile, "x"), 0o755)
	if _, err := ws.CreateEnvironment("Dev"); err == nil || !strings.Contains(err.Error(), "upgrade") {
		t.Fatalf("err = %v", err)
	}
	if ws.Manifest().Version != 1 {
		t.Fatal("version must stay 1 when the upgrade fails")
	}
}

func TestWatcherSeesExternalEnvironmentChanges(t *testing.T) {
	ws := newWS(t)
	var calls atomic.Int32
	w, err := ws.Watch(testDebounce, func([]Problem) { calls.Add(1) })
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = w.Close() })

	// environments/ created externally (git pull): the watcher picks it up.
	dir := filepath.Join(ws.Root(), EnvironmentsDir)
	if err := os.Mkdir(dir, 0o755); err != nil {
		t.Fatal(err)
	}
	waitFor(t, func() bool { return calls.Load() >= 1 })
	// The watch on the new folder is added asynchronously; give it a moment
	// (rewriting the file in a loop would keep resetting the debounce).
	time.Sleep(5 * testDebounce)
	_ = os.WriteFile(filepath.Join(dir, "ext.yaml"), []byte("id: EXT\nname: External\n"), 0o644)
	waitFor(t, func() bool { _, err := ws.GetEnvironment("EXT"); return err == nil })

	// Edits to an existing file show up.
	_ = os.WriteFile(filepath.Join(dir, "ext.yaml"), []byte("id: EXT\nname: Edited\n"), 0o644)
	waitFor(t, func() bool { e, _ := ws.GetEnvironment("EXT"); return e.Name == "Edited" })
	_ = os.WriteFile(filepath.Join(dir, GlobalsFile), []byte("id: G\nvariables:\n  - key: a\n    value: b\n    enabled: true\n"), 0o644)
	waitFor(t, func() bool { return ws.GetGlobals().ID == "G" })
}

func TestWatcherIgnoresOwnEnvironmentWrites(t *testing.T) {
	ws := newWS(t)
	var calls atomic.Int32
	w, err := ws.Watch(testDebounce, func([]Problem) { calls.Add(1) })
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = w.Close() })
	e := mustEnv(t, ws, "Dev") // creates environments/ and watches it synchronously
	if _, err := ws.SaveEnvironmentVariables(e.ID, []model.Variable{{Key: "a", Value: "b", Enabled: true}}); err != nil {
		t.Fatal(err)
	}
	if _, err := ws.RenameEnvironment(e.ID, "Development"); err != nil {
		t.Fatal(err)
	}
	if _, err := ws.SaveGlobals(nil); err != nil {
		t.Fatal(err)
	}
	if err := ws.DeleteEnvironment(e.ID); err != nil {
		t.Fatal(err)
	}
	time.Sleep(10 * testDebounce)
	if n := calls.Load(); n != 0 {
		t.Fatalf("callbacks = %d, want 0", n)
	}

	// An external change right after is still seen (the folder is watched).
	_ = os.WriteFile(envPath(ws, "ext.yaml"), []byte("id: EXT\nname: Ext\n"), 0o644)
	waitFor(t, func() bool { _, err := ws.GetEnvironment("EXT"); return err == nil })
}

func TestWatcherEnvironmentRelevance(t *testing.T) {
	ws := newWS(t)
	w, err := ws.Watch(testDebounce, nil)
	if err != nil {
		t.Fatal(err)
	}
	defer w.Close()
	if !w.relevant(envPath(ws, "dev.yaml")) || w.relevant(envPath(ws, tempPrefix+"1")) {
		t.Fatal("relevance of environments/ files is wrong")
	}
}
