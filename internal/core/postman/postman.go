// Package postman reads files exported from Postman (collections in the
// v2.0 and v2.1 formats, environments and globals) and converts them to
// Pakpos's model. It does no I/O: callers pass the file's bytes and write
// the result to a workspace themselves.
//
// What Pakpos can't represent is dropped or approximated, and each such
// case is reported as a Warning (an auth type it lacks, a GraphQL body sent
// as JSON, a script API it doesn't have...). Nothing is ever sent or run.
package postman

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"strings"

	"pakpos/internal/core/model"
)

// MaxFileSize is the largest file Parse accepts.
const MaxFileSize = 64 << 20

// Kind says what a file holds.
type Kind string

// Kinds of files.
const (
	KindCollection  Kind = "collection"
	KindEnvironment Kind = "environment"
	KindGlobals     Kind = "globals"
)

// Errors returned by Parse; Message turns them into sentences for the user.
var (
	ErrNotJSON       = errors.New("not a JSON file")
	ErrNotPostman    = errors.New("not a Postman export")
	ErrV1Collection  = errors.New("collection v1 format")
	ErrDataDump      = errors.New("postman data dump")
	ErrTooLarge      = errors.New("file too large")
	ErrUnsupportedV2 = errors.New("unsupported collection schema")
)

// Message is the user-facing sentence for an error from Parse.
func Message(err error) string {
	switch {
	case errors.Is(err, ErrTooLarge):
		return fmt.Sprintf("This file is over %d MB, too large to import.", MaxFileSize>>20)
	case errors.Is(err, ErrNotJSON):
		return "This file isn't valid JSON. Export the collection from Postman again and pick the .json file."
	case errors.Is(err, ErrV1Collection):
		return "This collection uses Postman's old v1 format. In Postman, export it again as Collection v2.1 and import that file."
	case errors.Is(err, ErrDataDump):
		return "This is a Postman data dump. Export each collection (as Collection v2.1) and environment from Postman, and import those files."
	case errors.Is(err, ErrUnsupportedV2):
		return "This collection uses a Postman format this version of Pakpos can't read. Export it again as Collection v2.1."
	case errors.Is(err, ErrNotPostman):
		return "This file isn't a Postman collection, environment or globals export."
	default:
		return "Couldn't read the file: " + err.Error()
	}
}

// Warning is something that didn't import as Postman would run it. Where
// names the item ("Orders / Create order"), or is "" for the whole file.
type Warning struct {
	Where   string `json:"where"`
	Message string `json:"message"`
}

// File is a converted export: a collection, or the variables of an
// environment or of the globals.
type File struct {
	Kind Kind
	Name string
	// Collection is set for KindCollection.
	Collection *Collection
	// Variables of an environment or the globals. A secret keeps its value
	// here (it must go to the secret store, never to a workspace file).
	Variables []model.Variable
	// Warnings is never nil.
	Warnings []Warning
}

// Collection is a converted collection. Secret variables keep their values
// (see File.Variables).
type Collection struct {
	Auth model.Auth
	// Headers are sent with every request below (Pakpos only; imports
	// leave them empty, exports copy them into each request).
	Headers   []model.KeyValue
	Variables []model.Variable
	Scripts   model.Scripts
	Items     []Item
}

// Item is a folder or a request; exactly one of the two is set.
type Item struct {
	Folder  *Folder
	Request *Request
}

// Folder is a converted folder.
type Folder struct {
	Name    string
	Auth    model.Auth
	Headers []model.KeyValue
	Scripts model.Scripts
	Items   []Item
}

// Request is a converted request with its saved responses.
type Request struct {
	Request  model.Request
	Examples []Example
}

// Example is a saved response (Postman's "examples"). Request is the
// request it was saved for (the item's own request when the export has none).
type Example struct {
	Name        string
	Request     model.Request
	StatusCode  int
	StatusText  string
	Headers     []model.KeyValue
	ContentType string
	Kind        model.BodyKind
	Body        string
	// Encoding is how Body is written ("" or utf8 = text, base64 = binary).
	Encoding model.BodyEncoding
}

// MaxExampleBody is the largest example body kept; larger ones are dropped
// with a warning (the workspace refuses them too).
const MaxExampleBody = 1 << 20

// Options control the conversion.
type Options struct {
	// GuessSecrets marks variables whose names look like credentials
	// (token, password, apiKey...) as secret, so their values go to the
	// secret store rather than into workspace files.
	GuessSecrets bool
}

// Parse reads a Postman export.
func Parse(data []byte, opts Options) (File, error) {
	if len(data) > MaxFileSize {
		return File{}, ErrTooLarge
	}
	data = bytes.TrimPrefix(data, []byte("\xef\xbb\xbf"))
	var p probe
	if err := json.Unmarshal(data, &p); err != nil {
		var syn *json.SyntaxError
		if errors.As(err, &syn) || !json.Valid(data) {
			return File{}, ErrNotJSON
		}
		return File{}, fmt.Errorf("%w: %v", ErrNotPostman, err)
	}
	c := &converter{opts: opts, warnings: []Warning{}}
	switch {
	case p.Info != nil && p.Item != nil:
		schema := strings.ToLower(string(p.Info.Schema))
		if schema != "" && !strings.Contains(schema, "/v2.") && !strings.Contains(schema, "/v2/") {
			return File{}, ErrUnsupportedV2
		}
		var col pmCollection
		if err := json.Unmarshal(data, &col); err != nil {
			return File{}, fmt.Errorf("%w: %v", ErrNotPostman, err)
		}
		return c.collection(col), nil
	case p.Requests != nil && p.Order != nil:
		return File{}, ErrV1Collection
	case p.Collections != nil && p.Environments != nil:
		return File{}, ErrDataDump
	case p.Values != nil:
		var vf pmVariableFile
		if err := json.Unmarshal(data, &vf); err != nil {
			return File{}, fmt.Errorf("%w: %v", ErrNotPostman, err)
		}
		return c.variableFile(vf), nil
	}
	return File{}, ErrNotPostman
}

type converter struct {
	opts     Options
	warnings []Warning
	// dynamic collects unsupported {{$name}} references, in first-seen order.
	dynamic     []string
	dynamicSeen map[string]bool
	// files lists requests whose bodies point at local files.
	files []string
	// plainCreds lists the items whose auth holds a literal credential.
	plainCreds []string
	// plainVars lists variables that look like credentials but stay plain.
	plainVars []string
}

func (c *converter) warn(where, format string, args ...any) {
	c.warnings = append(c.warnings, Warning{Where: where, Message: fmt.Sprintf(format, args...)})
}

func (c *converter) variableFile(vf pmVariableFile) File {
	kind := KindEnvironment
	if strings.EqualFold(string(vf.Scope), "globals") {
		kind = KindGlobals
	}
	name := cleanName(string(vf.Name))
	if name == "" {
		name = "Imported environment"
		if kind == KindGlobals {
			name = "Globals"
		}
	}
	vs := c.variables(vf.Values, true)
	c.checkDynamic("", vs)
	c.finish()
	return File{Kind: kind, Name: name, Variables: vs, Warnings: c.warnings}
}

func (c *converter) collection(pc pmCollection) File {
	name := cleanName(string(pc.Info.Name))
	if name == "" {
		name = "Imported collection"
	}
	col := &Collection{
		Auth:      c.auth("", pc.Auth, false),
		Variables: c.variables(pc.Variable, false),
		Scripts:   c.scripts("", pc.Event),
	}
	if col.Auth.Type == model.AuthInherit {
		col.Auth = model.Auth{Type: model.AuthNone}
	}
	c.checkDynamic("", col.Variables)
	col.Items = c.items("", pc.Item)
	c.finish()
	return File{Kind: KindCollection, Name: name, Collection: col, Warnings: c.warnings}
}

// finish adds the warnings collected over the whole file.
func (c *converter) finish() {
	if len(c.dynamic) > 0 {
		c.warn("", "Uses dynamic variables Pakpos doesn't have: %s. They stay as written and won't resolve when sent.",
			strings.Join(c.dynamic, ", "))
	}
	if len(c.files) > 0 {
		c.warn("", "%s send files from the computer the collection was exported on. Pick the files again before sending: %s.",
			plural(len(c.files), "request", "requests"), listSome(c.files, 5))
	}
	if len(c.plainVars) > 0 {
		c.warn("", "Variables that look like credentials will be written to workspace files as plain text: %s. Mark them secret before you commit or share the workspace.",
			listSome(c.plainVars, 5))
	}
	if len(c.plainCreds) > 0 {
		c.warn("", "Auth settings hold credentials as plain text, which will be written to workspace files: %s. Move them to secret variables before you commit or share the workspace.",
			listSome(c.plainCreds, 5))
	}
}

func (c *converter) items(parent string, list []pmItem) []Item {
	out := make([]Item, 0, len(list))
	for _, it := range list {
		name := cleanName(string(it.Name))
		if it.Request == nil && it.Item != nil {
			if name == "" {
				name = "New folder"
			}
			where := join(parent, name)
			f := &Folder{
				Name:    name,
				Auth:    c.auth(where, it.Auth, true),
				Scripts: c.scripts(where, it.Event),
			}
			f.Items = c.items(where, *it.Item)
			out = append(out, Item{Folder: f})
			continue
		}
		if it.Request == nil {
			c.warn(join(parent, name), "This item has no request and wasn't imported.")
			continue
		}
		if name == "" {
			name = "Untitled request"
		}
		where := join(parent, name)
		req := c.request(where, *it.Request, it.Behavior)
		req.Name = name
		req.Scripts = c.scripts(where, it.Event)
		r := &Request{Request: req}
		for _, resp := range it.Response {
			if ex, ok := c.example(where, req, resp); ok {
				r.Examples = append(r.Examples, ex)
			}
		}
		out = append(out, Item{Request: r})
	}
	return out
}

// request converts a request. A request without auth inherits its
// parent's, as in Postman.
func (c *converter) request(where string, pr pmRequest, b *pmBehavior) model.Request {
	req := model.Request{
		Method:  strings.ToUpper(strings.TrimSpace(string(pr.Method))),
		Headers: keyValues(pr.Header),
		Auth:    c.auth(where, pr.Auth, true),
		Body:    model.Body{Type: model.BodyNone},
	}
	if req.Method == "" {
		req.Method = "GET"
	}
	if pr.URL != nil {
		req.URL, req.Query, req.PathParams = convertURL(*pr.URL)
	}
	if pr.Body != nil {
		req.Body = c.body(where, *pr.Body, req.Headers)
	}
	if b != nil {
		if b.FollowRedirects.set {
			v := b.FollowRedirects.value
			req.Settings.FollowRedirects = &v
		}
		if b.StrictSSL.set {
			v := b.StrictSSL.value
			req.Settings.VerifyTLS = &v
		}
		if b.MaxRedirects != nil && *b.MaxRedirects >= 0 {
			v := *b.MaxRedirects
			req.Settings.MaxRedirects = &v
		}
	}
	c.checkDynamic(where, req)
	return req
}

func keyValues(list []pmKeyValue) []model.KeyValue {
	out := []model.KeyValue{}
	for _, kv := range list {
		if kv.Key == "" && kv.Value == "" {
			continue
		}
		out = append(out, model.KeyValue{Key: string(kv.Key), Value: string(kv.Value), Enabled: !bool(kv.Disabled)})
	}
	return out
}

func (c *converter) scripts(where string, events []pmEvent) model.Scripts {
	var pre, test []string
	for _, e := range events {
		if e.Disabled || e.Script == nil {
			continue
		}
		src := strings.TrimRight(strings.Join(e.Script.Exec, "\n"), "\n\t ")
		if strings.TrimSpace(src) == "" {
			continue
		}
		switch strings.ToLower(string(e.Listen)) {
		case "prerequest":
			pre = append(pre, src)
		case "test":
			test = append(test, src)
		}
	}
	s := model.Scripts{PreRequest: strings.Join(pre, "\n\n"), Test: strings.Join(test, "\n\n")}
	c.checkScript(where, s.PreRequest+"\n"+s.Test)
	return s
}

func (c *converter) variables(list []pmVariable, envFile bool) []model.Variable {
	out := []model.Variable{}
	for _, v := range list {
		key := strings.TrimSpace(string(v.Key))
		if key == "" {
			continue
		}
		enabled := !bool(v.Disabled)
		if envFile && v.Enabled != nil {
			enabled = bool(*v.Enabled)
		}
		secret := strings.EqualFold(string(v.Type), "secret") || (c.opts.GuessSecrets && LooksSecret(key))
		if !secret && LooksSecret(key) && v.Value != "" && !strings.Contains(string(v.Value), "{{") {
			c.plainVars = append(c.plainVars, key)
		}
		out = append(out, model.Variable{Key: key, Value: string(v.Value), Enabled: enabled, Secret: secret})
	}
	return out
}

func cleanName(s string) string { return strings.Join(strings.Fields(s), " ") }

func join(parent, name string) string {
	if parent == "" {
		return name
	}
	return parent + " / " + name
}

func plural(n int, one, many string) string {
	if n == 1 {
		return "1 " + one
	}
	return fmt.Sprintf("%d %s", n, many)
}

// listSome joins up to n names, adding "and N more".
func listSome(names []string, n int) string {
	if len(names) <= n {
		return strings.Join(names, ", ")
	}
	return fmt.Sprintf("%s and %d more", strings.Join(names[:n], ", "), len(names)-n)
}
