package hookserver

import (
	"context"
	"errors"
	"net/http"
	"strings"
	"sync"
	"testing"

	"pakpos/internal/core/webhook"
)

type fakeTunnel struct {
	url     string
	done    chan struct{}
	err     error
	stopped bool
	mu      sync.Mutex
	once    sync.Once
}

func newFakeTunnel(url string) *fakeTunnel { return &fakeTunnel{url: url, done: make(chan struct{})} }

func (f *fakeTunnel) URL() string           { return f.url }
func (f *fakeTunnel) Done() <-chan struct{} { return f.done }
func (f *fakeTunnel) Err() error            { return f.err }
func (f *fakeTunnel) Stop() error {
	f.mu.Lock()
	f.stopped = true
	f.mu.Unlock()
	f.once.Do(func() { close(f.done) })
	return nil
}
func (f *fakeTunnel) wasStopped() bool {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.stopped
}
func (f *fakeTunnel) die(err error) {
	f.err = err
	f.once.Do(func() { close(f.done) })
}

type statusLog struct {
	mu   sync.Mutex
	list []Status
}

func (l *statusLog) add(s Status) {
	l.mu.Lock()
	l.list = append(l.list, s)
	l.mu.Unlock()
}

func (l *statusLog) last() Status {
	l.mu.Lock()
	defer l.mu.Unlock()
	if len(l.list) == 0 {
		return Status{}
	}
	return l.list[len(l.list)-1]
}

func (l *statusLog) states() []State {
	l.mu.Lock()
	defer l.mu.Unlock()
	out := []State{}
	for _, s := range l.list {
		out = append(out, s.State)
	}
	return out
}

func TestManagerLocal(t *testing.T) {
	var log statusLog
	var mu sync.Mutex
	var got []Key
	m := NewManager(Options{OnStatus: log.add, OnRequest: func(k Key, _ Record) {
		mu.Lock()
		got = append(got, k)
		mu.Unlock()
	}})
	defer m.Close()
	key := Key{WorkspaceID: "W", WebhookID: "H"}
	st, err := m.Start(StartOptions{Key: key, Name: "Hook", WorkspaceName: "Work", Rules: compiled(t)})
	if err != nil {
		t.Fatal(err)
	}
	if st.State != StateRunning || st.Tunnel || st.LocalURL == "" || st.Name != "Hook" || st.WorkspaceName != "Work" || st.StartedAt.IsZero() {
		t.Fatalf("status = %+v", st)
	}
	if _, err := m.Start(StartOptions{Key: key, Rules: compiled(t)}); !errors.Is(err, ErrRunning) {
		t.Fatalf("second start: %v", err)
	}
	if resp, _ := send(t, "GET", st.LocalURL, "", nil); resp.StatusCode != 200 {
		t.Fatal("not answering")
	}
	mu.Lock()
	if len(got) != 1 || got[0] != key {
		t.Errorf("requests for %v", got)
	}
	mu.Unlock()

	if !m.SetRules(key, compiled(t, webhook.Rule{Enabled: true, Match: webhook.Match{Path: "/**"}, Response: webhook.Response{Status: 418}})) {
		t.Fatal("SetRules: not running")
	}
	if resp, _ := send(t, "GET", st.LocalURL, "", nil); resp.StatusCode != 418 {
		t.Fatal("rules not swapped")
	}
	if m.SetRules(Key{WebhookID: "other"}, compiled(t)) {
		t.Error("SetRules on a stopped webhook")
	}
	m.Rename(key, "Renamed")
	m.Rename(Key{WebhookID: "other"}, "x")
	if m.Status(key).Name != "Renamed" || log.last().Name != "Renamed" {
		t.Errorf("rename: %+v", m.Status(key))
	}

	st2, err := m.Start(StartOptions{Key: Key{WorkspaceID: "W2", WebhookID: "H"}, Rules: compiled(t)})
	if err != nil {
		t.Fatal(err)
	}
	if all := m.Statuses(); len(all) != 2 || all[0].WorkspaceID != "W" {
		t.Errorf("statuses = %+v", all)
	}

	if err := m.Stop(key); err != nil {
		t.Fatal(err)
	}
	if err := m.Stop(key); err != nil {
		t.Fatal("stopping twice:", err)
	}
	if s := m.Status(key); s.State != StateStopped {
		t.Errorf("after stop: %+v", s)
	}
	if l := log.last(); l.State != StateStopped || l.LocalURL != "" || l.WebhookID != "H" {
		t.Errorf("stop event = %+v", l)
	}
	if _, err := http.Get(st.LocalURL); err == nil {
		t.Error("server still answering after stop")
	}

	m.Close()
	if _, err := http.Get(st2.LocalURL); err == nil {
		t.Error("server still answering after Close")
	}
	if _, err := m.Start(StartOptions{Key: key, Rules: compiled(t)}); err == nil {
		t.Error("Start after Close")
	}
	if _, err := m.Start(StartOptions{Key: Key{WebhookID: "x"}}); err == nil {
		t.Error("Start without rules")
	}
}

func TestManagerStartWithoutRulesFails(t *testing.T) {
	m := NewManager(Options{})
	defer m.Close()
	if _, err := m.Start(StartOptions{Key: Key{WebhookID: "x"}}); err == nil {
		t.Fatal("expected an error")
	}
	if len(m.Statuses()) != 0 {
		t.Fatal("failed start left an entry")
	}
}

func TestManagerTunnel(t *testing.T) {
	var log statusLog
	ft := newFakeTunnel("https://abc.trycloudflare.com")
	var gotLocal string
	m := NewManager(Options{OnStatus: log.add, Tunnel: func(_ context.Context, local string) (Tunnel, error) {
		gotLocal = local
		return ft, nil
	}})
	defer m.Close()
	key := Key{WorkspaceID: "W", WebhookID: "H"}
	st, err := m.Start(StartOptions{Key: key, Rules: compiled(t), Tunnel: true})
	if err != nil {
		t.Fatal(err)
	}
	if st.State != StateTunnelStarting || !st.Tunnel {
		t.Fatalf("first status = %+v", st)
	}
	waitFor(t, func() bool { return m.Status(key).State == StateRunning })
	if s := m.Status(key); s.PublicURL != ft.url || gotLocal != s.LocalURL {
		t.Fatalf("running = %+v (local %s)", s, gotLocal)
	}

	// The tunnel dies: the local server keeps running.
	ft.die(errors.New("connection lost"))
	waitFor(t, func() bool { return m.Status(key).State == StateTunnelFailed })
	s := m.Status(key)
	if s.Message != "The tunnel stopped: connection lost" || s.PublicURL != "" {
		t.Errorf("failed = %+v", s)
	}
	if resp, _ := send(t, "GET", s.LocalURL, "", nil); resp.StatusCode != 200 {
		t.Error("local server stopped with the tunnel")
	}
	if err := m.Stop(key); err != nil {
		t.Fatal(err)
	}
	if got := log.states(); strings.Join(stateStrings(got), ",") != "tunnel-starting,running,tunnel-failed,stopped" {
		t.Errorf("states = %v", got)
	}

	// Stop while running stops the tunnel.
	ft2 := newFakeTunnel("https://b.trycloudflare.com")
	m2 := NewManager(Options{Tunnel: func(context.Context, string) (Tunnel, error) { return ft2, nil }})
	if _, err := m2.Start(StartOptions{Key: key, Rules: compiled(t), Tunnel: true}); err != nil {
		t.Fatal(err)
	}
	waitFor(t, func() bool { return m2.Status(key).State == StateRunning })
	m2.Close()
	if !ft2.wasStopped() {
		t.Error("Close didn't stop the tunnel")
	}

	// A clean exit has a plain message.
	ft3 := newFakeTunnel("https://c.trycloudflare.com")
	m3 := NewManager(Options{Tunnel: func(context.Context, string) (Tunnel, error) { return ft3, nil }})
	defer m3.Close()
	if _, err := m3.Start(StartOptions{Key: key, Rules: compiled(t), Tunnel: true}); err != nil {
		t.Fatal(err)
	}
	waitFor(t, func() bool { return m3.Status(key).State == StateRunning })
	ft3.die(nil)
	waitFor(t, func() bool { return m3.Status(key).Message == "The tunnel stopped." })
}

func stateStrings(s []State) []string {
	out := make([]string, len(s))
	for i, v := range s {
		out[i] = string(v)
	}
	return out
}

func TestManagerTunnelFails(t *testing.T) {
	m := NewManager(Options{Tunnel: func(context.Context, string) (Tunnel, error) {
		return nil, errors.New("cloudflared not found")
	}})
	defer m.Close()
	key := Key{WebhookID: "H"}
	if _, err := m.Start(StartOptions{Key: key, Rules: compiled(t), Tunnel: true}); err != nil {
		t.Fatal(err)
	}
	waitFor(t, func() bool { return m.Status(key).State == StateTunnelFailed })
	if s := m.Status(key); s.Message != "cloudflared not found" || s.LocalURL == "" {
		t.Errorf("status = %+v", s)
	}

	// No starter configured.
	m2 := NewManager(Options{})
	defer m2.Close()
	if _, err := m2.Start(StartOptions{Key: key, Rules: compiled(t), Tunnel: true}); err != nil {
		t.Fatal(err)
	}
	waitFor(t, func() bool { return m2.Status(key).State == StateTunnelFailed })
	if s := m2.Status(key); s.Message != ErrNoTunnel.Error() {
		t.Errorf("status = %+v", s)
	}
}

func TestManagerStopWhileTunnelStarting(t *testing.T) {
	release := make(chan struct{})
	late := newFakeTunnel("https://late.trycloudflare.com")
	var log statusLog
	m := NewManager(Options{OnStatus: log.add, Tunnel: func(ctx context.Context, _ string) (Tunnel, error) {
		<-ctx.Done()
		<-release
		return late, nil // a tunnel that came up anyway is stopped
	}})
	defer m.Close()
	key := Key{WebhookID: "H"}
	if _, err := m.Start(StartOptions{Key: key, Rules: compiled(t), Tunnel: true}); err != nil {
		t.Fatal(err)
	}
	done := make(chan struct{})
	go func() { _ = m.Stop(key); close(done) }()
	close(release)
	<-done
	if !late.wasStopped() {
		t.Error("late tunnel not stopped")
	}
	if got := log.states(); strings.Join(stateStrings(got), ",") != "tunnel-starting,stopped" {
		t.Errorf("states = %v", got)
	}
}
