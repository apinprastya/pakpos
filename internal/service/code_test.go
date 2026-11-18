package service

import (
	"strings"
	"testing"

	"pakpos/internal/core/model"
	"pakpos/internal/core/vars"
	"pakpos/internal/pipeline"
	"pakpos/internal/store/fsstore"
)

func TestImportCurl(t *testing.T) {
	h := newHarness(t)
	got, err := h.req.ImportCurl(`curl -k https://a.com -d x=1`)
	if err != nil {
		t.Fatal(err)
	}
	if got.Request.Method != "POST" || got.Request.Name != "POST /" || got.Request.Body.Type != model.BodyURLEncoded || len(got.Warnings) != 0 ||
		got.Request.Settings.VerifyTLS == nil || *got.Request.Settings.VerifyTLS {
		t.Fatalf("%+v", got)
	}
	got, err = h.req.ImportCurl(`curl https://a.com`)
	if err != nil || got.Warnings == nil {
		t.Fatalf("warnings must not be nil: %+v %v", got, err)
	}
	if _, err := h.req.ImportCurl("wget https://a.com"); err == nil || !strings.Contains(err.Error(), "isn't a curl command") {
		t.Fatalf("err = %v", err)
	}
}

func TestCodeLanguages(t *testing.T) {
	h := newHarness(t)
	langs := h.req.CodeLanguages()
	if len(langs) < 7 || langs[0].ID != "curl" {
		t.Fatalf("%+v", langs)
	}
}

func TestGenerateCodeWithoutWorkspace(t *testing.T) {
	h := newHarness(t)
	req := model.Request{Method: "GET", URL: "https://a.com/{{nope}}"}
	res, err := h.req.GenerateCode(req, "", "curl", CodeOptions{ResolveVariables: true})
	if err != nil {
		t.Fatal(err)
	}
	if res.Code != "curl -g 'https://a.com/{{nope}}'\n" || len(res.Unresolved) != 1 || res.Masked == nil || res.Warnings == nil {
		t.Fatalf("%+v", res)
	}
	if _, err := h.req.GenerateCode(req, "", "cobol", CodeOptions{}); err == nil {
		t.Fatal("unknown language accepted")
	}
}

func TestGenerateCode(t *testing.T) {
	h := newHarness(t)
	h.openWorkspace(t)
	col, err := h.ws.CreateCollection("API")
	if err != nil {
		t.Fatal(err)
	}
	if _, err := h.ws.SaveCollection(col.ID, fsstore.CollectionSettings{
		Auth:      model.Auth{Type: model.AuthBearer, Token: "{{token}}"},
		Variables: []model.Variable{{Key: "token", Enabled: true, Secret: true}, {Key: "host", Value: "api.example", Enabled: true}},
	}, nil); err != nil {
		t.Fatal(err)
	}
	if err := h.env.SetSecret(pipeline.ScopeRef{Kind: vars.ScopeCollection, ID: col.ID}, "token", "tok-XYZ"); err != nil {
		t.Fatal(err)
	}
	req := model.Request{Method: "GET", URL: "https://{{host}}/me", Auth: model.Auth{Type: model.AuthInherit}}

	res, err := h.req.GenerateCode(req, col.ID, "python-requests", CodeOptions{ResolveVariables: true})
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(res.Code, `"Authorization": "Bearer {{token}}"`) || !strings.Contains(res.Code, "https://api.example/me") ||
		strings.Contains(res.Code, "tok-XYZ") || len(res.Masked) != 1 {
		t.Fatalf("%+v", res)
	}

	res, err = h.req.GenerateCode(req, col.ID, "python-requests", CodeOptions{ResolveVariables: true, RevealSecrets: true})
	if err != nil || !strings.Contains(res.Code, "Bearer tok-XYZ") || len(res.Masked) != 0 {
		t.Fatalf("%+v %v", res, err)
	}

	res, err = h.req.GenerateCode(req, col.ID, "curl", CodeOptions{RevealSecrets: true})
	if err != nil || !strings.Contains(res.Code, "https://{{host}}/me") || !strings.Contains(res.Code, "Bearer {{token}}") {
		t.Fatalf("%+v %v", res, err)
	}

	if _, err := h.env.SaveGlobals([]model.Variable{{Key: "a", Value: "{{b}}", Enabled: true}, {Key: "b", Value: "{{a}}", Enabled: true}}, nil); err != nil {
		t.Fatal(err)
	}
	if _, err := h.req.GenerateCode(model.Request{URL: "{{a}}"}, "", "curl", CodeOptions{ResolveVariables: true}); err == nil ||
		!strings.Contains(err.Error(), "loop") {
		t.Fatalf("err = %v", err)
	}
}
