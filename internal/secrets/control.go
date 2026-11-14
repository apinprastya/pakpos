package secrets

import (
	"errors"
	"unicode/utf8"
)

// PasswordStore is a Store protected by a master password (FileStore).
type PasswordStore interface {
	Store
	HasPassword() bool
	Locked() bool
	Unlock(password string) error
	SetPassword(password string) error
	Lock()
	Reset() error
}

var _ PasswordStore = (*FileStore)(nil)

// Backend names reported by StatusOf.
const (
	BackendKeychain = "keychain"
	BackendFile     = "file"
)

// Status describes the secret store in use, for the UI.
type Status struct {
	// Backend is BackendKeychain or BackendFile.
	Backend string `json:"backend"`
	// HasPassword and Locked are only meaningful for the file backend.
	HasPassword bool `json:"hasPassword"`
	Locked      bool `json:"locked"`
}

// StatusOf reports which kind of store s is and, for a password store,
// whether a password is set and whether it is locked.
func StatusOf(s Store) Status {
	p, ok := s.(PasswordStore)
	if !ok {
		return Status{Backend: BackendKeychain}
	}
	return Status{Backend: BackendFile, HasPassword: p.HasPassword(), Locked: p.Locked()}
}

// ErrNotPasswordStore is returned by password operations on the keychain.
var ErrNotPasswordStore = errors.New("the keychain has no master password")

// AsPasswordStore returns s as a PasswordStore, or ErrNotPasswordStore.
func AsPasswordStore(s Store) (PasswordStore, error) {
	p, ok := s.(PasswordStore)
	if !ok {
		return nil, ErrNotPasswordStore
	}
	return p, nil
}

// MinPasswordLength is the shortest master password accepted for a new one
// (set or change). Unlocking accepts any length.
const MinPasswordLength = 8

// ErrPasswordTooShort is returned for a new master password shorter than
// MinPasswordLength.
var ErrPasswordTooShort = errors.New("master password is too short")

// CheckNewPassword validates a new master password (counted in characters).
func CheckNewPassword(password string) error {
	if password == "" {
		return ErrEmptyPassword
	}
	if utf8.RuneCountInString(password) < MinPasswordLength {
		return ErrPasswordTooShort
	}
	return nil
}

// ChangePassword checks the new password, then the current one, and
// re-encrypts every value under next. The store is left unlocked.
func ChangePassword(p PasswordStore, current, next string) error {
	if err := CheckNewPassword(next); err != nil {
		return err
	}
	if err := p.Unlock(current); err != nil {
		return err
	}
	return p.SetPassword(next)
}

// UserError carries a message written for end users; it unwraps to the
// underlying error so errors.Is keeps working.
type UserError struct {
	Message string
	Err     error
}

func (e *UserError) Error() string { return e.Message }
func (e *UserError) Unwrap() error { return e.Err }

// User-facing messages for the store errors (sentence case, with a next step).
const (
	MsgWrongPassword = "Wrong password, or the secrets file is damaged."
	MsgLocked        = "The secret store is locked. Unlock it with your master password."
	MsgNoPassword    = "No master password is set yet. Set one to store secrets on this machine."
	MsgEmptyPassword = "Enter a master password."
	MsgShortPassword = "Use a master password of at least 8 characters."
	MsgCorrupt       = "The secrets file is damaged. Reset the secret store to start over; stored secret values are lost."
	MsgUnavailable   = "The secret store can't be used on this machine."
	MsgNotFileStore  = "Secrets are kept in the system keychain, which has no master password."
)

// Explain turns a store error into a UserError with a message for the UI.
// Other errors (and nil) are returned unchanged.
func Explain(err error) error {
	if err == nil {
		return nil
	}
	var ue *UserError
	if errors.As(err, &ue) {
		return err
	}
	var msg string
	switch {
	case errors.Is(err, ErrWrongPassword):
		msg = MsgWrongPassword
	case errors.Is(err, ErrLocked):
		msg = MsgLocked
	case errors.Is(err, ErrNoPassword):
		msg = MsgNoPassword
	case errors.Is(err, ErrEmptyPassword):
		msg = MsgEmptyPassword
	case errors.Is(err, ErrPasswordTooShort):
		msg = MsgShortPassword
	case errors.Is(err, ErrCorrupt):
		msg = MsgCorrupt
	case errors.Is(err, ErrUnavailable):
		msg = MsgUnavailable
	case errors.Is(err, ErrNotPasswordStore):
		msg = MsgNotFileStore
	default:
		return err
	}
	return &UserError{Message: msg, Err: err}
}
