// Package httpexec builds and sends HTTP requests described by model.Request,
// measuring timings and supporting cancellation. It has no Wails dependency.
package httpexec

import (
	"context"
	"fmt"
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

// Limits for the timeout and redirect settings (app-wide and per request).
const (
	MaxTimeoutMs    = 10 * 60 * 1000 // 10 minutes
	MaxRedirectsCap = 50
)

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
	// Network is the proxy and certificate configuration.
	Network Network
	// Transports caches transports across executors. Nil gives the executor
	// a cache of its own.
	Transports *Transports
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

	if s.Transports == nil {
		s.Transports = NewTransports()
	}

	e := &Executor{settings: s, inflight: map[string]context.CancelFunc{}}
	e.client = &http.Client{
		// Records hops for sends that ask for it (WithRecorder); each hop
		// goes through the cached transport for its TLS options and host.
		Transport: recordingTransport{base: routeTransport{e: e}},
		Jar:       s.Jar,
		CheckRedirect: func(req *http.Request, via []*http.Request) error {
			o := optionsFrom(req.Context(), e.settings)
			if !o.followRedirects {
				return http.ErrUseLastResponse
			}
			if len(via) > o.maxRedirects {
				return errTooManyRedirects
			}
			return nil
		},
	}
	return e
}

// sendOptions are the effective timeout, redirect and TLS options of one
// send: the app settings with the request's overrides applied.
type sendOptions struct {
	timeout         time.Duration
	followRedirects bool
	maxRedirects    int
	insecure        bool
}

type optionsKey struct{}

func optionsFrom(ctx context.Context, s Settings) sendOptions {
	if o, ok := ctx.Value(optionsKey{}).(sendOptions); ok {
		return o
	}
	return defaultOptions(s)
}

func defaultOptions(s Settings) sendOptions {
	return sendOptions{timeout: s.Timeout, followRedirects: s.FollowRedirects, maxRedirects: s.MaxRedirects, insecure: s.InsecureSkipVerify}
}

// ValidateRequestSettings checks per-request overrides against the same
// limits as the app settings.
func ValidateRequestSettings(rs model.RequestSettings) error {
	if rs.TimeoutMs != nil && (*rs.TimeoutMs < 0 || *rs.TimeoutMs > MaxTimeoutMs) {
		return fmt.Errorf("the request timeout must be between 0 and %d ms", MaxTimeoutMs)
	}
	if rs.MaxRedirects != nil && (*rs.MaxRedirects < 1 || *rs.MaxRedirects > MaxRedirectsCap) {
		return fmt.Errorf("the request's maximum redirects must be between 1 and %d", MaxRedirectsCap)
	}
	return nil
}

// options applies a request's overrides to the executor settings.
func (e *Executor) options(rs model.RequestSettings) (sendOptions, error) {
	if err := ValidateRequestSettings(rs); err != nil {
		return sendOptions{}, newError(KindInvalidRequest, err, "The request settings aren't valid: %s", err.Error())
	}
	o := defaultOptions(e.settings)
	if rs.TimeoutMs != nil {
		o.timeout = time.Duration(*rs.TimeoutMs) * time.Millisecond
	}
	if rs.FollowRedirects != nil {
		o.followRedirects = *rs.FollowRedirects
	}
	if rs.MaxRedirects != nil {
		o.maxRedirects = *rs.MaxRedirects
	}
	if rs.VerifyTLS != nil {
		o.insecure = !*rs.VerifyTLS
	}
	return o, nil
}

// Settings returns the effective settings.
func (e *Executor) Settings() Settings { return e.settings }

// Execute sends req and reads the response. id identifies the send for
// Cancel; an empty id disables cancellation by id. Errors are *Error.
func (e *Executor) Execute(ctx context.Context, id string, req model.Request) (*model.Response, error) {
	opts, err := e.options(req.Settings)
	if err != nil {
		return nil, err
	}
	ctx, cancel := context.WithCancel(context.WithValue(ctx, optionsKey{}, opts))
	defer cancel()
	if opts.timeout > 0 {
		var cancelTimeout context.CancelFunc
		ctx, cancelTimeout = context.WithTimeout(ctx, opts.timeout)
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
