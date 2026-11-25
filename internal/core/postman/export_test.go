package postman

import (
	"bytes"
	"encoding/json"
	goflag "flag"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"

	"pakpos/internal/core/model"
)

var update = goflag.Bool("update", false, "rewrite the golden files in testdata")

func ptr[T any](v T) *T { return &v }

// sampleCollection covers every part of a collection the export writes.
func sampleCollection() File {
	login := model.Request{
		Name: "Log in", Method: "post", URL: "{{baseUrl}}/login?debug=1",
		Query:   []model.KeyValue{{Key: "debug", Value: "1", Enabled: true}, {Key: "trace", Value: "on"}},
		Headers: []model.KeyValue{{Key: "Accept", Value: "application/json", Enabled: true}},
		Body:    model.Body{Type: model.BodyRaw, Raw: `{"user":"{{user}}","pass":"<&>"}`, Language: model.LangJSON},
		Auth:    model.Auth{Type: model.AuthNone},
		Scripts: model.Scripts{Test: "pm.test('ok', () => {\n  pm.response.to.have.status(200);\n});\n"},
	}
	getUser := model.Request{
		Name: "Get user", Method: "GET", URL: "https://api.example.com:8443/users/:id#top",
		PathParams: []model.KeyValue{{Key: "id", Value: "42", Enabled: true}},
		Headers:    []model.KeyValue{{Key: "X-Trace", Value: "mine", Enabled: true}},
		Body:       model.Body{Type: model.BodyNone},
		Auth:       model.Auth{Type: model.AuthInherit},
		Settings:   model.RequestSettings{FollowRedirects: ptr(false), MaxRedirects: ptr(3), VerifyTLS: ptr(false)},
	}
	upload := model.Request{
		Name: "Upload", Method: "PUT", URL: "{{baseUrl}}/files",
		Body: model.Body{Type: model.BodyFormData, FormData: []model.FormField{
			{Key: "name", Kind: model.FormText, Value: "a.txt", Enabled: true},
			{Key: "file", Kind: model.FormFile, FilePath: "/tmp/a.txt", ContentType: "text/plain", Enabled: true},
		}},
		Auth:     model.Auth{Type: model.AuthBearer, Token: "{{token}}"},
		Settings: model.RequestSettings{TimeoutMs: ptr(5000)},
	}
	return File{Kind: KindCollection, Name: "Shop API", Collection: &Collection{
		Auth:      model.Auth{Type: model.AuthBasic, Username: "{{user}}", Password: "{{pass}}"},
		Headers:   []model.KeyValue{{Key: "X-Trace", Value: "collection", Enabled: true}, {Key: "X-Off", Value: "1"}},
		Variables: []model.Variable{{Key: "baseUrl", Value: "https://api.example.com", Enabled: true}, {Key: "pass", Value: "s3cret", Enabled: true, Secret: true}},
		Scripts:   model.Scripts{PreRequest: "console.log('start');"},
		Items: []Item{
			{Request: &Request{Request: login, Examples: []Example{{
				Name: "Logged in", Request: login, StatusCode: 200, StatusText: "OK",
				Headers: []model.KeyValue{{Key: "Content-Type", Value: "application/json", Enabled: true}},
				Kind:    model.KindJSON, Body: `{"token":"abc"}`,
			}, {
				Name: "Binary", Request: login, StatusCode: 200, StatusText: "OK", Kind: model.KindBinary,
				Body: "AAEC", Encoding: model.EncodingBase64,
			}}}},
			{Folder: &Folder{
				Name: "Users", Auth: model.Auth{Type: model.AuthInherit},
				Headers: []model.KeyValue{{Key: "X-Folder", Value: "users", Enabled: true}},
				Scripts: model.Scripts{Test: "pm.expect(1).to.equal(1);"},
				Items: []Item{
					{Request: &Request{Request: getUser}},
					{Folder: &Folder{Name: "Files", Auth: model.Auth{Type: model.AuthNone}, Items: []Item{{Request: &Request{Request: upload}}}}},
				},
			}},
		},
	}}
}

func exportJSON(t *testing.T, f File) ([]byte, []Warning) {
	t.Helper()
	b, w, err := Export(f)
	if err != nil {
		t.Fatalf("Export: %v", err)
	}
	if !json.Valid(b) {
		t.Fatalf("invalid JSON:\n%s", b)
	}
	return b, w
}

func golden(t *testing.T, name string, got []byte) {
	t.Helper()
	path := filepath.Join("testdata", name)
	if *update {
		if err := os.WriteFile(path, got, 0o644); err != nil { //nolint:gosec // test golden file
			t.Fatal(err)
		}
	}
	want, err := os.ReadFile(path) //nolint:gosec // test golden file
	if err != nil {
		t.Fatalf("%v (run go test -update)", err)
	}
	if !bytes.Equal(got, want) {
		t.Errorf("%s differs from the golden file (go test ./internal/core/postman -update):\n%s", name, got)
	}
}

func hasWarning(ws []Warning, where, contains string) bool {
	for _, w := range ws {
		if w.Where == where && strings.Contains(w.Message, contains) {
			return true
		}
	}
	return false
}

func TestExportCollectionGolden(t *testing.T) {
	b, warnings := exportJSON(t, sampleCollection())
	golden(t, "export-collection.json", b)
	for _, w := range []struct{ where, contains string }{
		{"", "copied into each request"},
		{"", "Secret values aren't exported: pass."},
		{"", "1 request send files from this computer"},
		{"", "per-request timeout, so these use Postman's own setting: Users / Files / Upload"},
		{"Log in", `The example "Binary" has a binary body`},
	} {
		if !hasWarning(warnings, w.where, w.contains) {
			t.Errorf("missing warning %q at %q in %+v", w.contains, w.where, warnings)
		}
	}
	if strings.Contains(string(b), "s3cret") {
		t.Error("a secret value was exported")
	}
}

// TestExportRoundTrip imports the export again: everything Pakpos and
// Postman both have survives.
func TestExportRoundTrip(t *testing.T) {
	src := sampleCollection()
	b, _ := exportJSON(t, src)
	back, err := Parse(b, Options{})
	if err != nil {
		t.Fatal(err)
	}
	if back.Kind != KindCollection || back.Name != "Shop API" {
		t.Fatalf("kind/name = %s %q", back.Kind, back.Name)
	}
	c := back.Collection
	if c.Auth.Type != model.AuthBasic || c.Auth.Password != "{{pass}}" || c.Scripts.PreRequest != "console.log('start');" {
		t.Errorf("collection: %+v", c)
	}
	wantVars := []model.Variable{{Key: "baseUrl", Value: "https://api.example.com", Enabled: true}, {Key: "pass", Enabled: true}}
	if !reflect.DeepEqual(c.Variables, wantVars) {
		t.Errorf("variables = %+v", c.Variables)
	}

	login := find(t, c.Items, "Log in")
	orig := src.Collection.Items[0].Request.Request
	got := login.Request
	if got.Method != "POST" || got.URL != orig.URL || !reflect.DeepEqual(got.Query, orig.Query) ||
		!reflect.DeepEqual(got.Body, orig.Body) ||
		got.Auth.Type != model.AuthNone || got.Scripts.Test != strings.TrimRight(orig.Scripts.Test, "\n") {
		t.Errorf("login = %+v", got)
	}
	wantHeaders := []model.KeyValue{{Key: "X-Trace", Value: "collection", Enabled: true}, {Key: "Accept", Value: "application/json", Enabled: true}}
	if !reflect.DeepEqual(got.Headers, wantHeaders) {
		t.Errorf("login headers = %+v", got.Headers)
	}
	if len(login.Examples) != 1 || login.Examples[0].Body != `{"token":"abc"}` || login.Examples[0].Kind != model.KindJSON ||
		login.Examples[0].Request.Body.Raw != orig.Body.Raw {
		t.Errorf("examples = %+v", login.Examples)
	}

	user := find(t, c.Items, "Users", "Get user").Request
	if user.URL != "https://api.example.com:8443/users/:id#top" || user.Auth.Type != model.AuthInherit ||
		!reflect.DeepEqual(user.PathParams, []model.KeyValue{{Key: "id", Value: "42", Enabled: true}}) ||
		!reflect.DeepEqual(user.Settings, model.RequestSettings{FollowRedirects: ptr(false), MaxRedirects: ptr(3), VerifyTLS: ptr(false)}) {
		t.Errorf("get user = %+v", user)
	}
	// The request's own X-Trace wins; the collection's disabled row isn't copied.
	wantUser := []model.KeyValue{{Key: "X-Folder", Value: "users", Enabled: true}, {Key: "X-Trace", Value: "mine", Enabled: true}}
	if !reflect.DeepEqual(user.Headers, wantUser) {
		t.Errorf("get user headers = %+v", user.Headers)
	}

	upload := find(t, c.Items, "Users", "Files", "Upload").Request
	if upload.Auth.Token != "{{token}}" || len(upload.Body.FormData) != 2 ||
		upload.Body.FormData[1] != (model.FormField{Key: "file", Kind: model.FormFile, FilePath: "/tmp/a.txt", ContentType: "text/plain", Enabled: true}) {
		t.Errorf("upload = %+v", upload)
	}
	users := c.Items[1].Folder
	if users.Scripts.Test != "pm.expect(1).to.equal(1);" || users.Auth.Type != model.AuthInherit ||
		users.Items[1].Folder.Auth.Type != model.AuthNone {
		t.Errorf("folders = %+v", users)
	}
}

func TestExportAuthRoundTrip(t *testing.T) {
	cases := []model.Auth{
		{Type: model.AuthNone},
		{Type: model.AuthBasic, Username: "u", Password: "{{p}}"},
		{Type: model.AuthBearer, Token: "{{t}}"},
		{Type: model.AuthAPIKey, APIKey: "X-Key", APIValue: "{{k}}", APIIn: model.APIKeyInQuery},
		{Type: model.AuthAPIKey, APIKey: "X-Key", APIValue: "{{k}}", APIIn: model.APIKeyInHeader},
		{Type: model.AuthDigest, Digest: &model.Digest{Username: "u", Password: "{{p}}", Algorithm: "SHA-256-sess", Qop: "auth-int"}},
		{Type: model.AuthAWSV4, AWSV4: &model.AWSV4{AccessKey: "AK", SecretKey: "{{sk}}", SessionToken: "{{st}}", Region: "eu-west-1", Service: "s3"}},
		{Type: model.AuthHawk, Hawk: &model.Hawk{ID: "id", Key: "{{hk}}", Algorithm: "sha1", Ext: "e", App: "a", Dlg: "d", PayloadHash: true}},
		{Type: model.AuthNTLM, NTLM: &model.NTLM{Username: "u", Password: "{{p}}", Domain: "CORP", Workstation: "W"}},
		{Type: model.AuthJWT, JWT: &model.JWT{Algorithm: "RS256", Secret: "{{key}}", SecretBase64: true, Header: `{"kid":"1"}`,
			Payload: `{"sub":"x"}`, Placement: model.PlaceQuery, QueryParam: "jwt", HeaderPrefix: "JWT", DisableIssuedAt: true}},
		{Type: model.AuthJWT, JWT: &model.JWT{Algorithm: "EdDSA", Secret: "{{key}}", DisableIssuedAt: true}},
		{Type: model.AuthOAuth2, OAuth2: &model.OAuth2{
			Grant: model.GrantAuthorizationCode, AuthURL: "https://a/auth", TokenURL: "https://a/token",
			RedirectURL: "http://127.0.0.1:5555/cb", ClientID: "id", ClientSecret: "{{cs}}", Scope: "read",
			ClientAuth: model.ClientAuthBody, PKCEMethod: model.PKCEPlain, HeaderPrefix: "Token",
			ExtraParams: []model.KeyValue{{Key: "audience", Value: "api", Enabled: true}, {Key: "off", Value: "1"}},
		}},
		{Type: model.AuthOAuth2, OAuth2: &model.OAuth2{Grant: model.GrantAuthorizationCode, DisablePKCE: true, TokenURL: "https://a/token"}},
		{Type: model.AuthOAuth2, OAuth2: &model.OAuth2{Grant: model.GrantPassword, TokenURL: "https://a/t", Username: "u", Password: "{{p}}", Placement: model.PlaceQuery}},
		{Type: model.AuthOAuth2, OAuth2: &model.OAuth2{Grant: model.GrantClientCredentials, TokenURL: "https://a/t"}},
		{Type: model.AuthOAuth2, OAuth2: &model.OAuth2{Grant: model.GrantImplicit, AuthURL: "https://a/auth", RedirectURL: "http://localhost:9000/cb"}},
	}
	for _, in := range cases {
		t.Run(string(in.Type), func(t *testing.T) {
			f := File{Kind: KindCollection, Name: "c", Collection: &Collection{Items: []Item{
				{Request: &Request{Request: model.Request{Name: "r", Method: "GET", URL: "https://x", Auth: in}}},
			}}}
			b, _ := exportJSON(t, f)
			back, err := Parse(b, Options{})
			if err != nil {
				t.Fatal(err)
			}
			got := back.Collection.Items[0].Request.Request.Auth
			want := in
			if want.JWT != nil {
				// Postman has no such setting; imports keep Pakpos's default.
				j := *want.JWT
				j.DisableIssuedAt = false
				want.JWT = &j
			}
			gj, _ := json.Marshal(got)
			wj, _ := json.Marshal(want)
			if !bytes.Equal(gj, wj) {
				t.Errorf("round trip:\n got  %s\n want %s\n%s", gj, wj, b)
			}
		})
	}
}

func TestExportAuthWarnings(t *testing.T) {
	cases := []struct {
		auth     model.Auth
		contains string
	}{
		{model.Auth{Type: model.AuthAWSV4, AWSV4: &model.AWSV4{UnsignedPayload: true}}, "Unsigned payload"},
		{model.Auth{Type: model.AuthJWT, JWT: &model.JWT{}}, "iat, exp and jti"},
		{model.Auth{Type: model.AuthOAuth2, OAuth2: &model.OAuth2{Placement: model.PlaceQuery, QueryParam: "tok"}}, `not "tok"`},
	}
	for _, c := range cases {
		f := File{Kind: KindCollection, Name: "c", Collection: &Collection{Items: []Item{
			{Request: &Request{Request: model.Request{Name: "r", Method: "GET", Auth: c.auth}}},
		}}}
		_, w := exportJSON(t, f)
		if !hasWarning(w, "r", c.contains) {
			t.Errorf("%s: missing %q in %+v", c.auth.Type, c.contains, w)
		}
	}
	// Defaults: a digest without algorithm is MD5, hawk sha256, JWT HS256.
	for _, c := range []struct {
		auth model.Auth
		want string
	}{
		{model.Auth{Type: model.AuthDigest}, `"value": "MD5"`},
		{model.Auth{Type: model.AuthHawk}, `"value": "sha256"`},
		{model.Auth{Type: model.AuthJWT}, `"value": "HS256"`},
		{model.Auth{Type: "unknown"}, `"type": "noauth"`},
	} {
		f := File{Kind: KindCollection, Name: "c", Collection: &Collection{Auth: c.auth}}
		b, _ := exportJSON(t, f)
		if !strings.Contains(string(b), c.want) {
			t.Errorf("%s: %s not in\n%s", c.auth.Type, c.want, b)
		}
	}
}

func TestExportBodies(t *testing.T) {
	cases := []struct {
		name string
		body model.Body
	}{
		{"none", model.Body{Type: model.BodyNone}},
		{"raw text", model.Body{Type: model.BodyRaw, Raw: "hi", Language: model.LangText}},
		{"raw xml", model.Body{Type: model.BodyRaw, Raw: "<a/>", Language: model.LangXML}},
		{"urlencoded", model.Body{Type: model.BodyURLEncoded, URLEncoded: []model.KeyValue{{Key: "a", Value: "b c", Enabled: true}, {Key: "d", Value: "e"}}}},
		{"binary", model.Body{Type: model.BodyBinary, BinaryPath: "/tmp/x.bin"}},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			f := File{Kind: KindCollection, Name: "c", Collection: &Collection{Items: []Item{
				{Request: &Request{Request: model.Request{Name: "r", Method: "POST", URL: "https://x", Body: c.body}}},
			}}}
			b, _ := exportJSON(t, f)
			back, err := Parse(b, Options{})
			if err != nil {
				t.Fatal(err)
			}
			got := back.Collection.Items[0].Request.Request.Body
			if !reflect.DeepEqual(got, c.body) {
				t.Errorf("body = %+v, want %+v", got, c.body)
			}
		})
	}
	// A raw body without a language is text.
	f := File{Kind: KindCollection, Name: "c", Collection: &Collection{Items: []Item{
		{Request: &Request{Request: model.Request{Name: "r", Body: model.Body{Type: model.BodyRaw, Raw: "x"}}}},
	}}}
	b, _ := exportJSON(t, f)
	if !strings.Contains(string(b), `"language": "text"`) || !strings.Contains(string(b), `"method": "GET"`) {
		t.Errorf("defaults missing:\n%s", b)
	}
}

func TestExportURL(t *testing.T) {
	cases := []struct {
		raw  string
		want xURL
	}{
		{"", xURL{Raw: ""}},
		{"{{baseUrl}}/users/:id", xURL{Raw: "{{baseUrl}}/users/:id", Host: []string{"{{baseUrl}}"}, Path: []string{"users", ":id"}}},
		{"https://a.b.c:8080/x/?q=1#h", xURL{Raw: "https://a.b.c:8080/x/?q=1#h", Protocol: "https", Host: []string{"a.b.c"}, Port: "8080", Path: []string{"x", ""}, Hash: "h"}},
		{"http://[::1]:9000", xURL{Raw: "http://[::1]:9000", Protocol: "http", Host: []string{"[::1]"}, Port: "9000"}},
		{"http://[::1]/p", xURL{Raw: "http://[::1]/p", Protocol: "http", Host: []string{"[::1]"}, Path: []string{"p"}}},
		{"{{host}}:{{port}}/p", xURL{Raw: "{{host}}:{{port}}/p", Host: []string{"{{host}}"}, Port: "{{port}}", Path: []string{"p"}}},
		{"localhost:abc", xURL{Raw: "localhost:abc", Host: []string{"localhost:abc"}}},
		{"localhost:", xURL{Raw: "localhost:", Host: []string{"localhost:"}}},
	}
	for _, c := range cases {
		got := exportURL(c.raw, nil, nil)
		got.Query = nil
		if !reflect.DeepEqual(got, c.want) {
			t.Errorf("%q:\n got  %+v\n want %+v", c.raw, got, c.want)
		}
	}
	got := exportURL("x", []model.KeyValue{{Key: "a", Value: "1", Enabled: true}, {Key: "b"}}, []model.KeyValue{{Key: "id", Value: "7"}, {Key: ""}})
	want := xURL{Raw: "x", Host: []string{"x"},
		Query:    []xKeyValue{{Key: "a", Value: "1"}, {Key: "b", Disabled: true}},
		Variable: []xKeyValue{{Key: "id", Value: "7"}},
	}
	if !reflect.DeepEqual(got, want) {
		t.Errorf("rows:\n got  %+v\n want %+v", got, want)
	}
}

func TestExportVariableFiles(t *testing.T) {
	vs := []model.Variable{
		{Key: "host", Value: "example.com", Enabled: true},
		{Key: "off", Value: "x"},
		{Key: "token", Value: "leak", Enabled: true, Secret: true},
	}
	for _, kind := range []Kind{KindEnvironment, KindGlobals} {
		t.Run(string(kind), func(t *testing.T) {
			b, w := exportJSON(t, File{Kind: kind, Name: "Dev", Variables: vs})
			golden(t, "export-"+string(kind)+".json", b)
			if strings.Contains(string(b), "leak") {
				t.Error("secret value exported")
			}
			if !hasWarning(w, "", "Secret values aren't exported: token.") {
				t.Errorf("warnings = %+v", w)
			}
			back, err := Parse(b, Options{})
			if err != nil {
				t.Fatal(err)
			}
			want := []model.Variable{vs[0], vs[1], {Key: "token", Enabled: true, Secret: true}}
			if back.Kind != kind || !reflect.DeepEqual(back.Variables, want) {
				t.Errorf("round trip = %s %+v", back.Kind, back.Variables)
			}
		})
	}
	b, w := exportJSON(t, File{Kind: KindEnvironment, Name: "Empty"})
	if !strings.Contains(string(b), `"values": []`) || len(w) != 0 {
		t.Errorf("empty environment: %s %+v", b, w)
	}
}

func TestExportFolderWithoutAuthTypeInherits(t *testing.T) {
	f := File{Kind: KindCollection, Name: "c", Collection: &Collection{Items: []Item{{Folder: &Folder{Name: "Old"}}}}}
	b, _ := exportJSON(t, f)
	back, err := Parse(b, Options{})
	if err != nil || back.Collection.Items[0].Folder.Auth.Type != model.AuthInherit {
		t.Errorf("folder auth = %+v, %v\n%s", back.Collection.Items[0].Folder, err, b)
	}
}

func TestExportErrors(t *testing.T) {
	if _, _, err := Export(File{Kind: KindCollection, Name: "x"}); err == nil {
		t.Error("collection without content should fail")
	}
	if _, _, err := Export(File{Kind: "nope"}); err == nil {
		t.Error("unknown kind should fail")
	}
}
