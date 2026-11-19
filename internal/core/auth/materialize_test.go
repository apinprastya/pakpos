package auth

import (
	"errors"
	"net/http"
	"reflect"
	"testing"

	"pakpos/internal/core/model"
)

func hdr(k, v string) model.KeyValue { return model.KeyValue{Key: k, Value: v, Enabled: true} }

func TestMaterialize(t *testing.T) {
	user := []model.KeyValue{hdr("Accept", "*/*")}
	tests := []struct {
		name      string
		auth      model.Auth
		headers   []model.KeyValue
		query     []model.KeyValue
		keepBasic bool
		wantAuth  model.AuthType
		wantHdr   []model.KeyValue
		wantQuery []model.KeyValue
		wantErr   error
	}{
		{name: "none", auth: model.Auth{Type: model.AuthNone}, headers: user, wantAuth: model.AuthNone, wantHdr: user},
		{name: "inherit", auth: model.Auth{Type: model.AuthInherit}, wantAuth: model.AuthNone},
		{name: "basic header", auth: model.Auth{Type: model.AuthBasic, Username: "u", Password: "p"}, headers: user,
			wantAuth: model.AuthNone, wantHdr: []model.KeyValue{hdr("Accept", "*/*"), hdr("Authorization", "Basic dTpw")}},
		{name: "basic kept", auth: model.Auth{Type: model.AuthBasic, Username: "u", Password: "{{pw}}", Token: "x"}, keepBasic: true,
			wantAuth: model.AuthBasic},
		{name: "basic loses to user header", auth: model.Auth{Type: model.AuthBasic, Username: "u"}, keepBasic: true,
			headers: []model.KeyValue{hdr("authorization", "Custom x")}, wantAuth: model.AuthNone,
			wantHdr: []model.KeyValue{hdr("authorization", "Custom x")}},
		{name: "bearer default prefix", auth: model.Auth{Type: model.AuthBearer, Token: "t"},
			headers:  []model.KeyValue{{Key: "Authorization", Value: "old"}, hdr("Authorization", "")},
			wantAuth: model.AuthNone, wantHdr: []model.KeyValue{{Key: "Authorization", Value: "old"}, hdr("Authorization", "Bearer t")}},
		{name: "bearer prefix", auth: model.Auth{Type: model.AuthBearer, Token: "t", Prefix: " Token "},
			wantAuth: model.AuthNone, wantHdr: []model.KeyValue{hdr("Authorization", "Token t")}},
		{name: "bearer without token", auth: model.Auth{Type: model.AuthBearer}, wantAuth: model.AuthNone},
		{name: "bearer loses to user header", auth: model.Auth{Type: model.AuthBearer, Token: "t"},
			headers: []model.KeyValue{hdr("Authorization", "x")}, wantAuth: model.AuthNone, wantHdr: []model.KeyValue{hdr("Authorization", "x")}},
		{name: "api key header", auth: model.Auth{Type: model.AuthAPIKey, APIKey: " X-Key ", APIValue: "v"},
			wantAuth: model.AuthNone, wantHdr: []model.KeyValue{hdr("X-Key", "v")}},
		{name: "api key header loses", auth: model.Auth{Type: model.AuthAPIKey, APIKey: "X-Key", APIValue: "v"},
			headers: []model.KeyValue{hdr("x-key", "mine")}, wantAuth: model.AuthNone, wantHdr: []model.KeyValue{hdr("x-key", "mine")}},
		{name: "api key query", auth: model.Auth{Type: model.AuthAPIKey, APIKey: "key", APIValue: "v", APIIn: model.APIKeyInQuery},
			query: []model.KeyValue{hdr("a", "1")}, wantAuth: model.AuthNone, wantQuery: []model.KeyValue{hdr("a", "1"), hdr("key", "v")}},
		{name: "api key query loses", auth: model.Auth{Type: model.AuthAPIKey, APIKey: "key", APIValue: "v", APIIn: model.APIKeyInQuery},
			query: []model.KeyValue{hdr("key", "mine")}, wantAuth: model.AuthNone, wantQuery: []model.KeyValue{hdr("key", "mine")}},
		{name: "api key without name", auth: model.Auth{Type: model.AuthAPIKey}, wantAuth: model.AuthNone, wantErr: ErrMissingAPIKeyName},
		{name: "api key bad location", auth: model.Auth{Type: model.AuthAPIKey, APIKey: "k", APIIn: "cookie"}, wantAuth: model.AuthNone, wantErr: errAny},
		{name: "unknown type", auth: model.Auth{Type: "kerberos"}, wantAuth: model.AuthNone, wantErr: errAny},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			in := model.Request{Headers: tt.headers, Query: tt.query, Auth: tt.auth}
			got, err := Materialize(in, tt.keepBasic)
			if tt.wantErr == errAny {
				if err == nil {
					t.Fatal("want an error")
				}
			} else if !errors.Is(err, tt.wantErr) {
				t.Fatalf("err = %v, want %v", err, tt.wantErr)
			}
			if got.Auth.Type != tt.wantAuth {
				t.Errorf("auth = %q, want %q", got.Auth.Type, tt.wantAuth)
			}
			if tt.wantAuth == model.AuthBasic && (got.Auth.Username != "u" || got.Auth.Password != "{{pw}}" || got.Auth.Token != "") {
				t.Errorf("basic auth = %+v", got.Auth)
			}
			if err == nil && !reflect.DeepEqual(got.Headers, tt.wantHdr) {
				t.Errorf("headers = %+v, want %+v", got.Headers, tt.wantHdr)
			}
			if err == nil && !reflect.DeepEqual(got.Query, tt.wantQuery) {
				t.Errorf("query = %+v, want %+v", got.Query, tt.wantQuery)
			}
		})
	}
}

func TestTokenAuth(t *testing.T) {
	tests := []struct {
		name string
		o    *model.OAuth2
		want model.Auth
	}{
		{"nil settings", nil, model.Auth{Type: model.AuthBearer, Token: "t", Prefix: "Bearer"}},
		{"header default", &model.OAuth2{}, model.Auth{Type: model.AuthBearer, Token: "t", Prefix: "Bearer"}},
		{"header prefix", &model.OAuth2{HeaderPrefix: " Token "}, model.Auth{Type: model.AuthBearer, Token: "t", Prefix: "Token"}},
		{"query default", &model.OAuth2{Placement: model.PlaceQuery}, model.Auth{Type: model.AuthAPIKey, APIKey: "access_token", APIValue: "t", APIIn: model.APIKeyInQuery}},
		{"query name", &model.OAuth2{Placement: model.PlaceQuery, QueryParam: "tok"}, model.Auth{Type: model.AuthAPIKey, APIKey: "tok", APIValue: "t", APIIn: model.APIKeyInQuery}},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if got := TokenAuth(tt.o, "t"); got != tt.want {
				t.Errorf("got %+v", got)
			}
		})
	}
}

func TestMaterializeOAuth2(t *testing.T) {
	req := model.Request{Auth: model.Auth{Type: model.AuthOAuth2, OAuth2: &model.OAuth2{HeaderPrefix: "Token"}}}
	out, err := Materialize(req, true)
	if err != nil || len(out.Headers) != 1 || out.Headers[0].Value != "Token {{oauth2AccessToken}}" || out.Auth.Type != model.AuthNone {
		t.Fatalf("header: %+v %v", out, err)
	}
	req.Auth.OAuth2 = &model.OAuth2{Placement: model.PlaceQuery}
	out, err = Materialize(req, true)
	if err != nil || len(out.Query) != 1 || out.Query[0].Key != "access_token" || out.Query[0].Value != TokenPlaceholder {
		t.Fatalf("query: %+v %v", out, err)
	}
	r := &http.Request{Header: http.Header{}}
	if err := Apply(r, req.Auth); !errors.Is(err, ErrOAuth2Token) {
		t.Errorf("Apply must refuse an OAuth 2.0 auth without a token: %v", err)
	}
}
