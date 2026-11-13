// Package httpexec builds and sends HTTP requests described by model.Request,
// measuring timings and supporting cancellation. It has no Wails dependency.
package httpexec

import (
	"context"
	"crypto/tls"
	"net/http"
	"net/http/httptrace"
	"os"
	"sync"
	"time"

	"pakpos/internal/buildinfo"
	"pakpos/internal/core/model"
)

// DefaultMaxBodyInMemory is how much of a response body is returned inline.
const DefaultMaxBodyInMemory = 10 << 20 // 10 MB

// Settings controls how requests are sent.
type Settings struct {
	// Timeout for the whole exchange, including reading the body. Zero means no timeout.
	Timeout         time.Duration
	FollowRedirects bool
	// MaxRedirects caps followed redirects when FollowRedirects is true.
	MaxRedirects       int
	InsecureSkipVerify bool
	// MaxBodyInMemory caps the inline body; larger bodies are written to a temp file.
	MaxBodyInMemory int64
	// TempDir holds full bodies of truncated responses. Empty means os.TempDir().
	TempDir   string
	UserAgent string
	// Jar stores cookies between requests. Nil disables cookie persistence.
	Jar http.CookieJar
}

// DefaultSettings returns the settings used for a fresh install.
func DefaultSettings() Settings {
	return Settings{
		Timeout:         30 * time.Second,
		FollowRedirects: true,
		MaxRedirects:    10,
		MaxBodyInMemory: DefaultMaxBodyInMemory,
		UserAgent:       "Pakpos/" + buildinfo.Version,
	}
}

// Executor sends requests. It is safe for concurrent use.
type Executor struct {
	settings Settings
	client   *http.Client

	mu       sync.Mutex
	inflight map[string]context.CancelFunc
}

// New creates an Executor. Zero values in s fall back to DefaultSettings
// (except booleans and Timeout, which are taken as given).
func New(s Settings) *Executor {
	def := DefaultSettings()
	if s.MaxRedirects <= 0 {
		s.MaxRedirects = def.MaxRedirects
	}
	if s.MaxBodyInMemory <= 0 {
		s.MaxBodyInMemory = def.MaxBodyInMemory
	}
	if s.UserAgent == "" {
		s.UserAgent = def.UserAgent
	}
	if s.TempDir == "" {
		s.TempDir = os.TempDir()
	}

	transport := http.DefaultTransport.(*http.Transport).Clone()
	transport.TLSClientConfig = &tls.Config{InsecureSkipVerify: s.InsecureSkipVerify} //nolint:gosec // user-controlled setting
	client := &http.Client{
		Transport: transport,
		Jar:       s.Jar,
		CheckRedirect: func(_ *http.Request, via []*http.Request) error {
			if !s.FollowRedirects {
				return http.ErrUseLastResponse
			}
			if len(via) > s.MaxRedirects {
				return errTooManyRedirects
			}
			return nil
		},
	}
	return &Executor{settings: s, client: client, inflight: map[string]context.CancelFunc{}}
}

// Settings returns the effective settings.
func (e *Executor) Settings() Settings { return e.settings }

// Execute sends req and reads the response. id identifies the send for
// Cancel; an empty id disables cancellation by id. Errors are *Error.
func (e *Executor) Execute(ctx context.Context, id string, req model.Request) (*model.Response, error) {
	ctx, cancel := context.WithCancel(ctx)
	defer cancel()
	if e.settings.Timeout > 0 {
		var cancelTimeout context.CancelFunc
		ctx, cancelTimeout = context.WithTimeout(ctx, e.settings.Timeout)
		defer cancelTimeout()
	}
	if id != "" {
		if err := e.register(id, cancel); err != nil {
			return nil, err
		}
		defer e.unregister(id)
	}

	httpReq, err := e.Build(ctx, req)
	if err != nil {
		return nil, Classify(err)
	}

	tr := &tracer{}
	httpReq = httpReq.WithContext(httptrace.WithClientTrace(ctx, tr.clientTrace()))

	tr.start = time.Now()
	resp, err := e.client.Do(httpReq)
	if err != nil {
		return nil, Classify(err)
	}
	defer resp.Body.Close()

	out := newResponse(resp)
	if err := e.readBody(resp, out); err != nil {
		return nil, Classify(err)
	}
	out.Timings = tr.timings(time.Now())
	return out, nil
}

// Cancel aborts the in-flight send with the given id. It reports whether a
// send was found.
func (e *Executor) Cancel(id string) bool {
	e.mu.Lock()
	cancel, ok := e.inflight[id]
	e.mu.Unlock()
	if ok {
		cancel()
	}
	return ok
}

// InFlight reports whether a send with the given id is running.
func (e *Executor) InFlight(id string) bool {
	e.mu.Lock()
	defer e.mu.Unlock()
	_, ok := e.inflight[id]
	return ok
}

func (e *Executor) register(id string, cancel context.CancelFunc) error {
	e.mu.Lock()
	defer e.mu.Unlock()
	if _, exists := e.inflight[id]; exists {
		return newError(KindInvalidRequest, nil, "A request with id %q is already being sent", id)
	}
	e.inflight[id] = cancel
	return nil
}

func (e *Executor) unregister(id string) {
	e.mu.Lock()
	delete(e.inflight, id)
	e.mu.Unlock()
}
