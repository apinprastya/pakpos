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
