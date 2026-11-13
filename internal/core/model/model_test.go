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
