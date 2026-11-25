package script

import (
	"context"
	"errors"
	"net/url"
	"strings"
	"testing"
	"time"

	"pakpos/internal/core/cookies"
	"pakpos/internal/core/model"
)

// fakeHTTP records requests and answers with resp (or err).
type fakeHTTP struct {
	got  []model.Request
	resp *Response
	err  error
	wait time.Duration
}

func (f *fakeHTTP) Send(ctx context.Context, req model.Request) (*Response, error) {
	f.got = append(f.got, req)
	if f.wait > 0 {
		select {
		case <-time.After(f.wait):
		case <-ctx.Done():
			return nil, ctx.Err()
		}
	}
	if f.err != nil {
		return nil, f.err
	}
	if f.resp != nil {
		return f.resp, nil
	}
	return jsonResponse(200, `{"token":"t-1","n":1}`), nil
}

// jarCookies is Cookies over a real jar, for tests.
type jarCookies struct{ jar *cookies.Jar }

func (j jarCookies) url(raw string) (*url.URL, error) {
	u, err := url.Parse(raw)
	if err != nil || u.Host == "" {
		return nil, errors.New("bad URL " + raw)
	}
	return u, nil
}

func (j jarCookies) List(raw string) ([]cookies.Cookie, error) {
	u, err := j.url(raw)
	if err != nil {
		return nil, err
	}
	return j.jar.ForURL(u), nil
}

func (j jarCookies) Set(raw string, c cookies.Cookie) (cookies.Cookie, error) {
	u, err := j.url(raw)
	if err != nil {
		return cookies.Cookie{}, err
	}
	return j.jar.SetForURL(u, c)
}

func (j jarCookies) Delete(raw, name string) error {
	u, err := j.url(raw)
	if err != nil {
		return err
	}
	j.jar.DeleteForURL(u, name)
	return nil
}

func newJarCookies(t *testing.T) jarCookies {
	t.Helper()
	jar, err := cookies.New(cookies.Options{})
	if err != nil {
		t.Fatal(err)
	}
	return jarCookies{jar: jar}
}

func TestSendRequestCallbackRunsAfterTheScript(t *testing.T) {
	h := &fakeHTTP{}
	vs := newVars()
	out := mustRun(t, Input{Source: reqSrc, HTTP: h, Vars: vs, Script: `
		const order = [];
		pm.sendRequest("https://auth.test/token?x=1", function (err, res) {
			order.push("callback");
			pm.environment.set("token", res.json().token);
			pm.environment.set("code", res.code);
			pm.environment.set("ct", res.headers.get("content-type"));
			pm.environment.set("order", order.join(","));
		});
		order.push("after");
	`})
	if vs.scopes["environment"]["token"] != "t-1" || vs.scopes["environment"]["code"] != "200" ||
		vs.scopes["environment"]["ct"] != "application/json" || vs.scopes["environment"]["order"] != "after,callback" {
		t.Fatalf("env = %v", vs.scopes["environment"])
	}
	if len(h.got) != 1 {
		t.Fatalf("requests = %+v", h.got)
	}
	r := h.got[0]
	if r.Method != "GET" || r.URL != "https://auth.test/token?x=1" || len(r.Query) != 1 || r.Query[0].Key != "x" ||
		r.Body.Type != model.BodyNone || r.Auth.Type != model.AuthNone {
		t.Fatalf("request = %+v", r)
	}
	if len(out.Console) != 1 || out.Console[0].Level != LevelInfo ||
		out.Console[0].Text != "pm.sendRequest GET https://auth.test/token?x=1 → 200 OK (12 ms)" {
		t.Fatalf("console = %+v", out.Console)
	}
}

func TestSendRequestShapes(t *testing.T) {
	cases := []struct {
		name, script string
		check        func(t *testing.T, r model.Request)
	}{
		{"raw json with headers", `pm.sendRequest({url: "https://x.test/a", method: "post",
			header: [{key: "X-A", value: 1}, "X-B: two", {key: "X-Off", value: "1", disabled: true}],
			body: {mode: "raw", raw: JSON.stringify({a: 1}), options: {raw: {language: "json"}}}}, () => {})`,
			func(t *testing.T, r model.Request) {
				if r.Method != "POST" || r.Body.Type != model.BodyRaw || r.Body.Raw != `{"a":1}` || r.Body.Language != model.LangJSON {
					t.Errorf("request = %+v", r)
				}
				want := []model.KeyValue{{Key: "X-A", Value: "1", Enabled: true}, {Key: "X-B", Value: "two", Enabled: true}, {Key: "X-Off", Value: "1"}}
				if len(r.Headers) != 3 || r.Headers[0] != want[0] || r.Headers[1] != want[1] || r.Headers[2] != want[2] {
					t.Errorf("headers = %+v", r.Headers)
				}
			}},
		{"header object and string body", `pm.sendRequest({url: "https://x.test", headers: {"X-A": "1"}, body: "plain"}, () => {})`,
			func(t *testing.T, r model.Request) {
				if len(r.Headers) != 1 || r.Headers[0].Key != "X-A" || r.Body.Raw != "plain" || r.Body.Language != model.LangText {
					t.Errorf("request = %+v", r)
				}
			}},
		{"url object", `pm.sendRequest({url: {raw: "https://x.test/raw"}}, () => {})`,
			func(t *testing.T, r model.Request) {
				if r.URL != "https://x.test/raw" {
					t.Errorf("url = %q", r.URL)
				}
			}},
		{"urlencoded", `pm.sendRequest({url: "https://x.test", method: "POST", body: {mode: "urlencoded",
			urlencoded: [{key: "grant_type", value: "client_credentials"}, {key: "off", value: "1", disabled: true}]}}, () => {})`,
			func(t *testing.T, r model.Request) {
				u := r.Body.URLEncoded
				if r.Body.Type != model.BodyURLEncoded || len(u) != 2 || u[0].Key != "grant_type" || !u[0].Enabled || u[1].Enabled {
					t.Errorf("body = %+v", r.Body)
				}
			}},
		{"formdata", `pm.sendRequest({url: "https://x.test", method: "POST", body: {mode: "formdata",
			formdata: [{key: "a", value: "1"}]}}, () => {})`,
			func(t *testing.T, r model.Request) {
				f := r.Body.FormData
				if r.Body.Type != model.BodyFormData || len(f) != 1 || f[0].Kind != model.FormText || f[0].Value != "1" || !f[0].Enabled {
					t.Errorf("body = %+v", r.Body)
				}
			}},
		{"graphql", `pm.sendRequest({url: "https://x.test", method: "POST", body: {mode: "graphql",
			graphql: {query: "{ me }", variables: '{"id": 1}'}}}, () => {})`,
			func(t *testing.T, r model.Request) {
				if r.Body.Raw != `{"query":"{ me }","variables":{"id":1}}` || r.Body.Language != model.LangJSON {
					t.Errorf("body = %+v", r.Body)
				}
			}},
		{"no body mode", `pm.sendRequest({url: "https://x.test", body: {}}, () => {})`,
			func(t *testing.T, r model.Request) {
				if r.Body.Type != model.BodyNone {
					t.Errorf("body = %+v", r.Body)
				}
			}},
		{"basic auth list", `pm.sendRequest({url: "https://x.test", auth: {type: "basic",
			basic: [{key: "username", value: "ann"}, {key: "password", value: "pw"}]}}, () => {})`,
			func(t *testing.T, r model.Request) {
				if r.Auth.Type != model.AuthBasic || r.Auth.Username != "ann" || r.Auth.Password != "pw" {
					t.Errorf("auth = %+v", r.Auth)
				}
			}},
		{"bearer object", `pm.sendRequest({url: "https://x.test", auth: {type: "bearer", bearer: {token: "tk"}}}, () => {})`,
			func(t *testing.T, r model.Request) {
				if r.Auth.Type != model.AuthBearer || r.Auth.Token != "tk" {
					t.Errorf("auth = %+v", r.Auth)
				}
			}},
		{"api key in query", `pm.sendRequest({url: "https://x.test", auth: {type: "apikey",
			apikey: [{key: "key", value: "k"}, {key: "value", value: "v"}, {key: "in", value: "query"}]}}, () => {})`,
			func(t *testing.T, r model.Request) {
				if r.Auth.Type != model.AuthAPIKey || r.Auth.APIKey != "k" || r.Auth.APIValue != "v" || r.Auth.APIIn != "query" {
					t.Errorf("auth = %+v", r.Auth)
				}
			}},
		{"noauth", `pm.sendRequest({url: "https://x.test", auth: {type: "noauth"}}, () => {})`,
			func(t *testing.T, r model.Request) {
				if r.Auth.Type != model.AuthNone {
					t.Errorf("auth = %+v", r.Auth)
				}
			}},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			h := &fakeHTTP{}
			mustRun(t, Input{Source: reqSrc, HTTP: h, Script: c.script})
			if len(h.got) != 1 {
				t.Fatalf("requests = %d", len(h.got))
			}
			c.check(t, h.got[0])
		})
	}
}

func TestSendRequestRefusals(t *testing.T) {
	cases := []struct{ script, want string }{
		{`pm.sendRequest(null, (e) => { throw e })`, "pm.sendRequest needs a URL or a request"},
		{`pm.sendRequest({url: " "}, (e) => { throw e })`, "pm.sendRequest needs a URL"},
		{`pm.sendRequest({url: "https://x", auth: {type: "digest"}}, (e) => { throw e })`, `not "digest"`},
		{`pm.sendRequest({url: "https://x", body: {mode: "file"}}, (e) => { throw e })`, `in "file" mode`},
		{`pm.sendRequest({url: "https://x", body: {mode: "formdata", formdata: [{key: "f", type: "file", src: "/etc/passwd"}]}}, (e) => { throw e })`, "can't upload files"},
		{`pm.sendRequest({url: "https://x", body: {mode: "graphql", graphql: {query: "q", variables: "{"}}}, (e) => { throw e })`, "GraphQL variables aren't valid JSON"},
		{`pm.sendRequest({url: "https://x", header: 5}, (e) => { throw e })`, "header must be a list"},
	}
	for _, c := range cases {
		h := &fakeHTTP{}
		_, err := run(t, Input{Source: reqSrc, HTTP: h, Script: c.script})
		if err == nil || !strings.Contains(err.Error(), c.want) {
			t.Errorf("%s: err = %v", c.script, err)
		}
		if len(h.got) != 0 {
			t.Errorf("%s: sent %d requests", c.script, len(h.got))
		}
	}
}

func TestSendRequestErrorGoesToTheCallback(t *testing.T) {
	h := &fakeHTTP{err: errors.New("Could not connect to x.test")}
	vs := newVars()
	out := mustRun(t, Input{Source: reqSrc, HTTP: h, Vars: vs, Script: `
		pm.sendRequest("https://x.test", (err, res) => {
			pm.variables.set("err", err.message);
			pm.variables.set("res", String(res));
		});
	`})
	if vs.scopes["local"]["err"] != "Could not connect to x.test" || vs.scopes["local"]["res"] != "undefined" {
		t.Fatalf("local = %v", vs.scopes["local"])
	}
	if len(out.Console) != 1 || out.Console[0].Level != LevelWarn || !strings.Contains(out.Console[0].Text, "failed: Could not connect") {
		t.Fatalf("console = %+v", out.Console)
	}
}

func TestSendRequestPromisesAndTopLevelAwait(t *testing.T) {
	h := &fakeHTTP{}
	vs := newVars()
	out := mustRun(t, Input{Source: testSrc, Response: jsonResponse(200, "{}"), HTTP: h, Vars: vs, Script: `
		const res = await pm.sendRequest("https://x.test/a");
		pm.environment.set("token", res.json().token);
		pm.sendRequest("https://x.test/b").then(r => pm.environment.set("b", r.code));
		pm.test("async test", async () => {
			const r = await pm.sendRequest("https://x.test/c");
			pm.expect(r.code).to.equal(201);
		});
		pm.test("sync test", () => {});
	`})
	if vs.scopes["environment"]["token"] != "t-1" || vs.scopes["environment"]["b"] != "200" || len(h.got) != 3 {
		t.Fatalf("env = %v, requests %d", vs.scopes["environment"], len(h.got))
	}
	if got := testsText(out.Tests); got != "pass sync test\nfail async test: AssertionError: expected 200 to equal 201\n" {
		t.Fatalf("tests = %q", got)
	}
}

func TestAsyncErrors(t *testing.T) {
	cases := []struct {
		name, script, want string
		line, col          int
	}{
		{"top-level await throw", "await pm.sendRequest('https://x.test');\n  throw new Error('boom');", "Error: boom", 2, 9},
		{"first line column", "await Promise.reject(new Error('first'));", "Error: first", 1, 22},
		{"unhandled rejection", "pm.sendRequest('https://x.test').then(() => {\n  throw new TypeError('late');\n});", "TypeError: late", 2, 9},
		{"rejected plain value", "Promise.reject('nope');", "nope", 0, 0},
		{"callback throw", "pm.sendRequest('https://x.test', () => {\n  undefinedFn();\n});", "ReferenceError: undefinedFn is not defined", 2, 0},
		{"syntax error with await", "await (;", "SyntaxError", 1, 8},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			_, err := run(t, Input{Source: reqSrc, HTTP: &fakeHTTP{}, Script: c.script})
			var se *Error
			if !errors.As(err, &se) || !strings.Contains(se.Message, c.want) {
				t.Fatalf("err = %v", err)
			}
			if se.Line != c.line || (c.col != 0 && se.Column != c.col) {
				t.Errorf("position = %d:%d, want %d:%d", se.Line, se.Column, c.line, c.col)
			}
		})
	}
	// A rejection handled later isn't an error.
	mustRun(t, Input{Source: reqSrc, Script: `const p = Promise.reject(new Error("x")); p.catch(() => {});`})
}

func TestSendRequestLimitAndTimeout(t *testing.T) {
	h := &fakeHTTP{}
	b := &Budget{}
	_, err := run(t, Input{Source: reqSrc, HTTP: h, Budget: b, Script: `
		for (let i = 0; i < 60; i++) await pm.sendRequest("https://x.test/" + i);
	`})
	if err == nil || !strings.Contains(err.Error(), "at most 50 requests") || len(h.got) != MaxRequests {
		t.Fatalf("err = %v, sent %d", err, len(h.got))
	}

	slow := &fakeHTTP{wait: 5 * time.Second}
	start := time.Now()
	_, err = run(t, Input{Source: reqSrc, HTTP: slow, Timeout: 50 * time.Millisecond,
		Script: `pm.sendRequest("https://slow.test", () => {})`})
	var se *Error
	if !errors.As(err, &se) || !se.Timeout || !strings.Contains(se.Message, "waiting for pm.sendRequest") {
		t.Fatalf("err = %#v", err)
	}
	if time.Since(start) > 2*time.Second {
		t.Fatal("the request wasn't stopped with the script")
	}
}

func TestCookies(t *testing.T) {
	jc := newJarCookies(t)
	vs := newVars()
	req := baseRequest()
	req.URL = "https://api.test/v1/login"
	_, err := jc.jar.SetForURL(&url.URL{Scheme: "https", Host: "api.test", Path: "/v1/login"}, cookies.Cookie{Name: "sid", Value: "s-1"})
	if err != nil {
		t.Fatal(err)
	}
	out := mustRun(t, Input{Source: testSrc, Request: req, Response: jsonResponse(200, "{}"), Cookies: jc, Vars: vs, Script: `
		pm.test("pm.cookies", () => {
			pm.expect(pm.cookies.has("sid")).to.be.true;
			pm.expect(pm.cookies.has("sid", "s-1")).to.be.true;
			pm.expect(pm.cookies.has("sid", "other")).to.be.false;
			pm.expect(pm.cookies.get("sid")).to.equal("s-1");
			pm.expect(pm.cookies.get("none")).to.be.undefined;
			pm.expect(pm.cookies.count()).to.equal(1);
			pm.expect(pm.cookies.toObject()).to.eql({sid: "s-1"});
			const names = [];
			pm.cookies.each(c => names.push(c.name + "@" + c.domain + c.path + ":" + c.session + c.hostOnly));
			pm.expect(names).to.eql(["sid@api.test/v1:truetrue"]);
			pm.expect(pm.cookies.all()[0].expires).to.be.undefined;
		});
		const jar = pm.cookies.jar();
		jar.set("https://api.test/", "theme", "dark", (err, c) => {
			pm.variables.set("set", err ? err.message : c.name + "=" + c.value + c.path);
		});
		// The jar is read now; only the callback waits until the script's
		// own code (and its awaits) are done.
		jar.get("https://api.test/", "theme", (err, v) => pm.variables.set("got", String(v)));
		jar.set("https://api.test/", {name: "keep", value: "1", domain: "api.test", path: "/", maxAge: 3600, secure: true, httpOnly: true}, (err, c) => {
			pm.variables.set("keep", String(!c.session && c.secure && c.httpOnly && c.expires > "2000"));
		});
		await jar.set("https://api.test/", {name: "exp", value: "2", expires: new Date(Date.now() + 60000)});
		const all = await jar.getAll("https://api.test/");
		pm.variables.set("all", all.map(c => c.name).sort().join(","));
		jar.set("https://api.test/", "bad;name", "x", (err) => pm.variables.set("bad", err.message));
		jar.set("https://api.test/", {name: "e", expires: "not a date"}, (err) => pm.variables.set("badDate", err.message));
		await jar.unset("https://api.test/", "theme");
		pm.variables.set("afterUnset", String(await jar.get("https://api.test/", "theme")));
		await jar.clear("https://api.test/");
		pm.variables.set("afterClear", String((await jar.getAll("https://api.test/")).length));
		jar.get("", "x", (err) => pm.variables.set("noURL", err.message));
		pm.variables.set("afterClearSid", await jar.get("https://api.test/v1/x", "sid"));
	`})
	if got := testsText(out.Tests); got != "pass pm.cookies\n" {
		t.Fatalf("tests = %q", got)
	}
	want := map[string]string{
		"set": "theme=dark/", "got": "dark", "keep": "true", "all": "exp,keep,theme",
		"bad":     "invalid cookie: the name \"bad;name\" can't contain spaces or any of ()<>@,;:\\\"/[]?={}",
		"badDate": "The cookie's expiry isn't a valid date", "afterUnset": "undefined", "afterClear": "0",
		"noURL": "jar.get needs a URL", "afterClearSid": "s-1",
	}
	for k, v := range want {
		if vs.scopes["local"][k] != v {
			t.Errorf("%s = %q, want %q", k, vs.scopes["local"][k], v)
		}
	}
	// sid lives on /v1, so clearing https://api.test/ leaves it.
	if left := jc.jar.All(); len(left) != 1 || left[0].Name != "sid" {
		t.Errorf("left = %+v", left)
	}
}

func TestCookiesWithoutAJar(t *testing.T) {
	vs := newVars()
	mustRun(t, Input{Source: reqSrc, Vars: vs, Script: `
		pm.variables.set("count", pm.cookies.count());
		pm.cookies.jar().set("https://x.test", "a", "1", (err) => pm.variables.set("set", err.message));
		pm.cookies.jar().clear("https://x.test", (err) => pm.variables.set("clear", err.message));
	`})
	if vs.scopes["local"]["count"] != "0" || vs.scopes["local"]["set"] != noJar || vs.scopes["local"]["clear"] != noJar {
		t.Fatalf("local = %v", vs.scopes["local"])
	}
}

type failingCookies struct{}

func (failingCookies) List(string) ([]cookies.Cookie, error) { return nil, errors.New("list failed") }
func (failingCookies) Set(string, cookies.Cookie) (cookies.Cookie, error) {
	return cookies.Cookie{}, errors.New("set failed")
}
func (failingCookies) Delete(string, string) error { return errors.New("delete failed") }

func TestCookieErrors(t *testing.T) {
	_, err := run(t, Input{Source: reqSrc, Cookies: failingCookies{}, Script: `pm.cookies.get("a")`})
	if err == nil || !strings.Contains(err.Error(), "list failed") {
		t.Fatalf("err = %v", err)
	}
	_, err = run(t, Input{Source: reqSrc, Cookies: failingCookies{}, Script: `await pm.cookies.jar().unset("https://x", "a")`})
	if err == nil || !strings.Contains(err.Error(), "delete failed") {
		t.Fatalf("err = %v", err)
	}
	vs := newVars()
	mustRun(t, Input{Source: reqSrc, Cookies: failingCookies{}, Vars: vs,
		Script: `pm.cookies.jar().set("https://x", "a", "1", (e) => pm.variables.set("e", e.message))`})
	if vs.scopes["local"]["e"] != "set failed" {
		t.Fatalf("local = %v", vs.scopes["local"])
	}
}
