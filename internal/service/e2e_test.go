package service

import (
	"bytes"
	"context"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync/atomic"
	"testing"

	"pakpos/internal/core/httpexec"
	"pakpos/internal/core/model"
	"pakpos/internal/store/sqlite"
)

// TestEndToEnd wires the real services (fsstore + sqlite + httpexec) with fake
// dialogs/events and walks through the main Tier 1 flow against a live server:
// workspace → collection → save → send → history → cookies → large body →
// rename/move/delete → reopen.
func TestEndToEnd(t *testing.T) {
	bigBody := bytes.Repeat([]byte("x"), httpexec.DefaultMaxBodyInMemory+4096)
	var cookieSeen atomic.Bool
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/login":
			http.SetCookie(w, &http.Cookie{Name: "session", Value: "abc", Path: "/"})
			w.Header().Set("Content-Type", "application/json")
			fmt.Fprintf(w, `{"ok":true,"method":%q,"q":%q}`, r.Method, r.URL.Query().Get("page"))
		case "/me":
			if c, err := r.Cookie("session"); err == nil && c.Value == "abc" {
				cookieSeen.Store(true)
				w.WriteHeader(http.StatusOK)
				return
			}
			w.WriteHeader(http.StatusUnauthorized)
		case "/big":
			w.Header().Set("Content-Type", "text/plain")
			_, _ = w.Write(bigBody)
		default:
			http.NotFound(w, r)
		}
	}))
	t.Cleanup(srv.Close)

	h := newHarness(t)
	ctx := context.Background()

	// Sending works before any workspace is open, and is recorded without one.
	res, err := h.req.Send(ctx, "pre", model.Request{Method: "GET", URL: srv.URL + "/nothing"})
	if err != nil || res.Error != nil || res.Response.StatusCode != http.StatusNotFound || res.HistoryID == 0 {
		t.Fatalf("send without workspace: %+v %v", res, err)
	}

	// Workspace + collection + save.
	wsDir := t.TempDir()
	info, err := h.ws.Create(wsDir, "E2E")
	if err != nil {
		t.Fatal(err)
	}
	auth, err := h.ws.CreateCollection("Auth")
	if err != nil {
		t.Fatal(err)
	}
	users, err := h.ws.CreateCollection("Users")
	if err != nil {
		t.Fatal(err)
	}
	login, err := h.req.SaveAs(auth.ID, "Log in", model.Request{
		Method: "POST",
		URL:    srv.URL + "/login?page=2",
		Query:  []model.KeyValue{{Key: "page", Value: "2", Enabled: true}},
		Body:   model.Body{Type: model.BodyRaw, Raw: `{"user":"ada"}`, Language: "json"},
	})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(filepath.Join(wsDir, "collections", "auth", "log-in.yaml")); err != nil {
		t.Fatalf("request file not written: %v", err)
	}

	// Send the saved request; history records it against the workspace.
	res, err = h.req.Send(ctx, "s1", login)
	if err != nil || res.Error != nil {
		t.Fatalf("send login: %+v %v", res, err)
	}
	if res.Response.StatusCode != 200 || res.Response.Kind != model.KindJSON ||
		!strings.Contains(res.Response.Body, `"method":"POST"`) || !strings.Contains(res.Response.Body, `"q":"2"`) {
		t.Fatalf("login response: %+v", res.Response)
	}
	page, err := h.hist.List(sqlite.HistoryFilter{WorkspaceID: info.ID})
	if err != nil || page.Total != 1 || page.Items[0].RequestID != login.ID || page.Items[0].Status != 200 {
		t.Fatalf("history for workspace: %+v %v", page, err)
	}
	entry, err := h.hist.Get(res.HistoryID)
	if err != nil || entry.Response == nil || entry.Request.Name != "Log in" {
		t.Fatalf("history entry: %+v %v", entry, err)
	}

	// Cookies from /login are sent to /me.
	res, err = h.req.Send(ctx, "s2", model.Request{Method: "GET", URL: srv.URL + "/me"})
	if err != nil || res.Error != nil || res.Response.StatusCode != 200 || !cookieSeen.Load() {
		t.Fatalf("cookie not kept between sends: %+v %v", res, err)
	}

	// A body over the inline cap is truncated, owned by history and saveable in full.
	res, err = h.req.Send(ctx, "s3", model.Request{Method: "GET", URL: srv.URL + "/big"})
	if err != nil || res.Error != nil || !res.Response.Truncated || res.Response.Size != int64(len(bigBody)) {
		t.Fatalf("big body: truncated=%v size=%d err=%v", res.Response.Truncated, res.Response.Size, err)
	}
	dest := filepath.Join(t.TempDir(), "big.txt")
	h.dialogs.save = dest
	if got, err := h.req.SaveResponseBody(res.HistoryID); err != nil || got != dest {
		t.Fatalf("save body: %q %v", got, err)
	}
	if saved, err := os.ReadFile(dest); err != nil || !bytes.Equal(saved, bigBody) {
		t.Fatalf("saved body differs: len=%d err=%v", len(saved), err)
	}

	// Rename, move, duplicate and delete.
	if login, err = h.req.Rename(login.ID, "Sign in"); err != nil || login.Name != "Sign in" {
		t.Fatalf("rename: %+v %v", login, err)
	}
	if _, err := h.req.Move(login.ID, users.ID); err != nil {
		t.Fatal(err)
	}
	dup, err := h.req.Duplicate(login.ID)
	if err != nil {
		t.Fatal(err)
	}
	if err := h.req.Delete(dup.ID); err != nil {
		t.Fatal(err)
	}
	if _, err := h.ws.RenameCollection(users.ID, "People"); err != nil {
		t.Fatal(err)
	}
	if err := h.ws.DeleteCollection(auth.ID); err != nil {
		t.Fatal(err)
	}

	// Reopen from disk: the tree reflects every change.
	h.ws.Close()
	if _, err := h.req.Get(login.ID); err == nil {
		t.Fatal("expected no workspace after close")
	}
	if _, err := h.ws.Open(wsDir); err != nil {
		t.Fatal(err)
	}
	tree, err := h.ws.Tree()
	if err != nil {
		t.Fatal(err)
	}
	if len(tree.Collections) != 1 || tree.Collections[0].Name != "People" ||
		len(tree.Collections[0].Requests) != 1 || tree.Collections[0].Requests[0].Name != "Sign in" {
		t.Fatalf("tree after reopen: %+v", tree)
	}
	got, err := h.req.Get(login.ID)
	if err != nil || got.Body.Raw != `{"user":"ada"}` || got.Method != "POST" {
		t.Fatalf("request after reopen: %+v %v", got, err)
	}
	recent, err := h.ws.Recent()
	if err != nil || len(recent) != 1 || recent[0].Path != wsDir {
		t.Fatalf("recent: %+v %v", recent, err)
	}

	// Cookies reset when the workspace changes.
	cookieSeen.Store(false)
	res, err = h.req.Send(ctx, "s4", model.Request{Method: "GET", URL: srv.URL + "/me"})
	if err != nil || res.Response.StatusCode != http.StatusUnauthorized || cookieSeen.Load() {
		t.Fatalf("cookies should reset on workspace switch: %+v %v", res, err)
	}

	// Clearing history removes everything, including the spilled body file.
	if err := h.hist.Clear(); err != nil {
		t.Fatal(err)
	}
	if page, _ := h.hist.List(sqlite.HistoryFilter{}); page.Total != 0 {
		t.Fatalf("history not cleared: %d", page.Total)
	}
	bodies, _ := os.ReadDir(filepath.Join(h.dataDir, "bodies"))
	if len(bodies) != 0 {
		t.Fatalf("body files left after clear: %d", len(bodies))
	}
}

// A send that's running when the user switches workspace is recorded against
// the workspace it started in.
func TestSendRecordsStartingWorkspace(t *testing.T) {
	release := make(chan struct{})
	started := make(chan struct{})
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		close(started)
		<-release
		w.WriteHeader(http.StatusNoContent)
	}))
	t.Cleanup(srv.Close)

	h := newHarness(t)
	first := h.openWorkspace(t)

	done := make(chan SendResult, 1)
	go func() {
		res, _ := h.req.Send(context.Background(), "slow", model.Request{Method: "GET", URL: srv.URL})
		done <- res
	}()
	<-started
	if _, err := h.ws.Create(t.TempDir(), "Second"); err != nil {
		t.Fatal(err)
	}
	close(release)
	res := <-done

	entry, err := h.hist.Get(res.HistoryID)
	if err != nil || entry.WorkspaceID != first.ID {
		t.Fatalf("recorded against %q, want %q (%v)", entry.WorkspaceID, first.ID, err)
	}
}
