// Package codegen writes a request as code in other languages: cURL,
// JavaScript (fetch for Node and browsers, axios), Python (requests), Go (net/http), Java
// (java.net.http) and PHP (the cURL extension).
//
// The input is the request as it will be sent: inheritance applied and
// variables resolved (see pipeline.Session.PrepareCode). Auth is applied
// here: bearer and API key auth become the header or query parameter they
// send, and basic auth uses each language's own helper where it has one, so
// a {{secret}} placeholder in the password stays readable. The Content-Type
// Pakpos would add for a raw, urlencoded or binary body is written out when
// the user set none; the User-Agent and Accept-Encoding headers Pakpos adds
// are left to the client library.
//
// Every generator produces a complete, runnable program (or script) that
// sends the request and prints the status and the response body.
//
// The package has no Wails dependency.
package codegen

import (
	"errors"
	"fmt"
	"path/filepath"
	"strings"

	"pakpos/internal/core/auth"
	"pakpos/internal/core/curl"
	"pakpos/internal/core/model"
	"pakpos/internal/core/urlx"
)

// Language describes a generator for the UI.
type Language struct {
	ID    string `json:"id"`
	Label string `json:"label"`
	// Editor is the CodeMirror language used to highlight the code.
	Editor string `json:"editor"`
}

// Result is generated code and what the user should know about it.
type Result struct {
	Code string `json:"code"`
	// Warnings explain parts of the request the code leaves out or sends
	// differently. Never nil.
	Warnings []string `json:"warnings"`
}

// ErrUnknownLanguage is returned by Generate for an id not in Languages.
var ErrUnknownLanguage = errors.New("unknown code language")

type generator struct {
	Language
	gen func(*spec) string
	// keep lists the auth types the language writes with a helper of its
	// own (see auth.MaterializeWith).
	keep func(model.AuthType) bool
}

func keepTypes(types ...model.AuthType) func(model.AuthType) bool {
	return func(t model.AuthType) bool {
		for _, k := range types {
			if k == t {
				return true
			}
		}
		return false
	}
}

var basicOnly = keepTypes(model.AuthBasic)

var generators = []generator{
	{Language{ID: "curl", Label: "cURL", Editor: "shell"}, genCurl, curl.Keeps},
	{Language{ID: "javascript-fetch", Label: "JavaScript (fetch, Node)", Editor: "javascript"}, genFetch, basicOnly},
	{Language{ID: "javascript-fetch-browser", Label: "JavaScript (fetch, browser)", Editor: "javascript"}, genFetchBrowser, basicOnly},
	{Language{ID: "javascript-axios", Label: "JavaScript (axios)", Editor: "javascript"}, genAxios, basicOnly},
	{Language{ID: "python-requests", Label: "Python (requests)", Editor: "python"}, genPython, keepTypes(model.AuthBasic, model.AuthDigest)},
	{Language{ID: "go-native", Label: "Go (net/http)", Editor: "go"}, genGo, basicOnly},
	{Language{ID: "java-http", Label: "Java (HttpClient)", Editor: "java"}, genJava, basicOnly},
	{Language{ID: "php-curl", Label: "PHP (cURL)", Editor: "php"}, genPHP, keepTypes(model.AuthBasic, model.AuthDigest, model.AuthNTLM)},
}

// Languages lists the generators in display order.
func Languages() []Language {
	out := make([]Language, len(generators))
	for i, g := range generators {
		out[i] = g.Language
	}
	return out
}

// Generate writes req as code in the language with id lang.
func Generate(lang string, req model.Request) (Result, error) {
	for _, g := range generators {
		if g.ID == lang {
			s := prepare(req, g.keep)
			code := g.gen(s)
			return Result{Code: code, Warnings: s.warnings}, nil
		}
	}
	return Result{}, fmt.Errorf("%w %q", ErrUnknownLanguage, lang)
}

// spec is the request reduced to what is sent, shared by the generators.
type spec struct {
	// req has auth materialized (basic kept as auth) for the cURL generator.
	req    model.Request
	method string
	url    string
	// headers are the enabled headers with a name, plus the default
	// Content-Type for raw, urlencoded and binary bodies.
	headers []model.KeyValue
	basic   *model.Auth
	// digest and ntlm are set when the language keeps them (its helper).
	digest *model.Digest
	ntlm   *model.NTLM
	body   model.Body
	// fields are the enabled urlencoded rows; parts the enabled form-data fields.
	fields   []model.KeyValue
	parts    []model.FormField
	warnings []string
}

// warn adds a warning once.
func (s *spec) warn(format string, args ...any) {
	msg := fmt.Sprintf(format, args...)
	for _, w := range s.warnings {
		if w == msg {
			return
		}
	}
	s.warnings = append(s.warnings, msg)
}

func prepare(req model.Request, keep func(model.AuthType) bool) *spec {
	s := &spec{warnings: []string{}}
	r, warnings, err := auth.MaterializeWith(req, keep)
	if err != nil {
		s.warn("The API key auth has no key name, so it was left out.")
	}
	for _, w := range warnings {
		s.warn("%s", w)
	}
	switch r.Auth.Type {
	case model.AuthDigest:
		s.digest = r.Auth.Digest
	case model.AuthNTLM:
		s.ntlm = r.Auth.NTLM
	}
	s.req = r
	s.method = strings.ToUpper(strings.TrimSpace(r.Method))
	if s.method == "" {
		s.method = "GET"
	}
	s.url = urlx.SendURL(r)
	if r.Auth.Type == model.AuthBasic {
		a := r.Auth
		s.basic = &a
	}
	for _, h := range r.Headers {
		key := strings.TrimSpace(h.Key)
		if h.Enabled && key != "" {
			s.headers = append(s.headers, model.KeyValue{Key: key, Value: h.Value, Enabled: true})
		}
	}

	s.body = model.Body{Type: r.Body.Type}
	switch r.Body.Type {
	case model.BodyRaw:
		s.body.Raw, s.body.Language = r.Body.Raw, r.Body.Language
	case model.BodyURLEncoded:
		for _, row := range r.Body.URLEncoded {
			if row.Enabled && (row.Key != "" || row.Value != "") {
				s.fields = append(s.fields, row)
			}
		}
	case model.BodyFormData:
		for _, f := range r.Body.FormData {
			if f.Enabled && strings.TrimSpace(f.Key) != "" {
				s.parts = append(s.parts, f)
			}
		}
	case model.BodyBinary:
		s.body.BinaryPath = r.Body.BinaryPath
		if s.body.BinaryPath == "" {
			s.body.Type = model.BodyNone
			s.warn("No file is chosen for the binary body, so the code sends no body.")
		}
	default:
		s.body.Type = model.BodyNone
	}
	if ct := s.body.DefaultContentType(); ct != "" && s.body.Type != model.BodyFormData && s.header("Content-Type") == "" {
		s.headers = append(s.headers, model.KeyValue{Key: "Content-Type", Value: ct, Enabled: true})
	}
	return s
}

// header returns the last enabled value of a header ("" when unset).
func (s *spec) header(name string) string {
	v := ""
	for _, h := range s.headers {
		if strings.EqualFold(h.Key, name) {
			v = h.Value
		}
	}
	return v
}

// hasBody reports whether a body is sent.
func (s *spec) hasBody() bool { return s.body.Type != model.BodyNone }

// uniqueHeaders reports whether no header name repeats (case-insensitive).
func (s *spec) uniqueHeaders() bool { return unique(s.headers, true) }

func unique(rows []model.KeyValue, fold bool) bool {
	seen := map[string]bool{}
	for _, r := range rows {
		k := r.Key
		if fold {
			k = strings.ToLower(k)
		}
		if seen[k] {
			return false
		}
		seen[k] = true
	}
	return true
}

// mergedHeaders joins repeated headers into one comma-separated value, for
// libraries whose headers are a map. It warns once when it had to.
func (s *spec) mergedHeaders(lib string) []model.KeyValue {
	if s.uniqueHeaders() {
		return s.headers
	}
	s.warn("%s takes one value per header, so repeated headers were combined into one.", lib)
	out := []model.KeyValue{}
	index := map[string]int{}
	for _, h := range s.headers {
		k := strings.ToLower(h.Key)
		if i, ok := index[k]; ok {
			sep := ", "
			if k == "cookie" {
				sep = "; "
			}
			out[i].Value += sep + h.Value
			continue
		}
		index[k] = len(out)
		out = append(out, h)
	}
	return out
}

// fileName is the base name of a path written on any OS.
func fileName(path string) string {
	if i := strings.LastIndexAny(path, `/\`); i >= 0 {
		return path[i+1:]
	}
	return filepath.Base(path)
}

// basicPair is "user:password" for basic auth.
func basicPair(a *model.Auth) string { return a.Username + ":" + a.Password }

// lines splits text into lines that keep their line break, for languages
// whose string literals are written one line at a time.
func lines(text string) []string {
	var out []string
	for text != "" {
		i := strings.IndexByte(text, '\n')
		if i < 0 {
			out = append(out, text)
			break
		}
		out = append(out, text[:i+1])
		text = text[i+1:]
	}
	return out
}
