package model

// BodyEncoding says how Response.Body is encoded for transport to the UI.
type BodyEncoding string

const (
	// EncodingUTF8 means Body holds the text as-is.
	EncodingUTF8 BodyEncoding = "utf8"
	// EncodingBase64 means Body holds standard base64 (binary or non-UTF-8 data).
	EncodingBase64 BodyEncoding = "base64"
)

// BodyKind is a hint for which response viewer to use.
type BodyKind string

const (
	KindJSON   BodyKind = "json"
	KindXML    BodyKind = "xml"
	KindHTML   BodyKind = "html"
	KindImage  BodyKind = "image"
	KindText   BodyKind = "text"
	KindBinary BodyKind = "binary"
	KindEmpty  BodyKind = "empty"
)

// Cookie is a cookie set by the response.
type Cookie struct {
	Name     string `json:"name"`
	Value    string `json:"value"`
	Domain   string `json:"domain"`
	Path     string `json:"path"`
	Expires  string `json:"expires"` // RFC 3339, empty for session cookies
	MaxAge   int    `json:"maxAge"`
	HTTPOnly bool   `json:"httpOnly"`
	Secure   bool   `json:"secure"`
	SameSite string `json:"sameSite"`
}

// Timings breaks down where time went, in milliseconds. Phases that did not
// happen (e.g. DNS for an IP literal, TLS for http, any phase on a reused
// connection) are zero.
type Timings struct {
	DNS     float64 `json:"dns"`
	Connect float64 `json:"connect"`
	TLS     float64 `json:"tls"`
	// TTFB is from sending the request until the first response byte.
	TTFB  float64 `json:"ttfb"`
	Total float64 `json:"total"`
	// ReusedConn is true when a kept-alive connection was used.
	ReusedConn bool `json:"reusedConn"`
}

// Response is what the UI receives after a send.
type Response struct {
	StatusCode int        `json:"statusCode"`
	StatusText string     `json:"statusText"`
	Proto      string     `json:"proto"`
	URL        string     `json:"url"` // final URL after redirects
	Headers    []KeyValue `json:"headers"`
	Cookies    []Cookie   `json:"cookies"`

	ContentType string       `json:"contentType"`
	Kind        BodyKind     `json:"kind"`
	Body        string       `json:"body"`
	Encoding    BodyEncoding `json:"encoding"`
	// Size is the full decoded body size in bytes.
	Size int64 `json:"size"`
	// Truncated is true when Body holds only the first part of the body;
	// the full body is then stored at BodyPath.
	Truncated bool    `json:"truncated"`
	BodyPath  string  `json:"bodyPath"`
	Timings   Timings `json:"timings"`
}
