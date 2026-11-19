package pipeline

import (
	"bytes"
	"encoding/base64"
	"errors"
	"net/url"
	"slices"
	"strings"
	"unicode/utf8"

	"pakpos/internal/core/model"
	"pakpos/internal/core/vars"
	"pakpos/internal/store/fsstore"
)

// MinSecretLength is the shortest secret value looked for in examples:
// shorter values match too much ordinary text to be useful.
const MinSecretLength = 4

// SecretValue is a secret variable with its stored value. It must never be
// written, logged or returned to the UI.
type SecretValue struct {
	Name  string
	Value string
}

// ErrBinarySecret is returned by MaskExample when a secret is in a body that
// isn't text, so it can't be replaced with {{name}}.
var ErrBinarySecret = errors.New("a secret value is in a binary response body")

// SecretValues returns the secret variables visible to the saved request
// requestID with the environment envID, that have a stored value: from the
// globals, the request's collection and the environment (shadowed ones
// too, since their value could still show up). locked is true when some
// couldn't be read because the secret store is locked; the list is then
// incomplete.
func (s *Session) SecretValues(requestID, envID string) (values []SecretValue, locked bool) {
	return s.secretValues(model.Request{ID: requestID}, "", envID)
}

// secretValues is SecretValues for req sent from parentID (see Chain), so a
// draft's collection secrets count too.
func (s *Session) secretValues(req model.Request, parentID, envID string) (values []SecretValue, locked bool) {
	chain := s.Chain(req, parentID)
	scopes := s.BuildScopes(collectionOf(chain), s.Environment(envID))
	for _, sc := range scopes.List {
		for _, v := range sc.Variables {
			if v.Secret && v.Enabled && len(v.Value) >= MinSecretLength {
				values = append(values, SecretValue{Name: v.Key, Value: v.Value})
			}
		}
	}
	// Longest first, so a value containing another is replaced whole.
	slices.SortStableFunc(values, func(a, b SecretValue) int { return len(b.Value) - len(a.Value) })
	return values, len(scopes.Locked) > 0
}

// ExampleSecrets is SecretValues plus the encoded forms a response could echo
// them in (see EncodedForms), and, when the request sent was authenticated
// with Basic auth whose username or password holds a secret, the base64 of
// "username:password" as it went into the Authorization header. sent is the
// request as written for that send (the history entry's request); it is
// resolved like Send resolves it. Every form keeps its secret's name, so the
// UI names the secret and masking writes {{name}} in its place. Longest first.
func (s *Session) ExampleSecrets(requestID, envID string, sent model.Request) (values []SecretValue, locked bool) {
	sent.ID = requestID
	return s.SendSecrets(sent, "", envID)
}

// SendSecrets is ExampleSecrets for a send of req from parentID (a draft's
// collection or folder, see Chain): every form in which a secret could have
// gone over the wire or come back. Longest first.
func (s *Session) SendSecrets(req model.Request, parentID, envID string) (values []SecretValue, locked bool) {
	plain, locked := s.secretValues(req, parentID, envID)
	tokens, tokensLocked := s.tokenSecrets(req, parentID)
	plain = append(plain, tokens...)
	locked = locked || tokensLocked
	p, perr := s.Prepare(req, parentID, envID)
	if perr == nil {
		plain = append(plain, AuthSecrets(p.Request.Auth)...)
	}
	values = append(values, plain...)
	values = append(values, EncodedForms(plain)...)
	if perr == nil && p.Request.Auth.Type == model.AuthBasic {
		a := p.Request.Auth
		if name := secretIn(plain, a.Password, a.Username); name != "" {
			creds := []byte(a.Username + ":" + a.Password)
			values = append(values,
				SecretValue{Name: name, Value: base64.StdEncoding.EncodeToString(creds)},
				SecretValue{Name: name, Value: base64.RawStdEncoding.EncodeToString(creds)})
		}
	}
	values = dedupe(values)
	slices.SortStableFunc(values, func(a, b SecretValue) int { return len(b.Value) - len(a.Value) })
	return values, locked
}

// AuthSecrets returns the resolved values of the secret-bearing fields of
// the auth types Tier 3 added (Digest and NTLM passwords, the AWS secret
// key and session token, the JWT signing key, the Hawk key), so a value
// typed in as is (not a secret variable) is masked too. Each is named
// after its field. Values shorter than MinSecretLength are left out.
func AuthSecrets(a model.Auth) []SecretValue {
	var out []SecretValue
	add := func(name, v string) {
		if len(v) >= MinSecretLength {
			out = append(out, SecretValue{Name: name, Value: v})
		}
	}
	switch {
	case a.Type == model.AuthDigest && a.Digest != nil:
		add("digestPassword", a.Digest.Password)
	case a.Type == model.AuthAWSV4 && a.AWSV4 != nil:
		add("awsSecretKey", a.AWSV4.SecretKey)
		add("awsSessionToken", a.AWSV4.SessionToken)
	case a.Type == model.AuthJWT && a.JWT != nil:
		add("jwtSecret", a.JWT.Secret)
	case a.Type == model.AuthHawk && a.Hawk != nil:
		add("hawkKey", a.Hawk.Key)
	case a.Type == model.AuthNTLM && a.NTLM != nil:
		add("ntlmPassword", a.NTLM.Password)
	}
	return out
}

// EncodedForms returns the forms of each value that commonly show up when a
// server echoes it: base64 (standard and URL alphabets, padded and not) and
// URL encoding (query, strict query and path escaping) and JSON string
// escaping (as a raw JSON body sends it), where they differ from the value.
// A base64 form only matches the value encoded on its own; inside a longer
// encoded string (such as Basic credentials) the alignment differs, which is
// why ExampleSecrets adds those separately.
func EncodedForms(values []SecretValue) []SecretValue {
	var out []SecretValue
	for _, sv := range values {
		b := []byte(sv.Value)
		for _, form := range []string{
			base64.StdEncoding.EncodeToString(b),
			base64.RawStdEncoding.EncodeToString(b),
			base64.URLEncoding.EncodeToString(b),
			base64.RawURLEncoding.EncodeToString(b),
			url.QueryEscape(sv.Value),
			strings.ReplaceAll(url.QueryEscape(sv.Value), "+", "%20"), // as httpexec sends query rows
			url.PathEscape(sv.Value),
			vars.JSONEscape(sv.Value), // inside a string in a raw JSON body
		} {
			if form != sv.Value && len(form) >= MinSecretLength {
				out = append(out, SecretValue{Name: sv.Name, Value: form})
			}
		}
	}
	return out
}

// secretIn returns the name of the first secret (in the order of values)
// whose value appears in one of fields, or "".
func secretIn(values []SecretValue, fields ...string) string {
	for _, f := range fields {
		for _, sv := range values {
			if strings.Contains(f, sv.Value) {
				return sv.Name
			}
		}
	}
	return ""
}

func dedupe(values []SecretValue) []SecretValue {
	seen := map[SecretValue]bool{}
	out := values[:0:0]
	for _, v := range values {
		if !seen[v] {
			seen[v] = true
			out = append(out, v)
		}
	}
	return out
}

// exampleBody returns the example's body as bytes (decoded when base64) and
// whether it is valid UTF-8 text.
func exampleBody(r fsstore.ExampleResponse) ([]byte, bool) {
	if r.Encoding == model.EncodingBase64 {
		b, err := base64.StdEncoding.DecodeString(r.Body)
		if err != nil {
			return []byte(r.Body), utf8.ValidString(r.Body)
		}
		return b, utf8.Valid(b)
	}
	return []byte(r.Body), true
}

// eachString calls f on every string of ex that is saved: the stored
// request as written, the response headers and the body (a base64 body is
// handled by the callers). f may change the string.
func eachString(ex *fsstore.Example, f func(*string)) {
	kvs := func(list []model.KeyValue) {
		for i := range list {
			f(&list[i].Key)
			f(&list[i].Value)
		}
	}
	r := &ex.Request
	for _, p := range []*string{&r.Name, &r.URL, &r.Body.Raw, &r.Body.BinaryPath,
		&r.Auth.Username, &r.Auth.Password, &r.Auth.Token, &r.Auth.Prefix, &r.Auth.APIKey, &r.Auth.APIValue} {
		f(p)
	}
	if o := r.Auth.OAuth2; o != nil {
		for _, p := range []*string{&o.AuthURL, &o.TokenURL, &o.RedirectURL, &o.ClientID, &o.ClientSecret,
			&o.Scope, &o.Username, &o.Password, &o.HeaderPrefix, &o.QueryParam} {
			f(p)
		}
		kvs(o.ExtraParams)
	}
	if d := r.Auth.Digest; d != nil {
		for _, p := range []*string{&d.Username, &d.Password} {
			f(p)
		}
	}
	if w := r.Auth.AWSV4; w != nil {
		for _, p := range []*string{&w.AccessKey, &w.SecretKey, &w.SessionToken, &w.Region, &w.Service} {
			f(p)
		}
	}
	if j := r.Auth.JWT; j != nil {
		for _, p := range []*string{&j.Secret, &j.Header, &j.Payload, &j.HeaderPrefix, &j.QueryParam} {
			f(p)
		}
	}
	if h := r.Auth.Hawk; h != nil {
		for _, p := range []*string{&h.ID, &h.Key, &h.Ext, &h.App, &h.Dlg} {
			f(p)
		}
	}
	if n := r.Auth.NTLM; n != nil {
		for _, p := range []*string{&n.Username, &n.Password, &n.Domain, &n.Workstation} {
			f(p)
		}
	}
	kvs(r.PathParams)
	kvs(r.Query)
	kvs(r.Headers)
	kvs(r.Body.URLEncoded)
	for i := range r.Body.FormData {
		ff := &r.Body.FormData[i]
		f(&ff.Key)
		f(&ff.Value)
		f(&ff.FilePath)
		f(&ff.ContentType)
	}
	kvs(ex.Response.Headers)
	f(&ex.Response.StatusText)
	f(&ex.Response.ContentType)
}

// ScanExample returns the names of the secrets whose value appears in ex
// (exact substring), in the order of values, without duplicates.
func ScanExample(ex fsstore.Example, values []SecretValue) []string {
	body, _ := exampleBody(ex.Response)
	var texts []string
	copied := copyExample(ex)
	eachString(&copied, func(p *string) { texts = append(texts, *p) })
	var found []string
	for _, sv := range values {
		hit := bytes.Contains(body, []byte(sv.Value)) ||
			slices.ContainsFunc(texts, func(t string) bool { return strings.Contains(t, sv.Value) })
		if hit && !slices.Contains(found, sv.Name) {
			found = append(found, sv.Name)
		}
	}
	return found
}

// MaskExample returns a copy of ex with every secret value replaced by
// {{name}}. A base64 body is replaced in its decoded text and stays base64;
// one that isn't valid UTF-8 and holds a secret returns ErrBinarySecret.
func MaskExample(ex fsstore.Example, values []SecretValue) (fsstore.Example, error) {
	out := copyExample(ex)
	body, text := exampleBody(out.Response)
	replaced := string(body)
	for _, sv := range values {
		if strings.Contains(replaced, sv.Value) {
			if !text {
				return fsstore.Example{}, ErrBinarySecret
			}
			replaced = strings.ReplaceAll(replaced, sv.Value, "{{"+sv.Name+"}}")
		}
	}
	if replaced != string(body) {
		if out.Response.Encoding == model.EncodingBase64 {
			out.Response.Body = base64.StdEncoding.EncodeToString([]byte(replaced))
		} else {
			out.Response.Body = replaced
		}
		out.Response.Size = int64(len(replaced))
	}
	eachString(&out, func(p *string) {
		for _, sv := range values {
			*p = strings.ReplaceAll(*p, sv.Value, "{{"+sv.Name+"}}")
		}
	})
	return out, nil
}

// copyExample deep-copies the slices of ex, so masking never changes the input.
func copyExample(ex fsstore.Example) fsstore.Example {
	r := &ex.Request
	r.PathParams = slices.Clone(r.PathParams)
	r.Query = slices.Clone(r.Query)
	r.Headers = slices.Clone(r.Headers)
	r.Body.URLEncoded = slices.Clone(r.Body.URLEncoded)
	r.Body.FormData = slices.Clone(r.Body.FormData)
	r.Auth = copyAuth(r.Auth)
	ex.Response.Headers = slices.Clone(ex.Response.Headers)
	return ex
}

// copyAuth copies the auth's settings blocks, so masking them never
// changes the input.
func copyAuth(a model.Auth) model.Auth {
	if a.OAuth2 != nil {
		o := *a.OAuth2
		o.ExtraParams = slices.Clone(o.ExtraParams)
		a.OAuth2 = &o
	}
	if a.Digest != nil {
		d := *a.Digest
		a.Digest = &d
	}
	if a.AWSV4 != nil {
		w := *a.AWSV4
		a.AWSV4 = &w
	}
	if a.JWT != nil {
		j := *a.JWT
		a.JWT = &j
	}
	if a.Hawk != nil {
		h := *a.Hawk
		a.Hawk = &h
	}
	if a.NTLM != nil {
		n := *a.NTLM
		a.NTLM = &n
	}
	return a
}
