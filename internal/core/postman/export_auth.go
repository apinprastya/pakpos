package postman

import (
	"encoding/json"
	"strings"

	"pakpos/internal/core/model"
)

// auth writes an auth block (the reverse of convertAuth). Settings Postman
// lacks are dropped with a warning.
func (e *exporter) auth(where string, a model.Auth) *xAuth {
	str := func(k, v string) xParam { return xParam{Key: k, Value: v, Type: "string"} }
	boolean := func(k string, v bool) xParam { return xParam{Key: k, Value: v, Type: "boolean"} }
	// Params whose value is empty are left out, as Postman does.
	params := func(ps ...xParam) []xParam {
		out := []xParam{}
		for _, p := range ps {
			if s, ok := p.Value.(string); ok && s == "" {
				continue
			}
			out = append(out, p)
		}
		return out
	}
	switch a.Type {
	case model.AuthBasic:
		return &xAuth{Type: "basic", Params: params(str("username", a.Username), str("password", a.Password))}
	case model.AuthBearer:
		return &xAuth{Type: "bearer", Params: params(str("token", a.Token))}
	case model.AuthAPIKey:
		in := "header"
		if a.APIIn == model.APIKeyInQuery {
			in = "query"
		}
		return &xAuth{Type: "apikey", Params: params(str("key", a.APIKey), str("value", a.APIValue), str("in", in))}
	case model.AuthDigest:
		d := deref(a.Digest)
		alg := d.Algorithm
		if alg == "" {
			alg = "MD5"
		}
		return &xAuth{Type: "digest", Params: params(
			str("username", d.Username), str("password", d.Password), str("algorithm", alg), str("qop", d.Qop))}
	case model.AuthAWSV4:
		s := deref(a.AWSV4)
		if s.UnsignedPayload {
			e.warn(where, "Postman always signs the AWS payload, so \"Unsigned payload\" wasn't exported.")
		}
		return &xAuth{Type: "awsv4", Params: params(
			str("accessKey", s.AccessKey), str("secretKey", s.SecretKey), str("sessionToken", s.SessionToken),
			str("region", s.Region), str("service", s.Service))}
	case model.AuthHawk:
		h := deref(a.Hawk)
		alg := h.Algorithm
		if alg == "" {
			alg = "sha256"
		}
		return &xAuth{Type: "hawk", Params: params(
			str("authId", h.ID), str("authKey", h.Key), str("algorithm", alg), str("extraData", h.Ext),
			str("app", h.App), str("delegation", h.Dlg), boolean("includePayloadHash", h.PayloadHash))}
	case model.AuthNTLM:
		n := deref(a.NTLM)
		return &xAuth{Type: "ntlm", Params: params(
			str("username", n.Username), str("password", n.Password), str("domain", n.Domain), str("workstation", n.Workstation))}
	case model.AuthJWT:
		return &xAuth{Type: "jwt", Params: params(e.jwt(where, deref(a.JWT))...)}
	case model.AuthOAuth2:
		return &xAuth{Type: "oauth2", Params: params(e.oauth2(where, deref(a.OAuth2))...)}
	}
	return &xAuth{Type: "noauth"}
}

func deref[T any](p *T) T {
	if p == nil {
		var zero T
		return zero
	}
	return *p
}

func (e *exporter) jwt(where string, j model.JWT) []xParam {
	if !j.DisableIssuedAt || j.LifetimeSeconds > 0 || j.AddJTI {
		e.warn(where, "Postman sends the JWT payload as written: add the iat, exp and jti claims Pakpos generates to the payload in Postman.")
	}
	alg := j.Algorithm
	if alg == "" {
		alg = "HS256"
	}
	addTo := "header"
	if j.Placement == model.PlaceQuery {
		addTo = "queryParam"
	}
	header, payload := j.Header, j.Payload
	if strings.TrimSpace(header) == "" {
		header = "{}"
	}
	if strings.TrimSpace(payload) == "" {
		payload = "{}"
	}
	return []xParam{
		{Key: "algorithm", Value: alg, Type: "string"},
		{Key: "secret", Value: j.Secret, Type: "string"},
		{Key: "isSecretBase64Encoded", Value: j.SecretBase64, Type: "boolean"},
		{Key: "header", Value: header, Type: "string"},
		{Key: "payload", Value: payload, Type: "string"},
		{Key: "addTokenTo", Value: addTo, Type: "string"},
		{Key: "headerPrefix", Value: j.HeaderPrefix, Type: "string"},
		{Key: "queryParamKey", Value: j.QueryParam, Type: "string"},
	}
}

// grantTypes maps Pakpos grants to Postman's grant_type (authorization code
// with PKCE is decided separately).
var grantTypes = map[model.OAuth2Grant]string{
	model.GrantAuthorizationCode: "authorization_code",
	model.GrantImplicit:          "implicit",
	model.GrantPassword:          "password_credentials",
	model.GrantClientCredentials: "client_credentials",
}

type xExtraParam struct {
	Key     string `json:"key"`
	Value   string `json:"value"`
	Enabled bool   `json:"enabled"`
	SendAs  string `json:"send_as"`
}

func (e *exporter) oauth2(where string, o model.OAuth2) []xParam {
	str := func(k, v string) xParam { return xParam{Key: k, Value: v, Type: "string"} }
	grant := o.Grant
	if grant == "" {
		grant = model.GrantAuthorizationCode
	}
	out := []xParam{}
	gt := grantTypes[grant]
	if grant == model.GrantAuthorizationCode && !o.DisablePKCE {
		gt = "authorization_code_with_pkce"
		method := o.PKCEMethod
		if method == "" {
			method = model.PKCES256
		}
		out = append(out, str("challengeAlgorithm", method))
	}
	clientAuth := "header"
	if o.ClientAuth == model.ClientAuthBody {
		clientAuth = "body"
	}
	addTo := "header"
	if o.Placement == model.PlaceQuery {
		addTo = "queryParams"
	}
	out = append(out,
		str("grant_type", gt),
		str("authUrl", o.AuthURL),
		str("accessTokenUrl", o.TokenURL),
		str("redirect_uri", o.RedirectURL),
		str("clientId", o.ClientID),
		str("clientSecret", o.ClientSecret),
		str("scope", o.Scope),
		str("username", o.Username),
		str("password", o.Password),
		str("client_authentication", clientAuth),
		str("addTokenTo", addTo),
		str("headerPrefix", o.HeaderPrefix),
	)
	if o.RedirectURL != "" {
		out = append(out, xParam{Key: "useBrowser", Value: false, Type: "boolean"})
	}
	if o.Placement == model.PlaceQuery && o.QueryParam != "" && o.QueryParam != "access_token" {
		e.warn(where, "Postman adds the OAuth 2.0 token as the access_token query parameter, not %q.", o.QueryParam)
	}
	if len(o.ExtraParams) > 0 {
		token := extraParamsJSON(o.ExtraParams, "body")
		out = append(out, xParam{Key: "tokenRequestParams", Value: token, Type: "any"})
		if grant == model.GrantAuthorizationCode || grant == model.GrantImplicit {
			out = append(out, xParam{Key: "authRequestParams", Value: extraParamsJSON(o.ExtraParams, "query"), Type: "any"})
		}
	}
	return out
}

func extraParamsJSON(rows []model.KeyValue, sendAs string) json.RawMessage {
	list := make([]xExtraParam, 0, len(rows))
	for _, r := range rows {
		list = append(list, xExtraParam{Key: r.Key, Value: r.Value, Enabled: r.Enabled, SendAs: sendAs})
	}
	b, err := marshalPlain(list)
	if err != nil {
		return json.RawMessage("[]")
	}
	return b
}
