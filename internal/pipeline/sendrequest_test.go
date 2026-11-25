package pipeline

import (
	"context"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"testing"

	"pakpos/internal/core/cookies"
	"pakpos/internal/core/httpexec"
	"pakpos/internal/core/model"
)

// tokenServer answers /token when it gets the resolved credentials, and
// sets a cookie.
func tokenServer(t *testing.T) *httptest.Server {
	t.Helper()
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/token":
			body, _ := io.ReadAll(r.Body)
			if r.Header.Get("Authorization") != "Bearer s3cret" || string(body) != "host=dev.example" || r.URL.Query().Get("env") != "dev.example" {
				http.Error(w, "bad request: "+r.Header.Get("Authorization")+" "+string(body), http.StatusBadRequest)
				return
			}
			http.SetCookie(w, &http.Cookie{Name: "sid", Value: "from-server", Path: "/"})
			w.Header().Set("Content-Type", "application/json")
			_, _ = io.WriteString(w, `{"access_token":"fresh-token-123"}`)
		case "/big":
			_, _ = io.WriteString(w, strings.Repeat("x", 2048))
		case "/cookies":
			c, _ := r.Cookie("sid")
			if c != nil {
				_, _ = io.WriteString(w, c.Value)
			}
		}
	}))
	t.Cleanup(srv.Close)
	return srv
}

func newExecutor(t *testing.T) (*httpexec.Executor, *cookies.Jar) {
	t.Helper()
	jar, err := cookies.New(cookies.Options{})
	if err != nil {
		t.Fatal(err)
	}
	s := httpexec.DefaultSettings()
	s.Jar = jar
	s.MaxBodyInMemory = 1024
	s.TempDir = t.TempDir()
	return httpexec.New(s), jar
}

func TestSendRequestFromScripts(t *testing.T) {
	f := newFixture(t)
	f.sess.WithOverlay(NewOverlay())
	srv := tokenServer(t)
	exec, jar := newExecutor(t)
	f.withScripts(model.Scripts{}, model.Scripts{}, model.Scripts{
		PreRequest: `
pm.sendRequest({
  url: "` + srv.URL + `/token?env={{host}}",
  method: "POST",
  header: {Authorization: "Bearer {{token}}"},
  body: {mode: "raw", raw: "host={{host}}"},
}, (err, res) => {
  if (err) throw err;
  pm.environment.set("access", res.json().access_token);
  console.log("status", res.code, "cookie", pm.cookies.jar() && "jar");
});
const big = await pm.sendRequest("` + srv.URL + `/big");
pm.variables.set("bigLength", big.text().length);
const echoed = await pm.sendRequest("` + srv.URL + `/cookies");
pm.variables.set("echoed", echoed.text());
`,
		Test: `
pm.test("jar", async () => {
  const v = await pm.cookies.jar().get("` + srv.URL + `/", "sid");
  pm.expect(v).to.equal("from-server");
});
`,
	})
	sd := f.sess.NewSend(f.req, "", f.dev.ID, ScriptOptions{Executor: exec, Jar: jar})
	pre := sd.PreRequest(context.Background())
	if pre.Err != nil {
		t.Fatalf("pre = %+v", pre.Err)
	}
	local := sd.Local()
	if local["bigLength"] != "2048" || local["echoed"] != "from-server" {
		t.Errorf("local = %v", local)
	}
	p, err := sd.Prepare()
	if err != nil {
		t.Fatal(err)
	}
	vals := must(f.sess.OverlayValues(ScopeRef{Kind: "environment", ID: f.dev.ID}))
	if len(vals) != 1 || vals[0].Key != "access" || vals[0].Value != "fresh-token-123" {
		t.Errorf("overlay = %+v (request %s)", vals, p.Request.URL)
	}
	texts := consoleTexts(pre.Console)
	if len(texts) != 4 || !strings.HasPrefix(texts[0], "pm.sendRequest POST "+srv.URL+"/token?env={{host}} → 200 OK") ||
		texts[3] != "status 200 cookie jar" {
		t.Errorf("console = %q", texts)
	}
	// The spilled body of /big was removed.
	if left, _ := os.ReadDir(exec.Settings().TempDir); len(left) != 0 {
		t.Errorf("temp files left: %v", left)
	}
	test := sd.Test(context.Background(), &model.Response{StatusCode: 200})
	if len(test.Tests) != 1 || !test.Tests[0].Passed {
		t.Errorf("tests = %+v", test.Tests)
	}
}

func TestSendRequestErrorsAreMasked(t *testing.T) {
	f := newFixture(t)
	exec, _ := newExecutor(t)
	f.withScripts(model.Scripts{}, model.Scripts{}, model.Scripts{PreRequest: `
pm.sendRequest("http://{{token}}:99999/", (err) => pm.variables.set("err", err.message));
`})
	sd := f.sess.NewSend(f.req, "", f.dev.ID, ScriptOptions{Executor: exec})
	pre := sd.PreRequest(context.Background())
	if pre.Err != nil {
		t.Fatal(pre.Err)
	}
	msg := sd.Local()["err"]
	if msg == "" || strings.Contains(msg, "s3cret") {
		t.Errorf("err = %q", msg)
	}
	for _, line := range consoleTexts(pre.Console) {
		if strings.Contains(line, "s3cret") {
			t.Errorf("console leaks the secret: %q", line)
		}
	}
}

func TestSendRequestOffAndUnavailable(t *testing.T) {
	cases := []struct {
		opts ScriptOptions
		want string
	}{
		{ScriptOptions{RequestsOff: true}, MsgScriptRequestsOff},
		{ScriptOptions{}, "pm.sendRequest isn't available here"},
	}
	for _, c := range cases {
		f := newFixture(t)
		f.withScripts(model.Scripts{}, model.Scripts{}, model.Scripts{PreRequest: `pm.sendRequest("https://x.test", (err) => pm.variables.set("err", err.message));`})
		sd := f.sess.NewSend(f.req, "", f.dev.ID, c.opts)
		if pre := sd.PreRequest(context.Background()); pre.Err != nil {
			t.Fatal(pre.Err)
		}
		if got := sd.Local()["err"]; got != c.want {
			t.Errorf("err = %q, want %q", got, c.want)
		}
	}
}

func TestScriptCookiesResolveURLs(t *testing.T) {
	f := newFixture(t)
	_, jar := newExecutor(t)
	f.withScripts(model.Scripts{}, model.Scripts{}, model.Scripts{PreRequest: `
const jar = pm.cookies.jar();
await jar.set("{{host}}/app", {name: "a", value: "1", path: "/"});
pm.variables.set("viaRequest", pm.cookies.get("a"));
pm.variables.set("all", (await jar.getAll("http://dev.example/")).length);
await jar.unset("dev.example", "a");
pm.variables.set("afterUnset", pm.cookies.count());
jar.get("http://", "a", (err) => pm.variables.set("badURL", err.message));
jar.getAll("{{token}}x://", (err) => pm.variables.set("masked", err.message));
`})
	sd := f.sess.NewSend(f.req, "", f.dev.ID, ScriptOptions{Jar: jar})
	if pre := sd.PreRequest(context.Background()); pre.Err != nil {
		t.Fatal(pre.Err)
	}
	local := sd.Local()
	// f.req's URL is https://{{host}}/users, i.e. dev.example.
	if local["viaRequest"] != "1" || local["all"] != "1" || local["afterUnset"] != "0" {
		t.Errorf("local = %v", local)
	}
	if !strings.Contains(local["badURL"], "isn't a URL cookies can belong to") {
		t.Errorf("badURL = %q", local["badURL"])
	}
	if strings.Contains(local["masked"], "s3cret") || local["masked"] == "" {
		t.Errorf("masked = %q", local["masked"])
	}
}
