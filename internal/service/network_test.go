package service

import (
	"context"
	"errors"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"pakpos/internal/core/cookies"
	"pakpos/internal/core/httpexec"
	"pakpos/internal/core/model"
	"pakpos/internal/core/settings"
	"pakpos/internal/secrets"
	"pakpos/internal/testnet"
)

func TestSettingsNetworkFiles(t *testing.T) {
	h := newHarness(t)
	dir := t.TempDir()
	ca := testnet.NewCA(t, "CA")
	caFile := testnet.WriteFile(t, dir, "ca.pem", ca.PEM)
	me := ca.Client(t, "me")
	certFile := testnet.WriteFile(t, dir, "me.crt", me.CertPEM)
	keyFile := testnet.WriteFile(t, dir, "me.key", me.KeyPEM)

	next := h.set.Get()
	next.CAFile = filepath.Join(dir, "missing.pem")
	if _, err := h.set.Set(next); err == nil || !strings.Contains(err.Error(), "missing.pem") {
		t.Fatalf("missing CA accepted: %v", err)
	}
	var ue *userError
	next.CAFile = caFile
	next.ClientCerts = []settings.ClientCert{{Host: "api.example.com", CertFile: certFile, KeyFile: caFile}}
	if _, err := h.set.Set(next); !errors.As(err, &ue) {
		t.Fatalf("bad key pair: %v", err)
	}
	next.ClientCerts[0].KeyFile = keyFile
	saved, err := h.set.Set(next)
	if err != nil {
		t.Fatal(err)
	}
	if saved.ClientCerts[0].ID == "" {
		t.Fatal("no id assigned")
	}

	// An unchanged file that went missing doesn't block other changes.
	saved.CAFile = caFile
	if err := os.Remove(caFile); err != nil {
		t.Fatal(err)
	}
	saved.Theme = settings.ThemeDark
	if _, err := h.set.Set(saved); err != nil {
		t.Fatalf("unrelated change refused: %v", err)
	}
	if got := h.core.executor().Settings().Network; got.CAFile != caFile || got.Secret == nil {
		t.Fatalf("executor network %+v", got)
	}
}

func TestNetworkSecrets(t *testing.T) {
	h := newHarness(t)
	dir := t.TempDir()
	ca := testnet.NewCA(t, "CA")
	pfx := testnet.WriteFile(t, dir, "me.p12", ca.Client(t, "me").PKCS12(t, ca, "pw"))

	st, err := h.set.NetworkSecretStatus()
	if err != nil || st.Locked || st.ProxyPassword || st.CertPassphrases == nil || len(st.CertPassphrases) != 0 {
		t.Fatalf("status %+v %v", st, err)
	}
	if err := h.set.SetProxyPassword("hunter2"); err != nil {
		t.Fatal(err)
	}
	if v, _ := h.secrets.Get("pakpos/_app/proxy"); v != "hunter2" {
		t.Fatalf("stored %q", v)
	}
	if err := h.set.SetCertPassphrase("nope", "x"); err == nil || !strings.Contains(err.Error(), "Save the client certificate") {
		t.Fatalf("unknown cert: %v", err)
	}

	s := h.set.Get()
	s.ClientCerts = []settings.ClientCert{{ID: "c1", Host: "*", PFXFile: pfx}, {ID: "c2", Host: "x", PFXFile: pfx}}
	if _, err := h.set.Set(s); err != nil {
		t.Fatal(err)
	}
	if err := h.set.SetCertPassphrase("c1", "pw"); err != nil {
		t.Fatal(err)
	}
	if err := h.set.SetCertPassphrase("c2", "pw2"); err != nil {
		t.Fatal(err)
	}
	st, _ = h.set.NetworkSecretStatus()
	if !st.ProxyPassword || len(st.CertPassphrases) != 2 {
		t.Fatalf("status %+v", st)
	}
	// Removing a certificate deletes its passphrase.
	s.ClientCerts = s.ClientCerts[:1]
	if _, err := h.set.Set(s); err != nil {
		t.Fatal(err)
	}
	if _, err := h.secrets.Get("pakpos/_app/cert/c2"); !errors.Is(err, secrets.ErrNotFound) {
		t.Fatalf("passphrase of a removed cert kept: %v", err)
	}
	// "" clears; clearing twice is fine.
	for range 2 {
		if err := h.set.SetProxyPassword(""); err != nil {
			t.Fatal(err)
		}
	}
	st, _ = h.set.NetworkSecretStatus()
	if st.ProxyPassword || len(st.CertPassphrases) != 1 {
		t.Fatalf("status %+v", st)
	}

	// Store failures.
	h.secrets.Err = errors.New("keychain broke")
	if err := h.set.SetProxyPassword("x"); err == nil {
		t.Fatal("store failure hidden")
	}
	if _, err := h.set.NetworkSecretStatus(); err == nil {
		t.Fatal("status hid a store failure")
	}
	s.ClientCerts = nil
	if _, err := h.set.Set(s); err != nil { // a failing delete is only logged
		t.Fatal(err)
	}
}

// keyFailStore fails Get for one key.
type keyFailStore struct {
	*secrets.Fake
	key string
}

func (k keyFailStore) Get(key string) (string, error) {
	if key == k.key {
		return "", errors.New("boom")
	}
	return k.Fake.Get(key)
}

func TestNetworkSecretStatusLocked(t *testing.T) {
	h := newHarnessWith(t, secrets.NewFileStore(t.TempDir()))
	st, err := h.set.NetworkSecretStatus()
	if err != nil || st.Locked || st.ProxyPassword {
		t.Fatalf("no password yet: status %+v %v", st, err)
	}
	if err := h.env.SetMasterPassword("password1"); err != nil {
		t.Fatal(err)
	}
	if err := h.env.Lock(); err != nil {
		t.Fatal(err)
	}
	if st, err := h.set.NetworkSecretStatus(); err != nil || !st.Locked {
		t.Fatalf("locked: status %+v %v", st, err)
	}
	h2 := newHarnessWith(t, keyFailStore{Fake: secrets.NewFake(), key: "pakpos/_app/cert/c"})
	s := h2.set.Get()
	s.ClientCerts = []settings.ClientCert{{ID: "c", Host: "*", PFXFile: testnet.WriteFile(t, t.TempDir(), "p.p12", []byte("p"))}}
	if _, err := h2.set.Set(s); err != nil {
		t.Fatal(err)
	}
	if _, err := h2.set.NetworkSecretStatus(); err == nil {
		t.Fatal("cert lookup failure hidden")
	}
}

func TestSendThroughLockedProxyPassword(t *testing.T) {
	h := newHarnessWith(t, secrets.NewFileStore(t.TempDir()))
	if err := h.env.SetMasterPassword("password1"); err != nil {
		t.Fatal(err)
	}
	if err := h.env.Lock(); err != nil {
		t.Fatal(err)
	}
	proxy := testnet.NewProxy(t)
	s := h.set.Get()
	s.Proxy = settings.Proxy{Mode: settings.ProxyCustom, URL: proxy.URL, Username: "me"}
	if _, err := h.set.Set(s); err != nil {
		t.Fatal(err)
	}
	res, err := h.req.Send(context.Background(), "s1", model.Request{URL: "http://example.invalid/"}, "")
	if err != nil {
		t.Fatal(err)
	}
	if res.Error == nil || res.Error.Kind != httpexec.KindProxy || !res.SecretsLocked {
		t.Fatalf("result %+v", res.Error)
	}
}

func TestRequestSettingsSaveAndSend(t *testing.T) {
	h := newHarness(t)
	h.openWorkspace(t)
	col, err := h.ws.CreateCollection("API")
	if err != nil {
		t.Fatal(err)
	}
	bad := -5
	if _, err := h.req.SaveAs(col.ID, "R", model.Request{Settings: model.RequestSettings{TimeoutMs: &bad}}); err == nil ||
		!strings.Contains(err.Error(), "Settings tab") {
		t.Fatalf("invalid settings saved: %v", err)
	}
	follow := false
	r, err := h.req.SaveAs(col.ID, "R", model.Request{Method: "GET", Settings: model.RequestSettings{FollowRedirects: &follow}})
	if err != nil {
		t.Fatal(err)
	}
	r.Settings.TimeoutMs = &bad
	if _, err := h.req.Save(r); err == nil {
		t.Fatal("invalid settings saved")
	}
	srv := httptest.NewServer(http.RedirectHandler("/elsewhere", http.StatusFound))
	defer srv.Close()
	r.Settings.TimeoutMs = nil
	r.URL = srv.URL
	res, err := h.req.Send(context.Background(), "s", r, "")
	if err != nil || res.Response == nil || res.Response.StatusCode != http.StatusFound {
		t.Fatalf("redirect followed although the request says not to: %+v %v", res, err)
	}
}

func TestCookieService(t *testing.T) {
	h := newHarness(t)
	svc := NewCookieService(h.core)
	if got := svc.List(); got == nil || len(got) != 0 {
		t.Fatalf("list %v", got)
	}
	future := time.Now().Add(time.Hour).UnixMilli()
	added, err := svc.Add(cookies.Cookie{Name: "a", Value: "1", Domain: "example.com", ExpiresAt: future})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := svc.Add(cookies.Cookie{Name: "", Domain: "example.com"}); err == nil || err.Error() != "Enter a name." {
		t.Fatalf("validation message %v", err)
	}
	upd, err := svc.Update(added.Ref(), cookies.Cookie{Name: "b", Value: "2", Domain: "example.com", ExpiresAt: future})
	if err != nil || upd.Name != "b" {
		t.Fatalf("update %+v %v", upd, err)
	}
	if _, err := svc.Update(added.Ref(), upd); err == nil || !strings.Contains(err.Error(), "no longer exists") {
		t.Fatalf("update of a gone cookie: %v", err)
	}
	if _, err := svc.Add(cookies.Cookie{Name: "c", Domain: "other.example"}); err != nil {
		t.Fatal(err)
	}
	if n := svc.ClearDomain("example.com"); n != 1 {
		t.Fatalf("cleared %d", n)
	}
	svc.Delete(cookies.Ref{Domain: "other.example", Path: "/", Name: "c"})
	svc.Delete(cookies.Ref{Domain: "other.example", Path: "/", Name: "c"})
	if _, err := svc.Add(cookies.Cookie{Name: "d", Domain: "x.example"}); err != nil {
		t.Fatal(err)
	}
	svc.ClearAll()
	if len(svc.List()) != 0 {
		t.Fatal("not cleared")
	}
	if cookieError(errors.New("other")) == nil {
		t.Fatal("other errors pass through")
	}
	if got := cookieError(cookies.ErrInvalid); got.Error() != "Check the cookie." {
		t.Fatalf("bare invalid: %v", got)
	}
}

func TestCookiesFollowTheWorkspace(t *testing.T) {
	h := newHarness(t)
	svc := NewCookieService(h.core)
	future := time.Now().Add(time.Hour).UnixMilli()
	if _, err := svc.Add(cookies.Cookie{Name: "none", Value: "1", Domain: "x.example", ExpiresAt: future}); err != nil {
		t.Fatal(err)
	}
	h.openWorkspace(t)
	if len(svc.List()) != 0 {
		t.Fatal("cookies of no workspace leaked into a workspace")
	}
	if _, err := svc.Add(cookies.Cookie{Name: "ws", Value: "1", Domain: "x.example", ExpiresAt: future}); err != nil {
		t.Fatal(err)
	}
	h.ws.Close()
	if got := svc.List(); len(got) != 1 || got[0].Name != "none" {
		t.Fatalf("after close %+v", got)
	}
}
