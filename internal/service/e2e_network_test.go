package service

import (
	"context"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"pakpos/internal/core/cookies"
	"pakpos/internal/core/httpexec"
	"pakpos/internal/core/model"
	"pakpos/internal/core/settings"
	"pakpos/internal/testnet"
)

// TestEndToEndNetwork goes through the network settings with real stores and
// servers: an HTTP proxy with a password from the secret store, a custom CA,
// a server that requires a client certificate (PEM, then PKCS#12 with a
// stored passphrase), and a request that turns TLS verification off while
// the app keeps it on. No password reaches SQLite.
func TestEndToEndNetwork(t *testing.T) {
	h := newHarness(t)
	h.openWorkspace(t)
	col, err := h.ws.CreateCollection("Net")
	if err != nil {
		t.Fatal(err)
	}
	ctx := context.Background()
	dir := t.TempDir()

	serverCA := testnet.NewCA(t, "Server CA")
	clientCA := testnet.NewCA(t, "Client CA")
	me := clientCA.Client(t, "me")
	mtls := testnet.TLSServer(t, serverCA, clientCA, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_, _ = io.WriteString(w, "hello "+r.TLS.PeerCertificates[0].Subject.CommonName)
	}))
	plainTLS := testnet.TLSServer(t, testnet.NewCA(t, "Unknown CA"), nil, http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		_, _ = io.WriteString(w, "self-signed")
	}))
	target := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_, _ = io.WriteString(w, "direct "+r.URL.Path)
	}))
	defer target.Close()
	proxy := testnet.NewProxy(t)

	send := func(name string, req model.Request) SendResult {
		t.Helper()
		res, err := h.req.Send(ctx, name, req, col.ID)
		if err != nil {
			t.Fatal(err)
		}
		return res
	}
	body := func(res SendResult) string {
		t.Helper()
		if res.Error != nil {
			t.Fatalf("send failed: %s (%v)", res.Error.Message, res.Error.Err)
		}
		return res.Response.Body
	}

	// 1. Proxy: the password comes from the secret store, never SQLite.
	const proxyPassword = "pr0xy-pa55"
	s := h.set.Get()
	s.Proxy = settings.Proxy{Mode: settings.ProxyCustom, URL: proxy.URL, Username: "alice", Bypass: "*.internal"}
	if _, err := h.set.Set(s); err != nil {
		t.Fatal(err)
	}
	if err := h.set.SetProxyPassword(proxyPassword); err != nil {
		t.Fatal(err)
	}
	if got := body(send("p1", model.Request{URL: target.URL + "/via-proxy"})); got != "direct /via-proxy" {
		t.Fatalf("body %q", got)
	}
	if seen := proxy.Seen(); len(seen) != 1 || !strings.HasSuffix(seen[0], "/via-proxy") {
		t.Fatalf("proxy saw %v", seen)
	}
	if auth := proxy.Auth(); auth[0] != "Basic YWxpY2U6cHIweHktcGE1NQ==" { // alice:pr0xy-pa55
		t.Fatalf("Proxy-Authorization %q", auth[0])
	}
	if dbHolds(t, h.dataDir, proxyPassword) {
		t.Fatal("the proxy password reached SQLite")
	}
	s.Proxy.Mode = settings.ProxyNone
	if _, err := h.set.Set(s); err != nil {
		t.Fatal(err)
	}
	send("p2", model.Request{URL: target.URL + "/direct"})
	if len(proxy.Seen()) != 1 {
		t.Fatal("proxy used after it was turned off")
	}

	// 2. Custom CA + mTLS with a PEM pair.
	res := send("m1", model.Request{URL: mtls.URL})
	if res.Error == nil || res.Error.Kind != httpexec.KindTLS {
		t.Fatalf("unknown CA accepted: %+v", res.Error)
	}
	s.CAFile = testnet.WriteFile(t, dir, "ca.pem", serverCA.PEM)
	if _, err := h.set.Set(s); err != nil {
		t.Fatal(err)
	}
	res = send("m2", model.Request{URL: mtls.URL})
	if res.Error == nil || res.Error.Kind != httpexec.KindTLS || !strings.Contains(res.Error.Message, "client certificate") {
		t.Fatalf("no client cert: %+v", res.Error)
	}
	s.ClientCerts = []settings.ClientCert{{
		Host:     "127.0.0.1",
		CertFile: testnet.WriteFile(t, dir, "me.crt", me.CertPEM),
		KeyFile:  testnet.WriteFile(t, dir, "me.key", me.KeyPEM),
	}}
	if _, err := h.set.Set(s); err != nil {
		t.Fatal(err)
	}
	if got := body(send("m3", model.Request{URL: mtls.URL})); got != "hello me" {
		t.Fatalf("mTLS body %q", got)
	}

	// 3. mTLS with PKCS#12: the passphrase is set after the entry is saved.
	const passphrase = "p12-passphrase"
	s.ClientCerts = []settings.ClientCert{{Host: "*", PFXFile: testnet.WriteFile(t, dir, "me.p12", me.PKCS12(t, clientCA, passphrase))}}
	saved, err := h.set.Set(s)
	if err != nil {
		t.Fatal(err)
	}
	if res := send("x1", model.Request{URL: mtls.URL}); res.Error == nil || !strings.Contains(res.Error.Message, "passphrase") {
		t.Fatalf("missing passphrase: %+v", res.Error)
	}
	if err := h.set.SetCertPassphrase(saved.ClientCerts[0].ID, passphrase); err != nil {
		t.Fatal(err)
	}
	if got := body(send("x2", model.Request{URL: mtls.URL})); got != "hello me" {
		t.Fatalf("PKCS#12 body %q", got)
	}
	if dbHolds(t, h.dataDir, passphrase) {
		t.Fatal("the passphrase reached SQLite")
	}

	// 4. A saved request turns verification off; the app keeps it on.
	verify := false
	saved2, err := h.req.SaveAs(col.ID, "Self-signed", model.Request{Method: "GET", URL: plainTLS.URL, Settings: model.RequestSettings{VerifyTLS: &verify}})
	if err != nil {
		t.Fatal(err)
	}
	if got := body(send("v1", saved2)); got != "self-signed" {
		t.Fatalf("override body %q", got)
	}
	if res := send("v2", model.Request{URL: plainTLS.URL}); res.Error == nil || res.Error.Kind != httpexec.KindTLS {
		t.Fatalf("app setting not applied: %+v", res.Error)
	}
	// The pooled mTLS connection survives the override send.
	res = send("x3", model.Request{URL: mtls.URL})
	if len(res.Hops) != 1 || !res.Hops[0].ReusedConn {
		t.Fatalf("the mTLS connection wasn't reused: %+v", res.Hops)
	}
	// The setting is in the file, and the manifest is v3.
	again, err := h.req.Get(saved2.ID)
	if err != nil || again.Settings.VerifyTLS == nil || *again.Settings.VerifyTLS {
		t.Fatalf("settings not saved: %+v %v", again.Settings, err)
	}
}

// TestEndToEndCookiesSurviveRestart: a server sets a persistent and a
// session cookie; after a restart on the same data dir only the persistent
// one is sent, and it is listed by the cookie manager. Cookies belong to
// their workspace, and none are written to the workspace files.
func TestEndToEndCookiesSurviveRestart(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/login":
			http.SetCookie(w, &http.Cookie{Name: "remember", Value: "cookie-value-123", Path: "/", MaxAge: 3600})
			http.SetCookie(w, &http.Cookie{Name: "session", Value: "s1", Path: "/"})
		default:
			var names []string
			for _, c := range r.Cookies() {
				names = append(names, c.Name+"="+c.Value)
			}
			_, _ = io.WriteString(w, strings.Join(names, "; "))
		}
	}))
	defer srv.Close()
	h := newHarness(t)
	info := h.openWorkspace(t)
	ctx := context.Background()
	if _, err := h.req.Send(ctx, "l", model.Request{URL: srv.URL + "/login"}, ""); err != nil {
		t.Fatal(err)
	}
	res, _ := h.req.Send(ctx, "w1", model.Request{URL: srv.URL + "/whoami"}, "")
	if res.Response.Body != "remember=cookie-value-123; session=s1" {
		t.Fatalf("before restart %q", res.Response.Body)
	}

	h.restart(t, h.secrets)
	if _, err := h.ws.Open(info.Path); err != nil {
		t.Fatal(err)
	}
	res, _ = h.req.Send(ctx, "w2", model.Request{URL: srv.URL + "/whoami"}, "")
	if res.Response.Body != "remember=cookie-value-123" {
		t.Fatalf("after restart %q", res.Response.Body)
	}
	svc := NewCookieService(h.core)
	list := svc.List()
	if len(list) != 1 || list[0].Name != "remember" || list[0].Domain != "127.0.0.1" || !list[0].HostOnly {
		t.Fatalf("manager lists %+v", list)
	}
	assertNoSecret(t, "cookie-value-123", info.Path)

	// Another workspace has its own jar; the first one's comes back with it.
	h.openWorkspace(t)
	res, _ = h.req.Send(ctx, "w3", model.Request{URL: srv.URL + "/whoami"}, "")
	if res.Response.Body != "" {
		t.Fatalf("cookies leaked across workspaces: %q", res.Response.Body)
	}
	if _, err := h.ws.Open(info.Path); err != nil {
		t.Fatal(err)
	}
	// An edit in the manager is what the next send uses, and it persists.
	if _, err := svc.Update(list[0].Ref(), cookies.Cookie{Name: "remember", Value: "edited", Domain: "127.0.0.1", HostOnly: true,
		ExpiresAt: time.Now().Add(time.Hour).UnixMilli()}); err != nil {
		t.Fatal(err)
	}
	h.restart(t, h.secrets)
	if _, err := h.ws.Open(info.Path); err != nil {
		t.Fatal(err)
	}
	res, _ = h.req.Send(ctx, "w4", model.Request{URL: srv.URL + "/whoami"}, "")
	if res.Response.Body != "remember=edited" {
		t.Fatalf("edited cookie %q", res.Response.Body)
	}
}
