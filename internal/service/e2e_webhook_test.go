package service

import (
	"context"
	"errors"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"

	"pakpos/internal/core/webhook"
	"pakpos/internal/hookserver"
	"pakpos/internal/store/fsstore"
)

type e2eTunnel struct {
	done chan struct{}
	once sync.Once
}

func (t *e2eTunnel) URL() string           { return "https://e2e.trycloudflare.com" }
func (t *e2eTunnel) Done() <-chan struct{} { return t.done }
func (t *e2eTunnel) Err() error            { return nil }
func (t *e2eTunnel) Stop() error           { t.once.Do(func() { close(t.done) }); return nil }

// withTunnel replaces the harness's webhook manager with one whose tunnels
// are fakes.
func withTunnel(h *harness) {
	h.core.hooks.Close()
	h.core.hooks = hookserver.NewManager(hookserver.Options{
		OnStatus:  func(s hookserver.Status) { h.core.events.Emit(EventWebhookStatus, s) },
		OnRequest: h.core.recordWebhookRequest,
		Tunnel: func(context.Context, string) (hookserver.Tunnel, error) {
			return &e2eTunnel{done: make(chan struct{})}, nil
		},
	})
}

func hookRequests(h *harness) []WebhookRequestEvent {
	var out []WebhookRequestEvent
	for _, e := range h.events.all() {
		if ev, ok := e.data.(WebhookRequestEvent); ok && e.name == EventWebhookRequest {
			out = append(out, ev)
		}
	}
	return out
}

func hookStatuses(h *harness) []hookserver.Status {
	var out []hookserver.Status
	for _, e := range h.events.all() {
		if ev, ok := e.data.(hookserver.Status); ok && e.name == EventWebhookStatus {
			out = append(out, ev)
		}
	}
	return out
}

func post(t *testing.T, url, contentType, body string) (int, string) {
	t.Helper()
	resp, err := http.Post(url, contentType, strings.NewReader(body))
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	b, _ := io.ReadAll(resp.Body)
	return resp.StatusCode, string(b)
}

// A webhook created and saved through the service answers through its
// rules, logs every request (surviving a restart), takes new rules while
// running, keeps running after a workspace switch, and stops on Close.
func TestEndToEndWebhooks(t *testing.T) {
	h := newHarness(t)
	svc := NewWebhookService(h.core)
	if _, err := svc.List(); !errors.Is(err, ErrNoWorkspace) {
		t.Fatalf("List without workspace: %v", err)
	}
	for name, err := range map[string]error{
		"get":    func() error { _, err := svc.Get("x"); return err }(),
		"create": func() error { _, err := svc.Create("x"); return err }(),
		"save":   func() error { _, err := svc.Save(webhook.Webhook{}); return err }(),
		"rename": func() error { _, err := svc.Rename("x", "y"); return err }(),
		"dup":    func() error { _, err := svc.Duplicate("x"); return err }(),
		"delete": svc.Delete("x"),
		"start":  func() error { _, err := svc.Start("x", false); return err }(),
	} {
		if !errors.Is(err, ErrNoWorkspace) {
			t.Errorf("%s without workspace: %v", name, err)
		}
	}

	info := h.openWorkspace(t)
	hook, err := svc.Create("Payments")
	if err != nil {
		t.Fatal(err)
	}
	hook.Rules = []webhook.Rule{{
		Name: "Declined", Enabled: true,
		Match: webhook.Match{Method: "POST", Path: "/stripe/*", Conditions: []webhook.Condition{
			{Source: "json", Name: "type", Op: "equals", Value: "payment_intent.payment_failed"},
		}},
		Response: webhook.Response{Status: 400, Body: `{"error": "declined", "id": "{{$request.json.data.id}}"}`},
	}}
	res, err := svc.Save(hook)
	if err != nil || res.Problem != nil || res.Webhook == nil || res.Webhook.Rules[0].ID == "" {
		t.Fatalf("save = %+v, %v", res, err)
	}
	hook = *res.Webhook

	bad := hook
	bad.Rules = append([]webhook.Rule{}, hook.Rules...)
	bad.Rules[0].Response.Status = 42
	res, err = svc.Save(bad)
	if err != nil || res.Webhook != nil || res.Problem == nil || res.Problem.Field != "status" || res.Problem.RuleID != hook.Rules[0].ID {
		t.Fatalf("invalid save = %+v, %v", res, err)
	}
	if _, err := svc.Save(webhook.Webhook{ID: "missing", Name: "x"}); !errors.Is(err, fsstore.ErrNotFound) {
		t.Fatalf("save missing: %v", err)
	}

	st, err := svc.Start(hook.ID, false)
	if err != nil {
		t.Fatal(err)
	}
	if st.State != hookserver.StateRunning || st.WorkspaceID != info.ID || st.WorkspaceName != "Test WS" || st.Name != "Payments" {
		t.Fatalf("status = %+v", st)
	}
	if _, err := svc.Start(hook.ID, false); err == nil || err.Error() != MsgWebhookRunning {
		t.Fatalf("second start: %v", err)
	}
	if _, err := svc.Start("missing", false); !errors.Is(err, fsstore.ErrNotFound) {
		t.Fatalf("start missing: %v", err)
	}

	code, body := post(t, st.LocalURL+"/stripe/events", "application/json", `{"type":"payment_intent.payment_failed","data":{"id":"pi_1"}}`)
	if code != 400 || body != `{"error": "declined", "id": "pi_1"}` {
		t.Fatalf("rule reply = %d %s", code, body)
	}
	code, body = post(t, st.LocalURL+"/other?x=1", "application/octet-stream", "\xff\xfe binary")
	if code != 200 || body != "{\"ok\": true}\n" {
		t.Fatalf("default reply = %d %s", code, body)
	}
	waitUntil(t, func() bool { return len(hookRequests(h)) == 2 })
	ev := hookRequests(h)[0]
	if ev.WorkspaceID != info.ID || ev.WebhookID != hook.ID || ev.Entry.RuleName != "Declined" || ev.Entry.Status != 400 {
		t.Fatalf("event = %+v", ev)
	}

	list, err := svc.Requests(hook.ID, "", 50)
	if err != nil || len(list) != 2 || list[0].Path != "/other" || list[0].Query != "x=1" || list[1].Path != "/stripe/events" {
		t.Fatalf("requests = %+v, %v", list, err)
	}
	detail, err := svc.Request(list[1].ID)
	if err != nil {
		t.Fatal(err)
	}
	if detail.Body.Binary || !strings.Contains(detail.Body.Text, "payment_failed") || detail.ResponseBody.Text != `{"error": "declined", "id": "pi_1"}` {
		t.Fatalf("detail = %+v", detail)
	}
	foundCT := false
	for _, hd := range detail.Headers {
		foundCT = foundCT || (hd.Name == "Content-Type" && hd.Value == "application/json")
	}
	if !foundCT {
		t.Errorf("headers = %+v", detail.Headers)
	}
	if bin, _ := svc.Request(list[0].ID); !bin.Body.Binary || bin.Body.Base64 == "" {
		t.Errorf("binary detail = %+v", bin.Body)
	}
	if _, err := svc.Request("missing"); err == nil {
		t.Error("missing request")
	}

	// New rules apply while running; renames show in the status.
	hook.Rules[0].Response.Status = 409
	if res, err := svc.Save(hook); err != nil || res.Problem != nil {
		t.Fatalf("save while running: %+v %v", res, err)
	}
	if code, _ := post(t, st.LocalURL+"/stripe/x", "application/json", `{"type":"payment_intent.payment_failed"}`); code != 409 {
		t.Fatalf("after save: %d", code)
	}
	if _, err := svc.Rename(hook.ID, "Stripe"); err != nil {
		t.Fatal(err)
	}
	if got := svc.Statuses(); len(got) != 1 || got[0].Name != "Stripe" {
		t.Fatalf("statuses = %+v", got)
	}

	// An external edit (git pull) applies once the watcher reloads.
	ws, _ := h.core.workspace()
	file := filepath.Join(ws.Root(), fsstore.WebhooksDir, "stripe.yaml")
	data, err := os.ReadFile(file)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(file, []byte(strings.Replace(string(data), "status: 409", "status: 410", 1)), 0o644); err != nil {
		t.Fatal(err)
	}
	ws.Reload()
	h.core.refreshWebhooks(ws)
	if code, _ := post(t, st.LocalURL+"/stripe/x", "application/json", `{"type":"payment_intent.payment_failed"}`); code != 410 {
		t.Fatalf("after external edit: %d", code)
	}

	// Switching workspaces keeps it running and logging under its own.
	if _, err := h.ws.Create(t.TempDir(), "Other"); err != nil {
		t.Fatal(err)
	}
	if code, _ := post(t, st.LocalURL+"/still", "text/plain", "hi"); code != 200 {
		t.Fatalf("after switch: %d", code)
	}
	waitUntil(t, func() bool { return len(hookRequests(h)) == 5 })
	if last := hookRequests(h)[4]; last.WorkspaceID != info.ID {
		t.Errorf("logged under %s", last.WorkspaceID)
	}
	if got := svc.Statuses(); len(got) != 1 || got[0].WorkspaceID != info.ID {
		t.Fatalf("statuses after switch = %+v", got)
	}
	if err := svc.Stop(info.ID, hook.ID); err != nil {
		t.Fatal(err)
	}
	if got := hookStatuses(h); got[len(got)-1].State != hookserver.StateStopped {
		t.Errorf("last status = %+v", got[len(got)-1])
	}
	if len(svc.Statuses()) != 0 {
		t.Error("still running after Stop")
	}

	// The log survives a restart; Clear and Delete remove it.
	h.restart(t, h.secrets)
	svc = NewWebhookService(h.core)
	if list, _ := svc.Requests(hook.ID, "", 0); len(list) != 5 {
		t.Fatalf("after restart: %d", len(list))
	}
	if err := svc.DeleteRequest(list[0].ID); err != nil {
		t.Fatal(err)
	}
	if list, _ := svc.Requests(hook.ID, "", 0); len(list) != 4 {
		t.Fatalf("after delete: %d", len(list))
	}
	if err := svc.ClearRequests(hook.ID); err != nil {
		t.Fatal(err)
	}
	if list, _ := svc.Requests(hook.ID, "", 0); len(list) != 0 {
		t.Fatalf("after clear: %d", len(list))
	}
}

func TestEndToEndWebhookTunnelAndDelete(t *testing.T) {
	h := newHarness(t)
	withTunnel(h)
	svc := NewWebhookService(h.core)
	h.openWorkspace(t)
	hook, err := svc.Create("Hook")
	if err != nil {
		t.Fatal(err)
	}
	dup, err := svc.Duplicate(hook.ID)
	if err != nil || dup.Name != "Hook copy" {
		t.Fatalf("dup = %+v, %v", dup, err)
	}
	if got, err := svc.Get(dup.ID); err != nil || got.ID != dup.ID {
		t.Fatalf("get = %+v, %v", got, err)
	}
	if all, _ := svc.List(); len(all) != 2 {
		t.Fatalf("list = %d", len(all))
	}
	st, err := svc.Start(hook.ID, true)
	if err != nil || st.State != hookserver.StateTunnelStarting || !st.Tunnel {
		t.Fatalf("start = %+v, %v", st, err)
	}
	waitUntil(t, func() bool {
		got := svc.Statuses()
		return len(got) == 1 && got[0].PublicURL == "https://e2e.trycloudflare.com"
	})
	if code, _ := post(t, st.LocalURL, "text/plain", "x"); code != 200 {
		t.Fatal("not answering")
	}
	waitUntil(t, func() bool { return len(hookRequests(h)) == 1 })

	// Deleting stops it and drops its log.
	if err := svc.Delete(hook.ID); err != nil {
		t.Fatal(err)
	}
	if len(svc.Statuses()) != 0 {
		t.Error("deleted webhook still running")
	}
	if list, _ := svc.Requests(hook.ID, "", 0); len(list) != 0 {
		t.Error("log kept after delete")
	}
	if err := svc.Delete(hook.ID); !errors.Is(err, fsstore.ErrNotFound) {
		t.Errorf("delete twice: %v", err)
	}

	// Close stops running webhooks.
	if _, err := svc.Start(dup.ID, false); err != nil {
		t.Fatal(err)
	}
	h.core.hooks.Close()
	if len(svc.Statuses()) != 0 {
		t.Error("running after Close")
	}
}

func TestWebhookBodyText(t *testing.T) {
	tests := []struct {
		in        []byte
		truncated bool
		text      string
		binary    bool
	}{
		{[]byte("plain"), false, "plain", false},
		{[]byte("caf\xc3"), true, "caf", false}, // cut inside é
		{[]byte("caf\xc3"), false, "", true},
		{[]byte{0xff, 0xfe, 0xfd, 0xfc, 0xfb}, true, "", true},
		{[]byte{}, false, "", false},
	}
	for _, tt := range tests {
		got := webhookBody(tt.in, tt.truncated)
		if got.Text != tt.text || got.Binary != tt.binary || got.Truncated != tt.truncated {
			t.Errorf("webhookBody(%q, %v) = %+v", tt.in, tt.truncated, got)
		}
	}
}

func TestRecordWebhookRequestStoreFailure(t *testing.T) {
	h := newHarness(t)
	// A record without an id can't be stored: logged, no event.
	h.core.recordWebhookRequest(hookserver.Key{WebhookID: "H"}, hookserver.Record{})
	if len(hookRequests(h)) != 0 {
		t.Error("event for an unstored request")
	}
	// A webhook that no longer compiles keeps its rules.
	h.core.applyWebhook("W", webhook.Webhook{ID: "x"})
}
