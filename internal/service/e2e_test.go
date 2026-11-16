package service

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"slices"
	"strconv"
	"strings"
	"sync/atomic"
	"testing"

	"pakpos/internal/core/httpexec"
	"pakpos/internal/core/model"
	"pakpos/internal/core/vars"
	"pakpos/internal/pipeline"
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
	res, err := h.req.Send(ctx, "pre", model.Request{Method: "GET", URL: srv.URL + "/nothing"}, "")
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
	res, err = h.req.Send(ctx, "s1", login, "")
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
	res, err = h.req.Send(ctx, "s2", model.Request{Method: "GET", URL: srv.URL + "/me"}, "")
	if err != nil || res.Error != nil || res.Response.StatusCode != 200 || !cookieSeen.Load() {
		t.Fatalf("cookie not kept between sends: %+v %v", res, err)
	}

	// A body over the inline cap is truncated, owned by history and saveable in full.
	res, err = h.req.Send(ctx, "s3", model.Request{Method: "GET", URL: srv.URL + "/big"}, "")
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
	res, err = h.req.Send(ctx, "s4", model.Request{Method: "GET", URL: srv.URL + "/me"}, "")
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
		res, _ := h.req.Send(context.Background(), "slow", model.Request{Method: "GET", URL: srv.URL}, "")
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
	}, nil)
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

// TestEndToEndSendPipeline walks the Tier 2 send pipeline through the real
// services (fsstore, sqlite, httpexec) with a fake secret store: inherited
// auth and headers, environments switching the target, globals vs
// environment precedence, secret and dynamic variables, drafts inheriting
// from their parent, environment duplicate/delete with secrets, and history
// that stores requests unresolved, per workspace, with no secret anywhere.
func TestEndToEndSendPipeline(t *testing.T) {
	const secretValue = "tok-SECRET-8c1f"
	type seen struct{ server, path, auth, team, trace, key, id string }
	var last atomic.Pointer[seen]
	handler := func(name string) http.HandlerFunc {
		return func(w http.ResponseWriter, r *http.Request) {
			last.Store(&seen{server: name, path: r.URL.Path, auth: r.Header.Get("Authorization"),
				team: r.Header.Get("X-Team"), trace: r.Header.Get("X-Trace"), key: r.Header.Get("X-Key"),
				id: r.URL.Query().Get("id")})
			w.WriteHeader(http.StatusNoContent) // never echo anything back
		}
	}
	srvA := httptest.NewServer(handler("A"))
	t.Cleanup(srvA.Close)
	srvB := httptest.NewServer(handler("B"))
	t.Cleanup(srvB.Close)

	h := newHarness(t)
	ctx := context.Background()
	must := func(err error) {
		t.Helper()
		if err != nil {
			t.Fatal(err)
		}
	}
	wsDir := t.TempDir()
	info, err := h.ws.Create(wsDir, "Pipeline")
	must(err)

	// Collection: bearer {{token}} (secret) and two headers; folder overrides one.
	col, err := h.ws.CreateCollection("API")
	must(err)
	_, err = h.ws.SaveCollection(col.ID, fsstore.CollectionSettings{
		Auth:      model.Auth{Type: model.AuthBearer, Token: "{{token}}"},
		Headers:   []model.KeyValue{{Key: "X-Team", Value: "platform", Enabled: true}, {Key: "X-Trace", Value: "col", Enabled: true}},
		Variables: []model.Variable{{Key: "token", Enabled: true, Secret: true}},
	}, nil)
	must(err)
	must(h.env.SetSecret(pipeline.ScopeRef{Kind: vars.ScopeCollection, ID: col.ID}, "token", secretValue))
	admin, err := h.ws.CreateFolder(col.ID, "Admin")
	must(err)
	_, err = h.ws.SaveFolder(admin.ID, fsstore.FolderSettings{Headers: []model.KeyValue{{Key: "x-team", Value: "admin", Enabled: true}}})
	must(err)

	// Globals and two environments.
	_, err = h.env.SaveGlobals([]model.Variable{
		{Key: "baseUrl", Value: srvA.URL + "/global", Enabled: true},
		{Key: "who", Value: "global", Enabled: true},
	}, nil)
	must(err)
	dev, err := h.env.Create("Dev")
	must(err)
	_, err = h.env.SaveVariables(pipeline.ScopeRef{Kind: vars.ScopeEnvironment, ID: dev.ID}, []model.Variable{
		{Key: "baseUrl", Value: srvA.URL + "/dev", Enabled: true},
		{Key: "apiKey", Enabled: true, Secret: true},
	}, nil)
	must(err)
	prod, err := h.env.Create("Prod")
	must(err)
	_, err = h.env.SaveVariables(pipeline.ScopeRef{Kind: vars.ScopeEnvironment, ID: prod.ID}, []model.Variable{
		{Key: "baseUrl", Value: srvB.URL + "/prod", Enabled: true},
		{Key: "apiKey", Enabled: true, Secret: true},
	}, nil)
	must(err)
	must(h.env.SetSecret(pipeline.ScopeRef{Kind: vars.ScopeEnvironment, ID: prod.ID}, "apiKey", "prod-key-77"))

	me, err := h.req.SaveAs(admin.ID, "Me", model.Request{
		Method: "GET", URL: "{{baseUrl}}/me?id={{$randomInt}}",
		Query:   []model.KeyValue{{Key: "id", Value: "{{$randomInt}}", Enabled: true}},
		Headers: []model.KeyValue{{Key: "X-Key", Value: "{{apiKey}}", Enabled: true}},
		Auth:    model.Auth{Type: model.AuthInherit},
	})
	must(err)

	send := func(id string, req model.Request, parentID string) (SendResult, seen) {
		t.Helper()
		last.Store(nil)
		res, err := h.req.Send(ctx, id, req, parentID)
		if err != nil || res.Error != nil {
			t.Fatalf("send %s: %+v %v", id, res.Error, err)
		}
		got := last.Load()
		if got == nil {
			t.Fatalf("send %s reached no server", id)
		}
		return res, *got
	}

	// No environment: globals give baseUrl; inherited bearer secret; folder
	// overrides X-Team, collection X-Trace is kept; apiKey is unknown.
	res, got := send("none", me, "")
	if got.server != "A" || got.path != "/global/me" || got.auth != "Bearer "+secretValue ||
		got.team != "admin" || got.trace != "col" || got.key != "{{apiKey}}" {
		t.Fatalf("no environment: %+v", got)
	}
	if _, err := strconv.Atoi(got.id); err != nil {
		t.Fatalf("dynamic $randomInt not resolved: %q", got.id)
	}
	if res.Environment != nil || !slices.Equal(res.Unresolved, []string{"apiKey"}) || res.SecretsLocked {
		t.Fatalf("no environment result: %+v", res)
	}

	// Dev: the environment beats globals; its secret has no value here, so
	// it is sent as written and reported.
	must(h.env.Select(dev.ID))
	res, got = send("dev", me, "")
	if got.server != "A" || got.path != "/dev/me" || got.key != "{{apiKey}}" || !slices.Equal(res.Unresolved, []string{"apiKey"}) ||
		res.Environment == nil || res.Environment.Name != "Dev" {
		t.Fatalf("dev: %+v %+v", got, res)
	}
	// In the hops an unresolved variable stays {{name}}, unlike a masked secret.
	if !slices.ContainsFunc(res.Hops[0].RequestHeaders, func(kv model.KeyValue) bool { return kv.Key == "X-Key" && kv.Value == "{{apiKey}}" }) {
		t.Fatalf("dev hop: %+v", res.Hops[0].RequestHeaders)
	}

	// Prod: another server, and its secret resolves.
	must(h.env.Select(prod.ID))
	res, got = send("prod", me, "")
	if got.server != "B" || got.path != "/prod/me" || got.key != "prod-key-77" || len(res.Unresolved) != 0 || got.auth != "Bearer "+secretValue {
		t.Fatalf("prod: %+v %+v", got, res)
	}
	prodHistory := res.HistoryID

	// The hops show what went over the wire, with both secrets masked.
	if len(res.Hops) != 1 {
		t.Fatalf("hops = %+v", res.Hops)
	}
	hop := res.Hops[0]
	wire := map[string]string{}
	for _, kv := range hop.RequestHeaders {
		wire[kv.Key] = kv.Value
	}
	if hop.Method != "GET" || !strings.HasPrefix(hop.URL, srvB.URL+"/prod/me?id=") || hop.StatusCode != http.StatusNoContent ||
		wire["Authorization"] != "Bearer [secret:token]" || wire["X-Key"] != "[secret:apiKey]" || wire["Host"] == "" || wire["X-Team"] != "admin" {
		t.Fatalf("prod hop: %+v", hop)
	}
	if raw, _ := json.Marshal(res.Hops); strings.Contains(string(raw), secretValue) || strings.Contains(string(raw), "prod-key-77") {
		t.Fatalf("hops leak a secret: %s", raw)
	}

	// An unsaved draft that belongs to the folder inherits like a saved request.
	draft := model.Request{Method: "GET", URL: "{{baseUrl}}/draft", Auth: model.Auth{Type: model.AuthInherit}}
	_, got = send("draft", draft, admin.ID)
	if got.path != "/prod/draft" || got.auth != "Bearer "+secretValue || got.team != "admin" {
		t.Fatalf("draft in folder: %+v", got)
	}
	_, got = send("orphan", draft, "")
	if got.auth != "" || got.team != "" {
		t.Fatalf("draft without parent inherited: %+v", got)
	}

	// History: the request as written, with the environment name, per workspace.
	entry, err := h.hist.Get(prodHistory)
	must(err)
	if entry.EnvironmentName != "Prod" || entry.URL != "{{baseUrl}}/me?id={{$randomInt}}" ||
		entry.Request.Auth.Type != model.AuthInherit || entry.Request.Headers[0].Value != "{{apiKey}}" || entry.WorkspaceID != info.ID {
		t.Fatalf("history entry: %+v", entry)
	}

	// Duplicating Prod copies its secret; deleting the copy removes it.
	dup, err := h.env.Duplicate(prod.ID)
	must(err)
	if st, err := h.env.SecretStatus(pipeline.ScopeRef{Kind: vars.ScopeEnvironment, ID: dup.ID}); err != nil || !slices.Equal(st.Set, []string{"apiKey"}) {
		t.Fatalf("duplicate secrets: %+v %v", st, err)
	}
	must(h.env.Select(dup.ID))
	if _, got = send("dup", me, ""); got.key != "prod-key-77" || got.server != "B" {
		t.Fatalf("duplicate environment send: %+v", got)
	}
	must(h.env.Delete(dup.ID))
	if slices.ContainsFunc(h.secrets.Keys(), func(k string) bool { return strings.Contains(k, dup.ID) }) {
		t.Fatalf("deleted environment kept secrets: %v", h.secrets.Keys())
	}
	if sel, _ := h.env.Selected(); sel != nil {
		t.Fatalf("deleted environment still selected: %+v", sel)
	}

	// Another workspace has its own history and selection.
	_, err = h.ws.Create(t.TempDir(), "Other")
	must(err)
	if page, _ := h.hist.List(sqlite.HistoryFilter{}); page.Total != 0 {
		t.Fatalf("other workspace sees %d entries", page.Total)
	}
	_, err = h.ws.Open(wsDir)
	must(err)
	page, err := h.hist.List(sqlite.HistoryFilter{})
	must(err)
	var envNames []string
	for _, it := range page.Items {
		envNames = append(envNames, it.EnvironmentName)
	}
	if want := []string{"Prod copy", "Prod", "Prod", "Prod", "Dev", ""}; !slices.Equal(envNames, want) {
		t.Fatalf("history environments = %q, want %q", envNames, want)
	}

	// Deleting the collection removes its secret value too.
	must(h.ws.DeleteCollection(col.ID))
	for _, k := range h.secrets.Keys() {
		if strings.Contains(k, col.ID) {
			t.Fatalf("deleted collection kept secret %s", k)
		}
	}

	// No secret value anywhere in the database or the workspace files.
	_ = h.core.Close() // flush the WAL into the database file
	for _, root := range []string{h.dataDir, wsDir} {
		must(filepath.WalkDir(root, func(p string, d os.DirEntry, err error) error {
			if err != nil || d.IsDir() {
				return err
			}
			data, err := os.ReadFile(p)
			if err != nil {
				return err
			}
			for _, s := range []string{secretValue, "prod-key-77"} {
				if bytes.Contains(data, []byte(s)) {
					t.Errorf("secret %q found in %s", s, p)
				}
			}
			return nil
		}))
	}
}

// An environment secret with no value on this machine shadows a globals
// variable of the same name: {{token}} is unresolved and the globals value
// is never sent.
func TestEndToEndUnsetSecretShadowsGlobals(t *testing.T) {
	var auth atomic.Value
	srv := httptest.NewServer(http.HandlerFunc(func(_ http.ResponseWriter, r *http.Request) {
		auth.Store(r.Header.Get("Authorization"))
	}))
	t.Cleanup(srv.Close)
	h := newHarness(t)
	h.openWorkspace(t)
	if _, err := h.env.SaveGlobals([]model.Variable{{Key: "token", Value: "global-token", Enabled: true}}, nil); err != nil {
		t.Fatal(err)
	}
	dev, err := h.env.Create("Dev")
	if err != nil {
		t.Fatal(err)
	}
	if _, err := h.env.SaveVariables(pipeline.ScopeRef{Kind: vars.ScopeEnvironment, ID: dev.ID},
		[]model.Variable{{Key: "token", Enabled: true, Secret: true}}, nil); err != nil {
		t.Fatal(err)
	}
	req := model.Request{URL: srv.URL, Auth: model.Auth{Type: model.AuthBearer, Token: "{{token}}"}}

	// No environment: the globals value is used.
	if res, err := h.req.Send(context.Background(), "g", req, ""); err != nil || res.Error != nil || auth.Load() != "Bearer global-token" {
		t.Fatalf("globals send: %+v %v auth=%v", res, err, auth.Load())
	}
	// Dev: its unset secret wins, so nothing from globals is sent.
	if err := h.env.Select(dev.ID); err != nil {
		t.Fatal(err)
	}
	res, err := h.req.Send(context.Background(), "d", req, "")
	if err != nil || res.Error != nil || !slices.Equal(res.Unresolved, []string{"token"}) || res.SecretsLocked {
		t.Fatalf("dev send: %+v %v", res, err)
	}
	if got := auth.Load(); got != "Bearer {{token}}" {
		t.Fatalf("sent %q; the globals value must not leak through an unset secret", got)
	}
	pv, err := h.env.ResolvePreview(req, "")
	if err != nil || len(pv.Variables) != 1 || pv.Variables[0].Scope != vars.ScopeEnvironment || pv.Variables[0].Set {
		t.Fatalf("preview = %+v %v", pv.Variables, err)
	}
}

// Renaming a secret environment variable keeps its value: the request still
// sends it under the new name, and the old key is gone from the store.
func TestEndToEndRenamedSecretKeepsValue(t *testing.T) {
	var auth atomic.Value
	srv := httptest.NewServer(http.HandlerFunc(func(_ http.ResponseWriter, r *http.Request) {
		auth.Store(r.Header.Get("Authorization"))
	}))
	t.Cleanup(srv.Close)
	h := newHarness(t)
	h.openWorkspace(t)
	dev, err := h.env.Create("Dev")
	if err != nil {
		t.Fatal(err)
	}
	ref := pipeline.ScopeRef{Kind: vars.ScopeEnvironment, ID: dev.ID}
	if _, err := h.env.SaveVariables(ref, []model.Variable{{Key: "token", Enabled: true, Secret: true}}, nil); err != nil {
		t.Fatal(err)
	}
	if err := h.env.SetSecret(ref, "token", "dev-secret"); err != nil {
		t.Fatal(err)
	}
	if err := h.env.Select(dev.ID); err != nil {
		t.Fatal(err)
	}
	saved, err := h.env.SaveVariables(ref, []model.Variable{{Key: "apiToken", Enabled: true, Secret: true}},
		[]pipeline.SecretRename{{From: "token", To: "apiToken"}})
	if err != nil || len(saved) != 1 || saved[0].Value != "" {
		t.Fatalf("saved = %+v %v", saved, err)
	}
	req := model.Request{URL: srv.URL, Auth: model.Auth{Type: model.AuthBearer, Token: "{{apiToken}}"}}
	if res, err := h.req.Send(context.Background(), "r", req, ""); err != nil || res.Error != nil || len(res.Unresolved) != 0 {
		t.Fatalf("send: %+v %v", res, err)
	}
	if got := auth.Load(); got != "Bearer dev-secret" {
		t.Fatalf("sent %q", got)
	}
	if keys := h.secrets.Keys(); len(keys) != 1 {
		t.Fatalf("stored keys = %v, want only the new one", keys)
	}
}

// TestEndToEndCurl imports a curl command, saves it, sends it to a live
// server and checks what arrived; then generates cURL for it with secrets
// masked by default and revealed only when asked, and sends the generated
// command back through import to get the same request on the wire.
func TestEndToEndCurl(t *testing.T) {
	const secretValue = "sk-SECRET-41d2"
	type seen struct {
		method, path, query, auth, ctype, custom, cookie string
		body                                             string
	}
	var last atomic.Pointer[seen]
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		body, _ := io.ReadAll(r.Body)
		last.Store(&seen{method: r.Method, path: r.URL.Path, query: r.URL.RawQuery, auth: r.Header.Get("Authorization"),
			ctype: r.Header.Get("Content-Type"), custom: r.Header.Get("X-Custom"), cookie: r.Header.Get("Cookie"), body: string(body)})
		w.WriteHeader(http.StatusNoContent)
	}))
	t.Cleanup(srv.Close)

	h := newHarness(t)
	ctx := context.Background()
	wsDir := t.TempDir()
	if _, err := h.ws.Create(wsDir, "Curl"); err != nil {
		t.Fatal(err)
	}
	col, err := h.ws.CreateCollection("API")
	if err != nil {
		t.Fatal(err)
	}

	// 1. Import a Chrome-style command and save it.
	cmd := "curl '" + srv.URL + "/v1/orders?page=2&q=a%20b' \\\n" +
		"  -H 'x-custom: one' \\\n" +
		"  -H 'content-type: application/json' \\\n" +
		"  -H 'authorization: Bearer tok-1' \\\n" +
		"  -b 'session=abc' \\\n" +
		"  --data-raw '{\"items\":[1,2],\"note\":\"it'\\''s\"}' \\\n" +
		"  --compressed"
	imp, err := h.req.ImportCurl(cmd)
	if err != nil {
		t.Fatal(err)
	}
	if len(imp.Warnings) != 1 || imp.Request.Auth.Type != model.AuthBearer {
		t.Fatalf("import = %+v", imp)
	}
	saved, err := h.req.SaveAs(col.ID, "Orders", imp.Request)
	if err != nil {
		t.Fatal(err)
	}
	reopened, err := h.req.Get(saved.ID)
	if err != nil {
		t.Fatal(err)
	}

	send := func(id string, req model.Request, parentID string) seen {
		t.Helper()
		last.Store(nil)
		res, err := h.req.Send(ctx, id, req, parentID)
		if err != nil || res.Error != nil {
			t.Fatalf("send: %+v %v", res.Error, err)
		}
		return *last.Load()
	}
	want := seen{method: "POST", path: "/v1/orders", query: "page=2&q=a%20b", auth: "Bearer tok-1",
		ctype: "application/json", custom: "one", cookie: "session=abc", body: `{"items":[1,2],"note":"it's"}`}
	if got := send("curl-1", reopened, ""); got != want {
		t.Fatalf("server saw %+v\nwant %+v", got, want)
	}

	// 2. A secret token: generated cURL masks it unless revealed.
	if _, err := h.ws.SaveCollection(col.ID, fsstore.CollectionSettings{
		Variables: []model.Variable{{Key: "token", Enabled: true, Secret: true}, {Key: "base", Value: srv.URL, Enabled: true}},
	}, nil); err != nil {
		t.Fatal(err)
	}
	if err := h.env.SetSecret(pipeline.ScopeRef{Kind: vars.ScopeCollection, ID: col.ID}, "token", secretValue); err != nil {
		t.Fatal(err)
	}
	reopened.URL = strings.Replace(reopened.URL, srv.URL, "{{base}}", 1)
	reopened.Auth.Token = "{{token}}"
	if _, err := h.req.Save(reopened); err != nil {
		t.Fatal(err)
	}

	masked, err := h.req.GenerateCode(reopened, "", "curl", CodeOptions{ResolveVariables: true})
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(masked.Code, secretValue) || !strings.Contains(masked.Code, "Bearer {{token}}") ||
		!strings.Contains(masked.Code, srv.URL+"/v1/orders") || !slices.Equal(masked.Masked, []string{"token"}) {
		t.Fatalf("masked = %+v", masked)
	}
	for _, lang := range h.req.CodeLanguages() {
		res, err := h.req.GenerateCode(reopened, "", lang.ID, CodeOptions{ResolveVariables: true})
		if err != nil || strings.Contains(res.Code, secretValue) {
			t.Fatalf("%s leaks the secret or failed: %v\n%s", lang.ID, err, res.Code)
		}
	}

	revealed, err := h.req.GenerateCode(reopened, "", "curl", CodeOptions{ResolveVariables: true, RevealSecrets: true})
	if err != nil || !strings.Contains(revealed.Code, "Bearer "+secretValue) || len(revealed.Masked) != 0 {
		t.Fatalf("revealed = %+v %v", revealed, err)
	}

	// Generating code stored nothing: the secret is in neither the workspace
	// nor the data dir (DB, WAL, bodies).
	assertNoSecret(t, secretValue, h.dataDir, wsDir)

	// 3. The revealed command imports and sends the same request as the saved
	// one. (That draft holds the value as plain text, so its history entry
	// does too, as for any literal the user sends.)
	back, err := h.req.ImportCurl(revealed.Code)
	if err != nil || len(back.Warnings) != 0 {
		t.Fatalf("re-import: %+v %v", back, err)
	}
	direct := send("curl-2", reopened, "")
	again := send("curl-3", back.Request, "")
	if direct != again || direct.auth != "Bearer "+secretValue {
		t.Fatalf("saved sent %+v\nre-imported sent %+v", direct, again)
	}
}

func assertNoSecret(t *testing.T, secret string, dirs ...string) {
	t.Helper()
	for _, dir := range dirs {
		_ = filepath.WalkDir(dir, func(p string, d os.DirEntry, err error) error {
			if err != nil || d.IsDir() {
				return err
			}
			data, rerr := os.ReadFile(p)
			if rerr == nil && bytes.Contains(data, []byte(secret)) {
				t.Errorf("secret found in %s", p)
			}
			return nil
		})
	}
}

// TestEndToEndExamples sends a request that uses a secret (in a header and
// the query string), saves the response as an example, moves and renames the
// request, reopens the workspace from disk and checks the example survived
// with the request as written and no secret value in the sidecar.
func TestEndToEndExamples(t *testing.T) {
	const secretValue = "ex-SECRET-51d2"
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("Authorization") != "Bearer "+secretValue || r.URL.Query().Get("key") != secretValue {
			w.WriteHeader(http.StatusUnauthorized)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		w.Header().Set("X-Request-Id", "abc")
		_, _ = w.Write([]byte(`{"users":[{"id":1,"name":"Ada"}]}`)) // never echoes the secret
	}))
	t.Cleanup(srv.Close)

	h := newHarness(t)
	must := func(err error) {
		t.Helper()
		if err != nil {
			t.Fatal(err)
		}
	}
	wsDir := t.TempDir()
	_, err := h.ws.Create(wsDir, "Examples")
	must(err)
	users, err := h.ws.CreateCollection("Users")
	must(err)
	_, err = h.ws.SaveCollection(users.ID, fsstore.CollectionSettings{
		Variables: []model.Variable{{Key: "baseUrl", Value: srv.URL, Enabled: true}, {Key: "token", Enabled: true, Secret: true}},
	}, nil)
	must(err)
	must(h.env.SetSecret(pipeline.ScopeRef{Kind: vars.ScopeCollection, ID: users.ID}, "token", secretValue))
	archive, err := h.ws.CreateCollection("Archive")
	must(err)
	old, err := h.ws.CreateFolder(archive.ID, "Old")
	must(err)

	list, err := h.req.SaveAs(users.ID, "List users", model.Request{
		Method: "GET", URL: "{{baseUrl}}/users?key={{token}}",
		Query: []model.KeyValue{{Key: "key", Value: "{{token}}", Enabled: true}},
		Auth:  model.Auth{Type: model.AuthBearer, Token: "{{token}}"},
	})
	must(err)
	res, err := h.req.Send(context.Background(), "ex", list, "")
	must(err)
	if res.Response == nil || res.Response.StatusCode != http.StatusOK {
		t.Fatalf("send = %+v %+v", res.Response, res.Error)
	}
	if !strings.Contains(res.Response.URL, secretValue) {
		t.Fatal("the response URL should hold the resolved secret (it must not reach the example)")
	}
	sum, err := h.saveExample(list.ID, "200 OK", res.HistoryID)
	must(err)

	// Move it into a folder of another collection, then rename it.
	_, err = h.ws.MoveRequest(list.ID, old.ID, 0)
	must(err)
	_, err = h.req.Rename(list.ID, "All users")
	must(err)
	sidecar := filepath.Join(wsDir, fsstore.CollectionsDir, "archive", "old", "all-users.examples.yaml")
	if _, err := os.Stat(sidecar); err != nil {
		t.Fatalf("sidecar didn't follow the request: %v", err)
	}

	// Reopen from disk.
	h.ws.Close()
	_, err = h.ws.Open(wsDir)
	must(err)
	all, err := h.ex.ListAll()
	must(err)
	if len(all) != 1 || all[0].ID != sum.ID || all[0].RequestID != list.ID || all[0].Name != "200 OK" || all[0].StatusCode != 200 {
		t.Fatalf("examples after reopen = %+v", all)
	}
	ex, err := h.ex.Get(list.ID, sum.ID)
	must(err)
	if ex.Response.Body != `{"users":[{"id":1,"name":"Ada"}]}` || ex.Response.Kind != model.KindJSON ||
		!slices.ContainsFunc(ex.Response.Headers, func(kv model.KeyValue) bool { return kv.Key == "X-Request-Id" }) {
		t.Fatalf("response = %+v", ex.Response)
	}
	if ex.Request.URL != "{{baseUrl}}/users?key={{token}}" || ex.Request.Auth.Token != "{{token}}" {
		t.Fatalf("request not as written: %+v", ex.Request)
	}
	raw, err := os.ReadFile(sidecar)
	must(err)
	if bytes.Contains(raw, []byte(secretValue)) || bytes.Contains(raw, []byte(srv.URL)) {
		t.Fatalf("sidecar holds a resolved value:\n%s", raw)
	}

	// Deleting the request deletes its examples.
	must(h.req.Delete(list.ID))
	if _, err := os.Stat(sidecar); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("sidecar left behind: %v", err)
	}
	if all, _ := h.ex.ListAll(); len(all) != 0 {
		t.Fatalf("examples after delete = %+v", all)
	}
}

// TestEndToEndExampleEchoedSecret: a server echoes the Authorization header;
// a plain "Save as example" is refused with the secret's name, and saving
// with {{name}} writes the placeholder and never the value.
func TestEndToEndExampleEchoedSecret(t *testing.T) {
	const secretValue = "echo-SECRET-3f9a"
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		w.Header().Set("X-Seen-Authorization", r.Header.Get("Authorization"))
		_, _ = fmt.Fprintf(w, `{"headers":{"Authorization":%q}}`, r.Header.Get("Authorization"))
	}))
	t.Cleanup(srv.Close)

	h := newHarness(t)
	must := func(err error) {
		t.Helper()
		if err != nil {
			t.Fatal(err)
		}
	}
	wsDir := t.TempDir()
	_, err := h.ws.Create(wsDir, "Echo")
	must(err)
	dev, err := h.env.Create("Dev")
	must(err)
	_, err = h.env.SaveVariables(pipeline.ScopeRef{Kind: vars.ScopeEnvironment, ID: dev.ID}, []model.Variable{{Key: "token", Enabled: true, Secret: true}}, nil)
	must(err)
	must(h.env.SetSecret(pipeline.ScopeRef{Kind: vars.ScopeEnvironment, ID: dev.ID}, "token", secretValue))
	must(h.env.Select(dev.ID))
	col, err := h.ws.CreateCollection("Echo")
	must(err)
	r, err := h.req.SaveAs(col.ID, "Echo headers", model.Request{Method: "GET", URL: srv.URL + "/headers",
		Auth: model.Auth{Type: model.AuthBearer, Token: "{{token}}"}})
	must(err)
	res, err := h.req.Send(context.Background(), "echo", r, "")
	must(err)
	if res.Response == nil || !strings.Contains(res.Response.Body, secretValue) {
		t.Fatalf("server didn't echo: %+v", res.Response)
	}

	plain, err := h.ex.Save(r.ID, "Echo", res.HistoryID, false)
	must(err)
	if plain.Example != nil || !slices.Equal(plain.SecretsFound, []string{"token"}) {
		t.Fatalf("plain save = %+v", plain)
	}
	sidecar := filepath.Join(wsDir, fsstore.CollectionsDir, "echo", "echo-headers.examples.yaml")
	if _, err := os.Stat(sidecar); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("a refused save wrote the sidecar: %v", err)
	}

	masked, err := h.ex.Save(r.ID, "Echo", res.HistoryID, true)
	must(err)
	if masked.Example == nil {
		t.Fatalf("masked save = %+v", masked)
	}
	raw, err := os.ReadFile(sidecar)
	must(err)
	if bytes.Contains(raw, []byte(secretValue)) || !bytes.Contains(raw, []byte("Bearer {{token}}")) {
		t.Fatalf("sidecar:\n%s", raw)
	}
}

// A server echoing a Basic Authorization header (httpbin's /headers, say)
// returns the secret password only as base64("user:password"), and a token
// sent in the query string comes back URL-encoded or base64-encoded.
func TestEndToEndExampleEchoedEncodedSecrets(t *testing.T) {
	const password = "pa ss/w0rd+42"
	const apiKey = "key&value=7"
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_, _ = fmt.Fprintf(w, `{"headers":{"Authorization":%q},"url":%q,"b64":%q}`,
			r.Header.Get("Authorization"), r.URL.String(),
			base64.StdEncoding.EncodeToString([]byte(r.URL.Query().Get("key"))))
	}))
	t.Cleanup(srv.Close)

	h := newHarness(t)
	must := func(err error) {
		t.Helper()
		if err != nil {
			t.Fatal(err)
		}
	}
	wsDir := t.TempDir()
	_, err := h.ws.Create(wsDir, "Echo")
	must(err)
	dev, err := h.env.Create("Dev")
	must(err)
	scope := pipeline.ScopeRef{Kind: vars.ScopeEnvironment, ID: dev.ID}
	_, err = h.env.SaveVariables(scope, []model.Variable{
		{Key: "user", Value: "alice", Enabled: true},
		{Key: "password", Enabled: true, Secret: true},
		{Key: "apiKey", Enabled: true, Secret: true},
	}, nil)
	must(err)
	must(h.env.SetSecret(scope, "password", password))
	must(h.env.SetSecret(scope, "apiKey", apiKey))
	must(h.env.Select(dev.ID))
	col, err := h.ws.CreateCollection("Echo")
	must(err)
	creds := base64.StdEncoding.EncodeToString([]byte("alice:" + password))

	tests := []struct {
		name  string
		req   model.Request
		found []string
		echo  string // what the response holds instead of the plain value
	}{
		{"basic auth", model.Request{Method: "GET", URL: srv.URL + "/basic",
			Auth: model.Auth{Type: model.AuthBasic, Username: "{{user}}", Password: "{{password}}"}},
			[]string{"password"}, creds},
		{"query string", model.Request{Method: "GET", URL: srv.URL + "/q",
			Query: []model.KeyValue{{Key: "key", Value: "{{apiKey}}", Enabled: true}}},
			[]string{"apiKey"}, "key%26value%3D7"},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			r, err := h.req.SaveAs(col.ID, tt.name, tt.req)
			must(err)
			res, err := h.req.Send(context.Background(), "echo-"+tt.name, r, "")
			must(err)
			if res.Response == nil || !strings.Contains(res.Response.Body, tt.echo) {
				t.Fatalf("server didn't echo %q: %+v", tt.echo, res.Response)
			}
			plain, err := h.ex.Save(r.ID, "Echo", res.HistoryID, false)
			must(err)
			if plain.Example != nil || !slices.Equal(plain.SecretsFound, tt.found) {
				t.Fatalf("plain save = %+v", plain)
			}
			masked, err := h.ex.Save(r.ID, "Echo", res.HistoryID, true)
			must(err)
			if masked.Example == nil {
				t.Fatalf("masked save = %+v", masked)
			}
			ex, err := h.ex.Get(r.ID, masked.Example.ID)
			must(err)
			for _, leak := range []string{password, apiKey, creds, tt.echo,
				base64.StdEncoding.EncodeToString([]byte(apiKey))} {
				if strings.Contains(ex.Response.Body, leak) {
					t.Errorf("example body still holds %q: %s", leak, ex.Response.Body)
				}
			}
		})
	}
}
