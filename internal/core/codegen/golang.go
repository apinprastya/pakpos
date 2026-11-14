package codegen

import (
	"fmt"
	"go/format"
	"sort"
	"strings"

	"pakpos/internal/core/model"
)

var goMethods = map[string]string{
	"GET": "http.MethodGet", "POST": "http.MethodPost", "PUT": "http.MethodPut", "PATCH": "http.MethodPatch",
	"DELETE": "http.MethodDelete", "HEAD": "http.MethodHead", "OPTIONS": "http.MethodOptions",
}

const goCheck = "if err != nil {\nlog.Fatal(err)\n}\n"

// genGo writes a Go program using net/http, formatted with gofmt.
func genGo(s *spec) string {
	imports := map[string]bool{"fmt": true, "io": true, "log": true, "net/http": true}
	var b strings.Builder
	bodyArg := "nil"

	switch s.body.Type {
	case model.BodyRaw:
		imports["strings"] = true
		b.WriteString("body := strings.NewReader(" + goString(s.body.Raw) + ")\n\n")
		bodyArg = "body"
	case model.BodyURLEncoded:
		imports["strings"], imports["net/url"] = true, true
		b.WriteString("form := url.Values{}\n")
		for _, f := range s.fields {
			b.WriteString("form.Add(" + goString(f.Key) + ", " + goString(f.Value) + ")\n")
		}
		b.WriteString("body := strings.NewReader(form.Encode())\n\n")
		bodyArg = "body"
	case model.BodyFormData:
		imports["bytes"], imports["mime/multipart"] = true, true
		b.WriteString("var body bytes.Buffer\nform := multipart.NewWriter(&body)\n")
		for _, p := range s.parts {
			goPart(&b, p, imports)
		}
		b.WriteString("if err := form.Close(); err != nil {\nlog.Fatal(err)\n}\n\n")
		bodyArg = "&body"
	case model.BodyBinary:
		imports["os"] = true
		b.WriteString("body, err := os.Open(" + goString(s.body.BinaryPath) + ")\n" + goCheck + "defer body.Close()\n\n")
		bodyArg = "body"
	}

	method, ok := goMethods[s.method]
	if !ok {
		method = goString(s.method)
	}
	b.WriteString("req, err := http.NewRequest(" + method + ", " + goString(s.url) + ", " + bodyArg + ")\n" + goCheck)

	seen := map[string]bool{}
	for _, h := range s.headers {
		if strings.EqualFold(h.Key, "Host") {
			b.WriteString("req.Host = " + goString(h.Value) + "\n")
			continue
		}
		fn := "Set"
		if seen[strings.ToLower(h.Key)] {
			fn = "Add"
		}
		seen[strings.ToLower(h.Key)] = true
		b.WriteString("req.Header." + fn + "(" + goString(h.Key) + ", " + goString(h.Value) + ")\n")
	}
	if s.body.Type == model.BodyFormData && s.header("Content-Type") == "" {
		b.WriteString("req.Header.Set(\"Content-Type\", form.FormDataContentType())\n")
	}
	if s.basic != nil {
		b.WriteString("req.SetBasicAuth(" + goString(s.basic.Username) + ", " + goString(s.basic.Password) + ")\n")
	}
	b.WriteString("\nresp, err := http.DefaultClient.Do(req)\n" + goCheck + "defer resp.Body.Close()\n\n")
	b.WriteString("data, err := io.ReadAll(resp.Body)\n" + goCheck)
	b.WriteString("fmt.Println(resp.Status)\nfmt.Println(string(data))\n")

	names := make([]string, 0, len(imports))
	for n := range imports {
		names = append(names, n)
	}
	sort.Strings(names)
	var src strings.Builder
	src.WriteString("package main\n\nimport (\n")
	for _, n := range names {
		fmt.Fprintf(&src, "%q\n", n)
	}
	src.WriteString(")\n\nfunc main() {\n" + b.String() + "}\n")
	out, err := format.Source([]byte(src.String()))
	if err != nil {
		return src.String()
	}
	return string(out)
}

var dispositionEscaper = strings.NewReplacer(`\`, `\\`, `"`, `\"`)

func goPart(b *strings.Builder, p model.FormField, imports map[string]bool) {
	name := dispositionEscaper.Replace(p.Key)
	if p.Kind != model.FormFile && p.ContentType == "" {
		b.WriteString("if err := form.WriteField(" + goString(p.Key) + ", " + goString(p.Value) + "); err != nil {\nlog.Fatal(err)\n}\n")
		return
	}
	b.WriteString("{\n")
	if p.Kind == model.FormFile {
		imports["os"] = true
		b.WriteString("file, err := os.Open(" + goString(p.FilePath) + ")\n" + goCheck + "defer file.Close()\n")
	}
	switch {
	case p.Kind == model.FormFile && p.ContentType == "":
		b.WriteString("part, err := form.CreateFormFile(" + goString(p.Key) + ", " + goString(fileName(p.FilePath)) + ")\n")
	default:
		imports["net/textproto"] = true
		disp := `form-data; name="` + name + `"`
		if p.Kind == model.FormFile {
			disp += `; filename="` + dispositionEscaper.Replace(fileName(p.FilePath)) + `"`
		}
		b.WriteString("part, err := form.CreatePart(textproto.MIMEHeader{\n" +
			"\"Content-Disposition\": {" + goString(disp) + "},\n" +
			"\"Content-Type\": {" + goString(p.ContentType) + "},\n" +
			"})\n")
	}
	b.WriteString(goCheck)
	if p.Kind == model.FormFile {
		b.WriteString("if _, err := io.Copy(part, file); err != nil {\nlog.Fatal(err)\n}\n")
	} else {
		b.WriteString("if _, err := io.WriteString(part, " + goString(p.Value) + "); err != nil {\nlog.Fatal(err)\n}\n")
	}
	b.WriteString("}\n")
}
