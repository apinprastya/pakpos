package codegen

import (
	"strings"

	"pakpos/internal/core/model"
	"pakpos/internal/core/urlx"
)

// genPHP writes a PHP script using the cURL extension.
func genPHP(s *spec) string {
	const in1, in2 = "    ", "        "
	opts := []string{
		"CURLOPT_URL => " + phpString(s.url),
		"CURLOPT_RETURNTRANSFER => true",
	}
	switch {
	case s.method == "HEAD" && !s.hasBody():
		opts = append(opts, "CURLOPT_NOBODY => true")
	case s.method != "GET" || s.hasBody():
		opts = append(opts, "CURLOPT_CUSTOMREQUEST => "+phpString(s.method))
	}
	if len(s.headers) > 0 {
		h := "CURLOPT_HTTPHEADER => [\n"
		for _, row := range s.headers {
			line := row.Key + ": " + row.Value
			if row.Value == "" {
				line = row.Key + ";" // cURL sends "Name;" as an empty header
			}
			h += in2 + phpString(line) + ",\n"
		}
		opts = append(opts, h+in1+"]")
	}
	if s.basic != nil {
		opts = append(opts, "CURLOPT_HTTPAUTH => CURLAUTH_BASIC", "CURLOPT_USERPWD => "+phpString(basicPair(s.basic)))
	}
	if s.digest != nil {
		opts = append(opts, "CURLOPT_HTTPAUTH => CURLAUTH_DIGEST", "CURLOPT_USERPWD => "+phpString(s.digest.Username+":"+s.digest.Password))
	}
	if s.ntlm != nil {
		user := s.ntlm.Username
		if s.ntlm.Domain != "" {
			user = s.ntlm.Domain + `\` + user
		}
		opts = append(opts, "CURLOPT_HTTPAUTH => CURLAUTH_NTLM", "CURLOPT_USERPWD => "+phpString(user+":"+s.ntlm.Password))
	}

	switch s.body.Type {
	case model.BodyRaw:
		opts = append(opts, "CURLOPT_POSTFIELDS => "+phpString(s.body.Raw))
	case model.BodyURLEncoded:
		if unique(s.fields, false) {
			f := "CURLOPT_POSTFIELDS => http_build_query([\n"
			for _, row := range s.fields {
				f += in2 + phpString(row.Key) + " => " + phpString(row.Value) + ",\n"
			}
			opts = append(opts, f+in1+"])")
		} else {
			opts = append(opts, "CURLOPT_POSTFIELDS => "+phpString(urlx.EncodeWireQuery(s.fields)))
		}
	case model.BodyFormData:
		f := "CURLOPT_POSTFIELDS => [\n"
		seen := map[string]bool{}
		for _, p := range s.parts {
			if seen[p.Key] {
				s.warn("PHP's cURL takes one form field per name, so the repeated field %q was left out.", p.Key)
				continue
			}
			seen[p.Key] = true
			value := phpString(p.Value)
			if p.Kind == model.FormFile {
				ct := p.ContentType
				if ct == "" {
					ct = "application/octet-stream"
				}
				value = "new CURLFile(" + phpString(p.FilePath) + ", " + phpString(ct) + ", " + phpString(fileName(p.FilePath)) + ")"
			} else if p.ContentType != "" {
				s.warn("PHP's cURL can't set a content type on the text field %q, so it was left out.", p.Key)
			}
			f += in2 + phpString(p.Key) + " => " + value + ",\n"
		}
		opts = append(opts, f+in1+"]")
	case model.BodyBinary:
		opts = append(opts, "CURLOPT_POSTFIELDS => file_get_contents("+phpString(s.body.BinaryPath)+")")
	}

	var b strings.Builder
	b.WriteString("<?php\n\n$curl = curl_init();\n\ncurl_setopt_array($curl, [\n")
	for _, o := range opts {
		b.WriteString(in1 + o + ",\n")
	}
	b.WriteString("]);\n\n$response = curl_exec($curl);\n\n")
	b.WriteString("if ($response === false) {\n")
	b.WriteString(in1 + "echo 'Request failed: ' . curl_error($curl) . PHP_EOL;\n")
	b.WriteString("} else {\n")
	b.WriteString(in1 + "echo curl_getinfo($curl, CURLINFO_RESPONSE_CODE) . PHP_EOL;\n")
	b.WriteString(in1 + "echo $response . PHP_EOL;\n")
	b.WriteString("}\n")
	return b.String()
}
