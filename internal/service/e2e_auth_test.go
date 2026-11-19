package service

import (
	"context"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"pakpos/internal/core/auth/awsv4"
	"pakpos/internal/core/auth/digest"
	"pakpos/internal/core/jwtx"
	"pakpos/internal/core/model"
	"pakpos/internal/core/vars"
	"pakpos/internal/pipeline"
	"pakpos/internal/store/fsstore"
	"pakpos/internal/testnet"
)

// Secret values of the other auth types; none may reach the workspace
// files, SQLite, the hops or generated code (without reveal).
var otherAuthSecrets = map[string]string{
	"digestPw":   "digest-PW-7d1c",
	"awsSecret":  "aws-SECRET-91fe0a",
	"awsToken":   "aws-TOKEN-55c2e1",
	"jwtKey":     "jwt-KEY-0b77aa31",
	"hawkKey":    "hawk-KEY-c03d8e",
	"ntlmPw":     "ntlm-PW-a8e4f2",
	"literalTok": "literal-TOKEN-3f9e2b",
}

// TestEndToEndOtherAuth sends with Digest, AWS Signature v4, JWT, Hawk and
// NTLM auth inherited from a collection, with the secrets in secret
// collection variables, against test servers that verify each scheme.
func TestEndToEndOtherAuth(t *testing.T) {
	ok := http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) { _, _ = w.Write([]byte(`{"ok":true}`)) })
	mux := http.NewServeMux()
	mux.Handle("/digest", testnetDigest(ok))
	mux.Handle("/aws", testnetAWS(ok))
	mux.Handle("/jwt", testnetJWT(ok))
	mux.Handle("/hawk", testnetHawk(ok))
	mux.Handle("/ntlm", testnetNTLM(ok))
	srv := httptest.NewServer(mux)
	t.Cleanup(srv.Close)

	h := newHarness(t)
	info := h.openWorkspace(t)
	col, err := h.ws.CreateCollection("API")
	if err != nil {
		t.Fatal(err)
	}
	ref := pipeline.ScopeRef{Kind: vars.ScopeCollection, ID: col.ID}
	vs := []model.Variable{{Key: "base", Value: srv.URL, Enabled: true}}
	for k := range otherAuthSecrets {
		vs = append(vs, model.Variable{Key: k, Enabled: true, Secret: true})
	}
	if _, err := h.env.SaveVariables(ref, vs, nil); err != nil {
		t.Fatal(err)
	}
	for k, v := range otherAuthSecrets {
		if err := h.env.SetSecret(ref, k, v); err != nil {
			t.Fatal(err)
		}
	}

	tests := []struct {
		name string
		path string
		auth model.Auth
		hops int
	}{
		{"digest", "/digest", model.Auth{Type: model.AuthDigest, Digest: &model.Digest{Username: "ann", Password: "{{digestPw}}"}}, 2},
		{"aws", "/aws", model.Auth{Type: model.AuthAWSV4, AWSV4: &model.AWSV4{AccessKey: "AKID", SecretKey: "{{awsSecret}}", SessionToken: "{{awsToken}}", Region: "eu-west-1", Service: "execute-api"}}, 1},
		{"jwt", "/jwt", model.Auth{Type: model.AuthJWT, JWT: &model.JWT{Secret: "{{jwtKey}}", Payload: `{"sub":"{{base}}"}`, LifetimeSeconds: 60}}, 1},
		{"hawk", "/hawk", model.Auth{Type: model.AuthHawk, Hawk: &model.Hawk{ID: "id1", Key: "{{hawkKey}}", PayloadHash: true}}, 1},
		{"ntlm", "/ntlm", model.Auth{Type: model.AuthNTLM, NTLM: &model.NTLM{Username: "ann", Domain: "CORP", Password: "{{ntlmPw}}"}}, 2},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if _, err := h.ws.SaveCollection(col.ID, fsstoreSettings(tt.auth, vs), nil); err != nil {
				t.Fatal(err)
			}
			req, err := h.req.SaveAs(col.ID, tt.name, model.Request{Method: "POST", URL: "{{base}}" + tt.path,
				Body: model.Body{Type: model.BodyRaw, Language: model.LangJSON, Raw: `{"n":1}`}, Auth: model.Auth{Type: model.AuthInherit}})
			if err != nil {
				t.Fatal(err)
			}
			res, err := h.req.Send(context.Background(), model.NewID(), req, "")
			if err != nil || res.Error != nil {
				t.Fatalf("send: %v %+v", err, res.Error)
			}
			if res.Response.StatusCode != 200 || len(res.Hops) != tt.hops {
				t.Fatalf("status %d (%s), %d hops", res.Response.StatusCode, res.Response.Body, len(res.Hops))
			}
			for _, hop := range res.Hops {
				for _, kv := range hop.RequestHeaders {
					for name, v := range otherAuthSecrets {
						if strings.Contains(kv.Value, v) {
							t.Errorf("%s in hop header %s", name, kv.Key)
						}
					}
				}
			}
			if tt.name == "aws" && !strings.Contains(hopValue(res.Hops[0], "X-Amz-Security-Token"), "[secret:awsToken]") {
				t.Errorf("session token not masked: %q", hopValue(res.Hops[0], "X-Amz-Security-Token"))
			}
			code, err := h.req.GenerateCode(req, "", "curl", CodeOptions{ResolveVariables: true})
			if err != nil {
				t.Fatal(err)
			}
			for _, v := range otherAuthSecrets {
				if strings.Contains(code.Code, v) {
					t.Errorf("secret in generated code:\n%s", code.Code)
				}
			}
			// Revealed, cURL writes the credentials for its own options.
			if tt.name == "digest" {
				revealed, _ := h.req.GenerateCode(req, "", "curl", CodeOptions{ResolveVariables: true, RevealSecrets: true})
				if !strings.Contains(revealed.Code, "--digest") || !strings.Contains(revealed.Code, otherAuthSecrets["digestPw"]) {
					t.Errorf("revealed code:\n%s", revealed.Code)
				}
			}
		})
	}

	// A literal session token is masked by its field name.
	lit := model.Request{Method: "GET", URL: srv.URL + "/aws", Auth: model.Auth{Type: model.AuthAWSV4, AWSV4: &model.AWSV4{
		AccessKey: "AKID", SecretKey: "literal-SK-1234", SessionToken: otherAuthSecrets["literalTok"], Region: "eu-west-1", Service: "execute-api"}}}
	res, err := h.req.Send(context.Background(), model.NewID(), lit, "")
	if err != nil || res.Response == nil || res.Response.StatusCode != 403 { // other keys than the server's
		t.Fatalf("literal: %v %+v", err, res.Error)
	}
	if got := hopValue(res.Hops[0], "X-Amz-Security-Token"); got != "[secret:awsSessionToken]" {
		t.Errorf("literal token in hop: %q", got)
	}

	// An incomplete signed auth fails with kind auth.
	bad := model.Request{Method: "GET", URL: srv.URL + "/jwt", Auth: model.Auth{Type: model.AuthJWT, JWT: &model.JWT{}}}
	if res, _ := h.req.Send(context.Background(), model.NewID(), bad, ""); res.Error == nil || res.Error.Kind != "auth" {
		t.Errorf("incomplete jwt: %+v", res.Error)
	}

	manifest, _ := os.ReadFile(filepath.Join(info.Path, "pakpos.yaml"))
	if !strings.Contains(string(manifest), "version: 3") {
		t.Errorf("manifest not upgraded:\n%s", manifest)
	}
	for name, v := range otherAuthSecrets {
		if name == "literalTok" {
			continue // typed in as is: history keeps the request as written
		}
		assertNoSecret(t, v, info.Path, h.dataDir)
	}
	assertNoSecret(t, otherAuthSecrets["literalTok"], info.Path)
}

func hopValue(hop model.Hop, name string) string {
	for _, kv := range hop.RequestHeaders {
		if strings.EqualFold(kv.Key, name) {
			return kv.Value
		}
	}
	return ""
}

func testnetDigest(next http.Handler) http.Handler {
	return testnet.Digest(testnet.DigestConfig{User: "ann", Password: otherAuthSecrets["digestPw"], Realm: "api", Algorithm: digest.SHA256, Qop: []string{"auth"}}, next)
}

func testnetAWS(next http.Handler) http.Handler {
	return testnet.AWSV4(awsv4.Credentials{AccessKey: "AKID", SecretKey: otherAuthSecrets["awsSecret"], SessionToken: otherAuthSecrets["awsToken"]}, "eu-west-1", "execute-api", next)
}

func testnetJWT(next http.Handler) http.Handler {
	return testnet.JWT(jwtx.Key{Kind: jwtx.KeySecret, Data: []byte(otherAuthSecrets["jwtKey"])}, "", next)
}

func testnetHawk(next http.Handler) http.Handler {
	return testnet.Hawk("id1", otherAuthSecrets["hawkKey"], "sha256", next)
}

func testnetNTLM(next http.Handler) http.Handler {
	return testnet.NTLM("ann", "CORP", otherAuthSecrets["ntlmPw"], next)
}

func fsstoreSettings(a model.Auth, vs []model.Variable) fsstore.CollectionSettings {
	return fsstore.CollectionSettings{Auth: a, Variables: vs}
}
