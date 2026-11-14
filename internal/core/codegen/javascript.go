package codegen

import (
	"strings"

	"pakpos/internal/core/curl"
	"pakpos/internal/core/model"
)

func genCurl(s *spec) string { return curl.Generate(s.req) + "\n" }

// jsWriter collects the lines of a JavaScript (ES module, Node 20+) program.
type jsWriter struct {
	imports []string
	pre     []string // statements before the request (form building)
}

func (w *jsWriter) importOnce(line string) {
	for _, l := range w.imports {
		if l == line {
			return
		}
	}
	w.imports = append(w.imports, line)
}

// jsHeaderEntries writes headers (and basic auth) as object properties at indent.
func jsHeaderEntries(headers []model.KeyValue, basic *model.Auth, indent string) []string {
	var out []string
	for _, h := range headers {
		out = append(out, indent+jsString(h.Key)+": "+jsString(h.Value)+",")
	}
	if basic != nil {
		out = append(out, indent+`"Authorization": "Basic " + Buffer.from(`+jsString(basicPair(basic))+`).toString("base64"),`)
	}
	return out
}

// jsHeaderPairs writes headers (and basic auth) as [name, value] pairs, for
// repeated names.
func jsHeaderPairs(headers []model.KeyValue, basic *model.Auth, indent string) []string {
	var out []string
	for _, h := range headers {
		out = append(out, indent+"["+jsString(h.Key)+", "+jsString(h.Value)+"],")
	}
	if basic != nil {
		out = append(out, indent+`["Authorization", "Basic " + Buffer.from(`+jsString(basicPair(basic))+`).toString("base64")],`)
	}
	return out
}

// form writes the statements that build a FormData named form.
func (w *jsWriter) form(parts []model.FormField) {
	w.pre = append(w.pre, "const form = new FormData();")
	for _, p := range parts {
		key := jsString(p.Key)
		switch {
		case p.Kind == model.FormFile:
			w.importOnce(`import { openAsBlob } from "node:fs";`)
			opts := ""
			if p.ContentType != "" {
				opts = ", { type: " + jsString(p.ContentType) + " }"
			}
			w.pre = append(w.pre, "form.append("+key+", await openAsBlob("+jsString(p.FilePath)+opts+"), "+jsString(fileName(p.FilePath))+");")
		case p.ContentType != "":
			w.pre = append(w.pre, "form.append("+key+", new Blob(["+jsString(p.Value)+"], { type: "+jsString(p.ContentType)+" }));")
		default:
			w.pre = append(w.pre, "form.append("+key+", "+jsString(p.Value)+");")
		}
	}
}

// urlSearchParams is a URLSearchParams expression for the urlencoded rows.
func urlSearchParams(fields []model.KeyValue, indent string) string {
	if len(fields) == 0 {
		return "new URLSearchParams()"
	}
	var b strings.Builder
	if unique(fields, false) {
		b.WriteString("new URLSearchParams({\n")
		for _, f := range fields {
			b.WriteString(indent + "  " + jsString(f.Key) + ": " + jsString(f.Value) + ",\n")
		}
		b.WriteString(indent + "})")
		return b.String()
	}
	b.WriteString("new URLSearchParams([\n")
	for _, f := range fields {
		b.WriteString(indent + "  [" + jsString(f.Key) + ", " + jsString(f.Value) + "],\n")
	}
	b.WriteString(indent + "])")
	return b.String()
}

func (w *jsWriter) program(call []string) string {
	var b strings.Builder
	for _, l := range w.imports {
		b.WriteString(l + "\n")
	}
	if len(w.imports) > 0 {
		b.WriteString("\n")
	}
	for _, l := range w.pre {
		b.WriteString(l + "\n")
	}
	if len(w.pre) > 0 {
		b.WriteString("\n")
	}
	for _, l := range call {
		b.WriteString(l + "\n")
	}
	return b.String()
}

// genFetch writes a Node.js (20+) ES module using the built-in fetch.
func genFetch(s *spec) string {
	w := &jsWriter{}
	var opts []string
	if s.method != "GET" {
		opts = append(opts, `  method: `+jsString(s.method)+`,`)
	}
	if len(s.headers) > 0 || s.basic != nil {
		if s.uniqueHeaders() {
			opts = append(opts, "  headers: {")
			opts = append(opts, jsHeaderEntries(s.headers, s.basic, "    ")...)
			opts = append(opts, "  },")
		} else {
			opts = append(opts, "  headers: [")
			opts = append(opts, jsHeaderPairs(s.headers, s.basic, "    ")...)
			opts = append(opts, "  ],")
		}
	}
	switch s.body.Type {
	case model.BodyRaw:
		if s.body.Language == model.LangJSON {
			if _, ok := parseJSON(s.body.Raw); ok {
				opts = append(opts, "  body: JSON.stringify("+indentJSON(s.body.Raw, "  ")+"),")
				break
			}
		}
		opts = append(opts, "  body: "+jsText(s.body.Raw)+",")
	case model.BodyURLEncoded:
		opts = append(opts, "  body: "+urlSearchParams(s.fields, "  ")+",")
	case model.BodyFormData:
		w.form(s.parts)
		opts = append(opts, "  body: form,")
	case model.BodyBinary:
		w.importOnce(`import { openAsBlob } from "node:fs";`)
		opts = append(opts, "  body: await openAsBlob("+jsString(s.body.BinaryPath)+"),")
	}

	var call []string
	if len(opts) == 0 {
		call = append(call, "const response = await fetch("+jsString(s.url)+");")
	} else {
		call = append(call, "const response = await fetch("+jsString(s.url)+", {")
		call = append(call, opts...)
		call = append(call, "});")
	}
	call = append(call, "", "console.log(response.status);", "console.log(await response.text());")
	return w.program(call)
}

// genAxios writes a Node.js (20+) ES module using axios.
func genAxios(s *spec) string {
	w := &jsWriter{}
	w.importOnce(`import axios from "axios";`)
	opts := []string{
		"  method: " + jsString(strings.ToLower(s.method)) + ",",
		"  url: " + jsString(s.url) + ",",
	}
	headers := s.mergedHeaders("axios")
	if len(headers) > 0 {
		opts = append(opts, "  headers: {")
		opts = append(opts, jsHeaderEntries(headers, nil, "    ")...)
		opts = append(opts, "  },")
	}
	if s.basic != nil {
		opts = append(opts, "  auth: {",
			"    username: "+jsString(s.basic.Username)+",",
			"    password: "+jsString(s.basic.Password)+",",
			"  },")
	}
	switch s.body.Type {
	case model.BodyRaw:
		if s.body.Language == model.LangJSON {
			if _, ok := parseJSON(s.body.Raw); ok {
				opts = append(opts, "  data: "+indentJSON(s.body.Raw, "  ")+",")
				break
			}
		}
		opts = append(opts, "  data: "+jsText(s.body.Raw)+",")
	case model.BodyURLEncoded:
		opts = append(opts, "  data: "+urlSearchParams(s.fields, "  ")+",")
	case model.BodyFormData:
		w.form(s.parts)
		opts = append(opts, "  data: form,")
	case model.BodyBinary:
		w.importOnce(`import { createReadStream } from "node:fs";`)
		opts = append(opts, "  data: createReadStream("+jsString(s.body.BinaryPath)+"),")
	}
	// Show error responses like any other instead of throwing.
	opts = append(opts, "  validateStatus: () => true,")

	call := []string{"const response = await axios.request({"}
	call = append(call, opts...)
	call = append(call, "});", "", "console.log(response.status);", "console.log(response.data);")
	return w.program(call)
}
