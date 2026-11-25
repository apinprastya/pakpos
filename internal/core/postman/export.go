package postman

import (
	"bytes"
	"encoding/json"
	"fmt"
	"strings"

	"pakpos/internal/core/inherit"
	"pakpos/internal/core/model"
)

// SchemaV21 is the schema URL written into exported collections.
const SchemaV21 = "https://schema.getpostman.com/json/collection/v2.1.0/collection.json"

// ExportedUsing is written into environment and globals exports.
const ExportedUsing = "Pakpos"

// Export writes f as a Postman export: a collection in the v2.1 format, or
// an environment or globals file. Secret variables are written with an
// empty value (Pakpos never exports secret values); a warning lists them.
// The returned warnings say what won't work in Postman as it does in
// Pakpos; they are never nil. Output is deterministic (no ids, no dates).
func Export(f File) ([]byte, []Warning, error) {
	e := &exporter{warnings: []Warning{}}
	var doc any
	switch f.Kind {
	case KindCollection:
		if f.Collection == nil {
			return nil, nil, fmt.Errorf("export collection %q: no content", f.Name)
		}
		doc = e.collection(f.Name, *f.Collection)
	case KindEnvironment, KindGlobals:
		doc = e.variableFile(f.Kind, f.Name, f.Variables)
	default:
		return nil, nil, fmt.Errorf("export: unknown kind %q", f.Kind)
	}
	e.finish()
	var buf bytes.Buffer
	enc := json.NewEncoder(&buf)
	enc.SetEscapeHTML(false)
	enc.SetIndent("", "\t")
	if err := enc.Encode(doc); err != nil {
		return nil, nil, fmt.Errorf("export %q: %w", f.Name, err)
	}
	return buf.Bytes(), e.warnings, nil
}

type exporter struct {
	warnings []Warning
	// secrets lists secret variables written without their value.
	secrets []string
	// files lists requests whose bodies point at local files.
	files []string
	// headers is set when collection or folder headers were copied into requests.
	headers bool
	// timeouts lists requests with their own timeout.
	timeouts []string
}

func (e *exporter) warn(where, format string, args ...any) {
	e.warnings = append(e.warnings, Warning{Where: where, Message: fmt.Sprintf(format, args...)})
}

func (e *exporter) finish() {
	if e.headers {
		e.warn("", "Postman has no headers on collections or folders, so they were copied into each request below them.")
	}
	if len(e.secrets) > 0 {
		e.warn("", "Secret values aren't exported: %s. Set them in Postman after importing.", listSome(e.secrets, 5))
	}
	if len(e.files) > 0 {
		e.warn("", "%s send files from this computer. Pick the files again in Postman: %s.",
			plural(len(e.files), "request", "requests"), listSome(e.files, 5))
	}
	if len(e.timeouts) > 0 {
		e.warn("", "Postman has no per-request timeout, so these use Postman's own setting: %s.", listSome(e.timeouts, 5))
	}
}

/* ---------- JSON shapes ---------- */

type xCollection struct {
	Info     xInfo       `json:"info"`
	Item     []xItem     `json:"item"`
	Auth     *xAuth      `json:"auth,omitempty"`
	Event    []xEvent    `json:"event,omitempty"`
	Variable []xVariable `json:"variable,omitempty"`
}

type xInfo struct {
	Name   string `json:"name"`
	Schema string `json:"schema"`
}

// xItem is a folder (Item set) or a request (Request set).
type xItem struct {
	Name     string      `json:"name"`
	Item     *[]xItem    `json:"item,omitempty"`
	Auth     *xAuth      `json:"auth,omitempty"`
	Event    []xEvent    `json:"event,omitempty"`
	Behavior *xBehavior  `json:"protocolProfileBehavior,omitempty"`
	Request  *xRequest   `json:"request,omitempty"`
	Response *[]xExample `json:"response,omitempty"`
}

type xBehavior struct {
	FollowRedirects *bool `json:"followRedirects,omitempty"`
	MaxRedirects    *int  `json:"maxRedirects,omitempty"`
	StrictSSL       *bool `json:"strictSSL,omitempty"`
}

type xRequest struct {
	Auth   *xAuth      `json:"auth,omitempty"`
	Method string      `json:"method"`
	Header []xKeyValue `json:"header"`
	Body   *xBody      `json:"body,omitempty"`
	URL    xURL        `json:"url"`
}

type xKeyValue struct {
	Key         string `json:"key"`
	Value       string `json:"value"`
	Type        string `json:"type,omitempty"`
	Disabled    bool   `json:"disabled,omitempty"`
	ContentType string `json:"contentType,omitempty"`
}

type xFormData struct {
	Key         string `json:"key"`
	Value       string `json:"value,omitempty"`
	Type        string `json:"type"`
	Src         string `json:"src,omitempty"`
	ContentType string `json:"contentType,omitempty"`
	Disabled    bool   `json:"disabled,omitempty"`
}

type xURL struct {
	Raw      string      `json:"raw"`
	Protocol string      `json:"protocol,omitempty"`
	Host     []string    `json:"host,omitempty"`
	Port     string      `json:"port,omitempty"`
	Path     []string    `json:"path,omitempty"`
	Query    []xKeyValue `json:"query,omitempty"`
	Hash     string      `json:"hash,omitempty"`
	Variable []xKeyValue `json:"variable,omitempty"`
}

type xBody struct {
	Mode       string      `json:"mode"`
	Raw        *string     `json:"raw,omitempty"`
	URLEncoded []xKeyValue `json:"urlencoded,omitempty"`
	FormData   []xFormData `json:"formdata,omitempty"`
	File       *xFile      `json:"file,omitempty"`
	Options    *xOptions   `json:"options,omitempty"`
}

type xFile struct {
	Src string `json:"src"`
}

type xOptions struct {
	Raw xRawOptions `json:"raw"`
}

type xRawOptions struct {
	Language string `json:"language"`
}

// xAuth is written in the v2.1 shape: {"type": t, t: [{key, value, type}]}.
type xAuth struct {
	Type   string
	Params []xParam
}

type xParam struct {
	Key   string `json:"key"`
	Value any    `json:"value"`
	Type  string `json:"type"`
}

func (a xAuth) MarshalJSON() ([]byte, error) {
	var buf bytes.Buffer
	buf.WriteString(`{"type":`)
	t, err := json.Marshal(a.Type)
	if err != nil {
		return nil, err
	}
	buf.Write(t)
	if a.Params != nil {
		buf.WriteString(",")
		buf.Write(t)
		buf.WriteString(":")
		p, err := marshalPlain(a.Params)
		if err != nil {
			return nil, err
		}
		buf.Write(p)
	}
	buf.WriteString("}")
	return buf.Bytes(), nil
}

type xEvent struct {
	Listen string  `json:"listen"`
	Script xScript `json:"script"`
}

type xScript struct {
	Type string   `json:"type"`
	Exec []string `json:"exec"`
}

type xVariable struct {
	Key      string `json:"key"`
	Value    string `json:"value"`
	Type     string `json:"type,omitempty"`
	Disabled bool   `json:"disabled,omitempty"`
}

type xExample struct {
	Name            string      `json:"name"`
	OriginalRequest xRequest    `json:"originalRequest"`
	Status          string      `json:"status"`
	Code            int         `json:"code"`
	PreviewLanguage string      `json:"_postman_previewlanguage"`
	Header          []xKeyValue `json:"header"`
	Cookie          []any       `json:"cookie"`
	Body            string      `json:"body"`
}

type xVariableFile struct {
	Name          string         `json:"name"`
	Values        []xEnvVariable `json:"values"`
	Scope         string         `json:"_postman_variable_scope"`
	ExportedUsing string         `json:"_postman_exported_using"`
}

type xEnvVariable struct {
	Key     string `json:"key"`
	Value   string `json:"value"`
	Type    string `json:"type"`
	Enabled bool   `json:"enabled"`
}

// marshalPlain encodes v without escaping <, > and &.
func marshalPlain(v any) ([]byte, error) {
	var buf bytes.Buffer
	enc := json.NewEncoder(&buf)
	enc.SetEscapeHTML(false)
	if err := enc.Encode(v); err != nil {
		return nil, err
	}
	return bytes.TrimRight(buf.Bytes(), "\n"), nil
}

/* ---------- conversion ---------- */

func (e *exporter) collection(name string, c Collection) xCollection {
	out := xCollection{
		Info:     xInfo{Name: name, Schema: SchemaV21},
		Event:    events(c.Scripts),
		Variable: e.collectionVariables(c.Variables),
	}
	if c.Auth.Type != "" && c.Auth.Type != model.AuthNone && c.Auth.Type != model.AuthInherit {
		out.Auth = e.auth("", c.Auth)
	}
	chain := []inherit.Level{{Kind: inherit.KindCollection, Headers: c.Headers}}
	out.Item = e.items("", chain, c.Items)
	return out
}

func (e *exporter) items(parent string, chain []inherit.Level, items []Item) []xItem {
	out := make([]xItem, 0, len(items))
	for _, it := range items {
		if f := it.Folder; f != nil {
			where := join(parent, f.Name)
			next := append(append([]inherit.Level{}, chain...), inherit.Level{Kind: inherit.KindFolder, Headers: f.Headers})
			children := e.items(where, next, f.Items)
			auth := f.Auth
			if auth.Type == "" {
				// A folder without an auth type passes its parent's on (inherit.Effective).
				auth.Type = model.AuthInherit
			}
			out = append(out, xItem{
				Name:  f.Name,
				Item:  &children,
				Auth:  e.itemAuth(where, auth),
				Event: events(f.Scripts),
			})
			continue
		}
		if it.Request == nil {
			continue
		}
		r := it.Request.Request
		where := join(parent, r.Name)
		withHeaders := r
		res := inherit.Effective(chain, r)
		if len(res.Headers) > 0 {
			e.headers = true
			withHeaders.Headers = res.Request.Headers
		}
		req := e.request(where, withHeaders, true)
		examples := make([]xExample, 0, len(it.Request.Examples))
		for _, ex := range it.Request.Examples {
			if x, ok := e.example(where, ex); ok {
				examples = append(examples, x)
			}
		}
		out = append(out, xItem{
			Name:     r.Name,
			Event:    events(r.Scripts),
			Behavior: e.behavior(where, r.Settings),
			Request:  &req,
			Response: &examples,
		})
	}
	return out
}

// itemAuth is a folder's or request's auth: none for inherit (Postman's
// default), noauth for none.
func (e *exporter) itemAuth(where string, a model.Auth) *xAuth {
	if a.Type == model.AuthInherit {
		return nil
	}
	return e.auth(where, a)
}

func (e *exporter) behavior(where string, s model.RequestSettings) *xBehavior {
	if s.TimeoutMs != nil {
		e.timeouts = append(e.timeouts, where)
	}
	if s.FollowRedirects == nil && s.MaxRedirects == nil && s.VerifyTLS == nil {
		return nil
	}
	return &xBehavior{FollowRedirects: s.FollowRedirects, MaxRedirects: s.MaxRedirects, StrictSSL: s.VerifyTLS}
}

// request converts a request; warn is false for an example's request, whose
// warnings the item's own request already raised.
func (e *exporter) request(where string, r model.Request, warn bool) xRequest {
	method := strings.ToUpper(strings.TrimSpace(r.Method))
	if method == "" {
		method = "GET"
	}
	out := xRequest{
		Method: method,
		Header: keyValueRows(r.Headers),
		URL:    exportURL(r.URL, r.Query, r.PathParams),
	}
	if warn {
		out.Auth = e.itemAuth(where, r.Auth)
		out.Body = e.body(where, r.Body)
	} else {
		quiet := &exporter{}
		out.Auth = quiet.itemAuth(where, r.Auth)
		out.Body = quiet.body(where, r.Body)
	}
	return out
}

func keyValueRows(rows []model.KeyValue) []xKeyValue {
	out := []xKeyValue{}
	for _, kv := range rows {
		if kv.Key == "" && kv.Value == "" {
			continue
		}
		out = append(out, xKeyValue{Key: kv.Key, Value: kv.Value, Type: "text", Disabled: !kv.Enabled})
	}
	return out
}

func (e *exporter) body(where string, b model.Body) *xBody {
	switch b.Type {
	case model.BodyRaw:
		raw := b.Raw
		lang := string(b.Language)
		if lang == "" {
			lang = string(model.LangText)
		}
		return &xBody{Mode: "raw", Raw: &raw, Options: &xOptions{Raw: xRawOptions{Language: lang}}}
	case model.BodyURLEncoded:
		return &xBody{Mode: "urlencoded", URLEncoded: keyValueRows(b.URLEncoded)}
	case model.BodyFormData:
		rows := []xFormData{}
		hasFile := false
		for _, f := range b.FormData {
			row := xFormData{Key: f.Key, ContentType: f.ContentType, Disabled: !f.Enabled, Type: "text", Value: f.Value}
			if f.Kind == model.FormFile {
				row.Type, row.Value, row.Src = "file", "", f.FilePath
				hasFile = hasFile || f.FilePath != ""
			}
			rows = append(rows, row)
		}
		if hasFile {
			e.files = append(e.files, where)
		}
		return &xBody{Mode: "formdata", FormData: rows}
	case model.BodyBinary:
		if b.BinaryPath != "" {
			e.files = append(e.files, where)
		}
		return &xBody{Mode: "file", File: &xFile{Src: b.BinaryPath}}
	}
	return nil
}

func events(s model.Scripts) []xEvent {
	var out []xEvent
	for _, ev := range []struct{ listen, src string }{{"prerequest", s.PreRequest}, {"test", s.Test}} {
		if strings.TrimSpace(ev.src) == "" {
			continue
		}
		out = append(out, xEvent{Listen: ev.listen, Script: xScript{
			Type: "text/javascript",
			Exec: strings.Split(strings.TrimRight(ev.src, "\n"), "\n"),
		}})
	}
	return out
}

func (e *exporter) collectionVariables(vs []model.Variable) []xVariable {
	out := make([]xVariable, 0, len(vs))
	for _, v := range vs {
		value := v.Value
		if v.Secret {
			// Collection variables have no secret type in the v2.1 schema.
			value = ""
			e.secrets = append(e.secrets, v.Key)
		}
		out = append(out, xVariable{Key: v.Key, Value: value, Type: "string", Disabled: !v.Enabled})
	}
	return out
}

func (e *exporter) variableFile(kind Kind, name string, vs []model.Variable) xVariableFile {
	out := xVariableFile{Name: name, Values: []xEnvVariable{}, Scope: string(kind), ExportedUsing: ExportedUsing}
	for _, v := range vs {
		row := xEnvVariable{Key: v.Key, Value: v.Value, Type: "default", Enabled: v.Enabled}
		if v.Secret {
			row.Type, row.Value = "secret", ""
			e.secrets = append(e.secrets, v.Key)
		}
		out.Values = append(out.Values, row)
	}
	return out
}

var previewLanguages = map[model.BodyKind]string{
	model.KindJSON: "json",
	model.KindXML:  "xml",
	model.KindHTML: "html",
}

func (e *exporter) example(where string, ex Example) (xExample, bool) {
	if ex.Encoding == model.EncodingBase64 {
		e.warn(where, "The example %q has a binary body, which Postman can't hold, so it wasn't exported.", ex.Name)
		return xExample{}, false
	}
	lang := previewLanguages[ex.Kind]
	if lang == "" {
		lang = "text"
	}
	return xExample{
		Name:            ex.Name,
		OriginalRequest: e.request(where, ex.Request, false),
		Status:          ex.StatusText,
		Code:            ex.StatusCode,
		PreviewLanguage: lang,
		Header:          keyValueRows(ex.Headers),
		Cookie:          []any{},
		Body:            ex.Body,
	}, true
}
