package postman

import (
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"pakpos/internal/core/model"
)

func load(t *testing.T, name string, opts Options) File {
	t.Helper()
	b, err := os.ReadFile(filepath.Join("testdata", name))
	if err != nil {
		t.Fatal(err)
	}
	f, err := Parse(b, opts)
	if err != nil {
		t.Fatalf("Parse(%s): %v", name, err)
	}
	return f
}

// find returns the request at a path of item names ("Orders", "List orders").
func find(t *testing.T, items []Item, path ...string) *Request {
	t.Helper()
	for _, it := range items {
		switch {
		case it.Folder != nil && it.Folder.Name == path[0] && len(path) > 1:
			return find(t, it.Folder.Items, path[1:]...)
		case it.Request != nil && it.Request.Request.Name == path[0] && len(path) == 1:
			return it.Request
		}
	}
	t.Fatalf("no request at %v", path)
	return nil
}

func warningFor(f File, where, contains string) bool {
	for _, w := range f.Warnings {
		if w.Where == where && strings.Contains(w.Message, contains) {
			return true
		}
	}
	return false
}

func TestCollectionV21(t *testing.T) {
	f := load(t, "collection-v21.json", Options{})
	if f.Kind != KindCollection || f.Name != "Shop API" {
		t.Fatalf("kind/name = %s %q", f.Kind, f.Name)
	}
	c := f.Collection
	if c.Auth.Type != model.AuthBearer || c.Auth.Token != "{{accessToken}}" {
		t.Errorf("collection auth = %+v", c.Auth)
	}
	if !strings.Contains(c.Scripts.PreRequest, "pm.variables.set") || !strings.Contains(c.Scripts.Test, "pm.test") {
		t.Errorf("collection scripts = %+v", c.Scripts)
	}
	wantVars := []model.Variable{
		{Key: "baseUrl", Value: "https://shop.example.com", Enabled: true},
		{Key: "apiKey", Value: "abc123", Enabled: true},
		{Key: "count", Value: "3", Enabled: true},
		{Key: "off", Value: "x"},
		{Key: "vaulted", Value: "s3cret", Enabled: true, Secret: true},
	}
	if len(c.Variables) != len(wantVars) {
		t.Fatalf("variables = %+v", c.Variables)
	}
	for i, v := range wantVars {
		if c.Variables[i] != v {
			t.Errorf("variable %d = %+v, want %+v", i, c.Variables[i], v)
		}
	}

	// Folder: noauth means none, its script is kept and checked.
	orders := c.Items[0].Folder
	if orders == nil || orders.Name != "Orders" || orders.Auth.Type != model.AuthNone {
		t.Fatalf("orders folder = %+v", orders)
	}
	if !warningFor(f, "Orders", "CryptoJS") {
		t.Errorf("no CryptoJS warning: %+v", f.Warnings)
	}

	list := find(t, c.Items, "Orders", "List orders").Request
	if list.Method != "GET" || list.URL != "{{baseUrl}}/orders?page=1&q=a%20b" || list.Auth.Type != model.AuthInherit {
		t.Errorf("list orders = %s %s auth %s", list.Method, list.URL, list.Auth.Type)
	}
	wantQuery := []model.KeyValue{{Key: "page", Value: "1", Enabled: true}, {Key: "q", Value: "a b", Enabled: true}, {Key: "debug", Value: "true"}}
	if len(list.Query) != 3 || list.Query[0] != wantQuery[0] || list.Query[1] != wantQuery[1] || list.Query[2] != wantQuery[2] {
		t.Errorf("query = %+v", list.Query)
	}
	if len(list.Headers) != 2 || list.Headers[1].Enabled {
		t.Errorf("headers = %+v", list.Headers)
	}
	s := list.Settings
	if s.FollowRedirects == nil || *s.FollowRedirects || s.VerifyTLS == nil || *s.VerifyTLS || s.MaxRedirects == nil || *s.MaxRedirects != 3 || s.TimeoutMs != nil {
		t.Errorf("settings = %+v", s)
	}

	exs := find(t, c.Items, "Orders", "List orders").Examples
	if len(exs) != 2 {
		t.Fatalf("examples = %d", len(exs))
	}
	if e := exs[0]; e.Name != "Two orders" || e.StatusCode != 200 || e.Kind != model.KindJSON || e.ContentType != "application/json" ||
		e.Request.URL != "{{baseUrl}}/orders?page=1" || e.Request.Name != "List orders" {
		t.Errorf("example 0 = %+v", e)
	}
	if e := exs[1]; e.Name != "Example" || e.StatusCode != 404 || e.Kind != model.KindEmpty || e.Request.URL != list.URL || len(e.Headers) != 0 {
		t.Errorf("example 1 = %+v", e)
	}

	get := find(t, c.Items, "Orders", "Get order").Request
	if len(get.PathParams) != 1 || get.PathParams[0] != (model.KeyValue{Key: "id", Value: "42", Enabled: true}) {
		t.Errorf("path params = %+v", get.PathParams)
	}
	if len(get.Headers) != 2 || get.Headers[1].Value != "{{$randomUUID}}" {
		t.Errorf("string headers = %+v", get.Headers)
	}

	create := find(t, c.Items, "Create order").Request
	if create.Auth.Type != model.AuthBasic || create.Auth.Username != "me" || create.Auth.Password != "hunter2" {
		t.Errorf("basic auth = %+v", create.Auth)
	}
	if create.Body.Type != model.BodyRaw || create.Body.Language != model.LangJSON {
		t.Errorf("raw body = %+v", create.Body)
	}
	if strings.Contains(create.Scripts.Test, "throw 1") {
		t.Errorf("disabled script imported: %q", create.Scripts.Test)
	}
	if warningFor(f, "Create order", "pm.sendRequest") || !warningFor(f, "Create order", "legacy") {
		t.Errorf("script warnings missing: %+v", f.Warnings)
	}

	up := find(t, c.Items, "Upload").Request
	if up.URL != "https://files.example.com:8443/upload" || up.Body.Type != model.BodyFormData {
		t.Errorf("upload = %s %+v", up.URL, up.Body)
	}
	fd := up.Body.FormData
	if len(fd) != 5 || fd[1].FilePath != "/home/me/a.png" || fd[2].FilePath != "/home/me/b.png" ||
		fd[3].Kind != model.FormFile || fd[3].FilePath != "" || fd[4].Enabled || fd[4].ContentType != "text/plain" {
		t.Errorf("form data = %+v", fd)
	}

	if b := find(t, c.Items, "Login").Request.Body; b.Language != model.LangXML {
		t.Errorf("language from content type = %+v", b)
	}
	if b := find(t, c.Items, "Form").Request.Body; b.Type != model.BodyURLEncoded || len(b.URLEncoded) != 2 || b.URLEncoded[1].Enabled {
		t.Errorf("urlencoded = %+v", b)
	}
	if b := find(t, c.Items, "Binary").Request.Body; b.Type != model.BodyBinary || b.BinaryPath != "/tmp/data.bin" {
		t.Errorf("binary = %+v", b)
	}
	g := find(t, c.Items, "Graph").Request.Body
	if g.Type != model.BodyRaw || g.Language != model.LangJSON || !strings.Contains(g.Raw, `"query": "query { me { id } }"`) || !strings.Contains(g.Raw, `"variables": {"a": 1}`) {
		t.Errorf("graphql = %+v", g)
	}
	if !warningFor(f, "Graph", "GraphQL") {
		t.Errorf("no GraphQL warning")
	}
	if b := find(t, c.Items, "Disabled body").Request.Body; b.Type != model.BodyNone || b.Raw != "keep me" {
		t.Errorf("disabled body = %+v", b)
	}
	if r := find(t, c.Items, "Just a URL").Request; r.Method != "GET" || r.URL != "https://example.com/ping" {
		t.Errorf("string request = %+v", r)
	}
	if !warningFor(f, "Broken", "no request") {
		t.Errorf("no warning for an item without request")
	}
	last := c.Items[len(c.Items)-1].Folder
	if last == nil || last.Name != "Empty folder" || len(last.Items) != 0 || last.Auth.Type != model.AuthInherit {
		t.Errorf("empty folder = %+v", last)
	}

	// File-wide warnings.
	if !warningFor(f, "", "$randomEmail") || warningFor(f, "", "$randomUUID") {
		t.Errorf("dynamic variable warning wrong: %+v", f.Warnings)
	}
	if !warningFor(f, "", "Upload, Binary") {
		t.Errorf("file warning missing: %+v", f.Warnings)
	}
	if !warningFor(f, "", "apiKey") {
		t.Errorf("plain credential variable warning missing: %+v", f.Warnings)
	}
	if !warningFor(f, "", "Create order") {
		t.Errorf("plain auth credential warning missing: %+v", f.Warnings)
	}
}

func TestGuessSecrets(t *testing.T) {
	f := load(t, "collection-v21.json", Options{GuessSecrets: true})
	for _, v := range f.Collection.Variables {
		want := v.Key == "apiKey" || v.Key == "vaulted"
		if v.Secret != want {
			t.Errorf("%s secret = %v, want %v", v.Key, v.Secret, want)
		}
	}
	if warningFor(f, "", "Variables that look like credentials") {
		t.Errorf("plain variable warning with GuessSecrets on")
	}
}

func TestCollectionV20(t *testing.T) {
	f := load(t, "collection-v20.json", Options{})
	d := find(t, f.Collection.Items, "Digest").Request
	if d.Auth.Type != model.AuthDigest || *d.Auth.Digest != (model.Digest{Username: "u", Password: "{{pw}}", Algorithm: "MD5-sess", Qop: "auth-int"}) {
		t.Errorf("digest = %+v", d.Auth.Digest)
	}
	if len(f.Warnings) != 0 {
		t.Errorf("warnings = %+v", f.Warnings)
	}
	r := find(t, f.Collection.Items, "Rebuilt URL").Request
	if r.URL != "http://example.com/a/b?x=1#top" || len(r.Query) != 1 {
		t.Errorf("rebuilt URL = %q %+v", r.URL, r.Query)
	}
	if f.Collection.Auth.Type != model.AuthNone {
		t.Errorf("collection without auth = %s", f.Collection.Auth.Type)
	}
}

func TestEnvironmentAndGlobals(t *testing.T) {
	f := load(t, "environment.json", Options{GuessSecrets: true})
	if f.Kind != KindEnvironment || f.Name != "Staging" || f.Collection != nil {
		t.Fatalf("env = %+v", f)
	}
	want := []model.Variable{
		{Key: "baseUrl", Value: "https://staging.example.com", Enabled: true},
		{Key: "password", Value: "pa55", Enabled: true, Secret: true},
		{Key: "client_token", Value: "t0k", Secret: true},
		{Key: "tokenUrl", Value: "https://auth.example.com/token", Enabled: true},
	}
	if len(f.Variables) != len(want) {
		t.Fatalf("variables = %+v", f.Variables)
	}
	for i := range want {
		if f.Variables[i] != want[i] {
			t.Errorf("variable %d = %+v, want %+v", i, f.Variables[i], want[i])
		}
	}

	g := load(t, "globals.json", Options{})
	if g.Kind != KindGlobals || len(g.Variables) != 2 || !g.Variables[1].Secret {
		t.Errorf("globals = %+v", g)
	}
	unnamed, err := Parse([]byte(`{"values":[],"_postman_variable_scope":"globals"}`), Options{})
	if err != nil || unnamed.Name != "Globals" {
		t.Errorf("unnamed globals = %+v %v", unnamed, err)
	}
	unnamedEnv, err := Parse([]byte(`{"values":[{"key":"a","value":"{{$randomColor}}"}]}`), Options{})
	if err != nil || unnamedEnv.Name != "Imported environment" || unnamedEnv.Kind != KindEnvironment || !warningFor(unnamedEnv, "", "$randomColor") {
		t.Errorf("unnamed env = %+v %v", unnamedEnv, err)
	}
}

func TestParseErrors(t *testing.T) {
	tests := []struct {
		name string
		in   string
		want error
		msg  string
	}{
		{"not json", "hello", ErrNotJSON, "isn't valid JSON"},
		{"truncated", `{"info": {"name": "x"}, "item": [`, ErrNotJSON, "isn't valid JSON"},
		{"other json", `{"openapi": "3.0.0"}`, ErrNotPostman, "isn't a Postman"},
		{"array", `[1, 2]`, ErrNotPostman, "isn't a Postman"},
		{"v1", `{"id": "x", "name": "Old", "requests": [], "order": []}`, ErrV1Collection, "v1 format"},
		{"dump", `{"version": 1, "collections": [], "environments": []}`, ErrDataDump, "data dump"},
		{"v3 schema", `{"info": {"name": "x", "schema": "https://schema.getpostman.com/json/collection/v3.0.0/"}, "item": []}`, ErrUnsupportedV2, "can't read"},
		{"bad item", `{"info": {"name": "x"}, "item": "nope"}`, ErrNotPostman, ""},
		{"bad values", `{"values": 5}`, ErrNotPostman, ""},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			_, err := Parse([]byte(tt.in), Options{})
			if !errors.Is(err, tt.want) {
				t.Fatalf("err = %v, want %v", err, tt.want)
			}
			if !strings.Contains(Message(err), tt.msg) {
				t.Errorf("Message = %q, want %q", Message(err), tt.msg)
			}
		})
	}
	big := make([]byte, MaxFileSize+1)
	if _, err := Parse(big, Options{}); !errors.Is(err, ErrTooLarge) || !strings.Contains(Message(err), "too large") {
		t.Errorf("large file: %v", err)
	}
	if m := Message(errors.New("boom")); !strings.Contains(m, "boom") {
		t.Errorf("default message = %q", m)
	}
}

func TestBOMAndMissingSchema(t *testing.T) {
	f, err := Parse([]byte("\xef\xbb\xbf"+`{"info": {"name": ""}, "item": [{"name": "", "request": {"url": {"raw": "x"}}}, {"name": "", "item": []}]}`), Options{})
	if err != nil {
		t.Fatal(err)
	}
	if f.Name != "Imported collection" || f.Collection.Items[0].Request.Request.Name != "Untitled request" || f.Collection.Items[1].Folder.Name != "New folder" {
		t.Errorf("fallback names = %+v", f)
	}
}

// collectionWith wraps one request's auth (as JSON) in a collection.
func authOf(t *testing.T, auth string) (model.Auth, File) {
	t.Helper()
	f, err := Parse([]byte(`{"info": {"name": "A"}, "item": [{"name": "R", "request": {"url": "http://x", "auth": `+auth+`}}]}`), Options{})
	if err != nil {
		t.Fatal(err)
	}
	return f.Collection.Items[0].Request.Request.Auth, f
}

func TestAuthTypes(t *testing.T) {
	a, _ := authOf(t, `{"type": "apikey", "apikey": [{"key": "key", "value": "X-Key"}, {"key": "value", "value": "{{k}}"}, {"key": "in", "value": "query"}]}`)
	if a.Type != model.AuthAPIKey || a.APIKey != "X-Key" || a.APIValue != "{{k}}" || a.APIIn != model.APIKeyInQuery {
		t.Errorf("apikey = %+v", a)
	}
	a, _ = authOf(t, `{"type": "apikey", "apikey": [{"key": "key", "value": "X"}]}`)
	if a.APIIn != model.APIKeyInHeader {
		t.Errorf("apikey default in = %q", a.APIIn)
	}
	a, _ = authOf(t, `{"type": "awsv4", "awsv4": [{"key": "accessKey", "value": "AK"}, {"key": "secretKey", "value": "{{sk}}"}, {"key": "region", "value": "eu-west-1"}, {"key": "service", "value": "s3"}, {"key": "sessionToken", "value": "{{st}}"}]}`)
	if a.Type != model.AuthAWSV4 || *a.AWSV4 != (model.AWSV4{AccessKey: "AK", SecretKey: "{{sk}}", SessionToken: "{{st}}", Region: "eu-west-1", Service: "s3"}) {
		t.Errorf("awsv4 = %+v", a.AWSV4)
	}
	a, _ = authOf(t, `{"type": "hawk", "hawk": [{"key": "authId", "value": "id"}, {"key": "authKey", "value": "{{k}}"}, {"key": "algorithm", "value": "SHA1"}, {"key": "extraData", "value": "e"}, {"key": "app", "value": "a"}, {"key": "delegation", "value": "d"}, {"key": "includePayloadHash", "value": true}]}`)
	if a.Type != model.AuthHawk || *a.Hawk != (model.Hawk{ID: "id", Key: "{{k}}", Algorithm: "sha1", Ext: "e", App: "a", Dlg: "d", PayloadHash: true}) {
		t.Errorf("hawk = %+v", a.Hawk)
	}
	a, _ = authOf(t, `{"type": "ntlm", "ntlm": [{"key": "username", "value": "u"}, {"key": "password", "value": "{{p}}"}, {"key": "domain", "value": "D"}, {"key": "workstation", "value": "W"}]}`)
	if a.Type != model.AuthNTLM || *a.NTLM != (model.NTLM{Username: "u", Password: "{{p}}", Domain: "D", Workstation: "W"}) {
		t.Errorf("ntlm = %+v", a.NTLM)
	}
	a, _ = authOf(t, `{"type": "jwt", "jwt": [{"key": "algorithm", "value": "eddsa"}, {"key": "secret", "value": "{{s}}"}, {"key": "isSecretBase64Encoded", "value": false}, {"key": "payload", "value": "{\"sub\": 1}"}, {"key": "header", "value": {}}, {"key": "addTokenTo", "value": "queryParam"}, {"key": "queryParamKey", "value": "t"}]}`)
	if a.Type != model.AuthJWT || a.JWT.Algorithm != "EdDSA" || a.JWT.Payload != `{"sub": 1}` || a.JWT.Header != "" || a.JWT.Placement != model.PlaceQuery || a.JWT.QueryParam != "t" {
		t.Errorf("jwt = %+v", a.JWT)
	}
	a, _ = authOf(t, `{"type": "jwt", "jwt": [{"key": "algorithm", "value": "hs512"}, {"key": "headerPrefix", "value": "JWT"}]}`)
	if a.JWT.Algorithm != "HS512" || a.JWT.Placement != "" || a.JWT.HeaderPrefix != "JWT" {
		t.Errorf("jwt header = %+v", a.JWT)
	}
	a, _ = authOf(t, `{"type": "digest", "digest": [{"key": "algorithm", "value": "SHA-512-256"}, {"key": "qop", "value": "auth"}]}`)
	if a.Digest.Algorithm != "" || a.Digest.Qop != "" {
		t.Errorf("digest unsupported algorithm = %+v", a.Digest)
	}
	a, _ = authOf(t, `{"type": "inherit"}`)
	if a.Type != model.AuthInherit {
		t.Errorf("inherit = %s", a.Type)
	}
	a, f := authOf(t, `{"type": "oauth1", "oauth1": []}`)
	if a.Type != model.AuthNone || !warningFor(f, "R", "OAuth 1.0") {
		t.Errorf("oauth1 = %s %+v", a.Type, f.Warnings)
	}
	_, f = authOf(t, `{"type": "kerberos"}`)
	if !warningFor(f, "R", "kerberos auth") {
		t.Errorf("unknown auth warnings = %+v", f.Warnings)
	}
	_, f = authOf(t, `{"type": "bearer", "bearer": {"token": "literal"}}`)
	if !warningFor(f, "", "plain text") {
		t.Errorf("plain bearer warning missing: %+v", f.Warnings)
	}
}

func TestPlainCredential(t *testing.T) {
	tests := []struct {
		a    model.Auth
		want bool
	}{
		{model.Auth{Type: model.AuthNone, Password: "x"}, false},
		{model.Auth{Type: model.AuthBasic, Password: "{{p}}"}, false},
		{model.Auth{Type: model.AuthAPIKey, APIValue: "v"}, true},
		{model.Auth{Type: model.AuthDigest, Digest: &model.Digest{Password: "p"}}, true},
		{model.Auth{Type: model.AuthAWSV4, AWSV4: &model.AWSV4{SessionToken: "t"}}, true},
		{model.Auth{Type: model.AuthJWT, JWT: &model.JWT{Secret: "s"}}, true},
		{model.Auth{Type: model.AuthHawk, Hawk: &model.Hawk{Key: " "}}, false},
		{model.Auth{Type: model.AuthNTLM, NTLM: &model.NTLM{Password: "p"}}, true},
		{model.Auth{Type: model.AuthOAuth2, OAuth2: &model.OAuth2{Password: "p"}}, true},
	}
	for i, tt := range tests {
		if got := plainCredential(tt.a); got != tt.want {
			t.Errorf("%d: plainCredential(%s) = %v", i, tt.a.Type, got)
		}
	}
}

func TestOAuth2(t *testing.T) {
	tests := []struct {
		name   string
		params string
		check  func(o *model.OAuth2) bool
		warn   string
	}{
		{"pkce", `{"key": "grant_type", "value": "authorization_code_with_pkce"}, {"key": "challengeAlgorithm", "value": "plain"}, {"key": "redirect_uri", "value": "http://localhost:5000/cb"}`,
			func(o *model.OAuth2) bool {
				return o.Grant == model.GrantAuthorizationCode && !o.DisablePKCE && o.PKCEMethod == model.PKCEPlain && o.RedirectURL == "http://localhost:5000/cb"
			}, ""},
		{"code", `{"key": "grant_type", "value": "authorization_code"}, {"key": "redirect_uri", "value": "https://oauth.pstmn.io/v1/callback"}, {"key": "useBrowser", "value": false}`,
			func(o *model.OAuth2) bool { return o.DisablePKCE && o.RedirectURL == "" }, "callback URL https://oauth.pstmn.io/v1/callback"},
		{"browser callback", `{"key": "grant_type", "value": "implicit"}, {"key": "redirect_uri", "value": "https://oauth.pstmn.io/v1/callback"}, {"key": "useBrowser", "value": true}`,
			func(o *model.OAuth2) bool { return o.Grant == model.GrantImplicit && o.RedirectURL == "" }, ""},
		{"client credentials", `{"key": "grant_type", "value": "client_credentials"}, {"key": "accessTokenUrl", "value": "{{tokenUrl}}"}, {"key": "clientId", "value": "id"}, {"key": "clientSecret", "value": "{{secret}}"}, {"key": "scope", "value": "read"}, {"key": "client_authentication", "value": "body"}, {"key": "addTokenTo", "value": "queryParams"}, {"key": "tokenRequestParams", "value": [{"key": "audience", "value": "api", "enabled": true, "send_as": "request_body"}]}, {"key": "authRequestParams", "value": [{"key": "audience", "value": "dup"}, {"key": "off", "value": "1", "enabled": false}]}`,
			func(o *model.OAuth2) bool {
				return o.Grant == model.GrantClientCredentials && o.TokenURL == "{{tokenUrl}}" && o.ClientSecret == "{{secret}}" &&
					o.ClientAuth == model.ClientAuthBody && o.Placement == model.PlaceQuery && len(o.ExtraParams) == 2 &&
					o.ExtraParams[0] == (model.KeyValue{Key: "audience", Value: "dup", Enabled: true}) && !o.ExtraParams[1].Enabled
			}, ""},
		{"password", `{"key": "grant_type", "value": "password_credentials"}, {"key": "username", "value": "u"}, {"key": "password", "value": "{{p}}"}, {"key": "accessToken", "value": "eyJ"}`,
			func(o *model.OAuth2) bool { return o.Grant == model.GrantPassword && o.Username == "u" }, "access token in the export"},
		{"default grant", `{"key": "authUrl", "value": "https://a"}`,
			func(o *model.OAuth2) bool { return o.Grant == model.GrantAuthorizationCode && o.AuthURL == "https://a" }, ""},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			a, f := authOf(t, `{"type": "oauth2", "oauth2": [`+tt.params+`]}`)
			if a.Type != model.AuthOAuth2 || !tt.check(a.OAuth2) {
				t.Errorf("oauth2 = %+v", a.OAuth2)
			}
			if tt.warn != "" && !warningFor(f, "R", tt.warn) {
				t.Errorf("missing warning %q: %+v", tt.warn, f.Warnings)
			}
			if tt.warn == "" && len(f.Warnings) != 0 {
				t.Errorf("unexpected warnings: %+v", f.Warnings)
			}
		})
	}
}

func TestBodies(t *testing.T) {
	parse := func(body string) (model.Body, File) {
		t.Helper()
		f, err := Parse([]byte(`{"info": {"name": "A"}, "item": [{"name": "R", "request": {"method": "POST", "url": "http://x", "header": [{"key": "content-type", "value": "text/html"}], "body": `+body+`}}]}`), Options{})
		if err != nil {
			t.Fatal(err)
		}
		return f.Collection.Items[0].Request.Request.Body, f
	}
	b, _ := parse(`{"mode": "raw", "raw": ""}`)
	if b.Type != model.BodyNone {
		t.Errorf("empty raw = %+v", b)
	}
	b, _ = parse(`{"mode": "raw", "raw": "<p>"}`)
	if b.Language != model.LangHTML {
		t.Errorf("html from header = %+v", b)
	}
	b, _ = parse(`{"mode": "raw", "raw": "x", "options": {"raw": {"language": "javascript"}}}`)
	if b.Language != model.LangJavaScript {
		t.Errorf("javascript = %+v", b)
	}
	b, _ = parse(`{"mode": "graphql", "graphql": {"query": "{ a }"}}`)
	if !strings.Contains(b.Raw, `"variables": {}`) {
		t.Errorf("graphql without variables = %q", b.Raw)
	}
	b, f := parse(`{"mode": "carrier-pigeon"}`)
	if b.Type != model.BodyNone || !warningFor(f, "R", "carrier-pigeon") {
		t.Errorf("unknown mode = %+v %+v", b, f.Warnings)
	}
	b, _ = parse(`{"mode": "none"}`)
	if b.Type != model.BodyNone {
		t.Errorf("none = %+v", b)
	}
	b, f = parse(`{"mode": "file", "file": {}}`)
	if b.Type != model.BodyBinary || b.BinaryPath != "" || warningFor(f, "", "send files") {
		t.Errorf("file without src = %+v %+v", b, f.Warnings)
	}
}

func TestLanguageAndKinds(t *testing.T) {
	langs := map[string]model.RawLanguage{
		"application/vnd.api+json": model.LangJSON, "text/xml": model.LangXML, "text/html": model.LangHTML,
		"application/javascript": model.LangJavaScript, "text/plain": model.LangText, "": model.LangText,
	}
	for ct, want := range langs {
		if got := languageOf(ct); got != want {
			t.Errorf("languageOf(%q) = %s, want %s", ct, got, want)
		}
	}
	kinds := []struct {
		body, preview, ct string
		want              model.BodyKind
	}{
		{"", "json", "", model.KindEmpty},
		{"x", "xml", "", model.KindXML},
		{"x", "html", "", model.KindHTML},
		{"x", "", "application/json", model.KindJSON},
		{"x", "", "application/xml", model.KindXML},
		{"x", "", "text/html", model.KindHTML},
		{"x", "text", "text/plain", model.KindText},
	}
	for _, k := range kinds {
		if got := bodyKind(k.body, k.preview, k.ct); got != k.want {
			t.Errorf("bodyKind(%q, %q, %q) = %s, want %s", k.body, k.preview, k.ct, got, k.want)
		}
	}
}

func TestLargeExampleDropped(t *testing.T) {
	body := strings.Repeat("a", MaxExampleBody+1)
	f, err := Parse([]byte(`{"info": {"name": "A"}, "item": [{"name": "R", "request": "http://x", "response": [{"name": "Big", "code": 200, "body": "`+body+`"}]}]}`), Options{})
	if err != nil {
		t.Fatal(err)
	}
	if n := len(f.Collection.Items[0].Request.Examples); n != 0 || !warningFor(f, "R", `"Big"`) {
		t.Errorf("examples = %d, warnings %+v", n, f.Warnings)
	}
}

func TestScriptChecks(t *testing.T) {
	tests := []struct {
		src  string
		want string
	}{
		{"pm.request.auth.type", "pm.request.auth"},
		{"pm.vault.get('x')", "pm.vault"},
		{"pm.visualizer.set('')", "pm.visualizer"},
		{"pm.require('@team/lib')", "pm.require"},
		{"pm.execution.runRequest('id')", "pm.execution.runRequest"},
		{"const x = require('lodash')", "require()"},
		{"setTimeout(() => {}, 1)", "timers"},
		{"_.get(a, 'b')", "lodash"},
		{"moment().format()", "moment"},
		{"const $ = cheerio.load(x)", "bundled libraries"},
		{"postman.setEnvironmentVariable('a', 1)", "legacy"},
	}
	for _, ok := range []string{"pm.sendRequest('x', () => {})", "pm.cookies.get('a')"} {
		c := &converter{}
		if c.checkScript("R", ok); len(c.warnings) != 0 {
			t.Errorf("%q: warnings = %+v", ok, c.warnings)
		}
	}
	for _, tt := range tests {
		c := &converter{}
		c.checkScript("R", tt.src)
		if len(c.warnings) != 1 || !strings.Contains(c.warnings[0].Message, tt.want) {
			t.Errorf("%q: warnings = %+v, want %q", tt.src, c.warnings, tt.want)
		}
	}
	for _, ok := range []string{"pm.test('a', () => pm.expect(1).to.eql(1))", "postman.setNextRequest('x')", "my_.get(1)", "foo.require(1)", ""} {
		c := &converter{}
		c.checkScript("R", ok)
		if len(c.warnings) != 0 {
			t.Errorf("%q: unexpected warnings %+v", ok, c.warnings)
		}
	}
}

func TestLooksSecret(t *testing.T) {
	for name, want := range map[string]bool{
		"password": true, "client_secret": true, "accessToken": true, "apiKey": true, "api-key": true, "x_api_key": true,
		"privateKey": true, "sessionId": true, "pwd": true, "key": true, "Passphrase": true,
		"tokenUrl": false, "accessTokenUrl": false, "tokenType": false, "keyName": false, "baseUrl": false, "user": false,
		"tokenExpiry": false, "monkey": false,
	} {
		if got := LooksSecret(name); got != want {
			t.Errorf("LooksSecret(%q) = %v, want %v", name, got, want)
		}
	}
}

func TestListSome(t *testing.T) {
	if got := listSome([]string{"a", "b", "c"}, 2); got != "a, b and 1 more" {
		t.Errorf("listSome = %q", got)
	}
	if plural(1, "request", "requests") != "1 request" || plural(2, "request", "requests") != "2 requests" {
		t.Error("plural")
	}
}
