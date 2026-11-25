// Package settings defines the user-editable app settings, their defaults and
// validation, and how they map onto the HTTP executor.
package settings

import (
	"fmt"
	"strings"
	"time"

	"pakpos/internal/core/httpexec"
	"pakpos/internal/core/model"
)

// Theme is the UI colour scheme.
type Theme string

const (
	ThemeLight  Theme = "light"
	ThemeDark   Theme = "dark"
	ThemeSystem Theme = "system"
)

// Layout places the response below ("vertical") or beside ("horizontal") the request.
type Layout string

const (
	LayoutVertical   Layout = "vertical"
	LayoutHorizontal Layout = "horizontal"
)

// Limits for numeric settings. Requests' own settings share the timeout
// and redirect limits (httpexec.ValidateRequestSettings).
const (
	MaxTimeoutMs     = httpexec.MaxTimeoutMs // 10 minutes
	MaxRedirectsCap  = httpexec.MaxRedirectsCap
	MaxHistoryRetain = 100_000
	MaxClientCerts   = 100
	// Script timeouts (pre-request and test scripts, per script run).
	DefaultScriptTimeoutMs = 5_000
	MinScriptTimeoutMs     = 1_000
	MaxScriptTimeoutMs     = 60_000
)

// ProxyMode says how requests reach the network.
type ProxyMode string

const (
	// ProxySystem uses the HTTP_PROXY, HTTPS_PROXY and NO_PROXY
	// environment variables.
	ProxySystem ProxyMode = "system"
	ProxyNone   ProxyMode = "none"
	ProxyCustom ProxyMode = "custom"
)

// Proxy is the app's proxy setting. The password is never here: it lives
// in the secret store (service.ProxySecretKey).
type Proxy struct {
	Mode ProxyMode `json:"mode"`
	// URL of a custom proxy: http://, https:// or socks5://host:port.
	URL      string `json:"url"`
	Username string `json:"username"`
	// Bypass lists the hosts reached directly, as typed (separated by commas
	// or new lines): names, *.wildcards, .suffixes, IPs or CIDR ranges.
	Bypass string `json:"bypass"`
}

// ClientCert is a client certificate sent to hosts matching Host: a PEM
// certificate and key, or a PKCS#12 file whose passphrase lives in the
// secret store under the entry's ID.
type ClientCert struct {
	ID       string `json:"id"`
	Host     string `json:"host"`
	CertFile string `json:"certFile"`
	KeyFile  string `json:"keyFile"`
	PFXFile  string `json:"pfxFile"`
}

// Settings are persisted as one JSON document.
type Settings struct {
	Theme Theme `json:"theme"`
	// TimeoutMs for a whole request; 0 means no timeout.
	TimeoutMs       int  `json:"timeoutMs"`
	FollowRedirects bool `json:"followRedirects"`
	MaxRedirects    int  `json:"maxRedirects"`
	VerifyTLS       bool `json:"verifyTls"`
	// HistoryRetention is how many history entries to keep per workspace
	// (entries sent without a workspace count as one more); 0 keeps all.
	HistoryRetention int    `json:"historyRetention"`
	Layout           Layout `json:"layout"`
	// CheckForUpdates lets the app look for a new release at startup and
	// once a day. Installing always waits for the user.
	CheckForUpdates bool  `json:"checkForUpdates"`
	Proxy           Proxy `json:"proxy"`
	// CAFile is a PEM bundle trusted in addition to the system roots.
	CAFile string `json:"caFile"`
	// ClientCerts are tried in order; the first whose host matches is sent.
	ClientCerts []ClientCert `json:"clientCerts"`
	// ScriptTimeoutMs stops a pre-request or test script that runs longer.
	ScriptTimeoutMs int `json:"scriptTimeoutMs"`
	// ScriptRequests lets scripts send requests with pm.sendRequest (on by
	// default, as in Postman; settings saved before it existed keep it on).
	ScriptRequests bool `json:"scriptRequests"`
	// CloudflaredPath is the cloudflared webhook tunnels use; "" finds it
	// (Pakpos's downloaded copy, then PATH).
	CloudflaredPath string `json:"cloudflaredPath"`
}

// Defaults returns the settings of a fresh install.
func Defaults() Settings {
	return Settings{
		Theme:            ThemeSystem,
		TimeoutMs:        30_000,
		FollowRedirects:  true,
		MaxRedirects:     10,
		VerifyTLS:        true,
		HistoryRetention: 500,
		Layout:           LayoutVertical,
		CheckForUpdates:  true,
		// Go's default before network settings existed.
		Proxy:           Proxy{Mode: ProxySystem},
		ClientCerts:     []ClientCert{},
		ScriptTimeoutMs: DefaultScriptTimeoutMs,
		ScriptRequests:  true,
	}
}

// ScriptTimeout is how long one script may run.
func (s Settings) ScriptTimeout() time.Duration {
	return time.Duration(s.ScriptTimeoutMs) * time.Millisecond
}

// Normalize trims paths and patterns and gives new client certificates an
// ID, so Validate and the secret keys can rely on them. A missing script
// timeout (settings saved before it existed) gets the default.
func (s Settings) Normalize() Settings {
	if s.ScriptTimeoutMs == 0 {
		s.ScriptTimeoutMs = DefaultScriptTimeoutMs
	}
	s.Proxy.URL = strings.TrimSpace(s.Proxy.URL)
	s.Proxy.Username = strings.TrimSpace(s.Proxy.Username)
	s.CAFile = strings.TrimSpace(s.CAFile)
	s.CloudflaredPath = strings.TrimSpace(s.CloudflaredPath)
	certs := make([]ClientCert, 0, len(s.ClientCerts))
	for _, c := range s.ClientCerts {
		c.Host = strings.ToLower(strings.TrimSpace(c.Host))
		c.CertFile, c.KeyFile, c.PFXFile = strings.TrimSpace(c.CertFile), strings.TrimSpace(c.KeyFile), strings.TrimSpace(c.PFXFile)
		if strings.TrimSpace(c.ID) == "" {
			c.ID = model.NewID()
		}
		certs = append(certs, c)
	}
	s.ClientCerts = certs
	return s
}

// Validate reports the first invalid field with a user-facing message.
func (s Settings) Validate() error {
	switch s.Theme {
	case ThemeLight, ThemeDark, ThemeSystem:
	default:
		return fmt.Errorf("theme must be light, dark or system (got %q)", s.Theme)
	}
	switch s.Layout {
	case LayoutVertical, LayoutHorizontal:
	default:
		return fmt.Errorf("layout must be vertical or horizontal (got %q)", s.Layout)
	}
	if s.TimeoutMs < 0 || s.TimeoutMs > MaxTimeoutMs {
		return fmt.Errorf("timeout must be between 0 and %d ms", MaxTimeoutMs)
	}
	if s.MaxRedirects < 1 || s.MaxRedirects > MaxRedirectsCap {
		return fmt.Errorf("max redirects must be between 1 and %d", MaxRedirectsCap)
	}
	if s.HistoryRetention < 0 || s.HistoryRetention > MaxHistoryRetain {
		return fmt.Errorf("history retention must be between 0 and %d", MaxHistoryRetain)
	}
	if s.ScriptTimeoutMs < MinScriptTimeoutMs || s.ScriptTimeoutMs > MaxScriptTimeoutMs {
		return fmt.Errorf("script timeout must be between %d and %d seconds", MinScriptTimeoutMs/1000, MaxScriptTimeoutMs/1000)
	}
	return s.validateNetwork()
}

func (s Settings) validateNetwork() error {
	switch s.Proxy.Mode {
	case ProxyNone, ProxySystem:
	case ProxyCustom:
		if _, err := httpexec.ParseProxyURL(s.Proxy.URL); err != nil {
			return err
		}
	default:
		return fmt.Errorf("proxy must be none, system or custom (got %q)", s.Proxy.Mode)
	}
	for _, p := range httpexec.ParseHostList(s.Proxy.Bypass) {
		if err := httpexec.CheckHostPattern(p); err != nil {
			return fmt.Errorf("proxy bypass list: %w", err)
		}
	}
	if len(s.ClientCerts) > MaxClientCerts {
		return fmt.Errorf("at most %d client certificates can be set", MaxClientCerts)
	}
	ids := map[string]bool{}
	for i, c := range s.ClientCerts {
		n := i + 1
		switch {
		case c.ID == "" || ids[c.ID]:
			return fmt.Errorf("client certificate %d needs a unique id", n)
		case c.Host == "":
			return fmt.Errorf("client certificate %d: enter the host it is for, e.g. api.example.com or *.example.com", n)
		case c.PFXFile != "" && (c.CertFile != "" || c.KeyFile != ""):
			return fmt.Errorf("client certificate %d: choose either a PKCS#12 file or a PEM certificate and key, not both", n)
		case c.PFXFile == "" && (c.CertFile == "" || c.KeyFile == ""):
			return fmt.Errorf("client certificate %d: choose a PEM certificate and its key, or a PKCS#12 file", n)
		}
		if err := httpexec.CheckHostPattern(c.Host); err != nil {
			return fmt.Errorf("client certificate %d: %w", n, err)
		}
		ids[c.ID] = true
	}
	return nil
}

// Network maps the network settings onto the executor's (without a
// password lookup; the service adds it).
func (s Settings) Network() httpexec.Network {
	n := httpexec.Network{
		Proxy: httpexec.Proxy{
			Mode: httpexec.ProxyMode(s.Proxy.Mode), URL: s.Proxy.URL, Username: s.Proxy.Username,
			Bypass: httpexec.ParseHostList(s.Proxy.Bypass),
		},
		CAFile:      s.CAFile,
		ClientCerts: []httpexec.ClientCert{},
	}
	for _, c := range s.ClientCerts {
		n.ClientCerts = append(n.ClientCerts, httpexec.ClientCert(c))
	}
	return n
}

// Executor maps the settings onto base executor settings.
func (s Settings) Executor(base httpexec.Settings) httpexec.Settings {
	base.Timeout = time.Duration(s.TimeoutMs) * time.Millisecond
	base.FollowRedirects = s.FollowRedirects
	base.MaxRedirects = s.MaxRedirects
	base.InsecureSkipVerify = !s.VerifyTLS
	secret := base.Network.Secret
	base.Network = s.Network()
	base.Network.Secret = secret
	return base
}
