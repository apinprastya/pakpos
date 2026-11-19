package service

import (
	"context"
	"errors"
	"fmt"
	"strings"
	"sync"
	"time"

	"pakpos/internal/core/auth/oauth2"
	"pakpos/internal/core/model"
	"pakpos/internal/pipeline"
	"pakpos/internal/secrets"
)

// EventOAuth2Flow reports a browser flow's progress (OAuth2FlowEvent).
const EventOAuth2Flow = "oauth2:flow"

// OAuth2FlowEvent is the payload of EventOAuth2Flow. Stage "browser" means
// the authorization URL was opened and Pakpos waits for the callback;
// AuthURL is that URL, so the UI can offer to copy it when no browser
// opened. It holds no secret (the PKCE challenge is a hash).
type OAuth2FlowEvent struct {
	FlowID  string `json:"flowId"`
	Stage   string `json:"stage"`
	AuthURL string `json:"authUrl"`
}

// DefaultOAuth2Timeout is how long a browser flow waits for the callback.
const DefaultOAuth2Timeout = 5 * time.Minute

// OAuth2Status describes an owner's stored token without its values.
type OAuth2Status struct {
	HasToken bool `json:"hasToken"`
	// Locked is true when the secret store is locked, so nothing is known.
	Locked    bool   `json:"locked"`
	TokenType string `json:"tokenType"`
	Scope     string `json:"scope"`
	// ExpiresAt and ObtainedAt are Unix milliseconds; ExpiresAt is 0 when
	// the server gave no expiry.
	ExpiresAt       int64 `json:"expiresAt"`
	ObtainedAt      int64 `json:"obtainedAt"`
	HasRefreshToken bool  `json:"hasRefreshToken"`
	HasIDToken      bool  `json:"hasIdToken"`
}

func statusOf(t oauth2.Token) OAuth2Status {
	st := OAuth2Status{
		HasToken: true, TokenType: t.TokenType, Scope: t.Scope, ObtainedAt: t.ObtainedAt.UnixMilli(),
		HasRefreshToken: t.RefreshToken != "", HasIDToken: t.IDToken != "",
	}
	if !t.ExpiresAt.IsZero() {
		st.ExpiresAt = t.ExpiresAt.UnixMilli()
	}
	return st
}

// AuthService gets, refreshes, shows and clears OAuth 2.0 tokens. An owner
// is the collection, folder or saved request whose auth the token belongs
// to. Token values only leave Go through RevealOAuth2Token.
type AuthService struct {
	c       *Core
	app     AppControl
	timeout time.Duration

	mu    sync.Mutex
	flows map[string]context.CancelFunc
}

// NewAuthService creates the service; app opens the browser.
func NewAuthService(c *Core, app AppControl) *AuthService {
	return &AuthService{c: c, app: app, timeout: DefaultOAuth2Timeout, flows: map[string]context.CancelFunc{}}
}

// Messages for owners that can't hold a token.
const (
	msgOAuth2Unsaved = "Save the request first: its OAuth 2.0 token is stored with it."
	msgOAuth2Owner   = "This request, folder or collection no longer exists."
)

// ownerSession checks the owner and returns the open workspace's pipeline.
func (s *AuthService) ownerSession(ownerID string) (*pipeline.Session, error) {
	_, p, err := s.c.openSession()
	if err != nil {
		return nil, err
	}
	if strings.TrimSpace(ownerID) == "" {
		return nil, &userError{msg: msgOAuth2Unsaved}
	}
	if !p.HasOwner(ownerID) {
		return nil, &userError{msg: msgOAuth2Owner}
	}
	return p, nil
}

// settings resolves the OAuth 2.0 settings as the editor has them.
func (s *AuthService) settings(p *pipeline.Session, ownerID, parentID string, a model.Auth) (model.OAuth2, error) {
	o, err := p.ResolveOAuth2(ownerID, parentID, a, s.c.selectedEnvironment(p.Workspace().Manifest().ID))
	if err != nil {
		return model.OAuth2{}, authError(err)
	}
	return o, nil
}

// authError turns pipeline errors into user messages.
func authError(err error) error {
	var ae *pipeline.AuthError
	if errors.As(err, &ae) {
		return &userError{msg: ae.Message, err: err}
	}
	return &userError{msg: pipeline.TokenMessage(err), err: err}
}

// StartOAuth2 gets a new token for ownerID with the auth settings a (as
// edited, possibly unsaved; parentID is a draft request's collection or
// folder) and stores it. The browser grants open the authorization URL
// and wait for the loopback callback until CancelOAuth2(flowID) or the
// timeout; the others ask the token endpoint directly.
func (s *AuthService) StartOAuth2(ctx context.Context, flowID, ownerID, parentID string, a model.Auth) (OAuth2Status, error) {
	if strings.TrimSpace(flowID) == "" {
		return OAuth2Status{}, errors.New("flow id is required")
	}
	p, err := s.ownerSession(ownerID)
	if err != nil {
		return OAuth2Status{}, err
	}
	o, err := s.settings(p, ownerID, parentID, a)
	if err != nil {
		return OAuth2Status{}, err
	}
	ctx, cancel := context.WithTimeout(ctx, s.timeout)
	defer cancel()
	if err := s.register(flowID, cancel); err != nil {
		return OAuth2Status{}, err
	}
	defer s.unregister(flowID)

	tok, err := p.NewToken(ctx, ownerID, o, func(authURL string) error {
		s.c.events.Emit(EventOAuth2Flow, OAuth2FlowEvent{FlowID: flowID, Stage: "browser", AuthURL: authURL})
		return s.app.OpenURL(authURL)
	})
	switch {
	case err == nil:
		return statusOf(tok), nil
	case errors.Is(err, context.DeadlineExceeded) && errors.Is(ctx.Err(), context.DeadlineExceeded):
		return OAuth2Status{}, &userError{msg: fmt.Sprintf("Pakpos waited %s for the browser and stopped. Try again.", humanDuration(s.timeout)), err: err}
	case errors.Is(err, context.Canceled):
		return OAuth2Status{}, &userError{msg: "Cancelled.", err: err}
	}
	return OAuth2Status{}, authError(err)
}

func humanDuration(d time.Duration) string {
	if d >= time.Minute && d%time.Minute == 0 {
		if d == time.Minute {
			return "1 minute"
		}
		return fmt.Sprintf("%d minutes", int(d/time.Minute))
	}
	return d.String()
}

func (s *AuthService) register(id string, cancel context.CancelFunc) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	if _, ok := s.flows[id]; ok {
		return fmt.Errorf("an OAuth 2.0 flow with id %q is already running", id)
	}
	s.flows[id] = cancel
	return nil
}

func (s *AuthService) unregister(id string) {
	s.mu.Lock()
	delete(s.flows, id)
	s.mu.Unlock()
}

// CancelOAuth2 stops a running flow; it reports whether one was found.
func (s *AuthService) CancelOAuth2(flowID string) bool {
	s.mu.Lock()
	cancel, ok := s.flows[flowID]
	s.mu.Unlock()
	if ok {
		cancel()
	}
	return ok
}

// OAuth2TokenStatus describes ownerID's stored token (never its values).
func (s *AuthService) OAuth2TokenStatus(ownerID string) (OAuth2Status, error) {
	_, p, err := s.c.openSession()
	if err != nil {
		return OAuth2Status{}, err
	}
	if strings.TrimSpace(ownerID) == "" {
		return OAuth2Status{}, nil
	}
	tok, found, err := p.LoadToken(ownerID)
	switch {
	case errors.Is(err, secrets.ErrLocked):
		return OAuth2Status{Locked: true}, nil
	case err != nil:
		return OAuth2Status{}, secrets.Explain(err)
	case !found:
		return OAuth2Status{}, nil
	}
	return statusOf(tok), nil
}

// RevealOAuth2Token returns ownerID's access token. It is only called when
// the user asks to see it.
func (s *AuthService) RevealOAuth2Token(ownerID string) (string, error) {
	_, p, err := s.c.openSession()
	if err != nil {
		return "", err
	}
	tok, found, err := p.LoadToken(ownerID)
	switch {
	case err != nil:
		return "", secrets.Explain(err)
	case !found:
		return "", &userError{msg: "There's no OAuth 2.0 access token to show."}
	}
	return tok.AccessToken, nil
}

// RefreshOAuth2 refreshes ownerID's token with its refresh token now.
func (s *AuthService) RefreshOAuth2(ctx context.Context, ownerID, parentID string, a model.Auth) (OAuth2Status, error) {
	p, err := s.ownerSession(ownerID)
	if err != nil {
		return OAuth2Status{}, err
	}
	o, err := s.settings(p, ownerID, parentID, a)
	if err != nil {
		return OAuth2Status{}, err
	}
	tok, err := p.RefreshToken(ctx, ownerID, o)
	if err != nil {
		return OAuth2Status{}, authError(err)
	}
	return statusOf(tok), nil
}

// ClearOAuth2Token deletes ownerID's stored token.
func (s *AuthService) ClearOAuth2Token(ownerID string) error {
	_, p, err := s.c.openSession()
	if err != nil {
		return err
	}
	return secrets.Explain(p.ClearToken(ownerID))
}
