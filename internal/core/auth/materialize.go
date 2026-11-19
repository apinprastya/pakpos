package auth

import (
	"bytes"
	"io"
	"net/http"
	"net/url"
	"strings"
	"time"

	"pakpos/internal/core/model"
	"pakpos/internal/core/urlx"
)

// unresolved reports whether any of fields still holds a {{reference}}
// (variables not resolved, or a secret kept as {{name}}).
func unresolved(fields ...string) bool {
	for _, f := range fields {
		if strings.Contains(f, "{{") {
			return true
		}
	}
	return false
}

const revealHint = "Resolve variables and reveal secrets to include it."

func materializeJWT(j *model.JWT) (string, []string) {
	if j == nil {
		return "", nil
	}
	if unresolved(j.Secret, j.Header, j.Payload) {
		return "", []string{"The JWT can't be signed while its key, header or payload holds a {{variable}}, so the code sends no token. " + revealHint}
	}
	now := Now()
	tok, err := JWTToken(*j, now)
	if err != nil {
		return "", []string{"The JWT couldn't be signed (" + err.Error() + "), so the code sends no token."}
	}
	msg := "The JWT in this code was signed now; Pakpos signs a new one for every send."
	if j.LifetimeSeconds > 0 {
		msg += " It expires at " + now.Add(time.Duration(j.LifetimeSeconds)*time.Second).UTC().Format(time.RFC3339) + "."
	}
	return tok, []string{msg}
}

// wireRequest builds the request as httpexec would send it, enough to sign
// it: method, URL, headers (with the default Content-Type) and the body of
// raw and urlencoded requests. hashable is false for form-data and binary
// bodies, whose bytes aren't known here.
func wireRequest(req model.Request) (r *http.Request, body []byte, hashable bool, err error) {
	method := strings.ToUpper(strings.TrimSpace(req.Method))
	if method == "" {
		method = http.MethodGet
	}
	u, err := url.Parse(urlx.SendURL(req))
	if err != nil {
		return nil, nil, false, err
	}
	hashable = true
	switch req.Body.Type {
	case model.BodyRaw:
		body = []byte(req.Body.Raw)
	case model.BodyURLEncoded:
		body = []byte(urlx.EncodeWireQuery(req.Body.URLEncoded))
	case model.BodyFormData, model.BodyBinary:
		hashable = false
	}
	r = &http.Request{Method: method, URL: u, Host: u.Host, Header: http.Header{}}
	for _, h := range req.Headers {
		if k := strings.TrimSpace(h.Key); h.Enabled && k != "" {
			r.Header.Add(k, h.Value)
		}
	}
	if ct := req.Body.DefaultContentType(); ct != "" && req.Body.Type != model.BodyFormData && r.Header.Get("Content-Type") == "" {
		r.Header.Set("Content-Type", ct)
	}
	if body != nil {
		r.Body = io.NopCloser(bytes.NewReader(body))
	}
	return r, body, hashable, nil
}

// addHeaders copies the named headers of r into out's rows.
func addHeaders(out model.Request, r *http.Request, names ...string) model.Request {
	for _, n := range names {
		if v := r.Header.Get(n); v != "" {
			out.Headers = setHeader(out.Headers, n, v)
		}
	}
	return out
}

func materializeAWS(out, req model.Request) (model.Request, []string, error) {
	w := req.Auth.AWSV4
	if w == nil {
		return out, nil, nil
	}
	if unresolved(w.AccessKey, w.SecretKey, w.SessionToken, w.Region, w.Service, urlx.SendURL(req)) {
		return out, []string{"The AWS signature can't be computed while the request or its keys hold a {{variable}}, so the code sends no signature. " + revealHint}, nil
	}
	r, _, hashable, err := wireRequest(req)
	if err != nil {
		return out, []string{"The AWS signature couldn't be computed: the URL isn't valid."}, nil
	}
	var warnings []string
	signed := *w
	if !hashable && !w.UnsignedPayload {
		signed.UnsignedPayload = true
		warnings = append(warnings, "The body can't be hashed here, so the code signs UNSIGNED-PAYLOAD, which only S3 accepts.")
	}
	if err := applyAWS(r, &signed); err != nil {
		return out, []string{"The AWS signature couldn't be computed (" + err.Error() + "), so the code sends no signature."}, nil
	}
	out = addHeaders(out, r, "X-Amz-Date", "X-Amz-Security-Token", "X-Amz-Content-Sha256", "Authorization")
	return out, append([]string{"The AWS signature in this code was computed now and is valid for about 5 minutes."}, warnings...), nil
}

func materializeHawk(out, req model.Request) (model.Request, []string, error) {
	h := req.Auth.Hawk
	if h == nil {
		return out, nil, nil
	}
	if unresolved(h.ID, h.Key, h.Ext, h.App, h.Dlg, urlx.SendURL(req)) {
		return out, []string{"The Hawk header can't be computed while the request or its key holds a {{variable}}, so the code sends no auth. " + revealHint}, nil
	}
	r, _, hashable, err := wireRequest(req)
	if err != nil {
		return out, []string{"The Hawk header couldn't be computed: the URL isn't valid."}, nil
	}
	var warnings []string
	hk := *h
	if hk.PayloadHash && !hashable {
		hk.PayloadHash = false
		warnings = append(warnings, "The body can't be hashed here, so the Hawk header has no payload hash.")
	}
	if err := applyHawk(r, &hk); err != nil {
		return out, []string{"The Hawk header couldn't be computed (" + err.Error() + "), so the code sends no auth."}, nil
	}
	out = addHeaders(out, r, "Authorization")
	return out, append([]string{"The Hawk header in this code was computed now; servers accept it for about a minute."}, warnings...), nil
}
