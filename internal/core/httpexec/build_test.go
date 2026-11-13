package httpexec

import (
	"context"
	"errors"
	"io"
	"io/fs"
	"net/http"
	"os"
	"testing"

	"pakpos/internal/core/model"
)

func TestBuildURL(t *testing.T) {
	e := newExec(t, nil)
	tests := []struct {
		name string
		req  model.Request
		want string
	}{
		{
			name: "query table is the source of truth",
			req: model.Request{
				URL:   "https://api.dev/x?ignored=1#frag",
				Query: []model.KeyValue{kv("a", "1 2"), off("hidden", "y"), kv("b", "{x}")},
			},
			want: "https://api.dev/x?a=1%202&b=%7Bx%7D",
		},
		{
			name: "path params and default scheme",
			req: model.Request{
				URL:        "localhost:8080/users/:id",
				PathParams: []model.KeyValue{kv("id", "a/b")},
			},
			want: "http://localhost:8080/users/a%2Fb",
		},
		{name: "trims spaces", req: model.Request{URL: "  http://h.dev  "}, want: "http://h.dev"},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			r, err := e.Build(context.Background(), tt.req)
			if err != nil {
				t.Fatal(err)
			}
			if got := r.URL.String(); got != tt.want {
				t.Errorf("URL = %q, want %q", got, tt.want)
			}
			if r.Method != http.MethodGet {
				t.Errorf("default method = %q", r.Method)
			}
		})
	}
}

func TestBuildErrors(t *testing.T) {
	e := newExec(t, nil)
	missing := "/definitely/not/here.bin"
	tests := []struct {
		name string
		req  model.Request
		kind ErrorKind
	}{
		{"empty url", model.Request{URL: "  "}, KindInvalidURL},
		{"unsupported scheme", model.Request{URL: "ftp://x.dev"}, KindInvalidURL},
		{"no host", model.Request{URL: "http://"}, KindInvalidURL},
		{"unparseable", model.Request{URL: "http://[::1"}, KindInvalidURL},
		{"bad method", model.Request{URL: "http://x.dev", Method: "GE T"}, KindInvalidRequest},
		{"bad method closes body", model.Request{URL: "http://x.dev", Method: "GE T", Body: model.Body{Type: model.BodyRaw, Raw: "x"}}, KindInvalidRequest},
		{"unknown body type", model.Request{URL: "http://x.dev", Body: model.Body{Type: "graphql"}}, KindInvalidRequest},
		{"binary without file", model.Request{URL: "http://x.dev", Body: model.Body{Type: model.BodyBinary}}, KindInvalidRequest},
		{"binary missing file", model.Request{URL: "http://x.dev", Body: model.Body{Type: model.BodyBinary, BinaryPath: missing}}, KindFileNotFound},
		{"form file without path", model.Request{URL: "http://x.dev", Body: model.Body{Type: model.BodyFormData, FormData: []model.FormField{{Key: "f", Kind: model.FormFile, Enabled: true}}}}, KindInvalidRequest},
		{"form file missing", model.Request{URL: "http://x.dev", Body: model.Body{Type: model.BodyFormData, FormData: []model.FormField{{Key: "f", Kind: model.FormFile, FilePath: missing, Enabled: true}}}}, KindFileNotFound},
		{"incomplete auth", model.Request{URL: "http://x.dev", Auth: model.Auth{Type: model.AuthAPIKey}}, KindInvalidRequest},
		{"incomplete auth with body", model.Request{URL: "http://x.dev", Body: model.Body{Type: model.BodyRaw, Raw: "x"}, Auth: model.Auth{Type: model.AuthAPIKey}}, KindInvalidRequest},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			_, err := e.Build(context.Background(), tt.req)
			wantKind(t, err, tt.kind)
		})
	}
}

func TestBuildHeadersAndDefaults(t *testing.T) {
	e := newExec(t, func(s *Settings) { s.UserAgent = "Pakpos/test" })
	tests := []struct {
		name    string
		req     model.Request
		wantCT  string
		wantUA  string
		wantLen int64
	}{
		{name: "no body", req: model.Request{}, wantCT: "", wantUA: "Pakpos/test", wantLen: 0},
		{name: "raw json", req: model.Request{Body: model.Body{Type: model.BodyRaw, Raw: `{"a":1}`, Language: model.LangJSON}}, wantCT: "application/json", wantUA: "Pakpos/test", wantLen: 7},
		{name: "raw xml", req: model.Request{Body: model.Body{Type: model.BodyRaw, Raw: "<a/>", Language: model.LangXML}}, wantCT: "application/xml", wantUA: "Pakpos/test", wantLen: 4},
		{name: "raw html", req: model.Request{Body: model.Body{Type: model.BodyRaw, Raw: "<p>", Language: model.LangHTML}}, wantCT: "text/html; charset=utf-8", wantUA: "Pakpos/test", wantLen: 3},
		{name: "raw js", req: model.Request{Body: model.Body{Type: model.BodyRaw, Raw: "x()", Language: model.LangJavaScript}}, wantCT: "application/javascript", wantUA: "Pakpos/test", wantLen: 3},
		{name: "raw unknown language is text", req: model.Request{Body: model.Body{Type: model.BodyRaw, Raw: "hi"}}, wantCT: "text/plain; charset=utf-8", wantUA: "Pakpos/test", wantLen: 2},
		{
			name: "user headers win, disabled and blank skipped",
			req: model.Request{
				Headers: []model.KeyValue{kv("Content-Type", "application/vnd.api+json"), kv("User-Agent", "curl/8"), off("X-Off", "1"), kv("  ", "blank"), kv("X-Multi", "1"), kv("X-Multi", "2")},
				Body:    model.Body{Type: model.BodyRaw, Raw: "{}", Language: model.LangJSON},
			},
			wantCT: "application/vnd.api+json", wantUA: "curl/8", wantLen: 2,
		},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			tt.req.URL = "http://x.dev"
			r, err := e.Build(context.Background(), tt.req)
			if err != nil {
				t.Fatal(err)
			}
			if got := r.Header.Get("Content-Type"); got != tt.wantCT {
				t.Errorf("Content-Type = %q, want %q", got, tt.wantCT)
			}
			if got := r.Header.Get("User-Agent"); got != tt.wantUA {
				t.Errorf("User-Agent = %q, want %q", got, tt.wantUA)
			}
			if r.ContentLength != tt.wantLen {
				t.Errorf("ContentLength = %d, want %d", r.ContentLength, tt.wantLen)
			}
			if r.Header.Get("X-Off") != "" {
				t.Error("disabled header was sent")
			}
			if got := r.Header.Values("X-Multi"); len(tt.req.Headers) > 0 && len(got) != 2 {
				t.Errorf("X-Multi = %v, want two values", got)
			}
		})
	}
}

func TestBuildMethodIsUppercased(t *testing.T) {
	r, err := newExec(t, nil).Build(context.Background(), model.Request{URL: "http://x.dev", Method: " patch "})
	if err != nil {
		t.Fatal(err)
	}
	if r.Method != http.MethodPatch {
		t.Errorf("Method = %q", r.Method)
	}
}

func TestMultipartStreamFailsWhenFileVanishes(t *testing.T) {
	path := writeFile(t, "gone.txt", "x")
	// The text part comes first: the pipe writer blocks on it until we read,
	// so the file is removed before the writer goroutine opens it.
	body, _, _, err := buildBody(model.Body{Type: model.BodyFormData, FormData: []model.FormField{
		{Key: "t", Kind: model.FormText, Value: "v", Enabled: true},
		{Key: "f", Kind: model.FormFile, FilePath: path, Enabled: true},
	}})
	if err != nil {
		t.Fatal(err)
	}
	// Remove the file after validation but before the pipe writer opens it.
	if err := os.Remove(path); err != nil {
		t.Fatal(err)
	}
	if _, err := io.ReadAll(body); !errors.Is(err, fs.ErrNotExist) {
		t.Fatalf("expected read error for vanished file, got %v", err)
	}
}
