// Package jwtx signs and verifies JSON Web Tokens (JWS compact
// serialization, RFC 7515/7519) with the standard library: HS256/384/512,
// RS256/384/512, PS256/384/512, ES256/384/512 and EdDSA (Ed25519).
//
// The JWT auth type (Tier 3) uses Sign; the JWT decoder of the tools plan
// (PLAN-TOOLS M3) uses Verify. Keys are a shared secret, a PEM key or
// certificate, a JWK or a JWK set. The package has no I/O: a JWKS URL is
// fetched by the caller and passed in as a KeyJWKS.
package jwtx

import (
	"bytes"
	"crypto"
	"crypto/ecdsa"
	"crypto/ed25519"
	"crypto/elliptic"
	"crypto/hmac"
	"crypto/rand"
	"crypto/rsa"
	"crypto/sha256"
	"crypto/sha512"
	"crypto/x509"
	"encoding/base64"
	"encoding/json"
	"encoding/pem"
	"errors"
	"fmt"
	"io"
	"math/big"
	"strings"
)

// Algorithm is a JWS "alg" value.
type Algorithm string

// The supported algorithms.
const (
	HS256 Algorithm = "HS256"
	HS384 Algorithm = "HS384"
	HS512 Algorithm = "HS512"
	RS256 Algorithm = "RS256"
	RS384 Algorithm = "RS384"
	RS512 Algorithm = "RS512"
	PS256 Algorithm = "PS256"
	PS384 Algorithm = "PS384"
	PS512 Algorithm = "PS512"
	ES256 Algorithm = "ES256"
	ES384 Algorithm = "ES384"
	ES512 Algorithm = "ES512"
	EdDSA Algorithm = "EdDSA"
)

// Algorithms lists the supported algorithms in display order.
func Algorithms() []Algorithm {
	return []Algorithm{HS256, HS384, HS512, RS256, RS384, RS512, PS256, PS384, PS512, ES256, ES384, ES512, EdDSA}
}

// Family is the key type an algorithm needs.
type Family string

// Algorithm families.
const (
	FamilyHMAC  Family = "hmac"
	FamilyRSA   Family = "rsa"
	FamilyEC    Family = "ec"
	FamilyEdDSA Family = "eddsa"
)

// Family returns the key family of a, or "" for an unknown algorithm.
func (a Algorithm) Family() Family {
	switch a {
	case HS256, HS384, HS512:
		return FamilyHMAC
	case RS256, RS384, RS512, PS256, PS384, PS512:
		return FamilyRSA
	case ES256, ES384, ES512:
		return FamilyEC
	case EdDSA:
		return FamilyEdDSA
	}
	return ""
}

func (a Algorithm) hash() crypto.Hash {
	switch a {
	case HS384, RS384, PS384, ES384:
		return crypto.SHA384
	case HS512, RS512, PS512, ES512:
		return crypto.SHA512
	}
	return crypto.SHA256
}

func (a Algorithm) curve() elliptic.Curve {
	switch a {
	case ES384:
		return elliptic.P384()
	case ES512:
		return elliptic.P521()
	}
	return elliptic.P256()
}

// KeyKind says what Key.Data holds.
type KeyKind string

// Key kinds.
const (
	// KeySecret is an HMAC secret (the raw bytes).
	KeySecret KeyKind = "secret"
	// KeyPEM is a PEM private key (PKCS#1, PKCS#8, SEC1) for signing, or a
	// public key, certificate or private key for verifying.
	KeyPEM KeyKind = "pem"
	// KeyJWK is one JSON Web Key; KeyJWKS a JWK set ({"keys": [...]}).
	KeyJWK  KeyKind = "jwk"
	KeyJWKS KeyKind = "jwks"
)

// Key is the key material for Sign or Verify.
type Key struct {
	Kind KeyKind
	Data []byte
}

// SecretKey returns the HMAC key for text, base64-decoded when b64 (the
// standard or URL alphabet, with or without padding).
func SecretKey(text string, b64 bool) (Key, error) {
	if !b64 {
		return Key{Kind: KeySecret, Data: []byte(text)}, nil
	}
	s := strings.TrimRight(strings.TrimSpace(text), "=")
	for _, enc := range []*base64.Encoding{base64.RawStdEncoding, base64.RawURLEncoding} {
		if b, err := enc.DecodeString(s); err == nil {
			return Key{Kind: KeySecret, Data: b}, nil
		}
	}
	return Key{}, errors.New("the secret isn't valid base64")
}

// Errors returned by Sign and Verify.
var (
	ErrAlgorithm = errors.New("unsupported JWT algorithm")
	ErrKey       = errors.New("unusable JWT key")
	ErrJSON      = errors.New("not a JSON object")
)

// Rand is the randomness used for RSA-PSS and ECDSA signatures and jti
// values (tests may replace it).
var Rand io.Reader = rand.Reader

// Sign returns the compact JWS of payload (a JSON object) signed with alg.
// header holds extra header fields (a JSON object, or empty); alg is always
// set to alg and typ defaults to "JWT". Fields are written in name order.
func Sign(alg Algorithm, header, payload []byte, key Key) (string, error) {
	if alg.Family() == "" {
		return "", fmt.Errorf("%w %q", ErrAlgorithm, alg)
	}
	h, err := object(header, "header")
	if err != nil {
		return "", err
	}
	if _, ok := h["typ"]; !ok {
		h["typ"] = "JWT"
	}
	h["alg"] = string(alg)
	hb, err := marshal(h)
	if err != nil {
		return "", err
	}
	p, err := object(payload, "payload")
	if err != nil {
		return "", err
	}
	pb, err := marshal(p)
	if err != nil {
		return "", err
	}
	input := enc(hb) + "." + enc(pb)
	sig, err := signInput(alg, []byte(input), key)
	if err != nil {
		return "", err
	}
	return input + "." + enc(sig), nil
}

// Object decodes a JSON object keeping numbers as written. Empty text is
// an empty object.
func Object(text []byte) (map[string]any, error) { return object(text, "value") }

func object(text []byte, what string) (map[string]any, error) {
	out := map[string]any{}
	if len(bytes.TrimSpace(text)) == 0 {
		return out, nil
	}
	d := json.NewDecoder(bytes.NewReader(text))
	d.UseNumber()
	if err := d.Decode(&out); err != nil || out == nil {
		return nil, fmt.Errorf("the %s is %w", what, ErrJSON)
	}
	if d.More() {
		return nil, fmt.Errorf("the %s is %w (text after the object)", what, ErrJSON)
	}
	return out, nil
}

func marshal(m map[string]any) ([]byte, error) {
	var b bytes.Buffer
	e := json.NewEncoder(&b)
	e.SetEscapeHTML(false)
	if err := e.Encode(m); err != nil { // maps are written in key order
		return nil, err
	}
	return bytes.TrimRight(b.Bytes(), "\n"), nil
}

func enc(b []byte) string { return base64.RawURLEncoding.EncodeToString(b) }

func digest(alg Algorithm, data []byte) []byte {
	switch alg.hash() {
	case crypto.SHA384:
		s := sha512.Sum384(data)
		return s[:]
	case crypto.SHA512:
		s := sha512.Sum512(data)
		return s[:]
	}
	s := sha256.Sum256(data)
	return s[:]
}

func signInput(alg Algorithm, input []byte, key Key) ([]byte, error) {
	if alg.Family() == FamilyHMAC {
		if key.Kind != KeySecret {
			return nil, fmt.Errorf("%w: %s needs a shared secret", ErrKey, alg)
		}
		if len(key.Data) == 0 {
			return nil, fmt.Errorf("%w: the secret is empty", ErrKey)
		}
		m := hmac.New(alg.hash().New, key.Data)
		m.Write(input)
		return m.Sum(nil), nil
	}
	if key.Kind != KeyPEM {
		return nil, fmt.Errorf("%w: %s needs a PEM private key", ErrKey, alg)
	}
	priv, err := parsePrivate(key.Data)
	if err != nil {
		return nil, err
	}
	switch k := priv.(type) {
	case *rsa.PrivateKey:
		if alg.Family() != FamilyRSA {
			break
		}
		if strings.HasPrefix(string(alg), "PS") {
			return rsa.SignPSS(Rand, k, alg.hash(), digest(alg, input), &rsa.PSSOptions{SaltLength: rsa.PSSSaltLengthEqualsHash})
		}
		return rsa.SignPKCS1v15(Rand, k, alg.hash(), digest(alg, input))
	case *ecdsa.PrivateKey:
		if alg.Family() != FamilyEC {
			break
		}
		if k.Curve != alg.curve() {
			return nil, fmt.Errorf("%w: %s needs a %s key", ErrKey, alg, alg.curve().Params().Name)
		}
		r, s, err := ecdsa.Sign(Rand, k, digest(alg, input))
		if err != nil {
			return nil, err
		}
		size := (k.Curve.Params().BitSize + 7) / 8
		out := make([]byte, 2*size)
		r.FillBytes(out[:size])
		s.FillBytes(out[size:])
		return out, nil
	case ed25519.PrivateKey:
		if alg == EdDSA {
			return ed25519.Sign(k, input), nil
		}
	}
	return nil, fmt.Errorf("%w: the key doesn't fit %s", ErrKey, alg)
}

func parsePrivate(data []byte) (crypto.PrivateKey, error) {
	block, _ := pem.Decode(data)
	if block == nil {
		return nil, fmt.Errorf("%w: no PEM block found", ErrKey)
	}
	if k, err := x509.ParsePKCS8PrivateKey(block.Bytes); err == nil {
		return k, nil
	}
	if k, err := x509.ParsePKCS1PrivateKey(block.Bytes); err == nil {
		return k, nil
	}
	if k, err := x509.ParseECPrivateKey(block.Bytes); err == nil {
		return k, nil
	}
	return nil, fmt.Errorf("%w: the PEM block isn't a private key", ErrKey)
}

// Result is the outcome of Verify.
type Result struct {
	Valid bool      `json:"valid"`
	Alg   Algorithm `json:"alg"`
	Kid   string    `json:"kid"`
	// Reason says why the token isn't valid ("" when it is).
	Reason string `json:"reason"`
}

// Verify checks token's signature with key. An unsigned token (alg none)
// is never valid. Malformed tokens are an error; a signature that doesn't
// match is a Result with Valid false and a Reason.
func Verify(token string, key Key) (Result, error) {
	parts := strings.Split(strings.TrimSpace(token), ".")
	if len(parts) != 3 {
		return Result{}, errors.New("a signed JWT has three parts separated by dots")
	}
	hb, err := base64.RawURLEncoding.DecodeString(parts[0])
	if err != nil {
		return Result{}, errors.New("the header isn't valid base64url")
	}
	var h struct {
		Alg string `json:"alg"`
		Kid string `json:"kid"`
	}
	if err := json.Unmarshal(hb, &h); err != nil {
		return Result{}, errors.New("the header isn't JSON")
	}
	res := Result{Alg: Algorithm(h.Alg), Kid: h.Kid}
	if strings.EqualFold(h.Alg, "none") {
		res.Reason = "Unsigned token"
		return res, nil
	}
	if res.Alg.Family() == "" {
		return res, fmt.Errorf("%w %q", ErrAlgorithm, h.Alg)
	}
	sig, err := base64.RawURLEncoding.DecodeString(parts[2])
	if err != nil {
		return res, errors.New("the signature isn't valid base64url")
	}
	input := []byte(parts[0] + "." + parts[1])

	if res.Alg.Family() == FamilyHMAC {
		if key.Kind != KeySecret {
			res.Reason = fmt.Sprintf("Algorithm %s needs a shared secret, not a public key", res.Alg)
			return res, nil
		}
		want, err := signInput(res.Alg, input, key)
		if err != nil {
			return res, err
		}
		return verdict(res, hmac.Equal(sig, want)), nil
	}
	pubs, err := publicKeys(key, h.Kid)
	if err != nil {
		return res, err
	}
	fits := false
	for _, pub := range pubs {
		ok, fit := verifyWith(res.Alg, pub, input, sig)
		fits = fits || fit
		if ok {
			return verdict(res, true), nil
		}
	}
	if !fits {
		res.Reason = fmt.Sprintf("Algorithm %s needs a %s key", res.Alg, familyKeyName(res.Alg))
		return res, nil
	}
	return verdict(res, false), nil
}

func familyKeyName(a Algorithm) string {
	switch a.Family() {
	case FamilyRSA:
		return "RSA"
	case FamilyEC:
		return a.curve().Params().Name + " EC"
	}
	return "Ed25519"
}

func verdict(r Result, ok bool) Result {
	r.Valid = ok
	if !ok {
		r.Reason = "Signature doesn't match"
	}
	return r
}

// verifyWith reports whether sig verifies, and whether the key fits alg.
func verifyWith(alg Algorithm, pub crypto.PublicKey, input, sig []byte) (ok, fits bool) {
	switch k := pub.(type) {
	case *rsa.PublicKey:
		if alg.Family() != FamilyRSA {
			return false, false
		}
		if strings.HasPrefix(string(alg), "PS") {
			return rsa.VerifyPSS(k, alg.hash(), digest(alg, input), sig, &rsa.PSSOptions{SaltLength: rsa.PSSSaltLengthAuto}) == nil, true
		}
		return rsa.VerifyPKCS1v15(k, alg.hash(), digest(alg, input), sig) == nil, true
	case *ecdsa.PublicKey:
		if alg.Family() != FamilyEC || k.Curve != alg.curve() {
			return false, false
		}
		size := (k.Curve.Params().BitSize + 7) / 8
		if len(sig) != 2*size {
			return false, true
		}
		r, s := new(big.Int).SetBytes(sig[:size]), new(big.Int).SetBytes(sig[size:])
		return ecdsa.Verify(k, digest(alg, input), r, s), true
	case ed25519.PublicKey:
		if alg != EdDSA {
			return false, false
		}
		return ed25519.Verify(k, input, sig), true
	}
	return false, false
}

// publicKeys returns the verification keys in key: one for PEM and JWK,
// those matching kid for a JWK set (all of them when kid is "" or matches
// none).
func publicKeys(key Key, kid string) ([]crypto.PublicKey, error) {
	switch key.Kind {
	case KeyPEM:
		k, err := parsePublic(key.Data)
		if err != nil {
			return nil, err
		}
		return []crypto.PublicKey{k}, nil
	case KeyJWK:
		k, _, err := parseJWK(key.Data)
		if err != nil {
			return nil, err
		}
		return []crypto.PublicKey{k}, nil
	case KeyJWKS:
		var set struct {
			Keys []json.RawMessage `json:"keys"`
		}
		if err := json.Unmarshal(key.Data, &set); err != nil {
			return nil, fmt.Errorf("%w: the key set isn't JSON", ErrKey)
		}
		var all, matched []crypto.PublicKey
		for _, raw := range set.Keys {
			k, id, err := parseJWK(raw)
			if err != nil {
				continue // keys of other types (oct, unknown curves)
			}
			all = append(all, k)
			if kid != "" && id == kid {
				matched = append(matched, k)
			}
		}
		if len(matched) > 0 {
			return matched, nil
		}
		if len(all) == 0 {
			return nil, fmt.Errorf("%w: the key set has no usable public keys", ErrKey)
		}
		return all, nil
	}
	return nil, fmt.Errorf("%w: a public key, certificate or JWK is needed", ErrKey)
}

func parsePublic(data []byte) (crypto.PublicKey, error) {
	block, _ := pem.Decode(data)
	if block == nil {
		return nil, fmt.Errorf("%w: no PEM block found", ErrKey)
	}
	if k, err := x509.ParsePKIXPublicKey(block.Bytes); err == nil {
		return k, nil
	}
	if k, err := x509.ParsePKCS1PublicKey(block.Bytes); err == nil {
		return k, nil
	}
	if c, err := x509.ParseCertificate(block.Bytes); err == nil {
		return c.PublicKey, nil
	}
	if k, err := parsePrivate(data); err == nil {
		if s, ok := k.(crypto.Signer); ok {
			return s.Public(), nil
		}
	}
	return nil, fmt.Errorf("%w: the PEM block isn't a public key, certificate or private key", ErrKey)
}

type jwk struct {
	Kty string `json:"kty"`
	Kid string `json:"kid"`
	Crv string `json:"crv"`
	N   string `json:"n"`
	E   string `json:"e"`
	X   string `json:"x"`
	Y   string `json:"y"`
}

func parseJWK(data []byte) (crypto.PublicKey, string, error) {
	var j jwk
	if err := json.Unmarshal(data, &j); err != nil {
		return nil, "", fmt.Errorf("%w: the JWK isn't JSON", ErrKey)
	}
	b := func(s string) *big.Int {
		v, err := base64.RawURLEncoding.DecodeString(strings.TrimRight(s, "="))
		if err != nil || len(v) == 0 {
			return nil
		}
		return new(big.Int).SetBytes(v)
	}
	switch j.Kty {
	case "RSA":
		n, e := b(j.N), b(j.E)
		if n == nil || e == nil || !e.IsInt64() {
			break
		}
		return &rsa.PublicKey{N: n, E: int(e.Int64())}, j.Kid, nil
	case "EC":
		curves := map[string]elliptic.Curve{"P-256": elliptic.P256(), "P-384": elliptic.P384(), "P-521": elliptic.P521()}
		c, x, y := curves[j.Crv], b(j.X), b(j.Y)
		if c == nil || x == nil || y == nil {
			break
		}
		// Parsing the uncompressed point checks that it is on the curve.
		size := (c.Params().BitSize + 7) / 8
		raw := make([]byte, 1+2*size)
		raw[0] = 4
		x.FillBytes(raw[1 : 1+size])
		y.FillBytes(raw[1+size:])
		k, err := ecdsa.ParseUncompressedPublicKey(c, raw)
		if err != nil {
			break
		}
		return k, j.Kid, nil
	case "OKP":
		x, err := base64.RawURLEncoding.DecodeString(strings.TrimRight(j.X, "="))
		if j.Crv != "Ed25519" || err != nil || len(x) != ed25519.PublicKeySize {
			break
		}
		return ed25519.PublicKey(x), j.Kid, nil
	}
	return nil, "", fmt.Errorf("%w: unsupported or incomplete JWK (kty %q)", ErrKey, j.Kty)
}
