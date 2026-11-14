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
// the active body type's fields and the active auth type's fields. Disabled
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
		rr.field("body", &out.Body.Raw)
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
