package fsstore

import (
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"pakpos/internal/core/inherit"
	"pakpos/internal/core/model"
)

// openVersion opens a workspace whose manifest has the given version.
func openVersion(t *testing.T, version int) (*Workspace, string) {
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

func readFile(t *testing.T, path string) string {
	t.Helper()
	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	return string(data)
}

var sampleScripts = model.Scripts{
	PreRequest: "pm.environment.set(\"ts\", Date.now());\nconsole.log('pre: ünïcode ✓');\n",
	Test:       "pm.test(\"ok\", () => {\n  pm.response.to.have.status(200);\n});",
}

func TestRequestScriptsYAML(t *testing.T) {
	ws, dir := openVersion(t, VersionV2)
	c, err := ws.CreateCollection("API")
	if err != nil {
		t.Fatal(err)
	}
	plain, err := ws.CreateRequest(c.ID, model.Request{Name: "Plain", URL: "http://x"})
	if err != nil {
		t.Fatal(err)
	}
	if ws.Manifest().Version != VersionV2 {
		t.Fatalf("a request without scripts upgraded the manifest to %d", ws.Manifest().Version)
	}
	file := filepath.Join(dir, CollectionsDir, "api", "plain.yaml")
	if strings.Contains(readFile(t, file), "scripts") {
		t.Errorf("empty scripts written:\n%s", readFile(t, file))
	}

	plain.Scripts = sampleScripts
	if _, err := ws.SaveRequest(plain); err != nil {
		t.Fatal(err)
	}
	if ws.Manifest().Version != FormatVersion || !strings.Contains(readFile(t, filepath.Join(dir, ManifestFile)), "version: 3") {
		t.Fatalf("manifest not upgraded: %d", ws.Manifest().Version)
	}
	text := readFile(t, file)
	for _, want := range []string{
		"scripts:\n  preRequest: |\n    pm.environment.set(\"ts\", Date.now());\n    console.log('pre: ünïcode ✓');\n",
		"  test: |-\n    pm.test(\"ok\", () => {\n      pm.response.to.have.status(200);\n    });\n",
	} {
		if !strings.Contains(text, want) {
			t.Errorf("file lacks %q:\n%s", want, text)
		}
	}
	got, err := ws.GetRequest(plain.ID)
	if err != nil {
		t.Fatal(err)
	}
	if got.Scripts != sampleScripts {
		t.Errorf("round trip = %+v", got.Scripts)
	}

	// One script only; the other key is left out.
	got.Scripts = model.Scripts{Test: "pm.test('x', () => {})"}
	if _, err := ws.SaveRequest(got); err != nil {
		t.Fatal(err)
	}
	if text := readFile(t, file); strings.Contains(text, "preRequest") || !strings.Contains(text, "  test: |-\n    pm.test('x', () => {})\n") {
		t.Errorf("file:\n%s", text)
	}
}

func TestScriptsCreateUpgrades(t *testing.T) {
	ws, _ := openVersion(t, 1)
	c, err := ws.CreateCollection("API")
	if err != nil {
		t.Fatal(err)
	}
	if _, err := ws.CreateRequest(c.ID, model.Request{Name: "S", Scripts: model.Scripts{PreRequest: "1"}}); err != nil {
		t.Fatal(err)
	}
	if ws.Manifest().Version != FormatVersion {
		t.Errorf("version = %d", ws.Manifest().Version)
	}
}

func TestScriptsBlockStyleFallback(t *testing.T) {
	// Trailing spaces can't be kept in a block scalar; yaml.v3 quotes the
	// value instead, and it still round-trips.
	s := model.Scripts{PreRequest: "a = 1;   \n\tb = 2;\n"}
	ws, _ := openVersion(t, FormatVersion)
	c, err := ws.CreateCollection("API")
	if err != nil {
		t.Fatal(err)
	}
	r, err := ws.CreateRequest(c.ID, model.Request{Name: "S", Scripts: s})
	if err != nil {
		t.Fatal(err)
	}
	got, err := ws.GetRequest(r.ID)
	if err != nil {
		t.Fatal(err)
	}
	if got.Scripts != s {
		t.Errorf("round trip = %q", got.Scripts.PreRequest)
	}
}

func TestFolderAndCollectionScripts(t *testing.T) {
	ws, dir := openVersion(t, VersionV2)
	c, err := ws.CreateCollection("API")
	if err != nil {
		t.Fatal(err)
	}
	f, err := ws.CreateFolder(c.ID, "Auth")
	if err != nil {
		t.Fatal(err)
	}
	r, err := ws.CreateRequest(f.ID, model.Request{Name: "Login"})
	if err != nil {
		t.Fatal(err)
	}

	// Settings without scripts stay v2.
	if _, err := ws.SaveFolder(f.ID, FolderSettings{Headers: []model.KeyValue{{Key: "A", Value: "1", Enabled: true}}}); err != nil {
		t.Fatal(err)
	}
	if _, err := ws.SaveCollection(c.ID, CollectionSettings{}); err != nil {
		t.Fatal(err)
	}
	if ws.Manifest().Version != VersionV2 {
		t.Fatalf("version = %d", ws.Manifest().Version)
	}

	folderScripts := model.Scripts{PreRequest: "console.log('folder')"}
	if _, err := ws.SaveFolder(f.ID, FolderSettings{Scripts: &folderScripts}); err != nil {
		t.Fatal(err)
	}
	if ws.Manifest().Version != FormatVersion {
		t.Fatalf("folder scripts: version = %d", ws.Manifest().Version)
	}
	colScripts := model.Scripts{Test: "console.log('collection')\n"}
	if _, err := ws.SaveCollection(c.ID, CollectionSettings{Scripts: &colScripts}); err != nil {
		t.Fatal(err)
	}

	// nil Scripts keeps them.
	if _, err := ws.SaveFolder(f.ID, FolderSettings{Headers: []model.KeyValue{}}); err != nil {
		t.Fatal(err)
	}
	if _, err := ws.SaveCollection(c.ID, CollectionSettings{Variables: []model.Variable{{Key: "a", Value: "1", Enabled: true}}}); err != nil {
		t.Fatal(err)
	}
	if text := readFile(t, filepath.Join(dir, CollectionsDir, "api", "auth", FolderFile)); !strings.Contains(text, "scripts:\n  preRequest: |-\n    console.log('folder')\n") {
		t.Errorf("folder file:\n%s", text)
	}
	if text := readFile(t, filepath.Join(dir, CollectionsDir, "api", CollectionFile)); !strings.Contains(text, "scripts:\n  test: |\n    console.log('collection')\n") {
		t.Errorf("collection file:\n%s", text)
	}

	// They survive a reload from disk and reach the inheritance chain.
	ws2, err := Open(dir)
	if err != nil {
		t.Fatal(err)
	}
	chain, err := ws2.InheritChain(r.ID)
	if err != nil {
		t.Fatal(err)
	}
	want := []inherit.Level{
		{Kind: inherit.KindCollection, ID: c.ID, Name: "API", Scripts: colScripts},
		{Kind: inherit.KindFolder, ID: f.ID, Name: "Auth", Scripts: folderScripts},
	}
	if len(chain) != 2 || chain[0].Scripts != want[0].Scripts || chain[1].Scripts != want[1].Scripts || chain[0].Kind != want[0].Kind || chain[1].ID != f.ID {
		t.Errorf("chain = %+v", chain)
	}
	got, err := ws2.GetFolder(f.ID)
	if err != nil || got.Scripts != folderScripts {
		t.Errorf("folder = %+v, %v", got, err)
	}
	col, err := ws2.GetCollection(c.ID)
	if err != nil || col.Scripts != colScripts {
		t.Errorf("collection = %+v, %v", col, err)
	}

	// Empty scripts clear them.
	if _, err := ws.SaveFolder(f.ID, FolderSettings{Scripts: &model.Scripts{}}); err != nil {
		t.Fatal(err)
	}
	if text := readFile(t, filepath.Join(dir, CollectionsDir, "api", "auth", FolderFile)); strings.Contains(text, "scripts") {
		t.Errorf("folder file:\n%s", text)
	}
}

func TestScriptsUpgradeFailure(t *testing.T) {
	if os.Getenv("GOOS") == "windows" || os.PathSeparator == '\\' {
		t.Skip("chmod doesn't make writes fail on Windows")
	}
	ws, dir := openVersion(t, VersionV2)
	c, err := ws.CreateCollection("API")
	if err != nil {
		t.Fatal(err)
	}
	f, err := ws.CreateFolder(c.ID, "Auth")
	if err != nil {
		t.Fatal(err)
	}
	if err := os.Chmod(dir, 0o500); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = os.Chmod(dir, 0o755) })
	if os.Getuid() == 0 {
		t.Skip("root ignores permissions")
	}
	s := model.Scripts{Test: "1"}
	if _, err := ws.SaveCollection(c.ID, CollectionSettings{Scripts: &s}); err == nil {
		t.Error("collection: no error")
	}
	if _, err := ws.SaveFolder(f.ID, FolderSettings{Scripts: &s}); err == nil {
		t.Error("folder: no error")
	}
}
