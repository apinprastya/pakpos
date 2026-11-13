package httpexec

import (
	"context"
	"crypto/tls"
	"crypto/x509"
	"errors"
	"fmt"
	"io/fs"
	"net"
	"net/http"
	"net/url"
	"os"
	"syscall"
	"testing"

	"pakpos/internal/core/model"
)

type timeoutErr struct{}

func (timeoutErr) Error() string   { return "i/o timeout" }
func (timeoutErr) Timeout() bool   { return true }
func (timeoutErr) Temporary() bool { return true }

func wrapURL(err error) error { return &url.Error{Op: "Get", URL: "http://x", Err: err} }

func TestClassify(t *testing.T) {
	if Classify(nil) != nil {
		t.Fatal("Classify(nil) should be nil")
	}
	own := newError(KindDNS, nil, "mine")
	if Classify(fmt.Errorf("wrapped: %w", own)) != own {
		t.Fatal("existing *Error should pass through")
	}

	tests := []struct {
		name string
		err  error
		want ErrorKind
	}{
		{"canceled", wrapURL(context.Canceled), KindCanceled},
		{"deadline", wrapURL(context.DeadlineExceeded), KindTimeout},
		{"redirects", wrapURL(errTooManyRedirects), KindTooManyRedirects},
		{"dns", wrapURL(&net.DNSError{Name: "x.invalid", Err: "no such host", IsNotFound: true}), KindDNS},
		{"refused", wrapURL(&net.OpError{Op: "dial", Err: &os.SyscallError{Syscall: "connect", Err: syscall.ECONNREFUSED}}), KindConnectionRefused},
		{"unknown CA", wrapURL(x509.UnknownAuthorityError{}), KindTLS},
		{"hostname", wrapURL(x509.HostnameError{Certificate: &x509.Certificate{}, Host: "x"}), KindTLS},
		{"cert invalid", wrapURL(x509.CertificateInvalidError{Reason: x509.Expired}), KindTLS},
		{"verify", wrapURL(&tls.CertificateVerificationError{Err: errors.New("bad")}), KindTLS},
		{"record header", wrapURL(tls.RecordHeaderError{Msg: "bad record"}), KindTLS},
		{"alert", wrapURL(tls.AlertError(40)), KindTLS},
		{"http to https", errors.New("http: server gave HTTP response to HTTPS client"), KindTLS},
		{"file", &fs.PathError{Op: "open", Path: "/x", Err: fs.ErrNotExist}, KindFileNotFound},
		{"permission is generic", &fs.PathError{Op: "open", Path: "/x", Err: fs.ErrPermission}, KindNetwork},
		{"net timeout", wrapURL(timeoutErr{}), KindTimeout},
		{"other", errors.New("boom"), KindNetwork},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got := Classify(tt.err)
			if got.Kind != tt.want || got.Message == "" {
				t.Fatalf("Classify(%v) = %+v, want kind %q", tt.err, got, tt.want)
			}
			if !errors.Is(got, tt.err) {
				t.Error("classified error should unwrap to the cause")
			}
		})
	}
}

func TestErrorString(t *testing.T) {
	if got := newError(KindDNS, nil, "Plain").Error(); got != "Plain" {
		t.Errorf("Error() = %q", got)
	}
	if got := newError(KindDNS, errors.New("cause"), "Msg %d", 1).Error(); got != "Msg 1: cause" {
		t.Errorf("Error() = %q", got)
	}
}

func TestDetectKind(t *testing.T) {
	tests := []struct {
		ct   string
		body string
		want model.BodyKind
	}{
		{"application/json", "{}", model.KindJSON},
		{"application/problem+json; charset=utf-8", "{}", model.KindJSON},
		{"application/xml", "<a/>", model.KindXML},
		{"text/xml", "<a/>", model.KindXML},
		{"application/atom+xml", "<a/>", model.KindXML},
		{"text/html; charset=utf-8", "<p>", model.KindHTML},
		{"application/xhtml+xml", "<p>", model.KindHTML},
		{"image/svg+xml", "<svg/>", model.KindXML},
		{"image/webp", "RIFF", model.KindImage},
		{"text/css", "a{}", model.KindText},
		{"application/javascript", "x()", model.KindText},
		{"application/x-ndjson", "{}\n", model.KindText},
		{"application/octet-stream", "\x00", model.KindBinary},
		{"", "", model.KindEmpty},
		{"", `  {"sniffed": true}`, model.KindJSON},
		{"", "[1,2", model.KindText},
		{"", "plain words", model.KindText},
		{"", "<!DOCTYPE html><html></html>", model.KindHTML},
		{"", "\x89PNG\r\n\x1a\n", model.KindImage},
		{"not a/valid;;type", "\x00\x01", model.KindBinary},
	}
	for _, tt := range tests {
		if got := detectKind(tt.ct, []byte(tt.body)); got != tt.want {
			t.Errorf("detectKind(%q, %q) = %q, want %q", tt.ct, tt.body, got, tt.want)
		}
	}
}

func TestEncodeBody(t *testing.T) {
	tests := []struct {
		name      string
		kind      model.BodyKind
		data      string
		truncated bool
		wantBody  string
		wantEnc   model.BodyEncoding
	}{
		{"text", model.KindText, "héllo", false, "héllo", model.EncodingUTF8},
		{"invalid utf8 text", model.KindText, "a\xffb", false, "Yf9i", model.EncodingBase64},
		{"truncated mid-rune", model.KindJSON, "ab\xe2\x9c", true, "ab", model.EncodingUTF8},
		{"truncated but garbage", model.KindText, "\xff\xff\xff\xff\xff", true, "//////8=", model.EncodingBase64},
		{"binary", model.KindBinary, "abc", false, "YWJj", model.EncodingBase64},
		{"image", model.KindImage, "abc", false, "YWJj", model.EncodingBase64},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			body, enc := encodeBody(tt.kind, []byte(tt.data), tt.truncated)
			if body != tt.wantBody || enc != tt.wantEnc {
				t.Errorf("encodeBody = %q,%q want %q,%q", body, enc, tt.wantBody, tt.wantEnc)
			}
		})
	}
}

func TestStatusTextFallback(t *testing.T) {
	if got := statusText(&http.Response{Status: "204", StatusCode: 204}); got != "No Content" {
		t.Errorf("statusText = %q", got)
	}
	if got := statusText(&http.Response{Status: "200 Fine", StatusCode: 200}); got != "Fine" {
		t.Errorf("statusText = %q", got)
	}
}
