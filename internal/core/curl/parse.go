package curl

import (
	"bytes"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"mime"
	"mime/multipart"
	"net/url"
	"regexp"
	"strings"
	"unicode/utf8"

	"pakpos/internal/core/model"
	"pakpos/internal/core/urlx"
)

// optKind says what an option does with its value.
type optKind int

const (
	optFlag  optKind = iota // takes no value
	optValue                // takes a value
)

type option struct {
	long  string
	short byte
	kind  optKind
	// quiet options don't change the request and aren't worth a warning
	// (output, progress, protocol version...).
	quiet bool
	// note is the warning for an option that is understood but maps to an
	// app setting or isn't supported; "" for options handled in parse.
	note string
}

const (
	settingTLS       = "Pakpos verifies TLS certificates unless you turn that off in Settings; this option wasn't imported."
	settingRedirects = "Pakpos follows redirects as set in Settings; this option wasn't imported."
	settingCompress  = "Pakpos always asks for compressed responses and decompresses them, so this option isn't needed."
	settingProxy     = "Proxies are set in Settings; this option wasn't imported."
	settingTimeout   = "Timeouts are set in Settings; this option wasn't imported."
	otherAuth        = "Only basic auth is imported from -u; this auth method was ignored."
)

var options = []option{
	{long: "request", short: 'X', kind: optValue},
	{long: "header", short: 'H', kind: optValue},
	{long: "data", short: 'd', kind: optValue},
	{long: "data-ascii", kind: optValue},
	{long: "data-raw", kind: optValue},
	{long: "data-binary", kind: optValue},
	{long: "data-urlencode", kind: optValue},
	{long: "json", kind: optValue},
	{long: "form", short: 'F', kind: optValue},
	{long: "form-string", kind: optValue},
	{long: "user", short: 'u', kind: optValue},
	{long: "cookie", short: 'b', kind: optValue},
	{long: "user-agent", short: 'A', kind: optValue},
	{long: "referer", short: 'e', kind: optValue},
	{long: "url", kind: optValue},
	{long: "url-query", kind: optValue},
	{long: "oauth2-bearer", kind: optValue},
	{long: "get", short: 'G'},
	{long: "head", short: 'I'},
	{long: "insecure", short: 'k', note: settingTLS},
	{long: "location", short: 'L', note: settingRedirects},
	{long: "location-trusted", note: settingRedirects},
	{long: "max-redirs", kind: optValue, note: settingRedirects},
	{long: "compressed", note: settingCompress},
	{long: "proxy", short: 'x', kind: optValue, note: settingProxy},
	{long: "proxy-user", short: 'U', kind: optValue, note: settingProxy},
	{long: "noproxy", kind: optValue, note: settingProxy},
	{long: "max-time", short: 'm', kind: optValue, note: settingTimeout},
	{long: "connect-timeout", kind: optValue, note: settingTimeout},
	{long: "digest", note: otherAuth},
	{long: "ntlm", note: otherAuth},
	{long: "negotiate", note: otherAuth},
	{long: "anyauth", note: otherAuth},
	{long: "basic", quiet: true},
	{long: "upload-file", short: 'T', kind: optValue, note: "Uploading a file with -T isn't supported; use a binary body instead."},
	{long: "cookie-jar", short: 'c', kind: optValue, note: "Cookies are kept by Pakpos for the session; the cookie jar file wasn't used."},
	{long: "cacert", kind: optValue, note: "Certificates aren't imported; this option was ignored."},
	{long: "capath", kind: optValue, note: "Certificates aren't imported; this option was ignored."},
	{long: "cert", short: 'E', kind: optValue, note: "Client certificates aren't supported yet; this option was ignored."},
	{long: "key", kind: optValue, note: "Client certificates aren't supported yet; this option was ignored."},
	{long: "cert-type", kind: optValue, note: "Client certificates aren't supported yet; this option was ignored."},
	{long: "key-type", kind: optValue, note: "Client certificates aren't supported yet; this option was ignored."},
	{long: "pass", kind: optValue, note: "Client certificates aren't supported yet; this option was ignored."},
	{long: "resolve", kind: optValue, note: "Custom name resolution isn't supported; this option was ignored."},
	{long: "connect-to", kind: optValue, note: "Custom name resolution isn't supported; this option was ignored."},
	{long: "range", short: 'r', kind: optValue, note: "Add a Range header instead; this option was ignored."},
	{long: "config", short: 'K', kind: optValue, note: "Config files aren't read; this option was ignored."},
	{long: "retry", kind: optValue, note: "Retries aren't supported; this option was ignored."},
	{long: "variable", kind: optValue, note: "curl variables aren't supported; this option was ignored."},
	{long: "unix-socket", kind: optValue, note: "Unix sockets aren't supported; this option was ignored."},
	{long: "aws-sigv4", kind: optValue, note: "AWS signatures aren't supported; this option was ignored."},
	{long: "request-target", kind: optValue, note: "This option isn't supported and was ignored."},
	{long: "time-cond", short: 'z', kind: optValue, note: "Add an If-Modified-Since header instead; this option was ignored."},
	// Quiet: they change output, progress or the protocol version, not the request.
	{long: "output", short: 'o', kind: optValue, quiet: true},
	{long: "remote-name", short: 'O', quiet: true},
	{long: "remote-header-name", short: 'J', quiet: true},
	{long: "output-dir", kind: optValue, quiet: true},
	{long: "create-dirs", quiet: true},
	{long: "write-out", short: 'w', kind: optValue, quiet: true},
	{long: "dump-header", short: 'D', kind: optValue, quiet: true},
	{long: "stderr", kind: optValue, quiet: true},
	{long: "trace", kind: optValue, quiet: true},
	{long: "trace-ascii", kind: optValue, quiet: true},
	{long: "retry-delay", kind: optValue, quiet: true},
	{long: "retry-max-time", kind: optValue, quiet: true},
	{long: "limit-rate", kind: optValue, quiet: true},
	{long: "silent", short: 's', quiet: true},
	{long: "show-error", short: 'S', quiet: true},
	{long: "verbose", short: 'v', quiet: true},
	{long: "include", short: 'i', quiet: true},
	{long: "fail", short: 'f', quiet: true},
	{long: "fail-with-body", quiet: true},
	{long: "globoff", short: 'g', quiet: true},
	{long: "no-progress-meter", quiet: true},
	{long: "progress-bar", short: '#', quiet: true},
	{long: "no-buffer", short: 'N', quiet: true},
	{long: "http1.0", short: '0', quiet: true},
	{long: "http1.1", quiet: true},
	{long: "http2", quiet: true},
	{long: "http2-prior-knowledge", quiet: true},
	{long: "http3", quiet: true},
	{long: "ipv4", short: '4', quiet: true},
	{long: "ipv6", short: '6', quiet: true},
	{long: "path-as-is", quiet: true},
	{long: "tcp-nodelay", quiet: true},
	{long: "no-keepalive", quiet: true},
	{long: "styled-output", quiet: true},
	{long: "raw", quiet: true},
	{long: "tlsv1.2", quiet: true},
	{long: "tlsv1.3", quiet: true},
	{long: "ssl-no-revoke", quiet: true},
}

var (
	byLong  = map[string]*option{}
	byShort = map[byte]*option{}
)

func init() {
	for i := range options {
		o := &options[i]
		byLong[o.long] = o
		if o.short != 0 {
			byShort[o.short] = o
		}
	}
}

// dataPart is one -d/--data-*/--json value, in order.
type dataPart struct {
	text string
	// file is the path of an @file value (text is then empty).
	file string
	opt  string
}

// parser collects what the options say before the request is assembled.
type parser struct {
	warnings []Warning
	method   string
	urls     []string
	headers  []model.KeyValue
	data     []dataPart
	jsonData bool
	form     []model.FormField
	query    []model.KeyValue
	auth     model.Auth
	get      bool
	head     bool
	noted    map[string]bool
}

func (p *parser) warn(opt, format string, args ...any) {
	p.warnings = append(p.warnings, Warning{Option: opt, Message: fmt.Sprintf(format, args...)})
}

// note adds an option's warning once.
func (p *parser) note(name string, o *option) {
	if p.noted[o.note] {
		return
	}
	p.noted[o.note] = true
	p.warnings = append(p.warnings, Warning{Option: name, Message: o.note})
}

// Parse reads a curl command into a request. Problems that don't stop the
// import (unknown or unsupported options, data curl would send differently)
// come back as warnings; an error means there is nothing to import: the
// text isn't a curl command, a quote isn't closed, an option misses its
// value or there is no URL.
//
// Decisions:
//   - -d @file and --data-binary @file become a binary body with that path
//     (-d would strip newlines; Pakpos sends the file as it is, with a
//     warning). --data-urlencode with a file and -d @- (stdin) are skipped
//     with a warning.
//   - An Authorization header with the Bearer scheme becomes bearer auth,
//     one with the Basic scheme becomes basic auth; other schemes stay a
//     header.
//   - The body type follows the Content-Type header: JSON, XML, HTML,
//     JavaScript or text raw bodies, urlencoded rows, or (for Chrome's
//     multipart --data-raw) form-data parts. Data without a Content-Type is
//     urlencoded when it looks like name=value pairs, JSON when it is valid
//     JSON (with a warning, since curl would send it as a form), and text
//     otherwise. A Content-Type equal to Pakpos's default for the body is
//     dropped, since Pakpos adds it when sending.
func Parse(text string) (model.Request, []Warning, error) {
	text = strings.TrimSpace(text)
	text = strings.TrimPrefix(text, "$ ")
	res, err := splitWords(text)
	if err != nil {
		return model.Request{}, res.warnings, err
	}
	words := res.words
	if len(words) == 0 || !strings.EqualFold(strings.TrimSuffix(strings.ToLower(words[0]), ".exe"), "curl") {
		return model.Request{}, nil, ErrNotCurl
	}
	p := &parser{warnings: res.warnings, noted: map[string]bool{}}
	if err := p.options(words[1:]); err != nil {
		return model.Request{}, p.warnings, err
	}
	if len(p.urls) == 0 {
		return model.Request{}, p.warnings, ErrMissingURL
	}
	if len(p.urls) > 1 {
		p.warn("", "The command has %d URLs; only the first one was imported.", len(p.urls))
	}
	return p.request(), p.warnings, nil
}

func (p *parser) options(args []string) error {
	urlsOnly := false
	for i := 0; i < len(args); i++ {
		a := args[i]
		next := func(name string) (string, error) {
			if i+1 >= len(args) {
				return "", fmt.Errorf("%w: %s", ErrMissingArgument, name)
			}
			i++
			return args[i], nil
		}
		switch {
		case urlsOnly || a == "" || a == "-" || a[0] != '-':
			p.urls = append(p.urls, a)
		case a == "--":
			urlsOnly = true
		case strings.HasPrefix(a, "--"):
			name, value, hasValue := strings.Cut(a[2:], "=")
			o := byLong[name]
			if o == nil {
				// curl also accepts --no-<flag> to turn a flag off.
				if base := strings.TrimPrefix(name, "no-"); base != name && byLong[base] != nil && byLong[base].kind == optFlag {
					continue
				}
				p.warn("--"+name, "Unknown option --%s was ignored.", name)
				continue
			}
			if o.kind == optValue && !hasValue {
				v, err := next("--" + name)
				if err != nil {
					return err
				}
				value = v
			}
			p.apply(o, "--"+name, value)
		default:
			// One or more short options: -sSL, -XPOST, -H value.
			for j := 1; j < len(a); j++ {
				c := a[j]
				o := byShort[c]
				if o == nil {
					p.warn("-"+string(c), "Unknown option -%c was ignored.", c)
					continue
				}
				if o.kind == optFlag {
					p.apply(o, "-"+string(c), "")
					continue
				}
				value := a[j+1:]
				if value == "" {
					v, err := next("-" + string(c))
					if err != nil {
						return err
					}
					value = v
				}
				p.apply(o, "-"+string(c), value)
				break
			}
		}
	}
	return nil
}

func (p *parser) apply(o *option, name, value string) {
	switch o.long {
	case "request":
		p.method = strings.ToUpper(strings.TrimSpace(value))
	case "header":
		p.header(name, value)
	case "data", "data-ascii", "data-binary":
		if strings.HasPrefix(value, "@") {
			p.fileData(name, o.long, value[1:])
			return
		}
		p.data = append(p.data, dataPart{text: value, opt: o.long})
	case "data-raw":
		p.data = append(p.data, dataPart{text: value, opt: o.long})
	case "data-urlencode":
		p.urlencoded(name, value)
	case "json":
		p.jsonData = true
		if strings.HasPrefix(value, "@") {
			p.fileData(name, o.long, value[1:])
			return
		}
		p.data = append(p.data, dataPart{text: value, opt: o.long})
	case "form":
		p.formPart(name, value, false)
	case "form-string":
		p.formPart(name, value, true)
	case "user":
		user, pass, ok := strings.Cut(value, ":")
		if !ok {
			p.warn(name, "No password was given for %q (curl would ask for one); the password is empty.", user)
		}
		p.auth = model.Auth{Type: model.AuthBasic, Username: user, Password: pass}
	case "cookie":
		if !strings.Contains(value, "=") {
			p.warn(name, "Reading cookies from a file isn't supported; %q was ignored.", value)
			return
		}
		p.headers = append(p.headers, model.KeyValue{Key: "Cookie", Value: value, Enabled: true})
	case "user-agent":
		p.headers = append(p.headers, model.KeyValue{Key: "User-Agent", Value: value, Enabled: true})
	case "referer":
		p.headers = append(p.headers, model.KeyValue{Key: "Referer", Value: strings.TrimSuffix(value, ";auto"), Enabled: true})
	case "url":
		p.urls = append(p.urls, value)
	case "url-query":
		p.urlQuery(value)
	case "oauth2-bearer":
		p.auth = model.Auth{Type: model.AuthBearer, Token: value}
	case "get":
		p.get = true
	case "head":
		p.head = true
	default:
		if !o.quiet && o.note != "" {
			p.note(name, o)
		}
	}
}

func (p *parser) header(name, value string) {
	if strings.HasPrefix(value, "@") {
		p.warn(name, "Reading headers from a file isn't supported; %q was ignored.", value)
		return
	}
	key, val, ok := strings.Cut(value, ":")
	key = strings.TrimSpace(key)
	if !ok {
		// "Name;" sends the header with an empty value.
		if k, found := strings.CutSuffix(key, ";"); found && k != "" {
			p.headers = append(p.headers, model.KeyValue{Key: strings.TrimSpace(k), Enabled: true})
			return
		}
		p.warn(name, "The header %q has no colon and was ignored.", value)
		return
	}
	val = strings.TrimSpace(val)
	if val == "" {
		p.warn(name, "%q removes a header curl adds by itself; it was ignored.", key+":")
		return
	}
	p.headers = append(p.headers, model.KeyValue{Key: key, Value: val, Enabled: true})
}

func (p *parser) fileData(name, long, path string) {
	if path == "-" {
		p.warn(name, "Data from standard input (@-) can't be imported and was ignored.")
		return
	}
	if long == "data" || long == "data-ascii" {
		p.warn(name, "%s @%s reads the file into the body; Pakpos sends the file as it is (curl would strip line breaks).", name, path)
	}
	p.data = append(p.data, dataPart{file: path, opt: long})
}

func (p *parser) urlencoded(name, value string) {
	// Forms: content, =content, name=content, @file, name@file.
	eq := strings.IndexByte(value, '=')
	at := strings.IndexByte(value, '@')
	if at >= 0 && (eq < 0 || at < eq) {
		p.warn(name, "--data-urlencode with a file (%q) isn't supported and was ignored.", value)
		return
	}
	var text string
	switch {
	case eq < 0:
		text = escapeStrict(value)
	case eq == 0:
		text = escapeStrict(value[1:])
	default:
		text = value[:eq] + "=" + escapeStrict(value[eq+1:])
	}
	p.data = append(p.data, dataPart{text: text, opt: "data-urlencode"})
}

func escapeStrict(s string) string { return strings.ReplaceAll(url.QueryEscape(s), "+", "%20") }

func (p *parser) urlQuery(value string) {
	if raw, ok := strings.CutPrefix(value, "+"); ok {
		p.query = append(p.query, urlx.ParseQuery(raw)...)
		return
	}
	key, val, _ := strings.Cut(value, "=")
	p.query = append(p.query, model.KeyValue{Key: key, Value: val, Enabled: true})
}

func (p *parser) formPart(name, value string, literal bool) {
	key, val, ok := strings.Cut(value, "=")
	if !ok {
		p.warn(name, "The form field %q has no '=' and was ignored.", value)
		return
	}
	f := model.FormField{Key: key, Kind: model.FormText, Enabled: true}
	if literal {
		f.Value = val
		p.form = append(p.form, f)
		return
	}
	switch {
	case strings.HasPrefix(val, "@"), strings.HasPrefix(val, "<"):
		path, params := formValue(val[1:])
		f.Kind, f.FilePath = model.FormFile, path
		if val[0] == '<' {
			p.warn(name, "The field %q reads its text from %s; it was imported as a file part.", key, path)
		}
		p.formParams(name, &f, params)
	default:
		text, params := formValue(val)
		f.Value = text
		p.formParams(name, &f, params)
	}
	p.form = append(p.form, f)
}

type param struct{ key, value string }

func (p *parser) formParams(name string, f *model.FormField, params []param) {
	for _, kv := range params {
		k, v := kv.key, kv.value
		switch k {
		case "type":
			f.ContentType = v
		case "filename":
			p.warn(name, "The file name %q for field %q isn't imported; the file's own name is sent.", v, f.Key)
		default:
			p.warn(name, "The form option %q for field %q isn't supported and was ignored.", k, f.Key)
		}
	}
}

var formParamRe = regexp.MustCompile(`^;\s*(type|filename|headers|encoder)=`)

// formValue splits a -F value into the value (or path) and its ;type= and
// ;filename= parameters. The value may be "quoted" (with \" and \\ escapes).
func formValue(s string) (string, []param) {
	var value, rest string
	if strings.HasPrefix(s, `"`) {
		var b strings.Builder
		i := 1
		for ; i < len(s) && s[i] != '"'; i++ {
			if s[i] == '\\' && i+1 < len(s) {
				i++
			}
			b.WriteByte(s[i])
		}
		value, rest = b.String(), s[min(i+1, len(s)):]
	} else {
		// The value ends at the first ";name=" that curl knows.
		end := len(s)
		for i := 0; i < len(s); i++ {
			if s[i] == ';' && formParamRe.MatchString(s[i:]) {
				end = i
				break
			}
		}
		value, rest = s[:end], s[end:]
	}
	var params []param
	for rest != "" {
		rest = strings.TrimPrefix(rest, ";")
		seg, after, _ := strings.Cut(rest, ";")
		k, v, _ := strings.Cut(strings.TrimSpace(seg), "=")
		if k != "" {
			params = append(params, param{k, strings.Trim(v, `"`)})
		}
		rest = after
	}
	return value, params
}

// request assembles the request from what the options said.
func (p *parser) request() model.Request {
	req := model.Request{
		Method: "GET",
		Body:   model.Body{Type: model.BodyNone},
		Auth:   p.auth,
	}
	if req.Auth.Type == "" {
		req.Auth.Type = model.AuthNone
	}
	rawURL := strings.TrimSpace(p.urls[0])
	query := urlx.QueryFromURL(rawURL)
	query = append(query, p.query...)

	headers := append([]model.KeyValue{}, p.headers...)
	hasBody := len(p.data) > 0 || len(p.form) > 0
	if p.get && len(p.data) > 0 {
		query = append(query, urlx.ParseQuery(p.joinData())...)
		hasBody = len(p.form) > 0
	} else if len(p.data) > 0 && len(p.form) == 0 {
		req.Body, headers = p.dataBody(headers)
	}
	if len(p.form) > 0 {
		if len(p.data) > 0 && !p.get {
			p.warn("-F", "The command has both data and form fields; only the form fields were imported.")
		}
		req.Body = model.Body{Type: model.BodyFormData, FormData: p.form}
		headers = dropHeader(headers, func(v string) bool { return mediaType(v) == "multipart/form-data" })
	}
	if p.jsonData {
		headers = addDefault(headers, "Accept", "application/json")
	}

	switch {
	case p.method != "":
		req.Method = p.method
	case p.head:
		req.Method = "HEAD"
	case hasBody:
		req.Method = "POST"
	}

	req.Headers, req.Auth = authFromHeader(headers, req.Auth)
	if len(p.query) > 0 || (p.get && len(p.data) > 0) {
		rawURL = urlx.WithQuery(rawURL, query)
	}
	req.URL = rawURL
	req.Query = query
	req.PathParams = urlx.SyncPathParams(rawURL, nil)
	return req
}

func (p *parser) joinData() string {
	parts := make([]string, 0, len(p.data))
	for _, d := range p.data {
		if d.file != "" {
			p.warn("--"+d.opt, "Data from the file %s can't be added to the query and was ignored.", d.file)
			continue
		}
		parts = append(parts, d.text)
	}
	sep := "&"
	if p.jsonData {
		sep = ""
	}
	return strings.Join(parts, sep)
}

func (p *parser) dataBody(headers []model.KeyValue) (model.Body, []model.KeyValue) {
	ct := headerValue(headers, "Content-Type")
	if p.jsonData && ct == "" {
		ct = "application/json"
		headers = append(headers, model.KeyValue{Key: "Content-Type", Value: ct, Enabled: true})
	}

	// A file: the binary body (other data next to it is dropped).
	for _, d := range p.data {
		if d.file == "" {
			continue
		}
		if len(p.data) > 1 {
			p.warn("--"+d.opt, "The command combines a file with other data; only the file %s was imported.", d.file)
		}
		headers = dropHeader(headers, func(v string) bool { return sameType(v, "application/octet-stream") })
		return model.Body{Type: model.BodyBinary, BinaryPath: d.file}, headers
	}

	data := p.joinData()
	mt := mediaType(ct)
	raw := func(lang model.RawLanguage) (model.Body, []model.KeyValue) {
		def := model.RawContentType(lang)
		return model.Body{Type: model.BodyRaw, Language: lang, Raw: data},
			dropHeader(headers, func(v string) bool { return sameType(v, def) })
	}
	switch {
	case mt == "":
		trimmed := strings.TrimSpace(data)
		if (strings.HasPrefix(trimmed, "{") || strings.HasPrefix(trimmed, "[")) && json.Valid([]byte(trimmed)) {
			p.warn("", "The data is JSON but no Content-Type was given (curl would send it as a form), so it was imported as JSON.")
			return model.Body{Type: model.BodyRaw, Language: model.LangJSON, Raw: data}, headers
		}
		if looksLikeForm(data) {
			return model.Body{Type: model.BodyURLEncoded, URLEncoded: urlx.ParseQuery(data)}, headers
		}
		p.warn("", "The data isn't in name=value form, so it was imported as text (curl would send it as application/x-www-form-urlencoded).")
		return model.Body{Type: model.BodyRaw, Language: model.LangText, Raw: data}, headers
	case mt == "application/x-www-form-urlencoded":
		return model.Body{Type: model.BodyURLEncoded, URLEncoded: urlx.ParseQuery(data)},
			dropHeader(headers, func(v string) bool { return sameType(v, "application/x-www-form-urlencoded") })
	case mt == "multipart/form-data":
		if fields, ok := p.multipart(ct, data); ok {
			return model.Body{Type: model.BodyFormData, FormData: fields},
				dropHeader(headers, func(v string) bool { return mediaType(v) == "multipart/form-data" })
		}
		p.warn("", "The multipart data couldn't be read, so it was imported as text.")
		return model.Body{Type: model.BodyRaw, Language: model.LangText, Raw: data}, headers
	case mt == "application/json" || strings.HasSuffix(mt, "+json"):
		return raw(model.LangJSON)
	case mt == "application/xml" || mt == "text/xml" || strings.HasSuffix(mt, "+xml"):
		return raw(model.LangXML)
	case mt == "text/html":
		return raw(model.LangHTML)
	case mt == "application/javascript" || mt == "text/javascript":
		return raw(model.LangJavaScript)
	default:
		return raw(model.LangText)
	}
}

// multipart reads multipart data (e.g. Chrome's --data-raw of a form) into
// form fields. File parts keep the file name as their path, with a warning,
// since the file's contents aren't in the command.
func (p *parser) multipart(ct, data string) ([]model.FormField, bool) {
	_, params, err := mime.ParseMediaType(ct)
	if err != nil || params["boundary"] == "" {
		return nil, false
	}
	r := multipart.NewReader(strings.NewReader(data), params["boundary"])
	fields := []model.FormField{}
	for {
		part, err := r.NextPart()
		if err == io.EOF {
			break
		}
		if err != nil {
			return nil, false
		}
		body, err := io.ReadAll(part)
		if err != nil {
			return nil, false
		}
		f := model.FormField{Key: part.FormName(), Kind: model.FormText, Enabled: true}
		if name := part.FileName(); name != "" {
			f.Kind, f.FilePath = model.FormFile, name
			if t := part.Header.Get("Content-Type"); t != "" && t != "application/octet-stream" {
				f.ContentType = t
			}
			p.warn("", "The file for field %q isn't in the command; choose %s again before sending.", f.Key, name)
		} else {
			f.Value = string(bytes.TrimSuffix(body, []byte("\r\n")))
			if t := part.Header.Get("Content-Type"); t != "" {
				f.ContentType = t
			}
		}
		fields = append(fields, f)
	}
	return fields, len(fields) > 0
}

var formPairRe = regexp.MustCompile(`^[^=&\s]+(=[^&\s]*)?$`)

// looksLikeForm reports whether every &-separated part is name or name=value
// without whitespace.
func looksLikeForm(data string) bool {
	if data == "" {
		return true
	}
	for _, part := range strings.Split(data, "&") {
		if part != "" && !formPairRe.MatchString(part) {
			return false
		}
	}
	return true
}

// mediaType is the lower-case media type of a Content-Type value.
func mediaType(v string) string {
	t, _, _ := strings.Cut(v, ";")
	return strings.ToLower(strings.TrimSpace(t))
}

// sameType compares two Content-Type values, ignoring case and spaces.
func sameType(a, b string) bool {
	norm := func(s string) string { return strings.ToLower(strings.ReplaceAll(s, " ", "")) }
	return norm(a) == norm(b)
}

func headerValue(headers []model.KeyValue, name string) string {
	v := ""
	for _, h := range headers {
		if h.Enabled && strings.EqualFold(h.Key, name) {
			v = h.Value
		}
	}
	return v
}

// dropHeader removes the Content-Type rows whose value matches.
func dropHeader(headers []model.KeyValue, match func(string) bool) []model.KeyValue {
	out := headers[:0:0]
	for _, h := range headers {
		if strings.EqualFold(h.Key, "Content-Type") && match(h.Value) {
			continue
		}
		out = append(out, h)
	}
	return out
}

func addDefault(headers []model.KeyValue, name, value string) []model.KeyValue {
	if headerValue(headers, name) != "" {
		return headers
	}
	return append(headers, model.KeyValue{Key: name, Value: value, Enabled: true})
}

// authFromHeader turns a single Bearer or Basic Authorization header into
// auth. It wins over -u, as an explicit header does in curl.
func authFromHeader(headers []model.KeyValue, a model.Auth) ([]model.KeyValue, model.Auth) {
	idx := -1
	for i, h := range headers {
		if strings.EqualFold(h.Key, "Authorization") {
			if idx >= 0 {
				return headers, a
			}
			idx = i
		}
	}
	if idx < 0 {
		return headers, a
	}
	scheme, cred, _ := strings.Cut(strings.TrimSpace(headers[idx].Value), " ")
	cred = strings.TrimSpace(cred)
	rest := append(append([]model.KeyValue{}, headers[:idx]...), headers[idx+1:]...)
	switch {
	case strings.EqualFold(scheme, "Bearer") && cred != "":
		return rest, model.Auth{Type: model.AuthBearer, Token: cred}
	case strings.EqualFold(scheme, "Basic"):
		dec, err := base64.StdEncoding.DecodeString(cred)
		if err != nil || !utf8.Valid(dec) {
			break
		}
		user, pass, ok := strings.Cut(string(dec), ":")
		if !ok {
			break
		}
		return rest, model.Auth{Type: model.AuthBasic, Username: user, Password: pass}
	}
	// Any other scheme stays a header; it wins over -u.
	if a.Type == model.AuthBasic {
		a = model.Auth{Type: model.AuthNone}
	}
	return headers, a
}

// Message explains a Parse error to the user.
func Message(err error) string {
	switch {
	case errors.Is(err, ErrNotCurl):
		return "This isn't a curl command. Paste a command that starts with curl."
	case errors.Is(err, ErrUnclosedQuote):
		return "A quote in the command isn't closed. Check that the whole command was copied."
	case errors.Is(err, ErrMissingURL):
		return "The command has no URL. Add the URL to import it."
	case errors.Is(err, ErrMissingArgument):
		return fmt.Sprintf("An option is missing its value (%s). Check that the whole command was copied.",
			strings.TrimPrefix(err.Error(), ErrMissingArgument.Error()+": "))
	default:
		return "Couldn't read the curl command: " + err.Error()
	}
}

// maxNamePath is how many characters of the path a suggested name keeps.
const maxNamePath = 48

// SuggestName names an imported request after its method and URL path,
// e.g. "POST /v2/orders": no scheme, host, query or fragment; {{variables}}
// are kept as written; "/" for an empty path. A long path keeps its first
// segment and as many trailing segments as fit, joined by "/…".
func SuggestName(req model.Request) string {
	method := strings.ToUpper(strings.TrimSpace(req.Method))
	if method == "" {
		method = "GET"
	}
	return method + " " + shortPath(urlPath(req.URL))
}

// urlPath is the path of a raw URL as typed (it may start with {{baseUrl}}).
func urlPath(raw string) string {
	base, _, _, _ := urlx.Split(strings.TrimSpace(raw))
	if i := strings.Index(base, "://"); i >= 0 {
		base = base[i+3:]
	}
	i := strings.IndexByte(base, '/')
	if i < 0 {
		return "/"
	}
	return base[i:]
}

func shortPath(p string) string {
	if utf8.RuneCountInString(p) <= maxNamePath {
		return p
	}
	segs := strings.Split(strings.TrimPrefix(p, "/"), "/")
	head := "/" + segs[0]
	tail := ""
	for i := len(segs) - 1; i > 0; i-- {
		next := "/" + segs[i] + tail
		if utf8.RuneCountInString(head+"/…"+next) > maxNamePath {
			break
		}
		tail = next
	}
	if tail == "" || utf8.RuneCountInString(head) > maxNamePath/2 {
		// One huge segment: cut it.
		r := []rune(p)
		return string(r[:maxNamePath-1]) + "…"
	}
	return head + "/…" + tail
}
