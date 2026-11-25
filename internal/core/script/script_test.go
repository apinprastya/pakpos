package script

import (
	"context"
	"errors"
	"fmt"
	"sort"
	"strings"
	"testing"
	"time"

	"pakpos/internal/core/model"
	"pakpos/internal/core/vars"
)

// mapVars is an in-memory Vars: one map per scope kind.
type mapVars struct {
	scopes map[vars.ScopeKind]map[string]string
	setErr error
}

func newVars() *mapVars {
	return &mapVars{scopes: map[vars.ScopeKind]map[string]string{
		vars.ScopeGlobal: {}, vars.ScopeCollection: {}, vars.ScopeEnvironment: {}, vars.ScopeLocal: {},
	}}
}

var order = []vars.ScopeKind{vars.ScopeGlobal, vars.ScopeCollection, vars.ScopeEnvironment, vars.ScopeLocal}

func (m *mapVars) Get(scope vars.ScopeKind, key string) (string, bool) {
	if scope == AllScopes {
		v, ok := m.All(AllScopes)[key]
		return v, ok
	}
	v, ok := m.scopes[scope][key]
	return v, ok
}

func (m *mapVars) All(scope vars.ScopeKind) map[string]string {
	out := map[string]string{}
	kinds := []vars.ScopeKind{scope}
	if scope == AllScopes {
		kinds = order
	}
	for _, k := range kinds {
		for n, v := range m.scopes[k] {
			out[n] = v
		}
	}
	return out
}

func (m *mapVars) Set(scope vars.ScopeKind, key, value string) error {
	if m.setErr != nil {
		return m.setErr
	}
	m.scopes[scope][key] = value
	return nil
}

func (m *mapVars) Unset(scope vars.ScopeKind, key string) error {
	delete(m.scopes[scope], key)
	return nil
}

func (m *mapVars) ReplaceIn(text string) (string, error) {
	var list []vars.Scope
	for _, k := range order {
		sc := vars.Scope{Kind: k}
		for n, v := range m.scopes[k] {
			sc.Variables = append(sc.Variables, model.Variable{Key: n, Value: v, Enabled: true})
		}
		list = append(list, sc)
	}
	out, _, err := vars.Resolve(text, list)
	return out, err
}

var reqSrc = Source{Kind: LevelRequest, ID: "r1", Name: "Login", Event: PreRequest}
var testSrc = Source{Kind: LevelRequest, ID: "r1", Name: "Login", Event: Test}

func baseRequest() model.Request {
	return model.Request{
		ID: "r1", Name: "Login", Method: "POST", URL: "https://api.test/login",
		Query:   []model.KeyValue{{Key: "a", Value: "1", Enabled: true}},
		Headers: []model.KeyValue{{Key: "Accept", Value: "application/json", Enabled: true}, {Key: "X-Off", Value: "1"}},
		Body:    model.Body{Type: model.BodyRaw, Raw: `{"user":"ann"}`, Language: model.LangJSON},
	}
}

func jsonResponse(code int, body string) *Response {
	return &Response{
		Code: code, Status: "OK", Body: body, ResponseTime: 12.5, ResponseSize: int64(len(body)),
		Headers: []model.KeyValue{{Key: "Content-Type", Value: "application/json"}, {Key: "X-Id", Value: "7"}},
	}
}

func run(t *testing.T, in Input) (Output, error) {
	t.Helper()
	if in.Source == (Source{}) {
		in.Source = testSrc
	}
	if in.Request.ID == "" {
		in.Request = baseRequest()
	}
	if in.Vars == nil {
		in.Vars = newVars()
	}
	return Run(context.Background(), in)
}

func mustRun(t *testing.T, in Input) Output {
	t.Helper()
	out, err := run(t, in)
	if err != nil {
		t.Fatalf("run: %v", err)
	}
	return out
}

func testsText(tests []TestResult) string {
	var b strings.Builder
	for _, tr := range tests {
		state := "pass"
		switch {
		case tr.Skipped:
			state = "skip"
		case !tr.Passed:
			state = "fail"
		}
		fmt.Fprintf(&b, "%s %s", state, tr.Name)
		if tr.Error != "" {
			fmt.Fprintf(&b, ": %s", tr.Error)
		}
		b.WriteString("\n")
	}
	return b.String()
}

func TestPostmanSnippets(t *testing.T) {
	v := newVars()
	out := mustRun(t, Input{
		Vars:     v,
		Response: jsonResponse(200, `{"token":"abc","user":{"id":7,"tags":["a","b"]}}`),
		Script: `
pm.test("Status code is 200", function () { pm.response.to.have.status(200); });
pm.test("Body has token", () => {
  const json = pm.response.json();
  pm.expect(json.token).to.eql("abc");
  pm.environment.set("token", json.token);
});
pm.test("Content-Type is present", function () { pm.response.to.have.header("Content-Type"); });
pm.test("Response time is less than 200ms", function () { pm.expect(pm.response.responseTime).to.be.below(200); });
pm.test("Body matches string", function () { pm.expect(pm.response.text()).to.include("token"); });
pm.test("Successful POST request", function () { pm.expect(pm.response.code).to.be.oneOf([201, 202, 200]); });
pm.test("user", function () {
  pm.expect(pm.response.json().user).to.have.property("id", 7);
  pm.expect(pm.response.json().user.tags).to.have.lengthOf(2).and.include("b");
  pm.response.to.be.ok.and.json;
  pm.response.to.have.jsonBody("user.tags[1]", "b");
  pm.response.to.not.be.error;
});
`,
	})
	if got := v.scopes[vars.ScopeEnvironment]["token"]; got != "abc" {
		t.Errorf("token = %q", got)
	}
	want := "pass Status code is 200\npass Body has token\npass Content-Type is present\npass Response time is less than 200ms\npass Body matches string\npass Successful POST request\npass user\n"
	if got := testsText(out.Tests); got != want {
		t.Errorf("tests:\n%s\nwant:\n%s", got, want)
	}
	if out.Tests[0].Source != testSrc {
		t.Errorf("source = %+v", out.Tests[0].Source)
	}
}

func TestExpectMessages(t *testing.T) {
	cases := []struct{ script, want string }{
		{`pm.expect(404).to.equal(200)`, "expected 404 to equal 200"},
		{`pm.expect("a").to.equal("b")`, "expected 'a' to equal 'b'"},
		{`pm.expect(1).to.not.equal(1)`, "expected 1 to not equal 1"},
		{`pm.expect({a: 1}).to.eql({a: 2})`, "expected { a: 1 } to deeply equal { a: 2 }"},
		{`pm.expect({a: 1}).to.deep.equal({a: 2})`, "expected { a: 1 } to deeply equal { a: 2 }"},
		{`pm.expect([1, 2]).to.eql([1, 3])`, "expected [ 1, 2 ] to deeply equal [ 1, 3 ]"},
		{`pm.expect({id: 1, name: "a long name here", more: true}).to.eql({})`, "expected { Object (id, name, ...) } to deeply equal {}"},
		{`pm.expect([1,2,3,4,5,6,7,8,9,10,11,12,13,14,15]).to.eql([])`, "expected [ Array(15) ] to deeply equal []"},
		{`pm.expect(5).to.be.a("string")`, "expected 5 to be a string"},
		{`pm.expect([]).to.be.an("object")`, "expected [] to be an object"},
		{`pm.expect("abc").to.include("x")`, "expected 'abc' to include 'x'"},
		{`pm.expect([1]).to.contain(2)`, "expected [ 1 ] to include 2"},
		{`pm.expect({a: 1}).to.include({a: 2})`, "expected { a: 1 } to include { a: 2 }"},
		{`pm.expect([{a: 1}]).to.deep.include({a: 2})`, "expected [ { a: 1 } ] to deep include { a: 2 }"},
		{`pm.expect({}).to.have.property("id")`, "expected {} to have property 'id'"},
		{`pm.expect({id: 1}).to.have.property("id", 2)`, "expected { id: 1 } to have property 'id' of 2, but got 1"},
		{`pm.expect({id: 1}).to.have.own.property("toString")`, "expected { id: 1 } to have own property 'toString'"},
		{`pm.expect([1]).to.have.lengthOf(2)`, "expected [ 1 ] to have a length of 2 but got 1"},
		{`pm.expect("ab").to.have.length.above(5)`, "expected 'ab' to have a length above 5 but got 2"},
		{`pm.expect(1).to.be.above(2)`, "expected 1 to be above 2"},
		{`pm.expect(3).to.be.below(2)`, "expected 3 to be below 2"},
		{`pm.expect(1).to.be.at.least(2)`, "expected 1 to be at least 2"},
		{`pm.expect(3).to.be.at.most(2)`, "expected 3 to be at most 2"},
		{`pm.expect(9).to.be.within(1, 5)`, "expected 9 to be within 1..5"},
		{`pm.expect(0).to.be.ok`, "expected 0 to be truthy"},
		{`pm.expect(1).to.not.be.ok`, "expected 1 to be falsy"},
		{`pm.expect(1).to.be.true`, "expected 1 to be true"},
		{`pm.expect(true).to.be.false`, "expected true to be false"},
		{`pm.expect(0).to.be.null`, "expected 0 to be null"},
		{`pm.expect(null).to.be.undefined`, "expected null to be undefined"},
		{`pm.expect(null).to.exist`, "expected null to exist"},
		{`pm.expect(1).to.not.exist`, "expected 1 to not exist"},
		{`pm.expect([1]).to.be.empty`, "expected [ 1 ] to be empty"},
		{`pm.expect("").to.not.be.empty`, "expected '' not to be empty"},
		{`pm.expect("abc").to.match(/^x/)`, "expected 'abc' to match /^x/"},
		{`pm.expect(4).to.be.oneOf([1, 2])`, "expected 4 to be one of [ 1, 2 ]"},
		{`pm.expect({a: 1, b: 2}).to.have.keys("a")`, "expected { a: 1, b: 2 } to have keys 'a'"},
		{`pm.expect({a: 1}).to.have.any.keys("x", "y")`, "expected { a: 1 } to have any of keys 'x', 'y'"},
		{`pm.expect({a: 1}).to.include.keys("a", "z")`, "expected { a: 1 } to contain keys 'a', 'z'"},
		{`pm.expect([1, 2]).to.have.members([1])`, "expected [ 1, 2 ] to have the same members as [ 1 ]"},
		{`pm.expect([1, 2]).to.include.members([3])`, "expected [ 1, 2 ] to be a superset of [ 3 ]"},
		{`pm.expect(NaN).to.not.be.NaN`, "expected NaN not to be NaN"},
		{`pm.expect(1.5).to.be.closeTo(1, 0.1)`, "expected 1.5 to be close to 1 +/- 0.1"},
		{`pm.expect(() => {}).to.throw()`, "expected [Function] to throw an error"},
		{`pm.expect(() => { throw new Error("boom") }).to.throw("bang")`, "expected [Function] to throw an error including 'bang'"},
		{`pm.expect(1, "count").to.equal(2)`, "count: expected 1 to equal 2"},
		{`pm.expect(1).to.satisfy(function isTwo(x) { return x === 2 })`, "expected 1 to satisfy [Function: isTwo]"},
		{`pm.expect({}).to.be.instanceOf(Array)`, "expected {} to be an instance of Array"},
		{`pm.expect("abc").to.have.string("z")`, "expected 'abc' to contain 'z'"},
		{`pm.expect.fail("nope")`, "nope"},
		{`pm.expect(1).to.fail()`, "assert.fail()"},
		{`pm.response.to.have.status(200)`, "expected response to have status code 200 but got 404"},
		{`pm.response.to.have.status("OK")`, "expected response to have status reason 'OK' but got 'Not Found'"},
		{`pm.response.to.have.header("X-None")`, "expected response to have header with key 'X-None'"},
		{`pm.response.to.have.header("X-Id", "8")`, "expected 'X-Id' response header to be '8' but got '7'"},
		{`pm.response.to.be.ok`, "expected response code to be 200 but found 404"},
		{`pm.response.to.be.success`, "expected response code to be 2XX but found 404"},
		{`pm.response.to.not.be.error`, "expected response code to not be 4XX or 5XX but found 404"},
		{`pm.response.to.be.serverError`, "expected response code to be 5XX but found 404"},
		{`pm.response.to.not.be.clientError`, "expected response code to not be 4XX but found 404"},
		{`pm.response.to.have.jsonBody("a.c")`, "expected response body json to have path 'a.c'"},
		{`pm.response.to.have.jsonBody("a.b", 2)`, "expected response body json at 'a.b' to deeply equal 2 but got 1"},
		{`pm.response.to.not.have.jsonBody()`, "expected response body to not be a valid json"},
		{`pm.response.to.have.body("x")`, `expected response body to equal 'x' but got '{"a":{"b":1}}'`},
		{`pm.response.to.have.body(/zzz/)`, "expected response body text to match /zzz/"},
		{`pm.response.to.have.body({a: 2})`, "expected response body json to deeply equal { a: 2 }"},
		{`pm.response.to.not.have.body()`, "expected response to not have content in body"},
		{`pm.response.to.not.be.json`, "expected response body to not be a valid json"},
		{`pm.expect(1).to.have.status(200)`, "TypeError: .status can only be used with pm.response"},
		{`pm.expect(5).to.include(1)`, "TypeError: 5 doesn't support .include; use a string, an array or an object"},
		{`pm.expect(5).to.be.empty`, "TypeError: .empty was passed 5; use a string, an array or an object"},
		{`pm.expect(5).to.have.length(1)`, "TypeError: expected 5 to have a length"},
		{`pm.expect("x").to.be.above(1)`, "TypeError: expected 'x' to be a number or a date"},
	}
	for _, c := range cases {
		t.Run(c.script, func(t *testing.T) {
			resp := jsonResponse(404, `{"a":{"b":1}}`)
			resp.Status = "Not Found"
			out := mustRun(t, Input{Response: resp, Script: `pm.test("t", () => { ` + c.script + ` })`})
			if len(out.Tests) != 1 || out.Tests[0].Passed {
				t.Fatalf("tests = %+v", out.Tests)
			}
			want := c.want
			if !strings.Contains(want, "Error: ") {
				want = "AssertionError: " + want
			}
			if got := out.Tests[0].Error; got != want {
				t.Errorf("error:\n got %q\nwant %q", got, want)
			}
		})
	}
}

func TestExpectPasses(t *testing.T) {
	script := `
const d = new Date(5);
const m = new Map([["a", 1]]);
const s = new Set([1, 2]);
pm.expect({a: [1, {b: 2}], d}).to.eql({a: [1, {b: 2}], d: new Date(5)});
pm.expect(NaN).to.eql(NaN);
pm.expect(0).to.not.eql(-0);
pm.expect(/a/g).to.eql(/a/g);
pm.expect(m).to.eql(new Map([["a", 1]]));
pm.expect(s).to.include(2);
pm.expect(s).to.have.lengthOf(2);
pm.expect(m).to.have.keys("a");
pm.expect(m).to.not.be.empty;
pm.expect({}).to.be.empty;
pm.expect([1, 2]).to.be.an("array").that.is.not.empty;
pm.expect([1, 2]).to.have.length.within(1, 3);
pm.expect("abc").to.have.length.of.at.least(3).and.at.most(3);
pm.expect([3, 1]).to.have.members([1, 3]);
pm.expect([{a: 1}]).to.deep.include.members([{a: 1}]);
pm.expect({a: {b: 1}}).to.have.deep.property("a", {b: 1});
pm.expect({a: {b: 1}}).to.have.property("a").that.has.property("b").which.equals(1);
pm.expect({a: 1}).to.haveOwnProperty("a");
pm.expect({a: 1, b: 2}).to.have.all.keys(["a", "b"]);
pm.expect({a: 1, b: 2}).to.have.keys({a: 0, b: 0});
pm.expect(2).to.be.oneOf([1, 2]);
pm.expect({a: 1}).to.be.deep.oneOf([{a: 1}]);
pm.expect(() => { throw new TypeError("bad") }).to.throw(TypeError);
pm.expect(() => { throw new Error("bad thing") }).to.throw(/thing/);
pm.expect(() => {}).to.not.throw();
pm.expect(new Date(10)).to.be.above(new Date(5));
pm.expect(undefined).to.not.exist;
pm.expect("x").to.be.a("string");
pm.expect(1).to.deep.equal(1);
`
	out := mustRun(t, Input{Script: `pm.test("all", () => {` + script + `})`})
	if got := testsText(out.Tests); got != "pass all\n" {
		t.Errorf("tests = %s", got)
	}
}

func TestInspect(t *testing.T) {
	out := mustRun(t, Input{Source: reqSrc, Script: `
const a = {name: "x", list: [1, "two", null, undefined, true], nested: {deep: {deeper: {deepest: {gone: 1}}}}};
a.self = a;
console.log("text", 1, a);
console.info([], {}, -0, 10n, Symbol("s"), function f() {}, /re/, new Date(0), new Date(NaN), new Error("e"));
console.warn(new Map([["k", 1]]), new Set(["v"]), {"odd key": 1});
console.error((function () { return arguments })(1));
console.debug([[[[[[[1]]]]]]], new Map(), new Set());
`})
	got := make([]string, len(out.Console))
	for i, e := range out.Console {
		got[i] = string(e.Level) + " " + e.Text
	}
	want := []string{
		`log text 1 {"name": "x", "list": [1, "two", null, undefined, true], "nested": {"deep": {"deeper": {"deepest": {"gone": 1}}}}, "self": [Circular]}`,
		`info [] {} -0 10n Symbol(s) [Function: f] /re/ 1970-01-01T00:00:00.000Z Invalid Date Error: e`,
		`warn Map(1) { "k" => 1 } Set(1) { "v" } {"odd key": 1}`,
		`error [1]`,
		`debug [[[[[[[Array]]]]]]] Map(0) {} Set(0) {}`,
	}
	if strings.Join(got, "\n") != strings.Join(want, "\n") {
		t.Errorf("console:\n%s\nwant:\n%s", strings.Join(got, "\n"), strings.Join(want, "\n"))
	}
	if out.Console[0].Source != reqSrc {
		t.Errorf("source = %+v", out.Console[0].Source)
	}
}

func TestChaiInspectKeys(t *testing.T) {
	out := mustRun(t, Input{Script: `pm.test("t", () => pm.expect({"a-b": 1}).to.eql({}))`})
	if got := out.Tests[0].Error; got != "AssertionError: expected { 'a-b': 1 } to deeply equal {}" {
		t.Errorf("error = %q", got)
	}
}

func TestVariables(t *testing.T) {
	v := newVars()
	v.scopes[vars.ScopeGlobal]["g"] = "global"
	v.scopes[vars.ScopeCollection]["c"] = "coll"
	v.scopes[vars.ScopeEnvironment]["host"] = "api.test"
	v.scopes[vars.ScopeEnvironment]["drop"] = "x"
	out := mustRun(t, Input{Vars: v, Source: reqSrc, EnvironmentName: "Dev", Script: `
console.log(pm.environment.name, pm.environment.get("host"), pm.environment.has("nope"), pm.environment.get("nope") === undefined);
pm.environment.set("n", 5);
pm.environment.set("obj", {a: 1});
pm.environment.set("u", undefined);
pm.environment.unset("drop");
pm.collectionVariables.set("c2", "two");
pm.globals.set("g2", true);
pm.variables.set("local", "here");
pm.variables.unset("nothing");
console.log(pm.variables.get("c"), pm.variables.get("local"), pm.variables.has("g"));
console.log(JSON.stringify(pm.environment.toObject()));
console.log(pm.variables.replaceIn("https://{{host}}/{{local}}"));
console.log(Object.keys(pm.variables.toObject()).sort().join(","));
console.log(pm.globals.get("g"), pm.collectionVariables.get("c"));
`})
	if got := v.scopes[vars.ScopeEnvironment]; got["n"] != "5" || got["obj"] != `{"a":1}` || got["u"] != "" {
		t.Errorf("environment = %v", got)
	}
	if _, ok := v.scopes[vars.ScopeEnvironment]["drop"]; ok {
		t.Error("drop not unset")
	}
	if v.scopes[vars.ScopeCollection]["c2"] != "two" || v.scopes[vars.ScopeGlobal]["g2"] != "true" || v.scopes[vars.ScopeLocal]["local"] != "here" {
		t.Errorf("scopes = %v", v.scopes)
	}
	texts := make([]string, len(out.Console))
	for i, e := range out.Console {
		texts[i] = e.Text
	}
	want := []string{
		"Dev api.test false true",
		"coll here true",
		`{"host":"api.test","n":"5","obj":"{\"a\":1}","u":""}`,
		"https://api.test/here",
		"c,c2,g,g2,host,local,n,obj,u",
		"global coll",
	}
	if strings.Join(texts, "\n") != strings.Join(want, "\n") {
		t.Errorf("console:\n%s", strings.Join(texts, "\n"))
	}
}

func TestVariableErrors(t *testing.T) {
	v := newVars()
	v.setErr = errors.New("No environment is selected")
	_, err := run(t, Input{Vars: v, Source: reqSrc, Script: "\n  pm.environment.set('a', 1)"})
	var se *Error
	if !errors.As(err, &se) {
		t.Fatalf("err = %v", err)
	}
	if se.Message != "Error: No environment is selected" || se.Line != 2 || se.Column != 21 {
		t.Errorf("error = %+v", se)
	}
	if got := err.Error(); got != `Error in the pre-request script of request "Login" at line 2:21: Error: No environment is selected` {
		t.Errorf("Error() = %q", got)
	}
	_, err = run(t, Input{Source: reqSrc, Script: "pm.environment.set('', 1)"})
	if !errors.As(err, &se) || se.Message != "Error: pm.environment.set needs a variable name" {
		t.Errorf("err = %v", err)
	}
	_, err = run(t, Input{Source: reqSrc, Script: "pm.variables.replaceIn('{{a}}')", Vars: cycleVars{newVars()}})
	if !errors.As(err, &se) || !strings.Contains(se.Message, "variable cycle") {
		t.Errorf("err = %v", err)
	}
	_, err = run(t, Input{Source: reqSrc, Script: "pm.globals.unset('x')", Vars: cycleVars{newVars()}})
	if !errors.As(err, &se) || se.Message != "Error: unset refused" {
		t.Errorf("err = %v", err)
	}
}

type cycleVars struct{ *mapVars }

func (cycleVars) ReplaceIn(string) (string, error)   { return "", vars.ErrCycle }
func (cycleVars) Unset(vars.ScopeKind, string) error { return errors.New("unset refused") }

func TestNilVars(t *testing.T) {
	out, err := Run(context.Background(), Input{Source: reqSrc, Request: baseRequest(), Script: `
console.log(pm.environment.get("a"), JSON.stringify(pm.variables.toObject()), pm.variables.replaceIn("{{a}}"));
pm.variables.unset("a");
`})
	if err != nil {
		t.Fatal(err)
	}
	if out.Console[0].Text != "undefined {} {{a}}" {
		t.Errorf("console = %q", out.Console[0].Text)
	}
	_, err = Run(context.Background(), Input{Source: reqSrc, Request: baseRequest(), Script: `pm.variables.set("a", 1)`})
	if err == nil || !strings.Contains(err.Error(), "Variables can't be set here") {
		t.Errorf("err = %v", err)
	}
}

func TestRequestMutations(t *testing.T) {
	out := mustRun(t, Input{Source: reqSrc, Script: `
console.log(pm.request.method, pm.request.url.toString(), String(pm.request.url), pm.request.headers.get("accept"), pm.request.headers.get("X-Off"));
console.log(pm.request.body.mode, pm.request.body.raw, pm.request.id, pm.request.name, pm.request.headers.count());
pm.request.method = "put";
pm.request.headers.add({key: "X-Trace", value: "{{trace}}"});
pm.request.headers.add("X-Two: 2");
pm.request.headers.add("X-Three", 3);
pm.request.headers.upsert({key: "accept", value: "text/plain"});
pm.request.headers.upsert({key: "X-New", value: "n"});
pm.request.headers.remove("X-Off");
pm.request.url.addQueryParams("b=2");
pm.request.url.addQueryParams([{key: "c d", value: "{{v}}"}, {key: "flag"}]);
pm.request.url.removeQueryParams("a");
pm.request.body.raw = '{"user":"bob"}';
console.log(pm.request.headers.has("x-trace"), pm.request.headers.has("X-Two", "2"), JSON.stringify(pm.request.headers.toObject()));
console.log(pm.request.url.getQueryString());
let keys = [];
pm.request.headers.each(h => keys.push(h.key));
console.log(keys.join(","), pm.request.headers.all().length, JSON.stringify(pm.request.url));
`})
	r := out.Request
	if r.Method != "PUT" {
		t.Errorf("method = %q", r.Method)
	}
	if r.URL != "https://api.test/login?b=2&c%20d=%7B%7Bv%7D%7D&flag" {
		t.Errorf("url = %q", r.URL)
	}
	q := fmt.Sprint(r.Query)
	if q != "[{b 2 true} {c d {{v}} true} {flag  true}]" {
		t.Errorf("query = %s", q)
	}
	h := fmt.Sprint(r.Headers)
	if h != "[{Accept text/plain true} {X-Trace {{trace}} true} {X-Two 2 true} {X-Three 3 true} {X-New n true}]" {
		t.Errorf("headers = %s", h)
	}
	if r.Body.Raw != `{"user":"bob"}` || r.Body.Type != model.BodyRaw || r.Body.Language != model.LangJSON {
		t.Errorf("body = %+v", r.Body)
	}
	texts := make([]string, len(out.Console))
	for i, e := range out.Console {
		texts[i] = e.Text
	}
	want := []string{
		"POST https://api.test/login?a=1 https://api.test/login?a=1 application/json undefined",
		`raw {"user":"ann"} r1 Login 1`,
		`true true {"Accept":"text/plain","X-Trace":"{{trace}}","X-Two":"2","X-Three":"3","X-New":"n"}`,
		"b=2&c%20d=%7B%7Bv%7D%7D&flag",
		`Accept,X-Trace,X-Two,X-Three,X-New 5 "https://api.test/login?b=2&c%20d=%7B%7Bv%7D%7D&flag"`,
	}
	if strings.Join(texts, "\n") != strings.Join(want, "\n") {
		t.Errorf("console:\n%s", strings.Join(texts, "\n"))
	}
}

func TestRequestURLAndBody(t *testing.T) {
	req := model.Request{ID: "r1", Name: "x", Method: "GET", URL: "http://h/:id#frag", Body: model.Body{Type: model.BodyNone},
		PathParams: []model.KeyValue{{Key: "id", Value: "1", Enabled: true}}}
	out := mustRun(t, Input{Source: reqSrc, Request: req, Script: `
console.log(pm.request.body.mode, JSON.stringify(pm.request.body.raw), pm.request.body.toString());
pm.request.url = "http://h/:id/:sub?x=1#frag";
pm.request.url.removeQueryParams(["x"]);
pm.request.body.update("plain");
`})
	if out.Request.URL != "http://h/:id/:sub#frag" || len(out.Request.Query) != 0 {
		t.Errorf("url = %q query %v", out.Request.URL, out.Request.Query)
	}
	if fmt.Sprint(out.Request.PathParams) != "[{id 1 true} {sub  true}]" {
		t.Errorf("path params = %v", out.Request.PathParams)
	}
	if out.Request.Body.Type != model.BodyRaw || out.Request.Body.Raw != "plain" {
		t.Errorf("body = %+v", out.Request.Body)
	}
	if out.Console[0].Text != `none "" ` {
		t.Errorf("console = %q", out.Console[0].Text)
	}

	enc := model.Request{ID: "r1", Name: "x", Method: "POST", URL: "http://h", Body: model.Body{Type: model.BodyURLEncoded,
		URLEncoded: []model.KeyValue{{Key: "a b", Value: "1&2", Enabled: true}, {Key: "off", Value: "x"}}}}
	out = mustRun(t, Input{Source: reqSrc, Request: enc, Script: `console.log(pm.request.body.mode, pm.request.body.toString())`})
	if out.Console[0].Text != "urlencoded a%20b=1%262" {
		t.Errorf("console = %q", out.Console[0].Text)
	}
	form := model.Request{ID: "r1", Name: "x", Method: "POST", URL: "http://h", Body: model.Body{Type: model.BodyFormData}}
	out = mustRun(t, Input{Source: reqSrc, Request: form, Script: `console.log(pm.request.body.mode, JSON.stringify(pm.request.body.toString()))`})
	if out.Console[0].Text != `formdata ""` {
		t.Errorf("console = %q", out.Console[0].Text)
	}
}

func TestRequestReadOnlyInTests(t *testing.T) {
	for _, script := range []string{
		`pm.request.headers.add({key: "a", value: "b"})`,
		`pm.request.headers.upsert({key: "a", value: "b"})`,
		`pm.request.headers.remove("Accept")`,
		`pm.request.method = "PUT"`,
		`pm.request.url = "http://x"`,
		`pm.request.url.addQueryParams("a=b")`,
		`pm.request.url.removeQueryParams("a")`,
		`pm.request.body.raw = "x"`,
	} {
		_, err := run(t, Input{Response: jsonResponse(200, "{}"), Script: script})
		if err == nil || !strings.Contains(err.Error(), "pm.request can only be changed in a pre-request script") {
			t.Errorf("%s: err = %v", script, err)
		}
	}
	out := mustRun(t, Input{Response: jsonResponse(200, "{}"), Script: `console.log(pm.request.headers.get("Accept"))`})
	if out.Console[0].Text != "application/json" {
		t.Errorf("console = %q", out.Console[0].Text)
	}
}

func TestBadHeader(t *testing.T) {
	_, err := run(t, Input{Source: reqSrc, Script: `pm.request.headers.add(5)`})
	if err == nil || !strings.Contains(err.Error(), "A header needs a key and a value") {
		t.Errorf("err = %v", err)
	}
	out := mustRun(t, Input{Source: reqSrc, Script: `pm.request.headers.add("Bare"); pm.request.headers.remove({key: "accept"})`})
	if fmt.Sprint(out.Request.Headers) != "[{X-Off 1 false} {Bare  true}]" {
		t.Errorf("headers = %v", out.Request.Headers)
	}
}

func TestResponse(t *testing.T) {
	resp := jsonResponse(201, "not json")
	out := mustRun(t, Input{Response: resp, Script: `
console.log(pm.response.code, pm.response.status, pm.response.responseTime, pm.response.responseSize, pm.response.text());
console.log(pm.response.headers.get("x-id"), pm.response.headers.has("X-ID"), pm.response.headers.has("nope"), JSON.stringify(pm.response.headers.toObject()));
pm.test("json", () => pm.response.json());
console.log(pm.info.eventName, pm.info.requestName, pm.info.requestId, pm.info.iteration, pm.info.iterationCount);
`})
	texts := make([]string, len(out.Console))
	for i, e := range out.Console {
		texts[i] = e.Text
	}
	want := []string{
		"201 OK 12.5 8 not json",
		`7 true false {"Content-Type":"application/json","X-Id":"7"}`,
		"test Login r1 0 1",
	}
	if strings.Join(texts, "\n") != strings.Join(want, "\n") {
		t.Errorf("console:\n%s", strings.Join(texts, "\n"))
	}
	if !strings.HasPrefix(out.Tests[0].Error, "SyntaxError: JSONError: ") || !strings.HasSuffix(out.Tests[0].Error, "(the response body isn't valid JSON)") {
		t.Errorf("json error = %q", out.Tests[0].Error)
	}
	pre := mustRun(t, Input{Source: reqSrc, Response: resp, Script: `console.log(typeof pm.response)`})
	if pre.Console[0].Text != "undefined" {
		t.Errorf("pre-request pm.response = %q", pre.Console[0].Text)
	}
}

func TestResponseFrom(t *testing.T) {
	r := &model.Response{StatusCode: 404, StatusText: "404 Not Found", Size: 3, Timings: model.Timings{Total: 9}, Headers: []model.KeyValue{{Key: "A", Value: "b"}}}
	got := ResponseFrom(r, []byte("a\xffb"))
	if got.Code != 404 || got.Status != "Not Found" || got.Body != "a�b" || got.ResponseTime != 9 || got.ResponseSize != 3 || len(got.Headers) != 1 {
		t.Errorf("response = %+v", got)
	}
	if got := ResponseFrom(&model.Response{StatusCode: 200, StatusText: "OK"}, nil); got.Status != "OK" {
		t.Errorf("status = %q", got.Status)
	}
}

func TestTestsAndExecution(t *testing.T) {
	out := mustRun(t, Input{Source: reqSrc, Iteration: 2, IterationCount: 5, IterationData: map[string]string{"user": "ann"}, Script: `
pm.test("passes", function () {});
pm.test("throws a string", function () { throw "plain"; });
pm.test("throws an object", function () { throw {message: "obj"}; });
pm.test("type error", function () { null.x; });
pm.test("pending");
pm.test.skip("skipped", function () { throw new Error("never"); });
pm.test("chain", () => {}).test("chained", () => {});
console.log(pm.iterationData.get("user"), pm.iterationData.has("x"), pm.iterationData.get("x"), JSON.stringify(pm.iterationData.toObject()), JSON.stringify(pm.iterationData));
console.log(pm.info.iteration, pm.info.iterationCount, pm.info.eventName);
pm.execution.setNextRequest("Next one");
pm.execution.skipRequest();
`})
	want := "pass passes\nfail throws a string: plain\nfail throws an object: Error: obj\nfail type error: TypeError: Cannot read property 'x' of undefined\nskip pending\nskip skipped\npass chain\npass chained\n"
	if got := testsText(out.Tests); got != want {
		t.Errorf("tests:\n%s", got)
	}
	if out.Console[0].Text != `ann false undefined {"user":"ann"} {"user":"ann"}` || out.Console[1].Text != "2 5 prerequest" {
		t.Errorf("console = %+v", out.Console)
	}
	if !out.NextRequestSet || out.NextRequest != "Next one" || out.NextRequestStop || !out.Skip {
		t.Errorf("execution = %+v", out)
	}
	out = mustRun(t, Input{Source: reqSrc, Script: `postman.setNextRequest(null)`})
	if !out.NextRequestSet || !out.NextRequestStop || out.NextRequest != "" {
		t.Errorf("stop = %+v", out)
	}
}

func TestSandbox(t *testing.T) {
	cases := []struct{ script, want string }{
		{`require("fs")`, "Error: require isn't available in Pakpos scripts: there are no modules to load"},
		{`setTimeout(() => {}, 1)`, "Error: setTimeout isn't available in Pakpos scripts: scripts run synchronously and stop when they end"},
		{`setInterval(() => {}, 1)`, "setInterval isn't available"},
		{`setImmediate(() => {})`, "setImmediate isn't available"},
		{`clearTimeout(1)`, "clearTimeout isn't available"},
		{`clearInterval(1)`, "clearInterval isn't available"},
		{`fetch("http://x")`, "Error: fetch isn't available in Pakpos scripts: use pm.sendRequest"},
		{`pm.sendRequest("http://x", (err) => { throw err })`, "Error: pm.sendRequest isn't available here"},
		{`process.exit()`, "ReferenceError: process is not defined"},
		{`XMLHttpRequest`, "ReferenceError: XMLHttpRequest is not defined"},
		{`throw "plain"`, "plain"},
		{`throw {code: 1}`, "[object Object]"},
		{`undefinedFn()`, "ReferenceError: undefinedFn is not defined"},
	}
	for _, c := range cases {
		_, err := run(t, Input{Source: reqSrc, Script: c.script})
		var se *Error
		if !errors.As(err, &se) || !strings.Contains(se.Message, c.want) {
			t.Errorf("%s: err = %v", c.script, err)
		}
	}
}

func TestFreshRuntime(t *testing.T) {
	mustRun(t, Input{Source: reqSrc, Script: `
Object.prototype.polluted = "yes";
Array.prototype.push = function () { throw new Error("tampered") };
JSON.parse = function () { return "tampered" };
pm.environment.get = function () { return "tampered" };
pm.expect = null;
globalThis.leak = 1;
`})
	v := newVars()
	v.scopes[vars.ScopeEnvironment]["a"] = "real"
	out := mustRun(t, Input{Vars: v, Response: jsonResponse(200, `{"x":1}`), Script: `
console.log(({}).polluted === undefined, typeof leak, pm.environment.get("a"), pm.response.json().x);
const list = []; list.push(1);
pm.test("expect works", () => pm.expect(list).to.have.lengthOf(1));
`})
	if out.Console[0].Text != "true undefined real 1" || !out.Tests[0].Passed {
		t.Errorf("console = %+v tests = %+v", out.Console, out.Tests)
	}
}

func TestTimeoutAndRecursion(t *testing.T) {
	cases := []struct {
		name, script string
		check        func(*Error) bool
	}{
		{"infinite loop", "while (true) {}", func(e *Error) bool { return e.Timeout && e.Message == "Script took longer than 0.2 s" }},
		{"loop in a test", `pm.test("t", () => { for (;;) {} })`, func(e *Error) bool { return e.Timeout }},
		{"catch can't stop it", "try { while (true) {} } catch (e) {}", func(e *Error) bool { return e.Timeout }},
		{"recursion", "\nfunction f() { return f() + 1 }\nf()", func(e *Error) bool {
			return e.Message == "RangeError: Maximum call stack size exceeded" && e.Line == 2
		}},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			start := time.Now()
			_, err := run(t, Input{Source: reqSrc, Script: c.script, Timeout: 200 * time.Millisecond})
			var se *Error
			if !errors.As(err, &se) || !c.check(se) {
				t.Fatalf("err = %#v", err)
			}
			if d := time.Since(start); d > 3*time.Second {
				t.Errorf("took %v", d)
			}
		})
	}
	if TimeoutMessage(DefaultTimeout) != "Script took longer than 5 s" {
		t.Errorf("default message = %q", TimeoutMessage(DefaultTimeout))
	}
	err := &Error{Source: reqSrc, Message: TimeoutMessage(time.Second)}
	if err.Error() != `Error in the pre-request script of request "Login": Script took longer than 1 s` {
		t.Errorf("Error() = %q", err.Error())
	}
}

func TestDefaultTimeoutApplies(t *testing.T) {
	in := Input{Source: reqSrc, Script: "1"}
	if _, err := run(t, in); err != nil {
		t.Fatal(err)
	}
}

func TestCancel(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	go func() {
		time.Sleep(50 * time.Millisecond)
		cancel()
	}()
	_, err := Run(ctx, Input{Source: reqSrc, Request: baseRequest(), Script: "while (true) {}"})
	var se *Error
	if !errors.As(err, &se) || !se.Canceled || se.Message != "The script was stopped because the send was cancelled" {
		t.Fatalf("err = %v", err)
	}
	_, err = Run(ctx, Input{Source: reqSrc, Request: baseRequest(), Script: "1"})
	if !errors.As(err, &se) || !se.Canceled {
		t.Fatalf("already cancelled: err = %v", err)
	}
}

func TestSyntaxErrors(t *testing.T) {
	cases := []struct {
		script     string
		line, col  int
		wantPrefix string
	}{
		{"let a = 1;\nlet b = ;", 2, 9, "SyntaxError: "},
		{"let a = 1; let a = 2;", 1, 16, "SyntaxError: "},
	}
	for _, c := range cases {
		_, err := run(t, Input{Source: reqSrc, Script: c.script})
		var se *Error
		if !errors.As(err, &se) || !strings.HasPrefix(se.Message, c.wantPrefix) || se.Line != c.line || se.Column != c.col {
			t.Errorf("%q: err = %#v", c.script, err)
		}
	}
}

func TestErrorPosition(t *testing.T) {
	_, err := run(t, Input{Source: Source{Kind: LevelFolder, Name: "Auth", Event: Test}, Response: jsonResponse(200, "{}"), Script: "const x = 1;\n\npm.expect(x).to.equal(2);"})
	var se *Error
	if !errors.As(err, &se) || se.Line != 3 || se.Message != "AssertionError: expected 1 to equal 2" {
		t.Fatalf("err = %#v", err)
	}
	if got := se.Error(); got != `Error in the test script of folder "Auth" at line 3:22: AssertionError: expected 1 to equal 2` {
		t.Errorf("Error() = %q", got)
	}
}

func TestConsoleBudget(t *testing.T) {
	out := mustRun(t, Input{Source: reqSrc, Script: `for (let i = 0; i < 1500; i++) console.log("line " + i)`})
	if len(out.Console) != MaxConsoleEntries+1 {
		t.Fatalf("entries = %d", len(out.Console))
	}
	if last := out.Console[MaxConsoleEntries]; last.Text != TruncatedText || last.Level != LevelWarn {
		t.Errorf("last = %+v", last)
	}

	// Bytes: a shared budget across runs.
	b := &Budget{}
	out = mustRun(t, Input{Source: reqSrc, Budget: b, Script: `console.log("é".repeat(400000))`})
	if len(out.Console) != 1 {
		t.Fatalf("first = %d entries", len(out.Console))
	}
	out = mustRun(t, Input{Source: reqSrc, Budget: b, Script: `console.log("é".repeat(400000)); console.log("more")`})
	if len(out.Console) != 2 || out.Console[1].Text != TruncatedText {
		t.Fatalf("second = %d entries", len(out.Console))
	}
	total := 800000 + len(out.Console[0].Text)
	if total > MaxConsoleBytes || !strings.HasPrefix(out.Console[0].Text, "éé") || !utf8Valid(out.Console[0].Text) {
		t.Errorf("cut text: %d bytes", total)
	}
	out = mustRun(t, Input{Source: reqSrc, Budget: b, Script: `console.log("after")`})
	if len(out.Console) != 0 {
		t.Errorf("after truncation: %+v", out.Console)
	}

	// A full budget: only the note.
	full := &Budget{entries: MaxConsoleEntries}
	out = mustRun(t, Input{Source: reqSrc, Budget: full, Script: `console.log("x")`})
	if len(out.Console) != 1 || out.Console[0].Text != TruncatedText {
		t.Errorf("full: %+v", out.Console)
	}
}

func utf8Valid(s string) bool { return strings.ToValidUTF8(s, "?") == s }

func TestUnicode(t *testing.T) {
	v := newVars()
	resp := jsonResponse(200, `{"name":"Zoë 🚀","jp":"日本"}`)
	out := mustRun(t, Input{Vars: v, Response: resp, Script: `
const j = pm.response.json();
pm.environment.set("name", j.name);
pm.test("ünïcödé ✓", () => pm.expect(j.jp).to.equal("日本"));
console.log(j.name.length, btoa("é"), atob("w6k="), atob("YQ"));
`})
	if v.scopes[vars.ScopeEnvironment]["name"] != "Zoë 🚀" {
		t.Errorf("name = %q", v.scopes[vars.ScopeEnvironment]["name"])
	}
	if !out.Tests[0].Passed || out.Tests[0].Name != "ünïcödé ✓" {
		t.Errorf("tests = %+v", out.Tests)
	}
	if out.Console[0].Text != "6 6Q== Ã© a" {
		t.Errorf("console = %q", out.Console[0].Text)
	}
	for _, script := range []string{`btoa("日")`, `atob("***")`} {
		if _, err := run(t, Input{Source: reqSrc, Script: script}); err == nil {
			t.Errorf("%s: no error", script)
		}
	}
}

func TestSourceString(t *testing.T) {
	got := []string{
		Source{Kind: LevelCollection, Name: "Users", Event: PreRequest}.String(),
		Source{Kind: LevelFolder, Name: "Auth", Event: Test}.String(),
	}
	sort.Strings(got)
	if got[0] != `pre-request script of collection "Users"` || got[1] != `test script of folder "Auth"` {
		t.Errorf("got %v", got)
	}
}

func TestToErrorFallbacks(t *testing.T) {
	e := toError(errors.New("plain"), reqSrc, time.Second)
	if e.Message != "plain" {
		t.Errorf("message = %q", e.Message)
	}
	e = toError(context.Canceled, reqSrc, time.Second)
	if !e.Canceled {
		t.Errorf("canceled = %+v", e)
	}
	if got := exceptionText(nil); got != "unknown error" {
		t.Errorf("nil = %q", got)
	}
}
