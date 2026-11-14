package secrets

import (
	"errors"
	"os"
	"reflect"
	"sync"
	"testing"
	"time"
)

func TestKey(t *testing.T) {
	if got := Key("WS", "ENV", "token"); got != "pakpos/WS/ENV/token" {
		t.Fatalf("Key = %q", got)
	}
}

func TestSelect(t *testing.T) {
	fallback := NewFake()
	up, down := NewFake(), NewFake()
	down.Unavailable = true
	tests := []struct {
		name    string
		primary Store
		want    Store
	}{
		{"available keychain", up, up},
		{"unavailable keychain", down, fallback},
		{"no keychain", nil, fallback},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if got := Select(tt.primary, fallback); got != tt.want {
				t.Fatalf("Select = %p, want %p", got, tt.want)
			}
		})
	}
}

func TestFake(t *testing.T) {
	f := &Fake{} // zero value works
	if !f.Available() {
		t.Fatal("zero fake should be available")
	}
	if _, err := f.Get("a"); !errors.Is(err, ErrNotFound) {
		t.Fatalf("Get missing = %v", err)
	}
	if err := f.Set("b", "2"); err != nil {
		t.Fatal(err)
	}
	_ = f.Set("a", "1")
	if v, err := f.Get("a"); err != nil || v != "1" {
		t.Fatalf("Get = %q %v", v, err)
	}
	if !reflect.DeepEqual(f.Keys(), []string{"a", "b"}) {
		t.Fatalf("Keys = %v", f.Keys())
	}
	if err := f.Delete("a"); err != nil || f.Delete("missing") != nil {
		t.Fatal("delete failed")
	}
	f.Err = errors.New("boom")
	if _, err := f.Get("b"); err == nil {
		t.Fatal("Get should fail")
	}
	if f.Set("b", "x") == nil || f.Delete("b") == nil {
		t.Fatal("Set/Delete should fail")
	}
}

// fakeBackend is an in-memory KeyringBackend with failure switches.
type fakeBackend struct {
	mu        sync.Mutex
	values    map[string]string
	setErr    error
	getErr    error
	deleteErr error
	garble    bool
	block     chan struct{}
}

func newBackend() *fakeBackend { return &fakeBackend{values: map[string]string{}} }

func (b *fakeBackend) Get(service, user string) (string, error) {
	b.mu.Lock()
	defer b.mu.Unlock()
	if b.getErr != nil {
		return "", b.getErr
	}
	v, ok := b.values[service+"|"+user]
	if !ok {
		return "", ErrBackendNotFound
	}
	if b.garble {
		v += "!"
	}
	return v, nil
}

func (b *fakeBackend) Set(service, user, pw string) error {
	if b.block != nil {
		<-b.block
	}
	b.mu.Lock()
	defer b.mu.Unlock()
	if b.setErr != nil {
		return b.setErr
	}
	b.values[service+"|"+user] = pw
	return nil
}

func (b *fakeBackend) Delete(service, user string) error {
	b.mu.Lock()
	defer b.mu.Unlock()
	if b.deleteErr != nil {
		return b.deleteErr
	}
	if _, ok := b.values[service+"|"+user]; !ok {
		return ErrBackendNotFound
	}
	delete(b.values, service+"|"+user)
	return nil
}

func TestKeyringRoundTrip(t *testing.T) {
	b := newBackend()
	k := NewKeyringWith(b, time.Second)
	key := Key("W", "S", "token")
	if _, err := k.Get(key); !errors.Is(err, ErrNotFound) {
		t.Fatalf("Get missing = %v", err)
	}
	if err := k.Set(key, "s3cret"); err != nil {
		t.Fatal(err)
	}
	if b.values["pakpos|"+key] != "s3cret" {
		t.Fatalf("stored under the wrong name: %v", b.values)
	}
	if v, err := k.Get(key); err != nil || v != "s3cret" {
		t.Fatalf("Get = %q %v", v, err)
	}
	if err := k.Delete(key); err != nil {
		t.Fatal(err)
	}
	if err := k.Delete(key); err != nil {
		t.Fatalf("deleting a missing key: %v", err)
	}
}

func TestKeyringErrors(t *testing.T) {
	boom := errors.New("boom")
	b := newBackend()
	b.getErr, b.setErr, b.deleteErr = boom, boom, boom
	k := NewKeyringWith(b, time.Second)
	if _, err := k.Get("k"); !errors.Is(err, boom) || errors.Is(err, ErrNotFound) {
		t.Fatalf("Get = %v", err)
	}
	if err := k.Set("k", "v"); !errors.Is(err, boom) {
		t.Fatalf("Set = %v", err)
	}
	if err := k.Delete("k"); !errors.Is(err, boom) {
		t.Fatalf("Delete = %v", err)
	}
}

func TestKeyringProbe(t *testing.T) {
	boom := errors.New("no secret service")
	tests := []struct {
		name  string
		setup func(*fakeBackend)
		want  bool
	}{
		{"works", func(*fakeBackend) {}, true},
		{"write fails", func(b *fakeBackend) { b.setErr = boom }, false},
		{"read fails", func(b *fakeBackend) { b.getErr = boom }, false},
		{"reads back garbage", func(b *fakeBackend) { b.garble = true }, false},
		{"hangs", func(b *fakeBackend) { b.block = make(chan struct{}) }, false},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			b := newBackend()
			tt.setup(b)
			k := NewKeyringWith(b, 50*time.Millisecond)
			if got := k.Available(); got != tt.want {
				t.Fatalf("Available = %v (%v)", got, k.ProbeError())
			}
			if (k.ProbeError() == nil) != tt.want {
				t.Fatalf("ProbeError = %v", k.ProbeError())
			}
			if b.block != nil {
				close(b.block)
			}
			if tt.want && len(b.values) != 0 {
				t.Fatalf("probe left entries behind: %v", b.values)
			}
			// Cached: a later failure does not change the answer.
			b.mu.Lock()
			b.setErr = boom
			b.mu.Unlock()
			if k.Available() != tt.want {
				t.Fatal("probe result should be cached")
			}
		})
	}
}

// TestRealKeyring touches the OS keychain, so it only runs on request:
// PAKPOS_TEST_KEYRING=1 go test ./internal/secrets -run RealKeyring
func TestRealKeyring(t *testing.T) {
	if os.Getenv("PAKPOS_TEST_KEYRING") != "1" {
		t.Skip("set PAKPOS_TEST_KEYRING=1 to test against the real OS keychain")
	}
	k := NewKeyring()
	if !k.Available() {
		t.Skipf("keychain unavailable: %v", k.ProbeError())
	}
	key := Key("test", "test", "roundtrip")
	t.Cleanup(func() { _ = k.Delete(key) })
	if err := k.Set(key, "value"); err != nil {
		t.Fatal(err)
	}
	if v, err := k.Get(key); err != nil || v != "value" {
		t.Fatalf("Get = %q %v", v, err)
	}
}
