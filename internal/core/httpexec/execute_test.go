package httpexec

import (
	"bytes"
	"compress/gzip"
	"context"
	"encoding/base64"
	"fmt"
	"io"
	"log"
	"net"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"sync"
	"testing"
	"time"

	"pakpos/internal/core/model"
)

func TestExecuteMethods(t *testing.T) {
	srv := newEchoServer(t)
	e := newExec(t, nil)
	for _, m := range []string{"GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"} {
		t.Run(m, func(t *testing.T) {
			resp, got := send(t, e, model.Request{Method: m, URL: srv.URL + "/m"})
			if resp.StatusCode != 200 || got.Method != m {
				t.Fatalf("status=%d method=%q", resp.StatusCode, got.Method)
			}
		})
	}
	t.Run("HEAD", func(t *testing.T) {
		resp, _ := send(t, e, model.Request{Method: "HEAD", URL: srv.URL})
		if resp.StatusCode != 200 || resp.Body != "" || resp.Kind != model.KindEmpty {
			t.Fatalf("HEAD response = %+v", resp)
		}
	})
}

func TestExecuteBodies(t *testing.T) {
	srv := newEchoServer(t)
	e := newExec(t, nil)
	upload := writeFile(t, "hello.txt", "file-content")
	binary := writeFile(t, "blob.bin", "\x00\x01\x02binary")

	t.Run("raw json", func(t *testing.T) {
		_, got := send(t, e, model.Request{Method: "POST", URL: srv.URL, Body: model.Body{Type: model.BodyRaw, Raw: `{"a":1}`, Language: model.LangJSON}})
		if got.Body != `{"a":1}` || got.ContentType != "application/json" || got.ContentLen != 7 {
			t.Fatalf("got %+v", got)
		}
	})
	t.Run("urlencoded", func(t *testing.T) {
		_, got := send(t, e, model.Request{Method: "POST", URL: srv.URL, Body: model.Body{Type: model.BodyURLEncoded, URLEncoded: []model.KeyValue{kv("a", "1 2"), off("b", "x"), kv("c", "&")}}})
		if got.Body != "a=1%202&c=%26" || got.ContentType != "application/x-www-form-urlencoded" {
			t.Fatalf("got %+v", got)
		}
	})
	t.Run("binary", func(t *testing.T) {
		_, got := send(t, e, model.Request{Method: "PUT", URL: srv.URL, Body: model.Body{Type: model.BodyBinary, BinaryPath: binary}})
		if got.Body != "\x00\x01\x02binary" || got.ContentType != "application/octet-stream" || got.ContentLen != 9 {
			t.Fatalf("got %+v", got)
		}
	})
	t.Run("form-data streams text and files", func(t *testing.T) {
		_, got := send(t, e, model.Request{Method: "POST", URL: srv.URL, Body: model.Body{Type: model.BodyFormData, FormData: []model.FormField{
			{Key: "name", Kind: model.FormText, Value: "pakpos", Enabled: true},
			{Key: "meta", Kind: model.FormText, Value: `{"x":1}`, ContentType: "application/json", Enabled: true},
			{Key: "skip", Kind: model.FormText, Value: "no"},
			{Key: "  ", Kind: model.FormText, Value: "blank", Enabled: true},
			{Key: "doc", Kind: model.FormFile, FilePath: upload, Enabled: true},
			{Key: "typed", Kind: model.FormFile, FilePath: upload, ContentType: "text/plain", Enabled: true},
		}}})
		if !strings.HasPrefix(got.ContentType, "multipart/form-data; boundary=") || !got.Chunked {
			t.Fatalf("content-type=%q chunked=%v", got.ContentType, got.Chunked)
		}
		if got.Form["name"][0] != "pakpos" || got.Form["meta"][0] != `{"x":1}` || len(got.Form["skip"]) != 0 {
			t.Fatalf("form = %v", got.Form)
		}
		if f := got.Files["doc"]; f.Name != "hello.txt" || f.Content != "file-content" || f.ContentType != "application/octet-stream" {
			t.Fatalf("doc = %+v", f)
		}
		if got.Files["typed"].ContentType != "text/plain" {
			t.Fatalf("typed = %+v", got.Files["typed"])
		}
	})
}

func TestExecuteQueryPathAndAuth(t *testing.T) {
	srv := newEchoServer(t)
	e := newExec(t, nil)
	tests := []struct {
		name      string
		auth      model.Auth
		wantQuery string
		header    string
		want      string
	}{
		{"basic", model.Auth{Type: model.AuthBasic, Username: "u", Password: "p"}, "x=1", "Authorization", "Basic dTpw"},
		{"bearer", model.Auth{Type: model.AuthBearer, Token: "t0k"}, "x=1", "Authorization", "Bearer t0k"},
		{"apikey header", model.Auth{Type: model.AuthAPIKey, APIKey: "X-Key", APIValue: "v"}, "x=1", "X-Key", "v"},
		{"apikey query", model.Auth{Type: model.AuthAPIKey, APIKey: "key", APIValue: "v", APIIn: model.APIKeyInQuery}, "x=1&key=v", "", ""},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			_, got := send(t, e, model.Request{
				URL:        srv.URL + "/users/:id?ignored=1",
				PathParams: []model.KeyValue{kv("id", "42")},
				Query:      []model.KeyValue{kv("x", "1")},
				Auth:       tt.auth,
			})
			if got.Path != "/users/42" || got.RawQuery != tt.wantQuery {
				t.Fatalf("path=%q query=%q", got.Path, got.RawQuery)
			}
			if tt.header != "" && strings.Join(got.Headers[tt.header], ",") != tt.want {
				t.Fatalf("%s = %v, want %q", tt.header, got.Headers[tt.header], tt.want)
			}
		})
	}
}

func TestExecuteResponseMetadata(t *testing.T) {
	expires := time.Date(2030, 1, 2, 3, 4, 5, 0, time.UTC)
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		http.SetCookie(w, &http.Cookie{Name: "sid", Value: "abc", Path: "/", Domain: "example.com", Expires: expires, MaxAge: 60, HttpOnly: true, Secure: true, SameSite: http.SameSiteStrictMode})
		http.SetCookie(w, &http.Cookie{Name: "plain", Value: "1"})
		w.Header().Add("X-B", "2")
		w.Header().Add("X-A", "1")
		w.Header().Add("X-A", "1b")
		w.Header().Set("Content-Type", "text/plain; charset=utf-8")
		w.WriteHeader(http.StatusTeapot)
		_, _ = w.Write([]byte("short and stout"))
	}))
	defer srv.Close()

	resp, _ := send(t, newExec(t, nil), model.Request{URL: srv.URL})
	if resp.StatusCode != 418 || resp.StatusText != "I'm a teapot" || resp.Proto != "HTTP/1.1" {
		t.Fatalf("status = %d %q %q", resp.StatusCode, resp.StatusText, resp.Proto)
	}
	if resp.Body != "short and stout" || resp.Encoding != model.EncodingUTF8 || resp.Kind != model.KindText || resp.Size != 15 {
		t.Fatalf("body = %+v", resp)
	}
	if resp.URL != srv.URL {
		t.Errorf("URL = %q", resp.URL)
	}
	var keys []string
	for _, h := range resp.Headers {
		keys = append(keys, h.Key+"="+h.Value)
	}
	joined := strings.Join(keys, ",")
	if !strings.Contains(joined, "X-A=1,X-A=1b,X-B=2") {
		t.Errorf("headers not sorted/complete: %s", joined)
	}
	if len(resp.Cookies) != 2 {
		t.Fatalf("cookies = %+v", resp.Cookies)
	}
	c := resp.Cookies[0]
	if c.Name != "sid" || c.Domain != "example.com" || c.Expires != "2030-01-02T03:04:05Z" || c.MaxAge != 60 || !c.HTTPOnly || !c.Secure || c.SameSite != "Strict" {
		t.Errorf("cookie = %+v", c)
	}
	if resp.Cookies[1].Expires != "" || resp.Cookies[1].SameSite != "" {
		t.Errorf("session cookie = %+v", resp.Cookies[1])
	}
	if resp.Timings.Total <= 0 || resp.Timings.TTFB <= 0 || resp.Timings.Connect <= 0 {
		t.Errorf("timings = %+v", resp.Timings)
	}
}

func TestExecuteBinaryBodyIsBase64(t *testing.T) {
	png := []byte("\x89PNG\r\n\x1a\n\x00\x00\x00\rIHDR")
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "image/png")
		_, _ = w.Write(png)
	}))
	defer srv.Close()
	resp, _ := send(t, newExec(t, nil), model.Request{URL: srv.URL})
	if resp.Kind != model.KindImage || resp.Encoding != model.EncodingBase64 || resp.Body != base64.StdEncoding.EncodeToString(png) {
		t.Fatalf("resp = %+v", resp)
	}
}

func TestExecuteGzipWithUserAcceptEncoding(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Encoding", "gzip")
		w.Header().Set("Content-Type", "application/json")
		gz := gzip.NewWriter(w)
		_, _ = gz.Write([]byte(`{"ok":true}`))
		_ = gz.Close()
	}))
	defer srv.Close()
	e := newExec(t, nil)
	for _, headers := range [][]model.KeyValue{nil, {kv("Accept-Encoding", "gzip")}} {
		resp, _ := send(t, e, model.Request{URL: srv.URL, Headers: headers})
		if resp.Body != `{"ok":true}` || resp.Kind != model.KindJSON {
			t.Fatalf("headers %v: body = %q kind=%q", headers, resp.Body, resp.Kind)
		}
	}
}

func TestExecuteBadGzip(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Encoding", "gzip")
		_, _ = w.Write([]byte("not gzip"))
	}))
	defer srv.Close()
	_, err := newExec(t, nil).Execute(context.Background(), "", model.Request{URL: srv.URL, Headers: []model.KeyValue{kv("Accept-Encoding", "gzip")}})
	wantKind(t, err, KindNetwork)
}

func TestExecuteLargeBodyIsTruncatedAndSpilled(t *testing.T) {
	// "é" is 2 bytes; with an odd limit the inline cut lands mid-rune.
	full := strings.Repeat("é", 3000)
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "text/plain; charset=utf-8")
		_, _ = w.Write([]byte(full))
	}))
	defer srv.Close()

	e := newExec(t, func(s *Settings) { s.MaxBodyInMemory = 1001 })
	resp, _ := send(t, e, model.Request{URL: srv.URL})
	if !resp.Truncated || resp.Size != int64(len(full)) || resp.Encoding != model.EncodingUTF8 {
		t.Fatalf("resp: truncated=%v size=%d enc=%s", resp.Truncated, resp.Size, resp.Encoding)
	}
	if len(resp.Body) != 1000 || resp.Body != full[:1000] {
		t.Fatalf("inline body length = %d", len(resp.Body))
	}
	data, err := os.ReadFile(resp.BodyPath)
	if err != nil || string(data) != full {
		t.Fatalf("spilled file mismatch: err=%v len=%d", err, len(data))
	}
}

func TestExecuteSpillFailure(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		_, _ = w.Write(bytes.Repeat([]byte("x"), 100))
	}))
	defer srv.Close()
	e := newExec(t, func(s *Settings) { s.MaxBodyInMemory = 10; s.TempDir = "/nonexistent/pakpos-dir" })
	_, err := e.Execute(context.Background(), "", model.Request{URL: srv.URL})
	wantKind(t, err, KindFileNotFound)
}

func redirectServer(t *testing.T) *httptest.Server {
	t.Helper()
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var n int
		if _, err := fmt.Sscanf(r.URL.Path, "/r/%d", &n); err == nil && n > 0 {
			http.Redirect(w, r, fmt.Sprintf("/r/%d", n-1), http.StatusFound)
			return
		}
		_, _ = w.Write([]byte("landed"))
	}))
	t.Cleanup(srv.Close)
	return srv
}

func TestExecuteRedirects(t *testing.T) {
	srv := redirectServer(t)
	t.Run("followed", func(t *testing.T) {
		resp, _ := send(t, newExec(t, nil), model.Request{URL: srv.URL + "/r/3"})
		if resp.StatusCode != 200 || resp.Body != "landed" || resp.URL != srv.URL+"/r/0" {
			t.Fatalf("resp = %d %q %q", resp.StatusCode, resp.Body, resp.URL)
		}
	})
	t.Run("not followed", func(t *testing.T) {
		resp, _ := send(t, newExec(t, func(s *Settings) { s.FollowRedirects = false }), model.Request{URL: srv.URL + "/r/3"})
		if resp.StatusCode != http.StatusFound {
			t.Fatalf("status = %d", resp.StatusCode)
		}
		if !strings.Contains(fmt.Sprint(resp.Headers), "/r/2") {
			t.Fatalf("missing Location header: %v", resp.Headers)
		}
	})
	t.Run("exactly at the limit", func(t *testing.T) {
		resp, _ := send(t, newExec(t, func(s *Settings) { s.MaxRedirects = 2 }), model.Request{URL: srv.URL + "/r/2"})
		if resp.StatusCode != 200 {
			t.Fatalf("status = %d", resp.StatusCode)
		}
	})
	t.Run("over the limit", func(t *testing.T) {
		_, err := newExec(t, func(s *Settings) { s.MaxRedirects = 2 }).Execute(context.Background(), "", model.Request{URL: srv.URL + "/r/3"})
		wantKind(t, err, KindTooManyRedirects)
	})
}

func blockingServer(t *testing.T) (*httptest.Server, <-chan struct{}) {
	t.Helper()
	started := make(chan struct{}, 1)
	srv := httptest.NewServer(http.HandlerFunc(func(_ http.ResponseWriter, r *http.Request) {
		started <- struct{}{}
		<-r.Context().Done()
	}))
	t.Cleanup(srv.Close)
	return srv, started
}

func TestExecuteCancel(t *testing.T) {
	srv, started := blockingServer(t)
	e := newExec(t, nil)

	errc := make(chan error, 1)
	go func() {
		_, err := e.Execute(context.Background(), "send-1", model.Request{URL: srv.URL})
		errc <- err
	}()
	<-started
	if !e.InFlight("send-1") {
		t.Fatal("send-1 should be in flight")
	}

	_, dupErr := e.Execute(context.Background(), "send-1", model.Request{URL: srv.URL})
	wantKind(t, dupErr, KindInvalidRequest)

	if !e.Cancel("send-1") {
		t.Fatal("Cancel returned false")
	}
	wantKind(t, <-errc, KindCanceled)
	if e.InFlight("send-1") || e.Cancel("send-1") {
		t.Fatal("send-1 should be unregistered after completion")
	}
}

func TestCancelIsConcurrencySafe(t *testing.T) {
	srv, started := blockingServer(t)
	e := newExec(t, nil)
	const n = 8
	var wg sync.WaitGroup
	errs := make(chan error, n)
	for i := range n {
		wg.Add(1)
		go func() {
			defer wg.Done()
			_, err := e.Execute(context.Background(), fmt.Sprintf("id-%d", i), model.Request{URL: srv.URL})
			errs <- err
		}()
	}
	for range n {
		<-started
	}
	for i := range n {
		go e.Cancel(fmt.Sprintf("id-%d", i))
	}
	wg.Wait()
	close(errs)
	for err := range errs {
		wantKind(t, err, KindCanceled)
	}
}

func TestExecuteParentContextCanceled(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	_, err := newExec(t, nil).Execute(ctx, "", model.Request{URL: "http://127.0.0.1:1"})
	wantKind(t, err, KindCanceled)
}

func TestExecuteTimeout(t *testing.T) {
	srv, _ := blockingServer(t)
	e := newExec(t, func(s *Settings) { s.Timeout = 50 * time.Millisecond })
	start := time.Now()
	_, err := e.Execute(context.Background(), "", model.Request{URL: srv.URL})
	wantKind(t, err, KindTimeout)
	if time.Since(start) > 5*time.Second {
		t.Fatal("timeout took too long")
	}
}

func TestExecuteTLS(t *testing.T) {
	srv := httptest.NewUnstartedServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		_, _ = w.Write([]byte("secure"))
	}))
	srv.Config.ErrorLog = log.New(io.Discard, "", 0) // expected handshake failures
	srv.StartTLS()
	defer srv.Close()

	_, err := newExec(t, nil).Execute(context.Background(), "", model.Request{URL: srv.URL})
	wantKind(t, err, KindTLS)

	resp, _ := send(t, newExec(t, func(s *Settings) { s.InsecureSkipVerify = true }), model.Request{URL: srv.URL})
	if resp.Body != "secure" || resp.Timings.TLS <= 0 {
		t.Fatalf("resp = %q timings=%+v", resp.Body, resp.Timings)
	}
}

func TestExecuteHTTPToHTTPSPort(t *testing.T) {
	// Speaking HTTPS to a plain HTTP server fails the handshake.
	srv := newEchoServer(t)
	_, err := newExec(t, nil).Execute(context.Background(), "", model.Request{URL: strings.Replace(srv.URL, "http://", "https://", 1)})
	wantKind(t, err, KindTLS)
}

func TestExecuteConnectionRefused(t *testing.T) {
	l, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	addr := l.Addr().String()
	_ = l.Close()
	_, err = newExec(t, nil).Execute(context.Background(), "", model.Request{URL: "http://" + addr})
	wantKind(t, err, KindConnectionRefused)
}

func TestExecuteDNS(t *testing.T) {
	_, err := newExec(t, nil).Execute(context.Background(), "", model.Request{URL: "http://pakpos-test.invalid"})
	wantKind(t, err, KindDNS)
}

func TestExecuteBuildError(t *testing.T) {
	_, err := newExec(t, nil).Execute(context.Background(), "x", model.Request{URL: ""})
	wantKind(t, err, KindInvalidURL)
}

func TestNewAppliesDefaults(t *testing.T) {
	e := New(Settings{})
	s := e.Settings()
	if s.MaxRedirects != 10 || s.MaxBodyInMemory != DefaultMaxBodyInMemory || !strings.HasPrefix(s.UserAgent, "Pakpos/") || s.TempDir == "" {
		t.Fatalf("settings = %+v", s)
	}
	if s.Timeout != 0 || s.FollowRedirects {
		t.Fatalf("explicit zero values should be kept: %+v", s)
	}
	d := DefaultSettings()
	if d.Timeout != 30*time.Second || !d.FollowRedirects {
		t.Fatalf("defaults = %+v", d)
	}
}
