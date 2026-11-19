package oauth2

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"errors"
	"fmt"
	"io"
	"net/url"
	"strings"

	"pakpos/internal/core/model"
)

// random returns n random bytes as unpadded base64url (rand is
// crypto/rand.Reader unless a test replaces it).
func random(r io.Reader, n int) (string, error) {
	b := make([]byte, n)
	if _, err := io.ReadFull(r, b); err != nil {
		return "", fmt.Errorf("make a random value: %w", err)
	}
	return base64.RawURLEncoding.EncodeToString(b), nil
}

// NewVerifier returns a PKCE code verifier (43 characters, RFC 7636 §4.1).
func NewVerifier() (string, error) { return random(rand.Reader, 32) }

// NewState returns a random state value.
func NewState() (string, error) { return random(rand.Reader, 24) }

// Challenge returns the PKCE code challenge of verifier for method
// (S256, the default, or plain).
func Challenge(method, verifier string) string {
	if method == model.PKCEPlain {
		return verifier
	}
	sum := sha256.Sum256([]byte(verifier))
	return base64.RawURLEncoding.EncodeToString(sum[:])
}

// pkceMethod is o's PKCE method ("" when PKCE is off or not used).
func pkceMethod(o model.OAuth2) string {
	if GrantOf(o) != model.GrantAuthorizationCode || o.DisablePKCE {
		return ""
	}
	if o.PKCEMethod == model.PKCEPlain {
		return model.PKCEPlain
	}
	return model.PKCES256
}

// AuthorizationURL builds the URL the browser opens: o.AuthURL (its own
// query kept) plus response_type, client_id, redirect_uri, scope, state,
// the PKCE challenge when verifier is set, and o's extra parameters.
func AuthorizationURL(o model.OAuth2, redirectURL, state, verifier string) (string, error) {
	u, err := url.Parse(strings.TrimSpace(o.AuthURL))
	if err != nil {
		return "", fmt.Errorf("the auth URL isn't valid: %w", err)
	}
	q := u.Query()
	responseType := "code"
	if GrantOf(o) == model.GrantImplicit {
		responseType = "token"
	}
	q.Set("response_type", responseType)
	q.Set("client_id", o.ClientID)
	q.Set("redirect_uri", redirectURL)
	if s := strings.TrimSpace(o.Scope); s != "" {
		q.Set("scope", s)
	}
	q.Set("state", state)
	if m := pkceMethod(o); m != "" && verifier != "" {
		q.Set("code_challenge", Challenge(m, verifier))
		q.Set("code_challenge_method", m)
	}
	for _, p := range o.ExtraParams {
		if k := strings.TrimSpace(p.Key); p.Enabled && k != "" && !q.Has(k) {
			q.Set(k, p.Value)
		}
	}
	u.RawQuery = q.Encode()
	return u.String(), nil
}

// ErrOpenBrowser wraps a failure to open the browser.
var ErrOpenBrowser = errors.New("couldn't open the browser")

// Authorize runs a browser grant (authorization code or implicit): it
// starts the loopback callback server, calls open with the authorization
// URL, waits for the callback (until ctx ends: the caller sets the
// timeout and cancels), checks the state and, for the code grant,
// exchanges the code. For other grants it is Fetch.
func (c Client) Authorize(ctx context.Context, o model.OAuth2, open func(authURL string) error) (Token, error) {
	grant := GrantOf(o)
	if grant != model.GrantAuthorizationCode && grant != model.GrantImplicit {
		return c.Fetch(ctx, o)
	}
	if err := Validate(o); err != nil {
		return Token{}, err
	}
	state, err := NewState()
	if err != nil {
		return Token{}, err
	}
	verifier := ""
	if pkceMethod(o) != "" {
		if verifier, err = NewVerifier(); err != nil {
			return Token{}, err
		}
	}
	lb, err := Listen(o.RedirectURL, state, grant == model.GrantImplicit)
	if err != nil {
		return Token{}, err
	}
	defer lb.Close()
	authURL, err := AuthorizationURL(o, lb.RedirectURL(), state, verifier)
	if err != nil {
		return Token{}, err
	}
	if err := open(authURL); err != nil {
		return Token{}, fmt.Errorf("%w: %v", ErrOpenBrowser, err)
	}
	params, err := lb.Wait(ctx)
	if err != nil {
		return Token{}, err
	}
	if grant == model.GrantImplicit {
		return tokenFrom(params, c.now())
	}
	code := params["code"]
	if code == "" {
		return Token{}, errors.New("the authorization response has no code")
	}
	return c.Exchange(ctx, o, code, verifier, lb.RedirectURL())
}
