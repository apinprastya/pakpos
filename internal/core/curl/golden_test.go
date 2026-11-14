package curl

import (
	"bytes"
	"encoding/json"
	"flag"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

var update = flag.Bool("update", false, "rewrite the golden files in testdata")

// golden compares got with the file at path, or writes it with -update.
func golden(t *testing.T, path string, got []byte) {
	t.Helper()
	if *update {
		if err := os.WriteFile(path, got, 0o644); err != nil {
			t.Fatal(err)
		}
		return
	}
	want, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("%v (run go test -update to create it)", err)
	}
	if !bytes.Equal(bytes.ReplaceAll(want, []byte("\r\n"), []byte("\n")), got) {
		t.Errorf("%s differs (run go test -update after checking):\n--- got ---\n%s\n--- want ---\n%s", path, got, want)
	}
}

// marshal writes v as indented JSON without HTML escaping, ending in a newline.
func marshal(t *testing.T, v any) []byte {
	t.Helper()
	var b bytes.Buffer
	enc := json.NewEncoder(&b)
	enc.SetEscapeHTML(false)
	enc.SetIndent("", "  ")
	if err := enc.Encode(v); err != nil {
		t.Fatal(err)
	}
	return b.Bytes()
}

// TestSamples parses real-world commands (browser devtools, API docs,
// Postman) and compares the result with testdata/samples/*.golden.json.
func TestSamples(t *testing.T) {
	files, err := filepath.Glob("testdata/samples/*.txt")
	if err != nil || len(files) == 0 {
		t.Fatalf("no samples: %v", err)
	}
	for _, f := range files {
		name := strings.TrimSuffix(filepath.Base(f), ".txt")
		t.Run(name, func(t *testing.T) {
			text, err := os.ReadFile(f)
			if err != nil {
				t.Fatal(err)
			}
			req, warnings, err := Parse(string(text))
			if err != nil {
				t.Fatalf("Parse: %v", err)
			}
			if warnings == nil {
				warnings = []Warning{}
			}
			golden(t, strings.TrimSuffix(f, ".txt")+".golden.json", marshal(t, map[string]any{"request": req, "warnings": warnings}))
		})
	}
}
