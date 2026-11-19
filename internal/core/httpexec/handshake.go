package httpexec

import (
	"context"
	"crypto/tls"
	"encoding/base64"
	"io"
	"net/http"
	"net/http/httptrace"
	"strings"
	"sync"

	"github.com/Azure/go-ntlmssp"

	"pakpos/internal/core/auth"
	"pakpos/internal/core/auth/digest"
	"pakpos/internal/core/model"
)

// send builds and sends req, answering a Digest challenge or running the
// NTLM handshake when the request's auth asks for one. Every exchange goes
// through the client, so each one is a hop in the Debug tab.
func (e *Executor) send(ctx context.Context, req model.Request, tr *tracer) (*http.Response, error) {
	httpReq, err := e.Build(ctx, req)
	if err != nil {
		return nil, err
	}
	own := httpReq.Header.Get("Authorization") != "" // the user's header wins
	if req.Auth.Type == model.AuthNTLM && req.Auth.NTLM != nil && !own {
		return e.sendNTLM(ctx, req, httpReq, tr)
	}
	resp, err := e.do(ctx, httpReq, tr)
	if err != nil {
		return nil, err
	}
	if req.Auth.Type == model.AuthDigest && req.Auth.Digest != nil && !own && resp.StatusCode == http.StatusUnauthorized {
		return e.answerDigest(ctx, req, httpReq, resp, tr)
	}
	return resp, nil
}

func (e *Executor) do(ctx context.Context, r *http.Request, tr *tracer) (*http.Response, error) {
	return e.client.Do(r.WithContext(httptrace.WithClientTrace(ctx, tr.clientTrace())))
}

// discard drains and closes a response body so its connection can be
// reused (the NTLM handshake needs the same connection).
func discard(resp *http.Response) {
	_, _ = io.Copy(io.Discard, io.LimitReader(resp.Body, 1<<20))
	_ = resp.Body.Close()
}

// answerDigest sends the request again, once, with the answer to the
// Digest challenge of a 401. A 401 without a challenge Pakpos can answer,
// or one that came after a redirect, is returned as it is.
func (e *Executor) answerDigest(ctx context.Context, req model.Request, first *http.Request, resp *http.Response, tr *tracer) (*http.Response, error) {
	d := req.Auth.Digest
	c, err := digest.Choose(digest.Parse(resp.Header.Values("WWW-Authenticate")), d.Algorithm)
	if err != nil || resp.Request == nil || resp.Request.URL.String() != first.URL.String() {
		return resp, nil
	}
	discard(resp)
	next, err := e.Build(ctx, req)
	if err != nil {
		return nil, err
	}
	var body []byte
	if digest.NeedsBody(c, d.Qop) && next.Body != nil {
		if body, err = io.ReadAll(next.Body); err != nil {
			return nil, err
		}
		_ = next.Body.Close()
		auth.SetBody(next, body)
	}
	h, err := digest.Authorization(c, d.Username, d.Password, digest.Request{Method: next.Method, URI: next.URL.RequestURI(), Body: body, Qop: d.Qop})
	if err != nil {
		closeBody(next)
		return nil, newError(KindAuth, err, "The Digest challenge couldn't be answered: %s", err.Error())
	}
	next.Header.Set("Authorization", h)
	return e.do(ctx, next, tr)
}

// sendNTLM runs the NTLM handshake: the request with a NEGOTIATE message,
// then, on a 401 with the server's CHALLENGE, the request again with the
// AUTHENTICATE message. Both go over the send's own connection (see
// dedicated), since NTLM authenticates the connection, not the request.
func (e *Executor) sendNTLM(ctx context.Context, req model.Request, first *http.Request, tr *tracer) (*http.Response, error) {
	n := req.Auth.NTLM
	neg, err := ntlmssp.NewNegotiateMessage("", strings.TrimSpace(n.Workstation))
	if err != nil {
		closeBody(first)
		return nil, newError(KindAuth, err, "The NTLM handshake couldn't start: %s", err.Error())
	}
	first.Header.Set("Authorization", "NTLM "+base64.StdEncoding.EncodeToString(neg))
	resp, err := e.do(ctx, first, tr)
	if err != nil || resp.StatusCode != http.StatusUnauthorized {
		return resp, err
	}
	challenge := ntlmChallenge(resp.Header.Values("WWW-Authenticate"))
	if challenge == nil {
		return resp, nil
	}
	discard(resp)
	user := strings.TrimSpace(n.Username)
	if d := strings.TrimSpace(n.Domain); d != "" && !strings.ContainsAny(user, `\@`) {
		user = d + `\` + user
	}
	msg, err := ntlmssp.NewAuthenticateMessage(challenge, user, n.Password, &ntlmssp.AuthenticateMessageOptions{WorkstationName: strings.TrimSpace(n.Workstation)})
	if err != nil {
		return nil, newError(KindAuth, err, "The NTLM challenge couldn't be answered: %s", err.Error())
	}
	next, err := e.Build(ctx, req)
	if err != nil {
		return nil, err
	}
	next.Header.Set("Authorization", "NTLM "+base64.StdEncoding.EncodeToString(msg))
	return e.do(ctx, next, tr)
}

// ntlmChallenge returns the decoded CHALLENGE message of an "NTLM <base64>"
// WWW-Authenticate value, or nil.
func ntlmChallenge(values []string) []byte {
	for _, v := range values {
		for _, part := range strings.Split(v, ",") {
			scheme, data, ok := strings.Cut(strings.TrimSpace(part), " ")
			if !ok || !strings.EqualFold(scheme, "NTLM") {
				continue
			}
			if b, err := base64.StdEncoding.DecodeString(strings.TrimSpace(data)); err == nil && len(b) > 0 {
				return b
			}
		}
	}
	return nil
}

// dedicated holds the transports of one send that must not share
// connections with other sends (NTLM): HTTP/1.1 only, one connection per
// host, closed when the send ends.
type dedicated struct {
	mu sync.Mutex
	m  map[transportKey]*http.Transport
}

type dedicatedKey struct{}

func withDedicated(ctx context.Context) (context.Context, func()) {
	d := &dedicated{m: map[transportKey]*http.Transport{}}
	return context.WithValue(ctx, dedicatedKey{}, d), d.close
}

func dedicatedFrom(ctx context.Context) *dedicated {
	d, _ := ctx.Value(dedicatedKey{}).(*dedicated)
	return d
}

func (d *dedicated) get(n Network, insecure bool, cert *ClientCert) (*http.Transport, error) {
	k := transportKey{network: n.key(), insecure: insecure}
	if cert != nil {
		k.cert = cert.ID + "\x00" + cert.Host
	}
	d.mu.Lock()
	defer d.mu.Unlock()
	if tr, ok := d.m[k]; ok {
		return tr, nil
	}
	tr, err := n.buildTransport(insecure, cert)
	if err != nil {
		return nil, err
	}
	tr.ForceAttemptHTTP2 = false
	tr.TLSNextProto = map[string]func(string, *tls.Conn) http.RoundTripper{}
	tr.MaxConnsPerHost = 1
	d.m[k] = tr
	return tr, nil
}

func (d *dedicated) close() {
	d.mu.Lock()
	defer d.mu.Unlock()
	for _, tr := range d.m {
		tr.CloseIdleConnections()
	}
}
