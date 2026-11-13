package httpexec

import (
	"context"
	"fmt"
	"io"
	"mime/multipart"
	"net/http"
	"net/textproto"
	"net/url"
	"os"
	"path/filepath"
	"strings"

	"pakpos/internal/core/auth"
	"pakpos/internal/core/model"
	"pakpos/internal/core/urlx"
)

var rawContentTypes = map[model.RawLanguage]string{
	model.LangJSON:       "application/json",
	model.LangXML:        "application/xml",
	model.LangHTML:       "text/html; charset=utf-8",
	model.LangJavaScript: "application/javascript",
	model.LangText:       "text/plain; charset=utf-8",
}

// Build converts a model.Request into an *http.Request bound to ctx.
//
//   - The query table (req.Query) is the source of truth for query params; the
//     query part of req.URL is ignored. Disabled rows are skipped.
//   - Path params are substituted, and "http://" is assumed if no scheme is given.
//   - A Content-Type matching the body type is set unless the user set one.
//   - User-Agent defaults to the executor's UserAgent unless the user set one.
//   - Auth is applied last; explicit user headers win (see package auth).
func (e *Executor) Build(ctx context.Context, req model.Request) (*http.Request, error) {
	method := strings.ToUpper(strings.TrimSpace(req.Method))
	if method == "" {
		method = http.MethodGet
	}

	target, err := buildURL(req)
	if err != nil {
		return nil, err
	}

	body, contentType, length, err := buildBody(req.Body)
	if err != nil {
		return nil, err
	}

	r, err := http.NewRequestWithContext(ctx, method, target.String(), body)
	if err != nil {
		if body != nil {
			_ = body.Close()
		}
		return nil, newError(KindInvalidRequest, err, "The request could not be built")
	}
	if length >= 0 && body != nil {
		r.ContentLength = length
	}

	for _, h := range req.Headers {
		key := strings.TrimSpace(h.Key)
		if !h.Enabled || key == "" {
			continue
		}
		r.Header.Add(key, h.Value)
	}
	if contentType != "" && r.Header.Get("Content-Type") == "" {
		r.Header.Set("Content-Type", contentType)
	}
	if r.Header.Get("User-Agent") == "" {
		r.Header.Set("User-Agent", e.settings.UserAgent)
	}

	if err := auth.Apply(r, req.Auth); err != nil {
		closeBody(r)
		return nil, newError(KindInvalidRequest, err, "Authorization settings are incomplete")
	}
	return r, nil
}

func closeBody(r *http.Request) {
	if r.Body != nil {
		_ = r.Body.Close()
	}
}

func buildURL(req model.Request) (*url.URL, error) {
	raw := strings.TrimSpace(req.URL)
	if raw == "" {
		return nil, newError(KindInvalidURL, nil, "Enter a URL to send the request")
	}
	base, _, _, _ := urlx.Split(raw)
	base = urlx.EnsureScheme(urlx.ApplyPathParams(base, req.PathParams))

	u, err := url.Parse(base)
	if err != nil {
		return nil, newError(KindInvalidURL, err, "The URL is not valid")
	}
	if u.Scheme != "http" && u.Scheme != "https" {
		return nil, newError(KindInvalidURL, nil, "Only http and https URLs are supported, got %q", u.Scheme)
	}
	if u.Host == "" {
		return nil, newError(KindInvalidURL, nil, "The URL has no host")
	}
	u.RawQuery = urlx.EncodeWireQuery(req.Query)
	return u, nil
}

// buildBody returns the body reader, its default content type and its length
// (-1 when unknown, which makes the transport use chunked encoding).
func buildBody(b model.Body) (io.ReadCloser, string, int64, error) {
	switch b.Type {
	case "", model.BodyNone:
		return nil, "", 0, nil
	case model.BodyRaw:
		ct := rawContentTypes[b.Language]
		if ct == "" {
			ct = rawContentTypes[model.LangText]
		}
		return io.NopCloser(strings.NewReader(b.Raw)), ct, int64(len(b.Raw)), nil
	case model.BodyURLEncoded:
		s := urlx.EncodeWireQuery(b.URLEncoded)
		return io.NopCloser(strings.NewReader(s)), "application/x-www-form-urlencoded", int64(len(s)), nil
	case model.BodyBinary:
		return openBinary(b.BinaryPath)
	case model.BodyFormData:
		return buildMultipart(b.FormData)
	default:
		return nil, "", 0, newError(KindInvalidRequest, nil, "Unsupported body type %q", b.Type)
	}
}

func openBinary(path string) (io.ReadCloser, string, int64, error) {
	if path == "" {
		return nil, "", 0, newError(KindInvalidRequest, nil, "Choose a file to send as the binary body")
	}
	f, err := os.Open(path)
	if err != nil {
		return nil, "", 0, Classify(err)
	}
	info, err := f.Stat()
	if err != nil {
		_ = f.Close()
		return nil, "", 0, Classify(err)
	}
	return f, "application/octet-stream", info.Size(), nil
}

// buildMultipart validates file parts up front (so a missing file is reported
// before connecting), then streams the parts through a pipe.
func buildMultipart(fields []model.FormField) (io.ReadCloser, string, int64, error) {
	enabled := make([]model.FormField, 0, len(fields))
	for _, f := range fields {
		if !f.Enabled || strings.TrimSpace(f.Key) == "" {
			continue
		}
		if f.Kind == model.FormFile {
			if f.FilePath == "" {
				return nil, "", 0, newError(KindInvalidRequest, nil, "Choose a file for form field %q", f.Key)
			}
			if _, err := os.Stat(f.FilePath); err != nil {
				return nil, "", 0, Classify(err)
			}
		}
		enabled = append(enabled, f)
	}

	pr, pw := io.Pipe()
	mw := multipart.NewWriter(pw)
	go func() {
		err := writeParts(mw, enabled)
		if err == nil {
			err = mw.Close()
		}
		pw.CloseWithError(err)
	}()
	return pr, mw.FormDataContentType(), -1, nil
}

func writeParts(mw *multipart.Writer, fields []model.FormField) error {
	for _, f := range fields {
		if f.Kind != model.FormFile {
			if err := writeTextPart(mw, f); err != nil {
				return err
			}
			continue
		}
		if err := writeFilePart(mw, f); err != nil {
			return err
		}
	}
	return nil
}

var quoteEscaper = strings.NewReplacer("\\", "\\\\", `"`, "\\\"")

func writeTextPart(mw *multipart.Writer, f model.FormField) error {
	if f.ContentType == "" {
		return mw.WriteField(f.Key, f.Value)
	}
	h := textproto.MIMEHeader{}
	h.Set("Content-Disposition", fmt.Sprintf(`form-data; name="%s"`, quoteEscaper.Replace(f.Key)))
	h.Set("Content-Type", f.ContentType)
	w, err := mw.CreatePart(h)
	if err != nil {
		return err
	}
	_, err = io.WriteString(w, f.Value)
	return err
}

func writeFilePart(mw *multipart.Writer, f model.FormField) error {
	file, err := os.Open(f.FilePath)
	if err != nil {
		return err
	}
	defer file.Close()

	ct := f.ContentType
	if ct == "" {
		ct = "application/octet-stream"
	}
	h := textproto.MIMEHeader{}
	h.Set("Content-Disposition", fmt.Sprintf(`form-data; name="%s"; filename="%s"`,
		quoteEscaper.Replace(f.Key), quoteEscaper.Replace(filepath.Base(f.FilePath))))
	h.Set("Content-Type", ct)
	w, err := mw.CreatePart(h)
	if err != nil {
		return err
	}
	_, err = io.Copy(w, file)
	return err
}
