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
	"pakpos/internal/pipeline"
	"pakpos/internal/store/sqlite"
)

// SendResult is what the UI gets back from Send. Exactly one of Response and
// Error is set. HistoryID is 0 when the send was not recorded (cancelled, or
// recording failed).
type SendResult struct {
	Response  *model.Response `json:"response"`
	Error     *httpexec.Error `json:"error"`
	HistoryID int64           `json:"historyId"`
	// Unresolved lists the {{names}} that had no value; they were sent as
	// written. Never nil.
	Unresolved []string `json:"unresolved"`
	// SecretsLocked is true when the request uses secret variables that
	// couldn't be read because the secret store is locked.
	SecretsLocked bool `json:"secretsLocked"`
	// Environment is the environment the request was sent with, or nil.
	Environment *pipeline.EnvRef `json:"environment"`
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
	return ws.SaveRequest(req)
}

// SaveAs saves req as a new request named name at the end of a collection
// or folder (parentID).
func (s *RequestService) SaveAs(parentID, name string, req model.Request) (model.Request, error) {
	ws, err := s.c.workspace()
	if err != nil {
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

// Delete removes a saved request.
func (s *RequestService) Delete(id string) error {
	ws, err := s.c.workspace()
	if err != nil {
		return err
	}
	return ws.DeleteRequest(id)
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
// cycle…) are returned in SendResult.Error, not as a Go error.
//
// The pipeline: inherit auth and headers, build the variable scopes (globals,
// collection, selected environment, local) with secrets, resolve, send.
// History stores req as written (variables unresolved) with the environment
// name, so secret values never reach the database.
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
	var prepared pipeline.Prepared
	var perr error
	if ws, err := s.c.workspace(); err == nil {
		wsID = ws.Manifest().ID
		prepared, perr = s.c.session(ws).Prepare(req, parentID, s.c.selectedEnvironment(wsID))
	} else {
		prepared, perr = pipeline.PrepareWithoutWorkspace(req)
	}
	result := SendResult{Unresolved: prepared.Unresolved, SecretsLocked: prepared.SecretsLocked, Environment: prepared.Environment}
	if result.Unresolved == nil {
		result.Unresolved = []string{}
	}
	envName := ""
	if prepared.Environment != nil {
		envName = prepared.Environment.Name
	}
	if perr != nil {
		result.Error = &httpexec.Error{Kind: httpexec.KindVariables, Message: pipeline.VariableMessage(perr), Err: perr}
		result.HistoryID = s.record(wsID, envName, req, nil, result.Error, started)
		return result, nil
	}

	resp, err := s.c.executor().Execute(ctx, "", prepared.Request)
	sendErr := httpexec.Classify(err)
	result.Response, result.Error = resp, sendErr
	if sendErr != nil && sendErr.Kind == httpexec.KindCanceled {
		return result, nil
	}

	result.HistoryID = s.record(wsID, envName, req, resp, sendErr, started)
	return result, nil
}

// record stores the request as written (never the resolved copy).
func (s *RequestService) record(wsID, envName string, req model.Request, resp *model.Response, sendErr *httpexec.Error, started time.Time) int64 {
	method := strings.ToUpper(strings.TrimSpace(req.Method))
	if method == "" {
		method = "GET"
	}
	e := sqlite.HistoryEntry{
		HistorySummary: sqlite.HistorySummary{
			CreatedAt:       started,
			RequestID:       req.ID,
			RequestName:     req.Name,
			Method:          method,
			URL:             req.URL,
			EnvironmentName: envName,
		},
		Request:  req,
		Response: resp,
	}
	e.WorkspaceID = wsID
	if resp != nil {
		e.Status, e.DurationMs, e.Size = resp.StatusCode, resp.Timings.Total, resp.Size
	}
	if sendErr != nil {
		e.ErrorKind, e.ErrorMessage = string(sendErr.Kind), sendErr.Message
	}
	id, err := s.c.db.AddHistory(e)
	if err != nil {
		s.c.log.Warn("record history", "err", err)
		return 0
	}
	if keep := s.c.currentSettings().HistoryRetention; keep > 0 {
		// Retention is per workspace: only this send's group is trimmed.
		if _, err := s.c.db.PruneWorkspaceHistory(wsID, keep); err != nil {
			s.c.log.Warn("prune history", "err", err)
		}
	}
	return id
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
