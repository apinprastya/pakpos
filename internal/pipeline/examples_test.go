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
