package testnet

import (
	"encoding/base64"
	"io"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"testing"
	"time"

	"github.com/Azure/go-ntlmssp"

	"pakpos/internal/core/auth/awsv4"
	"pakpos/internal/core/auth/digest"
	"pakpos/internal/core/auth/hawk"
	"pakpos/internal/core/jwtx"
)

var ok = http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) { _, _ = io.WriteString(w, "ok") })

func status(t *testing.T, h http.Handler, r *http.Request) (int, http.Header) {
	t.Helper()
	w := httptest.NewRecorder()
	h.ServeHTTP(w, r)
	return w.Code, w.Header()
}

func TestDigestServer(t *testing.T) {
	for _, cfg := range []DigestConfig{
		{User: "u", Password: "p", Realm: "r"},
		{User: "u", Password: "p", Realm: "r", Algorithm: digest.SHA256Sess, Qop: []string{"auth-int"}, UserHash: true, Opaque: "o"},
	} {
		h := Digest(cfg, ok)
		r := httptest.NewRequest("POST", "/x?y=1", strings.NewReader("b"))
		code, hdr := status(t, h, r)
		if code != 401 {
			t.Fatalf("code %d", code)
		}
		c, err := digest.Choose(digest.Parse(hdr.Values("WWW-Authenticate")), "")
		if err != nil {
			t.Fatal(err)
		}
		for _, pass := range []string{"p", "wrong"} {
			a, _ := digest.Authorization(c, "u", pass, digest.Request{Method: "POST", URI: "/x?y=1", Body: []byte("b")})
			r = httptest.NewRequest("POST", "/x?y=1", strings.NewReader("b"))
			r.Header.Set("Authorization", a)
			if code, _ := status(t, h, r); (code == 200) != (pass == "p") {
				t.Errorf("%+v %s: %d", cfg, pass, code)
			}
		}
	}
	r := httptest.NewRequest("GET", "/", nil)
	r.Header.Set("Authorization", `Digest username="u", algorithm=SHA-512`)
	if code, _ := status(t, Digest(DigestConfig{}, ok), r); code != 401 {
		t.Error("unknown algorithm")
	}
}

func TestNTLMServer(t *testing.T) {
	srv := httptest.NewServer(NTLM("bob", "D", "pw", ok))
	defer srv.Close()
	tr := &http.Transport{MaxConnsPerHost: 1}
	defer tr.CloseIdleConnections()
	c := &http.Client{Transport: tr}
	do := func(value string) *http.Response {
		req, _ := http.NewRequest("GET", srv.URL, nil)
		if value != "" {
			req.Header.Set("Authorization", value)
		}
		resp, err := c.Do(req)
		if err != nil {
			t.Fatal(err)
		}
		_, _ = io.Copy(io.Discard, resp.Body)
		_ = resp.Body.Close()
		return resp
	}
	neg, _ := ntlmssp.NewNegotiateMessage("", "")
	resp := do("NTLM " + base64.StdEncoding.EncodeToString(neg))
	_, data, _ := strings.Cut(resp.Header.Get("WWW-Authenticate"), " ")
	ch, _ := base64.StdEncoding.DecodeString(data)
	msg, err := ntlmssp.NewAuthenticateMessage(ch, `D\bob`, "pw", nil)
	if err != nil {
		t.Fatal(err)
	}
	if resp := do("NTLM " + base64.StdEncoding.EncodeToString(msg)); resp.StatusCode != 200 {
		t.Errorf("handshake: %d", resp.StatusCode)
	}
	// An AUTHENTICATE without a challenge on this connection, junk, other types.
	for _, v := range []string{"NTLM " + base64.StdEncoding.EncodeToString(msg), "", "NTLM !", "NTLM " + base64.StdEncoding.EncodeToString([]byte("NTLMSSP\x00\x09\x00\x00\x00"))} {
		if resp := do(v); resp.StatusCode != 401 {
			t.Errorf("%q: %d", v, resp.StatusCode)
		}
	}
	if field([]byte("short"), 20) != nil || field(append(make([]byte, 20), 9, 0, 0, 0, 200, 0, 0, 0), 20) != nil {
		t.Error("field bounds")
	}
	if ntlmValid(make([]byte, 64), nil, "u", "d", "p") {
		t.Error("empty response")
	}
}

func TestSignedServers(t *testing.T) {
	creds := awsv4.Credentials{AccessKey: "a", SecretKey: "s"}
	aws := AWSV4(creds, "r", "svc", ok)
	r := httptest.NewRequest("PUT", "http://h/x", strings.NewReader("body"))
	if code, _ := status(t, aws, r); code != 403 {
		t.Error("unsigned request")
	}
	for _, unsigned := range []bool{false, true} {
		r = httptest.NewRequest("PUT", "http://h/x", strings.NewReader("body"))
		hash := awsv4.HashPayload([]byte("body"))
		if unsigned {
			hash = awsv4.UnsignedPayload
		}
		_ = awsv4.Sign(r, creds, awsv4.Options{Region: "r", Service: "svc", Time: time.Now(), PayloadHash: hash})
		if code, _ := status(t, aws, r); code != 200 {
			t.Errorf("signed (unsigned payload %v): %d", unsigned, code)
		}
		r.Header.Set("Authorization", r.Header.Get("Authorization")+"0")
		if code, _ := status(t, aws, r); code != 403 {
			t.Error("bad signature")
		}
	}

	hk := Hawk("id", "key", "sha256", ok)
	for _, withHash := range []bool{false, true} {
		r = httptest.NewRequest("POST", "http://h:81/x?q=1", strings.NewReader("data"))
		r.Header.Set("Content-Type", "text/plain")
		u, _ := url.Parse("http://h:81/x?q=1")
		var hash string
		if withHash {
			hash, _ = hawk.PayloadHash("sha256", "text/plain", []byte("data"))
		}
		v, _ := hawk.Header(hawk.Credentials{ID: "id", Key: "key"}, hawk.Options{Method: "POST", URL: u, Ext: "e", App: "a", Dlg: "d", Hash: hash})
		r.Header.Set("Authorization", v)
		if code, _ := status(t, hk, r); code != 200 {
			t.Errorf("hawk (hash %v): %d", withHash, code)
		}
	}
	r = httptest.NewRequest("POST", "http://h/x", strings.NewReader("other"))
	r.Header.Set("Authorization", `Hawk id="id", ts="1", nonce="n", hash="x", mac="m"`)
	if code, _ := status(t, hk, r); code != 401 {
		t.Error("hash mismatch")
	}
	r.Header.Set("Authorization", `Hawk id="id", ts="1", nonce="n", mac="m"`)
	if code, _ := status(t, hk, r); code != 401 {
		t.Error("mac mismatch")
	}
	if len(hawkAttrs("Basic x")) != 0 {
		t.Error("not hawk")
	}

	key := jwtx.Key{Kind: jwtx.KeySecret, Data: []byte("k")}
	tok, _ := jwtx.Sign(jwtx.HS256, nil, []byte(`{}`), key)
	r = httptest.NewRequest("GET", "/?t="+tok, nil)
	if code, _ := status(t, JWT(key, "t", ok), r); code != 200 {
		t.Error("jwt in query")
	}
	r = httptest.NewRequest("GET", "/", nil)
	r.Header.Set("Authorization", "Bearer x.y.z")
	if code, _ := status(t, JWT(key, "", ok), r); code != 401 {
		t.Error("bad jwt")
	}
}
