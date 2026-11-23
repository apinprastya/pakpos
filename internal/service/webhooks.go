package service

import (
	"encoding/base64"
	"errors"
	"unicode/utf8"

	"pakpos/internal/core/webhook"
	"pakpos/internal/hookserver"
	"pakpos/internal/store/fsstore"
	"pakpos/internal/store/sqlite"
)

// EventWebhookStatus carries a webhook's status whenever it changes
// (hookserver.Status: running, tunnel-starting, tunnel-failed, stopped).
const EventWebhookStatus = "webhook:status"

// EventWebhookRequest fires after a request a webhook received is stored.
const EventWebhookRequest = "webhook:request"

// WebhookRequestEvent is the payload of EventWebhookRequest (the summary;
// the body is read with WebhookService.Request).
type WebhookRequestEvent struct {
	WorkspaceID string                       `json:"workspaceId"`
	WebhookID   string                       `json:"webhookId"`
	Entry       sqlite.WebhookRequestSummary `json:"entry"`
}

// WebhookSaveResult is what Save returns: the saved webhook, or the
// problem that kept it from being saved (shown on the field it names).
type WebhookSaveResult struct {
	Webhook *webhook.Webhook         `json:"webhook"`
	Problem *webhook.ValidationError `json:"problem"`
}

// WebhookBody is a stored body: Text when it is UTF-8, else Base64.
type WebhookBody struct {
	Text      string `json:"text"`
	Base64    string `json:"base64"`
	Binary    bool   `json:"binary"`
	Truncated bool   `json:"truncated"`
}

// WebhookRequestDetail is one logged request with its headers and bodies.
type WebhookRequestDetail struct {
	Entry           sqlite.WebhookRequestSummary `json:"entry"`
	Headers         []sqlite.WebhookHeader       `json:"headers"`
	Body            WebhookBody                  `json:"body"`
	ResponseHeaders []sqlite.WebhookHeader       `json:"responseHeaders"`
	ResponseBody    WebhookBody                  `json:"responseBody"`
}

// MsgWebhookRunning is returned by Start for a webhook already running.
const MsgWebhookRunning = "This webhook is already running."

// WebhookService manages a workspace's webhooks (webhooks/<slug>.yaml), runs
// their test servers and reads their request logs.
type WebhookService struct {
	c       *Core
	install installState
}

// NewWebhookService creates the service.
func NewWebhookService(c *Core) *WebhookService { return &WebhookService{c: c} }

// List returns the open workspace's webhooks.
func (s *WebhookService) List() ([]webhook.Webhook, error) {
	ws, err := s.c.workspace()
	if err != nil {
		return nil, err
	}
	return ws.ListWebhooks(), nil
}

// Get returns one webhook of the open workspace.
func (s *WebhookService) Get(id string) (webhook.Webhook, error) {
	ws, err := s.c.workspace()
	if err != nil {
		return webhook.Webhook{}, err
	}
	return ws.GetWebhook(id)
}

// Create adds a webhook with the default response.
func (s *WebhookService) Create(name string) (webhook.Webhook, error) {
	ws, err := s.c.workspace()
	if err != nil {
		return webhook.Webhook{}, err
	}
	return ws.CreateWebhook(name)
}

// Save writes a webhook. A running webhook answers with the new rules from
// its next request.
func (s *WebhookService) Save(h webhook.Webhook) (WebhookSaveResult, error) {
	ws, err := s.c.workspace()
	if err != nil {
		return WebhookSaveResult{}, err
	}
	saved, err := ws.SaveWebhook(h)
	if ve, ok := errors.AsType[*webhook.ValidationError](err); ok {
		return WebhookSaveResult{Problem: ve}, nil
	}
	if err != nil {
		return WebhookSaveResult{}, err
	}
	s.c.applyWebhook(ws.Manifest().ID, saved)
	return WebhookSaveResult{Webhook: &saved}, nil
}

// Rename renames a webhook (and its file).
func (s *WebhookService) Rename(id, name string) (webhook.Webhook, error) {
	ws, err := s.c.workspace()
	if err != nil {
		return webhook.Webhook{}, err
	}
	h, err := ws.RenameWebhook(id, name)
	if err != nil {
		return webhook.Webhook{}, err
	}
	s.c.applyWebhook(ws.Manifest().ID, h)
	return h, nil
}

// Duplicate copies a webhook with new ids; its log isn't copied.
func (s *WebhookService) Duplicate(id string) (webhook.Webhook, error) {
	ws, err := s.c.workspace()
	if err != nil {
		return webhook.Webhook{}, err
	}
	return ws.DuplicateWebhook(id)
}

// Delete stops a webhook, deletes its file and its request log.
func (s *WebhookService) Delete(id string) error {
	ws, err := s.c.workspace()
	if err != nil {
		return err
	}
	_ = s.c.hooks.Stop(hookserver.Key{WorkspaceID: ws.Manifest().ID, WebhookID: id})
	if err := ws.DeleteWebhook(id); err != nil {
		return err
	}
	return s.c.db.ClearWebhookRequests(id)
}

// Start starts a webhook of the open workspace: its local server and, with
// tunnel, a public tunnel (reported later through EventWebhookStatus).
func (s *WebhookService) Start(id string, tunnel bool) (hookserver.Status, error) {
	ws, err := s.c.workspace()
	if err != nil {
		return hookserver.Status{}, err
	}
	h, err := ws.GetWebhook(id)
	if err != nil {
		return hookserver.Status{}, err
	}
	rules, err := webhook.Compile(h)
	if err != nil {
		return hookserver.Status{}, &userError{msg: "Fix the webhook before starting it: " + err.Error(), err: err}
	}
	m := ws.Manifest()
	st, err := s.c.hooks.Start(hookserver.StartOptions{
		Key:  hookserver.Key{WorkspaceID: m.ID, WebhookID: id},
		Name: h.Name, WorkspaceName: m.Name, Rules: rules, Tunnel: tunnel,
	})
	if errors.Is(err, hookserver.ErrRunning) {
		return hookserver.Status{}, &userError{msg: MsgWebhookRunning, err: err}
	}
	return st, err
}

// Stop stops a running webhook (of any workspace).
func (s *WebhookService) Stop(workspaceID, id string) error {
	return s.c.hooks.Stop(hookserver.Key{WorkspaceID: workspaceID, WebhookID: id})
}

// Statuses lists every running webhook, of every workspace.
func (s *WebhookService) Statuses() []hookserver.Status {
	return s.c.hooks.Statuses()
}

// Requests returns up to limit logged requests of a webhook, newest first,
// older than beforeID ("" for the newest).
func (s *WebhookService) Requests(webhookID, beforeID string, limit int) ([]sqlite.WebhookRequestSummary, error) {
	return s.c.db.ListWebhookRequests(webhookID, beforeID, limit)
}

// Request returns one logged request with its headers and bodies.
func (s *WebhookService) Request(id string) (WebhookRequestDetail, error) {
	r, err := s.c.db.GetWebhookRequest(id)
	if err != nil {
		return WebhookRequestDetail{}, err
	}
	return WebhookRequestDetail{
		Entry:           r.WebhookRequestSummary,
		Headers:         r.Headers,
		Body:            webhookBody(r.Body, r.Truncated),
		ResponseHeaders: r.ResponseHeaders,
		ResponseBody:    webhookBody(r.ResponseBody, r.ResponseTruncated),
	}, nil
}

func webhookBody(b []byte, truncated bool) WebhookBody {
	// A body cut at the size limit may end inside a UTF-8 sequence.
	check := b
	if truncated {
		for i := 0; i < utf8.UTFMax && len(check) > 0 && !utf8.Valid(check); i++ {
			check = check[:len(check)-1]
		}
	}
	if utf8.Valid(check) {
		return WebhookBody{Text: string(check), Truncated: truncated}
	}
	return WebhookBody{Base64: base64.StdEncoding.EncodeToString(b), Binary: true, Truncated: truncated}
}

// DeleteRequest removes one logged request.
func (s *WebhookService) DeleteRequest(id string) error {
	return s.c.db.DeleteWebhookRequest(id)
}

// ClearRequests removes a webhook's whole log.
func (s *WebhookService) ClearRequests(webhookID string) error {
	return s.c.db.ClearWebhookRequests(webhookID)
}

// recordWebhookRequest stores a request a webhook answered and announces
// it. Failures are logged: the sender already has its reply.
func (c *Core) recordWebhookRequest(key hookserver.Key, r hookserver.Record) {
	row := sqlite.WebhookRequest{
		WebhookRequestSummary: sqlite.WebhookRequestSummary{
			ID: r.ID, WorkspaceID: key.WorkspaceID, WebhookID: key.WebhookID, ReceivedAt: r.ReceivedAt,
			Method: r.Method, Path: r.Path, Query: r.Query, BodySize: r.BodySize, RemoteAddr: r.RemoteAddr,
			RuleID: r.RuleID, RuleName: r.RuleName, Status: r.Status, DurationMs: r.DurationMs, Error: r.Error,
		},
		Headers:         webhookHeaders(r.Headers),
		Body:            r.Body,
		ResponseHeaders: webhookHeaders(r.ResponseHeaders),
		ResponseBody:    r.ResponseBody,
	}
	if err := c.db.AddWebhookRequest(row, sqlite.MaxWebhookRequests); err != nil {
		c.log.Warn("store webhook request", "webhook", key.WebhookID, "err", err)
		return
	}
	stored, err := c.db.GetWebhookRequest(r.ID)
	if err != nil {
		c.log.Warn("read webhook request", "webhook", key.WebhookID, "err", err)
		return
	}
	c.events.Emit(EventWebhookRequest, WebhookRequestEvent{
		WorkspaceID: key.WorkspaceID, WebhookID: key.WebhookID, Entry: stored.WebhookRequestSummary,
	})
}

func webhookHeaders(in []hookserver.Header) []sqlite.WebhookHeader {
	out := make([]sqlite.WebhookHeader, len(in))
	for i, h := range in {
		out[i] = sqlite.WebhookHeader{Name: h.Name, Value: h.Value}
	}
	return out
}

// applyWebhook gives a running webhook its saved rules and name.
func (c *Core) applyWebhook(workspaceID string, h webhook.Webhook) {
	key := hookserver.Key{WorkspaceID: workspaceID, WebhookID: h.ID}
	rules, err := webhook.Compile(h)
	if err != nil {
		c.log.Warn("compile webhook", "webhook", h.ID, "err", err)
		return
	}
	if c.hooks.SetRules(key, rules) {
		c.hooks.Rename(key, h.Name)
	}
}

// refreshWebhooks applies external changes to ws's webhook files to its
// running webhooks. A webhook whose file is gone or broken keeps the rules
// it has.
func (c *Core) refreshWebhooks(ws *fsstore.Workspace) {
	id := ws.Manifest().ID
	for _, st := range c.hooks.Statuses() {
		if st.WorkspaceID != id {
			continue
		}
		h, err := ws.GetWebhook(st.WebhookID)
		if err != nil {
			continue
		}
		c.applyWebhook(id, h)
	}
}
