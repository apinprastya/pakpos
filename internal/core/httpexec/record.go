package httpexec

import (
	"context"
	"crypto/tls"
	"encoding/base64"
	"io"
	"net/http"
	"net/http/httptrace"
	"sync"
	"unicode/utf8"

	"pakpos/internal/core/model"
)

// Recorder collects the hops of a send (see model.Hop). Pass it to Execute
// with WithRecorder; read it with Hops once Execute has returned.
type Recorder struct {
	mu   sync.Mutex
	hops []*hopRecord
}

// NewRecorder returns an empty Recorder.
func NewRecorder() *Recorder { return &Recorder{} }

type recorderKey struct{}

// WithRecorder makes sends with ctx record their hops in r.
func WithRecorder(ctx context.Context, r *Recorder) context.Context {
	return context.WithValue(ctx, recorderKey{}, r)
}

func recorderFrom(ctx context.Context) *Recorder {
	r, _ := ctx.Value(recorderKey{}).(*Recorder)
	return r
}

// Hops returns what was recorded, in order. Never nil.
func (r *Recorder) Hops() []model.Hop {
	r.mu.Lock()
	defer r.mu.Unlock()
	out := make([]model.Hop, 0, len(r.hops))
	for _, h := range r.hops {
		out = append(out, h.snapshot())
	}
	return out
}

func (r *Recorder) add(h *hopRecord) {
	r.mu.Lock()
	r.hops = append(r.hops, h)
	r.mu.Unlock()
}

// hopRecord is filled from the transport's goroutines (HTTP/1 writes the
// request on its own), so every access holds mu.
type hopRecord struct {
	mu   sync.Mutex
	hop  model.Hop
	body []byte
}

func (h *hopRecord) snapshot() model.Hop {
	h.mu.Lock()
	defer h.mu.Unlock()
	out := h.hop
	out.RequestHeaders = append([]model.KeyValue{}, h.hop.RequestHeaders...)
	if out.ResponseHeaders == nil {
		out.ResponseHeaders = []model.KeyValue{}
	} else {
		out.ResponseHeaders = append([]model.KeyValue{}, h.hop.ResponseHeaders...)
	}
	out.RequestBodyEncoding = model.EncodingUTF8
	switch {
	case len(h.body) == 0:
	case utf8.Valid(h.body) || (out.RequestBodyTruncated && validPrefix(h.body)):
		out.RequestBody = string(h.body)
	default:
		out.RequestBody = base64.StdEncoding.EncodeToString(h.body)
		out.RequestBodyEncoding = model.EncodingBase64
	}
	return out
}

// validPrefix reports whether b is UTF-8 apart from a rune cut off at the end.
func validPrefix(b []byte) bool {
	for i := 0; i < utf8.UTFMax && len(b) > 0; i++ {
		if utf8.Valid(b) {
			return true
		}
		b = b[:len(b)-1]
	}
	return utf8.Valid(b)
}

// recordingTransport records each round trip of a send whose context
// carries a Recorder; other sends pass straight through.
type recordingTransport struct{ base http.RoundTripper }

func (t recordingTransport) RoundTrip(req *http.Request) (*http.Response, error) {
	rec := recorderFrom(req.Context())
	if rec == nil {
		return t.base.RoundTrip(req)
	}
	h := &hopRecord{hop: model.Hop{Method: req.Method, URL: req.URL.String(), RequestHeaders: []model.KeyValue{}}}
	rec.add(h)
	trace := &httptrace.ClientTrace{
		WroteHeaderField: func(key string, values []string) {
			h.mu.Lock()
			for _, v := range values {
				h.hop.RequestHeaders = append(h.hop.RequestHeaders, model.KeyValue{Key: key, Value: v, Enabled: true})
			}
			h.mu.Unlock()
		},
		GotConn: func(info httptrace.GotConnInfo) {
			h.mu.Lock()
			if info.Conn != nil {
				h.hop.RemoteAddr = info.Conn.RemoteAddr().String()
			}
			h.hop.ReusedConn = info.Reused
			h.mu.Unlock()
		},
	}
	out := req.Clone(httptrace.WithClientTrace(req.Context(), trace))
	if req.Body != nil && req.Body != http.NoBody {
		out.Body = &bodyRecorder{ReadCloser: req.Body, h: h}
	}
	resp, err := t.base.RoundTrip(out)
	h.mu.Lock()
	defer h.mu.Unlock()
	if err != nil {
		h.hop.Error = Classify(err).Message
		return nil, err
	}
	h.hop.Proto, h.hop.StatusCode, h.hop.StatusText = resp.Proto, resp.StatusCode, statusText(resp)
	h.hop.ResponseHeaders = headerRows(resp.Header)
	if resp.TLS != nil {
		h.hop.TLS = tls.VersionName(resp.TLS.Version)
	}
	return resp, nil
}

// bodyRecorder keeps the first model.MaxHopBody bytes of a request body as
// the transport reads it, and counts the rest.
type bodyRecorder struct {
	io.ReadCloser
	h *hopRecord
}

func (b *bodyRecorder) Read(p []byte) (int, error) {
	n, err := b.ReadCloser.Read(p)
	if n > 0 {
		b.h.mu.Lock()
		if room := model.MaxHopBody - len(b.h.body); room > 0 {
			b.h.body = append(b.h.body, p[:min(n, room)]...)
		}
		b.h.hop.RequestBodySize += int64(n)
		b.h.hop.RequestBodyTruncated = b.h.hop.RequestBodySize > int64(len(b.h.body))
		b.h.mu.Unlock()
	}
	return n, err
}
