package webhook

import (
	"bytes"
	"errors"
	"net/http"
	"net/url"
	"strings"
	"testing"
	"time"

	"pakpos/internal/core/model"
	"pakpos/internal/core/vars"
)

func TestPattern(t *testing.T) {
	tests := []struct {
		pattern, path string
		ok            bool
		params        map[string]string
	}{
		{"/", "/", true, nil},
		{"/", "", true, nil},
		{"/", "/a", false, nil},
		{"/a/b", "/a/b", true, nil},
		{"/a/b", "/a/b/", true, nil},
		{"/a/b/", "/a/b", true, nil},
		{"/a/b", "/a/B", false, nil},
		{"/a/b", "/a", false, nil},
		{"/a/b", "/a/b/c", false, nil},
		{"/a/*", "/a/x", true, nil},
		{"/a/*", "/a", false, nil},
		{"/a/*/c", "/a/x/c", true, nil},
		{"/a/**", "/a", true, nil},
		{"/a/**", "/a/x/y/z", true, nil},
		{"/a/**", "/b/x", false, nil},
		{"/**", "/anything/at/all", true, nil},
		{"/orders/:id", "/orders/42", true, map[string]string{"id": "42"}},
		{"/orders/:id/items/:item", "/orders/42/items/7", true, map[string]string{"id": "42", "item": "7"}},
		{"/orders/:id", "/orders", false, nil},
		{"/a/b", "/a//b", false, nil},
	}
	for _, tt := range tests {
		p, err := CompilePattern(tt.pattern)
		if err != nil {
			t.Fatalf("CompilePattern(%q): %v", tt.pattern, err)
		}
		params, ok := p.Match(tt.path)
		if ok != tt.ok {
			t.Errorf("%q ~ %q = %v, want %v", tt.pattern, tt.path, ok, tt.ok)
			continue
		}
		if len(params) != len(tt.params) {
			t.Errorf("%q ~ %q params = %v, want %v", tt.pattern, tt.path, params, tt.params)
		}
		for k, v := range tt.params {
			if params[k] != v {
				t.Errorf("%q ~ %q param %s = %q, want %q", tt.pattern, tt.path, k, params[k], v)
			}
		}
	}
}

func TestPatternErrors(t *testing.T) {
	tests := map[string]string{
		"":          "enter a path",
		"a/b":       `must start with "/"`,
		"/a?x=1":    "can't hold a query",
		"/a#f":      "can't hold a query",
		"/**/a":     "last part",
		"/:":        "isn't a valid parameter",
		"/:1a":      "isn't a valid parameter",
		"/:id/:id":  "appears twice",
		"/a*":       "whole part",
		"/x/b*c/**": "whole part",
	}
	for p, want := range tests {
		_, err := CompilePattern(p)
		if err == nil || !strings.Contains(err.Error(), want) {
			t.Errorf("CompilePattern(%q) = %v, want %q", p, err, want)
		}
	}
}

func req(method, target string, header http.Header, body string) *Request {
	u, err := url.Parse(target)
	if err != nil {
		panic(err)
	}
	if header == nil {
		header = http.Header{}
	}
	return &Request{Method: method, Path: u.Path, Query: u.Query(), Header: header, Body: []byte(body)}
}

func rule(name, method, path string, conds ...Condition) Rule {
	return Rule{Name: name, Enabled: true, Match: Match{Method: method, Path: path, Conditions: conds}, Response: Response{Status: 201, Body: name}}
}

func compile(t *testing.T, rules ...Rule) *Compiled {
	t.Helper()
	w := New("Test")
	w.Rules = rules
	c, err := Compile(w)
	if err != nil {
		t.Fatalf("Compile: %v", err)
	}
	return c
}

func TestSelect(t *testing.T) {
	disabled := rule("disabled", "ANY", "/**")
	disabled.Enabled = false
	c := compile(t,
		disabled,
		rule("hdr-exists", "POST", "/hooks/*", Condition{Source: "header", Name: "x-signature", Op: "exists"}),
		rule("hdr-equals", "POST", "/hooks/*", Condition{Source: "header", Name: "X-Kind", Op: "equals", Value: "b"}),
		rule("query", "get", "/q", Condition{Source: "query", Name: "tag", Op: "equals", Value: "two"}),
		rule("body", "PUT", "/b", Condition{Source: "body", Op: "contains", Value: "failed"}),
		rule("json", "POST", "/j", Condition{Source: "json", Name: "data.items.1.id", Op: "equals", Value: "7"}),
		rule("json-obj", "POST", "/j", Condition{Source: "json", Name: "data", Op: "matches", Value: `^\{"items"`}),
		rule("regex", "", "/r/:id", Condition{Source: "header", Name: "User-Agent", Op: "matches", Value: `^Stripe/`}),
		rule("both", "POST", "/both",
			Condition{Source: "query", Name: "a", Op: "exists"},
			Condition{Source: "body", Op: "contains", Value: "x"}),
	)
	h := func(kv ...string) http.Header {
		out := http.Header{}
		for i := 0; i < len(kv); i += 2 {
			out.Add(kv[i], kv[i+1])
		}
		return out
	}
	tests := []struct {
		name string
		req  *Request
		want string // "" = default
	}{
		{"default", req("GET", "/nothing", nil, ""), ""},
		{"header exists", req("POST", "/hooks/stripe", h("X-Signature", "abc"), ""), "hdr-exists"},
		{"header equals second value", req("POST", "/hooks/x", h("X-Kind", "a", "X-Kind", "b"), ""), "hdr-equals"},
		{"header no match", req("POST", "/hooks/x", h("X-Kind", "c"), ""), ""},
		{"method mismatch", req("GET", "/hooks/x", h("X-Signature", "abc"), ""), ""},
		{"query repeat", req("GET", "/q?tag=one&tag=two", nil, ""), "query"},
		{"query missing", req("GET", "/q", nil, ""), ""},
		{"body contains", req("PUT", "/b", nil, `{"type":"payment.failed"}`), "body"},
		{"json path array", req("POST", "/j", nil, `{"data":{"items":[{"id":1},{"id":7}]}}`), "json"},
		{"json object as text", req("POST", "/j", nil, `{"data":{"items":[]}}`), "json-obj"},
		{"json invalid", req("POST", "/j", nil, `{"data":`), ""},
		{"json trailing data", req("POST", "/j", nil, `{"data":{"items":[1,{"id":7}]}} x`), ""},
		{"json out of range", req("POST", "/j", nil, `{"data":{"items":[{"id":7}]}}`), "json-obj"},
		{"regex any method", req("DELETE", "/r/5", h("User-Agent", "Stripe/1.0"), ""), "regex"},
		{"all conditions", req("POST", "/both?a=1", nil, "xyz"), "both"},
		{"one condition fails", req("POST", "/both?a=1", nil, "yz"), ""},
	}
	for _, tt := range tests {
		got := c.Select(tt.req)
		name := ""
		if got.Rule != nil {
			name = got.Rule.Name
		}
		if name != tt.want {
			t.Errorf("%s: matched %q, want %q", tt.name, name, tt.want)
		}
		if got.Rule == nil && got.Response.Status != 200 {
			t.Errorf("%s: default status %d", tt.name, got.Response.Status)
		}
	}
	if sel := c.Select(req("DELETE", "/r/abc", h("User-Agent", "Stripe/2"), "")); sel.Params["id"] != "abc" {
		t.Errorf("params = %v", sel.Params)
	}
	if got := c.Webhook().Rules[7].Match.Method; got != AnyMethod {
		t.Errorf("normalized method = %q", got)
	}
}

func TestFirstMatchWins(t *testing.T) {
	c := compile(t, rule("one", "POST", "/a"), rule("two", "ANY", "/**"))
	if got := c.Select(req("POST", "/a", nil, "")); got.Rule.Name != "one" {
		t.Errorf("got %q", got.Rule.Name)
	}
	if got := c.Select(req("GET", "/a", nil, "")); got.Rule.Name != "two" {
		t.Errorf("got %q", got.Rule.Name)
	}
}

func TestValidate(t *testing.T) {
	base := func() Webhook {
		w := New("Hooks")
		w.Rules = []Rule{rule("r", "POST", "/a")}
		return w
	}
	tests := []struct {
		name  string
		edit  func(w *Webhook)
		field string
		msg   string
	}{
		{"ok", func(*Webhook) {}, "", ""},
		{"no name", func(w *Webhook) { w.Name = "  " }, "name", "Give the webhook a name."},
		{"too many rules", func(w *Webhook) { w.Rules = make([]Rule, MaxRules+1) }, "rules", "at most"},
		{"default status", func(w *Webhook) { w.DefaultResponse.Status = 700 }, "status", "Default response: The status"},
		{"bad method", func(w *Webhook) { w.Rules[0].Match.Method = "PO ST" }, "method", `Rule 1 ("r"): "PO ST" isn't a valid HTTP method.`},
		{"bad path", func(w *Webhook) { w.Rules[0].Match.Path = "a" }, "path", "must start"},
		{"dup id", func(w *Webhook) {
			w.Rules = append(w.Rules, w.Rules[0])
			w.Rules[0].ID, w.Rules[1].ID = "x", "x"
		}, "id", "own id"},
		{"bad source", func(w *Webhook) { w.Rules[0].Match.Conditions = []Condition{{Source: "cookie", Op: "exists"}} }, "conditions.0.source", "condition 1: choose header"},
		{"no header name", func(w *Webhook) { w.Rules[0].Match.Conditions = []Condition{{Source: "header", Op: "exists"}} }, "conditions.0.name", "header name"},
		{"no json path", func(w *Webhook) { w.Rules[0].Match.Conditions = []Condition{{Source: "json", Op: "exists"}} }, "conditions.0.name", "JSON path"},
		{"bad op", func(w *Webhook) { w.Rules[0].Match.Conditions = []Condition{{Source: "body", Op: "startsWith"}} }, "conditions.0.op", "choose equals"},
		{"bad regex", func(w *Webhook) {
			w.Rules[0].Match.Conditions = []Condition{{Source: "body", Op: "matches", Value: "("}}
		}, "conditions.0.value", "regular expression"},
		{"too many conditions", func(w *Webhook) {
			w.Rules[0].Match.Conditions = make([]Condition, MaxConditions+1)
		}, "conditions", "at most"},
		{"delay", func(w *Webhook) { w.Rules[0].Response.DelayMs = MaxDelayMs + 1 }, "delayMs", "delay"},
		{"negative delay", func(w *Webhook) { w.Rules[0].Response.DelayMs = -1 }, "delayMs", "delay"},
		{"body", func(w *Webhook) { w.Rules[0].Response.Body = strings.Repeat("x", MaxBody+1) }, "body", "1 MiB"},
		{"header", func(w *Webhook) {
			w.Rules[0].Response.Headers = []model.KeyValue{{Key: "Bad Name", Enabled: true}, {Key: "ignored disabled", Enabled: false}}
		}, "headers", "valid header name"},
		{"disabled header ok", func(w *Webhook) {
			w.Rules[0].Response.Headers = []model.KeyValue{{Key: "bad name", Enabled: false}}
		}, "", ""},
	}
	for _, tt := range tests {
		w := base()
		tt.edit(&w)
		err := w.Normalize().Validate()
		if tt.field == "" {
			if err != nil {
				t.Errorf("%s: %v", tt.name, err)
			}
			continue
		}
		var ve *ValidationError
		if !errors.As(err, &ve) {
			t.Errorf("%s: err = %v", tt.name, err)
			continue
		}
		if ve.Field != tt.field || !strings.Contains(ve.Error(), tt.msg) {
			t.Errorf("%s: field %q, %q; want %q, %q", tt.name, ve.Field, ve.Error(), tt.field, tt.msg)
		}
	}
	if _, err := Compile(Webhook{}); err == nil {
		t.Error("Compile of an empty webhook should fail")
	}
}

func TestNormalize(t *testing.T) {
	w := Webhook{Name: " x ", Rules: []Rule{{Match: Match{Method: " post ", Path: " /a ", Conditions: []Condition{{Source: " Header ", Op: "EXISTS", Name: " X "}}}}}}
	n := w.Normalize()
	r := n.Rules[0]
	if n.Name != "x" || r.ID == "" || r.Match.Method != "POST" || r.Match.Path != "/a" || r.Response.Status != 200 || n.DefaultResponse.Status != 200 {
		t.Errorf("normalized = %+v", n)
	}
	if c := r.Match.Conditions[0]; c.Source != "header" || c.Op != "exists" || c.Name != "X" {
		t.Errorf("condition = %+v", c)
	}
	if w.Rules[0].ID != "" {
		t.Error("Normalize changed its input")
	}
	if New("a").DefaultResponse.Status != 200 {
		t.Error("default response")
	}
}

func fixed() []vars.Option {
	return []vars.Option{
		vars.WithClock(func() time.Time { return time.Unix(1700000000, 0) }),
		vars.WithRand(bytes.NewReader(bytes.Repeat([]byte{1}, 64))),
	}
}

func TestRender(t *testing.T) {
	r := req("POST", "/orders/42?b=2&a=1", http.Header{"X-Trace": {"t-1"}}, `{"id":"o\"1","n":5,"obj":{"k":true}}`)
	params := map[string]string{"id": "42"}
	tests := []struct {
		name    string
		resp    Response
		body    string
		ctype   string
		headers map[string]string
	}{
		{
			name:  "json escapes inside strings",
			resp:  Response{Status: 202, Body: `{"echo": "{{$request.json.id}}", "n": {{$request.json.n}}, "obj": {{ $request.json.obj }}}`},
			body:  `{"echo": "o\"1", "n": 5, "obj": {"k":true}}`,
			ctype: "application/json",
		},
		{
			name:  "request fields",
			resp:  Response{Status: 200, Headers: []model.KeyValue{{Key: "Content-Type", Value: "text/plain", Enabled: true}}, Body: "{{$request.method}} {{$request.path}} {{$request.url}} {{$request.query.a}} {{$request.header.x-trace}} {{$request.params.id}}"},
			body:  "POST /orders/42 /orders/42?a=1&b=2 1 t-1 42",
			ctype: "text/plain",
		},
		{
			name:  "missing known and unknown refs",
			resp:  Response{Status: 200, Headers: []model.KeyValue{{Key: "content-type", Value: "text/plain", Enabled: true}}, Body: "[{{$request.query.zz}}][{{$request.json.nope}}][{{$request.params.x}}][{{token}}][{{$request.}}][{{bad"},
			body:  "[][][][{{token}}][{{$request.}}][{{bad",
			ctype: "text/plain",
		},
		{
			name:  "dynamic",
			resp:  Response{Status: 200, Body: "{{$timestamp}}"},
			body:  "1700000000",
			ctype: "application/json",
		},
		{
			name:  "body echo not re-expanded",
			resp:  Response{Status: 200, Headers: []model.KeyValue{{Key: "Content-Type", Value: "text/plain", Enabled: true}}, Body: "{{$request.body}}"},
			body:  `{"id":"o\"1","n":5,"obj":{"k":true}}`,
			ctype: "text/plain",
		},
		{
			name:    "header templates and disabled headers",
			resp:    Response{Status: 200, Headers: []model.KeyValue{{Key: "X-Echo", Value: "{{$request.header.X-Trace}}", Enabled: true}, {Key: "X-Off", Value: "1"}, {Key: "", Value: "x", Enabled: true}}},
			body:    "",
			ctype:   "",
			headers: map[string]string{"X-Echo": "t-1", "X-Off": ""},
		},
		{"sniff xml", Response{Status: 200, Body: "<a/>"}, "<a/>", "application/xml", nil},
		{"sniff html", Response{Status: 200, Body: "<!DOCTYPE html><p>"}, "<!DOCTYPE html><p>", "text/html; charset=utf-8", nil},
		{"sniff text", Response{Status: 200, Body: "ok"}, "ok", "text/plain; charset=utf-8", nil},
		{"nested braces", Response{Status: 200, Body: "{{{{$request.method}}"}, "{{POST", "text/plain; charset=utf-8", nil},
	}
	for _, tt := range tests {
		got := Render(tt.resp, r, params, fixed()...)
		if string(got.Body) != tt.body {
			t.Errorf("%s: body = %q, want %q", tt.name, got.Body, tt.body)
		}
		if ct := got.Header.Get("Content-Type"); ct != tt.ctype {
			t.Errorf("%s: content type = %q, want %q", tt.name, ct, tt.ctype)
		}
		if got.Status != tt.resp.Status {
			t.Errorf("%s: status %d", tt.name, got.Status)
		}
		for k, v := range tt.headers {
			if got.Header.Get(k) != v {
				t.Errorf("%s: header %s = %q, want %q", tt.name, k, got.Header.Get(k), v)
			}
		}
	}
	// A body echoed inside a JSON string stays valid JSON, and a sender's
	// own {{refs}} aren't expanded.
	evil := req("POST", "/", nil, `"{{$request.method}}`)
	got := Render(Response{Status: 200, Body: `{"b": "{{$request.body}}"}`}, evil, nil)
	if string(got.Body) != `{"b": "\"{{$request.method}}"}` {
		t.Errorf("evil body = %s", got.Body)
	}
	// Path without query.
	got = Render(Response{Status: 200, Body: "{{$request.url}}"}, req("GET", "/p", nil, ""), nil)
	if string(got.Body) != "/p" {
		t.Errorf("url = %s", got.Body)
	}
	// A failing random source keeps the reference.
	got = Render(Response{Status: 200, Body: "{{$randomUUID}}"}, req("GET", "/", nil, ""), nil, vars.WithRand(bytes.NewReader(nil)))
	if string(got.Body) != "{{$randomUUID}}" {
		t.Errorf("uuid on failure = %s", got.Body)
	}
}

func TestJSONPathRoot(t *testing.T) {
	r := req("POST", "/", nil, `[1, "two"]`)
	if v, ok := r.JSONPath(""); !ok || v != `[1,"two"]` {
		t.Errorf("root = %q %v", v, ok)
	}
	if v, ok := r.JSONPath("1"); !ok || v != "two" {
		t.Errorf("index = %q %v", v, ok)
	}
	if _, ok := r.JSONPath("x"); ok {
		t.Error("string key on array")
	}
	if _, ok := r.JSONPath("0.x"); ok {
		t.Error("descend into number")
	}
}
