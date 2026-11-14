package codegen

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"strconv"
	"strings"
	"unicode/utf8"
)

// jsonNode is a parsed JSON value that keeps key order and number text.
type jsonNode struct {
	kind byte // 'o' object, 'a' array, 's' string, 'n' number, 'b' bool, 'z' null
	keys []string
	vals []*jsonNode
	str  string
	num  string
	bool bool
}

// parseJSON parses a JSON document for writing it as a literal in code. It
// fails for invalid JSON (e.g. a body with an unquoted {{variable}}) and for
// numbers that would change in a float64, so those bodies stay strings.
func parseJSON(text string) (*jsonNode, bool) {
	if !json.Valid([]byte(text)) {
		return nil, false
	}
	dec := json.NewDecoder(strings.NewReader(text))
	dec.UseNumber()
	n, err := readJSON(dec)
	if err != nil {
		return nil, false
	}
	return n, true
}

var errPrecision = fmt.Errorf("number would lose precision")

func readJSON(dec *json.Decoder) (*jsonNode, error) {
	tok, err := dec.Token()
	if err != nil {
		return nil, err
	}
	switch t := tok.(type) {
	case json.Delim:
		n := &jsonNode{kind: 'a'}
		if t == '{' {
			n.kind = 'o'
		}
		for dec.More() {
			if n.kind == 'o' {
				k, err := dec.Token()
				if err != nil {
					return nil, err
				}
				n.keys = append(n.keys, k.(string))
			}
			v, err := readJSON(dec)
			if err != nil {
				return nil, err
			}
			n.vals = append(n.vals, v)
		}
		_, err := dec.Token() // closing delimiter
		return n, err
	case string:
		return &jsonNode{kind: 's', str: t}, nil
	case json.Number:
		if !exactNumber(string(t)) {
			return nil, errPrecision
		}
		return &jsonNode{kind: 'n', num: string(t)}, nil
	case bool:
		return &jsonNode{kind: 'b', bool: t}, nil
	default:
		return &jsonNode{kind: 'z'}, nil
	}
}

// exactNumber reports whether a JSON number survives a float64 round trip
// in JavaScript (at most 15 significant digits).
func exactNumber(s string) bool {
	mant := s
	if i := strings.IndexAny(mant, "eE"); i >= 0 {
		mant = mant[:i]
	}
	digits := strings.TrimLeft(strings.NewReplacer("-", "", ".", "").Replace(mant), "0")
	return len(digits) <= 15
}

// indentJSON re-indents valid JSON with two spaces, each line after the
// first prefixed with prefix.
func indentJSON(text, prefix string) string {
	var b bytes.Buffer
	if err := json.Indent(&b, []byte(strings.TrimSpace(text)), prefix, "  "); err != nil {
		return text
	}
	return b.String()
}

// writePython writes n as a Python literal, nested at indent.
func writePython(w io.StringWriter, n *jsonNode, indent string) {
	inner := indent + "    "
	switch n.kind {
	case 'o', 'a':
		opening, closing := "[", "]"
		if n.kind == 'o' {
			opening, closing = "{", "}"
		}
		if len(n.vals) == 0 {
			_, _ = w.WriteString(opening + closing)
			return
		}
		_, _ = w.WriteString(opening + "\n")
		for i, v := range n.vals {
			_, _ = w.WriteString(inner)
			if n.kind == 'o' {
				_, _ = w.WriteString(pyString(n.keys[i]) + ": ")
			}
			writePython(w, v, inner)
			_, _ = w.WriteString(",\n")
		}
		_, _ = w.WriteString(indent + closing)
	case 's':
		_, _ = w.WriteString(pyString(n.str))
	case 'n':
		_, _ = w.WriteString(n.num)
	case 'b':
		if n.bool {
			_, _ = w.WriteString("True")
		} else {
			_, _ = w.WriteString("False")
		}
	default:
		_, _ = w.WriteString("None")
	}
}

// jsString is a double-quoted JavaScript string literal (JSON escaping,
// which also escapes U+2028 and U+2029).
func jsString(s string) string {
	var b bytes.Buffer
	enc := json.NewEncoder(&b)
	enc.SetEscapeHTML(false)
	_ = enc.Encode(s)
	return strings.TrimSuffix(b.String(), "\n")
}

// jsTemplate is a JavaScript template literal, for multi-line text. It
// can't hold \r (template literals turn CRLF into LF).
func jsTemplate(s string) string {
	return "`" + strings.NewReplacer(`\`, `\\`, "`", "\\`", "${", "\\${").Replace(s) + "`"
}

// jsText picks a template literal for multi-line text, a string otherwise.
func jsText(s string) string {
	if strings.Contains(s, "\n") && !strings.Contains(s, "\r") && utf8.ValidString(s) {
		return jsTemplate(s)
	}
	return jsString(s)
}

// pyString is a double-quoted Python 3 string literal.
func pyString(s string) string {
	var b strings.Builder
	b.WriteByte('"')
	for _, r := range s {
		switch r {
		case '\\':
			b.WriteString(`\\`)
		case '"':
			b.WriteString(`\"`)
		case '\n':
			b.WriteString(`\n`)
		case '\r':
			b.WriteString(`\r`)
		case '\t':
			b.WriteString(`\t`)
		default:
			if r < 0x20 || r == 0x7f || r == utf8.RuneError {
				fmt.Fprintf(&b, `\x%02x`, r)
				continue
			}
			b.WriteRune(r)
		}
	}
	b.WriteByte('"')
	return b.String()
}

// javaString is a double-quoted Java string literal. Control characters use
// octal escapes: \uXXXX escapes are decoded before parsing, so \u000a would
// end the line.
func javaString(s string) string {
	var b strings.Builder
	b.WriteByte('"')
	for _, r := range s {
		switch r {
		case '\\':
			b.WriteString(`\\`)
		case '"':
			b.WriteString(`\"`)
		case '\n':
			b.WriteString(`\n`)
		case '\r':
			b.WriteString(`\r`)
		case '\t':
			b.WriteString(`\t`)
		case '\b':
			b.WriteString(`\b`)
		case '\f':
			b.WriteString(`\f`)
		default:
			if r < 0x20 || r == 0x7f {
				fmt.Fprintf(&b, `\%03o`, r)
				continue
			}
			b.WriteRune(r)
		}
	}
	b.WriteByte('"')
	return b.String()
}

// goString is a Go string literal: a raw string for text with line breaks,
// quotes or backslashes when it can hold it, an interpreted one otherwise.
func goString(s string) string {
	if strings.ContainsAny(s, "\n\"\\") && !strings.ContainsAny(s, "`\r") && utf8.ValidString(s) && !hasControl(s) {
		return "`" + s + "`"
	}
	return strconv.Quote(s)
}

func hasControl(s string) bool {
	for _, r := range s {
		if (r < 0x20 && r != '\n' && r != '\t') || r == 0x7f {
			return true
		}
	}
	return false
}

// phpString is a single-quoted PHP string literal (only \ and ' are
// escaped), or a double-quoted one with escapes when s holds control
// characters other than a line break or tab.
func phpString(s string) string {
	if !hasControl(s) {
		return "'" + strings.NewReplacer(`\`, `\\`, `'`, `\'`).Replace(s) + "'"
	}
	var b strings.Builder
	b.WriteByte('"')
	for i := 0; i < len(s); i++ {
		switch c := s[i]; c {
		case '\\', '"', '$':
			b.WriteByte('\\')
			b.WriteByte(c)
		case '\n':
			b.WriteString(`\n`)
		case '\r':
			b.WriteString(`\r`)
		case '\t':
			b.WriteString(`\t`)
		default:
			if c < 0x20 || c == 0x7f {
				fmt.Fprintf(&b, `\x%02x`, c)
				continue
			}
			b.WriteByte(c)
		}
	}
	b.WriteByte('"')
	return b.String()
}
