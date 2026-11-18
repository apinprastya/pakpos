package testnet

import (
	"crypto/tls"
	"io"
	"net/http"
	"net/url"
	"strings"
	"testing"

	"software.sslmate.com/src/go-pkcs12"
)

func TestProxyForwardsAndTunnels(t *testing.T) {
	ca := NewCA(t, "Test CA")
	clients := NewCA(t, "Client CA")
	client := clients.Client(t, "me")
	target := TLSServer(t, ca, clients, http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		_, _ = io.WriteString(w, "secure")
	}))
	proxy := NewProxy(t)
	pu, _ := url.Parse(proxy.URL)
	tr := &http.Transport{
		Proxy:           http.ProxyURL(pu),
		TLSClientConfig: &tls.Config{RootCAs: ca.Pool(), Certificates: []tls.Certificate{client.TLS}},
	}
	defer tr.CloseIdleConnections()
	c := &http.Client{Transport: tr}

	resp, err := c.Get(target.URL)
	if err != nil {
		t.Fatal(err)
	}
	body, _ := io.ReadAll(resp.Body)
	_ = resp.Body.Close()
	if string(body) != "secure" {
		t.Fatalf("body %q", body)
	}

	// A plain request goes through the forwarding path.
	httpTarget := NewProxy(t) // any plain server works as the target
	req, _ := http.NewRequest(http.MethodGet, httpTarget.URL+"/x", nil)
	req.Header.Set("Proxy-Authorization", "Basic abc")
	resp, err = c.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	_ = resp.Body.Close()
	if resp.Header.Get("Via") != "testnet-proxy" {
		t.Fatalf("headers %v", resp.Header)
	}
	seen := proxy.Seen()
	if len(seen) != 2 || !strings.HasPrefix(seen[0], "CONNECT ") || !strings.HasPrefix(seen[1], "GET http://") {
		t.Fatalf("seen %v", seen)
	}
	if auth := proxy.Auth(); auth[1] != "Basic abc" {
		t.Fatalf("auth %v", auth)
	}

	// A CONNECT to nothing fails with 502.
	tr2 := &http.Transport{Proxy: http.ProxyURL(pu)}
	defer tr2.CloseIdleConnections()
	if _, err := (&http.Client{Transport: tr2}).Get("https://127.0.0.1:1/"); err == nil {
		t.Fatal("tunnel to a closed port succeeded")
	}
	resp, err = (&http.Client{Transport: tr2}).Get("http://127.0.0.1:1/")
	if err != nil || resp.StatusCode != http.StatusBadGateway {
		t.Fatalf("forward to a closed port: %v %v", resp, err)
	}
	_ = resp.Body.Close()
}

func TestPKCS12AndFiles(t *testing.T) {
	ca := NewCA(t, "CA")
	c := ca.Client(t, "me")
	data := c.PKCS12(t, ca, "pw")
	if _, _, _, err := pkcs12.DecodeChain(data, "pw"); err != nil {
		t.Fatal(err)
	}
	p := WriteFile(t, t.TempDir(), "c.pem", c.CertPEM)
	if !strings.HasSuffix(p, "c.pem") {
		t.Fatal(p)
	}
}
