package pipeline

import (
	"context"
	"errors"
	"net/http"
	"strings"
	"sync"
	"testing"
	"time"

	"pakpos/internal/core/auth"
	"pakpos/internal/core/auth/oauth2"
	"pakpos/internal/core/auth/oauth2/oauth2test"
	"pakpos/internal/core/inherit"
	"pakpos/internal/core/model"
	"pakpos/internal/secrets"
	"pakpos/internal/store/fsstore"
)

type clock struct {
	mu sync.Mutex
	t  time.Time
}

func (c *clock) now() time.Time      { c.mu.Lock(); defer c.mu.Unlock(); return c.t }
func (c *clock) add(d time.Duration) { c.mu.Lock(); c.t = c.t.Add(d); c.mu.Unlock() }

type oauthFixture struct {
	*fixture
	srv   *oauth2test.Server
	clock *clock
	o     model.OAuth2
	// api is a saved request in Users with its own OAuth 2.0 auth.
	api model.Request
}

func newOAuthFixture(t *testing.T, grant model.OAuth2Grant) *oauthFixture {
	t.Helper()
	srv := oauth2test.New(oauth2test.Options{ClientID: "pk", ClientSecret: "cs-123456", Username: "ann", Password: "pw-123456"})
	t.Cleanup(srv.Close)
	f := &oauthFixture{fixture: newFixture(t), srv: srv, clock: &clock{t: time.Now()}}
	f.sess.WithOAuth2(NewOAuth2(func() *http.Client { return http.DefaultClient }, f.clock.now))
	f.o = model.OAuth2{Grant: grant, AuthURL: srv.AuthURL(), TokenURL: srv.TokenURL(), ClientID: "pk", ClientSecret: "cs-123456",
		Username: "ann", Password: "pw-123456"}
	o := f.o
	f.api = must(f.ws.CreateRequest(f.col.ID, model.Request{Name: "API", Method: "GET", URL: srv.APIURL(),
		Auth: model.Auth{Type: model.AuthOAuth2, OAuth2: &o}}))
	return f
}

func (f *oauthFixture) authorize(t *testing.T, req model.Request, parentID string) (Prepared, *Send, error) {
	t.Helper()
	sd := f.sess.NewSend(req, parentID, "", ScriptOptions{})
	p, err := sd.Prepare()
	if err != nil {
		t.Fatal(err)
	}
	return p, sd, sd.Authorize(context.Background(), &p)
}

func authMessage(err error) string {
	var ae *AuthError
	if errors.As(err, &ae) {
		return ae.Message
	}
	if err == nil {
		return ""
	}
	return "not an AuthError: " + err.Error()
}

func TestAuthorizeFetchesAndReuses(t *testing.T) {
	f := newOAuthFixture(t, model.GrantClientCredentials)
	p, sd, err := f.authorize(t, f.api, "")
	if err != nil {
		t.Fatal(err)
	}
	tok, found, _ := f.sess.LoadToken(f.api.ID)
	if !found || p.Request.Auth != auth.TokenAuth(f.api.Auth.OAuth2, tok.AccessToken) {
		t.Fatalf("auth %+v", p.Request.Auth)
	}
	if got := sd.Mask("x " + tok.AccessToken); got != "x [secret:oauth2AccessToken]" {
		t.Errorf("mask %q", got)
	}
	// Reused while fresh; SendSecrets includes it.
	if _, _, err := f.authorize(t, f.api, ""); err != nil || len(f.srv.Forms()) != 1 {
		t.Fatalf("reuse: %v %d", err, len(f.srv.Forms()))
	}
	vals, _ := f.sess.SendSecrets(f.api, "", "")
	if !containsValue(vals, tok.AccessToken) {
		t.Error("SendSecrets lacks the token")
	}
	// Expiring: client credentials has no refresh token, so it fetches anew.
	f.clock.add(time.Hour)
	if _, _, err := f.authorize(t, f.api, ""); err != nil || len(f.srv.Forms()) != 2 {
		t.Fatalf("refetch: %v %d", err, len(f.srv.Forms()))
	}
	// Other auth is untouched.
	plain := f.api
	plain.Auth = model.Auth{Type: model.AuthNone}
	if p, _, err := f.authorize(t, plain, ""); err != nil || p.Request.Auth.Type != model.AuthNone {
		t.Error("other auth")
	}
}

func TestAuthorizeRefreshes(t *testing.T) {
	f := newOAuthFixture(t, model.GrantAuthorizationCode)
	first := must(f.sess.NewToken(context.Background(), f.api.ID, f.o, func(u string) error {
		go func() { _, _, _ = oauth2test.Browse(u) }()
		return nil
	}))
	f.clock.add(59*time.Minute + 45*time.Second) // 15 s left

	// Concurrent sends refresh once.
	var wg sync.WaitGroup
	for range 4 {
		wg.Add(1)
		go func() {
			defer wg.Done()
			sd := f.sess.NewSend(f.api, "", "", ScriptOptions{})
			p, _ := sd.Prepare()
			if err := sd.Authorize(context.Background(), &p); err != nil {
				t.Error(err)
			}
		}()
	}
	wg.Wait()
	refreshes := 0
	for _, form := range f.srv.Forms() {
		if form.Get("grant_type") == "refresh_token" {
			refreshes++
		}
	}
	tok, _, _ := f.sess.LoadToken(f.api.ID)
	if refreshes != 1 || tok.AccessToken == first.AccessToken || tok.RefreshToken == first.RefreshToken {
		t.Fatalf("refreshes = %d", refreshes)
	}

	// The refresh fails.
	f.clock.add(time.Hour)
	f.srv.SetFailRefresh("invalid_grant")
	_, _, err := f.authorize(t, f.api, "")
	if msg := authMessage(err); !strings.Contains(msg, "Couldn't refresh") || !strings.HasSuffix(msg, "Get a new access token in the Auth tab.") {
		t.Errorf("refresh failure %q", msg)
	}
	if _, err := f.sess.RefreshToken(context.Background(), f.api.ID, f.o); !strings.Contains(authMessage(err), "invalid_grant") {
		t.Errorf("RefreshToken failure %v", err)
	}

	// Auto refresh off: expired is an error; not yet expired is used.
	off := f.api
	o := f.o
	o.DisableAutoRefresh = true
	off.Auth.OAuth2 = &o
	if _, _, err := f.authorize(t, off, ""); !strings.Contains(authMessage(err), "has expired") {
		t.Errorf("expired %v", err)
	}
	f.clock.add(-time.Hour + 10*time.Second)
	if _, _, err := f.authorize(t, off, ""); err != nil {
		t.Errorf("expiring soon %v", err)
	}
}

func TestAuthorizeErrors(t *testing.T) {
	f := newOAuthFixture(t, model.GrantAuthorizationCode)
	ctx := context.Background()
	// No token yet, own auth and inherited.
	if _, _, err := f.authorize(t, f.api, ""); !strings.Contains(authMessage(err), "no OAuth 2.0 access token yet. Get a new access token in the Auth tab.") {
		t.Errorf("none %v", err)
	}
	f.col = must(f.ws.SaveCollection(f.col.ID, fsstore.CollectionSettings{Auth: f.api.Auth, Variables: f.col.Variables}))
	if _, _, err := f.authorize(t, f.req, ""); !strings.Contains(authMessage(err), `the Auth tab of the collection "Users"`) {
		t.Errorf("inherited %v", err)
	}
	// An unsaved draft with its own auth.
	draft := model.Request{Method: "GET", URL: "x", Auth: f.api.Auth}
	if _, _, err := f.authorize(t, draft, f.col.ID); !strings.Contains(authMessage(err), "Save the request first") {
		t.Errorf("draft %v", err)
	}
	// Without a workspace.
	sd := NewSendWithoutWorkspace(draft, ScriptOptions{})
	p, _ := sd.Prepare()
	if err := sd.Authorize(ctx, &p); !strings.Contains(authMessage(err), "Open a workspace") {
		t.Errorf("no workspace %v", err)
	}
	// Locked store.
	f.sec.Err = secrets.ErrLocked
	_, sd, err := f.authorize(t, f.api, "")
	var ae *AuthError
	if !errors.As(err, &ae) || !ae.Locked || !sd.SecretsLocked() || !errors.Is(err, secrets.ErrLocked) {
		t.Errorf("locked %v", err)
	}
	f.sec.Err = errors.New("boom")
	if _, _, err := f.authorize(t, f.api, ""); !strings.Contains(authMessage(err), "Couldn't read the OAuth 2.0 access token: boom") {
		t.Errorf("store error %v", err)
	}
	f.sec.Err = nil

	// Fetch failures and store failures.
	cc := newOAuthFixture(t, model.GrantPassword)
	bad := cc.api
	o := cc.o
	o.Password = "wrong"
	bad.Auth.OAuth2 = &o
	if _, _, err := cc.authorize(t, bad, ""); !strings.Contains(authMessage(err), "Couldn't get an OAuth 2.0 access token: The authorization server returned invalid_grant") {
		t.Errorf("fetch failure %v", err)
	}
	cc.sec.SetErr = secrets.ErrLocked
	if _, _, err := cc.authorize(t, cc.api, ""); !strings.Contains(authMessage(err), "can't be stored") {
		t.Errorf("locked keep %v", err)
	}
	cc.sec.SetErr = secrets.ErrNoPassword
	if _, _, err := cc.authorize(t, cc.api, ""); err != nil {
		t.Errorf("no master password: the send still gets the token: %v", err)
	}
	cc.sec.SetErr = errors.New("disk full")
	if _, err := cc.sess.NewToken(ctx, cc.api.ID, cc.o, nil); !strings.Contains(authMessage(err), "Couldn't store") {
		t.Errorf("NewToken store %v", err)
	}
	cc.sec.SetErr = nil

	// Without OAuth 2.0 on the session.
	plain := New(f.ws, f.sec, nil)
	if _, err := plain.Token(ctx, "x", f.o, ""); err == nil {
		t.Error("Token")
	}
	if _, err := plain.NewToken(ctx, "x", f.o, nil); err == nil {
		t.Error("NewToken")
	}
	if _, err := plain.RefreshToken(ctx, "x", f.o); err == nil {
		t.Error("RefreshToken")
	}
	if _, err := f.sess.NewToken(ctx, "x", model.OAuth2{}, nil); !strings.Contains(authMessage(err), "Check the OAuth 2.0 settings") {
		t.Errorf("NewToken validates %v", err)
	}
}

func TestRefreshTokenCases(t *testing.T) {
	f := newOAuthFixture(t, model.GrantPassword)
	ctx := context.Background()
	if _, err := f.sess.RefreshToken(ctx, f.api.ID, f.o); !strings.Contains(authMessage(err), "no OAuth 2.0 access token to refresh") {
		t.Errorf("none %v", err)
	}
	_ = must(f.sess.NewToken(ctx, f.api.ID, f.o, nil))
	next, err := f.sess.RefreshToken(ctx, f.api.ID, f.o)
	if err != nil || !f.srv.Valid(next.AccessToken) {
		t.Fatalf("refresh %v", err)
	}
	f.sec.SetErr = errors.New("disk full")
	if _, err := f.sess.RefreshToken(ctx, f.api.ID, f.o); !strings.Contains(authMessage(err), "Couldn't store") {
		t.Errorf("store %v", err)
	}
	f.sec.SetErr = nil
	f.sec.Err = secrets.ErrLocked
	if _, err := f.sess.RefreshToken(ctx, f.api.ID, f.o); !strings.Contains(authMessage(err), "locked") {
		t.Errorf("locked %v", err)
	}
	f.sec.Err = nil
	if err := f.sess.SaveToken(f.api.ID, oauth2.Token{AccessToken: "a-1234"}); err != nil {
		t.Fatal(err)
	}
	if _, err := f.sess.RefreshToken(ctx, f.api.ID, f.o); !strings.Contains(authMessage(err), "without a refresh token") {
		t.Errorf("no refresh token %v", err)
	}
}

func TestTokenStorage(t *testing.T) {
	f := newOAuthFixture(t, model.GrantPassword)
	if err := f.sess.SaveToken(" ", oauth2.Token{}); err == nil {
		t.Error("an owner is required")
	}
	_ = f.sec.Set(f.key(f.api.ID, OAuth2TokenKey), "not json")
	if _, found, err := f.sess.LoadToken(f.api.ID); found || err != nil {
		t.Error("a damaged value counts as none")
	}
	if err := f.sess.ClearToken(f.api.ID); err != nil {
		t.Fatal(err)
	}
	if err := f.sess.ClearToken(f.api.ID); err != nil {
		t.Error("clearing nothing is fine")
	}
	f.sec.Err = secrets.ErrNoPassword
	if _, found, err := f.sess.LoadToken(f.api.ID); found || err != nil {
		t.Error("no master password reads as none")
	}
	if err := f.sess.ClearToken(f.api.ID); err != nil {
		t.Error("no master password clears nothing")
	}
	f.sec.Err = nil
}

func TestResolveOAuth2(t *testing.T) {
	f := newOAuthFixture(t, model.GrantPassword)
	a := model.Auth{Type: model.AuthBearer, OAuth2: &model.OAuth2{ClientID: "{{host}}", ClientSecret: "{{token}}"}}
	o, err := f.sess.ResolveOAuth2(f.folder.ID, "", a, "")
	if err != nil || o.ClientID != "col.example" || o.ClientSecret != "s3cret" {
		t.Fatalf("folder owner %+v %v", o, err)
	}
	o, err = f.sess.ResolveOAuth2(f.req.ID, "", a, f.dev.ID)
	if err != nil || o.ClientID != "dev.example" {
		t.Fatalf("request owner %+v %v", o, err)
	}
	if _, err := f.sess.ResolveOAuth2(f.req.ID, "", model.Auth{}, ""); err == nil {
		t.Error("nil settings")
	}
	if _, err := f.sess.ResolveOAuth2(f.req.ID, "", model.Auth{OAuth2: &model.OAuth2{ClientID: "{{nope}}"}}, ""); err == nil || !strings.Contains(err.Error(), "nope") {
		t.Errorf("unresolved %v", err)
	}
	_ = must(f.ws.SaveGlobals([]model.Variable{v("a", "{{a}}")}))
	if _, err := f.sess.ResolveOAuth2(f.req.ID, "", model.Auth{OAuth2: &model.OAuth2{ClientID: "{{a}}"}}, ""); err == nil || !strings.Contains(err.Error(), "loop") {
		t.Errorf("cycle %v", err)
	}
	f.sec.Err = secrets.ErrLocked
	_, err = f.sess.ResolveOAuth2(f.req.ID, "", a, "")
	var ae *AuthError
	if !errors.As(err, &ae) || !ae.Locked {
		t.Errorf("locked %v", err)
	}
	f.sec.Err = nil
}

func TestTokenMessage(t *testing.T) {
	tests := map[error]string{
		&oauth2.Error{Code: "x"}:          "The authorization server returned x.",
		context.DeadlineExceeded:          "Timed out waiting for the authorization server.",
		context.Canceled:                  "Cancelled.",
		errors.New("enter the client ID"): "Enter the client ID.",
		errors.New("done; nothing left"):  "Done; nothing left.",
		errors.New(""):                    "",
	}
	for err, want := range tests {
		if got := TokenMessage(err); got != want {
			t.Errorf("%v: %q", err, got)
		}
	}
	_, err := http.Get("http://127.0.0.1:1/")
	if got := TokenMessage(err); !strings.HasPrefix(got, "Couldn't reach the token endpoint. ") {
		t.Errorf("network: %q", got)
	}
	if (&AuthError{Message: "m"}).Error() != "m" {
		t.Error("Error")
	}
}

func TestTokensInCodeAndOwners(t *testing.T) {
	f := newOAuthFixture(t, model.GrantPassword)
	db := withIndex(t, f.fixture)
	ctx := context.Background()
	tok := must(f.sess.NewToken(ctx, f.api.ID, f.o, nil))

	code := func(opts CodeOptions) PreparedCode {
		return must(f.sess.PrepareCode(f.api, "", "", opts))
	}
	if p := code(CodeOptions{ResolveVariables: true}); p.Request.Auth.Type != model.AuthOAuth2 || len(p.Masked) != 1 || p.Masked[0] != auth.TokenName {
		t.Errorf("masked %+v", p)
	}
	if p := code(CodeOptions{ResolveVariables: true, RevealSecrets: true}); p.Request.Auth.Token != tok.AccessToken {
		t.Errorf("revealed %+v", p.Request.Auth)
	}
	if p := code(CodeOptions{}); p.Request.Auth.Type != model.AuthOAuth2 || len(p.Masked) != 0 {
		t.Errorf("as written %+v", p)
	}
	f.sec.Err = secrets.ErrLocked
	if p := code(CodeOptions{ResolveVariables: true, RevealSecrets: true}); !p.SecretsLocked {
		t.Error("locked")
	}
	if _, locked := f.sess.SendSecrets(f.api, "", ""); !locked {
		t.Error("SendSecrets locked")
	}
	f.sec.Err = nil
	_ = f.sess.ClearToken(f.api.ID)
	if p := code(CodeOptions{ResolveVariables: true, RevealSecrets: true}); len(p.Unresolved) != 1 || p.Unresolved[0] != auth.TokenName {
		t.Errorf("no token %+v", p.Unresolved)
	}

	// Owners.
	if !f.sess.HasOwner(f.col.ID) || !f.sess.HasOwner(f.folder.ID) || !f.sess.HasOwner(f.api.ID) || f.sess.HasOwner("nope") {
		t.Error("HasOwner")
	}
	if TokenOwner(inherit.Result{Request: model.Request{ID: "r"}}) != "r" ||
		TokenOwner(inherit.Result{AuthSource: &inherit.Source{ID: "c"}}) != "c" {
		t.Error("TokenOwner")
	}
	if !f.sess.hasOAuth2(f.api.ID) || f.sess.hasOAuth2(f.req.ID) || f.sess.hasOAuth2(f.col.ID) || f.sess.hasOAuth2(f.folder.ID) || f.sess.hasOAuth2("x") {
		t.Error("hasOAuth2")
	}

	// Pruning keeps the token of an owner using OAuth 2.0, and drops the
	// others (owner gone, or no longer OAuth 2.0).
	for _, id := range []string{f.api.ID, f.folder.ID, "gone"} {
		_ = f.sess.SaveToken(id, oauth2.Token{AccessToken: "t-" + id})
	}
	if n, err := f.sess.PruneSecrets(time.Now().Add(time.Hour)); err != nil || n != 2 {
		t.Fatalf("pruned %d %v", n, err)
	}
	if _, found, _ := f.sess.LoadToken(f.api.ID); !found {
		t.Error("the live token was pruned")
	}

	// Deleting owners deletes their tokens (index-driven), and folders
	// take their requests' tokens along.
	inner := must(f.ws.CreateRequest(f.folder.ID, model.Request{Name: "In", Auth: f.api.Auth}))
	_ = f.sess.SaveToken(inner.ID, oauth2.Token{AccessToken: "t-inner"})
	_ = f.sess.SaveToken(f.folder.ID, oauth2.Token{AccessToken: "t-folder"})
	if err := f.sess.DeleteFolder(f.folder.ID); err != nil {
		t.Fatal(err)
	}
	for _, id := range []string{inner.ID, f.folder.ID} {
		if _, found, _ := f.sess.LoadToken(id); found {
			t.Errorf("token of %s left", id)
		}
	}
	if err := f.sess.DeleteFolder("nope"); err == nil {
		t.Error("unknown folder")
	}
	if err := f.sess.DeleteRequest("nope"); err == nil {
		t.Error("unknown request")
	}
	_ = must(f.sess.NewToken(ctx, f.api.ID, f.o, nil))
	if err := f.sess.DeleteRequest(f.api.ID); err != nil {
		t.Fatal(err)
	}
	if _, found, _ := f.sess.LoadToken(f.api.ID); found {
		t.Error("request token left")
	}
	_ = db

	// Without an index every id is cleared; failures are logged.
	g := newOAuthFixture(t, model.GrantPassword)
	_ = g.sess.SaveToken(g.api.ID, oauth2.Token{AccessToken: "t-x"})
	g.sec.Err = errors.New("boom")
	g.sess.forgetTokens([]string{g.api.ID})
	g.sec.Err = nil
	if !strings.Contains(g.logs.String(), "delete OAuth 2.0 token") {
		t.Error("not logged")
	}
	g.sess.forgetTokens(nil)
	if err := g.sess.DeleteCollection(g.col.ID); err != nil {
		t.Fatal(err)
	}
	if _, found, _ := g.sess.LoadToken(g.api.ID); found {
		t.Error("collection delete left the token")
	}
}
