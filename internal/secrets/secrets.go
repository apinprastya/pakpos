// Package secrets stores secret variable values outside the workspace: in
// the OS keychain when one is available, otherwise in an encrypted file
// unlocked with a master password. Workspace files only hold the variable's
// key (secret: true); the value lives here under Key(workspace, scope, key).
//
// The package has no Wails dependency.
package secrets

import (
	"errors"
	"strings"
)

// Errors shared by the stores. Check with errors.Is.
var (
	// ErrNotFound means no value is stored under the key.
	ErrNotFound = errors.New("secret not found")
	// ErrLocked means the file store has not been unlocked yet.
	ErrLocked = errors.New("secret store is locked")
	// ErrWrongPassword means the master password did not decrypt the file.
	ErrWrongPassword = errors.New("wrong master password")
	// ErrNoPassword means the file store has no master password yet.
	ErrNoPassword = errors.New("no master password has been set")
	// ErrEmptyPassword rejects an empty master password.
	ErrEmptyPassword = errors.New("master password cannot be empty")
	// ErrCorrupt means the secrets file cannot be read; Reset starts over.
	ErrCorrupt = errors.New("secrets file is damaged")
	// ErrUnavailable means the store cannot be used on this machine.
	ErrUnavailable = errors.New("secret store is not available")
)

// Store keeps secret values by key.
type Store interface {
	// Get returns the value for key, or an error wrapping ErrNotFound.
	Get(key string) (string, error)
	// Set stores value under key, replacing any previous value.
	Set(key, value string) error
	// Delete removes key. Deleting a missing key is not an error.
	Delete(key string) error
	// Available reports whether the store can be used on this machine.
	Available() bool
}

// KeyPrefix starts every key written by Pakpos.
const KeyPrefix = "pakpos"

// Key builds the storage key for a variable: pakpos/<workspaceId>/<scopeId>/<key>.
// Scope IDs (not names) are used so renaming an environment keeps its secrets.
func Key(workspaceID, scopeID, key string) string {
	return strings.Join([]string{KeyPrefix, workspaceID, scopeID, key}, "/")
}

// Select returns primary when it is available (for the keychain, Available
// runs a probe), otherwise fallback.
func Select(primary, fallback Store) Store {
	if primary != nil && primary.Available() {
		return primary
	}
	return fallback
}
