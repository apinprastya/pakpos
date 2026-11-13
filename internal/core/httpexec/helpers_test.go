package httpexec

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"pakpos/internal/core/model"
)

// echo is what the echo handler reports back.
type echo struct {
	Method      string              `json:"method"`
	Path        string              `json:"path"`
	RawQuery    string              `json:"rawQuery"`
	Headers     map[string][]string `json:"headers"`
	Body        string              `json:"body"`
	Form        map[string][]string `json:"form"`
	Files       map[string]fileInfo `json:"files"`
	ContentLen  int64               `json:"contentLength"`
	Chunked     bool                `json:"chunked"`
	ContentType string              `json:"contentType"`
}

type fileInfo struct {
	Name        string `json:"name"`
	Content     string `json:"content"`
	ContentType string `json:"contentType"`
}

func echoHandler(w http.ResponseWriter, r *http.Request) {
	out := echo{
		Method: r.Method, Path: r.URL.EscapedPath(), RawQuery: r.URL.RawQuery,
		Headers: r.Header, ContentLen: r.ContentLength, ContentType: r.Header.Get("Content-Type"),
	}
	for _, te := range r.TransferEncoding {
		if te == "chunked" {
			out.Chunked = true
		}
	}
	if strings.HasPrefix(r.Header.Get("Content-Type"), "multipart/") {
		if err := r.ParseMultipartForm(1 << 20); err != nil {
			http.Error(w, err.Error(), http.StatusBadRequest)
			return
		}
		out.Form = r.MultipartForm.Value
		out.Files = map[string]fileInfo{}
		for name, fhs := range r.MultipartForm.File {
			f, _ := fhs[0].Open()
			b, _ := io.ReadAll(f)
			_ = f.Close()
			out.Files[name] = fileInfo{Name: fhs[0].Filename, Content: string(b), ContentType: fhs[0].Header.Get("Content-Type")}
		}
	} else {
		b, _ := io.ReadAll(r.Body)
		out.Body = string(b)
	}
	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(out)
}

func newEchoServer(t *testing.T) *httptest.Server {
	t.Helper()
	srv := httptest.NewServer(http.HandlerFunc(echoHandler))
	t.Cleanup(srv.Close)
	return srv
}

func newExec(t *testing.T, mod func(*Settings)) *Executor {
	t.Helper()
	s := DefaultSettings()
	s.TempDir = t.TempDir()
	if mod != nil {
		mod(&s)
	}
	return New(s)
}

func send(t *testing.T, e *Executor, req model.Request) (*model.Response, echo) {
	t.Helper()
	resp, err := e.Execute(context.Background(), "", req)
	if err != nil {
		t.Fatalf("Execute: %v", err)
	}
	var got echo
	if resp.Body != "" && resp.Kind == model.KindJSON {
		if err := json.Unmarshal([]byte(resp.Body), &got); err != nil {
			t.Fatalf("decode echo: %v (%s)", err, resp.Body)
		}
	}
	return resp, got
}

func writeFile(t *testing.T, name, content string) string {
	t.Helper()
	p := filepath.Join(t.TempDir(), name)
	if err := os.WriteFile(p, []byte(content), 0o600); err != nil {
		t.Fatal(err)
	}
	return p
}

func wantKind(t *testing.T, err error, kind ErrorKind) {
	t.Helper()
	var e *Error
	if !errors.As(err, &e) {
		t.Fatalf("error %v (%T) is not *Error", err, err)
	}
	if e.Kind != kind {
		t.Fatalf("error kind = %q (%v), want %q", e.Kind, e, kind)
	}
	if e.Message == "" {
		t.Fatal("error message is empty")
	}
}

func kv(k, v string) model.KeyValue  { return model.KeyValue{Key: k, Value: v, Enabled: true} }
func off(k, v string) model.KeyValue { return model.KeyValue{Key: k, Value: v} }
