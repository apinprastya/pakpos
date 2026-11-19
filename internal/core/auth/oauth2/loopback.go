package oauth2

import (
	"context"
	"crypto/subtle"
	"errors"
	"fmt"
	"html/template"
	"io"
	"net"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"sync"
	"time"
)

// DefaultCallbackPath is the path of the random-port loopback callback.
const DefaultCallbackPath = "/callback"

// Redirect is a parsed loopback callback URL.
type Redirect struct {
	// Host is 127.0.0.1 or localhost.
	Host string
	// Port is 0 for a random port.
	Port int
	Path string
}

// ParseRedirect reads a callback URL setting: "" is a random port on
// 127.0.0.1 (path /callback); otherwise http://127.0.0.1:<port>/<path> or
// http://localhost:<port>/<path>.
func ParseRedirect(raw string) (Redirect, error) {
	raw = strings.TrimSpace(raw)
	if raw == "" {
		return Redirect{Host: "127.0.0.1", Path: DefaultCallbackPath}, nil
	}
	bad := errors.New("the callback URL must be http://127.0.0.1:<port>/<path> or http://localhost:<port>/<path>, or empty for a random port")
	u, err := url.Parse(raw)
	if err != nil || u.Scheme != "http" || u.User != nil || u.RawQuery != "" || u.Fragment != "" {
		return Redirect{}, bad
	}
	host := u.Hostname()
	if host != "127.0.0.1" && host != "localhost" {
		return Redirect{}, bad
	}
	port, err := strconv.Atoi(u.Port())
	if err != nil || port < 1 || port > 65535 {
		return Redirect{}, bad
	}
	path := u.EscapedPath()
	if path == "" {
		path = "/"
	}
	return Redirect{Host: host, Port: port, Path: path}, nil
}

// Loopback is a single-use callback server on the loopback interface.
// It answers the browser's redirect, checks the state and hands the
// parameters to Wait. Every later request gets a "used" page.
type Loopback struct {
	srv      *http.Server
	lns      []net.Listener
	redirect string
	path     string
	state    string
	implicit bool
	result   chan callback
	once     sync.Once
	closed   sync.Once
}

type callback struct {
	params map[string]string
	err    error
}

// Listen starts a loopback server for the callback URL setting raw (see
// ParseRedirect). state is the value the response must carry. implicit
// serves the page that posts the URL fragment back.
func Listen(raw, state string, implicit bool) (*Loopback, error) {
	r, err := ParseRedirect(raw)
	if err != nil {
		return nil, err
	}
	ln, err := net.Listen("tcp", net.JoinHostPort("127.0.0.1", strconv.Itoa(r.Port)))
	if err != nil {
		return nil, fmt.Errorf("can't listen for the callback on port %d (another program may be using it): %w", r.Port, err)
	}
	listeners := []net.Listener{ln}
	port := ln.Addr().(*net.TCPAddr).Port
	if r.Host == "localhost" {
		// Browsers may resolve localhost to ::1 first.
		if ln6, err := net.Listen("tcp", net.JoinHostPort("::1", strconv.Itoa(port))); err == nil {
			listeners = append(listeners, ln6)
		}
	}
	l := &Loopback{
		redirect: fmt.Sprintf("http://%s:%d%s", r.Host, port, r.Path),
		path:     r.Path, state: state, implicit: implicit,
		result: make(chan callback, 1), lns: listeners,
	}
	l.srv = &http.Server{Handler: l, ReadHeaderTimeout: 10 * time.Second}
	for _, ln := range listeners {
		go func() { _ = l.srv.Serve(ln) }()
	}
	return l, nil
}

// RedirectURL is the redirect_uri to send (with the actual port).
func (l *Loopback) RedirectURL() string { return l.redirect }

// Wait returns the callback parameters, or the error the callback carried
// (*Error, ErrStateMismatch), or ctx's error.
func (l *Loopback) Wait(ctx context.Context) (map[string]string, error) {
	select {
	case cb := <-l.result:
		return cb.params, cb.err
	case <-ctx.Done():
		return nil, ctx.Err()
	}
}

// Close stops the server.
func (l *Loopback) Close() error {
	var err error
	l.closed.Do(func() {
		ctx, cancel := context.WithTimeout(context.Background(), time.Second)
		defer cancel()
		err = l.srv.Shutdown(ctx)
		// Serve may not have taken a listener over yet.
		for _, ln := range l.lns {
			_ = ln.Close()
		}
	})
	return err
}

// deliver hands the first result to Wait; it reports whether this was it.
func (l *Loopback) deliver(cb callback) bool {
	first := false
	l.once.Do(func() {
		first = true
		l.result <- cb
	})
	return first
}

// Messages shown on the callback page.
const (
	msgDone     = "You can close this window and return to Pakpos."
	msgUsed     = "This sign-in response was already handled. You can close this window."
	msgMismatch = "This response doesn't match the request Pakpos made. Start again from Pakpos."
	msgNoParams = "Pakpos didn't get an authorization response. Start again from Pakpos."
	msgPostFail = "Pakpos didn't get the response. Start again from Pakpos."
)

func (l *Loopback) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	h := w.Header()
	h.Set("Cache-Control", "no-store")
	h.Set("Referrer-Policy", "no-referrer")
	h.Set("X-Content-Type-Options", "nosniff")
	h.Set("Content-Security-Policy", "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; connect-src 'self'")
	if r.URL.EscapedPath() != l.path {
		http.NotFound(w, r)
		return
	}
	switch r.Method {
	case http.MethodGet:
		q := r.URL.Query()
		if !q.Has("code") && !q.Has("error") && !q.Has("state") && !q.Has("access_token") {
			if l.implicit {
				page(w, http.StatusOK, "Pakpos", "Finishing sign-in…", true)
				return
			}
			page(w, http.StatusBadRequest, "Sign-in failed", msgNoParams, false)
			return
		}
		status, title, msg := l.handle(flatten(q))
		page(w, status, title, msg, false)
	case http.MethodPost:
		if !l.implicit {
			http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
			return
		}
		body, err := io.ReadAll(io.LimitReader(r.Body, 64<<10))
		q, perr := url.ParseQuery(string(body))
		if err != nil || perr != nil || len(q) == 0 {
			h.Set("Content-Type", "text/plain; charset=utf-8")
			w.WriteHeader(http.StatusBadRequest)
			_, _ = io.WriteString(w, msgNoParams)
			return
		}
		status, _, msg := l.handle(flatten(q))
		h.Set("Content-Type", "text/plain; charset=utf-8")
		w.WriteHeader(status)
		_, _ = io.WriteString(w, msg)
	default:
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
	}
}

// handle checks a response's state and delivers it (once).
func (l *Loopback) handle(params map[string]string) (int, string, string) {
	if subtle.ConstantTimeCompare([]byte(params["state"]), []byte(l.state)) != 1 {
		if !l.deliver(callback{err: ErrStateMismatch}) {
			return http.StatusConflict, "Already done", msgUsed
		}
		return http.StatusBadRequest, "Sign-in failed", msgMismatch
	}
	var cb callback
	if code := params["error"]; code != "" {
		cb.err = &Error{Code: code, Description: params["error_description"], URI: params["error_uri"]}
	} else {
		cb.params = params
	}
	if !l.deliver(cb) {
		return http.StatusConflict, "Already done", msgUsed
	}
	if cb.err != nil {
		return http.StatusBadRequest, "Sign-in failed", cb.err.Error() + " Return to Pakpos to try again."
	}
	return http.StatusOK, "Signed in", msgDone
}

var pageTmpl = template.Must(template.New("page").Parse(`<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>{{.Title}} · Pakpos</title>
<style>
:root{color-scheme:light dark;--bg:#fafafa;--fg:#18181b;--muted:#71717a;--border:#e4e4e7}
@media (prefers-color-scheme:dark){:root{--bg:#18181b;--fg:#fafafa;--muted:#a1a1aa;--border:#3f3f46}}
body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;background:var(--bg);color:var(--fg);font:15px/1.5 system-ui,-apple-system,"Segoe UI",sans-serif}
main{max-width:28rem;margin:16px;padding:24px 28px;border:1px solid var(--border);border-radius:10px}
h1{margin:0 0 8px;font-size:17px;font-weight:600}p{margin:0;color:var(--muted)}
</style></head>
<body><main><h1 id="title">{{.Title}}</h1><p id="msg">{{.Message}}</p></main>
{{if .Script}}<script>
(function(){
  var h=location.hash.slice(1),t=document.getElementById("title"),m=document.getElementById("msg");
  history.replaceState(null,"",location.pathname);
  if(!h){t.textContent="Sign-in failed";m.textContent={{.NoParams}};return;}
  fetch(location.pathname,{method:"POST",headers:{"Content-Type":"application/x-www-form-urlencoded"},body:h})
    .then(function(r){return r.text().then(function(x){t.textContent=r.ok?"Signed in":"Sign-in failed";m.textContent=x;});})
    .catch(function(){t.textContent="Sign-in failed";m.textContent={{.PostFail}};});
})();
</script>{{end}}
</body></html>
`))

func page(w http.ResponseWriter, status int, title, msg string, script bool) {
	w.Header().Set("Content-Type", "text/html; charset=utf-8")
	w.WriteHeader(status)
	_ = pageTmpl.Execute(w, map[string]any{
		"Title": title, "Message": msg, "Script": script, "NoParams": msgNoParams, "PostFail": msgPostFail,
	})
}
