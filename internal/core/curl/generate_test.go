package curl

import (
	"path/filepath"
	"reflect"
	"strings"
	"testing"

	"pakpos/internal/core/auth"
	"pakpos/internal/core/model"
	"pakpos/internal/core/urlx"
)

func off(k, v string) model.KeyValue { return model.KeyValue{Key: k, Value: v} }

// matrix is a set of requests covering every body type, auth type and the
// quoting edge cases. Generate is checked against golden files and the
// round trip parse(generate(r)) ≈ r.
var matrix = []struct {
	name string
	req  model.Request
}{
	{"get_query", model.Request{Method: "get", URL: "api.example.com/users/:id?ignored=1",
		PathParams: []model.KeyValue{kv("id", "42")},
		Query:      []model.KeyValue{kv("q", "a b&c"), off("debug", "1"), kv("tag", "x"), kv("tag", "y")},
		Headers:    []model.KeyValue{kv("Accept", "application/json"), off("X-Off", "1"), kv(" ", "no key"), kv("X-Empty", "")},
		Auth:       model.Auth{Type: model.AuthNone}}},
	{"post_json_bearer", model.Request{Method: "POST", URL: "https://api.example.com/orders",
		Body: model.Body{Type: model.BodyRaw, Language: model.LangJSON, Raw: "{\n  \"note\": \"it's here\",\n  \"n\": 1\n}"},
		Auth: model.Auth{Type: model.AuthBearer, Token: "tok-123"}}},
	{"put_xml_custom_type", model.Request{Method: "PUT", URL: "https://example.com/feed",
		Headers: []model.KeyValue{kv("Content-Type", "text/xml")},
		Body:    model.Body{Type: model.BodyRaw, Language: model.LangXML, Raw: `<a b="c">d</a>`}}},
	{"post_text_control_chars", model.Request{Method: "POST", URL: "https://example.com/t",
		Body: model.Body{Type: model.BodyRaw, Language: model.LangText, Raw: "tab\there\r\nback\\slash 'q'"}}},
	{"urlencoded_basic", model.Request{Method: "POST", URL: "https://example.com/login",
		Body: model.Body{Type: model.BodyURLEncoded, URLEncoded: []model.KeyValue{
			kv("user", "jane@example.com"), kv("pass", "p&ss word"), kv("odd key", "v=1"), off("skip", "1"), kv("", ""),
		}},
		Auth: model.Auth{Type: model.AuthBasic, Username: "jane", Password: "s3cr'et"}}},
	{"form_data", model.Request{Method: "POST", URL: "https://example.com/upload",
		Body: model.Body{Type: model.BodyFormData, FormData: []model.FormField{
			{Key: "title", Kind: model.FormText, Value: "Holiday", Enabled: true},
			{Key: "meta", Kind: model.FormText, Value: "{\"a\":1}", ContentType: "application/json", Enabled: true},
			{Key: "tricky", Kind: model.FormText, Value: "@not;a file", Enabled: true},
			{Key: "photo", Kind: model.FormFile, FilePath: "/home/jane/My Pictures/beach.jpg", ContentType: "image/jpeg", Enabled: true},
			{Key: "doc", Kind: model.FormFile, FilePath: "/tmp/a.pdf", Enabled: true},
			{Key: "off", Kind: model.FormText, Value: "x"},
		}}}},
	{"binary_patch", model.Request{Method: "PATCH", URL: "https://example.com/blob/1",
		Body: model.Body{Type: model.BodyBinary, BinaryPath: "/data/blob.bin"}}},
	{"get_with_body", model.Request{Method: "GET", URL: "https://example.com/search",
		Body: model.Body{Type: model.BodyRaw, Language: model.LangJSON, Raw: `{"q":1}`}}},
	{"head", model.Request{Method: "HEAD", URL: "https://example.com/"}},
	{"delete_api_key_query", model.Request{Method: "DELETE", URL: "https://example.com/items/{{itemId}}",
		Query: []model.KeyValue{kv("v", "2")},
		Auth:  model.Auth{Type: model.AuthAPIKey, APIKey: "api_key", APIValue: "{{apiKey}}", APIIn: model.APIKeyInQuery}}},
	{"api_key_header", model.Request{Method: "OPTIONS", URL: "https://example.com/",
		Auth: model.Auth{Type: model.AuthAPIKey, APIKey: "X-Api-Key", APIValue: "k"}}},
}

func TestGenerateGolden(t *testing.T) {
	for _, m := range matrix {
		t.Run(m.name, func(t *testing.T) {
			golden(t, filepath.Join("testdata", "generate", m.name+".sh"), []byte(Generate(m.req)+"\n"))
		})
	}
}

// normalize reduces a request to what is sent, so a request and its
// round-tripped copy can be compared.
func normalize(t *testing.T, r model.Request) model.Request {
	t.Helper()
	r, err := auth.Materialize(r, true)
	if err != nil {
		t.Fatal(err)
	}
	out := model.Request{
		Method: strings.ToUpper(r.Method),
		URL:    urlx.SendURL(r),
		Auth:   r.Auth,
		Body:   model.Body{Type: r.Body.Type},
	}
	if out.Method == "" {
		out.Method = "GET"
	}
	if out.Body.Type == "" {
		out.Body.Type = model.BodyNone
	}
	def := r.Body.DefaultContentType()
	for _, h := range enabledHeaders(r.Headers) {
		if strings.EqualFold(h.Key, "Content-Type") && h.Value == def {
			continue
		}
		out.Headers = append(out.Headers, h)
	}
	switch r.Body.Type {
	case model.BodyRaw:
		out.Body.Raw, out.Body.Language = r.Body.Raw, r.Body.Language
	case model.BodyURLEncoded:
		for _, row := range r.Body.URLEncoded {
			if row.Enabled && (row.Key != "" || row.Value != "") {
				out.Body.URLEncoded = append(out.Body.URLEncoded, row)
			}
		}
	case model.BodyFormData:
		for _, f := range r.Body.FormData {
			if f.Enabled && f.Key != "" {
				if f.Kind == model.FormText && strings.Contains(f.Value, ";") {
					f.ContentType = "" // sent with --form-string, which has no type
				}
				out.Body.FormData = append(out.Body.FormData, f)
			}
		}
	case model.BodyBinary:
		out.Body.BinaryPath = r.Body.BinaryPath
	}
	return out
}

func TestRoundTrip(t *testing.T) {
	for _, m := range matrix {
		t.Run(m.name, func(t *testing.T) {
			cmd := Generate(m.req)
			got, warnings, err := Parse(cmd)
			if err != nil {
				t.Fatalf("Parse(%s): %v", cmd, err)
			}
			if len(warnings) > 0 {
				t.Errorf("warnings: %+v", warnings)
			}
			want := normalize(t, m.req)
			if g := normalize(t, got); !reflect.DeepEqual(g, want) {
				t.Errorf("round trip of\n%s\ngot  %+v\nwant %+v", cmd, g, want)
			}
		})
	}
}

func TestGenerateEdges(t *testing.T) {
	// An empty method is GET; an incomplete API key is left out; an empty
	// binary path sends no body; an empty urlencoded table still posts.
	got := Generate(model.Request{URL: "https://a.com", Auth: model.Auth{Type: model.AuthAPIKey}})
	if got != "curl https://a.com" {
		t.Errorf("got %q", got)
	}
	got = Generate(model.Request{Method: "PUT", URL: "https://a.com", Body: model.Body{Type: model.BodyBinary}})
	if got != "curl -X PUT https://a.com" {
		t.Errorf("got %q", got)
	}
	got = Generate(model.Request{Method: "POST", URL: "https://a.com", Body: model.Body{Type: model.BodyURLEncoded}})
	if got != "curl https://a.com \\\n  --data ''" {
		t.Errorf("got %q", got)
	}
}

func TestQuote(t *testing.T) {
	tests := map[string]string{
		"":                     "''",
		"abc-1.2/x:y=z@w%+,":   "abc-1.2/x:y=z@w%+,",
		"a b":                  "'a b'",
		"it's":                 `'it'\''s'`,
		"line\nbreak":          "'line\nbreak'",
		"tab\t'\\\x01\x7f\r\n": `$'tab\t\'\\\x01\x7f\r\n'`,
	}
	for in, want := range tests {
		if got := Quote(in); got != want {
			t.Errorf("Quote(%q) = %s, want %s", in, got, want)
		}
		// Quoting is reversible by the tokenizer.
		res, err := splitWords("curl " + Quote(in))
		if err != nil || len(res.words) != 2 || res.words[1] != in {
			t.Errorf("split(Quote(%q)) = %q, %v", in, res.words, err)
		}
	}
}
