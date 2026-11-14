package service

import (
	"fmt"

	"pakpos/internal/core/model"
	"pakpos/internal/core/vars"
	"pakpos/internal/pipeline"
	"pakpos/internal/secrets"
	"pakpos/internal/store/fsstore"
	"pakpos/internal/store/sqlite"
)

// EnvService manages environments, global variables, secret values and the
// secret store, and previews how a request resolves.
//
// External edits to environments/ fire workspace:changed like any other
// workspace file; there is no separate event.
type EnvService struct{ c *Core }

// NewEnvService creates the service.
func NewEnvService(c *Core) *EnvService { return &EnvService{c: c} }

// List returns the environments in order.
func (s *EnvService) List() ([]fsstore.Environment, error) {
	ws, err := s.c.workspace()
	if err != nil {
		return nil, err
	}
	return ws.ListEnvironments(), nil
}

// Get returns one environment. Secret variables have an empty value.
func (s *EnvService) Get(id string) (fsstore.Environment, error) {
	ws, err := s.c.workspace()
	if err != nil {
		return fsstore.Environment{}, err
	}
	return ws.GetEnvironment(id)
}

// Create adds an empty environment at the end.
func (s *EnvService) Create(name string) (fsstore.Environment, error) {
	ws, err := s.c.workspace()
	if err != nil {
		return fsstore.Environment{}, err
	}
	return ws.CreateEnvironment(name)
}

// Rename renames an environment (and its file).
func (s *EnvService) Rename(id, name string) (fsstore.Environment, error) {
	ws, err := s.c.workspace()
	if err != nil {
		return fsstore.Environment{}, err
	}
	return ws.RenameEnvironment(id, name)
}

// Duplicate copies an environment as "<name> copy", including the secret
// values stored on this machine.
func (s *EnvService) Duplicate(id string) (fsstore.Environment, error) {
	_, p, err := s.c.openSession()
	if err != nil {
		return fsstore.Environment{}, err
	}
	return p.DuplicateEnvironment(id)
}

// Delete removes an environment and its stored secret values.
func (s *EnvService) Delete(id string) error {
	_, p, err := s.c.openSession()
	if err != nil {
		return err
	}
	return p.DeleteEnvironment(id)
}

// Reorder sets the environment order.
func (s *EnvService) Reorder(ids []string) error {
	ws, err := s.c.workspace()
	if err != nil {
		return err
	}
	return ws.ReorderEnvironments(ids)
}

// Globals returns the global variables.
func (s *EnvService) Globals() (fsstore.Globals, error) {
	ws, err := s.c.workspace()
	if err != nil {
		return fsstore.Globals{}, err
	}
	return ws.GetGlobals(), nil
}

// SaveGlobals replaces the global variables.
func (s *EnvService) SaveGlobals(vs []model.Variable) (fsstore.Globals, error) {
	ws, p, err := s.c.openSession()
	if err != nil {
		return fsstore.Globals{}, err
	}
	if _, err := p.SaveVariables(pipeline.ScopeRef{Kind: vars.ScopeGlobal}, vs); err != nil {
		return fsstore.Globals{}, err
	}
	return ws.GetGlobals(), nil
}

// SaveVariables replaces the variables of the globals, a collection or an
// environment and returns them as saved (secret values empty). Stored values
// of secrets that were removed, renamed or made non-secret are deleted.
func (s *EnvService) SaveVariables(scope pipeline.ScopeRef, vs []model.Variable) ([]model.Variable, error) {
	_, p, err := s.c.openSession()
	if err != nil {
		return nil, err
	}
	return p.SaveVariables(scope, vs)
}

// SetSecret stores the value of a secret variable on this machine.
func (s *EnvService) SetSecret(scope pipeline.ScopeRef, key, value string) error {
	_, p, err := s.c.openSession()
	if err != nil {
		return err
	}
	return secrets.Explain(p.SetSecret(scope, key, value))
}

// ClearSecret deletes the stored value of a secret variable.
func (s *EnvService) ClearSecret(scope pipeline.ScopeRef, key string) error {
	_, p, err := s.c.openSession()
	if err != nil {
		return err
	}
	return secrets.Explain(p.ClearSecret(scope, key))
}

// SecretStatus reports which secret variables of a scope have a value on
// this machine. Values are never returned.
func (s *EnvService) SecretStatus(scope pipeline.ScopeRef) (pipeline.SecretStatus, error) {
	_, p, err := s.c.openSession()
	if err != nil {
		return pipeline.SecretStatus{}, err
	}
	st, err := p.SecretStatus(scope)
	return st, secrets.Explain(err)
}

// Select makes an environment the selected one for the open workspace
// ("" selects none).
func (s *EnvService) Select(id string) error {
	ws, err := s.c.workspace()
	if err != nil {
		return err
	}
	if id != "" {
		if _, err := ws.GetEnvironment(id); err != nil {
			return err
		}
	}
	return s.c.db.SetWorkspaceState(ws.Manifest().ID, sqlite.StateSelectedEnvironment, id)
}

// Selected returns the selected environment, or nil for none (also when the
// selected one was deleted).
func (s *EnvService) Selected() (*pipeline.EnvRef, error) {
	ws, p, err := s.c.openSession()
	if err != nil {
		return nil, err
	}
	e := p.Environment(s.c.selectedEnvironment(ws.Manifest().ID))
	if e == nil {
		return nil, nil
	}
	return &pipeline.EnvRef{ID: e.ID, Name: e.Name}, nil
}

// ResolvePreview shows how a request (saved or draft) resolves with the
// selected environment: inherited headers and auth with their source, the
// visible variables (secret values masked) and the unresolved names.
// parentID is the collection or folder a draft belongs to.
func (s *EnvService) ResolvePreview(req model.Request, parentID string) (pipeline.Preview, error) {
	ws, p, err := s.c.openSession()
	if err != nil {
		return pipeline.Preview{}, err
	}
	return p.Preview(req, parentID, s.c.selectedEnvironment(ws.Manifest().ID)), nil
}

// SecretsStatus reports the secret store in use: the keychain, or the
// encrypted file with whether a master password is set and it is locked.
func (s *EnvService) SecretsStatus() secrets.Status {
	return secrets.StatusOf(s.c.secrets)
}

func (s *EnvService) passwordStore() (secrets.PasswordStore, error) {
	p, err := secrets.AsPasswordStore(s.c.secrets)
	return p, secrets.Explain(err)
}

// SetMasterPassword sets the first master password of the encrypted file
// store (or a new one while it is unlocked). The store is then unlocked.
func (s *EnvService) SetMasterPassword(password string) error {
	p, err := s.passwordStore()
	if err != nil {
		return err
	}
	return secrets.Explain(p.SetPassword(password))
}

// ChangeMasterPassword re-encrypts the secrets file under a new password
// after checking the current one.
func (s *EnvService) ChangeMasterPassword(current, next string) error {
	p, err := s.passwordStore()
	if err != nil {
		return err
	}
	return secrets.Explain(secrets.ChangePassword(p, current, next))
}

// Unlock unlocks the encrypted file store for this session.
func (s *EnvService) Unlock(password string) error {
	p, err := s.passwordStore()
	if err != nil {
		return err
	}
	return secrets.Explain(p.Unlock(password))
}

// Lock locks the encrypted file store.
func (s *EnvService) Lock() error {
	p, err := s.passwordStore()
	if err != nil {
		return err
	}
	p.Lock()
	return nil
}

// ResetSecretStore deletes the secrets file and every value in it (for a
// forgotten password or a damaged file). Variable keys in the workspace stay.
func (s *EnvService) ResetSecretStore() error {
	p, err := s.passwordStore()
	if err != nil {
		return err
	}
	if err := p.Reset(); err != nil {
		return fmt.Errorf("reset secret store: %w", err)
	}
	return nil
}
