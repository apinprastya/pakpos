package httpexec

import (
	"crypto/tls"
	"crypto/x509"
	"encoding/json"
	"errors"
	"fmt"
	"io/fs"
	"net"
	"net/http"
	"net/url"
	"os"
	"strings"
	"sync"

	"software.sslmate.com/src/go-pkcs12"
)

// ProxyMode says how requests reach the network.
type ProxyMode string

const (
	// ProxySystem uses the HTTP_PROXY, HTTPS_PROXY and NO_PROXY environment
	// variables (Go reads no other OS proxy settings). The zero value means
	// the same.
	ProxySystem ProxyMode = "system"
	// ProxyNone connects directly.
	ProxyNone ProxyMode = "none"
	// ProxyCustom sends everything through Proxy.URL.
	ProxyCustom ProxyMode = "custom"
)

// Proxy is the proxy configuration.
type Proxy struct {
	Mode ProxyMode
	// URL of a custom proxy: http://, https:// or socks5://host:port.
	URL string
	// Username for a custom proxy; the password comes from Network.Secret
	// (SecretProxy).
	Username string
	// Bypass lists hosts reached directly (see MatchHost), in every mode.
	Bypass []string
}

// ClientCert is a client certificate sent to hosts matching Host (see
// MatchHost): a PEM certificate and key, or a PKCS#12 file whose
// passphrase comes from Network.Secret (CertSecret(ID)).
type ClientCert struct {
	ID       string
	Host     string
	CertFile string
	KeyFile  string
	PFXFile  string
}

// Network is the app-wide network configuration: proxy, extra CA
// certificates and client certificates.
type Network struct {
	Proxy Proxy
	// CAFile is a PEM bundle trusted in addition to the system roots.
	CAFile      string
	ClientCerts []ClientCert
	// Secret returns a stored password by name (SecretProxy, CertSecret),
	// or "" when none is stored. Nil means no passwords are stored.
	Secret func(name string) (string, error) `json:"-"`
}

// SecretProxy names the proxy password for Network.Secret.
const SecretProxy = "proxy"

// CertSecret names the PKCS#12 passphrase of a client certificate.
func CertSecret(id string) string { return "cert/" + id }

func (n Network) secret(name string) (string, error) {
	if n.Secret == nil {
		return "", nil
	}
	return n.Secret(name)
}

// key identifies the configuration (not the stored passwords; Transports.Reset
// drops transports when those change).
func (n Network) key() string {
	b, _ := json.Marshal(n) // plain strings and slices: never fails
	return string(b)
}

// certFor returns the first client certificate whose host pattern matches.
func (n Network) certFor(host string) *ClientCert {
	for i := range n.ClientCerts {
		if MatchHost(n.ClientCerts[i].Host, host) {
			return &n.ClientCerts[i]
		}
	}
	return nil
}

// Check loads the CA bundle and the PEM client certificates, and checks
// that PKCS#12 files can be read (their passphrase may be locked away, so
// they are decoded at send time). Errors are *Error with a user message.
func (n Network) Check() error {
	if n.CAFile != "" {
		if _, err := LoadCAFile(n.CAFile); err != nil {
			return err
		}
	}
	for _, c := range n.ClientCerts {
		if c.PFXFile != "" {
			if _, err := os.ReadFile(c.PFXFile); err != nil {
				return certError(c, err)
			}
			continue
		}
		if _, err := n.loadClientCert(c); err != nil {
			return err
		}
	}
	if n.Proxy.Mode == ProxyCustom {
		if _, err := ParseProxyURL(n.Proxy.URL); err != nil {
			return newError(KindProxy, err, "%s", err.Error())
		}
	}
	return nil
}

// ParseProxyURL checks a custom proxy URL. Credentials don't belong in it:
// the user name and password have their own fields.
func ParseProxyURL(raw string) (*url.URL, error) {
	raw = strings.TrimSpace(raw)
	if raw == "" {
		return nil, errors.New("enter the proxy URL, e.g. http://proxy.example.com:8080")
	}
	u, err := url.Parse(raw)
	if err != nil {
		return nil, fmt.Errorf("the proxy URL %q isn't valid", raw)
	}
	switch strings.ToLower(u.Scheme) {
	case "http", "https", "socks5", "socks5h":
	default:
		return nil, fmt.Errorf("the proxy URL must start with http://, https:// or socks5:// (got %q)", raw)
	}
	if u.Hostname() == "" {
		return nil, fmt.Errorf("the proxy URL %q has no host", raw)
	}
	if u.User != nil {
		return nil, errors.New("put the proxy user name and password in their own fields, not in the URL")
	}
	return &url.URL{Scheme: strings.ToLower(u.Scheme), Host: u.Host}, nil
}

// ParseHostList splits a list of host patterns separated by commas,
// whitespace or new lines, lower-cased and without empty entries.
func ParseHostList(text string) []string {
	fields := strings.FieldsFunc(text, func(r rune) bool {
		return r == ',' || r == ';' || r == ' ' || r == '\t' || r == '\n' || r == '\r'
	})
	out := []string{}
	for _, f := range fields {
		out = append(out, strings.ToLower(strings.TrimSuffix(f, ".")))
	}
	return out
}

// CheckHostPattern reports a pattern MatchHost can't use.
func CheckHostPattern(p string) error {
	switch {
	case p == "":
		return errors.New("a host pattern is empty")
	case strings.Contains(p, "/"):
		if _, _, err := net.ParseCIDR(p); err != nil {
			return fmt.Errorf("%q isn't a valid IP range (e.g. 10.0.0.0/8)", p)
		}
	case strings.ContainsAny(p, " \t:@?#"):
		if net.ParseIP(p) == nil {
			return fmt.Errorf("%q isn't a host name, wildcard or IP address", p)
		}
	case strings.Count(p, "*") > 1 || (strings.Contains(p, "*") && p != "*" && !strings.HasPrefix(p, "*.")):
		return fmt.Errorf("%q: a wildcard can only start the pattern, as in *.example.com", p)
	}
	return nil
}

// MatchHost reports whether host (without port) matches pattern:
//
//   - "*" matches every host;
//   - "*.example.com" matches the subdomains of example.com;
//   - ".example.com" matches example.com and its subdomains;
//   - "10.0.0.0/8" matches IP addresses in the range;
//   - anything else matches the host exactly, ignoring case.
func MatchHost(pattern, host string) bool {
	pattern = strings.ToLower(strings.TrimSuffix(strings.TrimSpace(pattern), "."))
	host = strings.ToLower(strings.TrimSuffix(host, "."))
	switch {
	case pattern == "" || host == "":
		return false
	case pattern == "*":
		return true
	case strings.HasPrefix(pattern, "*."):
		return strings.HasSuffix(host, pattern[1:])
	case strings.HasPrefix(pattern, "."):
		return host == pattern[1:] || strings.HasSuffix(host, pattern)
	case strings.Contains(pattern, "/"):
		_, cidr, err := net.ParseCIDR(pattern)
		ip := net.ParseIP(host)
		return err == nil && ip != nil && cidr.Contains(ip)
	default:
		return pattern == host
	}
}

func bypassed(patterns []string, u *url.URL) bool {
	for _, p := range patterns {
		if MatchHost(p, u.Hostname()) {
			return true
		}
	}
	return false
}

type proxyFunc = func(*http.Request) (*url.URL, error)

func (n Network) proxyFunc() (proxyFunc, error) {
	bypass := n.Proxy.Bypass
	switch n.Proxy.Mode {
	case ProxyNone:
		return nil, nil
	case ProxyCustom:
		u, err := ParseProxyURL(n.Proxy.URL)
		if err != nil {
			return nil, newError(KindProxy, err, "The proxy settings aren't valid: %s", err.Error())
		}
		if n.Proxy.Username != "" {
			pw, err := n.secret(SecretProxy)
			if err != nil {
				return nil, newError(KindProxy, err, "The proxy password couldn't be read from the secret store")
			}
			u.User = url.UserPassword(n.Proxy.Username, pw)
		}
		return func(r *http.Request) (*url.URL, error) {
			if bypassed(bypass, r.URL) {
				return nil, nil
			}
			return u, nil
		}, nil
	default:
		// The environment is read once per process.
		return func(r *http.Request) (*url.URL, error) {
			if bypassed(bypass, r.URL) {
				return nil, nil
			}
			return http.ProxyFromEnvironment(r)
		}, nil
	}
}

// LoadCAFile reads a PEM bundle and returns the system roots plus its
// certificates. Errors are *Error (KindTLS) with a user message.
func LoadCAFile(path string) (*x509.CertPool, error) {
	data, err := os.ReadFile(path)
	if err != nil {
		return nil, newError(KindTLS, err, "The CA certificate file %s couldn't be read (%s). Check the path in Settings > Network", path, fileProblem(err))
	}
	pool, err := x509.SystemCertPool()
	if err != nil || pool == nil {
		pool = x509.NewCertPool()
	}
	if !pool.AppendCertsFromPEM(data) {
		return nil, newError(KindTLS, nil, "The CA certificate file %s holds no PEM certificates. Choose a PEM (.pem or .crt) bundle", path)
	}
	return pool, nil
}

func (n Network) loadClientCert(c ClientCert) (tls.Certificate, error) {
	if c.PFXFile != "" {
		data, err := os.ReadFile(c.PFXFile)
		if err != nil {
			return tls.Certificate{}, certError(c, err)
		}
		pass, err := n.secret(CertSecret(c.ID))
		if err != nil {
			return tls.Certificate{}, newError(KindTLS, err, "The passphrase of the client certificate for %s couldn't be read from the secret store", c.Host)
		}
		key, leaf, chain, err := pkcs12.DecodeChain(data, pass)
		if errors.Is(err, pkcs12.ErrIncorrectPassword) {
			return tls.Certificate{}, newError(KindTLS, err, "The passphrase of the client certificate for %s is wrong. Set it in Settings > Network", c.Host)
		}
		if err != nil {
			return tls.Certificate{}, newError(KindTLS, err, "The client certificate file %s isn't a valid PKCS#12 file", c.PFXFile)
		}
		cert := tls.Certificate{Certificate: [][]byte{leaf.Raw}, PrivateKey: key, Leaf: leaf}
		for _, ca := range chain {
			cert.Certificate = append(cert.Certificate, ca.Raw)
		}
		return cert, nil
	}
	cert, err := tls.LoadX509KeyPair(c.CertFile, c.KeyFile)
	if err != nil {
		var pathErr *fs.PathError
		if errors.As(err, &pathErr) {
			return tls.Certificate{}, newError(KindTLS, err, "The client certificate file %s couldn't be read (%s). Check the path in Settings > Network", pathErr.Path, fileProblem(err))
		}
		return tls.Certificate{}, newError(KindTLS, err, "The client certificate for %s couldn't be loaded: %s. Use an unencrypted PEM certificate and key, or a PKCS#12 file", c.Host, err.Error())
	}
	return cert, nil
}

func certError(c ClientCert, err error) error {
	return newError(KindTLS, err, "The client certificate file %s couldn't be read (%s). Check the path in Settings > Network", c.PFXFile, fileProblem(err))
}

// fileProblem says briefly why a file couldn't be read.
func fileProblem(err error) string {
	switch {
	case errors.Is(err, fs.ErrNotExist):
		return "it doesn't exist"
	case errors.Is(err, fs.ErrPermission):
		return "permission denied"
	default:
		var pathErr *fs.PathError
		if errors.As(err, &pathErr) {
			return pathErr.Err.Error()
		}
		return err.Error()
	}
}

// Transports caches one *http.Transport per network configuration, TLS
// verification choice and client certificate, so a request that turns
// verification off, or one that needs a client certificate, doesn't drop
// the pooled connections of other sends. Executors share it (the service
// keeps one for the app's lifetime). It is safe for concurrent use.
type Transports struct {
	mu sync.Mutex
	m  map[transportKey]*http.Transport
}

type transportKey struct {
	network  string
	insecure bool
	cert     string
}

// NewTransports returns an empty cache.
func NewTransports() *Transports {
	return &Transports{m: map[transportKey]*http.Transport{}}
}

// get returns the transport for n, building it on first use. Transports of
// another network configuration are stale: they are closed and dropped.
func (t *Transports) get(n Network, insecure bool, cert *ClientCert) (*http.Transport, error) {
	k := transportKey{network: n.key(), insecure: insecure}
	if cert != nil {
		k.cert = cert.ID + "\x00" + cert.Host
	}
	t.mu.Lock()
	defer t.mu.Unlock()
	if tr, ok := t.m[k]; ok {
		return tr, nil
	}
	for old, tr := range t.m {
		if old.network != k.network {
			tr.CloseIdleConnections()
			delete(t.m, old)
		}
	}
	tr, err := n.buildTransport(insecure, cert)
	if err != nil {
		return nil, err
	}
	t.m[k] = tr
	return tr, nil
}

// Reset closes the idle connections of every cached transport and forgets
// them, so the next send builds new ones (after a stored proxy password or
// passphrase changed). Sends in flight finish on the transport they use.
func (t *Transports) Reset() {
	t.mu.Lock()
	defer t.mu.Unlock()
	for k, tr := range t.m {
		tr.CloseIdleConnections()
		delete(t.m, k)
	}
}

// Len is the number of cached transports.
func (t *Transports) Len() int {
	t.mu.Lock()
	defer t.mu.Unlock()
	return len(t.m)
}

func (n Network) buildTransport(insecure bool, cert *ClientCert) (*http.Transport, error) {
	proxy, err := n.proxyFunc()
	if err != nil {
		return nil, err
	}
	cfg := &tls.Config{InsecureSkipVerify: insecure} //nolint:gosec // user-controlled setting
	if n.CAFile != "" && !insecure {
		pool, err := LoadCAFile(n.CAFile)
		if err != nil {
			return nil, err
		}
		cfg.RootCAs = pool
	}
	if cert != nil {
		c, err := n.loadClientCert(*cert)
		if err != nil {
			return nil, err
		}
		cfg.Certificates = []tls.Certificate{c}
	}
	tr := http.DefaultTransport.(*http.Transport).Clone()
	tr.Proxy = proxy
	tr.TLSClientConfig = cfg
	return tr, nil
}

// routeTransport sends each round trip (the request and every redirect it
// follows) through the cached transport for that hop: the send's TLS
// verification and the client certificate of the hop's host.
type routeTransport struct{ e *Executor }

func (r routeTransport) RoundTrip(req *http.Request) (*http.Response, error) {
	o := optionsFrom(req.Context(), r.e.settings)
	n := r.e.settings.Network
	tr, err := r.e.settings.Transports.get(n, o.insecure, n.certFor(req.URL.Hostname()))
	if err != nil {
		if req.Body != nil {
			_ = req.Body.Close()
		}
		return nil, err
	}
	return tr.RoundTrip(req)
}
