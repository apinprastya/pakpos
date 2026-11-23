package sqlite

import (
	"bytes"
	"errors"
	"fmt"
	"reflect"
	"testing"
	"time"
)

func TestWebhookRequests(t *testing.T) {
	s := openTest(t)
	base := time.UnixMilli(1_800_000_000_000).UTC()
	add := func(hook string, i int) WebhookRequest {
		r := WebhookRequest{
			WebhookRequestSummary: WebhookRequestSummary{
				ID: fmt.Sprintf("%s-%02d", hook, i), WorkspaceID: "W", WebhookID: hook,
				ReceivedAt: base.Add(time.Duration(i) * time.Second), Method: "POST", Path: "/p",
				Query: "a=1", BodySize: 2, RemoteAddr: "1.2.3.4", RuleID: "r1", RuleName: "Fail",
				Status: 400, DurationMs: 1.5,
			},
			Headers:         []WebhookHeader{{"Content-Type", "application/json"}, {"X-A", "1"}, {"X-A", "2"}},
			Body:            []byte("{}"),
			ResponseHeaders: []WebhookHeader{{"Content-Type", "text/plain"}},
			ResponseBody:    []byte("no"),
		}
		if err := s.AddWebhookRequest(r, 3); err != nil {
			t.Fatal(err)
		}
		return r
	}
	for i := range 5 {
		add("H1", i)
	}
	want := add("H2", 0)

	list, err := s.ListWebhookRequests("H1", "", 0)
	if err != nil {
		t.Fatal(err)
	}
	if len(list) != 3 || list[0].ID != "H1-04" || list[2].ID != "H1-02" {
		t.Fatalf("list = %+v", list)
	}
	if l := list[0]; l.Method != "POST" || l.Query != "a=1" || l.RuleName != "Fail" || l.Status != 400 || l.DurationMs != 1.5 || !l.ReceivedAt.Equal(base.Add(4*time.Second)) {
		t.Errorf("row = %+v", l)
	}
	page, err := s.ListWebhookRequests("H1", "H1-04", 1)
	if err != nil || len(page) != 1 || page[0].ID != "H1-03" {
		t.Fatalf("page = %+v, %v", page, err)
	}

	got, err := s.GetWebhookRequest("H2-00")
	if err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("get = %+v\nwant %+v", got, want)
	}
	if _, err := s.GetWebhookRequest("H1-00"); !errors.Is(err, ErrNotFound) {
		t.Errorf("pruned: %v", err)
	}

	if err := s.DeleteWebhookRequest("H1-04"); err != nil {
		t.Fatal(err)
	}
	if list, _ := s.ListWebhookRequests("H1", "", 10); len(list) != 2 {
		t.Errorf("after delete %d", len(list))
	}
	if err := s.ClearWebhookRequests("H1"); err != nil {
		t.Fatal(err)
	}
	if list, _ := s.ListWebhookRequests("H1", "", 10); list == nil || len(list) != 0 {
		t.Errorf("after clear %#v", list)
	}
	if list, _ := s.ListWebhookRequests("H2", "", 10); len(list) != 1 {
		t.Errorf("other webhook cleared too")
	}
}

func TestWebhookRequestDefaultsAndLimits(t *testing.T) {
	s := openTest(t)
	big := bytes.Repeat([]byte("x"), MaxWebhookBody+10)
	if err := s.AddWebhookRequest(WebhookRequest{
		WebhookRequestSummary: WebhookRequestSummary{ID: "a", WebhookID: "H", Method: "GET", Path: "/", BodySize: int64(len(big))},
		Body:                  big, ResponseBody: big,
	}, 0); err != nil {
		t.Fatal(err)
	}
	got, err := s.GetWebhookRequest("a")
	if err != nil {
		t.Fatal(err)
	}
	if len(got.Body) != MaxWebhookBody || !got.Truncated || len(got.ResponseBody) != MaxWebhookBody || !got.ResponseTruncated || got.BodySize != int64(len(big)) {
		t.Errorf("limits: body %d %v, resp %d %v", len(got.Body), got.Truncated, len(got.ResponseBody), got.ResponseTruncated)
	}
	if got.ReceivedAt.IsZero() || got.Headers == nil || got.ResponseHeaders == nil {
		t.Errorf("defaults = %+v", got)
	}
	if err := s.AddWebhookRequest(WebhookRequest{WebhookRequestSummary: WebhookRequestSummary{ID: "b", WebhookID: "H", Method: "GET", Path: "/"}}, 0); err != nil {
		t.Fatal(err)
	}
	if got, _ := s.GetWebhookRequest("b"); got.Body == nil || got.ResponseBody == nil {
		t.Errorf("nil bodies = %+v", got)
	}
	if err := s.AddWebhookRequest(WebhookRequest{}, 0); err == nil {
		t.Error("missing ids accepted")
	}
	if err := s.AddWebhookRequest(WebhookRequest{WebhookRequestSummary: WebhookRequestSummary{ID: "a", WebhookID: "H"}}, 0); err == nil {
		t.Error("duplicate id accepted")
	}
}

func TestWebhookRequestsClosed(t *testing.T) {
	s := openTest(t)
	_ = s.Close()
	if _, err := s.ListWebhookRequests("H", "", 1); err == nil {
		t.Error("list on closed db")
	}
	if _, err := s.GetWebhookRequest("x"); err == nil || errors.Is(err, ErrNotFound) {
		t.Errorf("get on closed db: %v", err)
	}
	if err := s.DeleteWebhookRequest("x"); err == nil {
		t.Error("delete on closed db")
	}
	if err := s.ClearWebhookRequests("x"); err == nil {
		t.Error("clear on closed db")
	}
	if err := s.AddWebhookRequest(WebhookRequest{WebhookRequestSummary: WebhookRequestSummary{ID: "a", WebhookID: "H"}}, 0); err == nil {
		t.Error("add on closed db")
	}
}
