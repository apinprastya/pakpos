package vars

import (
	"encoding/json"
	"errors"
	"reflect"
	"testing"

	"pakpos/internal/core/model"
)

func TestResolveJSON(t *testing.T) {
	r := New([]Scope{scope(ScopeEnvironment,
		v("quote", `say "hi"`),
		v("path", `C:\temp`),
		v("lines", "a\nb\tc"),
		v("html", "<a href='x'>&</a>"),
		v("count", "42"),
		v("user", `{"name": "ann"}`),
		v("nested", `{{quote}}!`),
		v("plain", "ann"),
	)})
	tests := []struct {
		name, in, want string
		unresolved     []string
	}{
		{"quote in a string", `{"msg": "{{quote}}"}`, `{"msg": "say \"hi\""}`, nil},
		{"backslash", `{"p": "{{path}}"}`, `{"p": "C:\\temp"}`, nil},
		{"control characters", `{"l": "{{lines}}"}`, `{"l": "a\nb\tc"}`, nil},
		{"html is not escaped", `{"h": "{{html}}"}`, `{"h": "<a href='x'>&</a>"}`, nil},
		{"part of a string", `{"m": "pre {{quote}} post"}`, `{"m": "pre say \"hi\" post"}`, nil},
		{"outside a string is raw", `{"n": {{count}}, "u": {{user}}}`, `{"n": 42, "u": {"name": "ann"}}`, nil},
		{"nested value escaped once", `{"m": "{{nested}}"}`, `{"m": "say \"hi\"!"}`, nil},
		{"reference as a key", `{"{{quote}}": 1}`, `{"say \"hi\"": 1}`, nil},
		{"escaped quote keeps string state", `{"m": "\"{{quote}}\"", "n": {{count}}}`, `{"m": "\"say \"hi\"\"", "n": 42}`, nil},
		{"unresolved stays", `{"m": "{{nope}}", "n": {{gone}}}`, `{"m": "{{nope}}", "n": {{gone}}}`, []string{"gone", "nope"}},
		{"no references", `{"m": "x"}`, `{"m": "x"}`, nil},
		{"unterminated string", `{"m": "{{quote}}`, `{"m": "say \"hi\"`, nil},
		{"plain value unchanged", `["{{plain}}"]`, `["ann"]`, nil},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got, unresolved, err := r.ResolveJSON(tt.in)
			if err != nil {
				t.Fatal(err)
			}
			if got != tt.want {
				t.Errorf("got  %s\nwant %s", got, tt.want)
			}
			if len(unresolved) != 0 || len(tt.unresolved) != 0 {
				if !reflect.DeepEqual(unresolved, tt.unresolved) {
					t.Errorf("unresolved = %v, want %v", unresolved, tt.unresolved)
				}
			}
		})
	}
}

func TestResolveJSONProducesValidJSON(t *testing.T) {
	r := New([]Scope{scope(ScopeEnvironment, v("x", "\"\\\x01\u2028 é"))})
	got, _, err := r.ResolveJSON(`{"x": "{{x}}"}`)
	if err != nil {
		t.Fatal(err)
	}
	var doc map[string]string
	if err := json.Unmarshal([]byte(got), &doc); err != nil {
		t.Fatalf("invalid JSON %s: %v", got, err)
	}
	if doc["x"] != "\"\\\x01\u2028 é" {
		t.Errorf("round trip = %q", doc["x"])
	}
}

func TestResolveJSONErrors(t *testing.T) {
	r := New([]Scope{scope(ScopeEnvironment, v("a", "{{b}}"), v("b", "{{a}}"))})
	for _, in := range []string{`{"m": "{{a}}"}`, `{"m": {{a}}}`} {
		if _, _, err := r.ResolveJSON(in); !errors.Is(err, ErrCycle) {
			t.Errorf("%s: err = %v, want ErrCycle", in, err)
		}
	}
}

func TestResolveRequestJSONBody(t *testing.T) {
	scopes := []Scope{scope(ScopeEnvironment, v("name", `ann "the" admin`), v("n", "3"))}
	for _, tt := range []struct {
		lang model.RawLanguage
		want string
	}{
		{model.LangJSON, `{"name": "ann \"the\" admin", "n": 3}`},
		{model.LangText, `{"name": "ann "the" admin", "n": 3}`},
		{model.LangXML, `{"name": "ann "the" admin", "n": 3}`},
	} {
		req := model.Request{Body: model.Body{Type: model.BodyRaw, Language: tt.lang, Raw: `{"name": "{{name}}", "n": {{n}}}`}}
		got, _, err := ResolveRequest(req, scopes)
		if err != nil {
			t.Fatal(err)
		}
		if got.Body.Raw != tt.want {
			t.Errorf("%s: body = %s, want %s", tt.lang, got.Body.Raw, tt.want)
		}
	}

	// Query rows stay plain text: httpexec encodes them when sending.
	req := model.Request{Query: []model.KeyValue{kv("q", "{{name}}")}}
	got, _, err := ResolveRequest(req, scopes)
	if err != nil {
		t.Fatal(err)
	}
	if got.Query[0].Value != `ann "the" admin` {
		t.Errorf("query = %q", got.Query[0].Value)
	}

	// Errors in a JSON body are reported with their field.
	bad := model.Request{Body: model.Body{Type: model.BodyRaw, Language: model.LangJSON, Raw: `"{{a}}"`}}
	cycle := []Scope{scope(ScopeEnvironment, v("a", "{{a}}"))}
	if _, _, err := ResolveRequest(bad, cycle); !errors.Is(err, ErrCycle) {
		t.Errorf("err = %v", err)
	}
}

func TestJSONEscape(t *testing.T) {
	if got := JSONEscape(`a"b\c<`); got != `a\"b\\c<` {
		t.Errorf("JSONEscape = %s", got)
	}
}
