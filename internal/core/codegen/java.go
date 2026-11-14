package codegen

import (
	"regexp"
	"sort"
	"strings"

	"pakpos/internal/core/model"
)

// javaRestricted are headers java.net.http refuses to set.
var javaRestricted = map[string]bool{"connection": true, "content-length": true, "expect": true, "host": true, "upgrade": true}

const javaBoundary = "PakposFormBoundary7MA4YWxkTrZu0gW"

var javaSafeKey = regexp.MustCompile(`^[A-Za-z0-9._*-]+$`)

// javaText is a string expression, one + joined literal per line for
// multi-line text, continued at indent.
func javaText(s, indent string) string {
	ls := lines(s)
	if len(ls) <= 1 {
		return javaString(s)
	}
	parts := make([]string, len(ls))
	for i, l := range ls {
		parts[i] = javaString(l)
	}
	return strings.Join(parts, "\n"+indent+"+ ")
}

// genJava writes a Java 11+ program using java.net.http.HttpClient.
func genJava(s *spec) string {
	imports := map[string]bool{
		"java.net.URI": true, "java.net.http.HttpClient": true,
		"java.net.http.HttpRequest": true, "java.net.http.HttpResponse": true,
	}
	const in2, in4 = "        ", "                "
	var pre strings.Builder
	publisher := ""

	switch s.body.Type {
	case model.BodyRaw:
		pre.WriteString(in2 + "String body = " + javaText(s.body.Raw, in4) + ";\n\n")
		publisher = "HttpRequest.BodyPublishers.ofString(body)"
	case model.BodyURLEncoded:
		imports["java.net.URLEncoder"], imports["java.nio.charset.StandardCharsets"] = true, true
		enc := func(v string) string { return "URLEncoder.encode(" + javaString(v) + ", StandardCharsets.UTF_8)" }
		pre.WriteString(in2 + "String form = String.join(\"&\"")
		for _, f := range s.fields {
			key := javaString(f.Key+"=") + " + "
			if !javaSafeKey.MatchString(f.Key) {
				key = enc(f.Key) + " + \"=\" + "
			}
			pre.WriteString(",\n" + in4 + key + enc(f.Value))
		}
		pre.WriteString(");\n\n")
		publisher = "HttpRequest.BodyPublishers.ofString(form)"
	case model.BodyFormData:
		imports["java.io.ByteArrayOutputStream"], imports["java.nio.charset.StandardCharsets"] = true, true
		pre.WriteString(in2 + "String boundary = " + javaString(javaBoundary) + ";\n")
		pre.WriteString(in2 + "ByteArrayOutputStream form = new ByteArrayOutputStream();\n")
		for _, p := range s.parts {
			disp := `Content-Disposition: form-data; name="` + dispositionEscaper.Replace(p.Key) + `"`
			if p.Kind == model.FormFile {
				disp += `; filename="` + dispositionEscaper.Replace(fileName(p.FilePath)) + `"`
			}
			head := disp + "\r\n"
			ct := p.ContentType
			if ct == "" && p.Kind == model.FormFile {
				ct = "application/octet-stream"
			}
			if ct != "" {
				head += "Content-Type: " + ct + "\r\n"
			}
			head += "\r\n"
			if p.Kind == model.FormFile {
				imports["java.nio.file.Files"], imports["java.nio.file.Path"] = true, true
				pre.WriteString(in2 + "form.write((\"--\" + boundary + \"\\r\\n\"\n" + in4 + "+ " + javaString(head) + ").getBytes(StandardCharsets.UTF_8));\n")
				pre.WriteString(in2 + "form.write(Files.readAllBytes(Path.of(" + javaString(p.FilePath) + ")));\n")
				pre.WriteString(in2 + "form.write(\"\\r\\n\".getBytes(StandardCharsets.UTF_8));\n")
				continue
			}
			pre.WriteString(in2 + "form.write((\"--\" + boundary + \"\\r\\n\"\n" + in4 + "+ " + javaString(head) + "\n" +
				in4 + "+ " + javaString(p.Value+"\r\n") + ").getBytes(StandardCharsets.UTF_8));\n")
		}
		pre.WriteString(in2 + "form.write((\"--\" + boundary + \"--\\r\\n\").getBytes(StandardCharsets.UTF_8));\n\n")
		publisher = "HttpRequest.BodyPublishers.ofByteArray(form.toByteArray())"
	case model.BodyBinary:
		imports["java.nio.file.Path"] = true
		publisher = "HttpRequest.BodyPublishers.ofFile(Path.of(" + javaString(s.body.BinaryPath) + "))"
	}

	var chain []string
	chain = append(chain, ".uri(URI.create("+javaString(s.url)+"))")
	for _, h := range s.headers {
		if javaRestricted[strings.ToLower(h.Key)] {
			s.warn("Java's HttpClient doesn't allow setting the %s header, so it was left out.", h.Key)
			continue
		}
		chain = append(chain, ".header("+javaString(h.Key)+", "+javaString(h.Value)+")")
	}
	if s.body.Type == model.BodyFormData && s.header("Content-Type") == "" {
		chain = append(chain, `.header("Content-Type", "multipart/form-data; boundary=" + boundary)`)
	}
	if s.basic != nil {
		imports["java.util.Base64"], imports["java.nio.charset.StandardCharsets"] = true, true
		chain = append(chain, `.header("Authorization", "Basic " + Base64.getEncoder().encodeToString(`+
			javaString(basicPair(s.basic))+`.getBytes(StandardCharsets.UTF_8)))`)
	}
	switch {
	case publisher == "" && s.method == "GET":
		chain = append(chain, ".GET()")
	case publisher == "" && s.method == "DELETE":
		chain = append(chain, ".DELETE()")
	case publisher == "":
		chain = append(chain, ".method("+javaString(s.method)+", HttpRequest.BodyPublishers.noBody())")
	case s.method == "POST":
		chain = append(chain, ".POST("+publisher+")")
	case s.method == "PUT":
		chain = append(chain, ".PUT("+publisher+")")
	default:
		chain = append(chain, ".method("+javaString(s.method)+", "+publisher+")")
	}
	chain = append(chain, ".build();")

	names := make([]string, 0, len(imports))
	for n := range imports {
		names = append(names, n)
	}
	sort.Strings(names)
	var b strings.Builder
	for _, n := range names {
		b.WriteString("import " + n + ";\n")
	}
	b.WriteString("\npublic class Main {\n")
	b.WriteString("    public static void main(String[] args) throws Exception {\n")
	b.WriteString(in2 + "HttpClient client = HttpClient.newHttpClient();\n\n")
	b.WriteString(pre.String())
	b.WriteString(in2 + "HttpRequest request = HttpRequest.newBuilder()\n")
	for _, c := range chain {
		b.WriteString(in4 + c + "\n")
	}
	b.WriteString("\n" + in2 + "HttpResponse<String> response = client.send(request, HttpResponse.BodyHandlers.ofString());\n\n")
	b.WriteString(in2 + "System.out.println(response.statusCode());\n")
	b.WriteString(in2 + "System.out.println(response.body());\n")
	b.WriteString("    }\n}\n")
	return b.String()
}
