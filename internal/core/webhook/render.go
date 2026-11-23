package webhook

import (
	"bytes"
	"encoding/json"
	"net/http"
	"strings"

	"pakpos/internal/core/vars"
)

// Template references available in response headers and bodies.
const (
	RefPrefix = "$request."
	refMethod = "$request.method"
	refPath   = "$request.path"
	refURL    = "$request.url"
	refBody   = "$request.body"
	refQuery  = "$request.query."
	refHeader = "$request.header."
	refParams = "$request.params."
	refJSON   = "$request.json."
)

// Rendered is a response ready to write.
type Rendered struct {
	Status int
	Header http.Header
	Body   []byte
}

// Render fills the templates of resp from req and params. References:
// {{$request.method}}, .path, .url (path and query), .body,
// .query.<name>, .header.<name>, .params.<name>, .json.<dot.path>, and the
// dynamic variables of core/vars. A known reference whose value is missing
// becomes ""; an unknown one stays as written. Values are inserted once and
// never expanded again, so a sender can't inject references. When the body
// is JSON (by its Content-Type, or by its first character when it has
// none), values inside string literals are JSON-escaped. opts configure the
// dynamic variables (clock, randomness).
func Render(resp Response, req *Request, params map[string]string, opts ...vars.Option) Rendered {
	dyn := vars.New(nil, opts...)
	lookup := func(name string) (string, bool) {
		return value(name, req, params, dyn)
	}
	out := Rendered{Status: resp.Status, Header: http.Header{}}
	contentType := ""
	for _, h := range resp.Headers {
		if !h.Enabled || h.Key == "" {
			continue
		}
		v := expand(h.Value, lookup, nil)
		out.Header.Add(h.Key, v)
		if http.CanonicalHeaderKey(h.Key) == "Content-Type" {
			contentType = v
		}
	}
	isJSON := strings.Contains(strings.ToLower(contentType), "json")
	if contentType == "" {
		t := strings.TrimLeft(resp.Body, " \t\r\n")
		isJSON = strings.HasPrefix(t, "{") || strings.HasPrefix(t, "[")
	}
	if isJSON {
		out.Body = []byte(expandJSON(resp.Body, lookup))
	} else {
		out.Body = []byte(expand(resp.Body, lookup, nil))
	}
	if contentType == "" && len(out.Body) > 0 {
		out.Header.Set("Content-Type", sniff(out.Body))
	}
	return out
}

// sniff picks a Content-Type for a rendered body without one.
func sniff(body []byte) string {
	t := bytes.TrimSpace(body)
	lower := bytes.ToLower(t[:min(len(t), 15)])
	switch {
	case json.Valid(t):
		return "application/json"
	case bytes.HasPrefix(lower, []byte("<!doctype html")), bytes.HasPrefix(lower, []byte("<html")):
		return "text/html; charset=utf-8"
	case bytes.HasPrefix(t, []byte("<")):
		return "application/xml"
	}
	return "text/plain; charset=utf-8"
}

func value(name string, req *Request, params map[string]string, dyn *vars.Resolver) (string, bool) {
	switch {
	case vars.IsDynamic(name):
		v, _, err := dyn.Resolve("{{" + name + "}}")
		return v, err == nil
	case name == refMethod:
		return req.Method, true
	case name == refPath:
		return req.Path, true
	case name == refURL:
		if q := req.Query.Encode(); q != "" {
			return req.Path + "?" + q, true
		}
		return req.Path, true
	case name == refBody:
		return string(req.Body), true
	case strings.HasPrefix(name, refQuery) && len(name) > len(refQuery):
		return req.Query.Get(name[len(refQuery):]), true
	case strings.HasPrefix(name, refHeader) && len(name) > len(refHeader):
		return req.Header.Get(name[len(refHeader):]), true
	case strings.HasPrefix(name, refParams) && len(name) > len(refParams):
		return params[name[len(refParams):]], true
	case strings.HasPrefix(name, refJSON) && len(name) > len(refJSON):
		v, _ := req.JSONPath(name[len(refJSON):])
		return v, true
	}
	return "", false
}

// expand replaces every {{ref}} in s that lookup knows, applying escape (when
// not nil) to each value. Values are not scanned again.
func expand(s string, lookup func(string) (string, bool), escape func(string) string) string {
	if !strings.Contains(s, "{{") {
		return s
	}
	var b strings.Builder
	rest := s
	for {
		start := strings.Index(rest, "{{")
		if start < 0 {
			break
		}
		end := strings.Index(rest[start+2:], "}}")
		if end < 0 {
			break
		}
		inner := rest[start+2 : start+2+end]
		if i := strings.LastIndex(inner, "{{"); i >= 0 {
			b.WriteString(rest[:start+2+i])
			rest = rest[start+2+i:]
			continue
		}
		b.WriteString(rest[:start])
		ref := rest[start : start+4+end]
		rest = rest[start+4+end:]
		name := strings.TrimSpace(inner)
		v, ok := lookup(name)
		if !ok {
			b.WriteString(ref)
			continue
		}
		if escape != nil {
			v = escape(v)
		}
		b.WriteString(v)
	}
	b.WriteString(rest)
	return b.String()
}

// expandJSON is expand that JSON-escapes values landing inside string
// literals; string literals are found by their quotes, as vars.ResolveJSON
// does.
func expandJSON(s string, lookup func(string) (string, bool)) string {
	if !strings.Contains(s, "{{") {
		return s
	}
	var b strings.Builder
	inString := false
	start := 0
	flush := func(end int) {
		var escape func(string) string
		if inString {
			escape = vars.JSONEscape
		}
		b.WriteString(expand(s[start:end], lookup, escape))
	}
	for i := 0; i < len(s); i++ {
		switch {
		case inString && s[i] == '\\':
			i++
		case s[i] == '"':
			flush(i)
			b.WriteByte('"')
			start = i + 1
			inString = !inString
		}
	}
	flush(len(s))
	return b.String()
}
