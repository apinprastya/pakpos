package digest

import (
	"crypto/md5" //nolint:gosec // test of MD5 digest auth
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"hash"
	"strings"
)

// verify checks an Authorization header the way a server would (an
// independent implementation of RFC 7616 §3.4.1, for tests).
func verify(header, password, method string, body []byte) error {
	p, ok := Params(header)
	if !ok {
		return fmt.Errorf("not one Digest credential: %q", header)
	}
	var newHash func() hash.Hash
	switch p["algorithm"] {
	case MD5, MD5Sess:
		newHash = md5.New
	case SHA256, SHA256Sess:
		newHash = sha256.New
	default:
		return fmt.Errorf("algorithm %q", p["algorithm"])
	}
	h := func(s string) string {
		x := newHash()
		x.Write([]byte(s))
		return hex.EncodeToString(x.Sum(nil))
	}
	ha1 := h(p["username"] + ":" + p["realm"] + ":" + password)
	if strings.HasSuffix(p["algorithm"], "-sess") {
		ha1 = h(ha1 + ":" + p["nonce"] + ":" + p["cnonce"])
	}
	a2 := method + ":" + p["uri"]
	if p["qop"] == "auth-int" {
		a2 += ":" + h(string(body))
	}
	var want string
	if p["qop"] == "" {
		want = h(ha1 + ":" + p["nonce"] + ":" + h(a2))
	} else {
		want = h(strings.Join([]string{ha1, p["nonce"], p["nc"], p["cnonce"], p["qop"], h(a2)}, ":"))
	}
	if p["response"] != want {
		return fmt.Errorf("response %s, want %s", p["response"], want)
	}
	return nil
}
