package pipeline

import (
	"encoding/base64"
	"errors"
	"reflect"
	"strings"
	"testing"

	"pakpos/internal/core/model"
	"pakpos/internal/secrets"
	"pakpos/internal/store/fsstore"
)

func TestSecretValues(t *testing.T) {
	f := newFixture(t)
	wsID := f.ws.Manifest().ID
	f.dev = must(f.ws.SaveEnvironmentVariables(f.dev.ID, []model.Variable{secret("apiKey"), secret("pin"), {Key: "off", Enabled: false, Secret: true}}))
	_ = f.sec.Set(secrets.Key(wsID, f.dev.ID, "apiKey"), "dev-key-123")
	_ = f.sec.Set(secrets.Key(wsID, f.dev.ID, "pin"), "123") // too short to look for
	_ = f.sec.Set(secrets.Key(wsID, f.dev.ID, "off"), "disabled-value")
	_ = must(f.ws.SaveGlobals([]model.Variable{secret("gpw")}))
	_ = f.sec.Set(secrets.Key(wsID, f.globalID, "gpw"), "global-password")

	got, locked := f.sess.SecretValues(f.req.ID, f.dev.ID)
	want := []SecretValue{{"gpw", "global-password"}, {"apiKey", "dev-key-123"}, {"token", "s3cret"}}
	if locked || !reflect.DeepEqual(got, want) {
		t.Fatalf("values = %+v locked=%v", got, locked)
	}
	// No environment: only globals and the collection.
	if got, _ := f.sess.SecretValues(f.req.ID, ""); len(got) != 2 {
		t.Fatalf("without environment = %+v", got)
	}
	f.sec.Err = secrets.ErrLocked
	if _, locked := f.sess.SecretValues(f.req.ID, f.dev.ID); !locked {
		t.Fatal("a locked store must be reported")
	}
}

func echoExample() fsstore.Example {
	return fsstore.Example{
		Name: "200 OK",
		Request: model.Request{
			URL:     "https://x/?key=literal-key-999",
			Headers: []model.KeyValue{{Key: "Authorization", Value: "Bearer {{token}}", Enabled: true}},
			Body:    model.Body{FormData: []model.FormField{{Key: "f", Value: "v"}}, URLEncoded: []model.KeyValue{{Key: "a", Value: "b"}}},
		},
		Response: fsstore.ExampleResponse{
			StatusCode: 200,
			Headers:    []model.KeyValue{{Key: "X-Echo", Value: "Bearer tok-SECRET", Enabled: true}},
			Body:       `{"auth":"Bearer tok-SECRET","again":"tok-SECRET"}`,
			Encoding:   model.EncodingUTF8,
			Size:       49,
		},
	}
}

var echoValues = []SecretValue{{"token", "tok-SECRET"}, {"literal", "literal-key-999"}, {"unused", "not-there"}}

func TestScanExample(t *testing.T) {
	ex := echoExample()
	if got := ScanExample(ex, echoValues); !reflect.DeepEqual(got, []string{"token", "literal"}) {
		t.Fatalf("found = %v", got)
	}
	// The same name in two scopes is listed once.
	if got := ScanExample(ex, []SecretValue{{"token", "tok-SECRET"}, {"token", "Bearer"}}); !reflect.DeepEqual(got, []string{"token"}) {
		t.Fatalf("dedup = %v", got)
	}
	if got := ScanExample(ex, nil); len(got) != 0 {
		t.Fatalf("no values = %v", got)
	}
	// A base64 body is searched decoded.
	bin := fsstore.Example{Response: fsstore.ExampleResponse{
		Encoding: model.EncodingBase64, Body: base64.StdEncoding.EncodeToString([]byte{0xff, 't', 'o', 'k', '-', 'S', 'E', 'C', 'R', 'E', 'T'}),
	}}
	if got := ScanExample(bin, echoValues); !reflect.DeepEqual(got, []string{"token"}) {
		t.Fatalf("base64 = %v", got)
	}
	// An undecodable "base64" body is searched as it is.
	bad := fsstore.Example{Response: fsstore.ExampleResponse{Encoding: model.EncodingBase64, Body: "!!tok-SECRET"}}
	if got := ScanExample(bad, echoValues); len(got) != 1 {
		t.Fatalf("bad base64 = %v", got)
	}
}

func TestMaskExample(t *testing.T) {
	ex := echoExample()
	out, err := MaskExample(ex, echoValues)
	if err != nil {
		t.Fatal(err)
	}
	if out.Response.Body != `{"auth":"Bearer {{token}}","again":"{{token}}"}` || out.Response.Size != int64(len(out.Response.Body)) {
		t.Fatalf("body = %s (%d)", out.Response.Body, out.Response.Size)
	}
	if out.Response.Headers[0].Value != "Bearer {{token}}" || out.Request.URL != "https://x/?key={{literal}}" {
		t.Fatalf("headers/url = %+v %s", out.Response.Headers, out.Request.URL)
	}
	if got := ScanExample(out, echoValues); len(got) != 0 {
		t.Fatalf("still found %v", got)
	}
	// The input is untouched.
	if ex.Response.Headers[0].Value != "Bearer tok-SECRET" || !strings.Contains(ex.Response.Body, "tok-SECRET") {
		t.Fatal("MaskExample changed its input")
	}

	// Base64 text stays base64.
	text := fsstore.Example{Response: fsstore.ExampleResponse{
		Encoding: model.EncodingBase64, Body: base64.StdEncoding.EncodeToString([]byte("id tok-SECRET")),
	}}
	out, err = MaskExample(text, echoValues)
	if err != nil {
		t.Fatal(err)
	}
	if dec, _ := base64.StdEncoding.DecodeString(out.Response.Body); string(dec) != "id {{token}}" || out.Response.Encoding != model.EncodingBase64 {
		t.Fatalf("base64 text = %q", dec)
	}

	// Binary with a secret in it: refused. Binary without one: unchanged.
	bin := fsstore.Example{Response: fsstore.ExampleResponse{
		Encoding: model.EncodingBase64, Body: base64.StdEncoding.EncodeToString([]byte("\xfftok-SECRET")),
	}}
	if _, err := MaskExample(bin, echoValues); !errors.Is(err, ErrBinarySecret) {
		t.Fatalf("binary err = %v", err)
	}
	clean := fsstore.Example{Response: fsstore.ExampleResponse{Encoding: model.EncodingBase64, Body: base64.StdEncoding.EncodeToString([]byte{0xff, 0})}}
	if got, err := MaskExample(clean, echoValues); err != nil || got.Response.Body != clean.Response.Body {
		t.Fatalf("clean binary = %+v %v", got.Response, err)
	}
}

func TestEncodedForms(t *testing.T) {
	got := EncodedForms([]SecretValue{{"k", "a+b/c?d=e f"}, {"s", "plain"}, {"q", `say "hi"`}})
	has := func(name, val string) bool {
		for _, sv := range got {
			if sv.Name == name && sv.Value == val {
				return true
			}
		}
		return false
	}
	for _, want := range []SecretValue{
		{"k", base64.StdEncoding.EncodeToString([]byte("a+b/c?d=e f"))},
		{"k", base64.RawURLEncoding.EncodeToString([]byte("a+b/c?d=e f"))},
		{"k", "a%2Bb%2Fc%3Fd%3De+f"},   // query escaping
		{"k", "a+b%2Fc%3Fd=e%20f"},     // path escaping
		{"k", "a%2Bb%2Fc%3Fd%3De%20f"}, // strict query escaping (httpexec)
		{"q", `say \"hi\"`},            // JSON string escaping
		{"s", "cGxhaW4="},
		{"s", "cGxhaW4"},
	} {
		if !has(want.Name, want.Value) {
			t.Errorf("missing %+v in %+v", want, got)
		}
	}
	// URL encoding that changes nothing isn't repeated.
	for _, sv := range got {
		if sv.Value == "plain" {
			t.Errorf("unchanged form listed: %+v", sv)
		}
	}
	if len(EncodedForms(nil)) != 0 {
		t.Error("no values, no forms")
	}
}

func TestExampleSecrets(t *testing.T) {
	f := newFixture(t)
	wsID := f.ws.Manifest().ID
	f.dev = must(f.ws.SaveEnvironmentVariables(f.dev.ID, []model.Variable{v("user", "alice"), secret("pw")}))
	_ = f.sec.Set(secrets.Key(wsID, f.dev.ID, "pw"), "hunter22")
	creds := base64.StdEncoding.EncodeToString([]byte("alice:hunter22"))
	contains := func(values []SecretValue, sv SecretValue) bool {
		for _, x := range values {
			if x == sv {
				return true
			}
		}
		return false
	}

	basic := model.Request{Method: "GET", URL: "https://x", Auth: model.Auth{Type: model.AuthBasic, Username: "{{user}}", Password: "{{pw}}"}}
	got, locked := f.sess.ExampleSecrets(f.req.ID, f.dev.ID, basic)
	if locked {
		t.Fatal("not locked")
	}
	for _, want := range []SecretValue{
		{"pw", "hunter22"}, {"token", "s3cret"},
		{"pw", base64.StdEncoding.EncodeToString([]byte("hunter22"))},
		{"token", base64.StdEncoding.EncodeToString([]byte("s3cret"))},
		{"pw", creds}, {"pw", strings.TrimRight(creds, "=")},
	} {
		if !contains(got, want) {
			t.Errorf("missing %+v", want)
		}
	}
	for i := 1; i < len(got); i++ {
		if len(got[i].Value) > len(got[i-1].Value) {
			t.Fatalf("not longest first: %+v", got)
		}
	}

	// A secret username counts too; the password is checked first.
	f.dev = must(f.ws.SaveEnvironmentVariables(f.dev.ID, []model.Variable{secret("user"), v("pw", "plain-pass")}))
	_ = f.sec.Set(secrets.Key(wsID, f.dev.ID, "user"), "root-admin")
	got, _ = f.sess.ExampleSecrets(f.req.ID, f.dev.ID, basic)
	if !contains(got, SecretValue{"user", base64.StdEncoding.EncodeToString([]byte("root-admin:plain-pass"))}) {
		t.Errorf("secret username: %+v", got)
	}

	// Literal credentials, or auth that isn't basic, add no credentials.
	literal := basic
	literal.Auth = model.Auth{Type: model.AuthBasic, Username: "bob", Password: "literal"}
	got, _ = f.sess.ExampleSecrets(f.req.ID, f.dev.ID, literal)
	if contains(got, SecretValue{"user", base64.StdEncoding.EncodeToString([]byte("bob:literal"))}) {
		t.Errorf("literal credentials listed: %+v", got)
	}
	// The request inherits bearer auth from the collection: no Basic header.
	inherited := model.Request{Method: "GET", URL: "https://x", Auth: model.Auth{Type: model.AuthInherit}}
	got, _ = f.sess.ExampleSecrets(f.req.ID, f.dev.ID, inherited)
	for _, sv := range got {
		if sv.Name == "user" && len(sv.Value) > len("root-admin")*2 {
			t.Errorf("unexpected credentials: %+v", sv)
		}
	}
	// A variable loop can't be resolved: the plain and encoded values remain.
	f.dev = must(f.ws.SaveEnvironmentVariables(f.dev.ID, []model.Variable{v("a", "{{b}}"), v("b", "{{a}}")}))
	loop := basic
	loop.Auth.Username = "{{a}}"
	got, _ = f.sess.ExampleSecrets(f.req.ID, f.dev.ID, loop)
	if !contains(got, SecretValue{"token", "s3cret"}) {
		t.Errorf("loop: %+v", got)
	}
}

func TestScanAndMaskEchoedBasicAuth(t *testing.T) {
	creds := base64.StdEncoding.EncodeToString([]byte("alice:hunter22"))
	values := dedupe(append([]SecretValue{{"pw", "hunter22"}, {"pw", creds}}, EncodedForms([]SecretValue{{"pw", "hunter22"}})...))
	ex := fsstore.Example{Response: fsstore.ExampleResponse{
		Body:     `{"headers":{"Authorization":"Basic ` + creds + `"},"q":"hunter%2022"}`,
		Encoding: model.EncodingUTF8,
	}}
	if got := ScanExample(ex, values); !reflect.DeepEqual(got, []string{"pw"}) {
		t.Fatalf("found = %v", got)
	}
	masked, err := MaskExample(ex, values)
	if err != nil || strings.Contains(masked.Response.Body, creds) || !strings.Contains(masked.Response.Body, "Basic {{pw}}") {
		t.Fatalf("masked = %q err=%v", masked.Response.Body, err)
	}
}

func TestAuthSecretsAndCopy(t *testing.T) {
	tests := []struct {
		a    model.Auth
		want []string
	}{
		{model.Auth{Type: model.AuthDigest, Digest: &model.Digest{Password: "digest-pw"}}, []string{"digestPassword"}},
		{model.Auth{Type: model.AuthAWSV4, AWSV4: &model.AWSV4{SecretKey: "aws-secret", SessionToken: "aws-token"}}, []string{"awsSecretKey", "awsSessionToken"}},
		{model.Auth{Type: model.AuthJWT, JWT: &model.JWT{Secret: "jwt-secret"}}, []string{"jwtSecret"}},
		{model.Auth{Type: model.AuthHawk, Hawk: &model.Hawk{Key: "hawk-key"}}, []string{"hawkKey"}},
		{model.Auth{Type: model.AuthNTLM, NTLM: &model.NTLM{Password: "ntlm-pw"}}, []string{"ntlmPassword"}},
		{model.Auth{Type: model.AuthNTLM, NTLM: &model.NTLM{Password: "pw"}}, nil},
		{model.Auth{Type: model.AuthBasic, Digest: &model.Digest{Password: "inactive"}}, nil},
	}
	for _, tt := range tests {
		var got []string
		for _, v := range AuthSecrets(tt.a) {
			got = append(got, v.Name)
		}
		if strings.Join(got, ",") != strings.Join(tt.want, ",") {
			t.Errorf("%s: %v", tt.a.Type, got)
		}
	}
	in := model.Auth{OAuth2: &model.OAuth2{}, Digest: &model.Digest{}, AWSV4: &model.AWSV4{}, JWT: &model.JWT{}, Hawk: &model.Hawk{}, NTLM: &model.NTLM{}}
	out := copyAuth(in)
	if out.OAuth2 == in.OAuth2 || out.Digest == in.Digest || out.AWSV4 == in.AWSV4 || out.JWT == in.JWT || out.Hawk == in.Hawk || out.NTLM == in.NTLM {
		t.Error("copyAuth shares a block")
	}
}
