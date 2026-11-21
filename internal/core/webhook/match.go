package webhook

import (
	"bytes"
	"encoding/json"
	"net/http"
	"net/url"
	"regexp"
	"strconv"
	"strings"
	"sync"
)

// Request is the part of an incoming request rules look at.
type Request struct {
	Method string
	// Path is the decoded URL path (no query).
	Path   string
	Query  url.Values
	Header http.Header
	Body   []byte

	jsonOnce sync.Once
	jsonVal  any
	jsonOK   bool
}

// JSON returns the body parsed as JSON (numbers kept as json.Number), or
// false when it isn't JSON. It is parsed once.
func (r *Request) JSON() (any, bool) {
	r.jsonOnce.Do(func() {
		dec := json.NewDecoder(bytes.NewReader(r.Body))
		dec.UseNumber()
		var v any
		if dec.Decode(&v) != nil {
			return
		}
		if len(bytes.TrimSpace(r.Body[dec.InputOffset():])) > 0 {
			return // trailing data
		}
		r.jsonVal, r.jsonOK = v, true
	})
	return r.jsonVal, r.jsonOK
}

// JSONPath returns the value at a dot path (data.items.0.id) as text:
// strings as they are, other values as compact JSON. Numeric parts index
// arrays.
func (r *Request) JSONPath(path string) (string, bool) {
	v, ok := r.JSON()
	if !ok {
		return "", false
	}
	if path != "" {
		for part := range strings.SplitSeq(path, ".") {
			switch cur := v.(type) {
			case map[string]any:
				next, found := cur[part]
				if !found {
					return "", false
				}
				v = next
			case []any:
				i, err := strconv.Atoi(part)
				if err != nil || i < 0 || i >= len(cur) {
					return "", false
				}
				v = cur[i]
			default:
				return "", false
			}
		}
	}
	return jsonText(v), true
}

func jsonText(v any) string {
	if s, ok := v.(string); ok {
		return s
	}
	b, _ := json.Marshal(v) // values from Decode always marshal
	return string(b)
}

// Compiled is a webhook ready to answer requests. It is immutable and safe
// for concurrent use.
type Compiled struct {
	webhook Webhook
	rules   []compiledRule
}

type compiledRule struct {
	rule    *Rule
	pattern Pattern
	conds   []compiledCondition
}

type compiledCondition struct {
	Condition
	re *regexp.Regexp
}

// Compile normalizes and validates w and prepares its enabled rules.
func Compile(w Webhook) (*Compiled, error) {
	w = w.Normalize()
	if err := w.Validate(); err != nil {
		return nil, err
	}
	c := &Compiled{webhook: w}
	for i := range w.Rules {
		r := &c.webhook.Rules[i]
		if !r.Enabled {
			continue
		}
		p, _ := CompilePattern(r.Match.Path) // checked by Validate
		cr := compiledRule{rule: r, pattern: p}
		for _, cond := range r.Match.Conditions {
			cc, _ := compileCondition(cond)
			cr.conds = append(cr.conds, cc)
		}
		c.rules = append(c.rules, cr)
	}
	return c, nil
}

// Webhook returns the normalized webhook c was compiled from.
func (c *Compiled) Webhook() Webhook { return c.webhook }

// Selection is the answer to one request: the rule that matched (nil for
// the default response), its response and the path parameters it captured.
type Selection struct {
	Rule     *Rule
	Response Response
	Params   map[string]string
}

// Select picks the first enabled rule that matches req, or the default
// response.
func (c *Compiled) Select(req *Request) Selection {
	for _, cr := range c.rules {
		if cr.rule.Match.Method != AnyMethod && cr.rule.Match.Method != req.Method {
			continue
		}
		params, ok := cr.pattern.Match(req.Path)
		if !ok {
			continue
		}
		if !allHold(cr.conds, req) {
			continue
		}
		return Selection{Rule: cr.rule, Response: cr.rule.Response, Params: params}
	}
	return Selection{Response: c.webhook.DefaultResponse}
}

func allHold(conds []compiledCondition, req *Request) bool {
	for _, c := range conds {
		if !c.holds(req) {
			return false
		}
	}
	return true
}

// holds checks the condition against every value the source has (a header
// or query parameter can repeat): one is enough.
func (c compiledCondition) holds(req *Request) bool {
	var values []string
	switch c.Source {
	case SourceHeader:
		values = req.Header.Values(c.Name)
	case SourceQuery:
		values = req.Query[c.Name]
	case SourceBody:
		values = []string{string(req.Body)}
	case SourceJSON:
		if v, ok := req.JSONPath(c.Name); ok {
			values = []string{v}
		}
	}
	if c.Op == OpExists {
		return len(values) > 0
	}
	for _, v := range values {
		switch c.Op {
		case OpEquals:
			if v == c.Value {
				return true
			}
		case OpContains:
			if strings.Contains(v, c.Value) {
				return true
			}
		case OpMatches:
			if c.re.MatchString(v) {
				return true
			}
		}
	}
	return false
}

type condError struct{ field, msg string }

func compileCondition(c Condition) (compiledCondition, *condError) {
	out := compiledCondition{Condition: c}
	switch c.Source {
	case SourceHeader, SourceQuery, SourceJSON:
		if c.Name == "" {
			what := map[string]string{SourceHeader: "header name", SourceQuery: "query parameter", SourceJSON: "JSON path"}[c.Source]
			return out, &condError{"name", "enter the " + what + "."}
		}
	case SourceBody:
	default:
		return out, &condError{"source", "choose header, query, body or JSON."}
	}
	switch c.Op {
	case OpEquals, OpContains, OpExists:
	case OpMatches:
		re, err := regexp.Compile(c.Value)
		if err != nil {
			return out, &condError{"value", "the regular expression isn't valid: " + err.Error()}
		}
		out.re = re
	default:
		return out, &condError{"op", "choose equals, contains, exists or matches."}
	}
	return out, nil
}
