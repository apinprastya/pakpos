package codegen

import (
	"bytes"
	"errors"
	"flag"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"

	"pakpos/internal/core/model"
)

var update = flag.Bool("update", false, "rewrite the golden files in testdata")

func kv(k, v string) model.KeyValue  { return model.KeyValue{Key: k, Value: v, Enabled: true} }
func off(k, v string) model.KeyValue { return model.KeyValue{Key: k, Value: v} }

// cases cover every body type, auth applied as headers or query, repeated
// headers and fields, and strings that need escaping in every language.
var cases = []struct {
	name string
	req  model.Request
}{
	{"get", model.Request{Method: "GET", URL: "https://api.example.com/users/:id",
		PathParams: []model.KeyValue{kv("id", "42")},
		Query:      []model.KeyValue{kv("q", `say "hi" & go`), off("debug", "1")},
		Headers:    []model.KeyValue{kv("Accept", "application/json"), off("X-Off", "1")},
		Auth:       model.Auth{Type: model.AuthBearer, Token: "{{token}}"}}},
	{"raw_json", model.Request{Method: "POST", URL: "https://api.example.com/orders",
		Headers: []model.KeyValue{kv("X-Request-Id", "7f9c")},
		Body: model.Body{Type: model.BodyRaw, Language: model.LangJSON,
			Raw: `{"note": "it's \"quoted\" \\ $x ${y}", "items": [{"sku": "A-1", "qty": 2}], "gift": true, "ref": null, "price": 1.5e2, "empty": {}, "none": []}`},
		Auth: model.Auth{Type: model.AuthBasic, Username: "jane", Password: "{{password}}"}}},
	{"raw_json_unquoted_variable", model.Request{Method: "PUT", URL: "https://api.example.com/limits",
		Body: model.Body{Type: model.BodyRaw, Language: model.LangJSON, Raw: "{\n  \"max\": {{max}},\n  \"big\": 12345678901234567890\n}"}}},
	{"raw_text_multiline", model.Request{Method: "POST", URL: "https://example.com/notes",
		Headers: []model.KeyValue{kv("Content-Type", "text/plain")},
		Body:    model.Body{Type: model.BodyRaw, Language: model.LangText, Raw: "first line\nsecond `line` with café\ttab"}}},
	{"raw_xml_crlf", model.Request{Method: "POST", URL: "https://example.com/soap",
		Body: model.Body{Type: model.BodyRaw, Language: model.LangXML, Raw: "<a>\r\n  <b>x</b>\r\n</a>"}}},
	{"urlencoded", model.Request{Method: "POST", URL: "https://example.com/login",
		Body: model.Body{Type: model.BodyURLEncoded, URLEncoded: []model.KeyValue{
			kv("user", "jane@example.com"), kv("pass", "p&ss word"), kv("odd key", "v=1"), off("skip", "1"),
		}}}},
	{"urlencoded_repeated", model.Request{Method: "POST", URL: "https://example.com/tags",
		Body: model.Body{Type: model.BodyURLEncoded, URLEncoded: []model.KeyValue{kv("tag", "a"), kv("tag", "b")}}}},
	{"multipart", model.Request{Method: "POST", URL: "https://example.com/upload",
		Headers: []model.KeyValue{kv("Accept", "*/*")},
		Body: model.Body{Type: model.BodyFormData, FormData: []model.FormField{
			{Key: "title", Kind: model.FormText, Value: "Holiday \"2026\"", Enabled: true},
			{Key: "meta", Kind: model.FormText, Value: `{"a":1}`, ContentType: "application/json", Enabled: true},
			{Key: "photo", Kind: model.FormFile, FilePath: "/home/jane/My Pictures/beach.jpg", ContentType: "image/jpeg", Enabled: true},
			{Key: "doc", Kind: model.FormFile, FilePath: `C:\Users\jane\report.pdf`, Enabled: true},
			{Key: "title", Kind: model.FormText, Value: "again", Enabled: true},
			{Key: "off", Kind: model.FormText, Value: "x"},
		}}}},
	{"binary", model.Request{Method: "PATCH", URL: "https://example.com/blob/1",
		Body: model.Body{Type: model.BodyBinary, BinaryPath: "/data/blob.bin"}}},
	{"head_api_key_query", model.Request{Method: "HEAD", URL: "example.com/status",
		Auth: model.Auth{Type: model.AuthAPIKey, APIKey: "api_key", APIValue: "k 1", APIIn: model.APIKeyInQuery}}},
	{"custom_method_repeated_headers", model.Request{Method: "PURGE", URL: "https://cdn.example.com/x",
		Headers: []model.KeyValue{kv("Host", "origin.example.com"), kv("Cookie", "a=1"), kv("Cookie", "b=2"), kv("X-Empty", ""),
			kv("X-Api-Key", "set")},
		Auth: model.Auth{Type: model.AuthAPIKey, APIKey: "X-Api-Key", APIValue: "ignored"}}},
	{"delete_no_body", model.Request{Method: "DELETE", URL: "https://example.com/items/7"}},
}

var extensions = map[string]string{
	"curl": "sh", "javascript-fetch": "mjs", "javascript-fetch-browser": "mjs", "javascript-axios": "mjs", "python-requests": "py",
	"go-native": "go", "java-http": "java", "php-curl": "php",
}

func golden(t *testing.T, path string, got []byte) {
	t.Helper()
	if *update {
		if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(path, got, 0o644); err != nil {
			t.Fatal(err)
		}
		return
	}
	want, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("%v (run go test -update to create it)", err)
	}
	crlf := func(b []byte) []byte { return bytes.ReplaceAll(b, []byte("\r\n"), []byte("\n")) }
	if !bytes.Equal(crlf(want), crlf(got)) {
		t.Errorf("%s differs (run go test -update after checking):\n--- got ---\n%s\n--- want ---\n%s", path, got, want)
	}
}

func TestGolden(t *testing.T) {
	for _, lang := range Languages() {
		for _, c := range cases {
			t.Run(lang.ID+"/"+c.name, func(t *testing.T) {
				res, err := Generate(lang.ID, c.req)
				if err != nil {
					t.Fatal(err)
				}
				out := res.Code
				if len(res.Warnings) > 0 {
					out += "\n# warnings:\n# " + strings.Join(res.Warnings, "\n# ") + "\n"
				}
				golden(t, filepath.Join("testdata", lang.ID, c.name+"."+extensions[lang.ID]+".golden"), []byte(out))
			})
		}
	}
}

func TestLanguages(t *testing.T) {
	langs := Languages()
	if len(langs) != 8 || langs[0].ID != "curl" || langs[0].Editor != "shell" {
		t.Errorf("%+v", langs)
	}
	for _, l := range langs {
		if l.Label == "" || l.Editor == "" || extensions[l.ID] == "" {
			t.Errorf("incomplete %+v", l)
		}
	}
	if _, err := Generate("cobol", model.Request{}); !errors.Is(err, ErrUnknownLanguage) {
		t.Errorf("err = %v", err)
	}
}

func TestWarnings(t *testing.T) {
	res, err := Generate("python-requests", model.Request{URL: "https://a.com",
		Body: model.Body{Type: model.BodyBinary},
		Auth: model.Auth{Type: model.AuthAPIKey}})
	if err != nil {
		t.Fatal(err)
	}
	if len(res.Warnings) != 2 || !strings.Contains(res.Warnings[0], "key name") || !strings.Contains(res.Warnings[1], "No file") {
		t.Errorf("%+v", res.Warnings)
	}
	if strings.Contains(res.Code, "payload") {
		t.Errorf("binary without a file sent a body:\n%s", res.Code)
	}
}

func TestBrowserHelpers(t *testing.T) {
	used := map[string]bool{}
	got := []string{fileVar("photo", used), fileVar("photo", used), fileVar("my-cool doc", used), fileVar("2x", used), fileVar("--", used)}
	want := []string{"photoFile", "photoFile2", "myCoolDocFile", "field2xFile", "fieldFile"}
	for i := range want {
		if got[i] != want[i] {
			t.Errorf("fileVar %d = %q, want %q", i, got[i], want[i])
		}
	}
	for n := 1; n <= 12; n++ {
		fileVar("x", used)
	}
	if !used["xFile12"] {
		t.Error("numbering")
	}
	if browserAllowed("Cookie") || browserAllowed("Sec-Fetch-Mode") || browserAllowed("proxy-authorization") || !browserAllowed("X-Api-Key") {
		t.Error("browserAllowed")
	}
	if browserBase64("u:p") != `btoa("u:p")` || !strings.Contains(browserBase64("ü:p"), "TextEncoder") {
		t.Error("browserBase64")
	}
}

func TestStrings(t *testing.T) {
	tests := []struct {
		fn   func(string) string
		in   string
		want string
	}{
		{pyString, "a\"\\\n\r\t\x01é", `"a\"\\\n\r\t\x01é"`},
		{javaString, "a\"\\\n\r\t\b\f\x01é", `"a\"\\\n\r\t\b\f\001é"`},
		{goString, "plain", `"plain"`},
		{goString, `{"a":1}`, "`{\"a\":1}`"},
		{goString, "back`tick\"", "\"back`tick\\\"\""},
		{goString, "a\x01\"", `"a\x01\""`},
		{phpString, `it's a \ path`, `'it\'s a \\ path'`},
		{phpString, "a\r\n\t\"$\\\x01", `"a\r\n\t\"\$\\\x01"`},
		{jsString, "a\u2028</script>", `"a\u2028</script>"`},
		{jsText, "one\ntwo `${x}` \\", "`one\ntwo \\`\\${x}\\` \\\\`"},
		{jsText, "one\r\ntwo", `"one\r\ntwo"`},
	}
	for _, tt := range tests {
		if got := tt.fn(tt.in); got != tt.want {
			t.Errorf("%q: got %s, want %s", tt.in, got, tt.want)
		}
	}
	if _, ok := parseJSON(`{"a": 1`); ok {
		t.Error("invalid JSON parsed")
	}
	if !exactNumber("-0.000123456789012345") || exactNumber("1234567890123456") || !exactNumber("1e300") {
		t.Error("exactNumber")
	}
	if got := indentJSON("not json", "  "); got != "not json" {
		t.Error(got)
	}
	if fileName(`C:\a\b.txt`) != "b.txt" || fileName("b.txt") != "b.txt" {
		t.Error("fileName")
	}
}

// TestSyntax compiles or syntax-checks every golden file with the local
// toolchains (go, node, python3, javac, php). It is opt-in, since it needs
// them installed: PAKPOS_CODEGEN_SYNTAX=1 go test ./internal/core/codegen.
func TestSyntax(t *testing.T) {
	if os.Getenv("PAKPOS_CODEGEN_SYNTAX") == "" {
		t.Skip("set PAKPOS_CODEGEN_SYNTAX=1 to check the generated code with local toolchains")
	}
	type checker struct {
		tool string
		run  func(dir, file string) *exec.Cmd
	}
	checkers := map[string]checker{
		"curl":                     {"bash", func(_, f string) *exec.Cmd { return exec.Command("bash", "-n", f) }},
		"javascript-fetch":         {"node", func(_, f string) *exec.Cmd { return exec.Command("node", "--check", f) }},
		"javascript-axios":         {"node", func(_, f string) *exec.Cmd { return exec.Command("node", "--check", f) }},
		"javascript-fetch-browser": {"node", func(_, f string) *exec.Cmd { return exec.Command("node", "--check", f) }},
		"python-requests":          {"python3", func(_, f string) *exec.Cmd { return exec.Command("python3", "-m", "py_compile", f) }},
		"go-native": {"go", func(dir, _ string) *exec.Cmd {
			cmd := exec.Command("go", "vet", ".")
			cmd.Dir = dir
			return cmd
		}},
		"java-http": {"javac", func(dir, f string) *exec.Cmd { return exec.Command("javac", "-d", dir, f) }},
		"php-curl":  {"php", func(_, f string) *exec.Cmd { return exec.Command("php", "-l", f) }},
	}
	for _, lang := range Languages() {
		c := checkers[lang.ID]
		if _, err := exec.LookPath(c.tool); err != nil {
			t.Logf("%s: %s not found, skipped", lang.ID, c.tool)
			continue
		}
		for _, tc := range cases {
			t.Run(lang.ID+"/"+tc.name, func(t *testing.T) {
				res, err := Generate(lang.ID, tc.req)
				if err != nil {
					t.Fatal(err)
				}
				dir := t.TempDir()
				name := "main." + extensions[lang.ID]
				if lang.ID == "java-http" {
					name = "Main.java"
				}
				file := filepath.Join(dir, name)
				if err := os.WriteFile(file, []byte(res.Code), 0o644); err != nil {
					t.Fatal(err)
				}
				if lang.ID == "go-native" {
					if err := os.WriteFile(filepath.Join(dir, "go.mod"), []byte("module check\n\ngo 1.22\n"), 0o644); err != nil {
						t.Fatal(err)
					}
				}
				if out, err := c.run(dir, file).CombinedOutput(); err != nil {
					t.Errorf("%s: %v\n%s\n--- code ---\n%s", c.tool, err, out, res.Code)
				}
			})
		}
	}
}
