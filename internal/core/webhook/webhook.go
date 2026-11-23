// Package webhook is the rule engine of the webhook test server: the model
// stored in a workspace's webhooks/<slug>.yaml, path patterns, rule
// selection and response rendering. It does no I/O; internal/webhook runs
// the HTTP server and internal/tunnel the Cloudflare tunnel.
//
// Rules are tried top to bottom and the first enabled rule whose match
// holds answers the request; when none does, the webhook's default response
// does. Response templates see only the incoming request and the dynamic
// variables ({{$randomUUID}}, ...), never workspace variables: the server
// can be reached by anyone with its public URL.
package webhook

import (
	"fmt"
	"net/http"
	"regexp"
	"strings"

	"pakpos/internal/core/model"
)

// Limits checked by Validate.
const (
	// MaxBody is the largest response body a rule (or the default
	// response) may hold, in bytes.
	MaxBody = 1 << 20
	// MaxDelayMs is the longest delay before a reply.
	MaxDelayMs = 60_000
	// MaxRules is how many rules one webhook may have.
	MaxRules = 500
	// MaxConditions is how many conditions one rule may have.
	MaxConditions = 50
)

// AnyMethod matches every request method.
const AnyMethod = "ANY"

// Condition sources.
const (
	SourceHeader = "header"
	SourceQuery  = "query"
	SourceBody   = "body"
	SourceJSON   = "json"
)

// Condition operators.
const (
	OpEquals   = "equals"
	OpContains = "contains"
	OpExists   = "exists"
	OpMatches  = "matches"
)

// Webhook is the content of webhooks/<slug>.yaml.
type Webhook struct {
	ID   string `json:"id" yaml:"id"`
	Name string `json:"name" yaml:"name"`
	Seq  int    `json:"seq" yaml:"seq"`
	// DefaultResponse answers requests no rule matches.
	DefaultResponse Response `json:"defaultResponse" yaml:"defaultResponse"`
	Rules           []Rule   `json:"rules" yaml:"rules,omitempty"`
}

// Rule replies with Response to requests that satisfy Match.
type Rule struct {
	ID       string   `json:"id" yaml:"id"`
	Name     string   `json:"name" yaml:"name,omitempty"`
	Enabled  bool     `json:"enabled" yaml:"enabled"`
	Match    Match    `json:"match" yaml:"match"`
	Response Response `json:"response" yaml:"response"`
}

// Match selects requests: the method (or AnyMethod), the path pattern (see
// CompilePattern) and every condition must hold.
type Match struct {
	Method     string      `json:"method" yaml:"method"`
	Path       string      `json:"path" yaml:"path"`
	Conditions []Condition `json:"conditions" yaml:"conditions,omitempty"`
}

// Condition checks one part of the request. Name is the header or query
// parameter name, or the dot path for SourceJSON (data.items.0.id); it is
// ignored for SourceBody. Value is ignored for OpExists and is a Go regular
// expression for OpMatches.
type Condition struct {
	Source string `json:"source" yaml:"source"`
	Name   string `json:"name" yaml:"name,omitempty"`
	Op     string `json:"op" yaml:"op"`
	Value  string `json:"value" yaml:"value,omitempty"`
}

// Response is what a rule replies. Headers and Body may hold templates (see
// Render). A body without an enabled Content-Type header gets one by
// sniffing.
type Response struct {
	Status  int              `json:"status" yaml:"status"`
	Headers []model.KeyValue `json:"headers" yaml:"headers,omitempty"`
	Body    string           `json:"body" yaml:"body,omitempty"`
	DelayMs int              `json:"delayMs" yaml:"delayMs,omitempty"`
}

// New returns a webhook with the default response new webhooks get.
func New(name string) Webhook {
	return Webhook{ID: model.NewID(), Name: name, DefaultResponse: DefaultResponse()}
}

// DefaultResponse is a new webhook's default response: 200 {"ok": true}.
func DefaultResponse() Response {
	return Response{
		Status:  http.StatusOK,
		Headers: []model.KeyValue{{Key: "Content-Type", Value: "application/json", Enabled: true}},
		Body:    "{\"ok\": true}\n",
	}
}

// Normalize fills ids of new rules, upper-cases methods ("" becomes
// AnyMethod), lower-cases sources and operators, defaults a zero status to
// 200 and makes nil slices empty. It returns the normalized copy.
func (w Webhook) Normalize() Webhook {
	w.Name = strings.TrimSpace(w.Name)
	w.DefaultResponse = w.DefaultResponse.normalize()
	rules := make([]Rule, len(w.Rules))
	for i, r := range w.Rules {
		if r.ID == "" {
			r.ID = model.NewID()
		}
		r.Name = strings.TrimSpace(r.Name)
		r.Match.Method = strings.ToUpper(strings.TrimSpace(r.Match.Method))
		if r.Match.Method == "" {
			r.Match.Method = AnyMethod
		}
		r.Match.Path = strings.TrimSpace(r.Match.Path)
		conds := make([]Condition, len(r.Match.Conditions))
		for j, c := range r.Match.Conditions {
			c.Source = strings.ToLower(strings.TrimSpace(c.Source))
			c.Op = strings.ToLower(strings.TrimSpace(c.Op))
			c.Name = strings.TrimSpace(c.Name)
			conds[j] = c
		}
		r.Match.Conditions = conds
		r.Response = r.Response.normalize()
		rules[i] = r
	}
	w.Rules = rules
	return w
}

func (r Response) normalize() Response {
	if r.Status == 0 {
		r.Status = http.StatusOK
	}
	headers := make([]model.KeyValue, len(r.Headers))
	copy(headers, r.Headers)
	r.Headers = headers
	return r
}

// ValidationError is a problem Validate found. RuleID is "" for the
// webhook itself or its default response; Field names the field the UI
// marks ("name", "method", "path", "conditions.2.value", "status",
// "headers", "body", "delayMs").
type ValidationError struct {
	RuleID  string `json:"ruleId"`
	Field   string `json:"field"`
	Message string `json:"message"`
	where   string
}

func (e *ValidationError) Error() string {
	if e.where == "" {
		return e.Message
	}
	return e.where + ": " + e.Message
}

var tokenRE = regexp.MustCompile("^[!#$%&'*+.^_`|~0-9A-Za-z-]+$")

// Validate checks a normalized webhook and returns the first problem as a
// *ValidationError.
func (w Webhook) Validate() error {
	if w.Name == "" {
		return &ValidationError{Field: "name", Message: "Give the webhook a name."}
	}
	if len(w.Rules) > MaxRules {
		return &ValidationError{Field: "rules", Message: fmt.Sprintf("A webhook can have at most %d rules.", MaxRules)}
	}
	if err := w.DefaultResponse.validate("", "Default response"); err != nil {
		return err
	}
	seen := map[string]bool{}
	for i, r := range w.Rules {
		where := fmt.Sprintf("Rule %d", i+1)
		if r.Name != "" {
			where += fmt.Sprintf(" (%q)", r.Name)
		}
		fail := func(field, msg string) error {
			return &ValidationError{RuleID: r.ID, Field: field, Message: msg, where: where}
		}
		if r.ID == "" || seen[r.ID] {
			return fail("id", "Every rule needs its own id.")
		}
		seen[r.ID] = true
		if r.Match.Method != AnyMethod && !tokenRE.MatchString(r.Match.Method) {
			return fail("method", fmt.Sprintf("%q isn't a valid HTTP method.", r.Match.Method))
		}
		if _, err := CompilePattern(r.Match.Path); err != nil {
			return fail("path", err.Error())
		}
		if len(r.Match.Conditions) > MaxConditions {
			return fail("conditions", fmt.Sprintf("A rule can have at most %d conditions.", MaxConditions))
		}
		for j, c := range r.Match.Conditions {
			if _, err := compileCondition(c); err != nil {
				return fail(fmt.Sprintf("conditions.%d.%s", j, err.field), fmt.Sprintf("condition %d: %s", j+1, err.msg))
			}
		}
		if err := r.Response.validate(r.ID, where); err != nil {
			return err
		}
	}
	return nil
}

func (r Response) validate(ruleID, where string) error {
	fail := func(field, msg string) error {
		return &ValidationError{RuleID: ruleID, Field: field, Message: msg, where: where}
	}
	if r.Status < 100 || r.Status > 599 {
		return fail("status", "The status must be between 100 and 599.")
	}
	if r.DelayMs < 0 || r.DelayMs > MaxDelayMs {
		return fail("delayMs", fmt.Sprintf("The delay must be between 0 and %d ms.", MaxDelayMs))
	}
	if len(r.Body) > MaxBody {
		return fail("body", "The response body is larger than 1 MiB.")
	}
	for _, h := range r.Headers {
		if h.Enabled && !tokenRE.MatchString(h.Key) {
			return fail("headers", fmt.Sprintf("%q isn't a valid header name.", h.Key))
		}
	}
	return nil
}
