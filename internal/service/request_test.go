package service

import (
	"context"
	"encoding/base64"
	"errors"
	"fmt"
	"net"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"pakpos/internal/core/httpexec"
	"pakpos/internal/core/model"
	"pakpos/internal/store/sqlite"
)

func TestRequestServiceWithoutWorkspace(t *testing.T) {
	h := newHarness(t)
	checks := map[string]error{
		"get":       func() error { _, e := h.req.Get("x"); return e }(),
		"save":      func() error { _, e := h.req.Save(model.Request{}); return e }(),
		"saveAs":    func() error { _, e := h.req.SaveAs("c", "n", model.Request{}); return e }(),
		"rename":    func() error { _, e := h.req.Rename("x", "y"); return e }(),
		"duplicate": func() error { _, e := h.req.Duplicate("x"); return e }(),
		"delete":    h.req.Delete("x"),
		"move":      func() error { _, e := h.req.Move("x", "y"); return e }(),
		"reorder":   h.req.Reorder("c", nil),
	}
	for name, err := range checks {
		if !errors.Is(err, ErrNoWorkspace) {
			t.Errorf("%s err = %v", name, err)
		}
	}
}

func TestRequestServiceCRUD(t *testing.T) {
	h := newHarness(t)
	h.openWorkspace(t)
	a, _ := h.ws.CreateCollection("A")
	b, _ := h.ws.CreateCollection("B")

	r, err := h.req.SaveAs(a.ID, "Get user", model.Request{ID: "ignored", Method: "GET", URL: "http://x"})
	if err != nil || r.ID == "ignored" || r.Name != "Get user" {
		t.Fatalf("saveAs = %+v %v", r, err)
	}
	r.URL = "http://y"
	if _, err := h.req.Save(r); err != nil {
		t.Fatal(err)
	}
	if got, _ := h.req.Get(r.ID); got.URL != "http://y" {
		t.Fatalf("get = %+v", got)
	}
	if got, err := h.req.Rename(r.ID, "Load user"); err != nil || got.Name != "Load user" {
		t.Fatalf("rename = %+v %v", got, err)
	}
	dup, err := h.req.Duplicate(r.ID)
	if err != nil || dup.ID == r.ID {
		t.Fatalf("dup = %+v %v", dup, err)
	}
	if err := h.req.Reorder(a.ID, []string{dup.ID, r.ID}); err != nil {
		t.Fatal(err)
	}
	if moved, err := h.req.Move(dup.ID, b.ID); err != nil || moved.ID != dup.ID {
		t.Fatalf("move = %+v %v", moved, err)
	}
	if err := h.req.Delete(r.ID); err != nil {
		t.Fatal(err)
	}
	tree, _ := h.ws.Tree()
	if len(tree.Collections[0].Requests) != 0 || len(tree.Collections[1].Requests) != 1 {
		t.Fatalf("tree = %+v", tree)
	}
}

func TestSendRecordsHistory(t *testing.T) {
	h := newHarness(t)
	ws := h.openWorkspace(t)
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"ok":true}`))
	}))
	defer srv.Close()

	res, err := h.req.Send(context.Background(), "s1", model.Request{ID: "R1", Name: "Ping", Method: "post", URL: srv.URL + "/ping"})
	if err != nil || res.Error != nil || res.Response == nil || res.Response.StatusCode != 200 || res.HistoryID == 0 {
		t.Fatalf("send = %+v %v", res, err)
	}
	e, err := h.hist.Get(res.HistoryID)
	if err != nil {
		t.Fatal(err)
	}
	if e.WorkspaceID != ws.ID || e.Method != "POST" || e.RequestID != "R1" || e.RequestName != "Ping" ||
		e.Status != 200 || e.Response.Body != `{"ok":true}` || e.Size != 11 {
		t.Fatalf("entry = %+v", e)
	}
}

func TestSendFailureIsResultNotError(t *testing.T) {
	h := newHarness(t)
	ln, _ := net.Listen("tcp", "127.0.0.1:0")
	addr := ln.Addr().String()
	_ = ln.Close()

	res, err := h.req.Send(context.Background(), "s1", model.Request{URL: "http://" + addr})
	if err != nil || res.Response != nil || res.Error == nil || res.Error.Kind != httpexec.KindConnectionRefused {
		t.Fatalf("res = %+v err=%v", res, err)
	}
	e, err := h.hist.Get(res.HistoryID)
	if err != nil || e.ErrorKind != "connection_refused" || e.Method != "GET" || e.WorkspaceID != "" || e.Response != nil {
		t.Fatalf("history = %+v %v", e, err)
	}
}

func TestSendValidationAndCancel(t *testing.T) {
	h := newHarness(t)
	if _, err := h.req.Send(context.Background(), " ", model.Request{}); err == nil {
		t.Fatal("empty send id should fail")
	}

	started := make(chan struct{})
	release := make(chan struct{})
	srv := httptest.NewServer(http.HandlerFunc(func(_ http.ResponseWriter, r *http.Request) {
		close(started)
		select {
		case <-r.Context().Done():
		case <-release:
		}
	}))
	defer srv.Close()
	defer close(release)

	done := make(chan SendResult)
	go func() {
		res, _ := h.req.Send(context.Background(), "slow", model.Request{URL: srv.URL})
		done <- res
	}()
	<-started
	if _, err := h.req.Send(context.Background(), "slow", model.Request{URL: srv.URL}); err == nil {
		t.Fatal("duplicate send id should fail")
	}
	if !h.req.Cancel("slow") {
		t.Fatal("cancel did not find the send")
	}
	res := <-done
	if res.Error == nil || res.Error.Kind != httpexec.KindCanceled || res.HistoryID != 0 {
		t.Fatalf("cancelled res = %+v", res)
	}
	if p, _ := h.hist.List(sqlite.HistoryFilter{}); p.Total != 0 {
		t.Fatal("cancelled send must not be recorded")
	}
	if h.req.Cancel("slow") {
		t.Fatal("finished send still cancellable")
	}
}

func TestSendRetentionAndRecordFailure(t *testing.T) {
	h := newHarness(t)
	srv := httptest.NewServer(http.HandlerFunc(func(http.ResponseWriter, *http.Request) {}))
	defer srv.Close()
	s := h.set.Get()
	s.HistoryRetention = 2
	if _, err := h.set.Set(s); err != nil {
		t.Fatal(err)
	}
	for i := 0; i < 4; i++ {
		if _, err := h.req.Send(context.Background(), fmt.Sprint(i), model.Request{URL: srv.URL}); err != nil {
			t.Fatal(err)
		}
	}
	if p, _ := h.hist.List(sqlite.HistoryFilter{}); p.Total != 2 {
		t.Fatalf("retention: total = %d", p.Total)
	}

	_ = h.core.db.Close()
	res, err := h.req.Send(context.Background(), "x", model.Request{URL: srv.URL})
	if err != nil || res.Response == nil || res.HistoryID != 0 {
		t.Fatalf("send with broken history = %+v %v", res, err)
	}
}

func TestSendTruncatedBodyMovesIntoHistory(t *testing.T) {
	h := newHarness(t)
	big := strings.Repeat("a", httpexec.DefaultMaxBodyInMemory+10)
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		_, _ = w.Write([]byte(big))
	}))
	defer srv.Close()
	res, err := h.req.Send(context.Background(), "big", model.Request{URL: srv.URL})
	if err != nil || !res.Response.Truncated {
		t.Fatalf("res = %+v %v", res.Error, err)
	}
	if filepath.Dir(res.Response.BodyPath) != filepath.Join(h.dataDir, sqlite.BodiesDir) {
		t.Fatalf("BodyPath = %s, want inside bodies dir", res.Response.BodyPath)
	}
	if entries, _ := os.ReadDir(filepath.Join(h.dataDir, tempDirName)); len(entries) != 0 {
		t.Fatal("spill left in temp dir")
	}
	h.dialogs.save = filepath.Join(t.TempDir(), "out.txt")
	if p, err := h.req.SaveResponseBody(res.HistoryID); err != nil || p != h.dialogs.save {
		t.Fatalf("save = %s %v", p, err)
	}
	if b, _ := os.ReadFile(h.dialogs.save); len(b) != len(big) {
		t.Fatalf("saved %d bytes, want full %d", len(b), len(big))
	}
}

func TestCookiesPersistUntilWorkspaceSwitch(t *testing.T) {
	h := newHarness(t)
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/login" {
			http.SetCookie(w, &http.Cookie{Name: "sid", Value: "1", Path: "/"})
			return
		}
		if _, err := r.Cookie("sid"); err != nil {
			w.WriteHeader(http.StatusUnauthorized)
		}
	}))
	defer srv.Close()
	send := func(id, path string) int {
		res, err := h.req.Send(context.Background(), id, model.Request{URL: srv.URL + path})
		if err != nil || res.Response == nil {
			t.Fatalf("send %s: %+v %v", id, res, err)
		}
		return res.Response.StatusCode
	}
	send("1", "/login")
	if got := send("2", "/me"); got != 200 {
		t.Fatalf("cookie not kept: %d", got)
	}
	// Changing settings keeps cookies.
	s := h.set.Get()
	s.TimeoutMs = 5000
	_, _ = h.set.Set(s)
	if got := send("3", "/me"); got != 200 {
		t.Fatalf("cookie lost on settings change: %d", got)
	}
	h.openWorkspace(t)
	if got := send("4", "/me"); got != http.StatusUnauthorized {
		t.Fatalf("cookie survived workspace switch: %d", got)
	}
}

func TestPickFile(t *testing.T) {
	h := newHarness(t)
	h.dialogs.file = "/a.txt"
	if p, err := h.req.PickFile(); p != "/a.txt" || err != nil {
		t.Fatalf("got %s %v", p, err)
	}
}

func TestSaveResponseBody(t *testing.T) {
	h := newHarness(t)
	add := func(resp *model.Response, url string) int64 {
		id, err := h.core.db.AddHistory(sqlite.HistoryEntry{
			HistorySummary: sqlite.HistorySummary{Method: "GET", URL: url, CreatedAt: time.Now()},
			Response:       resp,
		})
		if err != nil {
			t.Fatal(err)
		}
		return id
	}
	text := add(&model.Response{Body: "hello", Encoding: model.EncodingUTF8, Kind: model.KindText}, "http://x/notes")
	bin := add(&model.Response{Body: base64.StdEncoding.EncodeToString([]byte{1, 2, 3}), Encoding: model.EncodingBase64, Kind: model.KindBinary}, "http://x/f")
	badB64 := add(&model.Response{Body: "!!", Encoding: model.EncodingBase64}, "http://x/f")
	failed := add(nil, "http://x")

	out := t.TempDir()
	h.dialogs.save = filepath.Join(out, "a")
	if _, err := h.req.SaveResponseBody(text); err != nil {
		t.Fatal(err)
	}
	if b, _ := os.ReadFile(h.dialogs.save); string(b) != "hello" || h.dialogs.lastDefaultName != "notes.txt" {
		t.Fatalf("text: %q default=%s", b, h.dialogs.lastDefaultName)
	}
	if _, err := h.req.SaveResponseBody(bin); err != nil {
		t.Fatal(err)
	}
	if b, _ := os.ReadFile(h.dialogs.save); string(b) != "\x01\x02\x03" {
		t.Fatalf("binary: %v", b)
	}
	if _, err := h.req.SaveResponseBody(badB64); err == nil {
		t.Fatal("expected base64 error")
	}
	if _, err := h.req.SaveResponseBody(failed); err == nil {
		t.Fatal("expected no-response error")
	}
	if _, err := h.req.SaveResponseBody(999); !errors.Is(err, sqlite.ErrNotFound) {
		t.Fatalf("missing: %v", err)
	}

	h.dialogs.save = ""
	if p, err := h.req.SaveResponseBody(text); p != "" || err != nil {
		t.Fatalf("cancelled: %s %v", p, err)
	}
	h.dialogs.err = errDialog
	if _, err := h.req.SaveResponseBody(text); !errors.Is(err, errDialog) {
		t.Fatalf("dialog err: %v", err)
	}
	h.dialogs.err = nil
	h.dialogs.save = filepath.Join(out, "missing-dir", "x")
	if _, err := h.req.SaveResponseBody(text); err == nil {
		t.Fatal("expected write error")
	}
}

func TestCopyFileErrors(t *testing.T) {
	dir := t.TempDir()
	if err := copyFile(filepath.Join(dir, "missing"), filepath.Join(dir, "x")); err == nil {
		t.Fatal("expected open error")
	}
	src := filepath.Join(dir, "src")
	_ = os.WriteFile(src, []byte("x"), 0o600)
	if err := copyFile(src, filepath.Join(dir, "no", "x")); err == nil {
		t.Fatal("expected create error")
	}
	if err := copyFile(dir, filepath.Join(dir, "y")); err == nil {
		t.Fatal("expected read error when copying a directory")
	}
}

func TestSuggestFileName(t *testing.T) {
	cases := []struct {
		url, ctype string
		kind       model.BodyKind
		want       string
	}{
		{"http://x/users/42", "", model.KindJSON, "42.json"},
		{"https://x/report.pdf?dl=1", "", model.KindBinary, "report.pdf"},
		{"http://x/", "", model.KindHTML, "response.html"},
		{"http://x", "", model.KindXML, "response.xml"},
		{"example.com", "", model.KindText, "response.txt"},
		{"{{base}}/avatar", "image/svg+xml; charset=utf-8", model.KindImage, "avatar.svg"},
		{"http://x/img", "image", model.KindImage, "img.bin"},
		{"http://x/blob", "", model.KindBinary, "blob.bin"},
		{"http://x/e", "", model.KindEmpty, "e.bin"},
		{"://bad", "", model.KindText, "response.txt"},
	}
	for _, c := range cases {
		e := sqlite.HistoryEntry{HistorySummary: sqlite.HistorySummary{URL: c.url},
			Response: &model.Response{Kind: c.kind, ContentType: c.ctype}}
		if got := suggestFileName(e); got != c.want {
			t.Errorf("suggestFileName(%q, %s) = %q, want %q", c.url, c.kind, got, c.want)
		}
	}
}
