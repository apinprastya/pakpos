// Package hawk computes Hawk request authorization headers
// (https://github.com/mozilla/hawk, "hawk.1" header MACs with an optional
// payload hash). It has no I/O.
package hawk

import (
	"crypto/hmac"
	"crypto/rand"
	"crypto/sha1" //nolint:gosec // Hawk allows sha1 for older servers
	"crypto/sha256"
	"encoding/base64"
	"errors"
	"fmt"
	"hash"
	"io"
	"mime"
	"net"
	"net/url"
	"strconv"
	"strings"
	"time"
)

// Algorithms.
const (
	SHA256 = "sha256"
	SHA1   = "sha1"
)

// Credentials identify the client.
type Credentials struct {
	ID        string
	Key       string
	Algorithm string // sha256 ("" too) or sha1
}

// Options are the per-request inputs. Zero Time and empty Nonce get the
// current time and a random nonce.
type Options struct {
	Method string
	URL    *url.URL
	// Host overrides the URL's host (a Host header), "" for the URL's.
	Host  string
	Time  time.Time
	Nonce string
	Ext   string
	App   string
	Dlg   string
	// Hash is the payload hash ("" for none; see PayloadHash).
	Hash string
}

// Rand is the source of nonces (tests replace it).
var Rand io.Reader = rand.Reader

// Errors for incomplete settings.
var (
	ErrNoCredentials = errors.New("hawk auth needs an ID and a key")
	ErrAlgorithm     = errors.New("the Hawk algorithm must be sha256 or sha1")
)

func newHash(alg string) (func() hash.Hash, error) {
	switch strings.ToLower(alg) {
	case "", SHA256:
		return sha256.New, nil
	case SHA1:
		return sha1.New, nil
	}
	return nil, ErrAlgorithm
}

// PayloadHash returns the Hawk payload hash of body sent with contentType
// (its parameters are dropped).
func PayloadHash(alg, contentType string, body []byte) (string, error) {
	nh, err := newHash(alg)
	if err != nil {
		return "", err
	}
	if mt, _, err := mime.ParseMediaType(contentType); err == nil {
		contentType = mt
	} else {
		contentType = strings.ToLower(strings.TrimSpace(strings.Split(contentType, ";")[0]))
	}
	h := nh()
	h.Write([]byte("hawk.1.payload\n" + contentType + "\n"))
	h.Write(body)
	h.Write([]byte("\n"))
	return base64.StdEncoding.EncodeToString(h.Sum(nil)), nil
}

// Header returns the Authorization header value for the request.
func Header(c Credentials, o Options) (string, error) {
	if c.ID == "" || c.Key == "" {
		return "", ErrNoCredentials
	}
	nh, err := newHash(c.Algorithm)
	if err != nil {
		return "", err
	}
	if o.Time.IsZero() {
		o.Time = time.Now()
	}
	if o.Nonce == "" {
		b := make([]byte, 6)
		if _, err := io.ReadFull(Rand, b); err != nil {
			return "", fmt.Errorf("make a Hawk nonce: %w", err)
		}
		o.Nonce = base64.RawURLEncoding.EncodeToString(b)
	}
	ts := strconv.FormatInt(o.Time.Unix(), 10)
	host, port := hostPort(o)
	resource := o.URL.RequestURI()

	normalized := "hawk.1.header\n" + ts + "\n" + o.Nonce + "\n" + strings.ToUpper(o.Method) + "\n" + resource + "\n" +
		strings.ToLower(host) + "\n" + port + "\n" + o.Hash + "\n" + escapeExt(o.Ext) + "\n"
	if o.App != "" {
		normalized += o.App + "\n" + o.Dlg + "\n"
	}
	m := hmac.New(nh, []byte(c.Key))
	m.Write([]byte(normalized))
	mac := base64.StdEncoding.EncodeToString(m.Sum(nil))

	var b strings.Builder
	fmt.Fprintf(&b, `Hawk id="%s", ts="%s", nonce="%s"`, attr(c.ID), ts, attr(o.Nonce))
	if o.Hash != "" {
		fmt.Fprintf(&b, `, hash="%s"`, o.Hash)
	}
	if o.Ext != "" {
		fmt.Fprintf(&b, `, ext="%s"`, attr(o.Ext))
	}
	fmt.Fprintf(&b, `, mac="%s"`, mac)
	if o.App != "" {
		fmt.Fprintf(&b, `, app="%s"`, attr(o.App))
		if o.Dlg != "" {
			fmt.Fprintf(&b, `, dlg="%s"`, attr(o.Dlg))
		}
	}
	return b.String(), nil
}

func hostPort(o Options) (string, string) {
	h := o.Host
	if h == "" {
		h = o.URL.Host
	}
	host, port, err := net.SplitHostPort(h)
	if err != nil {
		host = strings.Trim(h, "[]")
		port = "80"
		if o.URL.Scheme == "https" {
			port = "443"
		}
	}
	return host, port
}

// escapeExt escapes ext the way the reference implementation does in the
// normalized string.
func escapeExt(s string) string {
	return strings.NewReplacer(`\`, `\\`, "\n", `\n`).Replace(s)
}

// attr escapes a header attribute value (quotes and backslashes).
func attr(s string) string {
	return strings.NewReplacer(`\`, `\\`, `"`, `\"`).Replace(s)
}
