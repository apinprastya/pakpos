package service

import (
	"context"
	"encoding/base64"
	"errors"
	"fmt"
	"io"
	"net/url"
	"os"
	"path"
	"strings"
	"time"

	"pakpos/internal/core/httpexec"
	"pakpos/internal/core/model"
	"pakpos/internal/core/script"
	"pakpos/internal/pipeline"
	"pakpos/internal/secrets"
	"pakpos/internal/store/sqlite"
)

// SendResult is what the UI gets back from Send. At most one of Response
// and Error is set; neither is when a pre-request script skipped the
// request (Skipped). HistoryID is 0 when the send was not recorded
// (cancelled, skipped, or recording failed).
type SendResult struct {
	Response  *model.Response `json:"response"`
	Error     *httpexec.Error `json:"error"`
	HistoryID int64           `json:"historyId"`
	// Unresolved lists the {{names}} that had no value; they were sent as
	// written. Never nil.
	Unresolved []string `json:"unresolved"`
	// SecretsLocked is true when the request uses secret variables that
	// couldn't be read, or a script couldn't write one, because the secret
	// store is locked.
	SecretsLocked bool `json:"secretsLocked"`
	// Environment is the environment the request was sent with, or nil.
	Environment *pipeline.EnvRef `json:"environment"`
	// Hops is what went over the wire (the request, then each redirect
	// followed), with secret values masked as [secret:name]. Empty when
	// nothing was sent. Never stored in history. Never nil.
	Hops []model.Hop `json:"hops"`
	// Tests are the pm.test results of the pre-request and test scripts,
	// collection first; a test script error is a failed "Script error"
	// test. Masked; never stored. Never nil.
	Tests []script.TestResult `json:"tests"`
	// Console is the scripts' console output, masked; never stored. Never nil.
	Console []script.ConsoleEntry `json:"console"`
	// Skipped is true when a pre-request script called
	// pm.execution.skipRequest: nothing was sent.
	Skipped bool `json:"skipped"`
	// ScriptError locates a pre-request script error (Error.Kind "script")
	// so the UI can open that script; nil otherwise and for timeouts'
	// position (Line 0).
	ScriptError *ScriptErrorInfo `json:"scriptError"`
}

// ScriptErrorInfo is where a pre-request script failed: the level's
// script and the 1-based line and column (0 when unknown, e.g. a timeout).
type ScriptErrorInfo struct {
	Source script.Source `json:"source"`
	Line   int           `json:"line"`
	Column int           `json:"column"`
}

// RequestService saves requests in the workspace and sends them.
type RequestService struct {
	c   *Core
	now func() time.Time
}

// NewRequestService creates the service.
func NewRequestService(c *Core) *RequestService { return &RequestService{c: c, now: time.Now} }

// Get loads a saved request.
func (s *RequestService) Get(id string) (model.Request, error) {
	ws, err := s.c.workspace()
	if err != nil {
		return model.Request{}, err
	}
	return ws.GetRequest(id)
}

// Save overwrites a saved request (matched by ID).
func (s *RequestService) Save(req model.Request) (model.Request, error) {
	ws, err := s.c.workspace()
	if err != nil {
		return model.Request{}, err
	}
	if err := checkRequestSettings(req); err != nil {
		return model.Request{}, err
	}
	return ws.SaveRequest(req)
}

// checkRequestSettings refuses per-request settings outside the app limits.
func checkRequestSettings(req model.Request) error {
	if err := httpexec.ValidateRequestSettings(req.Settings); err != nil {
		return &userError{msg: "Check the request's Settings tab: " + err.Error() + ".", err: err}
	}
	return nil
}

// SaveAs saves req as a new request named name at the end of a collection
// or folder (parentID).
func (s *RequestService) SaveAs(parentID, name string, req model.Request) (model.Request, error) {
	ws, err := s.c.workspace()
	if err != nil {
		return model.Request{}, err
	}
	if err := checkRequestSettings(req); err != nil {
		return model.Request{}, err
	}
	req.ID = ""
	req.Name = name
	return ws.CreateRequest(parentID, req)
}

// Rename renames a saved request.
func (s *RequestService) Rename(id, name string) (model.Request, error) {
	ws, err := s.c.workspace()
	if err != nil {
		return model.Request{}, err
	}
	return ws.RenameRequest(id, name)
}

// Duplicate copies a request within its collection.
func (s *RequestService) Duplicate(id string) (model.Request, error) {
	ws, err := s.c.workspace()
	if err != nil {
		return model.Request{}, err
	}
	return ws.DuplicateRequest(id)
}

// Delete removes a saved request and its OAuth 2.0 token.
func (s *RequestService) Delete(id string) error {
	_, p, err := s.c.openSession()
	if err != nil {
		return err
	}
	return p.DeleteRequest(id)
}

// Move moves a request to the end of another collection or folder.
// WorkspaceService.MoveRequest also takes the position.
func (s *RequestService) Move(id, toParentID string) (model.Request, error) {
	ws, err := s.c.workspace()
	if err != nil {
		return model.Request{}, err
	}
	return ws.MoveRequest(id, toParentID, -1)
}

// Reorder sets the order of the folders and requests within a collection
// or folder (same as WorkspaceService.Reorder).
func (s *RequestService) Reorder(parentID string, ids []string) error {
	ws, err := s.c.workspace()
	if err != nil {
		return err
	}
	return ws.Reorder(parentID, ids)
}

// Send sends req and records it in history. sendID identifies the send for
// Cancel and must be unique among running sends. parentID is the collection
// or folder an unsaved draft belongs to ("" for none); a saved request
// inherits from its parent on disk. Send failures (DNS, timeout, a variable
// cycle, a pre-request script error…) are returned in SendResult.Error, not
// as a Go error.
//
// The pipeline (pipeline.Send): inherit auth and headers, build the
// variable scopes (globals, collection, selected environment, local) with
// the script overlay and secrets, run the pre-request scripts (collection,
// folders, request), resolve, put the OAuth 2.0 token on (refreshing it
// when it expires soon; an unusable token is error kind "auth"), send, then run the test scripts in the same
// order. Script console output is also emitted as EventScriptConsole while
// the send runs. History stores req as written (variables unresolved, no
// script changes) with the environment name, so secret values never reach
// the database.
func (s *RequestService) Send(ctx context.Context, sendID string, req model.Request, parentID string) (SendResult, error) {
	if strings.TrimSpace(sendID) == "" {
		return SendResult{}, errors.New("send id is required")
	}
	ctx, cancel := context.WithCancel(ctx)
	defer cancel()
	if err := s.c.registerSend(sendID, cancel); err != nil {
		return SendResult{}, err
	}
	defer s.c.unregisterSend(sendID)

	// Record against the workspace open when the send started, even if the
	// user switches workspace while it runs.
	wsID := ""
	started := s.now()
	cfg := s.c.currentSettings()
	opts := pipeline.ScriptOptions{
		Timeout: cfg.ScriptTimeout(),
		OnConsole: func(entries []script.ConsoleEntry) {
			s.c.events.Emit(EventScriptConsole, ScriptConsoleEvent{SendID: sendID, Entries: entries})
		},
		Executor: s.c.executor(), RequestsOff: !cfg.ScriptRequests, Jar: s.c.scriptJar(),
	}
	var sd *pipeline.Send
	if ws, err := s.c.workspace(); err == nil {
		wsID = ws.Manifest().ID
		sd = s.c.session(ws).NewSend(req, parentID, s.c.selectedEnvironment(wsID), opts)
	} else {
		sd = pipeline.NewSendWithoutWorkspace(req, opts)
	}
	result := SendResult{
		Unresolved: []string{}, Hops: []model.Hop{},
		Tests: []script.TestResult{}, Console: []script.ConsoleEntry{},
	}
	addReport := func(r pipeline.ScriptReport) {
		result.Tests = append(result.Tests, r.Tests...)
		result.Console = append(result.Console, r.Console...)
		result.SecretsLocked = result.SecretsLocked || sd.SecretsLocked()
	}

	pre := sd.PreRequest(ctx)
	addReport(pre)
	prepared, perr := sd.Prepare()
	result.Environment = prepared.Environment
	envName := ""
	if prepared.Environment != nil {
		envName = prepared.Environment.Name
	}
	switch {
	case pre.Err != nil && pre.Err.Canceled:
		result.Error = &httpexec.Error{Kind: httpexec.KindCanceled, Message: "The request was cancelled", Err: pre.Err}
		return result, nil
	case pre.Err != nil:
		result.Error = &httpexec.Error{Kind: httpexec.KindScript, Message: pre.Err.Error(), Err: pre.Err}
		result.ScriptError = &ScriptErrorInfo{Source: pre.Err.Source, Line: pre.Err.Line, Column: pre.Err.Column}
		result.HistoryID = s.record(wsID, envName, req, nil, result.Error, started)
		return result, nil
	case pre.Skip:
		result.Skipped = true
		return result, nil
	}
	result.Unresolved, result.SecretsLocked = prepared.Unresolved, result.SecretsLocked || prepared.SecretsLocked
	if result.Unresolved == nil {
		result.Unresolved = []string{}
	}
	if perr != nil {
		result.Error = &httpexec.Error{Kind: httpexec.KindVariables, Message: pipeline.VariableMessage(perr), Err: perr}
		result.HistoryID = s.record(wsID, envName, req, nil, result.Error, started)
		return result, nil
	}
	if aerr := sd.Authorize(ctx, &prepared); aerr != nil {
		if ctx.Err() != nil {
			result.Error = &httpexec.Error{Kind: httpexec.KindCanceled, Message: "The request was cancelled", Err: aerr}
			return result, nil
		}
		result.Error = &httpexec.Error{Kind: httpexec.KindAuth, Message: aerr.Error(), Err: aerr}
		result.SecretsLocked = result.SecretsLocked || sd.SecretsLocked()
		result.HistoryID = s.record(wsID, envName, req, nil, result.Error, started)
		return result, nil
	}

	rec := httpexec.NewRecorder()
	resp, err := s.c.executor().Execute(httpexec.WithRecorder(ctx, rec), "", prepared.Request)
	sendErr := httpexec.Classify(err)
	result.Response, result.Error = resp, sendErr
	// Only the UI sees hops, and never a secret's value.
	result.Hops = pipeline.MaskHops(rec.Hops(), sd.Secrets())
	if sendErr != nil && errors.Is(sendErr, secrets.ErrLocked) {
		// The proxy password or a certificate passphrase is locked away.
		result.SecretsLocked = true
	}
	if sendErr != nil && sendErr.Kind == httpexec.KindCanceled {
		return result, nil
	}
	if resp != nil {
		addReport(sd.Test(ctx, resp))
	}

	result.HistoryID = s.record(wsID, envName, req, resp, sendErr, started)
	return result, nil
}

// record stores the request as written (never the resolved copy).
func (s *RequestService) record(wsID, envName string, req model.Request, resp *model.Response, sendErr *httpexec.Error, started time.Time) int64 {
	return s.c.recordHistory(wsID, envName, req, resp, sendErr, started)
}

// Cancel stops a running send. It reports whether one was found.
func (s *RequestService) Cancel(sendID string) bool {
	return s.c.cancelSend(sendID)
}

// PickFile asks the user for a file to upload. It returns "" when cancelled.
func (s *RequestService) PickFile() (string, error) {
	return s.c.dialogs.PickFile("Choose a file")
}

// SaveResponseBody asks where to save the full response body of a history
// entry and writes it there. It returns the chosen path, or "" when cancelled.
func (s *RequestService) SaveResponseBody(historyID int64) (string, error) {
	e, err := s.c.db.GetHistory(historyID)
	if err != nil {
		return "", err
	}
	if e.Response == nil {
		return "", errors.New("this request has no response to save")
	}
	dest, err := s.c.dialogs.SaveFile("Save response body", suggestFileName(e))
	if err != nil || dest == "" {
		return "", err
	}
	if err := writeBody(dest, e.Response); err != nil {
		return "", fmt.Errorf("save response body: %w", err)
	}
	return dest, nil
}

func writeBody(dest string, r *model.Response) error {
	if r.BodyPath != "" {
		return copyFile(r.BodyPath, dest)
	}
	data := []byte(r.Body)
	if r.Encoding == model.EncodingBase64 {
		decoded, err := base64.StdEncoding.DecodeString(r.Body)
		if err != nil {
			return err
		}
		data = decoded
	}
	return os.WriteFile(dest, data, 0o644)
}

func copyFile(src, dst string) error {
	in, err := os.Open(src)
	if err != nil {
		return err
	}
	defer in.Close()
	out, err := os.Create(dst)
	if err != nil {
		return err
	}
	if _, err := io.Copy(out, in); err != nil {
		_ = out.Close()
		return err
	}
	return out.Close()
}

var kindExt = map[model.BodyKind]string{
	model.KindJSON: ".json", model.KindXML: ".xml", model.KindHTML: ".html", model.KindText: ".txt",
}

// suggestFileName builds a default name from the URL's last path segment,
// adding an extension from the body kind when the segment has none.
func suggestFileName(e sqlite.HistoryEntry) string {
	base := "response"
	if u, err := url.Parse(e.URL); err == nil {
		if b := path.Base(u.Path); b != "." && b != "/" && (u.Host != "" || strings.Contains(u.Path, "/")) {
			base = b
		}
	}
	if path.Ext(base) != "" {
		return base
	}
	if ext, ok := kindExt[e.Response.Kind]; ok {
		return base + ext
	}
	if e.Response.Kind == model.KindImage {
		mediaType, _, _ := strings.Cut(e.Response.ContentType, ";")
		if _, sub, ok := strings.Cut(strings.TrimSpace(mediaType), "/"); ok && sub != "" {
			sub, _, _ = strings.Cut(sub, "+")
			return base + "." + sub
		}
	}
	return base + ".bin"
}
