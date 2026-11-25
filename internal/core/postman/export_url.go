package postman

import (
	"strings"

	"pakpos/internal/core/model"
)

// exportURL writes a URL object: raw is the URL as typed (its query mirrors
// the enabled rows), query lists every row (disabled ones included, which
// only url.query can hold) and variable the path params. The host is one
// segment, so a {{variable}} holding dots stays whole.
func exportURL(raw string, query, params []model.KeyValue) xURL {
	out := xURL{Raw: raw, Query: keyValueRows(query)}
	for _, p := range params {
		if p.Key == "" {
			continue
		}
		out.Variable = append(out.Variable, xKeyValue{Key: p.Key, Value: p.Value})
	}
	for i := range out.Query {
		out.Query[i].Type = ""
	}
	rest := raw
	if i := strings.Index(rest, "#"); i >= 0 {
		out.Hash = rest[i+1:]
		rest = rest[:i]
	}
	if i := strings.Index(rest, "?"); i >= 0 {
		rest = rest[:i]
	}
	if i := strings.Index(rest, "://"); i >= 0 {
		out.Protocol = rest[:i]
		rest = rest[i+3:]
	}
	host, path, hasPath := strings.Cut(rest, "/")
	if i := strings.LastIndex(host, ":"); i >= 0 && i > strings.LastIndex(host, "]") && isPort(host[i+1:]) {
		out.Port = host[i+1:]
		host = host[:i]
	}
	if host != "" {
		out.Host = []string{host}
	}
	if hasPath {
		out.Path = strings.Split(path, "/")
	}
	return out
}

// isPort reports whether s is a port number or a {{variable}}.
func isPort(s string) bool {
	if strings.HasPrefix(s, "{{") && strings.HasSuffix(s, "}}") {
		return true
	}
	if s == "" {
		return false
	}
	for _, r := range s {
		if r < '0' || r > '9' {
			return false
		}
	}
	return true
}
