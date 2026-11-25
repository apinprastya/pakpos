// Package script runs pre-request and test scripts in a goja sandbox with a
// Postman-compatible pm API (pm.environment, pm.request, pm.response,
// pm.test, pm.expect, …).
//
// Rules:
//   - Every Run gets a fresh runtime, so nothing a script does (globals,
//     prototype changes) reaches a later run.
//   - A run stops after Input.Timeout (DefaultTimeout when zero) or when
//     its context is cancelled; deep recursion stops at MaxCallStack.
//   - Scripts have no require, filesystem or timers: those names throw an
//     error that says so. pm.sendRequest and pm.cookies go through the
//     HTTP and Cookies interfaces; the request blocks the script (its time
//     counts against the timeout) and its callback runs after the script's
//     own code, as in Postman. Without a callback it returns a promise;
//     scripts may use top-level await.
//   - A rejected promise nobody handled fails the run like a throw.
//   - console output is captured (Budget caps it), never printed.
//   - Variables are read and written through the Vars interface; the caller
//     decides where values go (overlay, secret store, local scope).
//   - pm.request is a copy of Input.Request; changes made by a pre-request
//     script come back in Output.Request. In test scripts it is read-only.
//
// The package has no Wails dependency and does no I/O of its own.
package script

import (
	"context"
	_ "embed"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"regexp"
	"slices"
	"strconv"
	"strings"
	"sync/atomic"
	"time"
	"unicode/utf8"

	"github.com/dop251/goja"
	"github.com/dop251/goja/ast"
	"github.com/dop251/goja/parser"

	"pakpos/internal/core/cookies"
	"pakpos/internal/core/model"
	"pakpos/internal/core/urlx"
	"pakpos/internal/core/vars"
)

// Limits.
const (
	DefaultTimeout = 5 * time.Second
	// MaxCallStack is the deepest JavaScript call nesting allowed.
	MaxCallStack = 1000
	// MaxConsoleEntries and MaxConsoleBytes cap console output per Budget;
	// past them a single "output truncated" entry is added.
	MaxConsoleEntries = 1000
	MaxConsoleBytes   = 1 << 20
	// MaxRequests is the most pm.sendRequest calls per Budget (one send).
	MaxRequests = 50
)

// Event says when a script runs.
type Event string

// Events.
const (
	PreRequest Event = "prerequest"
	Test       Event = "test"
)

// LevelKind is where a script is defined.
type LevelKind string

// Level kinds.
const (
	LevelCollection LevelKind = "collection"
	LevelFolder     LevelKind = "folder"
	LevelRequest    LevelKind = "request"
)

// Source names the script a result came from.
type Source struct {
	Kind  LevelKind `json:"kind"`
	ID    string    `json:"id"`
	Name  string    `json:"name"`
	Event Event     `json:"event"`
}

// String describes the source for messages: `pre-request script of folder "Auth"`.
func (s Source) String() string {
	ev := "test"
	if s.Event == PreRequest {
		ev = "pre-request"
	}
	return fmt.Sprintf("%s script of %s %q", ev, s.Kind, s.Name)
}

// AllScopes is the scope Vars.Get, Vars.All see for pm.variables: the
// winning definition of each name across every scope.
const AllScopes vars.ScopeKind = ""

// Vars is how scripts read and write variables. Get and All take a scope
// kind (global, collection, environment, local) or AllScopes; Set and
// Unset take a scope kind (pm.variables writes to the local scope). An
// error from Set or Unset is thrown in the script with its message.
type Vars interface {
	Get(scope vars.ScopeKind, key string) (string, bool)
	All(scope vars.ScopeKind) map[string]string
	Set(scope vars.ScopeKind, key, value string) error
	Unset(scope vars.ScopeKind, key string) error
	// ReplaceIn resolves {{references}} in text with the current values.
	ReplaceIn(text string) (string, error)
}

// HTTP sends the requests scripts make with pm.sendRequest. req holds the
// script's values as given ({{variables}} unresolved); an error's message
// is what the script's callback gets.
type HTTP interface {
	Send(ctx context.Context, req model.Request) (*Response, error)
}

// Cookies is the cookie jar scripts see through pm.cookies. URLs are as the
// script gave them ({{variables}} unresolved). Delete with name "" removes
// every cookie a request to the URL sends. Errors are thrown in the script
// with their message.
type Cookies interface {
	List(rawURL string) ([]cookies.Cookie, error)
	Set(rawURL string, c cookies.Cookie) (cookies.Cookie, error)
	Delete(rawURL, name string) error
}

// Response is what a test script sees as pm.response.
type Response struct {
	Code    int
	Status  string
	Headers []model.KeyValue
	Body    string
	// ResponseTime in milliseconds; ResponseSize in bytes.
	ResponseTime float64
	ResponseSize int64
}

// ResponseFrom converts a sent response; body is its full decoded body.
func ResponseFrom(r *model.Response, body []byte) *Response {
	status := r.StatusText
	if i := strings.IndexByte(status, ' '); i >= 0 && strings.HasPrefix(status, strconv.Itoa(r.StatusCode)) {
		status = status[i+1:]
	}
	return &Response{
		Code: r.StatusCode, Status: status, Headers: r.Headers,
		Body:         strings.ToValidUTF8(string(body), "�"),
		ResponseTime: r.Timings.Total, ResponseSize: r.Size,
	}
}

// Input is one script run.
type Input struct {
	Source Source
	Script string
	// Request is the request as it will be sent (inherited headers and auth
	// applied, variables unresolved).
	Request model.Request
	// Response is set for test scripts.
	Response        *Response
	Vars            Vars
	EnvironmentName string
	// Iteration (0-based) and IterationCount describe a runner iteration;
	// a single send is iteration 0 of 1. IterationData is pm.iterationData.
	Iteration      int
	IterationCount int
	IterationData  map[string]string
	// Timeout for the run; DefaultTimeout when zero.
	Timeout time.Duration
	// Budget caps console output and pm.sendRequest calls; share one across
	// the runs of a send. nil gives the run its own.
	Budget *Budget
	// HTTP sends pm.sendRequest requests; nil makes pm.sendRequest fail.
	HTTP HTTP
	// Cookies backs pm.cookies; nil makes it an empty jar that refuses
	// writes.
	Cookies Cookies
}

// TestResult is one pm.test.
type TestResult struct {
	Name    string `json:"name"`
	Passed  bool   `json:"passed"`
	Skipped bool   `json:"skipped"`
	// Error is the failure message ("AssertionError: expected 404 to equal 200").
	Error  string `json:"error"`
	Source Source `json:"source"`
}

// ConsoleLevel is a console method.
type ConsoleLevel string

// Console levels.
const (
	LevelLog   ConsoleLevel = "log"
	LevelInfo  ConsoleLevel = "info"
	LevelWarn  ConsoleLevel = "warn"
	LevelError ConsoleLevel = "error"
	LevelDebug ConsoleLevel = "debug"
)

// ConsoleEntry is one console line.
type ConsoleEntry struct {
	Level  ConsoleLevel `json:"level"`
	Text   string       `json:"text"`
	Source Source       `json:"source"`
}

// TruncatedText is the entry added once a Budget runs out.
const TruncatedText = "Output truncated: scripts logged more than 1000 lines or 1 MiB."

// Budget caps console output across runs. It is not safe for concurrent use.
type Budget struct {
	entries   int
	bytes     int
	truncated bool
	requests  int
}

// add returns the entries to append for one console call.
func (b *Budget) add(e ConsoleEntry) []ConsoleEntry {
	if b.truncated {
		return nil
	}
	left := MaxConsoleBytes - b.bytes
	if b.entries < MaxConsoleEntries && len(e.Text) <= left {
		b.entries++
		b.bytes += len(e.Text)
		return []ConsoleEntry{e}
	}
	b.truncated = true
	note := ConsoleEntry{Level: LevelWarn, Text: TruncatedText, Source: e.Source}
	if b.entries < MaxConsoleEntries && left > 0 {
		e.Text = cutUTF8(e.Text, left)
		return []ConsoleEntry{e, note}
	}
	return []ConsoleEntry{note}
}

func cutUTF8(s string, n int) string {
	for n > 0 && !utf8.RuneStart(s[n]) {
		n--
	}
	return s[:n]
}

// Output is what a run produced. It is filled as far as the run got, also
// when Run returns an error.
type Output struct {
	Tests   []TestResult
	Console []ConsoleEntry
	// Request is the request after a pre-request script's changes (the
	// input request for test scripts and failed runs).
	Request model.Request
	// NextRequestSet is true when the script called setNextRequest;
	// NextRequest is its argument ("" with NextRequestStop for null).
	NextRequestSet  bool
	NextRequest     string
	NextRequestStop bool
	// Skip is true when a pre-request script called pm.execution.skipRequest.
	Skip bool
}

// Error is a script that failed: a syntax error, an uncaught exception,
// a timeout or a cancelled run.
type Error struct {
	Source Source
	// Line and Column (1-based) locate the error in the script; 0 when
	// unknown (a timeout).
	Line, Column int
	Message      string
	// Timeout is true when the script ran out of time; Canceled when its
	// context ended.
	Timeout, Canceled bool
}

func (e *Error) Error() string {
	where := e.Source.String()
	if e.Line > 0 {
		return fmt.Sprintf("Error in the %s at line %d:%d: %s", where, e.Line, e.Column, e.Message)
	}
	return fmt.Sprintf("Error in the %s: %s", where, e.Message)
}

// TimeoutMessage is the message of a run that took longer than d.
func TimeoutMessage(d time.Duration) string {
	return "Script took longer than " + strconv.FormatFloat(d.Seconds(), 'f', -1, 64) + " s"
}

//go:embed expect.js
var expectSrc string

//go:embed prelude.js
var preludeSrc string

var (
	expectProgram  = goja.MustCompile("pakpos-expect.js", expectSrc, false)
	preludeProgram = goja.MustCompile("pakpos-prelude.js", preludeSrc, false)
)

// userScript names the script's own code in stack traces.
const userScript = "script"

var errTimeout = errors.New("script timeout")

type wireRequest struct {
	ID      string           `json:"id"`
	Name    string           `json:"name"`
	Method  string           `json:"method"`
	URL     string           `json:"url"`
	Headers []model.KeyValue `json:"headers"`
	Body    model.Body       `json:"body"`
}

type wireResponse struct {
	Code         int              `json:"code"`
	Status       string           `json:"status"`
	Headers      []model.KeyValue `json:"headers"`
	Body         string           `json:"body"`
	ResponseTime float64          `json:"responseTime"`
	ResponseSize int64            `json:"responseSize"`
}

type wireInput struct {
	Event           Event             `json:"event"`
	Request         wireRequest       `json:"request"`
	Response        *wireResponse     `json:"response"`
	EnvironmentName string            `json:"environmentName"`
	Iteration       int               `json:"iteration"`
	IterationCount  int               `json:"iterationCount"`
	IterationData   map[string]string `json:"iterationData"`
}

type wireState struct {
	Request        wireRequest `json:"request"`
	NextRequest    *string     `json:"nextRequest"`
	NextRequestSet bool        `json:"nextRequestSet"`
	Skip           bool        `json:"skip"`
}

func nonNil[T any](s []T) []T {
	if s == nil {
		return []T{}
	}
	return s
}

func toWire(in Input) wireInput {
	r := in.Request
	body := r.Body
	body.FormData, body.URLEncoded = nonNil(body.FormData), nonNil(body.URLEncoded)
	w := wireInput{
		Event: in.Source.Event,
		Request: wireRequest{
			ID: r.ID, Name: r.Name, Method: r.Method,
			URL:     urlx.WithQuery(r.URL, r.Query),
			Headers: nonNil(r.Headers), Body: body,
		},
		EnvironmentName: in.EnvironmentName,
		Iteration:       in.Iteration, IterationCount: max(in.IterationCount, 1),
		IterationData: in.IterationData,
	}
	if w.IterationData == nil {
		w.IterationData = map[string]string{}
	}
	if in.Response != nil && in.Source.Event == Test {
		w.Response = &wireResponse{
			Code: in.Response.Code, Status: in.Response.Status, Headers: nonNil(in.Response.Headers),
			Body: in.Response.Body, ResponseTime: in.Response.ResponseTime, ResponseSize: in.Response.ResponseSize,
		}
	}
	return w
}

// apply copies a pre-request script's changes back onto req. A changed URL
// re-reads the query rows and path params from it, as the URL bar does.
func apply(req model.Request, before, after wireRequest) model.Request {
	req.Method = after.Method
	if after.URL != before.URL {
		req.URL = after.URL
		req.Query = urlx.MergeQuery(after.URL, req.Query)
		req.PathParams = urlx.SyncPathParams(after.URL, req.PathParams)
	}
	req.Headers = after.Headers
	req.Body = after.Body
	return req
}

// Run runs one script. A nil error means the script ran to the end; test
// failures are in Output.Tests. Errors are *Error.
func Run(ctx context.Context, in Input) (Output, error) {
	out := Output{Request: in.Request, Tests: []TestResult{}, Console: []ConsoleEntry{}}
	if in.Budget == nil {
		in.Budget = &Budget{}
	}
	timeout := in.Timeout
	if timeout <= 0 {
		timeout = DefaultTimeout
	}
	fail := func(err error) (Output, error) {
		return out, toError(err, in.Source, timeout)
	}
	if err := ctx.Err(); err != nil {
		return fail(err)
	}
	ast, wrapped, err := parse(in.Script)
	if err != nil {
		return fail(err)
	}
	prg, err := goja.CompileAST(ast, false)
	if err != nil {
		return fail(err)
	}

	vm := goja.New()
	vm.SetMaxCallStackSize(MaxCallStack)
	done := make(chan struct{})
	defer close(done)
	// runCtx bounds the run's requests: they stop with the script.
	runCtx, stop := context.WithCancel(ctx)
	defer stop()
	h := &host{vm: vm, in: in, out: &out, ctx: runCtx}
	timer := time.AfterFunc(timeout, func() {
		h.timedOutSending.Store(h.sending.Load())
		vm.Interrupt(errTimeout)
		stop()
	})
	defer timer.Stop()
	go func() {
		select {
		case <-ctx.Done():
			vm.Interrupt(ctx.Err())
		case <-done:
		}
	}()
	fail = func(err error) (Output, error) {
		e := toError(err, in.Source, timeout)
		if e.Timeout && h.timedOutSending.Load() {
			e.Message += " (it was waiting for pm.sendRequest)"
		}
		if e.Line == 1 && wrapped {
			e.Column = max(e.Column-len(asyncPrefix), 1)
		}
		return out, e
	}
	var unhandled []*goja.Promise
	vm.SetPromiseRejectionTracker(func(p *goja.Promise, op goja.PromiseRejectionOperation) {
		if op == goja.PromiseRejectionReject {
			unhandled = append(unhandled, p)
			return
		}
		unhandled = slices.DeleteFunc(unhandled, func(x *goja.Promise) bool { return x == p })
	})

	wire := toWire(in)
	inputJSON, err := json.Marshal(wire)
	if err != nil {
		return fail(fmt.Errorf("encode script input: %w", err))
	}
	drain, finish, err := h.setup(string(inputJSON))
	if err != nil {
		return fail(err)
	}
	result, err := vm.RunProgram(prg)
	if err != nil {
		return fail(err)
	}
	for {
		n, err := drain(goja.Undefined())
		if err != nil {
			return fail(err)
		}
		if n.ToInteger() == 0 {
			break
		}
	}
	if wrapped {
		if p, ok := result.Export().(*goja.Promise); ok && p.State() == goja.PromiseStateRejected {
			return fail(rejection(p.Result()))
		}
	}
	if len(unhandled) > 0 {
		return fail(rejection(unhandled[0].Result()))
	}
	stateVal, err := finish(goja.Undefined())
	if err != nil {
		return fail(err)
	}
	var st wireState
	if err := json.Unmarshal([]byte(stateVal.String()), &st); err != nil {
		return fail(fmt.Errorf("read script state: %w", err))
	}
	if in.Source.Event == PreRequest {
		out.Request = apply(in.Request, wire.Request, st.Request)
	}
	out.Skip = st.Skip
	out.NextRequestSet = st.NextRequestSet
	if st.NextRequestSet {
		if st.NextRequest == nil {
			out.NextRequestStop = true
		} else {
			out.NextRequest = *st.NextRequest
		}
	}
	return out, nil
}

// asyncPrefix wraps a script that uses top-level await (on its first line,
// so line numbers stay the same).
const asyncPrefix = "(async () => {"

// parse parses a script. One that only parses inside an async function
// (top-level await) is wrapped in one; wrapped reports that.
func parse(src string) (prog *ast.Program, wrapped bool, err error) {
	prog, err = parser.ParseFile(nil, userScript, src, 0)
	if err == nil || !strings.Contains(src, "await") {
		return prog, false, err
	}
	if wast, werr := parser.ParseFile(nil, userScript, asyncPrefix+src+"\n})()", 0); werr == nil {
		return wast, true, nil
	}
	return nil, false, err
}

// rejectionError is a rejected promise's reason.
type rejectionError struct{ value goja.Value }

func (e *rejectionError) Error() string { return exceptionText(e.value) }

func rejection(v goja.Value) error { return &rejectionError{value: v} }

// stackPosition finds "script:line:column" in an Error's stack.
var stackPosition = regexp.MustCompile(`\b` + userScript + `:(\d+):(\d+)`)

// host holds the Go functions the prelude calls.
type host struct {
	vm  *goja.Runtime
	in  Input
	out *Output
	// ctx bounds pm.sendRequest (cancelled when the run ends or times out).
	ctx context.Context
	// sending is true while pm.sendRequest waits; timedOutSending records
	// that the timeout hit then.
	sending, timedOutSending atomic.Bool
}

// setup runs the expect library and the prelude, which installs pm and
// the globals, and returns the prelude's drain and finish functions.
func (h *host) setup(inputJSON string) (drain, finish goja.Callable, err error) {
	lib, err := h.vm.RunProgram(expectProgram)
	if err != nil {
		return nil, nil, err
	}
	fnVal, err := h.vm.RunProgram(preludeProgram)
	if err != nil {
		return nil, nil, err
	}
	fn, _ := goja.AssertFunction(fnVal)
	res, err := fn(goja.Undefined(), h.object(), h.vm.ToValue(inputJSON), lib)
	if err != nil {
		return nil, nil, err
	}
	obj := res.ToObject(h.vm)
	drain, _ = goja.AssertFunction(obj.Get("drain"))
	finish, _ = goja.AssertFunction(obj.Get("finish"))
	return drain, finish, nil
}

func (h *host) throw(msg string) {
	ctor, _ := goja.AssertConstructor(h.vm.Get("Error"))
	obj, err := ctor(nil, h.vm.ToValue(msg))
	if err != nil {
		panic(err)
	}
	panic(obj)
}

func (h *host) object() *goja.Object {
	o := h.vm.NewObject()
	vs := h.in.Vars
	set := func(name string, fn func(goja.FunctionCall) goja.Value) {
		_ = o.Set(name, fn)
	}
	arg := func(c goja.FunctionCall, i int) string { return c.Argument(i).String() }
	set("varGet", func(c goja.FunctionCall) goja.Value {
		if vs == nil {
			return goja.Undefined()
		}
		if v, ok := vs.Get(vars.ScopeKind(arg(c, 0)), arg(c, 1)); ok {
			return h.vm.ToValue(v)
		}
		return goja.Undefined()
	})
	set("varAll", func(c goja.FunctionCall) goja.Value {
		all := map[string]string{}
		if vs != nil {
			all = vs.All(vars.ScopeKind(arg(c, 0)))
		}
		data, _ := json.Marshal(all)
		return h.vm.ToValue(string(data))
	})
	set("varSet", func(c goja.FunctionCall) goja.Value {
		if vs == nil {
			h.throw("Variables can't be set here")
		}
		if err := vs.Set(vars.ScopeKind(arg(c, 0)), arg(c, 1), arg(c, 2)); err != nil {
			h.throw(err.Error())
		}
		return goja.Undefined()
	})
	set("varUnset", func(c goja.FunctionCall) goja.Value {
		if vs != nil {
			if err := vs.Unset(vars.ScopeKind(arg(c, 0)), arg(c, 1)); err != nil {
				h.throw(err.Error())
			}
		}
		return goja.Undefined()
	})
	set("replaceIn", func(c goja.FunctionCall) goja.Value {
		text := arg(c, 0)
		if vs == nil {
			return h.vm.ToValue(text)
		}
		out, err := vs.ReplaceIn(text)
		if err != nil {
			h.throw(err.Error())
		}
		return h.vm.ToValue(out)
	})
	set("log", func(c goja.FunctionCall) goja.Value {
		h.log(ConsoleLevel(arg(c, 0)), arg(c, 1))
		return goja.Undefined()
	})
	set("test", func(c goja.FunctionCall) goja.Value {
		h.out.Tests = append(h.out.Tests, TestResult{
			Name: arg(c, 0), Passed: c.Argument(1).ToBoolean(), Error: arg(c, 2),
			Skipped: c.Argument(3).ToBoolean(), Source: h.in.Source,
		})
		return goja.Undefined()
	})
	set("sendRequest", func(c goja.FunctionCall) goja.Value {
		return h.vm.ToValue(h.sendRequest(arg(c, 0)))
	})
	set("cookieList", func(c goja.FunctionCall) goja.Value {
		list := []cookies.Cookie{}
		if h.in.Cookies != nil {
			got, err := h.in.Cookies.List(arg(c, 0))
			if err != nil {
				h.throw(err.Error())
			}
			list = append(list, got...)
		}
		data, _ := json.Marshal(list)
		return h.vm.ToValue(string(data))
	})
	set("cookieSet", func(c goja.FunctionCall) goja.Value {
		if h.in.Cookies == nil {
			h.throw(noJar)
		}
		var ck cookies.Cookie
		if err := json.Unmarshal([]byte(arg(c, 1)), &ck); err != nil {
			h.throw("The cookie isn't valid: " + err.Error())
		}
		got, err := h.in.Cookies.Set(arg(c, 0), ck)
		if err != nil {
			h.throw(err.Error())
		}
		data, _ := json.Marshal(got)
		return h.vm.ToValue(string(data))
	})
	set("cookieDelete", func(c goja.FunctionCall) goja.Value {
		if h.in.Cookies == nil {
			h.throw(noJar)
		}
		if err := h.in.Cookies.Delete(arg(c, 0), arg(c, 1)); err != nil {
			h.throw(err.Error())
		}
		return goja.Undefined()
	})
	set("btoa", func(c goja.FunctionCall) goja.Value {
		s := arg(c, 0)
		b := make([]byte, 0, len(s))
		for _, r := range s {
			if r > 0xFF {
				h.throw("btoa: the string has characters outside Latin-1")
			}
			b = append(b, byte(r)) //nolint:gosec // r is at most 0xFF (checked above)
		}
		return h.vm.ToValue(base64.StdEncoding.EncodeToString(b))
	})
	set("atob", func(c goja.FunctionCall) goja.Value {
		s := strings.Map(func(r rune) rune {
			if r == ' ' || r == '\t' || r == '\n' || r == '\r' || r == '\f' {
				return -1
			}
			return r
		}, arg(c, 0))
		b, err := base64.RawStdEncoding.DecodeString(strings.TrimRight(s, "="))
		if err != nil {
			h.throw("atob: the string isn't valid base64")
		}
		var sb strings.Builder
		for _, x := range b {
			sb.WriteRune(rune(x))
		}
		return h.vm.ToValue(sb.String())
	})
	return o
}

// noJar is thrown by cookie writes when the run has no jar.
const noJar = "The cookie jar isn't available here"

// scriptRequest is a pm.sendRequest request as the prelude sends it.
type scriptRequest struct {
	Method  string           `json:"method"`
	URL     string           `json:"url"`
	Headers []model.KeyValue `json:"headers"`
	Body    model.Body       `json:"body"`
	Auth    model.Auth       `json:"auth"`
}

// sendRequest sends a pm.sendRequest request and returns the response as
// JSON. Failures are thrown (the prelude hands them to the callback). A
// console line records each request.
func (h *host) sendRequest(reqJSON string) string {
	if h.in.HTTP == nil {
		h.throw("pm.sendRequest isn't available here")
	}
	if h.in.Budget.requests >= MaxRequests {
		h.throw(fmt.Sprintf("Scripts can send at most %d requests per send", MaxRequests))
	}
	h.in.Budget.requests++
	var sr scriptRequest
	if err := json.Unmarshal([]byte(reqJSON), &sr); err != nil {
		h.throw("The request isn't valid: " + err.Error())
	}
	req := model.Request{
		Method: sr.Method, URL: sr.URL, Query: urlx.MergeQuery(sr.URL, nil),
		Headers: sr.Headers, Body: sr.Body, Auth: sr.Auth,
	}
	h.sending.Store(true)
	resp, err := h.in.HTTP.Send(h.ctx, req)
	h.sending.Store(false)
	line := sr.Method + " " + sr.URL
	if err != nil {
		h.log(LevelWarn, "pm.sendRequest "+line+" failed: "+err.Error())
		h.throw(err.Error())
	}
	h.log(LevelInfo, fmt.Sprintf("pm.sendRequest %s → %d %s (%s ms)", line, resp.Code, resp.Status,
		strconv.FormatFloat(resp.ResponseTime, 'f', 0, 64)))
	data, _ := json.Marshal(wireResponse{
		Code: resp.Code, Status: resp.Status, Headers: nonNil(resp.Headers),
		Body: resp.Body, ResponseTime: resp.ResponseTime, ResponseSize: resp.ResponseSize,
	})
	return string(data)
}

func (h *host) log(level ConsoleLevel, text string) {
	e := ConsoleEntry{Level: level, Text: text, Source: h.in.Source}
	h.out.Console = append(h.out.Console, h.in.Budget.add(e)...)
}

// toError turns anything a run returned into an *Error.
func toError(err error, src Source, timeout time.Duration) *Error {
	e := &Error{Source: src}
	var (
		intr   *goja.InterruptedError
		so     *goja.StackOverflowError
		ex     *goja.Exception
		syntax *goja.CompilerSyntaxError
		parse  parser.ErrorList
		rej    *rejectionError
	)
	switch {
	case errors.As(err, &intr):
		if intr.Value() == errTimeout {
			e.Message, e.Timeout = TimeoutMessage(timeout), true
		} else {
			e.Message, e.Canceled = "The script was stopped because the send was cancelled", true
		}
	case errors.Is(err, context.Canceled), errors.Is(err, context.DeadlineExceeded):
		e.Message, e.Canceled = "The script was stopped because the send was cancelled", true
	case errors.As(err, &so):
		e.Message = "RangeError: Maximum call stack size exceeded"
		e.Line, e.Column = position(so.Stack())
	case errors.As(err, &syntax):
		e.Message = "SyntaxError: " + syntax.Message
		if syntax.File != nil {
			p := syntax.File.Position(syntax.Offset)
			e.Line, e.Column = p.Line, p.Column
		}
	case errors.As(err, &parse):
		e.Message = "SyntaxError: " + parse[0].Message
		e.Line, e.Column = parse[0].Position.Line, parse[0].Position.Column
	case errors.As(err, &rej):
		e.Message = exceptionText(rej.value)
		if obj, ok := rej.value.(*goja.Object); ok && obj.Get("stack") != nil {
			if m := stackPosition.FindStringSubmatch(obj.Get("stack").String()); m != nil {
				e.Line, _ = strconv.Atoi(m[1])
				e.Column, _ = strconv.Atoi(m[2])
			}
		}
	case errors.As(err, &ex):
		e.Message = exceptionText(ex.Value())
		e.Line, e.Column = position(ex.Stack())
	default:
		e.Message = err.Error()
	}
	return e
}

// exceptionText is "Name: message" for Error objects, else the value.
func exceptionText(v goja.Value) string {
	if v == nil {
		return "unknown error"
	}
	if obj, ok := v.(*goja.Object); ok {
		if msg := obj.Get("message"); msg != nil && !goja.IsUndefined(msg) {
			name := "Error"
			if n := obj.Get("name"); n != nil && !goja.IsUndefined(n) {
				name = n.String()
			}
			return name + ": " + msg.String()
		}
	}
	return v.String()
}

// position returns the line and column of the innermost frame in the
// user's script.
func position(stack []goja.StackFrame) (int, int) {
	for _, f := range stack {
		if f.SrcName() == userScript {
			p := f.Position()
			return p.Line, p.Column
		}
	}
	return 0, 0
}
