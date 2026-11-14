package service

import (
	"bytes"
	"context"
	"errors"
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
	"pakpos/internal/store/fsstore"
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
		len(tree.Collections[0].Children) != 1 || tree.Collections[0].Children[0].Name != "Sign in" {
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

// treeShape renders nodes as "A[F[r] s]" for compact assertions.
func treeShape(nodes []fsstore.Node) string {
	parts := make([]string, 0, len(nodes))
	for _, n := range nodes {
		s := n.Name
		if n.Kind != fsstore.NodeRequest {
			s += "[" + treeShape(n.Children) + "]"
		}
		parts = append(parts, s)
	}
	return strings.Join(parts, " ")
}

// TestEndToEndNestedFolders walks the Tier 2 folder flow through the
// services: create and nest folders, save into them, move requests and
// folders across levels and collections, rename, settings, delete, and
// reopen from disk.
func TestEndToEndNestedFolders(t *testing.T) {
	h := newHarness(t)
	wsDir := t.TempDir()
	if _, err := h.ws.Create(wsDir, "Nested"); err != nil {
		t.Fatal(err)
	}
	tree := func() string {
		t.Helper()
		tr, err := h.ws.Tree()
		if err != nil {
			t.Fatal(err)
		}
		return treeShape(tr.Collections)
	}
	must := func(err error) {
		t.Helper()
		if err != nil {
			t.Fatal(err)
		}
	}

	users, err := h.ws.CreateCollection("Users")
	must(err)
	orders, err := h.ws.CreateCollection("Orders")
	must(err)
	auth, err := h.ws.CreateFolder(users.ID, " Auth ")
	must(err)
	tokens, err := h.ws.CreateFolder(auth.ID, "Tokens")
	must(err)
	login, err := h.req.SaveAs(auth.ID, "Log in", model.Request{Method: "POST", URL: "http://x/login", Auth: model.Auth{Type: model.AuthInherit}})
	must(err)
	refresh, err := h.req.SaveAs(tokens.ID, "Refresh", model.Request{Method: "POST", URL: "http://x/refresh"})
	must(err)
	_, err = h.req.SaveAs(users.ID, "List", model.Request{URL: "http://x/users"})
	must(err)
	if _, err := os.Stat(filepath.Join(wsDir, "collections", "users", "auth", "tokens", "refresh.yaml")); err != nil {
		t.Fatalf("nested request file: %v", err)
	}
	if got := tree(); got != "Users[Auth[Tokens[Refresh] Log in] List] Orders[]" {
		t.Fatalf("tree = %s", got)
	}

	// Settings on the collection and folder; secret values never reach disk.
	_, err = h.ws.SaveCollection(users.ID, fsstore.CollectionSettings{
		Auth:      model.Auth{Type: model.AuthBearer, Token: "{{token}}"},
		Variables: []model.Variable{{Key: "token", Value: "hunter2", Enabled: true, Secret: true}},
	})
	must(err)
	_, err = h.ws.SaveFolder(auth.ID, fsstore.FolderSettings{Headers: []model.KeyValue{{Key: "X-Auth", Value: "1", Enabled: true}}})
	must(err)
	if f, err := h.ws.GetFolder(auth.ID); err != nil || len(f.Headers) != 1 {
		t.Fatalf("GetFolder = %+v %v", f, err)
	}
	if c, err := h.ws.GetCollection(users.ID); err != nil || c.Auth.Type != model.AuthBearer || c.Variables[0].Value != "" {
		t.Fatalf("GetCollection = %+v %v", c, err)
	}
	colFile, _ := os.ReadFile(filepath.Join(wsDir, "collections", "users", "_collection.yaml"))
	if strings.Contains(string(colFile), "hunter2") {
		t.Fatal("secret value written to the workspace")
	}

	// Move requests across levels and collections, and reorder mixed children.
	_, err = h.ws.MoveRequest(refresh.ID, users.ID, 0)
	must(err)
	_, err = h.ws.MoveRequest(login.ID, orders.ID, -1)
	must(err)
	_, err = h.req.Move(refresh.ID, tokens.ID) // the Tier 1 call, now with a folder target
	must(err)
	must(h.ws.Reorder(users.ID, []string{mustListID(t, h, "List"), auth.ID}))
	if got := tree(); got != "Users[List Auth[Tokens[Refresh]]] Orders[Log in]" {
		t.Fatalf("tree after request moves = %s", got)
	}

	// Move folders: up a level, across collections, and never into their own subtree.
	_, err = h.ws.MoveFolder(tokens.ID, orders.ID, 0)
	must(err)
	_, err = h.ws.MoveFolder(auth.ID, tokens.ID, -1)
	must(err)
	if _, err := h.ws.MoveFolder(tokens.ID, auth.ID, 0); !errors.Is(err, fsstore.ErrInvalidMove) {
		t.Fatalf("move into own subtree: %v", err)
	}
	_, err = h.ws.RenameFolder(tokens.ID, "Session")
	must(err)
	if got := tree(); got != "Users[List] Orders[Session[Refresh Auth[]] Log in]" {
		t.Fatalf("tree after folder moves = %s", got)
	}
	if r, err := h.req.Get(refresh.ID); err != nil || r.URL != "http://x/refresh" {
		t.Fatalf("request after moving its folder: %+v %v", r, err)
	}
	if _, err := os.Stat(filepath.Join(wsDir, "collections", "orders", "session", "auth", "_folder.yaml")); err != nil {
		t.Fatalf("moved folder on disk: %v", err)
	}

	// Reopen from disk: the structure and folder settings are kept.
	h.ws.Close()
	_, err = h.ws.Open(wsDir)
	must(err)
	if got := tree(); got != "Users[List] Orders[Session[Refresh Auth[]] Log in]" {
		t.Fatalf("tree after reopen = %s", got)
	}
	if f, err := h.ws.GetFolder(auth.ID); err != nil || f.Headers[0].Key != "X-Auth" {
		t.Fatalf("folder settings after reopen: %+v %v", f, err)
	}

	// Deleting a folder removes everything in it.
	must(h.ws.DeleteFolder(tokens.ID))
	if _, err := h.req.Get(refresh.ID); !errors.Is(err, fsstore.ErrNotFound) {
		t.Fatalf("request of deleted folder: %v", err)
	}
	if got := tree(); got != "Users[List] Orders[Log in]" {
		t.Fatalf("tree after delete = %s", got)
	}
}

func mustListID(t *testing.T, h *harness, name string) string {
	t.Helper()
	tr, err := h.ws.Tree()
	if err != nil {
		t.Fatal(err)
	}
	for _, c := range tr.Collections {
		for _, n := range c.Children {
			if n.Name == name {
				return n.ID
			}
		}
	}
	t.Fatalf("no top-level item %q", name)
	return ""
}

// A Tier 1 workspace (manifest v1, flat collections) opens and works
// unchanged; its manifest stays v1 until a folder is created.
func TestEndToEndTier1WorkspaceOpensUnchanged(t *testing.T) {
	dir := t.TempDir()
	files := map[string]string{
		"pakpos.yaml":                      "id: W1\nname: Legacy\nversion: 1\n",
		"collections/api/_collection.yaml": "id: C1\nname: API\nseq: 1\n",
		"collections/api/get-user.yaml":    "id: R1\nname: Get user\nseq: 1\nmethod: GET\nurl: http://x/users/1\nbody:\n  type: none\nauth:\n  type: none\n",
		"collections/api/list.yaml":        "id: R2\nname: List\nseq: 2\nmethod: GET\nurl: http://x/users\nbody:\n  type: none\nauth:\n  type: none\n",
	}
	for rel, content := range files {
		p := filepath.Join(dir, rel)
		if err := os.MkdirAll(filepath.Dir(p), 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(p, []byte(content), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	h := newHarness(t)
	if _, err := h.ws.Open(dir); err != nil {
		t.Fatal(err)
	}
	tr, err := h.ws.Tree()
	if err != nil || treeShape(tr.Collections) != "API[Get user List]" || len(tr.Problems) != 0 {
		t.Fatalf("tree = %s %+v %v", treeShape(tr.Collections), tr.Problems, err)
	}
	if tr.Collections[0].Children[0].ParentID != "C1" {
		t.Fatalf("parent id = %q", tr.Collections[0].Children[0].ParentID)
	}
	if _, err := h.req.SaveAs("C1", "Create", model.Request{Method: "POST"}); err != nil {
		t.Fatal(err)
	}
	if _, err := h.ws.MoveRequest("R2", "C1", 0); err != nil {
		t.Fatal(err)
	}
	for rel, content := range files {
		if rel == "pakpos.yaml" || rel == "collections/api/_collection.yaml" || rel == "collections/api/get-user.yaml" {
			got, _ := os.ReadFile(filepath.Join(dir, rel))
			if rel == "collections/api/get-user.yaml" {
				// Only its seq changed with the reorder.
				content = strings.Replace(content, "seq: 1", "seq: 2", 1)
			}
			if string(got) != content {
				t.Errorf("%s changed:\n%s", rel, got)
			}
		}
	}
	if _, err := h.ws.CreateFolder("C1", "Admin"); err != nil {
		t.Fatal(err)
	}
	m, _ := os.ReadFile(filepath.Join(dir, "pakpos.yaml"))
	if !strings.Contains(string(m), "version: 2") {
		t.Fatalf("manifest after first folder = %s", m)
	}
}
