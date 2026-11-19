package service

import (
	"context"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"sync"
	"testing"
	"time"

	"pakpos/internal/core/auth/oauth2"
	"pakpos/internal/core/auth/oauth2/oauth2test"
	"pakpos/internal/core/httpexec"
	"pakpos/internal/core/model"
	"pakpos/internal/core/vars"
	"pakpos/internal/pipeline"
	"pakpos/internal/secrets"
	"pakpos/internal/store/fsstore"
	"pakpos/internal/store/sqlite"
)

const oauthClientSecret = "client-secret-9a8b7c6d"

// browserApp is an AppControl whose "browser" follows the authorization
// URL to the loopback callback, as the user's browser would.
type browserApp struct {
	mu     sync.Mutex
	opened []string
	pages  []string
	stay   bool // open nothing (the user never signs in)
	err    error
}

func (a *browserApp) OpenURL(u string) error {
	a.mu.Lock()
	a.opened = append(a.opened, u)
	stay, err := a.stay, a.err
	a.mu.Unlock()
	if err != nil || stay {
		return err
	}
	go func() {
		_, body, _ := oauth2test.Browse(u)
		a.mu.Lock()
		a.pages = append(a.pages, body)
		a.mu.Unlock()
	}()
	return nil
}

func (a *browserApp) Quit() {}

type oauthFixture struct {
	h    *harness
	auth *AuthService
	app  *browserApp
	srv  *oauth2test.Server
	info WorkspaceInfo
	col  fsstore.Collection
	dev  fsstore.Environment
}

func newOAuthFixture(t *testing.T) *oauthFixture {
	t.Helper()
	srv := oauth2test.New(oauth2test.Options{ClientID: "pakpos", ClientSecret: oauthClientSecret, Username: "ann", Password: "pw-ann-1234"})
	t.Cleanup(srv.Close)
	h := newHarness(t)
	f := &oauthFixture{h: h, app: &browserApp{}, srv: srv, info: h.openWorkspace(t)}
	f.auth = NewAuthService(h.core, f.app)
	var err error
	if f.col, err = h.ws.CreateCollection("API"); err != nil {
		t.Fatal(err)
	}
	if f.dev, err = h.env.Create("Dev"); err != nil {
		t.Fatal(err)
	}
	ref := pipeline.ScopeRef{Kind: vars.ScopeEnvironment, ID: f.dev.ID}
	if _, err := h.env.SaveVariables(ref, []model.Variable{
		{Key: "authBase", Value: srv.URL, Enabled: true},
		{Key: "clientSecret", Enabled: true, Secret: true},
	}, nil); err != nil {
		t.Fatal(err)
	}
	if err := h.env.SetSecret(ref, "clientSecret", oauthClientSecret); err != nil {
		t.Fatal(err)
	}
	if err := h.env.Select(f.dev.ID); err != nil {
		t.Fatal(err)
	}
	return f
}

// settings is OAuth 2.0 auth against the fake with {{variables}}.
func (f *oauthFixture) settings(grant model.OAuth2Grant) model.Auth {
	return model.Auth{Type: model.AuthOAuth2, OAuth2: &model.OAuth2{
		Grant: grant, AuthURL: "{{authBase}}/authorize", TokenURL: "{{authBase}}/token",
		ClientID: "pakpos", ClientSecret: "{{clientSecret}}", Scope: "read", Username: "ann", Password: "pw-ann-1234",
	}}
}

func (f *oauthFixture) send(t *testing.T, req model.Request) SendResult {
	t.Helper()
	res, err := f.h.req.Send(context.Background(), model.NewID(), req, "")
	if err != nil {
		t.Fatal(err)
	}
	return res
}

func (f *oauthFixture) storedToken(t *testing.T, owner string) oauth2.Token {
	t.Helper()
	raw, err := f.h.secrets.Get(secrets.Key(f.info.ID, owner, pipeline.OAuth2TokenKey))
	if err != nil {
		t.Fatalf("no token stored for %s: %v", owner, err)
	}
	var tok oauth2.Token
	if err := json.Unmarshal([]byte(raw), &tok); err != nil {
		t.Fatal(err)
	}
	return tok
}

func (f *oauthFixture) hasToken(owner string) bool {
	_, err := f.h.secrets.Get(secrets.Key(f.info.ID, owner, pipeline.OAuth2TokenKey))
	return err == nil
}

func authHeader(res SendResult) string {
	for _, h := range res.Hops[0].RequestHeaders {
		if h.Key == "Authorization" {
			return h.Value
		}
	}
	return ""
}

// TestEndToEndOAuth2ClientCredentials: a collection's client credentials
// auth (secret client secret) is inherited by a request; the first send
// fetches a token, later sends reuse it; hops, history, examples, code
// and runner exports never hold the token.
func TestEndToEndOAuth2ClientCredentials(t *testing.T) {
	f := newOAuthFixture(t)
	h := f.h
	col, err := h.ws.SaveCollection(f.col.ID, fsstore.CollectionSettings{Auth: f.settings(model.GrantClientCredentials)}, nil)
	if err != nil {
		t.Fatal(err)
	}
	req, err := h.req.SaveAs(col.ID, "Me", model.Request{Method: "GET", URL: "{{authBase}}/api", Auth: model.Auth{Type: model.AuthInherit}})
	if err != nil {
		t.Fatal(err)
	}
	if st, _ := f.auth.OAuth2TokenStatus(col.ID); st.HasToken {
		t.Fatal("no token yet")
	}

	res := f.send(t, req)
	if res.Error != nil || res.Response.StatusCode != 200 {
		t.Fatalf("send = %+v %+v", res.Error, res.Response)
	}
	if got := authHeader(res); got != "Bearer [secret:oauth2AccessToken]" {
		t.Errorf("hop Authorization = %q", got)
	}
	tok := f.storedToken(t, col.ID)
	if !f.srv.Valid(tok.AccessToken) || tok.Scope != "read" {
		t.Fatalf("stored %+v", tok)
	}
	if forms := f.srv.Forms(); len(forms) != 1 || forms[0].Get("grant_type") != "client_credentials" {
		t.Fatalf("forms %v", forms)
	}
	// The request's Basic header carried the secret client secret.
	if a := f.srv.Authorizations()[0]; !strings.HasPrefix(a, "Basic ") {
		t.Errorf("client auth %q", a)
	}
	st, err := f.auth.OAuth2TokenStatus(col.ID)
	if err != nil || !st.HasToken || st.Scope != "read" || st.TokenType != "Bearer" || st.ExpiresAt == 0 || st.HasRefreshToken {
		t.Errorf("status %+v %v", st, err)
	}
	if got, err := f.auth.RevealOAuth2Token(col.ID); err != nil || got != tok.AccessToken {
		t.Errorf("reveal = %q %v", got, err)
	}

	// A second send reuses the token.
	res = f.send(t, req)
	if res.Error != nil || len(f.srv.Forms()) != 1 {
		t.Fatalf("second send: %+v, forms %d", res.Error, len(f.srv.Forms()))
	}

	// Nothing holds the token: the request is stored as written.
	for _, secret := range []string{tok.AccessToken, oauthClientSecret} {
		assertNoSecret(t, secret, f.info.Path)
		if dbHolds(t, h.dataDir, secret) {
			t.Errorf("database holds %q", secret)
		}
	}

	// Code: the token is a placeholder unless revealed; cURL with reveal
	// off never holds it.
	code, err := h.req.GenerateCode(req, "", "curl", CodeOptions{ResolveVariables: true})
	if err != nil || !strings.Contains(code.Code, "Bearer {{oauth2AccessToken}}") || !slices.Contains(code.Masked, "oauth2AccessToken") {
		t.Errorf("code = %+v %v", code, err)
	}
	code, err = h.req.GenerateCode(req, "", "curl", CodeOptions{ResolveVariables: true, RevealSecrets: true})
	if err != nil || !strings.Contains(code.Code, "Bearer "+tok.AccessToken) {
		t.Errorf("revealed code = %+v %v", code, err)
	}
	code, err = h.req.GenerateCode(req, "", "python-requests", CodeOptions{})
	if err != nil || !strings.Contains(code.Code, "{{oauth2AccessToken}}") {
		t.Errorf("code as written = %+v %v", code, err)
	}

	// An API that echoes the token: the example scan finds it.
	echo, err := h.req.SaveAs(col.ID, "Echo", model.Request{Method: "GET", URL: "{{authBase}}/api?echo=1", Query: []model.KeyValue{{Key: "echo", Value: "1", Enabled: true}}, Auth: model.Auth{Type: model.AuthInherit}})
	if err != nil {
		t.Fatal(err)
	}
	res = f.send(t, echo)
	if res.Error != nil || !strings.Contains(res.Response.Body, tok.AccessToken) {
		t.Fatalf("echo = %+v %+v", res.Error, res.Response)
	}
	saved, err := h.ex.Save(echo.ID, "OK", res.HistoryID, false)
	if err != nil || saved.Example != nil || !slices.Contains(saved.SecretsFound, "oauth2AccessToken") {
		t.Fatalf("example = %+v %v", saved, err)
	}
	if saved, err = h.ex.Save(echo.ID, "OK", res.HistoryID, true); err != nil || saved.Example == nil {
		t.Fatalf("masked example = %+v %v", saved, err)
	}

	// A runner run with saved responses: the report masks the echoed token.
	run := NewRunnerService(h.core)
	id, err := run.Start(RunConfig{TargetID: col.ID, EnvironmentID: f.dev.ID, Iterations: 1, SaveResponses: true})
	if err != nil {
		t.Fatal(err)
	}
	run.wait()
	rep, err := run.Get(id)
	if err != nil || len(rep.Results) != 2 || rep.Results[1].Error != nil || rep.Results[1].Status != 200 {
		t.Fatalf("run = %+v %v", rep.Results, err)
	}
	if body := rep.Results[1].Response.Body; !strings.Contains(body, "[secret:oauth2AccessToken]") {
		t.Errorf("saved body = %q", body)
	}
	out := t.TempDir()
	for _, format := range []string{ExportJSON, ExportHTML} {
		h.dialogs.save = filepath.Join(out, "report."+format)
		if _, err := run.Export(id, format); err != nil {
			t.Fatal(err)
		}
	}
	for _, secret := range []string{tok.AccessToken, oauthClientSecret} {
		assertNoSecret(t, secret, out, f.info.Path)
	}

	// Clear, then a send fetches a new token.
	if err := f.auth.ClearOAuth2Token(col.ID); err != nil || f.hasToken(col.ID) {
		t.Fatalf("clear: %v", err)
	}
	if res = f.send(t, req); res.Error != nil || len(f.srv.Forms()) != 2 {
		t.Fatalf("after clear: %+v", res.Error)
	}

	// Deleting the collection deletes its token.
	if err := h.ws.DeleteCollection(col.ID); err != nil {
		t.Fatal(err)
	}
	if f.hasToken(col.ID) {
		t.Error("token left after deleting its collection")
	}
}

// TestEndToEndOAuth2AuthorizationCode: the browser flow with PKCE through
// the loopback server, a token that expires within 30 s refreshed on the
// next send, a refresh failure surfaced as an auth error, and no token in
// SQLite, the workspace or the hops.
func TestEndToEndOAuth2AuthorizationCode(t *testing.T) {
	f := newOAuthFixture(t)
	h := f.h
	f.srv.SetExpiresIn(10) // within the refresh window from the start
	a := f.settings(model.GrantAuthorizationCode)
	req, err := h.req.SaveAs(f.col.ID, "Me", model.Request{Method: "GET", URL: "{{authBase}}/api", Auth: a})
	if err != nil {
		t.Fatal(err)
	}
	m, _ := os.ReadFile(filepath.Join(f.info.Path, fsstore.ManifestFile))
	if !strings.Contains(string(m), "version: 3") {
		t.Errorf("an OAuth 2.0 request is a v3 write: %s", m)
	}

	// No token: the send fails with an auth error and starts no flow.
	res := f.send(t, req)
	if res.Error == nil || res.Error.Kind != httpexec.KindAuth || !strings.Contains(res.Error.Message, "Get a new access token in the Auth tab") {
		t.Fatalf("no token: %+v", res.Error)
	}
	if len(f.app.opened) != 0 {
		t.Fatal("a send must never open the browser")
	}

	st, err := f.auth.StartOAuth2(context.Background(), "flow-1", req.ID, "", a)
	if err != nil || !st.HasToken || !st.HasRefreshToken {
		t.Fatalf("start = %+v %v", st, err)
	}
	if len(f.app.opened) != 1 || !strings.Contains(f.app.opened[0], "code_challenge_method=S256") {
		t.Errorf("opened %v", f.app.opened)
	}
	waitUntil(t, func() bool { f.app.mu.Lock(); defer f.app.mu.Unlock(); return len(f.app.pages) == 1 })
	if !strings.Contains(f.app.pages[0], "You can close this window and return to Pakpos.") {
		t.Errorf("callback page %q", f.app.pages[0])
	}
	var flowEvent *OAuth2FlowEvent
	for _, e := range h.events.all() {
		if ev, ok := e.data.(OAuth2FlowEvent); ok && e.name == EventOAuth2Flow {
			flowEvent = &ev
		}
	}
	if flowEvent == nil || flowEvent.FlowID != "flow-1" || flowEvent.Stage != "browser" || flowEvent.AuthURL != f.app.opened[0] {
		t.Errorf("flow event %+v", flowEvent)
	}
	first := f.storedToken(t, req.ID)
	tokens := []string{first.AccessToken, first.RefreshToken}
	if forms := f.srv.Forms(); forms[0].Get("code_verifier") == "" {
		t.Error("no PKCE verifier sent")
	}

	// The token expires within 30 s: the send refreshes it first.
	res = f.send(t, req)
	if res.Error != nil || res.Response.StatusCode != 200 {
		t.Fatalf("send = %+v", res.Error)
	}
	second := f.storedToken(t, req.ID)
	tokens = append(tokens, second.AccessToken, second.RefreshToken)
	if second.AccessToken == first.AccessToken || f.srv.Forms()[1].Get("grant_type") != "refresh_token" {
		t.Fatal("not refreshed")
	}
	if got := f.srv.ResourceAuth(); got[len(got)-1] != second.AccessToken {
		t.Error("the refreshed token wasn't sent")
	}

	// The Refresh button.
	if _, err := f.auth.RefreshOAuth2(context.Background(), req.ID, "", a); err != nil {
		t.Fatal(err)
	}
	third := f.storedToken(t, req.ID)
	tokens = append(tokens, third.AccessToken, third.RefreshToken)

	// A refresh failure stops the send with a clear message.
	f.srv.SetFailRefresh("invalid_grant")
	res = f.send(t, req)
	if res.Error == nil || res.Error.Kind != httpexec.KindAuth ||
		!strings.Contains(res.Error.Message, "Couldn't refresh the OAuth 2.0 access token: The authorization server returned invalid_grant") {
		t.Fatalf("refresh failure: %+v", res.Error)
	}
	if _, err := f.auth.RefreshOAuth2(context.Background(), req.ID, "", a); err == nil || !strings.Contains(err.Error(), "invalid_grant") {
		t.Errorf("refresh button failure: %v", err)
	}
	if page, _ := h.hist.List(sqlite.HistoryFilter{}); page.Total != 3 {
		t.Errorf("history = %d (the auth errors are recorded)", page.Total)
	}

	// Auto refresh off: a token that expires soon (not yet expired) is sent.
	f.srv.SetFailRefresh("")
	off := f.settings(model.GrantAuthorizationCode)
	off.OAuth2.DisableAutoRefresh = true
	req.Auth = off
	if res = f.send(t, req); res.Error != nil {
		t.Fatalf("auto refresh off: %+v", res.Error)
	}

	for _, secret := range append(tokens, oauthClientSecret) {
		assertNoSecret(t, secret, f.info.Path)
		if dbHolds(t, h.dataDir, secret) {
			t.Errorf("database holds %q", secret)
		}
	}

	// A duplicate starts without a token; deleting the request deletes its token.
	dup, err := h.req.Duplicate(req.ID)
	if err != nil {
		t.Fatal(err)
	}
	if f.hasToken(dup.ID) {
		t.Error("duplicates don't copy tokens")
	}
	if err := h.req.Delete(req.ID); err != nil || f.hasToken(req.ID) {
		t.Errorf("delete: %v, token left %v", err, f.hasToken(req.ID))
	}
}

// TestEndToEndOAuth2Implicit: the fragment is posted back by the page.
func TestEndToEndOAuth2Implicit(t *testing.T) {
	f := newOAuthFixture(t)
	folder, err := f.h.ws.CreateFolder(f.col.ID, "Users")
	if err != nil {
		t.Fatal(err)
	}
	a := f.settings(model.GrantImplicit)
	a.OAuth2.Placement, a.OAuth2.QueryParam = model.PlaceQuery, "access_token"
	if _, err := f.h.ws.SaveFolder(folder.ID, fsstore.FolderSettings{Auth: a}); err != nil {
		t.Fatal(err)
	}
	st, err := f.auth.StartOAuth2(context.Background(), "flow", folder.ID, "", a)
	if err != nil || !st.HasToken || st.HasRefreshToken {
		t.Fatalf("start = %+v %v", st, err)
	}
	waitUntil(t, func() bool { f.app.mu.Lock(); defer f.app.mu.Unlock(); return len(f.app.pages) == 1 })
	if f.app.pages[0] != "You can close this window and return to Pakpos." {
		t.Errorf("post answer %q", f.app.pages[0])
	}
	// A draft in the folder inherits it; the token goes in the query.
	res, err := f.h.req.Send(context.Background(), "s", model.Request{Method: "GET", URL: "{{authBase}}/api", Auth: model.Auth{Type: model.AuthInherit}}, folder.ID)
	if err != nil || res.Error != nil || res.Response.StatusCode != 200 {
		t.Fatalf("send %+v %v", res.Error, err)
	}
	if !strings.Contains(res.Hops[0].URL, "access_token=[secret:oauth2AccessToken]") {
		t.Errorf("hop URL %q", res.Hops[0].URL)
	}
	// Deleting the folder deletes its token.
	if err := f.h.ws.DeleteFolder(folder.ID); err != nil || f.hasToken(folder.ID) {
		t.Errorf("delete folder: %v", err)
	}
}

// TestEndToEndOAuth2Password: the password grant fetches on send; a token
// whose owner no longer uses OAuth 2.0 is pruned on the next start.
func TestEndToEndOAuth2Password(t *testing.T) {
	f := newOAuthFixture(t)
	a := f.settings(model.GrantPassword)
	a.OAuth2.ClientAuth = model.ClientAuthBody
	req, err := f.h.req.SaveAs(f.col.ID, "Me", model.Request{Method: "GET", URL: "{{authBase}}/api", Auth: a})
	if err != nil {
		t.Fatal(err)
	}
	other, err := f.h.req.SaveAs(f.col.ID, "Other", model.Request{Method: "GET", URL: "{{authBase}}/api", Auth: a})
	if err != nil {
		t.Fatal(err)
	}
	for _, r := range []model.Request{req, other} {
		if res := f.send(t, r); res.Error != nil {
			t.Fatalf("send: %+v", res.Error)
		}
	}
	if form := f.srv.Forms()[0]; form.Get("client_secret") != oauthClientSecret || form.Get("username") != "ann" {
		t.Errorf("form %v", form)
	}
	other.Auth = model.Auth{Type: model.AuthNone}
	if _, err := f.h.req.Save(other); err != nil {
		t.Fatal(err)
	}
	f.h.restart(t, f.h.secrets)
	if _, err := f.h.ws.Open(f.info.Path); err != nil {
		t.Fatal(err)
	}
	if !f.hasToken(req.ID) || f.hasToken(other.ID) {
		t.Errorf("after prune: in use %v, unused %v", f.hasToken(req.ID), f.hasToken(other.ID))
	}
}

func TestOAuth2ServiceErrors(t *testing.T) {
	f := newOAuthFixture(t)
	h := f.h
	ctx := context.Background()
	a := f.settings(model.GrantAuthorizationCode)
	req, err := h.req.SaveAs(f.col.ID, "Me", model.Request{Method: "GET", URL: "{{authBase}}/api", Auth: a})
	if err != nil {
		t.Fatal(err)
	}
	wantErr := func(name string, err error, want string) {
		t.Helper()
		if err == nil || !strings.Contains(err.Error(), want) {
			t.Errorf("%s: err = %v, want %q", name, err, want)
		}
	}
	_, err = f.auth.StartOAuth2(ctx, "", req.ID, "", a)
	wantErr("no flow id", err, "flow id")
	_, err = f.auth.StartOAuth2(ctx, "x", "", "", a)
	wantErr("unsaved", err, "Save the request first")
	_, err = f.auth.StartOAuth2(ctx, "x", "nope", "", a)
	wantErr("unknown owner", err, "no longer exists")
	_, err = f.auth.StartOAuth2(ctx, "x", req.ID, "", model.Auth{Type: model.AuthOAuth2})
	wantErr("no settings", err, "settings are empty")
	bad := f.settings(model.GrantAuthorizationCode)
	bad.OAuth2.AuthURL = ""
	_, err = f.auth.StartOAuth2(ctx, "x", req.ID, "", bad)
	wantErr("invalid", err, "Check the OAuth 2.0 settings: enter the auth URL.")
	unset := f.settings(model.GrantAuthorizationCode)
	unset.OAuth2.ClientID = "{{nope}}"
	_, err = f.auth.StartOAuth2(ctx, "x", req.ID, "", unset)
	wantErr("unresolved", err, "These variables have no value: nope")

	f.srv.SetDeny(true)
	_, err = f.auth.StartOAuth2(ctx, "x", req.ID, "", a)
	wantErr("denied", err, "access_denied")
	f.srv.SetDeny(false)

	f.app.err = errors.New("no browser here")
	_, err = f.auth.StartOAuth2(ctx, "x", req.ID, "", a)
	wantErr("open", err, "Couldn't open the browser: no browser here.")
	f.app.err = nil

	// Cancel from the UI.
	f.app.stay = true
	done := make(chan error, 1)
	go func() { _, err := f.auth.StartOAuth2(ctx, "flow-c", req.ID, "", a); done <- err }()
	waitUntil(t, func() bool { f.auth.mu.Lock(); defer f.auth.mu.Unlock(); return f.auth.flows["flow-c"] != nil })
	if _, err := f.auth.StartOAuth2(ctx, "flow-c", req.ID, "", a); err == nil || !strings.Contains(err.Error(), "already running") {
		t.Errorf("duplicate flow id: %v", err)
	}
	if !f.auth.CancelOAuth2("flow-c") {
		t.Fatal("no flow to cancel")
	}
	wantErr("cancel", <-done, "Cancelled.")
	if f.auth.CancelOAuth2("flow-c") {
		t.Error("cancel after the end")
	}
	// Timeout.
	f.auth.timeout = 50 * time.Millisecond
	_, err = f.auth.StartOAuth2(ctx, "x", req.ID, "", a)
	wantErr("timeout", err, "waited 50ms for the browser")
	f.auth.timeout = time.Minute
	if humanDuration(time.Minute) != "1 minute" || humanDuration(5*time.Minute) != "5 minutes" {
		t.Error("humanDuration")
	}
	f.app.stay = false

	_, err = f.auth.RefreshOAuth2(ctx, req.ID, "", a)
	wantErr("refresh without token", err, "no OAuth 2.0 access token to refresh")
	_, err = f.auth.RefreshOAuth2(ctx, "", "", a)
	wantErr("refresh unsaved", err, "Save the request first")
	_, err = f.auth.RefreshOAuth2(ctx, req.ID, "", model.Auth{})
	wantErr("refresh without settings", err, "settings are empty")
	_, err = f.auth.RevealOAuth2Token(req.ID)
	wantErr("reveal without token", err, "no OAuth 2.0 access token to show")
	if st, err := f.auth.OAuth2TokenStatus(""); err != nil || st.HasToken {
		t.Errorf("status of no owner = %+v %v", st, err)
	}

	// Client credentials without refresh tokens: Refresh says so.
	cc := f.settings(model.GrantClientCredentials)
	if _, err := f.auth.StartOAuth2(ctx, "cc", req.ID, "", cc); err != nil {
		t.Fatal(err)
	}
	_, err = f.auth.RefreshOAuth2(ctx, req.ID, "", cc)
	wantErr("no refresh token", err, "came without a refresh token")

	// A locked store.
	h.secrets.Err = secrets.ErrLocked
	if st, err := f.auth.OAuth2TokenStatus(req.ID); err != nil || !st.Locked {
		t.Errorf("locked status = %+v %v", st, err)
	}
	_, err = f.auth.RevealOAuth2Token(req.ID)
	wantErr("locked reveal", err, "locked")
	err = f.auth.ClearOAuth2Token(req.ID)
	wantErr("locked clear", err, "locked")
	_, err = f.auth.StartOAuth2(ctx, "x", req.ID, "", a)
	wantErr("locked secret settings", err, "secret store is locked")
	_, err = f.auth.RefreshOAuth2(ctx, req.ID, "", model.Auth{Type: model.AuthOAuth2, OAuth2: &model.OAuth2{TokenURL: f.srv.TokenURL()}})
	wantErr("locked refresh", err, "locked")
	res := f.send(t, model.Request{ID: req.ID, Method: "GET", URL: f.srv.APIURL(), Auth: model.Auth{Type: model.AuthOAuth2, OAuth2: &model.OAuth2{}}})
	if res.Error == nil || res.Error.Kind != httpexec.KindAuth || !res.SecretsLocked {
		t.Errorf("locked send = %+v, locked %v", res.Error, res.SecretsLocked)
	}
	h.secrets.Err = nil

	// Without a workspace.
	h.ws.Close()
	if _, err := f.auth.OAuth2TokenStatus(req.ID); !errors.Is(err, ErrNoWorkspace) {
		t.Errorf("status = %v", err)
	}
	if _, err := f.auth.RevealOAuth2Token(req.ID); !errors.Is(err, ErrNoWorkspace) {
		t.Errorf("reveal = %v", err)
	}
	if err := f.auth.ClearOAuth2Token(req.ID); !errors.Is(err, ErrNoWorkspace) {
		t.Errorf("clear = %v", err)
	}
	if _, err := f.auth.StartOAuth2(ctx, "x", req.ID, "", a); !errors.Is(err, ErrNoWorkspace) {
		t.Errorf("start = %v", err)
	}
	res = f.send(t, model.Request{Method: "GET", URL: f.srv.APIURL(), Auth: a})
	if res.Error == nil || res.Error.Kind != httpexec.KindAuth || !strings.Contains(res.Error.Message, "Open a workspace") {
		t.Errorf("send without workspace = %+v", res.Error)
	}
}
