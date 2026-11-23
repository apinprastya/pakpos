package postman

import (
	"encoding/json"
	"strings"

	"pakpos/internal/core/model"
)

// authNames are Postman's names for the auth types Pakpos doesn't have.
var authNames = map[string]string{
	"oauth1":   "OAuth 1.0",
	"akamai":   "Akamai EdgeGrid",
	"edgegrid": "Akamai EdgeGrid",
	"asap":     "ASAP (Atlassian)",
}

// auth converts an auth block. A missing block inherits when canInherit
// (folders and requests); otherwise it is none. Credentials written as
// plain text (not {{variables}}) are noted for a warning.
func (c *converter) auth(where string, a *pmAuth, canInherit bool) model.Auth {
	out := c.convertAuth(where, a, canInherit)
	if plainCredential(out) {
		c.plainCreds = append(c.plainCreds, whereOrRoot(where))
	}
	return out
}

// plainCredential reports whether a credential field of a holds a literal
// value rather than a {{variable}} reference.
func plainCredential(a model.Auth) bool {
	var fields []string
	switch a.Type {
	case model.AuthBasic:
		fields = []string{a.Password}
	case model.AuthBearer:
		fields = []string{a.Token}
	case model.AuthAPIKey:
		fields = []string{a.APIValue}
	case model.AuthDigest:
		fields = []string{a.Digest.Password}
	case model.AuthAWSV4:
		fields = []string{a.AWSV4.SecretKey, a.AWSV4.SessionToken}
	case model.AuthJWT:
		fields = []string{a.JWT.Secret}
	case model.AuthHawk:
		fields = []string{a.Hawk.Key}
	case model.AuthNTLM:
		fields = []string{a.NTLM.Password}
	case model.AuthOAuth2:
		fields = []string{a.OAuth2.ClientSecret, a.OAuth2.Password}
	}
	for _, f := range fields {
		if strings.TrimSpace(f) != "" && !strings.Contains(f, "{{") {
			return true
		}
	}
	return false
}

func whereOrRoot(where string) string {
	if where == "" {
		return "the collection"
	}
	return where
}

func (c *converter) convertAuth(where string, a *pmAuth, canInherit bool) model.Auth {
	none := model.Auth{Type: model.AuthNone}
	if a == nil || a.Type == "" || a.Type == "inherit" {
		if canInherit {
			return model.Auth{Type: model.AuthInherit}
		}
		return none
	}
	p := a.Params
	switch a.Type {
	case "noauth":
		return none
	case "basic":
		return model.Auth{Type: model.AuthBasic, Username: p["username"], Password: p["password"]}
	case "bearer":
		return model.Auth{Type: model.AuthBearer, Token: p["token"]}
	case "apikey":
		in := model.APIKeyInHeader
		if strings.EqualFold(p["in"], "query") {
			in = model.APIKeyInQuery
		}
		return model.Auth{Type: model.AuthAPIKey, APIKey: p["key"], APIValue: p["value"], APIIn: in}
	case "digest":
		d := &model.Digest{Username: p["username"], Password: p["password"]}
		switch alg := strings.ToUpper(p["algorithm"]); alg {
		case "MD5", "MD5-SESS", "SHA-256", "SHA-256-SESS":
			d.Algorithm = strings.Replace(alg, "-SESS", "-sess", 1)
		}
		if strings.EqualFold(p["qop"], "auth-int") {
			d.Qop = "auth-int"
		}
		return model.Auth{Type: model.AuthDigest, Digest: d}
	case "awsv4":
		return model.Auth{Type: model.AuthAWSV4, AWSV4: &model.AWSV4{
			AccessKey: p["accessKey"], SecretKey: p["secretKey"], SessionToken: p["sessionToken"],
			Region: p["region"], Service: p["service"],
		}}
	case "hawk":
		return model.Auth{Type: model.AuthHawk, Hawk: &model.Hawk{
			ID: p["authId"], Key: p["authKey"], Algorithm: strings.ToLower(p["algorithm"]),
			Ext: p["extraData"], App: p["app"], Dlg: p["delegation"], PayloadHash: isTrue(p["includePayloadHash"]),
		}}
	case "ntlm":
		return model.Auth{Type: model.AuthNTLM, NTLM: &model.NTLM{
			Username: p["username"], Password: p["password"], Domain: p["domain"], Workstation: p["workstation"],
		}}
	case "jwt":
		j := &model.JWT{
			Algorithm: strings.ToUpper(p["algorithm"]), Secret: p["secret"], SecretBase64: isTrue(p["isSecretBase64Encoded"]),
			Header: emptyObject(p["header"]), Payload: emptyObject(p["payload"]),
			HeaderPrefix: p["headerPrefix"], QueryParam: p["queryParamKey"],
		}
		if strings.EqualFold(p["algorithm"], "eddsa") {
			j.Algorithm = "EdDSA"
		}
		if strings.HasPrefix(strings.ToLower(p["addTokenTo"]), "query") {
			j.Placement = model.PlaceQuery
		}
		return model.Auth{Type: model.AuthJWT, JWT: j}
	case "oauth2":
		return model.Auth{Type: model.AuthOAuth2, OAuth2: c.oauth2(where, p)}
	}
	name := authNames[a.Type]
	if name == "" {
		name = a.Type
	}
	c.warn(where, "%s auth isn't supported in Pakpos, so it was imported without auth.", name)
	return none
}

func (c *converter) oauth2(where string, p map[string]string) *model.OAuth2 {
	o := &model.OAuth2{
		AuthURL: p["authUrl"], TokenURL: p["accessTokenUrl"], ClientID: p["clientId"], ClientSecret: p["clientSecret"],
		Scope: p["scope"], Username: p["username"], Password: p["password"], HeaderPrefix: p["headerPrefix"],
	}
	switch p["grant_type"] {
	case "authorization_code":
		o.Grant = model.GrantAuthorizationCode
		o.DisablePKCE = true
	case "authorization_code_with_pkce":
		o.Grant = model.GrantAuthorizationCode
		if strings.EqualFold(p["challengeAlgorithm"], "plain") {
			o.PKCEMethod = model.PKCEPlain
		}
	case "implicit":
		o.Grant = model.GrantImplicit
	case "password_credentials":
		o.Grant = model.GrantPassword
	case "client_credentials":
		o.Grant = model.GrantClientCredentials
	default:
		o.Grant = model.GrantAuthorizationCode
	}
	if strings.EqualFold(p["client_authentication"], "body") {
		o.ClientAuth = model.ClientAuthBody
	}
	if strings.HasPrefix(strings.ToLower(p["addTokenTo"]), "query") {
		o.Placement = model.PlaceQuery
	}
	if o.Grant == model.GrantAuthorizationCode || o.Grant == model.GrantImplicit {
		redirect := strings.TrimSpace(p["redirect_uri"])
		lower := strings.ToLower(redirect)
		switch {
		case strings.HasPrefix(lower, "http://127.0.0.1:"), strings.HasPrefix(lower, "http://localhost:"):
			o.RedirectURL = redirect
		case redirect != "" && !isTrue(p["useBrowser"]):
			c.warn(where, "The OAuth 2.0 callback URL %s can't be used: Pakpos receives the code on a local address (http://127.0.0.1). Register that callback with the provider, or set one in the Auth tab.", redirect)
		}
	}
	o.ExtraParams = extraParams(p["authRequestParams"], p["tokenRequestParams"])
	if strings.TrimSpace(p["accessToken"]) != "" {
		c.warn(where, "The OAuth 2.0 access token in the export wasn't imported. Get a new token in the Auth tab.")
	}
	return o
}

// extraParams reads Postman's authRequestParams and tokenRequestParams
// (JSON lists of {key, value, enabled}); Pakpos sends one list with both.
func extraParams(lists ...string) []model.KeyValue {
	var out []model.KeyValue
	seen := map[string]bool{}
	for _, l := range lists {
		var rows []struct {
			Key     text  `json:"key"`
			Value   text  `json:"value"`
			Enabled *flag `json:"enabled"`
		}
		if strings.TrimSpace(l) == "" || json.Unmarshal([]byte(l), &rows) != nil {
			continue
		}
		for _, r := range rows {
			if r.Key == "" || seen[string(r.Key)] {
				continue
			}
			seen[string(r.Key)] = true
			out = append(out, model.KeyValue{Key: string(r.Key), Value: string(r.Value), Enabled: r.Enabled == nil || bool(*r.Enabled)})
		}
	}
	return out
}

func isTrue(s string) bool { return strings.EqualFold(strings.TrimSpace(s), "true") }

// emptyObject drops an empty JSON object, which Pakpos writes as "".
func emptyObject(s string) string {
	if strings.TrimSpace(s) == "{}" {
		return ""
	}
	return s
}
