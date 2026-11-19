// Package model defines the request/response data types shared by the core,
// the stores and the Wails services. It has no dependencies on Wails.
package model

import (
	"crypto/rand"
	"time"

	"github.com/oklog/ulid/v2"
	"gopkg.in/yaml.v3"
)

// NewID returns a new ULID string. ULIDs are sortable by creation time and
// stay stable across renames, so they are used as request/collection IDs.
func NewID() string {
	return ulid.MustNew(ulid.Timestamp(time.Now()), rand.Reader).String()
}

// KeyValue is one row of a key/value table (query params, headers, form fields).
// Disabled rows are kept so the UI can toggle them, but they are never sent.
type KeyValue struct {
	Key     string `json:"key" yaml:"key"`
	Value   string `json:"value" yaml:"value"`
	Enabled bool   `json:"enabled" yaml:"enabled"`
}

// Variable is one row of a variable table (global, collection or environment
// scope). When Secret is true the value lives in the secret store, never in
// the workspace file: Value is omitted from YAML (and cleared when a file is
// read). JSON keeps Value so services can hand a resolved secret to the UI.
type Variable struct {
	Key     string `json:"key" yaml:"key"`
	Value   string `json:"value" yaml:"value"`
	Enabled bool   `json:"enabled" yaml:"enabled"`
	Secret  bool   `json:"secret" yaml:"secret,omitempty"`
}

// variableYAML is Variable's on-disk shape: value is dropped for secrets.
type variableYAML struct {
	Key     string `yaml:"key"`
	Value   string `yaml:"value,omitempty"`
	Enabled bool   `yaml:"enabled"`
	Secret  bool   `yaml:"secret,omitempty"`
}

// MarshalYAML writes the row without its value when it is a secret.
func (v Variable) MarshalYAML() (any, error) {
	out := variableYAML(v)
	if v.Secret {
		out.Value = ""
	}
	return out, nil
}

// UnmarshalYAML reads a row. A value found next to secret: true (e.g. a
// hand-edited file) is dropped, so a secret's value only ever comes from the
// secret store.
func (v *Variable) UnmarshalYAML(node *yaml.Node) error {
	var in variableYAML
	if err := node.Decode(&in); err != nil {
		return err
	}
	*v = Variable(in)
	if v.Secret {
		v.Value = ""
	}
	return nil
}

// Request is a saved or in-progress HTTP request.
type Request struct {
	ID   string `json:"id" yaml:"id"`
	Name string `json:"name" yaml:"name"`
	// Seq orders requests within a collection/folder.
	Seq    int    `json:"seq" yaml:"seq"`
	Method string `json:"method" yaml:"method"`
	// URL as typed by the user. Its query string mirrors Query; when sending,
	// Query is the source of truth (see httpexec.Build).
	URL        string     `json:"url" yaml:"url"`
	PathParams []KeyValue `json:"pathParams" yaml:"pathParams,omitempty"`
	Query      []KeyValue `json:"query" yaml:"query,omitempty"`
	Headers    []KeyValue `json:"headers" yaml:"headers,omitempty"`
	Body       Body       `json:"body" yaml:"body"`
	Auth       Auth       `json:"auth" yaml:"auth"`
	// Settings override the app's network settings for this request only.
	// Unset fields use the app setting; the block is omitted from YAML when
	// nothing is set (a v3-only field: writing it upgrades the manifest).
	Settings RequestSettings `json:"settings" yaml:"settings,omitempty"`
	// Scripts run before the request is sent and after its response (a
	// v3-only field: writing non-empty scripts upgrades the manifest).
	Scripts Scripts `json:"scripts" yaml:"scripts,omitempty"`
}

// Scripts are the JavaScript run before a send (PreRequest) and after its
// response (Test), on a request, a folder or a collection. Empty scripts
// are omitted from YAML; non-empty ones are written as literal block
// scalars so diffs stay readable.
type Scripts struct {
	PreRequest string `json:"preRequest" yaml:"preRequest,omitempty"`
	Test       string `json:"test" yaml:"test,omitempty"`
}

// IsZero reports whether both scripts are empty (yaml omitempty uses it).
func (s Scripts) IsZero() bool { return s.PreRequest == "" && s.Test == "" }

// MarshalYAML writes each non-empty script as a literal block scalar.
func (s Scripts) MarshalYAML() (any, error) {
	node := &yaml.Node{Kind: yaml.MappingNode}
	for _, f := range []struct{ key, value string }{{"preRequest", s.PreRequest}, {"test", s.Test}} {
		if f.value == "" {
			continue
		}
		node.Content = append(node.Content,
			&yaml.Node{Kind: yaml.ScalarNode, Value: f.key},
			&yaml.Node{Kind: yaml.ScalarNode, Tag: "!!str", Value: f.value, Style: yaml.LiteralStyle})
	}
	return node, nil
}

// RequestSettings are per-request overrides of the app's network settings.
// A nil field means "use the app setting".
type RequestSettings struct {
	// TimeoutMs for the whole exchange; 0 means no timeout.
	TimeoutMs       *int  `json:"timeoutMs,omitempty" yaml:"timeoutMs,omitempty"`
	FollowRedirects *bool `json:"followRedirects,omitempty" yaml:"followRedirects,omitempty"`
	MaxRedirects    *int  `json:"maxRedirects,omitempty" yaml:"maxRedirects,omitempty"`
	VerifyTLS       *bool `json:"verifyTls,omitempty" yaml:"verifyTls,omitempty"`
}

// IsZero reports whether no setting is overridden (yaml omitempty uses it).
func (s RequestSettings) IsZero() bool {
	return s.TimeoutMs == nil && s.FollowRedirects == nil && s.MaxRedirects == nil && s.VerifyTLS == nil
}

// BodyType selects how the request body is encoded.
type BodyType string

const (
	BodyNone       BodyType = "none"
	BodyRaw        BodyType = "raw"
	BodyFormData   BodyType = "form-data"
	BodyURLEncoded BodyType = "urlencoded"
	BodyBinary     BodyType = "binary"
)

// RawLanguage is the syntax of a raw body; it drives the default Content-Type.
type RawLanguage string

const (
	LangJSON       RawLanguage = "json"
	LangXML        RawLanguage = "xml"
	LangText       RawLanguage = "text"
	LangHTML       RawLanguage = "html"
	LangJavaScript RawLanguage = "javascript"
)

// FormFieldKind distinguishes text and file parts in multipart form data.
type FormFieldKind string

const (
	FormText FormFieldKind = "text"
	FormFile FormFieldKind = "file"
)

// FormField is one multipart/form-data part.
type FormField struct {
	Key   string        `json:"key" yaml:"key"`
	Kind  FormFieldKind `json:"kind" yaml:"kind"`
	Value string        `json:"value" yaml:"value,omitempty"`
	// FilePath is used when Kind is FormFile.
	FilePath string `json:"filePath" yaml:"filePath,omitempty"`
	// ContentType optionally overrides the part's Content-Type.
	ContentType string `json:"contentType" yaml:"contentType,omitempty"`
	Enabled     bool   `json:"enabled" yaml:"enabled"`
}

// Body is the request body. Only the fields matching Type are used; the
// others are kept so switching type in the UI does not lose data.
type Body struct {
	Type       BodyType    `json:"type" yaml:"type"`
	Raw        string      `json:"raw" yaml:"raw,omitempty"`
	Language   RawLanguage `json:"language" yaml:"language,omitempty"`
	FormData   []FormField `json:"formData" yaml:"formData,omitempty"`
	URLEncoded []KeyValue  `json:"urlEncoded" yaml:"urlEncoded,omitempty"`
	// BinaryPath is the file sent as-is when Type is BodyBinary.
	BinaryPath string `json:"binaryPath" yaml:"binaryPath,omitempty"`
}

// AuthType selects the authorization scheme.
type AuthType string

const (
	AuthNone AuthType = "none"
	// AuthInherit takes auth from the enclosing folder(s) and collection:
	// inherit.Effective walks up from the request and uses the first scope
	// whose type is not inherit, or AuthNone when there is none. Code that
	// sees it unresolved (e.g. auth.Apply) treats it like AuthNone.
	AuthInherit AuthType = "inherit"
	AuthBasic   AuthType = "basic"
	AuthBearer  AuthType = "bearer"
	AuthAPIKey  AuthType = "apikey"
	// AuthOAuth2 sends an access token obtained with OAuth 2.0 (Auth.OAuth2
	// holds the settings). The send pipeline loads the stored token and
	// turns it into a bearer header or a query parameter before sending.
	AuthOAuth2 AuthType = "oauth2"
	// AuthDigest is HTTP Digest auth (RFC 7616, Auth.Digest): the request
	// goes out without auth and is sent again once with the answer to the
	// server's 401 challenge.
	AuthDigest AuthType = "digest"
	// AuthAWSV4 signs the request with AWS Signature Version 4 (Auth.AWSV4).
	AuthAWSV4 AuthType = "awsv4"
	// AuthJWT sends a JSON Web Token signed for each send (Auth.JWT).
	AuthJWT AuthType = "jwt"
	// AuthHawk is Hawk auth (Auth.Hawk): a MAC over the request with a
	// fresh timestamp and nonce per send.
	AuthHawk AuthType = "hawk"
	// AuthNTLM is the NTLM handshake (Auth.NTLM) on a connection of its own.
	AuthNTLM AuthType = "ntlm"
)

// APIKeyLocation says where an API key is sent.
type APIKeyLocation string

const (
	APIKeyInHeader APIKeyLocation = "header"
	APIKeyInQuery  APIKeyLocation = "query"
)

// Auth holds the settings for every auth type; only those matching Type are used.
type Auth struct {
	Type     AuthType `json:"type" yaml:"type"`
	Username string   `json:"username" yaml:"username,omitempty"`
	Password string   `json:"password" yaml:"password,omitempty"`
	Token    string   `json:"token" yaml:"token,omitempty"`
	// Prefix for bearer auth; defaults to "Bearer" when empty.
	Prefix   string         `json:"prefix" yaml:"prefix,omitempty"`
	APIKey   string         `json:"apiKey" yaml:"apiKey,omitempty"`
	APIValue string         `json:"apiValue" yaml:"apiValue,omitempty"`
	APIIn    APIKeyLocation `json:"apiIn" yaml:"apiIn,omitempty"`
	// OAuth2 holds the OAuth 2.0 settings (Tier 3, a v3-only field).
	OAuth2 *OAuth2 `json:"oauth2,omitempty" yaml:"oauth2,omitempty"`
	// The settings of the other Tier 3 auth types (v3-only fields).
	Digest *Digest `json:"digest,omitempty" yaml:"digest,omitempty"`
	AWSV4  *AWSV4  `json:"awsv4,omitempty" yaml:"awsv4,omitempty"`
	JWT    *JWT    `json:"jwt,omitempty" yaml:"jwt,omitempty"`
	Hawk   *Hawk   `json:"hawk,omitempty" yaml:"hawk,omitempty"`
	NTLM   *NTLM   `json:"ntlm,omitempty" yaml:"ntlm,omitempty"`
}

// IsV3 reports whether the auth uses a type or field older builds don't
// know (OAuth 2.0, Digest, AWS Signature v4, JWT, Hawk, NTLM), so writing
// it upgrades the workspace format.
func (a Auth) IsV3() bool {
	switch a.Type {
	case AuthOAuth2, AuthDigest, AuthAWSV4, AuthJWT, AuthHawk, AuthNTLM:
		return true
	}
	return a.OAuth2 != nil || a.Digest != nil || a.AWSV4 != nil || a.JWT != nil || a.Hawk != nil || a.NTLM != nil
}

// Digest configures HTTP Digest auth (RFC 7616). Password usually holds a
// secret. Algorithm and Qop are preferences for when the server offers
// several; the server's challenge decides otherwise.
type Digest struct {
	Username string `json:"username" yaml:"username,omitempty"`
	Password string `json:"password" yaml:"password,omitempty"`
	// Algorithm is "" (the strongest the server offers), MD5, MD5-sess,
	// SHA-256 or SHA-256-sess.
	Algorithm string `json:"algorithm" yaml:"algorithm,omitempty"`
	// Qop is "" (auth when offered) or auth-int (the body is hashed too).
	Qop string `json:"qop" yaml:"qop,omitempty"`
}

// AWSV4 configures AWS Signature Version 4. SecretKey and SessionToken
// usually hold secrets.
type AWSV4 struct {
	AccessKey    string `json:"accessKey" yaml:"accessKey,omitempty"`
	SecretKey    string `json:"secretKey" yaml:"secretKey,omitempty"`
	SessionToken string `json:"sessionToken" yaml:"sessionToken,omitempty"`
	Region       string `json:"region" yaml:"region,omitempty"`
	Service      string `json:"service" yaml:"service,omitempty"`
	// UnsignedPayload signs UNSIGNED-PAYLOAD instead of the body's hash
	// (S3 accepts it; most other services don't).
	UnsignedPayload bool `json:"unsignedPayload" yaml:"unsignedPayload,omitempty"`
}

// JWT configures a JSON Web Token signed for every send. Secret holds the
// HMAC secret or a PEM private key and usually is a secret.
type JWT struct {
	// Algorithm is HS256 ("" too), HS384, HS512, RS256/384/512,
	// PS256/384/512, ES256/384/512 or EdDSA.
	Algorithm string `json:"algorithm" yaml:"algorithm,omitempty"`
	Secret    string `json:"secret" yaml:"secret,omitempty"`
	// SecretBase64 says the HMAC secret is base64 encoded.
	SecretBase64 bool `json:"secretBase64" yaml:"secretBase64,omitempty"`
	// Header is a JSON object of extra header fields (kid, typ...); alg is
	// always the Algorithm's.
	Header string `json:"header" yaml:"header,omitempty"`
	// Payload is the claims as a JSON object; {{variables}} in its string
	// literals are JSON-escaped.
	Payload string `json:"payload" yaml:"payload,omitempty"`
	// DisableIssuedAt leaves out the automatic iat claim. LifetimeSeconds
	// > 0 adds exp = now + lifetime. AddJTI adds a random jti. A claim the
	// payload sets itself is never replaced.
	DisableIssuedAt bool `json:"disableIssuedAt" yaml:"disableIssuedAt,omitempty"`
	LifetimeSeconds int  `json:"lifetimeSeconds" yaml:"lifetimeSeconds,omitempty"`
	AddJTI          bool `json:"addJti" yaml:"addJti,omitempty"`
	// Placement: header ("" too) with HeaderPrefix ("" = Bearer), or query
	// with QueryParam ("" = token).
	Placement    OAuth2Placement `json:"placement" yaml:"placement,omitempty"`
	HeaderPrefix string          `json:"headerPrefix" yaml:"headerPrefix,omitempty"`
	QueryParam   string          `json:"queryParam" yaml:"queryParam,omitempty"`
}

// Hawk configures Hawk auth. Key usually holds a secret.
type Hawk struct {
	ID  string `json:"id" yaml:"id,omitempty"`
	Key string `json:"key" yaml:"key,omitempty"`
	// Algorithm is sha256 ("" too) or sha1.
	Algorithm string `json:"algorithm" yaml:"algorithm,omitempty"`
	Ext       string `json:"ext" yaml:"ext,omitempty"`
	App       string `json:"app" yaml:"app,omitempty"`
	Dlg       string `json:"dlg" yaml:"dlg,omitempty"`
	// PayloadHash adds the hash of the body and its content type.
	PayloadHash bool `json:"payloadHash" yaml:"payloadHash,omitempty"`
}

// NTLM configures the NTLM handshake. Password usually holds a secret.
type NTLM struct {
	Username    string `json:"username" yaml:"username,omitempty"`
	Password    string `json:"password" yaml:"password,omitempty"`
	Domain      string `json:"domain" yaml:"domain,omitempty"`
	Workstation string `json:"workstation" yaml:"workstation,omitempty"`
}

// OAuth2Grant is an OAuth 2.0 grant type.
type OAuth2Grant string

const (
	GrantAuthorizationCode OAuth2Grant = "authorization_code"
	GrantClientCredentials OAuth2Grant = "client_credentials"
	GrantPassword          OAuth2Grant = "password"
	GrantImplicit          OAuth2Grant = "implicit"
)

// OAuth2ClientAuth says how the client id and secret reach the token endpoint.
type OAuth2ClientAuth string

const (
	// ClientAuthBasic sends them in an Authorization: Basic header (default).
	ClientAuthBasic OAuth2ClientAuth = "basic"
	// ClientAuthBody sends client_id and client_secret as form fields.
	ClientAuthBody OAuth2ClientAuth = "body"
)

// OAuth2Placement says where the access token goes on a request.
type OAuth2Placement string

const (
	// PlaceHeader sends "Authorization: <prefix> <token>" (default).
	PlaceHeader OAuth2Placement = "header"
	// PlaceQuery sends the token as a query parameter.
	PlaceQuery OAuth2Placement = "query"
)

// PKCE challenge methods.
const (
	PKCES256  = "S256"
	PKCEPlain = "plain"
)

// OAuth2 configures OAuth 2.0 auth. Every string field may hold
// {{variables}}. ClientSecret and Password usually hold secrets; the UI
// masks literal values and offers to move them to a secret variable.
// Tokens are never stored here (they live in the secret store).
type OAuth2 struct {
	Grant    OAuth2Grant `json:"grant" yaml:"grant,omitempty"`
	AuthURL  string      `json:"authUrl" yaml:"authUrl,omitempty"`
	TokenURL string      `json:"tokenUrl" yaml:"tokenUrl,omitempty"`
	// RedirectURL is the callback of the browser grants: "" means a
	// loopback server on 127.0.0.1 with a random port; otherwise a fixed
	// http://127.0.0.1:<port>/<path> or http://localhost:<port>/<path>.
	RedirectURL  string           `json:"redirectUrl" yaml:"redirectUrl,omitempty"`
	ClientID     string           `json:"clientId" yaml:"clientId,omitempty"`
	ClientSecret string           `json:"clientSecret" yaml:"clientSecret,omitempty"`
	ClientAuth   OAuth2ClientAuth `json:"clientAuth" yaml:"clientAuth,omitempty"`
	Scope        string           `json:"scope" yaml:"scope,omitempty"`
	// Username and Password are the resource owner's (password grant).
	Username string `json:"username" yaml:"username,omitempty"`
	Password string `json:"password" yaml:"password,omitempty"`
	// DisablePKCE turns PKCE off for the authorization code grant (on by
	// default). PKCEMethod is S256 ("" too) or plain.
	DisablePKCE bool   `json:"disablePkce" yaml:"disablePkce,omitempty"`
	PKCEMethod  string `json:"pkceMethod" yaml:"pkceMethod,omitempty"`
	// Placement of the access token: header ("" too) with HeaderPrefix
	// ("" = Bearer), or query with QueryParam ("" = access_token).
	Placement    OAuth2Placement `json:"placement" yaml:"placement,omitempty"`
	HeaderPrefix string          `json:"headerPrefix" yaml:"headerPrefix,omitempty"`
	QueryParam   string          `json:"queryParam" yaml:"queryParam,omitempty"`
	// DisableAutoRefresh stops sends from refreshing an expiring token.
	DisableAutoRefresh bool `json:"disableAutoRefresh" yaml:"disableAutoRefresh,omitempty"`
	// ExtraParams are added to the authorization request and every token
	// request (audience, resource...). Disabled rows are skipped.
	ExtraParams []KeyValue `json:"extraParams" yaml:"extraParams,omitempty"`
}

var rawContentTypes = map[RawLanguage]string{
	LangJSON:       "application/json",
	LangXML:        "application/xml",
	LangHTML:       "text/html; charset=utf-8",
	LangJavaScript: "application/javascript",
	LangText:       "text/plain; charset=utf-8",
}

// RawContentType is the Content-Type sent with a raw body of language lang
// when the user sets none (text for an unknown language).
func RawContentType(lang RawLanguage) string {
	if ct, ok := rawContentTypes[lang]; ok {
		return ct
	}
	return rawContentTypes[LangText]
}

// DefaultContentType is the Content-Type sent with the body when the user
// sets none: by language for raw bodies, the form type for urlencoded,
// application/octet-stream for binary and "multipart/form-data" (the
// boundary is added by whoever writes the parts) for form-data. It is ""
// for no body.
func (b Body) DefaultContentType() string {
	switch b.Type {
	case BodyRaw:
		return RawContentType(b.Language)
	case BodyURLEncoded:
		return "application/x-www-form-urlencoded"
	case BodyBinary:
		return "application/octet-stream"
	case BodyFormData:
		return "multipart/form-data"
	default:
		return ""
	}
}
