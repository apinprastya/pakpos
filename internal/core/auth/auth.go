// Package auth applies request authorization settings to an *http.Request.
//
// Precedence: an explicit, enabled user header (or query param) always wins.
// If the request already carries the header/param that the auth scheme would
// set, Apply leaves it untouched. This matches what users expect when they
// hand-craft an Authorization header for debugging.
package auth

import (
	"errors"
	"fmt"
	"net/http"
	"net/url"
	"strings"

	"pakpos/internal/core/model"
)

// ErrMissingAPIKeyName is returned when API key auth has no key name.
var ErrMissingAPIKeyName = errors.New("API key auth needs a key name")

// ErrOAuth2Token is returned by Apply for OAuth 2.0 auth: the send pipeline
// must first turn it into the token's header or query parameter (TokenAuth).
var ErrOAuth2Token = errors.New("OAuth 2.0 auth needs an access token; get one in the Auth tab")

// TokenName is the placeholder an OAuth 2.0 access token is shown as where
// a request is written out (generated code, masked text): {{oauth2AccessToken}}.
const TokenName = "oauth2AccessToken"

// TokenPlaceholder is TokenName as a {{reference}}.
const TokenPlaceholder = "{{" + TokenName + "}}"

// Defaults of the OAuth 2.0 token placement.
const (
	DefaultTokenPrefix = "Bearer"
	DefaultTokenParam  = "access_token"
)

// TokenAuth returns the auth that sends an OAuth 2.0 access token the way o
// places it: a bearer header with o's prefix (default Bearer), or a query
// parameter (default access_token). o may be nil (header, Bearer).
func TokenAuth(o *model.OAuth2, token string) model.Auth {
	if o != nil && o.Placement == model.PlaceQuery {
		name := strings.TrimSpace(o.QueryParam)
		if name == "" {
			name = DefaultTokenParam
		}
		return model.Auth{Type: model.AuthAPIKey, APIKey: name, APIValue: token, APIIn: model.APIKeyInQuery}
	}
	prefix := DefaultTokenPrefix
	if o != nil && strings.TrimSpace(o.HeaderPrefix) != "" {
		prefix = strings.TrimSpace(o.HeaderPrefix)
	}
	return model.Auth{Type: model.AuthBearer, Token: token, Prefix: prefix}
}

// Apply adds the authorization described by a to r.
// AuthNone, AuthInherit (resolved upstream in later tiers) and an empty type are no-ops.
func Apply(r *http.Request, a model.Auth) error {
	switch a.Type {
	case "", model.AuthNone, model.AuthInherit:
		return nil
	case model.AuthBasic:
		if r.Header.Get("Authorization") == "" {
			r.SetBasicAuth(a.Username, a.Password)
		}
		return nil
	case model.AuthBearer:
		if r.Header.Get("Authorization") == "" && a.Token != "" {
			prefix := strings.TrimSpace(a.Prefix)
			if prefix == "" {
				prefix = "Bearer"
			}
			r.Header.Set("Authorization", prefix+" "+a.Token)
		}
		return nil
	case model.AuthAPIKey:
		return applyAPIKey(r, a)
	case model.AuthOAuth2:
		return ErrOAuth2Token
	case model.AuthDigest, model.AuthNTLM:
		return nil // answered by httpexec after the server's challenge
	case model.AuthAWSV4:
		return applyAWS(r, a.AWSV4)
	case model.AuthJWT:
		return applyJWT(r, a.JWT)
	case model.AuthHawk:
		return applyHawk(r, a.Hawk)
	default:
		return fmt.Errorf("unsupported auth type %q", a.Type)
	}
}

func applyAPIKey(r *http.Request, a model.Auth) error {
	name := strings.TrimSpace(a.APIKey)
	if name == "" {
		return ErrMissingAPIKeyName
	}
	switch a.APIIn {
	case model.APIKeyInQuery:
		q := r.URL.Query()
		if q.Has(name) {
			return nil
		}
		pair := url.QueryEscape(name) + "=" + url.QueryEscape(a.APIValue)
		if r.URL.RawQuery == "" {
			r.URL.RawQuery = pair
		} else {
			r.URL.RawQuery += "&" + pair
		}
		return nil
	case "", model.APIKeyInHeader:
		if r.Header.Get(name) == "" {
			r.Header.Set(name, a.APIValue)
		}
		return nil
	default:
		return fmt.Errorf("unsupported API key location %q", a.APIIn)
	}
}

// Materialize returns req with its auth written out as the header or query
// row that Apply would set on the wire, and its auth type set to none. It is
// used where a request is shown rather than sent (code generation, Copy as
// cURL). The precedence is Apply's: an enabled user header (or query row)
// with a value wins over the auth setting.
//
// With keepBasic, basic auth stays as auth (type basic) instead of becoming
// an Authorization header, so generated code can use the language's own
// basic-auth helper and keep {{variables}} in the password readable. It is
// still dropped when the user set an Authorization header.
//
// req is not modified; Headers and Query are copied when they change.
func Materialize(req model.Request, keepBasic bool) (model.Request, error) {
	out, _, err := MaterializeWith(req, func(t model.AuthType) bool { return keepBasic && t == model.AuthBasic })
	return out, err
}

// MaterializeWith is Materialize where keep says which auth types the
// target writes with its own helper (they stay as auth: basic, Digest,
// NTLM, AWS Signature v4). The others become headers or query rows: AWS
// Signature v4, JWT and Hawk are computed now (see Signed), which needs
// their settings resolved; Digest and NTLM can't be (they need the
// server's challenge) and are left out. The warnings say what the code
// does differently from a send. keep may be nil.
func MaterializeWith(req model.Request, keep func(model.AuthType) bool) (model.Request, []string, error) {
	a := req.Auth
	out := req
	out.Auth = model.Auth{Type: model.AuthNone}
	kept := keep != nil && keep(a.Type)
	switch a.Type {
	case model.AuthOAuth2:
		a = TokenAuth(a.OAuth2, TokenPlaceholder)
	case model.AuthJWT:
		if hasValue(req.Headers, "Authorization") && a.JWT != nil && a.JWT.Placement != model.PlaceQuery {
			return out, nil, nil
		}
		tok, warn := materializeJWT(a.JWT)
		if tok == "" {
			return out, warn, nil
		}
		a = JWTAuth(*a.JWT, tok)
		res, err := materializeSimple(out, req, a, false)
		return res, warn, err
	case model.AuthDigest, model.AuthNTLM, model.AuthAWSV4:
		if hasValue(req.Headers, "Authorization") {
			return out, nil, nil
		}
		if kept && authSettings(a) {
			out.Auth = a
			return out, nil, nil
		}
		if a.Type == model.AuthAWSV4 {
			return materializeAWS(out, req)
		}
		if authSettings(a) {
			return out, []string{handshakeWarning(a.Type)}, nil
		}
		return out, nil, nil
	case model.AuthHawk:
		if hasValue(req.Headers, "Authorization") {
			return out, nil, nil
		}
		return materializeHawk(out, req)
	}
	res, err := materializeSimple(out, req, a, kept)
	return res, nil, err
}

// authSettings reports whether a has the settings block of its type.
func authSettings(a model.Auth) bool {
	switch a.Type {
	case model.AuthDigest:
		return a.Digest != nil
	case model.AuthNTLM:
		return a.NTLM != nil
	case model.AuthAWSV4:
		return a.AWSV4 != nil
	}
	return true
}

func handshakeWarning(t model.AuthType) string {
	name := map[model.AuthType]string{model.AuthDigest: "Digest", model.AuthNTLM: "NTLM"}[t]
	return name + " auth needs the server's challenge, which this code doesn't answer, so it sends no auth. Add it with an HTTP library that supports " + name + "."
}

// materializeSimple writes basic, bearer and API key auth.
func materializeSimple(out, req model.Request, a model.Auth, keepBasic bool) (model.Request, error) {
	switch a.Type {
	case "", model.AuthNone, model.AuthInherit:
		return out, nil
	case model.AuthBasic:
		if hasValue(req.Headers, "Authorization") {
			return out, nil
		}
		if keepBasic {
			out.Auth = model.Auth{Type: model.AuthBasic, Username: a.Username, Password: a.Password}
			return out, nil
		}
		r := &http.Request{Header: http.Header{}}
		r.SetBasicAuth(a.Username, a.Password)
		out.Headers = setHeader(req.Headers, "Authorization", r.Header.Get("Authorization"))
		return out, nil
	case model.AuthBearer:
		if a.Token == "" || hasValue(req.Headers, "Authorization") {
			return out, nil
		}
		prefix := strings.TrimSpace(a.Prefix)
		if prefix == "" {
			prefix = "Bearer"
		}
		out.Headers = setHeader(req.Headers, "Authorization", prefix+" "+a.Token)
		return out, nil
	case model.AuthAPIKey:
		name := strings.TrimSpace(a.APIKey)
		if name == "" {
			return out, ErrMissingAPIKeyName
		}
		switch a.APIIn {
		case model.APIKeyInQuery:
			for _, q := range req.Query {
				if q.Enabled && q.Key == name {
					return out, nil
				}
			}
			out.Query = append(append([]model.KeyValue{}, req.Query...), model.KeyValue{Key: name, Value: a.APIValue, Enabled: true})
			return out, nil
		case "", model.APIKeyInHeader:
			if !hasValue(req.Headers, name) {
				out.Headers = setHeader(req.Headers, name, a.APIValue)
			}
			return out, nil
		default:
			return out, fmt.Errorf("unsupported API key location %q", a.APIIn)
		}
	default:
		return out, fmt.Errorf("unsupported auth type %q", a.Type)
	}
}

// hasValue mirrors http.Header.Get(name) != "": the first enabled row named
// name (case-insensitive) has a non-empty value.
func hasValue(rows []model.KeyValue, name string) bool {
	for _, h := range rows {
		if h.Enabled && strings.EqualFold(strings.TrimSpace(h.Key), name) {
			return h.Value != ""
		}
	}
	return false
}

// setHeader mirrors http.Header.Set: enabled rows named name are dropped and
// one row is appended. Disabled rows are kept.
func setHeader(rows []model.KeyValue, name, value string) []model.KeyValue {
	out := make([]model.KeyValue, 0, len(rows)+1)
	for _, h := range rows {
		if h.Enabled && strings.EqualFold(strings.TrimSpace(h.Key), name) {
			continue
		}
		out = append(out, h)
	}
	return append(out, model.KeyValue{Key: name, Value: value, Enabled: true})
}
