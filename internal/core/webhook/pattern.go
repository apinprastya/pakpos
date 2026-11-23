package webhook

import (
	"errors"
	"fmt"
	"regexp"
	"strings"
)

// Pattern is a compiled path pattern. Segments are matched one by one:
// literal text exactly (case-sensitive), "*" any one segment, ":name" any
// one segment captured as the parameter name, and "**" (only as the last
// segment) the rest of the path, including nothing. A trailing slash is
// ignored on both sides.
type Pattern struct {
	segs []string
	rest bool // ends with **
}

var paramRE = regexp.MustCompile(`^:[A-Za-z_][A-Za-z0-9_]*$`)

// CompilePattern parses a path pattern such as /orders/:id/** .
func CompilePattern(p string) (Pattern, error) {
	if p == "" {
		return Pattern{}, errors.New("enter a path, such as / or /payments/*")
	}
	if !strings.HasPrefix(p, "/") {
		return Pattern{}, errors.New(`the path must start with "/"`)
	}
	if strings.ContainsAny(p, "?#") {
		return Pattern{}, errors.New("the path can't hold a query or fragment; match the query with a condition")
	}
	segs := splitPath(p)
	var out Pattern
	names := map[string]bool{}
	for i, s := range segs {
		switch {
		case s == "**":
			if i != len(segs)-1 {
				return Pattern{}, errors.New(`"**" can only be the last part of the path`)
			}
			out.rest = true
			continue
		case strings.HasPrefix(s, ":"):
			if !paramRE.MatchString(s) {
				return Pattern{}, fmt.Errorf("%q isn't a valid parameter; use letters, digits and _ after the colon", s)
			}
			if names[s] {
				return Pattern{}, fmt.Errorf("the parameter %q appears twice", s)
			}
			names[s] = true
		case strings.Contains(s, "*"):
			if s != "*" {
				return Pattern{}, fmt.Errorf("%q: a * must be a whole part of the path", s)
			}
		}
		out.segs = append(out.segs, s)
	}
	return out, nil
}

// Match reports whether path matches and returns the captured parameters.
func (p Pattern) Match(path string) (map[string]string, bool) {
	segs := splitPath(path)
	if len(segs) < len(p.segs) || (!p.rest && len(segs) != len(p.segs)) {
		return nil, false
	}
	var params map[string]string
	for i, s := range p.segs {
		switch {
		case s == "*":
		case strings.HasPrefix(s, ":"):
			if params == nil {
				params = map[string]string{}
			}
			params[s[1:]] = segs[i]
		case s != segs[i]:
			return nil, false
		}
	}
	return params, true
}

// splitPath splits /a/b/ into [a b]; "/" and "" give no segments. Empty
// segments from doubled slashes are kept, so /a//b doesn't match /a/b.
func splitPath(p string) []string {
	p = strings.TrimPrefix(p, "/")
	p = strings.TrimSuffix(p, "/")
	if p == "" {
		return nil
	}
	return strings.Split(p, "/")
}
