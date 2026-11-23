package fsstore

import (
	"errors"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"pakpos/internal/core/webhook"
)

func hookPath(ws *Workspace, file string) string {
	return filepath.Join(ws.Root(), WebhooksDir, file)
}

func hookNames(hs []webhook.Webhook) []string {
	out := []string{}
	for _, h := range hs {
		out = append(out, h.Name)
	}
	return out
}

func TestWebhooksCRUD(t *testing.T) {
	ws := newWS(t)
	if got := ws.ListWebhooks(); len(got) != 0 {
		t.Fatalf("new workspace has webhooks: %+v", got)
	}
	stripe, err := ws.CreateWebhook("  Stripe  ")
	if err != nil {
		t.Fatal(err)
	}
	if stripe.Name != "Stripe" || stripe.Seq != 1 || stripe.ID == "" || stripe.DefaultResponse.Status != 200 {
		t.Fatalf("created %+v", stripe)
	}
	if !exists(hookPath(ws, "stripe.yaml")) {
		t.Fatal("stripe.yaml not written")
	}
	unnamed, err := ws.CreateWebhook("")
	if err != nil {
		t.Fatal(err)
	}
	if unnamed.Name != "New webhook" || unnamed.Seq != 2 {
		t.Fatalf("unnamed = %+v", unnamed)
	}

	// Save rules; ids are filled, the file is renamed with the name.
	stripe.Name = "Stripe events"
	stripe.Seq = 99 // ignored
	stripe.Rules = []webhook.Rule{{
		Name: "Fail", Enabled: true,
		Match:    webhook.Match{Method: "post", Path: "/fail/:id", Conditions: []webhook.Condition{{Source: "json", Name: "type", Op: "equals", Value: "x"}}},
		Response: webhook.Response{Status: 400, Body: "{\"error\": \"declined\"}\n"},
	}}
	saved, err := ws.SaveWebhook(stripe)
	if err != nil {
		t.Fatal(err)
	}
	if saved.Seq != 1 || saved.Rules[0].ID == "" || saved.Rules[0].Match.Method != "POST" {
		t.Fatalf("saved %+v", saved)
	}
	if exists(hookPath(ws, "stripe.yaml")) || !exists(hookPath(ws, "stripe-events.yaml")) {
		t.Fatal("file not renamed")
	}
	data, _ := os.ReadFile(hookPath(ws, "stripe-events.yaml"))
	if !strings.Contains(string(data), "body: |\n") && !strings.Contains(string(data), "body: |-") {
		t.Logf("file:\n%s", data)
	}

	// Validation errors come back typed and nothing is written.
	bad := saved
	bad.Rules = append([]webhook.Rule{}, saved.Rules...)
	bad.Rules[0].Match.Path = "nope"
	_, err = ws.SaveWebhook(bad)
	var ve *webhook.ValidationError
	if !errors.As(err, &ve) || ve.Field != "path" {
		t.Fatalf("SaveWebhook(bad) = %v", err)
	}
	if got, _ := ws.GetWebhook(saved.ID); got.Rules[0].Match.Path != "/fail/:id" {
		t.Fatal("invalid save changed the webhook")
	}

	// Reload from disk gives the same webhook.
	ws.Reload()
	got, err := ws.GetWebhook(saved.ID)
	if err != nil || !reflect.DeepEqual(got, saved) {
		t.Fatalf("reloaded = %+v, %v\nwant %+v", got, err, saved)
	}

	renamed, err := ws.RenameWebhook(unnamed.ID, "GitHub")
	if err != nil || renamed.Name != "GitHub" || !exists(hookPath(ws, "github.yaml")) {
		t.Fatalf("rename = %+v, %v", renamed, err)
	}

	dup, err := ws.DuplicateWebhook(saved.ID)
	if err != nil {
		t.Fatal(err)
	}
	if dup.ID == saved.ID || dup.Name != "Stripe events copy" || dup.Seq != 3 || dup.Rules[0].ID == saved.Rules[0].ID || dup.Rules[0].Name != "Fail" {
		t.Fatalf("dup = %+v", dup)
	}
	if got := hookNames(ws.ListWebhooks()); !reflect.DeepEqual(got, []string{"Stripe events", "GitHub", "Stripe events copy"}) {
		t.Fatalf("list = %v", got)
	}

	if err := ws.DeleteWebhook(dup.ID); err != nil {
		t.Fatal(err)
	}
	if exists(hookPath(ws, "stripe-events-copy.yaml")) {
		t.Fatal("file not deleted")
	}

	for name, err := range map[string]error{
		"get":    func() error { _, err := ws.GetWebhook("x"); return err }(),
		"save":   func() error { _, err := ws.SaveWebhook(webhook.Webhook{ID: "x"}); return err }(),
		"rename": func() error { _, err := ws.RenameWebhook("x", "y"); return err }(),
		"dup":    func() error { _, err := ws.DuplicateWebhook("x"); return err }(),
		"delete": ws.DeleteWebhook("x"),
	} {
		if !errors.Is(err, ErrNotFound) {
			t.Errorf("%s: %v", name, err)
		}
	}
}

func TestWebhookUpgradesManifest(t *testing.T) {
	ws := newWS(t)
	ws.manifest.Version = 1
	if _, err := ws.CreateWebhook("x"); err != nil {
		t.Fatal(err)
	}
	if ws.Manifest().Version != FormatVersion {
		t.Fatalf("version = %d", ws.Manifest().Version)
	}
}

func TestWebhooksLoadProblems(t *testing.T) {
	ws := newWS(t)
	dir := filepath.Join(ws.Root(), WebhooksDir)
	if err := os.MkdirAll(filepath.Join(dir, "sub"), 0o755); err != nil {
		t.Fatal(err)
	}
	files := map[string]string{
		"good.yaml":    "id: a\nname: Good\ndefaultResponse:\n  status: 204\n",
		"noname.yaml":  "id: b\n",
		"broken.yaml":  "id: [",
		"noid.yaml":    "name: x\n",
		"zdup.yaml":    "id: a\nname: Dup\n",
		"invalid.yaml": "id: c\nname: Bad\nrules:\n  - id: r\n    match: {path: nope}\n",
		"_skip.yaml":   "id: d\n",
		".hidden.yaml": "id: e\n",
		"notes.txt":    "x",
	}
	for name, body := range files {
		if err := os.WriteFile(filepath.Join(dir, name), []byte(body), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	problems := ws.Reload()
	names := hookNames(ws.ListWebhooks())
	if !reflect.DeepEqual(names, []string{"Good", "noname"}) {
		t.Fatalf("loaded %v", names)
	}
	got := map[string]bool{}
	for _, p := range problems {
		got[filepath.Base(p.Path)] = true
	}
	for _, want := range []string{"broken.yaml", "noid.yaml", "invalid.yaml"} {
		if !got[want] {
			t.Errorf("no problem for %s: %+v", want, problems)
		}
	}
	if !got["zdup.yaml"] {
		t.Errorf("no duplicate problem: %+v", problems)
	}
	if h, _ := ws.GetWebhook("b"); h.DefaultResponse.Status != 200 {
		t.Errorf("missing default status not normalized: %+v", h)
	}
}

func TestWebhooksDirIsAFile(t *testing.T) {
	ws := newWS(t)
	if err := os.WriteFile(filepath.Join(ws.Root(), WebhooksDir), []byte("x"), 0o644); err != nil {
		t.Fatal(err)
	}
	if problems := ws.Reload(); len(problems) == 0 {
		t.Fatal("expected a problem")
	}
	if _, err := ws.CreateWebhook("x"); err == nil {
		t.Fatal("create should fail when webhooks is a file")
	}
}

func TestWatcherReloadsWebhooks(t *testing.T) {
	ws := newWS(t)
	if _, err := ws.CreateWebhook("Hook"); err != nil {
		t.Fatal(err)
	}
	var calls atomic.Int32
	wt, err := ws.Watch(20*time.Millisecond, func([]Problem) { calls.Add(1) })
	if err != nil {
		t.Fatal(err)
	}
	defer wt.Close()
	body := "id: EXT\nname: External\ndefaultResponse:\n  status: 202\n"
	if err := os.WriteFile(hookPath(ws, "external.yaml"), []byte(body), 0o644); err != nil {
		t.Fatal(err)
	}
	waitFor(t, func() bool {
		got, err := ws.GetWebhook("EXT")
		return calls.Load() > 0 && err == nil && got.DefaultResponse.Status == 202
	})
}
