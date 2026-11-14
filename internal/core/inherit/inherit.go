// Package inherit merges the auth and headers a request inherits from its
// collection and folders.
//
// Rules:
//   - Auth: when the request's type is inherit, the chain is walked from the
//     innermost folder out to the collection. The first level whose type is
//     neither inherit nor empty wins; if none has one, the result is none.
//     A request with an empty type keeps Tier 1 behaviour (none).
//   - Headers: collection, then folders (outermost first), then the request.
//     An enabled header at a deeper level replaces every shallower header
//     with the same name (case-insensitive). Disabled rows never hide
//     anything, and disabled inherited rows are not applied. Rows with the
//     same name at one level are all kept (multi-value headers).
//
// The package has no Wails dependency.
package inherit

import (
	"strings"

	"pakpos/internal/core/model"
)

// Kind is the kind of level a setting comes from.
type Kind string

// Level kinds.
const (
	KindCollection Kind = "collection"
	KindFolder     Kind = "folder"
)

// Level is the collection or one folder above a request.
type Level struct {
	Kind    Kind
	ID      string
	Name    string
	Auth    model.Auth
	Headers []model.KeyValue
}

// Source identifies the level an inherited setting comes from, for the UI.
type Source struct {
	Kind Kind   `json:"kind"`
	ID   string `json:"id"`
	Name string `json:"name"`
}

// Header is an inherited header that is applied, with where it comes from.
type Header struct {
	Key    string `json:"key"`
	Value  string `json:"value"`
	Source Source `json:"source"`
}

// Result is the request as it will be sent, before variables are resolved.
type Result struct {
	// Request has the effective auth, and the applied inherited headers
	// followed by the request's own headers (disabled ones included, as the
	// executor skips them).
	Request model.Request
	// Headers are the inherited headers that are applied, in send order.
	Headers []Header
	// AuthSource is where the auth came from when the request inherits it,
	// or nil when the request has its own auth or nothing was inherited.
	AuthSource *Source
}

// Effective applies the chain (collection first, then folders outermost
// first) to req. req is not modified; the result's Headers slice is new,
// its other slices are shared with req.
func Effective(chain []Level, req model.Request) Result {
	out := req
	res := Result{Headers: []Header{}}

	if req.Auth.Type == model.AuthInherit {
		out.Auth = model.Auth{Type: model.AuthNone}
		for i := len(chain) - 1; i >= 0; i-- {
			l := chain[i]
			if l.Auth.Type == "" || l.Auth.Type == model.AuthInherit {
				continue
			}
			out.Auth = l.Auth
			res.AuthSource = &Source{Kind: l.Kind, ID: l.ID, Name: l.Name}
			break
		}
	}

	// Walk innermost first; deeper holds the names set (enabled) below the
	// current level, the request being the deepest.
	deeper := enabledNames(req.Headers)
	var applied [][]Header
	for i := len(chain) - 1; i >= 0; i-- {
		l := chain[i]
		var rows []Header
		for _, h := range l.Headers {
			name := strings.ToLower(strings.TrimSpace(h.Key))
			if !h.Enabled || name == "" {
				continue
			}
			if _, hidden := deeper[name]; hidden {
				continue
			}
			rows = append(rows, Header{Key: h.Key, Value: h.Value, Source: Source{Kind: l.Kind, ID: l.ID, Name: l.Name}})
		}
		applied = append(applied, rows)
		for n := range enabledNames(l.Headers) {
			deeper[n] = struct{}{}
		}
	}
	// applied was built innermost first; send outermost first.
	for i := len(applied) - 1; i >= 0; i-- {
		res.Headers = append(res.Headers, applied[i]...)
	}

	headers := make([]model.KeyValue, 0, len(res.Headers)+len(req.Headers))
	for _, h := range res.Headers {
		headers = append(headers, model.KeyValue{Key: h.Key, Value: h.Value, Enabled: true})
	}
	headers = append(headers, req.Headers...)
	if len(headers) == 0 {
		headers = req.Headers
	}
	out.Headers = headers
	res.Request = out
	return res
}

func enabledNames(rows []model.KeyValue) map[string]struct{} {
	names := map[string]struct{}{}
	for _, h := range rows {
		if name := strings.ToLower(strings.TrimSpace(h.Key)); h.Enabled && name != "" {
			names[name] = struct{}{}
		}
	}
	return names
}
