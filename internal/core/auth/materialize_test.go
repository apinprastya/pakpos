package auth

import (
	"errors"
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
		{name: "unknown type", auth: model.Auth{Type: "digest"}, wantAuth: model.AuthNone, wantErr: errAny},
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
