// Package cookies is the app's cookie jar: an http.CookieJar (RFC 6265
// rules, the public suffix list) that can also be listed and edited by the
// cookie manager, and that writes persistent cookies through a Store so they
// survive a restart. Session cookies live only in memory.
//
// net/http/cookiejar can't list its cookies, so this is a jar of its own
// rather than a wrapper around it. It has no Wails dependency.
package cookies

import (
	"errors"
	"fmt"
	"net"
	"net/http"
	"net/url"
	"sort"
	"strings"
	"sync"
	"time"

	"golang.org/x/net/publicsuffix"
)

// Cookie is one stored cookie. Its identity is (Domain, Path, Name).
type Cookie struct {
	Name  string `json:"name"`
	Value string `json:"value"`
	// Domain without a leading dot, lower case.
	Domain string `json:"domain"`
	Path   string `json:"path"`
	// HostOnly cookies are sent to Domain only, not to its subdomains.
	HostOnly bool `json:"hostOnly"`
	Secure   bool `json:"secure"`
	HTTPOnly bool `json:"httpOnly"`
	// SameSite is "", "lax", "strict" or "none".
	SameSite string `json:"sameSite"`
	// ExpiresAt is Unix milliseconds; 0 marks a session cookie (memory only).
	ExpiresAt int64 `json:"expiresAt"`
	// CreatedAt (Unix milliseconds) orders cookies with equal paths.
	CreatedAt int64 `json:"createdAt"`
}

// Ref names a cookie.
type Ref struct {
	Domain string `json:"domain"`
	Path   string `json:"path"`
	Name   string `json:"name"`
}

// Ref returns the cookie's identity.
func (c Cookie) Ref() Ref { return Ref{Domain: c.Domain, Path: c.Path, Name: c.Name} }

// Persistent reports whether the cookie outlives the session.
func (c Cookie) Persistent() bool { return c.ExpiresAt != 0 }

// Store keeps the persistent cookies of one jar. Calls happen with the jar
// locked, in the order of the changes.
type Store interface {
	// LoadCookies returns the stored cookies that haven't expired at now
	// and deletes the expired ones.
	LoadCookies(now time.Time) ([]Cookie, error)
	// SaveCookie inserts or replaces a cookie (by Domain, Path, Name).
	SaveCookie(c Cookie) error
	// DeleteCookie removes one cookie; a missing one is not an error.
	DeleteCookie(r Ref) error
	// ClearCookies removes the cookies of domain, or all when domain is "".
	ClearCookies(domain string) error
}

// Errors from Add and Update. They carry a message for the user.
var (
	ErrInvalid  = errors.New("invalid cookie")
	ErrNotFound = errors.New("cookie not found")
)

// Jar is an http.CookieJar backed by a Store. It is safe for concurrent use.
type Jar struct {
	store Store
	now   func() time.Time
	// OnError reports a failed store write; the cookie still applies in
	// memory. May be nil.
	onError func(error)

	mu      sync.Mutex
	cookies map[Ref]*Cookie
	// seq keeps creation order stable within one millisecond.
	seq int64
}

// Options configure a Jar.
type Options struct {
	// Store keeps persistent cookies; nil keeps everything in memory.
	Store Store
	Now   func() time.Time
	// OnError reports store write failures (load failures are returned).
	OnError func(error)
}

// New loads the store's live cookies (pruning expired ones) into a jar.
// When loading fails the jar starts empty and the error is returned with it.
func New(o Options) (*Jar, error) {
	j := &Jar{store: o.Store, now: o.Now, onError: o.OnError, cookies: map[Ref]*Cookie{}}
	if j.now == nil {
		j.now = time.Now
	}
	if j.store == nil {
		return j, nil
	}
	loaded, err := j.store.LoadCookies(j.now())
	if err != nil {
		return j, fmt.Errorf("load cookies: %w", err)
	}
	for _, c := range loaded {
		c := c
		j.cookies[c.Ref()] = &c
	}
	return j, nil
}

func (j *Jar) report(err error) {
	if err != nil && j.onError != nil {
		j.onError(err)
	}
}

func (j *Jar) nowMs() int64 { return j.now().UnixMilli() }

// SetCookies implements http.CookieJar.
func (j *Jar) SetCookies(u *url.URL, cookies []*http.Cookie) {
	if u.Scheme != "http" && u.Scheme != "https" {
		return
	}
	host, err := canonicalHost(u.Host)
	if err != nil {
		return
	}
	defPath := defaultPath(u.Path)
	now := j.now()
	j.mu.Lock()
	defer j.mu.Unlock()
	for _, hc := range cookies {
		c, remove, err := j.fromHTTP(hc, host, defPath, now)
		if err != nil {
			continue
		}
		if remove {
			j.removeLocked(c.Ref())
			continue
		}
		j.putLocked(c)
	}
}

// fromHTTP converts a Set-Cookie into a stored cookie, or reports that it
// deletes one (Max-Age <= 0 or an Expires in the past).
func (j *Jar) fromHTTP(hc *http.Cookie, host, defPath string, now time.Time) (Cookie, bool, error) {
	if hc.Name == "" {
		return Cookie{}, false, ErrInvalid
	}
	domain, hostOnly, err := domainAndType(host, hc.Domain)
	if err != nil {
		return Cookie{}, false, err
	}
	path := hc.Path
	if path == "" || path[0] != '/' {
		path = defPath
	}
	c := Cookie{
		Name: hc.Name, Value: hc.Value, Domain: domain, Path: path, HostOnly: hostOnly,
		Secure: hc.Secure, HTTPOnly: hc.HttpOnly, SameSite: sameSite(hc.SameSite),
	}
	switch {
	case hc.MaxAge < 0:
		return c, true, nil
	case hc.MaxAge > 0:
		c.ExpiresAt = now.Add(time.Duration(hc.MaxAge) * time.Second).UnixMilli()
	case !hc.Expires.IsZero():
		if !hc.Expires.After(now) {
			return c, true, nil
		}
		c.ExpiresAt = hc.Expires.UnixMilli()
	}
	return c, false, nil
}

func sameSite(s http.SameSite) string {
	switch s {
	case http.SameSiteLaxMode:
		return "lax"
	case http.SameSiteStrictMode:
		return "strict"
	case http.SameSiteNoneMode:
		return "none"
	default:
		return ""
	}
}

// putLocked stores c, keeping the creation time of the cookie it replaces.
func (j *Jar) putLocked(c Cookie) {
	ref := c.Ref()
	old, existed := j.cookies[ref]
	if existed {
		c.CreatedAt = old.CreatedAt
	} else if c.CreatedAt == 0 {
		j.seq++
		c.CreatedAt = j.nowMs()*1000 + j.seq%1000
	}
	j.cookies[ref] = &c
	if j.store == nil {
		return
	}
	switch {
	case c.Persistent():
		j.report(j.store.SaveCookie(c))
	case existed && old.Persistent():
		// Now a session cookie: it no longer belongs on disk.
		j.report(j.store.DeleteCookie(ref))
	}
}

func (j *Jar) removeLocked(ref Ref) bool {
	old, ok := j.cookies[ref]
	if !ok {
		return false
	}
	delete(j.cookies, ref)
	if j.store != nil && old.Persistent() {
		j.report(j.store.DeleteCookie(ref))
	}
	return true
}

// Cookies implements http.CookieJar.
func (j *Jar) Cookies(u *url.URL) []*http.Cookie {
	hits := j.ForURL(u)
	if len(hits) == 0 {
		return nil
	}
	out := make([]*http.Cookie, 0, len(hits))
	for _, c := range hits {
		// A Cookie header carries only the name and value.
		out = append(out, &http.Cookie{Name: c.Name, Value: c.Value}) //nolint:gosec // request cookie, not a Set-Cookie
	}
	return out
}

// ForURL lists the live cookies a request to u sends, in Cookie header
// order (RFC 6265 5.4: longer paths first, then older cookies first).
func (j *Jar) ForURL(u *url.URL) []Cookie {
	j.mu.Lock()
	defer j.mu.Unlock()
	hits := j.matchLocked(u)
	out := make([]Cookie, len(hits))
	for i, c := range hits {
		out[i] = *c
	}
	return out
}

func (j *Jar) matchLocked(u *url.URL) []*Cookie {
	if u.Scheme != "http" && u.Scheme != "https" {
		return nil
	}
	host, err := canonicalHost(u.Host)
	if err != nil {
		return nil
	}
	path := u.Path
	if path == "" {
		path = "/"
	}
	secure := u.Scheme == "https"
	now := j.nowMs()
	var hits []*Cookie
	for ref, c := range j.cookies {
		if c.Persistent() && c.ExpiresAt <= now {
			j.removeLocked(ref)
			continue
		}
		if !c.domainMatch(host) || !pathMatch(c.Path, path) || (c.Secure && !secure) {
			continue
		}
		hits = append(hits, c)
	}
	sort.Slice(hits, func(a, b int) bool {
		if len(hits[a].Path) != len(hits[b].Path) {
			return len(hits[a].Path) > len(hits[b].Path)
		}
		return hits[a].CreatedAt < hits[b].CreatedAt
	})
	return hits
}

// SetForURL stores c as if a response from u had set it: an empty Domain
// makes a host-only cookie, and a Domain u's host isn't in is refused, as
// is a public suffix; an empty Path is u's default path.
func (j *Jar) SetForURL(u *url.URL, c Cookie) (Cookie, error) {
	if u.Scheme != "http" && u.Scheme != "https" {
		return Cookie{}, fmt.Errorf("%w: cookies need an http or https URL", ErrInvalid)
	}
	host, err := canonicalHost(u.Host)
	if err != nil {
		return Cookie{}, fmt.Errorf("%w: the URL has no host", ErrInvalid)
	}
	domain, hostOnly, err := domainAndType(host, strings.TrimSpace(c.Domain))
	if err != nil {
		return Cookie{}, fmt.Errorf("%w: a cookie for %s can't be set from %s", ErrInvalid, c.Domain, host)
	}
	c.Domain, c.HostOnly = domain, hostOnly
	if strings.TrimSpace(c.Path) == "" {
		c.Path = defaultPath(u.Path)
	}
	c, err = j.check(c)
	if err != nil {
		return Cookie{}, err
	}
	c.HostOnly = hostOnly
	c.CreatedAt = 0
	j.mu.Lock()
	defer j.mu.Unlock()
	j.putLocked(c)
	return *j.cookies[c.Ref()], nil
}

// DeleteForURL removes the cookies a request to u sends that are named
// name, or all of them when name is "". It returns how many.
func (j *Jar) DeleteForURL(u *url.URL, name string) int {
	j.mu.Lock()
	defer j.mu.Unlock()
	n := 0
	for _, c := range j.matchLocked(u) {
		if name == "" || c.Name == name {
			j.removeLocked(c.Ref())
			n++
		}
	}
	return n
}

func (c *Cookie) domainMatch(host string) bool {
	if c.Domain == host {
		return true
	}
	return !c.HostOnly && hasDotSuffix(host, c.Domain)
}

func pathMatch(cookiePath, reqPath string) bool {
	if cookiePath == reqPath {
		return true
	}
	if !strings.HasPrefix(reqPath, cookiePath) {
		return false
	}
	return strings.HasSuffix(cookiePath, "/") || reqPath[len(cookiePath)] == '/'
}

func hasDotSuffix(s, suffix string) bool {
	return len(s) > len(suffix) && s[len(s)-len(suffix)-1] == '.' && s[len(s)-len(suffix):] == suffix
}

// canonicalHost strips the port and a trailing dot, and lower-cases.
func canonicalHost(host string) (string, error) {
	if h, _, err := net.SplitHostPort(host); err == nil {
		host = h
	}
	host = strings.ToLower(strings.TrimSuffix(strings.Trim(host, "[]"), "."))
	if host == "" {
		return "", ErrInvalid
	}
	return host, nil
}

func defaultPath(p string) string {
	if p == "" || p[0] != '/' {
		return "/"
	}
	i := strings.LastIndex(p, "/")
	if i == 0 {
		return "/"
	}
	return p[:i]
}

// domainAndType decides a cookie's domain for a response from host
// (RFC 6265 5.3 steps 4–6): no Domain attribute makes a host-only cookie;
// a public suffix or a domain the host isn't in is refused.
func domainAndType(host, domain string) (string, bool, error) {
	if domain == "" {
		return host, true, nil
	}
	if net.ParseIP(host) != nil {
		// An IP host can only set a cookie for itself.
		if strings.TrimPrefix(domain, ".") != host {
			return "", false, ErrInvalid
		}
		return host, true, nil
	}
	domain = strings.ToLower(strings.TrimPrefix(domain, "."))
	if domain == "" || strings.HasSuffix(domain, ".") {
		return "", false, ErrInvalid
	}
	if ps, _ := publicsuffix.PublicSuffix(domain); ps != "" && !hasDotSuffix(domain, ps) {
		// The domain is a public suffix: only that host itself may use it.
		if host == domain {
			return host, true, nil
		}
		return "", false, ErrInvalid
	}
	if host != domain && !hasDotSuffix(host, domain) {
		return "", false, ErrInvalid
	}
	return domain, false, nil
}

// All lists the live cookies, by domain, then path, then name.
func (j *Jar) All() []Cookie {
	now := j.nowMs()
	j.mu.Lock()
	defer j.mu.Unlock()
	out := []Cookie{}
	for ref, c := range j.cookies {
		if c.Persistent() && c.ExpiresAt <= now {
			j.removeLocked(ref)
			continue
		}
		out = append(out, *c)
	}
	sort.Slice(out, func(a, b int) bool {
		x, y := out[a], out[b]
		if x.Domain != y.Domain {
			return x.Domain < y.Domain
		}
		if x.Path != y.Path {
			return x.Path < y.Path
		}
		return x.Name < y.Name
	})
	return out
}

// Add stores a cookie from the cookie manager, replacing one with the same
// domain, path and name. ExpiresAt in the past is refused.
func (j *Jar) Add(c Cookie) (Cookie, error) {
	c, err := j.check(c)
	if err != nil {
		return Cookie{}, err
	}
	c.CreatedAt = 0
	j.mu.Lock()
	defer j.mu.Unlock()
	j.putLocked(c)
	return *j.cookies[c.Ref()], nil
}

// Update replaces the cookie old with c (which may have another identity).
func (j *Jar) Update(old Ref, c Cookie) (Cookie, error) {
	c, err := j.check(c)
	if err != nil {
		return Cookie{}, err
	}
	j.mu.Lock()
	defer j.mu.Unlock()
	prev, ok := j.cookies[old]
	if !ok {
		return Cookie{}, fmt.Errorf("%w: %s on %s%s", ErrNotFound, old.Name, old.Domain, old.Path)
	}
	c.CreatedAt = prev.CreatedAt
	if old != c.Ref() {
		j.removeLocked(old)
		// The edited cookie replaces any other cookie it now collides with.
		j.removeLocked(c.Ref())
	}
	j.putLocked(c)
	return *j.cookies[c.Ref()], nil
}

// Delete removes one cookie. It reports whether it existed.
func (j *Jar) Delete(r Ref) bool {
	j.mu.Lock()
	defer j.mu.Unlock()
	return j.removeLocked(r)
}

// ClearDomain removes every cookie stored for domain (not its subdomains'
// own entries) and returns how many.
func (j *Jar) ClearDomain(domain string) int {
	domain = strings.ToLower(strings.TrimPrefix(strings.TrimSpace(domain), "."))
	j.mu.Lock()
	defer j.mu.Unlock()
	n := 0
	for ref := range j.cookies {
		if ref.Domain == domain {
			delete(j.cookies, ref)
			n++
		}
	}
	if j.store != nil && domain != "" {
		j.report(j.store.ClearCookies(domain))
	}
	return n
}

// Clear removes every cookie.
func (j *Jar) Clear() {
	j.mu.Lock()
	defer j.mu.Unlock()
	j.cookies = map[Ref]*Cookie{}
	if j.store != nil {
		j.report(j.store.ClearCookies(""))
	}
}

// check validates and normalizes a cookie from the manager.
func (j *Jar) check(c Cookie) (Cookie, error) {
	c.Name = strings.TrimSpace(c.Name)
	c.Domain = strings.TrimSpace(c.Domain)
	if strings.HasPrefix(c.Domain, ".") {
		c.HostOnly = false
	}
	host, err := canonicalHost(strings.TrimPrefix(c.Domain, "."))
	if err != nil || strings.ContainsAny(host, " /\\:;,") && net.ParseIP(host) == nil {
		return Cookie{}, fmt.Errorf("%w: enter the domain the cookie is for, e.g. api.example.com", ErrInvalid)
	}
	c.Domain = host
	c.Path = strings.TrimSpace(c.Path)
	if c.Path == "" {
		c.Path = "/"
	}
	if c.Path[0] != '/' {
		return Cookie{}, fmt.Errorf("%w: the path must start with /", ErrInvalid)
	}
	switch {
	case c.Name == "":
		return Cookie{}, fmt.Errorf("%w: enter a name", ErrInvalid)
	case !validName(c.Name):
		return Cookie{}, fmt.Errorf("%w: the name %q can't contain spaces or any of ()<>@,;:\\\"/[]?={}", ErrInvalid, c.Name)
	case !validValue(c.Value):
		return Cookie{}, fmt.Errorf("%w: the value can't contain control characters, quotes, semicolons or backslashes", ErrInvalid)
	case c.ExpiresAt < 0 || (c.ExpiresAt > 0 && c.ExpiresAt <= j.nowMs()):
		return Cookie{}, fmt.Errorf("%w: the expiry date is in the past; delete the cookie instead", ErrInvalid)
	}
	switch c.SameSite = strings.ToLower(c.SameSite); c.SameSite {
	case "", "lax", "strict", "none":
	default:
		return Cookie{}, fmt.Errorf("%w: SameSite must be Lax, Strict or None", ErrInvalid)
	}
	return c, nil
}

func validName(s string) bool {
	for _, r := range s {
		if r <= ' ' || r >= 0x7f || strings.ContainsRune("()<>@,;:\\\"/[]?={}", r) {
			return false
		}
	}
	return true
}

func validValue(s string) bool {
	for _, r := range s {
		if r < 0x20 || r == 0x7f || r == '"' || r == ';' || r == '\\' {
			return false
		}
	}
	return true
}
