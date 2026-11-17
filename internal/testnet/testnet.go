// Package testnet helps network tests: a throwaway certificate authority
// that issues server and client certificates, and a forwarding HTTP proxy
// (plain requests and CONNECT tunnels). It is only imported by tests.
package testnet

import (
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/tls"
	"crypto/x509"
	"crypto/x509/pkix"
	"encoding/pem"
	"io"
	"math/big"
	"net"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"sync"
	"testing"
	"time"

	"software.sslmate.com/src/go-pkcs12"
)

// Authority is a test CA.
type Authority struct {
	Cert *x509.Certificate
	Key  *ecdsa.PrivateKey
	// PEM is the CA certificate.
	PEM []byte
}

var serial int64 = 1
var serialMu sync.Mutex

func nextSerial() *big.Int {
	serialMu.Lock()
	defer serialMu.Unlock()
	serial++
	return big.NewInt(serial)
}

// NewCA creates a self-signed CA.
func NewCA(t testing.TB, name string) *Authority {
	t.Helper()
	key, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	tmpl := &x509.Certificate{
		SerialNumber:          nextSerial(),
		Subject:               pkix.Name{CommonName: name},
		NotBefore:             time.Now().Add(-time.Hour),
		NotAfter:              time.Now().Add(24 * time.Hour),
		IsCA:                  true,
		BasicConstraintsValid: true,
		KeyUsage:              x509.KeyUsageCertSign | x509.KeyUsageDigitalSignature,
	}
	der, err := x509.CreateCertificate(rand.Reader, tmpl, tmpl, &key.PublicKey, key)
	if err != nil {
		t.Fatal(err)
	}
	cert, err := x509.ParseCertificate(der)
	if err != nil {
		t.Fatal(err)
	}
	return &Authority{Cert: cert, Key: key, PEM: pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: der})}
}

// Pool holds only this CA.
func (a *Authority) Pool() *x509.CertPool {
	p := x509.NewCertPool()
	p.AddCert(a.Cert)
	return p
}

// Issued is a certificate signed by an Authority.
type Issued struct {
	TLS     tls.Certificate
	CertPEM []byte
	KeyPEM  []byte
}

// Server issues a server certificate for 127.0.0.1, ::1 and localhost.
func (a *Authority) Server(t testing.TB) Issued {
	return a.issue(t, "localhost", x509.ExtKeyUsageServerAuth)
}

// Client issues a client certificate.
func (a *Authority) Client(t testing.TB, name string) Issued {
	return a.issue(t, name, x509.ExtKeyUsageClientAuth)
}

func (a *Authority) issue(t testing.TB, cn string, usage x509.ExtKeyUsage) Issued {
	t.Helper()
	key, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	tmpl := &x509.Certificate{
		SerialNumber: nextSerial(),
		Subject:      pkix.Name{CommonName: cn},
		NotBefore:    time.Now().Add(-time.Hour),
		NotAfter:     time.Now().Add(24 * time.Hour),
		KeyUsage:     x509.KeyUsageDigitalSignature,
		ExtKeyUsage:  []x509.ExtKeyUsage{usage},
	}
	if usage == x509.ExtKeyUsageServerAuth {
		tmpl.DNSNames = []string{"localhost"}
		tmpl.IPAddresses = []net.IP{net.IPv4(127, 0, 0, 1), net.IPv6loopback}
	}
	der, err := x509.CreateCertificate(rand.Reader, tmpl, a.Cert, &key.PublicKey, a.Key)
	if err != nil {
		t.Fatal(err)
	}
	keyDER, err := x509.MarshalPKCS8PrivateKey(key)
	if err != nil {
		t.Fatal(err)
	}
	leaf, _ := x509.ParseCertificate(der)
	return Issued{
		TLS:     tls.Certificate{Certificate: [][]byte{der}, PrivateKey: key, Leaf: leaf},
		CertPEM: pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: der}),
		KeyPEM:  pem.EncodeToMemory(&pem.Block{Type: "PRIVATE KEY", Bytes: keyDER}),
	}
}

// PKCS12 encodes the certificate, its key and the CA as a PKCS#12 file.
func (i Issued) PKCS12(t testing.TB, ca *Authority, password string) []byte {
	t.Helper()
	data, err := pkcs12.Modern.Encode(i.TLS.PrivateKey, i.TLS.Leaf, []*x509.Certificate{ca.Cert}, password)
	if err != nil {
		t.Fatal(err)
	}
	return data
}

// WriteFile writes data to name in dir and returns the path.
func WriteFile(t testing.TB, dir, name string, data []byte) string {
	t.Helper()
	p := filepath.Join(dir, name)
	if err := os.WriteFile(p, data, 0o600); err != nil {
		t.Fatal(err)
	}
	return p
}

// TLSServer starts an HTTPS server with a certificate from ca. With
// clients set, it requires a client certificate signed by that CA.
func TLSServer(t testing.TB, ca *Authority, clients *Authority, h http.Handler) *httptest.Server {
	t.Helper()
	srv := httptest.NewUnstartedServer(h)
	srv.TLS = &tls.Config{Certificates: []tls.Certificate{ca.Server(t).TLS}, MinVersion: tls.VersionTLS12}
	if clients != nil {
		srv.TLS.ClientAuth = tls.RequireAndVerifyClientCert
		srv.TLS.ClientCAs = clients.Pool()
	}
	srv.StartTLS()
	t.Cleanup(srv.Close)
	return srv
}

// Proxy is a forwarding HTTP proxy for tests.
type Proxy struct {
	*httptest.Server
	mu   sync.Mutex
	seen []string
	auth []string
}

// NewProxy starts a proxy that forwards plain requests and tunnels CONNECT.
func NewProxy(t testing.TB) *Proxy {
	t.Helper()
	p := &Proxy{}
	p.Server = httptest.NewServer(http.HandlerFunc(p.serve))
	t.Cleanup(p.Close)
	return p
}

// Seen lists what went through: "CONNECT host:port" or "GET http://...".
func (p *Proxy) Seen() []string {
	p.mu.Lock()
	defer p.mu.Unlock()
	return append([]string{}, p.seen...)
}

// Auth lists the Proxy-Authorization headers received, in order.
func (p *Proxy) Auth() []string {
	p.mu.Lock()
	defer p.mu.Unlock()
	return append([]string{}, p.auth...)
}

func (p *Proxy) serve(w http.ResponseWriter, r *http.Request) {
	p.mu.Lock()
	target := r.URL.String()
	if r.Method == http.MethodConnect {
		target = r.Host
	}
	p.seen = append(p.seen, r.Method+" "+target)
	p.auth = append(p.auth, r.Header.Get("Proxy-Authorization"))
	p.mu.Unlock()

	if r.Method == http.MethodConnect {
		upstream, err := net.Dial("tcp", r.Host) //nolint:gosec // a test proxy dials what tests ask for
		if err != nil {
			http.Error(w, err.Error(), http.StatusBadGateway)
			return
		}
		hj, ok := w.(http.Hijacker)
		if !ok {
			_ = upstream.Close()
			http.Error(w, "no hijacking", http.StatusInternalServerError)
			return
		}
		w.WriteHeader(http.StatusOK)
		conn, buf, err := hj.Hijack()
		if err != nil {
			_ = upstream.Close()
			return
		}
		go func() {
			_, _ = io.Copy(upstream, buf)
			_ = upstream.Close()
		}()
		_, _ = io.Copy(conn, upstream)
		_ = conn.Close()
		return
	}
	out := r.Clone(r.Context())
	out.RequestURI = ""
	out.Header.Del("Proxy-Authorization")
	resp, err := (&http.Transport{}).RoundTrip(out)
	if err != nil {
		http.Error(w, err.Error(), http.StatusBadGateway)
		return
	}
	defer resp.Body.Close()
	for k, vs := range resp.Header {
		for _, v := range vs {
			w.Header().Add(k, v)
		}
	}
	w.Header().Set("Via", "testnet-proxy")
	w.WriteHeader(resp.StatusCode)
	_, _ = io.Copy(w, resp.Body)
}
