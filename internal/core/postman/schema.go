package postman

import (
	"bytes"
	"encoding/json"
	"strings"
)

// The types below mirror Postman's export formats loosely: every field that
// the schemas (or real exports) allow in more than one shape decodes through
// a type that accepts all of them, so one odd field never fails a whole file.

// text is a JSON value read as text: a string as is, null as "", and any
// other value (number, bool, object, array) as its JSON source.
type text string

func (t *text) UnmarshalJSON(b []byte) error {
	b = bytes.TrimSpace(b)
	switch {
	case len(b) == 0, bytes.Equal(b, []byte("null")):
		*t = ""
	case b[0] == '"':
		var s string
		if err := json.Unmarshal(b, &s); err != nil {
			return err
		}
		*t = text(s)
	default:
		*t = text(b)
	}
	return nil
}

// texts is a list of strings that may also be written as a single string.
type texts []string

func (t *texts) UnmarshalJSON(b []byte) error {
	b = bytes.TrimSpace(b)
	if len(b) > 0 && b[0] == '[' {
		var list []text
		if err := json.Unmarshal(b, &list); err != nil {
			return err
		}
		out := make([]string, 0, len(list))
		for _, s := range list {
			out = append(out, string(s))
		}
		*t = out
		return nil
	}
	var s text
	if err := json.Unmarshal(b, &s); err != nil {
		return err
	}
	if s == "" {
		*t = nil
	} else {
		*t = []string{string(s)}
	}
	return nil
}

// flag is a bool that tolerates null and the strings "true"/"false".
type flag bool

func (f *flag) UnmarshalJSON(b []byte) error {
	var t text
	if err := json.Unmarshal(b, &t); err != nil {
		return err
	}
	*f = flag(strings.EqualFold(strings.TrimSpace(string(t)), "true"))
	return nil
}

// optFlag is a bool that remembers whether it was present.
type optFlag struct {
	set   bool
	value bool
}

func (f *optFlag) UnmarshalJSON(b []byte) error {
	var v flag
	if err := json.Unmarshal(b, &v); err != nil {
		return err
	}
	if !bytes.Equal(bytes.TrimSpace(b), []byte("null")) {
		*f = optFlag{set: true, value: bool(v)}
	}
	return nil
}

// probe reads just enough of a file to tell what it is.
type probe struct {
	Info *struct {
		Schema text `json:"schema"`
	} `json:"info"`
	Item         json.RawMessage `json:"item"`
	Values       json.RawMessage `json:"values"`
	Scope        text            `json:"_postman_variable_scope"`
	Requests     json.RawMessage `json:"requests"`
	Order        json.RawMessage `json:"order"`
	Collections  json.RawMessage `json:"collections"`
	Environments json.RawMessage `json:"environments"`
	Name         text            `json:"name"`
}

type pmCollection struct {
	Info struct {
		Name   text `json:"name"`
		Schema text `json:"schema"`
	} `json:"info"`
	Item     []pmItem     `json:"item"`
	Auth     *pmAuth      `json:"auth"`
	Event    []pmEvent    `json:"event"`
	Variable []pmVariable `json:"variable"`
}

// pmItem is a request (Request set) or a folder (Item set, possibly empty).
type pmItem struct {
	Name     text         `json:"name"`
	Item     *[]pmItem    `json:"item"`
	Request  *pmRequest   `json:"request"`
	Response []pmResponse `json:"response"`
	Auth     *pmAuth      `json:"auth"`
	Event    []pmEvent    `json:"event"`
	Behavior *pmBehavior  `json:"protocolProfileBehavior"`
}

type pmBehavior struct {
	FollowRedirects optFlag `json:"followRedirects"`
	StrictSSL       optFlag `json:"strictSSL"`
	MaxRedirects    *int    `json:"maxRedirects"`
}

// pmRequest is a request object, or just its URL (a string in the schema).
type pmRequest struct {
	URL    *pmURL    `json:"url"`
	Method text      `json:"method"`
	Header pmHeaders `json:"header"`
	Body   *pmBody   `json:"body"`
	Auth   *pmAuth   `json:"auth"`
}

func (r *pmRequest) UnmarshalJSON(b []byte) error {
	b = bytes.TrimSpace(b)
	if len(b) > 0 && b[0] == '"' {
		var u pmURL
		if err := json.Unmarshal(b, &u); err != nil {
			return err
		}
		*r = pmRequest{URL: &u}
		return nil
	}
	type plain pmRequest
	var p plain
	if err := json.Unmarshal(b, &p); err != nil {
		return err
	}
	*r = pmRequest(p)
	return nil
}

// pmURL is a URL object, or just its raw text (a string in the schema).
type pmURL struct {
	Raw      text         `json:"raw"`
	Protocol text         `json:"protocol"`
	Host     pmSegments   `json:"host"`
	Port     text         `json:"port"`
	Path     pmSegments   `json:"path"`
	Query    []pmKeyValue `json:"query"`
	Variable []pmKeyValue `json:"variable"`
	Hash     text         `json:"hash"`
}

func (u *pmURL) UnmarshalJSON(b []byte) error {
	b = bytes.TrimSpace(b)
	if len(b) > 0 && b[0] == '"' {
		var s string
		if err := json.Unmarshal(b, &s); err != nil {
			return err
		}
		*u = pmURL{Raw: text(s)}
		return nil
	}
	type plain pmURL
	var p plain
	if err := json.Unmarshal(b, &p); err != nil {
		return err
	}
	*u = pmURL(p)
	return nil
}

// pmSegments is a host or path: a string, or a list whose items are strings
// or {type, value} objects (v2.0 path segments).
type pmSegments struct {
	list   []string
	single bool // written as one string, already joined
}

func (s *pmSegments) UnmarshalJSON(b []byte) error {
	b = bytes.TrimSpace(b)
	if len(b) == 0 || b[0] != '[' {
		var t text
		if err := json.Unmarshal(b, &t); err != nil {
			return err
		}
		*s = pmSegments{single: true}
		if t != "" {
			s.list = []string{string(t)}
		}
		return nil
	}
	var raw []json.RawMessage
	if err := json.Unmarshal(b, &raw); err != nil {
		return err
	}
	for _, r := range raw {
		var seg struct {
			Value text `json:"value"`
		}
		if bytes.HasPrefix(bytes.TrimSpace(r), []byte("{")) {
			if err := json.Unmarshal(r, &seg); err != nil {
				return err
			}
			s.list = append(s.list, string(seg.Value))
			continue
		}
		var t text
		if err := json.Unmarshal(r, &t); err != nil {
			return err
		}
		s.list = append(s.list, string(t))
	}
	return nil
}

func (s pmSegments) join(sep string) string { return strings.Join(s.list, sep) }

type pmKeyValue struct {
	Key      text `json:"key"`
	Value    text `json:"value"`
	Disabled flag `json:"disabled"`
}

// pmHeaders is a header list, or the headers as one "Name: value" per line
// string (allowed by the schema).
type pmHeaders []pmKeyValue

func (h *pmHeaders) UnmarshalJSON(b []byte) error {
	b = bytes.TrimSpace(b)
	if len(b) > 0 && b[0] == '[' {
		var list []pmKeyValue
		if err := json.Unmarshal(b, &list); err != nil {
			return err
		}
		*h = list
		return nil
	}
	var t text
	if err := json.Unmarshal(b, &t); err != nil {
		return err
	}
	var out []pmKeyValue
	for line := range strings.SplitSeq(string(t), "\n") {
		k, v, ok := strings.Cut(line, ":")
		if !ok || strings.TrimSpace(k) == "" {
			continue
		}
		out = append(out, pmKeyValue{Key: text(strings.TrimSpace(k)), Value: text(strings.TrimSpace(v))})
	}
	*h = out
	return nil
}

type pmBody struct {
	Mode       text         `json:"mode"`
	Raw        text         `json:"raw"`
	URLEncoded []pmKeyValue `json:"urlencoded"`
	FormData   []pmFormData `json:"formdata"`
	File       *struct {
		Src text `json:"src"`
	} `json:"file"`
	GraphQL *struct {
		Query     text `json:"query"`
		Variables text `json:"variables"`
	} `json:"graphql"`
	Options *struct {
		Raw *struct {
			Language text `json:"language"`
		} `json:"raw"`
	} `json:"options"`
	Disabled flag `json:"disabled"`
}

type pmFormData struct {
	Key         text  `json:"key"`
	Value       text  `json:"value"`
	Type        text  `json:"type"`
	Src         texts `json:"src"`
	ContentType text  `json:"contentType"`
	Disabled    flag  `json:"disabled"`
}

// pmAuth is an auth block. Params holds each type's settings: v2.1 writes
// them as [{key, value, type}], v2.0 as an object; both end up as a map.
type pmAuth struct {
	Type   string
	Params map[string]string
}

func (a *pmAuth) UnmarshalJSON(b []byte) error {
	var raw map[string]json.RawMessage
	if err := json.Unmarshal(b, &raw); err != nil {
		return err
	}
	var typ text
	if t, ok := raw["type"]; ok {
		if err := json.Unmarshal(t, &typ); err != nil {
			return err
		}
	}
	*a = pmAuth{Type: strings.ToLower(strings.TrimSpace(string(typ))), Params: map[string]string{}}
	block := bytes.TrimSpace(raw[a.Type])
	switch {
	case len(block) == 0:
	case block[0] == '[':
		var list []struct {
			Key   text `json:"key"`
			Value text `json:"value"`
		}
		if err := json.Unmarshal(block, &list); err != nil {
			return err
		}
		for _, p := range list {
			a.Params[string(p.Key)] = string(p.Value)
		}
	case block[0] == '{':
		var m map[string]text
		if err := json.Unmarshal(block, &m); err != nil {
			return err
		}
		for k, v := range m {
			a.Params[k] = string(v)
		}
	}
	return nil
}

type pmEvent struct {
	Listen   text `json:"listen"`
	Disabled flag `json:"disabled"`
	Script   *struct {
		Exec texts `json:"exec"`
	} `json:"script"`
}

type pmVariable struct {
	Key      text `json:"key"`
	Value    text `json:"value"`
	Type     text `json:"type"`
	Disabled flag `json:"disabled"`
	// Enabled is how environment and globals exports write it (default true).
	Enabled *flag `json:"enabled"`
}

type pmVariableFile struct {
	Name   text         `json:"name"`
	Scope  text         `json:"_postman_variable_scope"`
	Values []pmVariable `json:"values"`
}

type pmResponse struct {
	Name            text       `json:"name"`
	OriginalRequest *pmRequest `json:"originalRequest"`
	Status          text       `json:"status"`
	Code            int        `json:"code"`
	Header          pmHeaders  `json:"header"`
	Body            text       `json:"body"`
	PreviewLanguage text       `json:"_postman_previewlanguage"`
}
