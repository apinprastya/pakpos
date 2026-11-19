// Package awsv4 signs HTTP requests with AWS Signature Version 4
// (https://docs.aws.amazon.com/IAM/latest/UserGuide/reference_sigv4-create-signed-request.html).
// It is a small own implementation, so Pakpos needs no AWS SDK. It has no I/O.
package awsv4

import (
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"net/http"
	"net/url"
	"sort"
	"strings"
	"time"
)

// Header names and values the signer uses.
const (
	Algorithm       = "AWS4-HMAC-SHA256"
	HeaderDate      = "X-Amz-Date"
	HeaderToken     = "X-Amz-Security-Token"
	HeaderContent   = "X-Amz-Content-Sha256"
	UnsignedPayload = "UNSIGNED-PAYLOAD"
	timeFormat      = "20060102T150405Z"
	dateFormat      = "20060102"
)

// Credentials are an access key pair and an optional session token.
type Credentials struct {
	AccessKey    string
	SecretKey    string
	SessionToken string
}

// Options describe what the signature is for.
type Options struct {
	Region  string
	Service string
	Time    time.Time
	// PayloadHash is the hex SHA-256 of the body, or UnsignedPayload.
	PayloadHash string
	// ContentHeader adds X-Amz-Content-Sha256 (S3 requires it); it is
	// always added for S3 and for an unsigned payload.
	ContentHeader bool
}

// Errors for incomplete settings.
var (
	ErrNoKeys   = errors.New("AWS Signature v4 needs an access key and a secret key")
	ErrNoRegion = errors.New("AWS Signature v4 needs a region and a service")
)

// HashPayload returns the hex SHA-256 of body.
func HashPayload(body []byte) string {
	sum := sha256.Sum256(body)
	return hex.EncodeToString(sum[:])
}

// Sign adds X-Amz-Date (and X-Amz-Security-Token, X-Amz-Content-Sha256
// where needed) and the Authorization header to r. It signs the host,
// Content-Type, Content-MD5 and every X-Amz-* header, so headers added
// later (by a proxy or the transport) don't break the signature.
func Sign(r *http.Request, c Credentials, o Options) error {
	if c.AccessKey == "" || c.SecretKey == "" {
		return ErrNoKeys
	}
	if o.Region == "" || o.Service == "" {
		return ErrNoRegion
	}
	if o.PayloadHash == "" {
		o.PayloadHash = HashPayload(nil)
	}
	t := o.Time.UTC()
	r.Header.Set(HeaderDate, t.Format(timeFormat))
	if c.SessionToken != "" {
		r.Header.Set(HeaderToken, c.SessionToken)
	}
	if o.ContentHeader || o.Service == "s3" || o.PayloadHash == UnsignedPayload {
		r.Header.Set(HeaderContent, o.PayloadHash)
	}

	canonicalHeaders, signedHeaders := canonicalHeaders(r)
	canonical := strings.Join([]string{
		r.Method,
		CanonicalURI(r.URL, o.Service == "s3"),
		CanonicalQuery(r.URL.RawQuery),
		canonicalHeaders,
		signedHeaders,
		o.PayloadHash,
	}, "\n")
	scope := strings.Join([]string{t.Format(dateFormat), o.Region, o.Service, "aws4_request"}, "/")
	toSign := strings.Join([]string{Algorithm, t.Format(timeFormat), scope, HashPayload([]byte(canonical))}, "\n")

	key := hmacSHA256([]byte("AWS4"+c.SecretKey), t.Format(dateFormat))
	for _, part := range []string{o.Region, o.Service, "aws4_request"} {
		key = hmacSHA256(key, part)
	}
	sig := hex.EncodeToString(hmacSHA256(key, toSign))
	r.Header.Set("Authorization", Algorithm+" Credential="+c.AccessKey+"/"+scope+
		", SignedHeaders="+signedHeaders+", Signature="+sig)
	return nil
}

func hmacSHA256(key []byte, data string) []byte {
	m := hmac.New(sha256.New, key)
	m.Write([]byte(data))
	return m.Sum(nil)
}

// canonicalHeaders returns the canonical header block (each line ends in
// a line break) and the signed header list.
func canonicalHeaders(r *http.Request) (string, string) {
	host := r.Host
	if host == "" {
		host = r.URL.Host
	}
	values := map[string][]string{"host": {host}}
	for k, vs := range r.Header {
		lk := strings.ToLower(k)
		if lk == "content-type" || lk == "content-md5" || strings.HasPrefix(lk, "x-amz-") {
			values[lk] = append(values[lk], vs...)
		}
	}
	names := make([]string, 0, len(values))
	for k := range values {
		names = append(names, k)
	}
	sort.Strings(names)
	var b strings.Builder
	for _, k := range names {
		trimmed := make([]string, len(values[k]))
		for i, v := range values[k] {
			trimmed[i] = strings.Join(strings.Fields(v), " ")
		}
		b.WriteString(k + ":" + strings.Join(trimmed, ",") + "\n")
	}
	return b.String(), strings.Join(names, ";")
}

// CanonicalURI is the URI-encoded path. For every service but S3 the path
// is normalized (dot segments removed) and each segment is encoded twice;
// S3 keeps the path as is and encodes it once.
func CanonicalURI(u *url.URL, s3 bool) string {
	p := u.EscapedPath()
	if p == "" {
		return "/"
	}
	segs := strings.Split(p, "/")
	for i, s := range segs {
		if d, err := url.PathUnescape(s); err == nil {
			s = d
		}
		segs[i] = Escape(s)
	}
	if s3 {
		return strings.Join(segs, "/")
	}
	segs = normalize(segs)
	for i, s := range segs {
		segs[i] = Escape(s)
	}
	return strings.Join(segs, "/")
}

// normalize removes "." and ".." segments, keeping the leading and the
// trailing slash.
func normalize(segs []string) []string {
	out := []string{""}
	for i, s := range segs[1:] {
		last := i == len(segs)-2
		switch s {
		case ".":
			if last {
				out = append(out, "")
			}
		case "..":
			if len(out) > 1 {
				out = out[:len(out)-1]
			}
			if last {
				out = append(out, "")
			}
		default:
			out = append(out, s)
		}
	}
	if len(out) == 1 {
		out = append(out, "")
	}
	return out
}

// CanonicalQuery sorts the query parameters by name and value, each
// URI-encoded the AWS way.
func CanonicalQuery(raw string) string {
	if raw == "" {
		return ""
	}
	type pair struct{ k, v string }
	var pairs []pair
	for _, part := range strings.Split(raw, "&") {
		if part == "" {
			continue
		}
		k, v, _ := strings.Cut(part, "=")
		if d, err := url.QueryUnescape(k); err == nil {
			k = d
		}
		if d, err := url.QueryUnescape(v); err == nil {
			v = d
		}
		pairs = append(pairs, pair{Escape(k), Escape(v)})
	}
	sort.Slice(pairs, func(i, j int) bool {
		if pairs[i].k != pairs[j].k {
			return pairs[i].k < pairs[j].k
		}
		return pairs[i].v < pairs[j].v
	})
	out := make([]string, len(pairs))
	for i, p := range pairs {
		out[i] = p.k + "=" + p.v
	}
	return strings.Join(out, "&")
}

// Escape percent-encodes everything but the unreserved characters
// (A–Z, a–z, 0–9, -, _, ., ~), with upper-case hex.
func Escape(s string) string {
	const hexDigits = "0123456789ABCDEF"
	var b strings.Builder
	for i := 0; i < len(s); i++ {
		c := s[i]
		if c >= 'A' && c <= 'Z' || c >= 'a' && c <= 'z' || c >= '0' && c <= '9' || c == '-' || c == '_' || c == '.' || c == '~' {
			b.WriteByte(c)
			continue
		}
		b.WriteByte('%')
		b.WriteByte(hexDigits[c>>4])
		b.WriteByte(hexDigits[c&15])
	}
	return b.String()
}
