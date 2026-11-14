package pipeline

import (
	"errors"
	"reflect"
	"strings"
	"testing"

	"pakpos/internal/core/model"
	"pakpos/internal/core/vars"
	"pakpos/internal/secrets"
	"pakpos/internal/store/fsstore"
)

func TestSecretValuesPerScope(t *testing.T) {
	f := newFixture(t)
	scopes := []struct {
		name string
		ref  ScopeRef
		id   string
	}{
		{"globals", ScopeRef{Kind: vars.ScopeGlobal, ID: "ignored"}, f.globalID},
		{"collection", ScopeRef{Kind: vars.ScopeCollection, ID: f.col.ID}, f.col.ID},
		{"environment", ScopeRef{Kind: vars.ScopeEnvironment, ID: f.dev.ID}, f.dev.ID},
	}
	for _, sc := range scopes {
		t.Run(sc.name, func(t *testing.T) {
			if err := f.sess.SetSecret(sc.ref, " pw ", "v-"+sc.name); err != nil {
				t.Fatal(err)
			}
			if got, _ := f.sec.Get(f.key(sc.id, "pw")); got != "v-"+sc.name {
				t.Fatalf("stored = %q", got)
			}
			if err := f.sess.ClearSecret(sc.ref, "pw"); err != nil {
				t.Fatal(err)
			}
			if _, err := f.sec.Get(f.key(sc.id, "pw")); !errors.Is(err, secrets.ErrNotFound) {
				t.Fatalf("not cleared: %v", err)
			}
			if err := f.sess.ClearSecret(sc.ref, "pw"); err != nil {
				t.Fatalf("clearing twice: %v", err)
			}
		})
	}

	bad := []struct {
		ref ScopeRef
		key string
	}{
		{ScopeRef{Kind: vars.ScopeLocal}, "k"},
		{ScopeRef{Kind: vars.ScopeEnvironment, ID: "nope"}, "k"},
		{ScopeRef{Kind: vars.ScopeCollection, ID: "nope"}, "k"},
		{ScopeRef{Kind: vars.ScopeGlobal}, "  "},
	}
	for _, b := range bad {
		if err := f.sess.SetSecret(b.ref, b.key, "x"); err == nil {
			t.Errorf("SetSecret(%+v, %q) should fail", b.ref, b.key)
		}
		if err := f.sess.ClearSecret(b.ref, b.key); err == nil {
			t.Errorf("ClearSecret(%+v, %q) should fail", b.ref, b.key)
		}
	}
	if _, err := f.sess.SecretStatus(ScopeRef{Kind: "nope"}); !errors.Is(err, ErrInvalidScope) {
		t.Fatalf("status of bad scope: %v", err)
	}
}

func TestSecretStatus(t *testing.T) {
	f := newFixture(t)
	col := ScopeRef{Kind: vars.ScopeCollection, ID: f.col.ID}
	if st, err := f.sess.SecretStatus(col); err != nil || !reflect.DeepEqual(st, SecretStatus{Set: []string{"token"}}) {
		t.Fatalf("collection = %+v %v", st, err)
	}
	dev := ScopeRef{Kind: vars.ScopeEnvironment, ID: f.dev.ID}
	if st, err := f.sess.SecretStatus(dev); err != nil || len(st.Set) != 0 || st.Locked {
		t.Fatalf("dev = %+v %v", st, err)
	}
	f.sec.Err = secrets.ErrLocked
	if st, err := f.sess.SecretStatus(col); err != nil || !st.Locked || len(st.Set) != 0 {
		t.Fatalf("locked = %+v %v", st, err)
	}
	f.sec.Err = errors.New("boom")
	if _, err := f.sess.SecretStatus(col); err == nil {
		t.Fatal("expected store error")
	}
}

func TestSaveVariablesCleansUpSecrets(t *testing.T) {
	f := newFixture(t)
	wsID := f.ws.Manifest().ID
	// Globals: a secret that is renamed loses its old value.
	g := ScopeRef{Kind: vars.ScopeGlobal}
	if _, err := f.sess.SaveVariables(g, []model.Variable{secret("old"), v("plain", "1")}); err != nil {
		t.Fatal(err)
	}
	_ = f.sess.SetSecret(g, "old", "x")
	saved, err := f.sess.SaveVariables(g, []model.Variable{{Key: "new", Value: "typed", Enabled: true, Secret: true}})
	if err != nil || len(saved) != 1 || saved[0].Value != "" {
		t.Fatalf("saved = %+v %v", saved, err)
	}
	if _, err := f.sec.Get(secrets.Key(wsID, f.globalID, "old")); !errors.Is(err, secrets.ErrNotFound) {
		t.Fatal("renamed global secret kept its value")
	}

	// Environment: a secret made non-secret loses its stored value; others stay.
	env := ScopeRef{Kind: vars.ScopeEnvironment, ID: f.dev.ID}
	_ = f.sess.SetSecret(env, "apiKey", "k")
	_ = f.sess.SetSecret(env, "keep", "kv")
	if _, err := f.sess.SaveVariables(env, []model.Variable{secret("keep")}); err != nil {
		t.Fatal(err)
	}
	if _, err := f.sec.Get(f.key(f.dev.ID, "apiKey")); !errors.Is(err, secrets.ErrNotFound) {
		t.Fatal("removed env secret kept its value")
	}
	if got, _ := f.sec.Get(f.key(f.dev.ID, "keep")); got != "kv" {
		t.Fatal("kept secret lost its value")
	}

	// Collection: removing the secret deletes it; auth and headers are kept.
	col := ScopeRef{Kind: vars.ScopeCollection, ID: f.col.ID}
	if _, err := f.sess.SaveVariables(col, []model.Variable{v("host", "h")}); err != nil {
		t.Fatal(err)
	}
	if _, err := f.sec.Get(f.key(f.col.ID, "token")); !errors.Is(err, secrets.ErrNotFound) {
		t.Fatal("removed collection secret kept its value")
	}
	if c, _ := f.ws.GetCollection(f.col.ID); c.Auth.Type != model.AuthBearer || len(c.Headers) != 2 {
		t.Fatalf("collection settings lost: %+v", c)
	}

	// Failures.
	if _, err := f.sess.SaveVariables(ScopeRef{Kind: vars.ScopeEnvironment, ID: "nope"}, nil); err == nil {
		t.Fatal("unknown environment")
	}
	if _, err := f.sess.SaveVariables(ScopeRef{Kind: vars.ScopeLocal}, nil); !errors.Is(err, ErrInvalidScope) {
		t.Fatal("local scope can't be saved")
	}

	// A locked store can't delete: the save still succeeds and the failure is logged.
	_ = f.sess.SetSecret(env, "keep", "kv")
	f.sec.Err = secrets.ErrLocked
	if _, err := f.sess.SaveVariables(env, nil); err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(f.logs.String(), "delete secret values") {
		t.Fatalf("cleanup failure not logged: %s", f.logs)
	}
}

func TestSaveAndDeleteCollection(t *testing.T) {
	f := newFixture(t)
	c, err := f.sess.SaveCollection(f.col.ID, fsstore.CollectionSettings{
		Auth:      model.Auth{Type: model.AuthNone},
		Variables: []model.Variable{secret("token2")},
	})
	if err != nil || c.Auth.Type != model.AuthNone || len(c.Variables) != 1 {
		t.Fatalf("saved = %+v %v", c, err)
	}
	if _, err := f.sec.Get(f.key(f.col.ID, "token")); !errors.Is(err, secrets.ErrNotFound) {
		t.Fatal("renamed collection secret kept its value")
	}
	_ = f.sec.Set(f.key(f.col.ID, "token2"), "t2")
	if _, err := f.sess.SaveCollection("nope", fsstore.CollectionSettings{}); err == nil {
		t.Fatal("unknown collection")
	}
	if err := f.sess.DeleteCollection(f.col.ID); err != nil {
		t.Fatal(err)
	}
	if keys := f.sec.Keys(); len(keys) != 0 {
		t.Fatalf("secrets left after deleting the collection: %v", keys)
	}
	if err := f.sess.DeleteCollection(f.col.ID); err == nil {
		t.Fatal("deleting twice should fail")
	}
}

func TestDuplicateAndDeleteEnvironment(t *testing.T) {
	f := newFixture(t)
	_ = f.sec.Set(f.key(f.dev.ID, "apiKey"), "dev-key")
	dup, err := f.sess.DuplicateEnvironment(f.dev.ID)
	if err != nil || dup.Name != "Dev copy" || dup.ID == f.dev.ID {
		t.Fatalf("dup = %+v %v", dup, err)
	}
	if got, _ := f.sec.Get(f.key(dup.ID, "apiKey")); got != "dev-key" {
		t.Fatalf("copied secret = %q", got)
	}
	if err := f.sess.DeleteEnvironment(dup.ID); err != nil {
		t.Fatal(err)
	}
	if _, err := f.sec.Get(f.key(dup.ID, "apiKey")); !errors.Is(err, secrets.ErrNotFound) {
		t.Fatal("deleted environment kept its secret")
	}
	if got, _ := f.sec.Get(f.key(f.dev.ID, "apiKey")); got != "dev-key" {
		t.Fatal("original lost its secret")
	}
	if _, err := f.sess.DuplicateEnvironment("nope"); err == nil {
		t.Fatal("unknown environment")
	}
	if err := f.sess.DeleteEnvironment("nope"); err == nil {
		t.Fatal("unknown environment")
	}

	// A failing store doesn't stop the duplicate; the failure is logged.
	f.sec.Err = errors.New("boom")
	if _, err := f.sess.DuplicateEnvironment(f.dev.ID); err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(f.logs.String(), "copy secret values") {
		t.Fatalf("copy failure not logged: %s", f.logs)
	}
}
