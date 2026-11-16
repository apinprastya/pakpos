package model

// Hop is one HTTP exchange of a send as it went over the wire: the first
// request, then one per redirect that was followed. It is what the response
// pane's Debug tab shows. Hops can hold resolved secret values until the
// pipeline masks them; they are never stored in history.
type Hop struct {
	Method string `json:"method"`
	URL    string `json:"url"`
	// RequestHeaders are the header fields in the order they were written,
	// including the ones Go adds (Host, Content-Length, cookies from the jar).
	// HTTP/2 lists its pseudo-headers (":method", ":path"...) in lower case.
	RequestHeaders []KeyValue `json:"requestHeaders"`
	// RequestBody is the start of the body that was sent (MaxHopBody bytes at
	// most): text as is, anything else as base64 (RequestBodyEncoding).
	RequestBody          string       `json:"requestBody"`
	RequestBodyEncoding  BodyEncoding `json:"requestBodyEncoding"`
	RequestBodySize      int64        `json:"requestBodySize"`
	RequestBodyTruncated bool         `json:"requestBodyTruncated"`
	// RequestBodyNote explains a body that isn't shown, e.g. a binary body
	// that held a secret.
	RequestBodyNote string `json:"requestBodyNote"`

	// RemoteAddr is the server address connected to, e.g. "93.184.216.34:443".
	RemoteAddr string `json:"remoteAddr"`
	ReusedConn bool   `json:"reusedConn"`
	// TLS is the negotiated version (e.g. "TLS 1.3"); empty for plain HTTP.
	TLS string `json:"tls"`

	// The response's status line and headers as received (before bodies are
	// decoded). Zero when the hop failed.
	Proto           string     `json:"proto"`
	StatusCode      int        `json:"statusCode"`
	StatusText      string     `json:"statusText"`
	ResponseHeaders []KeyValue `json:"responseHeaders"`
	// Error is why the hop failed, if it did.
	Error string `json:"error"`
}

// MaxHopBody caps the request body kept in a Hop.
const MaxHopBody = 64 << 10
