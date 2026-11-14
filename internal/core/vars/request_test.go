package vars

import (
	"errors"
	"reflect"
	"testing"

	"pakpos/internal/core/model"
)

func kv(k, val string) model.KeyValue { return model.KeyValue{Key: k, Value: val, Enabled: true} }

func reqScopes() []Scope {
	return []Scope{
		scope(ScopeGlobal, v("host", "api.example.com"), v("id", "42"), v("hk", "X-Trace")),
		scope(ScopeEnvironment, v("token", "tok"), v("user", "ann"), v("pw", "pa55"), v("dir", "/tmp"), v("ct", "text/plain")),
	}
}

func TestResolveRequestFields(t *testing.T) {
	base := model.Request{
		ID: "R1", Name: "{{host}} stays", Method: "GET",
		URL:        "https://{{host}}/users/:id?q={{id}}",
		PathParams: []model.KeyValue{kv("id", "{{id}}"), {Key: "off", Value: "{{offPath}}"}},
		Query:      []model.KeyValue{kv("q", "{{id}}"), {Key: "x", Value: "{{offQuery}}"}},
		Headers:    []model.KeyValue{kv("{{hk}}", "{{id}}"), kv("Missing", "{{nope}}"), {Key: "D", Value: "{{offHeader}}"}},
	}
	tests := []struct {
		name       string
		mutate     func(*model.Request)
		check      func(t *testing.T, got model.Request)
		unresolved []string
	}{
		{
			name: "url, path params, query, headers",
			check: func(t *testing.T, got model.Request) {
				if got.URL != "https://api.example.com/users/:id?q=42" {
					t.Errorf("URL = %q", got.URL)
				}
				if got.PathParams[0].Value != "42" || got.PathParams[1].Value != "{{offPath}}" {
					t.Errorf("path params = %+v", got.PathParams)
				}
				if got.Query[0].Value != "42" || got.Query[1].Value != "{{offQuery}}" {
					t.Errorf("query = %+v", got.Query)
				}
				if got.Headers[0] != kv("X-Trace", "42") || got.Headers[2].Value != "{{offHeader}}" {
					t.Errorf("headers = %+v", got.Headers)
				}
				if got.Name != "{{host}} stays" {
					t.Errorf("name must not be resolved: %q", got.Name)
				}
			},
			unresolved: []string{"nope"},
		},
		{
			name: "raw body",
			mutate: func(r *model.Request) {
				r.Body = model.Body{Type: model.BodyRaw, Raw: `{"id": {{id}}, "u": "{{who}}"}`, BinaryPath: "{{inactive}}"}
			},
			check: func(t *testing.T, got model.Request) {
				if got.Body.Raw != `{"id": 42, "u": "{{who}}"}` || got.Body.BinaryPath != "{{inactive}}" {
					t.Errorf("body = %+v", got.Body)
				}
			},
			unresolved: []string{"nope", "who"},
		},
		{
			name: "form data text and file",
			mutate: func(r *model.Request) {
				r.Body = model.Body{Type: model.BodyFormData, FormData: []model.FormField{
					{Key: "{{hk}}", Kind: model.FormText, Value: "{{id}}", ContentType: "{{ct}}", Enabled: true},
					{Key: "f", Kind: model.FormFile, Value: "{{ignored}}", FilePath: "{{dir}}/a.png", Enabled: true},
					{Key: "off", Kind: model.FormText, Value: "{{offForm}}"},
				}}
			},
			check: func(t *testing.T, got model.Request) {
				fd := got.Body.FormData
				if fd[0].Key != "X-Trace" || fd[0].Value != "42" || fd[0].ContentType != "text/plain" {
					t.Errorf("text part = %+v", fd[0])
				}
				if fd[1].FilePath != "/tmp/a.png" || fd[1].Value != "{{ignored}}" {
					t.Errorf("file part = %+v", fd[1])
				}
				if fd[2].Value != "{{offForm}}" {
					t.Errorf("disabled part = %+v", fd[2])
				}
			},
			unresolved: []string{"nope"},
		},
		{
			name: "urlencoded",
			mutate: func(r *model.Request) {
				r.Body = model.Body{Type: model.BodyURLEncoded, URLEncoded: []model.KeyValue{kv("u", "{{user}}"), {Key: "x", Value: "{{off}}"}}}
			},
			check: func(t *testing.T, got model.Request) {
				if got.Body.URLEncoded[0].Value != "ann" || got.Body.URLEncoded[1].Value != "{{off}}" {
					t.Errorf("urlencoded = %+v", got.Body.URLEncoded)
				}
			},
			unresolved: []string{"nope"},
		},
		{
			name:   "binary path",
			mutate: func(r *model.Request) { r.Body = model.Body{Type: model.BodyBinary, BinaryPath: "{{dir}}/b.bin"} },
			check: func(t *testing.T, got model.Request) {
				if got.Body.BinaryPath != "/tmp/b.bin" {
					t.Errorf("binary = %q", got.Body.BinaryPath)
				}
			},
			unresolved: []string{"nope"},
		},
		{
			name: "basic auth",
			mutate: func(r *model.Request) {
				r.Auth = model.Auth{Type: model.AuthBasic, Username: "{{user}}", Password: "{{pw}}", Token: "{{inactive}}"}
			},
			check: func(t *testing.T, got model.Request) {
				if got.Auth.Username != "ann" || got.Auth.Password != "pa55" || got.Auth.Token != "{{inactive}}" {
					t.Errorf("auth = %+v", got.Auth)
				}
			},
			unresolved: []string{"nope"},
		},
		{
			name: "bearer auth",
			mutate: func(r *model.Request) {
				r.Auth = model.Auth{Type: model.AuthBearer, Token: "{{token}}", Prefix: "{{pfx}}"}
			},
			check: func(t *testing.T, got model.Request) {
				if got.Auth.Token != "tok" || got.Auth.Prefix != "{{pfx}}" {
					t.Errorf("auth = %+v", got.Auth)
				}
			},
			unresolved: []string{"nope", "pfx"},
		},
		{
			name: "api key auth",
			mutate: func(r *model.Request) {
				r.Auth = model.Auth{Type: model.AuthAPIKey, APIKey: "{{hk}}", APIValue: "{{token}}", APIIn: model.APIKeyInHeader}
			},
			check: func(t *testing.T, got model.Request) {
				if got.Auth.APIKey != "X-Trace" || got.Auth.APIValue != "tok" {
					t.Errorf("auth = %+v", got.Auth)
				}
			},
			unresolved: []string{"nope"},
		},
		{
			name: "none body and inherit auth untouched",
			mutate: func(r *model.Request) {
				r.Body = model.Body{Type: model.BodyNone, Raw: "{{a}}"}
				r.Auth = model.Auth{Type: model.AuthInherit, Token: "{{b}}"}
			},
			check: func(t *testing.T, got model.Request) {
				if got.Body.Raw != "{{a}}" || got.Auth.Token != "{{b}}" {
					t.Errorf("got %+v %+v", got.Body, got.Auth)
				}
			},
			unresolved: []string{"nope"},
		},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			req := deepCopy(base)
			if tt.mutate != nil {
				tt.mutate(&req)
			}
			before := deepCopy(req)
			got, unresolved, err := ResolveRequest(req, reqScopes())
			if err != nil {
				t.Fatal(err)
			}
			tt.check(t, got)
			if !reflect.DeepEqual(unresolved, tt.unresolved) {
				t.Errorf("unresolved = %v, want %v", unresolved, tt.unresolved)
			}
			if !reflect.DeepEqual(req, before) {
				t.Errorf("input was mutated:\n got %+v\nwant %+v", req, before)
			}
		})
	}
}

func deepCopy(r model.Request) model.Request {
	out := r
	out.PathParams = cloneKV(r.PathParams)
	out.Query = cloneKV(r.Query)
	out.Headers = cloneKV(r.Headers)
	out.Body.URLEncoded = cloneKV(r.Body.URLEncoded)
	if r.Body.FormData != nil {
		out.Body.FormData = append([]model.FormField{}, r.Body.FormData...)
	}
	return out
}

func TestResolveRequestNilSlicesStayNil(t *testing.T) {
	got, unresolved, err := ResolveRequest(model.Request{URL: "x"}, nil)
	if err != nil || got.Headers != nil || got.Query != nil || got.Body.FormData != nil || len(unresolved) != 0 {
		t.Fatalf("got %+v %v %v", got, unresolved, err)
	}
}

func TestResolveRequestErrors(t *testing.T) {
	cyc := []Scope{scope(ScopeEnvironment, v("a", "{{a}}"))}
	tests := []struct {
		name string
		req  model.Request
	}{
		{"url", model.Request{URL: "{{a}}"}},
		{"header", model.Request{Headers: []model.KeyValue{kv("H", "{{a}}")}}},
		{"form", model.Request{Body: model.Body{Type: model.BodyFormData, FormData: []model.FormField{{Key: "k", Kind: model.FormText, Value: "{{a}}", Enabled: true}}}}},
		{"auth", model.Request{URL: "ok", Auth: model.Auth{Type: model.AuthBearer, Token: "{{a}}"}}},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			_, _, err := ResolveRequest(tt.req, cyc)
			if !errors.Is(err, ErrCycle) {
				t.Fatalf("err = %v", err)
			}
		})
	}
}
