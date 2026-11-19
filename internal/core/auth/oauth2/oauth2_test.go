package oauth2

import (
	"context"
	"errors"
	"net/http"
	"net/url"
	"strings"
	"testing"
	"time"

	"pakpos/internal/core/auth/oauth2/oauth2test"
	"pakpos/internal/core/model"
)

var now = time.Date(2026, 11, 19, 10, 0, 0, 0, time.UTC)

func TestValidate(t *testing.T) {
	code := model.OAuth2{AuthURL: "https://a/auth", TokenURL: "https://a/token", ClientID: "id"}
	tests := []struct {
		name   string
		mutate func(*model.OAuth2)
		want   string
	}{
		{"code ok", func(*model.OAuth2) {}, ""},
		{"unknown grant", func(o *model.OAuth2) { o.Grant = "device" }, "unknown OAuth 2.0 grant"},
		{"no auth url", func(o *model.OAuth2) { o.AuthURL = " " }, "enter the auth URL"},
		{"bad auth url", func(o *model.OAuth2) { o.AuthURL = "ftp://a" }, "auth URL must be"},
		{"bad redirect", func(o *model.OAuth2) { o.RedirectURL = "https://a/cb" }, "callback URL"},
		{"no token url", func(o *model.OAuth2) { o.TokenURL = "" }, "enter the token URL"},
		{"no client id", func(o *model.OAuth2) { o.ClientID = "" }, "client ID"},
		{"bad pkce", func(o *model.OAuth2) { o.PKCEMethod = "S512" }, "PKCE method"},
		{"pkce off ignores method", func(o *model.OAuth2) { o.PKCEMethod = "S512"; o.DisablePKCE = true }, ""},
		{"implicit needs no token url", func(o *model.OAuth2) { o.Grant = model.GrantImplicit; o.TokenURL = "" }, ""},
		{"client credentials needs no auth url", func(o *model.OAuth2) { o.Grant = model.GrantClientCredentials; o.AuthURL = "" }, ""},
		{"password needs a username", func(o *model.OAuth2) { o.Grant = model.GrantPassword }, "username"},
		{"password without client id", func(o *model.OAuth2) { o.Grant = model.GrantPassword; o.ClientID = ""; o.Username = "u" }, ""},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			o := code
			tt.mutate(&o)
			err := Validate(o)
			if tt.want == "" && err != nil || tt.want != "" && (err == nil || !strings.Contains(err.Error(), tt.want)) {
				t.Errorf("err = %v, want %q", err, tt.want)
			}
		})
	}
}

func TestParseRedirect(t *testing.T) {
	tests := []struct {
		in   string
		want Redirect
		bad  bool
	}{
		{"", Redirect{Host: "127.0.0.1", Path: "/callback"}, false},
		{"http://127.0.0.1:8765/callback", Redirect{Host: "127.0.0.1", Port: 8765, Path: "/callback"}, false},
		{"http://localhost:9000", Redirect{Host: "localhost", Port: 9000, Path: "/"}, false},
		{"https://127.0.0.1:1/cb", Redirect{}, true},
		{"http://example.com:80/cb", Redirect{}, true},
		{"http://127.0.0.1/cb", Redirect{}, true},
		{"http://127.0.0.1:70000/cb", Redirect{}, true},
		{"http://127.0.0.1:80/cb?x=1", Redirect{}, true},
		{"http://u:p@127.0.0.1:80/cb", Redirect{}, true},
		{"http://%zz", Redirect{}, true},
	}
	for _, tt := range tests {
		got, err := ParseRedirect(tt.in)
		if (err != nil) != tt.bad || got != tt.want {
			t.Errorf("%q: %+v %v", tt.in, got, err)
		}
	}
}

func TestParseResponse(t *testing.T) {
	tests := []struct {
		name   string
		status int
		ct     string
		body   string
		check  func(t *testing.T, tok Token, err error)
	}{
		{"json", 200, "application/json", `{"access_token":"a","refresh_token":"r","token_type":"Bearer","expires_in":60,"scope":"read","id_token":"i"}`,
			func(t *testing.T, tok Token, err error) {
				if err != nil || tok.AccessToken != "a" || tok.RefreshToken != "r" || tok.TokenType != "Bearer" || tok.Scope != "read" ||
					tok.IDToken != "i" || !tok.ExpiresAt.Equal(now.Add(time.Minute)) || !tok.ObtainedAt.Equal(now) {
					t.Errorf("%+v %v", tok, err)
				}
			}},
		{"json string expiry, charset", 200, "application/json; charset=utf-8", `{"access_token":"a","expires_in":"30"}`,
			func(t *testing.T, tok Token, err error) {
				if err != nil || !tok.ExpiresAt.Equal(now.Add(30*time.Second)) {
					t.Errorf("%+v %v", tok, err)
				}
			}},
		{"no expiry", 200, "application/json", `{"access_token":"a","expires_in":0}`,
			func(t *testing.T, tok Token, err error) {
				if err != nil || !tok.ExpiresAt.IsZero() || tok.ExpiresWithin(now, time.Hour) {
					t.Errorf("%+v %v", tok, err)
				}
			}},
		{"form", 200, "application/x-www-form-urlencoded", "access_token=a&scope=repo&token_type=bearer",
			func(t *testing.T, tok Token, err error) {
				if err != nil || tok.AccessToken != "a" || tok.Scope != "repo" {
					t.Errorf("%+v %v", tok, err)
				}
			}},
		{"text plain form", 200, "text/plain", "access_token=a",
			func(t *testing.T, tok Token, err error) {
				if err != nil || tok.AccessToken != "a" {
					t.Errorf("%+v %v", tok, err)
				}
			}},
		{"json without content type", 200, "", `{"access_token":"a"}`,
			func(t *testing.T, tok Token, err error) {
				if err != nil || tok.AccessToken != "a" {
					t.Errorf("%+v %v", tok, err)
				}
			}},
		{"oauth error", 400, "application/json", `{"error":"invalid_client","error_description":"Bad secret."}`,
			func(t *testing.T, _ Token, err error) {
				var e *Error
				if !errors.As(err, &e) || e.Code != "invalid_client" || e.Status != 400 ||
					err.Error() != "The authorization server returned invalid_client: Bad secret. Check the client ID, the client secret and how the client authenticates (header or body)." {
					t.Errorf("%v", err)
				}
			}},
		{"error in a 200 form", 200, "application/x-www-form-urlencoded", "error=bad_verification_code&error_description=The+code+is+wrong",
			func(t *testing.T, _ Token, err error) {
				if err == nil || err.Error() != "The authorization server returned bad_verification_code: The code is wrong." {
					t.Errorf("%v", err)
				}
			}},
		{"html 500", 500, "text/html", "<h1>oops</h1>",
			func(t *testing.T, _ Token, err error) {
				if err == nil || err.Error() != "The token endpoint answered 500 Internal Server Error." {
					t.Errorf("%v", err)
				}
			}},
		{"bad json 200", 200, "application/json", `{"access_token":`,
			func(t *testing.T, _ Token, err error) {
				if !errors.Is(err, ErrNoAccessToken) {
					t.Errorf("%v", err)
				}
			}},
		{"no access token", 200, "application/json", `{"token_type":"Bearer"}`,
			func(t *testing.T, _ Token, err error) {
				if !errors.Is(err, ErrNoAccessToken) {
					t.Errorf("%v", err)
				}
			}},
		{"bad form", 200, "application/x-www-form-urlencoded", "a=%zz",
			func(t *testing.T, _ Token, err error) {
				if !errors.Is(err, ErrNoAccessToken) {
					t.Errorf("%v", err)
				}
			}},
		{"binary", 200, "application/octet-stream", "xyz",
			func(t *testing.T, _ Token, err error) {
				if !errors.Is(err, ErrNoAccessToken) {
					t.Errorf("%v", err)
				}
			}},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			tok, err := ParseResponse(tt.status, tt.ct, []byte(tt.body), now)
			tt.check(t, tok, err)
		})
	}
}

func TestErrorMessages(t *testing.T) {
	if got := (&Error{Code: "custom"}).Error(); got != "The authorization server returned custom." {
		t.Error(got)
	}
	if got := (&Error{Code: "access_denied", Description: "No"}).Error(); got != "The authorization server returned access_denied: No. Authorization was denied in the browser." {
		t.Error(got)
	}
}

func TestTokenHelpers(t *testing.T) {
	tok := Token{ExpiresAt: now.Add(20 * time.Second)}
	if !tok.ExpiresWithin(now, 30*time.Second) || tok.ExpiresWithin(now, 10*time.Second) {
		t.Error("ExpiresWithin")
	}
	old := Token{AccessToken: "a", RefreshToken: "r", Scope: "s", IDToken: "i"}
	if got := old.Merge(Token{AccessToken: "b"}); got != (Token{AccessToken: "b", RefreshToken: "r", Scope: "s", IDToken: "i"}) {
		t.Errorf("merge %+v", got)
	}
	if got := old.Merge(Token{AccessToken: "b", RefreshToken: "r2", Scope: "x", IDToken: "j"}); got.RefreshToken != "r2" || got.Scope != "x" || got.IDToken != "j" {
		t.Errorf("merge keeps new values: %+v", got)
	}
}

func TestPKCE(t *testing.T) {
	// RFC 7636 Appendix B.
	if got := Challenge("S256", "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk"); got != "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM" {
		t.Errorf("S256 = %s", got)
	}
	if Challenge("plain", "v") != "v" {
		t.Error("plain")
	}
	v, err := NewVerifier()
	if err != nil || len(v) != 43 {
		t.Errorf("verifier %q %v", v, err)
	}
	s1, _ := NewState()
	s2, _ := NewState()
	if s1 == s2 || len(s1) < 30 {
		t.Error("state")
	}
	if _, err := random(strings.NewReader(""), 4); err == nil {
		t.Error("a failing random source")
	}
}

func TestAuthorizationURL(t *testing.T) {
	o := model.OAuth2{
		AuthURL: "https://a/auth?prompt=consent", ClientID: "id", Scope: " read write ",
		ExtraParams: []model.KeyValue{{Key: "audience", Value: "api", Enabled: true}, {Key: "off", Value: "x"}, {Key: "state", Value: "evil", Enabled: true}},
	}
	raw, err := AuthorizationURL(o, "http://127.0.0.1:5/callback", "st", "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk")
	if err != nil {
		t.Fatal(err)
	}
	u, _ := url.Parse(raw)
	q := u.Query()
	want := map[string]string{
		"prompt": "consent", "response_type": "code", "client_id": "id", "redirect_uri": "http://127.0.0.1:5/callback",
		"scope": "read write", "state": "st", "code_challenge": "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM",
		"code_challenge_method": "S256", "audience": "api",
	}
	for k, v := range want {
		if q.Get(k) != v {
			t.Errorf("%s = %q, want %q", k, q.Get(k), v)
		}
	}
	if q.Has("off") || len(q) != len(want) {
		t.Errorf("query %v", q)
	}

	o.Grant, o.Scope = model.GrantImplicit, ""
	raw, _ = AuthorizationURL(o, "r", "st", "v")
	q = mustQuery(t, raw)
	if q.Get("response_type") != "token" || q.Has("code_challenge") || q.Has("scope") {
		t.Errorf("implicit %v", q)
	}
	o.Grant, o.PKCEMethod = model.GrantAuthorizationCode, "plain"
	q = mustQuery(t, must(AuthorizationURL(o, "r", "st", "v")))
	if q.Get("code_challenge") != "v" || q.Get("code_challenge_method") != "plain" {
		t.Errorf("plain %v", q)
	}
	o.DisablePKCE = true
	if q := mustQuery(t, must(AuthorizationURL(o, "r", "st", "v"))); q.Has("code_challenge") {
		t.Error("PKCE off")
	}
	if _, err := AuthorizationURL(model.OAuth2{AuthURL: "http://%zz"}, "r", "s", ""); err == nil {
		t.Error("bad auth URL")
	}
}

func must(s string, err error) string {
	if err != nil {
		panic(err)
	}
	return s
}

func mustQuery(t *testing.T, raw string) url.Values {
	t.Helper()
	u, err := url.Parse(raw)
	if err != nil {
		t.Fatal(err)
	}
	return u.Query()
}

func newServer(t *testing.T, o oauth2test.Options) *oauth2test.Server {
	t.Helper()
	if o.ClientID == "" {
		o.ClientID, o.ClientSecret, o.Username, o.Password = "pakpos", "s3cret&+", "ann", "pa55 word"
	}
	s := oauth2test.New(o)
	t.Cleanup(s.Close)
	return s
}

func settings(s *oauth2test.Server, grant model.OAuth2Grant) model.OAuth2 {
	return model.OAuth2{
		Grant: grant, AuthURL: s.AuthURL(), TokenURL: s.TokenURL(), ClientID: "pakpos", ClientSecret: "s3cret&+",
		Username: "ann", Password: "pa55 word", Scope: "read",
	}
}

// browse follows the authorization URL like a browser would, in the
// background, and records the callback page.
func browse(t *testing.T, page *string) func(string) error {
	return func(authURL string) error {
		go func() {
			_, body, err := oauth2test.Browse(authURL)
			if err != nil {
				t.Errorf("browse: %v", err)
			}
			if page != nil {
				*page = body
			}
		}()
		return nil
	}
}

func TestGrants(t *testing.T) {
	ctx := context.Background()
	tests := []struct {
		name    string
		opts    oauth2test.Options
		grant   model.OAuth2Grant
		mutate  func(*model.OAuth2)
		wantErr string
		check   func(t *testing.T, s *oauth2test.Server, tok Token)
	}{
		{name: "client credentials, basic auth", grant: model.GrantClientCredentials,
			check: func(t *testing.T, s *oauth2test.Server, tok Token) {
				f := s.Forms()[0]
				if f.Get("grant_type") != "client_credentials" || f.Get("scope") != "read" || f.Has("client_secret") {
					t.Errorf("form %v", f)
				}
				// RFC 6749 §2.3.1: form-encoded before Basic.
				if s.Authorizations()[0] != "Basic cGFrcG9zOnMzY3JldCUyNiUyQg==" {
					t.Errorf("authorization %q", s.Authorizations()[0])
				}
				if tok.RefreshToken != "" || !tok.ExpiresAt.Equal(now.Add(time.Hour)) {
					t.Errorf("token %+v", tok)
				}
			}},
		{name: "client credentials, credentials in the body", grant: model.GrantClientCredentials,
			mutate: func(o *model.OAuth2) {
				o.ClientAuth = model.ClientAuthBody
				o.ExtraParams = []model.KeyValue{{Key: "audience", Value: "https://api", Enabled: true}}
			},
			check: func(t *testing.T, s *oauth2test.Server, _ Token) {
				f := s.Forms()[0]
				if f.Get("client_id") != "pakpos" || f.Get("client_secret") != "s3cret&+" || f.Get("audience") != "https://api" || s.Authorizations()[0] != "" {
					t.Errorf("form %v", f)
				}
			}},
		{name: "client credentials, wrong secret", grant: model.GrantClientCredentials,
			mutate: func(o *model.OAuth2) { o.ClientSecret = "nope" }, wantErr: "invalid_client"},
		{name: "password", grant: model.GrantPassword, opts: oauth2test.Options{FormResponse: true},
			check: func(t *testing.T, s *oauth2test.Server, tok Token) {
				f := s.Forms()[0]
				if f.Get("username") != "ann" || f.Get("password") != "pa55 word" || tok.RefreshToken == "" || tok.Scope != "read" {
					t.Errorf("form %v token %+v", f, tok)
				}
			}},
		{name: "password, wrong password", grant: model.GrantPassword,
			mutate: func(o *model.OAuth2) { o.Password = "x" }, wantErr: "invalid_grant: Wrong username or password"},
		{name: "authorization code with PKCE (S256)", grant: model.GrantAuthorizationCode,
			check: func(t *testing.T, s *oauth2test.Server, tok Token) {
				f := s.Forms()[0]
				if f.Get("grant_type") != "authorization_code" || len(f.Get("code_verifier")) != 43 || !strings.HasPrefix(f.Get("redirect_uri"), "http://127.0.0.1:") {
					t.Errorf("form %v", f)
				}
				if !s.Valid(tok.AccessToken) || tok.RefreshToken == "" {
					t.Errorf("token %+v", tok)
				}
			}},
		{name: "authorization code, public client with plain PKCE", grant: model.GrantAuthorizationCode,
			mutate: func(o *model.OAuth2) { o.ClientSecret, o.PKCEMethod = "", model.PKCEPlain },
			check: func(t *testing.T, s *oauth2test.Server, _ Token) {
				f := s.Forms()[0]
				if f.Get("client_id") != "pakpos" || f.Has("client_secret") || s.Authorizations()[0] != "" {
					t.Errorf("form %v", f)
				}
			}},
		{name: "authorization code without PKCE", grant: model.GrantAuthorizationCode,
			mutate: func(o *model.OAuth2) { o.DisablePKCE = true },
			check: func(t *testing.T, s *oauth2test.Server, _ Token) {
				if s.Forms()[0].Has("code_verifier") {
					t.Error("no verifier without PKCE")
				}
			}},
		{name: "authorization code on a fixed localhost port", grant: model.GrantAuthorizationCode,
			mutate: func(o *model.OAuth2) { o.RedirectURL = "http://localhost:" + freePort(t) + "/cb" },
			check: func(t *testing.T, s *oauth2test.Server, _ Token) {
				if r := s.Forms()[0].Get("redirect_uri"); !strings.HasPrefix(r, "http://localhost:") || !strings.HasSuffix(r, "/cb") {
					t.Errorf("redirect %q", r)
				}
			}},
		{name: "implicit", grant: model.GrantImplicit,
			check: func(t *testing.T, s *oauth2test.Server, tok Token) {
				if len(s.Forms()) != 0 || !s.Valid(tok.AccessToken) || tok.TokenType != "Bearer" || tok.ExpiresAt.IsZero() {
					t.Errorf("token %+v forms %v", tok, s.Forms())
				}
			}},
		{name: "authorization code, refused redirect", grant: model.GrantAuthorizationCode,
			mutate: func(o *model.OAuth2) { o.ClientID = "other" }, wantErr: "browse"},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			s := newServer(t, tt.opts)
			o := settings(s, tt.grant)
			if tt.mutate != nil {
				tt.mutate(&o)
			}
			c := Client{Now: func() time.Time { return now }}
			if tt.wantErr == "browse" {
				// The fake refuses the client: nothing reaches the callback.
				ctx, cancel := context.WithTimeout(ctx, 300*time.Millisecond)
				defer cancel()
				_, err := c.Authorize(ctx, o, func(u string) error { go oauth2test.Browse(u); return nil })
				if !errors.Is(err, context.DeadlineExceeded) {
					t.Fatalf("err = %v", err)
				}
				return
			}
			var page string
			tok, err := c.Authorize(ctx, o, browse(t, &page))
			if tt.wantErr != "" {
				if err == nil || !strings.Contains(err.Error(), tt.wantErr) {
					t.Fatalf("err = %v, want %q", err, tt.wantErr)
				}
				return
			}
			if err != nil {
				t.Fatal(err)
			}
			tt.check(t, s, tok)
		})
	}
}

func freePort(t *testing.T) string {
	t.Helper()
	lb, err := Listen("", "x", false)
	if err != nil {
		t.Fatal(err)
	}
	u, _ := url.Parse(lb.RedirectURL())
	_ = lb.Close()
	return u.Port()
}

func TestAuthorizeErrors(t *testing.T) {
	s := newServer(t, oauth2test.Options{})
	c := Client{}
	ctx := context.Background()

	o := settings(s, model.GrantAuthorizationCode)
	o.AuthURL = ""
	if _, err := c.Authorize(ctx, o, nil); err == nil || !strings.Contains(err.Error(), "auth URL") {
		t.Errorf("invalid settings: %v", err)
	}
	o = settings(s, model.GrantAuthorizationCode)
	if _, err := c.Authorize(ctx, o, func(string) error { return errors.New("no browser") }); !errors.Is(err, ErrOpenBrowser) {
		t.Errorf("open: %v", err)
	}
	s.SetDeny(true)
	_, err := c.Authorize(ctx, o, browse(t, nil))
	var e *Error
	if !errors.As(err, &e) || e.Code != "access_denied" {
		t.Errorf("denied: %v", err)
	}
	s.SetDeny(false)

	// Cancelled while waiting for the browser.
	cctx, cancel := context.WithCancel(ctx)
	go func() { time.Sleep(20 * time.Millisecond); cancel() }()
	if _, err := c.Authorize(cctx, o, func(string) error { return nil }); !errors.Is(err, context.Canceled) {
		t.Errorf("cancel: %v", err)
	}

	// A busy fixed port.
	lb, err := Listen("", "x", false)
	if err != nil {
		t.Fatal(err)
	}
	defer lb.Close()
	o.RedirectURL = lb.RedirectURL()
	if _, err := c.Authorize(ctx, o, nil); err == nil || !strings.Contains(err.Error(), "another program") {
		t.Errorf("busy port: %v", err)
	}

	// Client credentials through Authorize is Fetch.
	cc := settings(s, model.GrantClientCredentials)
	if tok, err := c.Authorize(ctx, cc, nil); err != nil || tok.AccessToken == "" {
		t.Errorf("fetch: %v", err)
	}
	if _, err := c.Fetch(ctx, settings(s, model.GrantAuthorizationCode)); !errors.Is(err, ErrBrowserGrant) {
		t.Errorf("fetch of a browser grant: %v", err)
	}
	cc.ClientID = ""
	if _, err := c.Fetch(ctx, cc); err == nil {
		t.Error("fetch validates")
	}
}

func TestRefresh(t *testing.T) {
	s := newServer(t, oauth2test.Options{})
	c := Client{HTTP: http.DefaultClient}
	ctx := context.Background()
	o := settings(s, model.GrantPassword)
	tok, err := c.Fetch(ctx, o)
	if err != nil {
		t.Fatal(err)
	}
	next, err := c.Refresh(ctx, o, tok.RefreshToken)
	if err != nil || next.AccessToken == tok.AccessToken || !s.Valid(next.AccessToken) {
		t.Fatalf("refresh %+v %v", next, err)
	}
	if f := s.Forms()[1]; f.Get("grant_type") != "refresh_token" || f.Get("refresh_token") != tok.RefreshToken {
		t.Errorf("form %v", f)
	}
	// The old refresh token was rotated away.
	if _, err := c.Refresh(ctx, o, tok.RefreshToken); err == nil || !strings.Contains(err.Error(), "invalid_grant") {
		t.Errorf("reuse: %v", err)
	}
	s.SetFailRefresh("invalid_grant")
	if _, err := c.Refresh(ctx, o, next.RefreshToken); err == nil {
		t.Error("failing refresh")
	}
	o.TokenURL = ""
	if _, err := c.Refresh(ctx, o, "x"); err == nil {
		t.Error("no token URL")
	}
	o.TokenURL = "http://127.0.0.1:1/token"
	if _, err := c.Refresh(ctx, o, "x"); err == nil {
		t.Error("unreachable")
	}
	o.TokenURL = "http://a b/"
	if _, err := c.token(ctx, o, url.Values{}); err == nil || !strings.Contains(err.Error(), "token URL") {
		t.Errorf("bad URL: %v", err)
	}
}

func TestExchangeWithoutCode(t *testing.T) {
	// A callback with the right state but no code.
	s := newServer(t, oauth2test.Options{})
	o := settings(s, model.GrantAuthorizationCode)
	_, err := Client{}.Authorize(context.Background(), o, func(authURL string) error {
		go func() {
			q := mustQuery(t, authURL)
			_, _ = http.Get(q.Get("redirect_uri") + "?state=" + url.QueryEscape(q.Get("state")))
		}()
		return nil
	})
	if err == nil || !strings.Contains(err.Error(), "no code") {
		t.Errorf("err = %v", err)
	}
}
