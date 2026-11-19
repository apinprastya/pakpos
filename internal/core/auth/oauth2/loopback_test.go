package oauth2

import (
	"context"
	"errors"
	"io"
	"net/http"
	"net/url"
	"strings"
	"testing"
	"time"
)

func get(t *testing.T, u string) (int, string) {
	t.Helper()
	resp, err := http.Get(u)
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	b, _ := io.ReadAll(resp.Body)
	return resp.StatusCode, string(b)
}

func postForm(t *testing.T, u, body string) (int, string) {
	t.Helper()
	resp, err := http.Post(u, "application/x-www-form-urlencoded", strings.NewReader(body))
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	b, _ := io.ReadAll(resp.Body)
	return resp.StatusCode, string(b)
}

func TestLoopbackCode(t *testing.T) {
	lb, err := Listen("", "st", false)
	if err != nil {
		t.Fatal(err)
	}
	defer lb.Close()
	cb := lb.RedirectURL()
	if !strings.HasPrefix(cb, "http://127.0.0.1:") || !strings.HasSuffix(cb, "/callback") {
		t.Fatalf("redirect %q", cb)
	}
	base := strings.TrimSuffix(cb, "/callback")
	if status, _ := get(t, base+"/favicon.ico"); status != 404 {
		t.Error("other paths are 404")
	}
	if status, body := get(t, cb); status != 400 || !strings.Contains(body, "didn&#39;t get an authorization response") {
		t.Errorf("no params: %d %s", status, body)
	}
	if status, _ := postForm(t, cb, "code=x"); status != http.StatusMethodNotAllowed {
		t.Error("POST is for the implicit page only")
	}
	req, _ := http.NewRequest(http.MethodPut, cb, nil)
	if resp, _ := http.DefaultClient.Do(req); resp.StatusCode != http.StatusMethodNotAllowed {
		t.Error("PUT")
	}
	status, body := get(t, cb+"?code=abc&state=st")
	if status != 200 || !strings.Contains(body, "You can close this window and return to Pakpos.") || !strings.Contains(body, "prefers-color-scheme:dark") || strings.Contains(body, "<script") {
		t.Errorf("done page: %d %s", status, body)
	}
	params, err := lb.Wait(context.Background())
	if err != nil || params["code"] != "abc" {
		t.Fatalf("wait %v %v", params, err)
	}
	// Single use.
	if status, body := get(t, cb+"?code=again&state=st"); status != http.StatusConflict || !strings.Contains(body, "already handled") {
		t.Errorf("reuse: %d", status)
	}
	if status, _ := get(t, cb+"?code=again&state=bad"); status != http.StatusConflict {
		t.Errorf("reuse with a bad state: %d", status)
	}
	if err := lb.Close(); err != nil {
		t.Fatal(err)
	}
	_ = lb.Close()
}

func TestLoopbackStateMismatchAndErrors(t *testing.T) {
	lb := must2(Listen("", "st", false))
	defer lb.Close()
	if status, body := get(t, lb.RedirectURL()+"?code=abc&state=evil"); status != 400 || !strings.Contains(body, "match the request") {
		t.Errorf("mismatch: %d %s", status, body)
	}
	if _, err := lb.Wait(context.Background()); !errors.Is(err, ErrStateMismatch) {
		t.Errorf("err = %v", err)
	}

	lb2 := must2(Listen("", "st", false))
	defer lb2.Close()
	status, body := get(t, lb2.RedirectURL()+"?error=access_denied&error_description=nope&state=st")
	if status != 400 || !strings.Contains(body, "access_denied") {
		t.Errorf("error page: %d %s", status, body)
	}
	var e *Error
	if _, err := lb2.Wait(context.Background()); !errors.As(err, &e) || e.Description != "nope" {
		t.Errorf("err = %v", err)
	}

	lb3 := must2(Listen("", "st", false))
	defer lb3.Close()
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Millisecond)
	defer cancel()
	if _, err := lb3.Wait(ctx); !errors.Is(err, context.DeadlineExceeded) {
		t.Errorf("timeout %v", err)
	}
	if _, err := Listen("ftp://x", "", false); err == nil {
		t.Error("bad redirect")
	}
}

func TestLoopbackImplicit(t *testing.T) {
	lb := must2(Listen("http://localhost:"+freePort(t)+"/cb", "st", true))
	defer lb.Close()
	cb := lb.RedirectURL()
	status, body := get(t, strings.Replace(cb, "localhost", "127.0.0.1", 1))
	if status != 200 || !strings.Contains(body, "<script>") || !strings.Contains(body, "location.hash") {
		t.Errorf("page: %d %s", status, body)
	}
	if status, _ := postForm(t, strings.Replace(cb, "localhost", "127.0.0.1", 1), ""); status != 400 {
		t.Error("empty post")
	}
	frag := url.Values{"access_token": {"tok"}, "token_type": {"Bearer"}, "state": {"st"}}.Encode()
	status, body = postForm(t, strings.Replace(cb, "localhost", "127.0.0.1", 1), frag)
	if status != 200 || body != "You can close this window and return to Pakpos." {
		t.Errorf("post: %d %q", status, body)
	}
	params, err := lb.Wait(context.Background())
	if err != nil || params["access_token"] != "tok" {
		t.Fatalf("wait %v %v", params, err)
	}
	if _, err := tokenFrom(map[string]string{}, now); !errors.Is(err, ErrNoAccessToken) {
		t.Error("no token in the fragment")
	}
}

func must2[T any](v T, err error) T {
	if err != nil {
		panic(err)
	}
	return v
}
