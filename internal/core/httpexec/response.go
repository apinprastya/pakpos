package httpexec

import (
	"bytes"
	"compress/gzip"
	"encoding/base64"
	"encoding/json"
	"io"
	"mime"
	"net/http"
	"os"
	"sort"
	"strings"
	"time"
	"unicode/utf8"

	"pakpos/internal/core/model"
)

func newResponse(resp *http.Response) *model.Response {
	out := &model.Response{
		StatusCode:  resp.StatusCode,
		StatusText:  statusText(resp),
		Proto:       resp.Proto,
		Headers:     headerRows(resp.Header),
		Cookies:     cookies(resp.Cookies()),
		ContentType: resp.Header.Get("Content-Type"),
	}
	if resp.Request != nil && resp.Request.URL != nil {
		out.URL = resp.Request.URL.String()
	}
	return out
}

func statusText(resp *http.Response) string {
	// resp.Status is e.g. "200 OK"; prefer the server's reason phrase.
	if _, reason, ok := strings.Cut(resp.Status, " "); ok && reason != "" {
		return reason
	}
	return http.StatusText(resp.StatusCode)
}

func headerRows(h http.Header) []model.KeyValue {
	keys := make([]string, 0, len(h))
	for k := range h {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	rows := make([]model.KeyValue, 0, len(h))
	for _, k := range keys {
		for _, v := range h[k] {
			rows = append(rows, model.KeyValue{Key: k, Value: v, Enabled: true})
		}
	}
	return rows
}

var sameSiteNames = map[http.SameSite]string{
	http.SameSiteLaxMode:    "Lax",
	http.SameSiteStrictMode: "Strict",
	http.SameSiteNoneMode:   "None",
}

func cookies(cs []*http.Cookie) []model.Cookie {
	out := make([]model.Cookie, 0, len(cs))
	for _, c := range cs {
		mc := model.Cookie{
			Name: c.Name, Value: c.Value, Domain: c.Domain, Path: c.Path,
			MaxAge: c.MaxAge, HTTPOnly: c.HttpOnly, Secure: c.Secure,
			SameSite: sameSiteNames[c.SameSite],
		}
		if !c.Expires.IsZero() {
			mc.Expires = c.Expires.UTC().Format(time.RFC3339)
		}
		out = append(out, mc)
	}
	return out
}

// readBody reads up to MaxBodyInMemory bytes inline. If the body is larger,
// the full body is written to a temp file and Truncated/BodyPath are set.
func (e *Executor) readBody(resp *http.Response, out *model.Response) error {
	body, err := decodedBody(resp)
	if err != nil {
		return err
	}
	limit := e.settings.MaxBodyInMemory
	var buf bytes.Buffer
	n, err := io.CopyN(&buf, body, limit+1)
	if err != nil && err != io.EOF {
		return err
	}

	data := buf.Bytes()
	size := n
	if n > limit {
		path, total, err := e.spill(data, body)
		if err != nil {
			return err
		}
		data = data[:limit]
		size = total
		out.Truncated = true
		out.BodyPath = path
	}

	out.Size = size
	out.Kind = detectKind(out.ContentType, data)
	out.Body, out.Encoding = encodeBody(out.Kind, data, out.Truncated)
	return nil
}

// decodedBody gunzips the body when the server compressed it but the
// transport did not (which happens when the user sets Accept-Encoding).
func decodedBody(resp *http.Response) (io.Reader, error) {
	if resp.Uncompressed || !strings.EqualFold(resp.Header.Get("Content-Encoding"), "gzip") {
		return resp.Body, nil
	}
	return gzip.NewReader(resp.Body)
}

func (e *Executor) spill(head []byte, rest io.Reader) (string, int64, error) {
	f, err := os.CreateTemp(e.settings.TempDir, "pakpos-response-*")
	if err != nil {
		return "", 0, err
	}
	defer f.Close()
	if _, err := f.Write(head); err != nil {
		_ = os.Remove(f.Name())
		return "", 0, err
	}
	n, err := io.Copy(f, rest)
	if err != nil {
		_ = os.Remove(f.Name())
		return "", 0, err
	}
	return f.Name(), int64(len(head)) + n, nil
}

// detectKind picks a viewer hint from the Content-Type, falling back to sniffing.
func detectKind(contentType string, body []byte) model.BodyKind {
	if len(body) == 0 {
		return model.KindEmpty
	}
	mt, _, err := mime.ParseMediaType(contentType)
	if err != nil || mt == "" {
		mt, _, _ = mime.ParseMediaType(http.DetectContentType(body))
		if mt == "text/plain" && looksLikeJSON(body) {
			return model.KindJSON
		}
	}
	switch {
	case mt == "application/json" || strings.HasSuffix(mt, "+json"):
		return model.KindJSON
	case mt == "text/html" || mt == "application/xhtml+xml":
		return model.KindHTML
	case mt == "application/xml" || mt == "text/xml" || strings.HasSuffix(mt, "+xml"):
		return model.KindXML
	case strings.HasPrefix(mt, "image/"):
		return model.KindImage
	case strings.HasPrefix(mt, "text/"), mt == "application/javascript",
		mt == "application/x-www-form-urlencoded", mt == "application/x-ndjson":
		return model.KindText
	default:
		return model.KindBinary
	}
}

func looksLikeJSON(b []byte) bool {
	t := bytes.TrimSpace(b)
	return len(t) > 0 && (t[0] == '{' || t[0] == '[') && json.Valid(t)
}

// encodeBody returns text inline when it is valid UTF-8 and of a textual
// kind; everything else is base64. A truncated body may end mid-rune, so up
// to 3 trailing bytes of an incomplete rune are dropped from the text.
func encodeBody(kind model.BodyKind, data []byte, truncated bool) (string, model.BodyEncoding) {
	textual := kind != model.KindImage && kind != model.KindBinary
	if textual {
		if n, ok := validUTF8Prefix(data, truncated); ok {
			return string(data[:n]), model.EncodingUTF8
		}
	}
	return base64.StdEncoding.EncodeToString(data), model.EncodingBase64
}

// validUTF8Prefix returns the length of data to keep as text and whether it
// is valid UTF-8.
func validUTF8Prefix(data []byte, truncated bool) (int, bool) {
	if utf8.Valid(data) {
		return len(data), true
	}
	if !truncated {
		return 0, false
	}
	for cut := 1; cut <= 3 && cut <= len(data); cut++ {
		if utf8.Valid(data[:len(data)-cut]) {
			return len(data) - cut, true
		}
	}
	return 0, false
}
