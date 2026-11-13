package httpexec

import (
	"context"
	"crypto/tls"
	"crypto/x509"
	"errors"
	"fmt"
	"io/fs"
	"net"
	"strings"
	"syscall"
)

// ErrorKind classifies a send failure so the UI can show a helpful message.
type ErrorKind string

const (
	KindInvalidURL        ErrorKind = "invalid_url"
	KindInvalidRequest    ErrorKind = "invalid_request"
	KindFileNotFound      ErrorKind = "file_not_found"
	KindDNS               ErrorKind = "dns"
	KindConnectionRefused ErrorKind = "connection_refused"
	KindTLS               ErrorKind = "tls"
	KindTimeout           ErrorKind = "timeout"
	KindCanceled          ErrorKind = "canceled"
	KindTooManyRedirects  ErrorKind = "too_many_redirects"
	KindNetwork           ErrorKind = "network"
)

// Error is a classified send failure. Message is written for end users.
type Error struct {
	Kind    ErrorKind `json:"kind"`
	Message string    `json:"message"`
	Err     error     `json:"-"`
}

func (e *Error) Error() string {
	if e.Err != nil {
		return e.Message + ": " + e.Err.Error()
	}
	return e.Message
}

func (e *Error) Unwrap() error { return e.Err }

func newError(kind ErrorKind, err error, format string, args ...any) *Error {
	return &Error{Kind: kind, Message: fmt.Sprintf(format, args...), Err: err}
}

var errTooManyRedirects = errors.New("too many redirects")

// Classify turns any error from building or sending a request into an *Error.
// It returns nil for a nil error.
func Classify(err error) *Error {
	if err == nil {
		return nil
	}
	var e *Error
	if errors.As(err, &e) {
		return e
	}

	var (
		dnsErr      *net.DNSError
		unknownCA   x509.UnknownAuthorityError
		hostErr     x509.HostnameError
		certInvalid x509.CertificateInvalidError
		verifyErr   *tls.CertificateVerificationError
		recordErr   tls.RecordHeaderError
		alertErr    tls.AlertError
		pathErr     *fs.PathError
		netErr      net.Error
	)
	switch {
	case errors.Is(err, context.Canceled):
		return newError(KindCanceled, err, "The request was canceled")
	case errors.Is(err, context.DeadlineExceeded):
		return newError(KindTimeout, err, "The request timed out. Increase the timeout in settings or check that the server is responding")
	case errors.Is(err, errTooManyRedirects):
		return newError(KindTooManyRedirects, err, "Stopped after too many redirects. Raise the redirect limit or check for a redirect loop")
	case errors.As(err, &dnsErr):
		return newError(KindDNS, err, "Could not resolve host %q. Check the URL and your network connection", dnsErr.Name)
	case errors.Is(err, syscall.ECONNREFUSED):
		return newError(KindConnectionRefused, err, "Connection refused. Check that the server is running and the port is correct")
	case errors.As(err, &unknownCA), errors.As(err, &hostErr), errors.As(err, &certInvalid), errors.As(err, &verifyErr):
		return newError(KindTLS, err, "The server's TLS certificate could not be verified. Turn off certificate verification in settings to send anyway")
	case strings.Contains(err.Error(), "server gave HTTP response to HTTPS client"):
		// net/http reports this as an untyped error.
		return newError(KindTLS, err, "The server answered with plain HTTP. Use http:// instead of https://")
	case errors.As(err, &recordErr), errors.As(err, &alertErr):
		return newError(KindTLS, err, "The TLS handshake failed. Check that the server speaks HTTPS on this port")
	case errors.As(err, &pathErr) && errors.Is(err, fs.ErrNotExist):
		return newError(KindFileNotFound, err, "File not found: %s", pathErr.Path)
	case errors.As(err, &netErr) && netErr.Timeout():
		return newError(KindTimeout, err, "The request timed out. Increase the timeout in settings or check that the server is responding")
	default:
		return newError(KindNetwork, err, "The request failed")
	}
}
