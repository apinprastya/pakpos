package secrets

import (
	"errors"
	"fmt"
	"sync"
	"time"

	gokeyring "github.com/zalando/go-keyring"
)

// Service is the keychain service name entries are stored under; the
// account name is the full Key.
const Service = "pakpos"

// probeKey is written, read back and deleted to check the keychain works.
const probeKey = KeyPrefix + "/probe"

// DefaultProbeTimeout bounds the availability probe: a keychain that waits
// for an unlock prompt or a hung D-Bus service counts as unavailable.
const DefaultProbeTimeout = 3 * time.Second

// KeyringBackend is the subset of go-keyring used by Keyring, so tests can
// swap in a fake instead of touching the real OS keychain.
type KeyringBackend interface {
	Get(service, user string) (string, error)
	Set(service, user, password string) error
	Delete(service, user string) error
}

// osKeyring calls the real OS keychain through go-keyring.
type osKeyring struct{}

func (osKeyring) Get(service, user string) (string, error) { return gokeyring.Get(service, user) }
func (osKeyring) Set(service, user, pw string) error       { return gokeyring.Set(service, user, pw) }
func (osKeyring) Delete(service, user string) error        { return gokeyring.Delete(service, user) }

// ErrBackendNotFound is what a KeyringBackend returns for a missing entry
// (go-keyring's ErrNotFound).
var ErrBackendNotFound = gokeyring.ErrNotFound

// Keyring stores secrets in the OS keychain (macOS Keychain, Windows
// Credential Manager, Secret Service on Linux).
type Keyring struct {
	backend      KeyringBackend
	probeTimeout time.Duration

	once      sync.Once
	available bool
	probeErr  error
}

// NewKeyring returns a store backed by the OS keychain.
func NewKeyring() *Keyring { return NewKeyringWith(osKeyring{}, DefaultProbeTimeout) }

// NewKeyringWith returns a store using backend; for tests.
func NewKeyringWith(backend KeyringBackend, probeTimeout time.Duration) *Keyring {
	return &Keyring{backend: backend, probeTimeout: probeTimeout}
}

// Get returns the value for key.
func (k *Keyring) Get(key string) (string, error) {
	v, err := k.backend.Get(Service, key)
	if errors.Is(err, ErrBackendNotFound) {
		return "", fmt.Errorf("keychain %s: %w", key, ErrNotFound)
	}
	if err != nil {
		return "", fmt.Errorf("keychain read %s: %w", key, err)
	}
	return v, nil
}

// Set stores value under key.
func (k *Keyring) Set(key, value string) error {
	if err := k.backend.Set(Service, key, value); err != nil {
		return fmt.Errorf("keychain write %s: %w", key, err)
	}
	return nil
}

// Delete removes key; a missing key is not an error.
func (k *Keyring) Delete(key string) error {
	if err := k.backend.Delete(Service, key); err != nil && !errors.Is(err, ErrBackendNotFound) {
		return fmt.Errorf("keychain delete %s: %w", key, err)
	}
	return nil
}

// Available probes the keychain once (set, get and delete a sentinel) and
// caches the answer.
func (k *Keyring) Available() bool {
	k.once.Do(func() {
		k.probeErr = k.probe()
		k.available = k.probeErr == nil
	})
	return k.available
}

// ProbeError is why the keychain is unavailable (nil when it works or has
// not been probed). Useful for logs and the settings UI.
func (k *Keyring) ProbeError() error {
	k.Available()
	return k.probeErr
}

func (k *Keyring) probe() error {
	done := make(chan error, 1)
	go func() {
		const want = "ok"
		if err := k.backend.Set(Service, probeKey, want); err != nil {
			done <- fmt.Errorf("keychain probe write: %w", err)
			return
		}
		got, err := k.backend.Get(Service, probeKey)
		_ = k.backend.Delete(Service, probeKey)
		switch {
		case err != nil:
			done <- fmt.Errorf("keychain probe read: %w", err)
		case got != want:
			done <- errors.New("keychain probe read back a different value")
		default:
			done <- nil
		}
	}()
	select {
	case err := <-done:
		return err
	case <-time.After(k.probeTimeout):
		return fmt.Errorf("%w: keychain did not answer within %s", ErrUnavailable, k.probeTimeout)
	}
}
