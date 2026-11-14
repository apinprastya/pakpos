package httpexec

import (
	"bytes"
	"compress/flate"
	"compress/gzip"
	"compress/zlib"
	"context"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"strconv"
	"strings"
	"testing"

	"github.com/andybalholm/brotli"

	"pakpos/internal/core/model"
)

func compress(t *testing.T, coding string, data []byte) []byte {
	t.Helper()
	var buf bytes.Buffer
	var w io.WriteCloser
	switch coding {
	case "gzip":
		w = gzip.NewWriter(&buf)
	case "zlib":
		w = zlib.NewWriter(&buf)
	case "raw-deflate":
		fw, err := flate.NewWriter(&buf, flate.DefaultCompression)
		if err != nil {
			t.Fatal(err)
		}
		w = fw
	case "br":
		w = brotli.NewWriter(&buf)
	default:
		t.Fatalf("unknown coding %q", coding)
	}
	if _, err := w.Write(data); err != nil {
		t.Fatal(err)
	}
	if err := w.Close(); err != nil {
		t.Fatal(err)
	}
	return buf.Bytes()
}

// encodedServer answers with body under the given Content-Encoding header and
// records the Accept-Encoding it was sent.
func encodedServer(t *testing.T, header string, body []byte, accept *string) *httptest.Server {
	t.Helper()
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if accept != nil {
			*accept = r.Header.Get("Accept-Encoding")
		}
		if header != "" {
			w.Header().Set("Content-Encoding", header)
		}
		w.Header().Set("Content-Type", "application/json")
		if r.Method != http.MethodHead {
			_, _ = w.Write(body)
		}
	}))
	t.Cleanup(srv.Close)
	return srv
}

func fetch(t *testing.T, e *Executor, req model.Request) *model.Response {
	t.Helper()
	resp, err := e.Execute(context.Background(), "", req)
	if err != nil {
		t.Fatalf("Execute: %v", err)
	}
	return resp
}

func TestExecuteDecodesContentEncodings(t *testing.T) {
	plain := []byte(`{"ok":true,"text":"` + strings.Repeat("pakpos ", 200) + `"}`)
	twice := compress(t, "br", compress(t, "gzip", plain))
	tests := []struct {
		name, header string
		body         []byte
	}{
		{"gzip", "gzip", compress(t, "gzip", plain)},
		{"x-gzip", "x-gzip", compress(t, "gzip", plain)},
		{"deflate (zlib)", "deflate", compress(t, "zlib", plain)},
		{"deflate (raw)", "deflate", compress(t, "raw-deflate", plain)},
		{"br", "br", compress(t, "br", plain)},
		{"upper case", "BR", compress(t, "br", plain)},
		{"gzip then br", "gzip, br", twice},
		{"identity", "identity", plain},
		{"none", "", plain},
	}
	e := newExec(t, nil)
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			var accept string
			srv := encodedServer(t, tt.header, tt.body, &accept)
			resp := fetch(t, e, model.Request{URL: srv.URL})
			if resp.Body != string(plain) || resp.Kind != model.KindJSON || resp.Size != int64(len(plain)) {
				t.Fatalf("body = %.40q… kind=%q size=%d", resp.Body, resp.Kind, resp.Size)
			}
			if accept != AcceptEncoding {
				t.Errorf("Accept-Encoding sent = %q, want %q", accept, AcceptEncoding)
			}
		})
	}
}

func TestExecuteKeepsUserAcceptEncoding(t *testing.T) {
	var accept string
	srv := encodedServer(t, "gzip", compress(t, "gzip", []byte(`{"a":1}`)), &accept)
	resp := fetch(t, newExec(t, nil), model.Request{URL: srv.URL, Headers: []model.KeyValue{kv("Accept-Encoding", "gzip")}})
	if accept != "gzip" || resp.Body != `{"a":1}` {
		t.Fatalf("accept = %q, body = %q", accept, resp.Body)
	}
}

func TestExecuteLeavesUnknownEncodings(t *testing.T) {
	// A coding Pakpos can't undo (it never asks for one) is shown as received.
	for _, header := range []string{"zstd", "gzip, compress"} {
		srv := encodedServer(t, header, []byte("opaque"), nil)
		resp := fetch(t, newExec(t, nil), model.Request{URL: srv.URL})
		if resp.Body != "opaque" {
			t.Errorf("%s: body = %q", header, resp.Body)
		}
	}
}

func TestExecuteEmptyEncodedBody(t *testing.T) {
	// HEAD, 204 and friends carry Content-Encoding with no body.
	for _, header := range []string{"gzip", "deflate", "br"} {
		srv := encodedServer(t, header, nil, nil)
		for _, method := range []string{http.MethodHead, http.MethodGet} {
			resp := fetch(t, newExec(t, nil), model.Request{Method: method, URL: srv.URL})
			if resp.Body != "" || resp.Size != 0 {
				t.Errorf("%s %s: body = %q size=%d", method, header, resp.Body, resp.Size)
			}
		}
	}
}

func TestExecuteLargeEncodedBodyIsSpilledDecoded(t *testing.T) {
	plain := []byte(strings.Repeat("0123456789", 5000))
	srv := encodedServer(t, "br", compress(t, "br", plain), nil)
	e := newExec(t, func(s *Settings) { s.MaxBodyInMemory = 1000 })
	resp := fetch(t, e, model.Request{URL: srv.URL})
	if !resp.Truncated || resp.Size != int64(len(plain)) || len(resp.Body) != 1000 {
		t.Fatalf("truncated=%v size=%d inline=%d", resp.Truncated, resp.Size, len(resp.Body))
	}
}

func TestExecuteCorruptEncodedBody(t *testing.T) {
	good := compress(t, "gzip", []byte(strings.Repeat("x", 4096)))
	tests := []struct {
		name, header string
		body         []byte
		want         string // the coding named in the message; the header when empty
	}{
		{"gzip header", "gzip", []byte("not gzip"), ""},
		{"gzip checksum", "gzip", append(append([]byte{}, good[:len(good)-8]...), 1, 2, 3, 4, 5, 6, 7, 8), ""},
		{"gzip truncated", "gzip", good[:len(good)/2], ""},
		{"deflate", "deflate", []byte{0xff, 0xff, 0xff, 0xff}, ""},
		{"zlib checksum", "deflate", append(compress(t, "zlib", []byte("hello"))[:13], 0, 0, 0, 0), ""},
		{"br", "br", []byte("definitely not brotli, just text that goes on"), ""},
		// The outer coding (br, applied last) is broken: gzip reads it first.
		{"outer br of gzip, br", "gzip, br", []byte("definitely not brotli, just text that goes on"), "br"},
		{"inner gzip of gzip, br", "gzip, br", compress(t, "br", good[:len(good)/2]), "gzip"},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			srv := encodedServer(t, tt.header, tt.body, nil)
			_, err := newExec(t, nil).Execute(context.Background(), "", model.Request{URL: srv.URL})
			wantKind(t, err, KindDecode)
			want := tt.want
			if want == "" {
				want = tt.header
			}
			if !strings.Contains(err.Error(), "couldn't be decoded as "+want+" ") {
				t.Errorf("message = %q", err.Error())
			}
		})
	}
}

func TestExecuteConnectionDropWhileDecodingIsANetworkError(t *testing.T) {
	data := compress(t, "gzip", bytes.Repeat([]byte("abc"), 100000))
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		hj, ok := w.(http.Hijacker)
		if !ok {
			t.Error("no hijacker")
			return
		}
		conn, rw, err := hj.Hijack()
		if err != nil {
			t.Error(err)
			return
		}
		defer conn.Close()
		// Promise the whole body, send half, hang up.
		_, _ = rw.WriteString("HTTP/1.1 200 OK\r\nContent-Encoding: gzip\r\nContent-Length: " +
			strconv.Itoa(len(data)) + "\r\n\r\n")
		_, _ = rw.Write(data[:len(data)/2])
		_ = rw.Flush()
	}))
	defer srv.Close()
	_, err := newExec(t, nil).Execute(context.Background(), "", model.Request{URL: srv.URL})
	var e *Error
	if !errors.As(err, &e) || e.Kind == KindDecode {
		t.Fatalf("err = %v, want a network error", err)
	}
}

func TestDecoderPeekError(t *testing.T) {
	boom := errors.New("boom")
	if _, err := decoder("gzip", &failingReader{err: boom}); !errors.Is(err, boom) {
		t.Fatalf("err = %v", err)
	}
	resp := &http.Response{Header: http.Header{"Content-Encoding": {"br"}}, Body: io.NopCloser(&failingReader{err: boom})}
	if _, err := decodedBody(resp); !errors.Is(err, boom) {
		t.Fatalf("decodedBody err = %v", err)
	}
}

type failingReader struct{ err error }

func (f *failingReader) Read([]byte) (int, error) { return 0, f.err }
