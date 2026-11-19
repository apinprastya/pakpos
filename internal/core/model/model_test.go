package model

import (
	"encoding/json"
	"strings"
	"testing"

	"github.com/oklog/ulid/v2"
	"gopkg.in/yaml.v3"
)

func TestNewIDIsValidAndUnique(t *testing.T) {
	a, b := NewID(), NewID()
	if a == b {
		t.Fatal("expected unique IDs")
	}
	if _, err := ulid.ParseStrict(a); err != nil {
		t.Fatalf("NewID() = %q is not a ULID: %v", a, err)
	}
}

func sampleRequest() Request {
	return Request{
		ID: NewID(), Name: "Get user", Seq: 2, Method: "GET",
		URL:        "https://api.example.com/users/:id?verbose=true",
		PathParams: []KeyValue{{Key: "id", Value: "42", Enabled: true}},
		Query:      []KeyValue{{Key: "verbose", Value: "true", Enabled: true}},
		Headers:    []KeyValue{{Key: "Accept", Value: "application/json", Enabled: true}},
		Body:       Body{Type: BodyRaw, Raw: `{"a":1}`, Language: LangJSON},
		Auth:       Auth{Type: AuthInherit},
	}
}

func TestRequestRoundTripsJSONAndYAML(t *testing.T) {
	req := sampleRequest()

	j, err := json.Marshal(req)
	if err != nil {
		t.Fatal(err)
	}
	var fromJSON Request
	if err := json.Unmarshal(j, &fromJSON); err != nil {
		t.Fatal(err)
	}

	y, err := yaml.Marshal(req)
	if err != nil {
		t.Fatal(err)
	}
	var fromYAML Request
	if err := yaml.Unmarshal(y, &fromYAML); err != nil {
		t.Fatal(err)
	}

	for name, got := range map[string]Request{"json": fromJSON, "yaml": fromYAML} {
		if got.ID != req.ID || got.Seq != 2 || got.Auth.Type != AuthInherit ||
			got.Body.Language != LangJSON || got.PathParams[0].Value != "42" {
			t.Errorf("%s round trip mismatch: %+v", name, got)
		}
	}
}

func TestYAMLOmitsEmptyOptionalFields(t *testing.T) {
	y, err := yaml.Marshal(Request{ID: "x", Method: "GET", Body: Body{Type: BodyNone}, Auth: Auth{Type: AuthNone}})
	if err != nil {
		t.Fatal(err)
	}
	for _, field := range []string{"headers", "query", "raw:", "username"} {
		if strings.Contains(string(y), field) {
			t.Errorf("YAML should omit %q:\n%s", field, y)
		}
	}
}

func TestDefaultContentType(t *testing.T) {
	tests := []struct {
		body Body
		want string
	}{
		{Body{Type: BodyNone}, ""},
		{Body{}, ""},
		{Body{Type: BodyRaw, Language: LangJSON}, "application/json"},
		{Body{Type: BodyRaw, Language: LangXML}, "application/xml"},
		{Body{Type: BodyRaw}, "text/plain; charset=utf-8"},
		{Body{Type: BodyRaw, Language: "yaml"}, "text/plain; charset=utf-8"},
		{Body{Type: BodyURLEncoded}, "application/x-www-form-urlencoded"},
		{Body{Type: BodyBinary}, "application/octet-stream"},
		{Body{Type: BodyFormData}, "multipart/form-data"},
	}
	for _, tt := range tests {
		if got := tt.body.DefaultContentType(); got != tt.want {
			t.Errorf("%+v: got %q, want %q", tt.body, got, tt.want)
		}
	}
}

func TestRequestSettingsYAML(t *testing.T) {
	timeout, follow := 1500, false
	tests := []struct {
		name     string
		settings RequestSettings
		want     string // substring of the YAML; "" means no settings block
	}{
		{"unset is omitted", RequestSettings{}, ""},
		{"timeout", RequestSettings{TimeoutMs: &timeout}, "settings:\n    timeoutMs: 1500\n"},
		{"false is kept", RequestSettings{FollowRedirects: &follow}, "settings:\n    followRedirects: false\n"},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			req := sampleRequest()
			req.Settings = tt.settings
			out, err := yaml.Marshal(req)
			if err != nil {
				t.Fatal(err)
			}
			if tt.want == "" {
				if strings.Contains(string(out), "settings") {
					t.Fatalf("settings written although unset:\n%s", out)
				}
				return
			}
			if !strings.Contains(string(out), tt.want) {
				t.Fatalf("YAML = %s, want %q", out, tt.want)
			}
			var back Request
			if err := yaml.Unmarshal(out, &back); err != nil {
				t.Fatal(err)
			}
			if back.Settings.IsZero() {
				t.Fatal("settings lost in round trip")
			}
		})
	}
}

func TestScriptsYAML(t *testing.T) {
	cases := []struct {
		name string
		in   Scripts
		want string
	}{
		{"empty", Scripts{}, "{}\n"},
		{"both", Scripts{PreRequest: "a();\nb();\n", Test: "pm.test('x', () => {})"},
			"preRequest: |\n    a();\n    b();\ntest: |-\n    pm.test('x', () => {})\n"},
		{"test only", Scripts{Test: "t"}, "test: |-\n    t\n"},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			out, err := yaml.Marshal(c.in)
			if err != nil {
				t.Fatal(err)
			}
			if string(out) != c.want {
				t.Errorf("yaml:\n%s\nwant:\n%s", out, c.want)
			}
			var back Scripts
			if err := yaml.Unmarshal(out, &back); err != nil || back != c.in {
				t.Errorf("round trip = %+v, %v", back, err)
			}
		})
	}
	if !(Scripts{}).IsZero() || (Scripts{Test: "x"}).IsZero() {
		t.Error("IsZero")
	}
	// A request without scripts omits the block.
	out, err := yaml.Marshal(Request{Name: "r"})
	if err != nil || strings.Contains(string(out), "scripts") {
		t.Errorf("request yaml = %s, %v", out, err)
	}
}

func TestAuthOAuth2YAML(t *testing.T) {
	if (Auth{Type: AuthBearer}).IsV3() || !(Auth{Type: AuthOAuth2}).IsV3() || !(Auth{Type: AuthNone, OAuth2: &OAuth2{}}).IsV3() {
		t.Error("IsV3")
	}
	y, err := yaml.Marshal(Auth{Type: AuthBearer})
	if err != nil || strings.Contains(string(y), "oauth2") {
		t.Fatalf("an unset oauth2 block must be omitted: %s %v", y, err)
	}
	in := Auth{Type: AuthOAuth2, OAuth2: &OAuth2{
		Grant: GrantAuthorizationCode, AuthURL: "https://a/auth", TokenURL: "https://a/token", ClientID: "id",
		ClientSecret: "{{secret}}", Scope: "read", ExtraParams: []KeyValue{{Key: "audience", Value: "api", Enabled: true}},
	}}
	y, err = yaml.Marshal(in)
	if err != nil {
		t.Fatal(err)
	}
	for _, absent := range []string{"disablePkce", "placement", "redirectUrl", "username"} {
		if strings.Contains(string(y), absent) {
			t.Errorf("%s should be omitted:\n%s", absent, y)
		}
	}
	var back Auth
	if err := yaml.Unmarshal(y, &back); err != nil {
		t.Fatal(err)
	}
	if back.OAuth2 == nil || back.OAuth2.ClientSecret != "{{secret}}" || back.OAuth2.ExtraParams[0].Key != "audience" {
		t.Errorf("round trip: %+v", back.OAuth2)
	}
}
