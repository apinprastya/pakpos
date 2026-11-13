package auth

import (
	"errors"
	"net/http"
	"net/http/httptest"
	"testing"

	"pakpos/internal/core/model"
)

func newReq(t *testing.T, target string, headers map[string]string) *http.Request {
	t.Helper()
	r := httptest.NewRequest(http.MethodGet, target, nil)
	for k, v := range headers {
		r.Header.Set(k, v)
	}
	return r
}

func TestApply(t *testing.T) {
	tests := []struct {
		name       string
		auth       model.Auth
		headers    map[string]string
		target     string
		wantHeader map[string]string
		wantQuery  string
		wantErr    error
	}{
		{name: "empty type", auth: model.Auth{}, wantHeader: map[string]string{"Authorization": ""}},
		{name: "none", auth: model.Auth{Type: model.AuthNone}, wantHeader: map[string]string{"Authorization": ""}},
		{name: "inherit is a no-op for now", auth: model.Auth{Type: model.AuthInherit, Token: "t"}, wantHeader: map[string]string{"Authorization": ""}},
		{
			name:       "basic",
			auth:       model.Auth{Type: model.AuthBasic, Username: "alice", Password: "s3cret"},
			wantHeader: map[string]string{"Authorization": "Basic YWxpY2U6czNjcmV0"},
		},
		{
			name:       "basic keeps explicit header",
			auth:       model.Auth{Type: model.AuthBasic, Username: "alice"},
			headers:    map[string]string{"Authorization": "Custom x"},
			wantHeader: map[string]string{"Authorization": "Custom x"},
		},
		{
			name:       "bearer default prefix",
			auth:       model.Auth{Type: model.AuthBearer, Token: "abc"},
			wantHeader: map[string]string{"Authorization": "Bearer abc"},
		},
		{
			name:       "bearer custom prefix",
			auth:       model.Auth{Type: model.AuthBearer, Token: "abc", Prefix: " Token "},
			wantHeader: map[string]string{"Authorization": "Token abc"},
		},
		{
			name:       "bearer empty token sends nothing",
			auth:       model.Auth{Type: model.AuthBearer},
			wantHeader: map[string]string{"Authorization": ""},
		},
		{
			name:       "bearer keeps explicit header",
			auth:       model.Auth{Type: model.AuthBearer, Token: "abc"},
			headers:    map[string]string{"Authorization": "Bearer manual"},
			wantHeader: map[string]string{"Authorization": "Bearer manual"},
		},
		{
			name:       "api key in header (default location)",
			auth:       model.Auth{Type: model.AuthAPIKey, APIKey: "X-API-Key", APIValue: "k1"},
			wantHeader: map[string]string{"X-Api-Key": "k1"},
		},
		{
			name:       "api key header keeps explicit header",
			auth:       model.Auth{Type: model.AuthAPIKey, APIKey: "X-API-Key", APIValue: "k1", APIIn: model.APIKeyInHeader},
			headers:    map[string]string{"X-API-Key": "mine"},
			wantHeader: map[string]string{"X-Api-Key": "mine"},
		},
		{
			name:      "api key in query appended",
			auth:      model.Auth{Type: model.AuthAPIKey, APIKey: "api key", APIValue: "a&b", APIIn: model.APIKeyInQuery},
			target:    "http://x.dev/p?a=1",
			wantQuery: "a=1&api+key=a%26b",
		},
		{
			name:      "api key in query on empty query",
			auth:      model.Auth{Type: model.AuthAPIKey, APIKey: "key", APIValue: "v", APIIn: model.APIKeyInQuery},
			wantQuery: "key=v",
		},
		{
			name:      "api key in query keeps explicit param",
			auth:      model.Auth{Type: model.AuthAPIKey, APIKey: "key", APIValue: "v", APIIn: model.APIKeyInQuery},
			target:    "http://x.dev/?key=mine",
			wantQuery: "key=mine",
		},
		{name: "api key without name", auth: model.Auth{Type: model.AuthAPIKey, APIKey: "  "}, wantErr: ErrMissingAPIKeyName},
		{name: "api key bad location", auth: model.Auth{Type: model.AuthAPIKey, APIKey: "k", APIIn: "cookie"}, wantErr: errAny},
		{name: "unknown type", auth: model.Auth{Type: "digest"}, wantErr: errAny},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			target := tt.target
			if target == "" {
				target = "http://x.dev/"
			}
			r := newReq(t, target, tt.headers)
			err := Apply(r, tt.auth)
			switch {
			case tt.wantErr == errAny:
				if err == nil {
					t.Fatal("expected an error")
				}
				return
			case tt.wantErr != nil:
				if !errors.Is(err, tt.wantErr) {
					t.Fatalf("err = %v, want %v", err, tt.wantErr)
				}
				return
			case err != nil:
				t.Fatalf("unexpected error: %v", err)
			}
			for k, v := range tt.wantHeader {
				if got := r.Header.Get(k); got != v {
					t.Errorf("header %s = %q, want %q", k, got, v)
				}
			}
			if tt.wantQuery != "" && r.URL.RawQuery != tt.wantQuery {
				t.Errorf("query = %q, want %q", r.URL.RawQuery, tt.wantQuery)
			}
		})
	}
}

var errAny = errors.New("any error")
