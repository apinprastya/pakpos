package pipeline

import (
	"bytes"
	"errors"
	"reflect"
	"testing"

	"pakpos/internal/core/model"
	"pakpos/internal/core/vars"
)

func TestPrepareCode(t *testing.T) {
	f := newFixture(t)
	req := model.Request{URL: "https://{{host}}/x?k={{apiKey}}&t={{$timestamp}}", Auth: model.Auth{Type: model.AuthInherit}}

	tests := []struct {
		name       string
		opts       CodeOptions
		wantURL    string
		wantToken  string
		wantUnres  []string
		wantMasked []string
	}{
		{"as written, inheritance applied", CodeOptions{}, req.URL, "{{token}}", []string{}, []string{}},
		{"reveal ignored when not resolving", CodeOptions{RevealSecrets: true}, req.URL, "{{token}}", []string{}, []string{}},
		{"resolved, secrets masked", CodeOptions{ResolveVariables: true},
			"https://dev.example/x?k={{apiKey}}&t=1700000000", "{{token}}", []string{"apiKey"}, []string{"token"}},
		{"resolved, secrets revealed", CodeOptions{ResolveVariables: true, RevealSecrets: true},
			"https://dev.example/x?k={{apiKey}}&t=1700000000", "s3cret", []string{"apiKey"}, []string{}},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			p, err := f.sess.PrepareCode(req, f.folder.ID, f.dev.ID, tt.opts)
			if err != nil {
				t.Fatal(err)
			}
			if p.Request.URL != tt.wantURL || p.Request.Auth.Type != model.AuthBearer || p.Request.Auth.Token != tt.wantToken {
				t.Fatalf("request = %+v", p.Request)
			}
			if !reflect.DeepEqual(p.Unresolved, tt.wantUnres) || !reflect.DeepEqual(p.Masked, tt.wantMasked) {
				t.Fatalf("unresolved = %v, masked = %v", p.Unresolved, p.Masked)
			}
			if p.Environment == nil || p.Environment.Name != "Dev" {
				t.Fatalf("environment = %+v", p.Environment)
			}
			// Inherited headers are applied in every mode.
			if len(p.Request.Headers) != 3 {
				t.Fatalf("headers = %+v", p.Request.Headers)
			}
		})
	}

	_ = must(f.ws.SaveEnvironmentVariables(f.prod.ID, []model.Variable{v("a", "{{b}}"), v("b", "{{a}}")}))
	if _, err := f.sess.PrepareCode(model.Request{URL: "{{a}}"}, "", f.prod.ID, CodeOptions{ResolveVariables: true}); !errors.Is(err, vars.ErrCycle) {
		t.Fatalf("err = %v", err)
	}
}

func TestPrepareCodeWithoutWorkspace(t *testing.T) {
	req := model.Request{URL: "http://x/{{$randomInt}}/{{nope}}"}
	p, err := PrepareCodeWithoutWorkspace(req, CodeOptions{ResolveVariables: true}, vars.WithRand(bytes.NewReader(make([]byte, 64))))
	if err != nil || p.Request.URL != "http://x/0/{{nope}}" || !reflect.DeepEqual(p.Unresolved, []string{"nope"}) || p.Masked == nil {
		t.Fatalf("p = %+v, err = %v", p, err)
	}
	p, err = PrepareCodeWithoutWorkspace(req, CodeOptions{})
	if err != nil || p.Request.URL != req.URL || len(p.Unresolved) != 0 {
		t.Fatalf("p = %+v, err = %v", p, err)
	}
}
