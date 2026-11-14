package vars

import (
	"reflect"
	"testing"

	"pakpos/internal/core/model"
)

func TestKeepSecrets(t *testing.T) {
	secret := model.Variable{Key: "token", Value: "s3cr3t", Enabled: true, Secret: true}
	scopes := []Scope{
		scope(ScopeGlobal, v("auth", "Bearer {{ token }}"), v("host", "api.example")),
		{Kind: ScopeEnvironment, ID: "env", Variables: []model.Variable{secret}, Unset: []string{"missing"}},
	}
	var kept []string
	r := New(scopes, KeepSecrets(func(n string) { kept = append(kept, n) }))
	got, unresolved, err := r.Resolve("{{host}} {{auth}} {{token}} {{missing}} {{$timestamp}}")
	if err != nil {
		t.Fatal(err)
	}
	if want := "api.example Bearer {{token}} {{token}} {{missing}} "; got[:len(want)] != want {
		t.Errorf("got %q, want prefix %q", got, want)
	}
	if !reflect.DeepEqual(unresolved, []string{"missing"}) {
		t.Errorf("unresolved = %v", unresolved)
	}
	if !reflect.DeepEqual(kept, []string{"token", "token"}) {
		t.Errorf("kept = %v", kept)
	}

	// A nil callback is allowed; without the option secrets resolve.
	if got, _, _ := New(scopes, KeepSecrets(nil)).Resolve("{{token}}"); got != "{{token}}" {
		t.Errorf("nil callback: %q", got)
	}
	if got, _, _ := New(scopes).Resolve("{{token}}"); got != "s3cr3t" {
		t.Errorf("default: %q", got)
	}
}
