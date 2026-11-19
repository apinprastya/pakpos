package vars

import (
	"fmt"
	"sort"

	"pakpos/internal/core/model"
)

// ResolveRequest is a shortcut for New(scopes, opts...).ResolveRequest(req).
func ResolveRequest(req model.Request, scopes []Scope, opts ...Option) (model.Request, []string, error) {
	return New(scopes, opts...).ResolveRequest(req)
}

// ResolveRequest returns a copy of req with references resolved in every
// field that is sent: the URL, path param values, query and header rows,
// the active body type's fields and the active auth type's fields. In a raw
// JSON body, values inside string literals are JSON-escaped (see
// ResolveJSON); query rows and urlencoded fields are left as plain text
// because httpexec encodes them when it builds the request. Disabled
// rows and inactive body/auth fields are copied unchanged and their
// references are not reported. req itself is never modified.
//
// The second result lists the unresolved names, sorted and deduplicated.
func (r *Resolver) ResolveRequest(req model.Request) (model.Request, []string, error) {
	out := req
	out.PathParams = cloneKV(req.PathParams)
	out.Query = cloneKV(req.Query)
	out.Headers = cloneKV(req.Headers)
	out.Body.URLEncoded = cloneKV(req.Body.URLEncoded)
	if req.Body.FormData != nil {
		out.Body.FormData = append([]model.FormField{}, req.Body.FormData...)
	}

	rr := requestResolver{r: r, unresolved: map[string]struct{}{}}
	rr.field("URL", &out.URL)
	for i := range out.PathParams {
		if p := &out.PathParams[i]; p.Enabled {
			rr.field("path param "+p.Key, &p.Value)
		}
	}
	rr.rows("query param", out.Query)
	rr.rows("header", out.Headers)

	switch out.Body.Type {
	case model.BodyRaw:
		if out.Body.Language == model.LangJSON {
			rr.jsonField("body", &out.Body.Raw)
		} else {
			rr.field("body", &out.Body.Raw)
		}
	case model.BodyURLEncoded:
		rr.rows("form field", out.Body.URLEncoded)
	case model.BodyFormData:
		for i := range out.Body.FormData {
			f := &out.Body.FormData[i]
			if !f.Enabled {
				continue
			}
			ctx := "form field " + f.Key
			rr.field(ctx, &f.Key)
			if f.Kind == model.FormFile {
				rr.field(ctx+" file", &f.FilePath)
			} else {
				rr.field(ctx, &f.Value)
			}
			rr.field(ctx+" content type", &f.ContentType)
		}
	case model.BodyBinary:
		rr.field("body file", &out.Body.BinaryPath)
	}

	a := &out.Auth
	switch a.Type {
	case model.AuthBasic:
		rr.field("auth username", &a.Username)
		rr.field("auth password", &a.Password)
	case model.AuthBearer:
		rr.field("auth token", &a.Token)
		rr.field("auth prefix", &a.Prefix)
	case model.AuthAPIKey:
		rr.field("API key name", &a.APIKey)
		rr.field("API key value", &a.APIValue)
	case model.AuthOAuth2:
		if a.OAuth2 != nil {
			o := *a.OAuth2
			o.ExtraParams = cloneKV(o.ExtraParams)
			rr.oauth2(&o)
			a.OAuth2 = &o
		}
	case model.AuthDigest:
		if a.Digest != nil {
			d := *a.Digest
			rr.fields("Digest", map[string]*string{"username": &d.Username, "password": &d.Password})
			a.Digest = &d
		}
	case model.AuthAWSV4:
		if a.AWSV4 != nil {
			w := *a.AWSV4
			rr.fields("AWS", map[string]*string{"access key": &w.AccessKey, "secret key": &w.SecretKey,
				"session token": &w.SessionToken, "region": &w.Region, "service": &w.Service})
			a.AWSV4 = &w
		}
	case model.AuthJWT:
		if a.JWT != nil {
			j := *a.JWT
			rr.fields("JWT", map[string]*string{"secret": &j.Secret, "header prefix": &j.HeaderPrefix, "query parameter": &j.QueryParam})
			rr.jsonField("JWT header", &j.Header)
			rr.jsonField("JWT payload", &j.Payload)
			a.JWT = &j
		}
	case model.AuthHawk:
		if a.Hawk != nil {
			h := *a.Hawk
			rr.fields("Hawk", map[string]*string{"ID": &h.ID, "key": &h.Key, "ext": &h.Ext, "app": &h.App, "dlg": &h.Dlg})
			a.Hawk = &h
		}
	case model.AuthNTLM:
		if a.NTLM != nil {
			n := *a.NTLM
			rr.fields("NTLM", map[string]*string{"username": &n.Username, "password": &n.Password,
				"domain": &n.Domain, "workstation": &n.Workstation})
			a.NTLM = &n
		}
	}

	if rr.err != nil {
		return model.Request{}, nil, rr.err
	}
	names := make([]string, 0, len(rr.unresolved))
	for n := range rr.unresolved {
		names = append(names, n)
	}
	sort.Strings(names)
	return out, names, nil
}

// oauth2 resolves the OAuth 2.0 settings that reach the authorization
// server or the request (not the enums, which are never variables).
func (rr *requestResolver) oauth2(o *model.OAuth2) {
	for _, f := range []struct {
		what string
		p    *string
	}{
		{"OAuth 2.0 auth URL", &o.AuthURL},
		{"OAuth 2.0 token URL", &o.TokenURL},
		{"OAuth 2.0 callback URL", &o.RedirectURL},
		{"OAuth 2.0 client ID", &o.ClientID},
		{"OAuth 2.0 client secret", &o.ClientSecret},
		{"OAuth 2.0 scope", &o.Scope},
		{"OAuth 2.0 username", &o.Username},
		{"OAuth 2.0 password", &o.Password},
		{"OAuth 2.0 header prefix", &o.HeaderPrefix},
		{"OAuth 2.0 query parameter", &o.QueryParam},
	} {
		rr.field(f.what, f.p)
	}
	rr.rows("OAuth 2.0 parameter", o.ExtraParams)
}

// fields resolves named fields of an auth type, in name order so the first
// error reported doesn't depend on map order.
func (rr *requestResolver) fields(kind string, fs map[string]*string) {
	names := make([]string, 0, len(fs))
	for n := range fs {
		names = append(names, n)
	}
	sort.Strings(names)
	for _, n := range names {
		rr.field(kind+" "+n, fs[n])
	}
}

// requestResolver resolves fields in place, keeping the first error.
type requestResolver struct {
	r          *Resolver
	unresolved map[string]struct{}
	err        error
}

func (rr *requestResolver) field(what string, s *string) {
	if rr.err != nil {
		return
	}
	v, err := rr.r.expand(*s, nil, rr.unresolved)
	if err != nil {
		rr.err = fmt.Errorf("resolve %s: %w", what, err)
		return
	}
	*s = v
}

func (rr *requestResolver) jsonField(what string, s *string) {
	if rr.err != nil {
		return
	}
	v, err := rr.r.expandJSON(*s, rr.unresolved)
	if err != nil {
		rr.err = fmt.Errorf("resolve %s: %w", what, err)
		return
	}
	*s = v
}

func (rr *requestResolver) rows(what string, rows []model.KeyValue) {
	for i := range rows {
		kv := &rows[i]
		if !kv.Enabled {
			continue
		}
		ctx := what + " " + kv.Key
		rr.field(ctx, &kv.Key)
		rr.field(ctx, &kv.Value)
	}
}

func cloneKV(in []model.KeyValue) []model.KeyValue {
	if in == nil {
		return nil
	}
	return append([]model.KeyValue{}, in...)
}
