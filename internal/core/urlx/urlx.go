// Package urlx keeps the URL bar and the params tables in sync. All functions
// are tolerant of partial or invalid URLs, since they run while the user types.
package urlx

import (
	"net/url"
	"regexp"
	"strings"

	"pakpos/internal/core/model"
)

// Split breaks a raw URL into base (scheme, host, path), query (without '?')
// and fragment (without '#'). hasQuery reports whether a '?' was present.
func Split(raw string) (base, query, fragment string, hasQuery bool) {
	if i := strings.IndexByte(raw, '#'); i >= 0 {
		raw, fragment = raw[:i], raw[i+1:]
	}
	if i := strings.IndexByte(raw, '?'); i >= 0 {
		return raw[:i], raw[i+1:], fragment, true
	}
	return raw, "", fragment, false
}

// ParseQuery converts a query string into table rows, preserving order and
// duplicates. Values are decoded; undecodable values are kept verbatim.
func ParseQuery(query string) []model.KeyValue {
	rows := []model.KeyValue{}
	for _, part := range strings.Split(query, "&") {
		if part == "" {
			continue
		}
		key, value, _ := strings.Cut(part, "=")
		rows = append(rows, model.KeyValue{Key: decode(key), Value: decode(value), Enabled: true})
	}
	return rows
}

// QueryFromURL returns the query rows of a raw URL.
func QueryFromURL(raw string) []model.KeyValue {
	_, q, _, _ := Split(raw)
	return ParseQuery(q)
}

// BuildQuery encodes the enabled rows for display in the URL bar. Only
// characters that would change the meaning are escaped, so `{{vars}}`, ':'
// and '/' stay readable. Rows with an empty key and value are skipped.
func BuildQuery(rows []model.KeyValue) string {
	parts := make([]string, 0, len(rows))
	for _, r := range rows {
		if !r.Enabled || (r.Key == "" && r.Value == "") {
			continue
		}
		if r.Value == "" {
			parts = append(parts, encodeDisplay(r.Key))
			continue
		}
		parts = append(parts, encodeDisplay(r.Key)+"="+encodeDisplay(r.Value))
	}
	return strings.Join(parts, "&")
}

// WithQuery replaces the query string of raw with the enabled rows,
// keeping base and fragment. The '?' is dropped when nothing is enabled.
func WithQuery(raw string, rows []model.KeyValue) string {
	base, _, fragment, _ := Split(raw)
	out := base
	if q := BuildQuery(rows); q != "" {
		out += "?" + q
	}
	if fragment != "" {
		out += "#" + fragment
	}
	return out
}

// MergeQuery returns the rows parsed from the URL's query, followed by the
// disabled rows of previous (which never appear in the URL). Use it when the
// user edits the URL bar so disabled rows are not lost.
func MergeQuery(raw string, previous []model.KeyValue) []model.KeyValue {
	rows := QueryFromURL(raw)
	for _, r := range previous {
		if !r.Enabled {
			rows = append(rows, r)
		}
	}
	return rows
}

// EncodeWireQuery encodes enabled rows strictly (RFC 3986) for sending.
func EncodeWireQuery(rows []model.KeyValue) string {
	parts := make([]string, 0, len(rows))
	for _, r := range rows {
		if !r.Enabled || (r.Key == "" && r.Value == "") {
			continue
		}
		parts = append(parts, escapeStrict(r.Key)+"="+escapeStrict(r.Value))
	}
	return strings.Join(parts, "&")
}

func escapeStrict(s string) string {
	return strings.ReplaceAll(url.QueryEscape(s), "+", "%20")
}

func decode(s string) string {
	if d, err := url.QueryUnescape(s); err == nil {
		return d
	}
	return s
}

// encodeDisplay escapes everything except unreserved characters and a set of
// readable delimiters that are safe inside a query component.
func encodeDisplay(s string) string {
	const hex = "0123456789ABCDEF"
	var b strings.Builder
	for i := 0; i < len(s); i++ {
		c := s[i]
		if isDisplaySafe(c) {
			b.WriteByte(c)
			continue
		}
		b.WriteByte('%')
		b.WriteByte(hex[c>>4])
		b.WriteByte(hex[c&15])
	}
	return b.String()
}

func isDisplaySafe(c byte) bool {
	switch {
	case 'a' <= c && c <= 'z', 'A' <= c && c <= 'Z', '0' <= c && c <= '9':
		return true
	}
	return strings.IndexByte("-._~!$'()*,;:@/?{}[]", c) >= 0
}

var schemeRe = regexp.MustCompile(`^[A-Za-z][A-Za-z0-9+.-]*://`)

// HasScheme reports whether raw starts with "scheme://".
func HasScheme(raw string) bool { return schemeRe.MatchString(raw) }

// EnsureScheme prefixes "http://" when raw has no scheme. Empty input and
// URLs starting with a {{variable}} are returned unchanged.
func EnsureScheme(raw string) string {
	raw = strings.TrimSpace(raw)
	if raw == "" || HasScheme(raw) || strings.HasPrefix(raw, "{{") {
		return raw
	}
	return "http://" + raw
}

// splitPath separates "scheme://host[:port]" (or "host[:port]" without a
// scheme) from the path of base, so a port is never mistaken for a path param.
func splitPath(base string) (authority, path string) {
	start := 0
	if loc := schemeRe.FindStringIndex(base); loc != nil {
		start = loc[1]
	}
	if i := strings.IndexByte(base[start:], '/'); i >= 0 {
		return base[:start+i], base[start+i:]
	}
	return base, ""
}

var paramNameRe = regexp.MustCompile(`^[A-Za-z_][A-Za-z0-9_-]*$`)

// PathParamNames returns the names of ":name" path segments in order,
// without duplicates.
func PathParamNames(raw string) []string {
	base, _, _, _ := Split(raw)
	_, path := splitPath(base)
	names := []string{}
	seen := map[string]bool{}
	for _, seg := range strings.Split(path, "/") {
		name, ok := strings.CutPrefix(seg, ":")
		if !ok || !paramNameRe.MatchString(name) || seen[name] {
			continue
		}
		seen[name] = true
		names = append(names, name)
	}
	return names
}

// SyncPathParams returns one row per path param in raw, keeping values from
// previous rows with the same key.
func SyncPathParams(raw string, previous []model.KeyValue) []model.KeyValue {
	old := map[string]string{}
	for _, p := range previous {
		old[p.Key] = p.Value
	}
	names := PathParamNames(raw)
	rows := make([]model.KeyValue, 0, len(names))
	for _, n := range names {
		rows = append(rows, model.KeyValue{Key: n, Value: old[n], Enabled: true})
	}
	return rows
}

// ApplyPathParams substitutes ":name" segments with their path-escaped
// values. Params with an empty value, or disabled, are left as-is.
func ApplyPathParams(raw string, params []model.KeyValue) string {
	values := map[string]string{}
	for _, p := range params {
		if p.Enabled && p.Value != "" {
			values[p.Key] = p.Value
		}
	}
	if len(values) == 0 {
		return raw
	}
	base, query, fragment, hasQuery := Split(raw)
	authority, path := splitPath(base)
	segs := strings.Split(path, "/")
	for i, seg := range segs {
		if name, ok := strings.CutPrefix(seg, ":"); ok {
			if v, found := values[name]; found {
				segs[i] = url.PathEscape(v)
			}
		}
	}
	out := authority + strings.Join(segs, "/")
	if hasQuery {
		out += "?" + query
	}
	if fragment != "" {
		out += "#" + fragment
	}
	return out
}
