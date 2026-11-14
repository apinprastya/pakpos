package codegen

import (
	"regexp"
	"strconv"
	"strings"

	"pakpos/internal/core/model"
)

// browserForbidden are request headers browsers don't let fetch set.
var browserForbidden = map[string]bool{
	"accept-charset": true, "accept-encoding": true, "access-control-request-headers": true,
	"access-control-request-method": true, "connection": true, "content-length": true, "cookie": true,
	"cookie2": true, "date": true, "dnt": true, "expect": true, "host": true, "keep-alive": true,
	"origin": true, "referer": true, "te": true, "trailer": true, "transfer-encoding": true,
	"upgrade": true, "via": true,
}

func browserAllowed(name string) bool {
	n := strings.ToLower(name)
	return !browserForbidden[n] && !strings.HasPrefix(n, "proxy-") && !strings.HasPrefix(n, "sec-")
}

var nonIdent = regexp.MustCompile(`[^A-Za-z0-9]+`)

// fileVar is a JavaScript variable name for the file of a form field.
func fileVar(key string, used map[string]bool) string {
	parts := nonIdent.Split(key, -1)
	name := ""
	for _, p := range parts {
		if p == "" {
			continue
		}
		if name == "" {
			name = strings.ToLower(p[:1]) + p[1:]
		} else {
			name += strings.ToUpper(p[:1]) + p[1:]
		}
	}
	if name == "" || (name[0] >= '0' && name[0] <= '9') {
		name = "field" + name
	}
	name += "File"
	base, n := name, 2
	for used[name] {
		name = base + strconv.Itoa(n)
		n++
	}
	used[name] = true
	return name
}

// fileInput is the statement that reads a File from a file input, with a
// comment telling the user which file to pick.
func fileInput(varName, field, path string) []string {
	sel := "input[type=file]"
	if field != "" {
		sel += "[name='" + strings.NewReplacer(`\`, `\\`, "'", `\'`).Replace(field) + "']"
	}
	return []string{
		"// Pick " + strings.ReplaceAll(path, "\n", " ") + " with an <input type=\"file\"> on your page;",
		"// a browser can't read files from a path.",
		"const " + varName + " = document.querySelector(" + jsString(sel) + ").files[0];",
	}
}

// genFetchBrowser writes an ES module for browsers using fetch: no Node
// imports, files come from <input type="file">, and headers browsers
// refuse to set are left out.
func genFetchBrowser(s *spec) string {
	w := &jsWriter{}
	var headers []model.KeyValue
	for _, h := range s.headers {
		if !browserAllowed(h.Key) {
			s.warn("Browsers don't let fetch set the %s header, so it was left out.", h.Key)
			continue
		}
		headers = append(headers, h)
	}

	var opts []string
	if s.method != "GET" {
		opts = append(opts, `  method: `+jsString(s.method)+`,`)
	}
	if len(headers) > 0 || s.basic != nil {
		var entries []string
		if unique(headers, true) {
			opts = append(opts, "  headers: {")
			for _, h := range headers {
				entries = append(entries, "    "+jsString(h.Key)+": "+jsString(h.Value)+",")
			}
			if s.basic != nil {
				entries = append(entries, `    "Authorization": "Basic " + `+browserBase64(basicPair(s.basic))+",")
			}
			opts = append(opts, entries...)
			opts = append(opts, "  },")
		} else {
			opts = append(opts, "  headers: [")
			for _, h := range headers {
				entries = append(entries, "    ["+jsString(h.Key)+", "+jsString(h.Value)+"],")
			}
			if s.basic != nil {
				entries = append(entries, `    ["Authorization", "Basic " + `+browserBase64(basicPair(s.basic))+"],")
			}
			opts = append(opts, entries...)
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
		used := map[string]bool{}
		w.pre = append(w.pre, "const form = new FormData();")
		for _, p := range s.parts {
			key := jsString(p.Key)
			switch {
			case p.Kind == model.FormFile:
				v := fileVar(p.Key, used)
				w.pre = append(w.pre, fileInput(v, p.Key, p.FilePath)...)
				value := v
				if p.ContentType != "" {
					value = "new Blob([" + v + "], { type: " + jsString(p.ContentType) + " })"
				}
				w.pre = append(w.pre, "form.append("+key+", "+value+", "+v+".name);")
			case p.ContentType != "":
				w.pre = append(w.pre, "form.append("+key+", new Blob(["+jsString(p.Value)+"], { type: "+jsString(p.ContentType)+" }));")
			default:
				w.pre = append(w.pre, "form.append("+key+", "+jsString(p.Value)+");")
			}
		}
		opts = append(opts, "  body: form,")
	case model.BodyBinary:
		w.pre = append(w.pre, fileInput("file", "", s.body.BinaryPath)...)
		opts = append(opts, "  body: file,")
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

// browserBase64 is a base64 expression for text: btoa for ASCII, a UTF-8
// encoding first otherwise (btoa only takes Latin-1).
func browserBase64(text string) string {
	if isASCII(text) {
		return "btoa(" + jsString(text) + ")"
	}
	return "btoa(String.fromCharCode(...new TextEncoder().encode(" + jsString(text) + ")))"
}
