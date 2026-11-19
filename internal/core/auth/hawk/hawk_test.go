package hawk

import (
	"bytes"
	"errors"
	"net/url"
	"strings"
	"testing"
	"time"
)

// The examples from the Hawk README (mozilla/hawk, BSD-3-Clause).
var readme = Credentials{ID: "dh37fgj492je", Key: "werxhqb98rpaxn39848xrunpaw3489ruxnpa98w4rxn", Algorithm: SHA256}

func TestReadmeExamples(t *testing.T) {
	u, _ := url.Parse("http://example.com:8000/resource/1?b=1&a=2")
	got, err := Header(readme, Options{Method: "GET", URL: u, Time: time.Unix(1353832234, 0), Nonce: "j4h3g2", Ext: "some-app-ext-data"})
	if err != nil {
		t.Fatal(err)
	}
	want := `Hawk id="dh37fgj492je", ts="1353832234", nonce="j4h3g2", ext="some-app-ext-data", mac="6R4rV5iE+NPoym+WwjeHzjAGXUtLNIxmo1vpMofpLAE="`
	if got != want {
		t.Errorf("got  %s\nwant %s", got, want)
	}

	hash, err := PayloadHash(SHA256, "text/plain; charset=utf-8", []byte("Thank you for flying Hawk"))
	if err != nil || hash != "Yi9LfIIFRtBEPt74PVmbTF/xVAwPn7ub15ePICfgnuY=" {
		t.Fatalf("hash = %s %v", hash, err)
	}
	u, _ = url.Parse("http://example.com:8000/resource/1?b=1&a=2")
	got, _ = Header(readme, Options{Method: "POST", URL: u, Time: time.Unix(1353832234, 0), Nonce: "j4h3g2", Ext: "some-app-ext-data", Hash: hash})
	if !strings.Contains(got, `hash="Yi9LfIIFRtBEPt74PVmbTF/xVAwPn7ub15ePICfgnuY="`) ||
		!strings.Contains(got, `mac="aSe1DERmZuRl3pI36/9BdZmnErTw3sNzOOAUlfeKjVw="`) {
		t.Errorf("payload example: %s", got)
	}
}

func TestOptions(t *testing.T) {
	Rand = bytes.NewReader(bytes.Repeat([]byte{1}, 6))
	defer func() { Rand = nil }()
	u, _ := url.Parse("https://Example.com/x")
	got, err := Header(Credentials{ID: `a"b`, Key: "k", Algorithm: "SHA1"}, Options{Method: "get", URL: u, App: "app", Dlg: "d", Ext: "e\nx"})
	if err != nil {
		t.Fatal(err)
	}
	for _, part := range []string{`id="a\"b"`, `nonce="AQEBAQEB"`, `app="app", dlg="d"`, `ext="e` + "\n" + `x"`} {
		if !strings.Contains(got, part) {
			t.Errorf("missing %s in %s", part, got)
		}
	}
	if h, p := hostPort(Options{URL: u}); h != "Example.com" || p != "443" {
		t.Errorf("host %s port %s", h, p)
	}
	if h, p := hostPort(Options{URL: &url.URL{Scheme: "http", Host: "x"}, Host: "[::1]:81"}); h != "::1" || p != "81" {
		t.Errorf("host %s port %s", h, p)
	}
	if h, p := hostPort(Options{URL: &url.URL{Scheme: "http", Host: "x"}}); h != "x" || p != "80" {
		t.Errorf("host %s port %s", h, p)
	}
	if hash, _ := PayloadHash(SHA256, "Text/Plain;;bad", nil); hash == "" {
		t.Error("bad media type still hashes")
	}
}

func TestErrors(t *testing.T) {
	u, _ := url.Parse("http://x/")
	if _, err := Header(Credentials{ID: "a"}, Options{URL: u}); !errors.Is(err, ErrNoCredentials) {
		t.Error(err)
	}
	if _, err := Header(Credentials{ID: "a", Key: "k", Algorithm: "md5"}, Options{URL: u}); !errors.Is(err, ErrAlgorithm) {
		t.Error(err)
	}
	if _, err := PayloadHash("md5", "", nil); !errors.Is(err, ErrAlgorithm) {
		t.Error(err)
	}
	Rand = bytes.NewReader(nil)
	defer func() { Rand = nil }()
	if _, err := Header(Credentials{ID: "a", Key: "k"}, Options{URL: u}); err == nil {
		t.Error("nonce failure")
	}
}
