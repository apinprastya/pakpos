package curl

import (
	"regexp"
	"strconv"
	"strings"

	"pakpos/internal/core/auth"
	"pakpos/internal/core/model"
	"pakpos/internal/core/urlx"
)

// Generate writes req as a curl command for a POSIX shell: one option per
// line with " \" continuations, every value quoted for the shell.
//
// The order is stable: the method (-X, or --head; left out for a GET
// without a body and a POST with one), -g when the URL has characters curl
// would treat as a glob, the URL, -u for basic auth, the headers in order
// (plus the Content-Type Pakpos would add for the body, when no header sets
// one), then the body: --data-raw for raw, --data-urlencode (or --data for
// names that need escaping) per urlencoded row, -F/--form-string per
// form-data field, --data-binary @path for binary. Bearer and API key auth
// are written as the header or query parameter they send. Disabled rows are
// left out. The request's own settings follow the URL (see settingArgs).
func Generate(req model.Request) string {
	// An incomplete API key setting is left out, as it can't be sent.
	r, _ := auth.Materialize(req, true)
	method := strings.ToUpper(strings.TrimSpace(r.Method))
	if method == "" {
		method = "GET"
	}
	body := bodyArgs(r.Body)
	headers := enabledHeaders(r.Headers)
	if ct := r.Body.DefaultContentType(); ct != "" && r.Body.Type != model.BodyURLEncoded && r.Body.Type != model.BodyFormData &&
		len(body) > 0 && !hasHeader(headers, "Content-Type") {
		headers = append(headers, model.KeyValue{Key: "Content-Type", Value: ct, Enabled: true})
	}

	first := []string{"curl"}
	switch {
	case method == "HEAD" && len(body) == 0:
		first = append(first, "--head")
	case method == "GET" && len(body) == 0, method == "POST" && len(body) > 0:
	default:
		first = append(first, "-X", Quote(method))
	}
	target := urlx.SendURL(r)
	if globRe.MatchString(target) {
		first = append(first, "-g")
	}
	first = append(first, Quote(target))

	lines := []string{strings.Join(first, " ")}
	lines = append(lines, settingArgs(r.Settings)...)
	if r.Auth.Type == model.AuthBasic {
		lines = append(lines, "-u "+Quote(r.Auth.Username+":"+r.Auth.Password))
	}
	for _, h := range headers {
		if h.Value == "" {
			lines = append(lines, "-H "+Quote(h.Key+";"))
			continue
		}
		lines = append(lines, "-H "+Quote(h.Key+": "+h.Value))
	}
	lines = append(lines, body...)
	return strings.Join(lines, " \\\n  ")
}

var globRe = regexp.MustCompile(`[\[\]{}]`)

// settingArgs writes the request's own settings as curl options: -k when it
// turns TLS verification off, -L (and --max-redirs) when it follows
// redirects, --max-time for its timeout. App settings aren't written.
func settingArgs(s model.RequestSettings) []string {
	var out []string
	if s.VerifyTLS != nil && !*s.VerifyTLS {
		out = append(out, "-k")
	}
	if s.FollowRedirects != nil && *s.FollowRedirects {
		out = append(out, "-L")
		if s.MaxRedirects != nil {
			out = append(out, "--max-redirs "+strconv.Itoa(*s.MaxRedirects))
		}
	}
	if s.TimeoutMs != nil && *s.TimeoutMs > 0 {
		out = append(out, "--max-time "+strconv.FormatFloat(float64(*s.TimeoutMs)/1000, 'f', -1, 64))
	}
	return out
}

func enabledHeaders(rows []model.KeyValue) []model.KeyValue {
	out := []model.KeyValue{}
	for _, h := range rows {
		key := strings.TrimSpace(h.Key)
		if h.Enabled && key != "" {
			out = append(out, model.KeyValue{Key: key, Value: h.Value, Enabled: true})
		}
	}
	return out
}

func hasHeader(rows []model.KeyValue, name string) bool {
	for _, h := range rows {
		if strings.EqualFold(h.Key, name) {
			return true
		}
	}
	return false
}

var safeKeyRe = regexp.MustCompile(`^[A-Za-z0-9._~-]+$`)

func bodyArgs(b model.Body) []string {
	var out []string
	switch b.Type {
	case model.BodyRaw:
		out = append(out, "--data-raw "+Quote(b.Raw))
	case model.BodyURLEncoded:
		for _, row := range b.URLEncoded {
			if !row.Enabled || (row.Key == "" && row.Value == "") {
				continue
			}
			if safeKeyRe.MatchString(row.Key) {
				out = append(out, "--data-urlencode "+Quote(row.Key+"="+row.Value))
				continue
			}
			out = append(out, "--data "+Quote(urlx.EncodeWireQuery([]model.KeyValue{row})))
		}
		if len(out) == 0 {
			out = append(out, "--data ''")
		}
	case model.BodyFormData:
		for _, f := range b.FormData {
			if !f.Enabled || strings.TrimSpace(f.Key) == "" {
				continue
			}
			out = append(out, formArg(f))
		}
	case model.BodyBinary:
		if b.BinaryPath != "" {
			out = append(out, "--data-binary "+Quote("@"+b.BinaryPath))
		}
	}
	return out
}

func formArg(f model.FormField) string {
	if f.Kind == model.FormFile {
		v := f.Key + "=@" + formQuote(f.FilePath)
		if f.ContentType != "" {
			v += ";type=" + f.ContentType
		}
		return "-F " + Quote(v)
	}
	// curl reads @, < and ;type= in -F values; --form-string sends the text as is.
	if strings.HasPrefix(f.Value, "@") || strings.HasPrefix(f.Value, "<") || strings.Contains(f.Value, ";") ||
		strings.HasPrefix(f.Value, `"`) {
		return "--form-string " + Quote(f.Key+"="+f.Value)
	}
	v := f.Key + "=" + f.Value
	if f.ContentType != "" {
		v += ";type=" + f.ContentType
	}
	return "-F " + Quote(v)
}

// formQuote quotes a -F file name when curl would otherwise split it.
func formQuote(path string) string {
	if !strings.ContainsAny(path, `;,"\ `) {
		return path
	}
	return `"` + strings.NewReplacer(`\`, `\\`, `"`, `\"`).Replace(path) + `"`
}

// Quote returns s quoted for a POSIX shell: as is when it has only safe
// characters, in single quotes otherwise, or as $'…' when it holds control
// characters (other than a line break) that wouldn't survive copy and paste.
func Quote(s string) string {
	if s == "" {
		return "''"
	}
	if safeWordRe.MatchString(s) {
		return s
	}
	if needsANSI(s) {
		return ansiQuote(s)
	}
	return "'" + strings.ReplaceAll(s, "'", `'\''`) + "'"
}

var safeWordRe = regexp.MustCompile(`^[A-Za-z0-9_@%+=:,./-]+$`)

func needsANSI(s string) bool {
	for i := 0; i < len(s); i++ {
		if c := s[i]; (c < 0x20 && c != '\n') || c == 0x7f {
			return true
		}
	}
	return false
}

func ansiQuote(s string) string {
	var b strings.Builder
	b.WriteString("$'")
	const hex = "0123456789abcdef"
	for i := 0; i < len(s); i++ {
		switch c := s[i]; c {
		case '\\':
			b.WriteString(`\\`)
		case '\'':
			b.WriteString(`\'`)
		case '\n':
			b.WriteString(`\n`)
		case '\r':
			b.WriteString(`\r`)
		case '\t':
			b.WriteString(`\t`)
		default:
			if c < 0x20 || c == 0x7f {
				b.WriteString(`\x`)
				b.WriteByte(hex[c>>4])
				b.WriteByte(hex[c&15])
				continue
			}
			b.WriteByte(c)
		}
	}
	b.WriteByte('\'')
	return b.String()
}
