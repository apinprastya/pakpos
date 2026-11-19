package pipeline

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/url"
	"slices"
	"strings"
	"sync"
	"time"

	"pakpos/internal/core/auth"
	"pakpos/internal/core/auth/oauth2"
	"pakpos/internal/core/httpexec"
	"pakpos/internal/core/inherit"
	"pakpos/internal/core/model"
	"pakpos/internal/core/vars"
	"pakpos/internal/secrets"
	"pakpos/internal/store/fsstore"
)

// OAuth2TokenKey is the key name of an OAuth 2.0 token in the secret store:
// pakpos/<workspace>/<owner id>/{oauth2}, where the owner is the request,
// folder or collection whose auth got it. Braces can't appear in a
// {{variable}} name, so it never collides with a collection's secret
// variable (a collection's id is also its variable scope id).
const OAuth2TokenKey = "{oauth2}"

// RefreshTokenName names the refresh token in masked text.
const RefreshTokenName = "oauth2RefreshToken"

// RefreshWindow is how close to its expiry a token is refreshed before a send.
const RefreshWindow = 30 * time.Second

// OAuth2 is the token machinery shared by every Session of an app: the
// HTTP client for token endpoints (the app's transports) and a lock per
// owner, so concurrent sends refresh a token once.
type OAuth2 struct {
	client func() *http.Client
	now    func() time.Time

	mu    sync.Mutex
	locks map[string]*sync.Mutex
}

// NewOAuth2 returns the shared state. client is called for every token
// request (so settings changes apply); now may be nil (time.Now).
func NewOAuth2(client func() *http.Client, now func() time.Time) *OAuth2 {
	if now == nil {
		now = time.Now
	}
	return &OAuth2{client: client, now: now, locks: map[string]*sync.Mutex{}}
}

// lock serialises token work for one owner and returns the unlock.
func (o *OAuth2) lock(key string) func() {
	o.mu.Lock()
	m, ok := o.locks[key]
	if !ok {
		m = &sync.Mutex{}
		o.locks[key] = m
	}
	o.mu.Unlock()
	m.Lock()
	return m.Unlock
}

func (o *OAuth2) oauthClient() oauth2.Client {
	return oauth2.Client{HTTP: o.client(), Now: o.now}
}

// WithOAuth2 enables OAuth 2.0 tokens for the session. It returns s.
func (s *Session) WithOAuth2(o *OAuth2) *Session {
	s.oauth = o
	return s
}

// AuthError is an OAuth 2.0 problem that stops a send (error kind
// httpexec.KindAuth): no token, or getting or refreshing one failed.
type AuthError struct {
	Message string
	// Locked is true when the secret store is locked.
	Locked bool
	Err    error
}

func (e *AuthError) Error() string { return e.Message }
func (e *AuthError) Unwrap() error { return e.Err }

// TokenOwner returns the id whose token a request with the effective
// result eff uses: the level it inherits its auth from, else the request.
func TokenOwner(eff inherit.Result) string {
	if eff.AuthSource != nil {
		return eff.AuthSource.ID
	}
	return eff.Request.ID
}

func (s *Session) tokenKey(owner string) string {
	return secrets.Key(s.workspaceID(), owner, OAuth2TokenKey)
}

// LoadToken reads the stored token of owner. found is false when there is
// none (also when the file store has no master password yet).
func (s *Session) LoadToken(owner string) (tok oauth2.Token, found bool, err error) {
	raw, err := s.sec.Get(s.tokenKey(owner))
	switch {
	case errors.Is(err, secrets.ErrNotFound), errors.Is(err, secrets.ErrNoPassword):
		return oauth2.Token{}, false, nil
	case err != nil:
		return oauth2.Token{}, false, err
	}
	if err := json.Unmarshal([]byte(raw), &tok); err != nil || tok.AccessToken == "" {
		// A damaged value is as good as none; the next token replaces it.
		return oauth2.Token{}, false, nil
	}
	return tok, true, nil
}

// SaveToken stores owner's token (through the session's store, so the
// secret index records the key).
func (s *Session) SaveToken(owner string, tok oauth2.Token) error {
	if strings.TrimSpace(owner) == "" {
		return errors.New("an OAuth 2.0 token needs an owner")
	}
	data, err := json.Marshal(tok) //nolint:gosec // the token goes to the secret store only
	if err != nil {
		return err
	}
	return s.sec.Set(s.tokenKey(owner), string(data))
}

// ClearToken deletes owner's token; none stored is not an error.
func (s *Session) ClearToken(owner string) error {
	err := s.sec.Delete(s.tokenKey(owner))
	if errors.Is(err, secrets.ErrNotFound) || errors.Is(err, secrets.ErrNoPassword) {
		return nil
	}
	return err
}

// ResolveOAuth2 resolves the {{variables}} of OAuth 2.0 settings a as seen
// from owner (a request, folder or collection id; parentID is a draft
// request's collection or folder) with the environment envID. Variables
// without a value are an error: the authorization server would get the
// reference as written.
func (s *Session) ResolveOAuth2(owner, parentID string, a model.Auth, envID string) (model.OAuth2, error) {
	if a.OAuth2 == nil {
		return model.OAuth2{}, errors.New("the OAuth 2.0 settings are empty")
	}
	a.Type = model.AuthOAuth2
	chain, err := s.ws.InheritChain(owner)
	if err != nil {
		chain = s.Chain(model.Request{ID: owner}, parentID)
	}
	scopes := s.BuildScopes(collectionOf(chain), s.Environment(envID))
	res := vars.New(scopes.List, s.opts...)
	out, unresolved, err := res.ResolveRequest(model.Request{Auth: a})
	if err != nil {
		return model.OAuth2{}, errors.New(VariableMessage(err))
	}
	if len(unresolved) > 0 {
		if anyLocked(res, unresolved, scopes.Locked) {
			return model.OAuth2{}, &AuthError{Message: "The secret store is locked, so the OAuth 2.0 settings can't be read. Unlock it and try again.", Locked: true, Err: secrets.ErrLocked}
		}
		return model.OAuth2{}, fmt.Errorf("these variables have no value: %s; set them and try again", strings.Join(unresolved, ", "))
	}
	return *out.Auth.OAuth2, nil
}

// TokenMessage turns an error from getting or refreshing a token into a
// sentence for the user.
func TokenMessage(err error) string {
	var oe *oauth2.Error
	var ue *url.Error
	switch {
	case errors.As(err, &oe):
		return oe.Error()
	case errors.Is(err, context.DeadlineExceeded):
		return "Timed out waiting for the authorization server."
	case errors.Is(err, context.Canceled):
		return "Cancelled."
	case errors.As(err, &ue):
		return "Couldn't reach the token endpoint. " + httpexec.Classify(err).Message
	}
	msg := err.Error()
	if msg == "" {
		return msg
	}
	msg = strings.ToUpper(msg[:1]) + msg[1:]
	if !strings.HasSuffix(msg, ".") {
		msg += "."
	}
	return msg
}

// Token gets a usable token for owner with the resolved settings o: the
// stored one, refreshed when it expires within RefreshWindow (and has a
// refresh token, and auto refresh is on), or for the client credentials
// and password grants a new one when there is none. Never a browser flow.
// where names the Auth tab to point the user at.
func (s *Session) Token(ctx context.Context, owner string, o model.OAuth2, where string) (oauth2.Token, error) {
	if s.oauth == nil {
		return oauth2.Token{}, &AuthError{Message: "OAuth 2.0 isn't available here."}
	}
	defer s.oauth.lock(s.workspaceID() + "/" + owner)()
	tok, found, err := s.LoadToken(owner)
	if err != nil {
		return oauth2.Token{}, storeError(err, "read")
	}
	now := s.oauth.now()
	if found && !tok.ExpiresWithin(now, RefreshWindow) {
		return tok, nil
	}
	getNew := "Get a new access token in " + where + "."
	grant := oauth2.GrantOf(o)
	fetch := grant == model.GrantClientCredentials || grant == model.GrantPassword
	switch {
	case found && tok.RefreshToken != "" && !o.DisableAutoRefresh:
		next, err := s.oauth.oauthClient().Refresh(ctx, o, tok.RefreshToken)
		if err != nil {
			return oauth2.Token{}, &AuthError{Message: "Couldn't refresh the OAuth 2.0 access token: " + TokenMessage(err) + " " + getNew, Err: err}
		}
		return s.keep(owner, tok.Merge(next))
	case fetch:
		next, err := s.oauth.oauthClient().Fetch(ctx, o)
		if err != nil {
			return oauth2.Token{}, &AuthError{Message: "Couldn't get an OAuth 2.0 access token: " + TokenMessage(err), Err: err}
		}
		return s.keep(owner, next)
	case found && tok.ExpiresWithin(now, 0):
		return oauth2.Token{}, &AuthError{Message: "The OAuth 2.0 access token has expired. " + getNew}
	case found:
		return tok, nil // expires soon, but can't be refreshed: still good now
	default:
		return oauth2.Token{}, &AuthError{Message: "There's no OAuth 2.0 access token yet. " + getNew}
	}
}

// keep stores a new token; a store without a master password can't keep
// it, but the send still uses it.
func (s *Session) keep(owner string, tok oauth2.Token) (oauth2.Token, error) {
	err := s.SaveToken(owner, tok)
	switch {
	case err == nil:
	case errors.Is(err, secrets.ErrNoPassword):
		s.log.Warn("OAuth 2.0 token not stored: no master password yet")
	default:
		return oauth2.Token{}, storeError(err, "store")
	}
	return tok, nil
}

func storeError(err error, verb string) error {
	if errors.Is(err, secrets.ErrLocked) {
		return &AuthError{Message: "The secret store is locked, so the OAuth 2.0 access token can't be " + verb + "d. Unlock it and send again.", Locked: true, Err: err}
	}
	return &AuthError{Message: fmt.Sprintf("Couldn't %s the OAuth 2.0 access token: %v", verb, secrets.Explain(err)), Err: err}
}

// authTab names where a request's token is managed, for messages.
func authTab(eff inherit.Result) string {
	if src := eff.AuthSource; src != nil {
		return fmt.Sprintf("the Auth tab of the %s %q", src.Kind, src.Name)
	}
	return "the Auth tab"
}

// Authorize puts the OAuth 2.0 access token on p.Request when its auth is
// OAuth 2.0 (see Session.Token), as a bearer header or a query parameter,
// and masks the token from then on. Other auth is left alone. The error
// is an *AuthError.
func (sd *Send) Authorize(ctx context.Context, p *Prepared) error {
	a := p.Request.Auth
	if a.Type != model.AuthOAuth2 {
		return nil
	}
	if sd.sess == nil {
		return &AuthError{Message: "OAuth 2.0 tokens are kept per workspace. Open a workspace to use OAuth 2.0."}
	}
	owner := TokenOwner(sd.eff)
	if owner == "" {
		return &AuthError{Message: "Save the request first: its OAuth 2.0 token is stored with it."}
	}
	o := model.OAuth2{}
	if a.OAuth2 != nil {
		o = *a.OAuth2
	}
	tok, err := sd.sess.Token(ctx, owner, o, authTab(sd.eff))
	if err != nil {
		var ae *AuthError
		if errors.As(err, &ae) {
			ae.Message = sd.Mask(ae.Message)
			sd.locked = sd.locked || ae.Locked
		}
		return err
	}
	sd.addSecret(auth.TokenName, tok.AccessToken)
	sd.addSecret(RefreshTokenName, tok.RefreshToken)
	p.Request.Auth = auth.TokenAuth(a.OAuth2, tok.AccessToken)
	return nil
}

// tokenSecrets returns the stored token of the owner of req's effective
// OAuth 2.0 auth, as secret values (none for other auth).
func (s *Session) tokenSecrets(req model.Request, parentID string) (values []SecretValue, locked bool) {
	eff := inherit.Effective(s.Chain(req, parentID), req)
	if eff.Request.Auth.Type != model.AuthOAuth2 || TokenOwner(eff) == "" {
		return nil, false
	}
	tok, found, err := s.LoadToken(TokenOwner(eff))
	if err != nil {
		return nil, errors.Is(err, secrets.ErrLocked)
	}
	if !found {
		return nil, false
	}
	for _, v := range []SecretValue{{auth.TokenName, tok.AccessToken}, {RefreshTokenName, tok.RefreshToken}} {
		if len(v.Value) >= MinSecretLength {
			values = append(values, v)
		}
	}
	return values, false
}

// codeToken puts the stored access token into a request prepared for code
// generation when secrets are revealed; otherwise the auth stays OAuth 2.0
// and the code shows auth.TokenPlaceholder (listed in Masked).
func (s *Session) codeToken(p *PreparedCode, eff inherit.Result, opts CodeOptions) {
	if p.Request.Auth.Type != model.AuthOAuth2 {
		return
	}
	if !opts.ResolveVariables {
		return
	}
	if !opts.RevealSecrets {
		p.Masked = append(p.Masked, auth.TokenName)
		slices.Sort(p.Masked)
		return
	}
	owner := TokenOwner(eff)
	tok, found, err := s.LoadToken(owner)
	switch {
	case owner != "" && err == nil && found:
		p.Request.Auth = auth.TokenAuth(p.Request.Auth.OAuth2, tok.AccessToken)
	case errors.Is(err, secrets.ErrLocked):
		p.SecretsLocked = true
	default:
		p.Unresolved = append(p.Unresolved, auth.TokenName)
	}
}

// hasOAuth2 reports whether id is a collection, folder or request whose own
// auth is OAuth 2.0 (so its stored token is still in use).
func (s *Session) hasOAuth2(id string) bool {
	if c, err := s.ws.GetCollection(id); err == nil {
		return c.Auth.Type == model.AuthOAuth2
	}
	if f, err := s.ws.GetFolder(id); err == nil {
		return f.Auth.Type == model.AuthOAuth2
	}
	if r, err := s.ws.GetRequest(id); err == nil {
		return r.Auth.Type == model.AuthOAuth2
	}
	return false
}

// subtree returns id and the ids of every folder and request under it.
func subtree(nodes []fsstore.Node, id string, inside bool) []string {
	var out []string
	for _, n := range nodes {
		in := inside || n.ID == id
		if in {
			out = append(out, n.ID)
		}
		out = append(out, subtree(n.Children, id, in)...)
	}
	return out
}

// forgetTokens deletes the stored tokens of ids. With a secret index only
// the indexed keys are touched; failures are logged.
func (s *Session) forgetTokens(ids []string) {
	if len(ids) == 0 {
		return
	}
	targets := ids
	if s.idx != nil {
		if indexed, err := s.idx.SecretKeys(s.workspaceID()); err == nil {
			targets = nil
			for _, r := range indexed {
				if r.Key == OAuth2TokenKey && slices.Contains(ids, r.ScopeID) {
					targets = append(targets, r.ScopeID)
				}
			}
		}
	}
	for _, id := range targets {
		if err := s.ClearToken(id); err != nil {
			s.log.Warn("delete OAuth 2.0 token", "owner", id, "err", err)
		}
	}
}

// DeleteRequest deletes a saved request and its OAuth 2.0 token.
func (s *Session) DeleteRequest(id string) error {
	if err := s.ws.DeleteRequest(id); err != nil {
		return err
	}
	s.forgetTokens([]string{id})
	return nil
}

// DeleteFolder deletes a folder with everything in it, and the OAuth 2.0
// tokens of the folder and what was in it.
func (s *Session) DeleteFolder(id string) error {
	ids := subtree(s.ws.Tree().Collections, id, false)
	if err := s.ws.DeleteFolder(id); err != nil {
		return err
	}
	s.forgetTokens(ids)
	return nil
}

// NewToken runs o's grant for owner (a browser flow calls open with the
// authorization URL and waits for the callback until ctx ends) and stores
// the token. Errors are *AuthError with a message for the user.
func (s *Session) NewToken(ctx context.Context, owner string, o model.OAuth2, open func(authURL string) error) (oauth2.Token, error) {
	if s.oauth == nil {
		return oauth2.Token{}, &AuthError{Message: "OAuth 2.0 isn't available here."}
	}
	if err := oauth2.Validate(o); err != nil {
		return oauth2.Token{}, &AuthError{Message: "Check the OAuth 2.0 settings: " + err.Error() + ".", Err: err}
	}
	tok, err := s.oauth.oauthClient().Authorize(ctx, o, open)
	if err != nil {
		return oauth2.Token{}, &AuthError{Message: TokenMessage(err), Err: err}
	}
	defer s.oauth.lock(s.workspaceID() + "/" + owner)()
	if err := s.SaveToken(owner, tok); err != nil {
		return oauth2.Token{}, storeError(err, "store")
	}
	return tok, nil
}

// RefreshToken refreshes owner's stored token now and stores the result.
func (s *Session) RefreshToken(ctx context.Context, owner string, o model.OAuth2) (oauth2.Token, error) {
	if s.oauth == nil {
		return oauth2.Token{}, &AuthError{Message: "OAuth 2.0 isn't available here."}
	}
	defer s.oauth.lock(s.workspaceID() + "/" + owner)()
	tok, found, err := s.LoadToken(owner)
	switch {
	case err != nil:
		return oauth2.Token{}, storeError(err, "read")
	case !found:
		return oauth2.Token{}, &AuthError{Message: "There's no OAuth 2.0 access token to refresh. Get a new access token."}
	case tok.RefreshToken == "":
		return oauth2.Token{}, &AuthError{Message: "This access token came without a refresh token. Get a new access token."}
	}
	next, err := s.oauth.oauthClient().Refresh(ctx, o, tok.RefreshToken)
	if err != nil {
		return oauth2.Token{}, &AuthError{Message: "Couldn't refresh the OAuth 2.0 access token: " + TokenMessage(err), Err: err}
	}
	next = tok.Merge(next)
	if err := s.SaveToken(owner, next); err != nil {
		return oauth2.Token{}, storeError(err, "store")
	}
	return next, nil
}

// HasOwner reports whether id is a collection, folder or saved request of
// the workspace (something that can own an OAuth 2.0 token).
func (s *Session) HasOwner(id string) bool {
	if _, err := s.ws.GetCollection(id); err == nil {
		return true
	}
	if _, err := s.ws.GetFolder(id); err == nil {
		return true
	}
	_, err := s.ws.RequestParent(id)
	return err == nil
}
