package httpexec

import (
	"context"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"

	"pakpos/internal/core/auth/awsv4"
	"pakpos/internal/core/auth/digest"
	"pakpos/internal/core/jwtx"
	"pakpos/internal/core/model"
	"pakpos/internal/testnet"
)

// okHandler answers 200 with the request body.
var okHandler = http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
	b, _ := io.ReadAll(r.Body)
	_, _ = io.WriteString(w, "ok:"+string(b))
})

func sendRecorded(t *testing.T, req model.Request) (*model.Response, []model.Hop, error) {
	t.Helper()
	e := New(DefaultSettings())
	rec := NewRecorder()
	resp, err := e.Execute(WithRecorder(context.Background(), rec), "", req)
	return resp, rec.Hops(), err
}

func TestDigestAuth(t *testing.T) {
	dir := t.TempDir()
	file := filepath.Join(dir, "f.txt")
	if err := os.WriteFile(file, []byte("file body"), 0o600); err != nil {
		t.Fatal(err)
	}
	tests := []struct {
		name string
		cfg  testnet.DigestConfig
		d    model.Digest
		body model.Body
	}{
		{"md5 auth", testnet.DigestConfig{Algorithm: digest.MD5, Qop: []string{"auth"}}, model.Digest{}, model.Body{Type: model.BodyRaw, Raw: "hello"}},
		{"sha-256-sess auth-int", testnet.DigestConfig{Algorithm: digest.SHA256Sess, Qop: []string{"auth", "auth-int"}, Opaque: "op"}, model.Digest{Qop: "auth-int"},
			model.Body{Type: model.BodyRaw, Raw: `{"a":1}`, Language: model.LangJSON}},
		{"no qop", testnet.DigestConfig{Algorithm: digest.MD5Sess}, model.Digest{}, model.Body{}},
		{"userhash with a file body", testnet.DigestConfig{Algorithm: digest.SHA256, Qop: []string{"auth-int"}, UserHash: true}, model.Digest{},
			model.Body{Type: model.BodyBinary, BinaryPath: file}},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			tt.cfg.User, tt.cfg.Password, tt.cfg.Realm = "Mufasa", "Circle of Life", "test@example.org"
			srv := httptest.NewServer(testnet.Digest(tt.cfg, okHandler))
			defer srv.Close()
			d := tt.d
			d.Username, d.Password = "Mufasa", "Circle of Life"
			req := model.Request{Method: "POST", URL: srv.URL + "/dir/index.html?x=1", Body: tt.body, Auth: model.Auth{Type: model.AuthDigest, Digest: &d}}
			resp, hops, err := sendRecorded(t, req)
			if err != nil {
				t.Fatal(err)
			}
			if resp.StatusCode != 200 || len(hops) != 2 || hops[0].StatusCode != 401 || !strings.HasPrefix(hopHeader(hops[1], "Authorization"), "Digest ") {
				t.Fatalf("status %d, %d hops: %+v", resp.StatusCode, len(hops), hops)
			}
			if !strings.HasPrefix(resp.Body, "ok:") || (tt.body.Type != "" && resp.Body == "ok:") {
				t.Errorf("body replay: %q", resp.Body)
			}
		})
	}

	// Wrong password: the second 401 is the response.
	srv := httptest.NewServer(testnet.Digest(testnet.DigestConfig{User: "u", Password: "p", Realm: "r"}, okHandler))
	defer srv.Close()
	bad := model.Request{Method: "GET", URL: srv.URL, Auth: model.Auth{Type: model.AuthDigest, Digest: &model.Digest{Username: "u", Password: "x"}}}
	if resp, hops, err := sendRecorded(t, bad); err != nil || resp.StatusCode != 401 || len(hops) != 2 {
		t.Errorf("wrong password: %v %d hops", err, len(hops))
	}
	// A user Authorization header wins: no retry.
	own := bad
	own.Headers = []model.KeyValue{{Key: "Authorization", Value: "Custom", Enabled: true}}
	if resp, hops, _ := sendRecorded(t, own); resp.StatusCode != 401 || len(hops) != 1 {
		t.Errorf("own header: %d hops", len(hops))
	}
	// A 401 without a Digest challenge, or with an unknown algorithm, is returned as is.
	for _, challenge := range []string{`Basic realm="x"`, `Digest realm="x", nonce="n", algorithm=SHA-512-256`} {
		plain := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
			w.Header().Set("WWW-Authenticate", challenge)
			w.WriteHeader(401)
		}))
		req := bad
		req.URL = plain.URL
		if resp, hops, _ := sendRecorded(t, req); resp.StatusCode != 401 || len(hops) != 1 {
			t.Errorf("%s: %d hops", challenge, len(hops))
		}
		plain.Close()
	}
}

func hopHeader(h model.Hop, name string) string {
	for _, kv := range h.RequestHeaders {
		if strings.EqualFold(kv.Key, name) {
			return kv.Value
		}
	}
	return ""
}

func TestNTLMAuth(t *testing.T) {
	srv := httptest.NewServer(testnet.NTLM("alice", "CORP", "Passw0rd!", okHandler))
	defer srv.Close()
	n := &model.NTLM{Username: "alice", Domain: "CORP", Password: "Passw0rd!", Workstation: "WS1"}
	req := model.Request{Method: "POST", URL: srv.URL + "/x", Body: model.Body{Type: model.BodyRaw, Raw: "payload"}, Auth: model.Auth{Type: model.AuthNTLM, NTLM: n}}
	resp, hops, err := sendRecorded(t, req)
	if err != nil {
		t.Fatal(err)
	}
	if resp.StatusCode != 200 || resp.Body != "ok:payload" || len(hops) != 2 || !hops[1].ReusedConn {
		t.Fatalf("status %d body %q hops %+v", resp.StatusCode, resp.Body, hops)
	}
	// Domain in the user name; a wrong password fails with the server's 401.
	req.Auth.NTLM = &model.NTLM{Username: `CORP\alice`, Password: "nope"}
	if resp, hops, err := sendRecorded(t, req); err != nil || resp.StatusCode != 401 || len(hops) != 2 {
		t.Errorf("wrong password: %v %+v", err, resp)
	}
	// Concurrent sends each keep their own connection.
	var wg sync.WaitGroup
	e := New(DefaultSettings())
	req.Auth.NTLM = n
	for range 8 {
		wg.Add(1)
		go func() {
			defer wg.Done()
			if resp, err := e.Execute(context.Background(), "", req); err != nil || resp.StatusCode != 200 {
				t.Errorf("concurrent: %v %+v", err, resp)
			}
		}()
	}
	wg.Wait()

	// Servers without NTLM, or a garbled challenge.
	for _, challenge := range []string{"", "NTLM !!!", "NTLM " + "AAAA"} {
		other := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
			if challenge != "" {
				w.Header().Set("WWW-Authenticate", challenge)
				w.WriteHeader(401)
			}
		}))
		r := req
		r.URL = other.URL
		resp, _, err := sendRecorded(t, r)
		switch challenge {
		case "NTLM AAAA":
			if err == nil || Classify(err).Kind != KindAuth {
				t.Errorf("garbled challenge: %v", err)
			}
		case "":
			if err != nil || resp.StatusCode != 200 {
				t.Errorf("no auth needed: %v", err)
			}
		default:
			if err != nil || resp.StatusCode != 401 {
				t.Errorf("%q: %v", challenge, err)
			}
		}
		other.Close()
	}
	// The user's own header wins.
	own := req
	own.Headers = []model.KeyValue{{Key: "Authorization", Value: "Basic x", Enabled: true}}
	if resp, hops, _ := sendRecorded(t, own); resp.StatusCode != 401 || len(hops) != 1 {
		t.Errorf("own header: %d hops", len(hops))
	}
}

func TestSignedAuth(t *testing.T) {
	creds := awsv4.Credentials{AccessKey: "AKID", SecretKey: "secret", SessionToken: "tok"}
	aws := httptest.NewServer(testnet.AWSV4(creds, "eu-west-1", "execute-api", okHandler))
	defer aws.Close()
	req := model.Request{Method: "POST", URL: aws.URL + "/a b/c?z=1&a=x y", Body: model.Body{Type: model.BodyRaw, Raw: `{"x":1}`, Language: model.LangJSON},
		Auth: model.Auth{Type: model.AuthAWSV4, AWSV4: &model.AWSV4{AccessKey: "AKID", SecretKey: "secret", SessionToken: "tok", Region: "eu-west-1", Service: "execute-api"}}}
	if resp, _, err := sendRecorded(t, req); err != nil || resp.StatusCode != 200 || resp.Body != `ok:{"x":1}` {
		t.Errorf("aws: %v %+v", err, resp)
	}
	// Form data is buffered so it can be hashed.
	req.Body = model.Body{Type: model.BodyFormData, FormData: []model.FormField{{Key: "a", Value: "1", Enabled: true}}}
	if resp, _, err := sendRecorded(t, req); err != nil || resp.StatusCode != 200 {
		t.Errorf("aws form: %v %+v", err, resp)
	}
	req.Auth.AWSV4 = &model.AWSV4{AccessKey: "AKID"}
	if _, _, err := sendRecorded(t, req); err == nil || Classify(err).Kind != KindAuth || !strings.Contains(err.Error(), "Auth tab") {
		t.Errorf("incomplete aws: %v", err)
	}

	hawkSrv := httptest.NewServer(testnet.Hawk("id1", "key1", "sha256", okHandler))
	defer hawkSrv.Close()
	hreq := model.Request{Method: "PUT", URL: hawkSrv.URL + "/r?b=1", Body: model.Body{Type: model.BodyRaw, Raw: "text", Language: model.LangText},
		Auth: model.Auth{Type: model.AuthHawk, Hawk: &model.Hawk{ID: "id1", Key: "key1", Ext: "e", App: "a", Dlg: "d", PayloadHash: true}}}
	if resp, _, err := sendRecorded(t, hreq); err != nil || resp.StatusCode != 200 {
		t.Errorf("hawk: %v %+v", err, resp)
	}

	jwtSrv := httptest.NewServer(testnet.JWT(jwtx.Key{Kind: jwtx.KeySecret, Data: []byte("s3cret")}, "", okHandler))
	defer jwtSrv.Close()
	jreq := model.Request{Method: "GET", URL: jwtSrv.URL, Auth: model.Auth{Type: model.AuthJWT, JWT: &model.JWT{Secret: "s3cret", Payload: `{"sub":"x"}`}}}
	if resp, _, err := sendRecorded(t, jreq); err != nil || resp.StatusCode != 200 {
		t.Errorf("jwt: %v %+v", err, resp)
	}
}
