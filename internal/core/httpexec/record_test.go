package httpexec

import (
	"context"
	"encoding/base64"
	"net"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"pakpos/internal/core/model"
)

func recordSend(t *testing.T, e *Executor, req model.Request) ([]model.Hop, error) {
	t.Helper()
	rec := NewRecorder()
	_, err := e.Execute(WithRecorder(context.Background(), rec), "", req)
	return rec.Hops(), err
}

func header(kvs []model.KeyValue, key string) string {
	for _, kv := range kvs {
		if strings.EqualFold(kv.Key, key) {
			return kv.Value
		}
	}
	return ""
}

func TestRecorderFollowsRedirects(t *testing.T) {
	mux := http.NewServeMux()
	mux.HandleFunc("/start", func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Location", "/end")
		w.WriteHeader(http.StatusFound)
	})
	mux.HandleFunc("/end", echoHandler)
	srv := httptest.NewServer(mux)
	defer srv.Close()

	hops, err := recordSend(t, newExec(t, nil), model.Request{
		URL:     srv.URL + "/start",
		Headers: []model.KeyValue{kv("X-Trace", "abc")},
	})
	if err != nil {
		t.Fatal(err)
	}
	if len(hops) != 2 {
		t.Fatalf("hops = %d, want 2", len(hops))
	}
	first, last := hops[0], hops[1]
	if first.Method != "GET" || !strings.HasSuffix(first.URL, "/start") || first.StatusCode != 302 ||
		header(first.ResponseHeaders, "Location") != "/end" || first.Proto != "HTTP/1.1" || first.StatusText != "Found" {
		t.Errorf("first hop = %+v", first)
	}
	for _, h := range hops {
		// Headers as written, including the ones Go adds.
		for _, k := range []string{"Host", "User-Agent", "Accept-Encoding", "X-Trace"} {
			if header(h.RequestHeaders, k) == "" {
				t.Errorf("%s missing from %v", k, h.RequestHeaders)
			}
		}
		if h.RemoteAddr == "" || h.TLS != "" || h.Error != "" {
			t.Errorf("connection = %q, tls %q, error %q", h.RemoteAddr, h.TLS, h.Error)
		}
	}
	if h := first.RequestHeaders[0]; h.Key != "Host" {
		t.Errorf("first header = %v, want Host", h)
	}
	if !strings.HasSuffix(last.URL, "/end") || last.StatusCode != 200 || !last.ReusedConn {
		t.Errorf("last hop = %+v", last)
	}
}

func TestRecorderBodies(t *testing.T) {
	srv := newEchoServer(t)
	e := newExec(t, nil)

	hops, err := recordSend(t, e, model.Request{Method: "POST", URL: srv.URL, Body: model.Body{Type: model.BodyRaw, Raw: `{"a":1}`, Language: model.LangJSON}})
	if err != nil {
		t.Fatal(err)
	}
	if h := hops[0]; h.RequestBody != `{"a":1}` || h.RequestBodySize != 7 || h.RequestBodyTruncated ||
		h.RequestBodyEncoding != model.EncodingUTF8 || header(h.RequestHeaders, "Content-Length") != "7" {
		t.Errorf("text body hop = %+v", h)
	}

	bin := writeFile(t, "b.bin", "\x00\xff\x01")
	hops, err = recordSend(t, e, model.Request{Method: "PUT", URL: srv.URL, Body: model.Body{Type: model.BodyBinary, BinaryPath: bin}})
	if err != nil {
		t.Fatal(err)
	}
	if hops[0].RequestBodyEncoding != model.EncodingBase64 || hops[0].RequestBody != base64.StdEncoding.EncodeToString([]byte("\x00\xff\x01")) {
		t.Errorf("binary body = %q (%s)", hops[0].RequestBody, hops[0].RequestBodyEncoding)
	}

	// A big text body is cut at MaxHopBody, even mid-rune, and stays text.
	big := strings.Repeat("a", model.MaxHopBody-1) + "é" + "tail"
	hops, err = recordSend(t, e, model.Request{Method: "POST", URL: srv.URL, Body: model.Body{Type: model.BodyRaw, Raw: big}})
	if err != nil {
		t.Fatal(err)
	}
	h := hops[0]
	if !h.RequestBodyTruncated || h.RequestBodySize != int64(len(big)) || len(h.RequestBody) != model.MaxHopBody || h.RequestBodyEncoding != model.EncodingUTF8 {
		t.Errorf("big body: truncated %v, size %d, kept %d, %s", h.RequestBodyTruncated, h.RequestBodySize, len(h.RequestBody), h.RequestBodyEncoding)
	}

	// No body: nothing recorded, and response headers are never nil.
	hops, _ = recordSend(t, e, model.Request{URL: srv.URL})
	if hops[0].RequestBody != "" || hops[0].RequestBodySize != 0 || hops[0].ResponseHeaders == nil {
		t.Errorf("empty body hop = %+v", hops[0])
	}
}

func TestRecorderTLSAndFailures(t *testing.T) {
	srv := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) { _, _ = w.Write([]byte("ok")) }))
	defer srv.Close()
	hops, err := recordSend(t, newExec(t, func(s *Settings) { s.InsecureSkipVerify = true }), model.Request{URL: srv.URL})
	if err != nil {
		t.Fatal(err)
	}
	if !strings.HasPrefix(hops[0].TLS, "TLS 1.") {
		t.Errorf("tls = %q", hops[0].TLS)
	}

	// A refused connection is one hop with the reason and no response.
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	addr := ln.Addr().String()
	_ = ln.Close()
	hops, err = recordSend(t, newExec(t, nil), model.Request{URL: "http://" + addr})
	if err == nil || len(hops) != 1 || hops[0].Error == "" || hops[0].StatusCode != 0 || len(hops[0].ResponseHeaders) != 0 {
		t.Fatalf("refused: err %v, hops %+v", err, hops)
	}
}

func TestExecuteWithoutRecorderRecordsNothing(t *testing.T) {
	srv := newEchoServer(t)
	rec := NewRecorder()
	send(t, newExec(t, nil), model.Request{URL: srv.URL})
	if hops := rec.Hops(); hops == nil || len(hops) != 0 {
		t.Fatalf("hops = %v, want empty and non-nil", hops)
	}
}

func TestValidPrefix(t *testing.T) {
	for _, c := range []struct {
		in   string
		want bool
	}{
		{"abc", true},
		{"ab\xc3", true}, // é cut after its first byte
		{"\xff\xfe\xfd\xfc\xfb", false},
		{"", true},
	} {
		if got := validPrefix([]byte(c.in)); got != c.want {
			t.Errorf("validPrefix(%q) = %v, want %v", c.in, got, c.want)
		}
	}
}
