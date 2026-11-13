package httpexec

import (
	"crypto/tls"
	"net/http/httptrace"
	"sync"
	"time"

	"pakpos/internal/core/model"
)

// tracer records phase boundaries. Callbacks may run on transport
// goroutines, so access is guarded.
type tracer struct {
	mu sync.Mutex

	start, dnsStart, dnsDone, connStart, connDone time.Time
	tlsStart, tlsDone, wroteRequest, firstByte    time.Time
	reused                                        bool
}

func (t *tracer) set(field *time.Time) {
	t.mu.Lock()
	*field = time.Now()
	t.mu.Unlock()
}

func (t *tracer) clientTrace() *httptrace.ClientTrace {
	return &httptrace.ClientTrace{
		DNSStart:     func(httptrace.DNSStartInfo) { t.set(&t.dnsStart) },
		DNSDone:      func(httptrace.DNSDoneInfo) { t.set(&t.dnsDone) },
		ConnectStart: func(string, string) { t.set(&t.connStart) },
		ConnectDone:  func(string, string, error) { t.set(&t.connDone) },
		TLSHandshakeStart: func() {
			t.set(&t.tlsStart)
		},
		TLSHandshakeDone: func(tls.ConnectionState, error) { t.set(&t.tlsDone) },
		GotConn: func(info httptrace.GotConnInfo) {
			t.mu.Lock()
			t.reused = info.Reused
			t.mu.Unlock()
		},
		WroteRequest:         func(httptrace.WroteRequestInfo) { t.set(&t.wroteRequest) },
		GotFirstResponseByte: func() { t.set(&t.firstByte) },
	}
}

func ms(from, to time.Time) float64 {
	if from.IsZero() || to.IsZero() || to.Before(from) {
		return 0
	}
	return float64(to.Sub(from).Microseconds()) / 1000
}

func (t *tracer) timings(end time.Time) model.Timings {
	t.mu.Lock()
	defer t.mu.Unlock()
	// After redirects, phases reflect the last connection; TTFB is measured
	// from the last request write so it isolates server think time.
	return model.Timings{
		DNS:        ms(t.dnsStart, t.dnsDone),
		Connect:    ms(t.connStart, t.connDone),
		TLS:        ms(t.tlsStart, t.tlsDone),
		TTFB:       ms(t.wroteRequest, t.firstByte),
		Total:      ms(t.start, end),
		ReusedConn: t.reused,
	}
}
