package service

import (
	"errors"
	"strings"

	"pakpos/internal/core/cookies"
)

// CookieService lists and edits the cookies of the open workspace (or of
// sends without one). Persistent cookies are kept in SQLite per workspace,
// session cookies only until the app quits; none go into workspace files.
type CookieService struct{ c *Core }

// NewCookieService creates the service.
func NewCookieService(c *Core) *CookieService { return &CookieService{c: c} }

// List returns the live cookies, by domain, path and name. Never nil.
func (s *CookieService) List() []cookies.Cookie {
	return s.c.cookieJar().All()
}

// Add stores a new cookie, replacing one with the same domain, path and
// name. ExpiresAt 0 makes a session cookie.
func (s *CookieService) Add(c cookies.Cookie) (cookies.Cookie, error) {
	out, err := s.c.cookieJar().Add(c)
	return out, cookieError(err)
}

// Update replaces the cookie named by old with c.
func (s *CookieService) Update(old cookies.Ref, c cookies.Cookie) (cookies.Cookie, error) {
	out, err := s.c.cookieJar().Update(old, c)
	return out, cookieError(err)
}

// Delete removes one cookie. A cookie that is already gone is not an error.
func (s *CookieService) Delete(ref cookies.Ref) {
	s.c.cookieJar().Delete(ref)
}

// ClearDomain removes the cookies stored for one domain and returns how many.
func (s *CookieService) ClearDomain(domain string) int {
	return s.c.cookieJar().ClearDomain(domain)
}

// ClearAll removes every cookie of the open workspace.
func (s *CookieService) ClearAll() {
	s.c.cookieJar().Clear()
}

// cookieError turns the jar's validation errors into sentences for the UI.
func cookieError(err error) error {
	switch {
	case err == nil:
		return nil
	case errors.Is(err, cookies.ErrNotFound):
		return &userError{msg: "That cookie no longer exists. It may have expired or been replaced by a response.", err: err}
	case errors.Is(err, cookies.ErrInvalid):
		_, detail, _ := strings.Cut(err.Error(), ": ")
		if detail == "" {
			detail = "check the cookie"
		}
		return &userError{msg: strings.ToUpper(detail[:1]) + detail[1:] + ".", err: err}
	default:
		return err
	}
}
