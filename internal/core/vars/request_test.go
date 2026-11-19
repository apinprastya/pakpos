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

func TestResolveRequestOAuth2(t *testing.T) {
	in := &model.OAuth2{
		Grant: model.GrantPassword, AuthURL: "https://{{host}}/authorize", TokenURL: "https://{{host}}/token",
		RedirectURL: "http://127.0.0.1:{{id}}/callback", ClientID: "{{user}}", ClientSecret: "{{pw}}",
		Scope: "read {{nope}}", Username: "{{user}}", Password: "{{pw}}", HeaderPrefix: "{{ct}}", QueryParam: "{{hk}}",
		ExtraParams: []model.KeyValue{kv("audience", "{{host}}"), {Key: "off", Value: "{{offParam}}"}},
	}
	req := model.Request{URL: "x", Auth: model.Auth{Type: model.AuthOAuth2, OAuth2: in}}
	got, unresolved, err := ResolveRequest(req, reqScopes())
	if err != nil {
		t.Fatal(err)
	}
	o := got.Auth.OAuth2
	if o == in || in.ClientID != "{{user}}" || in.ExtraParams[0].Value != "{{host}}" {
		t.Fatal("the input must not change")
	}
	want := model.OAuth2{
		Grant: model.GrantPassword, AuthURL: "https://api.example.com/authorize", TokenURL: "https://api.example.com/token",
		RedirectURL: "http://127.0.0.1:42/callback", ClientID: "ann", ClientSecret: "pa55", Scope: "read {{nope}}",
		Username: "ann", Password: "pa55", HeaderPrefix: "text/plain", QueryParam: "X-Trace",
		ExtraParams: []model.KeyValue{kv("audience", "api.example.com"), {Key: "off", Value: "{{offParam}}"}},
	}
	if !reflect.DeepEqual(*o, want) {
		t.Errorf("got %+v", *o)
	}
	if !reflect.DeepEqual(unresolved, []string{"nope"}) {
		t.Errorf("unresolved = %v", unresolved)
	}

	// No settings, or another auth type: left alone.
	if got, _, _ := ResolveRequest(model.Request{Auth: model.Auth{Type: model.AuthOAuth2}}, nil); got.Auth.OAuth2 != nil {
		t.Error("nil settings")
	}
	other := model.Request{Auth: model.Auth{Type: model.AuthBearer, OAuth2: in}}
	if got, _, _ := ResolveRequest(other, reqScopes()); got.Auth.OAuth2 != in {
		t.Error("inactive settings are copied unchanged")
	}
	cyc := []Scope{scope(ScopeEnvironment, v("a", "{{a}}"))}
	bad := model.Request{Auth: model.Auth{Type: model.AuthOAuth2, OAuth2: &model.OAuth2{ClientSecret: "{{a}}"}}}
	if _, _, err := ResolveRequest(bad, cyc); !errors.Is(err, ErrCycle) {
		t.Errorf("err = %v", err)
	}
}

func TestResolveRequestOtherAuth(t *testing.T) {
	sc := append(reqScopes(), scope(ScopeLocal, v("quote", `a"b`)))
	tests := []struct {
		name  string
		auth  model.Auth
		check func(model.Auth) bool
	}{
		{"digest", model.Auth{Type: model.AuthDigest, Digest: &model.Digest{Username: "{{user}}", Password: "{{pw}}"}},
			func(a model.Auth) bool { return a.Digest.Username == "ann" && a.Digest.Password == "pa55" }},
		{"aws", model.Auth{Type: model.AuthAWSV4, AWSV4: &model.AWSV4{AccessKey: "{{user}}", SecretKey: "{{pw}}", SessionToken: "{{pw}}", Region: "{{id}}", Service: "s3"}},
			func(a model.Auth) bool {
				w := a.AWSV4
				return w.AccessKey == "ann" && w.SecretKey == "pa55" && w.SessionToken == "pa55" && w.Region == "42"
			}},
		{"jwt", model.Auth{Type: model.AuthJWT, JWT: &model.JWT{Secret: "{{pw}}", Header: `{"kid":"{{quote}}"}`, Payload: `{"sub":"{{quote}}","n":{{id}}}`, HeaderPrefix: "{{user}}"}},
			func(a model.Auth) bool {
				j := a.JWT
				return j.Secret == "pa55" && j.Header == `{"kid":"a\"b"}` && j.Payload == `{"sub":"a\"b","n":42}` && j.HeaderPrefix == "ann"
			}},
		{"hawk", model.Auth{Type: model.AuthHawk, Hawk: &model.Hawk{ID: "{{user}}", Key: "{{pw}}", Ext: "{{id}}"}},
			func(a model.Auth) bool { return a.Hawk.ID == "ann" && a.Hawk.Key == "pa55" && a.Hawk.Ext == "42" }},
		{"ntlm", model.Auth{Type: model.AuthNTLM, NTLM: &model.NTLM{Username: "{{user}}", Password: "{{pw}}", Domain: "{{id}}"}},
			func(a model.Auth) bool {
				return a.NTLM.Username == "ann" && a.NTLM.Password == "pa55" && a.NTLM.Domain == "42"
			}},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got, unresolved, err := ResolveRequest(model.Request{URL: "x", Auth: tt.auth}, sc)
			if err != nil || len(unresolved) != 0 {
				t.Fatalf("err = %v, unresolved = %v", err, unresolved)
			}
			if !tt.check(got.Auth) {
				t.Errorf("got %+v", got.Auth)
			}
			if tt.check(tt.auth) {
				t.Error("the input must not change")
			}
			// Without settings nothing happens.
			if _, _, err := ResolveRequest(model.Request{Auth: model.Auth{Type: tt.auth.Type}}, sc); err != nil {
				t.Error(err)
			}
		})
	}
	cyc := []Scope{scope(ScopeEnvironment, v("a", "{{a}}"))}
	bad := model.Request{Auth: model.Auth{Type: model.AuthJWT, JWT: &model.JWT{Payload: `{"a":"{{a}}"}`}}}
	if _, _, err := ResolveRequest(bad, cyc); !errors.Is(err, ErrCycle) {
		t.Errorf("err = %v", err)
	}
}
