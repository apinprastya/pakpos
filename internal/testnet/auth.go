package testnet

import (
	"bytes"
	"crypto/hmac"
	"crypto/md5" //nolint:gosec // Digest and NTLM test servers
	"crypto/sha256"
	"encoding/base64"
	"encoding/binary"
	"encoding/hex"
	"fmt"
	"hash"
	"io"
	"net/http"
	"strings"
	"sync"
	"time"
	"unicode/utf16"

	"golang.org/x/crypto/md4" //nolint:staticcheck,gosec // NTLM hashes passwords with MD4

	"pakpos/internal/core/auth/awsv4"
	"pakpos/internal/core/auth/digest"
	"pakpos/internal/core/auth/hawk"
	"pakpos/internal/core/jwtx"
)

// DigestConfig configures a Digest auth test server.
type DigestConfig struct {
	User, Password, Realm string
	// Algorithm is the one challenged with (MD5 when empty).
	Algorithm string
	Qop       []string
	UserHash  bool
	Opaque    string
}

// Digest returns a handler that answers requests without valid Digest
// credentials with a 401 challenge, and passes the rest to next. The
// answer is checked independently of the client code (RFC 7616 §3.4.1).
func Digest(c DigestConfig, next http.Handler) http.Handler {
	if c.Algorithm == "" {
		c.Algorithm = digest.MD5
	}
	const nonce = "dcd98b7102dd2f0e8b11d0f600bfb0c093"
	challenge := fmt.Sprintf(`Digest realm=%q, nonce=%q, algorithm=%s`, c.Realm, nonce, c.Algorithm)
	if len(c.Qop) > 0 {
		challenge += fmt.Sprintf(`, qop=%q`, strings.Join(c.Qop, ", "))
	}
	if c.Opaque != "" {
		challenge += fmt.Sprintf(`, opaque=%q`, c.Opaque)
	}
	if c.UserHash {
		challenge += ", userhash=true"
	}
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		body, _ := io.ReadAll(r.Body)
		r.Body = io.NopCloser(bytes.NewReader(body))
		p, ok := digest.Params(r.Header.Get("Authorization"))
		if !ok || !digestValid(c, nonce, p, r, body) {
			w.Header().Set("WWW-Authenticate", challenge)
			http.Error(w, "digest auth required", http.StatusUnauthorized)
			return
		}
		next.ServeHTTP(w, r)
	})
}

func digestValid(c DigestConfig, nonce string, p map[string]string, r *http.Request, body []byte) bool {
	var nh func() hash.Hash
	switch p["algorithm"] {
	case digest.MD5, digest.MD5Sess:
		nh = md5.New
	case digest.SHA256, digest.SHA256Sess:
		nh = sha256.New
	default:
		return false
	}
	h := func(s string) string { x := nh(); x.Write([]byte(s)); return hex.EncodeToString(x.Sum(nil)) }
	user := c.User
	if c.UserHash {
		user = h(c.User + ":" + c.Realm)
	}
	if p["username"] != user || p["realm"] != c.Realm || p["nonce"] != nonce || p["uri"] != r.RequestURI ||
		p["opaque"] != c.Opaque || p["algorithm"] != c.Algorithm {
		return false
	}
	ha1 := h(c.User + ":" + c.Realm + ":" + c.Password)
	if strings.HasSuffix(p["algorithm"], "-sess") {
		ha1 = h(ha1 + ":" + nonce + ":" + p["cnonce"])
	}
	a2 := r.Method + ":" + p["uri"]
	if p["qop"] == digest.QopAuthInt {
		a2 += ":" + h(string(body))
	}
	want := h(ha1 + ":" + nonce + ":" + h(a2))
	if p["qop"] != "" {
		want = h(strings.Join([]string{ha1, nonce, p["nc"], p["cnonce"], p["qop"], h(a2)}, ":"))
	}
	return hmac.Equal([]byte(p["response"]), []byte(want))
}

// NTLM returns a handler that runs the server side of an NTLMv2 handshake
// for one account and passes authenticated requests to next. The
// challenge is kept per connection (remote address), so an AUTHENTICATE
// message on another connection fails, as with real servers.
func NTLM(user, domain, password string, next http.Handler) http.Handler {
	var mu sync.Mutex
	challenges := map[string][]byte{}
	deny := func(w http.ResponseWriter, value string) {
		w.Header().Set("WWW-Authenticate", value)
		http.Error(w, "ntlm auth required", http.StatusUnauthorized)
	}
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		body, _ := io.ReadAll(r.Body)
		r.Body = io.NopCloser(bytes.NewReader(body))
		scheme, data, _ := strings.Cut(r.Header.Get("Authorization"), " ")
		msg, err := base64.StdEncoding.DecodeString(data)
		if !strings.EqualFold(scheme, "NTLM") || err != nil || len(msg) < 12 {
			deny(w, "NTLM")
			return
		}
		switch binary.LittleEndian.Uint32(msg[8:12]) {
		case 1:
			ch := []byte{1, 2, 3, 4, 5, 6, 7, 8}
			mu.Lock()
			challenges[r.RemoteAddr] = ch
			mu.Unlock()
			deny(w, "NTLM "+base64.StdEncoding.EncodeToString(challengeMessage(ch)))
		case 3:
			mu.Lock()
			ch := challenges[r.RemoteAddr]
			delete(challenges, r.RemoteAddr)
			mu.Unlock()
			if ch == nil || !ntlmValid(msg, ch, user, domain, password) {
				deny(w, "NTLM")
				return
			}
			next.ServeHTTP(w, r)
		default:
			deny(w, "NTLM")
		}
	})
}

func challengeMessage(serverChallenge []byte) []byte {
	const flags = 0x1 | 0x4 | 0x200 | 0x8000 | 0x80000 | 0x800000 // unicode, target, NTLM, always sign, ESS, target info
	m := make([]byte, 48, 52)
	copy(m, "NTLMSSP\x00")
	binary.LittleEndian.PutUint32(m[8:], 2)
	binary.LittleEndian.PutUint32(m[20:], flags)
	copy(m[24:32], serverChallenge)
	binary.LittleEndian.PutUint16(m[40:], 4) // target info: MsvAvEOL
	binary.LittleEndian.PutUint16(m[42:], 4)
	binary.LittleEndian.PutUint32(m[44:], 48)
	return append(m, 0, 0, 0, 0)
}

func field(msg []byte, at int) []byte {
	if len(msg) < at+8 {
		return nil
	}
	n, off := int(binary.LittleEndian.Uint16(msg[at:])), int(binary.LittleEndian.Uint32(msg[at+4:]))
	if off+n > len(msg) {
		return nil
	}
	return msg[off : off+n]
}

func utf16le(s string) []byte {
	var b []byte
	for _, u := range utf16.Encode([]rune(s)) {
		b = binary.LittleEndian.AppendUint16(b, u)
	}
	return b
}

func ntlmValid(msg, serverChallenge []byte, user, domain, password string) bool {
	nt := field(msg, 20)
	if len(nt) <= 16 || !bytes.Equal(field(msg, 36), utf16le(user)) || !bytes.Equal(field(msg, 28), utf16le(domain)) {
		return false
	}
	h4 := md4.New() //nolint:gosec // NTLM hashes passwords with MD4
	h4.Write(utf16le(password))
	m := hmac.New(md5.New, h4.Sum(nil))
	m.Write(utf16le(strings.ToUpper(user) + domain))
	v2 := m.Sum(nil)
	proof := hmac.New(md5.New, v2)
	proof.Write(serverChallenge)
	proof.Write(nt[16:])
	return hmac.Equal(proof.Sum(nil), nt[:16])
}

// AWSV4 returns a handler that checks an AWS Signature v4 Authorization
// header by signing the received request again, and passes valid
// requests to next.
func AWSV4(c awsv4.Credentials, region, service string, next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		body, _ := io.ReadAll(r.Body)
		r.Body = io.NopCloser(bytes.NewReader(body))
		got := r.Header.Get("Authorization")
		t, err := time.Parse("20060102T150405Z", r.Header.Get(awsv4.HeaderDate))
		if err != nil || got == "" {
			http.Error(w, "missing signature", http.StatusForbidden)
			return
		}
		hash := awsv4.HashPayload(body)
		if v := r.Header.Get(awsv4.HeaderContent); v == awsv4.UnsignedPayload {
			hash = v
		}
		check := r.Clone(r.Context())
		check.URL.Host, check.URL.Scheme = r.Host, "http"
		check.Header.Del("Authorization")
		if err := awsv4.Sign(check, c, awsv4.Options{Region: region, Service: service, Time: t, PayloadHash: hash}); err != nil ||
			check.Header.Get("Authorization") != got {
			http.Error(w, "signature mismatch: "+got, http.StatusForbidden)
			return
		}
		next.ServeHTTP(w, r)
	})
}

// Hawk returns a handler that checks a Hawk Authorization header (and its
// payload hash, when sent) and passes valid requests to next.
func Hawk(id, key, algorithm string, next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		body, _ := io.ReadAll(r.Body)
		r.Body = io.NopCloser(bytes.NewReader(body))
		got := r.Header.Get("Authorization")
		attrs := hawkAttrs(got)
		var ts int64
		_, _ = fmt.Sscan(attrs["ts"], &ts)
		if attrs["hash"] != "" {
			want, _ := hawk.PayloadHash(algorithm, r.Header.Get("Content-Type"), body)
			if want != attrs["hash"] {
				http.Error(w, "payload hash mismatch", http.StatusUnauthorized)
				return
			}
		}
		u := *r.URL
		u.Scheme, u.Host = "http", r.Host
		want, err := hawk.Header(hawk.Credentials{ID: id, Key: key, Algorithm: algorithm},
			hawk.Options{Method: r.Method, URL: &u, Time: time.Unix(ts, 0), Nonce: attrs["nonce"], Ext: attrs["ext"],
				App: attrs["app"], Dlg: attrs["dlg"], Hash: attrs["hash"]})
		if err != nil || attrs["id"] != id || hawkAttrs(want)["mac"] != attrs["mac"] {
			http.Error(w, "hawk mac mismatch", http.StatusUnauthorized)
			return
		}
		next.ServeHTTP(w, r)
	})
}

func hawkAttrs(header string) map[string]string {
	out := map[string]string{}
	rest, ok := strings.CutPrefix(header, "Hawk ")
	if !ok {
		return out
	}
	for _, part := range strings.Split(rest, `", `) {
		k, v, _ := strings.Cut(part, `="`)
		out[strings.TrimSpace(k)] = strings.TrimSuffix(v, `"`)
	}
	return out
}

// JWT returns a handler that checks a bearer JWT (in the Authorization
// header, or the query parameter param when not empty) with key and passes
// valid requests to next.
func JWT(key jwtx.Key, param string, next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		tok := strings.TrimPrefix(r.Header.Get("Authorization"), "Bearer ")
		if param != "" {
			tok = r.URL.Query().Get(param)
		}
		if res, err := jwtx.Verify(tok, key); err != nil || !res.Valid {
			http.Error(w, "invalid token", http.StatusUnauthorized)
			return
		}
		next.ServeHTTP(w, r)
	})
}
