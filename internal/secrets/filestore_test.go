package secrets

import (
	"bytes"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
)

// fastKDF keeps tests quick; production uses DefaultKDFParams.
var fastKDF = KDFParams{Time: 1, Memory: 64, Threads: 1}

func newFS(t *testing.T) *FileStore {
	t.Helper()
	return NewFileStore(filepath.Join(t.TempDir(), "data"), WithKDFParams(fastKDF))
}

func TestFileStoreLifecycle(t *testing.T) {
	fs := newFS(t)
	if !fs.Available() || !fs.Locked() || fs.HasPassword() {
		t.Fatal("new store should be available, locked and without password")
	}
	if _, err := fs.Get("k"); !errors.Is(err, ErrNoPassword) {
		t.Fatalf("Get before password = %v", err)
	}
	if err := fs.Unlock("pw"); !errors.Is(err, ErrNoPassword) {
		t.Fatalf("Unlock before password = %v", err)
	}
	if err := fs.SetPassword(""); !errors.Is(err, ErrEmptyPassword) {
		t.Fatalf("empty password = %v", err)
	}

	if err := fs.SetPassword("first"); err != nil {
		t.Fatal(err)
	}
	if fs.Locked() || !fs.HasPassword() {
		t.Fatal("SetPassword should leave the store unlocked")
	}
	if runtime.GOOS != "windows" {
		info, err := os.Stat(fs.Path())
		if err != nil || info.Mode().Perm() != 0o600 {
			t.Fatalf("file mode = %v, %v", info.Mode(), err)
		}
	}
	if err := fs.Set("pakpos/W/S/token", "tok-123"); err != nil {
		t.Fatal(err)
	}
	_ = fs.Set("pakpos/W/S/other", "x")
	if err := fs.Delete("pakpos/W/S/other"); err != nil {
		t.Fatal(err)
	}
	if err := fs.Delete("never-set"); err != nil {
		t.Fatalf("delete missing = %v", err)
	}
	raw, _ := os.ReadFile(fs.Path())
	if bytes.Contains(raw, []byte("tok-123")) || bytes.Contains(raw, []byte("pakpos/W/S")) {
		t.Fatal("plain text in the secrets file")
	}

	// A new instance (next app session) starts locked and needs the password.
	again := NewFileStore(filepath.Dir(fs.Path()), WithKDFParams(fastKDF))
	if _, err := again.Get("pakpos/W/S/token"); !errors.Is(err, ErrLocked) {
		t.Fatalf("Get while locked = %v", err)
	}
	if again.Set("a", "b") != ErrLocked || again.Delete("a") != ErrLocked {
		t.Fatal("Set/Delete while locked should fail")
	}
	if err := again.Unlock("wrong"); !errors.Is(err, ErrWrongPassword) {
		t.Fatalf("wrong password = %v", err)
	}
	if !again.Locked() {
		t.Fatal("wrong password must not unlock")
	}
	if err := again.Unlock("first"); err != nil {
		t.Fatal(err)
	}
	if v, err := again.Get("pakpos/W/S/token"); err != nil || v != "tok-123" {
		t.Fatalf("Get = %q %v", v, err)
	}
	if _, err := again.Get("pakpos/W/S/other"); !errors.Is(err, ErrNotFound) {
		t.Fatalf("deleted key = %v", err)
	}

	// Changing the password keeps the values.
	if err := again.SetPassword("second"); err != nil {
		t.Fatal(err)
	}
	again.Lock()
	if !again.Locked() {
		t.Fatal("Lock")
	}
	if err := again.SetPassword("third"); !errors.Is(err, ErrLocked) {
		t.Fatalf("change password while locked = %v", err)
	}
	if err := again.Unlock("first"); !errors.Is(err, ErrWrongPassword) {
		t.Fatalf("old password = %v", err)
	}
	if err := again.Unlock("second"); err != nil {
		t.Fatal(err)
	}
	if v, _ := again.Get("pakpos/W/S/token"); v != "tok-123" {
		t.Fatalf("value lost on password change: %q", v)
	}

	// Reset deletes everything and allows a new password.
	if err := again.Reset(); err != nil {
		t.Fatal(err)
	}
	if !again.Locked() || again.HasPassword() {
		t.Fatal("Reset should lock and remove the file")
	}
	if err := again.Reset(); err != nil {
		t.Fatalf("Reset twice = %v", err)
	}
	if err := again.SetPassword("new"); err != nil {
		t.Fatal(err)
	}
	if _, err := again.Get("pakpos/W/S/token"); !errors.Is(err, ErrNotFound) {
		t.Fatalf("value survived reset: %v", err)
	}
}

func TestFileStoreUsesStoredParams(t *testing.T) {
	dir := t.TempDir()
	fs := NewFileStore(dir, WithKDFParams(KDFParams{Time: 2, Memory: 128, Threads: 2}))
	if err := fs.SetPassword("pw"); err != nil {
		t.Fatal(err)
	}
	_ = fs.Set("k", "v")
	// Opened by a build with different defaults: the header's params win.
	other := NewFileStore(dir, WithKDFParams(fastKDF))
	if err := other.Unlock("pw"); err != nil {
		t.Fatal(err)
	}
	if err := other.Set("k2", "v2"); err != nil {
		t.Fatal(err)
	}
	third := NewFileStore(dir)
	if err := third.Unlock("pw"); err != nil {
		t.Fatal(err)
	}
	if v, _ := third.Get("k2"); v != "v2" {
		t.Fatalf("Get = %q", v)
	}
}

func validFile(t *testing.T) (string, fileEnvelope) {
	t.Helper()
	fs := newFS(t)
	if err := fs.SetPassword("pw"); err != nil {
		t.Fatal(err)
	}
	_ = fs.Set("k", "v")
	data, _ := os.ReadFile(fs.Path())
	var env fileEnvelope
	if err := json.Unmarshal(data, &env); err != nil {
		t.Fatal(err)
	}
	return fs.Path(), env
}

func TestFileStoreCorrupt(t *testing.T) {
	tests := []struct {
		name   string
		edit   func(*fileEnvelope)
		raw    []byte
		target error
	}{
		{name: "not json", raw: []byte("\x00\x01garbage"), target: ErrCorrupt},
		{name: "empty file", raw: []byte{}, target: ErrCorrupt},
		{name: "unknown format", edit: func(e *fileEnvelope) { e.Header.Format = 99 }, target: ErrCorrupt},
		{name: "unknown kdf", edit: func(e *fileEnvelope) { e.Header.KDF = "md5" }, target: ErrCorrupt},
		{name: "huge memory", edit: func(e *fileEnvelope) { e.Header.Params.Memory = 1 << 31 }, target: ErrCorrupt},
		{name: "zero time", edit: func(e *fileEnvelope) { e.Header.Params.Time = 0 }, target: ErrCorrupt},
		{name: "zero threads", edit: func(e *fileEnvelope) { e.Header.Params.Threads = 0 }, target: ErrCorrupt},
		{name: "short salt", edit: func(e *fileEnvelope) { e.Header.Salt = []byte{1} }, target: ErrCorrupt},
		{name: "bad nonce", edit: func(e *fileEnvelope) { e.Header.Nonce = []byte{1, 2} }, target: ErrCorrupt},
		{name: "truncated", edit: func(e *fileEnvelope) { e.Ciphertext = e.Ciphertext[:4] }, target: ErrCorrupt},
		// GCM cannot tell tampering from a wrong key.
		{name: "flipped bit", edit: func(e *fileEnvelope) { e.Ciphertext[0] ^= 1 }, target: ErrWrongPassword},
		{name: "header tampered", edit: func(e *fileEnvelope) { e.Header.Salt[0] ^= 1 }, target: ErrWrongPassword},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			path, env := validFile(t)
			data := tt.raw
			if tt.edit != nil {
				tt.edit(&env)
				data, _ = json.Marshal(env)
			}
			if err := os.WriteFile(path, data, 0o600); err != nil {
				t.Fatal(err)
			}
			fs := NewFileStore(filepath.Dir(path), WithKDFParams(fastKDF))
			if err := fs.Unlock("pw"); !errors.Is(err, tt.target) {
				t.Fatalf("Unlock = %v, want %v", err, tt.target)
			}
			if !fs.Locked() {
				t.Fatal("must stay locked")
			}
			if err := fs.Reset(); err != nil || fs.SetPassword("pw2") != nil {
				t.Fatal("Reset should recover from a damaged file")
			}
		})
	}
}

func TestFileStoreDecryptedGarbage(t *testing.T) {
	// Valid encryption of something that isn't a JSON object.
	path, _ := validFile(t)
	fs := NewFileStore(filepath.Dir(path), WithKDFParams(fastKDF))
	if err := fs.Unlock("pw"); err != nil {
		t.Fatal(err)
	}
	key := append([]byte{}, fs.key...)
	salt := append([]byte{}, fs.salt...)
	gcm, _ := newGCM(key)
	nonce := bytes.Repeat([]byte{7}, 12)
	h := fileHeader{Format: fileFormat, KDF: "argon2id", Params: fastKDF, Salt: salt, Nonce: nonce}
	aad, _ := json.Marshal(h)
	out, _ := json.Marshal(fileEnvelope{Header: h, Ciphertext: gcm.Seal(nil, nonce, []byte("[1,2]"), aad)})
	_ = os.WriteFile(path, out, 0o600)
	fs.Lock()
	if err := fs.Unlock("pw"); !errors.Is(err, ErrCorrupt) {
		t.Fatalf("Unlock = %v", err)
	}
}

type failingReader struct{}

func (failingReader) Read([]byte) (int, error) { return 0, errors.New("no entropy") }

// limitedReader gives n bytes, then fails.
type limitedReader struct{ n int }

func (l *limitedReader) Read(p []byte) (int, error) {
	if l.n <= 0 {
		return 0, errors.New("no entropy")
	}
	k := min(len(p), l.n)
	l.n -= k
	return k, nil
}

func TestFileStoreWriteErrors(t *testing.T) {
	dir := t.TempDir()
	if err := NewFileStore(dir, WithKDFParams(fastKDF), WithRandom(failingReader{})).SetPassword("pw"); err == nil || !strings.Contains(err.Error(), "salt") {
		t.Fatalf("salt error = %v", err)
	}
	fs := NewFileStore(dir, WithKDFParams(fastKDF), WithRandom(&limitedReader{n: saltLen}))
	if err := fs.SetPassword("pw"); err == nil || !strings.Contains(err.Error(), "nonce") {
		t.Fatalf("nonce error = %v", err)
	}
	if !fs.Locked() || fs.HasPassword() {
		t.Fatal("failed SetPassword must leave nothing behind")
	}

	// The data dir path is a file: the write fails cleanly.
	blocker := filepath.Join(t.TempDir(), "file")
	_ = os.WriteFile(blocker, []byte("x"), 0o600)
	if err := NewFileStore(blocker, WithKDFParams(fastKDF)).SetPassword("pw"); err == nil {
		t.Fatal("expected error writing under a file")
	}

	// Set/Delete failures keep the in-memory values unchanged.
	good := NewFileStore(t.TempDir(), WithKDFParams(fastKDF))
	_ = good.SetPassword("pw")
	_ = good.Set("keep", "1")
	good.rand = failingReader{}
	if err := good.Set("new", "2"); err == nil {
		t.Fatal("Set should fail")
	}
	if err := good.Delete("keep"); err == nil {
		t.Fatal("Delete should fail")
	}
	if _, err := good.Get("new"); !errors.Is(err, ErrNotFound) {
		t.Fatal("failed Set must not be visible")
	}
	if v, _ := good.Get("keep"); v != "1" {
		t.Fatal("failed Delete must keep the value")
	}
}

func TestFileStoreUnreadable(t *testing.T) {
	dir := t.TempDir()
	// The secrets file path is a directory: reading it fails without panicking.
	if err := os.Mkdir(filepath.Join(dir, FileName), 0o700); err != nil {
		t.Fatal(err)
	}
	fs := NewFileStore(dir, WithKDFParams(fastKDF))
	if err := fs.Unlock("pw"); err == nil || errors.Is(err, ErrNoPassword) {
		t.Fatalf("Unlock = %v", err)
	}
	_ = os.WriteFile(filepath.Join(dir, FileName, "x"), []byte("x"), 0o600)
	if err := fs.Reset(); err == nil {
		t.Fatal("Reset of a non-empty directory should fail")
	}
}
