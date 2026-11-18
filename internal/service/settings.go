package service

import (
	"errors"
	"fmt"
	"slices"
	"strings"

	"pakpos/internal/core/httpexec"
	"pakpos/internal/core/settings"
	"pakpos/internal/secrets"
)

// SettingsService reads and changes app settings, and the passwords the
// network settings need (kept in the secret store, never in SQLite).
type SettingsService struct{ c *Core }

// NewSettingsService creates the service.
func NewSettingsService(c *Core) *SettingsService { return &SettingsService{c: c} }

// Get returns the current settings.
func (s *SettingsService) Get() settings.Settings {
	return s.c.currentSettings()
}

// Defaults returns the settings of a fresh install.
func (s *SettingsService) Defaults() settings.Settings {
	return settings.Defaults()
}

// Set validates, saves and applies new settings, and returns them.
// Network settings apply to the next send; lowering history retention prunes
// every workspace's history now (the limit is per workspace). A CA bundle
// or client certificate that changed is loaded first, so a bad path is
// reported here rather than at the next send. Removing a client certificate
// deletes its stored passphrase.
func (s *SettingsService) Set(next settings.Settings) (settings.Settings, error) {
	next = next.Normalize()
	if err := next.Validate(); err != nil {
		return settings.Settings{}, err
	}
	prev := s.c.currentSettings()
	if err := checkNetworkFiles(prev, next); err != nil {
		return settings.Settings{}, err
	}
	if err := s.c.db.SetSetting(settingsKey, next); err != nil {
		return settings.Settings{}, err
	}
	s.c.mu.Lock()
	s.c.settings = next
	s.c.resetExecutorLocked()
	s.c.mu.Unlock()
	if networkChanged(prev, next) {
		// Close pooled connections made with the old proxy or certificates.
		s.c.transports.Reset()
	}
	s.forgetRemovedCerts(prev, next)

	if next.HistoryRetention > 0 {
		if _, err := s.c.db.PruneHistory(next.HistoryRetention); err != nil {
			s.c.log.Warn("prune history", "err", err)
		}
	}
	return next, nil
}

// checkNetworkFiles loads the CA bundle and client certificates that are new
// or changed (unchanged ones are left alone, so a file that went missing
// doesn't block saving the theme).
func checkNetworkFiles(prev, next settings.Settings) error {
	n := httpexec.Network{}
	if next.CAFile != "" && next.CAFile != prev.CAFile {
		n.CAFile = next.CAFile
	}
	for _, c := range next.ClientCerts {
		if !slices.Contains(prev.ClientCerts, c) {
			n.ClientCerts = append(n.ClientCerts, httpexec.ClientCert(c))
		}
	}
	if err := n.Check(); err != nil {
		var e *httpexec.Error
		if errors.As(err, &e) {
			return &userError{msg: e.Message, err: err}
		}
		return err
	}
	return nil
}

func networkChanged(prev, next settings.Settings) bool {
	return prev.Proxy != next.Proxy || prev.CAFile != next.CAFile || !slices.Equal(prev.ClientCerts, next.ClientCerts)
}

func (s *SettingsService) forgetRemovedCerts(prev, next settings.Settings) {
	for _, old := range prev.ClientCerts {
		kept := slices.ContainsFunc(next.ClientCerts, func(c settings.ClientCert) bool { return c.ID == old.ID })
		if kept {
			continue
		}
		err := s.c.secrets.Delete(secrets.AppKey(httpexec.CertSecret(old.ID)))
		if err != nil && !errors.Is(err, secrets.ErrNotFound) {
			s.c.log.Warn("delete client certificate passphrase", "id", old.ID, "err", err)
		}
	}
}

// NetworkSecretStatus says which network passwords are stored on this
// machine. Values are never returned.
type NetworkSecretStatus struct {
	// Locked is true when the secret store must be unlocked to tell.
	Locked        bool `json:"locked"`
	ProxyPassword bool `json:"proxyPassword"`
	// CertPassphrases lists the client certificate ids with a stored
	// passphrase. Never nil.
	CertPassphrases []string `json:"certPassphrases"`
}

// NetworkSecretStatus reports which of the proxy password and the saved
// client certificates' passphrases are stored.
func (s *SettingsService) NetworkSecretStatus() (NetworkSecretStatus, error) {
	out := NetworkSecretStatus{CertPassphrases: []string{}}
	has := func(name string) (bool, error) {
		v, err := s.c.appSecret(name)
		return v != "", err
	}
	ok, err := has(httpexec.SecretProxy)
	if errors.Is(err, secrets.ErrLocked) {
		out.Locked = true
		return out, nil
	}
	if err != nil {
		return out, secrets.Explain(err)
	}
	out.ProxyPassword = ok
	for _, c := range s.c.currentSettings().ClientCerts {
		if c.PFXFile == "" {
			continue
		}
		ok, err := has(httpexec.CertSecret(c.ID))
		if err != nil {
			return out, secrets.Explain(err)
		}
		if ok {
			out.CertPassphrases = append(out.CertPassphrases, c.ID)
		}
	}
	return out, nil
}

// SetProxyPassword stores the custom proxy's password ("" deletes it).
func (s *SettingsService) SetProxyPassword(password string) error {
	return s.setAppSecret(httpexec.SecretProxy, password)
}

// SetCertPassphrase stores the passphrase of a saved client certificate's
// PKCS#12 file ("" deletes it).
func (s *SettingsService) SetCertPassphrase(id, passphrase string) error {
	known := slices.ContainsFunc(s.c.currentSettings().ClientCerts, func(c settings.ClientCert) bool { return c.ID == id })
	if !known || strings.TrimSpace(id) == "" {
		return &userError{msg: "Save the client certificate before setting its passphrase."}
	}
	return s.setAppSecret(httpexec.CertSecret(id), passphrase)
}

func (s *SettingsService) setAppSecret(name, value string) error {
	key := secrets.AppKey(name)
	var err error
	if value == "" {
		err = s.c.secrets.Delete(key)
		if errors.Is(err, secrets.ErrNotFound) {
			err = nil
		}
	} else {
		err = s.c.secrets.Set(key, value)
	}
	if err != nil {
		return secrets.Explain(fmt.Errorf("store %s: %w", name, err))
	}
	// Transports hold the old password: build new ones on the next send.
	s.c.transports.Reset()
	return nil
}
