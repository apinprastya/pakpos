// Package hookserver runs the webhook test server: one local HTTP server
// per running webhook (127.0.0.1 only), answering through the rules of
// core/webhook and handing every request to a sink, plus the Manager that
// starts and stops them and their tunnels. It has no Wails dependency.
package hookserver

import (
	"context"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"sort"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"pakpos/internal/core/model"
	"pakpos/internal/core/vars"
	"pakpos/internal/core/webhook"
)

// MaxRequestBody is the largest request body the server reads; a larger one
// is answered with 413.
const MaxRequestBody = 10 << 20

// Errors recorded on a request that wasn't answered normally.
const (
	ErrTextTooLarge = "Body too large"
	ErrTextStopped  = "Webhook stopped before replying"
	ErrTextGone     = "Sender disconnected before the reply"
	ErrTextRead     = "Couldn't read the body"
)

// Header is one header line; a repeated name is several entries.
type Header struct {
	Name  string `json:"name"`
	Value string `json:"value"`
}

// Record is one request the server received and what it replied.
type Record struct {
	ID         string
	ReceivedAt time.Time
	Method     string
	Path       string
	Query      string
	Headers    []Header
	Body       []byte
	// BodySize is the size read; for a body over MaxRequestBody it is what
	// was read before giving up.
	BodySize   int64
	RemoteAddr string
	RuleID     string
	RuleName   string
	Status     int
	DurationMs float64
	Error      string

	ResponseHeaders []Header
	ResponseBody    []byte
}

// Server is one running webhook's HTTP server.
type Server struct {
	ln    net.Listener
	srv   *http.Server
	rules atomic.Pointer[webhook.Compiled]
	sink  func(Record)
	opts  []vars.Option

	ctx    context.Context // cancelled on Close, ends pending delays
	cancel context.CancelFunc
	wg     sync.WaitGroup
	once   sync.Once
	mu     sync.Mutex // guards closed and wg.Add against Close's Wait
	closed bool
	// inFlight counts requests being handled (tests wait on it).
	inFlight atomic.Int32
}

// Listen starts a server on a random port of 127.0.0.1 answering with c.
// sink (may be nil) gets every request after its reply is written. opts
// configure the dynamic template variables.
func Listen(c *webhook.Compiled, sink func(Record), opts ...vars.Option) (*Server, error) {
	if c == nil {
		return nil, errors.New("no rules to answer with")
	}
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		return nil, fmt.Errorf("start webhook server: %w", err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	s := &Server{ln: ln, sink: sink, opts: opts, ctx: ctx, cancel: cancel}
	s.rules.Store(c)
	s.srv = &http.Server{
		Handler:           http.HandlerFunc(s.serve),
		ReadHeaderTimeout: 10 * time.Second,
		ReadTimeout:       30 * time.Second,
		WriteTimeout:      30*time.Second + webhook.MaxDelayMs*time.Millisecond,
		IdleTimeout:       60 * time.Second,
		BaseContext:       func(net.Listener) context.Context { return ctx },
	}
	go func() { _ = s.srv.Serve(ln) }()
	return s, nil
}

// URL is the server's local base URL (http://127.0.0.1:<port>).
func (s *Server) URL() string { return "http://" + s.ln.Addr().String() }

// SetRules makes the next requests use c.
func (s *Server) SetRules(c *webhook.Compiled) {
	if c != nil {
		s.rules.Store(c)
	}
}

// Close stops the server: pending delays end, open connections close, and
// it returns once every handler has recorded its request.
func (s *Server) Close() error {
	var err error
	s.once.Do(func() {
		s.mu.Lock()
		s.closed = true
		s.mu.Unlock()
		s.cancel()
		err = s.srv.Close()
		s.wg.Wait()
	})
	return err
}

func (s *Server) serve(w http.ResponseWriter, r *http.Request) {
	s.mu.Lock()
	if s.closed {
		s.mu.Unlock()
		http.Error(w, "This webhook is stopped.", http.StatusServiceUnavailable)
		return
	}
	s.wg.Add(1)
	s.inFlight.Add(1)
	s.mu.Unlock()
	defer s.wg.Done()
	defer s.inFlight.Add(-1)
	start := time.Now()
	rec := Record{
		ID:         model.NewID(),
		ReceivedAt: start.UTC(),
		Method:     r.Method,
		Path:       r.URL.Path,
		Query:      r.URL.RawQuery,
		Headers:    requestHeaders(r),
		RemoteAddr: remoteAddr(r),
	}
	if rec.Path == "" {
		rec.Path = "/"
	}
	body, err := io.ReadAll(http.MaxBytesReader(w, r.Body, MaxRequestBody))
	rec.Body, rec.BodySize = body, int64(len(body))
	if err != nil {
		rec.Error, rec.Status = ErrTextRead, http.StatusBadRequest
		msg := "Pakpos couldn't read the request body.\n"
		if _, ok := errors.AsType[*http.MaxBytesError](err); ok {
			rec.Error, rec.Status = ErrTextTooLarge, http.StatusRequestEntityTooLarge
			msg = "The request body is larger than 10 MiB.\n"
		}
		w.Header().Set("Content-Type", "text/plain; charset=utf-8")
		w.Header().Set("Connection", "close")
		w.WriteHeader(rec.Status)
		_, _ = io.WriteString(w, msg)
		rec.ResponseHeaders = headerList(w.Header())
		rec.ResponseBody = []byte(msg)
		s.finish(rec, start)
		return
	}

	req := &webhook.Request{Method: r.Method, Path: rec.Path, Query: r.URL.Query(), Header: r.Header, Body: body}
	sel := s.rules.Load().Select(req)
	if sel.Rule != nil {
		rec.RuleID, rec.RuleName = sel.Rule.ID, sel.Rule.Name
	}
	out := webhook.Render(sel.Response, req, sel.Params, s.opts...)
	rec.Status = out.Status
	if d := sel.Response.DelayMs; d > 0 {
		t := time.NewTimer(time.Duration(d) * time.Millisecond)
		select {
		case <-t.C:
		case <-r.Context().Done():
			t.Stop()
			rec.Error = ErrTextGone
			if s.ctx.Err() != nil {
				rec.Error = ErrTextStopped
			}
			s.finish(rec, start)
			return
		}
	}
	for k, vs := range out.Header {
		for _, v := range vs {
			w.Header().Add(k, v)
		}
	}
	w.WriteHeader(out.Status)
	_, _ = w.Write(out.Body)
	if f, ok := w.(http.Flusher); ok {
		f.Flush()
	}
	rec.ResponseHeaders = headerList(out.Header)
	rec.ResponseBody = out.Body
	s.finish(rec, start)
}

func (s *Server) finish(rec Record, start time.Time) {
	rec.DurationMs = float64(time.Since(start).Microseconds()) / 1000
	if s.sink != nil {
		s.sink(rec)
	}
}

// requestHeaders lists the request's headers sorted by name, with Host
// first (net/http moves it out of the header map).
func requestHeaders(r *http.Request) []Header {
	out := []Header{}
	if r.Host != "" {
		out = append(out, Header{Name: "Host", Value: r.Host})
	}
	out = append(out, headerList(r.Header)...)
	if len(r.TransferEncoding) > 0 {
		out = append(out, Header{Name: "Transfer-Encoding", Value: strings.Join(r.TransferEncoding, ", ")})
	}
	return out
}

func headerList(h http.Header) []Header {
	names := make([]string, 0, len(h))
	for k := range h {
		names = append(names, k)
	}
	sort.Strings(names)
	out := []Header{}
	for _, k := range names {
		for _, v := range h[k] {
			out = append(out, Header{Name: k, Value: v})
		}
	}
	return out
}

// remoteAddr is the sender's IP: CF-Connecting-IP when the request came
// through the tunnel (cloudflared connects from 127.0.0.1), else the peer.
func remoteAddr(r *http.Request) string {
	host, _, err := net.SplitHostPort(r.RemoteAddr)
	if err != nil {
		host = r.RemoteAddr
	}
	if ip := r.Header.Get("Cf-Connecting-Ip"); ip != "" && net.ParseIP(host).IsLoopback() {
		return ip
	}
	return host
}
