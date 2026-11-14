package service

import (
	"context"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"reflect"
	"strings"
	"testing"
	"time"

	"pakpos/internal/core/model"
	"pakpos/internal/core/vars"
	"pakpos/internal/pipeline"
	"pakpos/internal/secrets"
	"pakpos/internal/store/fsstore"
	"pakpos/internal/store/sqlite"
)

func TestExampleServiceNeedsWorkspace(t *testing.T) {
	h := newHarness(t)
	for name, err := range map[string]error{
		"list":    func() error { _, err := h.ex.List("r"); return err }(),
		"listAll": func() error { _, err := h.ex.ListAll(); return err }(),
		"get":     func() error { _, err := h.ex.Get("r", "e"); return err }(),
		"save":    func() error { _, err := h.ex.Save("r", "x", 1, false); return err }(),
		"rename":  func() error { _, err := h.ex.Rename("r", "e", "x"); return err }(),
		"delete":  h.ex.Delete("r", "e"),
	} {
		if !errors.Is(err, ErrNoWorkspace) {
			t.Errorf("%s: err = %v", name, err)
		}
	}
}

func TestExampleService(t *testing.T) {
	bodies := map[string]string{
		"/ok":    `{"id":1}`,
		"/big":   strings.Repeat("x", fsstore.MaxExampleBody+1),
		"/exact": strings.Repeat("y", fsstore.MaxExampleBody),
	}
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusCreated)
		_, _ = w.Write([]byte(bodies[r.URL.Path]))
	}))
	t.Cleanup(srv.Close)

	h := newHarness(t)
	h.openWorkspace(t)
	h.ex.now = func() time.Time { return time.Date(2026, 11, 14, 12, 0, 0, 0, time.UTC) }
	col, err := h.ws.CreateCollection("API")
	if err != nil {
		t.Fatal(err)
	}
	r, err := h.req.SaveAs(col.ID, "Create", model.Request{Method: "POST", URL: srv.URL + "/ok"})
	if err != nil {
		t.Fatal(err)
	}
	send := func(path string) int64 {
		t.Helper()
		req := r
		req.URL = srv.URL + path
		res, err := h.req.Send(context.Background(), "s"+path, req, "")
		if err != nil || res.HistoryID == 0 {
			t.Fatalf("send %s: %+v %v", path, res, err)
		}
		return res.HistoryID
	}

	sum, err := h.saveExample(r.ID, "Created", send("/ok"))
	if err != nil {
		t.Fatal(err)
	}
	if sum.Name != "Created" || sum.StatusCode != 201 || sum.RequestID != r.ID || !sum.SavedAt.Equal(h.ex.now()) {
		t.Fatalf("summary = %+v", sum)
	}
	got, err := h.ex.Get(r.ID, sum.ID)
	if err != nil || got.Response.Body != `{"id":1}` || got.Request.URL != srv.URL+"/ok" || got.Response.ContentType != "application/json" {
		t.Fatalf("Get = %+v %v", got, err)
	}

	if _, err := h.saveExample(r.ID, "Too big", send("/big")); err == nil || err.Error() != msgExampleTooLarge {
		t.Fatalf("big body err = %v", err)
	}
	if _, err := h.saveExample(r.ID, "1 MB", send("/exact")); err != nil {
		t.Fatalf("1 MB body: %v", err)
	}

	// A send that failed has no response.
	failed, err := h.req.Send(context.Background(), "fail", model.Request{Method: "GET", URL: "http://127.0.0.1:1/"}, "")
	if err != nil || failed.Error == nil || failed.HistoryID == 0 {
		t.Fatalf("failed send = %+v %v", failed, err)
	}
	if _, err := h.saveExample(r.ID, "x", failed.HistoryID); err == nil || err.Error() != msgExampleNoResponse {
		t.Fatalf("no response err = %v", err)
	}
	if _, err := h.saveExample(r.ID, "x", 99999); err == nil {
		t.Fatal("unknown history id should fail")
	}
	if _, err := h.saveExample("nope", "x", send("/ok")); !errors.Is(err, fsstore.ErrNotFound) {
		t.Fatalf("unknown request err = %v", err)
	}

	list, err := h.ex.List(r.ID)
	if err != nil || len(list) != 2 {
		t.Fatalf("List = %+v %v", list, err)
	}
	all, err := h.ex.ListAll()
	if err != nil || len(all) != 2 {
		t.Fatalf("ListAll = %+v %v", all, err)
	}
	renamed, err := h.ex.Rename(r.ID, sum.ID, "201 Created")
	if err != nil || renamed.Name != "201 Created" {
		t.Fatalf("Rename = %+v %v", renamed, err)
	}
	if err := h.ex.Delete(r.ID, sum.ID); err != nil {
		t.Fatal(err)
	}
	if list, _ := h.ex.List(r.ID); len(list) != 1 {
		t.Fatalf("after delete = %+v", list)
	}
}

// A response truncated at the inline limit (10 MB) can't be an example.
func TestExampleServiceRefusesTruncatedBodies(t *testing.T) {
	h := newHarness(t)
	h.openWorkspace(t)
	col, _ := h.ws.CreateCollection("API")
	r, _ := h.req.SaveAs(col.ID, "Get", model.Request{Method: "GET", URL: "https://x"})
	id, err := h.core.db.AddHistory(sqlite.HistoryEntry{
		HistorySummary: sqlite.HistorySummary{Method: "GET", URL: "https://x"},
		Request:        r,
		Response:       &model.Response{StatusCode: 200, Body: "partial", Size: 7, Truncated: true},
	})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := h.saveExample(r.ID, "x", id); err == nil || err.Error() != msgExampleTooLarge {
		t.Fatalf("truncated err = %v", err)
	}
	// A body whose recorded size is small but whose content is over the limit
	// is caught by the store.
	id, err = h.core.db.AddHistory(sqlite.HistoryEntry{
		HistorySummary: sqlite.HistorySummary{Method: "GET", URL: "https://x"},
		Request:        r,
		Response:       &model.Response{StatusCode: 200, Body: strings.Repeat("b", fsstore.MaxExampleBody+1), Size: 1},
	})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := h.saveExample(r.ID, "x", id); err == nil || err.Error() != msgExampleTooLarge {
		t.Fatalf("store limit err = %v", err)
	}
}

// A response that echoes a secret isn't saved as is: the names are
// reported, and with replaceSecrets the values become {{name}}.
func TestExampleServiceEchoedSecrets(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/bin" {
			w.Header().Set("Content-Type", "application/octet-stream")
			_, _ = w.Write(append([]byte{0xff, 0xfe}, r.Header.Get("Authorization")...))
			return
		}
		w.Header().Set("X-Echo", r.Header.Get("Authorization"))
		_, _ = w.Write([]byte(`{"auth":"` + r.Header.Get("Authorization") + `"}`))
	}))
	t.Cleanup(srv.Close)
	h := newHarness(t)
	h.openWorkspace(t)
	col, _ := h.ws.CreateCollection("API")
	if _, err := h.ws.SaveCollection(col.ID, fsstore.CollectionSettings{
		Variables: []model.Variable{{Key: "token", Enabled: true, Secret: true}},
	}, nil); err != nil {
		t.Fatal(err)
	}
	if err := h.env.SetSecret(pipeline.ScopeRef{Kind: vars.ScopeCollection, ID: col.ID}, "token", "tok-ECHO-77"); err != nil {
		t.Fatal(err)
	}
	r, _ := h.req.SaveAs(col.ID, "Me", model.Request{Method: "GET", URL: srv.URL + "/me", Auth: model.Auth{Type: model.AuthBearer, Token: "{{token}}"}})
	send := func(req model.Request) int64 {
		t.Helper()
		res, err := h.req.Send(context.Background(), "s"+req.URL, req, "")
		if err != nil || res.HistoryID == 0 {
			t.Fatalf("send: %+v %v", res, err)
		}
		return res.HistoryID
	}
	id := send(r)

	res, err := h.ex.Save(r.ID, "Echo", id, false)
	if err != nil || res.Example != nil || !reflect.DeepEqual(res.SecretsFound, []string{"token"}) || res.SecretsLocked {
		t.Fatalf("plain save = %+v %v", res, err)
	}
	if list, _ := h.ex.List(r.ID); len(list) != 0 {
		t.Fatal("nothing may be saved while a secret is found")
	}

	res, err = h.ex.Save(r.ID, "Echo", id, true)
	if err != nil || res.Example == nil {
		t.Fatalf("replaced save = %+v %v", res, err)
	}
	ex, _ := h.ex.Get(r.ID, res.Example.ID)
	if ex.Response.Body != `{"auth":"Bearer {{token}}"}` || strings.Contains(fmt.Sprint(ex.Response.Headers), "tok-ECHO-77") {
		t.Fatalf("masked example = %+v", ex.Response)
	}

	// A secret in a binary body can't be replaced.
	bin := r
	bin.URL = srv.URL + "/bin"
	if res, err := h.ex.Save(r.ID, "Binary", send(bin), true); err == nil || err.Error() != msgExampleBinarySecret || res.Example != nil {
		t.Fatalf("binary echo = %+v %v", res, err)
	}

	// Locked: the check can't run, so nothing is saved.
	h.secrets.Err = secrets.ErrLocked
	if res, err := h.ex.Save(r.ID, "Echo", id, true); err != nil || !res.SecretsLocked || res.Example != nil {
		t.Fatalf("locked = %+v %v", res, err)
	}
}
