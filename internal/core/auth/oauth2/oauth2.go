// Package oauth2 obtains OAuth 2.0 access tokens: it builds the
// authorization URL (state, PKCE), runs the browser grants through a
// loopback callback server (authorization code, implicit), requests tokens
// from the token endpoint (authorization code, client credentials,
// password, refresh) and parses token and error responses.
//
// HTTP goes through the *http.Client the caller injects (the app's
// transports, so the proxy, CA and client certificate settings apply). The
// package keeps nothing: storing tokens is the caller's job. It has no
// Wails dependency and uses only the standard library.
package oauth2

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"mime"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"time"

	"pakpos/internal/core/model"
)

// maxResponse caps how much of a token endpoint response is read.
const maxResponse = 1 << 20

// Token is what the authorization server granted. It holds secrets: store
// it only in the secret store and never show it unless the user asks.
type Token struct {
	AccessToken  string `json:"accessToken"`
	RefreshToken string `json:"refreshToken,omitempty"`
	TokenType    string `json:"tokenType,omitempty"`
	Scope        string `json:"scope,omitempty"`
	IDToken      string `json:"idToken,omitempty"`
	// ExpiresAt is zero when the server didn't say (expires_in).
	ExpiresAt  time.Time `json:"expiresAt,omitzero"`
	ObtainedAt time.Time `json:"obtainedAt"`
}

// ExpiresWithin reports whether the token expires within d of now. A token
// without an expiry never does.
func (t Token) ExpiresWithin(now time.Time, d time.Duration) bool {
	return !t.ExpiresAt.IsZero() && !now.Add(d).Before(t.ExpiresAt)
}

// Merge returns next with what a refresh response may leave out taken from
// t: the refresh token (servers that don't rotate it), the scope and the
// ID token.
func (t Token) Merge(next Token) Token {
	if next.RefreshToken == "" {
		next.RefreshToken = t.RefreshToken
	}
	if next.Scope == "" {
		next.Scope = t.Scope
	}
	if next.IDToken == "" {
		next.IDToken = t.IDToken
	}
	return next
}

// Error is an error response from the authorization server: an OAuth error
// code (RFC 6749 §5.2, §4.1.2.1) or, without one, an unexpected HTTP status.
type Error struct {
	Code        string
	Description string
	URI         string
	// Status is the HTTP status of a token endpoint response (0 for an
	// error delivered to the callback).
	Status int
}

func (e *Error) Error() string {
	if e.Code == "" {
		return fmt.Sprintf("The token endpoint answered %d %s.", e.Status, http.StatusText(e.Status))
	}
	msg := "The authorization server returned " + e.Code
	if e.Description != "" {
		msg += ": " + strings.TrimSuffix(e.Description, ".")
	}
	if hint := hints[e.Code]; hint != "" {
		msg += ". " + hint
	}
	return msg + "."
}

// hints say what usually fixes an OAuth error code.
var hints = map[string]string{
	"invalid_client":            "Check the client ID, the client secret and how the client authenticates (header or body)",
	"invalid_grant":             "The code, refresh token or credentials are no longer valid; get a new access token",
	"unauthorized_client":       "The client isn't allowed to use this grant type",
	"unsupported_grant_type":    "The server doesn't support this grant type",
	"invalid_scope":             "Check the scope",
	"access_denied":             "Authorization was denied in the browser",
	"unsupported_response_type": "The server doesn't support this grant type",
}

// Sentinel errors for the caller to classify.
var (
	// ErrStateMismatch means the callback's state wasn't the one sent.
	ErrStateMismatch = errors.New("the authorization response doesn't match the request Pakpos made (state mismatch); start again")
	// ErrNoAccessToken means a successful response had no access_token.
	ErrNoAccessToken = errors.New("the authorization server's response has no access token")
	// ErrBrowserGrant is returned by Fetch for a grant that needs the browser.
	ErrBrowserGrant = errors.New("this grant type needs the browser; get a new access token in the Auth tab")
)

// Client talks to the authorization server.
type Client struct {
	// HTTP sends the token requests (nil: http.DefaultClient).
	HTTP *http.Client
	// Now is the clock (nil: time.Now).
	Now func() time.Time
}

func (c Client) now() time.Time {
	if c.Now != nil {
		return c.Now()
	}
	return time.Now()
}

func (c Client) http() *http.Client {
	if c.HTTP != nil {
		return c.HTTP
	}
	return http.DefaultClient
}

// GrantOf returns o's grant, authorization code when unset.
func GrantOf(o model.OAuth2) model.OAuth2Grant {
	if o.Grant == "" {
		return model.GrantAuthorizationCode
	}
	return o.Grant
}

// Validate checks that o has what its grant needs, with a message for the user.
func Validate(o model.OAuth2) error {
	grant := GrantOf(o)
	switch grant {
	case model.GrantAuthorizationCode, model.GrantImplicit, model.GrantClientCredentials, model.GrantPassword:
	default:
		return fmt.Errorf("unknown OAuth 2.0 grant type %q", grant)
	}
	browser := grant == model.GrantAuthorizationCode || grant == model.GrantImplicit
	if browser {
		if err := checkURL("auth URL", o.AuthURL); err != nil {
			return err
		}
		if _, err := ParseRedirect(o.RedirectURL); err != nil {
			return err
		}
	}
	if grant != model.GrantImplicit {
		if err := checkURL("token URL", o.TokenURL); err != nil {
			return err
		}
	}
	if grant != model.GrantPassword && strings.TrimSpace(o.ClientID) == "" {
		return errors.New("enter the client ID")
	}
	if grant == model.GrantPassword && strings.TrimSpace(o.Username) == "" {
		return errors.New("enter the username")
	}
	if m := o.PKCEMethod; grant == model.GrantAuthorizationCode && !o.DisablePKCE && m != "" && m != model.PKCES256 && m != model.PKCEPlain {
		return fmt.Errorf("unknown PKCE method %q (use S256 or plain)", m)
	}
	return nil
}

func checkURL(what, raw string) error {
	if strings.TrimSpace(raw) == "" {
		return fmt.Errorf("enter the %s", what)
	}
	u, err := url.Parse(strings.TrimSpace(raw))
	if err != nil || (u.Scheme != "http" && u.Scheme != "https") || u.Host == "" {
		return fmt.Errorf("the %s must be an http:// or https:// URL", what)
	}
	return nil
}

// Fetch gets a token without the browser: the client credentials or
// password grant. Other grants return ErrBrowserGrant.
func (c Client) Fetch(ctx context.Context, o model.OAuth2) (Token, error) {
	if err := Validate(o); err != nil {
		return Token{}, err
	}
	form := url.Values{}
	switch GrantOf(o) {
	case model.GrantClientCredentials:
		form.Set("grant_type", "client_credentials")
	case model.GrantPassword:
		form.Set("grant_type", "password")
		form.Set("username", o.Username)
		form.Set("password", o.Password)
	default:
		return Token{}, ErrBrowserGrant
	}
	if s := strings.TrimSpace(o.Scope); s != "" {
		form.Set("scope", s)
	}
	return c.token(ctx, o, form)
}

// Exchange trades an authorization code for a token. verifier is the PKCE
// code verifier ("" without PKCE); redirectURL is the one the
// authorization request used.
func (c Client) Exchange(ctx context.Context, o model.OAuth2, code, verifier, redirectURL string) (Token, error) {
	form := url.Values{"grant_type": {"authorization_code"}, "code": {code}, "redirect_uri": {redirectURL}}
	if verifier != "" {
		form.Set("code_verifier", verifier)
	}
	return c.token(ctx, o, form)
}

// Refresh gets a new token with a refresh token. The result is merged with
// old (see Token.Merge) by the caller.
func (c Client) Refresh(ctx context.Context, o model.OAuth2, refreshToken string) (Token, error) {
	if err := checkURL("token URL", o.TokenURL); err != nil {
		return Token{}, err
	}
	form := url.Values{"grant_type": {"refresh_token"}, "refresh_token": {refreshToken}}
	return c.token(ctx, o, form)
}

// token posts form (plus client authentication and the extra parameters)
// to the token endpoint and parses the answer.
func (c Client) token(ctx context.Context, o model.OAuth2, form url.Values) (Token, error) {
	for _, p := range o.ExtraParams {
		if p.Enabled && strings.TrimSpace(p.Key) != "" && !form.Has(p.Key) {
			form.Set(strings.TrimSpace(p.Key), p.Value)
		}
	}
	basic := o.ClientAuth != model.ClientAuthBody && o.ClientSecret != ""
	if !basic && strings.TrimSpace(o.ClientID) != "" {
		form.Set("client_id", o.ClientID)
		if o.ClientSecret != "" {
			form.Set("client_secret", o.ClientSecret)
		}
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, strings.TrimSpace(o.TokenURL), strings.NewReader(form.Encode()))
	if err != nil {
		return Token{}, fmt.Errorf("the token URL isn't valid: %w", err)
	}
	req.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	req.Header.Set("Accept", "application/json")
	if basic {
		// RFC 6749 §2.3.1: both are form-encoded before Basic encoding.
		req.SetBasicAuth(url.QueryEscape(o.ClientID), url.QueryEscape(o.ClientSecret))
	}
	resp, err := c.http().Do(req)
	if err != nil {
		return Token{}, err
	}
	defer resp.Body.Close()
	body, err := io.ReadAll(io.LimitReader(resp.Body, maxResponse))
	if err != nil {
		return Token{}, fmt.Errorf("read the token response: %w", err)
	}
	return ParseResponse(resp.StatusCode, resp.Header.Get("Content-Type"), body, c.now())
}

// ParseResponse reads a token endpoint response: JSON, or form-encoded
// (some servers, e.g. GitHub without Accept). An "error" field or a non-2xx
// status is an *Error.
func ParseResponse(status int, contentType string, body []byte, now time.Time) (Token, error) {
	fields, ok := decodeFields(contentType, body)
	if code := fields["error"]; code != "" {
		return Token{}, &Error{Code: code, Description: fields["error_description"], URI: fields["error_uri"], Status: status}
	}
	if status < 200 || status > 299 || !ok {
		if status >= 200 && status <= 299 {
			return Token{}, ErrNoAccessToken
		}
		return Token{}, &Error{Status: status}
	}
	return tokenFrom(fields, now)
}

// tokenFrom builds a token from response fields (token endpoint or the
// implicit grant's fragment).
func tokenFrom(fields map[string]string, now time.Time) (Token, error) {
	t := Token{
		AccessToken: fields["access_token"], RefreshToken: fields["refresh_token"],
		TokenType: fields["token_type"], Scope: fields["scope"], IDToken: fields["id_token"],
		ObtainedAt: now.UTC(),
	}
	if t.AccessToken == "" {
		return Token{}, ErrNoAccessToken
	}
	if s, err := strconv.ParseFloat(strings.TrimSpace(fields["expires_in"]), 64); err == nil && s > 0 {
		t.ExpiresAt = now.Add(time.Duration(s * float64(time.Second))).UTC()
	}
	return t, nil
}

// decodeFields turns a JSON object or form body into strings (numbers as
// written). ok is false when the body is neither.
func decodeFields(contentType string, body []byte) (map[string]string, bool) {
	mt, _, _ := mime.ParseMediaType(contentType)
	trimmed := strings.TrimSpace(string(body))
	if strings.Contains(mt, "json") || strings.HasPrefix(trimmed, "{") {
		var raw map[string]json.RawMessage
		if err := json.Unmarshal(body, &raw); err != nil {
			return map[string]string{}, false
		}
		out := map[string]string{}
		for k, v := range raw {
			var s string
			if json.Unmarshal(v, &s) == nil {
				out[k] = s
				continue
			}
			out[k] = strings.TrimSpace(string(v))
		}
		return out, true
	}
	if mt == "application/x-www-form-urlencoded" || mt == "text/plain" || (mt == "" && strings.Contains(trimmed, "=")) {
		q, err := url.ParseQuery(trimmed)
		if err != nil {
			return map[string]string{}, false
		}
		return flatten(q), true
	}
	return map[string]string{}, false
}

func flatten(q url.Values) map[string]string {
	out := map[string]string{}
	for k := range q {
		out[k] = q.Get(k)
	}
	return out
}
