// Package oauth2test is a fake OAuth 2.0 authorization server (with a
// protected resource) for tests: authorization code with PKCE, implicit,
// client credentials, password and refresh grants, plus a "browser" that
// follows an authorization URL to the loopback callback.
package oauth2test

import (
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"sync"
)

// Server is the fake. Set its exported fields before use; they are read
// under its lock, so tests may change them between requests with Set.
type Server struct {
	*httptest.Server

	mu           sync.Mutex
	clientID     string
	clientSecret string
	username     string
	password     string
	// expiresIn is the expires_in of new tokens (0 leaves it out).
	expiresIn int
	// formResponse answers token requests form-encoded instead of JSON.
	formResponse bool
	// failRefresh, when set, is the error code refresh requests get.
	failRefresh string
	// deny makes the authorization endpoint redirect with access_denied.
	deny bool
	// noRefresh issues no refresh tokens.
	noRefresh bool

	codes   map[string]codeInfo
	refresh map[string]bool
	tokens  map[string]bool
	// Forms are the token requests' forms, Authorizations their
	// Authorization headers, in order.
	forms          []url.Values
	authorizations []string
	resourceAuth   []string
}

type codeInfo struct {
	redirect, challenge, method string
}

// Options configure New.
type Options struct {
	ClientID, ClientSecret string
	Username, Password     string
	// ExpiresIn defaults to 3600; -1 leaves expires_in out.
	ExpiresIn    int
	FormResponse bool
	NoRefresh    bool
}

// New starts the fake. Close it when done.
func New(o Options) *Server {
	if o.ExpiresIn == 0 {
		o.ExpiresIn = 3600
	}
	if o.ExpiresIn < 0 {
		o.ExpiresIn = 0
	}
	s := &Server{
		clientID: o.ClientID, clientSecret: o.ClientSecret, username: o.Username, password: o.Password,
		expiresIn: o.ExpiresIn, formResponse: o.FormResponse, noRefresh: o.NoRefresh,
		codes: map[string]codeInfo{}, refresh: map[string]bool{}, tokens: map[string]bool{},
	}
	mux := http.NewServeMux()
	mux.HandleFunc("/authorize", s.authorize)
	mux.HandleFunc("/token", s.token)
	mux.HandleFunc("/api", s.api)
	s.Server = httptest.NewServer(mux)
	return s
}

// AuthURL, TokenURL and APIURL are the fake's endpoints.
func (s *Server) AuthURL() string  { return s.URL + "/authorize" }
func (s *Server) TokenURL() string { return s.URL + "/token" }
func (s *Server) APIURL() string   { return s.URL + "/api" }

// SetFailRefresh makes refresh requests fail with code ("" stops it).
func (s *Server) SetFailRefresh(code string) { s.mu.Lock(); s.failRefresh = code; s.mu.Unlock() }

// SetDeny makes the authorization endpoint deny access.
func (s *Server) SetDeny(deny bool) { s.mu.Lock(); s.deny = deny; s.mu.Unlock() }

// SetExpiresIn sets expires_in for new tokens (0 leaves it out).
func (s *Server) SetExpiresIn(sec int) { s.mu.Lock(); s.expiresIn = sec; s.mu.Unlock() }

// Forms returns copies of the token requests' forms.
func (s *Server) Forms() []url.Values {
	s.mu.Lock()
	defer s.mu.Unlock()
	return append([]url.Values{}, s.forms...)
}

// Authorizations returns the token requests' Authorization headers.
func (s *Server) Authorizations() []string {
	s.mu.Lock()
	defer s.mu.Unlock()
	return append([]string{}, s.authorizations...)
}

// ResourceAuth returns the credentials /api saw (header or query).
func (s *Server) ResourceAuth() []string {
	s.mu.Lock()
	defer s.mu.Unlock()
	return append([]string{}, s.resourceAuth...)
}

// Valid reports whether token is an access token the fake issued.
func (s *Server) Valid(token string) bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.tokens[token]
}

// Revoke makes every issued access token invalid.
func (s *Server) Revoke() { s.mu.Lock(); s.tokens = map[string]bool{}; s.mu.Unlock() }

func randomHex(prefix string) string {
	b := make([]byte, 12)
	_, _ = rand.Read(b)
	return prefix + hex.EncodeToString(b)
}

func (s *Server) authorize(w http.ResponseWriter, r *http.Request) {
	q := r.URL.Query()
	s.mu.Lock()
	defer s.mu.Unlock()
	redirect := q.Get("redirect_uri")
	if q.Get("client_id") != s.clientID || redirect == "" {
		http.Error(w, "unknown client or no redirect_uri", http.StatusBadRequest)
		return
	}
	implicit := q.Get("response_type") == "token"
	back := url.Values{"state": {q.Get("state")}}
	switch {
	case s.deny:
		back.Set("error", "access_denied")
		back.Set("error_description", "The user said no")
	case implicit:
		tok := randomHex("at-")
		s.tokens[tok] = true
		back.Set("access_token", tok)
		back.Set("token_type", "Bearer")
		back.Set("scope", q.Get("scope"))
		if s.expiresIn > 0 {
			back.Set("expires_in", fmt.Sprint(s.expiresIn))
		}
	default:
		code := randomHex("code-")
		s.codes[code] = codeInfo{redirect: redirect, challenge: q.Get("code_challenge"), method: q.Get("code_challenge_method")}
		back.Set("code", code)
	}
	sep := "?"
	if implicit {
		sep = "#"
	}
	http.Redirect(w, r, redirect+sep+back.Encode(), http.StatusFound) //nolint:gosec // a test server redirecting to the client's redirect_uri is the protocol
}

func (s *Server) fail(w http.ResponseWriter, status int, code, desc string) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(map[string]string{"error": code, "error_description": desc})
}

func (s *Server) token(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, "POST only", http.StatusMethodNotAllowed)
		return
	}
	if err := r.ParseForm(); err != nil {
		s.fail(w, http.StatusBadRequest, "invalid_request", err.Error())
		return
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	form := r.PostForm
	s.forms = append(s.forms, form)
	s.authorizations = append(s.authorizations, r.Header.Get("Authorization"))

	id, secret, basic := r.BasicAuth()
	if basic {
		id, _ = url.QueryUnescape(id)
		secret, _ = url.QueryUnescape(secret)
	} else {
		id, secret = form.Get("client_id"), form.Get("client_secret")
	}
	public := secret == "" && form.Get("code_verifier") != "" // a PKCE public client
	if id != s.clientID || (secret != s.clientSecret && !public) {
		s.fail(w, http.StatusUnauthorized, "invalid_client", "Client authentication failed")
		return
	}
	scope := form.Get("scope")
	switch form.Get("grant_type") {
	case "authorization_code":
		c, ok := s.codes[form.Get("code")]
		delete(s.codes, form.Get("code"))
		if !ok || c.redirect != form.Get("redirect_uri") {
			s.fail(w, http.StatusBadRequest, "invalid_grant", "Unknown code or redirect_uri mismatch")
			return
		}
		if c.challenge != "" && !pkceOK(c, form.Get("code_verifier")) {
			s.fail(w, http.StatusBadRequest, "invalid_grant", "PKCE verification failed")
			return
		}
		if c.challenge == "" && secret == "" {
			s.fail(w, http.StatusUnauthorized, "invalid_client", "A public client must use PKCE")
			return
		}
	case "client_credentials":
	case "password":
		if form.Get("username") != s.username || form.Get("password") != s.password {
			s.fail(w, http.StatusBadRequest, "invalid_grant", "Wrong username or password")
			return
		}
	case "refresh_token":
		if s.failRefresh != "" {
			s.fail(w, http.StatusBadRequest, s.failRefresh, "Refresh refused")
			return
		}
		rt := form.Get("refresh_token")
		if !s.refresh[rt] {
			s.fail(w, http.StatusBadRequest, "invalid_grant", "Unknown refresh token")
			return
		}
		delete(s.refresh, rt)
	default:
		s.fail(w, http.StatusBadRequest, "unsupported_grant_type", "")
		return
	}
	out := map[string]string{"access_token": randomHex("at-"), "token_type": "Bearer"}
	s.tokens[out["access_token"]] = true
	if !s.noRefresh && form.Get("grant_type") != "client_credentials" {
		out["refresh_token"] = randomHex("rt-")
		s.refresh[out["refresh_token"]] = true
	}
	if scope != "" {
		out["scope"] = scope
	}
	if s.expiresIn > 0 {
		out["expires_in"] = fmt.Sprint(s.expiresIn)
	}
	if s.formResponse {
		v := url.Values{}
		for k, x := range out {
			v.Set(k, x)
		}
		w.Header().Set("Content-Type", "application/x-www-form-urlencoded")
		_, _ = io.WriteString(w, v.Encode())
		return
	}
	w.Header().Set("Content-Type", "application/json")
	body := map[string]any{}
	for k, x := range out {
		body[k] = x
	}
	if s.expiresIn > 0 {
		body["expires_in"] = s.expiresIn // a number, as most servers send it
	}
	_ = json.NewEncoder(w).Encode(body)
}

func pkceOK(c codeInfo, verifier string) bool {
	if verifier == "" {
		return false
	}
	if c.method == "plain" {
		return verifier == c.challenge
	}
	sum := sha256.Sum256([]byte(verifier))
	return base64.RawURLEncoding.EncodeToString(sum[:]) == c.challenge
}

// api is the protected resource: 200 (echoing the token with ?echo=1) with a valid
// token in the Authorization header (any prefix) or the access_token query
// parameter, else 401.
func (s *Server) api(w http.ResponseWriter, r *http.Request) {
	s.mu.Lock()
	defer s.mu.Unlock()
	tok := r.URL.Query().Get("access_token")
	if h := r.Header.Get("Authorization"); h != "" {
		_, tok, _ = strings.Cut(h, " ")
	}
	s.resourceAuth = append(s.resourceAuth, tok)
	if !s.tokens[tok] {
		w.WriteHeader(http.StatusUnauthorized)
		_, _ = io.WriteString(w, `{"error":"invalid_token"}`)
		return
	}
	w.Header().Set("Content-Type", "application/json")
	if r.URL.Query().Get("echo") == "" {
		_, _ = io.WriteString(w, `{"ok":true}`)
		return
	}
	// Echo the token, as some APIs (and introspection endpoints) do.
	_ = json.NewEncoder(w).Encode(map[string]any{"ok": true, "token": tok})
}

// Browse acts as the user's browser: it opens authURL, follows the
// redirect to the callback and, for the implicit grant (a fragment),
// posts the fragment back as the callback page's script does. It returns
// the callback's final status and body.
func Browse(authURL string) (int, string, error) {
	c := &http.Client{CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }}
	resp, err := c.Get(authURL)
	if err != nil {
		return 0, "", err
	}
	_ = resp.Body.Close()
	loc := resp.Header.Get("Location")
	if loc == "" {
		return resp.StatusCode, "", fmt.Errorf("no redirect from the authorization endpoint (%d)", resp.StatusCode)
	}
	target, fragment, _ := strings.Cut(loc, "#")
	resp, err = c.Get(target)
	if err != nil {
		return 0, "", err
	}
	body, _ := io.ReadAll(resp.Body)
	_ = resp.Body.Close()
	if fragment == "" {
		return resp.StatusCode, string(body), nil
	}
	resp, err = c.Post(target, "application/x-www-form-urlencoded", strings.NewReader(fragment))
	if err != nil {
		return 0, "", err
	}
	defer resp.Body.Close()
	body, _ = io.ReadAll(resp.Body)
	return resp.StatusCode, string(body), nil
}
