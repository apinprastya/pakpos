package oauth2test

import (
	"io"
	"net/http"
	"net/url"
	"strings"
	"testing"
)

func post(t *testing.T, s *Server, form url.Values, basic bool) (int, string) {
	t.Helper()
	req, _ := http.NewRequest(http.MethodPost, s.TokenURL(), strings.NewReader(form.Encode()))
	req.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	if basic {
		req.SetBasicAuth("c", "s")
	}
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	b, _ := io.ReadAll(resp.Body)
	return resp.StatusCode, string(b)
}

func TestServer(t *testing.T) {
	s := New(Options{ClientID: "c", ClientSecret: "s", ExpiresIn: -1, FormResponse: true, NoRefresh: true})
	defer s.Close()
	cred := url.Values{"client_id": {"c"}, "client_secret": {"s"}}
	with := func(kv ...string) url.Values {
		v := url.Values{}
		for k, x := range cred {
			v[k] = x
		}
		for i := 0; i < len(kv); i += 2 {
			v.Set(kv[i], kv[i+1])
		}
		return v
	}
	cases := []struct {
		form   url.Values
		basic  bool
		status int
		want   string
	}{
		{with("grant_type", "client_credentials"), false, 200, "access_token="},
		{url.Values{"grant_type": {"client_credentials"}}, true, 200, "access_token="},
		{with("grant_type", "nope"), false, 400, "unsupported_grant_type"},
		{with("grant_type", "password", "username", "x"), false, 400, "Wrong username"},
		{with("grant_type", "refresh_token", "refresh_token", "x"), false, 400, "Unknown refresh token"},
		{with("grant_type", "authorization_code", "code", "x"), false, 400, "Unknown code"},
		{url.Values{"client_id": {"c"}, "grant_type": {"client_credentials"}}, false, 401, "invalid_client"},
	}
	for _, c := range cases {
		status, body := post(t, s, c.form, c.basic)
		if status != c.status || !strings.Contains(body, c.want) || strings.Contains(body, "refresh_token=") {
			t.Errorf("%v: %d %s", c.form, status, body)
		}
	}
	if len(s.Forms()) != len(cases) || len(s.Authorizations()) != len(cases) {
		t.Error("recorded requests")
	}
	if resp, _ := http.Get(s.TokenURL()); resp.StatusCode != http.StatusMethodNotAllowed {
		t.Error("GET token")
	}
	req, _ := http.NewRequest(http.MethodPost, s.TokenURL(), strings.NewReader("%zz"))
	req.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	if resp, _ := http.DefaultClient.Do(req); resp.StatusCode != http.StatusBadRequest {
		t.Error("bad form")
	}
	if resp, _ := http.Get(s.AuthURL() + "?client_id=other"); resp.StatusCode != http.StatusBadRequest {
		t.Error("unknown client")
	}

	// A code without PKCE needs the secret.
	c := &http.Client{CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }}
	resp, _ := c.Get(s.AuthURL() + "?client_id=c&redirect_uri=http://x/cb&state=st")
	loc, _ := url.Parse(resp.Header.Get("Location"))
	code := loc.Query().Get("code")
	if status, body := post(t, s, url.Values{"client_id": {"c"}, "code_verifier": {"v"}, "grant_type": {"authorization_code"}, "code": {code}, "redirect_uri": {"http://x/cb"}}, false); status != 401 || !strings.Contains(body, "public client") {
		t.Errorf("public without PKCE: %d %s", status, body)
	}
	// Plain PKCE checked; a wrong verifier fails.
	resp, _ = c.Get(s.AuthURL() + "?client_id=c&redirect_uri=http://x/cb&code_challenge=abc&code_challenge_method=plain")
	loc, _ = url.Parse(resp.Header.Get("Location"))
	if status, _ := post(t, s, with("grant_type", "authorization_code", "code", loc.Query().Get("code"), "redirect_uri", "http://x/cb", "code_verifier", "nope"), false); status != 400 {
		t.Error("wrong plain verifier")
	}
	if pkceOK(codeInfo{challenge: "x"}, "") {
		t.Error("empty verifier")
	}

	// Resource and helpers.
	_, body := post(t, s, with("grant_type", "client_credentials"), false)
	tok := must(url.ParseQuery(body)).Get("access_token")
	for _, u := range []string{s.APIURL() + "?access_token=" + tok, s.APIURL() + "?echo=1&access_token=" + tok} {
		if resp, _ := http.Get(u); resp.StatusCode != 200 {
			t.Error("api with a token")
		}
	}
	if len(s.ResourceAuth()) != 2 {
		t.Error("resource auth")
	}
	s.Revoke()
	if s.Valid(tok) {
		t.Error("revoke")
	}
	if resp, _ := http.Get(s.APIURL()); resp.StatusCode != 401 {
		t.Error("api without a token")
	}
	if _, _, err := Browse("http://127.0.0.1:1/"); err == nil {
		t.Error("browse unreachable")
	}
	if _, _, err := Browse(s.AuthURL() + "?client_id=other"); err == nil {
		t.Error("browse without redirect")
	}
	if _, _, err := Browse(s.AuthURL() + "?client_id=c&redirect_uri=http://127.0.0.1:1/cb"); err == nil {
		t.Error("browse to a closed callback")
	}
	if _, _, err := Browse(s.AuthURL() + "?client_id=c&response_type=token&redirect_uri=http://127.0.0.1:1/cb"); err == nil {
		t.Error("browse implicit to a closed callback")
	}
}

func must[T any](v T, err error) T {
	if err != nil {
		panic(err)
	}
	return v
}
