// Package digest implements the client side of HTTP Digest access
// authentication (RFC 7616, with the RFC 2617 forms it keeps): parsing
// WWW-Authenticate challenges and computing the Authorization header for
// MD5, MD5-sess, SHA-256 and SHA-256-sess, with qop auth or auth-int and
// the optional userhash. It has no I/O.
package digest

import (
	"crypto/md5" //nolint:gosec // MD5 is what Digest auth servers ask for
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"hash"
	"io"
	"net/url"
	"strings"
)

// Algorithms in order of preference (the strongest first).
const (
	SHA256     = "SHA-256"
	SHA256Sess = "SHA-256-sess"
	MD5        = "MD5"
	MD5Sess    = "MD5-sess"
)

var preference = []string{SHA256, SHA256Sess, MD5, MD5Sess}

// Quality of protection values.
const (
	QopAuth    = "auth"
	QopAuthInt = "auth-int"
)

// Challenge is one Digest challenge from a WWW-Authenticate header.
type Challenge struct {
	Realm     string
	Nonce     string
	Opaque    string
	Algorithm string // canonical spelling; MD5 when the server gives none
	Qop       []string
	UserHash  bool
	Charset   string
	Stale     bool
}

// ErrNoChallenge is returned by Choose when no challenge can be answered.
var ErrNoChallenge = errors.New("the server sent no Digest challenge Pakpos supports")

// Parse returns the Digest challenges in WWW-Authenticate header values
// (one header may hold several challenges; other schemes are skipped).
func Parse(values []string) []Challenge {
	var out []Challenge
	for _, v := range values {
		for _, raw := range splitChallenges(v) {
			if !strings.EqualFold(raw.scheme, "Digest") {
				continue
			}
			c := Challenge{Algorithm: MD5}
			for k, val := range raw.params {
				switch k {
				case "realm":
					c.Realm = val
				case "nonce":
					c.Nonce = val
				case "opaque":
					c.Opaque = val
				case "algorithm":
					c.Algorithm = canonicalAlgorithm(val)
				case "qop":
					for _, q := range strings.Split(val, ",") {
						if q = strings.ToLower(strings.TrimSpace(q)); q != "" {
							c.Qop = append(c.Qop, q)
						}
					}
				case "userhash":
					c.UserHash = strings.EqualFold(val, "true")
				case "charset":
					c.Charset = val
				case "stale":
					c.Stale = strings.EqualFold(val, "true")
				}
			}
			out = append(out, c)
		}
	}
	return out
}

func canonicalAlgorithm(a string) string {
	for _, known := range preference {
		if strings.EqualFold(a, known) {
			return known
		}
	}
	return a
}

// Supported reports whether algorithm is one Pakpos can compute.
func Supported(algorithm string) bool {
	for _, a := range preference {
		if a == canonicalAlgorithm(algorithm) {
			return true
		}
	}
	return false
}

// Choose picks the challenge to answer: the one with the preferred
// algorithm when the server offers it, else the strongest supported one.
// A challenge without a nonce is skipped.
func Choose(cs []Challenge, prefer string) (Challenge, error) {
	prefer = canonicalAlgorithm(strings.TrimSpace(prefer))
	order := preference
	if prefer != "" {
		order = append([]string{prefer}, preference...)
	}
	for _, alg := range order {
		for _, c := range cs {
			if c.Algorithm == alg && c.Nonce != "" {
				return c, nil
			}
		}
	}
	return Challenge{}, ErrNoChallenge
}

// Request is what the response is computed over.
type Request struct {
	Method string
	// URI is the request target as sent (path and query).
	URI string
	// Body is hashed for qop auth-int.
	Body []byte
	// Qop is the preferred quality of protection: "" (auth when offered)
	// or auth-int.
	Qop string
	// CNonce and NC are the client nonce and the nonce count; a random
	// cnonce and 1 are used when they are empty or zero.
	CNonce string
	NC     uint32
}

// Params returns the parameters of a "Digest ..." Authorization header
// value (for servers and tests), or false when it isn't one.
func Params(header string) (map[string]string, bool) {
	cs := splitChallenges(header)
	if len(cs) != 1 || !strings.EqualFold(cs[0].scheme, "Digest") {
		return nil, false
	}
	return cs[0].params, true
}

// Rand is the source of client nonces (tests replace it).
var Rand io.Reader = rand.Reader

// Authorization returns the Authorization header value answering c.
func Authorization(c Challenge, username, password string, r Request) (string, error) {
	h := hasher(c.Algorithm)
	if h == nil {
		return "", fmt.Errorf("the Digest algorithm %q isn't supported", c.Algorithm)
	}
	qop := chooseQop(c.Qop, r.Qop)
	cnonce := r.CNonce
	if cnonce == "" && (qop != "" || strings.HasSuffix(c.Algorithm, "-sess")) {
		b := make([]byte, 16)
		if _, err := io.ReadFull(Rand, b); err != nil {
			return "", fmt.Errorf("make a client nonce: %w", err)
		}
		cnonce = hex.EncodeToString(b)
	}
	nc := r.NC
	if nc == 0 {
		nc = 1
	}
	ncs := fmt.Sprintf("%08x", nc)

	ha1 := h(username + ":" + c.Realm + ":" + password)
	if strings.HasSuffix(c.Algorithm, "-sess") {
		ha1 = h(ha1 + ":" + c.Nonce + ":" + cnonce)
	}
	a2 := r.Method + ":" + r.URI
	if qop == QopAuthInt {
		a2 += ":" + h(string(r.Body))
	}
	ha2 := h(a2)
	var response string
	if qop == "" {
		response = h(ha1 + ":" + c.Nonce + ":" + ha2)
	} else {
		response = h(ha1 + ":" + c.Nonce + ":" + ncs + ":" + cnonce + ":" + qop + ":" + ha2)
	}

	var b strings.Builder
	b.WriteString("Digest ")
	switch {
	case c.UserHash:
		fmt.Fprintf(&b, "username=%s", quote(h(username+":"+c.Realm)))
	case needsExtended(username):
		fmt.Fprintf(&b, "username*=UTF-8''%s", url.PathEscape(username))
	default:
		fmt.Fprintf(&b, "username=%s", quote(username))
	}
	fmt.Fprintf(&b, ", realm=%s, uri=%s, algorithm=%s, nonce=%s", quote(c.Realm), quote(r.URI), c.Algorithm, quote(c.Nonce))
	if qop != "" {
		fmt.Fprintf(&b, ", nc=%s, cnonce=%s, qop=%s", ncs, quote(cnonce), qop)
	} else if cnonce != "" { // a -sess algorithm without qop still needs it
		fmt.Fprintf(&b, ", cnonce=%s", quote(cnonce))
	}
	fmt.Fprintf(&b, ", response=%s", quote(response))
	if c.Opaque != "" {
		fmt.Fprintf(&b, ", opaque=%s", quote(c.Opaque))
	}
	if c.UserHash {
		b.WriteString(", userhash=true")
	}
	return b.String(), nil
}

// NeedsBody reports whether answering c with the preferred qop hashes the
// request body (auth-int).
func NeedsBody(c Challenge, prefer string) bool { return chooseQop(c.Qop, prefer) == QopAuthInt }

func chooseQop(offered []string, prefer string) string {
	has := func(q string) bool {
		for _, o := range offered {
			if o == q {
				return true
			}
		}
		return false
	}
	switch {
	case strings.EqualFold(prefer, QopAuthInt) && has(QopAuthInt):
		return QopAuthInt
	case has(QopAuth):
		return QopAuth
	case has(QopAuthInt):
		return QopAuthInt
	default:
		return ""
	}
}

func hasher(alg string) func(string) string {
	var newHash func() hash.Hash
	switch alg {
	case MD5, MD5Sess:
		newHash = md5.New
	case SHA256, SHA256Sess:
		newHash = sha256.New
	default:
		return nil
	}
	return func(s string) string {
		h := newHash()
		h.Write([]byte(s))
		return hex.EncodeToString(h.Sum(nil))
	}
}

func needsExtended(s string) bool {
	for i := 0; i < len(s); i++ {
		if s[i] >= 0x80 || s[i] < 0x20 || s[i] == '"' || s[i] == '\\' {
			return true
		}
	}
	return false
}

func quote(s string) string {
	return `"` + strings.NewReplacer(`\`, `\\`, `"`, `\"`).Replace(s) + `"`
}

type rawChallenge struct {
	scheme string
	params map[string]string
}

// splitChallenges parses a WWW-Authenticate value into its challenges:
// a scheme token followed by comma-separated name=value parameters (values
// may be quoted). A token68 after a scheme (Negotiate abc==) is skipped.
func splitChallenges(s string) []rawChallenge {
	var out []rawChallenge
	i := 0
	skip := func() {
		for i < len(s) && (s[i] == ' ' || s[i] == '\t' || s[i] == ',') {
			i++
		}
	}
	for {
		skip()
		if i >= len(s) {
			return out
		}
		start := i
		for i < len(s) && isToken(s[i]) {
			i++
		}
		if i == start { // not a token: skip the character
			i++
			continue
		}
		name := s[start:i]
		j := i
		for j < len(s) && (s[j] == ' ' || s[j] == '\t') {
			j++
		}
		if j < len(s) && s[j] == '=' && len(out) > 0 {
			i = j + 1
			for i < len(s) && (s[i] == ' ' || s[i] == '\t') {
				i++
			}
			if i >= len(s) || s[i] == ',' || s[i] == '=' { // token68 padding
				for i < len(s) && s[i] == '=' {
					i++
				}
				continue
			}
			out[len(out)-1].params[strings.ToLower(name)] = readValue(s, &i)
			continue
		}
		out = append(out, rawChallenge{scheme: name, params: map[string]string{}})
	}
}

func readValue(s string, i *int) string {
	if s[*i] != '"' {
		start := *i
		for *i < len(s) && s[*i] != ',' && s[*i] != ' ' && s[*i] != '\t' {
			*i++
		}
		return s[start:*i]
	}
	*i++
	var b strings.Builder
	for *i < len(s) {
		c := s[*i]
		*i++
		switch {
		case c == '\\' && *i < len(s):
			b.WriteByte(s[*i])
			*i++
		case c == '"':
			return b.String()
		default:
			b.WriteByte(c)
		}
	}
	return b.String()
}

func isToken(c byte) bool {
	switch {
	case c >= 'a' && c <= 'z', c >= 'A' && c <= 'Z', c >= '0' && c <= '9':
		return true
	}
	return strings.IndexByte("!#$%&'*+-.^_`|~/", c) >= 0
}
