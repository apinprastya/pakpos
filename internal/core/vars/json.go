package vars

import (
	"bytes"
	"encoding/json"
	"strings"
)

// ResolveJSON is Resolve for a JSON document: a value substituted inside a
// string literal is JSON-escaped (quotes, backslashes, control characters),
// so "name": "{{name}}" stays valid whatever name holds. A reference outside
// a string literal is inserted as is, so "count": {{count}} or "user":
// {{user}} can supply a number, a boolean or a whole JSON value. The document
// does not need to be valid JSON; string literals are found by their quotes.
func (r *Resolver) ResolveJSON(s string) (string, []string, error) {
	unresolved := map[string]struct{}{}
	out, err := r.expandJSON(s, unresolved)
	if err != nil {
		return "", nil, err
	}
	return out, sortedNames(unresolved), nil
}

func (r *Resolver) expandJSON(s string, unresolved map[string]struct{}) (string, error) {
	if !strings.Contains(s, "{{") {
		return s, nil
	}
	var b strings.Builder
	inString := false
	start := 0
	flush := func(end int) error {
		var escape func(string) string
		if inString {
			escape = jsonEscape
		}
		out, err := r.expandEscaped(s[start:end], escape, nil, unresolved)
		b.WriteString(out)
		return err
	}
	for i := 0; i < len(s); i++ {
		switch {
		case inString && s[i] == '\\':
			i++ // skip the escaped character, which may be a quote
		case s[i] == '"':
			if err := flush(i); err != nil {
				return "", err
			}
			b.WriteByte('"')
			start = i + 1
			inString = !inString
		}
	}
	if err := flush(len(s)); err != nil {
		return "", err
	}
	return b.String(), nil
}

// jsonEscape returns s as the contents of a JSON string literal (without
// the quotes). HTML characters are left alone.
func jsonEscape(s string) string {
	var buf bytes.Buffer
	enc := json.NewEncoder(&buf)
	enc.SetEscapeHTML(false)
	_ = enc.Encode(s) // encoding a string cannot fail
	out := buf.Bytes()
	return string(out[1 : len(out)-2]) // drop the quotes and Encode's newline
}

// JSONEscape is the escaping ResolveJSON applies to values inside string
// literals, for callers that need to recognise a value as it was sent.
func JSONEscape(s string) string { return jsonEscape(s) }
