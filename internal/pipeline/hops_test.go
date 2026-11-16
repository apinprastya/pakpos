package pipeline

import (
	"encoding/base64"
	"reflect"
	"strings"
	"testing"

	"pakpos/internal/core/model"
)

func TestSendSecretsForDrafts(t *testing.T) {
	f := newFixture(t)
	// An unsaved draft in the collection sees the collection's secret.
	draft := model.Request{Method: "GET", URL: "https://x"}
	got, locked := f.sess.SendSecrets(draft, f.folder.ID, "")
	if locked || !containsValue(got, "s3cret") {
		t.Fatalf("draft in folder = %+v (locked %v)", got, locked)
	}
	// Without a parent it doesn't.
	if got, _ := f.sess.SendSecrets(draft, "", ""); containsValue(got, "s3cret") {
		t.Fatalf("draft without parent = %+v", got)
	}
}

func containsValue(values []SecretValue, s string) bool {
	for _, v := range values {
		if v.Value == s {
			return true
		}
	}
	return false
}

func TestMaskHops(t *testing.T) {
	values := []SecretValue{{"token", "s3cret-token"}, {"key", "k3y-value"}}
	hops := []model.Hop{
		{
			URL:   "https://x/?api=k3y-value",
			Error: "",
			RequestHeaders: []model.KeyValue{
				{Key: "Authorization", Value: "Bearer s3cret-token", Enabled: true},
				{Key: "k3y-value", Value: "odd", Enabled: true},
			},
			RequestBody:         `{"token":"s3cret-token"}`,
			RequestBodyEncoding: model.EncodingUTF8,
			ResponseHeaders:     []model.KeyValue{{Key: "X-Echo", Value: "k3y-value", Enabled: true}},
		},
		{
			URL: "https://y", Error: "refused for s3cret-token",
			RequestBody:          "start s3cret",
			RequestBodyEncoding:  model.EncodingUTF8,
			RequestBodyTruncated: true,
			RequestHeaders:       []model.KeyValue{},
			ResponseHeaders:      []model.KeyValue{},
		},
		{
			RequestBody:         base64.StdEncoding.EncodeToString([]byte("\x00\xffk3y-value")),
			RequestBodyEncoding: model.EncodingBase64,
		},
		{
			RequestBody:         base64.StdEncoding.EncodeToString([]byte("\x00\xffplain")),
			RequestBodyEncoding: model.EncodingBase64,
		},
		{RequestBody: "!!not base64", RequestBodyEncoding: model.EncodingBase64},
	}
	before := hops[0].RequestHeaders[0].Value
	got := MaskHops(hops, values)

	h := got[0]
	if h.URL != "https://x/?api={{key}}" || h.RequestHeaders[0].Value != "Bearer {{token}}" || h.RequestHeaders[1].Key != "{{key}}" ||
		h.RequestBody != `{"token":"{{token}}"}` || h.ResponseHeaders[0].Value != "{{key}}" {
		t.Errorf("hop 0 = %+v", h)
	}
	if hops[0].RequestHeaders[0].Value != before {
		t.Error("MaskHops changed its input")
	}
	// A body cut off partway into a secret has that part masked.
	if got[1].RequestBody != "start {{token}}" || got[1].Error != "refused for {{token}}" {
		t.Errorf("hop 1 = %+v", got[1])
	}
	// Binary with a secret is dropped; without one it stays.
	if got[2].RequestBody != "" || got[2].RequestBodyNote != BinarySecretNote || got[2].RequestBodyEncoding != model.EncodingUTF8 {
		t.Errorf("binary with secret = %+v", got[2])
	}
	if got[3].RequestBody != hops[3].RequestBody || got[3].RequestBodyNote != "" {
		t.Errorf("binary without secret = %+v", got[3])
	}
	if got[4].RequestBody != "" || got[4].RequestBodyNote != BinarySecretNote {
		t.Errorf("undecodable body = %+v", got[4])
	}

	// No secrets: hops come back as they were.
	if plain := MaskHops(hops, nil); !reflect.DeepEqual(plain, hops) {
		t.Errorf("without secrets = %+v", plain)
	}
}

func TestMaskCutOff(t *testing.T) {
	values := []SecretValue{{"t", "abcdefgh"}}
	for in, want := range map[string]string{
		"x abcdefg": "x {{t}}",
		"x abcd":    "x {{t}}",
		"x abc":     "x abc", // shorter than MinSecretLength: too common to mask
		"x":         "x",
	} {
		if got := maskCutOff(in, values); got != want {
			t.Errorf("maskCutOff(%q) = %q, want %q", in, got, want)
		}
	}
	if got := maskCutOff("é-abc\xc3", []SecretValue{{"u", "abc\xc3\xa9zz"}}); !strings.HasSuffix(got, "{{u}}") {
		t.Errorf("multi-byte cut = %q", got)
	}
}
