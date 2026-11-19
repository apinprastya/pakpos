package jwtx

import (
	"crypto"
	"crypto/ecdsa"
	"crypto/ed25519"
	"crypto/elliptic"
	"crypto/hmac"
	"crypto/rand"
	"crypto/rsa"
	"crypto/x509"
	"crypto/x509/pkix"
	"encoding/base64"
	"encoding/json"
	"encoding/pem"
	"errors"
	"fmt"
	"math/big"
	"strings"
	"testing"
	"time"
)

type keys struct {
	rsa              *rsa.PrivateKey
	p256, p384, p521 *ecdsa.PrivateKey
	ed               ed25519.PrivateKey
}

func newKeys(t *testing.T) keys {
	t.Helper()
	var k keys
	var err error
	if k.rsa, err = rsa.GenerateKey(rand.Reader, 2048); err != nil {
		t.Fatal(err)
	}
	for _, c := range []struct {
		dst   **ecdsa.PrivateKey
		curve elliptic.Curve
	}{{&k.p256, elliptic.P256()}, {&k.p384, elliptic.P384()}, {&k.p521, elliptic.P521()}} {
		if *c.dst, err = ecdsa.GenerateKey(c.curve, rand.Reader); err != nil {
			t.Fatal(err)
		}
	}
	if _, k.ed, err = ed25519.GenerateKey(rand.Reader); err != nil {
		t.Fatal(err)
	}
	return k
}

func pkcs8(t *testing.T, k any) Key {
	t.Helper()
	der, err := x509.MarshalPKCS8PrivateKey(k)
	if err != nil {
		t.Fatal(err)
	}
	return Key{Kind: KeyPEM, Data: pem.EncodeToMemory(&pem.Block{Type: "PRIVATE KEY", Bytes: der})}
}

func pubPEM(t *testing.T, k any) Key {
	t.Helper()
	der, err := x509.MarshalPKIXPublicKey(k)
	if err != nil {
		t.Fatal(err)
	}
	return Key{Kind: KeyPEM, Data: pem.EncodeToMemory(&pem.Block{Type: "PUBLIC KEY", Bytes: der})}
}

func (k keys) signer(alg Algorithm) crypto.Signer {
	switch alg.Family() {
	case FamilyRSA:
		return k.rsa
	case FamilyEC:
		return map[Algorithm]*ecdsa.PrivateKey{ES256: k.p256, ES384: k.p384, ES512: k.p521}[alg]
	}
	return k.ed
}

// stdVerify checks a token with the standard library directly, independent
// of Verify.
func stdVerify(t *testing.T, alg Algorithm, token string, secret []byte, pub crypto.PublicKey) {
	t.Helper()
	parts := strings.Split(token, ".")
	input := []byte(parts[0] + "." + parts[1])
	sig, err := base64.RawURLEncoding.DecodeString(parts[2])
	if err != nil {
		t.Fatal(err)
	}
	h := alg.hash()
	sum := func() []byte { x := h.New(); x.Write(input); return x.Sum(nil) }
	var ok bool
	switch alg {
	case HS256, HS384, HS512:
		m := hmac.New(h.New, secret)
		m.Write(input)
		ok = hmac.Equal(m.Sum(nil), sig)
	case RS256, RS384, RS512:
		ok = rsa.VerifyPKCS1v15(pub.(*rsa.PublicKey), h, sum(), sig) == nil
	case PS256, PS384, PS512:
		ok = rsa.VerifyPSS(pub.(*rsa.PublicKey), h, sum(), sig, &rsa.PSSOptions{SaltLength: rsa.PSSSaltLengthEqualsHash}) == nil
	case ES256, ES384, ES512:
		n := len(sig) / 2
		ok = ecdsa.Verify(pub.(*ecdsa.PublicKey), sum(), new(big.Int).SetBytes(sig[:n]), new(big.Int).SetBytes(sig[n:]))
	case EdDSA:
		ok = ed25519.Verify(pub.(ed25519.PublicKey), input, sig)
	}
	if !ok {
		t.Errorf("%s: the standard library rejects the signature", alg)
	}
}

func TestSignAndVerifyEveryAlgorithm(t *testing.T) {
	k := newKeys(t)
	secret := []byte("a-string-secret-at-least-256-bits-long")
	for _, alg := range Algorithms() {
		t.Run(string(alg), func(t *testing.T) {
			var signKey, verifyKey Key
			var pub crypto.PublicKey
			if alg.Family() == FamilyHMAC {
				signKey = Key{Kind: KeySecret, Data: secret}
				verifyKey = signKey
			} else {
				s := k.signer(alg)
				signKey, pub = pkcs8(t, s), s.Public()
				verifyKey = pubPEM(t, pub)
			}
			tok, err := Sign(alg, []byte(`{"kid":"k1"}`), []byte(`{"sub":"1234567890","big":12345678901234567890,"name":"<é>"}`), signKey)
			if err != nil {
				t.Fatal(err)
			}
			stdVerify(t, alg, tok, secret, pub)
			res, err := Verify(tok, verifyKey)
			if err != nil || !res.Valid || res.Alg != alg || res.Kid != "k1" {
				t.Errorf("Verify = %+v, %v", res, err)
			}
			hb, _ := base64.RawURLEncoding.DecodeString(strings.Split(tok, ".")[0])
			pb, _ := base64.RawURLEncoding.DecodeString(strings.Split(tok, ".")[1])
			if string(hb) != `{"alg":"`+string(alg)+`","kid":"k1","typ":"JWT"}` {
				t.Errorf("header = %s", hb)
			}
			if string(pb) != `{"big":12345678901234567890,"name":"<é>","sub":"1234567890"}` {
				t.Errorf("payload = %s", pb)
			}
			// A changed payload fails.
			parts := strings.Split(tok, ".")
			parts[1] = enc([]byte(`{"sub":"x"}`))
			if res, err := Verify(strings.Join(parts, "."), verifyKey); err != nil || res.Valid || res.Reason != "Signature doesn't match" {
				t.Errorf("tampered = %+v, %v", res, err)
			}
		})
	}
}

// The jwt.io HS256 example token.
func TestKnownHS256(t *testing.T) {
	key, _ := SecretKey("a-string-secret-at-least-256-bits-long", false)
	tok, err := Sign(HS256, nil, []byte(`{"sub":"1234567890","name":"John Doe","admin":true,"iat":1516239022}`), key)
	if err != nil {
		t.Fatal(err)
	}
	// Fields are sorted, so the payload differs from jwt.io's; recompute
	// with the same header and payload bytes through Verify.
	if res, _ := Verify(tok, key); !res.Valid {
		t.Error("own token")
	}
	jwtio := "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIiwibmFtZSI6IkpvaG4gRG9lIiwiYWRtaW4iOnRydWUsImlhdCI6MTUxNjIzOTAyMn0.KMUFsIDTnFmyG3nMiGM6H9FNFUROf3wh7SmqJp-QV30"
	if res, err := Verify(jwtio, key); err != nil || !res.Valid {
		t.Errorf("jwt.io token: %+v %v", res, err)
	}
}

func TestSecretKey(t *testing.T) {
	for _, in := range []string{"c2VjcmV0", "c2VjcmV0==", " c2VjcmV0 "} {
		if k, err := SecretKey(in, true); err != nil || string(k.Data) != "secret" {
			t.Errorf("%q: %q %v", in, k.Data, err)
		}
	}
	if k, _ := SecretKey("-_8", true); len(k.Data) != 2 {
		t.Error("URL alphabet")
	}
	if _, err := SecretKey("!!", true); err == nil {
		t.Error("bad base64")
	}
}

func TestSignErrors(t *testing.T) {
	k := newKeys(t)
	secret := Key{Kind: KeySecret, Data: []byte("s")}
	ecKey := pkcs8(t, k.p256)
	tests := []struct {
		name    string
		alg     Algorithm
		header  string
		payload string
		key     Key
		want    error
	}{
		{"unknown alg", "none", "", "{}", secret, ErrAlgorithm},
		{"header not an object", HS256, "[1]", "{}", secret, ErrJSON},
		{"payload not JSON", HS256, "", "{", secret, ErrJSON},
		{"trailing text", HS256, "", "{} {}", secret, ErrJSON},
		{"null payload", HS256, "", "null", secret, ErrJSON},
		{"hmac with pem", HS256, "", "{}", ecKey, ErrKey},
		{"empty secret", HS256, "", "{}", Key{Kind: KeySecret}, ErrKey},
		{"rsa with secret", RS256, "", "{}", secret, ErrKey},
		{"no pem", RS256, "", "{}", Key{Kind: KeyPEM, Data: []byte("x")}, ErrKey},
		{"public key", RS256, "", "{}", pubPEM(t, k.rsa.Public()), ErrKey},
		{"rsa alg with ec key", RS256, "", "{}", ecKey, ErrKey},
		{"curve mismatch", ES384, "", "{}", ecKey, ErrKey},
		{"ec alg with rsa key", ES256, "", "{}", pkcs8(t, k.rsa), ErrKey},
		{"eddsa with ec key", EdDSA, "", "{}", ecKey, ErrKey},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if _, err := Sign(tt.alg, []byte(tt.header), []byte(tt.payload), tt.key); !errors.Is(err, tt.want) {
				t.Errorf("err = %v, want %v", err, tt.want)
			}
		})
	}
	// PKCS#1 and SEC1 PEM keys sign too.
	pk1 := Key{Kind: KeyPEM, Data: pem.EncodeToMemory(&pem.Block{Type: "RSA PRIVATE KEY", Bytes: x509.MarshalPKCS1PrivateKey(k.rsa)})}
	if _, err := Sign(RS256, nil, nil, pk1); err != nil {
		t.Error(err)
	}
	sec1, _ := x509.MarshalECPrivateKey(k.p256)
	if _, err := Sign(ES256, nil, nil, Key{Kind: KeyPEM, Data: pem.EncodeToMemory(&pem.Block{Type: "EC PRIVATE KEY", Bytes: sec1})}); err != nil {
		t.Error(err)
	}
	if o, err := Object(nil); err != nil || len(o) != 0 {
		t.Error("Object(nil)")
	}
}

func jwkOf(t *testing.T, pub crypto.PublicKey, kid string) string {
	t.Helper()
	b := func(x []byte) string { return base64.RawURLEncoding.EncodeToString(x) }
	var m map[string]string
	switch k := pub.(type) {
	case *rsa.PublicKey:
		m = map[string]string{"kty": "RSA", "n": b(k.N.Bytes()), "e": b(big.NewInt(int64(k.E)).Bytes())}
	case *ecdsa.PublicKey:
		raw, _ := k.Bytes()
		n := (len(raw) - 1) / 2
		m = map[string]string{"kty": "EC", "crv": k.Curve.Params().Name, "x": b(raw[1 : 1+n]), "y": b(raw[1+n:])}
	case ed25519.PublicKey:
		m = map[string]string{"kty": "OKP", "crv": "Ed25519", "x": b(k)}
	}
	m["kid"] = kid
	out, _ := json.Marshal(m)
	return string(out)
}

func TestVerifyKeys(t *testing.T) {
	k := newKeys(t)
	sign := func(alg Algorithm, kid string) string {
		tok, err := Sign(alg, []byte(fmt.Sprintf(`{"kid":%q}`, kid)), []byte(`{"a":1}`), pkcs8(t, k.signer(alg)))
		if err != nil {
			t.Fatal(err)
		}
		return tok
	}
	rs, es, ed := sign(RS256, "r"), sign(ES256, "e"), sign(EdDSA, "")

	// Certificate and private key PEMs verify too.
	tmpl := &x509.Certificate{SerialNumber: big.NewInt(1), Subject: pkix.Name{CommonName: "t"}, NotBefore: time.Now(), NotAfter: time.Now().Add(time.Hour)}
	der, err := x509.CreateCertificate(rand.Reader, tmpl, tmpl, k.rsa.Public(), k.rsa)
	if err != nil {
		t.Fatal(err)
	}
	cert := Key{Kind: KeyPEM, Data: pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: der})}
	pk1pub := Key{Kind: KeyPEM, Data: pem.EncodeToMemory(&pem.Block{Type: "RSA PUBLIC KEY", Bytes: x509.MarshalPKCS1PublicKey(&k.rsa.PublicKey)})}
	set := Key{Kind: KeyJWKS, Data: []byte(`{"keys":[{"kty":"oct","k":"x"},` + jwkOf(t, k.rsa.Public(), "r") + `,` + jwkOf(t, k.p256.Public(), "e") + `,` + jwkOf(t, k.ed.Public(), "d") + `]}`)}

	valid := []struct {
		name  string
		token string
		key   Key
	}{
		{"cert", rs, cert}, {"pkcs1 public", rs, pk1pub}, {"private key", rs, pkcs8(t, k.rsa)},
		{"rsa jwk", rs, Key{Kind: KeyJWK, Data: []byte(jwkOf(t, k.rsa.Public(), ""))}},
		{"ec jwk", es, Key{Kind: KeyJWK, Data: []byte(jwkOf(t, k.p256.Public(), ""))}},
		{"ed jwk", ed, Key{Kind: KeyJWK, Data: []byte(jwkOf(t, k.ed.Public(), ""))}},
		{"set by kid", rs, set}, {"set by kid ec", es, set}, {"set without kid", ed, set},
	}
	for _, tt := range valid {
		if res, err := Verify(tt.token, tt.key); err != nil || !res.Valid {
			t.Errorf("%s: %+v %v", tt.name, res, err)
		}
	}

	invalid := []struct {
		name   string
		token  string
		key    Key
		reason string
	}{
		{"hs with public key", mustHS(t), pubPEM(t, k.rsa.Public()), "Algorithm HS256 needs a shared secret, not a public key"},
		{"rs with ec key", rs, pubPEM(t, k.p256.Public()), "Algorithm RS256 needs a RSA key"},
		{"es with wrong curve", es, pubPEM(t, k.p384.Public()), "Algorithm ES256 needs a P-256 EC key"},
		{"ed with rsa", ed, pubPEM(t, k.rsa.Public()), "Algorithm EdDSA needs a Ed25519 key"},
		{"es short signature", cut(es), pubPEM(t, k.p256.Public()), "Signature doesn't match"},
		{"other rsa key", rs, pubPEM(t, mustRSA(t).Public()), "Signature doesn't match"},
		{"unsigned", enc([]byte(`{"alg":"none"}`)) + "." + enc([]byte(`{}`)) + ".", Key{}, "Unsigned token"},
	}
	for _, tt := range invalid {
		if res, err := Verify(tt.token, tt.key); err != nil || res.Valid || res.Reason != tt.reason {
			t.Errorf("%s: %+v %v", tt.name, res, err)
		}
	}

	errs := []struct {
		name  string
		token string
		key   Key
	}{
		{"two parts", "a.b", Key{}},
		{"header base64", "!.b.c", Key{}},
		{"header json", enc([]byte("x")) + ".b.c", Key{}},
		{"unknown alg", enc([]byte(`{"alg":"XX1"}`)) + ".b.c", Key{}},
		{"sig base64", enc([]byte(`{"alg":"HS256"}`)) + ".b.!", Key{Kind: KeySecret, Data: []byte("s")}},
		{"empty secret", enc([]byte(`{"alg":"HS256"}`)) + ".b.c", Key{Kind: KeySecret}},
		{"secret for rs", rs, Key{Kind: KeySecret, Data: []byte("s")}},
		{"bad pem", rs, Key{Kind: KeyPEM, Data: []byte("x")}},
		{"pem not a key", rs, Key{Kind: KeyPEM, Data: pem.EncodeToMemory(&pem.Block{Type: "X", Bytes: []byte("x")})}},
		{"bad jwk", rs, Key{Kind: KeyJWK, Data: []byte("x")}},
		{"incomplete jwk", rs, Key{Kind: KeyJWK, Data: []byte(`{"kty":"RSA"}`)}},
		{"bad ec jwk", es, Key{Kind: KeyJWK, Data: []byte(`{"kty":"EC","crv":"P-256","x":"AQ","y":"AQ"}`)}},
		{"bad okp jwk", ed, Key{Kind: KeyJWK, Data: []byte(`{"kty":"OKP","crv":"X25519","x":"AQ"}`)}},
		{"bad set", rs, Key{Kind: KeyJWKS, Data: []byte("x")}},
		{"empty set", rs, Key{Kind: KeyJWKS, Data: []byte(`{"keys":[]}`)}},
	}
	for _, tt := range errs {
		if _, err := Verify(tt.token, tt.key); err == nil {
			t.Errorf("%s: no error", tt.name)
		}
	}
}

func mustHS(t *testing.T) string {
	tok, err := Sign(HS256, nil, nil, Key{Kind: KeySecret, Data: []byte("s")})
	if err != nil {
		t.Fatal(err)
	}
	return tok
}

func mustRSA(t *testing.T) *rsa.PrivateKey {
	k, err := rsa.GenerateKey(rand.Reader, 2048)
	if err != nil {
		t.Fatal(err)
	}
	return k
}

func cut(tok string) string {
	parts := strings.Split(tok, ".")
	parts[2] = enc([]byte("short"))
	return strings.Join(parts, ".")
}
