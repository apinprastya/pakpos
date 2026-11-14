package codegen

import (
	"strings"

	"pakpos/internal/core/model"
)

var pyMethods = map[string]bool{"GET": true, "POST": true, "PUT": true, "PATCH": true, "DELETE": true, "HEAD": true, "OPTIONS": true}

// pyText is a string literal, split into implicitly joined lines for
// multi-line text.
func pyText(s string) string {
	ls := lines(s)
	if len(ls) <= 1 {
		return pyString(s)
	}
	var b strings.Builder
	b.WriteString("(\n")
	for _, l := range ls {
		b.WriteString("    " + pyString(l) + "\n")
	}
	b.WriteString(")")
	return b.String()
}

// genPython writes a Python 3 script using requests.
func genPython(s *spec) string {
	var b strings.Builder
	b.WriteString("import requests\n\n")
	b.WriteString("url = " + pyString(s.url) + "\n")

	var args []string
	headers := s.mergedHeaders("requests")
	if len(headers) > 0 {
		b.WriteString("\nheaders = {\n")
		for _, h := range headers {
			b.WriteString("    " + pyString(h.Key) + ": " + pyString(h.Value) + ",\n")
		}
		b.WriteString("}\n")
		args = append(args, "headers=headers")
	}

	switch s.body.Type {
	case model.BodyRaw:
		if s.body.Language == model.LangJSON {
			if n, ok := parseJSON(s.body.Raw); ok {
				b.WriteString("\npayload = ")
				writePython(&b, n, "")
				b.WriteString("\n")
				args = append(args, "json=payload")
				break
			}
		}
		b.WriteString("\npayload = " + pyText(s.body.Raw) + "\n")
		if isASCII(s.body.Raw) {
			args = append(args, "data=payload")
		} else {
			// requests encodes str bodies as Latin-1.
			args = append(args, `data=payload.encode("utf-8")`)
		}
	case model.BodyURLEncoded:
		if unique(s.fields, false) {
			b.WriteString("\npayload = {\n")
			for _, f := range s.fields {
				b.WriteString("    " + pyString(f.Key) + ": " + pyString(f.Value) + ",\n")
			}
			b.WriteString("}\n")
		} else {
			b.WriteString("\npayload = [\n")
			for _, f := range s.fields {
				b.WriteString("    (" + pyString(f.Key) + ", " + pyString(f.Value) + "),\n")
			}
			b.WriteString("]\n")
		}
		args = append(args, "data=payload")
	case model.BodyFormData:
		b.WriteString("\nfiles = [\n")
		for _, p := range s.parts {
			var part string
			if p.Kind == model.FormFile {
				part = "(" + pyString(fileName(p.FilePath)) + ", open(" + pyString(p.FilePath) + `, "rb")`
			} else {
				part = "(None, " + pyString(p.Value)
			}
			if p.ContentType != "" {
				part += ", " + pyString(p.ContentType)
			}
			b.WriteString("    (" + pyString(p.Key) + ", " + part + ")),\n")
		}
		b.WriteString("]\n")
		args = append(args, "files=files")
	case model.BodyBinary:
		b.WriteString("\npayload = open(" + pyString(s.body.BinaryPath) + `, "rb")` + "\n")
		args = append(args, "data=payload")
	}
	if s.basic != nil {
		args = append(args, "auth=("+pyString(s.basic.Username)+", "+pyString(s.basic.Password)+")")
	}

	call := "requests." + strings.ToLower(s.method) + "(url"
	if !pyMethods[s.method] {
		call = "requests.request(" + pyString(s.method) + ", url"
	}
	for _, a := range args {
		call += ", " + a
	}
	b.WriteString("\nresponse = " + call + ")\n\n")
	b.WriteString("print(response.status_code)\n")
	b.WriteString("print(response.text)\n")
	return b.String()
}

func isASCII(s string) bool {
	for i := 0; i < len(s); i++ {
		if s[i] >= 0x80 {
			return false
		}
	}
	return true
}
