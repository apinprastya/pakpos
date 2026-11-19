// Package hashx computes message digests (MD5, SHA-1, SHA-2) and HMACs of
// text or of a stream, for the Hash and HMAC tool. It has no Wails or file
// system code: callers pass bytes or an io.Reader.
package hashx

import (
	"context"
	"crypto/hmac"
	"crypto/md5"  //nolint:gosec // offered as a checksum, labelled insecure in the UI
	"crypto/sha1" //nolint:gosec // offered as a checksum, labelled insecure in the UI
	"crypto/sha256"
	"crypto/sha512"
	"encoding/base64"
	"encoding/hex"
	"errors"
	"fmt"
	"hash"
	"io"
	"strings"
)

// Algorithm names a digest.
type Algorithm string

// The supported algorithms.
const (
	MD5    Algorithm = "md5"
	SHA1   Algorithm = "sha1"
	SHA256 Algorithm = "sha256"
	SHA384 Algorithm = "sha384"
	SHA512 Algorithm = "sha512"
)

// Algorithms lists the supported algorithms, weakest first.
func Algorithms() []Algorithm { return []Algorithm{MD5, SHA1, SHA256, SHA384, SHA512} }

// KeyFormat says how an HMAC key is written.
type KeyFormat string

// The supported key formats. "" means text.
const (
	KeyText   KeyFormat = "text"
	KeyHex    KeyFormat = "hex"
	KeyBase64 KeyFormat = "base64"
)

// Errors callers can match; their messages are written for the user.
var (
	ErrUnknownAlgorithm = errors.New("unknown hash algorithm")
	ErrBadKey           = errors.New("the HMAC key can't be read")
)

// Options choose the digest and, for an HMAC, its key.
type Options struct {
	Algorithm Algorithm
	HMAC      bool
	// Key is used only when HMAC is set; an empty key is allowed.
	Key       string
	KeyFormat KeyFormat
}

// Sum is a digest in the two usual encodings.
type Sum struct {
	Hex    string `json:"hex"`
	Base64 string `json:"base64"`
}

func constructor(a Algorithm) (func() hash.Hash, error) {
	switch a {
	case MD5:
		return md5.New, nil
	case SHA1:
		return sha1.New, nil
	case SHA256:
		return sha256.New, nil
	case SHA384:
		return sha512.New384, nil
	case SHA512:
		return sha512.New, nil
	}
	return nil, fmt.Errorf("%w %q", ErrUnknownAlgorithm, a)
}

// DecodeKey turns a key written as text, hex or base64 into bytes. Hex and
// base64 may contain whitespace; base64 may be standard or URL-safe, with or
// without padding.
func DecodeKey(key string, f KeyFormat) ([]byte, error) {
	switch f {
	case "", KeyText:
		return []byte(key), nil
	case KeyHex:
		b, err := hex.DecodeString(strings.Join(strings.Fields(key), ""))
		if err != nil {
			return nil, fmt.Errorf("%w: it isn't valid hex (use the digits 0-9 and a-f, two per byte)", ErrBadKey)
		}
		return b, nil
	case KeyBase64:
		s := strings.TrimRight(strings.Join(strings.Fields(key), ""), "=")
		if strings.ContainsAny(s, "-_") {
			s = strings.NewReplacer("-", "+", "_", "/").Replace(s)
		}
		b, err := base64.RawStdEncoding.DecodeString(s)
		if err != nil {
			return nil, fmt.Errorf("%w: it isn't valid base64", ErrBadKey)
		}
		return b, nil
	}
	return nil, fmt.Errorf("%w: unknown key format %q", ErrBadKey, f)
}

// New returns a fresh hash for the options (an HMAC when o.HMAC is set).
func New(o Options) (hash.Hash, error) {
	mk, err := constructor(o.Algorithm)
	if err != nil {
		return nil, err
	}
	if !o.HMAC {
		return mk(), nil
	}
	key, err := DecodeKey(o.Key, o.KeyFormat)
	if err != nil {
		return nil, err
	}
	return hmac.New(mk, key), nil
}

func sumOf(h hash.Hash) Sum {
	b := h.Sum(nil)
	return Sum{Hex: hex.EncodeToString(b), Base64: base64.StdEncoding.EncodeToString(b)}
}

// Bytes digests data.
func Bytes(o Options, data []byte) (Sum, error) {
	h, err := New(o)
	if err != nil {
		return Sum{}, err
	}
	h.Write(data)
	return sumOf(h), nil
}

// chunk is how much is read between cancellation checks.
const chunk = 256 << 10

// Reader digests everything r yields, streaming it in chunks so any size
// works, and stops with ctx.Err() when ctx is cancelled.
func Reader(ctx context.Context, o Options, r io.Reader) (Sum, error) {
	h, err := New(o)
	if err != nil {
		return Sum{}, err
	}
	buf := make([]byte, chunk)
	for {
		if err := ctx.Err(); err != nil {
			return Sum{}, err
		}
		n, err := r.Read(buf)
		h.Write(buf[:n])
		if errors.Is(err, io.EOF) {
			return sumOf(h), nil
		}
		if err != nil {
			return Sum{}, fmt.Errorf("read: %w", err)
		}
	}
}
