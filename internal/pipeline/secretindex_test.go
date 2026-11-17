package pipeline

import (
	"bytes"
	"errors"
	"log/slog"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
	"time"

	"pakpos/internal/core/model"
	"pakpos/internal/secrets"
	"pakpos/internal/store/fsstore"
	"pakpos/internal/store/sqlite"
)

// withIndex gives the fixture's session a real secret index.
func withIndex(t *testing.T, f *fixture) *sqlite.Store {
	t.Helper()
	db, err := sqlite.Open(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = db.Close() })
	f.sess = f.sess.WithSecretIndex(db)
	return db
}

func indexed(t *testing.T, db *sqlite.Store, wsID string) []string {
	t.Helper()
	refs, err := db.SecretKeys(wsID)
	if err != nil {
		t.Fatal(err)
	}
	out := []string{}
	for _, r := range refs {
		out = append(out, r.ScopeID+"/"+r.Key)
	}
	return out
}

func TestSecretIndexFollowsBookkeeping(t *testing.T) {
	f := newFixture(t)
	db := withIndex(t, f)
	wsID := f.ws.Manifest().ID
	dev := ScopeRef{Kind: "environment", ID: f.dev.ID}

	if err := f.sess.SetSecret(dev, "apiKey", "k1"); err != nil {
		t.Fatal(err)
	}
	dup, err := f.sess.DuplicateEnvironment(f.dev.ID)
	if err != nil {
		t.Fatal(err)
	}
	want := []string{dup.ID + "/apiKey", f.dev.ID + "/apiKey"}
	if dup.ID > f.dev.ID {
		want = []string{f.dev.ID + "/apiKey", dup.ID + "/apiKey"}
	}
	if got := indexed(t, db, wsID); !reflect.DeepEqual(got, want) {
		t.Fatalf("after set and duplicate = %v, want %v", got, want)
	}

	// A rename moves the key; removing a secret forgets it.
	if _, err := f.sess.SaveVariables(dev, []model.Variable{v("host", "dev.example"), secret("key2")}, SecretRename{From: "apiKey", To: "key2"}); err != nil {
		t.Fatal(err)
	}
	if err := f.sess.DeleteEnvironment(dup.ID); err != nil {
		t.Fatal(err)
	}
	if got := indexed(t, db, wsID); !reflect.DeepEqual(got, []string{f.dev.ID + "/key2"}) {
		t.Fatalf("after rename and delete = %v", got)
	}
	if err := f.sess.ClearSecret(dev, "key2"); err != nil {
		t.Fatal(err)
	}
	if got := indexed(t, db, wsID); len(got) != 0 {
		t.Fatalf("after clear = %v", got)
	}
	if err := f.sess.SetSecret(dev, "key2", "v"); err != nil {
		t.Fatal(err)
	}
	if _, err := f.sess.MakePlain(dev, "key2"); err != nil {
		t.Fatal(err)
	}
	if got := indexed(t, db, wsID); len(got) != 0 {
		t.Fatalf("after make plain = %v", got)
	}
	// Index entries never hold values.
	for _, k := range f.sec.Keys() {
		if _, _, _, ok := secrets.SplitKey(k); !ok {
			t.Fatalf("unexpected key %q", k)
		}
	}
}

// failingIndex fails every call.
type failingIndex struct{ err error }

func (x failingIndex) RecordSecretKey(string, string, string) error { return x.err }
func (x failingIndex) AdoptSecretKey(string, string, string) error  { return x.err }
func (x failingIndex) ForgetSecretKey(string, string, string) error { return x.err }
func (x failingIndex) SecretKeys(string) ([]sqlite.SecretKeyRef, error) {
	return nil, x.err
}

func TestSecretIndexFailuresAreLogged(t *testing.T) {
	f := newFixture(t)
	f.sess = f.sess.WithSecretIndex(failingIndex{errors.New("disk full")})
	dev := ScopeRef{Kind: "environment", ID: f.dev.ID}
	if err := f.sess.SetSecret(dev, "apiKey", "k1"); err != nil {
		t.Fatal(err)
	}
	if err := f.sess.ClearSecret(dev, "apiKey"); err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(f.logs.String(), "record secret key") || !strings.Contains(f.logs.String(), "forget secret key") {
		t.Fatalf("logs = %s", f.logs)
	}
	// The value was stored and deleted all the same.
	if _, err := f.sec.Get(f.key(f.dev.ID, "apiKey")); !errors.Is(err, secrets.ErrNotFound) {
		t.Fatalf("value = %v", err)
	}
	if _, err := f.sess.PruneSecrets(time.Now()); err == nil || !strings.Contains(err.Error(), "disk full") {
		t.Fatalf("prune err = %v", err)
	}
	// A nil index changes nothing.
	if f.sess.WithSecretIndex(nil) != f.sess {
		t.Fatal("WithSecretIndex(nil) must return the session")
	}
}

func TestSecretIndexStoreErrors(t *testing.T) {
	f := newFixture(t)
	db := withIndex(t, f)
	dev := ScopeRef{Kind: "environment", ID: f.dev.ID}
	f.sec.Err = secrets.ErrLocked
	if err := f.sess.SetSecret(dev, "apiKey", "k"); !errors.Is(err, secrets.ErrLocked) {
		t.Fatalf("set = %v", err)
	}
	if err := f.sess.ClearSecret(dev, "apiKey"); !errors.Is(err, secrets.ErrLocked) {
		t.Fatalf("clear = %v", err)
	}
	if got := indexed(t, db, f.ws.Manifest().ID); len(got) != 0 {
		t.Fatalf("a failed write must not be indexed: %v", got)
	}
}

// deleteErrStore fails Delete for one key.
type deleteErrStore struct {
	*secrets.Fake
	key string
	err error
}

func (s *deleteErrStore) Delete(key string) error {
	if key == s.key {
		return s.err
	}
	return s.Fake.Delete(key)
}

func TestPruneSecrets(t *testing.T) {
	f := newFixture(t)
	wsID := f.ws.Manifest().ID
	if n, err := f.sess.PruneSecrets(time.Now()); n != 0 || err != nil {
		t.Fatalf("without an index = %d %v", n, err)
	}
	db := withIndex(t, f)
	dev := ScopeRef{Kind: "environment", ID: f.dev.ID}

	// apiKey is a live secret of Dev; "draft" was set on a row never saved.
	for _, k := range []string{"apiKey", "draft"} {
		if err := f.sess.SetSecret(dev, k, "v-"+k); err != nil {
			t.Fatal(err)
		}
	}
	// Prod is deleted while the store is locked: its value stays behind.
	prod := ScopeRef{Kind: "environment", ID: f.prod.ID}
	if _, err := f.sess.SaveVariables(prod, []model.Variable{secret("pw")}); err != nil {
		t.Fatal(err)
	}
	if err := f.sess.SetSecret(prod, "pw", "p"); err != nil {
		t.Fatal(err)
	}
	f.sec.Err = secrets.ErrLocked
	if err := f.sess.DeleteEnvironment(f.prod.ID); err != nil {
		t.Fatal(err)
	}
	f.sec.Err = nil

	// Written in this session: nothing is pruned yet.
	if n, err := f.sess.PruneSecrets(time.Now().Add(-time.Hour)); n != 0 || err != nil {
		t.Fatalf("same session = %d %v", n, err)
	}
	// The collection's token (stored before the index) was adopted.
	if got := indexed(t, db, wsID); len(got) != 4 {
		t.Fatalf("indexed = %v", got)
	}

	// Next session: the unsaved row's value and the deleted environment's go.
	next := time.Now().Add(2 * time.Second)
	if n, err := f.sess.PruneSecrets(next); n != 2 || err != nil {
		t.Fatalf("prune = %d %v", n, err)
	}
	wantKeys := []string{f.key(f.col.ID, "token"), f.key(f.dev.ID, "apiKey")}
	if got := f.sec.Keys(); !sameSet(got, wantKeys) {
		t.Fatalf("stored = %v, want %v", got, wantKeys)
	}
	if got := indexed(t, db, wsID); !sameSet(got, []string{f.col.ID + "/token", f.dev.ID + "/apiKey"}) {
		t.Fatalf("indexed = %v", got)
	}

	// A secret removed by hand-editing the collection file goes on the next prune.
	if _, err := f.ws.SaveCollection(f.col.ID, fsstore.CollectionSettings{Variables: []model.Variable{v("host", "x")}}); err != nil {
		t.Fatal(err)
	}
	if n, err := f.sess.PruneSecrets(next); n != 1 || err != nil {
		t.Fatalf("prune = %d %v", n, err)
	}
	if got := f.sec.Keys(); !reflect.DeepEqual(got, []string{f.key(f.dev.ID, "apiKey")}) {
		t.Fatalf("stored = %v", got)
	}
}

func sameSet(a, b []string) bool {
	if len(a) != len(b) {
		return false
	}
	seen := map[string]int{}
	for _, x := range a {
		seen[x]++
	}
	for _, x := range b {
		seen[x]--
	}
	for _, n := range seen {
		if n != 0 {
			return false
		}
	}
	return true
}

func TestPruneSecretsStops(t *testing.T) {
	setup := func(t *testing.T) (*fixture, *sqlite.Store) {
		f := newFixture(t)
		db := withIndex(t, f)
		for _, k := range []string{"a", "b"} {
			if err := f.sess.SetSecret(ScopeRef{Kind: "environment", ID: f.dev.ID}, k, "v"); err != nil {
				t.Fatal(err)
			}
		}
		return f, db
	}
	later := time.Now().Add(2 * time.Second)

	t.Run("locked store", func(t *testing.T) {
		f, db := setup(t)
		f.sec.Err = secrets.ErrLocked
		if n, err := f.sess.PruneSecrets(later); n != 0 || !errors.Is(err, secrets.ErrLocked) {
			t.Fatalf("prune = %d %v", n, err)
		}
		if got := indexed(t, db, f.ws.Manifest().ID); len(got) < 2 {
			t.Fatalf("index must be kept: %v", got)
		}
	})

	t.Run("one delete fails", func(t *testing.T) {
		f := newFixture(t)
		store := &deleteErrStore{Fake: f.sec, key: f.key(f.dev.ID, "a"), err: errors.New("dbus gone")}
		f.sess = New(f.ws, store, slog.New(slog.NewTextHandler(&bytes.Buffer{}, nil)))
		db := withIndex(t, f)
		for _, k := range []string{"a", "b"} {
			if err := f.sess.SetSecret(ScopeRef{Kind: "environment", ID: f.dev.ID}, k, "v"); err != nil {
				t.Fatal(err)
			}
		}
		n, err := f.sess.PruneSecrets(later)
		if n != 1 || err == nil || !strings.Contains(err.Error(), "dbus gone") {
			t.Fatalf("prune = %d %v", n, err)
		}
		if got := indexed(t, db, f.ws.Manifest().ID); !sameSet(got, []string{f.col.ID + "/token", f.dev.ID + "/a", f.dev.ID + "/apiKey"}) {
			t.Fatalf("indexed = %v", got)
		}
		if _, err := f.sec.Get(f.key(f.dev.ID, "a")); err != nil {
			t.Fatal("the failed key's value must stay")
		}
	})

	t.Run("workspace with problems", func(t *testing.T) {
		f, _ := setup(t)
		bad := filepath.Join(f.ws.Root(), fsstore.EnvironmentsDir, "broken.yaml")
		if err := os.WriteFile(bad, []byte("id: [\n"), 0o644); err != nil {
			t.Fatal(err)
		}
		f.ws.Reload()
		if n, err := f.sess.PruneSecrets(later); n != 0 || err != nil {
			t.Fatalf("prune = %d %v", n, err)
		}
		if len(f.sec.Keys()) != 3 {
			t.Fatalf("nothing may be pruned: %v", f.sec.Keys())
		}
		if !strings.Contains(f.logs.String(), "skip pruning secrets") {
			t.Fatalf("logs = %s", f.logs)
		}
	})
}
