package postman

import (
	"encoding/json"
	"regexp"
	"strings"

	"pakpos/internal/core/vars"
)

// scriptFeatures are script APIs Postman has and Pakpos doesn't; a script
// using one throws when it gets there.
var scriptFeatures = []struct {
	re   *regexp.Regexp
	name string
}{
	{regexp.MustCompile(`\bpm\.sendRequest\b`), "pm.sendRequest"},
	{regexp.MustCompile(`\bpm\.cookies\b`), "pm.cookies"},
	{regexp.MustCompile(`\bpm\.request\.auth\b`), "pm.request.auth"},
	{regexp.MustCompile(`\bpm\.vault\b`), "pm.vault"},
	{regexp.MustCompile(`\bpm\.visualizer\b`), "pm.visualizer"},
	{regexp.MustCompile(`\bpm\.require\b`), "pm.require"},
	{regexp.MustCompile(`\bpm\.execution\.runRequest\b`), "pm.execution.runRequest"},
	{regexp.MustCompile(`(^|[^.\w])require\s*\(`), "require()"},
	{regexp.MustCompile(`\bset(Timeout|Interval)\s*\(`), "timers"},
	{regexp.MustCompile(`\bCryptoJS\b`), "CryptoJS"},
	{regexp.MustCompile(`(^|[^.\w$])_\.\w+\s*\(`), "lodash (_)"},
	{regexp.MustCompile(`(^|[^.\w])moment\s*\(`), "moment"},
	{regexp.MustCompile(`\b(cheerio|xml2Json|tv4)\b`), "Postman's bundled libraries"},
	{regexp.MustCompile(`\btests\s*\[|\bresponseBody\b|\bresponseCode\b|\bresponseHeaders\b|\bpostman\.(set|get|clear)(Environment|Global)Variable\b`), "the legacy postman/tests[] API"},
}

// checkScript warns about script APIs Pakpos doesn't have.
func (c *converter) checkScript(where, src string) {
	if strings.TrimSpace(src) == "" {
		return
	}
	var used []string
	for _, f := range scriptFeatures {
		if f.re.MatchString(src) {
			used = append(used, f.name)
		}
	}
	if len(used) > 0 {
		c.warn(where, "Scripts use %s, which Pakpos scripts don't support. Those lines throw an error until they're rewritten with the pm API.",
			strings.Join(used, ", "))
	}
}

var dynamicRe = regexp.MustCompile(`\{\{\s*(\$[A-Za-z][A-Za-z0-9_]*)\s*\}\}`)

// checkDynamic collects the {{$name}} references in v that Pakpos can't
// resolve (Postman has many more dynamic variables, e.g. $randomEmail).
func (c *converter) checkDynamic(_ string, v any) {
	b, err := json.Marshal(v)
	if err != nil {
		return
	}
	if c.dynamicSeen == nil {
		c.dynamicSeen = map[string]bool{}
	}
	for _, m := range dynamicRe.FindAllSubmatch(b, -1) {
		name := string(m[1])
		if vars.IsDynamic(name) || c.dynamicSeen[name] {
			continue
		}
		c.dynamicSeen[name] = true
		c.dynamic = append(c.dynamic, name)
	}
}

var (
	secretNameRe = regexp.MustCompile(`(?i)(password|passwd|passphrase|secret|token|api[-_]?key|private[-_]?key|credential|session[-_]?id|^pwd$|^pass$|^key$)`)
	notSecretRe  = regexp.MustCompile(`(?i)(url|uri|endpoint|host|path|type|name|expir\w*|ttl)$`)
)

// LooksSecret reports whether a variable name looks like it holds a
// credential ("token", "client_secret", "apiKey"...). URLs and other
// settings about credentials ("tokenUrl", "tokenType") don't count.
func LooksSecret(name string) bool {
	return secretNameRe.MatchString(name) && !notSecretRe.MatchString(name)
}
