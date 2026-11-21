package hookserver

import (
	"bytes"
	"context"
	"errors"
	"io"
	"net/http"
	"strings"
	"sync"
	"testing"
	"time"

	"pakpos/internal/core/model"
	"pakpos/internal/core/vars"
	"pakpos/internal/core/webhook"
)

func compiled(t *testing.T, rules ...webhook.Rule) *webhook.Compiled {
	t.Helper()
	w := webhook.New("Test")
	w.Rules = rules
	c, err := webhook.Compile(w)
	if err != nil {
		t.Fatal(err)
	}
	return c
}

type records struct {
	mu   sync.Mutex
	list []Record
}

func (r *records) add(rec Record) {
	r.mu.Lock()
	r.list = append(r.list, rec)
	r.mu.Unlock()
}

func (r *records) all() []Record {
	r.mu.Lock()
	defer r.mu.Unlock()
	return append([]Record{}, r.list...)
}

func send(t *testing.T, method, url, body string, header http.Header) (*http.Response, string) {
	t.Helper()
	req, err := http.NewRequest(method, url, strings.NewReader(body))
	if err != nil {
		t.Fatal(err)
	}
	for k, vs := range header {
		req.Header[k] = vs
	}
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	b, _ := io.ReadAll(resp.Body)
	return resp, string(b)
}

func waitFor(t *testing.T, cond func() bool) {
	t.Helper()
	deadline := time.Now().Add(3 * time.Second)
	for !cond() {
		if time.Now().After(deadline) {
			t.Fatal("condition not met in time")
		}
		time.Sleep(5 * time.Millisecond)
	}
}

func TestServerAnswersAndRecords(t *testing.T) {
	var recs records
	c := compiled(t, webhook.Rule{
		Name: "Fail", Enabled: true,
		Match: webhook.Match{Method: "POST", Path: "/orders/:id"},
		Response: webhook.Response{Status: 402, Body: `{"order": "{{$request.params.id}}", "t": {{$timestamp}}}`,
			Headers: []model.KeyValue{{Key: "X-Pakpos", Value: "yes", Enabled: true}}},
	})
	s, err := Listen(c, recs.add, vars.WithClock(func() time.Time { return time.Unix(5, 0) }))
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	if !strings.HasPrefix(s.URL(), "http://127.0.0.1:") {
		t.Fatalf("URL = %s", s.URL())
	}

	resp, body := send(t, "POST", s.URL()+"/orders/42?x=1&x=2", `{"a":1}`, http.Header{"X-A": {"1", "2"}, "Cf-Connecting-Ip": {"9.9.9.9"}})
	if resp.StatusCode != 402 || body != `{"order": "42", "t": 5}` || resp.Header.Get("X-Pakpos") != "yes" || resp.Header.Get("Content-Type") != "application/json" {
		t.Fatalf("reply = %d %q %v", resp.StatusCode, body, resp.Header)
	}
	resp, body = send(t, "GET", s.URL(), "", nil)
	if resp.StatusCode != 200 || body != "{\"ok\": true}\n" {
		t.Fatalf("default reply = %d %q", resp.StatusCode, body)
	}

	got := recs.all()
	if len(got) != 2 {
		t.Fatalf("records = %d", len(got))
	}
	r := got[0]
	if r.ID == "" || r.Method != "POST" || r.Path != "/orders/42" || r.Query != "x=1&x=2" || string(r.Body) != `{"a":1}` || r.BodySize != 7 ||
		r.RuleName != "Fail" || r.RuleID == "" || r.Status != 402 || r.RemoteAddr != "9.9.9.9" || r.Error != "" || r.DurationMs <= 0 ||
		string(r.ResponseBody) != `{"order": "42", "t": 5}` || r.ReceivedAt.IsZero() {
		t.Errorf("record = %+v", r)
	}
	if r.Headers[0].Name != "Host" {
		t.Errorf("headers = %+v", r.Headers)
	}
	var xa []string
	for _, h := range r.Headers {
		if h.Name == "X-A" {
			xa = append(xa, h.Value)
		}
	}
	if len(xa) != 2 {
		t.Errorf("repeated header = %v", xa)
	}
	if got[1].Path != "/" || got[1].RuleID != "" || got[1].RemoteAddr != "127.0.0.1" {
		t.Errorf("default record = %+v", got[1])
	}

	// New rules apply to the next request.
	s.SetRules(compiled(t, webhook.Rule{Enabled: true, Match: webhook.Match{Path: "/**"}, Response: webhook.Response{Status: 204}}))
	s.SetRules(nil) // ignored
	if resp, _ := send(t, "GET", s.URL()+"/x", "", nil); resp.StatusCode != 204 {
		t.Errorf("after SetRules: %d", resp.StatusCode)
	}
}

func TestServerBodyTooLarge(t *testing.T) {
	var recs records
	s, err := Listen(compiled(t), recs.add)
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	big := bytes.Repeat([]byte("x"), MaxRequestBody+1)
	resp, err := http.Post(s.URL()+"/big", "text/plain", bytes.NewReader(big))
	if err == nil {
		defer resp.Body.Close()
		if resp.StatusCode != http.StatusRequestEntityTooLarge {
			t.Fatalf("status = %d", resp.StatusCode)
		}
	}
	waitFor(t, func() bool { return len(recs.all()) == 1 })
	r := recs.all()[0]
	if r.Error != ErrTextTooLarge || r.Status != 413 || r.BodySize != MaxRequestBody {
		t.Errorf("record = %+v", r.Error)
	}
}

func TestServerChunked(t *testing.T) {
	var recs records
	s, err := Listen(compiled(t), recs.add)
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	// Chunked body: Transfer-Encoding is recorded.
	pr, pw := io.Pipe()
	go func() { _, _ = pw.Write([]byte("chunk")); _ = pw.Close() }()
	resp, err := http.Post(s.URL()+"/c", "text/plain", pr)
	if err != nil {
		t.Fatal(err)
	}
	resp.Body.Close()
	r := recs.all()[0]
	found := false
	for _, h := range r.Headers {
		found = found || (h.Name == "Transfer-Encoding" && h.Value == "chunked")
	}
	if !found || string(r.Body) != "chunk" {
		t.Errorf("chunked record = %+v", r)
	}
}

func TestServerDelayAndClose(t *testing.T) {
	var recs records
	slow := compiled(t, webhook.Rule{Enabled: true, Match: webhook.Match{Path: "/slow"}, Response: webhook.Response{Status: 200, DelayMs: 60_000}},
		webhook.Rule{Enabled: true, Match: webhook.Match{Path: "/short"}, Response: webhook.Response{Status: 201, DelayMs: 20}})
	s, err := Listen(slow, recs.add)
	if err != nil {
		t.Fatal(err)
	}
	if resp, _ := send(t, "GET", s.URL()+"/short", "", nil); resp.StatusCode != 201 {
		t.Fatalf("short delay: %d", resp.StatusCode)
	}
	if d := recs.all()[0].DurationMs; d < 20 {
		t.Errorf("duration %v", d)
	}

	// A client that gives up.
	ctx, cancel := context.WithCancel(context.Background())
	req, _ := http.NewRequestWithContext(ctx, "GET", s.URL()+"/slow", nil)
	errc := make(chan error, 1)
	go func() {
		resp, err := http.DefaultClient.Do(req)
		if err == nil {
			resp.Body.Close()
		}
		errc <- err
	}()
	waitFor(t, func() bool { return activeHandlers(s) == 1 })
	cancel()
	<-errc
	waitFor(t, func() bool { return len(recs.all()) == 2 })
	if e := recs.all()[1].Error; e != ErrTextGone {
		t.Errorf("gone error = %q", e)
	}

	// Close while a reply waits.
	go func() {
		resp, err := http.Get(s.URL() + "/slow")
		if err == nil {
			resp.Body.Close()
		}
	}()
	waitFor(t, func() bool { return activeHandlers(s) == 1 })
	if err := s.Close(); err != nil {
		t.Fatal(err)
	}
	_ = s.Close() // idempotent
	got := recs.all()
	if len(got) != 3 || got[2].Error != ErrTextStopped {
		t.Fatalf("after close: %+v", got)
	}
	// A request reaching the handler after Close gets 503.
	rec := &respRecorder{header: http.Header{}}
	s.serve(rec, mustReq(t))
	if rec.status != http.StatusServiceUnavailable {
		t.Errorf("after close status = %d", rec.status)
	}
}

// activeHandlers counts requests in a handler (waiting on a delay).
func activeHandlers(s *Server) int { return int(s.inFlight.Load()) }

type respRecorder struct {
	header http.Header
	status int
	body   bytes.Buffer
}

func (r *respRecorder) Header() http.Header         { return r.header }
func (r *respRecorder) Write(b []byte) (int, error) { return r.body.Write(b) }
func (r *respRecorder) WriteHeader(s int)           { r.status = s }

func mustReq(t *testing.T) *http.Request {
	req, err := http.NewRequest("GET", "http://x/", nil)
	if err != nil {
		t.Fatal(err)
	}
	return req
}

func TestListenNoRules(t *testing.T) {
	if _, err := Listen(nil, nil); err == nil {
		t.Fatal("Listen(nil) should fail")
	}
}

func TestRemoteAddr(t *testing.T) {
	tests := []struct{ remote, cf, want string }{
		{"127.0.0.1:5", "1.1.1.1", "1.1.1.1"},
		{"10.0.0.1:5", "1.1.1.1", "10.0.0.1"},
		{"[::1]:5", "", "::1"},
		{"weird", "", "weird"},
	}
	for _, tt := range tests {
		r := &http.Request{RemoteAddr: tt.remote, Header: http.Header{}}
		if tt.cf != "" {
			r.Header.Set("CF-Connecting-IP", tt.cf)
		}
		if got := remoteAddr(r); got != tt.want {
			t.Errorf("remoteAddr(%q, %q) = %q", tt.remote, tt.cf, got)
		}
	}
}

var errBoom = errors.New("boom")

type failingBody struct{}

func (failingBody) Read([]byte) (int, error) { return 0, errBoom }
func (failingBody) Close() error             { return nil }

func TestServerBodyReadError(t *testing.T) {
	var recs records
	s, err := Listen(compiled(t), recs.add)
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	req := mustReq(t)
	req.Body = failingBody{}
	rec := &respRecorder{header: http.Header{}}
	s.serve(rec, req)
	if rec.status != http.StatusBadRequest || recs.all()[0].Error != ErrTextRead {
		t.Errorf("status %d, record %+v", rec.status, recs.all())
	}
}
