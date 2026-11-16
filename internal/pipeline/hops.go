package pipeline

import (
	"encoding/base64"
	"strings"

	"pakpos/internal/core/model"
)

// BinarySecretNote replaces a binary request body that held a secret, which
// can't be shown with {{name}} in its place.
const BinarySecretNote = "Not shown: this binary body contains a secret value."

// MaskHops returns copies of hops with every secret value (see SendSecrets)
// replaced by {{name}}: in URLs, header names and values, errors and text
// bodies. A truncated body that ends partway into a secret has that part
// masked too. A binary body holding a secret is dropped, with
// BinarySecretNote saying why.
func MaskHops(hops []model.Hop, values []SecretValue) []model.Hop {
	out := make([]model.Hop, len(hops))
	for i, h := range hops {
		if len(values) == 0 {
			out[i] = h
			continue
		}
		h.URL = maskText(h.URL, values)
		h.Error = maskText(h.Error, values)
		h.RequestHeaders = maskRows(h.RequestHeaders, values)
		h.ResponseHeaders = maskRows(h.ResponseHeaders, values)
		h.RequestBody, h.RequestBodyNote = maskBody(h, values)
		if h.RequestBodyNote == BinarySecretNote {
			h.RequestBodyEncoding = model.EncodingUTF8
		}
		out[i] = h
	}
	return out
}

func maskText(s string, values []SecretValue) string {
	for _, sv := range values {
		s = strings.ReplaceAll(s, sv.Value, "{{"+sv.Name+"}}")
	}
	return s
}

func maskRows(rows []model.KeyValue, values []SecretValue) []model.KeyValue {
	out := make([]model.KeyValue, len(rows))
	for i, r := range rows {
		r.Key, r.Value = maskText(r.Key, values), maskText(r.Value, values)
		out[i] = r
	}
	return out
}

func maskBody(h model.Hop, values []SecretValue) (body, note string) {
	if h.RequestBodyEncoding != model.EncodingBase64 {
		body = maskText(h.RequestBody, values)
		if h.RequestBodyTruncated {
			body = maskCutOff(body, values)
		}
		return body, h.RequestBodyNote
	}
	raw, err := base64.StdEncoding.DecodeString(h.RequestBody)
	if err != nil {
		return "", BinarySecretNote
	}
	for _, sv := range values {
		if strings.Contains(string(raw), sv.Value) {
			return "", BinarySecretNote
		}
	}
	return h.RequestBody, h.RequestBodyNote
}

// maskCutOff masks the start of a secret left at the very end of a body that
// was cut short (MinSecretLength characters or more of it).
func maskCutOff(body string, values []SecretValue) string {
	for _, sv := range values {
		for n := len(sv.Value) - 1; n >= MinSecretLength; n-- {
			if strings.HasSuffix(body, sv.Value[:n]) {
				return body[:len(body)-n] + "{{" + sv.Name + "}}"
			}
		}
	}
	return body
}
