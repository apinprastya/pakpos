package pipeline

import (
	"bytes"
	"encoding/base64"
	"errors"
	"slices"
	"strings"
	"unicode/utf8"

	"pakpos/internal/core/model"
	"pakpos/internal/store/fsstore"
)

// MinSecretLength is the shortest secret value looked for in examples:
// shorter values match too much ordinary text to be useful.
const MinSecretLength = 4

// SecretValue is a secret variable with its stored value. It must never be
// written, logged or returned to the UI.
type SecretValue struct {
	Name  string
	Value string
}

// ErrBinarySecret is returned by MaskExample when a secret is in a body that
// isn't text, so it can't be replaced with {{name}}.
var ErrBinarySecret = errors.New("a secret value is in a binary response body")

// SecretValues returns the secret variables visible to the saved request
// requestID with the environment envID, that have a stored value: from the
// globals, the request's collection and the environment (shadowed ones
// too, since their value could still show up). locked is true when some
// couldn't be read because the secret store is locked; the list is then
// incomplete.
func (s *Session) SecretValues(requestID, envID string) (values []SecretValue, locked bool) {
	chain := s.Chain(model.Request{ID: requestID}, "")
	scopes := s.BuildScopes(collectionOf(chain), s.Environment(envID))
	for _, sc := range scopes.List {
		for _, v := range sc.Variables {
			if v.Secret && v.Enabled && len(v.Value) >= MinSecretLength {
				values = append(values, SecretValue{Name: v.Key, Value: v.Value})
			}
		}
	}
	// Longest first, so a value containing another is replaced whole.
	slices.SortStableFunc(values, func(a, b SecretValue) int { return len(b.Value) - len(a.Value) })
	return values, len(scopes.Locked) > 0
}

// exampleBody returns the example's body as bytes (decoded when base64) and
// whether it is valid UTF-8 text.
func exampleBody(r fsstore.ExampleResponse) ([]byte, bool) {
	if r.Encoding == model.EncodingBase64 {
		b, err := base64.StdEncoding.DecodeString(r.Body)
		if err != nil {
			return []byte(r.Body), utf8.ValidString(r.Body)
		}
		return b, utf8.Valid(b)
	}
	return []byte(r.Body), true
}

// eachString calls f on every string of ex that is saved: the stored
// request as written, the response headers and the body (a base64 body is
// handled by the callers). f may change the string.
func eachString(ex *fsstore.Example, f func(*string)) {
	kvs := func(list []model.KeyValue) {
		for i := range list {
			f(&list[i].Key)
			f(&list[i].Value)
		}
	}
	r := &ex.Request
	for _, p := range []*string{&r.Name, &r.URL, &r.Body.Raw, &r.Body.BinaryPath,
		&r.Auth.Username, &r.Auth.Password, &r.Auth.Token, &r.Auth.Prefix, &r.Auth.APIKey, &r.Auth.APIValue} {
		f(p)
	}
	kvs(r.PathParams)
	kvs(r.Query)
	kvs(r.Headers)
	kvs(r.Body.URLEncoded)
	for i := range r.Body.FormData {
		ff := &r.Body.FormData[i]
		f(&ff.Key)
		f(&ff.Value)
		f(&ff.FilePath)
		f(&ff.ContentType)
	}
	kvs(ex.Response.Headers)
	f(&ex.Response.StatusText)
	f(&ex.Response.ContentType)
}

// ScanExample returns the names of the secrets whose value appears in ex
// (exact substring), in the order of values, without duplicates.
func ScanExample(ex fsstore.Example, values []SecretValue) []string {
	body, _ := exampleBody(ex.Response)
	var texts []string
	copied := copyExample(ex)
	eachString(&copied, func(p *string) { texts = append(texts, *p) })
	var found []string
	for _, sv := range values {
		hit := bytes.Contains(body, []byte(sv.Value)) ||
			slices.ContainsFunc(texts, func(t string) bool { return strings.Contains(t, sv.Value) })
		if hit && !slices.Contains(found, sv.Name) {
			found = append(found, sv.Name)
		}
	}
	return found
}

// MaskExample returns a copy of ex with every secret value replaced by
// {{name}}. A base64 body is replaced in its decoded text and stays base64;
// one that isn't valid UTF-8 and holds a secret returns ErrBinarySecret.
func MaskExample(ex fsstore.Example, values []SecretValue) (fsstore.Example, error) {
	out := copyExample(ex)
	body, text := exampleBody(out.Response)
	replaced := string(body)
	for _, sv := range values {
		if strings.Contains(replaced, sv.Value) {
			if !text {
				return fsstore.Example{}, ErrBinarySecret
			}
			replaced = strings.ReplaceAll(replaced, sv.Value, "{{"+sv.Name+"}}")
		}
	}
	if replaced != string(body) {
		if out.Response.Encoding == model.EncodingBase64 {
			out.Response.Body = base64.StdEncoding.EncodeToString([]byte(replaced))
		} else {
			out.Response.Body = replaced
		}
		out.Response.Size = int64(len(replaced))
	}
	eachString(&out, func(p *string) {
		for _, sv := range values {
			*p = strings.ReplaceAll(*p, sv.Value, "{{"+sv.Name+"}}")
		}
	})
	return out, nil
}

// copyExample deep-copies the slices of ex, so masking never changes the input.
func copyExample(ex fsstore.Example) fsstore.Example {
	r := &ex.Request
	r.PathParams = slices.Clone(r.PathParams)
	r.Query = slices.Clone(r.Query)
	r.Headers = slices.Clone(r.Headers)
	r.Body.URLEncoded = slices.Clone(r.Body.URLEncoded)
	r.Body.FormData = slices.Clone(r.Body.FormData)
	ex.Response.Headers = slices.Clone(ex.Response.Headers)
	return ex
}
