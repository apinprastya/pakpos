package postman

import (
	"encoding/json"
	"net/http"
	"net/url"
	"strings"

	"pakpos/internal/core/model"
	"pakpos/internal/core/urlx"
)

// convertURL returns the URL as typed, its query rows and its path params.
// Postman keeps disabled query params only in url.query, so when that list
// is there it is the source of the rows and the URL's query is rebuilt from
// the enabled ones (Pakpos's URL mirrors the enabled rows).
func convertURL(u pmURL) (raw string, query, params []model.KeyValue) {
	raw = strings.TrimSpace(string(u.Raw))
	if raw == "" {
		raw = buildURL(u)
	}
	if u.Query != nil {
		query = []model.KeyValue{}
		for _, q := range u.Query {
			if q.Key == "" && q.Value == "" {
				continue
			}
			query = append(query, model.KeyValue{
				Key: unescape(string(q.Key)), Value: unescape(string(q.Value)), Enabled: !bool(q.Disabled),
			})
		}
		raw = urlx.WithQuery(raw, query)
	} else {
		query = urlx.QueryFromURL(raw)
	}
	vars := make([]model.KeyValue, 0, len(u.Variable))
	for _, v := range u.Variable {
		vars = append(vars, model.KeyValue{Key: string(v.Key), Value: string(v.Value), Enabled: true})
	}
	return raw, query, urlx.SyncPathParams(raw, vars)
}

// buildURL writes a URL object that has no raw text.
func buildURL(u pmURL) string {
	out := u.Host.join(".")
	if p := strings.TrimSuffix(string(u.Protocol), "://"); p != "" {
		out = p + "://" + out
	}
	if u.Port != "" {
		out += ":" + string(u.Port)
	}
	if path := u.Path.join("/"); path != "" {
		if !strings.HasPrefix(path, "/") {
			out += "/"
		}
		out += path
	}
	if q := urlx.BuildQuery(keyValues(u.Query)); q != "" {
		out += "?" + q
	}
	if u.Hash != "" {
		out += "#" + string(u.Hash)
	}
	return out
}

func unescape(s string) string {
	if d, err := url.QueryUnescape(s); err == nil {
		return d
	}
	return s
}

var rawLanguages = map[string]model.RawLanguage{
	"json":       model.LangJSON,
	"xml":        model.LangXML,
	"html":       model.LangHTML,
	"javascript": model.LangJavaScript,
	"text":       model.LangText,
}

func (c *converter) body(where string, pb pmBody, headers []model.KeyValue) model.Body {
	var b model.Body
	switch strings.ToLower(string(pb.Mode)) {
	case "", "none":
		b = model.Body{Type: model.BodyNone}
	case "raw":
		lang := model.RawLanguage("")
		if pb.Options != nil && pb.Options.Raw != nil {
			lang = rawLanguages[strings.ToLower(string(pb.Options.Raw.Language))]
		}
		if lang == "" {
			lang = languageOf(headerValue(headers, "Content-Type"))
		}
		b = model.Body{Type: model.BodyRaw, Raw: string(pb.Raw), Language: lang}
		if pb.Raw == "" {
			b.Type = model.BodyNone
		}
	case "urlencoded":
		b = model.Body{Type: model.BodyURLEncoded, URLEncoded: keyValues(pb.URLEncoded)}
	case "formdata":
		b = model.Body{Type: model.BodyFormData, FormData: c.formData(where, pb.FormData)}
	case "file":
		b = model.Body{Type: model.BodyBinary}
		if pb.File != nil {
			b.BinaryPath = string(pb.File.Src)
		}
		if b.BinaryPath != "" {
			c.files = append(c.files, where)
		}
	case "graphql":
		b = model.Body{Type: model.BodyRaw, Language: model.LangJSON}
		if pb.GraphQL != nil {
			b.Raw = graphQLBody(string(pb.GraphQL.Query), string(pb.GraphQL.Variables))
		}
		c.warn(where, "The GraphQL body was imported as a JSON body with the query and variables, which is what Postman sends.")
	default:
		b = model.Body{Type: model.BodyNone}
		c.warn(where, "The body type %q isn't supported, so the request was imported without a body.", string(pb.Mode))
	}
	if pb.Disabled {
		b.Type = model.BodyNone
	}
	return b
}

func (c *converter) formData(where string, list []pmFormData) []model.FormField {
	out := []model.FormField{}
	hasFile := false
	for _, f := range list {
		if f.Key == "" && f.Value == "" && len(f.Src) == 0 {
			continue
		}
		field := model.FormField{Key: string(f.Key), ContentType: string(f.ContentType), Enabled: !bool(f.Disabled)}
		if !strings.EqualFold(string(f.Type), "file") {
			field.Kind = model.FormText
			field.Value = string(f.Value)
			out = append(out, field)
			continue
		}
		field.Kind = model.FormFile
		if len(f.Src) == 0 {
			out = append(out, field)
			continue
		}
		hasFile = true
		for _, src := range f.Src {
			ff := field
			ff.FilePath = src
			out = append(out, ff)
		}
	}
	if hasFile {
		c.files = append(c.files, where)
	}
	return out
}

// graphQLBody is the JSON Postman sends for a GraphQL body. Variables that
// aren't valid JSON (e.g. with an unquoted {{variable}}) go in as written.
func graphQLBody(query, variables string) string {
	q, _ := json.Marshal(query)
	v := strings.TrimSpace(variables)
	if v == "" {
		v = "{}"
	}
	return "{\n  \"query\": " + string(q) + ",\n  \"variables\": " + v + "\n}"
}

func headerValue(headers []model.KeyValue, name string) string {
	for _, h := range headers {
		if h.Enabled && strings.EqualFold(strings.TrimSpace(h.Key), name) {
			return h.Value
		}
	}
	return ""
}

// languageOf picks a raw body language from a Content-Type.
func languageOf(contentType string) model.RawLanguage {
	ct := strings.ToLower(contentType)
	switch {
	case strings.Contains(ct, "json"):
		return model.LangJSON
	case strings.Contains(ct, "xml"):
		return model.LangXML
	case strings.Contains(ct, "html"):
		return model.LangHTML
	case strings.Contains(ct, "javascript"):
		return model.LangJavaScript
	default:
		return model.LangText
	}
}

func (c *converter) example(where string, req model.Request, r pmResponse) (Example, bool) {
	name := cleanName(string(r.Name))
	if name == "" {
		name = "Example"
	}
	if len(r.Body) > MaxExampleBody {
		c.warn(where, "The example %q has a body over 1 MB and wasn't imported.", name)
		return Example{}, false
	}
	ex := Example{Name: name, Request: req, StatusCode: r.Code, StatusText: strings.TrimSpace(string(r.Status)), Body: string(r.Body)}
	if r.OriginalRequest != nil {
		// Converted quietly: the item's own request already raised any warning.
		quiet := &converter{opts: c.opts}
		ex.Request = quiet.request(where, *r.OriginalRequest, nil)
		ex.Request.Name = req.Name
	}
	if ex.StatusCode == 0 {
		ex.StatusCode = http.StatusOK
	}
	if ex.StatusText == "" {
		ex.StatusText = http.StatusText(ex.StatusCode)
	}
	ex.Headers = keyValues(r.Header)
	ex.ContentType = headerValue(ex.Headers, "Content-Type")
	ex.Kind = bodyKind(ex.Body, string(r.PreviewLanguage), ex.ContentType)
	return ex, true
}

func bodyKind(body, preview, contentType string) model.BodyKind {
	if body == "" {
		return model.KindEmpty
	}
	switch strings.ToLower(preview) {
	case "json":
		return model.KindJSON
	case "xml":
		return model.KindXML
	case "html":
		return model.KindHTML
	}
	switch languageOf(contentType) {
	case model.LangJSON:
		return model.KindJSON
	case model.LangXML:
		return model.KindXML
	case model.LangHTML:
		return model.KindHTML
	default:
		return model.KindText
	}
}
