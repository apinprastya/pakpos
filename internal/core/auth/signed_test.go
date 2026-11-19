package auth

import (
	"bytes"
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/x509"
	"encoding/base64"
	"encoding/json"
	"encoding/pem"
	"errors"
	"io"
	"net/http"
	"net/url"
	"strings"
	"testing"
	"time"

	"pakpos/internal/core/auth/awsv4"
	"pakpos/internal/core/auth/hawk"
	"pakpos/internal/core/jwtx"
	"pakpos/internal/core/model"
)

var fixedNow = time.Date(2015, 8, 30, 12, 36, 0, 0, time.UTC)

func pinClock(t *testing.T) {
	t.Helper()
	Now = func() time.Time { return fixedNow }
	Random = bytes.NewReader(bytes.Repeat([]byte{9}, 1024))
	t.Cleanup(func() { Now, Random = time.Now, rand.Reader })
}

func bodyReq(t *testing.T, method, target, body string) *http.Request {
	t.Helper()
	var rb io.Reader
	if body != "" {
		rb = strings.NewReader(body)
	}
	r, err := http.NewRequest(method, target, rb)
	if err != nil {
		t.Fatal(err)
	}
	if body != "" {
		r.Body = io.NopCloser(strings.NewReader(body)) // not replayable, like httpexec's bodies
		r.GetBody = nil
	}
	return r
}

func TestApplyAWS(t *testing.T) {
	pinClock(t)
	a := model.Auth{Type: model.AuthAWSV4, AWSV4: &model.AWSV4{AccessKey: " AKIDEXAMPLE ", SecretKey: "wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY", Region: "us-east-1", Service: "service"}}
	r := bodyReq(t, "GET", "https://example.amazonaws.com/", "")
	if err := Apply(r, a); err != nil {
		t.Fatal(err)
	}
	// The suite's get-vanilla signature.
	if !strings.HasSuffix(r.Header.Get("Authorization"), "Signature=5fa00fa31553b73ebf1942676e86291e8372ff2a2260956d9b8aae1d763fbf31") {
		t.Errorf("got %s", r.Header.Get("Authorization"))
	}

	// The body is hashed and stays readable.
	r = bodyReq(t, "POST", "https://example.amazonaws.com/", "Param1=value1")
	r.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	if err := Apply(r, a); err != nil {
		t.Fatal(err)
	}
	if !strings.HasSuffix(r.Header.Get("Authorization"), "ff11897932ad3f4e8b18135d722051e5ac45fc38421b1da7b9d196a0fe09473a") {
		t.Errorf("post: %s", r.Header.Get("Authorization"))
	}
	if b, _ := io.ReadAll(r.Body); string(b) != "Param1=value1" || r.ContentLength != 13 || r.GetBody == nil {
		t.Errorf("body after signing: %q", b)
	}

	// Unsigned payload doesn't read the body.
	unsigned := a
	w := *a.AWSV4
	w.UnsignedPayload = true
	unsigned.AWSV4 = &w
	r = bodyReq(t, "PUT", "https://example.amazonaws.com/", "data")
	_ = Apply(r, unsigned)
	if r.Header.Get(awsv4.HeaderContent) != awsv4.UnsignedPayload || r.GetBody != nil {
		t.Error("unsigned payload")
	}

	// A user Authorization header wins; missing settings and keys fail.
	r = bodyReq(t, "GET", "https://example.amazonaws.com/", "")
	r.Header.Set("Authorization", "mine")
	if err := Apply(r, a); err != nil || r.Header.Get("Authorization") != "mine" || r.Header.Get("X-Amz-Date") != "" {
		t.Error("user header")
	}
	if err := Apply(bodyReq(t, "GET", "https://x/", ""), model.Auth{Type: model.AuthAWSV4}); !errors.Is(err, ErrNoSettings) {
		t.Errorf("err = %v", err)
	}
	if err := Apply(bodyReq(t, "GET", "https://x/", ""), model.Auth{Type: model.AuthAWSV4, AWSV4: &model.AWSV4{}}); !errors.Is(err, awsv4.ErrNoKeys) {
		t.Errorf("err = %v", err)
	}
	bad := bodyReq(t, "POST", "https://x/", "x")
	bad.Body = io.NopCloser(errBody{})
	if err := Apply(bad, a); err == nil {
		t.Error("body read error")
	}
}

type errBody struct{}

func (errBody) Read([]byte) (int, error) { return 0, errors.New("broken") }

func TestApplyHawk(t *testing.T) {
	pinClock(t)
	h := &model.Hawk{ID: "dh37fgj492je", Key: "werxhqb98rpaxn39848xrunpaw3489ruxnpa98w4rxn", Ext: "x", PayloadHash: true}
	r := bodyReq(t, "POST", "http://example.com:8000/resource/1?b=1&a=2", "Thank you for flying Hawk")
	r.Header.Set("Content-Type", "text/plain")
	if err := Apply(r, model.Auth{Type: model.AuthHawk, Hawk: h}); err != nil {
		t.Fatal(err)
	}
	got := r.Header.Get("Authorization")
	if !strings.Contains(got, `ts="1440938160"`) || !strings.Contains(got, `hash="Yi9LfIIFRtBEPt74PVmbTF/xVAwPn7ub15ePICfgnuY="`) {
		t.Errorf("got %s", got)
	}
	if b, _ := io.ReadAll(r.Body); string(b) != "Thank you for flying Hawk" {
		t.Error("body")
	}
	r = bodyReq(t, "GET", "http://x/", "")
	r.Header.Set("Authorization", "mine")
	if err := Apply(r, model.Auth{Type: model.AuthHawk, Hawk: h}); err != nil || r.Header.Get("Authorization") != "mine" {
		t.Error("user header")
	}
	for _, a := range []model.Auth{
		{Type: model.AuthHawk},
		{Type: model.AuthHawk, Hawk: &model.Hawk{ID: "a"}},
		{Type: model.AuthHawk, Hawk: &model.Hawk{ID: "a", Key: "k", Algorithm: "md5", PayloadHash: true}},
	} {
		if err := Apply(bodyReq(t, "GET", "http://x/", ""), a); err == nil {
			t.Errorf("%+v: no error", a.Hawk)
		}
	}
	bad := bodyReq(t, "POST", "http://x/", "x")
	bad.Body = io.NopCloser(errBody{})
	if err := Apply(bad, model.Auth{Type: model.AuthHawk, Hawk: h}); err == nil {
		t.Error("body read error")
	}
	if err := Apply(bodyReq(t, "GET", "http://x/", ""), model.Auth{Type: model.AuthDigest}); err != nil {
		t.Error("digest is answered later")
	}
	if !Signed(model.AuthJWT) || Signed(model.AuthDigest) || !Handshake(model.AuthNTLM) || Handshake(model.AuthJWT) {
		t.Error("Signed/Handshake")
	}
}

func decodeJWT(t *testing.T, tok string) (map[string]any, map[string]any) {
	t.Helper()
	parts := strings.Split(tok, ".")
	if len(parts) != 3 {
		t.Fatalf("token %q", tok)
	}
	var h, p map[string]any
	hb, _ := base64.RawURLEncoding.DecodeString(parts[0])
	pb, _ := base64.RawURLEncoding.DecodeString(parts[1])
	if json.Unmarshal(hb, &h) != nil || json.Unmarshal(pb, &p) != nil {
		t.Fatalf("token parts %s %s", hb, pb)
	}
	return h, p
}

func TestJWT(t *testing.T) {
	pinClock(t)
	j := model.JWT{Secret: "c2VjcmV0", SecretBase64: true, Header: `{"kid":"k1"}`, Payload: `{"sub":"ann","iat":5}`, LifetimeSeconds: 60, AddJTI: true}
	r := bodyReq(t, "GET", "https://x/a", "")
	if err := Apply(r, model.Auth{Type: model.AuthJWT, JWT: &j}); err != nil {
		t.Fatal(err)
	}
	tok := strings.TrimPrefix(r.Header.Get("Authorization"), "Bearer ")
	h, p := decodeJWT(t, tok)
	if h["kid"] != "k1" || h["alg"] != "HS256" || h["typ"] != "JWT" {
		t.Errorf("header %v", h)
	}
	if p["iat"] != float64(5) || p["exp"] != float64(fixedNow.Unix()+60) || p["jti"] != base64.RawURLEncoding.EncodeToString(bytes.Repeat([]byte{9}, 16)) {
		t.Errorf("payload %v", p)
	}
	if res, _ := jwtx.Verify(tok, jwtx.Key{Kind: jwtx.KeySecret, Data: []byte("secret")}); !res.Valid {
		t.Error("signature")
	}

	// Automatic iat, query placement, iat off.
	j = model.JWT{Secret: "s", Placement: model.PlaceQuery}
	r = bodyReq(t, "GET", "https://x/a?q=1", "")
	_ = Apply(r, model.Auth{Type: model.AuthJWT, JWT: &j})
	_, p = decodeJWT(t, r.URL.Query().Get("token"))
	if p["iat"] != float64(fixedNow.Unix()) || p["exp"] != nil || r.URL.Query().Get("q") != "1" {
		t.Errorf("query placement payload %v", p)
	}
	j = model.JWT{Secret: "s", DisableIssuedAt: true, Placement: model.PlaceQuery, QueryParam: "jwt", HeaderPrefix: "x"}
	r = bodyReq(t, "GET", "https://x/a", "")
	_ = Apply(r, model.Auth{Type: model.AuthJWT, JWT: &j})
	if _, p = decodeJWT(t, r.URL.Query().Get("jwt")); len(p) != 0 {
		t.Errorf("iat off: %v", p)
	}
	r = bodyReq(t, "GET", "https://x/a", "")
	_ = Apply(r, model.Auth{Type: model.AuthJWT, JWT: &model.JWT{Secret: "s", HeaderPrefix: " JWT "}})
	if !strings.HasPrefix(r.Header.Get("Authorization"), "JWT ey") {
		t.Errorf("prefix: %s", r.Header.Get("Authorization"))
	}

	// ES256 with a PEM pasted into one line.
	k, _ := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	der, _ := x509.MarshalPKCS8PrivateKey(k)
	oneLine := strings.ReplaceAll(string(pem.EncodeToMemory(&pem.Block{Type: "PRIVATE KEY", Bytes: der})), "\n", "")
	tok, err := JWTToken(model.JWT{Algorithm: "ES256", Secret: oneLine}, fixedNow)
	if err != nil {
		t.Fatal(err)
	}
	pubDer, _ := x509.MarshalPKIXPublicKey(k.Public())
	if res, _ := jwtx.Verify(tok, jwtx.Key{Kind: jwtx.KeyPEM, Data: pem.EncodeToMemory(&pem.Block{Type: "PUBLIC KEY", Bytes: pubDer})}); !res.Valid {
		t.Error("ES256 signature")
	}

	errs := []model.JWT{
		{Algorithm: "XX", Secret: "s"},
		{Secret: " "},
		{Secret: "!!", SecretBase64: true},
		{Secret: "s", Payload: "[1]"},
		{Secret: "s", Header: "x"},
		{Algorithm: "RS256", Secret: "not pem"},
	}
	for _, j := range errs {
		if _, err := JWTToken(j, fixedNow); err == nil {
			t.Errorf("%+v: no error", j)
		}
	}
	Random = bytes.NewReader(nil)
	if _, err := JWTToken(model.JWT{Secret: "s", AddJTI: true}, fixedNow); err == nil {
		t.Error("jti randomness")
	}
	if err := Apply(bodyReq(t, "GET", "https://x/", ""), model.Auth{Type: model.AuthJWT}); !errors.Is(err, ErrNoSettings) {
		t.Error(err)
	}
}

func TestNormalizePEM(t *testing.T) {
	for in, want := range map[string]string{
		"-----BEGIN X-----AB CD-----END X-----":    "-----BEGIN X-----\nABCD\n-----END X-----",
		`-----BEGIN X-----\nABCD\n-----END X-----`: "-----BEGIN X-----\nABCD\n-----END X-----",
		"-----BEGIN X-----\nAB\n-----END X-----":   "-----BEGIN X-----\nAB\n-----END X-----",
		"plain":                                    "plain",
	} {
		if got := NormalizePEM(in); got != want {
			t.Errorf("NormalizePEM(%q) = %q", in, got)
		}
	}
}

func TestMaterializeWith(t *testing.T) {
	pinClock(t)
	keepAll := func(model.AuthType) bool { return true }
	aws := model.Auth{Type: model.AuthAWSV4, AWSV4: &model.AWSV4{AccessKey: "AKIDEXAMPLE", SecretKey: "wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY", Region: "us-east-1", Service: "service"}}
	base := model.Request{Method: "GET", URL: "https://example.amazonaws.com/"}

	req := base
	req.Auth = aws
	out, warns, err := MaterializeWith(req, nil)
	if err != nil || len(warns) != 1 || !strings.Contains(warns[0], "5 minutes") {
		t.Fatalf("aws: %v %v", warns, err)
	}
	if got := header(out, "Authorization"); !strings.HasSuffix(got, "5fa00fa31553b73ebf1942676e86291e8372ff2a2260956d9b8aae1d763fbf31") || header(out, "X-Amz-Date") == "" {
		t.Errorf("aws headers: %+v", out.Headers)
	}
	// Kept for cURL.
	if out, warns, _ := MaterializeWith(req, keepAll); out.Auth.Type != model.AuthAWSV4 || len(warns) != 0 {
		t.Errorf("kept aws: %+v", out.Auth)
	}
	// Form data can't be hashed: unsigned payload.
	form := req
	form.Method, form.Body = "POST", model.Body{Type: model.BodyFormData}
	if out, warns, _ := MaterializeWith(form, nil); len(warns) != 2 || header(out, "X-Amz-Content-Sha256") != "UNSIGNED-PAYLOAD" {
		t.Errorf("form: %v %+v", warns, out.Headers)
	}
	// Unresolved keys, bad URL, missing region, user header.
	masked := req
	masked.Auth = model.Auth{Type: model.AuthAWSV4, AWSV4: &model.AWSV4{AccessKey: "a", SecretKey: "{{sk}}", Region: "r", Service: "s"}}
	if out, warns, _ := MaterializeWith(masked, nil); len(warns) != 1 || !strings.Contains(warns[0], "reveal secrets") || len(out.Headers) != 0 {
		t.Errorf("masked: %v", warns)
	}
	badURL := req
	badURL.URL = "http://[::1"
	if _, warns, _ := MaterializeWith(badURL, nil); len(warns) != 1 || !strings.Contains(warns[0], "URL") {
		t.Errorf("bad url: %v", warns)
	}
	noRegion := req
	noRegion.Auth = model.Auth{Type: model.AuthAWSV4, AWSV4: &model.AWSV4{AccessKey: "a", SecretKey: "b"}}
	if _, warns, _ := MaterializeWith(noRegion, nil); len(warns) != 1 || !strings.Contains(warns[0], "region") {
		t.Errorf("no region: %v", warns)
	}
	userHdr := req
	userHdr.Headers = []model.KeyValue{hdr("Authorization", "x")}
	if out, warns, _ := MaterializeWith(userHdr, keepAll); len(warns) != 0 || out.Auth.Type != model.AuthNone || len(out.Headers) != 1 {
		t.Error("user header wins")
	}
	if _, warns, _ := MaterializeWith(model.Request{Auth: model.Auth{Type: model.AuthAWSV4}}, nil); len(warns) != 0 {
		t.Error("no settings")
	}

	// Digest and NTLM: kept, or left out with a warning.
	for _, a := range []model.Auth{{Type: model.AuthDigest, Digest: &model.Digest{}}, {Type: model.AuthNTLM, NTLM: &model.NTLM{}}} {
		r := base
		r.Auth = a
		if out, _, _ := MaterializeWith(r, keepAll); out.Auth.Type != a.Type {
			t.Errorf("%s kept", a.Type)
		}
		if out, warns, _ := MaterializeWith(r, nil); out.Auth.Type != model.AuthNone || len(warns) != 1 || !strings.Contains(warns[0], "challenge") {
			t.Errorf("%s: %v", a.Type, warns)
		}
		r.Auth = model.Auth{Type: a.Type}
		if _, warns, _ := MaterializeWith(r, nil); len(warns) != 0 {
			t.Errorf("%s without settings: %v", a.Type, warns)
		}
	}

	// JWT and Hawk.
	jwtReq := base
	jwtReq.Auth = model.Auth{Type: model.AuthJWT, JWT: &model.JWT{Secret: "s", LifetimeSeconds: 60}}
	out, warns, _ = MaterializeWith(jwtReq, nil)
	if !strings.HasPrefix(header(out, "Authorization"), "Bearer ey") || len(warns) != 1 || !strings.Contains(warns[0], "2015-08-30T12:37:00Z") {
		t.Errorf("jwt: %v %+v", warns, out.Headers)
	}
	jwtReq.Auth.JWT = &model.JWT{Secret: "{{key}}"}
	if out, warns, _ := MaterializeWith(jwtReq, nil); len(out.Headers) != 0 || !strings.Contains(warns[0], "{{variable}}") {
		t.Errorf("jwt masked: %v", warns)
	}
	jwtReq.Auth.JWT = &model.JWT{Secret: "s", Payload: "x"}
	if _, warns, _ := MaterializeWith(jwtReq, nil); !strings.Contains(warns[0], "couldn't be signed") {
		t.Errorf("jwt error: %v", warns)
	}
	jwtReq.Headers = []model.KeyValue{hdr("Authorization", "x")}
	if out, warns, _ := MaterializeWith(jwtReq, nil); len(warns) != 0 || header(out, "Authorization") != "x" {
		t.Error("jwt user header")
	}
	if _, warns, _ := MaterializeWith(model.Request{Auth: model.Auth{Type: model.AuthJWT}}, nil); len(warns) != 0 {
		t.Error("jwt no settings")
	}

	hawkReq := model.Request{Method: "POST", URL: "http://example.com:8000/x", Body: model.Body{Type: model.BodyRaw, Raw: "hi", Language: model.LangText},
		Auth: model.Auth{Type: model.AuthHawk, Hawk: &model.Hawk{ID: "id", Key: "k", PayloadHash: true}}}
	out, warns, _ = MaterializeWith(hawkReq, nil)
	if !strings.Contains(header(out, "Authorization"), `hash="`) || len(warns) != 1 {
		t.Errorf("hawk: %v %+v", warns, out.Headers)
	}
	hawkReq.Body = model.Body{Type: model.BodyBinary, BinaryPath: "/x"}
	if out, warns, _ := MaterializeWith(hawkReq, nil); strings.Contains(header(out, "Authorization"), `hash="`) || len(warns) != 2 {
		t.Errorf("hawk binary: %v", warns)
	}
	for _, h := range []*model.Hawk{{ID: "{{id}}", Key: "k"}, {ID: "id"}} {
		hawkReq.Auth.Hawk = h
		if out, warns, _ := MaterializeWith(hawkReq, nil); len(warns) != 1 || header(out, "Authorization") != "" {
			t.Errorf("hawk %+v: %v", h, warns)
		}
	}
	hawkReq.URL = "http://[::1"
	hawkReq.Auth.Hawk = &model.Hawk{ID: "id", Key: "k"}
	if _, warns, _ := MaterializeWith(hawkReq, nil); len(warns) != 1 || !strings.Contains(warns[0], "URL") {
		t.Errorf("hawk bad url: %v", warns)
	}
	hawkReq.URL = "http://x/"
	hawkReq.Headers = []model.KeyValue{hdr("Authorization", "x")}
	if _, warns, _ := MaterializeWith(hawkReq, nil); len(warns) != 0 {
		t.Error("hawk user header")
	}
	if _, warns, _ := MaterializeWith(model.Request{Auth: model.Auth{Type: model.AuthHawk}}, nil); len(warns) != 0 {
		t.Error("hawk no settings")
	}

	// Urlencoded bodies are signed with their wire form.
	enc := req
	enc.Method = "POST"
	enc.Body = model.Body{Type: model.BodyURLEncoded, URLEncoded: []model.KeyValue{hdr("Param1", "value1")}}
	out, _, _ = MaterializeWith(enc, nil)
	if !strings.HasSuffix(header(out, "Authorization"), "ff11897932ad3f4e8b18135d722051e5ac45fc38421b1da7b9d196a0fe09473a") {
		t.Errorf("urlencoded: %s", header(out, "Authorization"))
	}
	_ = url.URL{}
	_ = hawk.SHA1
}

func header(r model.Request, name string) string {
	for _, h := range r.Headers {
		if h.Enabled && strings.EqualFold(h.Key, name) {
			return h.Value
		}
	}
	return ""
}
