package hookserver

import (
	"context"
	"errors"
	"sort"
	"sync"
	"time"

	"pakpos/internal/core/vars"
	"pakpos/internal/core/webhook"
)

// State is where a running webhook is.
type State string

// States reported in Status.
const (
	// StateRunning: the local server answers (and the tunnel, if asked for,
	// is up).
	StateRunning State = "running"
	// StateTunnelStarting: the local server answers; the tunnel is starting.
	StateTunnelStarting State = "tunnel-starting"
	// StateTunnelFailed: the local server answers; the tunnel didn't start
	// or stopped (Message says why).
	StateTunnelFailed State = "tunnel-failed"
	// StateStopped: not running.
	StateStopped State = "stopped"
)

// Key identifies a running webhook: webhooks keep running after their
// workspace is closed, so the workspace is part of the key.
type Key struct {
	WorkspaceID string `json:"workspaceId"`
	WebhookID   string `json:"webhookId"`
}

// Status describes one webhook's server and tunnel.
type Status struct {
	Key
	Name          string    `json:"name"`
	WorkspaceName string    `json:"workspaceName"`
	State         State     `json:"state"`
	Tunnel        bool      `json:"tunnel"`
	LocalURL      string    `json:"localUrl"`
	PublicURL     string    `json:"publicUrl"`
	Message       string    `json:"message"`
	StartedAt     time.Time `json:"startedAt"`
}

// Tunnel is a running tunnel to a local server.
type Tunnel interface {
	// URL is the public base URL.
	URL() string
	// Done is closed when the tunnel process ends.
	Done() <-chan struct{}
	// Err says why it ended (after Done).
	Err() error
	// Stop ends the tunnel and waits for it.
	Stop() error
}

// TunnelStarter opens a tunnel to localURL; it returns once the public URL
// is known or it failed. Cancelling ctx stops a tunnel still starting.
type TunnelStarter func(ctx context.Context, localURL string) (Tunnel, error)

// ErrRunning is returned by Start for a webhook that is already running.
var ErrRunning = errors.New("this webhook is already running")

// ErrNoTunnel is returned (as the tunnel's failure) when no TunnelStarter
// is configured.
var ErrNoTunnel = errors.New("tunnels aren't available")

// Options configure a Manager.
type Options struct {
	// OnStatus gets every status change (may be nil). It is called without
	// the Manager's lock held.
	OnStatus func(Status)
	// OnRequest gets every request a webhook answered (may be nil).
	OnRequest func(Key, Record)
	// Tunnel opens tunnels; nil makes every tunnel fail with ErrNoTunnel.
	Tunnel TunnelStarter
	// Vars configure the dynamic template variables (tests).
	Vars []vars.Option
}

// Manager starts and stops webhooks. It is safe for concurrent use.
type Manager struct {
	opts Options

	mu      sync.Mutex
	running map[Key]*entry
	closed  bool
}

type entry struct {
	status Status
	server *Server
	cancel context.CancelFunc // stops the tunnel (starting or running)
	tunnel Tunnel
	done   chan struct{} // closed when the tunnel goroutine has finished
}

// NewManager returns a Manager with nothing running.
func NewManager(opts Options) *Manager {
	return &Manager{opts: opts, running: map[Key]*entry{}}
}

// StartOptions describe a webhook to start.
type StartOptions struct {
	Key
	Name          string
	WorkspaceName string
	Rules         *webhook.Compiled
	// Tunnel opens a public tunnel after the local server starts.
	Tunnel bool
}

// Start starts a webhook's local server and, with Tunnel, its tunnel in
// the background (StateTunnelStarting until it's up). It returns the first
// status.
func (m *Manager) Start(o StartOptions) (Status, error) {
	m.mu.Lock()
	if m.closed {
		m.mu.Unlock()
		return Status{}, errors.New("the app is shutting down")
	}
	if _, ok := m.running[o.Key]; ok {
		m.mu.Unlock()
		return Status{}, ErrRunning
	}
	key := o.Key
	srv, err := Listen(o.Rules, func(r Record) {
		if m.opts.OnRequest != nil {
			m.opts.OnRequest(key, r)
		}
	}, m.opts.Vars...)
	if err != nil {
		m.mu.Unlock()
		return Status{}, err
	}
	e := &entry{
		server: srv,
		status: Status{
			Key: o.Key, Name: o.Name, WorkspaceName: o.WorkspaceName, State: StateRunning,
			Tunnel: o.Tunnel, LocalURL: srv.URL(), StartedAt: time.Now().UTC(),
		},
	}
	if o.Tunnel {
		ctx, cancel := context.WithCancel(context.Background())
		e.cancel, e.done = cancel, make(chan struct{})
		e.status.State = StateTunnelStarting
		go m.runTunnel(ctx, e)
	}
	m.running[o.Key] = e
	st := e.status
	m.mu.Unlock()
	m.emit(st)
	return st, nil
}

// runTunnel starts the tunnel and watches it until it ends.
func (m *Manager) runTunnel(ctx context.Context, e *entry) {
	defer close(e.done)
	start := m.opts.Tunnel
	if start == nil {
		start = func(context.Context, string) (Tunnel, error) { return nil, ErrNoTunnel }
	}
	t, err := start(ctx, e.server.URL())
	if ctx.Err() != nil {
		// Stopped while starting.
		if t != nil {
			_ = t.Stop()
		}
		return
	}
	if err != nil {
		m.update(e, func(s *Status) { s.State, s.Message = StateTunnelFailed, err.Error() })
		return
	}
	m.mu.Lock()
	e.tunnel = t
	m.mu.Unlock()
	m.update(e, func(s *Status) { s.State, s.PublicURL, s.Message = StateRunning, t.URL(), "" })
	select {
	case <-ctx.Done():
		_ = t.Stop()
	case <-t.Done():
		msg := "The tunnel stopped."
		if err := t.Err(); err != nil {
			msg = "The tunnel stopped: " + err.Error()
		}
		m.update(e, func(s *Status) { s.State, s.PublicURL, s.Message = StateTunnelFailed, "", msg })
	}
}

// update changes e's status if e is still running and emits it.
func (m *Manager) update(e *entry, fn func(*Status)) {
	m.mu.Lock()
	if cur, ok := m.running[e.status.Key]; !ok || cur != e {
		m.mu.Unlock()
		return
	}
	fn(&e.status)
	st := e.status
	m.mu.Unlock()
	m.emit(st)
}

func (m *Manager) emit(st Status) {
	if m.opts.OnStatus != nil {
		m.opts.OnStatus(st)
	}
}

// SetRules makes a running webhook answer with c from its next request. It
// reports whether the webhook was running.
func (m *Manager) SetRules(key Key, c *webhook.Compiled) bool {
	m.mu.Lock()
	defer m.mu.Unlock()
	e, ok := m.running[key]
	if ok {
		e.server.SetRules(c)
	}
	return ok
}

// Rename updates a running webhook's display name.
func (m *Manager) Rename(key Key, name string) {
	m.mu.Lock()
	e, ok := m.running[key]
	m.mu.Unlock()
	if ok {
		m.update(e, func(s *Status) { s.Name = name })
	}
}

// Stop stops a webhook's tunnel and server. Stopping one that isn't running
// is not an error.
func (m *Manager) Stop(key Key) error {
	m.mu.Lock()
	e, ok := m.running[key]
	if ok {
		delete(m.running, key)
	}
	m.mu.Unlock()
	if !ok {
		return nil
	}
	err := m.stopEntry(e)
	st := e.status
	st.State, st.PublicURL, st.LocalURL, st.Message = StateStopped, "", "", ""
	m.emit(st)
	return err
}

func (m *Manager) stopEntry(e *entry) error {
	if e.cancel != nil {
		e.cancel()
		<-e.done
	}
	return e.server.Close()
}

// Status returns a webhook's status (StateStopped when it isn't running).
func (m *Manager) Status(key Key) Status {
	m.mu.Lock()
	defer m.mu.Unlock()
	if e, ok := m.running[key]; ok {
		return e.status
	}
	return Status{Key: key, State: StateStopped}
}

// Statuses lists every running webhook, oldest first.
func (m *Manager) Statuses() []Status {
	m.mu.Lock()
	out := make([]Status, 0, len(m.running))
	for _, e := range m.running {
		out = append(out, e.status)
	}
	m.mu.Unlock()
	sort.Slice(out, func(i, j int) bool {
		if !out[i].StartedAt.Equal(out[j].StartedAt) {
			return out[i].StartedAt.Before(out[j].StartedAt)
		}
		return out[i].WebhookID < out[j].WebhookID
	})
	return out
}

// Close stops every webhook; later Starts fail. No status events are sent.
func (m *Manager) Close() {
	m.mu.Lock()
	m.closed = true
	entries := make([]*entry, 0, len(m.running))
	for _, e := range m.running {
		entries = append(entries, e)
	}
	m.running = map[Key]*entry{}
	m.mu.Unlock()
	var wg sync.WaitGroup
	for _, e := range entries {
		wg.Go(func() { _ = m.stopEntry(e) })
	}
	wg.Wait()
}
