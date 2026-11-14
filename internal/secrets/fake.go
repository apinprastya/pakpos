package secrets

import (
	"fmt"
	"sort"
	"sync"
)

// Fake is an in-memory Store for tests (here and in other packages). Set
// Unavailable to simulate a missing keychain, Err to make every call fail and
// SetErr to make only writes fail.
type Fake struct {
	mu          sync.Mutex
	values      map[string]string
	Unavailable bool
	Err         error
	SetErr      error
}

// NewFake returns an empty, available fake store.
func NewFake() *Fake { return &Fake{values: map[string]string{}} }

// Get returns the value for key.
func (f *Fake) Get(key string) (string, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	if f.Err != nil {
		return "", f.Err
	}
	v, ok := f.values[key]
	if !ok {
		return "", fmt.Errorf("fake %s: %w", key, ErrNotFound)
	}
	return v, nil
}

// Set stores value under key.
func (f *Fake) Set(key, value string) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	if f.Err != nil {
		return f.Err
	}
	if f.SetErr != nil {
		return f.SetErr
	}
	if f.values == nil {
		f.values = map[string]string{}
	}
	f.values[key] = value
	return nil
}

// Delete removes key.
func (f *Fake) Delete(key string) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	if f.Err != nil {
		return f.Err
	}
	delete(f.values, key)
	return nil
}

// Available reports !Unavailable.
func (f *Fake) Available() bool {
	f.mu.Lock()
	defer f.mu.Unlock()
	return !f.Unavailable
}

// Keys returns the stored keys, sorted (for assertions).
func (f *Fake) Keys() []string {
	f.mu.Lock()
	defer f.mu.Unlock()
	keys := make([]string, 0, len(f.values))
	for k := range f.values {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	return keys
}
