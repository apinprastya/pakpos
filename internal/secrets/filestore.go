package secrets

import (
	"crypto/aes"
	"crypto/cipher"
	"crypto/rand"
	"crypto/subtle"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"sync"

	"golang.org/x/crypto/argon2"
)

// FileName is the encrypted secrets file inside the app data directory.
const FileName = "secrets.enc"

// fileFormat identifies the file layout; bumped on incompatible changes.
const fileFormat = 1

// KDFParams are the Argon2id parameters, stored in the file header so they
// can be raised later without breaking existing files.
type KDFParams struct {
	Time    uint32 `json:"time"`
	Memory  uint32 `json:"memory"` // KiB
	Threads uint8  `json:"threads"`
}

// DefaultKDFParams follow RFC 9106's second recommended option
// (t=3, m=64 MiB, p=4).
var DefaultKDFParams = KDFParams{Time: 3, Memory: 64 * 1024, Threads: 4}

// Bounds checked when reading a header, so a damaged or hostile file cannot
// make the app allocate gigabytes or spin for minutes.
const (
	maxKDFTime    = 20
	maxKDFMemory  = 1024 * 1024 // 1 GiB
	maxKDFThreads = 64
	minSaltLen    = 16
	maxSaltLen    = 64
	saltLen       = 16
	keyLen        = 32 // AES-256
)

// fileHeader is authenticated (as GCM additional data) but not encrypted.
type fileHeader struct {
	Format int       `json:"format"`
	KDF    string    `json:"kdf"`
	Params KDFParams `json:"params"`
	Salt   []byte    `json:"salt"`
	Nonce  []byte    `json:"nonce"`
}

// fileEnvelope is the whole file: the header and the encrypted values.
type fileEnvelope struct {
	Header     fileHeader `json:"header"`
	Ciphertext []byte     `json:"ciphertext"`
}

// FileStore keeps secrets in one file encrypted with AES-256-GCM, with the
// key derived from a master password by Argon2id. It must be unlocked once
// per session before use. Values are only ever written encrypted.
type FileStore struct {
	path   string
	params KDFParams
	rand   io.Reader

	mu     sync.Mutex
	key    []byte // nil while locked
	salt   []byte
	kdf    KDFParams // params of the open file
	values map[string]string
}

// FileOption configures a FileStore.
type FileOption func(*FileStore)

// WithKDFParams sets the Argon2id parameters used when (re)encrypting.
// Tests use small values; production uses DefaultKDFParams.
func WithKDFParams(p KDFParams) FileOption { return func(f *FileStore) { f.params = p } }

// WithRandom sets the source of salts and nonces (crypto/rand by default).
func WithRandom(r io.Reader) FileOption { return func(f *FileStore) { f.rand = r } }

// NewFileStore returns a locked store for <dataDir>/secrets.enc.
func NewFileStore(dataDir string, opts ...FileOption) *FileStore {
	f := &FileStore{path: filepath.Join(dataDir, FileName), params: DefaultKDFParams, rand: rand.Reader}
	for _, o := range opts {
		o(f)
	}
	return f
}

// Path is the location of the secrets file.
func (f *FileStore) Path() string { return f.path }

// Available is always true: the file store works on every machine.
func (f *FileStore) Available() bool { return true }

// HasPassword reports whether a master password has been set (the file exists).
func (f *FileStore) HasPassword() bool {
	_, err := os.Stat(f.path)
	return err == nil
}

// Locked reports whether the store must be unlocked before use.
func (f *FileStore) Locked() bool {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.key == nil
}

// Unlock decrypts the file with password. A wrong password returns
// ErrWrongPassword; an unreadable file returns ErrCorrupt.
func (f *FileStore) Unlock(password string) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	data, err := os.ReadFile(f.path)
	if errors.Is(err, os.ErrNotExist) {
		return ErrNoPassword
	}
	if err != nil {
		return fmt.Errorf("read %s: %w", FileName, err)
	}
	env, err := parseEnvelope(data)
	if err != nil {
		return err
	}
	key := deriveKey(password, env.Header.Salt, env.Header.Params)
	values, err := decrypt(key, env)
	if err != nil {
		wipe(key)
		return err
	}
	f.wipeLocked()
	f.key, f.salt, f.kdf, f.values = key, env.Header.Salt, env.Header.Params, values
	return nil
}

// SetPassword sets the master password. On first use it creates an empty
// file; otherwise the store must be unlocked, and every value is
// re-encrypted under the new password (with a fresh salt). The store stays
// unlocked.
func (f *FileStore) SetPassword(password string) error {
	if password == "" {
		return ErrEmptyPassword
	}
	f.mu.Lock()
	defer f.mu.Unlock()
	values := f.values
	if f.key == nil {
		if f.HasPassword() {
			return fmt.Errorf("change master password: %w", ErrLocked)
		}
		values = map[string]string{}
	}
	salt := make([]byte, saltLen)
	if _, err := io.ReadFull(f.rand, salt); err != nil {
		return fmt.Errorf("generate salt: %w", err)
	}
	key := deriveKey(password, salt, f.params)
	if err := f.write(key, salt, f.params, values); err != nil {
		wipe(key)
		return err
	}
	f.wipeLocked()
	f.key, f.salt, f.kdf, f.values = key, salt, f.params, values
	return nil
}

// Lock forgets the key and the decrypted values.
func (f *FileStore) Lock() {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.wipeLocked()
}

// Reset deletes the file and every value in it, and locks the store. A new
// master password can then be set. Used when the password is forgotten or
// the file is damaged.
func (f *FileStore) Reset() error {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.wipeLocked()
	if err := os.Remove(f.path); err != nil && !errors.Is(err, os.ErrNotExist) {
		return fmt.Errorf("delete %s: %w", FileName, err)
	}
	return nil
}

// Get returns the value for key.
func (f *FileStore) Get(key string) (string, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	if f.key == nil {
		return "", f.lockedErr()
	}
	v, ok := f.values[key]
	if !ok {
		return "", fmt.Errorf("secrets file %s: %w", key, ErrNotFound)
	}
	return v, nil
}

// Set stores value under key and rewrites the file.
func (f *FileStore) Set(key, value string) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	if f.key == nil {
		return f.lockedErr()
	}
	next := make(map[string]string, len(f.values)+1)
	for k, v := range f.values {
		next[k] = v
	}
	next[key] = value
	if err := f.write(f.key, f.salt, f.kdf, next); err != nil {
		return err
	}
	f.values = next
	return nil
}

// Delete removes key and rewrites the file; a missing key is not an error.
func (f *FileStore) Delete(key string) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	if f.key == nil {
		return f.lockedErr()
	}
	if _, ok := f.values[key]; !ok {
		return nil
	}
	next := make(map[string]string, len(f.values))
	for k, v := range f.values {
		if k != key {
			next[k] = v
		}
	}
	if err := f.write(f.key, f.salt, f.kdf, next); err != nil {
		return err
	}
	f.values = next
	return nil
}

func (f *FileStore) lockedErr() error {
	if !f.HasPassword() {
		return ErrNoPassword
	}
	return ErrLocked
}

func (f *FileStore) wipeLocked() {
	wipe(f.key)
	f.key, f.salt, f.values = nil, nil, nil
}

// write encrypts values and replaces the file atomically (mode 0600).
func (f *FileStore) write(key, salt []byte, params KDFParams, values map[string]string) error {
	plain, err := json.Marshal(values)
	if err != nil {
		return fmt.Errorf("encode secrets: %w", err)
	}
	defer wipe(plain)
	nonce := make([]byte, 12)
	if _, err := io.ReadFull(f.rand, nonce); err != nil {
		return fmt.Errorf("generate nonce: %w", err)
	}
	h := fileHeader{Format: fileFormat, KDF: "argon2id", Params: params, Salt: salt, Nonce: nonce}
	aad, err := json.Marshal(h)
	if err != nil {
		return fmt.Errorf("encode header: %w", err)
	}
	gcm, err := newGCM(key)
	if err != nil {
		return err
	}
	out, err := json.Marshal(fileEnvelope{Header: h, Ciphertext: gcm.Seal(nil, nonce, plain, aad)})
	if err != nil {
		return fmt.Errorf("encode secrets file: %w", err)
	}
	return writePrivateAtomic(f.path, out)
}

func parseEnvelope(data []byte) (fileEnvelope, error) {
	var env fileEnvelope
	if err := json.Unmarshal(data, &env); err != nil {
		return env, fmt.Errorf("%w: %v", ErrCorrupt, err)
	}
	h, p := env.Header, env.Header.Params
	switch {
	case h.Format != fileFormat:
		return env, fmt.Errorf("%w: unsupported format %d", ErrCorrupt, h.Format)
	case h.KDF != "argon2id":
		return env, fmt.Errorf("%w: unsupported key derivation %q", ErrCorrupt, h.KDF)
	case p.Time < 1 || p.Time > maxKDFTime || p.Threads < 1 || p.Threads > maxKDFThreads ||
		p.Memory < 8*uint32(p.Threads) || p.Memory > maxKDFMemory:
		return env, fmt.Errorf("%w: invalid key derivation parameters", ErrCorrupt)
	case len(h.Salt) < minSaltLen || len(h.Salt) > maxSaltLen:
		return env, fmt.Errorf("%w: invalid salt", ErrCorrupt)
	case len(h.Nonce) != 12:
		return env, fmt.Errorf("%w: invalid nonce", ErrCorrupt)
	case len(env.Ciphertext) < 16:
		return env, fmt.Errorf("%w: truncated", ErrCorrupt)
	}
	return env, nil
}

// decrypt opens the ciphertext. GCM cannot tell a wrong key from a modified
// file, so an authentication failure is reported as a wrong password.
func decrypt(key []byte, env fileEnvelope) (map[string]string, error) {
	aad, err := json.Marshal(env.Header)
	if err != nil {
		return nil, fmt.Errorf("encode header: %w", err)
	}
	gcm, err := newGCM(key)
	if err != nil {
		return nil, err
	}
	plain, err := gcm.Open(nil, env.Header.Nonce, env.Ciphertext, aad)
	if err != nil {
		return nil, ErrWrongPassword
	}
	defer wipe(plain)
	values := map[string]string{}
	if err := json.Unmarshal(plain, &values); err != nil {
		return nil, fmt.Errorf("%w: %v", ErrCorrupt, err)
	}
	return values, nil
}

func deriveKey(password string, salt []byte, p KDFParams) []byte {
	return argon2.IDKey([]byte(password), salt, p.Time, p.Memory, p.Threads, keyLen)
}

func newGCM(key []byte) (cipher.AEAD, error) {
	block, err := aes.NewCipher(key)
	if err != nil {
		return nil, fmt.Errorf("init cipher: %w", err)
	}
	gcm, err := cipher.NewGCM(block)
	if err != nil {
		return nil, fmt.Errorf("init cipher: %w", err)
	}
	return gcm, nil
}

// wipe zeroes b (best effort; Go may have copied it elsewhere).
func wipe(b []byte) {
	if b != nil {
		subtle.XORBytes(b, b, b)
	}
}

// writePrivateAtomic writes data to a temp file next to path (os.CreateTemp
// creates it with mode 0600), syncs it and renames it over path.
func writePrivateAtomic(path string, data []byte) (err error) {
	dir := filepath.Dir(path)
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return fmt.Errorf("create %s: %w", dir, err)
	}
	tmp, err := os.CreateTemp(dir, ".tmp-"+FileName+"-*")
	if err != nil {
		return fmt.Errorf("write %s: %w", FileName, err)
	}
	name := tmp.Name()
	defer func() {
		if err != nil {
			_ = tmp.Close()
			_ = os.Remove(name)
		}
	}()
	if _, err = tmp.Write(data); err != nil {
		return fmt.Errorf("write %s: %w", FileName, err)
	}
	if err = tmp.Sync(); err != nil {
		return fmt.Errorf("sync %s: %w", FileName, err)
	}
	if err = tmp.Close(); err != nil {
		return fmt.Errorf("close %s: %w", FileName, err)
	}
	if err = os.Rename(name, path); err != nil {
		return fmt.Errorf("save %s: %w", FileName, err)
	}
	return nil
}
