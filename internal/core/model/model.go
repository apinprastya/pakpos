// Package model defines the request/response data types shared by the core,
// the stores and the Wails services. It has no dependencies on Wails.
package model

import (
	"crypto/rand"
	"time"

	"github.com/oklog/ulid/v2"
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
	// AuthInherit takes auth from the parent folder/collection (Tier 2).
	// Until inheritance is resolved upstream it behaves like AuthNone.
	AuthInherit AuthType = "inherit"
	AuthBasic   AuthType = "basic"
	AuthBearer  AuthType = "bearer"
	AuthAPIKey  AuthType = "apikey"
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
}
