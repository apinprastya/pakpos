package digest

import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"reflect"
	"strings"
	"testing"
)

// The RFC 7616 §3.9.1 example.
var rfc7616 = Challenge{
	Realm:  "http-auth@example.org",
	Nonce:  "7ypf/xlj9XXwfDPEoM4URrv/xwf94BcCAzFZH4GiTo0v",
	Opaque: "FQhe/qaU925kfnzjCev0ciny7QMkPqMAFRtzCUYo5tdS",
	Qop:    []string{"auth", "auth-int"},
}

func TestRFCVectors(t *testing.T) {
	tests := []struct {
		name      string
		c         Challenge
		user      string
		pass      string
		r         Request
		wantParts []string
	}{
		{
			name: "RFC 7616 MD5",
			c:    with(rfc7616, MD5), user: "Mufasa", pass: "Circle of Life",
			r: Request{Method: "GET", URI: "/dir/index.html", CNonce: "f2/wE4q74E6zIJEtWaHKaf5wv/H5QzzpXusqGemxURZJ", NC: 1},
			wantParts: []string{`response="8ca523f5e9506fed4657c9700eebdbec"`, `qop=auth`, `nc=00000001`, `algorithm=MD5`,
				`opaque="FQhe/qaU925kfnzjCev0ciny7QMkPqMAFRtzCUYo5tdS"`, `username="Mufasa"`, `uri="/dir/index.html"`},
		},
		{
			name: "RFC 7616 SHA-256",
			c:    with(rfc7616, SHA256), user: "Mufasa", pass: "Circle of Life",
			r:         Request{Method: "GET", URI: "/dir/index.html", CNonce: "f2/wE4q74E6zIJEtWaHKaf5wv/H5QzzpXusqGemxURZJ", NC: 1},
			wantParts: []string{`response="753927fa0e85d155564e2e272a28d1802ca10daf4496794697cf8db5856cb6c1"`, `algorithm=SHA-256`},
		},
		{
			name: "RFC 2617",
			c:    Challenge{Realm: "testrealm@host.com", Nonce: "dcd98b7102dd2f0e8b11d0f600bfb0c093", Algorithm: MD5, Qop: []string{"auth"}},
			user: "Mufasa", pass: "Circle Of Life",
			r:         Request{Method: "GET", URI: "/dir/index.html", CNonce: "0a4f113b", NC: 1},
			wantParts: []string{`response="6629fae49393a05397450978507c4ef1"`},
		},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got, err := Authorization(tt.c, tt.user, tt.pass, tt.r)
			if err != nil {
				t.Fatal(err)
			}
			if !strings.HasPrefix(got, "Digest ") {
				t.Errorf("got %s", got)
			}
			for _, p := range tt.wantParts {
				if !strings.Contains(got, p) {
					t.Errorf("missing %s in\n%s", p, got)
				}
			}
		})
	}
}

func with(c Challenge, alg string) Challenge { c.Algorithm = alg; return c }

// A server-side check of every algorithm and qop, computed independently.
func TestAlgorithmsAndQop(t *testing.T) {
	Rand = bytes.NewReader(bytes.Repeat([]byte{7}, 1000))
	defer func() { Rand = nil }()
	for _, alg := range []string{MD5, MD5Sess, SHA256, SHA256Sess} {
		for _, qop := range [][]string{nil, {"auth"}, {"auth-int"}} {
			c := Challenge{Realm: "r", Nonce: "n", Algorithm: alg, Qop: qop}
			got, err := Authorization(c, "u", "p", Request{Method: "POST", URI: "/x?y=1", Body: []byte("body"), Qop: QopAuthInt})
			if err != nil {
				t.Fatal(err)
			}
			if err := verify(got, "p", "POST", []byte("body")); err != nil {
				t.Errorf("%s %v: %v\n%s", alg, qop, err, got)
			}
			if len(qop) == 0 && strings.Contains(got, "qop=") {
				t.Errorf("no qop offered: %s", got)
			}
		}
	}
}

func TestUserHashAndExtendedNames(t *testing.T) {
	c := Challenge{Realm: "api@example.org", Nonce: "n", Algorithm: SHA256, Qop: []string{"auth"}, UserHash: true}
	got, err := Authorization(c, "Jäsøn Doe", "Secret, or not?", Request{Method: "GET", URI: "/doe.json", CNonce: "c"})
	if err != nil {
		t.Fatal(err)
	}
	sum := sha256.Sum256([]byte("Jäsøn Doe:api@example.org"))
	if !strings.Contains(got, `username="`+hex.EncodeToString(sum[:])+`"`) || !strings.Contains(got, "userhash=true") {
		t.Errorf("userhash: %s", got)
	}
	c.UserHash = false
	got, _ = Authorization(c, `Jäsøn "Doe"`, "p", Request{Method: "GET", URI: "/", CNonce: "c"})
	if !strings.Contains(got, `username*=UTF-8''J%C3%A4s%C3%B8n%20%22Doe%22`) {
		t.Errorf("extended name: %s", got)
	}
	got, _ = Authorization(Challenge{Realm: `a"b`, Nonce: "n", Algorithm: MD5}, "u", "p", Request{Method: "GET", URI: "/"})
	if !strings.Contains(got, `realm="a\"b"`) {
		t.Errorf("quoting: %s", got)
	}
}

func TestAuthorizationErrors(t *testing.T) {
	if _, err := Authorization(Challenge{Algorithm: "SHA-512-256"}, "u", "p", Request{}); err == nil {
		t.Error("unsupported algorithm")
	}
	Rand = errReader{}
	defer func() { Rand = nil }()
	if _, err := Authorization(Challenge{Algorithm: MD5, Qop: []string{"auth"}}, "u", "p", Request{}); err == nil {
		t.Error("nonce failure")
	}
}

type errReader struct{}

func (errReader) Read([]byte) (int, error) { return 0, errors.New("no randomness") }

func TestParse(t *testing.T) {
	got := Parse([]string{
		`Negotiate abc==, Digest realm="http-auth@example.org", qop="auth, auth-int", algorithm=SHA-256, nonce="7ypf", opaque="FQhe", userhash=true, charset=UTF-8, stale=TRUE`,
		`Basic realm="x", Digest realm="a \"q\" b", nonce=abc, algorithm=md5-SESS`,
		`Bearer`, `Negotiate abc=`, `Digest realm=`, `Digest`, `, ,`,
	})
	want := []Challenge{
		{Realm: "http-auth@example.org", Nonce: "7ypf", Opaque: "FQhe", Algorithm: SHA256, Qop: []string{"auth", "auth-int"}, UserHash: true, Charset: "UTF-8", Stale: true},
		{Realm: `a "q" b`, Nonce: "abc", Algorithm: MD5Sess},
		{Algorithm: MD5},
		{Algorithm: MD5},
	}
	if !reflect.DeepEqual(got, want) {
		t.Errorf("got  %+v\nwant %+v", got, want)
	}
	if got := Parse([]string{`Digest realm="unterminated`}); got[0].Realm != "unterminated" {
		t.Errorf("unterminated: %+v", got)
	}
}

func TestChoose(t *testing.T) {
	cs := []Challenge{{Algorithm: MD5, Nonce: "1"}, {Algorithm: SHA256, Nonce: "2"}, {Algorithm: "SHA-512-256", Nonce: "3"}, {Algorithm: SHA256Sess}}
	if c, _ := Choose(cs, ""); c.Nonce != "2" {
		t.Errorf("strongest: %+v", c)
	}
	if c, _ := Choose(cs, "md5"); c.Nonce != "1" {
		t.Errorf("preferred: %+v", c)
	}
	if c, _ := Choose(cs, SHA256Sess); c.Nonce != "2" {
		t.Errorf("preferred but offered without a nonce: %+v", c)
	}
	if _, err := Choose([]Challenge{{Algorithm: "SHA-512-256", Nonce: "x"}}, ""); !errors.Is(err, ErrNoChallenge) {
		t.Errorf("err = %v", err)
	}
	if !Supported("sha-256") || Supported("SHA-512-256") {
		t.Error("Supported")
	}
	if !NeedsBody(Challenge{Qop: []string{"auth-int"}}, "") || NeedsBody(Challenge{Qop: []string{"auth", "auth-int"}}, "") ||
		!NeedsBody(Challenge{Qop: []string{"auth", "auth-int"}}, "auth-int") {
		t.Error("NeedsBody")
	}
}
