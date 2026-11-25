package service

import (
	"context"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"pakpos/internal/core/httpexec"
	"pakpos/internal/core/model"
	"pakpos/internal/core/vars"
	"pakpos/internal/pipeline"
)

// TestEndToEndSendRequest: a pre-request script fetches a token with
// pm.sendRequest (credentials from a secret), the request uses it, and a
// test script reads the cookie the token endpoint set. Turning the setting
// off stops pm.sendRequest; the runner sends script requests too.
func TestEndToEndSendRequest(t *testing.T) {
	tokens := 0
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/token":
			user, pass, _ := r.BasicAuth()
			if user != "client" || pass != "client-secret-1" {
				http.Error(w, "bad client", http.StatusUnauthorized)
				return
			}
			tokens++
			http.SetCookie(w, &http.Cookie{Name: "session", Value: "abc", Path: "/"})
			_, _ = io.WriteString(w, `{"access_token":"tok-`+strings.Repeat("9", tokens)+`"}`)
		case "/me":
			if !strings.HasPrefix(r.Header.Get("Authorization"), "Bearer tok-") {
				http.Error(w, "no token", http.StatusUnauthorized)
				return
			}
			_, _ = io.WriteString(w, `{"ok":true}`)
		}
	}))
	t.Cleanup(srv.Close)

	h := newHarness(t)
	h.openWorkspace(t)
	col, err := h.ws.CreateCollection("API")
	if err != nil {
		t.Fatal(err)
	}
	env, err := h.env.Create("Dev")
	if err != nil {
		t.Fatal(err)
	}
	ref := pipeline.ScopeRef{Kind: vars.ScopeEnvironment, ID: env.ID}
	if _, err := h.env.SaveVariables(ref, []model.Variable{
		{Key: "base", Value: srv.URL, Enabled: true},
		{Key: "clientSecret", Enabled: true, Secret: true},
	}, nil); err != nil {
		t.Fatal(err)
	}
	if err := h.env.SetSecret(ref, "clientSecret", "client-secret-1"); err != nil {
		t.Fatal(err)
	}
	if err := h.env.Select(env.ID); err != nil {
		t.Fatal(err)
	}
	req, err := h.req.SaveAs(col.ID, "Me", model.Request{
		Method: "GET", URL: "{{base}}/me",
		Auth: model.Auth{Type: model.AuthBearer, Token: "{{access}}"},
		Scripts: model.Scripts{
			PreRequest: `
const res = await pm.sendRequest({
  url: pm.environment.get("base") + "/token",
  method: "POST",
  auth: {type: "basic", basic: [{key: "username", value: "client"}, {key: "password", value: "{{clientSecret}}"}]},
});
pm.environment.set("access", res.json().access_token);
console.log("secret", pm.environment.get("clientSecret"));
`,
			Test: `
pm.test("authorized", () => pm.response.to.have.status(200));
pm.test("session cookie", () => pm.expect(pm.cookies.jar && pm.cookies.has("session", "abc")).to.be.true);
`,
		},
	})
	if err != nil {
		t.Fatal(err)
	}

	res, err := h.req.Send(context.Background(), "s1", req, col.ID)
	if err != nil || res.Error != nil {
		t.Fatalf("send = %+v, %v", res.Error, err)
	}
	if res.Response.StatusCode != 200 || len(res.Tests) != 2 || !res.Tests[0].Passed || !res.Tests[1].Passed {
		t.Fatalf("status %d, tests %+v", res.Response.StatusCode, res.Tests)
	}
	var lines []string
	for _, c := range res.Console {
		lines = append(lines, c.Text)
	}
	joined := strings.Join(lines, "\n")
	if !strings.Contains(joined, "pm.sendRequest POST "+srv.URL+"/token → 200 OK") ||
		!strings.Contains(joined, "secret [secret:clientSecret]") || strings.Contains(joined, "client-secret-1") {
		t.Errorf("console = %q", lines)
	}
	if cookies := h.core.cookieJar().All(); len(cookies) != 1 || cookies[0].Name != "session" {
		t.Errorf("jar = %+v", cookies)
	}

	// The runner sends script requests as well.
	run := NewRunnerService(h.core)
	if _, err := run.Start(RunConfig{TargetID: col.ID, EnvironmentID: env.ID}); err != nil {
		t.Fatal(err)
	}
	run.wait()
	if tokens != 2 {
		t.Errorf("token requests = %d, want 2", tokens)
	}

	// Off in Settings: the script's await rejects with the reason.
	s := h.set.Get()
	s.ScriptRequests = false
	if _, err := h.set.Set(s); err != nil {
		t.Fatal(err)
	}
	res, err = h.req.Send(context.Background(), "s2", req, col.ID)
	if err != nil {
		t.Fatal(err)
	}
	if res.Error == nil || res.Error.Kind != httpexec.KindScript || !strings.Contains(res.Error.Message, pipeline.MsgScriptRequestsOff) {
		t.Fatalf("error = %+v", res.Error)
	}
	if tokens != 2 {
		t.Errorf("a request went out while the setting was off")
	}
}
